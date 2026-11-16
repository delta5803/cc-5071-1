import { CharacterController, DEFAULT_CONFIG, STEP_SCHEMES } from '../sim/character.js';
import { makeBox, maxPenetration } from '../sim/colliders.js';
import { rampSpec } from '../course.js';
import { runStepScheme } from '../sim/step-schemes.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DT = 1 / 60;
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, '..', '..', 'experiments');

const SCHEMES = [
  { id: STEP_SCHEMES.HORIZONTAL_FIRST, name: '水平扫描再抬升' },
  { id: STEP_SCHEMES.CONSTRAINED_CANDIDATES, name: '受限多候选运动求解' },
];

function slab(id, center, half, kind = 'ground') {
  return makeBox({ id, label: id, center, half, kind });
}

/**
 * Each scenario is a small self-contained OBB world. `request` is one frame's
 * horizontal displacement (m); `spawn` places the capsule axis; `expect`
 * documents the geometric intent used by the sanity assertions.
 */
function buildScenario(id) {
  const r = DEFAULT_CONFIG.radius;
  const h = DEFAULT_CONFIG.height;
  const base = [slab('floor', { x: 0, y: -0.4, z: 0 }, { x: 3, y: 0.4, z: 3 })];

  if (id === 'low-headroom-step') {
    // 0.22 m riser under a ceiling whose underside is 2.10 m. A full 0.32 m
    // lift raises the capsule apex (start 1.70 m) to 2.02 m, leaving an 8 cm
    // gap: climbable but tight, so the headroom gate is exercised on every
    // attempt rather than being trivially satisfied.
    const ceilingUnder = 2.10;
    const colliders = [
      ...base,
      slab('riser', { x: 0, y: 0.11 - 0.4, z: -0.55 }, { x: 1.2, y: 0.51, z: 0.45 }, 'step'),
      slab('ceiling', { x: 0, y: ceilingUnder + 0.1, z: -1.05 }, { x: 1.4, y: 0.1, z: 0.7 }, 'ceiling'),
    ];
    return {
      id,
      title: '矮顶台阶（0.22 m 抬升，满抬升后仅剩 8 cm 净空）',
      colliders,
      spawn: { x: 0, y: h / 2, z: 0.25 },
      request: { x: 0, z: -0.18 },
      expect: { kind: 'step', rise: 0.22, ceilingUnder, headroomAtFullLift: ceilingUnder - (0.32 + h / 2 + r) },
    };
  }

  if (id === 'low-headroom-tight') {
    // Ceiling underside at 1.90 m: even the minimum 0.22 m lift puts the apex
    // at 1.92 m, 2 cm into the slab. Every correct solver rejects on headroom
    // with zero penetration; embedding the capsule is the only way to "succeed".
    const ceilingUnder = 1.90;
    const colliders = [
      ...base,
      slab('riser', { x: 0, y: 0.11 - 0.4, z: -0.55 }, { x: 1.2, y: 0.51, z: 0.45 }, 'step'),
      slab('ceiling', { x: 0, y: ceilingUnder + 0.1, z: -1.05 }, { x: 1.4, y: 0.1, z: 0.7 }, 'ceiling'),
    ];
    return {
      id,
      title: '极矮顶台阶（最小抬升仍侵入顶面 2 cm）',
      colliders,
      spawn: { x: 0, y: h / 2, z: 0.25 },
      request: { x: 0, z: -0.18 },
      expect: { kind: 'headroom-or-reject', rise: 0.22, ceilingUnder, headroomAtMinLift: ceilingUnder - (0.22 + h / 2 + r) },
    };
  }

  if (id === 'ramp-24') {
    // 24 deg ramp, inside the 46 deg walkable limit: the support-plane walk
    // handles it; a step solver invoked on the ramp geometry must not invent
    // a vertical step and must keep penetration at zero. The approach floor
    // stops at the ramp toe so no horizontal slab underlaps the slope and
    // corrupts its contact normal.
    const ramp = rampSpec({ id: 'ramp24', label: 'ramp24', zStart: 0.6, yBase: 0, angleDeg: 24, run: 2.4, width: 3 });
    const approach = slab('approach-floor', { x: 0, y: -0.4, z: 1.7 }, { x: 3, y: 0.4, z: 1.1 });
    return {
      id,
      title: '24° 斜坡（可行走，不应触发台阶抬升）',
      colliders: [approach, ramp.box],
      spawn: { x: 0, y: h / 2, z: 1.0 },
      request: { x: 0, z: -0.16 },
      // The single-frame request only walks a few centimetres; a driven ramp
      // demonstration needs a held command long enough to cross the approach
      // floor and actually climb the slope.
      holdDistance: 1.3,
      expect: { kind: 'ramp', angleDeg: 24, toeZ: 0.6 },
    };
  }

  if (id === 'over-limit-step') {
    // 0.38 m riser against a 0.32 m step limit: every solver must reject on
    // the geometric rise gate with zero forward commitment and zero
    // penetration, i.e. the capsule never tunnels into the tall block.
    const colliders = [
      ...base,
      slab('tall-block', { x: 0, y: 0.19 - 0.4, z: -0.5 }, { x: 1.2, y: 0.59, z: 0.5 }, 'ledge'),
    ];
    return {
      id,
      title: '超限台阶（0.38 m > 0.32 m 上限）',
      colliders,
      spawn: { x: 0, y: h / 2, z: 0.4 },
      request: { x: 0, z: -0.2 },
      expect: { kind: 'reject', rise: 0.38 },
    };
  }

  if (id === 'long-stride') {
    // One big frame stride (0.9 m) toward a 0.22 m riser 0.55 m away. The
    // distance-query sweep is bounded to maxSweepIterations; the metrics show
    // how much of the requested stride survives and whether sub-sampling finds
    // penetration the endpoint query misses.
    const colliders = [
      ...base,
      slab('riser', { x: 0, y: 0.11 - 0.4, z: -0.55 }, { x: 1.2, y: 0.51, z: 0.45 }, 'step'),
    ];
    return {
      id,
      title: '大步长单帧（0.90 m 请求，扫掠迭代受限）',
      colliders,
      spawn: { x: 0, y: h / 2, z: 0.25 },
      request: { x: 0, z: -0.9 },
      expect: { kind: 'step', rise: 0.22 },
    };
  }

  if (id === 'flat-ground') {
    return {
      id,
      title: '平地对照（无抬升，纯行走位移）',
      colliders: base,
      spawn: { x: 0, y: h / 2, z: 0.2 },
      request: { x: 0, z: -0.2 },
      expect: { kind: 'flat' },
    };
  }

  throw new Error(`unknown scenario ${id}`);
}

