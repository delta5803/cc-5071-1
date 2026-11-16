import { sub, vec3 } from './math.js';
import {
  capsuleFits,
  maxPenetration,
  sweepCapsule,
} from './colliders.js';
import { rayDown, ringOffsets } from './rays.js';

/**
 * Nearest overhead slab face from an apex height. Only boxes whose top is above
 * the apex can be a ceiling (the floor is excluded); a box whose underside is
 * already below the apex yields a negative, intruding gap so the headroom clamp
 * drives the allowed lift to zero instead of ignoring it.
 */
function ceilingHitAt(x, z, apexY, colliders) {
  let best = null;
  for (const box of colliders) {
    if (x < box.aabb.min.x || x > box.aabb.max.x) continue;
    if (z < box.aabb.min.z || z > box.aabb.max.z) continue;
    if (box.aabb.max.y <= apexY + 1e-6) continue;
    const underside = box.aabb.min.y;
    if (!best || underside < best.y) best = { y: underside, label: box.label };
  }
  return best;
}

/**
 * Alternative step solvers wired into the same CharacterController.
 *
 * Both solvers move the SAME capsule through REAL sweeps (no endpoint-only
 * placement) and every accepted pose is checked for headroom and for
 * penetration along the traversed path, not just at the final position.
 *
 *   horizontalFirst ("水平扫描再抬升"):
 *     push the full horizontal request at the current height, then lift only
 *     as much as the measured riser requires. It is deliberately faithful to
 *     the naive ordering so the experiments can show where that ordering fails
 *     (riser collision, headroom, long-stride truncation).
 *
 *   constrainedCandidates ("受限多候选运动求解"):
 *     build a small bounded set of candidate paths (lift-first, diagonal
 *     corner-cut, climb-along-surface), verify each with the same sweep +
 *     headroom + path-penetration gates, and commit the first feasible one;
 *     rejection records which gate and which candidate failed.
 */

const PATH_SAMPLE = 0.02; // m between independent penetration queries
// A walkable tread must be within ~26 deg of horizontal. Ramp faces (e.g. the
// 24 deg test slope has normal.y = cos24 ~ 0.914) are excluded from stepping
// and left to the support-plane projection so no millimetre "step" is invented.
const TREAD_NORMAL_Y = 0.94;

function baseResult(supportBefore) {
  return {
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
    candidates: [],
    violations: [],
    pathPenetration: 0,
    headroomBlocked: false,
  };
}

/** Largest penetration over the swept box of one capsule move. */
export function pathPenetrationOf(start, end, halfSeg, radius, colliders, cfg) {
  const span = sub(end, start);
  const dist = Math.hypot(span.x, span.y, span.z);
  const steps = Math.max(1, Math.ceil(dist / PATH_SAMPLE));
  let worst = 0;
  let worstAt = start;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const p = { x: start.x + span.x * t, y: start.y + span.y * t, z: start.z + span.z * t };
    const { depth } = maxPenetration(p, halfSeg, radius, colliders, cfg);
    if (depth > worst) {
      worst = depth;
      worstAt = p;
    }
  }
  return { depth: worst, at: worstAt, samples: steps + 1 };
}

/**
 * Headroom gate at a raised pose: the capsule apex must not cross the lowest
 * underside over the axis or one radius ahead. The gap is a slab interval
 * measurement so a ceiling inside the horizontal footprint is always seen.
 */
export function headroomClear(center, halfSeg, radius, dirH, colliders, cfg) {
  const topY = center.y + halfSeg + radius;
  const origins = [
    { x: center.x, z: center.z },
    { x: center.x + dirH.x * radius, z: center.z + dirH.z * radius },
  ];
  for (const o of origins) {
    const hit = ceilingHitAt(o.x, o.z, topY, colliders);
    if (hit && hit.y - topY < cfg.skin) {
      return { clear: false, contact: { label: hit.label, gap: hit.y - topY } };
    }
  }
  return { clear: true, contact: null };
}

