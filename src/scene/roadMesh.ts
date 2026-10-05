// Road rendering: asphalt strips with sloping verges (one merged mesh), dashed
// centre lines, bus stop boxes and level-crossing panels (a second mesh drawn just
// above), the fixed furniture (crossing posts, St Andrew's crosses, signal housings,
// bus stop signs and shelters) and the moving parts: barrier arms and flashing lights. Each road stops
// where a junction area begins (see model/roads.ts JunctionArea), which is drawn as one surface;
// deep tunnel interiors are skipped.

import * as THREE from "three";
import type { World } from "../model/build";
import type { GateSnapshot } from "../sim/traffic";
import { pointAt, headingAt, sampleS } from "../model/geometry";
import { profileZ, structureAt } from "../model/heights";
import { CROSSING_ROAD_Z, sidewalkWidth, kerbOffset, pavedHalf, type LevelCrossing, type JunctionArea } from "../model/roads";
import { LOT_AISLE, BAY_DEPTH, lotFrame } from "../model/parking";
import { FRONT_PAST } from "../model/buses";
import { PALETTE } from "./palette";
import { GeoBuilder, flatMaterial, toThree, type P3 } from "./geo";
import { type Frame, side } from "./trackMesh";

const STEP = 2;                  // m between cross-sections
const VERGE = 1.0;               // m the verge reaches beyond the carriageway
const VERGE_DROP = 0.6;          // m it falls over that width
const KERB_DROP = 0.45;          // m a kerb face reaches down where a sidewalk runs
const TUNNEL_VISIBLE = 14;       // m of road drawn inside each tunnel mouth
const DASH = 3;                  // m centre-line dash, then the same gap
const LINE_HALF = 0.08;
const MARK_LIFT = 0.02;
const PANEL_HALF = 1.7;          // m either side of the rails covered by crossing panels
const POST_OUT = 0.9;            // m beyond the carriageway edge for crossing posts
const PIVOT = 1.0;               // m barrier pivot height
const LAMP_Z = 1.75;
const CROSS_Z = 2.45;
const ARM_UP = (85 * Math.PI) / 180;
const RAIL_GAUGE = 1.435;
const RAIL_TOP = 0.28;
const BAY_LINE = 0.06;           // m half-width of a parking bay's painted line

export function roadFrame(world: World, road: string, s: number): Frame {
  const r = world.roads.roads.get(road)!;
  const [x, y] = pointAt(r.path, s);
  return { x, y, z: profileZ(world.roads.profiles.get(road)!, s), h: headingAt(r.path, s) };
}

export function pathFrame(world: World, path: string, s: number): Frame {
  const p = world.walks.paths.get(path)!;
  const [x, y] = pointAt(p.path, s);
  return { x, y, z: profileZ(world.walks.profiles.get(path)!, s), h: headingAt(p.path, s) };
}

const inRanges = (s: number, ranges: Array<[number, number]>) => ranges.some(([a, b]) => s >= a && s <= b);