const SCENARIO_IDS = ['low-headroom-step', 'low-headroom-tight', 'ramp-24', 'over-limit-step', 'long-stride', 'flat-ground'];

function makeController(colliders, scheme) {
  const ctrl = new CharacterController({ stepScheme: scheme });
  ctrl.setColliders(colliders);
  return ctrl;
}

/**
 * Three independent penetration computations over the same geometry:
 *   A. maxPenetration at the final pose (endpoint query, what the UI shows)
 *   B. sub-sampling every 2 cm along the path actually traversed by the
 *      solver's sweeps (independent distance queries, catches tunnel-through
 *      frames; the starting pose t=0 is excluded so pre-existing overlap is
 *      never charged to the move)
 *   C. fresh maxPenetration re-query on a controller rebuilt at that pose
 * A and C must agree exactly; B must be >= A and is the number reported.
 *
 * Rejected solvers commit no position, so their path comes from the recorded
 * phases: the deepest penetration reached inside any attempted sweep is the
 * honest measure of how far the trial entered geometry.
 */
function penetrationCrossCheck(controller, startPos, endPos, phasePath) {
  const { halfSeg, radius, colliders, cfg } = {
    halfSeg: controller.shape.halfSeg,
    radius: controller.shape.radius,
    colliders: controller.colliders,
    cfg: controller.cfg,
  };
  const endpoint = maxPenetration(endPos, halfSeg, radius, colliders, cfg).depth;
  const rebuilt = new CharacterController({ ...cfg }).setColliders(colliders);
  rebuilt.position = { ...endPos };
  const reQuery = maxPenetration(rebuilt.position, halfSeg, radius, colliders, cfg).depth;
  let sampled = 0;
  let sampleCount = 0;
  const rawSegments = phasePath && phasePath.length
    ? phasePath.map((p) => [p.from, p.to])
    : [[startPos, endPos]];
  // Zero-length segments carry no traversed space (e.g. a geometric gate
  // rejection that never moved the capsule); skip them so the resting pose is
  // not misreported as motion-induced penetration.
  const segments = rawSegments.filter(([a, b]) => {
    if (!a || !b || !Number.isFinite(a.x) || !Number.isFinite(b.x)) return false;
    return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) > 1e-9;
  });
  for (const [a, b] of segments) {
    const span = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
    const dist = Math.hypot(span.x, span.y, span.z);
    const steps = Math.max(1, Math.ceil(dist / 0.02));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const p = { x: a.x + span.x * t, y: a.y + span.y * t, z: a.z + span.z * t };
      sampled = Math.max(sampled, maxPenetration(p, halfSeg, radius, colliders, cfg).depth);
      sampleCount++;
    }
  }
  const agree = Math.abs(endpoint - reQuery) < 1e-12;
  const sampledDominates = sampled + 1e-9 >= endpoint;
  return { endpoint, reQuery, sampled, samples: sampleCount, agree, sampledDominates };
}

