// Roads: a second network built like the track — waypoints filleted into lines and
// arcs, heights clamped to a grade, bridges and tunnels, terrain shaping — joined
// by T-junctions (from/to) and automatic crossroads, and meeting tracks at level
// crossings (or passing over/under them when far enough apart in height).

import type { Layout, RoadSpec } from "./schema";
import { waypoint } from "./schema";
import type { TrackGeom, Junction } from "./trackGraph";
import { type Path, makePath, filletPolyline, pointAt, headingAt, sampleS } from "./geometry";
import { type Profile, type Span, type Pin, buildProfile, classify, profileZ, structureAt, opensGround } from "./heights";
import { type Terrain, baseZ } from "./terrain";
import { type WaterNet, crossingFloor, crossingSurface } from "./water";
import { type Issue, error, warning } from "./validate";
import { EDGE_SNAP, offEdge } from "./exits";
import { SpatialHash } from "../util/spatial";
import { type V2, mod, wrapAngle, clamp } from "../util/vec";

const LEVEL_DZ = 3;              // m: road and track this close in height meet at grade
const RAIL_CLEAR = 6.5;          // m: height difference for a road to pass over or under a track
const ROAD_CLEAR = 5.5;          // m: same for a road over or under another road
export const CROSSING_ROAD_Z = 0.2; // road surface above track z at a level crossing (above sleepers, below rail tops)
const CROSSING_FLAT = 5;         // m either side of a level crossing held level
const CROSSING_GROUP_GAP = 15;   // m: level crossings closer than this along a road work as one
const TRACK_ZONE = 3;            // m either side of the track centre that cars must clear
const MIN_CROSSING_ANGLE = 30;   // degrees; shallower level crossings get a warning
export const SHALLOWEST_CROSSING = 15;   // degrees; shallower ones are an error (the crossing zone is not modelled)
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
/**
 * The paved area where roads meet (a junction, or a corner where one road runs on as
 * another): each leg is cut back to where its kerbs meet the neighbouring legs' kerbs,
 * and one surface fills the area inside. Kerbs run straight to sharp corners.
 */
export type JunctionArea = {
  node: number;
  legs: Array<{ leg: number; cut: number }>;              // counter-clockwise; leg indexes node.legs
  outline: Array<[number, number, number]>;               // the area, counter-clockwise: each leg's right and left kerb at its cut, then the corner to the next leg
  // The outline's outer edges, leg k's left kerb round to leg k+1's right; `out` is the
  // mitred outward direction at each point (point + out·d lies d metres outside).
  kerbs: Array<{ points: Array<[number, number, number]>; out: V2[]; sidewalk: boolean }>;
};
/** One set of lamps at a junction with traffic lights: for the traffic arriving along one leg. */
export type SignalHead = {
  leg: number;                   // node.legs index: the traffic arriving along this leg
  stopS: number;                 // s on the leg's road of the stop line
  post: [number, number, number]; // the pole, beyond the kerb on the arriving drivers' right
  facing: number;                // heading the lamps face (toward the arriving drivers)
  arm: number;                   // m a mast arm reaches out over the lanes from the pole (0: lamps on the pole only)
};
/**
 * Traffic lights at a junction: the legs in groups (opposite legs together, others
 * alone), each group green in turn, and a set of lamps for each leg.
 */
export type SignalGeom = { index: number; node: number; green: number; phases: number[][]; heads: SignalHead[] };
export type LevelCrossing = {
  id: string;
  kind: "road" | "path";         // a road (cars and its sidewalks) or a footpath crossing the line
  road: string; roadS: number;   // the road or path, and s along it
  width: number;                 // m across the whole crossing: carriageway and sidewalks, or the path
  track: string; trackS: number;
  at: V2; z: number;
  angle: number;                 // degrees between road and track (90 = square)
  zone: number;                  // half-length along the road that must be clear of cars when trains pass
  group: number;                 // index of the first crossing of its group: crossings close together on one road
                                 // (a road over double track) close and open together, with barriers only outside
};
export type RoadPoint = {
  road: string; s: number; x: number; y: number; z: number;
  heading: number;
  width: number;                 // paved width: carriageway and parking strips (twice the wider side)
  left: number; right: number;   // m from the centre to the kerb on each side (carriageway plus parking)
  reach: number;                 // half-width including parking and the wider sidewalk
  ground: boolean;               // the ground is shaped to it: on plain ground or just inside a tunnel mouth
  mouth: boolean;                // inside a tunnel mouth
};