/**
 * Vertical distance the capsule may rise before its top sphere touches an
 * underside. The ceiling of a step sits over the destination, not the starting
 * axis, so this measures the tightest underside gap along the whole horizontal
 * extent the capsule will occupy (axis plus `reach` of forward travel).
 */
export function headroomBudget(center, shape, dirH, reach, colliders) {
  const topY = center.y + shape.halfSeg + shape.radius;
  let nearest = Infinity;
  let label = null;
  const samples = Math.max(1, Math.ceil(reach / 0.05));
  for (let i = 0; i <= samples; i++) {
    const d = (i / samples) * reach;
    const x = center.x + dirH.x * d;
    const z = center.z + dirH.z * d;
    // Only undersides strictly above the current apex are an upward limit; a
    // slab below the apex is the floor/riser, never a ceiling.
    const hit = ceilingHitAt(x, z, topY, colliders);
    if (hit && hit.y > topY && hit.y - topY < nearest) {
      nearest = hit.y - topY;
      label = hit.label;
    }
  }
  if (!Number.isFinite(nearest)) return { available: Infinity, label: null, ceilingY: null };
  // Signed gap: negative means the apex already intrudes at this horizontal
  // sample, which forces the lift clamp to zero and the feasibility gate fails.
  return { available: nearest, label, ceilingY: topY + nearest };
}

/**
 * Locate the riser in front of the capsule. The probe must stay within the
 * tread's own horizontal extent: a ray one radius ahead can overshoot a thin
 * step (its AABB ends at the back edge) and miss the top face entirely, so the
 * search steps outward in 2 cm increments and keeps the first walkable hit
 * whose height is within the step limit.
 */
function measureRiser(startPos, shape, dirH, supportBefore, colliders, cfg) {
  const feetY = startPos.y - shape.feetOffset;
  // Origin above the highest legal tread: a ray starting below the riser top
  // intersects the vertical side face and rayBox rejects inside origins, so
  // the probe would see only the floor. From above, the first hit is the top
  // face; the height-window check then decides whether the rise is legal.
  const fromY = feetY + cfg.stepHeight + cfg.stepTolerance + 0.05;
  for (let d = 0.04; d <= shape.radius + 0.12 + 1e-9; d += 0.02) {
    const x = startPos.x + dirH.x * d;
    const z = startPos.z + dirH.z * d;
    const hit = rayDown(x, z, fromY, feetY + 0.001, colliders);
    if (!hit) continue;
    // A step tread is near-horizontal. A sloped face (a ramp) has normal.y well
    // below this gate and is handled by the support-plane walk instead, so the
    // step solver must not read millimetres of ramp climb as a vertical step.
    if (hit.normal.y < TREAD_NORMAL_Y) continue;
    const rise = hit.point.y - supportBefore.point.y;
    if (rise <= 1e-4) continue;
    return { hit, rise, treadY: hit.point.y };
  }
  return null;
}

function runPhase(result, name, from, halfSeg, radius, delta, colliders, cfg, iterationCap) {
  const res = sweepCapsule(from, halfSeg, radius, delta, colliders, cfg, { maxIterations: iterationCap });
  const depth = motionPenetration(from, res.position, halfSeg, radius, colliders, cfg);
  const pen = { depth };
  result.pathPenetration = Math.max(result.pathPenetration, depth);
  if (depth > 0.002) {
    result.violations.push({ phase: name, kind: 'path-penetration', depth, at: { ...res.position } });
  }
  result.phases.push({ name, from: { ...from }, to: { ...res.position }, distance: res.travelled, penetration: pen.depth, truncated: res.truncated });
  return { res, pen };
}

/**
 * Penetration attributable to a solver move: the starting pose is excluded so
 * a pre-existing overlap (the controller never starts a step inside geometry,
 * but a rejected trial must still be measured fairly) cannot be charged to the
 * traversed path. Samples t in (0, 1]; the endpoint query stays separate.
 */
