import {
  EPS,
  add,
  clamp,
  clampPointToBox,
  cross,
  dot,
  length,
  lengthSq,
  lerp,
  scale,
  sub,
  vec3,
  boxRotation,
  rotForward,
  rotInverse,
} from './math.js';

const GOLDEN = 0.6180339887498949;

/**
 * Oriented box collider. Rotation is Ry(yaw) * Rx(pitch); with yaw=0 and
 * pitch>0 the top surface rises toward -Z, giving a ramp.
 */
export function makeBox({
  id,
  label = id,
  center,
  half,
  yaw = 0,
  pitch = 0,
  kind = 'solid',
  color = 0x8a93a6,
}) {
  if (!(half.x > 0) || !(half.y > 0) || !(half.z > 0)) {
    throw new Error(`invalid collider ${id}: half extents must be positive (${half.x}, ${half.y}, ${half.z})`);
  }
  const rotation = boxRotation(yaw, pitch);
  const corners = [];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        corners.push(add(center, rotForward(rotation, { x: half.x * sx, y: half.y * sy, z: half.z * sz })));
      }
    }
  }
  const aabb = {
    min: {
      x: Math.min(...corners.map((c) => c.x)),
      y: Math.min(...corners.map((c) => c.y)),
      z: Math.min(...corners.map((c) => c.z)),
    },
    max: {
      x: Math.max(...corners.map((c) => c.x)),
      y: Math.max(...corners.map((c) => c.y)),
      z: Math.max(...corners.map((c) => c.z)),
    },
  };
  return { id, label, center, half, rotation, corners, aabb, kind, color };
}

export function capsuleBounds(center, halfSeg, radius) {
  return {
    min: { x: center.x - radius, y: center.y - halfSeg - radius, z: center.z - radius },
    max: { x: center.x + radius, y: center.y + halfSeg + radius, z: center.z + radius },
  };
}

export function broadphaseHit(center, halfSeg, radius, box, skin) {
  const cap = capsuleBounds(center, halfSeg, radius);
  const pad = skin + 1e-4;
  return !(
    cap.max.x + pad < box.aabb.min.x ||
    cap.min.x - pad > box.aabb.max.x ||
    cap.max.y + pad < box.aabb.min.y ||
    cap.min.y - pad > box.aabb.max.y ||
    cap.max.z + pad < box.aabb.min.z ||
    cap.min.z - pad > box.aabb.max.z
  );
}

/**
 * Closest approach between the capsule axis segment and an oriented box.
 *
 * Squared distance from a point to a convex box is convex along an affine
 * segment, so golden-section search over the segment parameter finds the true
 * closest feature (face, edge or corner). This is what yields exact contact
 * normals on ramps and box edges rather than sampled sphere probes.
 *
 * `queryMargin` is how far outside the surface a contact is still reported.
 * It is independent of the contact `skin`: sweeps query a margin at least as
 * large as their step so no surface can be skipped.
 */
