import * as THREE from 'three';
import { buildCourse } from './course.js';
import { CharacterController } from './sim/character.js';
import { runReplayChecks } from './replay.js';

const $ = (id) => document.getElementById(id);
const viewportEl = $('viewport');

// ---------------------------------------------------------------------------
// course + controller (the only source of truth for motion and contacts)
// ---------------------------------------------------------------------------
const course = buildCourse();
const features = course.features;
const controller = new CharacterController().setColliders(course.colliders);

const rad = (d) => (d * Math.PI) / 180;
const rampFeet = (ramp, z) => ramp.yBase + (ramp.zStart - z) * Math.tan(rad(ramp.angleDeg));

// ---------------------------------------------------------------------------
// renderer / scene / camera
// ---------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
viewportEl.appendChild(renderer.domElement);
renderer.domElement.style.touchAction = 'none';

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0c1016);
scene.fog = new THREE.Fog(0x0c1016, 24, 58);

const camera = new THREE.PerspectiveCamera(52, 1, 0.05, 150);

const hemi = new THREE.HemisphereLight(0xbcd6ea, 0x20262e, 1.35);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff0da, 2.4);
sun.position.set(7, 13, 9);
sun.target.position.set(0, 0, 2);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -16;
sun.shadow.camera.right = 16;
sun.shadow.camera.top = 16;
sun.shadow.camera.bottom = -16;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 46;
sun.shadow.bias = -0.0006;
scene.add(sun);
scene.add(sun.target);
const fill = new THREE.DirectionalLight(0x88b8d8, 0.55);
fill.position.set(-9, 6, -7);
scene.add(fill);

// Local key light that follows the character so the corridor interior — where
// the sun is occluded — still reads clearly.
const charLight = new THREE.PointLight(0xffe7c4, 5.5, 8, 2);
scene.add(charLight);

const cameraRay = new THREE.Raycaster();
cameraRay.far = 20;
const colliderMeshList = [];

// ---------------------------------------------------------------------------
// collider meshes
// ---------------------------------------------------------------------------
const edgeMaterial = new THREE.LineBasicMaterial({ color: 0xa9bacb, transparent: true, opacity: 0.13 });
const colliderMeshes = new Map();

for (const box of course.colliders) {
  const geo = new THREE.BoxGeometry(box.half.x * 2, box.half.y * 2, box.half.z * 2);
  const mat = new THREE.MeshStandardMaterial({
    color: box.color,
    roughness: 0.9,
    metalness: 0.02,
    flatShading: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(box.center.x, box.center.y, box.center.z);
  const m = new THREE.Matrix4().set(
    box.rotation[0], box.rotation[1], box.rotation[2], 0,
    box.rotation[3], box.rotation[4], box.rotation[5], 0,
    box.rotation[6], box.rotation[7], box.rotation[8], 0,
    0, 0, 0, 1,
  );
  mesh.setRotationFromMatrix(m);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);
  colliderMeshList.push(mesh);
  colliderMeshes.set(box.id, mesh);

  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMaterial);
  edges.position.copy(mesh.position);
  edges.quaternion.copy(mesh.quaternion);
  scene.add(edges);
}

// ---------------------------------------------------------------------------
// character visual (capsule + procedural walk proxy)
// ---------------------------------------------------------------------------
const character = new THREE.Group();
scene.add(character);
const bodyGroup = new THREE.Group();
character.add(bodyGroup);

const bodyMaterial = new THREE.MeshStandardMaterial({
  color: 0xffc869,
  roughness: 0.42,
  metalness: 0.08,
  emissive: 0x3a2609,
  emissiveIntensity: 0.7,
});
const wireMaterial = new THREE.MeshBasicMaterial({
  color: 0x8fe6f2,
  wireframe: true,
  transparent: true,
  opacity: 0.24,
  depthWrite: false,
});
const visorMaterial = new THREE.MeshStandardMaterial({
  color: 0x141b24,
  roughness: 0.25,
  metalness: 0.5,
  emissive: 0x1b3f47,
  emissiveIntensity: 0.8,
});
const visorGeo = new THREE.SphereGeometry(1, 16, 12);

let bodyMesh = null;
let wireMesh = null;
let visorMesh = null;
let bodyBaseY = 0.85;

function rebuildCharacterMesh() {
  const { radius, halfSeg, height } = controller.shape;
  if (bodyMesh) {
    bodyGroup.remove(bodyMesh);
    bodyMesh.geometry.dispose();
  }
  if (wireMesh) {
    bodyGroup.remove(wireMesh);
    wireMesh.geometry.dispose();
  }
  const geo = new THREE.CapsuleGeometry(radius, Math.max(0.001, halfSeg * 2), 6, 16);
  bodyMesh = new THREE.Mesh(geo, bodyMaterial);
  bodyMesh.castShadow = true;
  bodyMesh.receiveShadow = true;
  bodyBaseY = height / 2;
  bodyMesh.position.y = bodyBaseY;
  bodyGroup.add(bodyMesh);

  wireMesh = new THREE.Mesh(geo, wireMaterial);
  wireMesh.position.y = bodyBaseY;
  bodyGroup.add(wireMesh);

  if (!visorMesh) {
    visorMesh = new THREE.Mesh(visorGeo, visorMaterial);
    visorMesh.castShadow = true;
    character.add(visorMesh);
  }
  visorMesh.scale.setScalar(Math.max(0.05, radius * 0.3));
  visorMesh.position.set(0, bodyBaseY + height * 0.27, radius * 0.74);
}
rebuildCharacterMesh();
wireMesh.visible = $('in-show-capsule').checked;