/** Deterministic one-shot: call the solver directly with one request. */
function runOneShot(scenario, schemeId) {
  const ctrl = makeController(scenario.colliders, schemeId);
  ctrl.teleport({ ...scenario.spawn }, { snap: true });
  const start = { ...ctrl.position };
  const info = runStepScheme(schemeId, start, ctrl.shape, scenario.request, ctrl.support, scenario.colliders, ctrl.cfg);
  const end = info.success ? { ...info.position } : { ...start };
  const phasePath = info.phases.map((p) => ({ from: p.from, to: p.to }));
  const check = penetrationCrossCheck(ctrl, start, end, phasePath);
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  return {
    mode: 'one-shot',
    scheme: schemeId,
    scenario: scenario.id,
    success: info.success,
    reason: info.reason,
    chosen: info.chosen ?? null,
    candidates: (info.candidates || []).map((c) => ({ name: c.name, feasible: c.feasible, reason: c.reason })),
    violations: info.violations,
    headroomBlocked: !!info.headroomBlocked,
    requested: Math.hypot(scenario.request.x, scenario.request.z),
    reachable: Math.hypot(dx, dz),
    verticalGain: end.y - start.y,
    rise: info.rise,
    lift: info.lift,
    penetration: check,
    phases: info.phases.map((p) => ({ name: p.name, distance: p.distance, penetration: p.penetration })),
  };
}

/**
 * Driven run: the real CharacterController loop with the same fixed dt the
 * playground uses. Most scenarios convert one frame's request into a short
 * held command; a scenario may set holdDistance to walk far enough to reach a
 * feature farther away than the request (the 24 deg ramp, whose toe sits past
 * the short step-test stride).
 */
