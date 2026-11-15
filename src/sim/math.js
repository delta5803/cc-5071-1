export const EPS = 1e-9;

export function vec3(x = 0, y = 0, z = 0) {
  return { x, y, z };
}

export function add(a, b) {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function sub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function scale(a, s) {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

export function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function lengthSq(a) {
  return a.x * a.x + a.y * a.y + a.z * a.z;
}

export function length(a) {
  return Math.sqrt(lengthSq(a));
}

export function normalize(a) {
  const l = length(a);
  return l > EPS ? scale(a, 1 / l) : vec3();
}

export function lerp(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function rad(deg) {
  return (deg * Math.PI) / 180;
}

export function deg(r) {
  return (r * 180) / Math.PI;
}

/**
 * Row-major local->world rotation for a box.
 * yaw rotates about +Y, pitch rotates about +X (R = Ry * Rx).
 * With yaw=0 and pitch>0, the box's up vector leans toward +Z, which makes a
 * ramp that rises toward -Z.
 */
export function boxRotation(yaw = 0, pitch = 0) {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  return [
    cy, sy * sp, sy * cp,
    0, cp, -sp,
    -sy, cy * sp, cy * cp,
  ];
}

export function rotForward(m, v) {
  return {
    x: m[0] * v.x + m[1] * v.y + m[2] * v.z,
    y: m[3] * v.x + m[4] * v.y + m[5] * v.z,
    z: m[6] * v.x + m[7] * v.y + m[8] * v.z,
  };
}

export function rotInverse(m, v) {
  return {
    x: m[0] * v.x + m[3] * v.y + m[6] * v.z,
    y: m[1] * v.x + m[4] * v.y + m[7] * v.z,
    z: m[2] * v.x + m[5] * v.y + m[8] * v.z,
  };
}

export function clampPointToBox(p, half) {
  return {
    x: clamp(p.x, -half.x, half.x),
    y: clamp(p.y, -half.y, half.y),
    z: clamp(p.z, -half.z, half.z),
  };
}
