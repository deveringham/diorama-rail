// Water (rivers, streams, lakes and ponds): smoothed courses and shores, surface
// heights (a river's falls from its first point to its last), carving into the
// terrain — a bed under the water, a sloping bank beyond its edge — and the queries
// the rest of the model needs: is a point over water, and how high is the surface?
// Tracks, roads and paths over water become bridges (heights.ts); scatter keeps off it.

import type { Layout, WaterSpec, WaterPointSpec } from "./schema";
import type { Terrain } from "./terrain";
import { type Issue, error, warning } from "./validate";
import { type V2, lerp, smoothstep } from "../util/vec";
import { type Box2, bboxOf, insidePolygon, segmentDistance, polylineDistance } from "../util/polygon";
import { SpatialHash } from "../util/spatial";

const SMOOTHING = 4;            // Chaikin corner-cutting rounds for courses and shores
const STEP = 2;                 // m between points of the dense line
const BANK_RISE = 0.3;          // m the ground at the water's edge stands above the surface
const EDGE_BED = 0.25;          // m the bed lies below the surface right at the edge
const RIVER_SMOOTH = 80;        // m terrain smoothing window for a river's surface
const BOARD_SNAP = 1;           // m: a point this close to the board's edge lies on it
const SHORE_STRIP = 5;          // m beyond the edge drawn as shore (gravel by a river, mud and reeds by a lake)
const SHORE_RISE = 1.2;         // m above the bank top the shore colour stops

export type WaterKind = WaterSpec["kind"];

export type WaterBody = {
  id: string;
  index: number;
  kind: WaterKind;
  name: string;
  closed: boolean;              // a lake or pond: `line` is its shore
  line: V2[];                   // the smoothed course (river, stream) or shore, every ~2 m
  s: number[];                  // distance along `line`
  half: Float64Array;           // half-width at each point (0 for a shore)
  surface: Float64Array;        // water surface height at each point (a lake's level throughout)
  depth: number;
  bank: number;
  clearance: number;            // how high bridges keep above the surface
  box: Box2;                    // the water and its banks
};

export type WaterHit = { body: number; surface: number; edge: number };   // edge: m inside the water's edge (negative: outside)

export type WaterNet = {
  bodies: WaterBody[];
  /** The water at (x, y), or within `margin` m of its edge; null over dry land. */
  at(x: number, y: number, margin?: number): WaterHit | null;
};

const DEFAULTS: Record<WaterKind, { width: number; depth: number; bank: number; clearance: number }> = {
  river: { width: 40, depth: 3, bank: 14, clearance: 5 },
  stream: { width: 5, depth: 0.8, bank: 5, clearance: 1.2 },
  lake: { width: 0, depth: 5, bank: 10, clearance: 2 },
  pond: { width: 0, depth: 1.5, bank: 5, clearance: 1 },
};
const INCISE: Record<WaterKind, number> = { river: 1.5, stream: 0.8, lake: 0.3, pond: 0.3 };

export const emptyWaterNet = (): WaterNet => ({ bodies: [], at: () => null });

const point = (w: WaterPointSpec) => (Array.isArray(w) ? { at: w } : w) as { at: V2; z?: number; width?: number };
const titleCase = (id: string) => id.split("-").map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");

/**
 * Builds every body of water from the layout and carves them into the terrain's base
 * (and shaped) heights. Runs right after the terrain, before anything is laid on it.
 */
export function buildWater(layout: Layout, t: Terrain): { net: WaterNet; issues: Issue[] } {
  const issues: Issue[] = [];
  const [W, H] = layout.terrain.size;
  const bodies: WaterBody[] = [];
  layout.water.forEach((spec, index) => {
    const pts = spec.points.map(point);
    const out = pts.findIndex((p) => p.at[0] < -BOARD_SNAP || p.at[1] < -BOARD_SNAP || p.at[0] > W + BOARD_SNAP || p.at[1] > H + BOARD_SNAP);
    if (out >= 0) {
      issues.push(error("OUT_OF_BOUNDS", `${spec.kind} '${spec.id}' point (${pts[out].at.join(", ")}) is outside the terrain [0,0]–[${W},${H}]; a river may end on the board's edge, not beyond it`, `water[${index}].points[${out}]`, pts[out].at));
      return;
    }
    bodies.push(spec.kind === "lake" || spec.kind === "pond" ? lake(spec, index, pts, t) : river(spec, index, pts, t, issues));
  });
  carve(t, bodies);
  return { net: waterNet(bodies), issues };
}

