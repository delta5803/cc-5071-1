import { EPS, add, clamp, deg, length, lengthSq, scale, sub, vec3 } from './math.js';
import { footprintTop, rayDown, ringOffsets } from './rays.js';
import {
  capsuleBounds,
  capsuleFits,
  clipVelocity,
  collectContacts,
  depenetrate,
  maxPenetration,
  sweepCapsule,
} from './colliders.js';

export const DEFAULT_CONFIG = Object.freeze({
  radius: 0.35,
  height: 1.7,
  moveSpeed: 3.2,
  groundAccel: 30,
  airAccel: 9,
  groundFriction: 10,
  gravity: 22,
  jumpSpeed: 5.6,
  slopeLimitDeg: 46,
  stepHeight: 0.32,
  stepTolerance: 0.015,
  groundSnap: 0.26,
  skin: 0.004,
  supportTolerance: 0.006,
  maxSweepIterations: 10,
  maxSlideIterations: 7,
  maxDepenetrationPasses: 6,
  maxDepenetrationStep: 0.2,
  maxFrameDt: 1 / 30,
});

export function deriveShape(cfg) {
  const radius = Math.max(0.05, cfg.radius);
  const height = Math.max(2 * radius + 0.02, cfg.height);
  return { radius, height, halfSeg: height / 2 - radius, feetOffset: height / 2 };
}

function approach(current, target, delta) {
  if (current < target) return Math.min(current + delta, target);
  return Math.max(current - delta, target);
}

function isWalkableNormal(normal, cfg) {
  return deg(Math.acos(clamp(normal.y, -1, 1))) <= cfg.slopeLimitDeg + 0.5;
}

/**
 * Ground support is a pure query over current contacts. Walkable contacts are
 * preferred; if only steep contacts exist the highest one is still reported
 * (with walkable=false) so the UI can show what the capsule is touching.
 */
export function supportFromContacts(contacts, cfg) {
  let walkableBest = null;
  let anyBest = null;
  for (const c of contacts) {
    if (c.normal.y <= 0.02) continue;
    if (c.separation > cfg.supportTolerance) continue;
    const walkable = isWalkableNormal(c.normal, cfg);
    if (!anyBest || c.point.y > anyBest.contact.point.y) anyBest = { contact: c, walkable };
    if (walkable && (!walkableBest || c.point.y > walkableBest.contact.point.y)) walkableBest = { contact: c, walkable };
  }
  const chosen = walkableBest || anyBest;
  if (!chosen) return null;
  const c = chosen.contact;
  return {
    contact: c,
    point: c.point,
    normal: c.normal,
    angleDeg: deg(Math.acos(clamp(c.normal.y, -1, 1))),
    walkable: chosen.walkable,
    separation: c.separation,
    boxId: c.boxId,
    label: c.label,
  };
}

/**
 * Downward support probe. The capsule is only moved when a contact is found,
 * so a probe over a ledge never teleports the character downward.
 */
export function probeSupport(center, shape, colliders, cfg, maxDrop = cfg.groundSnap) {
  const sweep = sweepCapsule(center, shape.halfSeg, shape.radius, { x: 0, y: -maxDrop, z: 0 }, colliders, cfg);
  const support = supportFromContacts(sweep.contacts, cfg);
  return {
    position: support ? sweep.position : { ...center },
    travelled: support ? sweep.travelled : 0,
    support,
    contacts: sweep.contacts,
    hit: sweep.hit,
  };
}

/**
 * Displacement with wall sliding.
 *
 * `ignoreWalkable` removes walkable ground contacts from the sweep so that
 * movement along a ramp is governed by the support plane (the caller projects
 * the displacement onto that plane) instead of being stopped by the ramp
 * itself. Steep surfaces are never ignored.
 *
 * Each blocked step resolves all currently opposing planes through the bounded
 * multi-plane clip; the loop has a hard iteration cap and reports whether the
 * remaining motion was abandoned.
 */