export function capsuleBoxContact(center, halfSeg, radius, box, queryMargin = 0) {
  if (!broadphaseHit(center, halfSeg, radius, box, queryMargin)) return null;

  const aWorld = { x: center.x, y: center.y + halfSeg, z: center.z };
  const bWorld = { x: center.x, y: center.y - halfSeg, z: center.z };
  const la = rotInverse(box.rotation, sub(aWorld, box.center));
  const lb = rotInverse(box.rotation, sub(bWorld, box.center));
  const half = box.half;

  const distSqAt = (t) => {
    const p = lerp(la, lb, t);
    const q = clampPointToBox(p, half);
    return lengthSq(sub(p, q));
  };

  let lo = 0;
  let hi = 1;
  let t1 = hi - GOLDEN * (hi - lo);
  let t2 = lo + GOLDEN * (hi - lo);
  let f1 = distSqAt(t1);
  let f2 = distSqAt(t2);
  for (let i = 0; i < 44; i++) {
    if (f1 < f2) {
      hi = t2;
      t2 = t1;
      f2 = f1;
      t1 = hi - GOLDEN * (hi - lo);
      f1 = distSqAt(t1);
    } else {
      lo = t1;
      t1 = t2;
      f1 = f2;
      t2 = lo + GOLDEN * (hi - lo);
      f2 = distSqAt(t2);
    }
  }

  const t = clamp((lo + hi) * 0.5, 0, 1);
  const localPoint = lerp(la, lb, t);
  const localClosest = clampPointToBox(localPoint, half);
  const pointOnSegment = add(box.center, rotForward(box.rotation, localPoint));
  const pointOnBox = add(box.center, rotForward(box.rotation, localClosest));

  const dist = length(sub(pointOnSegment, pointOnBox));
  const inside =
    Math.abs(localPoint.x) <= half.x + EPS &&
    Math.abs(localPoint.y) <= half.y + EPS &&
    Math.abs(localPoint.z) <= half.z + EPS;

  const localNormalForPoint = () => {
    const gaps = [
      half.x - Math.abs(localPoint.x),
      half.y - Math.abs(localPoint.y),
      half.z - Math.abs(localPoint.z),
    ];
    let axis = 0;
    if (gaps[1] < gaps[axis]) axis = 1;
    if (gaps[2] < gaps[axis]) axis = 2;
    const coord = axis === 0 ? localPoint.x : axis === 1 ? localPoint.y : localPoint.z;
    const sign = coord >= 0 ? 1 : -1;
    const localNormal = { x: 0, y: 0, z: 0 };
    if (axis === 0) localNormal.x = sign;
    if (axis === 1) localNormal.y = sign;
    if (axis === 2) localNormal.z = sign;
    return { normal: rotForward(box.rotation, localNormal), axis, sign, gap: gaps[axis] };
  };

  let normal;
  let separation;
  let point = pointOnBox;

  if (inside) {
    const face = localNormalForPoint();
    normal = face.normal;
    separation = -(face.gap + radius);
    const faceLocal = { ...localPoint };
    faceLocal[face.axis === 0 ? 'x' : face.axis === 1 ? 'y' : 'z'] = half[face.axis === 0 ? 'x' : face.axis === 1 ? 'y' : 'z'] * face.sign;
    point = add(box.center, rotForward(box.rotation, faceLocal));
  } else {
    separation = dist - radius;
    if (dist > EPS) {
      normal = scale(sub(pointOnSegment, pointOnBox), 1 / dist);
    } else {
      normal = localNormalForPoint().normal;
    }
  }

  if (separation > queryMargin) return null;

  return {
    boxId: box.id,
    label: box.label,
    kind: box.kind,
    normal,
    separation,
    depth: Math.max(0, -separation),
    point,
    distance: dist,
    inside,
    axisT: t,
  };
}

export function collectContacts(center, halfSeg, radius, colliders, cfg, queryMargin = Math.max(cfg.skin, cfg.supportTolerance ?? cfg.skin)) {
  const out = [];
  for (const box of colliders) {
    const c = capsuleBoxContact(center, halfSeg, radius, box, queryMargin);
    if (c) out.push(c);
  }
  out.sort((a, b) => a.separation - b.separation);
  return out;
}

export function maxPenetration(center, halfSeg, radius, colliders, cfg) {
  const contacts = collectContacts(center, halfSeg, radius, colliders, cfg);
  let depth = 0;
  for (const c of contacts) depth = Math.max(depth, -c.separation);
  return { depth, contacts };
}

/**
 * Conservative capsule sweep along `delta` using distance queries.
 *
 * For a convex box, separation along any translation is bounded below by the
 * signed distance to the supporting plane at the current closest point. That
 * plane closes at rate `-dot(dir, normal)`, so `separation / rate` is a safe
 * advance distance and the whole displacement can be resolved in one query
 * whose margin equals the step. A small bounded loop handles the remaining
 * motion after a contact resolves.
 */