function runDriven(scenario, schemeId) {
  const ctrl = makeController(scenario.colliders, schemeId);
  ctrl.teleport({ ...scenario.spawn }, { snap: true });
  const start = { ...ctrl.position };
  const reqLen = Math.hypot(scenario.request.x, scenario.request.z);
  const walkLen = scenario.holdDistance ?? reqLen;
  // Enough frames for the acceleration model to cover the held distance, plus
  // a small settle margin.
  const cruiseFrames = walkLen / (DEFAULT_CONFIG.moveSpeed * DT);
  const frames = Math.max(6, Math.ceil(cruiseFrames) + 3);
  const move = { x: scenario.request.x / reqLen, z: scenario.request.z / reqLen };
  const telemetry = [];
  let stepAttempts = 0;
  let stepAccepted = 0;
  let headroomRejects = 0;
  for (let i = 0; i < frames; i++) {
    const tel = ctrl.step(DT, { move });
    telemetry.push(tel);
    if (tel.step && tel.step.attempted) {
      stepAttempts++;
      if (tel.step.success) stepAccepted++;
      if (tel.step.reason === 'headroom-blocked' || tel.step.headroomBlocked) headroomRejects++;
    }
  }
  const end = { ...ctrl.position };
  // Rebuild the ACTUAL traversed path. On a step frame the controller moves
  // along the solver's internal sweep polyline (lift/forward/drop); joining
  // only frame endpoints would draw a straight chord through the riser and
  // invent penetration that never happened. Step phases are spliced in where
  // they occur; ordinary frames contribute their endpoint segment.
  const truePath = [{ ...start }];
  for (const tel of telemetry) {
    const phases = tel.step && tel.step.attempted && Array.isArray(tel.step.phases) ? tel.step.phases : [];
    const complete = phases.filter((p) => p && p.from && p.to);
    if (complete.length) {
      for (const p of complete) truePath.push({ ...p.to });
    } else {
      truePath.push({ ...tel.position });
    }
  }
  const segments = [];
  for (let i = 1; i < truePath.length; i++) segments.push([truePath[i - 1], truePath[i]]);
  const check = penetrationCrossCheck(ctrl, start, end, segments);
  const maxFramePen = Math.max(0, ...telemetry.map((t) => t.penetration));
  // Ramp walk evidence: the steepest (largest tilt from horizontal) support
  // normal actually seen while grounded, plus the frame on which the capsule
  // first reached the ramp box. On the 24 deg scenario the support plane walk
  // must carry the capsule onto the slope without any accepted step-up.
  let maxGroundAngle = 0;
  let reachedRamp = false;
  let firstRampFrame = null;
  for (const tel of telemetry) {
    if (tel.grounded && tel.groundAngleDeg != null) {
      maxGroundAngle = Math.max(maxGroundAngle, tel.groundAngleDeg);
    }
    if (!reachedRamp && tel.support && tel.support.label === 'ramp24') {
      reachedRamp = true;
      firstRampFrame = tel.frame;
    }
  }
  const horizontalReach = Math.hypot(end.x - start.x, end.z - start.z);
  return {
    mode: 'driven',
    scheme: schemeId,
    scenario: scenario.id,
    frames,
    walkLength: walkLen,
    pathPoints: truePath.length,
    stepAttempts,
    stepAccepted,
    headroomRejects,
    grounded: ctrl.grounded,
    requested: walkLen,
    reachable: horizontalReach,
    verticalGain: end.y - start.y,
    maxGroundAngleDeg: maxGroundAngle,
    reachedRamp,
    firstRampFrame,
    maxFramePenetration: maxFramePen,
    penetration: check,
    supportLabel: ctrl.support ? ctrl.support.label : null,
    groundAngleDeg: ctrl.support ? ctrl.support.angleDeg : null,
  };
}