export function slideMove(position, shape, delta, colliders, cfg, options = {}) {
  const { ignoreWalkable = false, maxIterations = cfg.maxSlideIterations } = options;
  let pos = { ...position };
  let remaining = { ...delta };
  const hits = [];
  let iterations = 0;
  let planesSolved = 0;
  let exhausted = false;
  let lastContacts = [];

  const limitHit = (h) => ignoreWalkable && isWalkableNormal(h.normal, cfg);

  while (lengthSq(remaining) > 1e-12 && iterations < maxIterations) {
    iterations++;
    let res = sweepCapsule(pos, shape.halfSeg, shape.radius, remaining, colliders, cfg);
    if (ignoreWalkable && res.hit && limitHit(res.hit)) {
      // The sweep stopped on the floor/ramp it is meant to travel along.
      // Temporarily drop the walkable plane and retry the remaining motion.
      const skipped = new Set();
      let guard = 0;
      while (res.hit && limitHit(res.hit) && guard++ < 8) {
        skipped.add(res.hit.boxId);
        const filtered = colliders.filter((b) => !skipped.has(b.id));
        res = sweepCapsule(pos, shape.halfSeg, shape.radius, remaining, filtered, cfg);
      }
    }
    pos = res.position;
    remaining = sub(remaining, res.moved);
    lastContacts = res.contacts;
    if (!res.hit) break;
    const contacts = collectContacts(pos, shape.halfSeg, shape.radius, colliders, cfg);
    const opposing = [];
    for (const c of contacts) {
      if (ignoreWalkable && isWalkableNormal(c.normal, cfg)) continue;
      if (remaining.x * c.normal.x + remaining.y * c.normal.y + remaining.z * c.normal.z < -1e-7) {
        opposing.push(c.normal);
      }
    }
    if (!opposing.length) opposing.push(res.hit.normal);
    const clip = clipVelocity(remaining, opposing);
    planesSolved = Math.max(planesSolved, clip.planes);
    hits.push({ ...res.hit, clipPlanes: clip.planes });
    const before = length(remaining);
    remaining = clip.velocity;
    if (length(remaining) >= before - 1e-7) {
      exhausted = true;
      break;
    }
  }
  if (lengthSq(remaining) > 1e-10) exhausted = true;

  return { position: pos, remaining, hits, iterations, planesSolved, exhausted, contacts: lastContacts };
}

/**
 * Step assessment as its own phase: lift, forward, drop — three real capsule
 * sweeps from the frame's starting position, independent of the walking slide.
 * Acceptance is geometric: measured rise between support points, measured
 * landing normal angle, and forward distance actually gained.
 */
