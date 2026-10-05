// Freight: what the board's buildings and the off-layout places send out and need
// delivered (goods by id, in loads per hour), the goods yards where freight trains
// and lorries exchange them, where a lorry stops to load at each building and yard
// — its "dock": a place in a lane at the kerb beside the door, or along a yard's
// loading dock — and the fleet of delivery vehicles. The sim (sim/freight.ts) turns
// this into orders, consignments and jobs for the vehicles and freight trains.

import type { Layout } from "./schema";
import type { TrackGeom } from "./trackGraph";
import type { Profile } from "./heights";
import { profileZ, structureAt } from "./heights";
import { type RoadNet, type RoadGeom, type LaneTopo, laneTopology, isPortal, kerbOffset, sidewalkWidth } from "./roads";
import type { WalkNet } from "./walks";
import { KERB } from "./walks";
import type { BusNet } from "./buses";
import type { Town } from "./town";
import type { OffLayout } from "./exits";
import type { ObjectInfo } from "./scenery";
import { DOCK_OFFSET, DOCK_WIDTH, PLATFORM_TOP } from "./scenery";
import { pointAt, headingAt } from "./geometry";
import { TRAIN_CATALOG, isTrainType, goodsName } from "./catalog";
import { type Issue, warning } from "./validate";
import { mod } from "../util/vec";

type P3 = [number, number, number];

const BUILDING_REACH = 40;             // m from a door to the kerb where a lorry stops for it
const YARD_REACH = 30;                 // m from a yard's dock to the kerb along it
const SEARCH = 30;                     // m either way along the road to look for room to stop
const LANE_CLEAR = 3;                  // m a stopped lorry keeps from the ends of its lane (a junction's area)
const END_CLEAR = 4;                   // m more before a dead end, where vehicles turn round
const EDGE_CLEAR = 15;                 // m from the board's edge
const CROSSING_CLEAR = 6;              // m from a level crossing's zone
const ZEBRA_CLEAR = 3;                 // m from a zebra or a crossing over a junction's leg
const BUS_CLEAR = 2;                   // m from where a bus stands at a stop
const DEFAULT_LENGTH = 8;              // m of road a stopped delivery vehicle takes when no fleet says otherwise
const FLEET_ROAD = 400;                // m of road per delivery vehicle at most, for the default fleet

/** Where a delivery vehicle stops to load and unload: in a lane, at the kerb. */
export type Dock = {
  lane: string;                        // lane topology key
  d: number;                           // the stopped vehicle's front, in road metres from the lane's start node
  road: string;
  s: number;                           // the vehicle's middle along the road
  side: 1 | -1;                        // the road's side (left/right of increasing s) it stops on
  heading: number;                     // the way it faces
  kerb: P3;                            // the kerb beside its middle, where goods go in and out
  target: P3;                          // the door or dock edge it serves
};

/** A goods yard: a loading dock beside the track, with a road along its back. */
export type Yard = {
  id: string;                          // its station id
  index: number;                       // into layout.stations
  name: string;
  track: string;
  at: number;                          // s of the dock's centre
  length: number;
  side: 1 | -1;                        // the dock's side of the track
  building: number;                    // its goods shed (town building), or -1
  dock: Dock | null;                   // where lorries stop along it
};

export type Rate = { goods: string; rate: number };

/** A place goods come from, go to or change hands at. */
export type Site = {
  id: number;
  kind: "building" | "yard" | "off";
  ref: number;                         // building id, yard index or off-layout place index
  name: string;
  supplies: Rate[];
  demands: Rate[];
  dock: Dock | null;                   // on the board: where vehicles stop for it (null: none can)
  stop: string | null;                 // where freight trains call for it: its yard's station id, or the off-layout place id
};

/** A group of delivery vehicles. */
export type Fleet = {
  index: number;
  name: string;
  object: string;
  count: number;
  capacity: number;                    // loads
  goods: string[] | null;              // only these, or any
  color: string | null;
  length: number;                      // m
};

export type FreightNet = {
  goods: string[];                     // every goods id supplied or demanded anywhere
  sites: Site[];
  yards: Yard[];
  fleet: Fleet[];
  buildingSite: Map<number, number>;   // building id → site
  yardSite: number[];                  // per yard
  offSite: Map<number, number>;        // off-layout place → site
  services: string[];                  // ids of the freight services (freight trains)
};

export const emptyFreightNet = (): FreightNet => ({
  goods: [], sites: [], yards: [], fleet: [], buildingSite: new Map(), yardSite: [], offSite: new Map(), services: [],
});

type Ctx = {
  layout: Layout;
  tracks: Map<string, TrackGeom>;
  profiles: Map<string, Profile>;
  roads: RoadNet;
  walks: WalkNet;
  buses: BusNet;
  town: Town;
  off: OffLayout;
  objects: Map<string, ObjectInfo>;
  lots: Set<string>;
};

