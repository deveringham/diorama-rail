// Bus stops and bus lines. A stop stands beside a road at s, on one side of it or
// both. Buses drive on the right, so a side is served by buses travelling with it on
// their right: the right side (−1) going toward increasing s, the left (+1) coming
// back. A bus stops in its lane with its front door by the stop's sign, and the
// traffic behind waits. A line calls at its stops in order, round and round (loop)
// or there and back (shuttle), taking the quickest way along the roads between them.
// Routes are found here over the network's lanes (the same ones the traffic sim
// drives), so a line that cannot be driven is reported when the layout is built.

import type { Layout, BusStopSpec } from "./schema";
import { type RoadNet, type LaneTopo, laneTopology, isPortal, displayName, kerbOffset, sidewalkWidth } from "./roads";
import type { WalkNet } from "./walks";
import { KERB } from "./walks";
import type { ObjectInfo } from "./scenery";
import { pointAt, headingAt } from "./geometry";
import { profileZ, structureAt } from "./heights";
import { type Issue, error, warning } from "./validate";
import { mod } from "../util/vec";

type P3 = [number, number, number];

export const FRONT_PAST = 2;           // m a stopped bus's front is beyond the stop's sign
export const DOOR_BACK = 1.6;          // m from a bus's front to its door
const BUS_SPEED = 0.7;                 // share of the speed limit a bus averages between stops
const JUNCTION_TIME = 3;               // s per junction passed
const STOP_TIME = 8;                   // s lost slowing for a stop and pulling away again
const AWAY_TIME = 10;                  // s off the board, turning round beyond its edge
const LANE_CLEAR = 3;                  // m a stopped bus keeps from the ends of its lane (a junction's area)
const END_CLEAR = 4;                   // m more before a dead end, where cars turn round
const CROSSING_CLEAR = 6;              // m from a level crossing's zone
const ZEBRA_CLEAR = 3;                 // m from a zebra or a crossing over a junction's leg
const STOP_GAP = 2;                    // m between buses stopped at neighbouring stops
const SEARCH = 200;                    // m either way to look for a better place for a stop
const TWIN_SLACK = 45;                 // s longer a shuttle's round may get for calling at both sides of a stop
const UNREACHABLE_PENALTY = 600;       // s a line would rather drive than call at a side nobody can walk to
const COLORS = ["#c8553d", "#4f6f9a", "#5f8a4e", "#d9a43a", "#7a5a9e", "#3a8f8f"];

/** One side of a stop: where buses going one way stop and their passengers wait. */
export type StopSide = {
  id: number;
  stop: number;                        // index into BusNet.stops
  side: 1 | -1;                        // left (+1) or right of increasing s
  dir: 1 | -1;                         // the way the buses serving it travel along the road
  lane: string;                        // the lane (topology key) a stopped bus stands in
  d: number;                           // where its front is, in road metres from the lane's start node
  s: number;                           // the sign's s
  heading: number;                     // the road's heading at the sign, the buses' way
  at: P3;                              // where people wait: on the sidewalk (or just off the road) by the sign
  sign: P3;                            // the sign post, at the kerb
  shelter: P3 | null;                  // a shelter behind the kerb (dropped later if something stands there)
  width: number;                       // m across the sidewalk people wait on (0: none)
  reach: number;                       // m of road behind the bus's front it takes (the longest bus calling)
};

export type BusStopGeom = { id: string; index: number; name: string; road: string; s: number; sides: number[] };

export type BusVisit = {
  side: number;                        // StopSide id
  t: number;                           // s after arriving at the first visit that a bus arrives here
  dist: number;                        // m along the line from the first visit
};

export type BusLineGeom = {
  id: string;
  index: number;
  name: string;
  color: string;
  vehicle: string;
  length: number;                      // m, the bus
  mode: "shuttle" | "loop";
  count: number;
  dwell: number;
  capacity: number;
  visits: BusVisit[];                  // in calling order; after the last, back to the first
  legs: string[][];                    // lane keys from each visit's lane to the next visit's (both included)
  cycle: number;                       // s for one bus to go round once, stops included
  distance: number;                    // m round once
};