/** Chaikin corner cutting: a smooth curve inside the polyline, through its end points if open. */
export function chaikin(pts: V2[], closed: boolean, rounds = SMOOTHING): V2[] {
  let p = pts;
  for (let r = 0; r < rounds; r++) {
    const out: V2[] = closed ? [] : [p[0]];
    const n = p.length;
    for (let i = 0; i < (closed ? n : n - 1); i++) {
      const a = p[i];
      const b = p[(i + 1) % n];
      const q: V2 = [0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]];
      const s: V2 = [0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]];
      if (closed || i > 0) out.push(q);
      if (closed || i < n - 2) out.push(s);
    }
    if (!closed) out.push(p[n - 1]);
    p = out;
  }
  return p;
}

/** Points every ~STEP m along a polyline (closing the ring if `closed`), with distances along it. */
function densify(pts: V2[], closed: boolean): { line: V2[]; s: number[] } {
  const line: V2[] = [];
  const s: number[] = [];
  let acc = 0;
  const n = pts.length;
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const k = Math.max(1, Math.ceil(L / STEP));
    for (let j = 0; j < k; j++) {
      line.push([a[0] + ((b[0] - a[0]) * j) / k, a[1] + ((b[1] - a[1]) * j) / k]);
      s.push(acc + (L * j) / k);
    }
    acc += L;
  }
  if (!closed) {
    line.push(pts[n - 1]);
    s.push(acc);
  }
  return { line, s };
}

/** For each waypoint, the distance along the smoothed line of its nearest point (in order). */
function waypointS(pts: Array<{ at: V2 }>, line: V2[], s: number[]): number[] {
  let from = 0;
  return pts.map((p, k) => {
    if (k === 0) return 0;
    if (k === pts.length - 1) return s[s.length - 1];
    let best = from;
    let bd = Infinity;
    for (let i = from; i < line.length; i++) {
      const d = Math.hypot(line[i][0] - p.at[0], line[i][1] - p.at[1]);
      if (d < bd) { bd = d; best = i; }
    }
    from = best;
    return s[best];
  });
}

/** Linear interpolation by s between the anchors given; held beyond the first and last. */
function interpolate(anchors: Array<{ s: number; v: number }>, s: number): number {
  if (s <= anchors[0].s) return anchors[0].v;
  const last = anchors[anchors.length - 1];
  if (s >= last.s) return last.v;
  let k = 0;
  while (anchors[k + 1].s < s) k++;
  const a = anchors[k];
  const b = anchors[k + 1];
  return b.s > a.s ? a.v + ((b.v - a.v) * (s - a.s)) / (b.s - a.s) : a.v;
}