/** Static road meshes: surfaces and verges, markings, and crossing furniture. */
export function roadMeshes(world: World): THREE.Object3D[] {
  const net = world.roads;
  if (!net.roads.size) return [];
  const season = world.layout.style.season;
  const g = new GeoBuilder();
  const marks = new GeoBuilder();
  const lots = new Set(world.town.lots.map((l) => l.id));

  for (const r of net.roads.values()) {
    const L = r.path.length;
    const half = r.spec.width / 2;
    const kl = kerbOffset(r.spec, 1);                     // kerbs, beyond any parking strip
    const kr = kerbOffset(r.spec, -1);
    const spans = net.spans.get(r.id)!;
    const trims = net.trims.get(r.id)!;
    const hidden = (s: number) => spans.some((sp) => sp.kind === "tunnel" && s > sp.s0 + TUNNEL_VISIBLE && s < sp.s1 - TUNNEL_VISIBLE);
    // Cross-sections every STEP metres plus exactly at every trim and span boundary.
    const cuts = new Set(sampleS(r.path, STEP));
    if (r.path.closed) cuts.add(L);
    for (const [a, b] of trims) { cuts.add(a); cuts.add(b); }
    for (const sp of spans) { cuts.add(sp.s0); cuts.add(sp.s1); }
    const ss = [...cuts].filter((s) => s >= 0 && s <= L).sort((a, b) => a - b);
    const frames = ss.map((s) => roadFrame(world, r.id, s));
    for (let i = 0; i + 1 < ss.length; i++) {
      const mid = (ss[i] + ss[i + 1]) / 2;
      if (ss[i + 1] - ss[i] < 1e-3 || inRanges(mid, trims) || hidden(mid)) continue;
      const [a, b] = [frames[i], frames[i + 1]];
      g.quad(side(a, -half, 0), side(b, -half, 0), side(b, half, 0), side(a, half, 0), PALETTE.road[season]);
      // Parking strips either side of the carriageway.
      if (kl > half) g.quad(side(a, half, 0), side(b, half, 0), side(b, kl, 0), side(a, kl, 0), PALETTE.parking[season]);
      if (kr > half) g.quad(side(a, -kr, 0), side(b, -kr, 0), side(b, -half, 0), side(a, -half, 0), PALETTE.parking[season]);
      // A sloping verge, or a kerb face where a sidewalk runs (the sidewalk itself is a walkway).
      const bridge = structureAt(spans, mid) === "bridge";
      if (sidewalkWidth(r.spec, 1) > 0) g.quad(side(a, kl, 0), side(b, kl, 0), side(b, kl, -KERB_DROP), side(a, kl, -KERB_DROP), PALETTE.kerb);
      else if (!bridge) g.quad(side(a, kl, 0), side(b, kl, 0), side(b, kl + VERGE, -VERGE_DROP), side(a, kl + VERGE, -VERGE_DROP), PALETTE.verge[season]);
      if (sidewalkWidth(r.spec, -1) > 0) g.quad(side(a, -kr, -KERB_DROP), side(b, -kr, -KERB_DROP), side(b, -kr, 0), side(a, -kr, 0), PALETTE.kerb);
      else if (!bridge) g.quad(side(a, -kr - VERGE, -VERGE_DROP), side(b, -kr - VERGE, -VERGE_DROP), side(b, -kr, 0), side(a, -kr, 0), PALETTE.verge[season]);
    }

    // Dashed centre line, kept out of junctions, crossings, narrow lanes and car parks; snow hides it.
    if (r.spec.width < 5 || season === "winter" || lots.has(r.id)) continue;
    const quiet: Array<[number, number]> = trims.map(([a, b]) => [a - 2, b + 2]);
    for (const n of net.nodes) {
      if (n.legs.length < 3) continue;
      const mine = n.legs.find((l) => l.road === r.id);
      if (!mine) continue;
      const widest = Math.max(...n.legs.filter((l) => l.road !== r.id).map((l) => pavedHalf(net.roads.get(l.road)!.spec)));
      quiet.push([mine.s - widest - 3, mine.s + widest + 3]);
    }
    for (const c of net.crossings) if (c.road === r.id) quiet.push([c.roadS - c.zone - 2, c.roadS + c.zone + 2]);
    for (const c of world.walks.crossings) if (c.road === r.id && c.kind === "zebra") quiet.push([c.roadS - c.half - 1.5, c.roadS + c.half + 1.5]);
    if (!r.path.closed) quiet.push([-Infinity, 2], [L - 2, Infinity]);
    for (let s = 1; s + DASH <= L; s += 2 * DASH) {
      if (inRanges(s, quiet) || inRanges(s + DASH, quiet) || hidden(s)) continue;
      const a = roadFrame(world, r.id, s);
      const b = roadFrame(world, r.id, s + DASH);
      marks.quad(side(a, -LINE_HALF, MARK_LIFT), side(b, -LINE_HALF, MARK_LIFT), side(b, LINE_HALF, MARK_LIFT), side(a, LINE_HALF, MARK_LIFT), PALETTE.roadLine);
    }
  }

  for (const j of net.junctions) junction(g, j, season);

  // Level crossings: a dark panel over the track the width of the road, and posts on both approaches.
  for (const c of net.crossings) {
    const r = net.roads.get(c.road)!;
    const t = world.tracks.get(c.track)!;
    const ht = headingAt(t.path, c.trackS);
    const hr = headingAt(r.path, c.roadS);
    const sin = Math.max(Math.abs(Math.sin(hr - ht)), 0.25);
    const along = c.width / 2 / sin;                        // along the track to the outer edges (sidewalks included)
    const across = PANEL_HALF / sin;                        // along the road to the panel edges
    const z = c.z + CROSSING_ROAD_Z + MARK_LIFT;
    const corner = (a: number, b: number): P3 => [
      c.at[0] + Math.cos(ht) * a + Math.cos(hr) * b, c.at[1] + Math.sin(ht) * a + Math.sin(hr) * b, z,
    ];
    const ccw = Math.sin(hr - ht) > 0;
    const panel = (a0: number, a1: number, b0: number, b1: number, color: number, lift = 0) => {
      const q = [corner(a0, b0), corner(a1, b0), corner(a1, b1), corner(a0, b1)].map((p): P3 => [p[0], p[1], p[2] + lift]);
      if (ccw) marks.quad(q[0], q[1], q[2], q[3], color);
      else marks.quad(q[3], q[2], q[1], q[0], color);
    };
    panel(-along, along, -across, across, PALETTE.crossingPanel);
    // The rail heads show through the panel (the offset markings would otherwise hide them).
    for (const g0 of [RAIL_GAUGE / 2, -RAIL_GAUGE / 2]) {
      const b = g0 / sin;
      panel(-along, along, b - 0.05 / sin, b + 0.05 / sin, PALETTE.rail, RAIL_TOP - CROSSING_ROAD_Z - MARK_LIFT);
    }
    for (const a of crossingApproaches(world, c)) if (a) furniture(g, a);
  }

  parking(world, g, marks);
  busStops(world, g, marks);

  const roads = new THREE.Mesh(g.build(), flatMaterial());
  roads.name = "roads";
  roads.receiveShadow = true;
  const out: THREE.Object3D[] = [roads];
  if (marks.triangles) {
    const m = flatMaterial();
    m.polygonOffset = true;
    m.polygonOffsetFactor = -2;
    m.polygonOffsetUnits = -2;
    const markings = new THREE.Mesh(marks.build(), m);
    markings.name = "road-markings";
    markings.receiveShadow = true;
    out.push(markings);
  }
  return out;
}

