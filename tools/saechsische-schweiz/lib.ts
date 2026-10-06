// Helpers for the Sächsische Schweiz layout generator.
export type V2 = [number, number];
export type WP = { at: V2; z?: number; radius?: number };

export const W = 3000;
export const H = 2200;

export const add = (a: V2, b: V2): V2 => [a[0] + b[0], a[1] + b[1]];
export const sub = (a: V2, b: V2): V2 => [a[0] - b[0], a[1] - b[1]];
export const mul = (a: V2, k: number): V2 => [a[0] * k, a[1] * k];
export const len = (a: V2) => Math.hypot(a[0], a[1]);
export const norm = (a: V2): V2 => { const l = len(a) || 1; return [a[0] / l, a[1] / l]; };
export const left = (a: V2): V2 => [-a[1], a[0]];
export const dist = (a: V2, b: V2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const lerp2 = (a: V2, b: V2, t: number): V2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
export const r1 = (x: number) => Math.round(x * 10) / 10;
export const p1 = (p: V2): V2 => [r1(p[0]), r1(p[1])];

const onEdge = (p: V2) => p[0] <= 0.01 || p[1] <= 0.01 || p[0] >= W - 0.01 || p[1] >= H - 0.01;

/** Slides an end point along its segment's direction until it lies on the board edge it was on. */
function toEdge(p: V2, dir: V2, orig: V2): V2 {
  for (const [axis, val] of [[0, 0], [0, W], [1, 0], [1, H]] as const) {
    if (Math.abs(orig[axis] - val) < 0.01 && Math.abs(dir[axis]) > 1e-6) {
      const t = (val - p[axis]) / dir[axis];
      return [p[0] + dir[0] * t, p[1] + dir[1] * t];
    }
  }
  return p;
}

/**
 * A waypoint polyline offset `d` metres to the left of its travel direction, corners
 * moved along their bisectors and radii adjusted, so filleted tracks stay parallel.
 * End points on the board edge stay on it.
 */
export function offsetWps(wps: WP[], d: number, defRadius: number): WP[] {
  const n = wps.length;
  return wps.map((w, i) => {
    const P = w.at;
    let q: V2;
    let radius = w.radius;
    if (i === 0 || i === n - 1) {
      const seg = i === 0 ? sub(wps[1].at, P) : sub(P, wps[n - 2].at);
      const nrm = left(norm(seg));
      q = add(P, mul(nrm, d));
      if (onEdge(P)) q = toEdge(q, norm(seg), P);
    } else {
      const s1 = norm(sub(P, wps[i - 1].at));
      const s2 = norm(sub(wps[i + 1].at, P));
      const n1 = left(s1);
      const n2 = left(s2);
      const m = norm(add(n1, n2));
      const k = d / Math.max(0.2, m[0] * n1[0] + m[1] * n1[1]);
      q = add(P, mul(m, k));
      const turn = s1[0] * s2[1] - s1[1] * s2[0];
      const r = w.radius ?? defRadius;
      if (Math.abs(turn) > 1e-6) radius = r - d * Math.sign(turn);
    }
    const out: WP = { at: p1(q) };
    if (w.z !== undefined) out.z = w.z;
    if (radius !== undefined) out.radius = r1(radius);
    return out;
  });
}

export const wpJson = (w: WP) => (w.z === undefined && w.radius === undefined ? w.at : { at: w.at, ...(w.z !== undefined ? { z: w.z } : {}), ...(w.radius !== undefined ? { radius: w.radius } : {}) });

/** Chaikin smoothing (open: keeps the ends). */
export function chaikin(pts: V2[], closed = false, rounds = 3): V2[] {
  let p = pts;
  for (let r = 0; r < rounds; r++) {
    const out: V2[] = closed ? [] : [p[0]];
    const n = p.length;
    for (let i = 0; i < (closed ? n : n - 1); i++) {
      const a = p[i];
      const b = p[(i + 1) % n];
      if (closed || i > 0) out.push(lerp2(a, b, 0.25));
      if (closed || i < n - 2) out.push(lerp2(a, b, 0.75));
    }
    if (!closed) out.push(p[n - 1]);
    p = out;
  }
  return p;
}

/** Points every `step` m along a polyline, with headings. */
export function resample(pts: V2[], step: number): Array<{ p: V2; h: number; s: number }> {
  const out: Array<{ p: V2; h: number; s: number }> = [];
  let acc = 0;
  let carry = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const L = dist(a, b);
    const h = Math.atan2(b[1] - a[1], b[0] - a[0]);
    let t = carry;
    while (t <= L) {
      out.push({ p: lerp2(a, b, t / L), h, s: acc + t });
      t += step;
    }
    carry = t - L;
    acc += L;
  }
  return out;
}

/** Deterministic random numbers. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function insidePoly(poly: V2[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** A rough circle-ish polygon around c. */
export function blob(c: V2, rx: number, ry = rx, n = 10, seed = 1, jitter = 0.18, rot = 0): V2[] {
  const r = rng(seed);
  return Array.from({ length: n }, (_, k) => {
    const a = (k / n) * Math.PI * 2;
    const f = 1 + (r() - 0.5) * 2 * jitter;
    const x = Math.cos(a) * rx * f, y = Math.sin(a) * ry * f;
    return p1([c[0] + x * Math.cos(rot) - y * Math.sin(rot), c[1] + x * Math.sin(rot) + y * Math.cos(rot)]);
  });
}

