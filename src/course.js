import { makeBox } from './sim/colliders.js';
import { rad } from './sim/math.js';

const COLORS = {
  ground: 0x39414d,
  ramp: 0x41607a,
  plateau: 0x3c4c60,
  wall: 0x5a6472,
  step: 0x4d6078,
  ceiling: 0x6b7481,
  boundary: 0x464f5c,
  ledge: 0x7a5c4b,
  steep: 0x77605c,
};

const CORRIDOR_HALF = 1.5;
const WALL_HALF = 0.2;
const WALL_CENTER = CORRIDOR_HALF + WALL_HALF;

function box(id, label, center, half, { kind = 'wall', yaw = 0, pitch = 0 } = {}) {
  return makeBox({ id, label, center, half, yaw, pitch, kind, color: COLORS[kind] ?? COLORS.wall });
}

function slab(id, label, xMin, xMax, zMin, zMax, top, kind = 'ground') {
  const thickness = 0.8;
  if (zMax <= zMin || xMax <= xMin) {
    throw new Error(`slab ${id}: bad extent x[${xMin},${xMax}] z[${zMin},${zMax}]`);
  }
  return box(
    id,
    label,
    { x: (xMin + xMax) / 2, y: top - thickness / 2, z: (zMin + zMax) / 2 },
    { x: (xMax - xMin) / 2, y: thickness / 2, z: (zMax - zMin) / 2 },
    { kind },
  );
}

/**
 * Ramp rising toward -Z. `yBase` is the top-surface height at `zStart`, the
 * downhill edge. A negative angle descends. The surface normal and top height
 * are pure geometry and are used as the expectation in the replay checks.
 */
export function rampSpec({ id, label, x = 0, width = 3, zStart, yBase, angleDeg, run, thickness = 0.45 }) {
  const p = rad(angleDeg);
  const sp = Math.sin(p);
  const cp = Math.cos(p);
  const len = run / cp;
  const half = { x: width / 2, y: thickness / 2, z: len / 2 };
  const center = {
    x,
    y: yBase - cp * half.y + sp * half.z,
    z: zStart - sp * half.y - cp * half.z,
  };
  return {
    box: box(id, label, center, half, { kind: Math.abs(angleDeg) > 45 ? 'steep' : 'ramp', pitch: p }),
    yBase,
    zStart,
    zEnd: zStart - run,
    top: yBase + run * Math.tan(p),
    angleDeg,
    normal: { x: 0, y: cp, z: sp },
    width,
  };
}

export const STEP_RISE = 0.22;
export const STAIR_RUN = 0.42;
export const STAIR_COUNT = 4;
export const LEDGE_HEIGHT = 0.38;
export const DOOR_GAP = 1.05;

