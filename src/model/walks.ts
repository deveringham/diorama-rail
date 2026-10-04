// Footpaths and sidewalks: the pedestrians' network, built like the roads. Paths are
// waypoint lines with heights, bridges and tunnels of their own, joined by
// T-junctions (from/to) and automatic crossings. Sidewalks run along roads that ask
// for them, round the corners of junctions and across their legs. Where a path
// crosses a road there is a zebra crossing; where it crosses a track, a foot
// crossing with lights and barriers that works like a level crossing.
//
// The result is a graph of walkways (polylines with a width) between nodes, which
// the pedestrian sim walks and the scene draws.

import type { Layout, PathSpec } from "./schema";
import { waypoint } from "./schema";
import type { TrackGeom, Junction } from "./trackGraph";
import { type Path, makePath, filletPolyline, pointAt, headingAt, sampleS } from "./geometry";
import { type Profile, type Span, type Pin, buildProfile, classify, profileZ, structureAt, tunnelMouths, MOUTH } from "./heights";
import { type Terrain, baseZ } from "./terrain";
import {
  type RoadNet, type RoadGeom, type LevelCrossing, polyline, intersections, crossAngle, endAt, sidewalkWidth, roadReach, junctionStop,
  kerbOffset, legCorner, sortedLegs, SHALLOWEST_CROSSING,
} from "./roads";
import { type Issue, error, warning } from "./validate";
import { offEdge } from "./exits";
import { SpatialHash } from "../util/spatial";
import { type V2, mod } from "../util/vec";

export const KERB = 0.15;            // m a sidewalk stands above the carriageway
const LEVEL_DZ = 2;                  // m: a path this close in height to a track, road or path meets it at grade
const RAIL_CLEAR = 6.5;              // m for a path over or under a track
const ROAD_CLEAR = 5;                // m over or under a road (a footbridge or an underpass)
const PATH_CLEAR = 3;                // m over or under another path
const PATH_SMOOTH = 20;              // m terrain smoothing window for path heights
const ABOVE_SEA = 0.5;
const FOOT_FLAT = 3;                 // m either side of a foot crossing held level
const FOOT_RAIL_Z = 0.2;             // path surface above track z at a foot crossing
const TRACK_ZONE = 3;                // m either side of the track centre people must clear
const CROSSING_GROUP_GAP = 6;        // m: foot crossings closer than this along a path work as one
const MIN_CROSSING_ANGLE = 30;
const TURNOUT_CLEAR = 35;
const CROSS_BACK = 6;                // m behind the cars' junction stop line where people cross a side road
const CORNER_RUN = 1.5;              // m of each leg's sidewalk past its corner that the corner piece takes
const CUT_MAX = 16;                  // m
const ZEBRA_WIDTH = 3;               // m along the road
const CROSSING_WIDTH = 2.5;          // m along the road, unmarked crossings at junctions
const ZEBRA_JUNCTION_CLEAR = 5;      // m a zebra keeps beyond a junction's sidewalk corners
const ZEBRA_LEVEL_CLEAR = 8;         // m a zebra keeps from a level crossing's zone
const ZEBRA_END_CLEAR = 15;          // m a zebra keeps from a road's dead end
const SAMPLE = 1;                    // m between walkway polyline points
const GATE_ROOM = 2;                 // m beyond a crossing's zone that must stay on the same walkway
const GATE_MERGE = 4;                // m: crossing zones closer than this along a walkway are one
const POINT_STEP = 2;
const BOUNDS_MARGIN = 3;
const END_SNAP = 2;                  // m: a path crossing another this close to its end meets it at a T
const JOIN_REACH = 1.5;              // m beyond a road's sidewalks within which a path end joins it
const SHARED_NODE = 10;              // m round a shared node where walkways may overlap
const SMALL = 1.2;                   // m: objects at most this wide may stand on a walkway (lamps, bollards)

export type PathGeom = { id: string; index: number; spec: PathSpec; path: Path; waypointS: number[] };
export type WalkKind = "path" | "sidewalk" | "corner" | "zebra" | "crossing";
export type Walkway = {
  id: number;
  kind: WalkKind;                    // zebra: a marked crossing over a road; crossing: unmarked, over a junction's leg
  owner: string;                     // path or road id
  x: number[]; y: number[]; z: number[]; cum: number[];
  length: number;
  width: number;
  surface: "gravel" | "paved";
  a: number; b: number;              // nodes at the start and end
  crossing: number;                  // index into WalkNet.crossings for zebra and crossing ways, else -1
  // Level and foot crossings along it (gate index: road crossings first). Zones that overlap or
  // nearly touch are one: `gate` is the first crossing's, `also` the others'.
  gates: Array<{ gate: number; also: number[]; at: number; zone: number }>;
};
export type WalkNode = {
  id: number; at: V2; z: number; ways: Array<{ way: number; end: 0 | 1 }>;
  exit: number;                      // the exit (world.offLayout.exits) a path or sidewalk leaves the board by here, else -1
};
/** Where people cross a road: cars on its lanes stop for them (zebra) or they wait for a gap (crossing). */
export type RoadCrossing = { id: number; kind: "zebra" | "crossing"; road: string; roadS: number; half: number; way: number; at: V2 };
/** `ground`: the ground is shaped to it (a path on plain ground or just inside a tunnel mouth). */
export type WalkPoint = { x: number; y: number; z: number; width: number; kind: WalkKind; owner: string; ground: boolean; mouth: boolean };
export type WalkNet = {
  paths: Map<string, PathGeom>;
  stationNodes: Array<{ station: string; node: number }>;   // path ends on station platforms
  order: string[];
  profiles: Map<string, Profile>;
  spans: Map<string, Span[]>;
  ways: Walkway[];
  nodes: WalkNode[];
  crossings: RoadCrossing[];
  footCrossings: LevelCrossing[];
  points: WalkPoint[];
  hash: SpatialHash<WalkPoint>;
};

export const emptyWalkNet = (): WalkNet => ({
  paths: new Map(), stationNodes: [], order: [], profiles: new Map(), spans: new Map(), ways: [], nodes: [], crossings: [], footCrossings: [],
  points: [], hash: new SpatialHash<WalkPoint>(10),
});

type Ctx = {
  layout: Layout;
  stationEntries: Map<string, Array<{ at: P3 }>>;   // where paths may meet each station's platforms
  tracks: Map<string, TrackGeom>;
  trackProfiles: Map<string, Profile>;
  trackSpans: Map<string, Span[]>;
  junctions: Junction[];
  terrain: Terrain;
  roads: RoadNet;
};

export type P3 = [number, number, number];
const dist2 = (a: { 0: number; 1: number }, b: { 0: number; 1: number }) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Paths in dependency order (parents first), or the cycle that prevents it. */
function pathOrder(paths: PathSpec[]): { order: string[]; cycle: string[] | null } {
  const byId = new Map(paths.map((p) => [p.id, p]));
  const state = new Map<string, number>();
  const order: string[] = [];
  let cycle: string[] | null = null;
  const visit = (id: string, stack: string[]) => {
    if (cycle || state.get(id) === 2) return;
    if (state.get(id) === 1) { cycle = [...stack.slice(stack.indexOf(id)), id]; return; }
    state.set(id, 1);
    const p = byId.get(id)!;
    for (const e of [p.from, p.to]) if (e?.path && byId.has(e.path)) visit(e.path, [...stack, id]);
    state.set(id, 2);
    order.push(id);
  };
  for (const p of paths) visit(p.id, []);
  return { order, cycle };
}

/** A point beside a road: s along it, `lateral` metres to its left (negative: right), at road height + dz. */
function beside(roads: RoadNet, road: string, s: number, lateral: number, dz = 0): P3 {
  const r = roads.roads.get(road)!;
  const [x, y] = pointAt(r.path, s);
  const h = headingAt(r.path, s);
  return [x - Math.sin(h) * lateral, y + Math.cos(h) * lateral, profileZ(roads.profiles.get(road)!, s) + dz];
}