/** A control polygon Chaikin-smoothed and resampled every `step` m (ends kept). */
export function smoothCurve(ctrl: V2[], step = 25, rounds = 4): V2[] {
  const curve = chaikin(ctrl, false, rounds);
  const dense = resample(curve, step).map((x) => x.p);
  const last = curve[curve.length - 1];
  if (dist(dense[dense.length - 1], last) > step * 0.3) dense.push(last);
  else dense[dense.length - 1] = last;
  return dense;
}

/** A dense polyline offset to its left (per-point normals; the offset may vary by point); ends on the board's edge stay on it. */
export function offsetCurve(pts: V2[], dd: number | ((p: V2, i: number) => number)): V2[] {
  const n = pts.length;
  return pts.map((p, i) => {
    const d = typeof dd === "number" ? dd : dd(p, i);
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(n - 1, i + 1)];
    const dir = norm(sub(b, a));
    let q = add(p, mul(left(dir), d));
    if ((i === 0 || i === n - 1) && onEdge(p)) q = toEdge(q, dir, p);
    return q;
  });
}

/**
 * Waypoints for a dense polyline: each interior point a corner with the largest radius
 * its legs allow (so the fillets reproduce the curve), straights where the turn is
 * negligible. `zAt(s, p)` (if given) pins heights every `zEvery` points.
 */
export function fitWps(dense: V2[], opts: { zAt?: (s: number, p: V2) => number; zEvery?: number } = {}): WP[] {
  const pts = dense.map(p1);
  const s: number[] = [0];
  for (let i = 1; i < pts.length; i++) s.push(s[i - 1] + dist(pts[i - 1], pts[i]));
  const every = opts.zEvery ?? 6;
  return pts.map((p, i) => {
    const w: WP = { at: p };
    if (i > 0 && i < pts.length - 1) {
      const a = norm(sub(p, pts[i - 1]));
      const b = norm(sub(pts[i + 1], p));
      const turn = Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1])));
      const leg = Math.min(dist(p, pts[i - 1]), dist(p, pts[i + 1]));
      w.radius = turn > 1e-4 ? r1(Math.min(50000, (leg / 2 / Math.tan(turn / 2)) * 0.96)) : 50000;
    }
    if (opts.zAt && (i === 0 || i === pts.length - 1 || i % every === 0)) w.z = r1(opts.zAt(s[i], p));
    return w;
  });
}

/** smoothCurve + fitWps. */
export function smoothWps(ctrl: V2[], opts: { step?: number; rounds?: number; zAt?: (s: number, p: V2) => number; zEvery?: number } = {}): WP[] {
  return fitWps(smoothCurve(ctrl, opts.step, opts.rounds), opts);
}

/** Linear interpolation over [x, value] pairs. */
export function piecewise(pairs: Array<[number, number]>, x: number): number {
  if (x <= pairs[0][0]) return pairs[0][1];
  for (let i = 0; i + 1 < pairs.length; i++) {
    const [x0, v0] = pairs[i], [x1, v1] = pairs[i + 1];
    if (x <= x1) return v0 + ((v1 - v0) * (x - x0)) / (x1 - x0);
  }
  return pairs[pairs.length - 1][1];
}

export const minRadius = (wps: WP[]) => Math.min(...wps.map((w) => w.radius ?? Infinity));

export const smoothstep = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

import { filletPolyline, makePath, pointAt as pathPoint } from "../../src/model/geometry";

/** Vertices [x, y, radius?] filleted exactly as the engine does, sampled every `step` m. */
export function filletCurve(vs: Array<[number, number, number?]>, step = 25, defR = 300): V2[] {
  const f = filletPolyline(vs.map((v) => [v[0], v[1]] as V2), vs.map((v) => v[2] ?? defR), false);
  if (f.issues.length) throw new Error(f.issues.map((i) => i.message).join("; "));
  const path = makePath(f.segments, false);
  const n = Math.max(1, Math.round(path.length / step));
  return Array.from({ length: n + 1 }, (_, i) => pathPoint(path, (i * path.length) / n) as V2);
}

/**
 * A stream's course through control points: smoothed, then swung from side to side
 * (amplitude `amp` m, wavelength about `wave` m, irregular), held still near both ends.
 */
export function meander(ctrl: V2[], amp: number, wave: number, seed: number, step = 12): V2[] {
  const dense = smoothCurve(ctrl, step, 3);
  const r = rng(seed);
  const phase = r() * Math.PI * 2;
  const s: number[] = [0];
  for (let i = 1; i < dense.length; i++) s.push(s[i - 1] + dist(dense[i - 1], dense[i]));
  const L = s[s.length - 1];
  const k1 = (2 * Math.PI) / wave, k2 = (2 * Math.PI) / (wave * 0.43);
  const off = offsetCurve(dense, (_, i) => {
    const taper = smoothstep(0, wave * 0.5, s[i]) * smoothstep(0, wave * 0.5, L - s[i]);
    return amp * taper * (Math.sin(k1 * s[i] + phase) * 0.8 + Math.sin(k2 * s[i] + phase * 1.7) * 0.25);
  });
  return off.map((p) => p1([Math.min(W, Math.max(0, p[0])), Math.min(H, Math.max(0, p[1]))]));
}