const rates = (r: Record<string, number> | undefined): Rate[] =>
  Object.entries(r ?? {}).filter(([, v]) => v > 0).map(([goods, rate]) => ({ goods, rate })).sort((a, b) => a.goods.localeCompare(b.goods));

const titleCase = (id: string) => id.split("-").map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");

/** Whether the layout says anything about freight itself (rather than relying on the built-in buildings' defaults). */
function explicitFreight(layout: Layout): boolean {
  const said = (b: { supplies?: unknown; demands?: unknown } | undefined) => !!b && (b.supplies !== undefined || b.demands !== undefined);
  return layout.stations.some((s) => s.kind === "freight") || layout.freight.vehicles !== undefined
    || layout.offLayout.some((p) => Object.keys(p.supplies).length > 0 || Object.keys(p.demands).length > 0)
    || layout.scenery.some((e) => said(e.building)) || Object.values(layout.objects).some((o) => said(o.building));
}

export function buildFreight(ctx: Ctx): { net: FreightNet; issues: Issue[] } {
  const { layout, roads, town, off } = ctx;
  const issues: Issue[] = [];
  const net = emptyFreightNet();
  const explicit = explicitFreight(layout);
  const topo = laneTopology(roads, layout.terrain.size);
  const lengthOf = (object: string) => {
    const mesh = ctx.objects.get(object)?.mesh;
    return mesh ? Math.max(1, mesh.max[0] - mesh.min[0]) : DEFAULT_LENGTH;
  };
  const specs = layout.freight.vehicles;
  const longest = specs?.length ? Math.max(...specs.map((f) => lengthOf(f.object))) : lengthOf("truck");
  const docks = docker(ctx, topo, longest);

  net.services = layout.services.filter((s) => isTrainType(s.train) && TRAIN_CATALOG[s.train].shape === "freight").map((s) => s.id);

  // --- goods yards ------------------------------------------------------------------
  layout.stations.forEach((st, i) => {
    if (st.kind !== "freight") return;
    const t = ctx.tracks.get(st.track);
    const prof = ctx.profiles.get(st.track);
    if (!t || !prof) return;
    const side: 1 | -1 = st.side === "left" ? 1 : -1;
    const edge = (s0: number): P3 => {
      const s = t.path.closed ? mod(s0, t.path.length) : Math.min(Math.max(s0, 0), t.path.length);
      const [x, y] = pointAt(t.path, s);
      const h = headingAt(t.path, s);
      const lat = side * (DOCK_OFFSET + DOCK_WIDTH / 2);
      return [x - Math.sin(h) * lat, y + Math.cos(h) * lat, profileZ(prof, s) + PLATFORM_TOP];
    };
    // Along the dock from its middle outwards, the first place a lorry can stop beside it.
    let dock: Dock | null = null;
    for (const f of [0, 0.15, -0.15, 0.3, -0.3]) {
      dock = docks.find(edge(st.at + f * st.length), YARD_REACH, st.road ?? null);
      if (dock) break;
    }
    const building = town.buildings.find((b) => b.station === st.id)?.id ?? -1;
    net.yards.push({ id: st.id, index: i, name: st.name, track: st.track, at: st.at, length: st.length, side, building, dock });
    if (!dock) {
      const named = st.road ? `road '${st.road}' has no room for a lorry to stop beside its dock` : `there is no road within ${YARD_REACH} m of its dock's back edge`;
      issues.push(warning("YARD_ROAD", `freight yard '${st.id}': ${named} (clear of junctions, crossings and bus stops), so no lorry can load or unload there; run a road along the dock side${st.road ? "" : ` or name one with "road"`}`, `stations[${i}]`, [edge(st.at)[0], edge(st.at)[1]]));
    }
  });

  // --- sites --------------------------------------------------------------------------
  const add = (site: Omit<Site, "id">) => { net.sites.push({ id: net.sites.length, ...site }); return net.sites.length - 1; };
  for (const b of town.buildings) {
    const supplies = rates(b.supplies);
    const demands = rates(b.demands);
    if (!supplies.length && !demands.length) continue;
    const dock = docks.find(b.door, BUILDING_REACH, null);
    net.buildingSite.set(b.id, add({ kind: "building", ref: b.id, name: b.name, supplies, demands, dock, stop: null }));
    const home = b.functions.length === 1 && b.functions[0] === "accommodation";
    if (!dock && explicit && roads.roads.size && (supplies.length || !home)) {
      const what = supplies.length ? `send out its ${supplies.map((r) => goodsName(r.goods)).join(" and ")}` : `take deliveries of ${demands.map((r) => goodsName(r.goods)).join(" and ")}`;
      issues.push(warning("FREIGHT_UNREACHABLE", `${b.kind.toLowerCase()} '${b.name}' has no road within ${BUILDING_REACH} m of its door where a lorry could stop, so it cannot ${what}; run a road past it or turn its door toward one`, b.where, [b.door[0], b.door[1]]));
    }
  }
  net.yards.forEach((y, k) => { net.yardSite.push(add({ kind: "yard", ref: k, name: y.name, supplies: [], demands: [], dock: y.dock, stop: y.id })); });
  for (const p of off.places) {
    const spec = layout.offLayout[p.index];
    const supplies = rates(spec.supplies);
    const demands = rates(spec.demands);
    if (!supplies.length && !demands.length) continue;
    net.offSite.set(p.index, add({ kind: "off", ref: p.index, name: p.name, supplies, demands, dock: null, stop: p.id }));
  }
  const goods = new Set<string>();
  for (const s of net.sites) for (const r of [...s.supplies, ...s.demands]) goods.add(r.goods);
  net.goods = [...goods].sort();

  // --- goods nobody sends or nobody needs ----------------------------------------------
  if (explicit) {
    for (const g of net.goods) {
      const from = net.sites.filter((s) => s.supplies.some((r) => r.goods === g));
      const to = net.sites.filter((s) => s.demands.some((r) => r.goods === g));
      if (from.length && to.length) continue;
      const [one, other] = from.length ? [from, "needs"] : [to, "sends"];
      const names = one.slice(0, 3).map((s) => `'${s.name}'`).join(", ") + (one.length > 3 ? ` and ${one.length - 3} more` : "");
      issues.push(warning("FREIGHT_UNMATCHED", `${goodsName(g)} ('${g}') is ${from.length ? "sent out" : "needed"} by ${names} but nothing ${other} it, so none moves; add a building or an off-layout place that ${other} '${g}' (its "${from.length ? "demands" : "supplies"}")`, "freight"));
    }
  }

  // --- the delivery fleet ----------------------------------------------------------------
  const nameOf = (object: string) => (object === "van" ? "Delivery van" : object === "truck" ? "Lorry" : titleCase(object));
  if (specs) {
    specs.forEach((f, k) => net.fleet.push({
      index: k, name: f.name ?? nameOf(f.object), object: f.object, count: f.count, capacity: f.capacity,
      goods: f.goods ?? null, color: f.color ?? null, length: lengthOf(f.object),
    }));
  } else if (net.sites.some((s) => s.dock) && net.goods.some((g) => net.sites.some((s) => s.supplies.some((r) => r.goods === g)) && net.sites.some((s) => s.demands.some((r) => r.goods === g)))) {
    // Something to deliver: a few vans and lorries, more where more is needed — but no more
    // than about one per 400 m of road, so they do not clog a small network.
    const demand = net.sites.reduce((a, s) => a + s.demands.reduce((b, r) => b + r.rate, 0), 0);
    const roadLength = [...roads.roads.values()].filter((r) => !ctx.lots.has(r.id)).reduce((a, r) => a + r.path.length, 0);
    const room = Math.max(2, Math.floor(roadLength / FLEET_ROAD));
    const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
    const trucks = clamp(Math.round(demand / 60), 1, Math.min(3, Math.floor(room / 3) || 1));
    const vans = clamp(Math.round(demand / 30), 1, Math.min(5, room - trucks));
    net.fleet.push({ index: 0, name: "Delivery van", object: "van", count: vans, capacity: 6, goods: null, color: null, length: lengthOf("van") });
    net.fleet.push({ index: 1, name: "Lorry", object: "truck", count: trucks, capacity: 16, goods: null, color: null, length: lengthOf("truck") });
  }
  return { net, issues };
}