/** Where people stand on one side of a road at s: the sidewalk's centre, or just off the carriageway. */
function sideSpot(roads: RoadNet, road: string, s: number, side: 1 | -1): P3 {
  const r = roads.roads.get(road)!;
  const sw = sidewalkWidth(r.spec, side);
  const kerb = kerbOffset(r.spec, side);
  return sw > 0 ? beside(roads, road, s, side * (kerb + sw / 2), KERB) : beside(roads, road, s, side * (kerb + 0.4));
}

/** Signed distance of (x, y) to the left of a road at s. */
function lateralOf(r: RoadGeom, s: number, x: number, y: number): number {
  const [px, py] = pointAt(r.path, s);
  const h = headingAt(r.path, s);
  return -(x - px) * Math.sin(h) + (y - py) * Math.cos(h);
}

/** Nearest road point to (x, y): road, s and distance, refined between the 2 m samples. */
function nearestRoad(roads: RoadNet, x: number, y: number, radius: number): { road: RoadGeom; s: number; d: number } | null {
  let best: { road: string; s: number; d: number } | null = null;
  roads.hash.near(x, y, radius, (p) => {
    const d = Math.hypot(p.x - x, p.y - y);
    if (d <= radius && (!best || d < best.d)) best = { road: p.road, s: p.s, d };
  });
  if (!best) return null;
  const b: { road: string; s: number; d: number } = best;
  const r = roads.roads.get(b.road)!;
  for (let ds = -2; ds <= 2; ds += 0.05) {
    const s = r.path.closed ? mod(b.s + ds, r.path.length) : Math.min(Math.max(b.s + ds, 0), r.path.length);
    const [px, py] = pointAt(r.path, s);
    const d = Math.hypot(px - x, py - y);
    if (d < b.d) Object.assign(b, { s, d });
  }
  return { road: r, s: b.s, d: b.d };
}

// ---------------------------------------------------------------------------

