// Track elevation (§5.5): a base profile from waypoint z values or smoothed
// terrain, junction pins, grade clamping, and classification of each stretch
// as ground, bridge or tunnel. Runs per track, parents first.

import type { TrackGeom } from "./trackGraph";
import type { WaypointSpec } from "./schema";
import { pointAt } from "./geometry";
import { waypoint } from "./schema";
import { mod } from "../util/vec";

/** Anything with a path and waypoints: a track or a road. */
export type Profiled = Pick<TrackGeom, "path" | "waypointS"> & { spec: { id: string; points: WaypointSpec[]; maxGrade: number } };

export const PROFILE_STEP = 5;          // m between profile samples
const SMOOTH_WINDOW = 120;              // m, moving average of terrain for the base profile
const BRIDGE_CLEARANCE = 5;             // track this far above ground becomes a bridge
const TUNNEL_COVER = 7;                 // ground this far above track becomes a tunnel
const MIN_SPAN = 20;                    // shorter structure runs merge into neighbours
/**
 * m into a tunnel from each portal where the ground is still cut down to the track,
 * so the hillside cannot slope across the mouth: the terrain grid needs a cell's
 * diagonal to climb back up, and the portal's box hides that climb.
 */
export const MOUTH = 8;

export type Profile = { step: number; z: Float64Array; length: number; closed: boolean };
export type StructureKind = "ground" | "bridge" | "tunnel";
export type Span = { kind: StructureKind; s0: number; s1: number };
export type Pin = { s: number; z: number };
export type GradeIssue = { s0: number; s1: number; grade: number; message: string };

const sampleCount = (L: number, closed: boolean) => Math.max(2, Math.ceil(L / PROFILE_STEP) + (closed ? 0 : 1));

/** s of profile sample i. */
export function profileS(p: Profile, i: number): number {
  const n = p.z.length;
  return p.closed ? (i * p.length) / n : (i * p.length) / (n - 1);
}

/** Track height at s, linearly interpolated (wrapping on loops). */
export function profileZ(p: Profile, s: number): number {
  const n = p.z.length;
  const segs = p.closed ? n : n - 1;
  const x = p.closed ? (mod(s, p.length) / p.length) * segs : (Math.min(Math.max(s, 0), p.length) / p.length) * segs;
  const i = Math.min(Math.floor(x), segs - 1);
  const f = x - i;
  return p.z[i] * (1 - f) + p.z[(i + 1) % n] * f;
}

/**
 * Builds the height profile of one track (or road). `ground` is the unmodified
 * terrain; `pins` are junction heights taken from parent tracks (hard constraints).
 */