/** Finds docks: places to stop at the kerb near a point, `len` m of lane long. */
function docker(ctx: Ctx, topo: LaneTopo[], len: number) {
  const { roads, walks, buses, layout } = ctx;
  const size = layout.terrain.size;
  const lanesOf = new Map<string, LaneTopo[]>();
  for (const t of topo) lanesOf.set(t.road, [...(lanesOf.get(t.road) ?? []), t]);

  /** The lane and front offset of a vehicle stopped with its middle at sMid going `dir`, or null if it may not stop there. */
  const place = (road: RoadGeom, sMid: number, dir: 1 | -1): { lane: string; d: number } | null => {
    const L = road.path.length;
    const closed = road.path.closed;
    const sf = closed ? mod(sMid + (dir * len) / 2, L) : sMid + (dir * len) / 2;
    const rear = sf - dir * len;
    if (!closed && (rear < 0 || rear > L || sf < 0 || sf > L)) return null;
    for (const t of lanesOf.get(road.id) ?? []) {
      if (t.dir !== dir) continue;
      let d = (sf - t.s) * dir;
      if (closed) d = mod(d, L);
      if (d < 0 || d > t.dist) continue;
      const endNode = t.end === null ? null : roads.nodes[t.end];
      const portal = !!endNode && endNode.legs.length === 1 && isPortal(endNode, size);
      const deadEnd = !!endNode && endNode.legs.length === 1 && !portal;
      const lo = t.box0 + LANE_CLEAR;
      const hi = t.dist - t.box1 - LANE_CLEAR - (deadEnd ? END_CLEAR : 0) - (portal ? EDGE_CLEAR : 0);
      if (t.end !== null && (d - len < lo || d > hi)) return null;
      const startNode = roads.nodes[Number(t.key.split("|")[0])];
      if (startNode && startNode.legs.length === 1 && isPortal(startNode, size) && d - len < EDGE_CLEAR) return null;
      // Clear of level crossings, zebras, bus stops and anything but level ground along its length.
      const body = (x: number, margin: number) => {
        let k = (sf - x) * dir;
        if (closed) k = mod(k + L / 2, L) - L / 2;
        return k >= -margin && k <= len + margin;
      };
      if (roads.crossings.some((c) => c.road === road.id && body(c.roadS, c.zone + CROSSING_CLEAR))) return null;
      if (walks.crossings.some((c) => c.road === road.id && body(c.roadS, c.half + ZEBRA_CLEAR))) return null;
      if (buses.sides.some((b) => b.lane === t.key && b.d - b.reach - BUS_CLEAR < d && d - len < b.d + BUS_CLEAR)) return null;
      const spans = roads.spans.get(road.id)!;
      for (let k = 0; k <= len; k += 1) {
        const sx = sf - dir * k;
        if (structureAt(spans, closed ? mod(sx, L) : sx) !== "ground") return null;
      }
      return { lane: t.key, d };
    }
    return null;
  };

  /** The nearest place to stop beside `target`, within `reach` of the kerb (on `only` if given). */
  const find = (target: P3, reach: number, only: string | null): Dock | null => {
    const near: Array<{ road: RoadGeom; s: number; dist: number }> = [];
    for (const road of roads.roads.values()) {
      if (ctx.lots.has(road.id) || (only && road.id !== only)) continue;
      const L = road.path.length;
      let best = { s: 0, dist: Infinity };
      for (let s = 0; s <= L; s += 2) {
        const [x, y] = pointAt(road.path, s);
        const dist = Math.hypot(x - target[0], y - target[1]);
        if (dist < best.dist) best = { s, dist };
      }
      for (let ds = -2; ds <= 2; ds += 0.25) {
        const s = road.path.closed ? mod(best.s + ds, L) : Math.min(Math.max(best.s + ds, 0), L);
        const [x, y] = pointAt(road.path, s);
        const dist = Math.hypot(x - target[0], y - target[1]);
        if (dist < best.dist) best = { s, dist };
      }
      if (best.dist - road.spec.width / 2 <= reach) near.push({ road, ...best });
    }
    near.sort((a, b) => a.dist - b.dist || a.road.id.localeCompare(b.road.id));
    for (const { road, s } of near) {
      const L = road.path.length;
      const [px, py] = pointAt(road.path, s);
      const h = headingAt(road.path, s);
      const side: 1 | -1 = -(target[0] - px) * Math.sin(h) + (target[1] - py) * Math.cos(h) >= 0 ? 1 : -1;
      const dir = (-side) as 1 | -1;
      for (let k = 0; k <= SEARCH; k++) {
        for (const sg of k ? [1, -1] : [1]) {
          const raw = s + sg * k;
          if (!road.path.closed && (raw < 0 || raw > L)) continue;
          const sMid = road.path.closed ? mod(raw, L) : raw;
          const at = place(road, sMid, dir);
          if (!at) continue;
          const [x, y] = pointAt(road.path, sMid);
          const hm = headingAt(road.path, sMid);
          const lat = side * kerbOffset(road.spec, side);
          const sw = sidewalkWidth(road.spec, side);
          const kerb: P3 = [x - Math.sin(hm) * lat, y + Math.cos(hm) * lat, profileZ(roads.profiles.get(road.id)!, sMid) + (sw > 0 ? KERB : 0)];
          if (Math.hypot(kerb[0] - target[0], kerb[1] - target[1]) > reach + 8) continue;
          return { lane: at.lane, d: at.d, road: road.id, s: sMid, side, heading: hm + (dir < 0 ? Math.PI : 0), kerb, target };
        }
      }
    }
    return null;
  };
  return { find };
}

/** A site's name, said with where it is when it is off the board. */
export const siteName = (s: Site): string => (s.kind === "off" ? `${s.name} (off the board)` : s.name);