function fmt(n, d = 4) {
  return Number.isFinite(n) ? n.toFixed(d) : '—';
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const rows = [];
  const sanity = [];
  let allSanityPass = true;

  function assert(name, pass, detail) {
    sanity.push({ name, pass: !!pass, detail });
    if (!pass) allSanityPass = false;
  }

  for (const id of SCENARIO_IDS) {
    const scenario = buildScenario(id);
    for (const scheme of SCHEMES) {
      rows.push(runOneShot(scenario, scheme.id));
      rows.push(runDriven(scenario, scheme.id));
    }
  }

  // ---- sanity assertions tied to geometric expectations -------------------
  for (const row of rows) {
    assert(
      `[${row.mode}/${row.scenario}/${row.scheme}] 穿透三路复算一致`,
      row.penetration.agree && row.penetration.sampledDominates,
      `endpoint=${fmt(row.penetration.endpoint)} reQuery=${fmt(row.penetration.reQuery)} sampled=${fmt(row.penetration.sampled)}`,
    );
    assert(
      `[${row.mode}/${row.scenario}/${row.scheme}] 经过空间无显著穿透 (<2mm)`,
      row.penetration.sampled < 0.002,
      `sampled=${fmt(row.penetration.sampled)} m`,
    );
  }

  const oneShot = (scenario, scheme) => rows.find((r) => r.mode === 'one-shot' && r.scenario === scenario && r.scheme === scheme);
  for (const scheme of SCHEMES) {
    const over = oneShot('over-limit-step', scheme.id);
    assert(`[${scheme.id}] 0.38m 超限台阶被几何门控拒绝`, over.reason === 'rise-exceeds-limit' && !over.success, `reason=${over.reason}`);
    assert(`[${scheme.id}] 拒绝时可达位移为 0`, over.reachable < 1e-6, `reachable=${fmt(over.reachable)}`);
    const flat = oneShot('flat-ground', scheme.id);
    assert(`[${scheme.id}] 平地不产生台阶抬升`, flat.verticalGain < 1e-6, `gain=${fmt(flat.verticalGain)}`);
  }
  // The two solvers must actually differ on the riser-face case: the
  // horizontal-first sweep records a riser block before lifting.
  const hfRiser = oneShot('low-headroom-step', STEP_SCHEMES.HORIZONTAL_FIRST);
  assert(
    '水平方案在矮顶台阶记录到立面阻挡事件',
    hfRiser.violations.some((v) => v.kind === 'riser-block'),
    `violations=${hfRiser.violations.map((v) => v.kind).join(',') || 'none'}`,
  );
  const ccRiser = oneShot('low-headroom-step', STEP_SCHEMES.CONSTRAINED_CANDIDATES);
  assert(
    '多候选方案在矮顶台阶选出可行候选并登阶',
    ccRiser.success && typeof ccRiser.chosen === 'string',
    `success=${ccRiser.success} chosen=${ccRiser.chosen} reason=${ccRiser.reason}`,
  );

  // ---- ramp: the step solvers must refuse the slope, the support-plane walk
  // must actually climb it --------------------------------------------------
  for (const scheme of SCHEMES) {
    const rampShot = oneShot('ramp-24', scheme.id);
    assert(
      `[${scheme.id}] 斜坡不被当成台阶 (no-tread 拒绝)`,
      !rampShot.success && rampShot.reason === 'no-tread',
      `success=${rampShot.success} reason=${rampShot.reason}`,
    );
    const rampDrive = rows.find((r) => r.mode === 'driven' && r.scenario === 'ramp-24' && r.scheme === scheme.id);
    assert(
      `[${scheme.id}] 驱动模式真正走上斜坡 (支撑面命中 ramp24)`,
      rampDrive.reachedRamp && rampDrive.supportLabel === 'ramp24',
      `reached=${rampDrive.reachedRamp} support=${rampDrive.supportLabel} frame=${rampDrive.firstRampFrame}`,
    );
    assert(
      `[${scheme.id}] 斜坡行走期间不产生台阶接受事件`,
      rampDrive.stepAccepted === 0,
      `attempts=${rampDrive.stepAttempts} accepted=${rampDrive.stepAccepted}`,
    );
    assert(
      `[${scheme.id}] 斜坡支撑角达到 ~24°`,
      Math.abs(rampDrive.maxGroundAngleDeg - 24) < 1.5,
      `maxAngle=${fmt(rampDrive.maxGroundAngleDeg, 2)}°`,
    );
    // Support-plane projection raises the capsule by horizontal distance times
    // tan(24 deg) while on the slope. The capsule reaches the toe only after
    // crossing part of the approach floor, so assert the sign and that the
    // realised gain does not exceed the pure-slope bound; a precise value would
    // depend on how many frames remain on the flat approach.
    const slopeBound = rampDrive.reachable * Math.tan((24 * Math.PI) / 180);
    assert(
      `[${scheme.id}] 斜坡垂直增益为正且不超过水平位移×tan24°`,
      rampDrive.verticalGain > 0.02 && rampDrive.verticalGain <= slopeBound + 0.05,
      `gain=${fmt(rampDrive.verticalGain, 3)} bound=${fmt(slopeBound, 3)} reach=${fmt(rampDrive.reachable, 3)}`,
    );
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    dt: DT,
    config: {
      radius: DEFAULT_CONFIG.radius,
      height: DEFAULT_CONFIG.height,
      stepHeight: DEFAULT_CONFIG.stepHeight,
      slopeLimitDeg: DEFAULT_CONFIG.slopeLimitDeg,
      maxSweepIterations: DEFAULT_CONFIG.maxSweepIterations,
    },
    scenarios: SCENARIO_IDS,
    schemes: SCHEMES,
    sanity,
    allSanityPass,
    rows,
  };
  const jsonText = `${JSON.stringify(payload, null, 2)}\n`;
  writeFileSync(resolve(OUT_DIR, 'step-results.json'), jsonText);
  const checksum = createHash('sha256').update(jsonText).digest('hex');

  // ---- human-readable table ------------------------------------------------
  const lines = [];
  lines.push('# 台阶方案实验 · 机器生成数据');
  lines.push('');
  lines.push(`生成时间：${payload.generatedAt}`);
  lines.push(`固定步长：${DT} s · 胶囊 r=${DEFAULT_CONFIG.radius} m h=${DEFAULT_CONFIG.height} m · 台阶上限 ${DEFAULT_CONFIG.stepHeight} m · 扫掠迭代上限 ${DEFAULT_CONFIG.maxSweepIterations}`);
  lines.push('');
  lines.push('穿透量经三路独立复算：终点查询(A)、重建控制器再查询(C)、沿路径每 2 cm 子采样(B)。A=C 且 B≥A，下表报 B（毫米）。');
  lines.push('');
  lines.push('## 一次性求解（单帧请求直接驱动求解器）');
  lines.push('');
  lines.push('| 场景 | 方案 | 结果 | 原因/选中 | 请求(m) | 可达位移(m) | 垂直增益(m) | 穿透(mm) | 立面阻挡 | 净空拒绝 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of rows.filter((r) => r.mode === 'one-shot')) {
    lines.push(
      `| ${r.scenario} | ${r.scheme} | ${r.success ? '登阶' : '拒绝'} | ${r.chosen ? r.chosen : r.reason} | ${fmt(r.requested, 3)} | ${fmt(r.reachable, 3)} | ${fmt(r.verticalGain, 3)} | ${fmt(r.penetration.sampled * 1000, 2)} | ${r.violations.some((v) => v.kind === 'riser-block') ? '是' : '否'} | ${r.headroomBlocked ? '是' : '否'} |`,
    );
  }
  lines.push('');
  lines.push('## 驱动接入（真实 CharacterController 循环，同一步长）');
  lines.push('');
  lines.push('| 场景 | 方案 | 帧数 | 台阶尝试/接受 | 行进(m) | 可达位移(m) | 垂直增益(m) | 帧内最大穿透(mm) | 路径穿透(mm) | 支撑面 | 地面角 | 最大坡角 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of rows.filter((r) => r.mode === 'driven')) {
    lines.push(
      `| ${r.scenario} | ${r.scheme} | ${r.frames} | ${r.stepAttempts}/${r.stepAccepted} | ${fmt(r.walkLength, 3)} | ${fmt(r.reachable, 3)} | ${fmt(r.verticalGain, 3)} | ${fmt(r.maxFramePenetration * 1000, 2)} | ${fmt(r.penetration.sampled * 1000, 2)} | ${r.supportLabel ?? '—'} | ${r.groundAngleDeg == null ? '—' : r.groundAngleDeg.toFixed(1) + '°'} | ${r.reachedRamp ? r.maxGroundAngleDeg.toFixed(1) + '°' : '—'} |`,
    );
  }
  lines.push('');
  lines.push('## 健全性断言');
  lines.push('');
  for (const s of sanity) lines.push(`- ${s.pass ? 'PASS' : 'FAIL'} ${s.name} — ${s.detail}`);
  lines.push('');
  lines.push(`数据校验和 (sha256 of step-results.json): \`${checksum}\``);
  lines.push('');
  writeFileSync(resolve(OUT_DIR, 'step-results.md'), `${lines.join('\n')}\n`);

  for (const s of sanity) console.log(`${s.pass ? 'PASS' : 'FAIL'}  ${s.name}  ${s.detail}`);
  console.log(`\n${sanity.filter((s) => s.pass).length}/${sanity.length} sanity checks passed`);
  console.log(`wrote experiments/step-results.json + step-results.md (sha256 ${checksum.slice(0, 16)}…)`);
  if (!allSanityPass) process.exit(1);
}

main();