export function buildProfile(
  t: Profiled, ground: (x: number, y: number) => number, pins: Pin[],
  opts: { window?: number; noun?: string; follow?: boolean; floor?: (x: number, y: number) => number } = {},
): { profile: Profile; issues: GradeIssue[] } {
  const { path, spec } = t;
  const L = path.length;
  const closed = path.closed;
  const n = sampleCount(L, closed);
  const p: Profile = { step: L / (closed ? n : n - 1), z: new Float64Array(n), length: L, closed };

  // 1–2. Base profile: interpolate explicit waypoint z, or smooth the terrain.
  const fixed: Pin[] = spec.points
    .map((w, i) => ({ s: t.waypointS[i], z: waypoint(w).z }))
    .filter((c): c is Pin => c.z !== undefined)
    .sort((a, b) => a.s - b.s);
  // Tracks with explicit z interpolate between them; roads (`follow`) keep to the
  // smoothed ground and treat explicit z as pins like any other.
  if (fixed.length > 0 && !opts.follow) {
    // Junction pins are known heights too, so they join the interpolation anchors.
    const anchors = [...fixed, ...pins].sort((a, b) => a.s - b.s);
    for (let i = 0; i < n; i++) p.z[i] = interpolate(anchors, profileS(p, i), L, closed);
  } else {
    const raw = Array.from({ length: n }, (_, i) => {
      const [x, y] = pointAt(path, profileS(p, i));
      return ground(x, y);
    });
    const half = Math.max(1, Math.round((opts.window ?? SMOOTH_WINDOW) / 2 / p.step));
    for (let i = 0; i < n; i++) {
      let sum = 0;
      let cnt = 0;
      for (let k = -half; k <= half; k++) {
        const j = closed ? mod(i + k, n) : i + k;
        if (j < 0 || j >= n) continue;
        sum += raw[j];
        cnt++;
      }
      p.z[i] = sum / cnt;
    }
  }

  // 3. Hard constraints: junction pins and explicit waypoint z, snapped to samples.
  const hard = new Map<number, number>();
  for (const c of [...fixed, ...pins]) hard.set(nearestSample(p, c.s), c.z);
  for (const [i, z] of hard) p.z[i] = z;

  // 4. Grade clamp. First check that consecutive hard constraints are reachable at all.
  const issues: GradeIssue[] = [];
  const g = spec.maxGrade * p.step;
  const idx = [...hard.keys()].sort((a, b) => a - b);
  const pairs: Array<[number, number]> = idx.slice(1).map((b, k) => [idx[k], b]);
  if (closed && idx.length > 1) pairs.push([idx[idx.length - 1], idx[0] + n]);
  for (const [a, b] of pairs) {
    const ds = (b - a) * p.step;
    const dz = Math.abs(p.z[b % n] - p.z[a]);
    const grade = dz / ds;
    if (grade > spec.maxGrade + 1e-9) {
      const s0 = a * p.step;
      const s1 = Math.min(b * p.step, L);
      issues.push({
        s0, s1, grade,
        message: `${opts.noun ?? "track"} '${spec.id}' must change height by ${dz.toFixed(1)} m between s=${s0.toFixed(0)} and s=${s1.toFixed(0)} (${(grade * 100).toFixed(1)}%), above its maxGrade ${(spec.maxGrade * 100).toFixed(1)}%; make that stretch at least ${(dz / spec.maxGrade).toFixed(0)} m long, change the z target, or raise maxGrade`,
      });
    }
  }
  // Forward then backward pass; loops go round twice so the wrap-around settles.
  const laps = closed ? 2 * n : n;
  for (let k = 1; k < laps; k++) {
    const i = k % n;
    if (!hard.has(i)) p.z[i] = clampTo(p.z[i], p.z[(k - 1) % n], g);
  }
  for (let k = laps - 2; k >= 0; k--) {
    const i = k % n;
    if (!hard.has(i)) p.z[i] = clampTo(p.z[i], p.z[(k + 1) % n], g);
  }
  // 5. A floor (bridges keeping above water): lift what is below it, then ease the climbs
  // to and from it within the grade, only ever raising.
  if (opts.floor) {
    let lifted = false;
    for (let i = 0; i < n; i++) {
      if (hard.has(i)) continue;
      const [x, y] = pointAt(path, profileS(p, i));
      const f = opts.floor(x, y);
      if (p.z[i] < f) { p.z[i] = f; lifted = true; }
    }
    if (lifted) {
      for (let k = 1; k < laps; k++) {
        const i = k % n;
        if (!hard.has(i)) p.z[i] = Math.max(p.z[i], p.z[(k - 1) % n] - g);
      }
      for (let k = laps - 2; k >= 0; k--) {
        const i = k % n;
        if (!hard.has(i)) p.z[i] = Math.max(p.z[i], p.z[(k + 1) % n] - g);
      }
    }
  }
  return { profile: p, issues };
}

const clampTo = (z: number, ref: number, g: number) => Math.min(Math.max(z, ref - g), ref + g);

function nearestSample(p: Profile, s: number): number {
  const n = p.z.length;
  const i = Math.round(s / p.step);
  return p.closed ? mod(i, n) : Math.min(Math.max(i, 0), n - 1);
}

function interpolate(fixed: Pin[], s: number, L: number, closed: boolean): number {
  const first = fixed[0];
  const last = fixed[fixed.length - 1];
  if (fixed.length === 1) return first.z;
  if (s <= first.s || s >= last.s) {
    if (!closed) return s <= first.s ? first.z : last.z;
    // Loops interpolate across the seam between the last and first waypoint.
    const span = first.s + L - last.s;
    const u = s >= last.s ? s - last.s : s + L - last.s;
    return last.z + ((first.z - last.z) * u) / span;
  }
  let k = 0;
  while (fixed[k + 1].s < s) k++;
  const a = fixed[k];
  const b = fixed[k + 1];
  return b.s > a.s ? a.z + ((b.z - a.z) * (s - a.s)) / (b.s - a.s) : a.z;
}