export const PARKING_WIDTH = { parallel: 2.4, perpendicular: 5.2 } as const;

/** Width of a road's sidewalk on one side (+1 left, −1 right of increasing s), 0 if none. */
export function sidewalkWidth(spec: RoadSpec, side: 1 | -1): number {
  const has = spec.sidewalks === "both" || spec.sidewalks === (side > 0 ? "left" : "right");
  return has ? spec.sidewalkWidth : 0;
}

/** Width of a road's parking strip on one side, 0 if none. */
export function parkingWidth(spec: RoadSpec, side: 1 | -1): number {
  const has = spec.parking === "both" || spec.parking === (side > 0 ? "left" : "right");
  return has ? PARKING_WIDTH[spec.parkingStyle] : 0;
}

/** From the road's centre to the kerb on one side: the carriageway plus any parking strip. */
export const kerbOffset = (spec: RoadSpec, side: 1 | -1) => spec.width / 2 + parkingWidth(spec, side);

/** Width of one traffic lane. */
export const laneWidth = (spec: Pick<RoadSpec, "width" | "lanes">) => spec.width / (2 * spec.lanes);

/**
 * Offset along the road's left normal of the centre of lane `track` for traffic going
 * in direction `dir` (driving on the right): track 0 runs by the kerb, the last next
 * to the centre line.
 */
export const laneLateral = (spec: Pick<RoadSpec, "width" | "lanes">, dir: 1 | -1, track: number) =>
  -dir * laneWidth(spec) * (spec.lanes - track - 0.5);

export const LANE_MIN = 2.75;    // m: narrower lanes on a road of several lanes each way get a warning

/** Half-width of the paved road on its wider side (carriageway and parking). */
export const pavedHalf = (spec: RoadSpec) => Math.max(kerbOffset(spec, 1), kerbOffset(spec, -1));

/** Half-width of a road including parking and sidewalks, on its wider side. */
export const roadReach = (spec: RoadSpec) => Math.max(kerbOffset(spec, 1) + sidewalkWidth(spec, 1), kerbOffset(spec, -1) + sidewalkWidth(spec, -1));

/** Display name of a road or path: its `name`, or its id in title case. */
export const displayName = (spec: { id: string; name?: string }) =>
  spec.name ?? spec.id.split("-").map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");

/**
 * How far from a junction's centre cars on one leg stop: clear of every other road
 * there, further back when that road meets at an angle. Shared by traffic and the
 * pedestrian crossings placed just behind it.
 */
export function junctionStop(net: Pick<RoadNet, "roads">, n: RoadNode, legIndex: number): number {
  const leg = n.legs[legIndex];
  const road = net.roads.get(leg.road)!;
  const h = headingAt(road.path, leg.s) + (leg.dir < 0 ? Math.PI : 0);
  let box = 2;
  for (const o of n.legs) {
    if (o.road === leg.road) continue;
    const other = net.roads.get(o.road)!;
    const sin = Math.abs(Math.sin(headingAt(other.path, o.s) - h));
    box = Math.max(box, pavedHalf(other.spec) / Math.max(sin, 0.4) + 1.5);
  }
  return box;
}

const CUT_MAX = 16;              // m a junction area may cut a leg back at most
const OUTSIDE_MAX = 12;          // m behind the node an outside corner may reach