/** A junction area's surface, with kerb faces (where a sidewalk runs) or sloping verges round its outer edges. */
function junction(g: GeoBuilder, j: JunctionArea, season: World["layout"]["style"]["season"]): void {
  const pts = j.outline;
  for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(pts.map((p) => new THREE.Vector2(p[0], p[1])), [])) {
    const [p, q, r] = [pts[a], pts[b], pts[c]];
    const ccw = (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]) > 0;
    if (ccw) g.tri(p, q, r, PALETTE.road[season]);
    else g.tri(p, r, q, PALETTE.road[season]);
  }
  // The outline runs counter-clockwise, so outward is to the right of each kerb edge.
  for (const k of j.kerbs) {
    const outer = k.points.map((p, i): P3 => [p[0] + k.out[i][0] * VERGE, p[1] + k.out[i][1] * VERGE, p[2] - VERGE_DROP]);
    for (let i = 0; i + 1 < k.points.length; i++) {
      const [a, b] = [k.points[i], k.points[i + 1]];
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-3) continue;
      if (k.sidewalk) g.quad([a[0], a[1], a[2] - KERB_DROP], [b[0], b[1], b[2] - KERB_DROP], b, a, PALETTE.kerb);
      else g.quad(outer[i], outer[i + 1], b, a, PALETTE.verge[season]);
    }
  }
}