function river(spec: WaterSpec, index: number, pts: Array<{ at: V2; z?: number; width?: number }>, t: Terrain, issues: Issue[]): WaterBody {
  const d = DEFAULTS[spec.kind];
  const { line, s } = densify(chaikin(pts.map((p) => p.at), false), false);
  const ws = waypointS(pts, line, s);
  const widths = pts.map((p, k) => ({ s: ws[k], v: p.width ?? NaN })).filter((a) => !Number.isNaN(a.v));
  const width = spec.width ?? d.width;
  const half = Float64Array.from(s, (x) => (widths.length ? interpolate(widths, x) : width) / 2);
  const fixed = pts.map((p, k) => ({ s: ws[k], v: p.z ?? NaN })).filter((a) => !Number.isNaN(a.v));
  let surface: Float64Array;
  if (fixed.length) {
    surface = Float64Array.from(s, (x) => interpolate(fixed, x));
    for (let k = 1; k < fixed.length; k++) {
      if (fixed[k].v > fixed[k - 1].v + 1e-6) {
        issues.push(warning("WATER_FLOW", `${spec.kind} '${spec.id}' rises from ${fixed[k - 1].v} m to ${fixed[k].v} m along its course; water flows from its first point to its last, so heights should fall (or stay level) along it`, `water[${index}].points`));
        break;
      }
    }
  } else {
    // Follow the valley floor a little below the smoothed ground, never flowing uphill.
    const raw = line.map(([x, y]) => groundAt(t, x, y));
    const halfWin = Math.max(1, Math.round(RIVER_SMOOTH / 2 / STEP));
    surface = Float64Array.from(raw, (_, i) => {
      let sum = 0;
      let n = 0;
      for (let k = Math.max(0, i - halfWin); k <= Math.min(raw.length - 1, i + halfWin); k++) { sum += raw[k]; n++; }
      return sum / n - INCISE[spec.kind];
    });
    for (let i = 1; i < surface.length; i++) surface[i] = Math.min(surface[i], surface[i - 1]);
  }
  const bank = spec.bank ?? d.bank;
  let maxHalf = 0;
  for (const h of half) maxHalf = Math.max(maxHalf, h);
  return {
    id: spec.id, index, kind: spec.kind, name: spec.name ?? titleCase(spec.id), closed: false, line, s, half, surface,
    depth: spec.depth ?? d.depth, bank, clearance: spec.clearance ?? d.clearance, box: bboxOf(line, maxHalf + bank),
  };
}

function lake(spec: WaterSpec, index: number, pts: Array<{ at: V2 }>, t: Terrain): WaterBody {
  const d = DEFAULTS[spec.kind];
  const { line, s } = densify(chaikin(pts.map((p) => p.at), true), true);
  let level = spec.level;
  if (level === undefined) {
    level = Infinity;
    for (const [x, y] of line) level = Math.min(level, groundAt(t, x, y));
    level -= INCISE[spec.kind];
  }
  const bank = spec.bank ?? d.bank;
  return {
    id: spec.id, index, kind: spec.kind, name: spec.name ?? titleCase(spec.id), closed: true, line, s,
    half: new Float64Array(line.length), surface: new Float64Array(line.length).fill(level),
    depth: spec.depth ?? d.depth, bank, clearance: spec.clearance ?? d.clearance, box: bboxOf(line, bank),
  };
}

function groundAt(t: Terrain, x: number, y: number): number {
  const i = Math.min(t.nx, Math.max(0, Math.round(x / t.cx)));
  const j = Math.min(t.ny, Math.max(0, Math.round(y / t.cy)));
  return t.base[j * (t.nx + 1) + i];
}

/**
 * Lowers the ground under every body of water to its bed (deepest in the middle) and
 * slopes it back up over the bank beyond the edge, where it stands just above the
 * surface; low ground there is raised into a low levee. Where waters meet, the
 * nearest one's bank wins and the water's bed always does.
 */
