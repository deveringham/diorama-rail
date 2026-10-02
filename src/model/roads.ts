// Roads: a second network built like the track — waypoints filleted into lines and
// arcs, heights clamped to a grade, bridges and tunnels, terrain shaping — joined
// by T-junctions (from/to) and automatic crossroads, and meeting tracks at level
// crossings (or passing over/under them when far enough apart in height).

import type { Layout, RoadSpec } from "./schema";
import { waypoint } from "./schema";
import type { TrackGeom, Junction } from "./trackGraph";
import { type Path, makePath, filletPolyline, pointAt, headingAt, sampleS } from "./geometry";
import { type Profile, type Span, type Pin, buildProfile, classify, profileZ, structureAt } from "./heights";
import { type Terrain, baseZ } from "./terrain";
import { type Issue, error, warning } from "./validate";
import { SpatialHash } from "../util/spatial";
import { type V2, mod, wrapAngle } from "../util/vec";

const LEVEL_DZ = 3;              // m: road and track this close in height meet at grade
const RAIL_CLEAR = 6.5;          // m: height difference for a road to pass over or under a track
const ROAD_CLEAR = 5.5;          // m: same for a road over or under another road
export const CROSSING_ROAD_Z = 0.2; // road surface above track z at a level crossing (above sleepers, below rail tops)
const CROSSING_FLAT = 5;         // m either side of a level crossing held level
const CROSSING_GROUP_GAP = 15;   // m: level crossings closer than this along a road work as one
const TRACK_ZONE = 3;            // m either side of the track centre that cars must clear
const MIN_CROSSING_ANGLE = 30;   // degrees; shallower level crossings get a warning
const TURNOUT_CLEAR = 35;        // m a level crossing must keep from a railway junction
const NODE_CLEAR = 25;           // m a level crossing must keep from a road junction or road end
const NODE_SPACING = 25;         // m between road junctions along a road
const ROAD_SMOOTH = 40;          // m terrain smoothing window for road heights
const POINT_STEP = 2;
const BOUNDS_MARGIN = 5;
const ABOVE_SEA = 1.0;           // m a road keeps above sea level
const LEG_MERGE = 3;             // m: legs of one road at one node closer than this are the same leg
const END_SNAP = 4;              // m: a road crossing another this close to its end meets it at a T
const JUNCTION_IGNORE = 30;       // m around a shared junction where two roads may overlap

export type RoadGeom = { id: string; index: number; spec: RoadSpec; path: Path; waypointS: number[] };
export type Leg = { road: string; s: number; dir: 1 | -1 };       // leave a node along `road` from s in dir
export type RoadNode = { id: number; at: V2; legs: Leg[] };       // 1 leg = dead end; 3+ = junction
export type LevelCrossing = {
  id: string;
  road: string; roadS: number;
  track: string; trackS: number;
  at: V2; z: number;
  angle: number;                 // degrees between road and track (90 = square)
  zone: number;                  // half-length along the road that must be clear of cars when trains pass
  group: number;                 // index of the first crossing of its group: crossings close together on one road
                                 // (a road over double track) close and open together, with barriers only outside
};
export type RoadPoint = { road: string; s: number; x: number; y: number; z: number; width: number; ground: boolean };
export type RoadNet = {
  roads: Map<string, RoadGeom>;
  order: string[];
  profiles: Map<string, Profile>;
  spans: Map<string, Span[]>;
  nodes: RoadNode[];
  stops: Map<string, Array<{ s: number; node: number }>>;   // nodes along each road, by s
  crossings: LevelCrossing[];
  trims: Map<string, Array<[number, number]>>;              // s-ranges drawn by another road (junction areas)
  points: RoadPoint[];
  hash: SpatialHash<RoadPoint>;
};

export const emptyRoadNet = (): RoadNet => ({
  roads: new Map(), order: [], profiles: new Map(), spans: new Map(), nodes: [], stops: new Map(), crossings: [],
  trims: new Map(), points: [], hash: new SpatialHash<RoadPoint>(10),
});

type Ctx = {
  layout: Layout;
  tracks: Map<string, TrackGeom>;
  trackProfiles: Map<string, Profile>;
  trackSpans: Map<string, Span[]>;
  junctions: Junction[];
  terrain: Terrain;
};