export function buildWalks(ctx: Ctx): { net: WalkNet | null; issues: Issue[] } {
  const { layout, terrain, roads } = ctx;
  const issues: Issue[] = [];
  const base = (x: number, y: number) => baseZ(terrain, x, y);
  const sea = terrain.seaLevel;
  const dry = sea === null ? base : (x: number, y: number) => Math.max(base(x, y), sea + ABOVE_SEA);
  const { order, cycle } = pathOrder(layout.paths);
  if (cycle) {
    const i = layout.paths.findIndex((p) => p.id === cycle![0]);
    return { net: null, issues: [error("TRACK_REF_CYCLE", `paths reference each other in a cycle (${cycle.join(" → ")}); a path's from/to must point at a path that does not depend on it`, `paths[${i}]`)] };
  }

  // 1. Path geometry, parents first.
  const paths = new Map<string, PathGeom>();
  for (const id of order) {
    const index = layout.paths.findIndex((p) => p.id === id);
    const geom = buildPathGeom(layout.paths[index], index, paths, roads, ctx.stationEntries, issues);
    if (geom) paths.set(id, geom);
  }
  if (paths.size < layout.paths.length) return { net: null, issues };

  // 2. How each path end meets the world: a parent path, a road's edge, or nothing.
  type End = { kind: "path"; parent: string; s: number } | { kind: "road"; road: string; s: number; side: 1 | -1 }
    | { kind: "station"; station: string; z: number } | { kind: "free" };
  const ends = new Map<string, [End, End]>();
  const provisional = new Map([...paths].map(([id, p]) => [id, buildProfile(p, dry, [], { window: PATH_SMOOTH, noun: "path", follow: true }).profile]));
  for (const p of paths.values()) {
    const pair: End[] = [];
    for (const k of [0, 1] as const) {
      const e = k === 0 ? p.spec.from : p.spec.to;
      if (p.path.closed) { pair.push({ kind: "free" }); continue; }
      if (e?.path) { pair.push({ kind: "path", parent: e.path, s: endAt({ at: e.at! }, paths.get(e.path)!) }); continue; }
      if (e?.station) {
        const [ex, ey] = pointAt(p.path, k === 0 ? 0 : p.path.length);
        const entry = ctx.stationEntries.get(e.station)!.map((x) => x.at).reduce((a, b) => (dist2(a, [ex, ey]) <= dist2(b, [ex, ey]) ? a : b));
        pair.push({ kind: "station", station: e.station, z: entry[2] });
        continue;
      }
      if (e?.road) {
        const r = roads.roads.get(e.road)!;
        const s = endAt({ at: e.at! }, r);
        const inner = pointAt(p.path, k === 0 ? Math.min(3, p.path.length) : Math.max(0, p.path.length - 3));
        pair.push({ kind: "road", road: e.road, s, side: lateralOf(r, s, inner[0], inner[1]) >= 0 ? 1 : -1 });
        continue;
      }
      // A free end inside a road's footprint (carriageway and sidewalks) joins that road.
      const s0 = k === 0 ? 0 : p.path.length;
      const [ex, ey] = pointAt(p.path, s0);
      const near = nearestRoad(roads, ex, ey, 30);
      const ez = profileZ(provisional.get(p.id)!, s0);
      if (near && near.d <= roadReach(near.road.spec) + JOIN_REACH && Math.abs(profileZ(roads.profiles.get(near.road.id)!, near.s) - ez) < LEVEL_DZ + 1) {
        const inner = pointAt(p.path, k === 0 ? Math.min(near.d + 4, p.path.length) : Math.max(0, p.path.length - near.d - 4));
        pair.push({ kind: "road", road: near.road.id, s: near.s, side: lateralOf(near.road, near.s, inner[0], inner[1]) >= 0 ? 1 : -1 });
      } else pair.push({ kind: "free" });
    }
    ends.set(p.id, pair as [End, End]);
  }

  // 3. Where paths meet tracks, roads and each other, judged on provisional heights.
  const polys = new Map([...paths].map(([id, p]) => [id, polyline(p.path)]));
  const trackPolys = new Map([...ctx.tracks].map(([id, t]) => [id, polyline(t.path)]));
  const roadPolys = new Map([...roads.roads].map(([id, r]) => [id, polyline(r.path)]));
  const footCrossings: LevelCrossing[] = [];
  type Zebra = { path: string; pathS: number; road: string; roadS: number; at: V2; angle: number };
  const zebras: Zebra[] = [];
  type Meet = { a: string; sa: number; b: string; sb: number; at: V2 };
  const meets: Meet[] = [];                                       // path × path at grade
  const separated: Array<{ path: string; s: number; kind: "track" | "road" | "path"; other: string; otherS: number; at: V2 }> = [];
  for (const p of paths.values()) {
    const pz = provisional.get(p.id)!;
    const where = `paths[${p.index}]`;
    for (const t of ctx.tracks.values()) {
      for (const x of intersections(polys.get(p.id)!, trackPolys.get(t.id)!)) {
        const tz = profileZ(ctx.trackProfiles.get(t.id)!, x.sb);
        const dz = profileZ(pz, x.sa) - tz;
        const angle = crossAngle(headingAt(p.path, x.sa), headingAt(t.path, x.sb));
        if (Math.abs(dz) <= LEVEL_DZ) {
          const a = (angle * Math.PI) / 180;
          const zone = (TRACK_ZONE + (p.spec.width / 2) * Math.cos(a)) / Math.max(Math.sin(a), 0.25);
          const id = `${p.id}×${t.id}`;
          const n = footCrossings.filter((c) => c.id === id || c.id.startsWith(`${id}#`)).length;
          footCrossings.push({
            id: n ? `${id}#${n + 1}` : id, kind: "path", group: footCrossings.length, road: p.id, roadS: x.sa, width: p.spec.width,
            track: t.id, trackS: x.sb, at: x.at, z: tz, angle, zone,
          });
        } else if (Math.abs(dz) < RAIL_CLEAR) {
          issues.push(error("PATH_CONFLICT", `path '${p.id}' crosses track '${t.id}' ${Math.abs(dz).toFixed(1)} m ${dz > 0 ? "above" : "below"} it; make it a foot crossing (within ${LEVEL_DZ} m, e.g. with a waypoint z) or clear it by ${RAIL_CLEAR} m`, where, x.at));
        } else separated.push({ path: p.id, s: x.sa, kind: "track", other: t.id, otherS: x.sb, at: x.at });
      }
    }
    for (const r of roads.roads.values()) {
      for (const x of intersections(polys.get(p.id)!, roadPolys.get(r.id)!)) {
        // A path end that joins this road is not a crossing.
        const pe = ends.get(p.id)!;
        if (pe.some((e, k) => e.kind === "road" && e.road === r.id && Math.abs(x.sa - (k === 0 ? 0 : p.path.length)) < roadReach(r.spec) + JOIN_REACH + 4)) continue;
        const dz = profileZ(provisional.get(p.id)!, x.sa) - profileZ(roads.profiles.get(r.id)!, x.sb);
        if (Math.abs(dz) <= LEVEL_DZ) {
          zebras.push({ path: p.id, pathS: x.sa, road: r.id, roadS: x.sb, at: x.at, angle: crossAngle(headingAt(p.path, x.sa), headingAt(r.path, x.sb)) });
        } else if (Math.abs(dz) < ROAD_CLEAR) {
          issues.push(error("PATH_CONFLICT", `path '${p.id}' crosses road '${r.id}' ${Math.abs(dz).toFixed(1)} m ${dz > 0 ? "above" : "below"} it; cross at the same height (a zebra crossing) or clear it by ${ROAD_CLEAR} m`, where, x.at));
        } else separated.push({ path: p.id, s: x.sa, kind: "road", other: r.id, otherS: x.sb, at: x.at });
      }
    }
  }
  const ids = [...paths.keys()];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const [a, b] = [paths.get(ids[i])!, paths.get(ids[j])!];
      for (const x of intersections(polys.get(a.id)!, polys.get(b.id)!)) {
        // A T-junction's own meeting point is not a crossing.
        const isT = (c: PathGeom, cs: number, other: string) => ends.get(c.id)!.some((e, k) => e.kind === "path" && e.parent === other
          && Math.abs(cs - (k === 0 ? 0 : c.path.length)) < 4);
        if (isT(a, x.sa, b.id) || isT(b, x.sb, a.id)) continue;
        const dz = profileZ(provisional.get(a.id)!, x.sa) - profileZ(provisional.get(b.id)!, x.sb);
        if (Math.abs(dz) <= LEVEL_DZ) {
          const snap = (p: PathGeom, s: number) => (p.path.closed ? s : s < END_SNAP ? 0 : s > p.path.length - END_SNAP ? p.path.length : s);
          meets.push({ a: a.id, sa: snap(a, x.sa), b: b.id, sb: snap(b, x.sb), at: x.at });
        } else if (Math.abs(dz) < PATH_CLEAR) {
          issues.push(error("PATH_CONFLICT", `paths '${a.id}' and '${b.id}' cross ${Math.abs(dz).toFixed(1)} m apart in height; meet at the same height or clear each other by ${PATH_CLEAR} m`, `paths[${b.index}]`, x.at));
        } else separated.push({ path: a.id, s: x.sa, kind: "path", other: b.id, otherS: x.sb, at: x.at });
      }
    }
  }
  // Foot crossings close together along a path (double track) work as one; indices follow the road crossings.
  const gateBase = roads.crossings.length;
  footCrossings.forEach((c, i) => { c.group = gateBase + i; });
  for (const p of paths.values()) {
    const mine = footCrossings.filter((c) => c.road === p.id).sort((a, b) => a.roadS - b.roadS);
    for (let k = 1; k < mine.length; k++) {
      if (mine[k].roadS - mine[k].zone - (mine[k - 1].roadS + mine[k - 1].zone) < CROSSING_GROUP_GAP) mine[k].group = mine[k - 1].group;
    }
  }

  // 4. Final heights, parents first: pinned to parent paths, road kerbs, rails and earlier paths.
  const profiles = new Map<string, Profile>();
  const spans = new Map<string, Span[]>();
  const rank = new Map(order.map((id, k) => [id, k]));
  for (const id of order) {
    const p = paths.get(id)!;
    const L = p.path.length;
    const pins: Pin[] = [];
    const flat = (s: number, half: number, z: number) => {
      for (const d of [-half, 0, half]) {
        const v = p.path.closed ? mod(s + d, L) : s + d;
        if (v >= 0 && v <= L) pins.push({ s: v, z });
      }
    };
    ends.get(id)!.forEach((e, k) => {
      const s = k === 0 ? 0 : L;
      if (e.kind === "path") pins.push({ s, z: profileZ(profiles.get(e.parent)!, e.s) });
      if (e.kind === "road") pins.push({ s, z: sideSpot(roads, e.road, e.s, e.side)[2] });
      if (e.kind === "station") pins.push({ s, z: e.z });
    });
    for (const z of zebras) {
      if (z.path !== id) continue;
      const r = roads.roads.get(z.road)!;
      const reach = (roadReach(r.spec) + 0.5) / Math.max(Math.sin((z.angle * Math.PI) / 180), 0.3);
      flat(z.pathS, reach, profileZ(roads.profiles.get(z.road)!, z.roadS) + KERB);
    }
    for (const c of footCrossings) if (c.road === id) flat(c.roadS, FOOT_FLAT, c.z + FOOT_RAIL_Z);
    for (const m of meets) {
      const [mine, other, otherS] = m.a === id ? [m.sa, m.b, m.sb] : m.b === id ? [m.sb, m.a, m.sa] : [NaN, "", 0];
      if (Number.isNaN(mine) || rank.get(other)! > rank.get(id)!) continue;
      flat(mine, paths.get(other)!.spec.width / 2, profileZ(profiles.get(other)!, otherS));
    }
    const { profile, issues: grade } = buildProfile(p, dry, pins, { window: PATH_SMOOTH, noun: "path", follow: true });
    for (const g of grade) issues.push(error("GRADE_EXCEEDED", g.message, `paths[${p.index}]`, pointAt(p.path, g.s0)));
    profiles.set(id, profile);
    // Over the sea a path stands on piles: a pier.
    spans.set(id, classify(p, profile, sea === null ? base : (x, y) => (base(x, y) < sea ? -Infinity : base(x, y))));
  }
  for (const x of separated) {
    const z = profileZ(profiles.get(x.path)!, x.s);
    const oz = x.kind === "track" ? profileZ(ctx.trackProfiles.get(x.other)!, x.otherS)
      : x.kind === "road" ? profileZ(roads.profiles.get(x.other)!, x.otherS) : profileZ(profiles.get(x.other)!, x.otherS);
    const need = x.kind === "track" ? RAIL_CLEAR : x.kind === "road" ? ROAD_CLEAR : PATH_CLEAR;
    if (Math.abs(z - oz) < need) {
      issues.push(error("PATH_CONFLICT", `path '${x.path}' passes ${Math.abs(z - oz).toFixed(1)} m ${z > oz ? "over" : "under"} ${x.kind} '${x.other}', less than the ${need} m needed; adjust its waypoint z or the grades`, `paths[${paths.get(x.path)!.index}]`, x.at));
    }
  }

  // 5. The graph.
  const g = new GraphBuilder(roads);
  const pathZ = (id: string, s: number) => profileZ(profiles.get(id)!, s);
  const pathPt = (id: string, s: number): P3 => {
    const p = paths.get(id)!;
    const [x, y] = pointAt(p.path, s);
    return [x, y, pathZ(id, s)];
  };

  // 5a. Road junctions: where each leg's sidewalks end, the corners between legs and crossings over legs.
  const cuts = roadJunctions(g, roads);

  // 5b. Path events along each path and each sidewalk (road side).
  type Ev = { s: number; node: number; kind: "split" | "cutStart" | "cutEnd"; spot?: P3 };
  const pathEvents = new Map<string, Ev[]>([...paths.keys()].map((id) => [id, []]));
  const sideEvents = new Map<string, Ev[]>();                       // "road|side"
  const sideKey = (road: string, side: number) => `${road}|${side}`;
  const sideNode = (road: string, s: number, side: 1 | -1): number => {
    // A node on the sidewalk at s; inside a junction's cut it snaps to the nearest piece end.
    const r = roads.roads.get(road)!;
    if (sidewalkWidth(r.spec, side) <= 0) return g.node(sideSpot(roads, road, s, side));
    const snapped = cuts.snap(road, side, s);
    if (snapped !== null) return snapped;
    const list = sideEvents.get(sideKey(road, side)) ?? [];
    const found = list.find((e) => Math.abs(e.s - s) < 0.5);
    if (found) return found.node;
    const node = g.node(sideSpot(roads, road, s, side));
    list.push({ s, node, kind: "split" });
    sideEvents.set(sideKey(road, side), list);
    return node;
  };
  const meetNodes = new Map<Meet, number>();
  const stationNodes: Array<{ station: string; node: number }> = [];
  const joins: Array<{ path: string; road: string; at: V2 }> = [];
  for (const m of meets) {
    const z = pathZ(m.a, m.sa);
    const node = g.node([m.at[0], m.at[1], z]);
    meetNodes.set(m, node);
    pathEvents.get(m.a)!.push({ s: m.sa, node, kind: "split" });
    pathEvents.get(m.b)!.push({ s: m.sb, node, kind: "split" });
  }
  for (const p of paths.values()) {
    const L = p.path.length;
    ends.get(p.id)!.forEach((e, k) => {
      if (p.path.closed) return;
      const s = k === 0 ? 0 : L;
      let node: number;
      let spot: P3 | undefined;
      if (e.kind === "path") {
        // The parent's split at the T, shared with the meeting point if one coincides.
        const list = pathEvents.get(e.parent)!;
        const found = list.find((x) => Math.abs(x.s - e.s) < 0.5 && x.kind === "split");
        node = found ? found.node : g.node(pathPt(e.parent, e.s));
        if (!found) list.push({ s: e.s, node, kind: "split" });
      } else if (e.kind === "road") {
        node = sideNode(e.road, e.s, e.side);
        spot = g.nodes[node].at3;
        // The path stops at the road's outer edge; the last stretch runs to the sidewalk.
        const r = roads.roads.get(e.road)!;
        const edge = kerbOffset(r.spec, e.side) + Math.max(sidewalkWidth(r.spec, e.side), 0.4);
        let t = s;
        for (let i = 0; i < 400; i++) {
          const [x, y] = pointAt(p.path, t);
          if (Math.abs(lateralOf(r, e.s, x, y)) >= edge - 0.05) break;
          const next = t + (k === 0 ? 0.25 : -0.25);
          if (next < 0 || next > L) break;
          t = next;
        }
        joins.push({ path: p.id, road: e.road, at: pointAt(p.path, s) });
        pathEvents.get(p.id)!.push({ s: t, node, kind: "split", spot });
        return;
      } else {
        const existing = pathEvents.get(p.id)!.find((x) => Math.abs(x.s - s) < 0.5);
        node = existing ? existing.node : g.node(pathPt(p.id, s));
        if (e.kind === "station") stationNodes.push({ station: e.station, node });
      }
      // A free path end that meets another path's end at a T was snapped into `meets` already.
      const list = pathEvents.get(p.id)!;
      if (!list.some((x) => Math.abs(x.s - s) < 1e-6 && x.node === node)) list.push({ s, node, kind: "split", spot });
    });
  }
  // Zebras: the path is cut where it is on the road; people cross on the zebra between the two sides.
  const crossings: RoadCrossing[] = [];
  for (const z of zebras) {
    const p = paths.get(z.path)!;
    const r = roads.roads.get(z.road)!;
    const edge = (side: 1 | -1) => kerbOffset(r.spec, side) + Math.max(sidewalkWidth(r.spec, side), 0.4);
    // Walk out from the crossing point along the path until it is off the road on each side.
    const out = (dir: 1 | -1) => {
      let s = z.pathS;
      for (let k = 0; k < 400; k++) {
        const next = s + dir * 0.25;
        if (!p.path.closed && (next < 0 || next > p.path.length)) break;
        s = p.path.closed ? mod(next, p.path.length) : next;
        const [x, y] = pointAt(p.path, s);
        const lat = lateralOf(r, z.roadS, x, y);
        if (Math.abs(lat) >= edge(lat >= 0 ? 1 : -1)) break;
      }
      const [x, y] = pointAt(p.path, s);
      return { s, side: (lateralOf(r, z.roadS, x, y) >= 0 ? 1 : -1) as 1 | -1 };
    };
    const a = out(-1);
    const b = out(1);
    if (a.side === b.side) continue;                          // grazes the road without crossing it
    const na = sideNode(z.road, z.roadS, a.side);
    const nb = sideNode(z.road, z.roadS, b.side);
    const evs = pathEvents.get(z.path)!;
    evs.push({ s: a.s, node: na, kind: "cutStart", spot: g.nodes[na].at3 }, { s: b.s, node: nb, kind: "cutEnd", spot: g.nodes[nb].at3 });
    const way = g.crossWay("zebra", z.road, z.roadS, a.side, na, nb, ZEBRA_WIDTH);
    crossings.push({ id: crossings.length, kind: "zebra", road: z.road, roadS: z.roadS, half: ZEBRA_WIDTH / 2, way, at: z.at });
    g.ways[way].crossing = crossings.length - 1;
  }
  for (const c of g.legCrossings) {
    crossings.push({ id: crossings.length, kind: "crossing", road: c.road, roadS: c.roadS, half: CROSSING_WIDTH / 2, way: c.way, at: c.at });
    g.ways[c.way].crossing = crossings.length - 1;
  }

  // 5c. Walkways along paths.
  for (const p of paths.values()) {
    const evs = pathEvents.get(p.id)!.sort((a, b) => a.s - b.s);
    const L = p.path.length;
    if (p.path.closed && !evs.length) {
      // A loop with nothing on it still needs a node: put it opposite its foot crossings.
      const mine = footCrossings.filter((c) => c.road === p.id);
      const s0 = mine.length ? mod(mine[0].roadS + L / 2, L) : 0;
      evs.push({ s: s0, node: g.node(pathPt(p.id, s0)), kind: "split" });
    }
    const pts = (s0: number, s1: number) => {
      const out: P3[] = [];
      const len = s1 - s0;
      const n = Math.max(1, Math.ceil(len / SAMPLE));
      for (let i = 0; i <= n; i++) out.push(pathPt(p.id, p.path.closed ? mod(s0 + (len * i) / n, L) : s0 + (len * i) / n));
      return out;
    };
    const add = (from: Ev, to: Ev, s1: number) => {
      const line = pts(from.s, s1);
      if (from.spot) line.unshift(from.spot);
      if (to.spot) line.push(to.spot);
      g.way("path", p.id, line, from.node, to.node, p.spec.width, p.spec.surface);
    };
    for (let k = 0; k < evs.length; k++) {
      const from = evs[k];
      if (from.kind === "cutStart") continue;                 // the zebra replaces what follows
      const last = k + 1 === evs.length;
      if (last && !p.path.closed) break;
      const to = last ? evs[0] : evs[k + 1];
      add(from, to, last ? to.s + L : to.s);
    }
  }

  // 5d. Walkways along sidewalks: pieces between junction cuts, split where paths join or cross.
  for (const r of roads.roads.values()) {
    for (const side of [1, -1] as const) {
      const sw = sidewalkWidth(r.spec, side);
      if (sw <= 0) continue;
      const lateral = side * (kerbOffset(r.spec, side) + sw / 2);
      const splits = (sideEvents.get(sideKey(r.id, side)) ?? []).sort((a, b) => a.s - b.s);
      const L = r.path.length;
      for (const piece of cuts.pieces(r.id, side)) {
        // piece: s0 → s1 (s1 may exceed L on loops), with nodes at both ends.
        const inside = splits.filter((e) => {
          const s = r.path.closed && e.s < piece.s0 ? e.s + L : e.s;
          return s > piece.s0 + 1e-6 && s < piece.s1 - 1e-6;
        }).map((e) => ({ ...e, s: r.path.closed && e.s < piece.s0 ? e.s + L : e.s })).sort((a, b) => a.s - b.s);
        const stops = [{ s: piece.s0, node: piece.a }, ...inside, { s: piece.s1, node: piece.b }];
        for (let k = 0; k + 1 < stops.length; k++) {
          const [s0, s1] = [stops[k].s, stops[k + 1].s];
          const n = Math.max(1, Math.ceil((s1 - s0) / SAMPLE));
          const line: P3[] = [];
          for (let i = 0; i <= n; i++) {
            const s = s0 + ((s1 - s0) * i) / n;
            line.push(beside(roads, r.id, r.path.closed ? mod(s, L) : s, lateral, KERB));
          }
          g.way("sidewalk", r.id, line, stops[k].node, stops[k + 1].node, sw, "paved");
        }
      }
    }
  }

  // 5e. Level and foot crossings along walkways: where each walkway crosses a track at grade.
  const footBy = (path: string, track: string, at: V2) => {
    let best = -1;
    footCrossings.forEach((c, k) => {
      if (c.road === path && c.track === track && dist2(c.at, at) < 6 && (best < 0 || dist2(c.at, at) < dist2(footCrossings[best].at, at))) best = k;
    });
    return best;
  };
  for (const w of g.ways) {
    if (w.kind === "zebra" || w.kind === "crossing") continue;
    const wp = { s: w.cum, x: w.x, y: w.y };
    for (const t of ctx.tracks.values()) {
      for (const x of intersections(wp, trackPolys.get(t.id)!)) {
        const tz = profileZ(ctx.trackProfiles.get(t.id)!, x.sb);
        const i = Math.min(w.z.length - 1, Math.max(0, w.cum.findIndex((c) => c >= x.sa)));
        if (Math.abs(w.z[i] - tz) > 3) continue;              // on a bridge or in a cutting: not at grade
        let gate = -1;
        if (w.kind === "path") {
          const k = footBy(w.owner, t.id, x.at);
          if (k >= 0) gate = gateBase + k;
        } else {
          gate = roads.crossings.findIndex((c) => c.road === w.owner && c.track === t.id && Math.abs(c.trackS - x.sb) < c.width + 10);
        }
        if (gate < 0) continue;
        const k = Math.max(1, w.cum.findIndex((c) => c >= x.sa));
        const hw = Math.atan2(w.y[k] - w.y[k - 1], w.x[k] - w.x[k - 1]);
        const a = (crossAngle(hw, headingAt(t.path, x.sb)) * Math.PI) / 180;
        const zone = (TRACK_ZONE + (w.width / 2) * Math.cos(a)) / Math.max(Math.sin(a), 0.25);
        w.gates.push({ gate, also: [], at: x.sa, zone });
      }
    }
    // Crossings of one group (double track), or too close to wait between, are one zone for the
    // people: nobody waits between them.
    w.gates.sort((a, b) => a.at - b.at);
    const groupOf = (gate: number) => (gate < gateBase ? roads.crossings[gate].group : footCrossings[gate - gateBase].group);
    const merged: typeof w.gates = [];
    for (const gt of w.gates) {
      const last = merged[merged.length - 1];
      if (last && (groupOf(last.gate) === groupOf(gt.gate) || gt.at - gt.zone - (last.at + last.zone) < GATE_MERGE)) {
        const lo = Math.min(last.at - last.zone, gt.at - gt.zone);
        const hi = Math.max(last.at + last.zone, gt.at + gt.zone);
        last.at = (lo + hi) / 2;
        last.zone = (hi - lo) / 2;
        if (gt.gate !== last.gate && !last.also.includes(gt.gate)) last.also.push(gt.gate);
      } else merged.push({ ...gt, also: [] });
    }
    w.gates = merged;
  }

  // A crossing's zone must lie within one walkway: people wait at its edge, not at a node beyond it.
  for (const w of g.ways) {
    for (const gt of w.gates) {
      if (gt.at - gt.zone - GATE_ROOM >= 0 && gt.at + gt.zone + GATE_ROOM <= w.length) continue;
      const c = gt.gate < gateBase ? roads.crossings[gt.gate] : footCrossings[gt.gate - gateBase];
      if (w.kind === "path") {
        issues.push(error("LEVEL_CROSSING_POSITION", `path '${w.owner}' crosses track '${c.track}' near (${c.at[0].toFixed(0)}, ${c.at[1].toFixed(0)}) within ${(gt.zone + GATE_ROOM).toFixed(0)} m of a junction, crossing or end of the path; move the foot crossing or the junction further apart`, `paths[${paths.get(w.owner)!.index}]`, c.at));
      } else {
        const r = roads.roads.get(w.owner)!;
        issues.push(error("LEVEL_CROSSING_POSITION", `the sidewalks of road '${w.owner}' meet a junction, path or zebra within ${(gt.zone + GATE_ROOM).toFixed(0)} m of the level crossing ${c.id}; keep junctions and paths further from it`, `roads[${r.index}]`, c.at));
      }
    }
  }

  // 6. Dense points for shaping, conflicts, bounds and scenery checks.
  const points: WalkPoint[] = [];
  // Each path's tunnel mouths: where they are and which way leads in.
  const mouths = new Map([...paths.values()].map((p) => [p.id, tunnelMouths(spans.get(p.id)!, p.path.closed).map((m) => {
    const h = headingAt(p.path, m.s) + (m.into > 0 ? 0 : Math.PI);
    return { at: pointAt(p.path, m.s), dir: [Math.cos(h), Math.sin(h)] as V2 };
  })]));
  for (const w of g.ways) {
    if (w.kind === "zebra" || w.kind === "crossing") continue;
    for (let d = 0; d <= w.length; d += POINT_STEP) {
      const [x, y, z] = wayPoint(w, d);
      // Paths shape the ground unless on a bridge, a pier or in a tunnel (bar its mouths); sidewalks sit on the road's bed.
      const gap = z - base(x, y);
      const mouth = w.kind === "path" && (mouths.get(w.owner) ?? []).some((m) => {
        const fwd = (x - m.at[0]) * m.dir[0] + (y - m.at[1]) * m.dir[1];
        const lat = -(x - m.at[0]) * m.dir[1] + (y - m.at[1]) * m.dir[0];
        return fwd >= 0 && fwd <= MOUTH && Math.abs(lat) < w.width / 2 + 1;
      });
      const ground = w.kind === "path" && (mouth || (gap < 5 && gap > -7 && (sea === null || base(x, y) >= sea)));
      points.push({ x, y, z, width: w.width, kind: w.kind, owner: w.owner, ground, mouth });
    }
  }
  const hash = new SpatialHash<WalkPoint>(10);
  for (const p of points) hash.insert(p.x, p.y, p);

  const net: WalkNet = {
    paths, stationNodes, order, profiles, spans, ways: g.ways, nodes: g.nodes.map((n) => ({ id: n.id, at: n.at, z: n.at3[2], ways: n.ways, exit: -1 })),
    crossings, footCrossings, points, hash,
  };
  issues.push(...checkWalks(ctx, net, zebras, cuts, joins));
  return { net, issues };
}