/**
 * 5. Classify the track against the unmodified ground into ground/bridge/tunnel spans.
 * Over water (`water` gives its surface there, or null) it is always a bridge — or a
 * tunnel well below the bed — however short the crossing.
 */
export function classify(t: Profiled, p: Profile, ground: (x: number, y: number) => number, water?: (x: number, y: number) => number | null): Span[] {
  const n = p.z.length;
  const spans: Array<Span & { forced: boolean }> = [];
  for (let i = 0; i < n; i++) {
    const s = profileS(p, i);
    const [x, y] = pointAt(t.path, s);
    const gap = p.z[i] - ground(x, y);
    const surface = water ? water(x, y) : null;
    const forced = surface !== null;
    const kind: StructureKind = forced ? (gap < -TUNNEL_COVER ? "tunnel" : "bridge")
      : gap > BRIDGE_CLEARANCE ? "bridge" : gap < -TUNNEL_COVER ? "tunnel" : "ground";
    const s0 = Math.max(0, s - p.step / 2);
    const s1 = Math.min(p.length, s + p.step / 2);
    const last = spans[spans.length - 1];
    if (last && last.kind === kind) { last.s1 = s1; last.forced ||= forced; }
    else spans.push({ kind, s0, s1, forced });
  }
  // Merge short runs into their longer neighbour so structures don't flicker (but never a water crossing).
  for (;;) {
    let shortest = -1;
    for (let i = 0; i < spans.length; i++) {
      const len = spans[i].s1 - spans[i].s0;
      if (spans.length > 1 && !spans[i].forced && len < MIN_SPAN && (shortest < 0 || len < spans[shortest].s1 - spans[shortest].s0)) shortest = i;
    }
    if (shortest < 0) break;
    const prev = spans[shortest - 1];
    const next = spans[shortest + 1];
    const into = !prev ? next : !next ? prev : prev.s1 - prev.s0 >= next.s1 - next.s0 ? prev : next;
    spans[shortest].kind = into.kind;
    for (let i = spans.length - 1; i > 0; i--) {
      if (spans[i].kind === spans[i - 1].kind) {
        spans[i - 1].s1 = spans[i].s1;
        spans[i - 1].forced ||= spans[i].forced;
        spans.splice(i, 1);
      }
    }
  }
  return spans.map(({ kind, s0, s1 }) => ({ kind, s0, s1 }));
}

export function structureAt(spans: Span[], s: number): StructureKind {
  for (const sp of spans) if (s >= sp.s0 && s <= sp.s1) return sp.kind;
  return "ground";
}

/**
 * Each portal: where a tunnel meets open ground, and which way along s leads into the
 * hill. A loop's tunnel may run through s = 0; an open path that starts in a tunnel
 * has a portal at its start.
 */
export function tunnelMouths(spans: Span[], closed: boolean): Array<{ s: number; into: 1 | -1 }> {
  const out: Array<{ s: number; into: 1 | -1 }> = [];
  spans.forEach((sp, k) => {
    if (sp.kind !== "tunnel") return;
    const prev = spans[k - 1] ?? (closed ? spans[spans.length - 1] : undefined);
    const next = spans[k + 1] ?? (closed ? spans[0] : undefined);
    if (!prev || prev.kind !== "tunnel") out.push({ s: sp.s0, into: 1 });
    if (next && next.kind !== "tunnel") out.push({ s: sp.s1, into: -1 });
  });
  return out;
}

/** Whether the ground is shaped to a track or road at s: on plain ground, and just inside each tunnel mouth. */
export function opensGround(spans: Span[], closed: boolean, s: number): boolean {
  const kind = structureAt(spans, s);
  if (kind !== "tunnel") return kind === "ground";
  return tunnelMouths(spans, closed).some((m) => (s - m.s) * m.into >= 0 && (s - m.s) * m.into <= MOUTH);
}