export function sweepCapsule(startPos, halfSeg, radius, delta, colliders, cfg, options = {}) {
  const total = length(delta);
  const dir = total > EPS ? scale(delta, 1 / total) : vec3();
  let pos = { ...startPos };
  let budget = total;
  let iterations = 0;
  let hit = null;
  if (total <= EPS) {
    return { position: pos, moved: vec3(), travelled: 0, hit: null, iterations: 0, contacts: collectContacts(pos, halfSeg, radius, colliders, cfg) };
  }

  const iterationCap = options.maxIterations ?? Math.max(1, Math.min(cfg.maxSweepIterations, 4));
  while (budget > 1e-7 && iterations < iterationCap) {
    iterations++;
    const step = budget;
    // Any surface within `step` can be reached, so query at least that far.
    const queryMargin = step + 2 * cfg.skin;
    let limiter = null;
    let limiterAllowed = Infinity;

    let limiterBoxRef = null;
    for (const box of colliders) {
      if (!broadphaseHit(pos, halfSeg, radius, box, queryMargin)) continue;
      const c = capsuleBoxContact(pos, halfSeg, radius, box, queryMargin);
      if (!c) continue;
      const approachRate = -dot(dir, c.normal);
      if (approachRate <= 1e-6) continue; // parallel or separating
      if (c.separation <= 0) {
        // Already touching/overlapping. Only a surface we are actually pushing
        // into blocks; a coincident floor under the capsule must not.
        if (approachRate > 1e-4 && limiterAllowed > 0) {
          limiterAllowed = 0;
          limiter = c;
          limiterBoxRef = box;
        }
        continue;
      }
      const allowed = c.separation / approachRate;
      if (allowed < limiterAllowed) {
        limiterAllowed = allowed;
        limiter = c;
        limiterBoxRef = box;
      }
    }

    const advance = Math.min(step, limiterAllowed);
    if (!(advance > 1e-7)) {
      hit = limiter;
      break;
    }
    pos = add(pos, scale(dir, advance));
    budget -= advance;
    if (limiter && limiterAllowed <= advance + 1e-9) {
      // The plane bound was reached. Re-query that surface: if it is still
      // separated, the bound was conservative (e.g. an oblique box edge below
      // a falling capsule) and we continue instead of reporting a phantom hit.
      const recheck = limiterBoxRef
        ? capsuleBoxContact(pos, halfSeg, radius, limiterBoxRef, cfg.skin)
        : null;
      if (recheck) {
        hit = recheck;
        break;
      }
    }
  }

  return {
    position: pos,
    moved: sub(pos, startPos),
    travelled: total - budget,
    hit,
    truncated: budget > 1e-7 && !hit,
    iterations,
    contacts: collectContacts(pos, halfSeg, radius, colliders, cfg),
  };
}

function mergeNormals(normals) {
  const merged = [];
  for (const n of normals) {
    let found = false;
    for (const m of merged) {
      if (dot(n, m) > 0.985) {
        if (n.y > m.y) m.x = n.x, m.y = n.y, m.z = n.z;
        found = true;
        break;
      }
    }
    if (!found) merged.push({ ...n });
  }
  return merged;
}

function projectOnPlane(v, n) {
  return sub(v, scale(n, dot(v, n)));
}

/**
 * Bounded velocity clip against up to three simultaneously active planes.
 *
 * One or two planes are solved analytically (projection onto the intersection
 * of half-spaces); three are solved as a 3x3 system when well conditioned. In a
 * concave corner this yields one resolved direction instead of oscillating
 * between wall normals, and there is no unbounded projection loop.
 */