/** Car park surfaces either side of their aisles, and the painted lines between parking bays. */
function parking(world: World, g: GeoBuilder, marks: GeoBuilder): void {
  const season = world.layout.style.season;
  for (const lot of world.town.lots) {
    const aisle = world.roads.roads.get(lot.id);
    if (!aisle) continue;
    const { bayS0 } = lotFrame(lot, aisle);
    const inner = LOT_AISLE / 2;
    const outer = inner + BAY_DEPTH + 0.3;
    const s0 = Math.max(0, bayS0 - 2);
    const ss = sampleS(aisle.path, STEP).filter((s) => s >= s0);
    ss.unshift(s0);
    const frames = ss.map((s) => roadFrame(world, lot.id, s));
    for (let i = 0; i + 1 < frames.length; i++) {
      const [a, b] = [frames[i], frames[i + 1]];
      for (const k of [1, -1]) {
        const [p0, p1] = k > 0 ? [inner, outer] : [-outer, -inner];
        g.quad(side(a, p0, 0), side(b, p0, 0), side(b, p1, 0), side(a, p1, 0), PALETTE.parking[season]);
        const e = k * outer;
        const ev = k * (outer + VERGE);
        if (k > 0) g.quad(side(a, e, 0), side(b, e, 0), side(b, ev, -VERGE_DROP), side(a, ev, -VERGE_DROP), PALETTE.verge[season]);
        else g.quad(side(a, ev, -VERGE_DROP), side(b, ev, -VERGE_DROP), side(b, e, 0), side(a, e, 0), PALETTE.verge[season]);
      }
    }
    // Verges along the front either side of the driveway, and right across the back, round the corners.
    const along = (f: Frame, d: number): Frame => ({ ...f, x: f.x + Math.cos(f.h) * d, y: f.y + Math.sin(f.h) * d });
    const ends: Array<[Frame, number, Array<[number, number]>]> = [
      [frames[0], -VERGE, [[inner, outer], [-outer, -inner]]],
      [frames[frames.length - 1], VERGE, [[-outer, outer]]],
    ];
    for (const [f, d, spans] of ends) {
      const o = along(f, d);
      for (const [l0, l1] of spans) facingUp(g, side(f, l0, 0), side(f, l1, 0), side(o, l1, -VERGE_DROP), side(o, l0, -VERGE_DROP), PALETTE.verge[season]);
      for (const k of [1, -1]) {
        facingUp(g, side(f, k * outer, 0), side(f, k * (outer + VERGE), -VERGE_DROP), side(o, k * (outer + VERGE), -VERGE_DROP), side(o, k * outer, -VERGE_DROP), PALETTE.verge[season]);
      }
    }
  }
  if (season === "winter") return;
  for (const bay of world.town.bays) {
    const u = [Math.cos(bay.heading), Math.sin(bay.heading)];
    const n = [-u[1], u[0]];
    const z = bay.z + MARK_LIFT;
    const line = (cx: number, cy: number, dx: number, dy: number, len: number) => {
      // A thin quad of length `len` centred on (cx, cy) along (dx, dy).
      const [ox, oy] = [-dy * BAY_LINE, dx * BAY_LINE];
      const [hx, hy] = [(dx * len) / 2, (dy * len) / 2];
      marks.quad([cx - hx - ox, cy - hy - oy, z], [cx + hx - ox, cy + hy - oy, z], [cx + hx + ox, cy + hy + oy, z], [cx - hx + ox, cy - hy + oy, z], PALETTE.roadLine);
    };
    if (bay.style === "parallel") {
      for (const k of [1, -1]) line(bay.x + u[0] * k * bay.length / 2, bay.y + u[1] * k * bay.length / 2, n[0], n[1], bay.width);
    } else {
      for (const k of [1, -1]) line(bay.x + n[0] * k * bay.width / 2, bay.y + n[1] * k * bay.width / 2, u[0], u[1], bay.length);
    }
  }
}

/** A quad turned to face upward, whichever way its corners were listed. */
function facingUp(g: GeoBuilder, a: P3, b: P3, c: P3, d: P3, color: number): void {
  const up = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) + (c[0] - a[0]) * (d[1] - a[1]) - (c[1] - a[1]) * (d[0] - a[0]);
  if (up >= 0) g.quad(a, b, c, d, color);
  else g.quad(d, c, b, a, color);
}