function motionPenetration(start, end, halfSeg, radius, colliders, cfg) {
  const span = sub(end, start);
  const dist = Math.hypot(span.x, span.y, span.z);
  const steps = Math.max(1, Math.ceil(dist / PATH_SAMPLE));
  let worst = 0;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const p = { x: start.x + span.x * t, y: start.y + span.y * t, z: start.z + span.z * t };
    worst = Math.max(worst, maxPenetration(p, halfSeg, radius, colliders, cfg).depth);
  }
  return worst;
}

/**
 * Landing validation over the capsule footprint rather than a single axis ray.
 * Near a tread's back edge the axis can overshoot while most of the contact disc
 * still rests on the step; requiring every footprint sample to hit the tread
 * would reject valid landings, so the highest tread-height hit across the disc
 * is accepted when it matches the expected box and height.
 */
function footprintLanding(pos, radius, treadHit, colliders) {
  const offsets = ringOffsets(radius, 8, 0.8);
  let best = null;
  for (const off of offsets) {
    const hit = rayDown(
      pos.x + off.x,
      pos.z + off.z,
      treadHit.point.y + 0.08,
      treadHit.point.y - 0.08,
      colliders,
    );
    if (!hit || hit.boxId !== treadHit.boxId) continue;
    if (Math.abs(hit.point.y - treadHit.point.y) > 0.02) continue;
    if (!best || hit.point.y > best.point.y) best = hit;
  }
  return best;
}

function finishOnTread(result, pos, halfSeg, radius, treadHit, colliders, cfg) {
  const feetAt = pos.y - radius - halfSeg;
  const dropNeeded = Math.max(0, feetAt - treadHit.point.y);
  const drop = runPhase(result, 'drop', pos, halfSeg, radius, { x: 0, y: -dropNeeded, z: 0 }, colliders, cfg, cfg.maxSweepIterations);
  const landing = footprintLanding(drop.res.position, radius, treadHit, colliders);
  if (!landing) {
    result.reason = 'no-landing';
    return null;
  }
  if (!capsuleFits(drop.res.position, halfSeg, radius, colliders, cfg)) {
    result.reason = 'landing-overlap';
    return null;
  }
  result.position = drop.res.position;
  result.support = {
    point: { ...landing.point },
    normal: { ...landing.normal },
    angleDeg: 0,
    walkable: true,
    label: landing.label,
    boxId: landing.boxId,
    contact: null,
  };
  return result;
}

/**
 * Horizontal scan first, then lift. The capsule drives into the riser at foot
 * level; the sweep stops at the face, so the realised forward distance is
 * whatever geometry allowed, and the measured rise caps the lift.
 */
