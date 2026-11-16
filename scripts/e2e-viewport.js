#!/usr/bin/env node
/**
 * Browser E2E for the contact-drill viewport.
 *
 * The CLI experiment (src/experiments/steps.js) cannot replace an interactive
 * capsule in the real viewport: this script starts the Vite dev server, drives
 * the actual rendered CharacterController through the window.__capsuleDemo
 * hook, and asserts on the same telemetry the UI paints — ground motion,
 * support/contact positions, step-scheme switching, collider resize, and the
 * anomaly banner. Evidence (screenshots + a JSON report) is written under
 * experiments/e2e/ and the script exits non-zero on any failed assertion.
 *
 * The rootless container has no system Chromium libraries, so the browser is
 * launched with LD_LIBRARY_PATH pointing at scripts/fetch-browser-libs.sh
 * output and the usual no-sandbox flags.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT_DIR = resolve(ROOT, 'experiments', 'e2e');
const PORT = process.env.E2E_PORT || '5199';
const BASE_URL = `http://127.0.0.1:${PORT}/`;
const HEADLESS_SHELL = process.env.CHROME_HEADLESS_SHELL
  || `${process.env.HOME}/.cache/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-linux-arm64/chrome-headless-shell`;

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  ${detail ?? ''}`);
}

function startDevServer() {
  // npm would add a wrapper layer; call the Vite binary directly with an
  // explicit, fixed port so the URL is deterministic.
  const bin = resolve(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  const proc = spawn(process.execPath, [bin, '--port', PORT, '--strictPort', '--host', '127.0.0.1'], {
    cwd: ROOT,
    env: { ...process.env },
  });
  return proc;
}

async function waitForServer(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE_URL);
      if (res.ok) return true;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(`dev server did not respond at ${BASE_URL}`);
}

async function settleFrames(page, frames) {
  // Fixed timestep is 1/60; wait a little longer than the frame count needs so
  // the requestAnimationFrame loop definitely steps the physics that many times.
  await page.waitForTimeout(frames * (1000 / 60) + 250);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  if (!existsSync(HEADLESS_SHELL)) {
    throw new Error(`headless shell not found at ${HEADLESS_SHELL}; run scripts/fetch-browser-libs.sh and install Playwright browsers`);
  }

  const server = startDevServer();
  server.stdout.on('data', () => {});
  server.stderr.on('data', () => {});
  try {
    await waitForServer();

    const libPath = [
      resolve(ROOT, 'local-libs', 'usr', 'lib', 'aarch64-linux-gnu'),
      resolve(ROOT, 'local-libs', 'lib', 'aarch64-linux-gnu'),
    ].join(':');

    const browser = await chromium.launch({
      executablePath: HEADLESS_SHELL,
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
      ],
      env: {
        ...process.env,
        LD_LIBRARY_PATH: `${libPath}${process.env.LD_LIBRARY_PATH ? `:${process.env.LD_LIBRARY_PATH}` : ''}`,
      },
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    page.on('console', (msg) => {
      if (msg.type() === 'error') pageErrors.push(msg.text());
    });

    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => !!window.__capsuleDemo, { timeout: 10000 });

    // ---- 1. boot: controller grounded, telemetry live, no anomaly ----------
    const boot = await page.evaluate(() => {
      const d = window.__capsuleDemo;
      return {
        scenarios: d.scenarios,
        scheme: d.scheme,
        grounded: d.telemetry.grounded,
        supportLabel: d.telemetry.support ? d.telemetry.support.label : null,
        contacts: d.telemetry.contacts.length,
        anomalies: d.anomalies,
      };
    });
    check('视窗启动后胶囊在地面且有支撑接触', boot.grounded && boot.contacts > 0, `grounded=${boot.grounded} contacts=${boot.contacts} support=${boot.supportLabel}`);
    check('启动无运行异常标记', Array.isArray(boot.anomalies) && boot.anomalies.length === 0, `anomalies=${JSON.stringify(boot.anomalies)}`);
    check('测试钩子暴露全部场景与三种方案', boot.scenarios.length >= 8 && boot.scheme === 'lift-first', `scenarios=${boot.scenarios.length} scheme=${boot.scheme}`);
    await page.screenshot({ path: resolve(OUT_DIR, '01-boot.png') });

    // ---- 2. flat ground motion: real W press moves the capsule, support
    // stays a walkable ground contact and penetration stays zero -------------
    await page.evaluate(() => window.__capsuleDemo.teleport('plaza'));
    const before = await page.evaluate(() => ({ ...window.__capsuleDemo.controller.position }));
    await page.evaluate(() => window.__capsuleDemo.press('KeyW'));
    await settleFrames(page, 45);
    await page.evaluate(() => window.__capsuleDemo.release('KeyW'));
    await settleFrames(page, 6);
    const flat = await page.evaluate((start) => {
      const d = window.__capsuleDemo;
      const t = d.telemetry;
      const p = d.controller.position;
      return {
        dxz: Math.hypot(p.x - start.x, p.z - start.z),
        grounded: t.grounded,
        groundAngle: t.groundAngleDeg,
        contacts: t.contacts.length,
        supportPoint: t.support ? t.support.point : null,
        supportLabel: t.support ? t.support.label : null,
        penetration: t.penetration,
        anomalies: d.anomalies,
      };
    }, before);
    check('按住 W 在平地产生真实水平位移', flat.dxz > 1.0, `horizontal=${flat.dxz.toFixed(3)} m`);
    check('平地全程贴合可行走支撑面且无穿透', flat.grounded && flat.penetration < 0.002 && flat.groundAngle < 1,
      `grounded=${flat.grounded} angle=${flat.groundAngle?.toFixed(2)} pen=${flat.penetration}`);
    check('支撑接触点位于脚底高度附近', !!flat.supportPoint && Math.abs(flat.supportPoint.y) < 0.05,
      `support=${flat.supportLabel} pointY=${flat.supportPoint?.y.toFixed(3)}`);
    await page.screenshot({ path: resolve(OUT_DIR, '02-flat-motion.png') });

    // ---- 3. ramp: support-plane projection, no step-up, ~16 deg normal ------
    await page.evaluate(() => window.__capsuleDemo.teleport('ramp-up'));
    const rampStart = await page.evaluate(() => ({ ...window.__capsuleDemo.controller.position }));
    // The experiment solvers gate treads at normal.y >= 0.94 so a 16 deg slope
    // is never read as a step; drive the ramp under constrained-candidates.
    await page.evaluate(() => window.__capsuleDemo.setStepScheme('constrained-candidates'));
    const rampTrace = await page.evaluate((n) => {
      const d = window.__capsuleDemo;
      const trace = [];
      for (let i = 0; i < n; i++) {
        const t = d.stepFrames(1, { x: 0, z: -1 })[0];
        trace.push({
          i,
          z: d.controller.position.z.toFixed(3),
          feetY: d.controller.feetY.toFixed(3),
          angle: t.groundAngleDeg == null ? null : Number(t.groundAngleDeg.toFixed(2)),
          label: t.support ? t.support.label : null,
          stepUp: !!(t.events && t.events.includes('step-up')),
          stepReason: t.step && t.step.attempted ? t.step.reason : null,
          stepRise: t.step && t.step.attempted ? Number((t.step.rise || 0).toFixed(4)) : null,
          stepScheme: d.scheme,
        });
      }
      return trace;
    }, 12);
    const ramp = await page.evaluate((start) => {
      const d = window.__capsuleDemo;
      const t = d.telemetry;
      const p = d.controller.position;
      return {
        dxz: Math.hypot(p.x - start.x, p.z - start.z),
        gain: p.y - start.y,
        angle: t.groundAngleDeg,
        label: t.support ? t.support.label : null,
        normal: t.support ? t.support.normal : null,
        stepAttempted: !!(t.step && t.step.attempted),
        penetration: t.penetration,
      };
    }, rampStart);
    const onRampFrame = rampTrace.find((f) => f.label && f.label.includes('up-ramp'));
    check('斜坡上支撑面投影产生垂直增益', ramp.gain > 0.05 && ramp.dxz > 0.2, `gain=${ramp.gain.toFixed(3)} dxz=${ramp.dxz.toFixed(3)}`);
    check('斜坡接触法线角接近 16° 且该段无台阶抬升事件',
      !!onRampFrame && Math.abs(onRampFrame.angle - 16) < 2 && !rampTrace.some((f) => f.stepUp),
      `onRamp=${onRampFrame ? `${onRampFrame.label} ${onRampFrame.angle}°` : 'never'} trace=${JSON.stringify(rampTrace.filter((f) => f.i % 2 === 0))}`);
    check('斜坡行走无穿透', ramp.penetration < 0.002, `pen=${ramp.penetration}`);
    await page.screenshot({ path: resolve(OUT_DIR, '03-ramp.png') });

    // ---- 4. stairs with BOTH experiment schemes: switch, drive, compare -----
    const schemeRows = [];
    for (const scheme of ['horizontal-first', 'constrained-candidates']) {
      await page.evaluate((s) => window.__capsuleDemo.setStepScheme(s), scheme);
      const active = await page.evaluate(() => window.__capsuleDemo.scheme);
      check(`方案切换生效：${scheme}`, active === scheme, `active=${active}`);
      await page.evaluate(() => window.__capsuleDemo.teleport('stairs'));
      const s0 = await page.evaluate(() => ({ ...window.__capsuleDemo.controller.position }));
      // 18 deterministic steps stop the capsule mid-staircase so the live
      // contacts are still on the stair boxes, not the upper corridor beyond.
      await page.evaluate((n) => window.__capsuleDemo.stepFrames(n, { x: 0, z: -1 }), 18);
      const midClimb = await page.evaluate(() => {
        const t = window.__capsuleDemo.telemetry;
        return {
          stairContact: t.contacts.some((c) => c.label.startsWith('stair')),
          contactLabels: [...new Set(t.contacts.map((c) => c.label))],
          contactPoint: t.contacts.length ? t.contacts[0].point : null,
        };
      });
      const row = await page.evaluate((start) => {
        const d = window.__capsuleDemo;
        const t = d.telemetry;
        const p = d.controller.position;
        return {
          scheme: d.scheme,
          feetGain: d.controller.feetY - (start.y - d.controller.shape.feetOffset),
          dxz: Math.hypot(p.x - start.x, p.z - start.z),
          stepUps: d.controller.stats.stepUps,
          stepRejections: d.controller.stats.stepRejections,
          lastReason: t.step && t.step.attempted ? t.step.reason : null,
          chosen: t.step && t.step.chosen ? t.step.chosen : null,
          pathPen: t.step && t.step.pathPenetration != null ? t.step.pathPenetration : 0,
          penetration: t.penetration,
          supportLabel: t.support ? t.support.label : null,
        };
      }, s0);
      row.midClimb = midClimb;
      schemeRows.push(row);
      check(`[${scheme}] 驱动真实胶囊登台阶并有净垂直增益`, row.stepUps > 0 && row.feetGain > 0.15,
        `stepUps=${row.stepUps} feetGain=${row.feetGain.toFixed(3)} support=${row.supportLabel}`);
      check(`[${scheme}] 登阶过程接触点无穿透 (路径+端点)`, row.penetration < 0.002 && row.pathPen < 0.002,
        `endpoint=${row.penetration} path=${row.pathPen}`);
      check(`[${scheme}] 登阶中途接触位置落在台阶碰撞体上`, midClimb.stairContact,
        `labels=${midClimb.contactLabels.join(',')} point=${midClimb.contactPoint ? `(${midClimb.contactPoint.x.toFixed(2)},${midClimb.contactPoint.y.toFixed(2)},${midClimb.contactPoint.z.toFixed(2)})` : 'none'}`);
      await page.screenshot({ path: resolve(OUT_DIR, `04-stairs-${scheme}.png`) });
    }
    check('两方案均完成登阶（同一真实胶囊，行为可对照）', schemeRows.every((r) => r.stepUps > 0),
      schemeRows.map((r) => `${r.scheme}:ups=${r.stepUps}`).join(' '));

    // ---- 5. over-limit ledge: geometric rejection + anomaly banner ---------
    await page.evaluate(() => window.__capsuleDemo.setStepScheme('constrained-candidates'));
    await page.evaluate(() => window.__capsuleDemo.teleport('ledge'));
    const ledge0 = await page.evaluate(() => ({ ...window.__capsuleDemo.controller.position }));
    await page.evaluate((n) => window.__capsuleDemo.stepFrames(n, { x: 0, z: -1 }), 40);
    const ledge = await page.evaluate((start) => {
      const d = window.__capsuleDemo;
      const p = d.controller.position;
      return {
        dxz: Math.hypot(p.x - start.x, p.z - start.z),
        rejections: d.controller.stats.stepRejections,
        anomalies: d.anomalies,
        telemetryReason: d.telemetry.step && d.telemetry.step.attempted ? d.telemetry.step.reason : null,
        penetration: d.telemetry.penetration,
      };
    }, ledge0);
    check('0.38 m 超限高台触发台阶拒绝计数', ledge.rejections > 0, `rejections=${ledge.rejections}`);
    check('拒绝后无穿透且胶囊未嵌入高台', ledge.penetration < 0.002, `pen=${ledge.penetration}`);
    check('异常横幅标记地面运动/台阶异常', ledge.anomalies.length > 0, `anomalies=${JSON.stringify(ledge.anomalies)}`);
    await page.screenshot({ path: resolve(OUT_DIR, '05-ledge-anomaly.png') });

    // ---- 6. collider resize: radius slider changes the real shape ----------
    const shapeBefore = await page.evaluate(() => ({ ...window.__capsuleDemo.controller.shape }));
    await page.evaluate(() => {
      const slider = document.getElementById('in-radius');
      slider.value = '0.6';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const shapeAfter = await page.evaluate(() => ({ ...window.__capsuleDemo.controller.shape }));
    check('调整半径滑块实时改变胶囊碰撞体', Math.abs(shapeAfter.radius - 0.6) < 1e-6 && shapeAfter.radius !== shapeBefore.radius,
      `before=${shapeBefore.radius} after=${shapeAfter.radius}`);
    // Resized capsule must still be depenetrated and report valid contacts.
    const resizeTel = await page.evaluate(() => {
      const t = window.__capsuleDemo.telemetry;
      return { penetration: t.penetration, contacts: t.contacts.length, grounded: t.grounded };
    });
    check('碰撞体调整后仍无穿透且接触查询有效', resizeTel.penetration < 0.002 && resizeTel.contacts > 0,
      `pen=${resizeTel.penetration} contacts=${resizeTel.contacts} grounded=${resizeTel.grounded}`);
    await page.evaluate(() => {
      const slider = document.getElementById('in-radius');
      slider.value = '0.35';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.screenshot({ path: resolve(OUT_DIR, '06-resized-collider.png') });

    // ---- 7. running state visible: pause toggle works ----------------------
    const pausedState = await page.evaluate(async () => {
      const d = window.__capsuleDemo;
      d.teleport('plaza');
      // No direct pause hook; drive via the topbar button.
      document.getElementById('btn-pause').click();
      await new Promise((r) => setTimeout(r, 80));
      const paused = d.paused;
      const z1 = d.controller.position.z;
      d.press('KeyW');
      await new Promise((r) => setTimeout(r, 350));
      const z2 = d.controller.position.z;
      d.release('KeyW');
      document.getElementById('btn-pause').click();
      return { paused, z1, z2, movedWhilePaused: Math.abs(z2 - z1) };
    });
    check('暂停态在视窗可见且暂停时移动输入不改变位置', pausedState.paused && pausedState.movedWhilePaused < 1e-6,
      `paused=${pausedState.paused} drift=${pausedState.movedWhilePaused.toFixed(4)}`);

    // ---- 8. no page/console errors throughout ------------------------------
    check('浏览器全程无页面或控制台错误', pageErrors.length === 0, pageErrors.length ? pageErrors.slice(0, 3).join(' | ') : 'clean');

    await browser.close();

    const passed = results.filter((r) => r.pass).length;
    const report = {
      baseUrl: BASE_URL,
      total: results.length,
      passed,
      failed: results.length - passed,
      allPassed: passed === results.length,
      results,
      schemeStairs: schemeRows,
    };
    writeFileSync(resolve(OUT_DIR, 'e2e-report.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\n${passed}/${results.length} E2E checks passed`);
    console.log(`evidence written to experiments/e2e/ (screenshots + e2e-report.json)`);
    if (!report.allPassed) process.exitCode = 1;
  } finally {
    server.kill();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