export type BusNet = { stops: BusStopGeom[]; sides: StopSide[]; lines: BusLineGeom[]; lanes: Map<string, LaneTopo> };

export const emptyBusNet = (): BusNet => ({ stops: [], sides: [], lines: [], lanes: new Map() });

type Ctx = { layout: Layout; roads: RoadNet; walks: WalkNet; objects: Map<string, ObjectInfo>; lots: Set<string> };

/** The stops and their sides (lines come later, once the town knows which sides people can walk to). */
export function buildBusStops(ctx: Ctx): { net: BusNet; issues: Issue[] } {
  const { layout, roads } = ctx;
  const issues: Issue[] = [];
  const net = emptyBusNet();
  if (!layout.busStops.length) return { net, issues };
  const topo = laneTopology(roads, layout.terrain.size);
  for (const t of topo) net.lanes.set(t.key, t);

  // The longest bus calling at each stop sets how much road it needs.
  const busLength = (vehicle: string) => {
    const mesh = ctx.objects.get(vehicle)?.mesh;
    return mesh ? Math.max(1, mesh.max[0] - mesh.min[0]) : 11;
  };
  const longest = new Map<string, number>();
  for (const l of layout.busLines) for (const id of l.stops) longest.set(id, Math.max(longest.get(id) ?? 0, busLength(l.vehicle)));

  layout.busStops.forEach((spec, i) => {
    const road = roads.roads.get(spec.road);
    if (!road) return;
    const stop: BusStopGeom = { id: spec.id, index: i, name: displayName(spec), road: spec.road, s: spec.at, sides: [] };
    net.stops.push(stop);
    const len = longest.get(spec.id) ?? 11;
    const L = road.path.length;
    const where = `busStops[${i}]`;
    if (!road.path.closed && (spec.at < 0 || spec.at > L)) {
      issues.push(error("BUS_STOP_POSITION", `bus stop '${spec.id}' is at s=${spec.at} but road '${spec.road}' is ${L.toFixed(0)} m long; use 0..${L.toFixed(0)}`, `${where}.at`));
      return;
    }
    const s = road.path.closed ? mod(spec.at, L) : spec.at;
    const sides: Array<1 | -1> = spec.side === "both" ? [-1, 1] : spec.side === "left" ? [1] : [-1];
    for (const side of sides) {
      const dir = (-side) as 1 | -1;
      const place = (sAt: number) => stopPlace(ctx, net, spec, sAt, dir, len);
      const here = place(s);
      if (typeof here === "string") {
        // Say why, and where the nearest workable spot is.
        let better: number | null = null;
        for (let k = 1; k <= SEARCH && better === null; k++) {
          for (const sg of [1, -1]) {
            const t = spec.at + sg * k;
            if (better === null && (road.path.closed || (t >= 0 && t <= L)) && typeof place(road.path.closed ? mod(t, L) : t) !== "string") better = t;
          }
        }
        const sideName = side > 0 ? "left" : "right";
        const hint = better !== null ? `move it to about s=${better.toFixed(0)}` : "move it to a longer stretch of road between junctions";
        issues.push(error("BUS_STOP_POSITION", `bus stop '${spec.id}' (${sideName} side of '${spec.road}' at s=${spec.at}) ${here}; ${hint}`, `${where}.at`, pointAt(road.path, s)));
        continue;
      }
      const [px, py] = pointAt(road.path, s);
      const h = headingAt(road.path, s);
      const z = profileZ(roads.profiles.get(road.id)!, s);
      const sw = sidewalkWidth(road.spec, side);
      const kerb = kerbOffset(road.spec, side);
      const beside = (lat: number, dz: number): P3 => [px - Math.sin(h) * side * lat, py + Math.cos(h) * side * lat, z + dz];
      const id = net.sides.length;
      net.sides.push({
        id, stop: stop.index, side, dir, lane: here.lane, d: here.d, s, heading: h + (dir < 0 ? Math.PI : 0),
        at: beside(sw > 0 ? kerb + sw / 2 : kerb + 0.8, sw > 0 ? KERB : 0),
        sign: beside(kerb + 0.35, sw > 0 ? KERB : 0),
        shelter: spec.shelter ? beside(sw > 0 ? kerb + sw + 0.9 : kerb + 1.9, sw > 0 ? KERB : 0) : null,
        width: sw, reach: len,
      });
      stop.sides.push(id);
    }
  });

  // Stops whose stretches of road overlap on the same side.
  for (const a of net.sides) {
    for (const b of net.sides) {
      if (b.id <= a.id || a.lane !== b.lane) continue;
      const la = longest.get(net.stops[a.stop].id) ?? 11;
      const lb = longest.get(net.stops[b.stop].id) ?? 11;
      if (a.d - la - STOP_GAP < b.d && b.d - lb - STOP_GAP < a.d) {
        const spec = layout.busStops[net.stops[b.stop].index];
        issues.push(error("BUS_STOP_POSITION", `bus stops '${net.stops[a.stop].id}' and '${spec.id}' are too close on the same side of '${spec.road}' for a bus at each; move one at least ${Math.ceil(Math.max(la, lb) + STOP_GAP)} m from the other`, `busStops[${net.stops[b.stop].index}].at`));
      }
    }
  }

  layout.busStops.forEach((spec, i) => {
    if (!layout.busLines.some((l) => l.stops.includes(spec.id))) {
      issues.push(warning("BUS_STOP_UNUSED", `no bus line calls at bus stop '${spec.id}'; add it to a line's stops or remove it`, `busStops[${i}]`));
    }
  });
  return { net, issues };
}