// ---------------------------------------------------------------------------
// contact / support / displacement markers
// ---------------------------------------------------------------------------
const markerLayer = new THREE.Group();
scene.add(markerLayer);

const contactGroup = new THREE.Group();
markerLayer.add(contactGroup);

const contactGeo = new THREE.SphereGeometry(0.045, 12, 10);
const contactMat = new THREE.MeshBasicMaterial({ color: 0xf5b65c, depthTest: false });
contactMat.renderOrder = 12;
const normalMat = new THREE.LineBasicMaterial({ color: 0xf5b65c, transparent: true, opacity: 0.95, depthTest: false });
normalMat.renderOrder = 12;
const CONTACT_POOL = 14;
const contactMarkers = [];
for (let i = 0; i < CONTACT_POOL; i++) {
  const sphere = new THREE.Mesh(contactGeo, contactMat);
  const positions = new Float32Array(6);
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const line = new THREE.Line(lineGeo, normalMat);
  contactGroup.add(sphere);
  contactGroup.add(line);
  contactMarkers.push({ sphere, line, positions, lineGeo });
}

const supportGroup = new THREE.Group();
markerLayer.add(supportGroup);
const supportRing = new THREE.Mesh(
  new THREE.RingGeometry(0.19, 0.25, 32),
  new THREE.MeshBasicMaterial({ color: 0x6fd3a4, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false, depthTest: false }),
);
const supportDot = new THREE.Mesh(
  new THREE.CircleGeometry(0.055, 20),
  new THREE.MeshBasicMaterial({ color: 0xc8ffe8, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false, depthTest: false }),
);
const supportNormalPositions = new Float32Array(6);
const supportNormalGeo = new THREE.BufferGeometry();
supportNormalGeo.setAttribute('position', new THREE.BufferAttribute(supportNormalPositions, 3));
const supportNormalLine = new THREE.Line(
  supportNormalGeo,
  new THREE.LineBasicMaterial({ color: 0x6fd3a4, transparent: true, opacity: 0.95, depthTest: false }),
);
for (const obj of [supportRing, supportDot, supportNormalLine]) obj.renderOrder = 12;
supportGroup.add(supportRing, supportDot, supportNormalLine);

const requestedArrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, -1), new THREE.Vector3(), 0.6, 0x5cc8d8, 0.16, 0.09);
const blockedArrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, -1), new THREE.Vector3(), 0.5, 0xec7089, 0.14, 0.085);
const stepArrow = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(), 0.32, 0xa48cf0, 0.13, 0.08);
for (const arrow of [requestedArrow, blockedArrow, stepArrow]) arrow.renderOrder = 12;
markerLayer.add(requestedArrow, blockedArrow, stepArrow);

// ---------------------------------------------------------------------------
// motion trail (real per-frame positions)
// ---------------------------------------------------------------------------
const TRAIL_MAX = 1600;
const trailPositions = new Float32Array(TRAIL_MAX * 3);
const trailGeo = new THREE.BufferGeometry();
trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPositions, 3));
trailGeo.setDrawRange(0, 0);
const trail = new THREE.Line(
  trailGeo,
  new THREE.LineBasicMaterial({ color: 0x5cc8d8, transparent: true, opacity: 0.6 }),
);
trail.frustumCulled = false;
scene.add(trail);
let trailCount = 0;
let trailEnabled = $('in-show-trail').checked;
trail.visible = trailEnabled;

function pushTrail(point) {
  if (!trailEnabled) return;
  if (trailCount >= TRAIL_MAX) return;
  if (trailCount > 0) {
    const j = (trailCount - 1) * 3;
    const dx = point.x - trailPositions[j];
    const dy = point.y - trailPositions[j + 1];
    const dz = point.z - trailPositions[j + 2];
    if (dx * dx + dy * dy + dz * dz < 0.0009) return;
  }
  const i = trailCount * 3;
  trailPositions[i] = point.x;
  trailPositions[i + 1] = point.y;
  trailPositions[i + 2] = point.z;
  trailCount++;
  trailGeo.setDrawRange(0, trailCount);
  trailGeo.attributes.position.needsUpdate = true;
}
function clearTrail() {
  trailCount = 0;
  trailGeo.setDrawRange(0, 0);
}