// ---------------------------------------------------------------------------

/** Polyline of a path sampled every ~1 m, for intersection tests. */
type Poly = { s: number[]; x: number[]; y: number[] };
function polyline(path: Path): Poly {
  const s = sampleS(path, 1);
  if (path.closed) s.push(path.length);
  const pts = s.map((v) => pointAt(path, v));
  return { s, x: pts.map((p) => p[0]), y: pts.map((p) => p[1]) };
}

/** Where two polylines cross: s on each and the point. Segments of b are hashed for speed. */
function intersections(a: Poly, b: Poly): Array<{ sa: number; sb: number; at: V2 }> {
  const hash = new SpatialHash<number>(8);
  for (let j = 0; j + 1 < b.s.length; j++) hash.insert((b.x[j] + b.x[j + 1]) / 2, (b.y[j] + b.y[j + 1]) / 2, j);
  const out: Array<{ sa: number; sb: number; at: V2 }> = [];
  for (let i = 0; i + 1 < a.s.length; i++) {
    const [px, py, rx, ry] = [a.x[i], a.y[i], a.x[i + 1] - a.x[i], a.y[i + 1] - a.y[i]];
    hash.near(px + rx / 2, py + ry / 2, 3, (j) => {
      const [qx, qy, sx, sy] = [b.x[j], b.y[j], b.x[j + 1] - b.x[j], b.y[j + 1] - b.y[j]];
      const den = rx * sy - ry * sx;
      if (Math.abs(den) < 1e-12) return;
      const t = ((qx - px) * sy - (qy - py) * sx) / den;
      const u = ((qx - px) * ry - (qy - py) * rx) / den;
      if (t < 0 || t >= 1 || u < 0 || u >= 1) return;
      const at: V2 = [px + rx * t, py + ry * t];
      if (out.some((o) => Math.hypot(o.at[0] - at[0], o.at[1] - at[1]) < 1)) return;
      out.push({ sa: a.s[i] + (a.s[i + 1] - a.s[i]) * t, sb: b.s[j] + (b.s[j + 1] - b.s[j]) * u, at });
    });
  }
  return out;
}

/** s on the parent road of a from/to end ("start" and "end" resolved). */
const endAt = (e: { at: number | "start" | "end" }, parent: RoadGeom) =>
  e.at === "start" ? 0 : e.at === "end" ? parent.path.length : e.at;

const crossAngle = (h1: number, h2: number) => {
  const d = Math.abs(wrapAngle(h1 - h2));
  return (Math.min(d, Math.PI - d) * 180) / Math.PI;
};

/** Roads in dependency order (parents first), or the cycle that prevents it. */
function roadOrder(roads: RoadSpec[]): { order: string[]; cycle: string[] | null } {
  const byId = new Map(roads.map((r) => [r.id, r]));
  const state = new Map<string, number>();
  const order: string[] = [];
  let cycle: string[] | null = null;
  const visit = (id: string, stack: string[]) => {
    if (cycle || state.get(id) === 2) return;
    if (state.get(id) === 1) { cycle = [...stack.slice(stack.indexOf(id)), id]; return; }
    state.set(id, 1);
    const r = byId.get(id)!;
    for (const e of [r.from, r.to]) if (e && byId.has(e.road)) visit(e.road, [...stack, id]);
    state.set(id, 2);
    order.push(id);
  };
  for (const r of roads) visit(r.id, []);
  return { order, cycle };
}

// ---------------------------------------------------------------------------