/** Position along a walkway polyline. */
export function wayPoint(w: Walkway, d: number): P3 {
  const n = w.cum.length;
  if (d <= 0) return [w.x[0], w.y[0], w.z[0]];
  if (d >= w.length) return [w.x[n - 1], w.y[n - 1], w.z[n - 1]];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (w.cum[mid] <= d) lo = mid;
    else hi = mid;
  }
  const u = (d - w.cum[lo]) / Math.max(w.cum[hi] - w.cum[lo], 1e-9);
  return [w.x[lo] + (w.x[hi] - w.x[lo]) * u, w.y[lo] + (w.y[hi] - w.y[lo]) * u, w.z[lo] + (w.z[hi] - w.z[lo]) * u];
}

/** Heading of a walkway at d. */
export function wayHeading(w: Walkway, d: number): number {
  const n = w.cum.length;
  let i = 1;
  while (i < n - 1 && w.cum[i] < d) i++;
  return Math.atan2(w.y[i] - w.y[i - 1], w.x[i] - w.x[i - 1]);
}

/** One path's geometry: an optional start/end on a parent path or a road's edge, then filleted waypoints. */
function buildPathGeom(
  spec: PathSpec, index: number, built: Map<string, PathGeom>, roads: RoadNet, stationEntries: Map<string, Array<{ at: P3 }>>, issues: Issue[],
): PathGeom | null {
  const base = `paths[${index}]`;
  const wps = spec.points.map(waypoint);
  const pts: V2[] = wps.map((w) => w.at);
  const radii = wps.map((w) => w.radius ?? spec.minRadius);
  for (const [which, e] of [["from", spec.from], ["to", spec.to]] as const) {
    if (!e) continue;
    let J: V2;
    if (e.station) {
      // Beside the station building on the platform's back edge, whichever side the path comes from.
      const toward = which === "from" ? wps[0].at : wps[wps.length - 1].at;
      const entries = stationEntries.get(e.station);
      if (!entries?.length) return null;
      const best = entries.map((x) => x.at).reduce((a, b) => (dist2(a, toward) <= dist2(b, toward) ? a : b));
      J = [best[0], best[1]];
    } else if (e.path) {
      const parent = built.get(e.path);
      if (!parent) return null;
      const at = endAt({ at: e.at! }, parent);
      if (!parent.path.closed && (at < 0 || at > parent.path.length)) {
        issues.push(error("JUNCTION_POSITION", `path junction at s=${at} is outside path '${e.path}' (length ${parent.path.length.toFixed(0)} m); use 0..${parent.path.length.toFixed(0)}, "start" or "end"`, `${base}.${which}.at`));
        return null;
      }
      J = pointAt(parent.path, at);
    } else {
      const r = roads.roads.get(e.road!);
      if (!r) return null;
      const at = endAt({ at: e.at! }, r);
      if (!r.path.closed && (at < 0 || at > r.path.length)) {
        issues.push(error("JUNCTION_POSITION", `path start/end at s=${at} is outside road '${e.road}' (length ${r.path.length.toFixed(0)} m); use 0..${r.path.length.toFixed(0)}, "start" or "end"`, `${base}.${which}.at`));
        return null;
      }
      // Start at the outer edge of the road's sidewalk on the side the path goes.
      const toward = which === "from" ? wps[0].at : wps[wps.length - 1].at;
      const side = lateralOf(r, at, toward[0], toward[1]) >= 0 ? 1 : -1;
      const [x, y] = beside(roads, r.id, at, side * (kerbOffset(r.spec, side) + Math.max(sidewalkWidth(r.spec, side), 0.4)));
      J = [x, y];
    }
    if (which === "from") { pts.unshift(J); radii.unshift(spec.minRadius); } else { pts.push(J); radii.push(spec.minRadius); }
  }
  const offset = spec.from ? 1 : 0;
  const f = filletPolyline(pts, radii, spec.kind === "loop");
  for (const is of f.issues) {
    const p = typeof is.point === "number" ? is.point - offset : -1;
    const where = p >= 0 && p < wps.length ? `${base}.points[${p}]` : `${base}.${p < 0 ? "from" : "to"}`;
    issues.push(error(is.code, `path '${spec.id}': ${is.message}`, where, is.at));
  }
  if (f.issues.length) return null;
  const path = makePath(f.segments, spec.kind === "loop");
  const waypointS = f.cornerS.slice(offset, offset + wps.length);
  if (!spec.from && spec.kind === "line") waypointS[0] = 0;
  if (!spec.to && spec.kind === "line") waypointS[wps.length - 1] = path.length;
  return { id: spec.id, index, spec, path, waypointS };
}

