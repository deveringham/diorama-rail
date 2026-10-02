// Small 2D vector helpers on plain [x, y] tuples, plus scalar utilities.
// Used by model geometry; three.js vectors never appear outside scene/.

export type V2 = [number, number];

export const add = (a: V2, b: V2): V2 => [a[0] + b[0], a[1] + b[1]];
export const sub = (a: V2, b: V2): V2 => [a[0] - b[0], a[1] - b[1]];
export const scale = (a: V2, k: number): V2 => [a[0] * k, a[1] * k];
export const dot = (a: V2, b: V2): number => a[0] * b[0] + a[1] * b[1];
/** z-component of the 3D cross product; > 0 means b is counter-clockwise of a. */
export const cross = (a: V2, b: V2): number => a[0] * b[1] - a[1] * b[0];
export const len = (a: V2): number => Math.hypot(a[0], a[1]);
export const dist = (a: V2, b: V2): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const norm = (a: V2): V2 => {
  const l = len(a);
  return l > 0 ? [a[0] / l, a[1] / l] : [0, 0];
};
/** Rotate 90° counter-clockwise (the "left" normal of a direction). */
export const perp = (a: V2): V2 => [-a[1], a[0]];
export const fromAngle = (a: number): V2 => [Math.cos(a), Math.sin(a)];
export const angleOf = (a: V2): number => Math.atan2(a[1], a[0]);

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
export const smoothstep = (a: number, b: number, x: number): number => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
/** Positive modulo: mod(-1, 5) === 4. */
export const mod = (x: number, m: number): number => ((x % m) + m) % m;
/** Wrap an angle to (-π, π]. */
export const wrapAngle = (a: number): number => {
  const w = mod(a + Math.PI, 2 * Math.PI) - Math.PI;
  return w === -Math.PI ? Math.PI : w;
};
export const round = (x: number, digits = 1): number => {
  const k = 10 ** digits;
  return Math.round(x * k) / k;
};