/** Each bus stop: a painted box where the bus stands, a sign at the kerb and a shelter behind it. */
function busStops(world: World, g: GeoBuilder, marks: GeoBuilder): void {
  const net = world.buses;
  for (const st of net.sides) {
    const stop = net.stops[st.stop];
    const road = world.roads.roads.get(stop.road)!;
    const L = road.path.length;
    const wrap = (s: number) => (road.path.closed ? ((s % L) + L) % L : Math.min(Math.max(s, 0), L));
    // The box: from just behind the bus to just ahead of it, across the lane on the stop's side.
    const front = st.s + st.dir * (FRONT_PAST + 1);
    const back = st.s - st.dir * (st.reach - FRONT_PAST + 1);
    const [s0, s1] = [Math.min(front, back), Math.max(front, back)];
    const inner = st.side * 0.35;
    const outer = st.side * (road.spec.width / 2 - 0.2);
    const n = Math.max(2, Math.ceil((s1 - s0) / STEP));
    const frames = Array.from({ length: n + 1 }, (_, i) => roadFrame(world, stop.road, wrap(s0 + ((s1 - s0) * i) / n)));
    const strip = (lat: number) => {
      for (let i = 0; i < n; i++) {
        const [a, b] = [frames[i], frames[i + 1]];
        marks.quad(side(a, lat - BAY_LINE * 1.5, MARK_LIFT), side(b, lat - BAY_LINE * 1.5, MARK_LIFT), side(b, lat + BAY_LINE * 1.5, MARK_LIFT), side(a, lat + BAY_LINE * 1.5, MARK_LIFT), PALETTE.busMark);
      }
    };
    strip(inner);
    strip(outer);
    for (const f of [frames[0], frames[n]]) {
      const [lo, hi] = [Math.min(inner, outer), Math.max(inner, outer)];
      const a = side(f, lo, MARK_LIFT);
      const b = side(f, hi, MARK_LIFT);
      const dx = Math.cos(f.h) * BAY_LINE * 1.5;
      const dy = Math.sin(f.h) * BAY_LINE * 1.5;
      marks.quad([a[0] - dx, a[1] - dy, a[2]], [a[0] + dx, a[1] + dy, a[2]], [b[0] + dx, b[1] + dy, b[2]], [b[0] - dx, b[1] - dy, b[2]], PALETTE.busMark);
    }
    // The sign: a post with a plate facing the traffic.
    const h = st.heading;
    g.box(st.sign[0], st.sign[1], st.sign[2], 0.09, 0.09, 2.7, h, PALETTE.busPost);
    g.box(st.sign[0], st.sign[1], st.sign[2] + 2.15, 0.05, 0.6, 0.6, h, PALETTE.busSign, PALETTE.busSign);
    g.box(st.sign[0], st.sign[1], st.sign[2] + 2.0, 0.05, 0.6, 0.12, h, PALETTE.busMark);
    if (!world.town.stops[st.id]?.shelter || !st.shelter) continue;
    // The shelter: glass back and ends, a roof and a bench, its open side to the road.
    const [c, sn] = [Math.cos(h), Math.sin(h)];
    const at = (k: number, along: number): [number, number] => [st.shelter![0] + sn * k + c * along, st.shelter![1] - c * k + sn * along];
    const z = st.shelter[2];
    const [bx, by] = at(0.62, 0);
    g.box(bx, by, z, 3.2, 0.08, 2.25, h, PALETTE.shelterGlass);
    for (const e of [-1.6, 1.6]) {
      const [ex, ey] = at(0.1, e);
      g.box(ex, ey, z, 0.08, 1.1, 2.25, h, PALETTE.shelterGlass);
    }
    for (const e of [-1.6, 1.6]) for (const k of [-0.62, 0.62]) {
      const [px, py] = at(k, e);
      g.box(px, py, z, 0.1, 0.1, 2.3, h, PALETTE.shelterFrame);
    }
    const [rx, ry] = at(0, 0);
    g.box(rx, ry, z + 2.3, 3.5, 1.6, 0.1, h, PALETTE.shelterFrame);
    const [qx, qy] = at(0.38, 0);
    g.box(qx, qy, z, 2.2, 0.38, 0.45, h, PALETTE.shelterFrame);
  }
}

/** One approach to a level crossing: the post on the driver's right and where its barrier points. */
type Approach = { post: P3; travel: number; arm: number; length: number };

/**
 * The two approaches of a road level crossing or a foot crossing. A road's barrier
 * covers its lane and sidewalk; a path's covers the whole path.
 */