export function buildRoads(ctx: Ctx): { net: RoadNet | null; issues: Issue[] } {
  const { layout, terrain } = ctx;
  const issues: Issue[] = [];
  const base = (x: number, y: number) => baseZ(terrain, x, y);
  // Roads keep above the water: along a shore they run on a low quay.
  const sea = terrain.seaLevel;
  const dry = sea === null ? base : (x: number, y: number) => Math.max(base(x, y), sea + ABOVE_SEA);
  const { order, cycle } = roadOrder(layout.roads);
  if (cycle) {
    const i = layout.roads.findIndex((r) => r.id === cycle![0]);
    return { net: null, issues: [error("TRACK_REF_CYCLE", `roads reference each other in a cycle (${cycle.join(" → ")}); a road's from/to must point at a road that does not depend on it`, `roads[${i}]`)] };
  }

  // 1. Geometry, parents first.
  const roads = new Map<string, RoadGeom>();
  for (const id of order) {
    const index = layout.roads.findIndex((r) => r.id === id);
    const road = buildRoadPath(layout.roads[index], index, roads, issues);
    if (road) roads.set(id, road);
  }
  if (roads.size < layout.roads.length) return { net: null, issues };

  // 2. Where roads meet tracks and each other, judged on provisional heights.
  const provisional = new Map([...roads].map(([id, r]) => [id, buildProfile(r, dry, [], { window: ROAD_SMOOTH, noun: "road", follow: true }).profile]));
  const polys = new Map([...roads].map(([id, r]) => [id, polyline(r.path)]));
  const crossings: LevelCrossing[] = [];
  const separated: Array<{ road: string; s: number; other: string; otherS: number; rail: boolean; above: boolean; at: V2 }> = [];
  const crossroads: Array<{ a: string; sa: number; b: string; sb: number; at: V2; angle: number }> = [];
  for (const r of roads.values()) {
    const rz = provisional.get(r.id)!;
    const path = `roads[${r.index}]`;
    for (const t of ctx.tracks.values()) {
      for (const x of intersections(polys.get(r.id)!, polyline(t.path))) {
        const tz = profileZ(ctx.trackProfiles.get(t.id)!, x.sb);
        const dz = profileZ(rz, x.sa) - tz;
        const angle = crossAngle(headingAt(r.path, x.sa), headingAt(t.path, x.sb));
        if (Math.abs(dz) <= LEVEL_DZ) {
          // Along the road, the stretch where any part of the carriageway is within TRACK_ZONE of the rails.
          const a = (angle * Math.PI) / 180;
          const zone = (TRACK_ZONE + (r.spec.width / 2) * Math.cos(a)) / Math.max(Math.sin(a), 0.25);
          const id = `${r.id}×${t.id}`;
          const n = crossings.filter((c) => c.id === id || c.id.startsWith(`${id}#`)).length;
          crossings.push({ id: n ? `${id}#${n + 1}` : id, group: crossings.length, road: r.id, roadS: x.sa, track: t.id, trackS: x.sb, at: x.at, z: tz, angle, zone });
        } else if (Math.abs(dz) < RAIL_CLEAR) {
          issues.push(error("ROAD_CONFLICT", `road '${r.id}' crosses track '${t.id}' ${Math.abs(dz).toFixed(1)} m ${dz > 0 ? "above" : "below"} it; make it a level crossing (within ${LEVEL_DZ} m, e.g. with a waypoint z) or clear it by ${RAIL_CLEAR} m`, path, x.at));
        } else separated.push({ road: r.id, s: x.sa, other: t.id, otherS: x.sb, rail: true, above: dz > 0, at: x.at });
      }
    }
  }
  const ids = [...roads.keys()];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const [a, b] = [roads.get(ids[i])!, roads.get(ids[j])!];
      for (const x of intersections(polys.get(a.id)!, polys.get(b.id)!)) {
        // A T-junction's own meeting point is not a crossing.
        if ([a, b].some((r) => [r.spec.from, r.spec.to].some((e, k) => e && (e.road === a.id || e.road === b.id)
          && Math.hypot(pointAt(r.path, k === 0 ? 0 : r.path.length)[0] - x.at[0], pointAt(r.path, k === 0 ? 0 : r.path.length)[1] - x.at[1]) < 4))) continue;
        const dz = profileZ(provisional.get(a.id)!, x.sa) - profileZ(provisional.get(b.id)!, x.sb);
        if (Math.abs(dz) <= LEVEL_DZ) {
          // A road that simply ends on another (without from/to) meets it at a T: snap to its end.
          const snap = (r: RoadGeom, s: number) => (r.path.closed ? s : s < END_SNAP ? 0 : s > r.path.length - END_SNAP ? r.path.length : s);
          const [sa, sb] = [snap(a, x.sa), snap(b, x.sb)];
          crossroads.push({ a: a.id, sa, b: b.id, sb, at: x.at, angle: crossAngle(headingAt(a.path, sa), headingAt(b.path, sb)) });
        } else if (Math.abs(dz) < ROAD_CLEAR) {
          issues.push(error("ROAD_CONFLICT", `roads '${a.id}' and '${b.id}' cross ${Math.abs(dz).toFixed(1)} m apart in height; meet at the same height (a crossroads) or clear each other by ${ROAD_CLEAR} m`, `roads[${b.index}]`, x.at));
        } else separated.push({ road: a.id, s: x.sa, other: b.id, otherS: x.sb, rail: false, above: dz > 0, at: x.at });
      }
    }
  }

  // Crossings whose zones come within a vehicle's length of each other along a road form a group.
  for (const r of roads.values()) {
    const mine = crossings.filter((c) => c.road === r.id).sort((a, b) => a.roadS - b.roadS);
    for (let k = 1; k < mine.length; k++) {
      if (mine[k].roadS - mine[k].zone - (mine[k - 1].roadS + mine[k - 1].zone) < CROSSING_GROUP_GAP) mine[k].group = mine[k - 1].group;
    }
  }

  // 3. Final heights, parents first, pinned to parents, tracks and earlier crossing roads.
  const profiles = new Map<string, Profile>();
  const spans = new Map<string, Span[]>();
  const rank = new Map(order.map((id, k) => [id, k]));
  for (const id of order) {
    const r = roads.get(id)!;
    const L = r.path.length;
    const pins: Pin[] = [];
    const flat = (s: number, half: number, z: number) => {
      for (const d of [-half, 0, half]) {
        const v = r.path.closed ? mod(s + d, L) : s + d;
        if (v >= 0 && v <= L) pins.push({ s: v, z });
      }
    };
    for (const [k, e] of [[0, r.spec.from], [1, r.spec.to]] as const) {
      if (!e) continue;
      const parent = roads.get(e.road)!;
      const z = profileZ(profiles.get(e.road)!, endAt(e, parent));
      const half = parent.spec.width / 2;
      pins.push({ s: k === 0 ? 0 : L, z }, { s: k === 0 ? Math.min(L, half) : Math.max(0, L - half), z });
    }
    for (const c of crossings) if (c.road === id) flat(c.roadS, CROSSING_FLAT, c.z + CROSSING_ROAD_Z);
    for (const c of crossroads) {
      const [mine, other, otherS] = c.a === id ? [c.sa, c.b, c.sb] : c.b === id ? [c.sb, c.a, c.sa] : [NaN, "", 0];
      if (Number.isNaN(mine) || rank.get(other)! > rank.get(id)!) continue;
      flat(mine, roads.get(other)!.spec.width / 2, profileZ(profiles.get(other)!, otherS));
    }
    const { profile, issues: grade } = buildProfile(r, dry, pins, { window: ROAD_SMOOTH, noun: "road", follow: true });
    for (const g of grade) issues.push(error("GRADE_EXCEEDED", g.message, `roads[${r.index}]`, pointAt(r.path, g.s0)));
    profiles.set(id, profile);
    spans.set(id, classify(r, profile, base));
  }
  for (const x of separated) {
    const z = profileZ(profiles.get(x.road)!, x.s);
    const oz = x.rail ? profileZ(ctx.trackProfiles.get(x.other)!, x.otherS) : profileZ(profiles.get(x.other)!, x.otherS);
    const need = x.rail ? RAIL_CLEAR : ROAD_CLEAR;
    if (Math.abs(z - oz) < need) {
      issues.push(error("ROAD_CONFLICT", `road '${x.road}' passes ${Math.abs(z - oz).toFixed(1)} m ${z > oz ? "over" : "under"} ${x.rail ? "track" : "road"} '${x.other}', less than the ${need} m needed; adjust its waypoint z or the grades`, `roads[${roads.get(x.road)!.index}]`, x.at));
    }
  }

  // 4. Nodes: T-junctions, crossroads and dead ends; then which nodes lie along each road.
  const nodes: RoadNode[] = [];
  const nodeAt = (at: V2) => {
    const found = nodes.find((n) => Math.hypot(n.at[0] - at[0], n.at[1] - at[1]) < 1.5);
    if (found) return found;
    nodes.push({ id: nodes.length, at, legs: [] });
    return nodes[nodes.length - 1];
  };
  // A node may gather the same road twice (a T-junction and a crossroads at one spot): one leg per way out.
  const addLeg = (n: RoadNode, leg: Leg) => {
    const path = roads.get(leg.road)!.path;
    const gap = (a: number, b: number) => (path.closed ? Math.min(Math.abs(a - b), path.length - Math.abs(a - b)) : Math.abs(a - b));
    if (!n.legs.some((l) => l.road === leg.road && l.dir === leg.dir && gap(l.s, leg.s) < LEG_MERGE)) n.legs.push(leg);
  };
  const both = (n: RoadNode, road: string, s: number) => {
    const r = roads.get(road)!;
    if (r.path.closed || s < r.path.length - 1e-6) addLeg(n, { road, s, dir: 1 });
    if (r.path.closed || s > 1e-6) addLeg(n, { road, s, dir: -1 });
  };
  for (const r of roads.values()) {
    for (const [k, e] of [[0, r.spec.from], [1, r.spec.to]] as const) {
      const s = k === 0 ? 0 : r.path.length;
      if (e) {
        const parent = roads.get(e.road)!;
        const ps = parent.path.closed ? mod(endAt(e, parent), parent.path.length) : endAt(e, parent);
        const n = nodeAt(pointAt(parent.path, ps));
        if (!n.legs.some((l) => l.road === parent.id)) both(n, parent.id, ps);
        addLeg(n, { road: r.id, s, dir: k === 0 ? 1 : -1 });
      } else if (!r.path.closed) {
        addLeg(nodeAt(pointAt(r.path, s)), { road: r.id, s, dir: k === 0 ? 1 : -1 });
      }
    }
  }
  for (const c of crossroads) {
    const n = nodeAt(c.at);
    both(n, c.a, c.sa);
    both(n, c.b, c.sb);
  }
  const stops = new Map<string, Array<{ s: number; node: number }>>([...roads.keys()].map((id) => [id, []]));
  for (const n of nodes) {
    for (const l of n.legs) {
      const list = stops.get(l.road)!;
      if (!list.some((x) => x.node === n.id)) list.push({ s: l.s, node: n.id });
    }
  }
  for (const list of stops.values()) list.sort((a, b) => a.s - b.s);

  // 5. Junction areas are drawn by one road only: trim branch ends and the later crossing road.
  const trims = new Map<string, Array<[number, number]>>([...roads.keys()].map((id) => [id, []]));
  const trimLen = (w: number, angle: number) => Math.min(12, w / 2 / Math.max(Math.sin((angle * Math.PI) / 180), 0.3));
  for (const r of roads.values()) {
    for (const [k, e] of [[0, r.spec.from], [1, r.spec.to]] as const) {
      if (!e) continue;
      const parent = roads.get(e.road)!;
      const s = k === 0 ? 0 : r.path.length;
      const t = trimLen(parent.spec.width, crossAngle(headingAt(r.path, s), headingAt(parent.path, endAt(e, parent))));
      trims.get(r.id)!.push(k === 0 ? [0, t] : [r.path.length - t, r.path.length]);
    }
  }
  for (const c of crossroads) {
    const [later, s, other] = rank.get(c.a)! > rank.get(c.b)! ? [c.a, c.sa, c.b] : [c.b, c.sb, c.a];
    const t = trimLen(roads.get(other)!.spec.width, c.angle);
    const L = roads.get(later)!.path.length;
    const list = trims.get(later)!;
    // Ranges stay within [0, L]; on a loop, one that wraps is split in two.
    if (s - t < 0 && roads.get(later)!.path.closed) list.push([0, s + t], [L + s - t, L]);
    else if (s + t > L && roads.get(later)!.path.closed) list.push([s - t, L], [0, s + t - L]);
    else list.push([Math.max(0, s - t), Math.min(L, s + t)]);
  }

  // 6. Dense points for shaping, conflicts, bounds and scenery checks.
  const points: RoadPoint[] = [];
  for (const r of roads.values()) {
    for (const s of sampleS(r.path, POINT_STEP)) {
      const [x, y] = pointAt(r.path, s);
      points.push({ road: r.id, s, x, y, z: profileZ(profiles.get(r.id)!, s), width: r.spec.width, ground: structureAt(spans.get(r.id)!, s) === "ground" });
    }
  }
  const hash = new SpatialHash<RoadPoint>(10);
  for (const p of points) hash.insert(p.x, p.y, p);
  const net: RoadNet = { roads, order, profiles, spans, nodes, stops, crossings, trims, points, hash };
  issues.push(...checkRoads(ctx, net));
  return { net, issues };
}

