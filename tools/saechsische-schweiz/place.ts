// Placing scenery for the generator: an occupancy map of the built world (roads with their
// sidewalks and parking, tracks, paths, water, placed objects) and helpers that line streets
// with houses, set farmsteads, and drop single objects where they fit.
import type { V2 } from "./lib";
import { rng, r1 } from "./lib";
import { type World, pointAt, headingAt, groundZ } from "./world";

export type Entry = Record<string, unknown>;
type Box = { cx: number; cy: number; ux: V2; uy: V2; hx: number; hy: number };
type Sample = { x: number; y: number; half: number };

const CELL = 20;

/** Corners-free oriented box test helpers. */
function boxOf(w: World, id: string, x: number, y: number, rot: number, scale = 1, pad = 0): Box {
  const info = w.objects.get(id);
  if (!info) throw new Error(`unknown object ${id}`);
  const { min, max } = info.mesh;
  const ux: V2 = [Math.cos(rot), Math.sin(rot)];
  const uy: V2 = [-Math.sin(rot), Math.cos(rot)];
  const ox = ((min[0] + max[0]) / 2) * scale, oy = ((min[1] + max[1]) / 2) * scale;
  return {
    cx: x + ux[0] * ox + uy[0] * oy, cy: y + ux[1] * ox + uy[1] * oy, ux, uy,
    hx: ((max[0] - min[0]) / 2) * scale + pad, hy: ((max[1] - min[1]) / 2) * scale + pad,
  };
}

/** Signed distance from a point to a box (negative inside). */
function boxDist(b: Box, x: number, y: number): number {
  const dx = x - b.cx, dy = y - b.cy;
  const u = Math.abs(dx * b.ux[0] + dy * b.ux[1]) - b.hx;
  const v = Math.abs(dx * b.uy[0] + dy * b.uy[1]) - b.hy;
  return u > 0 && v > 0 ? Math.hypot(u, v) : Math.max(u, v);
}

function boxesOverlap(a: Box, b: Box, gap: number): boolean {
  for (const axis of [a.ux, a.uy, b.ux, b.uy]) {
    const pa = Math.abs(a.ux[0] * axis[0] + a.ux[1] * axis[1]) * a.hx + Math.abs(a.uy[0] * axis[0] + a.uy[1] * axis[1]) * a.hy;
    const pb = Math.abs(b.ux[0] * axis[0] + b.ux[1] * axis[1]) * b.hx + Math.abs(b.uy[0] * axis[0] + b.uy[1] * axis[1]) * b.hy;
    const d = Math.abs((b.cx - a.cx) * axis[0] + (b.cy - a.cy) * axis[1]);
    if (d > pa + pb + gap) return false;
  }
  return true;
}