// ---------------------------------------------------------------------------
// scenarios
// ---------------------------------------------------------------------------
const corridorHalf = features.corridorHalf;
const scenarios = [
  { id: 'plaza', name: '起点广场', meta: 'z 20.4 · 平地', x: 0, z: 20.4, feet: 0, cameraYaw: 0,
    note: '在平坦广场上起步，观察地面支撑点。' },
  { id: 'ramp-up', name: '16° 上坡', meta: 'z 7.4 · 几何坡度', x: 0, z: 7.4, feet: rampFeet(features.rampA, 7.4), cameraYaw: 0,
    note: '沿坡面法线投影位移；抬升应等于水平距离 × tan(16°)。' },
  { id: 'plateau', name: '坡顶平台', meta: 'z 4.2 · 过渡', x: 0, z: 4.2, feet: features.plateauA, cameraYaw: 0,
    note: '上坡与下坡的交接平台。' },
  { id: 'ramp-down', name: '22° 下坡', meta: 'z 1.0 · 几何坡度', x: 0, z: 1.0, feet: rampFeet(features.rampB, 1.0), cameraYaw: 0,
    note: '下坡时地面吸附保持贴合，不产生腾空抖动。' },
  { id: 'stairs', name: '0.22 m 台阶', meta: 'z -0.7 · 4 级', x: 0, z: -0.7, feet: 0, cameraYaw: 0,
    note: '正对 4 级 0.22 m 台阶，观察抬升阶段与落脚校验。' },
  { id: 'door', name: '1.05 m 窄门', meta: 'z -3.0 · 门洞', x: 0, z: -3.0, feet: features.stairTop, cameraYaw: 0,
    note: '按 W 穿过 1.05 m 门洞；两侧门框同时接触。' },
  { id: 'ledge', name: '0.38 m 高台', meta: 'z -5.15 · 单侧', x: 0.95, z: -5.15, feet: features.stairTop, cameraYaw: 0,
    note: '0.38 m 高台超过 0.32 m 抬升上限，应被几何判定拒绝。' },
  { id: 'steep', name: '58° 陡坡', meta: 'z -6.15 · 超限', x: -0.9, z: -6.15, feet: features.stairTop, cameraYaw: 0,
    note: '坡度超过 46° 上限，只能贴面滑动、不能行走。' },
  { id: 'corner', name: '凹角', meta: 'x 0.3 · 两墙', x: 0.3, z: -8.6, feet: features.stairTop, cameraYaw: 0,
    note: '按 W+D 斜向推入两面墙的凹角，观察多平面有界求解收敛。' },
];
const scenarioById = new Map(scenarios.map((s) => [s.id, s]));
let activeScenarioId = 'plaza';

const scenarioGrid = $('scenario-grid');
for (const s of scenarios) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'scenario-btn';
  btn.dataset.scenario = s.id;
  btn.title = s.note;
  btn.innerHTML = `<b>${s.name}</b><small>${s.meta}</small>`;
  btn.addEventListener('click', () => activateScenario(s.id));
  scenarioGrid.appendChild(btn);
}

function setActiveScenarioButton(id) {
  activeScenarioId = id;
  for (const btn of scenarioGrid.querySelectorAll('.scenario-btn')) {
    btn.classList.toggle('active', btn.dataset.scenario === id);
  }
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------
const FIXED_DT = 1 / 60;
const keys = new Set();
let jumpQueued = false;
let paused = false;
let lastTelemetry = null;
let lastStep = null;
let lastStepEvent = null;
let lastSlideEvent = null;
let walkPhase = 0;
let facing = 0;
let cameraSnap = true;

const camState = { yaw: 0, pitch: 0.42, dist: 8.2 };
const camTarget = new THREE.Vector3();
const desiredTarget = new THREE.Vector3();

const liveReplay = { active: false, elapsed: 0, duration: 10 };

function clearMarkers() {
  contactGroup.visible = false;
  supportGroup.visible = false;
  requestedArrow.visible = false;
  blockedArrow.visible = false;
  stepArrow.visible = false;
}

function teleportToScenario(id, { announce = true } = {}) {
  const s = scenarioById.get(id);
  if (!s) return;
  liveReplay.active = false;
  setReplayUI(false);
  controller.teleport(
    { x: s.x, y: s.feet + controller.shape.feetOffset + 0.12, z: s.z },
    { snap: true },
  );
  controller.velocity = { x: 0, y: 0, z: 0 };
  lastStep = null;
  lastStepEvent = null;
  lastSlideEvent = null;
  clearTrail();
  pushTrail({ x: controller.position.x, y: controller.feetY + 0.03, z: controller.position.z });
  camState.yaw = s.cameraYaw ?? 0;
  cameraSnap = true;
  setActiveScenarioButton(id);
  settleOnce();
  if (announce) showScenarioNote(s);
}

function settleOnce() {
  const tel = controller.step(FIXED_DT, { move: { x: 0, z: 0 }, cameraYaw: camState.yaw });
  lastTelemetry = tel;
  lastStep = tel.step;
  rememberFrameEvents(tel);
  updateHUD();
  renderPanel();
}

// ---------------------------------------------------------------------------
// input
// ---------------------------------------------------------------------------
const HANDLED = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'ShiftRight',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
]);