/**
 * The lines: their stops in calling order, each on the side that makes the quickest
 * round, preferring sides people can walk to (`reachable`). Fills `net.lines`.
 */
export function buildBusLines(ctx: Ctx, net: BusNet, reachable: (side: number) => boolean): Issue[] {
  const { layout } = ctx;
  const issues: Issue[] = [];
  if (!net.stops.length) return issues;
  const penalty = (id: number) => (id >= 0 && !reachable(id) ? UNREACHABLE_PENALTY : 0);
  layout.busLines.forEach((spec, i) => {
    const where = `busLines[${i}]`;
    const ids = spec.stops.map((id) => net.stops.find((s) => s.id === id));
    if (ids.some((s) => !s)) return;                      // reported as UNKNOWN_REF
    const stops = ids as BusStopGeom[];
    const empty = stops.find((s) => !s.sides.length);
    if (empty) return;                                    // its position is reported already
    // Each visit with the index it has in the full round (a shuttle's return pass mirrors its way out).
    const out = stops.length;
    let visits = (spec.mode === "loop" ? stops.slice() : [...stops, ...stops.slice(1, -1).reverse()]).map((st, k) => ({ st, k }));
    const twin = (k: number) => (spec.mode === "shuttle" && k > 0 && k !== out - 1 ? 2 * out - 2 - k : -1);
    const choose = (list: typeof visits, relax: boolean) => bestSides(ctx, net, list.map((v) => (relax ? bothSides(v.st) : v.st.sides)), relax ? () => 0 : penalty);
    if (spec.mode === "shuttle") {
      // A stop on one side only is called at once: on the pass that has it on the right (the way out if both do, or neither).
      const relaxed = choose(visits, true);
      if (relaxed) {
        visits = visits.filter((v) => {
          if (twin(v.k) < 0 || v.st.sides.length !== 1) return true;
          const own = net.sides[v.st.sides[0]].side;
          const [outK, backK] = [Math.min(v.k, twin(v.k)), Math.max(v.k, twin(v.k))];
          const back = relaxed.sides[backK].side === own && relaxed.sides[outK].side !== own;
          return v.k === backK ? back : !back;
        });
      }
    }
    let best = choose(visits, false);
    if (!best) {
      const k = firstGap(ctx, net, visits.map((v) => v.st));
      const [a, b] = [visits[k].st, visits[(k + 1) % visits.length].st];
      issues.push(error("BUS_ROUTE", `bus line '${spec.id}' finds no way by road from stop '${a.id}' to stop '${b.id}' (buses drive on the right and call at the stop on their right-hand side; a stop on one side only is served one way); connect the roads, add the other side to a stop, or change the order`, `${where}.stops`));
      return;
    }
    if (spec.mode === "shuttle") {
      // Coming back, a shuttle calls at the other side of a stop it called at on the way out, if that costs little.
      const options = visits.map((v) => v.st.sides.slice());
      visits.forEach((v, i) => {
        const j = visits.findIndex((w) => w.k === twin(v.k));
        if (j <= i || v.st.sides.length !== 2 || best!.sides[i].id !== best!.sides[j].id) return;
        const trial = options.map((o) => o.slice());
        trial[i] = [best!.sides[i].id];
        trial[j] = v.st.sides.filter((x) => x !== best!.sides[i].id);
        const other = bestSides(ctx, net, trial, penalty);
        if (other && other.cost <= best!.cost + TWIN_SLACK) { best = other; options[i] = trial[i]; options[j] = trial[j]; }
      });
    }
    const chosen = best;
    const vehicle = ctx.objects.get(spec.vehicle);
    const lineVisits: BusVisit[] = [];
    let t = 0;
    let dist = 0;
    chosen.sides.forEach((side, k) => {
      lineVisits.push({ side: side.id, t, dist });
      t += spec.dwell + STOP_TIME + chosen.legs[k].time;
      dist += chosen.legs[k].dist;
    });
    const line: BusLineGeom = {
      id: spec.id, index: i, name: displayName(spec), color: spec.color ?? COLORS[i % COLORS.length], vehicle: spec.vehicle,
      length: vehicle ? Math.max(1, vehicle.mesh.max[0] - vehicle.mesh.min[0]) : 11, mode: spec.mode, count: spec.count,
      dwell: spec.dwell, capacity: spec.capacity, visits: lineVisits, legs: chosen.legs.map((l) => l.keys), cycle: t, distance: dist,
    };
    net.lines.push(line);
    const fit = Math.floor(dist / (line.length + 60));
    if (spec.count > Math.max(1, fit)) {
      issues.push(warning("CAPACITY", `bus line '${spec.id}' has ${spec.count} buses but its ${dist.toFixed(0)} m round holds about ${Math.max(1, fit)} with room between them; use fewer buses`, `${where}.count`));
    }
  });
  return issues;
}

