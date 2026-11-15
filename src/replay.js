import { CharacterController, DEFAULT_CONFIG } from './sim/character.js';
import { maxPenetration } from './sim/colliders.js';
import { buildCourse } from './course.js';

const DT = 1 / 60;

function makeController(course, overrides = {}) {
  return new CharacterController(overrides).setColliders(course.colliders);
}

function spawnAt(ctrl, x, z, y) {
  ctrl.teleport({ x, y: y ?? ctrl.shape.feetOffset + 2.5, z }, { snap: true });
  return ctrl.position;
}

/**
 * Drive the controller with a deterministic command script. Every frame's
 * telemetry is returned so checks inspect penetration, realised distance and
 * state transitions instead of trusting the final position alone.
 */
export function runScript(ctrl, script) {
  const frames = [];
  for (const segment of script) {
    const ticks = Math.round(segment.seconds / DT);
    for (let i = 0; i < ticks; i++) {
      const tel = ctrl.step(DT, {
        move: segment.move || { x: 0, z: 0 },
        jump: segment.jump === true && i === (segment.jumpFrame ?? 0),
        cameraYaw: segment.cameraYaw || 0,
      });
      frames.push({ ...tel, segment: segment.name, tick: i });
    }
  }
  return frames;
}

function summarize(frames) {
  let maxPen = 0;
  let maxSlideIterations = 0;
  let maxSlidePlanes = 0;
  let stepUps = 0;
  let stepRejections = 0;
  let maxGroundAngle = 0;
  let groundedFrames = 0;
  for (const f of frames) {
    maxPen = Math.max(maxPen, f.penetration);
    if (f.slide) {
      maxSlideIterations = Math.max(maxSlideIterations, f.slide.iterations);
      maxSlidePlanes = Math.max(maxSlidePlanes, f.slide.planes);
    }
    if (f.step) {
      if (f.step.success) stepUps++;
      else stepRejections++;
    }
    if (f.groundAngleDeg != null) maxGroundAngle = Math.max(maxGroundAngle, f.groundAngleDeg);
    if (f.grounded) groundedFrames++;
  }
  return { maxPen, maxSlideIterations, maxSlidePlanes, stepUps, stepRejections, maxGroundAngle, groundedFrames };
}

function check(list, name, pass, detail) {
  list.push({ name, pass: !!pass, detail });
}

function footprint(ctrl, course) {
  return maxPenetration(ctrl.position, ctrl.shape.halfSeg, ctrl.shape.radius, course.colliders, ctrl.cfg);
}