export class Space {
  private grid = new Map<string, Sample[]>();
  private boxes: Box[] = [];
  readonly entries: Entry[] = [];
  constructor(readonly w: World, private seed = 7) {
    for (const r of w.roads.roads.values()) {
      const sp = r.spec;
      const side = (which: "left" | "right") =>
        (sp.sidewalks === "both" || sp.sidewalks === which ? sp.sidewalkWidth : 0) +
        (sp.parking === "both" || sp.parking === which ? (sp.parkingStyle === "perpendicular" ? 5.2 : 2.4) : 0);
      const half = sp.width / 2 + Math.max(side("left"), side("right")) + 0.6;
      this.addLine(r.path, half);
    }
    for (const t of w.tracks.values()) this.addLine(t.path, 3.4);
    for (const p of w.walks.paths.values()) this.addLine(p.path, p.spec.width / 2 + 0.6);
    for (const st of w.stations) {
      // Platforms and docks, and room for the station building behind them.
      const t = w.tracks.get(st.track)!;
      for (let s = st.s0; s <= st.s1; s += 3) {
        const [x, y] = pointAt(t.path, Math.max(0, Math.min(t.path.length, s)));
        this.addSample(x, y, 22);
      }
    }
  }
  private key(i: number, j: number) { return `${i},${j}`; }
  addSample(x: number, y: number, half: number) {
    const k = this.key(Math.floor(x / CELL), Math.floor(y / CELL));
    let list = this.grid.get(k);
    if (!list) this.grid.set(k, (list = []));
    list.push({ x, y, half });
  }
  addLine(path: Parameters<typeof pointAt>[0], half: number) {
    for (let s = 0; s <= path.length; s += 2) {
      const [x, y] = pointAt(path, s);
      this.addSample(x, y, half);
    }
  }
  /** Keep a polygon free (a car park, a plaza, a yard). */
  reserve(poly: V2[]) {
    const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    this.boxes.push({ cx, cy, ux: [1, 0], uy: [0, 1], hx: (Math.max(...xs) - Math.min(...xs)) / 2, hy: (Math.max(...ys) - Math.min(...ys)) / 2 });
  }
  private near(b: Box): boolean {
    const R = Math.hypot(b.hx, b.hy);
    const i0 = Math.floor((b.cx - R - 30) / CELL), i1 = Math.floor((b.cx + R + 30) / CELL);
    const j0 = Math.floor((b.cy - R - 30) / CELL), j1 = Math.floor((b.cy + R + 30) / CELL);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      for (const s of this.grid.get(this.key(i, j)) ?? []) if (boxDist(b, s.x, s.y) < s.half) return true;
    }
    return false;
  }
  /** Why an object does not fit (for debugging), or "ok". */
  why(id: string, x: number, y: number, rot: number): string {
    const b = boxOf(this.w, id, x, y, rot);
    const R = Math.hypot(b.hx, b.hy);
    const i0 = Math.floor((b.cx - R - 30) / CELL), i1 = Math.floor((b.cx + R + 30) / CELL);
    const j0 = Math.floor((b.cy - R - 30) / CELL), j1 = Math.floor((b.cy + R + 30) / CELL);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      for (const s of this.grid.get(this.key(i, j)) ?? []) if (boxDist(b, s.x, s.y) < s.half) return `line sample (${s.x.toFixed(0)},${s.y.toFixed(0)}) half ${s.half}`;
    }
    const o = this.boxes.find((o) => boxesOverlap(o, b, 1.5));
    if (o) return `object at (${o.cx.toFixed(0)},${o.cy.toFixed(0)})`;
    const corners: V2[] = [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, 0]].map(([a, c]) =>
      [b.cx + b.ux[0] * b.hx * a + b.uy[0] * b.hy * c, b.cy + b.ux[1] * b.hx * a + b.uy[1] * b.hy * c]);
    if (corners.some(([cx, cy]) => this.w.water.at(cx, cy, 1.5))) return "water";
    const zs = corners.map(([cx, cy]) => groundZ(this.w.terrain, cx, cy));
    return `drop ${(Math.max(...zs) - Math.min(...zs)).toFixed(1)}`;
  }
  /** Whether an object fits here: clear of lines, water, other objects; on ground no steeper than `maxDrop` across it. */
  fits(id: string, x: number, y: number, rot: number, opts: { scale?: number; gap?: number; maxDrop?: number; wet?: boolean } = {}): boolean {
    const W = this.w.terrain.width, H = this.w.terrain.height;
    const b = boxOf(this.w, id, x, y, rot, opts.scale ?? 1);
    const R = Math.hypot(b.hx, b.hy);
    if (b.cx - R < 2 || b.cy - R < 2 || b.cx + R > W - 2 || b.cy + R > H - 2) return false;
    if (this.near(b)) return false;
    const gap = opts.gap ?? 1.5;
    if (this.boxes.some((o) => boxesOverlap(o, b, gap))) return false;
    const corners: V2[] = [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, 0]].map(([a, c]) =>
      [b.cx + b.ux[0] * b.hx * a + b.uy[0] * b.hy * c, b.cy + b.ux[1] * b.hx * a + b.uy[1] * b.hy * c]);
    if (!opts.wet && corners.some(([cx, cy]) => this.w.water.at(cx, cy, 1.5))) return false;
    const zs = corners.map(([cx, cy]) => groundZ(this.w.terrain, cx, cy));
    if (Math.max(...zs) - Math.min(...zs) > (opts.maxDrop ?? 3.2)) return false;
    return true;
  }
  /** Places an object (no checks); rotation in radians. */
  put(id: string, x: number, y: number, rot: number, extra: Entry = {}): Entry {
    this.boxes.push(boxOf(this.w, id, x, y, rot, typeof extra.scale === "number" ? extra.scale : 1));
    const e: Entry = { object: id, at: [r1(x), r1(y)], rotation: Math.round(((rot * 180) / Math.PI) * 10) / 10, ...extra };
    this.entries.push(e);
    return e;
  }
  /** Places it if it fits. */
  tryPut(id: string, x: number, y: number, rot: number, extra: Entry = {}, opts: Parameters<Space["fits"]>[4] = {}): Entry | null {
    return this.fits(id, x, y, rot, { scale: typeof extra.scale === "number" ? extra.scale : 1, ...opts }) ? this.put(id, x, y, rot, extra) : null;
  }
  /** Tries spots around (x, y) in widening rings until one fits. */
  putNear(id: string, x: number, y: number, rot: number, extra: Entry = {}, reach = 30, opts: Parameters<Space["fits"]>[4] = {}): Entry | null {
    for (let r = 0; r <= reach; r += 3) {
      for (let k = 0; k < Math.max(1, Math.round(r / 2)); k++) {
        const a = (k / Math.max(1, Math.round(r / 2))) * Math.PI * 2;
        const e = this.tryPut(id, x + Math.cos(a) * r, y + Math.sin(a) * r, rot, extra, opts);
        if (e) return e;
      }
    }
    return null;
  }

  // --- Streets --------------------------------------------------------------------------
  /** Half the road's full cross-section on its wider side (carriageway, parking, sidewalk), plus a margin. */
  roadSide(road: string): number {
    const walk = this.w.walks.paths.get(road);
    if (walk) return walk.spec.width / 2 + 0.6;
    const sp = this.w.roads.roads.get(road)!.spec;
    const one = (which: "left" | "right") => (sp.sidewalks === "both" || sp.sidewalks === which ? sp.sidewalkWidth : 0) +
      (sp.parking === "both" || sp.parking === which ? (sp.parkingStyle === "perpendicular" ? 5.2 : 2.4) : 0);
    return sp.width / 2 + Math.max(one("left"), one("right")) + 0.6;
  }
  /** Width of an object along its y axis and depth along x, from its bounds. */
  dims(id: string): { depth: number; width: number; front: number } {
    const { min, max } = this.w.objects.get(id)!.mesh;
    return { depth: max[0] - min[0], width: max[1] - min[1], front: max[0] };
  }

  /**
   * Lines a stretch of road with buildings facing it: walks from s0 to s1 on each side,
   * picking an object, setting it back from the kerb, and moving on by its width and a gap.
   * Behind some, a second building (a barn) stands across the plot.
   */
  street(road: string, s0: number, s1: number, opts: {
    sides?: Array<1 | -1>; pick: Array<[string, number]>; gap: [number, number]; setback: [number, number];
    behind?: { chance: number; pick: Array<[string, number]>; distance: number }; seed?: number; name?: string; maxDrop?: number;
  }): Entry[] {
    const r = this.w.roads.roads.get(road) ?? this.w.walks.paths.get(road);
    if (!r) throw new Error(`no road or path ${road}`);
    const rand = rng(opts.seed ?? ++this.seed * 7919);
    const choose = (list: Array<[string, number]>) => {
      const tot = list.reduce((a, [, wgt]) => a + wgt, 0);
      let x = rand() * tot;
      for (const [id, wgt] of list) if ((x -= wgt) <= 0) return id;
      return list[list.length - 1][0];
    };
    const out: Entry[] = [];
    const lo = Math.max(0, Math.min(s0, s1)), hi = Math.min(r.path.length, Math.max(s0, s1));
    for (const side of opts.sides ?? [1, -1]) {
      let s = lo + rand() * 4;
      while (s < hi) {
        const id = choose(opts.pick);
        const { depth, width, front } = this.dims(id);
        const sc = s + width / 2;
        if (sc + width / 2 > hi) break;
        const [px, py] = pointAt(r.path, sc);
        const h = headingAt(r.path, sc);
        const nx = -Math.sin(h) * side, ny = Math.cos(h) * side;          // toward this side
        const setback = opts.setback[0] + rand() * (opts.setback[1] - opts.setback[0]);
        const lateral = this.roadSide(road) + setback + front;    // the front face `setback` m behind the kerb line
        const x = px + nx * lateral, y = py + ny * lateral;
        const rot = Math.atan2(-ny, -nx);                                // front (+x) toward the road
        const e = this.tryPut(id, x, y, rot, {}, { maxDrop: opts.maxDrop });
        if (e) {
          out.push(e);
          if (opts.behind && rand() < opts.behind.chance) {
            const bid = choose(opts.behind.pick);
            const bd = this.dims(bid);
            const back = lateral + depth / 2 + opts.behind.distance + bd.width / 2;
            if (back - this.roadSide(road) > 34) { s = sc + width / 2 + opts.gap[0]; continue; }
            const bx = px + nx * back, by = py + ny * back;
            const brot = rot + Math.PI / 2 * (rand() < 0.5 ? 1 : -1);
            const be = this.tryPut(bid, bx, by, brot, {}, { maxDrop: opts.maxDrop });
            if (be) out.push(be);
          }
          s = sc + width / 2 + opts.gap[0] + rand() * (opts.gap[1] - opts.gap[0]);
        } else s += 3;
      }
    }
    return out;
  }

  /** s along a road nearest a point. */
  roadS(road: string, p: V2): number {
    const r = this.w.roads.roads.get(road) ?? this.w.walks.paths.get(road)!;
    let best = 0, bd = Infinity;
    for (let s = 0; s <= r.path.length; s += 1) {
      const [x, y] = pointAt(r.path, s);
      const d = Math.hypot(x - p[0], y - p[1]);
      if (d < bd) { bd = d; best = s; }
    }
    return best;
  }
}