/** Both sides of a stop, real or not, for working out which way each pass of a shuttle goes. */
function bothSides(st: BusStopGeom): number[] {
  return st.sides.length === 2 ? st.sides : [st.sides[0], -1 - st.sides[0]];
}

/**
 * Where a bus stopping at a stop's sign on one side stands: the lane and its front's
 * offset, or why it cannot stop there (too near a junction, a crossing, a dead end).
 */
function stopPlace(ctx: Ctx, net: BusNet, spec: BusStopSpec, s: number, dir: 1 | -1, len: number): { lane: string; d: number } | string {
  const { roads, walks, layout } = ctx;
  const road = roads.roads.get(spec.road)!;
  const L = road.path.length;
  const sf = road.path.closed ? mod(s + dir * FRONT_PAST, L) : s + dir * FRONT_PAST;
  const rear = road.path.closed ? mod(sf - dir * len, L) : sf - dir * len;
  if (!road.path.closed && (rear < 0 || rear > L || sf < 0 || sf > L)) return "leaves no room for a bus before the end of the road";
  // The lane holding the bus's front, and its whole body inside the lane.
  for (const t of net.lanes.values()) {
    if (t.road !== spec.road || t.dir !== dir) continue;
    let d = (sf - t.s) * dir;
    if (road.path.closed) d = mod(d, L);
    if (d < 0 || d > t.dist) continue;
    const lo = t.box0 + LANE_CLEAR;
    const endNode = t.end === null ? null : roads.nodes[t.end];
    const hi = t.dist - t.box1 - LANE_CLEAR - (endNode && endNode.legs.length === 1 && !isPortal(endNode, layout.terrain.size) ? END_CLEAR : 0);
    if (t.end !== null && d - len < lo) {
      const n = roads.nodes[roads.stops.get(spec.road)!.find((x) => Math.abs(mod(x.s - t.s + 1, L || Infinity) - 1) < 1e-3)?.node ?? 0];
      return `leaves a stopped bus reaching back into ${n.legs.length === 1 ? "the end of the road" : `the junction at (${n.at[0].toFixed(0)}, ${n.at[1].toFixed(0)})`}`;
    }
    if (t.end !== null && d > hi) {
      const n = roads.nodes[t.end];
      return `puts a stopped bus too close to ${n.legs.length === 1 ? "the end of the road" : `the junction at (${n.at[0].toFixed(0)}, ${n.at[1].toFixed(0)})`}`;
    }
    // Clear of level crossings, zebras and tunnels along the bus's length.
    const body = (x: number, margin: number) => {
      let k = (sf - x) * dir;                             // how far behind the bus's front x is
      if (road.path.closed) k = mod(k + L / 2, L) - L / 2;
      return k >= -margin && k <= len + margin;
    };
    for (const c of roads.crossings) {
      if (c.road === spec.road && body(c.roadS, c.zone + CROSSING_CLEAR)) return `puts a stopped bus within ${CROSSING_CLEAR} m of the level crossing over '${c.track}'`;
    }
    for (const c of walks.crossings) {
      if (c.road === spec.road && body(c.roadS, c.half + ZEBRA_CLEAR)) return `puts a stopped bus on or next to the ${c.kind === "zebra" ? "zebra crossing" : "pedestrian crossing"} at (${c.at[0].toFixed(0)}, ${c.at[1].toFixed(0)})`;
    }
    const spans = roads.spans.get(spec.road)!;
    for (let k = 0; k <= len; k += 1) {
      const sx = sf - dir * k;
      if (structureAt(spans, road.path.closed ? mod(sx, L) : sx) === "tunnel") return "is in a tunnel";
    }
    return { lane: t.key, d };
  }
  return "is not on a stretch of road that buses can drive";
}