/** Each leg of a node, counter-clockwise by the heading it leaves along, with its kerb offsets (left and right of that heading). */
export function sortedLegs(net: Pick<RoadNet, "roads">, n: RoadNode) {
  return n.legs.map((l, i) => {
    const r = net.roads.get(l.road)!;
    const theta = headingAt(r.path, l.s) + (l.dir < 0 ? Math.PI : 0);
    return {
      l, i, r, theta, u: [Math.cos(theta), Math.sin(theta)] as V2, nrm: [-Math.sin(theta), Math.cos(theta)] as V2,
      left: kerbOffset(r.spec, l.dir), right: kerbOffset(r.spec, -l.dir as 1 | -1),
    };
  }).sort((a, b) => mod(a.theta, 2 * Math.PI) - mod(b.theta, 2 * Math.PI));
}

/**
 * Where two lines p + u·t and q + v·t2 meet, or null when (nearly) parallel.
 */
export function meet(p: V2, u: V2, q: V2, v: V2): { t: number; t2: number; at: V2 } | null {
  const det = -u[0] * v[1] + v[0] * u[1];
  if (Math.abs(det) < 1e-6) return null;
  const [dx, dy] = [q[0] - p[0], q[1] - p[1]];
  const t = (-dx * v[1] + v[0] * dy) / det;
  const t2 = (u[0] * dy - dx * u[1]) / det;
  return { t, t2, at: [p[0] + u[0] * t, p[1] + u[1] * t] };
}

/**
 * The corner between leg A's left side and leg B's (the next counter-clockwise) right
 * side, for lines `oa` and `ob` out from the centre line: the point where they meet,
 * at t along A and t2 along B (negative behind the node: the outside of a bend), or
 * null where they run on in line or meet too far away to draw.
 */
export function legCorner(at: V2, A: { theta: number; u: V2; nrm: V2 }, oa: number, B: { theta: number; u: V2; nrm: V2 }, ob: number) {
  const phi = mod(B.theta - A.theta, 2 * Math.PI);
  if (phi < 1e-3) return null;
  const hit = meet([at[0] + A.nrm[0] * oa, at[1] + A.nrm[1] * oa], A.u, [at[0] - B.nrm[0] * ob, at[1] - B.nrm[1] * ob], B.u);
  if (!hit || Math.max(hit.t, hit.t2) > CUT_MAX || Math.min(hit.t, hit.t2) < -OUTSIDE_MAX) return null;
  return hit;
}

/** The offset direction where edges with outward normals a and b meet: a line d out from each passes through d·miter. */
export function miter(a: V2, b: V2): V2 {
  const k = Math.max(1 + a[0] * b[0] + a[1] * b[1], 0.25);
  return [(a[0] + b[0]) / k, (a[1] + b[1]) / k];
}