export function assessStep(startPos, shape, horizontalDelta, supportBefore, colliders, cfg) {
  const result = {
    attempted: true,
    success: false,
    reason: 'unknown',
    rise: 0,
    forward: 0,
    lift: 0,
    obstacleTop: null,
    obstacleLabel: null,
    landingAngleDeg: null,
    supportBeforePoint: supportBefore ? { ...supportBefore.point } : null,
    phases: [],
  };
  if (!supportBefore) {
    result.reason = 'no-support';
    return result;
  }
  const horizontalLen = Math.hypot(horizontalDelta.x, horizontalDelta.z);
  if (horizontalLen <= 1e-5) {
    result.reason = 'no-motion';
    return result;
  }

  // ---- geometric gate: is there a walkable tread within step height? -------
  // Vertical rays over the capsule footprint. The highest walkable face under
  // the footprint that is above the current support by <= stepHeight is the
  // candidate step. If it rises more than the limit, the step is rejected on
  // geometry alone -- no trial motion touches the controller position.
  const dirH = { x: horizontalDelta.x / horizontalLen, z: horizontalDelta.z / horizontalLen };
  const footOffsets = ringOffsets(shape.radius, 8, 0.98);
  const edge = { x: startPos.x + dirH.x * shape.radius * 0.98, z: startPos.z + dirH.z * shape.radius * 0.98 };
  // Probe just ahead of the front edge of the footprint (direction of travel).
  const probeCenter = {
    x: edge.x + dirH.x * Math.min(horizontalLen, 0.12),
    z: edge.z + dirH.z * Math.min(horizontalLen, 0.12),
  };
  const feetY = startPos.y - shape.feetOffset;
  const headroom = feetY;
  // One probe over the whole reachable range: the highest walkable face above
  // the current feet. Its measured height is compared against the step limit,
  // so "no tread" and "tread too high" are distinguished geometrically.
  const probe = footprintTop(probeCenter, footOffsets, headroom + 0.02, headroom + cfg.stepHeight + 0.9, colliders);
  if (!probe) {
    result.reason = 'no-tread';
    return result;
  }
  const geometricRise = probe.point.y - supportBefore.point.y;
  result.obstacleTop = probe.point.y;
  result.obstacleLabel = probe.label;
  if (geometricRise > cfg.stepHeight + cfg.stepTolerance) {
    result.rise = geometricRise;
    result.reason = 'rise-exceeds-limit';
    return result;
  }
  if (geometricRise <= 1e-4) {
    result.reason = 'no-rise';
    return result;
  }
  const obstacleTop = probe;

  // ---- lift ---------------------------------------------------------------
  // Lift the full step height, not just the measured rise: the bottom sphere
  // must clear the riser corner horizontally while advancing, which needs
  // lift >= rise + (r - sqrt(r^2 - reach^2)) worth of clearance.
  const liftTarget = cfg.stepHeight;
  const liftRes = sweepCapsule(startPos, shape.halfSeg, shape.radius, { x: 0, y: liftTarget, z: 0 }, colliders, cfg);
  const lift = Math.max(0, liftRes.travelled);
  result.lift = lift;
  result.phases.push({ name: 'lift', from: { ...startPos }, to: { ...liftRes.position }, distance: lift });
  if (lift < geometricRise - 0.005) {
    result.reason = liftRes.hit ? 'lift-blocked' : 'lift-too-small';
    return result;
  }

  // ---- forward at lifted height ------------------------------------------
  // A capsule is only supported above the face under its axis. To stand on a
  // tread the axis must end up over it, so the step assist advances at most
  // one radius (the exact distance for the axis to clear the riser at feet ==
  // tread height). This is bounded geometry, not a teleport.
  const dirNorm = { x: horizontalDelta.x / horizontalLen, z: horizontalDelta.z / horizontalLen };
  // Advance exactly to the point where the capsule axis is over the tread,
  // found by scanning forward rays at the lifted height. Bounded by one
  // radius, i.e. the capsule can only step within its own footprint.
  const feetAtLiftProbe = startPos.y - shape.feetOffset + liftTarget;
  const treadAdvance = findTreadAdvance(
    startPos,
    dirNorm,
    feetAtLiftProbe,
    obstacleTop.point.y,
    shape.radius + 0.02,
    colliders,
  );
  const forwardDist = Math.max(horizontalLen, Math.min(treadAdvance + 0.01, horizontalLen + shape.radius));
  const fwdRes = sweepCapsule(
    liftRes.position,
    shape.halfSeg,
    shape.radius,
    { x: dirNorm.x * forwardDist, y: 0, z: dirNorm.z * forwardDist },
    colliders,
    cfg,
  );
  const forward = Math.hypot(fwdRes.moved.x, fwdRes.moved.z);
  result.forward = forward;
  result.assist = Math.max(0, forwardDist - horizontalLen);
  result.phases.push({ name: 'forward', from: { ...liftRes.position }, to: { ...fwdRes.position }, distance: forward });
  if (forward < Math.max(1e-3, horizontalLen * 0.5)) {
    result.reason = 'forward-blocked';
    return result;
  }

  // ---- drop: find the tread under the axis, then place feet on it --------
  // Footprint rays just ahead at the lifted height locate the tread; the drop
  // then moves down by the measured amount, so landing height is geometric.
  // Probe the tread directly under the advanced axis (a single ray), which is
  // the surface the capsule will actually rest on.
  const underAxis = rayDown(
    fwdRes.position.x,
    fwdRes.position.z,
    fwdRes.position.y - shape.feetOffset + 0.02,
    obstacleTop.point.y - 0.03,
    colliders,
  );
  const dropProbe = underAxis;
  if (!dropProbe) {
    result.reason = 'no-landing';
    return result;
  }
  const feetAtLift = fwdRes.position.y - shape.feetOffset;
  const dropNeeded = Math.max(0, feetAtLift - dropProbe.point.y);
  const dropRes = sweepCapsule(
    fwdRes.position,
    shape.halfSeg,
    shape.radius,
    { x: 0, y: -dropNeeded, z: 0 },
    colliders,
    cfg,
  );
  result.phases.push({
    name: 'drop',
    from: { ...fwdRes.position },
    to: { ...dropRes.position },
    distance: Math.max(0, dropRes.travelled),
  });
  // Final geometric verification: a vertical ray at the resulting axis must
  // hit the same tread top and the capsule must not overlap anything.
  const landingRay = rayDown(dropRes.position.x, dropRes.position.z, dropProbe.point.y + 0.05, dropProbe.point.y - 0.05, colliders);
  if (!landingRay || landingRay.boxId !== dropProbe.boxId) {
    result.reason = 'landing-ray-mismatch';
    return result;
  }
  if (!capsuleFits(dropRes.position, shape.halfSeg, shape.radius, colliders, cfg)) {
    result.reason = 'landing-overlap';
    return result;
  }
  const rise = landingRay.point.y - supportBefore.point.y;
  result.rise = rise;
  result.landingAngleDeg = 0;
  if (rise > cfg.stepHeight + cfg.stepTolerance) {
    result.reason = 'rise-exceeds-limit';
    return result;
  }
  if (rise <= 1e-4) {
    const forwardProgress = Math.hypot(fwdRes.moved.x, fwdRes.moved.z);
    if (forwardProgress > 0.005) {
      result.success = true;
      result.reason = 'partial-forward';
      result.position = dropRes.position;
      result.support = supportFromContacts(dropRes.contacts, cfg) || supportBefore;
      result.partial = true;
      return result;
    }
    result.reason = 'no-progress';
    return result;
  }

  result.success = true;
  result.reason = 'ok';
  result.position = dropRes.position;
  result.support = {
    ...supportBefore,
    point: { ...landingRay.point },
    normal: { ...landingRay.normal },
    angleDeg: 0,
    walkable: true,
    label: landingRay.label,
    boxId: landingRay.boxId,
    contact: null,
  };
  return result;
}