type Hop = { keys: string[]; time: number; dist: number };

/** The quickest way by lane from one stop side's stopping place to another's, or null. */
function hop(ctx: Ctx, net: BusNet, a: { lane: string; d: number }, b: { lane: string; d: number }): Hop | null {
  const { roads, layout } = ctx;
  const speed = (t: LaneTopo) => Math.max(3, roads.roads.get(t.road)!.spec.speed * BUS_SPEED);
  const A = net.lanes.get(a.lane)!;
  if (a.lane === b.lane && b.d > a.d + 0.5) return { keys: [a.lane], time: (b.d - a.d) / speed(A), dist: b.d - a.d };
  const turnTime = (t: LaneTopo) => {
    const n = t.end === null ? null : roads.nodes[t.end];
    return n && isPortal(n, layout.terrain.size) ? AWAY_TIME : t.end === null ? 0 : JUNCTION_TIME;
  };
  const best = new Map<string, number>();
  const prev = new Map<string, string>();
  const open: Array<{ key: string; time: number; dist: number }> = [];
  const dists = new Map<string, number>();
  const push = (key: string, time: number, dist: number, from: string) => {
    if (ctx.lots.has(net.lanes.get(key)!.road)) return;          // not through car parks
    if (time >= (best.get(key) ?? Infinity)) return;
    best.set(key, time);
    dists.set(key, dist);
    prev.set(key, from);
    open.push({ key, time, dist });
  };
  for (const k of A.next) push(k, (A.dist - a.d) / speed(A) + turnTime(A), A.dist - a.d, "");
  let done: { time: number; dist: number; via: string } | null = null;
  while (open.length) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i].time < open[bi].time) bi = i;
    const cur = open.splice(bi, 1)[0];
    if (cur.time > (best.get(cur.key) ?? Infinity)) continue;
    if (done && cur.time >= done.time) break;
    const t = net.lanes.get(cur.key)!;
    if (cur.key === b.lane) {
      const time = cur.time + b.d / speed(t);
      if (!done || time < done.time) done = { time, dist: cur.dist + b.d, via: cur.key };
    }
    for (const k of t.next) push(k, cur.time + t.dist / speed(t) + turnTime(t), cur.dist + t.dist, cur.key);
  }
  if (!done) return null;
  const keys: string[] = [b.lane];
  for (let k = prev.get(b.lane)!; k; k = prev.get(k)!) {
    keys.unshift(k);
    if (keys.length > 2000) return null;
  }
  keys.unshift(a.lane);
  return { keys, time: done.time, dist: done.dist };
}

