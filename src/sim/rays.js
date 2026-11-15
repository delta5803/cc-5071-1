import { EPS, add, clamp, dot, lengthSq, rotForward, rotInverse, sub } from './math.js';

/**
 * Ray vs oriented box. `dir` need not be normalised; `t` is in units of `dir`.
 * Returns the entry face normal (world space) and the entry point.
 */
export function rayBox(origin, dir, box) {
  const lo = rotInverse(box.rotation, sub(origin, box.center));
  const ld = rotInverse(box.rotation, dir);
  const half = box.half;
  let tmin = -Infinity;
  let tmax = Infinity;
  let normalLocal = null;

  for (let i = 0; i < 3; i++) {
    const o = i === 0 ? lo.x : i === 1 ? lo.y : lo.z;
    const d = i === 0 ? ld.x : i === 1 ? ld.y : ld.z;
    const h = i === 0 ? half.x : i === 1 ? half.y : half.z;
    if (Math.abs(d) < EPS) {
      if (o < -h || o > h) return null;
      continue;
    }
    const inv = 1 / d;
    const ta = (-h - o) * inv;
    const tb = (h - o) * inv;
    const tNear = Math.min(ta, tb);
    const tFar = Math.max(ta, tb);
    // The entry face is -h when travel is toward +axis, +h otherwise.
    const sign = tb < ta ? 1 : -1;
    const nearFace = { x: 0, y: 0, z: 0 };
    if (i === 0) nearFace.x = sign;
    if (i === 1) nearFace.y = sign;
    if (i === 2) nearFace.z = sign;
    if (tNear > tmin) {
      tmin = tNear;
      normalLocal = nearFace;
    }
    if (tFar < tmax) tmax = tFar;
    if (tmin > tmax) return null;
  }
  if (!normalLocal || tmax < 0) return null;
  // An origin inside the box has no valid entry face; reject it so a probe
  // starting within a thick ledge cannot report a phantom top surface.
  if (tmin < 0) return null;
  const t = tmin;
  return {
    boxId: box.id,
    label: box.label,
    kind: box.kind,
    t,
    point: add(origin, { x: dir.x * t, y: dir.y * t, z: dir.z * t }),
    normal: rotForward(box.rotation, normalLocal),
  };
}

/** Highest downward ray hit over a point. Returns null when nothing is hit. */
export function rayDown(x, z, fromY, toY, colliders) {
  const origin = { x, y: fromY, z };
  const dir = { x: 0, y: toY - fromY, z: 0 };
  let best = null;
  for (const box of colliders) {
    if (x < box.aabb.min.x || x > box.aabb.max.x) continue;
    if (z < box.aabb.min.z || z > box.aabb.max.z) continue;
    if (fromY < box.aabb.min.y && toY < box.aabb.min.y) continue;
    const hit = rayBox(origin, dir, box);
    if (!hit) continue;
    if (!best || hit.t < best.t) best = hit;
  }
  return best;
}

/**
 * Footprint support: vertical rays over a disc of sample offsets, returning the
 * highest walkable face whose height lies in (minY, maxY]. This is what makes a
 * step riser detectable as "there is a walkable tread within step height".
 */
export function footprintTop(center, offsets, minY, maxY, colliders) {
  let best = null;
  for (const off of offsets) {
    const hit = rayDown(center.x + off.x, center.z + off.z, maxY, minY, colliders);
    if (!hit) continue;
    const walkable = hit.normal.y >= 0.5;
    if (!walkable) continue;
    const candidate = { ...hit, offset: off, center: off.x === 0 && off.z === 0 };
    if (!best || hit.point.y > best.point.y) best = candidate;
  }
  return best;
}

export function ringOffsets(radius, count = 8, scale = 0.98) {
  const out = [{ x: 0, z: 0 }];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    out.push({ x: Math.cos(a) * radius * scale, z: Math.sin(a) * radius * scale });
  }
  return out;
}

export function frontOffsets(radius, count = 8, scale = 0.98) {
  return ringOffsets(radius, count, scale).slice(1);
}