// ---------------------------------------------------------------------------
// Graph building

type BNode = { id: number; at: V2; at3: P3; ways: Array<{ way: number; end: 0 | 1 }> };

class GraphBuilder {
  nodes: BNode[] = [];
  ways: Walkway[] = [];
  legCrossings: Array<{ road: string; roadS: number; way: number; at: V2 }> = [];
  constructor(private roads: RoadNet) {}

  node(at: P3): number {
    this.nodes.push({ id: this.nodes.length, at: [at[0], at[1]], at3: at, ways: [] });
    return this.nodes.length - 1;
  }

  way(kind: WalkKind, owner: string, line: P3[], a: number, b: number, width: number, surface: "gravel" | "paved"): number {
    // Drop repeated points so headings are defined everywhere.
    const pts: P3[] = [];
    for (const p of line) if (!pts.length || dist2(pts[pts.length - 1], p) > 0.05) pts.push(p);
    if (pts.length < 2) pts.push([pts[0][0] + 0.01, pts[0][1], pts[0][2]]);
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist2(pts[i - 1], pts[i]));
    const w: Walkway = {
      id: this.ways.length, kind, owner, x: pts.map((p) => p[0]), y: pts.map((p) => p[1]), z: pts.map((p) => p[2]), cum,
      length: cum[cum.length - 1], width, surface, a, b, crossing: -1, gates: [],
    };
    this.ways.push(w);
    this.nodes[a].ways.push({ way: w.id, end: 0 });
    this.nodes[b].ways.push({ way: w.id, end: 1 });
    return w.id;
  }

  /** A walkway straight across a road at s, from one side's node to the other's. */
  crossWay(kind: "zebra" | "crossing", road: string, s: number, fromSide: 1 | -1, a: number, b: number, width: number): number {
    const r = this.roads.roads.get(road)!;
    const line: P3[] = [
      this.nodes[a].at3, beside(this.roads, road, s, fromSide * kerbOffset(r.spec, fromSide)),
      beside(this.roads, road, s, -fromSide * kerbOffset(r.spec, (-fromSide) as 1 | -1)), this.nodes[b].at3,
    ];
    return this.way(kind, road, line, a, b, width, "paved");
  }
}