/** Where a side (or the missing side of a one-sided stop: id −1 − side) has a bus stand. */
function placeOf(net: BusNet, id: number): { lane: string; d: number; side: 1 | -1 } | null {
  if (id >= 0) return { lane: net.sides[id].lane, d: net.sides[id].d, side: net.sides[id].side };
  // A stand-in for the other side of a one-sided stop: the same spot driven the other way.
  const real = net.sides[-1 - id];
  for (const t of net.lanes.values()) {
    if (t.road !== net.lanes.get(real.lane)!.road || t.dir !== -real.dir) continue;
    const road = net.lanes.get(real.lane)!;
    const sf = road.s + road.dir * real.d;
    const d = (sf - t.s) * t.dir;
    if (d >= 0 && d <= t.dist) return { lane: t.key, d, side: (-real.side) as 1 | -1 };
  }
  return null;
}

/** For each visit (a list of candidate sides), the sides that make the quickest round, with each leg. */
function bestSides(
  ctx: Ctx, net: BusNet, options: number[][], penalty: (id: number) => number,
): { sides: Array<{ id: number; side: 1 | -1 }>; legs: Hop[]; cost: number } | null {
  const m = options.length;
  const places = options.map((list) => list.map((id) => ({ id, p: placeOf(net, id) })).filter((x) => x.p));
  const memo = new Map<string, Hop | null>();
  const leg = (i: number, a: number, b: number): Hop | null => {
    const key = `${i}|${a}|${b}`;
    if (!memo.has(key)) {
      const j = (i + 1) % m;
      memo.set(key, hop(ctx, net, places[i][a].p!, places[j][b].p!));
    }
    return memo.get(key)!;
  };
  let best: { cost: number; choice: number[] } | null = null;
  for (let a0 = 0; a0 < places[0].length; a0++) {
    // cost[k][c]: quickest from visit 0 (side a0) to visit k on side c; from[k][c] the side before.
    const cost: number[][] = [places[0].map((x, c) => (c === a0 ? penalty(x.id) : Infinity))];
    const from: number[][] = [places[0].map(() => -1)];
    for (let k = 1; k < m; k++) {
      cost.push(places[k].map(() => Infinity));
      from.push(places[k].map(() => -1));
      places[k].forEach((_, c) => {
        places[k - 1].forEach((__, p) => {
          if (!Number.isFinite(cost[k - 1][p])) return;
          const h = leg(k - 1, p, c);
          const t = h ? cost[k - 1][p] + h.time + penalty(places[k][c].id) : Infinity;
          if (t < cost[k][c]) { cost[k][c] = t; from[k][c] = p; }
        });
      });
    }
    places[m - 1].forEach((_, c) => {
      if (!Number.isFinite(cost[m - 1][c])) return;
      const h = leg(m - 1, c, a0);
      if (!h) return;
      const total = cost[m - 1][c] + h.time;
      if (best && total >= best.cost) return;
      const choice = new Array<number>(m);
      choice[m - 1] = c;
      for (let k = m - 1; k > 0; k--) choice[k - 1] = from[k][choice[k]];
      best = { cost: total, choice };
    });
  }
  if (!best) return null;
  const { choice, cost } = best as { choice: number[]; cost: number };
  return {
    cost,
    sides: choice.map((c, k) => ({ id: places[k][c].id, side: places[k][c].p!.side })),
    legs: choice.map((c, k) => leg(k, c, choice[(k + 1) % m])!),
  };
}

/** The first pair of visits with no way between them on any sides (for the error message). */
function firstGap(ctx: Ctx, net: BusNet, visits: BusStopGeom[]): number {
  for (let k = 0; k < visits.length; k++) {
    const a = visits[k].sides;
    const b = visits[(k + 1) % visits.length].sides;
    if (!a.some((x) => b.some((y) => hop(ctx, net, placeOf(net, x)!, placeOf(net, y)!)))) return k;
  }
  return 0;
}