export function runReplayChecks() {
  const course = buildCourse();
  const f = course.features;
  const results = [];

  // --------------------------------------------------------- 16 deg ramp up
  {
    const ctrl = makeController(course);
    spawnAt(ctrl, 0, 20.4);
    const frames = runScript(ctrl, [{ name: 'up-ramp', seconds: 4.0, move: { x: 0, z: -1 } }]);
    const sum = summarize(frames);
    const onRamp = frames.filter((fr) => fr.support && fr.support.label === '16 deg up-ramp');
    const riseOnRamp = onRamp.length
      ? onRamp[onRamp.length - 1].support.point.y - onRamp[0].support.point.y
      : 0;
    check(results, '16deg ramp: climbs to plateau A', Math.abs(ctrl.feetY - f.plateauA) < 0.05, `feet=${ctrl.feetY.toFixed(3)} plateau=${f.plateauA.toFixed(3)}`);
    check(results, '16deg ramp: contact normal angle equals geometric angle', onRamp.length > 0 && onRamp.every((fr) => Math.abs(fr.groundAngleDeg - 16) < 0.6), `samples=${onRamp.length}, angles=${[...new Set(onRamp.map((fr) => fr.groundAngleDeg.toFixed(1)))].join(',')}`);
    check(results, '16deg ramp: no penetration while climbing', sum.maxPen < 0.01, `maxPen=${sum.maxPen.toFixed(4)} m`);
  }

  // ------------------------------------------------------- 22 deg ramp down
  {
    const ctrl = makeController(course);
    spawnAt(ctrl, 0, 5.5);
    const frames = runScript(ctrl, [{ name: 'down-ramp', seconds: 1.7, move: { x: 0, z: -1 } }]);
    const sum = summarize(frames);
    const onRamp = frames.filter((fr) => fr.support && fr.support.label === '22 deg down-ramp');
    check(results, '22deg ramp: descends while grounded', onRamp.length > 25 && onRamp.every((fr) => fr.grounded), `samples=${onRamp.length}`);
    check(results, '22deg ramp: contact normal angle equals geometric angle', onRamp.length > 0 && onRamp.every((fr) => Math.abs(fr.groundAngleDeg - 22) < 0.6), `angles=${[...new Set(onRamp.map((fr) => fr.groundAngleDeg.toFixed(1)))].join(',')}`);
    check(results, '22deg ramp: no penetration', sum.maxPen < 0.01, `maxPen=${sum.maxPen.toFixed(4)} m`);
  }

  // ---------------------------------------------------- 58 deg slope limit
  {
    const ctrl = makeController(course);
    // spawn on the upper floor in front of the steep wedge, then push into it
    spawnAt(ctrl, -0.925, f.steepZStart + 0.9);
    const startY = ctrl.feetY;
    const frames = runScript(ctrl, [{ name: 'push-steep', seconds: 1.4, move: { x: 0, z: -1 } }]);
    const sum = summarize(frames);
    const climbed = ctrl.feetY - startY;
    const steepContacts = frames.filter((fr) => fr.contacts.some((c) => c.boxId === 'ramp-steep'));
    check(results, '58deg ramp: slope limit blocks climbing', climbed < 0.2, `rise=${climbed.toFixed(3)} m, limit=${DEFAULT_CONFIG.slopeLimitDeg} deg`);
    check(results, '58deg ramp: capsule actually touches the steep face', steepContacts.length > 0, `frames touching steep=${steepContacts.length}`);
    check(results, '58deg ramp: never marked walkable', frames.every((fr) => !fr.grounded || fr.groundAngleDeg <= DEFAULT_CONFIG.slopeLimitDeg + 0.6), `max walkable angle=${sum.maxGroundAngle.toFixed(2)}`);
    check(results, '58deg ramp: no penetration', sum.maxPen < 0.02, `maxPen=${sum.maxPen.toFixed(4)} m`);
  }

  // ---------------------------------------------------------- stairs 4 x 0.22
  {
    const ctrl = makeController(course);
    spawnAt(ctrl, 0, -0.75);
    const frames = runScript(ctrl, [{ name: 'stairs', seconds: 1.4, move: { x: 0, z: -1 } }]);
    const sum = summarize(frames);
    // Behavioural evidence: the capsule must actually stand on each tread at
    // 0.22/0.44/0.66/0.88 m, and the risers must be climbed via step events.
    const treads = new Set();
    for (const fr of frames) {
      if (!fr.grounded || !fr.support) continue;
      const h = Math.round(fr.support.point.y * 100) / 100;
      if (h >= 0.2) treads.add(h);
    }
    const stepEvents = frames.filter((fr) => fr.events.includes('step-up')).length;
    const allTreads = [0.22, 0.44, 0.66, 0.88].every((h) => [...treads].some((t) => Math.abs(t - h) < 0.02));
    check(results, 'stairs: each 0.22 m tread is stood on', allTreads, `treads visited=[${[...treads].sort((a, b) => a - b).join(', ')}]`);
    check(results, 'stairs: reaches stair-top height', Math.abs(ctrl.feetY - f.stairTop) < 0.05, `feet=${ctrl.feetY.toFixed(3)} expected=${f.stairTop.toFixed(3)}`);
    check(results, 'stairs: step rejection count is bounded', sum.stepRejections < 12, `rejections=${sum.stepRejections}, accepted=${sum.stepUps}`);
    check(results, 'stairs: no penetration', sum.maxPen < 0.01, `maxPen=${sum.maxPen.toFixed(4)} m`);
  }

  // ------------------------------------------------- 0.38 m ledge is too tall
  {
    const ctrl = makeController(course);
    spawnAt(ctrl, 0.98, -5.1);
    const frames = runScript(ctrl, [{ name: 'push-ledge', seconds: 1.2, move: { x: 0, z: -1 } }]);
    const sum = summarize(frames);
    const rejects = frames.filter((fr) => fr.step && !fr.step.success);
    const reasons = [...new Set(rejects.map((fr) => fr.step.reason))];
    const climbed = ctrl.feetY - f.stairTop;
    check(results, '0.38m ledge: rejected by geometric rise limit', reasons.includes('rise-exceeds-limit'), `reasons=[${reasons.join(',')}]`);
    check(results, '0.38m ledge: capsule cannot mount it', climbed < 0.06, `rise=${climbed.toFixed(3)} m (ledge=${f.ledgeHeight} m, limit=${DEFAULT_CONFIG.stepHeight} m)`);
    check(results, '0.38m ledge: measured obstacle height matches geometry', rejects.some((fr) => Math.abs(fr.step.obstacleTop - f.ledgeTop) < 0.01), `measured tops=[${[...new Set(rejects.map((fr) => fr.step.obstacleTop?.toFixed(3)))].join(',')}] expected=${f.ledgeTop.toFixed(3)}`);
    check(results, '0.38m ledge: no penetration', sum.maxPen < 0.02, `maxPen=${sum.maxPen.toFixed(4)} m`);
  }

  // ------------------------------------------------------------- narrow door
  {
    const ctrl = makeController(course);
    spawnAt(ctrl, 0, -3.0);
    const frames = runScript(ctrl, [{ name: 'through-door', seconds: 1.5, move: { x: 0, z: -1 } }]);
    const sum = summarize(frames);
    check(results, 'narrow door: capsule fits 1.05 m gap', ctrl.position.z < f.doorZ - 0.35, `final z=${ctrl.position.z.toFixed(3)} door z=${f.doorZ}`);
    check(results, 'narrow door: no penetration while squeezing', sum.maxPen < 0.02, `maxPen=${sum.maxPen.toFixed(4)} m`);
  }

  // ------------------------------------- concave corner: bounded, settles
  {
    const ctrl = makeController(course);
    spawnAt(ctrl, 0.35, -8.9);
    const frames = runScript(ctrl, [{ name: 'into-corner', seconds: 2.0, move: { x: 0.7071, z: -0.7071 } }]);
    const sum = summarize(frames);
    const tail = frames.slice(Math.floor(frames.length * 0.6));
    let maxTailStep = 0;
    for (let i = 1; i < tail.length; i++) {
      maxTailStep = Math.max(maxTailStep, Math.hypot(tail[i].position.x - tail[i - 1].position.x, tail[i].position.z - tail[i - 1].position.z));
    }
    check(results, 'concave corner: slide iterations stay bounded', sum.maxSlideIterations <= DEFAULT_CONFIG.maxSlideIterations, `max iterations=${sum.maxSlideIterations} cap=${DEFAULT_CONFIG.maxSlideIterations}`);
    check(results, 'concave corner: multi-plane clip engaged', sum.maxSlidePlanes >= 2, `max simultaneous planes=${sum.maxSlidePlanes}`);
    check(results, 'concave corner: settles without oscillation', maxTailStep < 0.01, `max per-frame tail delta=${maxTailStep.toFixed(5)} m`);
    check(results, 'concave corner: no penetration', sum.maxPen < 0.01, `maxPen=${sum.maxPen.toFixed(4)} m`);
    check(results, 'concave corner: stays inside pocket', ctrl.position.x < f.corridorHalf + 0.02 && ctrl.position.z > f.corner.z - 0.02, `pos=(${ctrl.position.x.toFixed(3)}, ${ctrl.position.z.toFixed(3)}) walls x=${f.corridorHalf} z=${f.corner.z}`);
  }

  // ------------------------------------------------ jump + landing transitions
  {
    const ctrl = makeController(course);
    spawnAt(ctrl, 0, 14.5);
    const frames = runScript(ctrl, [
      { name: 'run', seconds: 0.5, move: { x: 0, z: -1 } },
      { name: 'jump', seconds: 0.02, move: { x: 0, z: -1 }, jump: true },
      { name: 'air', seconds: 1.1, move: { x: 0, z: -1 } },
      { name: 'settle', seconds: 0.5, move: { x: 0, z: 0 } },
    ]);
    const transitions = ctrl.transitions.map((t) => `${t.from}->${t.to}`);
    const peak = Math.max(...frames.map((fr) => fr.position.y));
    check(results, 'jump: grounded->airborne->grounded cycle recorded', transitions.includes('grounded->airborne') && transitions.includes('airborne->grounded'), `transitions=[${transitions.join(', ')}]`);
    check(results, 'jump: leaves and returns to the ground', peak > 0.85 + 0.6 && ctrl.grounded, `peak capsule y=${peak.toFixed(3)} end grounded=${ctrl.grounded}`);
  }

  // --------------------------------- wall slide: realised vs expected distance
  {
    // Start near the +X corridor wall and push diagonally into it: the X axis
    // must stop at wall - radius while the Z axis keeps its tangential speed.
    const ctrl = makeController(course);
    spawnAt(ctrl, 0.6, 3.0);
    const start = { ...ctrl.position };
    const frames = runScript(ctrl, [{ name: 'diagonal-into-wall', seconds: 1.0, move: { x: 0.7071, z: -0.7071 } }]);
    const sum = summarize(frames);
    const dz = start.z - ctrl.position.z;
    const expectedDz = DEFAULT_CONFIG.moveSpeed * 0.7071 * 1.0;
    const wallInner = f.corridorHalf;
    const maxCenterX = wallInner - DEFAULT_CONFIG.radius + 0.03;
    check(results, 'wall slide: tangential travel preserved', Math.abs(dz - expectedDz) < 0.6, `dz=${dz.toFixed(3)} m, expected ~${expectedDz.toFixed(3)} m`);
    check(results, 'wall slide: blocked axis stops at the wall', ctrl.position.x <= maxCenterX, `x=${ctrl.position.x.toFixed(3)}, limit=${maxCenterX.toFixed(3)}`);
    check(results, 'wall slide: no penetration', sum.maxPen < 0.01, `maxPen=${sum.maxPen.toFixed(4)} m`);
  }

  // --------------------------------------- capsule resize: depenetrates safely
  {
    const ctrl = makeController(course);
    spawnAt(ctrl, 0, 13);
    ctrl.configure({ radius: 0.62, height: 2.3 });
    const pen = footprint(ctrl, course).depth;
    check(results, 'resize: wider capsule is depenetrated from the corridor', pen < 0.02, `penetration=${pen.toFixed(4)} m`);
    const fits = ctrl.step(DT, { move: { x: 0, z: -1 } });
    check(results, 'resize: still responds to input after resize', Math.hypot(fits.horizontalActual.x, fits.horizontalActual.z) > 1e-4, `moved=${fitStr(fits)}`);
    ctrl.configure({ radius: 0.35, height: 1.7 });
    const pen2 = footprint(ctrl, course).depth;
    check(results, 'resize: shrink keeps capsule outside geometry', pen2 < 0.02, `penetration=${pen2.toFixed(4)} m`);
  }

  // ------------------------------------------------ full traverse walkability
  {
    const ctrl = makeController(course);
    spawnAt(ctrl, 0, 20.0);
    const frames = runScript(ctrl, [{ name: 'traverse', seconds: 6.6, move: { x: 0, z: -1 } }]);
    const sum = summarize(frames);
    check(results, 'traverse: no penetration over the whole course', sum.maxPen < 0.02, `maxPen=${sum.maxPen.toFixed(4)} m`);
    check(results, 'traverse: slide iterations bounded everywhere', sum.maxSlideIterations <= DEFAULT_CONFIG.maxSlideIterations, `max=${sum.maxSlideIterations}`);
    check(results, 'traverse: reaches the upper corridor', Math.abs(ctrl.feetY - f.stairTop) < 0.08, `feet=${ctrl.feetY.toFixed(3)} expected=${f.stairTop.toFixed(3)}`);
  }

  return { results, passed: results.filter((r) => r.pass).length, total: results.length, course };
}

function ctrlShape(ctrl) {
  return ctrl.shape.feetOffset;
}

function fitStr(fr) {
  return `(${fr.horizontalActual.x.toFixed(4)}, ${fr.horizontalActual.z.toFixed(4)})`;
}

if (typeof process !== 'undefined' && process.argv && process.argv[1] && process.argv[1].endsWith('replay.js')) {
  const { results, passed, total } = runReplayChecks();
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}  ${r.detail}`);
  console.log(`\n${passed}/${total} checks passed`);
  process.exit(passed === total ? 0 : 1);
}