/**
 * Sidewalks at road nodes. Each leg's sidewalks end where the corner to the next
 * leg begins; corners join one leg's sidewalk to its neighbour's, straight along the
 * kerbs to a square turn (inside the corner or round its outside); at junctions,
 * people cross each leg a car's length behind where cars wait. Returns where every
 * sidewalk piece runs.
 */
function roadJunctions(g: GraphBuilder, roads: RoadNet) {
  type LegEnd = { node: number; s: number } | null;
  // Per road side: piece boundaries (start of a piece going +s at a leg with dir +1, end at a leg with dir −1).
  const bounds = new Map<string, Array<{ s: number; node: number; start: boolean }>>();
  const key = (road: string, side: number) => `${road}|${side}`;
  const addBound = (road: string, side: number, s: number, node: number, start: boolean) => {
    if (!bounds.has(key(road, side))) bounds.set(key(road, side), []);
    bounds.get(key(road, side))!.push({ s, node, start });
  };
  const nextNodeDist = (road: string, s: number, dir: 1 | -1): number => {
    const r = roads.roads.get(road)!;
    let best = Infinity;
    for (const x of roads.stops.get(road)!) {
      let d = (x.s - s) * dir;
      if (r.path.closed) d = mod(d, r.path.length) || r.path.length;
      if (d > 1e-6 && d < best) best = d;
    }
    return best;
  };

  for (const n of roads.nodes) {
    const legs = sortedLegs(roads, n);
    const m = legs.length;
    const sw = (k: number, legSide: 1 | -1) => sidewalkWidth(legs[k].r.spec, (legSide * legs[k].l.dir) as 1 | -1);
    const offset = (k: number, legSide: 1 | -1) =>
      kerbOffset(legs[k].r.spec, (legSide * legs[k].l.dir) as 1 | -1) + (sw(k, legSide) > 0 ? sw(k, legSide) / 2 : 1);
    // Corner between leg k (its left) and the next leg counter-clockwise (its right): where
    // their sidewalks' centre lines meet, in front of the node or (round the outside of a bend) behind it.
    const tLeft = new Array<number>(m).fill(0);
    const tRight = new Array<number>(m).fill(0);
    const corner: Array<{ at: V2; t: number; t2: number } | null> = new Array(m).fill(null);
    if (m >= 2) {
      for (let k = 0; k < m; k++) {
        const j = (k + 1) % m;
        const hit = legCorner(n.at, legs[k], offset(k, 1), legs[j], offset(j, -1));
        if (!hit) continue;
        tLeft[k] = Math.min(Math.max(hit.t, 0), CUT_MAX);
        tRight[j] = Math.min(Math.max(hit.t2, 0), CUT_MAX);
        corner[k] = hit;
      }
    }
    // Each leg's cut: both its sidewalks end at the same distance, a car's length behind the stop line at junctions.
    const cut = legs.map((L, k) => {
      if (m === 1) return 0;
      const c = Math.max(tLeft[k], tRight[k]);
      let v = c > 0 ? c + CORNER_RUN : 0;
      if (m >= 3 && sw(k, 1) > 0 && sw(k, -1) > 0) v = Math.max(v, junctionStop(roads, n, L.i) + CROSS_BACK);
      return Math.min(v, Math.max(0, nextNodeDist(L.l.road, L.l.s, L.l.dir) / 2 - 1));
    });
    // Sidewalk ends at each leg (left and right of the leg's heading).
    const endsAt: Array<[LegEnd, LegEnd]> = legs.map((L, k) => {
      const pair: LegEnd[] = [];
      for (const legSide of [1, -1] as const) {
        if (sw(k, legSide) <= 0) { pair.push(null); continue; }
        const r = L.r;
        const roadSide = (legSide * L.l.dir) as 1 | -1;
        const len = r.path.length;
        const sRaw = L.l.s + L.l.dir * cut[k];
        const s = r.path.closed ? mod(sRaw, len) : Math.min(Math.max(sRaw, 0), len);
        const node = g.node(beside(roads, r.id, s, roadSide * (kerbOffset(r.spec, roadSide) + sw(k, legSide) / 2), KERB));
        // The piece runs away from the node along the leg: it starts here for dir +1 and ends here for dir −1.
        addBound(r.id, roadSide, s, node, L.l.dir > 0);
        pair.push({ node, s });
      }
      return pair as [LegEnd, LegEnd];
    });
    if (m === 1) continue;
    // Corners.
    for (let k = 0; k < m; k++) {
      const j = (k + 1) % m;
      const e1 = endsAt[k][0];
      const e2 = endsAt[j][1];
      if (!e1 || !e2) continue;
      const p1 = g.nodes[e1.node].at3;
      const p2 = g.nodes[e2.node].at3;
      // Straight along leg k's kerb to the corner, then straight out along leg j's; or straight
      // across where the legs run on in line (or the corner lies past a sidewalk's end).
      const hit = corner[k];
      const turn = hit && hit.t <= cut[k] + 1e-6 && hit.t2 <= cut[j] + 1e-6 ? [hit.at] : [];
      const plan: V2[] = [[p1[0], p1[1]], ...turn, [p2[0], p2[1]]];
      const total = plan.slice(1).reduce((a, q, i) => a + dist2(plan[i], q), 0);
      const line: P3[] = [p1];
      let run = 0;
      for (let i = 0; i + 1 < plan.length; i++) {
        const [a, b] = [plan[i], plan[i + 1]];
        const len = dist2(a, b);
        const N = Math.ceil(len / SAMPLE);
        for (let q = 1; q <= N; q++) {
          const f = q / N;
          const z = p1[2] + (p2[2] - p1[2]) * (total > 0 ? (run + len * f) / total : 1);
          line.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, z]);
        }
        run += len;
      }
      g.way("corner", `${legs[k].l.road}/${legs[j].l.road}`, line, e1.node, e2.node, Math.min(sw(k, 1), sw(j, -1)), "paved");
    }
    // Crossings over each leg of a junction with sidewalks on both sides.
    if (m >= 3) {
      for (let k = 0; k < m; k++) {
        const [left, right] = endsAt[k];
        if (!left || !right || cut[k] < junctionStop(roads, n, legs[k].i) + 2) continue;
        const roadSide = legs[k].l.dir as 1 | -1;              // the leg's left side, in the road's terms
        const way = g.crossWay("crossing", legs[k].l.road, left.s, roadSide, left.node, right.node, CROSSING_WIDTH);
        const [x, y] = pointAt(legs[k].r.path, left.s);
        g.legCrossings.push({ road: legs[k].l.road, roadS: left.s, way, at: [x, y] });
      }
    }
  }

  const cache = new Map<string, Array<{ s0: number; s1: number; a: number; b: number }>>();
  return {
    /** Sidewalk pieces of one road side: s0 → s1 (s1 may pass the end of a loop) with their end nodes. */
    pieces(road: string, side: 1 | -1): Array<{ s0: number; s1: number; a: number; b: number }> {
      const k = key(road, side);
      if (!cache.has(k)) cache.set(k, this.compute(road, side));
      return cache.get(k)!;
    },
    compute(road: string, side: 1 | -1): Array<{ s0: number; s1: number; a: number; b: number }> {
      const r = roads.roads.get(road)!;
      const L = r.path.length;
      const list = (bounds.get(key(road, side)) ?? []).slice().sort((a, b) => a.s - b.s);
      if (!list.length) {
        if (!r.path.closed) return [];
        const node = g.node(beside(roads, road, 0, side * (kerbOffset(r.spec, side) + sidewalkWidth(r.spec, side) / 2), KERB));
        return [{ s0: 0, s1: L, a: node, b: node }];
      }
      const out: Array<{ s0: number; s1: number; a: number; b: number }> = [];
      list.forEach((b0, k) => {
        if (!b0.start) return;
        // The next boundary along +s that ends a piece.
        for (let step = 1; step <= list.length; step++) {
          const idx = k + step;
          if (!r.path.closed && idx >= list.length) break;
          const b1 = list[idx % list.length];
          if (b1.start) continue;
          const s1 = idx >= list.length ? b1.s + L : b1.s;
          if (s1 > b0.s + 0.2) out.push({ s0: b0.s, s1, a: b0.node, b: b1.node });
          break;
        }
      });
      return out;
    },
    /** A node to join at s if s lies in a junction's cut (the nearest piece end), else null. */
    snap(road: string, side: 1 | -1, s: number): number | null {
      const ps = this.pieces(road, side);
      const L = roads.roads.get(road)!.path.length;
      const inPiece = ps.some((p) => (s > p.s0 && s < p.s1) || (s + L > p.s0 && s + L < p.s1));
      if (inPiece) return null;
      let best: number | null = null;
      let bd = Infinity;
      for (const b of bounds.get(key(road, side)) ?? []) {
        const d = Math.abs(b.s - s);
        if (d < bd) { bd = d; best = b.node; }
      }
      return best;
    },
    /** The s-ranges of all sidewalk pieces along a road (for zebra checks). */
    pieceRanges(road: string): Array<[number, number]> {
      const out: Array<[number, number]> = [];
      for (const side of [1, -1]) {
        for (const p of this.pieces(road, side as 1 | -1)) out.push([p.s0, p.s1]);
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------------------

/** Bounds, clearances, and where zebras and foot crossings may go. */
function checkWalks(
  ctx: Ctx, net: WalkNet, zebras: Array<{ path: string; road: string; roadS: number; at: V2; angle: number }>,
  cuts: ReturnType<typeof roadJunctions>, joins: Array<{ path: string; road: string; at: V2 }>,
): Issue[] {
  const issues: Issue[] = [];
  const [W, H] = ctx.layout.terrain.size;
  const { roads } = ctx;
  const path = (id: string) => net.paths.get(id)!;
  for (const p of net.paths.values()) {
    for (const s of sampleS(p.path, POINT_STEP)) {
      const [x, y] = pointAt(p.path, s);
      if ((x < BOUNDS_MARGIN || y < BOUNDS_MARGIN || x > W - BOUNDS_MARGIN || y > H - BOUNDS_MARGIN) && !offEdge(ctx.layout.terrain.size, p, s, BOUNDS_MARGIN)) {
        issues.push(error("OUT_OF_BOUNDS", `path '${p.id}' leaves the terrain around (${x.toFixed(0)}, ${y.toFixed(0)}); keep paths ${BOUNDS_MARGIN} m inside, or end the path on the edge to let it leave the board`, `paths[${p.index}].points`, [x, y]));
        break;
      }
    }
  }

  // Foot crossings follow the level-crossing rules.
  for (const c of net.footCrossings) {
    const where = `paths[${path(c.road).index}]`;
    const span = structureAt(ctx.trackSpans.get(c.track)!, c.trackS);
    const station = ctx.layout.stations.find((st) => st.track === c.track && Math.abs(st.at - c.trackS) < st.length / 2 + 5);
    const turnout = ctx.junctions.find((j) => Math.hypot(j.at[0] - c.at[0], j.at[1] - c.at[1]) < TURNOUT_CLEAR);
    const why = span !== "ground" ? `track '${c.track}' is in a ${span} there`
      : station ? `it is on the platform of station '${station.id}'`
        : turnout ? `it is within ${TURNOUT_CLEAR} m of the railway junction ${turnout.id}` : null;
    if (why) issues.push(error("LEVEL_CROSSING_POSITION", `path '${c.road}' crosses track '${c.track}' at grade near (${c.at[0].toFixed(0)}, ${c.at[1].toFixed(0)}) but ${why}; move the crossing or take the path over or under the line`, where, c.at));
    if (c.angle < SHALLOWEST_CROSSING) {
      issues.push(error("LEVEL_CROSSING_ANGLE", `path '${c.road}' crosses track '${c.track}' at only ${c.angle.toFixed(0)}°; a foot crossing needs at least ${SHALLOWEST_CROSSING}° (aim for ${MIN_CROSSING_ANGLE}° or more, ideally square), or take the path over or under the line`, where, c.at));
    } else if (c.angle < MIN_CROSSING_ANGLE) {
      issues.push(warning("LEVEL_CROSSING_ANGLE", `path '${c.road}' crosses track '${c.track}' at only ${c.angle.toFixed(0)}°; aim for at least ${MIN_CROSSING_ANGLE}° (ideally square)`, where, c.at));
    }
  }

  // Zebras: away from junctions and level crossings.
  for (const z of zebras) {
    const where = `paths[${path(z.path).index}]`;
    const r = roads.roads.get(z.road)!;
    const L = r.path.length;
    const pieces = cuts.pieceRanges(z.road);
    const inside = (s: number) => pieces.some(([a, b]) => (s >= a && s <= b) || (s + L >= a && s + L <= b));
    const hasSidewalk = sidewalkWidth(r.spec, 1) + sidewalkWidth(r.spec, -1) > 0;
    // Clear of junctions (beyond their sidewalk corners, or 15 m without sidewalks) and of road ends, where cars turn.
    const nodeNear = roads.stops.get(z.road)!.find((x) => {
      const d = Math.abs(r.path.closed ? Math.min(Math.abs(x.s - z.roadS), L - Math.abs(x.s - z.roadS)) : x.s - z.roadS);
      return roads.nodes[x.node].legs.length === 1 ? d < ZEBRA_END_CLEAR : d < (hasSidewalk ? 0 : 15);
    });
    const clearOfCorners = !hasSidewalk || (inside(z.roadS - ZEBRA_JUNCTION_CLEAR) && inside(z.roadS + ZEBRA_JUNCTION_CLEAR));
    if (nodeNear || !clearOfCorners) {
      issues.push(error("PATH_CONFLICT", `path '${z.path}' crosses road '${z.road}' too close to a road junction or the road's end near (${z.at[0].toFixed(0)}, ${z.at[1].toFixed(0)}); cross further from it, or end the path on the sidewalk and let people use the junction's crossings`, where, z.at));
    }
    const level = roads.crossings.find((c) => c.road === z.road && Math.abs(c.roadS - z.roadS) < c.zone + ZEBRA_LEVEL_CLEAR);
    if (level) issues.push(error("PATH_CONFLICT", `path '${z.path}' crosses road '${z.road}' right beside the level crossing ${level.id}; move the zebra crossing ${ZEBRA_LEVEL_CLEAR} m or more away from it`, where, z.at));
  }

  // Clearances: paths beside tracks and roads, and paths over each other, away from their crossings.
  const trackHash = new SpatialHash<{ track: string; x: number; y: number; z: number }>(10);
  for (const t of ctx.tracks.values()) {
    for (const s of sampleS(t.path, POINT_STEP)) {
      const [x, y] = pointAt(t.path, s);
      trackHash.insert(x, y, { track: t.id, x, y, z: profileZ(ctx.trackProfiles.get(t.id)!, s) });
    }
  }
  const reported = new Set<string>();
  const report = (k: string, issue: Issue) => { if (!reported.has(k)) { reported.add(k); issues.push(issue); } };
  const sharedNode = (a: string, b: string, x: number, y: number) => net.nodes.some((n) => Math.hypot(n.at[0] - x, n.at[1] - y) < SHARED_NODE
    && n.ways.some((w) => net.ways[w.way].owner === a) && n.ways.some((w) => net.ways[w.way].owner === b));
  for (const pt of net.points) {
    if (pt.kind !== "path") continue;
    const p = path(pt.owner);
    const where = `paths[${p.index}]`;
    const gap = pt.width / 2 + 2.5;
    trackHash.near(pt.x, pt.y, gap, (q) => {
      if (Math.hypot(pt.x - q.x, pt.y - q.y) >= gap || Math.abs(pt.z - q.z) >= RAIL_CLEAR) return;
      if (net.footCrossings.some((c) => c.road === pt.owner && Math.hypot(c.at[0] - pt.x, c.at[1] - pt.y) < c.zone + pt.width + 3)) return;
      report(`${pt.owner}|${q.track}`, error("PATH_CONFLICT", `path '${pt.owner}' runs within ${Math.hypot(pt.x - q.x, pt.y - q.y).toFixed(1)} m of track '${q.track}' near (${pt.x.toFixed(0)}, ${pt.y.toFixed(0)}); keep paths ${gap.toFixed(1)} m from track centres or cross at a foot crossing`, where, [pt.x, pt.y]));
    });
    roads.hash.near(pt.x, pt.y, 20, (q) => {
      const need = q.reach + pt.width / 2 + 0.2;
      if (Math.hypot(pt.x - q.x, pt.y - q.y) >= need || Math.abs(pt.z - q.z) >= ROAD_CLEAR) return;
      if (zebras.some((z) => z.path === pt.owner && z.road === q.road && Math.hypot(z.at[0] - pt.x, z.at[1] - pt.y) < 2 * q.reach + 8)) return;
      if (sharedNode(pt.owner, q.road, pt.x, pt.y)) return;
      if (joins.some((j) => j.path === pt.owner && j.road === q.road && Math.hypot(j.at[0] - pt.x, j.at[1] - pt.y) < q.reach + 6)) return;
      report(`${pt.owner}|${q.road}`, error("PATH_CONFLICT", `path '${pt.owner}' runs along road '${q.road}' near (${pt.x.toFixed(0)}, ${pt.y.toFixed(0)}) without crossing or joining it; keep it ${need.toFixed(1)} m from the road's centre, cross it, or end it on the sidewalk`, where, [pt.x, pt.y]));
    });
    net.hash.near(pt.x, pt.y, 8, (q) => {
      if (q.kind !== "path" || q.owner <= pt.owner) return;
      const need = (pt.width + q.width) / 2 + 0.3;
      if (Math.hypot(pt.x - q.x, pt.y - q.y) >= need || Math.abs(pt.z - q.z) >= PATH_CLEAR) return;
      if (sharedNode(pt.owner, q.owner, pt.x, pt.y)) return;
      report(`${pt.owner}|${q.owner}`, error("PATH_CONFLICT", `paths '${pt.owner}' and '${q.owner}' overlap near (${pt.x.toFixed(0)}, ${pt.y.toFixed(0)}) without meeting; move them apart, cross them, or join one to the other with from/to`, `paths[${path(q.owner).index}]`, [pt.x, pt.y]));
    });
  }
  return issues;
}

/** Whether a placed object of this footprint may stand on walkways (small things only). */
export const smallEnough = (hx: number, hy: number) => 2 * Math.max(hx, hy) <= SMALL;