/** The paved area of a node with two or more legs, or null where the roads simply run on into each other. */
function junctionArea(net: Pick<RoadNet, "roads" | "profiles" | "stops">, n: RoadNode): JunctionArea | null {
  const legs = sortedLegs(net, n);
  const m = legs.length;
  const z = legs.reduce((a, L) => a + profileZ(net.profiles.get(L.l.road)!, L.l.s), 0) / m;
  const need = new Array<number>(m).fill(0);
  const corners = legs.map((A, k) => {
    const j = (k + 1) % m;
    const hit = legCorner(n.at, A, A.left, legs[j], legs[j].right);
    if (!hit) return [];
    need[k] = Math.max(need[k], hit.t);
    need[j] = Math.max(need[j], hit.t2);
    return [hit.at];
  });
  const cut = legs.map((L, k) => {
    const next = nextNode(net, L.r, L.l.s, L.l.dir);
    const room = next ? next.dist / 2 - 0.5 : L.l.dir > 0 ? L.r.path.length - L.l.s : L.l.s;
    return Math.max(0, Math.min(need[k], CUT_MAX, room));
  });
  // A point `lat` left of leg k's heading where it is cut, and the left normal there.
  const edge = (k: number, lat: number): { p: [number, number, number]; nrm: V2 } => {
    const L = legs[k];
    const len = L.r.path.length;
    const raw = L.l.s + L.l.dir * cut[k];
    const s = L.r.path.closed ? mod(raw, len) : Math.min(Math.max(raw, 0), len);
    const [x, y] = pointAt(L.r.path, s);
    const h = headingAt(L.r.path, s) + (L.l.dir < 0 ? Math.PI : 0);
    return { p: [x - Math.sin(h) * lat, y + Math.cos(h) * lat, profileZ(net.profiles.get(L.l.road)!, s)], nrm: [-Math.sin(h), Math.cos(h)] };
  };
  const outline: Array<[number, number, number]> = [];
  const kerbs: JunctionArea["kerbs"] = [];
  for (let k = 0; k < m; k++) {
    const j = (k + 1) % m;
    const [right, left, next] = [edge(k, -legs[k].right), edge(k, legs[k].left), edge(j, -legs[j].right)];
    outline.push(right.p, left.p);
    const mid = corners[k].map((c): [number, number, number] => [c[0], c[1], z]);
    outline.push(...mid);
    // Outward: left of leg k along its kerb, right of leg j along its kerb, mitred at the corner.
    const out: V2[] = [left.nrm, ...mid.map(() => miter(legs[k].nrm, [-legs[j].nrm[0], -legs[j].nrm[1]])), [-next.nrm[0], -next.nrm[1]]];
    const sidewalk = sidewalkWidth(legs[k].r.spec, legs[k].l.dir) > 0 || sidewalkWidth(legs[j].r.spec, -legs[j].l.dir as 1 | -1) > 0;
    kerbs.push({ points: [left.p, ...mid, next.p], out, sidewalk });
  }
  let area = 0;
  for (let i = 0; i < outline.length; i++) {
    const [a, b] = [outline[i], outline[(i + 1) % outline.length]];
    area += a[0] * b[1] - b[0] * a[1];
  }
  if (area / 2 < 0.5) return null;
  return { node: n.id, legs: legs.map((L, k) => ({ leg: L.i, cut: cut[k] })), outline, kerbs };
}

const DEAD_END_TURN = 6;         // m of road a car uses to turn round at a dead end

/** Whether a node is a road's end on the board's edge, where the road leads off the board (see model/exits.ts). */
export function isPortal(n: RoadNode, size: readonly [number, number]): boolean {
  return n.legs.length === 1 && Math.min(n.at[0], n.at[1], size[0] - n.at[0], size[1] - n.at[1]) <= EDGE_SNAP + 1e-6;
}

/** The next node along a road from s in direction dir (wrapping on loops), not counting s itself. */
export function nextNode(net: Pick<RoadNet, "stops">, road: RoadGeom, s: number, dir: 1 | -1): { node: number; s: number; dist: number } | null {
  const list = net.stops.get(road.id)!;
  const L = road.path.length;
  let best: { node: number; s: number; dist: number } | null = null;
  for (const x of list) {
    let dist = (x.s - s) * dir;
    if (road.path.closed) dist = mod(dist, L);
    if (dist <= 1e-6 && road.path.closed) dist += L;
    if (dist <= 1e-6) continue;
    if (!best || dist < best.dist) best = { node: x.node, s: x.s, dist };
  }
  return best;
}

/**
 * One direction of a road between two nodes: the stretch a lane of traffic drives.
 * `s` is the start node's s and `dist` the road distance to the end node; the lane
 * itself leaves `box0` after the start node and stops `box1` before the end one
 * (the junction areas, or room to turn round at a dead end). A loop road without
 * nodes has one lane each way that runs into itself (`end` null, no boxes). `next`
 * holds the lanes a vehicle may take at the end: any but straight back, unless
 * that is all there is.
 */
export type LaneTopo = {
  key: string; road: string; dir: 1 | -1; s: number; dist: number; end: number | null; box0: number; box1: number; next: string[];
};