/**
 * Project a horizontal displacement onto a support plane. This is the
 * geometric relationship the on-ramp rise is validated against:
 *   dy = -(dx * n.x + dz * n.z) / n.y
 * so a 22 deg ramp must raise the capsule by |d| * tan(22 deg).
 */
export function projectOnSupport(horizontal, support) {
  const delta = { x: horizontal.x, y: 0, z: horizontal.z };
  if (!support || support.normal.y < 0.2) return delta;
  const n = support.normal;
  delta.y = -(delta.x * n.x + delta.z * n.z) / n.y;
  return delta;
}

/**
 * Smallest forward distance at which a vertical ray under the capsule axis
 * lands on the expected tread height. Straight geometric test, no motion.
 */
export function findTreadAdvance(pos, dir, feetAtLift, treadY, maxAdvance, colliders) {
  const step = 0.01;
  for (let d = 0; d <= maxAdvance + 1e-9; d += step) {
    const x = pos.x + dir.x * d;
    const z = pos.z + dir.z * d;
    const hit = rayDown(x, z, feetAtLift + 0.03, feetAtLift - 0.12, colliders);
    if (hit && Math.abs(hit.point.y - treadY) < 0.02) return d;
  }
  return maxAdvance;
}

/**
 * Cheap geometric look-ahead used to decide whether step assessment should run
 * this frame. It performs no motion: it tests for a walkable tread just ahead
 * at a height within the step limit above the current support.
 */
export function advanceProbe(pos, support, shape, horizontal, colliders, cfg) {
  if (!support || !support.walkable) return null;
  const len = Math.hypot(horizontal.x, horizontal.z);
  if (len <= 1e-6) return null;
  const dir = { x: horizontal.x / len, z: horizontal.z / len };
  const center = {
    x: pos.x + dir.x * (shape.radius + 0.03),
    z: pos.z + dir.z * (shape.radius + 0.03),
  };
  const feet = pos.y - shape.feetOffset;
  const hit = rayDown(center.x, center.z, feet + cfg.stepHeight, feet + 0.02, colliders);
  if (!hit) return null;
  if (hit.normal.y < 0.5) return null;
  const rise = hit.point.y - support.point.y;
  if (rise <= 0.02 || rise > cfg.stepHeight + cfg.stepTolerance) return null;
  return hit;
}