/** One road's path: an optional T-junction start/end on a parent, then filleted waypoints. */
function buildRoadPath(spec: RoadSpec, index: number, built: Map<string, RoadGeom>, issues: Issue[]): RoadGeom | null {
  const base = `roads[${index}]`;
  const wps = spec.points.map(waypoint);
  const pts: V2[] = wps.map((w) => w.at);
  const radii = wps.map((w) => w.radius ?? spec.minRadius);
  for (const [which, e] of [["from", spec.from], ["to", spec.to]] as const) {
    if (!e) continue;
    const parent = built.get(e.road);
    if (!parent) return null;
    const L = parent.path.length;
    const at = endAt(e, parent);
    if (!parent.path.closed && (at < 0 || at > L)) {
      issues.push(error("JUNCTION_POSITION", `road junction at s=${at} is outside road '${e.road}' (length ${L.toFixed(0)} m); use 0..${L.toFixed(0)}, "start" or "end"`, `${base}.${which}.at`));
      return null;
    }
    const J = pointAt(parent.path, at);
    if (which === "from") { pts.unshift(J); radii.unshift(spec.minRadius); } else { pts.push(J); radii.push(spec.minRadius); }
  }
  const offset = spec.from ? 1 : 0;
  const f = filletPolyline(pts, radii, spec.kind === "loop");
  for (const is of f.issues) {
    const p = typeof is.point === "number" ? is.point - offset : -1;
    const where = p >= 0 && p < wps.length ? `${base}.points[${p}]` : `${base}.${p < 0 ? "from" : "to"}`;
    issues.push(error(is.code, `road '${spec.id}': ${is.message}`, where, is.at));
  }
  if (f.issues.length) return null;
  const path = makePath(f.segments, spec.kind === "loop");
  const waypointS = f.cornerS.slice(offset, offset + wps.length);
  if (!spec.from && spec.kind === "line") waypointS[0] = 0;
  if (!spec.to && spec.kind === "line") waypointS[wps.length - 1] = path.length;
  return { id: spec.id, index, spec, path, waypointS };
}