export function horizontalFirstStep(startPos, shape, horizontalDelta, supportBefore, colliders, cfg) {
  const result = baseResult(supportBefore);
  result.scheme = 'horizontal-first';
  if (!supportBefore) {
    result.reason = 'no-support';
    return result;
  }
  const len = Math.hypot(horizontalDelta.x, horizontalDelta.z);
  if (len <= 1e-5) {
    result.reason = 'no-motion';
    return result;
  }
  const dirH = { x: horizontalDelta.x / len, z: horizontalDelta.z / len };
  const riser = measureRiser(startPos, shape, dirH, supportBefore, colliders, cfg);
  if (!riser) {
    result.reason = 'no-tread';
    return result;
  }
  result.obstacleTop = riser.treadY;
  result.obstacleLabel = riser.hit.label;
  if (riser.rise > cfg.stepHeight + cfg.stepTolerance) {
    result.rise = riser.rise;
    result.reason = 'rise-exceeds-limit';
    return result;
  }

  // Phase 1: full horizontal scan at the current height.
  const h0 = runPhase(result, 'horizontal', startPos, shape.halfSeg, shape.radius, { x: horizontalDelta.x, y: 0, z: horizontalDelta.z }, colliders, cfg, cfg.maxSweepIterations);
  const gotH = Math.hypot(h0.res.moved.x, h0.res.moved.z);
  result.forward = gotH;
  if (h0.res.hit) result.violations.push({ phase: 'horizontal', kind: 'riser-block', label: h0.res.hit.label, remaining: Math.hypot(h0.res.position.x - (startPos.x + horizontalDelta.x), h0.res.position.z - (startPos.z + horizontalDelta.z)) });
  if (h0.res.truncated) result.violations.push({ phase: 'horizontal', kind: 'iter-cap' });
  if (gotH < 1e-5) {
    result.reason = 'horizontal-blocked';
    return result;
  }

  // Phase 2: lift enough for the bottom sphere to clear the riser corner.
  // At a horizontal gap g from the tread face the sphere sags by
  // r - sqrt(r^2 - g^2), so the lift must cover rise plus that sag; the value
  // is bounded by the configured step height and by the measured headroom.
  const gap = Math.max(0, shape.radius - gotH);
  const sag = shape.radius - Math.sqrt(Math.max(0, shape.radius * shape.radius - gap * gap));
  const liftWanted = Math.min(cfg.stepHeight, riser.rise + sag + cfg.skin);
  const room = headroomBudget(h0.res.position, shape, dirH, shape.radius + 0.05, colliders);
  const liftNeeded = Math.min(liftWanted, room.available);
  if (liftNeeded + 0.005 < liftWanted) {
    result.headroomBlocked = true;
    result.violations.push({ phase: 'lift', kind: 'headroom-clamp', label: room.label, wanted: liftWanted, allowed: room.available });
    // A clamped lift that cannot clear the riser geometry is a rejection, not
    // an embedded forward move.
    if (liftNeeded < riser.rise + sag - 0.005) {
      result.reason = 'headroom-blocked';
      return result;
    }
  }
  const lift = runPhase(result, 'lift', h0.res.position, shape.halfSeg, shape.radius, { x: 0, y: liftNeeded, z: 0 }, colliders, cfg, cfg.maxSweepIterations);
  result.lift = lift.res.travelled;
  if (lift.res.hit || lift.res.truncated) {
    result.reason = 'headroom-blocked';
    result.headroomBlocked = true;
    result.violations.push({ phase: 'lift', kind: lift.res.hit ? 'headroom' : 'iter-cap', label: lift.res.hit ? lift.res.hit.label : null });
    return result;
  }
  const head = headroomClear(lift.res.position, shape.halfSeg, shape.radius, dirH, colliders, cfg);
  if (!head.clear) {
    result.reason = 'headroom-blocked';
    result.headroomBlocked = true;
    result.violations.push({ phase: 'lift', kind: 'headroom-gate', label: head.contact.label });
    return result;
  }

  // Phase 3: advance at the raised height until the axis is over the tread.
  // Bounded to one radius so the assist can only reach within the capsule's
  // own footprint; a ceiling or wall here stops the sweep and the trial fails
  // on headroom instead of snapping onto the top from below the ledge.
  const advance = Math.min(shape.radius, Math.max(0, shape.radius - gotH) + 0.02);
  const fwd = runPhase(
    result,
    'forward',
    lift.res.position,
    shape.halfSeg,
    shape.radius,
    { x: dirH.x * advance, y: 0, z: dirH.z * advance },
    colliders,
    cfg,
    cfg.maxSweepIterations,
  );
  if (fwd.res.hit || fwd.res.truncated) {
    result.reason = 'forward-blocked';
    result.violations.push({ phase: 'forward', kind: fwd.res.hit ? 'headroom' : 'iter-cap', label: fwd.res.hit ? fwd.res.hit.label : null });
    return result;
  }
  const head2 = headroomClear(fwd.res.position, shape.halfSeg, shape.radius, dirH, colliders, cfg);
  if (!head2.clear) {
    result.reason = 'headroom-blocked';
    result.headroomBlocked = true;
    result.violations.push({ phase: 'forward', kind: 'headroom-gate', label: head2.contact.label });
    return result;
  }

  const done = finishOnTread(result, fwd.res.position, shape.halfSeg, shape.radius, riser.hit, colliders, cfg);
  if (!done) return result;
  result.rise = riser.rise;
  result.success = true;
  result.reason = 'ok';
  result.forward = Math.hypot(result.position.x - startPos.x, result.position.z - startPos.z);
  return result;
}