export function crossingApproaches(world: World, c: LevelCrossing): Array<Approach | null> {
  const road = c.kind === "road";
  const geom = road ? world.roads.roads.get(c.road)!.path : world.walks.paths.get(c.road)!.path;
  const list = road ? world.roads.crossings : world.walks.footCrossings;
  // In a group of crossings, barriers stand only outside the first and last.
  const group = list.filter((x) => x.group === c.group);
  return ([1, -1] as const).map((k) => {
    if (group.some((x) => (x.roadS - c.roadS) * k < 0)) return null;
    const raw = c.roadS - k * (c.zone + 0.5);
    const s = geom.closed ? (raw + geom.length) % geom.length : Math.min(Math.max(raw, 0), geom.length);
    const f = road ? roadFrame(world, c.road, s) : pathFrame(world, c.road, s);
    const travel = f.h + (k < 0 ? Math.PI : 0);
    if (!road) {
      const half = c.width / 2;
      return { post: side(f, -k * (half + 0.5), 0), travel, arm: travel + Math.PI / 2, length: c.width + 0.4 };
    }
    const spec = world.roads.roads.get(c.road)!.spec;
    const half = kerbOffset(spec, (-k) as 1 | -1) + sidewalkWidth(spec, (-k) as 1 | -1);
    return { post: side(f, -k * (half + POST_OUT), 0), travel, arm: travel + Math.PI / 2, length: half + POST_OUT - 0.2 };
  });
}

/** A box with arbitrary orientation: centre, unit axes u, v, n and their extents. */
function orientedBox(g: GeoBuilder, c: P3, u: P3, v: P3, n: P3, lu: number, lv: number, ln: number, color: number): void {
  const p = (a: number, b: number, d: number): P3 => [
    c[0] + u[0] * a * lu / 2 + v[0] * b * lv / 2 + n[0] * d * ln / 2,
    c[1] + u[1] * a * lu / 2 + v[1] * b * lv / 2 + n[1] * d * ln / 2,
    c[2] + u[2] * a * lu / 2 + v[2] * b * lv / 2 + n[2] * d * ln / 2,
  ];
  // u × v = n for a right-handed set, so these windings face outward.
  g.quad(p(-1, -1, 1), p(1, -1, 1), p(1, 1, 1), p(-1, 1, 1), color);
  g.quad(p(-1, 1, -1), p(1, 1, -1), p(1, -1, -1), p(-1, -1, -1), color, 0.8);
  g.quad(p(1, -1, -1), p(1, 1, -1), p(1, 1, 1), p(1, -1, 1), color, 0.9);
  g.quad(p(-1, 1, -1), p(-1, -1, -1), p(-1, -1, 1), p(-1, 1, 1), color, 0.9);
  g.quad(p(-1, -1, -1), p(1, -1, -1), p(1, -1, 1), p(-1, -1, 1), color, 0.9);
  g.quad(p(1, 1, -1), p(-1, 1, -1), p(-1, 1, 1), p(1, 1, 1), color, 0.9);
}

export function furniture(g: GeoBuilder, a: Approach): void {
  const [x, y, z] = a.post;
  g.box(x, y, z - 0.3, 0.16, 0.16, CROSS_Z + 0.9, a.travel, PALETTE.signalPost);
  // Barrier housing at the foot of the post.
  g.box(x + Math.cos(a.arm) * 0.25, y + Math.sin(a.arm) * 0.25, z, 0.45, 0.4, PIVOT + 0.15, a.travel, PALETTE.signalWhite);
  // Lamp back-plate facing the traffic.
  const back: P3 = [-Math.cos(a.travel), -Math.sin(a.travel), 0];
  g.box(x + back[0] * 0.12, y + back[1] * 0.12, z + LAMP_Z - 0.22, 0.08, 0.95, 0.44, a.travel, PALETTE.signalBack);
  // St Andrew's cross: red planks with white faces, crossed at ±45° in the plane facing the traffic.
  const lat: P3 = [Math.cos(a.arm), Math.sin(a.arm), 0];
  const c: P3 = [x + back[0] * 0.12, y + back[1] * 0.12, z + CROSS_Z];
  for (const sgn of [1, -1]) {
    const u: P3 = [lat[0] * Math.SQRT1_2, lat[1] * Math.SQRT1_2, sgn * Math.SQRT1_2];
    // v completes a right-handed set with n = back: v = n × u.
    const v: P3 = [back[1] * u[2] - back[2] * u[1], back[2] * u[0] - back[0] * u[2], back[0] * u[1] - back[1] * u[0]];
    orientedBox(g, c, u, v, back, 1.3, 0.24, 0.04, PALETTE.signalRed);
    const front: P3 = [c[0] + back[0] * 0.03, c[1] + back[1] * 0.03, c[2]];
    orientedBox(g, front, u, v, back, 1.18, 0.13, 0.03, PALETTE.signalWhite);
  }
}