export class CharacterController {
  constructor(options = {}) {
    this.cfg = { ...DEFAULT_CONFIG, ...options };
    this.shape = deriveShape(this.cfg);
    this.position = vec3(0, this.shape.feetOffset, 0);
    this.velocity = vec3();
    this.grounded = false;
    this.support = null;
    this.time = 0;
    this.frame = 0;
    this.transitions = [];
    this.lastTelemetry = null;
    this.colliders = [];
    this.stats = {
      frames: 0,
      maxPenetration: 0,
      maxSlideIterations: 0,
      maxSlidePlanes: 0,
      stepUps: 0,
      stepRejections: 0,
      multiPlaneSolves: 0,
      groundedFrames: 0,
    };
  }

  setColliders(colliders) {
    this.colliders = colliders;
    return this;
  }

  configure(partial) {
    const feet = this.feetY;
    this.cfg = { ...this.cfg, ...partial };
    this.shape = deriveShape(this.cfg);
    this.position.y = feet + this.shape.feetOffset;
    const depen = depenetrate(this.position, this.shape.halfSeg, this.shape.radius, this.colliders, this.cfg);
    this.position = depen.position;
    this.refreshSupport();
  }

  setPosition(position, { grounded = false } = {}) {
    this.position = { ...position };
    this.velocity = vec3();
    this.grounded = grounded;
    this.time = 0;
    this.frame = 0;
    this.transitions = [];
    this.lastTelemetry = null;
    this.stats = {
      frames: 0,
      maxPenetration: 0,
      maxSlideIterations: 0,
      maxSlidePlanes: 0,
      stepUps: 0,
      stepRejections: 0,
      multiPlaneSolves: 0,
      groundedFrames: 0,
    };
    this.refreshSupport();
    return this;
  }

  get feetY() {
    return this.position.y - this.shape.feetOffset;
  }

  teleport(position, { snap = true } = {}) {
    this.position = { ...position };
    this.velocity = vec3();
    this.grounded = false;
    this.support = null;
    if (snap && this.colliders.length) {
      const probe = probeSupport(this.position, this.shape, this.colliders, this.cfg, 4);
      if (probe.support) {
        this.position = probe.position;
        this.support = probe.support;
        this.grounded = probe.support.walkable;
      }
    }
    this.lastTelemetry = null;
    return this;
  }

  refreshSupport() {
    if (!this.colliders.length) return;
    const contacts = collectContacts(this.position, this.shape.halfSeg, this.shape.radius, this.colliders, this.cfg);
    this.support = supportFromContacts(contacts, this.cfg);
    this.grounded = !!(this.support && this.support.walkable);
  }