/**
 * Constrained multi-candidate solve. Each candidate is a full path of real
 * sweeps; feasibility = every phase moved its requested distance, headroom
 * gate passes, path penetration stays within the skin, and the landing ray
 * matches the tread. Candidates are tried in order and the first feasible one
 * wins, so the choice is explainable rather than a black-box preference.
 */
export function constrainedCandidateStep(startPos, shape, horizontalDelta, supportBefore, colliders, cfg) {
  const result = baseResult(supportBefore);
  result.scheme = 'constrained-candidates';
  if (!supportBefore) {
    result.reason = 'no-support';
    return result;
  }
  const len = Math.hypot(horizontalDelta.x, horizontalDelta.z);
  if (len <= 1e-5) {
    result.reason = 'no-motion';
    return result;
  }
  const dirH = { x: horizontalDelta.x / len, z: horizontalDelta.z / len };
  const riser = measureRiser(startPos, shape, dirH, supportBefore, colliders, cfg);
  if (!riser) {
    result.reason = 'no-tread';
    return result;
  }
  result.obstacleTop = riser.treadY;
  result.obstacleLabel = riser.hit.label;
  if (riser.rise > cfg.stepHeight + cfg.stepTolerance) {
    result.rise = riser.rise;
    result.reason = 'rise-exceeds-limit';
    return result;
  }

  const cap = cfg.maxSweepIterations;
  // Probe all the way to the forward destination plus one radius: the capsule
  // apex occupies that footprint even though the axis stops a radius earlier.
  const reach = len + 2 * shape.radius;
  const room = headroomBudget(startPos, shape, dirH, reach, colliders);
  result.headroomAvailable = Number.isFinite(room.available) ? room.available : null;
  const candidates = buildCandidates(startPos, shape, dirH, len, riser.rise, cfg, room.available);

  for (const cand of candidates) {
    const trial = baseResult(supportBefore);
    trial.scheme = result.scheme;
    trial.obstacleTop = riser.treadY;
    trial.obstacleLabel = riser.hit.label;
    let pos = { ...startPos };
    let feasible = true;
    let blockReason = null;

    for (const phase of cand.phases) {
      const delta = phase.delta(pos);
      const r = runPhase(trial, phase.name, pos, shape.halfSeg, shape.radius, delta, colliders, cfg, cap);
      const wanted = Math.hypot(delta.x, delta.y, delta.z);
      if (r.res.truncated) {
        feasible = false;
        blockReason = { phase: phase.name, kind: 'iter-cap', label: null };
        break;
      }
      if (wanted > 1e-6 && r.res.travelled < wanted - 0.005) {
        feasible = false;
        blockReason = { phase: phase.name, kind: r.res.hit ? 'sweep-block' : 'iter-cap', label: r.res.hit ? r.res.hit.label : null };
        break;
      }
      if (r.pen.depth > 0.002) {
        feasible = false;
        blockReason = { phase: phase.name, kind: 'path-penetration', label: null, depth: r.pen.depth };
        break;
      }
      if (phase.needsHeadroom) {
        const head = headroomClear(r.res.position, shape.halfSeg, shape.radius, dirH, colliders, cfg);
        if (!head.clear) {
          feasible = false;
          blockReason = { phase: phase.name, kind: 'headroom', label: head.contact.label };
          break;
        }
      }
      pos = r.res.position;
    }

    const report = {
      name: cand.name,
      feasible,
      reason: blockReason ? blockReason.kind : 'pending-landing',
      block: blockReason,
      pathPenetration: trial.pathPenetration,
      phases: trial.phases.map((p) => ({ name: p.name, penetration: p.penetration })),
    };

    if (feasible) {
      const finished = finishOnTread(trial, pos, shape.halfSeg, shape.radius, riser.hit, colliders, cfg);
      report.reason = finished ? 'ok' : trial.reason;
      report.feasible = !!finished;
      result.candidates.push(report);
      if (finished) {
        result.success = true;
        result.reason = 'ok';
        result.chosen = cand.name;
        result.position = trial.position;
        result.support = trial.support;
        result.phases = trial.phases;
        result.violations = trial.violations;
        result.pathPenetration = trial.pathPenetration;
        result.rise = riser.rise;
        result.lift = Math.max(...trial.phases.filter((p) => p.name === 'lift' || p.name === 'diagonal').map((p) => p.distance), 0);
        result.forward = Math.hypot(trial.position.x - startPos.x, trial.position.z - startPos.z);
        return result;
      }
    } else {
      result.violations.push({ candidate: cand.name, ...blockReason });
      result.candidates.push(report);
    }
  }

  result.reason = result.headroomBlocked ? 'headroom-blocked' : 'all-candidates-blocked';
  result.forward = 0;
  return result;
}