function carve(t: Terrain, bodies: WaterBody[]): void {
  if (!bodies.length) return;
  const w = t.nx + 1;
  const count = w * (t.ny + 1);
  const wet = new Float32Array(count).fill(Infinity);
  const near = new Float32Array(count).fill(Infinity);     // m outside the nearest water's edge
  const top = new Float32Array(count);                     // that water's bank top at its edge
  const reach = new Float32Array(count);                   // and its bank's width
  const range = (b: Box2) => ({
    i0: Math.max(0, Math.floor(b.x0 / t.cx)), i1: Math.min(t.nx, Math.ceil(b.x1 / t.cx)),
    j0: Math.max(0, Math.floor(b.y0 / t.cy)), j1: Math.min(t.ny, Math.ceil(b.y1 / t.cy)),
  });
  const shore = new Uint8Array(count);                     // the nearest water's kind for the shore strip: 1 river, 2 lake
  const dry = (v: number, e: number, surface: number, bank: number, lake: boolean) => {
    if (e < near[v]) { near[v] = e; top[v] = surface + BANK_RISE; reach[v] = bank; shore[v] = lake ? 2 : 1; }
  };
  for (const b of bodies) {
    if (!b.closed) {
      // Splat each point of the course into the vertices around it, keeping the nearest.
      b.line.forEach(([px, py], k) => {
        const h = b.half[k];
        const r = range({ x0: px - h - b.bank, y0: py - h - b.bank, x1: px + h + b.bank, y1: py + h + b.bank });
        for (let j = r.j0; j <= r.j1; j++) {
          for (let i = r.i0; i <= r.i1; i++) {
            const v = j * w + i;
            const d = Math.hypot(i * t.cx - px, j * t.cy - py);
            const e = d - h;
            if (e <= 0) wet[v] = Math.min(wet[v], b.surface[k] - EDGE_BED - (b.depth - EDGE_BED) * (1 - (d / h) ** 2));
            else if (e < b.bank) dry(v, e, b.surface[k], b.bank, false);
          }
        }
      });
      continue;
    }
    const level = b.surface[0];
    const shelf = Math.max(10, b.depth * 5);
    const r = range(b.box);
    const sw = r.i1 - r.i0 + 1;
    const edge = new Float32Array(sw * (r.j1 - r.j0 + 1)).fill(Infinity);
    const far = Math.max(shelf, b.bank);
    for (const [px, py] of b.line) {
      const q = range({ x0: px - far, y0: py - far, x1: px + far, y1: py + far });
      for (let j = Math.max(q.j0, r.j0); j <= Math.min(q.j1, r.j1); j++) {
        for (let i = Math.max(q.i0, r.i0); i <= Math.min(q.i1, r.i1); i++) {
          const k = (j - r.j0) * sw + (i - r.i0);
          edge[k] = Math.min(edge[k], Math.hypot(i * t.cx - px, j * t.cy - py));
        }
      }
    }
    for (let j = r.j0; j <= r.j1; j++) {
      for (let i = r.i0; i <= r.i1; i++) {
        const v = j * w + i;
        const e = edge[(j - r.j0) * sw + (i - r.i0)];
        if (insidePolygon(b.line, i * t.cx, j * t.cy)) wet[v] = Math.min(wet[v], level - EDGE_BED - (b.depth - EDGE_BED) * smoothstep(0, shelf, e));
        else if (e < b.bank) dry(v, e, level, b.bank, true);
      }
    }
  }
  const flags = new Uint8Array(count);
  for (let v = 0; v < count; v++) {
    const z = t.base[v];
    if (wet[v] < Infinity) {
      t.base[v] = Math.min(z, wet[v]);
      flags[v] = 3;
    } else if (near[v] < reach[v]) {
      t.base[v] = lerp(top[v], z, smoothstep(0, reach[v], near[v]));
      if (near[v] < SHORE_STRIP && t.base[v] < top[v] + SHORE_RISE) flags[v] = shore[v];
    }
  }
  t.shaped.set(t.base);
  t.wet = flags;
}