  step(dt, cmd = {}) {
    if (!this.colliders.length) throw new Error('CharacterController: no colliders');
    dt = Math.min(dt, this.cfg.maxFrameDt);
    const cfg = this.cfg;
    const shape = this.shape;
    const colliders = this.colliders;

    this.frame++;
    this.time += dt;
    const events = [];
    const prePos = { ...this.position };
    const preGrounded = this.grounded;
    const preSupport = this.support ? { ...this.support } : null;

    // ---- intent -----------------------------------------------------------
    const move = cmd.move || { x: 0, z: 0 };
    const wishLen = Math.hypot(move.x, move.z);
    const wish = wishLen > 1e-6 ? { x: move.x / wishLen, y: 0, z: move.z / wishLen } : vec3();
    const speed = cmd.speedScale === undefined ? cfg.moveSpeed : cfg.moveSpeed * cmd.speedScale;
    const wishVel = scale(wish, speed);

    const accel = this.grounded ? cfg.groundAccel : cfg.airAccel;
    if (wishLen > 1e-4) {
      this.velocity.x = approach(this.velocity.x, wishVel.x, accel * dt);
      this.velocity.z = approach(this.velocity.z, wishVel.z, accel * dt);
    } else if (this.grounded) {
      const damp = Math.max(0, 1 - cfg.groundFriction * dt);
      this.velocity.x *= damp;
      this.velocity.z *= damp;
      if (Math.abs(this.velocity.x) < 1e-3) this.velocity.x = 0;
      if (Math.abs(this.velocity.z) < 1e-3) this.velocity.z = 0;
    }

    const horizontalRequested = { x: this.velocity.x * dt, y: 0, z: this.velocity.z * dt };
    const requestsMove = Math.hypot(horizontalRequested.x, horizontalRequested.z) > 1e-7;

    let jumped = false;
    if (cmd.jump && this.grounded) {
      this.velocity.y = cfg.jumpSpeed;
      this.grounded = false;
      jumped = true;
      events.push('jump');
    }

    let slide = null;
    let stepInfo = null;
    let steppedForward = false;
    let supportProjected = null;
    let verticalStage = null;

    if (this.grounded && !jumped) {
      // ---- phase A: displacement along the support plane ------------------
      const planeDelta = projectOnSupport(horizontalRequested, this.support);
      supportProjected = planeDelta;
      slide = slideMove(this.position, shape, planeDelta, colliders, cfg, { ignoreWalkable: true });
      this.position = slide.position;
      const actualH = Math.hypot(this.position.x - prePos.x, this.position.z - prePos.z);
      const wantedH = Math.hypot(horizontalRequested.x, horizontalRequested.z);

      // ---- phase B: step assessment (separate from walking) --------------
      // Triggered by realised motion being blocked, not by a lucky contact
      // list: a steep wall or a riser both count. At full walking speed one
      // frame covers only a few centimetres, so the block is detected on
      // geometry too (a tread within step height right in front).
      const wantForStep = Math.hypot(horizontalRequested.x, horizontalRequested.z);
      let triggered = requestsMove && actualH < wantedH * 0.9;
      if (!triggered && requestsMove && wantForStep > 1e-5) {
        const ahead = advanceProbe(this.position, this.support, shape, horizontalRequested, colliders, cfg);
        if (ahead) triggered = true;
      }
      if (cfg.stepHeight > 0 && triggered) {
        {
          stepInfo = assessStep(prePos, shape, horizontalRequested, preSupport, colliders, cfg);
          if (stepInfo.success) {
            this.position = stepInfo.position;
            this.support = stepInfo.support;
            this.velocity.y = 0;
            this.steppedThisFrame = true;
            steppedForward = true;
            this.grounded = true;
            this.stats.stepUps++;
            events.push('step-up');
          } else {
            this.stats.stepRejections++;
            events.push('step-rejected');
          }
        }
      }

      // ---- phase C: ground support / vertical ----------------------------
      if (!steppedForward) {
        const groundProbe = probeSupport(this.position, shape, colliders, cfg, cfg.groundSnap);
        verticalStage = {
          probeDrop: Math.max(0, this.position.y - groundProbe.position.y),
          supportFound: !!groundProbe.support,
        };
        if (groundProbe.support && groundProbe.support.walkable) {
          this.position = groundProbe.position;
          this.support = groundProbe.support;
          this.velocity.y = 0;
          this.grounded = true;
        } else {
          this.support = groundProbe.support || null;
          this.grounded = false;
          this.velocity.y = Math.min(0, this.velocity.y) - cfg.gravity * dt;
          const fall = slideMove(
            this.position,
            shape,
            { x: 0, y: this.velocity.y * dt, z: 0 },
            colliders,
            cfg,
          );
          this.position = fall.position;
          if (fall.hits.length) {
            const up = fall.hits.find((h) => h.normal.y > 0.02);
            if (up) this.velocity.y = 0;
          }
          if (preGrounded) events.push('left-ground');
        }
      }
    } else {
      // ---- airborne: one bounded 3D slide ---------------------------------
      this.velocity.y -= cfg.gravity * dt;
      const delta = { x: this.velocity.x * dt, y: this.velocity.y * dt, z: this.velocity.z * dt };
      slide = slideMove(this.position, shape, delta, colliders, cfg);
      this.position = slide.position;
      if (slide.hits.length) {
        const clip = clipVelocity(this.velocity, slide.hits.map((h) => h.normal));
        this.velocity.x = clip.velocity.x;
        this.velocity.y = clip.velocity.y;
        this.velocity.z = clip.velocity.z;
        const groundHit = slide.hits
          .filter((h) => h.normal.y > 0.02)
          .sort((a, b) => b.normal.y - a.normal.y)[0];
        if (groundHit && isWalkableNormal(groundHit.normal, cfg) && this.velocity.y <= 1e-3) {
          this.velocity.y = 0;
        }
      }
      if (preGrounded && !this.grounded) events.push('left-ground');
    }

    // ---- step commit re-anchor: settle exactly onto the tread -------------
    if (steppedForward) {
      const anchor = probeSupport(this.position, shape, colliders, cfg, cfg.groundSnap);
      if (anchor.support && anchor.support.walkable) {
        this.position = anchor.position;
        this.support = anchor.support;
        this.grounded = true;
        this.velocity.y = 0;
      }
    }

    // ---- phase D: bounded depenetration safety net ------------------------
    const depen = depenetrate(this.position, shape.halfSeg, shape.radius, colliders, cfg);
    if (depen.passes) this.position = depen.position;

    // ---- phase E: final support read (pure query) -------------------------
    const finalContacts = collectContacts(this.position, shape.halfSeg, shape.radius, colliders, cfg);
    const finalSupport = supportFromContacts(finalContacts, cfg);
    this.support = finalSupport;
    if (this.grounded) {
      if (!finalSupport || !finalSupport.walkable) {
        this.grounded = false;
        if (!events.includes('left-ground')) events.push('left-ground');
      }
    } else if (finalSupport && finalSupport.walkable && this.velocity.y <= 1e-3) {
      this.grounded = true;
      this.velocity.y = 0;
      if (!preGrounded && !jumped) events.push('landed');
    }

    // ---- horizontal velocity from realised motion -------------------------
    const actualHorizontal = { x: this.position.x - prePos.x, y: 0, z: this.position.z - prePos.z };
    if (steppedForward) {
      this.velocity.x = horizontalRequested.x / dt;
      this.velocity.z = horizontalRequested.z / dt;
    } else if (this.grounded) {
      this.velocity.x = actualHorizontal.x / dt;
      this.velocity.z = actualHorizontal.z / dt;
    }

    const penetration = Math.max(depen.penetration, 0);
    this.stats.frames++;
    if (this.grounded) this.stats.groundedFrames++;
    this.stats.maxPenetration = Math.max(this.stats.maxPenetration, penetration);
    if (slide) {
      this.stats.maxSlideIterations = Math.max(this.stats.maxSlideIterations, slide.iterations);
      this.stats.maxSlidePlanes = Math.max(this.stats.maxSlidePlanes, slide.planesSolved);
      if (slide.planesSolved >= 2) this.stats.multiPlaneSolves++;
    }

    const telemetry = {
      frame: this.frame,
      time: this.time,
      dt,
      prePosition: prePos,
      position: { ...this.position },
      cameraYaw: cmd.cameraYaw || 0,
      velocity: { ...this.velocity },
      grounded: this.grounded,
      previousGrounded: preGrounded,
      support: this.support
        ? {
            point: { ...this.support.point },
            normal: { ...this.support.normal },
            angleDeg: this.support.angleDeg,
            walkable: this.support.walkable,
            boxId: this.support.boxId,
            label: this.support.label,
            separation: this.support.separation,
          }
        : null,
      groundAngleDeg: this.support ? this.support.angleDeg : null,
      contacts: finalContacts.map((c) => ({
        boxId: c.boxId,
        label: c.label,
        kind: c.kind,
        point: { ...c.point },
        normal: { ...c.normal },
        separation: c.separation,
        depth: c.depth,
      })),
      horizontalRequested,
      horizontalActual: actualHorizontal,
      horizontalActualDistance: Math.hypot(actualHorizontal.x, actualHorizontal.z),
      horizontalRequestedDistance: Math.hypot(horizontalRequested.x, horizontalRequested.z),
      planeDelta: supportProjected,
      verticalStage,
      step: stepInfo,
      slide: slide
        ? {
            iterations: slide.iterations,
            planes: slide.planesSolved,
            exhausted: slide.exhausted,
            hits: slide.hits.map((h) => ({
              boxId: h.boxId,
              label: h.label,
              normal: { ...h.normal },
              clipPlanes: h.clipPlanes,
            })),
          }
        : null,
      depenetrationPasses: depen.passes,
      penetration,
      events,
      jumped,
    };
    this.lastTelemetry = telemetry;
    if (preGrounded !== this.grounded) {
      this.transitions.push({
        frame: this.frame,
        time: this.time,
        from: preGrounded ? 'grounded' : 'airborne',
        to: this.grounded ? 'grounded' : 'airborne',
      });
    }
    return telemetry;
  }
}

export function measurePenetration(controller) {
  const res = maxPenetration(controller.position, controller.shape.halfSeg, controller.shape.radius, controller.colliders, controller.cfg);
  return res.depth;
}

export { capsuleBounds, EPS };