/**
 * Candidate paths, each bounded to one radius of assisted travel and never
 * lifting more than stepHeight. The diagonal candidate cuts the lift/forward
 * corner; the ramp candidate follows the measured surface slope so a shallow
 * ramp that reads as a tiny riser is traversed instead of being stepped.
 */
function buildCandidates(startPos, shape, dirH, len, rise, cfg, availableHeadroom = Infinity) {
  // Full vertical lift must cover the bottom-sphere sag at zero horizontal
  // clearance: r - sqrt(r^2 - r^2) = r. Capped by the step-height budget and
  // by the measured headroom; when the cap is below the required clearance the
  // feasibility gates reject this candidate instead of scraping the riser.
  const fullSag = shape.radius;
  const liftHeight = Math.min(cfg.stepHeight, rise + fullSag + cfg.skin, availableHeadroom);
  // The solver may assist at most one radius beyond the requested stride; it
  // never invents motion larger than the request plus that bounded assist.
  const forwardDist = len + Math.min(shape.radius, Math.max(0, shape.radius - len));
  const diag = Math.min(shape.radius, Math.max(0.05, forwardDist * 0.4));
  // After travelling diag horizontally the remaining sphere sag is smaller.
  const diagSag = shape.radius - Math.sqrt(Math.max(0, shape.radius * shape.radius - diag * diag));
  const diagLift = Math.min(cfg.stepHeight, rise + diagSag + cfg.skin, availableHeadroom);
  const climbAngle = Math.atan2(rise, Math.max(rise, shape.radius));

  return [
    {
      name: 'lift-first',
      phases: [
        { name: 'lift', needsHeadroom: true, delta: () => vec3(0, liftHeight, 0) },
        {
          name: 'forward',
          needsHeadroom: true,
          delta: () => ({ x: dirH.x * forwardDist, y: 0, z: dirH.z * forwardDist }),
        },
      ],
    },
    {
      name: 'diagonal-corner-cut',
      phases: [
        {
          name: 'diagonal',
          needsHeadroom: true,
          delta: () => ({ x: dirH.x * diag, y: diagLift, z: dirH.z * diag }),
        },
        {
          name: 'forward',
          needsHeadroom: true,
          delta: () => ({ x: dirH.x * (forwardDist - diag), y: 0, z: dirH.z * (forwardDist - diag) }),
        },
      ],
    },
    {
      name: 'climb-along-surface',
      phases: [
        {
          name: 'ramp-climb',
          needsHeadroom: false,
          delta: () => ({
            x: dirH.x * forwardDist,
            y: Math.max(rise, forwardDist * Math.sin(climbAngle)),
            z: dirH.z * forwardDist,
          }),
        },
      ],
    },
  ];
}

export const STEP_SCHEMES = Object.freeze({
  HORIZONTAL_FIRST: 'horizontal-first',
  CONSTRAINED_CANDIDATES: 'constrained-candidates',
});

export function runStepScheme(scheme, startPos, shape, horizontalDelta, supportBefore, colliders, cfg) {
  if (scheme === STEP_SCHEMES.HORIZONTAL_FIRST) {
    return horizontalFirstStep(startPos, shape, horizontalDelta, supportBefore, colliders, cfg);
  }
  if (scheme === STEP_SCHEMES.CONSTRAINED_CANDIDATES) {
    return constrainedCandidateStep(startPos, shape, horizontalDelta, supportBefore, colliders, cfg);
  }
  throw new Error(`unknown step scheme: ${scheme}`);
}