window.addEventListener('keydown', (e) => {
  if (HANDLED.has(e.code)) e.preventDefault();
  if (e.repeat) return;
  if (e.code === 'KeyR') {
    teleportToScenario('plaza');
    return;
  }
  if (e.code === 'KeyP') {
    togglePause();
    return;
  }
  keys.add(e.code);
  if (e.code === 'Space' && !paused && !liveReplay.active) jumpQueued = true;
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());

let dragging = false;
let dragPointer = null;
let lastPointer = { x: 0, y: 0 };

renderer.domElement.addEventListener('pointerdown', (e) => {
  dragging = true;
  dragPointer = e.pointerId;
  lastPointer = { x: e.clientX, y: e.clientY };
  renderer.domElement.setPointerCapture(e.pointerId);
});
renderer.domElement.addEventListener('pointermove', (e) => {
  if (!dragging || e.pointerId !== dragPointer) return;
  const dx = e.clientX - lastPointer.x;
  const dy = e.clientY - lastPointer.y;
  lastPointer = { x: e.clientX, y: e.clientY };
  camState.yaw -= dx * 0.006;
  camState.pitch = THREE.MathUtils.clamp(camState.pitch + dy * 0.004, 0.06, 1.25);
});
const endDrag = (e) => {
  if (dragPointer !== null && e.pointerId !== dragPointer) return;
  dragging = false;
  dragPointer = null;
};
renderer.domElement.addEventListener('pointerup', endDrag);
renderer.domElement.addEventListener('pointercancel', endDrag);
renderer.domElement.addEventListener('wheel', (e) => {
  e.preventDefault();
  camState.dist = THREE.MathUtils.clamp(camState.dist * (1 + Math.sign(e.deltaY) * 0.08), 3.2, 16);
}, { passive: false });
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

// ---------------------------------------------------------------------------
// topbar + panel controls
// ---------------------------------------------------------------------------
function togglePause() {
  paused = !paused;
  $('btn-pause').textContent = paused ? '继续' : '暂停';
  $('btn-pause').classList.toggle('btn-primary', paused);
  updateHUD();
}
$('btn-pause').addEventListener('click', togglePause);
$('btn-respawn').addEventListener('click', () => teleportToScenario('plaza'));
$('btn-replay').addEventListener('click', startLiveReplay);

function setReplayUI(on) {
  $('btn-replay').textContent = on ? '回放中…' : '重放检查';
  $('btn-replay').classList.toggle('btn-accent', !on);
}

function startLiveReplay() {
  liveReplay.active = true;
  liveReplay.elapsed = 0;
  paused = false;
  $('btn-pause').textContent = '暂停';
  $('btn-pause').classList.remove('btn-primary');
  keys.clear();
  jumpQueued = false;
  controller.teleport(
    { x: 0, y: controller.shape.feetOffset + 0.1, z: 20.4 },
    { snap: true },
  );
  controller.velocity = { x: 0, y: 0, z: 0 };
  lastTelemetry = null;
  lastStep = null;
  lastStepEvent = null;
  lastSlideEvent = null;
  clearTrail();
  pushTrail({ x: controller.position.x, y: controller.feetY + 0.03, z: controller.position.z });
  camState.yaw = 0;
  camState.pitch = 0.4;
  camState.dist = 8.2;
  cameraSnap = true;
  setReplayUI(true);
  setActiveScenarioButton(null);
  liveReplay.duration = 10;
  settleOnce();
}

// slider wiring
const radiusSlider = $('in-radius');
const heightSlider = $('in-height');
const slopeSlider = $('in-slope');
const stepSlider = $('in-step');

function syncOutputs() {
  const shape = controller.shape;
  $('out-radius').textContent = `${shape.radius.toFixed(2)} m`;
  const requested = Number(heightSlider.value);
  const clamped = shape.height > requested + 1e-6;
  $('out-height').textContent = `${shape.height.toFixed(2)} m${clamped ? '（已钳制）' : ''}`;
  $('out-height').style.color = clamped ? 'var(--contact)' : '';
  $('out-slope').textContent = `${controller.cfg.slopeLimitDeg.toFixed(0)}°`;
  $('out-step').textContent = `${controller.cfg.stepHeight.toFixed(2)} m`;
}

function applyBodyConfig(partial) {
  controller.configure(partial);
  rebuildCharacterMesh();
  wireMesh.visible = $('in-show-capsule').checked;
  syncOutputs();
  lastStep = null;
  lastStepEvent = null;
  lastSlideEvent = null;
  settleOnce();
  cameraSnap = false;
}

radiusSlider.addEventListener('input', () => {
  applyBodyConfig({ radius: Number(radiusSlider.value) });
});
heightSlider.addEventListener('input', () => {
  applyBodyConfig({ height: Number(heightSlider.value) });
});
slopeSlider.addEventListener('input', () => {
  applyBodyConfig({ slopeLimitDeg: Number(slopeSlider.value) });
});
stepSlider.addEventListener('input', () => {
  applyBodyConfig({ stepHeight: Number(stepSlider.value) });
});

$('in-show-contact').addEventListener('change', (e) => {
  markerLayer.visible = e.target.checked;
  if (e.target.checked) updateMarkers(lastTelemetry);
});
$('in-show-capsule').addEventListener('change', (e) => {
  if (wireMesh) wireMesh.visible = e.target.checked;
});
$('in-show-trail').addEventListener('change', (e) => {
  trailEnabled = e.target.checked;
  trail.visible = trailEnabled;
  if (!trailEnabled) clearTrail();
});

syncOutputs();
$('in-show-capsule').checked = true;

function rememberFrameEvents(tel) {
  if (!tel) return;
  if (tel.step && tel.step.attempted) {
    lastStepEvent = { step: tel.step, frame: tel.frame };
  }
  if (tel.slide && (tel.slide.iterations > 0 || tel.slide.planes > 0)) {
    const prev = lastSlideEvent && lastSlideEvent.slide;
    const better = !prev || tel.slide.planes > prev.planes || (tel.slide.planes === prev.planes && tel.slide.iterations >= prev.iterations);
    if (better) lastSlideEvent = { slide: tel.slide, frame: tel.frame };
  }
}

// ---------------------------------------------------------------------------
// physics / visuals
// ---------------------------------------------------------------------------
function physics(dt) {
  if (paused) return;

  let move = { x: 0, z: 0 };
  let speedScale = 1;
  let jump = false;

  if (liveReplay.active) {
    liveReplay.elapsed += dt;
    if (liveReplay.elapsed <= liveReplay.duration) {
      move = { x: 0, z: -1 };
    } else {
      liveReplay.active = false;
      liveReplay.elapsed = 0;
      setReplayUI(false);
    }
  } else {
    const ix = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
    const iz = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
    // camera-relative basis from the orbit yaw
    const fwdX = -Math.sin(camState.yaw);
    const fwdZ = -Math.cos(camState.yaw);
    const rightX = Math.cos(camState.yaw);
    const rightZ = -Math.sin(camState.yaw);
    move = { x: fwdX * iz + rightX * ix, z: fwdZ * iz + rightZ * ix };
    speedScale = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 1.65 : 1;
    if (jumpQueued) {
      jump = true;
      jumpQueued = false;
    }
  }

  const tel = controller.step(dt, { move, jump, speedScale, cameraYaw: camState.yaw });
  lastTelemetry = tel;
  lastStep = tel.step;
  rememberFrameEvents(tel);

  if (controller.position.y < -8) {
    teleportToScenario('plaza');
    return;
  }

  pushTrail({ x: controller.position.x, y: controller.feetY + 0.03, z: controller.position.z });
}

function updateCharacter(dtReal) {
  const shape = controller.shape;
  const feetY = controller.position.y - shape.height / 2;
  character.position.set(controller.position.x, feetY, controller.position.z);

  const tel = lastTelemetry;
  let vx = 0;
  let vz = 0;
  if (tel) {
    vx = tel.velocity.x;
    vz = tel.velocity.z;
  }
  const speed = Math.hypot(vx, vz);
  if (speed > 0.15) {
    facing = Math.atan2(vx, vz);
  }
  character.rotation.y = facing;
  charLight.position.set(controller.position.x + 0.9, controller.position.y + 1.7, controller.position.z + 1.1);

  const ratio = THREE.MathUtils.clamp(speed / Math.max(0.1, controller.cfg.moveSpeed), 0, 1.4);
  walkPhase += speed * dtReal * 6.2;
  const bob = Math.abs(Math.sin(walkPhase)) * 0.045 * ratio;
  bodyGroup.position.y = bob;
  bodyGroup.rotation.x = 0.11 * ratio;
  bodyGroup.rotation.z = Math.sin(walkPhase) * 0.035 * ratio;

  if (visorMesh) {
    visorMesh.position.y = bodyBaseY + shape.height * 0.27 + bob;
    visorMesh.rotation.x = bodyGroup.rotation.x;
  }
}

function updateMarkers(tel) {
  contactGroup.visible = false;
  supportGroup.visible = false;
  requestedArrow.visible = false;
  blockedArrow.visible = false;
  stepArrow.visible = false;
  if (!tel) return;

  const showContacts = $('in-show-contact').checked;
  if (showContacts) {
    const contacts = (tel.contacts || []).slice(0, CONTACT_POOL);
    contactGroup.visible = contacts.length > 0;
    for (let i = 0; i < contactMarkers.length; i++) {
      const marker = contactMarkers[i];
      const c = contacts[i];
      if (!c) {
        marker.sphere.visible = false;
        marker.line.visible = false;
        continue;
      }
      marker.sphere.visible = true;
      marker.line.visible = true;
      marker.sphere.position.set(c.point.x, c.point.y, c.point.z);
      const p = marker.positions;
      p[0] = c.point.x;
      p[1] = c.point.y;
      p[2] = c.point.z;
      p[3] = c.point.x + c.normal.x * 0.32;
      p[4] = c.point.y + c.normal.y * 0.32;
      p[5] = c.point.z + c.normal.z * 0.32;
      marker.lineGeo.attributes.position.needsUpdate = true;
      marker.lineGeo.computeBoundingSphere();
    }

    const s = tel.support;
    if (s) {
      supportGroup.visible = true;
      const n = new THREE.Vector3(s.normal.x, s.normal.y, s.normal.z).normalize();
      const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
      supportRing.position.set(s.point.x + n.x * 0.012, s.point.y + n.y * 0.012, s.point.z + n.z * 0.012);
      supportDot.position.copy(supportRing.position);
      supportRing.quaternion.copy(quat);
      supportDot.quaternion.copy(quat);
      const sp = supportNormalPositions;
      sp[0] = s.point.x;
      sp[1] = s.point.y;
      sp[2] = s.point.z;
      sp[3] = s.point.x + n.x * 0.45;
      sp[4] = s.point.y + n.y * 0.45;
      sp[5] = s.point.z + n.z * 0.45;
      supportNormalGeo.attributes.position.needsUpdate = true;
      supportNormalGeo.computeBoundingSphere();
      supportRing.material.color.set(s.walkable ? 0x6fd3a4 : 0xec7089);
      supportDot.material.color.set(s.walkable ? 0xc8ffe8 : 0xffc4cf);
      supportNormalLine.material.color.set(s.walkable ? 0x6fd3a4 : 0xec7089);
    }
  }

  // horizontal request vs realised motion (per-frame, amplified for visibility)
  const req = tel.horizontalRequested;
  const real = tel.horizontalActual;
  const reqLen = Math.hypot(req.x, req.z);
  if (reqLen > 2e-4) {
    const ox = controller.position.x;
    const oz = controller.position.z;
    const oy = controller.feetY + 0.16;
    requestedArrow.visible = true;
    requestedArrow.position.set(ox, oy, oz);
    requestedArrow.setDirection(new THREE.Vector3(req.x / reqLen, 0, req.z / reqLen));
    requestedArrow.setLength(Math.min(0.9, Math.max(0.22, reqLen * 14)), 0.16, 0.09);

    const bx = req.x - real.x;
    const bz = req.z - real.z;
    const blockLen = Math.hypot(bx, bz);
    if (blockLen > Math.max(2e-4, reqLen * 0.05)) {
      blockedArrow.visible = true;
      blockedArrow.position.set(ox, oy + 0.03, oz);
      blockedArrow.setDirection(new THREE.Vector3(bx / blockLen, 0, bz / blockLen));
      blockedArrow.setLength(Math.min(0.9, Math.max(0.2, blockLen * 16)), 0.15, 0.085);
    }
  }

  if (tel.step && tel.step.attempted) {
    stepArrow.visible = true;
    stepArrow.position.set(controller.position.x, controller.feetY + 0.04, controller.position.z);
    stepArrow.setDirection(new THREE.Vector3(0, 1, 0));
    stepArrow.setLength(Math.max(0.12, controller.cfg.stepHeight), 0.13, 0.08);
  }
}

function updateCamera(dtReal) {
  desiredTarget.set(
    controller.position.x,
    controller.position.y + 0.45,
    controller.position.z,
  );
  if (cameraSnap) {
    camTarget.copy(desiredTarget);
    cameraSnap = false;
  } else {
    camTarget.lerp(desiredTarget, 1 - Math.exp(-9 * dtReal));
  }
  const cp = Math.cos(camState.pitch);
  const offset = new THREE.Vector3(
    Math.sin(camState.yaw) * cp,
    Math.sin(camState.pitch),
    Math.cos(camState.yaw) * cp,
  ).multiplyScalar(camState.dist);

  // Pull the camera in front of any collider between it and the target so the
  // character is never hidden behind a wall.
  const rayDir = offset.clone().normalize();
  cameraRay.set(camTarget, rayDir);
  cameraRay.far = camState.dist;
  const overlaps = cameraRay.intersectObjects(colliderMeshList, false);
  let distance = camState.dist;
  if (overlaps.length) {
    distance = Math.max(0.75, overlaps[0].distance - 0.35);
  }

  camera.position.copy(camTarget).addScaledVector(rayDir, distance);
  camera.lookAt(camTarget);
}

// ---------------------------------------------------------------------------
// HUD + results panel (all values come from per-frame telemetry)
// ---------------------------------------------------------------------------
const fmt = (v, n = 3) => (Number.isFinite(v) ? v.toFixed(n) : '—');
const vec = (v, n = 3) => (v ? `(${fmt(v.x, n)}, ${fmt(v.y, n)}, ${fmt(v.z, n)})` : '—');
const mm = (m) => `${(m * 1000).toFixed(2)} mm`;

const STEP_REASON = {
  'no-support': '无地面支撑',
  'no-motion': '无水平位移',
  'no-tread': '前方无可踏面',
  'rise-exceeds-limit': '抬升超限',
  'no-rise': '无抬升',
  'lift-blocked': '抬升受阻',
  'lift-too-small': '抬升不足',
  'forward-blocked': '前移受阻',
  'no-landing': '无落点',
  'landing-ray-mismatch': '落点不匹配',
  'landing-overlap': '落点重叠',
  'no-progress': '无进展',
  'partial-forward': '仅前移（未抬升）',
  ok: '成功',
  unknown: '未判定',
};

function stateLabel() {
  if (paused) return '已暂停';
  if (liveReplay.active) return '脚本回放';
  if (!lastTelemetry) return '—';
  if (lastTelemetry.jumped) return '跳跃';
  if (lastStep && lastStep.attempted && lastStep.success) return '台阶抬升';
  if (lastStep && lastStep.attempted && !lastStep.success) return '台阶拒绝';
  return lastTelemetry.grounded ? '地面' : '空中';
}

function updateHUD() {
  if (!lastTelemetry) {
    $('hud-state').textContent = stateLabel();
    $('hud-angle').textContent = '—';
    $('hud-speed').textContent = '—';
    $('hud-pen').textContent = '—';
    return;
  }
  const tel = lastTelemetry;
  $('hud-state').textContent = stateLabel();
  $('hud-angle').textContent = tel.groundAngleDeg == null ? '—' : `${tel.groundAngleDeg.toFixed(1)}°`;
  const v = tel.velocity;
  $('hud-speed').textContent = `${Math.hypot(v.x, v.z).toFixed(2)} m/s`;
  const pen = tel.penetration;
  $('hud-pen').textContent = pen > 5e-4 ? `${(pen * 1000).toFixed(1)} mm` : '0.0 mm';
  $('hud-pen').style.color = pen > 5e-4 ? 'var(--blocked)' : 'var(--ground)';
}

function setRow(id, text, tone = '') {
  const el = $(id);
  el.textContent = text;
  el.classList.toggle('good', tone === 'good');
  el.classList.toggle('warn', tone === 'warn');
  el.classList.toggle('bad', tone === 'bad');
}

function renderPanel() {
  const tel = lastTelemetry;
  if (!tel) {
    for (const id of ['res-request', 'res-actual', 'res-normal', 'res-plane', 'res-point', 'res-surface', 'res-contacts', 'res-step', 'res-slide', 'res-depen']) {
      setRow(id, '—');
    }
    $('contact-list').innerHTML = '<div class="contact-empty">等待角色移动…</div>';
    return;
  }

  const req = tel.horizontalRequested;
  const real = tel.horizontalActual;
  setRow('res-request', `${(tel.horizontalRequestedDistance * 100).toFixed(2)} cm · ${vec(req)}`);
  const ratio = tel.horizontalRequestedDistance > 1e-5
    ? tel.horizontalActualDistance / tel.horizontalRequestedDistance
    : 1;
  const actualTone = tel.horizontalRequestedDistance < 1e-5 ? '' : ratio > 0.95 ? 'good' : ratio > 0.4 ? 'warn' : 'bad';
  setRow('res-actual', `${(tel.horizontalActualDistance * 100).toFixed(2)} cm · 达成 ${(ratio * 100).toFixed(0)}%`, actualTone);

  if (tel.support) {
    const supportTone = tel.support.walkable ? 'good' : 'bad';
    setRow(
      'res-normal',
      `n=${vec(tel.support.normal)} · ${tel.support.angleDeg.toFixed(2)}°${tel.support.walkable ? '（可行走）' : '（超限）'}`,
      supportTone,
    );
    setRow('res-point', `${vec(tel.support.point)} · 脚底 ${controller.feetY.toFixed(3)} m`);
    setRow('res-surface', `${tel.support.label} [${tel.support.boxId}]`, supportTone);
  } else {
    setRow('res-normal', '无支撑（空中）', 'warn');
    setRow('res-point', '—');
    setRow('res-surface', '—');
  }

  // The projected displacement is what the support-plane relationship predicts:
  // dy = -(dx*n.x + dz*n.z)/n.y, i.e. horizontal distance * tan(slope).
  if (tel.planeDelta) {
    const pd = tel.planeDelta;
    const horiz = Math.hypot(pd.x, pd.z);
    const implied = horiz > 1e-6 ? (Math.atan2(Math.abs(pd.y), horiz) * 180) / Math.PI : 0;
    const dyShare = pd.y;
    const tone = Math.abs(implied - (tel.groundAngleDeg || 0)) < 0.6 ? 'good' : '';
    setRow(
      'res-plane',
      `Δ=${vec(pd)} · 水平 ${(horiz * 100).toFixed(2)} cm · dy ${(dyShare * 100).toFixed(2)} cm · ${implied.toFixed(2)}°`,
      tone,
    );
  } else {
    setRow('res-plane', '—');
  }

  setRow('res-contacts', `${tel.contacts.length} 个${tel.contacts.length ? ' · ' + [...new Set(tel.contacts.map((c) => c.label))].join('，') : ''}`);

  if (lastStepEvent) {
    const st = lastStepEvent.step;
    const age = tel.frame - lastStepEvent.frame;
    const base = `${st.success ? '通过' : '拒绝'} · ${STEP_REASON[st.reason] || st.reason}`;
    const bits = [];
    if (st.obstacleTop != null) bits.push(`障碍顶 ${st.obstacleTop.toFixed(3)} m`);
    bits.push(`实测抬升 ${st.rise.toFixed(3)} m`);
    bits.push(`前移 ${st.forward.toFixed(3)} m`);
    if (st.landingAngleDeg != null) bits.push(`落点 ${st.landingAngleDeg.toFixed(1)}°`);
    const staleness = age > 0 ? ` · ${age} 帧前` : '';
    setRow('res-step', `${base} · ${bits.join(' · ')}${staleness}`, st.success ? 'good' : 'bad');
  } else {
    setRow('res-step', `未触发（抬升上限 ${controller.cfg.stepHeight.toFixed(2)} m）`);
  }

  if (lastSlideEvent) {
    const sl = lastSlideEvent.slide;
    const age = tel.frame - lastSlideEvent.frame;
    const hitLabels = [...new Set(sl.hits.map((h) => h.label))];
    const detail = hitLabels.length ? ` · 接触 ${hitLabels.join('，')}` : '';
    const staleness = age > 0 ? ` · ${age} 帧前` : '';
    setRow(
      'res-slide',
      `迭代 ${sl.iterations} · 平面 ${sl.planes}${sl.exhausted ? ' · 达上限放弃' : ' · 收敛'}${detail}${staleness}`,
      sl.exhausted ? 'bad' : sl.planes >= 2 ? 'good' : '',
    );
  } else {
    setRow('res-slide', '本帧无滑动');
  }

  setRow(
    'res-depen',
    `${tel.depenetrationPasses} 次解穿 · 残留穿透 ${mm(tel.penetration)}`,
    tel.penetration > 5e-4 ? 'bad' : 'good',
  );

  const list = $('contact-list');
  if (!tel.contacts.length) {
    list.innerHTML = '<div class="contact-empty">本帧无接触</div>';
  } else {
    const fragment = document.createDocumentFragment();
    for (const c of tel.contacts.slice(0, 12)) {
      const chip = document.createElement('div');
      chip.className = 'contact-chip';
      const name = document.createElement('span');
      name.className = 'c-name';
      name.textContent = c.label;
      const meta = document.createElement('span');
      meta.className = 'c-meta';
      meta.textContent = `${mm(c.separation)}`;
      const detail = document.createElement('span');
      detail.className = 'c-detail';
      detail.textContent = `p ${vec(c.point)}  n ${vec(c.normal)}`;
      chip.append(name, meta, detail);
      fragment.appendChild(chip);
    }
    list.replaceChildren(fragment);
  }
}

// ---------------------------------------------------------------------------
// replay checks panel
// ---------------------------------------------------------------------------
let checksRunning = false;
function executeChecks() {
  if (checksRunning) return;
  checksRunning = true;
  const summaryEl = $('check-summary');
  summaryEl.textContent = '正在驱动角色通过边界场景…';
  summaryEl.className = 'check-summary';
  const listEl = $('check-list');
  listEl.replaceChildren();
  // Let the browser paint the pending state before the synchronous run.
  requestAnimationFrame(() => {
    const { results, passed, total } = runReplayChecks();
    summaryEl.textContent = `${passed}/${total} 项检查通过`;
    summaryEl.className = `check-summary ${passed === total ? 'pass' : 'fail'}`;
    const fragment = document.createDocumentFragment();
    for (const r of results) {
      const li = document.createElement('li');
      li.className = r.pass ? 'pass' : 'fail';
      const tick = document.createElement('span');
      tick.className = 'tick';
      tick.textContent = r.pass ? 'PASS' : 'FAIL';
      const body = document.createElement('div');
      body.className = 'check-body';
      const name = document.createElement('div');
      name.className = 'check-name';
      name.textContent = r.name;
      const detail = document.createElement('div');
      detail.className = 'check-detail';
      detail.textContent = r.detail;
      body.append(name, detail);
      li.append(tick, body);
      fragment.appendChild(li);
    }
    listEl.replaceChildren(fragment);
    checksRunning = false;
  });
}
$('btn-run-checks').addEventListener('click', executeChecks);

// ---------------------------------------------------------------------------
// scenario note + toast
// ---------------------------------------------------------------------------
let noteTimer = null;
function showScenarioNote(s) {
  let note = $('scenario-note');
  if (!note) {
    note = document.createElement('div');
    note.id = 'scenario-note';
    note.className = 'scenario-note';
    viewportEl.appendChild(note);
  }
  note.textContent = s.note;
  note.classList.add('visible');
  if (noteTimer) clearTimeout(noteTimer);
  noteTimer = setTimeout(() => note.classList.remove('visible'), 4200);
}

// ---------------------------------------------------------------------------
// loop
// ---------------------------------------------------------------------------
let lastTime = performance.now();
let accumulator = 0;
let uiAccum = 0;

function animate(now) {
  requestAnimationFrame(animate);
  const dtReal = Math.min(0.1, Math.max(0, (now - lastTime) / 1000));
  lastTime = now;

  if (!paused) {
    accumulator += dtReal;
    let steps = 0;
    while (accumulator >= FIXED_DT && steps < 8) {
      physics(FIXED_DT);
      accumulator -= FIXED_DT;
      steps++;
    }
    if (steps === 8) accumulator = 0;
  }

  updateCharacter(dtReal);
  updateCamera(dtReal);
  updateMarkers(lastTelemetry);
  updateHUD();

  uiAccum += dtReal;
  if (uiAccum >= 0.09) {
    uiAccum = 0;
    renderPanel();
  }

  if (liveReplay.active) {
    const left = Math.max(0, liveReplay.duration - liveReplay.elapsed);
    $('hud-state').textContent = `脚本回放 ${left.toFixed(1)}s`;
  }

  renderer.render(scene, camera);
}

function resize() {
  const w = Math.max(1, viewportEl.clientWidth);
  const h = Math.max(1, viewportEl.clientHeight);
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
resize();
new ResizeObserver(resize).observe(viewportEl);

// boot
teleportToScenario('plaza', { announce: false });
const bootNote = $('scenario-note');
if (bootNote) bootNote.remove();
updateHUD();
renderPanel();
requestAnimationFrame(animate);

// Test hook: exposes the real controller/course so browser-driven checks can
// inspect the same state the UI renders.
window.__capsuleDemo = {
  controller,
  course,
  runReplayChecks,
  get telemetry() {
    return lastTelemetry;
  },
  teleport: (id) => teleportToScenario(id),
  scenarios: scenarios.map((s) => s.id),
  setCamera: (yaw, pitch = 0.42, dist = 8.2) => {
    camState.yaw = yaw;
    camState.pitch = pitch;
    camState.dist = dist;
  },
  press: (code) => {
    keys.add(code);
    if (code === 'Space') jumpQueued = true;
  },
  release: (code) => keys.delete(code),
  tap: (code) => {
    keys.add(code);
    if (code === 'Space') jumpQueued = true;
    setTimeout(() => keys.delete(code), 40);
  },
  get paused() {
    return paused;
  },
};