/** Every lane of the road network, in a fixed order (the traffic sim's lanes are built from these). */
export function laneTopology(net: RoadNet, size: readonly [number, number]): LaneTopo[] {
  const nodeBox = (n: RoadNode, legIndex: number): number => {
    const leg = n.legs[legIndex];
    const road = net.roads.get(leg.road)!;
    let box: number;
    if (n.legs.length === 1) box = isPortal(n, size) ? 0 : DEAD_END_TURN;
    else if (n.legs.length === 2) box = 1;
    else box = junctionStop(net, n, legIndex);
    // Never more than half way to the next node along this leg.
    const next = nextNode(net, road, leg.s, leg.dir);
    if (next) box = Math.min(box, Math.max(0, next.dist / 2 - 0.5));
    return box;
  };
  const out: LaneTopo[] = [];
  const byKey = new Map<string, LaneTopo>();
  net.nodes.forEach((n) => {
    n.legs.forEach((leg, li) => {
      const road = net.roads.get(leg.road)!;
      const next = nextNode(net, road, leg.s, leg.dir);
      if (!next) return;
      const m = net.nodes[next.node];
      const back = m.legs.findIndex((l) => l.road === leg.road && l.dir === -leg.dir && Math.abs(mod(l.s - next.s + 1, road.path.length || Infinity) - 1) < 1e-3);
      const t: LaneTopo = {
        key: `${n.id}|${li}`, road: leg.road, dir: leg.dir, s: leg.s, dist: next.dist, end: next.node,
        box0: nodeBox(n, li), box1: back >= 0 ? nodeBox(m, back) : 0, next: [],
      };
      out.push(t);
      byKey.set(t.key, t);
    });
  });
  for (const road of net.roads.values()) {
    if (!road.path.closed || net.stops.get(road.id)!.length) continue;
    for (const dir of [1, -1] as const) {
      const key = `loop|${road.id}|${dir}`;
      out.push({ key, road: road.id, dir, s: dir > 0 ? 0 : road.path.length, dist: road.path.length, end: null, box0: 0, box1: 0, next: [key] });
    }
  }
  for (const t of out) {
    if (t.end === null) continue;
    const n = net.nodes[t.end];
    const L = net.roads.get(t.road)!.path.length;
    const endS = net.roads.get(t.road)!.path.closed ? mod(t.s + t.dir * t.dist, L) : t.s + t.dir * t.dist;
    const outs = n.legs.map((leg, li) => ({ leg, key: `${n.id}|${li}` })).filter((o) => byKey.has(o.key));
    const reverse = (o: (typeof outs)[number]) => o.leg.road === t.road && o.leg.dir === -t.dir && Math.abs(mod(o.leg.s - endS + 1, L || Infinity) - 1) < 0.5;
    const forward = outs.filter((o) => !reverse(o));
    t.next = (forward.length ? forward : outs).map((o) => o.key);
  }
  return out;
}

export type RoadNet = {
  roads: Map<string, RoadGeom>;
  order: string[];
  profiles: Map<string, Profile>;
  spans: Map<string, Span[]>;
  nodes: RoadNode[];
  stops: Map<string, Array<{ s: number; node: number }>>;   // nodes along each road, by s
  crossings: LevelCrossing[];
  junctions: JunctionArea[];
  signals: SignalGeom[];                                   // traffic lights, in the layout's order
  trims: Map<string, Array<[number, number]>>;              // s-ranges inside a junction area, which draws them
  points: RoadPoint[];
  hash: SpatialHash<RoadPoint>;
};

export const emptyRoadNet = (): RoadNet => ({
  roads: new Map(), order: [], profiles: new Map(), spans: new Map(), nodes: [], stops: new Map(), crossings: [],
  junctions: [], signals: [], trims: new Map(), points: [], hash: new SpatialHash<RoadPoint>(10),
});

type Ctx = {
  layout: Layout;
  tracks: Map<string, TrackGeom>;
  trackProfiles: Map<string, Profile>;
  trackSpans: Map<string, Span[]>;
  junctions: Junction[];
  terrain: Terrain;
  water?: WaterNet;
};