/** Barrier arms and flashing lamps, moved every frame from the sim's gate states. */
export class CrossingMeshes {
  readonly group = new THREE.Group();
  private arms: THREE.InstancedMesh | null = null;
  private lamps: THREE.InstancedMesh | null = null;
  private approaches: Array<Approach | null> = [];
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler(0, 0, 0, "YZX");
  private p = new THREE.Vector3();
  private s = new THREE.Vector3();
  private on = new THREE.Color(PALETTE.lampOn);
  private off = new THREE.Color(PALETTE.lampOff);

  constructor(world: World) {
    // Road crossings, then foot crossings: two approaches each, in the order of the sim's gates.
    for (const c of [...world.roads.crossings, ...world.walks.footCrossings]) this.approaches.push(...crossingApproaches(world, c));
    const n = this.approaches.length;
    if (!n) return;
    // Arm: unit length along +x from the pivot, red and white bands; scaled per approach.
    const ag = new GeoBuilder();
    const bands = 7;
    for (let i = 0; i < bands; i++) ag.box((i + 0.5) / bands, 0, -0.06, 1 / bands, 0.1, 0.12, 0, i % 2 ? PALETTE.signalWhite : PALETTE.signalRed);
    this.arms = new THREE.InstancedMesh(ag.build(), flatMaterial(), n);
    this.arms.name = "barriers";
    this.arms.castShadow = true;
    this.arms.frustumCulled = false;
    const lg = new GeoBuilder();
    lg.box(0, 0, -0.12, 0.12, 0.24, 0.24, 0, 0xffffff);
    this.lamps = new THREE.InstancedMesh(lg.build(), new THREE.MeshBasicMaterial({ color: 0xffffff }), n * 2);
    this.lamps.name = "crossing-lamps";
    this.approaches.forEach((a, i) => {
      if (!a) return this.hide(i);
      for (const k of [0, 1]) {
        const off = (k === 0 ? 0.25 : -0.25);
        const x = a.post[0] - Math.cos(a.travel) * 0.2 + Math.cos(a.arm) * off;
        const y = a.post[1] - Math.sin(a.travel) * 0.2 + Math.sin(a.arm) * off;
        this.q.setFromEuler(this.e.set(0, a.travel, 0));
        this.lamps!.setMatrixAt(i * 2 + k, this.m.compose(toThree(x, y, a.post[2] + LAMP_Z, this.p), this.q, this.s.set(1, 1, 1)));
        this.lamps!.setColorAt(i * 2 + k, this.off);
      }
    });
    this.lamps.computeBoundingSphere();
    this.group.add(this.arms, this.lamps);
  }

  update(gates: GateSnapshot[]): void {
    if (!this.arms || !this.lamps) return;
    this.approaches.forEach((a, i) => {
      if (!a) return;
      const g = gates[i >> 1];
      const down = g ? g.barrier : 0;
      // Ease the arm's swing.
      const t = down * down * (3 - 2 * down);
      this.q.setFromEuler(this.e.set(0, a.arm, (1 - t) * ARM_UP));
      toThree(a.post[0] + Math.cos(a.arm) * 0.25, a.post[1] + Math.sin(a.arm) * 0.25, a.post[2] + PIVOT, this.p);
      this.arms!.setMatrixAt(i, this.m.compose(this.p, this.q, this.s.set(a.length, 1, 1)));
      const flashing = !!g && g.state !== "open";
      this.lamps!.setColorAt(i * 2, flashing && g.lights ? this.on : this.off);
      this.lamps!.setColorAt(i * 2 + 1, flashing && !g.lights ? this.on : this.off);
    });
    this.arms.instanceMatrix.needsUpdate = true;
    if (this.lamps.instanceColor) this.lamps.instanceColor.needsUpdate = true;
  }

  /** An approach without furniture (inside a group of crossings): its instances shrink to nothing. */
  private hide(i: number): void {
    this.m.makeScale(0, 0, 0);
    this.arms!.setMatrixAt(i, this.m);
    this.lamps!.setMatrixAt(i * 2, this.m);
    this.lamps!.setMatrixAt(i * 2 + 1, this.m);
    this.lamps!.setColorAt(i * 2, this.off);
    this.lamps!.setColorAt(i * 2 + 1, this.off);
  }

  dispose(): void {
    for (const o of [this.arms, this.lamps]) {
      if (!o) continue;
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    }
  }
}