function waterNet(bodies: WaterBody[]): WaterNet {
  const hash = new SpatialHash<{ body: number; k: number }>(10);
  let widest = 0;
  bodies.forEach((b, bi) => {
    if (b.closed) return;
    b.line.forEach(([x, y], k) => hash.insert(x, y, { body: bi, k }));
    for (const h of b.half) widest = Math.max(widest, h);
  });
  const lakes = bodies.map((b, bi) => ({ b, bi })).filter((x) => x.b.closed);
  return {
    bodies,
    at(x, y, margin = 0) {
      let best: WaterHit | null = null;
      // Rivers: the nearest point of each course nearby, then the true distance to its segments.
      const seen = new Map<number, number>();
      hash.near(x, y, widest + margin + STEP, ({ body, k }) => {
        const p = bodies[body].line[k];
        const d = Math.hypot(p[0] - x, p[1] - y);
        const prev = seen.get(body);
        if (prev === undefined || d < Math.hypot(bodies[body].line[prev][0] - x, bodies[body].line[prev][1] - y)) seen.set(body, k);
      });
      for (const [bi, k] of seen) {
        const b = bodies[bi];
        let hit: { d: number; k: number; t: number } | null = null;
        for (const a of [k - 1, k]) {
          if (a < 0 || a + 1 >= b.line.length) continue;
          const sd = segmentDistance(b.line[a], b.line[a + 1], x, y);
          if (!hit || sd.d < hit.d) hit = { d: sd.d, k: a, t: sd.t };
        }
        if (!hit) hit = { d: Math.hypot(b.line[k][0] - x, b.line[k][1] - y), k, t: 0 };
        const k1 = Math.min(hit.k + 1, b.line.length - 1);
        const edge = lerp(b.half[hit.k], b.half[k1], hit.t) - hit.d;
        if (edge < -margin || (best && edge <= best.edge)) continue;
        best = { body: bi, surface: lerp(b.surface[hit.k], b.surface[k1], hit.t), edge };
      }
      for (const { b, bi } of lakes) {
        if (x < b.box.x0 || x > b.box.x1 || y < b.box.y0 || y > b.box.y1) continue;
        const inside = insidePolygon(b.line, x, y);
        if (!inside && margin <= 0) continue;
        const d = polylineDistance(b.line, x, y, true);
        const edge = inside ? d : -d;
        if (edge < -margin || (best && edge <= best.edge)) continue;
        best = { body: bi, surface: b.surface[0], edge };
      }
      return best;
    },
  };
}

/** m beyond the water's edge where a crossing is still a bridge: its abutments stand on the bank. */
export const CROSSING_MARGIN = 1.5;

/** For classify(): the surface under (x, y) where a track, road or path crosses water; undefined without water. */
export function crossingSurface(net: WaterNet | undefined): ((x: number, y: number) => number | null) | undefined {
  if (!net?.bodies.length) return undefined;
  return (x, y) => net.at(x, y, CROSSING_MARGIN)?.surface ?? null;
}

/** For buildProfile(): the lowest a crossing may run, its water's clearance above the surface; undefined without water. */
export function crossingFloor(net: WaterNet | undefined): ((x: number, y: number) => number) | undefined {
  if (!net?.bodies.length) return undefined;
  return (x, y) => {
    const h = net.at(x, y, CROSSING_MARGIN);
    return h ? h.surface + net.bodies[h.body].clearance : -Infinity;
  };
}

/**
 * Tracks, roads and paths crossing water lower than its clearance (only where a
 * waypoint `z` or a junction pins them down: elsewhere they rise over it by
 * themselves): one error per crossing.
 */
export function checkCrossings(net: WaterNet, lines: Array<{ noun: string; id: string; path: string; points: Array<{ x: number; y: number; z: number }> }>): Issue[] {
  const issues: Issue[] = [];
  if (!net.bodies.length) return issues;
  for (const line of lines) {
    let last = -Infinity;
    line.points.forEach((p, k) => {
      const h = net.at(p.x, p.y);
      if (!h) return;
      const b = net.bodies[h.body];
      const need = h.surface + Math.min(b.clearance, 1) - 0.05;
      if (p.z >= need || k - last < 40) return;
      last = k;
      issues.push(error("WATER_CLEARANCE", `${line.noun} '${line.id}' crosses ${b.kind} '${b.id}' only ${(p.z - h.surface).toFixed(1)} m above the water at (${p.x.toFixed(0)}, ${p.y.toFixed(0)}); a bridge there needs ${b.clearance} m: raise it with a waypoint z of about ${(h.surface + b.clearance).toFixed(1)}, or move the waypoint that pins it`, line.path, [p.x, p.y]));
    });
  }
  return issues;
}