// ---------------------------------------------------------------------------

/** Polyline of a path sampled every ~1 m, for intersection tests. */
export type Poly = { s: number[]; x: number[]; y: number[] };
export function polyline(path: Path): Poly {
  const s = sampleS(path, 1);
  if (path.closed) s.push(path.length);
  const pts = s.map((v) => pointAt(path, v));
  return { s, x: pts.map((p) => p[0]), y: pts.map((p) => p[1]) };
}

/** Where two polylines cross: s on each and the point. Segments of b are hashed for speed. */
export function intersections(a: Poly, b: Poly): Array<{ sa: number; sb: number; at: V2 }> {
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

/** s on the parent of a from/to end ("start" and "end" resolved). */
export const endAt = (e: { at: number | "start" | "end" }, parent: { path: Path }) =>
  e.at === "start" ? 0 : e.at === "end" ? parent.path.length : e.at;

export const crossAngle = (h1: number, h2: number) => {
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
          crossings.push({
            id: n ? `${id}#${n + 1}` : id, kind: "road", group: crossings.length, road: r.id, roadS: x.sa, width: 2 * roadReach(r.spec),
            track: t.id, trackS: x.sb, at: x.at, z: tz, angle, zone,
          });
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
      const half = pavedHalf(parent.spec);
      pins.push({ s: k === 0 ? 0 : L, z }, { s: k === 0 ? Math.min(L, half) : Math.max(0, L - half), z });
    }
    for (const c of crossings) if (c.road === id) flat(c.roadS, CROSSING_FLAT, c.z + CROSSING_ROAD_Z);
    for (const c of crossroads) {
      const [mine, other, otherS] = c.a === id ? [c.sa, c.b, c.sb] : c.b === id ? [c.sb, c.a, c.sa] : [NaN, "", 0];
      if (Number.isNaN(mine) || rank.get(other)! > rank.get(id)!) continue;
      flat(mine, pavedHalf(roads.get(other)!.spec), profileZ(profiles.get(other)!, otherS));
    }
    const { profile, issues: grade } = buildProfile(r, dry, pins, { window: ROAD_SMOOTH, noun: "road", follow: true, floor: crossingFloor(ctx.water) });
    for (const g of grade) issues.push(error("GRADE_EXCEEDED", g.message, `roads[${r.index}]`, pointAt(r.path, g.s0)));
    profiles.set(id, profile);
    spans.set(id, classify(r, profile, base, crossingSurface(ctx.water)));
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

  // 5. Junction areas, and the stretch of each road they cover.
  const junctions: JunctionArea[] = [];
  const trims = new Map<string, Array<[number, number]>>([...roads.keys()].map((id) => [id, []]));
  for (const n of nodes) {
    if (n.legs.length < 2) continue;
    const area = junctionArea({ roads, profiles, stops }, n);
    if (!area) continue;
    junctions.push(area);
    for (const a of area.legs) {
      const l = n.legs[a.leg];
      const r = roads.get(l.road)!;
      const L = r.path.length;
      const [s0, s1] = l.dir > 0 ? [l.s, l.s + a.cut] : [l.s - a.cut, l.s];
      const list = trims.get(l.road)!;
      // Ranges stay within [0, L]; on a loop, one that wraps is split in two.
      if (s0 < 0 && r.path.closed) list.push([0, s1], [L + s0, L]);
      else if (s1 > L && r.path.closed) list.push([s0, L], [0, s1 - L]);
      else list.push([Math.max(0, s0), Math.min(L, s1)]);
    }
  }

  // 6. Dense points for shaping, conflicts, bounds and scenery checks.
  const points: RoadPoint[] = [];
  for (const r of roads.values()) {
    for (const s of sampleS(r.path, POINT_STEP)) {
      const [x, y] = pointAt(r.path, s);
      points.push({
        road: r.id, s, x, y, z: profileZ(profiles.get(r.id)!, s), heading: headingAt(r.path, s), width: 2 * pavedHalf(r.spec),
        left: kerbOffset(r.spec, 1), right: kerbOffset(r.spec, -1), reach: roadReach(r.spec),
        ground: opensGround(spans.get(r.id)!, r.path.closed, s), mouth: structureAt(spans.get(r.id)!, s) === "tunnel",
      });
    }
  }
  const hash = new SpatialHash<RoadPoint>(10);
  for (const p of points) hash.insert(p.x, p.y, p);
  const net: RoadNet = { roads, order, profiles, spans, nodes, stops, crossings, junctions, signals: [], trims, points, hash };
  const sig = buildSignals(layout, net);
  net.signals = sig.signals;
  issues.push(...sig.issues);
  issues.push(...checkRoads(ctx, net));
  return { net, issues };
}