export function clipVelocity(v, normals) {
  const ns = mergeNormals(normals);
  const active = ns.filter((n) => dot(v, n) < -1e-7);
  if (!active.length) return { velocity: { ...v }, planes: 0, clamped: false };

  if (active.length === 1) {
    return { velocity: projectOnPlane(v, active[0]), planes: 1, clamped: true };
  }

  if (active.length === 2) {
    const [n1, n2] = active;
    const k = dot(n1, n2);
    const det = 1 - k * k;
    if (det > 1e-6) {
      const d1 = dot(v, n1);
      const d2 = dot(v, n2);
      const a = (d1 - k * d2) / det;
      const b = (d2 - k * d1) / det;
      let out = sub(sub(v, scale(n1, a)), scale(n2, b));
      if (dot(out, n1) < -1e-6) out = projectOnPlane(out, n1);
      if (dot(out, n2) < -1e-6) out = projectOnPlane(out, n2);
      return { velocity: out, planes: 2, clamped: true };
    }
    return { velocity: projectOnPlane(projectOnPlane(v, n1), n2), planes: 2, clamped: true };
  }

  // Three planes: c solves n_i . c = n_i . v; the constraint-corrected
  // velocity is v - sum(c_i * n_i).
  const byViolation = [...active].sort((a, b) => dot(v, a) - dot(v, b));
  const triples = [byViolation.slice(0, 3)];
  if (byViolation.length > 3) triples.push([byViolation[0], byViolation[1], byViolation[3]]);

  for (const triple of triples) {
    const [n1, n2, n3] = triple;
    const det = dot(n1, cross(n2, n3));
    if (Math.abs(det) < 0.08) continue;
    const d1 = dot(v, n1);
    const d2 = dot(v, n2);
    const d3 = dot(v, n3);
    const num = add(
      add(scale(cross(n2, n3), d1), scale(cross(n3, n1), d2)),
      scale(cross(n1, n2), d3),
    );
    const c = scale(num, 1 / det);
    let out = sub(sub(sub(v, scale(n1, c.x)), scale(n2, c.y)), scale(n3, c.z));
    let feasible = true;
    for (const n of ns) {
      if (dot(out, n) < -1e-5) {
        feasible = false;
        break;
      }
    }
    if (feasible) return { velocity: out, planes: 3, clamped: true };
  }

  // Near-degenerate corner: strip the two worst planes, then stop entirely if
  // the desired velocity still pushes into the remaining face.
  let out = projectOnPlane(v, byViolation[0]);
  if (dot(out, byViolation[1]) < 0) out = projectOnPlane(out, byViolation[1]);
  if (dot(out, byViolation[2] ?? byViolation[0]) < -1e-5) out = vec3();
  return { velocity: out, planes: 2, clamped: true };
}

/**
 * Bounded depenetration, deepest contacts first, with a capped number of
 * passes and a fresh penetration query at the end. Used only as a safety net;
 * normal motion is contact-driven rather than "move then yank back".
 */
export function depenetrate(pos, halfSeg, radius, colliders, cfg) {
  let position = { ...pos };
  let passes = 0;
  for (let i = 0; i < cfg.maxDepenetrationPasses; i++) {
    const contacts = collectContacts(position, halfSeg, radius, colliders, cfg).filter(
      (c) => c.separation < -1e-7,
    );
    if (!contacts.length) break;
    passes++;
    for (const c of contacts) {
      const depth = Math.min(-c.separation, cfg.maxDepenetrationStep);
      position = add(position, scale(c.normal, depth));
    }
  }
  const check = maxPenetration(position, halfSeg, radius, colliders, cfg);
  return { position, passes, penetration: check.depth, contacts: check.contacts };
}

export function capsuleFits(center, halfSeg, radius, colliders, cfg) {
  for (const box of colliders) {
    if (!broadphaseHit(center, halfSeg, radius, box, cfg.skin)) continue;
    const c = capsuleBoxContact(center, halfSeg, radius, box, cfg.skin);
    if (c && c.separation < -cfg.skin * 0.5) return false;
  }
  return true;
}