/** Bounds, clearances to tracks and other roads, and where level crossings may go. */
function checkRoads(ctx: Ctx, net: RoadNet): Issue[] {
  const issues: Issue[] = [];
  const [W, H] = ctx.layout.terrain.size;
  const road = (id: string) => net.roads.get(id)!;
  for (const r of net.roads.values()) {
    const out = net.points.find((p) => p.road === r.id && (p.x < BOUNDS_MARGIN || p.y < BOUNDS_MARGIN || p.x > W - BOUNDS_MARGIN || p.y > H - BOUNDS_MARGIN));
    if (out) issues.push(error("OUT_OF_BOUNDS", `road '${r.id}' leaves the terrain around (${out.x.toFixed(0)}, ${out.y.toFixed(0)}); keep roads ${BOUNDS_MARGIN} m inside`, `roads[${r.index}].points`, [out.x, out.y]));
  }

  // Junctions need room between them for a car to wait clear of both.
  for (const [id, list] of net.stops) {
    const r = road(id);
    const junction = list.filter((x) => net.nodes[x.node].legs.length >= 2);
    for (let k = 0; k < junction.length; k++) {
      const a = junction[k];
      const b = junction[(k + 1) % junction.length];
      if (k + 1 === junction.length && (!r.path.closed || junction.length < 2)) break;
      const gap = k + 1 === junction.length ? b.s + r.path.length - a.s : b.s - a.s;
      if (gap < NODE_SPACING && a.node !== b.node) {
        const at = net.nodes[b.node].at;
        issues.push(error("JUNCTION_POSITION", `road '${id}' has two junctions only ${gap.toFixed(0)} m apart near (${at[0].toFixed(0)}, ${at[1].toFixed(0)}); keep road junctions at least ${NODE_SPACING} m apart so cars can wait between them`, `roads[${r.index}]`, at));
      }
    }
  }

  for (const c of net.crossings) {
    const r = road(c.road);
    const path = `roads[${r.index}]`;
    const span = structureAt(ctx.trackSpans.get(c.track)!, c.trackS);
    const station = ctx.layout.stations.find((st) => st.track === c.track && Math.abs(st.at - c.trackS) < st.length / 2 + 5);
    const turnout = ctx.junctions.find((j) => Math.hypot(j.at[0] - c.at[0], j.at[1] - c.at[1]) < TURNOUT_CLEAR);
    const node = net.nodes.find((n) => Math.hypot(n.at[0] - c.at[0], n.at[1] - c.at[1]) < NODE_CLEAR);
    const why = span !== "ground" ? `track '${c.track}' is in a ${span} there`
      : station ? `it is on the platform of station '${station.id}'`
        : turnout ? `it is within ${TURNOUT_CLEAR} m of the railway junction ${turnout.id}`
          : node ? `it is within ${NODE_CLEAR} m of ${node.legs.length === 1 ? "the end of the road" : "a road junction"}` : null;
    if (why) issues.push(error("LEVEL_CROSSING_POSITION", `road '${c.road}' crosses track '${c.track}' at grade near (${c.at[0].toFixed(0)}, ${c.at[1].toFixed(0)}) but ${why}; move the crossing or take the road over or under the line`, path, c.at));
    if (c.angle < MIN_CROSSING_ANGLE) {
      issues.push(warning("LEVEL_CROSSING_ANGLE", `road '${c.road}' crosses track '${c.track}' at only ${c.angle.toFixed(0)}°; aim for at least ${MIN_CROSSING_ANGLE}° (ideally square) so the crossing stays short`, path, c.at));
    }
  }

  // Clearance from tracks (away from this road's level crossings) and from other roads.
  const trackHash = new SpatialHash<{ track: string; s: number; x: number; y: number; z: number }>(10);
  for (const t of ctx.tracks.values()) {
    for (const s of sampleS(t.path, POINT_STEP)) {
      const [x, y] = pointAt(t.path, s);
      trackHash.insert(x, y, { track: t.id, s, x, y, z: profileZ(ctx.trackProfiles.get(t.id)!, s) });
    }
  }
  const reported = new Set<string>();
  const report = (key: string, issue: Issue) => { if (!reported.has(key)) { reported.add(key); issues.push(issue); } };
  for (const p of net.points) {
    const gap = p.width / 2 + 2.5;
    trackHash.near(p.x, p.y, gap, (q) => {
      if (Math.hypot(p.x - q.x, p.y - q.y) >= gap || Math.abs(p.z - q.z) >= RAIL_CLEAR) return;
      if (net.crossings.some((c) => c.road === p.road && Math.hypot(c.at[0] - p.x, c.at[1] - p.y) < c.zone + p.width + 4)) return;
      report(`${p.road}|${q.track}`, error("ROAD_CONFLICT", `road '${p.road}' runs within ${Math.hypot(p.x - q.x, p.y - q.y).toFixed(1)} m of track '${q.track}' near (${p.x.toFixed(0)}, ${p.y.toFixed(0)}); keep roads ${gap.toFixed(1)} m from track centres or cross at a level crossing`, `roads[${road(p.road).index}]`, [p.x, p.y]));
    });
    net.hash.near(p.x, p.y, 10, (q) => {
      if (q.road === p.road) {
        const path = road(p.road).path;
        const ds = Math.abs(q.s - p.s);
        if ((path.closed ? Math.min(ds, path.length - ds) : ds) < 40) return;
      }
      if (q.road < p.road) return;
      const need = (p.width + q.width) / 2 + 0.5;
      if (Math.hypot(p.x - q.x, p.y - q.y) >= need || Math.abs(p.z - q.z) >= ROAD_CLEAR) return;
      const shared = net.nodes.some((n) => n.legs.some((l) => l.road === p.road) && n.legs.some((l) => l.road === q.road)
        && Math.hypot(n.at[0] - p.x, n.at[1] - p.y) < JUNCTION_IGNORE);
      if (shared) return;
      report(`${p.road}|${q.road}`, error("ROAD_CONFLICT", `roads '${p.road}' and '${q.road}' overlap near (${p.x.toFixed(0)}, ${p.y.toFixed(0)}) without meeting at a junction; move them apart, cross them, or join one to the other with from/to`, `roads[${road(q.road).index}]`, [p.x, p.y]));
    });
  }
  return issues;
}