/** Just the roads' paths, parents first (no heights or checks): for placing things beside roads. */
export function roadGeometry(roads: RoadSpec[]): Map<string, RoadGeom> {
  const out = new Map<string, RoadGeom>();
  const { order, cycle } = roadOrder(roads);
  if (cycle) return out;
  for (const id of order) {
    const index = roads.findIndex((r) => r.id === id);
    const road = buildRoadPath(roads[index], index, out, []);
    if (road) out.set(id, road);
  }
  return out;
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
const SIGNAL_REACH = 15;          // m from a traffic lights entry to the junction it belongs to
const OPPOSITE = (40 * Math.PI) / 180;   // legs this close to straight across each other share a green

/** Traffic lights: the junction each entry belongs to, its groups of legs and where its lamps stand. */
function buildSignals(layout: Layout, net: RoadNet): { signals: SignalGeom[]; issues: Issue[] } {
  const signals: SignalGeom[] = [];
  const issues: Issue[] = [];
  layout.trafficLights.forEach((spec, index) => {
    const where = `trafficLights[${index}].at`;
    let best: RoadNode | null = null;
    let bd = Infinity;
    for (const n of net.nodes) {
      const d = Math.hypot(n.at[0] - spec.at[0], n.at[1] - spec.at[1]);
      if (n.legs.length >= 3 && d < bd) { bd = d; best = n; }
    }
    if (!best || bd > SIGNAL_REACH) {
      const near = best ? `; the nearest is ${bd.toFixed(0)} m away at (${best.at[0].toFixed(0)}, ${best.at[1].toFixed(0)})` : "; there is none on the board";
      issues.push(error("SIGNAL_POSITION", `traffic lights at (${spec.at[0]}, ${spec.at[1]}) are not at a junction of three or more roads${near}; move them within ${SIGNAL_REACH} m of one`, where, spec.at));
      return;
    }
    const n = best;
    const other = signals.find((x) => x.node === n.id);
    if (other) {
      issues.push(error("SIGNAL_POSITION", `traffic lights at (${spec.at[0]}, ${spec.at[1]}) are at the same junction as trafficLights[${other.index}]; give each junction one entry`, where, spec.at));
      return;
    }
    // Opposite legs share a green; any other leg has one of its own.
    const legs = sortedLegs(net, n);
    const phases: number[][] = [];
    const used = new Set<number>();
    for (const a of legs) {
      if (used.has(a.i)) continue;
      used.add(a.i);
      let pair: (typeof legs)[number] | null = null;
      for (const b of legs) {
        if (used.has(b.i)) continue;
        const off = Math.abs(wrapAngle(a.theta - b.theta - Math.PI));
        if (off < OPPOSITE && (!pair || off < Math.abs(wrapAngle(a.theta - pair.theta - Math.PI)))) pair = b;
      }
      if (pair) used.add(pair.i);
      phases.push(pair ? [a.i, pair.i] : [a.i]);
    }
    // Lamps for each leg: at the stop line, on the arriving drivers' right; over the lanes too on a wide road.
    const heads: SignalHead[] = n.legs.map((leg, li) => {
      const road = net.roads.get(leg.road)!;
      const L = road.path.length;
      let stop = junctionStop(net, n, li);
      const next = nextNode(net, road, leg.s, leg.dir);
      if (next) stop = Math.min(stop, Math.max(0, next.dist / 2 - 0.5));
      const raw = leg.s + leg.dir * stop;
      const stopS = road.path.closed ? mod(raw, L) : clamp(raw, 0, L);
      const [x, y] = pointAt(road.path, stopS);
      const h = headingAt(road.path, stopS);
      const lat = leg.dir * (kerbOffset(road.spec, leg.dir) + 0.6);
      const z = profileZ(net.profiles.get(leg.road)!, stopS);
      const arm = road.spec.lanes > 1 ? Math.max(0, Math.abs(lat) - road.spec.width / 4) : 0;
      return { leg: li, stopS, post: [x - Math.sin(h) * lat, y + Math.cos(h) * lat, z], facing: h + (leg.dir < 0 ? Math.PI : 0), arm };
    });
    signals.push({ index, node: n.id, green: spec.green, phases, heads });
  });
  return { signals, issues };
}

function checkRoads(ctx: Ctx, net: RoadNet): Issue[] {
  const issues: Issue[] = [];
  const [W, H] = ctx.layout.terrain.size;
  const road = (id: string) => net.roads.get(id)!;
  for (const r of net.roads.values()) {
    const lw = laneWidth(r.spec);
    if (r.spec.lanes > 1 && lw < LANE_MIN - 1e-9) {
      issues.push(warning("ROAD_LANES", `road '${r.id}' has ${r.spec.lanes} lanes each way in ${r.spec.width} m, only ${lw.toFixed(2)} m a lane; give it a width of ${(6 * r.spec.lanes).toFixed(0)} m (3 m a lane) or fewer lanes`, `roads[${r.index}].width`));
    }
  }
  for (const r of net.roads.values()) {
    const out = net.points.find((p) => p.road === r.id && (p.x < BOUNDS_MARGIN || p.y < BOUNDS_MARGIN || p.x > W - BOUNDS_MARGIN || p.y > H - BOUNDS_MARGIN)
      && !offEdge(ctx.layout.terrain.size, r, p.s, BOUNDS_MARGIN));
    if (out) issues.push(error("OUT_OF_BOUNDS", `road '${r.id}' leaves the terrain around (${out.x.toFixed(0)}, ${out.y.toFixed(0)}); keep roads ${BOUNDS_MARGIN} m inside, or end the road on the edge to let it leave the board`, `roads[${r.index}].points`, [out.x, out.y]));
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
    if (c.angle < SHALLOWEST_CROSSING) {
      issues.push(error("LEVEL_CROSSING_ANGLE", `road '${c.road}' crosses track '${c.track}' at only ${c.angle.toFixed(0)}°; a level crossing needs at least ${SHALLOWEST_CROSSING}° (aim for ${MIN_CROSSING_ANGLE}° or more, ideally square), or take the road over or under the line`, path, c.at));
    } else if (c.angle < MIN_CROSSING_ANGLE) {
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
    const gap = Math.max(p.width / 2 + 2.5, p.reach + 1.5);
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
      const need = p.reach + q.reach + 0.5;
      if (Math.hypot(p.x - q.x, p.y - q.y) >= need || Math.abs(p.z - q.z) >= ROAD_CLEAR) return;
      const shared = net.nodes.some((n) => n.legs.some((l) => l.road === p.road) && n.legs.some((l) => l.road === q.road)
        && Math.hypot(n.at[0] - p.x, n.at[1] - p.y) < JUNCTION_IGNORE);
      if (shared) return;
      report(`${p.road}|${q.road}`, error("ROAD_CONFLICT", `roads '${p.road}' and '${q.road}' overlap near (${p.x.toFixed(0)}, ${p.y.toFixed(0)}) without meeting at a junction; move them apart, cross them, or join one to the other with from/to`, `roads[${road(q.road).index}]`, [p.x, p.y]));
    });
  }
  return issues;
}