export function buildCourse() {
  const colliders = [];
  const markers = [];

  const zStartPlaza = 8.8;
  const zRampAStart = 9.0;
  const rampARun = 4;
  const rampAAngle = 16;

  // ---- start plaza -------------------------------------------------------
  colliders.push(slab('plaza', 'start plaza', -3.8, 3.8, zStartPlaza, 28.2, 0));
  colliders.push(box('plaza-wall-l', 'plaza wall left', { x: -4.0, y: 1.8, z: 18.5 }, { x: 0.2, y: 2.1, z: 9.7 }, { kind: 'boundary' }));
  colliders.push(box('plaza-wall-r', 'plaza wall right', { x: 4.0, y: 1.8, z: 18.5 }, { x: 0.2, y: 2.1, z: 9.7 }, { kind: 'boundary' }));
  colliders.push(box('plaza-wall-back', 'plaza wall back', { x: 0, y: 1.8, z: 28.4 }, { x: 4.0, y: 2.1, z: 0.2 }, { kind: 'boundary' }));
  colliders.push(box('plaza-front-l', 'plaza front left', { x: -2.65, y: 1.8, z: 9.05 }, { x: 1.15, y: 2.1, z: 0.2 }, { kind: 'boundary' }));
  colliders.push(box('plaza-front-r', 'plaza front right', { x: 2.65, y: 1.8, z: 9.05 }, { x: 1.15, y: 2.1, z: 0.2 }, { kind: 'boundary' }));

  // ---- 16 deg up-ramp -----------------------------------------------------
  const rampA = rampSpec({ id: 'ramp-a', label: '16 deg up-ramp', zStart: zRampAStart, yBase: 0, angleDeg: rampAAngle, run: rampARun });
  colliders.push(rampA.box);
  const plateauAY = rampA.top;
  colliders.push(slab('plateau-a', 'plateau A', -CORRIDOR_HALF, CORRIDOR_HALF, 2.6, rampA.zEnd + 0.1, plateauAY, 'plateau'));

  // ---- 22 deg down-ramp ---------------------------------------------------
  const rampBAngle = 22;
  const rampBRun = plateauAY / Math.tan(rad(rampBAngle));
  const rampB = rampSpec({ id: 'ramp-b', label: '22 deg down-ramp', zStart: 2.6, yBase: plateauAY, angleDeg: -rampBAngle, run: rampBRun });
  colliders.push(rampB.box);

  // ---- valley floor -------------------------------------------------------
  colliders.push(slab('valley', 'valley floor', -CORRIDOR_HALF, CORRIDOR_HALF, -1.2, rampB.zEnd + 0.35, 0));

  // ---- stairs, 4 x 0.22 m ------------------------------------------------
  const stairStartZ = -1.2;
  for (let i = 0; i < STAIR_COUNT; i++) {
    const top = STEP_RISE * (i + 1);
    const zFront = stairStartZ - STAIR_RUN * i;
    const zBack = zFront - STAIR_RUN;
    colliders.push(
      box(
        `stair-${i + 1}`,
        `stair ${i + 1} +${STEP_RISE.toFixed(2)}m`,
        { x: 0, y: top / 2 - 0.5, z: (zFront + zBack) / 2 },
        { x: CORRIDOR_HALF, y: top / 2 + 0.5, z: STAIR_RUN / 2 },
        { kind: 'step' },
      ),
    );
    markers.push({ id: `stair-${i + 1}`, kind: 'step', index: i + 1, rise: STEP_RISE, top, z: (zFront + zBack) / 2, x: 0 });
  }
  const stairTop = STEP_RISE * STAIR_COUNT;
  const stairEndZ = stairStartZ - STAIR_RUN * STAIR_COUNT;

  // ---- upper corridor floor ----------------------------------------------
  const upperEndZ = -9.8;
  colliders.push(slab('upper-floor', 'upper corridor floor', -CORRIDOR_HALF, CORRIDOR_HALF, upperEndZ, stairEndZ + 0.1, stairTop, 'plateau'));

  // ---- narrow door --------------------------------------------------------
  const doorZ = -4.0;
  const doorHeight = 2.2;
  const jambHalfX = 0.6;
  const jambCenter = DOOR_GAP / 2 + jambHalfX;
  const jambBottom = stairTop - 0.1;
  const jambTop = stairTop + doorHeight;
  colliders.push(box('door-jamb-l', 'narrow door jamb L', { x: -jambCenter, y: (jambBottom + jambTop) / 2, z: doorZ }, { x: jambHalfX, y: (jambTop - jambBottom) / 2, z: 0.22 }, { kind: 'wall' }));
  colliders.push(box('door-jamb-r', 'narrow door jamb R', { x: jambCenter, y: (jambBottom + jambTop) / 2, z: doorZ }, { x: jambHalfX, y: (jambTop - jambBottom) / 2, z: 0.22 }, { kind: 'wall' }));
  colliders.push(box('door-lintel', 'narrow door lintel', { x: 0, y: stairTop + doorHeight + 0.22, z: doorZ }, { x: jambCenter + jambHalfX, y: 0.22, z: 0.22 }, { kind: 'ceiling' }));
  markers.push({ id: 'door', kind: 'door', gap: DOOR_GAP, z: doorZ, floorY: stairTop, x: 0 });

  // ---- 0.38 m task ledge (right side; pass on the left) -------------------
  // Approach run before the ledge: door at z=-4, ledge starts at -6.2 so the
  // capsule is fully grounded well before the 0.38 m riser.
  const ledgeZFront = -6.2;
  const ledgeZBack = -6.9;
  const ledgeXMin = 0.45;
  const ledgeTop = stairTop + LEDGE_HEIGHT;
  colliders.push(
    box(
      'task-ledge',
      `task ledge +${LEDGE_HEIGHT.toFixed(2)}m`,
      { x: (ledgeXMin + CORRIDOR_HALF) / 2, y: (stairTop + ledgeTop) / 2, z: (ledgeZFront + ledgeZBack) / 2 },
      { x: (CORRIDOR_HALF - ledgeXMin) / 2, y: LEDGE_HEIGHT / 2, z: (ledgeZFront - ledgeZBack) / 2 },
      { kind: 'ledge' },
    ),
  );
  markers.push({ id: 'task-ledge', kind: 'ledge', height: LEDGE_HEIGHT, top: ledgeTop, z: (ledgeZFront + ledgeZBack) / 2, floorY: stairTop, x: (ledgeXMin + CORRIDOR_HALF) / 2 });

  // ---- 58 deg over-limit wedge (left side; pass on the right) ------------
  const steepZStart = -7.2;
  const steepRun = 0.8;
  const steepAngle = 58;
  const steepXMax = -0.65;
  const steep = rampSpec({
    id: 'ramp-steep',
    label: `${steepAngle} deg over-limit ramp`,
    x: (-CORRIDOR_HALF + steepXMax) / 2,
    width: steepXMax + CORRIDOR_HALF,
    zStart: steepZStart,
    yBase: stairTop,
    angleDeg: steepAngle,
    run: steepRun,
  });
  colliders.push(steep.box);
  markers.push({ id: 'ramp-steep', kind: 'steep', angleDeg: steepAngle, top: steep.top, z: steepZStart, floorY: stairTop, x: steep.box.center.x });

  // ---- corridor side walls -----------------------------------------------
  const wallZ0 = zStartPlaza + 0.4;
  const wallZ1 = upperEndZ - 0.4;
  const wallCenterZ = (wallZ0 + wallZ1) / 2;
  const wallHalfZ = Math.abs(wallZ0 - wallZ1) / 2;
  colliders.push(box('corridor-wall-l', 'corridor wall left', { x: -WALL_CENTER, y: 2.4, z: wallCenterZ }, { x: WALL_HALF, y: 2.6, z: wallHalfZ }, { kind: 'wall' }));
  colliders.push(box('corridor-wall-r', 'corridor wall right', { x: WALL_CENTER, y: 2.4, z: wallCenterZ }, { x: WALL_HALF, y: 2.6, z: wallHalfZ }, { kind: 'wall' }));

  // ---- concave corner: corridor +X wall meets the end wall ----------------
  const endZ = upperEndZ;
  colliders.push(box('end-wall', 'end wall', { x: 0, y: stairTop + 1.6, z: endZ - 0.2 }, { x: CORRIDOR_HALF + 0.2, y: 1.8, z: 0.2 }, { kind: 'boundary' }));

  return {
    colliders,
    markers,
    spawn: { x: 0, y: 1.7, z: 20.4 },
    features: {
      rampA,
      rampB,
      steep,
      plateauA: plateauAY,
      valleyY: 0,
      stairTop,
      stairRise: STEP_RISE,
      stairCount: STAIR_COUNT,
      stairStartZ,
      stairEndZ,
      doorGap: DOOR_GAP,
      doorZ,
      doorFloor: stairTop,
      ledgeHeight: LEDGE_HEIGHT,
      ledgeTop,
      ledgeZFront,
      ledgeZBack,
      ledgeXMin,
      steepZStart,
      steepTop: steep.top,
      corridorHalf: CORRIDOR_HALF,
      corner: { x: CORRIDOR_HALF, z: endZ, floorY: stairTop },
      zLayout: {
        plaza: [zStartPlaza, 28.2],
        rampA: [rampA.zEnd, rampA.zStart],
        plateauA: [2.6, rampA.zEnd],
        rampB: [rampB.zEnd, 2.6],
        stairs: [stairEndZ, stairStartZ],
        upper: [upperEndZ, stairEndZ],
      },
    },
  };
}
