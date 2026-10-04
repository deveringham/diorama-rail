// The town: every building people can live in, work at or visit (with an address,
// its functions and a door joined to the walkways), the parking bays along streets
// and in car parks, how each station is reached on foot, places to stroll to, and
// the residents themselves — names, homes, jobs and cars. Deterministic from the
// layout seed; the sim gives these people their errands.

import type { Layout } from "./schema";
import type { TrackGeom } from "./trackGraph";
import type { Profile, Span } from "./heights";
import { profileZ, structureAt } from "./heights";
import { pointAt, headingAt } from "./geometry";
import {
  type RoadNet, type RoadPoint, displayName, kerbOffset, parkingWidth, pavedHalf, sidewalkWidth, PARKING_WIDTH,
} from "./roads";
import { type WalkNet, type Walkway, KERB, wayPoint } from "./walks";
import { type LotGeom, LOT_AISLE, BAY_PITCH, BAY_DEPTH, lotFrame } from "./parking";
import type { Placement, ObjectInfo, StationGeom, StationEntry } from "./scenery";
import type { BuildingFunction } from "./objects";
import { type BusNet, FRONT_PAST } from "./buses";
import type { OffLayout } from "./exits";
import type { TrackPoint } from "./validate";
import { TRAIN_CATALOG, isTrainType } from "./catalog";
import { type Issue, warning } from "./validate";
import { SpatialHash } from "../util/spatial";
import { rng, range, type Rng } from "../util/rng";
import { mod } from "../util/vec";

type P3 = [number, number, number];

export const ACCESS_REACH = 45;        // m from a door (or a station's platform) to the walkway it uses
const BAY_WALK_REACH = 30;             // m from a bay without a sidewalk to a walkway
const DOOR_BAY_REACH = 40;             // m a door may be from a bay its people use directly
const DOOR_BAYS = 6;                   // bays at most linked straight to one door
const HOME_PARKING = 150;              // m: a car is kept within this of its owner's home
const PARALLEL_BAY = 6;                // m of kerb per parallel bay
export const PULL_OUT = 7;             // m along the lane a car pulling out of a bay drives to join it
const JUNCTION_CLEAR = 6;              // m bays keep beyond a junction's box
const CROSSING_CLEAR = 6;              // m beyond a level crossing's zone
const ZEBRA_CLEAR = 4;                 // m beyond a zebra or a crossing over a junction's leg
const BUS_CLEAR = 3;                   // m beyond where a bus stands at a stop
const END_CLEAR = 10;                  // m from a dead end (cars turn there)
const STREET_REACH = 60;               // m from a door to the street that gives its address
const SPOT_SPACING = 70;               // m between places to stroll to along a footpath
const AUTO_MAX = 600;                  // people at most when people.count is not given
const EMPLOYMENT = 0.72;               // share of people with a job, where there are jobs
const LINK_STEP = 1;                   // m between checks along a link
const LINK_CLIMB = 4.5;                // m a link may climb or fall (steps up to a sidewalk; never onto a bridge)
const GATE_CLEAR = 3;                  // m beyond a level or foot crossing's zone that links and spots keep
const DEFAULT_RESIDENTS = 3;
const DEFAULT_JOBS = 3;

/** How a place joins the walkways: along `link` (from the place) to point d of walkway `way`. */
export type Attach = { way: number; d: number; link: P3[]; length: number };

export type Building = {
  id: number;
  placement: number;                   // index into world.scenery
  object: string;
  name: string;                        // the layout's name for it, or a street address
  kind: string;                        // what sort of place: "House", "Church", ...
  functions: BuildingFunction[];
  residents: number;                   // homes for this many people
  jobs: string[];                      // a title per job
  at: P3;                              // where it stands
  door: P3;
  access: Attach | null;
  bays: Array<{ bay: number; link: P3[]; length: number }>;   // bays its people reach straight from the door
  station: string | null;              // the station it belongs to (a station building, or a goods yard's shed)
  supplies: Record<string, number>;    // goods it sends out, loads per hour
  demands: Record<string, number>;     // goods it needs delivered, loads per hour
  where: string;                       // layout path, for issues
};

export type Bay = {
  id: number;
  road: string;                        // the road (or car park aisle) whose lane serves it
  side: 1 | -1;                        // left (+1) or right of increasing s
  s: number;
  x: number; y: number; z: number;
  heading: number;                     // a parked car's heading
  style: "parallel" | "perpendicular";
  lot: string | null;                  // the car park it is in
  length: number;                      // along the car's heading
  width: number;
  kerb: P3;                            // where its driver gets in and out
  access: Attach | null;               // from the kerb to the walkways
};

/** One way into a station: from the walkways on to a platform (through the station building, or not). */
export type Entrance = {
  entry: P3;                           // where people step on to the platform
  entryS: number;                      // its s along the track
  side: 1 | -1;                        // the platform's side of the track (left/right of increasing s)
  via: "path" | "building" | "direct";
  door: P3 | null;                     // the station building's door (via building)
  access: Attach;                      // from the entry (or door) to the walkways
};

export type StationAccess = {
  station: string;
  name: string;
  track: string;
  building: number;                    // station building, or -1
  entrances: Entrance[];               // none: nobody can get there on foot
};

export type Spot = { id: number; name: string; way: number; d: number; at: P3 };

/** How people reach one side of a bus stop (indexed like BusNet.sides), and whether it has a shelter. */
export type StopAccess = { access: Attach | null; shelter: boolean };

export type Person = {
  id: number;
  first: string;
  last: string;
  name: string;
  home: number;                        // building
  job: { title: string; building: number; off: number } | null;   // at a building, or (building −1) at off-layout place `off`
  car: { object: string; bay: number } | null;   // their car and where it is parked at the start
  prefs: { walk: number; drive: number; train: number; bus: number };   // how much they mind each (cost factors)
};

export type Town = {
  buildings: Building[];
  bays: Bay[];
  stations: StationAccess[];
  spots: Spot[];
  people: Person[];
  lots: LotGeom[];
  stops: StopAccess[];
};

export const emptyTown = (): Town => ({ buildings: [], bays: [], stations: [], spots: [], people: [], lots: [], stops: [] });

type Ctx = {
  layout: Layout;
  tracks: Map<string, TrackGeom>;
  profiles: Map<string, Profile>;
  spans: Map<string, Span[]>;
  trackHash: SpatialHash<TrackPoint>;
  roads: RoadNet;
  walks: WalkNet;
  lots: LotGeom[];
  stations: StationGeom[];
  stationEntries: Map<string, StationEntry[]>;
  objects: Map<string, ObjectInfo>;
  scenery: Placement[];
  buses: BusNet;
  off: OffLayout;
};

const FIRST = [
  "Anna", "Ben", "Clara", "David", "Emma", "Felix", "Greta", "Hugo", "Ida", "Jonas", "Karla", "Leo", "Mia", "Noah",
  "Olga", "Paul", "Rosa", "Simon", "Tilda", "Udo", "Vera", "Walter", "Yara", "Zoe", "Alma", "Bruno", "Cora", "Emil",
  "Frieda", "Georg", "Hanna", "Ivo", "Johanna", "Kurt", "Lena", "Max", "Nora", "Oskar", "Paula", "Rudi", "Sophie",
  "Theo", "Ute", "Viktor", "Wilma", "Ada", "Carl", "Elsa", "Finn", "Hedda", "Jakob", "Liese", "Moritz", "Pia", "Toni",
];
const LAST = [
  "Bauer", "Becker", "Brandt", "Dietrich", "Engel", "Fischer", "Franke", "Graf", "Hartmann", "Huber", "Jung", "Kaiser",
  "Keller", "Klein", "Koch", "Krause", "Lang", "Lehmann", "Lorenz", "Maier", "Meyer", "Möller", "Neumann", "Otto",
  "Peters", "Richter", "Roth", "Sauer", "Schmidt", "Schneider", "Schulz", "Seidel", "Sommer", "Stein", "Vogel",
  "Wagner", "Weber", "Winter", "Wolf", "Ziegler", "Albers", "Baum", "Busch", "Haas", "Kühn", "Mertens", "Pohl",
];

export function buildTown(ctx: Ctx): { town: Town; issues: Issue[] } {
  const { layout, walks } = ctx;
  const issues: Issue[] = [];
  const links = linker(ctx);

  // --- buildings --------------------------------------------------------------
  const buildings: Building[] = [];
  ctx.scenery.forEach((p, k) => {
    const info = ctx.objects.get(p.object)!;
    const entry = p.entry >= 0 ? layout.scenery[p.entry] : undefined;
    const own = info.def.building;
    const over = entry?.object ? entry.building : undefined;
    const functions = over?.functions ?? own?.functions;
    if (!functions?.length) return;
    const station = p.station ? layout.stations.find((s) => s.id === p.station)! : null;
    const meta = { ...own, ...over };
    const c = Math.cos(p.rotation);
    const s = Math.sin(p.rotation);
    const [dx, dy] = meta.door ?? [info.mesh.max[0] + 0.3, (info.mesh.min[1] + info.mesh.max[1]) / 2];
    const door: P3 = [p.x + (dx * c - dy * s) * p.scale, p.y + (dx * s + dy * c) * p.scale, p.z];
    const titles = meta.titles ?? ["Employee"];
    const jobCount = functions.includes("workplace") ? meta.jobs ?? DEFAULT_JOBS : 0;
    buildings.push({
      id: buildings.length, placement: k, object: p.object,
      name: station ? (station.kind === "freight" ? station.name : `${station.name} Station`) : entry?.object && entry.name ? entry.name : "",
      kind: meta.kind ?? titleCase(p.object), functions,
      residents: functions.includes("accommodation") ? meta.residents ?? DEFAULT_RESIDENTS : 0,
      jobs: Array.from({ length: jobCount }, (_, j) => titles[Math.min(j, titles.length - 1)]),
      at: [p.x, p.y, p.z], door, access: null, bays: [], station: station?.id ?? null, supplies: { ...meta.supplies }, demands: { ...meta.demands },
      where: station ? `stations[${layout.stations.indexOf(station)}].building` : `scenery[${p.entry}]`,
    });
  });
  addresses(ctx, buildings);
  for (const b of buildings) b.access = links.attach(b.door, ACCESS_REACH);

  // --- parking bays -------------------------------------------------------------
  const bays: Bay[] = [];
  streetBays(ctx, bays);
  lotBays(ctx, bays, links);
  for (const b of bays) if (!b.access) b.access = links.attach(b.kerb, b.lot ? ACCESS_REACH : BAY_WALK_REACH);
  const bayHash = new SpatialHash<Bay>(20);
  for (const b of bays) bayHash.insert(b.kerb[0], b.kerb[1], b);
  for (const b of buildings) {
    const near: Array<{ bay: number; d: number }> = [];
    bayHash.near(b.door[0], b.door[1], DOOR_BAY_REACH, (bay) => {
      const d = Math.hypot(bay.kerb[0] - b.door[0], bay.kerb[1] - b.door[1]);
      if (d <= DOOR_BAY_REACH) near.push({ bay: bay.id, d });
    });
    near.sort((x, y) => x.d - y.d || x.bay - y.bay);
    for (const n of near) {
      if (b.bays.length >= DOOR_BAYS) break;
      const bay = bays[n.bay];
      if (!links.clear(b.door, bay.kerb, bay.lot)) continue;
      b.bays.push({ bay: n.bay, link: [b.door, bay.kerb], length: n.d });
    }
  }

  // --- stations: a way in from every path ending at one, through the building, and on to each platform ----
  const stations: StationAccess[] = [];
  for (const st of layout.stations) {
    const t = ctx.tracks.get(st.track);
    const entries = ctx.stationEntries.get(st.id);
    if (!t || !entries || st.kind === "freight") continue;          // goods yards take no passengers
    const home: 1 | -1 = st.side === "left" ? 1 : -1;
    const sOf = (p: P3) => nearestS(t, p, st.at, st.length);
    const building = buildings.find((b) => b.station === st.id);
    const entrances: Entrance[] = [];
    for (const node of walks.stationNodes.filter((n) => n.station === st.id)) {
      const n = walks.nodes[node.node];
      const at: P3 = [n.at[0], n.at[1], n.z];
      const e = entries.reduce((a, b) => (Math.hypot(a.at[0] - at[0], a.at[1] - at[1]) <= Math.hypot(b.at[0] - at[0], b.at[1] - at[1]) ? a : b));
      const w = walks.ways[n.ways[0].way];
      entrances.push({ entry: at, entryS: sOf(at), side: e.side, via: "path", door: null, access: { way: w.id, d: n.ways[0].end === 0 ? 0 : w.length, link: [at], length: 0 } });
    }
    if (building?.access) {
      // In at its door, out in front of it on the platform.
      entrances.push({ entry: platformPoint(ctx, st.id, st.at, 1, home), entryS: st.at, side: home, via: "building", door: building.door, access: building.access });
    }
    for (const side of [1, -1] as const) {
      if (entrances.some((e) => e.side === side)) continue;
      // Otherwise the platform's nearest walkway, wherever it is closest.
      let best: { e: StationEntry; a: Attach } | null = null;
      for (const e of entries.filter((x) => x.side === side)) {
        const a = links.attach(e.at, ACCESS_REACH);
        if (a && (!best || a.length < best.a.length)) best = { e, a };
      }
      if (best) entrances.push({ entry: best.e.at, entryS: best.e.s, side, via: "direct", door: null, access: best.a });
    }
    stations.push({ station: st.id, name: st.name, track: st.track, building: building?.id ?? -1, entrances });
  }

  // --- bus stops: the walkway beside each, and room for its shelter -----------------------
  const stops: StopAccess[] = ctx.buses.sides.map((side) => ({
    access: links.attach(side.at, ACCESS_REACH),
    shelter: side.shelter !== null && shelterFits(ctx, links, side.shelter, side.heading),
  }));

  // --- places to stroll to ------------------------------------------------------------
  const spots: Spot[] = [];
  for (const w of walks.ways) {
    if (w.kind !== "path" || w.length < 30) continue;
    const spec = walks.paths.get(w.owner)!.spec;
    for (let d = 15; d < w.length - 10; d += SPOT_SPACING) {
      if (inGateZone(w, d)) continue;
      spots.push({ id: spots.length, name: displayName(spec), way: w.id, d, at: wayPoint(w, d) });
    }
  }

  // --- who is unreachable (in a layout with walkways or parking at all) -------------------
  for (const b of walks.ways.length || bays.length ? buildings : []) {
    if (b.access || b.bays.length || b.station) continue;
    issues.push(warning("BUILDING_UNREACHABLE", `${b.kind.toLowerCase()} '${b.name}' has no sidewalk or path within ${ACCESS_REACH} m of its door (and no parking bay beside it), so nobody can live, work or visit there; run a sidewalk or path past it, or turn its door toward one`, b.where, [b.door[0], b.door[1]]));
  }

  // --- people ------------------------------------------------------------------------
  const people = residents(ctx, buildings, bays, issues);
  const passengerServices = layout.services.filter((s) => !isTrainType(s.train) || TRAIN_CATALOG[s.train].shape !== "freight");
  layout.stations.forEach((st, i) => {
    const access = stations.find((x) => x.station === st.id);
    if (!people.length || st.kind === "freight" || access?.entrances.length || !passengerServices.some((s) => s.stops.includes(st.id))) return;
    issues.push(warning("STATION_UNREACHABLE", `station '${st.id}' has no walkway within ${ACCESS_REACH} m of its platforms or building, so nobody can catch a train there; end a path at it ("to": { "station": "${st.id}" }) or run a sidewalk past it`, `stations[${i}]`));
  });
  ctx.buses.sides.forEach((side, k) => {
    if (!people.length || stops[k].access) return;
    const stop = ctx.buses.stops[side.stop];
    issues.push(warning("BUS_STOP_UNREACHABLE", `bus stop '${stop.id}' (${side.side > 0 ? "left" : "right"} side of '${stop.road}') has no walkway within ${ACCESS_REACH} m, so nobody can catch a bus there; give the road a sidewalk on that side or run a path to it`, `busStops[${stop.index}]`, [side.at[0], side.at[1]]));
  });
  return { town: { buildings, bays, stations, spots, people, lots: ctx.lots, stops }, issues };
}

const titleCase = (id: string) => id.split("-").map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");

/** s of the track point nearest p, within a station's platform. */
function nearestS(t: TrackGeom, p: P3, at: number, length: number): number {
  let best = at;
  let bd = Infinity;
  for (let s = at - length / 2; s <= at + length / 2; s += 0.5) {
    const v = t.path.closed ? mod(s, t.path.length) : Math.min(Math.max(s, 0), t.path.length);
    const [x, y] = pointAt(t.path, v);
    const d = Math.hypot(x - p[0], y - p[1]);
    if (d < bd) { bd = d; best = v; }
  }
  return best;
}

/**
 * A point on a station's platform at track s and `across` its width (0 at the
 * track's edge, 1 at the back), on the given side (default the building's).
 */
export function platformPoint(ctx: Pick<Ctx, "layout" | "tracks" | "profiles">, station: string, s0: number, across = 0.75, side?: 1 | -1): P3 {
  const st = ctx.layout.stations.find((x) => x.id === station)!;
  const t = ctx.tracks.get(st.track)!;
  side ??= st.side === "left" ? 1 : -1;
  const L = t.path.length;
  const s = t.path.closed ? mod(s0, L) : Math.min(Math.max(s0, 0), L);
  const [x, y] = pointAt(t.path, s);
  const h = headingAt(t.path, s);
  const lateral = side * (3.7 - 2 + 4 * across * 0.98);
  return [x - Math.sin(h) * lateral, y + Math.cos(h) * lateral, profileZ(ctx.profiles.get(st.track)!, s) + 0.9];
}

/** Whether d along a walkway is in (or near) the zone of a level or foot crossing, where nobody may join it. */
const inGateZone = (w: Walkway, d: number) => w.gates.some((g) => Math.abs(d - g.at) < g.zone + GATE_CLEAR);

/** Whether a bus shelter (3.2 × 1.4 m, its back to the road) has room: no road, track, walkway or object there. */
function shelterFits(ctx: Ctx, links: ReturnType<typeof linker>, at: P3, heading: number): boolean {
  const [c, s] = [Math.cos(heading), Math.sin(heading)];
  const solids = ctx.scenery.filter((p) => ctx.objects.get(p.object)!.mesh.max[2] * p.scale >= 0.5);
  for (const u of [-1.7, 0, 1.7]) {
    for (const v of [-0.7, 0, 0.7]) {
      const x = at[0] + c * u - s * v;
      const y = at[1] + s * u + c * v;
      if (links.onRoad(x, y, at[2], null) || links.onTrack(x, y, at[2])) return false;
      let walk = false;
      ctx.walks.hash.near(x, y, 4, (q) => { if (!walk && Math.hypot(q.x - x, q.y - y) < q.width / 2 && Math.abs(q.z - at[2]) < 3) walk = true; });
      if (walk) return false;
      for (const p of solids) {
        const m = ctx.objects.get(p.object)!.mesh;
        const [pc, ps] = [Math.cos(p.rotation), Math.sin(p.rotation)];
        const lx = ((x - p.x) * pc + (y - p.y) * ps) / p.scale;
        const ly = (-(x - p.x) * ps + (y - p.y) * pc) / p.scale;
        if (lx > m.min[0] - 0.2 && lx < m.max[0] + 0.2 && ly > m.min[1] - 0.2 && ly < m.max[1] + 0.2) return false;
      }
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Links from doors, bays and platforms to the walkways

function linker(ctx: Ctx) {
  const { walks, roads, trackHash } = ctx;
  type Sample = { way: number; d: number; x: number; y: number; z: number };
  const hash = new SpatialHash<Sample>(8);
  for (const w of walks.ways) {
    if (w.kind === "zebra" || w.kind === "crossing") continue;
    for (let d = 0; d <= w.length; d += 1) {
      if (inGateZone(w, d)) continue;
      const [x, y, z] = wayPoint(w, d);
      hash.insert(x, y, { way: w.id, d, x, y, z });
    }
    if (!inGateZone(w, w.length)) {
      const [x, y, z] = wayPoint(w, w.length);
      hash.insert(x, y, { way: w.id, d: w.length, x, y, z });
    }
  }

  /** On a road's paved area (or a car park other than `own`)? */
  const onRoad = (x: number, y: number, z: number, own: string | null): boolean => {
    let hit = false;
    roads.hash.near(x, y, 14, (q: RoadPoint) => {
      if (hit || q.road === own || Math.abs(q.z - z) > 3) return;
      const dx = x - q.x;
      const dy = y - q.y;
      const along = dx * Math.cos(q.heading) + dy * Math.sin(q.heading);
      const lat = -dx * Math.sin(q.heading) + dy * Math.cos(q.heading);
      if (Math.abs(along) <= 1.2 && lat < q.left - 0.05 && lat > -q.right + 0.05) hit = true;
    });
    return hit;
  };
  const onTrack = (x: number, y: number, z: number): boolean => {
    let hit = false;
    trackHash.near(x, y, 4, (t) => { if (!hit && Math.hypot(t.x - x, t.y - y) < 2.6 && Math.abs(t.z - z) < 3) hit = true; });
    return hit;
  };

  /** A straight walk from a to b that stays off roads and tracks and changes height little. */
  const clear = (a: P3, b: P3, own: string | null = null): boolean => {
    if (Math.abs(a[2] - b[2]) > LINK_CLIMB) return false;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.ceil(len / LINK_STEP));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const x = a[0] + (b[0] - a[0]) * t;
      const y = a[1] + (b[1] - a[1]) * t;
      const z = a[2] + (b[2] - a[2]) * t;
      if (onRoad(x, y, z, own) || onTrack(x, y, z)) return false;
    }
    return true;
  };

  /** The nearest walkway point reachable in a straight line from p, within reach. */
  const attach = (p: P3, reach: number, own: string | null = null): Attach | null => {
    const best = new Map<number, Sample & { dist: number }>();
    hash.near(p[0], p[1], reach, (q) => {
      const dist = Math.hypot(q.x - p[0], q.y - p[1]);
      if (dist > reach) return;
      const prev = best.get(q.way);
      if (!prev || dist < prev.dist) best.set(q.way, { ...q, dist });
    });
    const list = [...best.values()].sort((a, b) => a.dist - b.dist || a.way - b.way);
    for (const q of list) {
      const to: P3 = [q.x, q.y, q.z];
      if (!clear(p, to, own)) continue;
      return { way: q.way, d: q.d, link: [p, to], length: q.dist };
    }
    return null;
  };
  return { attach, clear, onRoad, onTrack };
}

// ---------------------------------------------------------------------------
// Addresses: numbered along the nearest street, odd on the left and even on the right

function addresses(ctx: Ctx, buildings: Building[]): void {
  const { roads, walks } = ctx;
  const lotIds = new Set(ctx.lots.map((l) => l.id));
  type Pos = { b: Building; street: string; s: number; side: 1 | -1 };
  const byStreet = new Map<string, Pos[]>();
  const lone: Building[] = [];
  for (const b of buildings) {
    if (b.name) continue;
    let best: { street: string; s: number; side: 1 | -1; d: number } | null = null;
    roads.hash.near(b.door[0], b.door[1], STREET_REACH, (q) => {
      if (lotIds.has(q.road)) return;
      const d = Math.hypot(q.x - b.door[0], q.y - b.door[1]);
      if (d > STREET_REACH || (best && d >= best.d)) return;
      const lat = -(b.door[0] - q.x) * Math.sin(q.heading) + (b.door[1] - q.y) * Math.cos(q.heading);
      best = { street: displayName(roads.roads.get(q.road)!.spec), s: q.s, side: lat >= 0 ? 1 : -1, d };
    });
    if (!best) {
      walks.hash.near(b.door[0], b.door[1], STREET_REACH, (q) => {
        if (q.kind !== "path") return;
        const d = Math.hypot(q.x - b.door[0], q.y - b.door[1]);
        if (d > STREET_REACH || (best && d >= best.d)) return;
        best = { street: displayName(walks.paths.get(q.owner)!.spec), s: d, side: 1, d };
      });
    }
    if (!best) { lone.push(b); continue; }
    const pos = best as { street: string; s: number; side: 1 | -1 };
    if (!byStreet.has(pos.street)) byStreet.set(pos.street, []);
    byStreet.get(pos.street)!.push({ b, ...pos });
  }
  for (const [street, list] of byStreet) {
    list.sort((a, b) => a.s - b.s || a.b.id - b.b.id);
    let odd = 1;
    let even = 2;
    for (const p of list) {
      const n = p.side > 0 ? odd : even;
      if (p.side > 0) odd += 2;
      else even += 2;
      p.b.name = `${n} ${street}`;
    }
  }
  // Away from any street: named for what they are, numbered if there are several.
  const count = new Map<string, number>();
  for (const b of lone) count.set(b.kind, (count.get(b.kind) ?? 0) + 1);
  const seen = new Map<string, number>();
  for (const b of lone) {
    const k = (seen.get(b.kind) ?? 0) + 1;
    seen.set(b.kind, k);
    b.name = count.get(b.kind)! > 1 ? `${b.kind} ${k}` : b.kind;
  }
}

// ---------------------------------------------------------------------------
// Parking bays

/** Bays along every street with parking, kept clear of junctions, crossings, bridges and dead ends. */
function streetBays(ctx: Ctx, bays: Bay[]): void {
  const { roads, walks } = ctx;
  const lotIds = new Set(ctx.lots.map((l) => l.id));
  for (const r of roads.roads.values()) {
    if (lotIds.has(r.id)) continue;
    const L = r.path.length;
    const prof = roads.profiles.get(r.id)!;
    const spans = roads.spans.get(r.id)!;
    for (const side of [1, -1] as const) {
      const pw = parkingWidth(r.spec, side);
      if (pw <= 0) continue;
      const style = r.spec.parkingStyle;
      const pitch = style === "parallel" ? PARALLEL_BAY : BAY_PITCH;
      const blocked: Array<[number, number]> = [];
      for (const st of roads.stops.get(r.id)!) {
        const n = roads.nodes[st.node];
        if (n.legs.length === 1) {
          blocked.push([st.s - END_CLEAR, st.s + END_CLEAR]);
          continue;
        }
        const h = headingAt(r.path, st.s);
        let box = 4;
        for (const o of n.legs) {
          if (o.road === r.id) continue;
          const other = roads.roads.get(o.road)!;
          const sin = Math.abs(Math.sin(headingAt(other.path, o.s) - h));
          box = Math.max(box, pavedHalf(other.spec) / Math.max(sin, 0.4) + 1.5);
        }
        blocked.push([st.s - box - JUNCTION_CLEAR, st.s + box + JUNCTION_CLEAR]);
      }
      for (const c of roads.crossings) if (c.road === r.id) blocked.push([c.roadS - c.zone - CROSSING_CLEAR, c.roadS + c.zone + CROSSING_CLEAR]);
      for (const c of walks.crossings) if (c.road === r.id) blocked.push([c.roadS - c.half - ZEBRA_CLEAR, c.roadS + c.half + ZEBRA_CLEAR]);
      // Nobody parks where a bus stops.
      for (const st of ctx.buses.sides) {
        if (st.side !== side || ctx.buses.stops[st.stop].road !== r.id) continue;
        const front = st.s + st.dir * FRONT_PAST;
        const back = front - st.dir * st.reach;
        blocked.push([Math.min(front, back) - BUS_CLEAR, Math.max(front, back) + BUS_CLEAR]);
      }
      // Where a path meets this side of the road, people step off the kerb: keep it free.
      for (const p of walks.paths.values()) {
        for (const [k, e] of [[0, p.spec.from], [1, p.spec.to]] as const) {
          if (e?.road !== r.id) continue;
          const [x, y] = pointAt(p.path, k === 0 ? 0 : p.path.length);
          const s = nearestRoadS(r.path, x, y);
          blocked.push([s - 3, s + 3]);
        }
      }
      // A car pulls out forward along its lane (toward lower s on the left side): keep that stretch clear too.
      for (const range of blocked) {
        if (side > 0) range[1] += PULL_OUT + 1;
        else range[0] -= PULL_OUT + 1;
      }
      if (!r.path.closed) blocked.push([-Infinity, 3], [L - 3, Infinity]);
      const free = (a: number, b: number) => {
        for (const [x, y] of blocked) {
          if (r.path.closed) {
            for (const k of [-L, 0, L]) if (b > x + k && a < y + k) return false;
          } else if (b > x && a < y) return false;
        }
        for (let s = a; s <= b; s += 1) if (structureAt(spans, r.path.closed ? mod(s, L) : s) !== "ground") return false;
        return true;
      };
      for (let s = pitch / 2 + 1; s + pitch / 2 <= L - 1; ) {
        if (!free(s - pitch / 2, s + pitch / 2)) { s += 1; continue; }
        const sv = r.path.closed ? mod(s, L) : s;
        const [px, py] = pointAt(r.path, sv);
        const h = headingAt(r.path, sv);
        const nx = -Math.sin(h);
        const ny = Math.cos(h);
        const mid = side * (r.spec.width / 2 + pw / 2);
        const z = profileZ(prof, sv);
        const sw = sidewalkWidth(r.spec, side);
        const kerbLat = side * (kerbOffset(r.spec, side) + (sw > 0 ? sw / 2 : 0.6));
        bays.push({
          id: bays.length, road: r.id, side, s: sv, x: px + nx * mid, y: py + ny * mid, z,
          heading: style === "parallel" ? h + (side > 0 ? Math.PI : 0) : h + side * (Math.PI / 2),
          style, lot: null, length: style === "parallel" ? PARALLEL_BAY : PARKING_WIDTH.perpendicular, width: style === "parallel" ? pw : BAY_PITCH,
          kerb: [px + nx * kerbLat, py + ny * kerbLat, z + (sw > 0 ? KERB : 0)], access: null,
        });
        s += pitch;
      }
    }
  }
}

/** Nose-in bays either side of each car park's aisle; their people walk out by the lot's front corner. */
function lotBays(ctx: Ctx, bays: Bay[], links: ReturnType<typeof linker>): void {
  const { roads } = ctx;
  for (const lot of ctx.lots) {
    const aisle = roads.roads.get(lot.id);
    if (!aisle) continue;
    const prof = roads.profiles.get(lot.id)!;
    const { bayS0 } = lotFrame(lot, aisle);
    // The lot's way out on foot: whichever front corner reaches a walkway.
    const u = [Math.cos(lot.heading), Math.sin(lot.heading)];
    const n = [-u[1], u[0]];
    let out: { corner: P3; access: Attach } | null = null;
    for (const k of [1, -1]) {
      const corner: P3 = [
        lot.entrance[0] + n[0] * k * (lot.width / 2 - 0.5) - u[0] * 0.5, lot.entrance[1] + n[1] * k * (lot.width / 2 - 0.5) - u[1] * 0.5,
        profileZ(prof, bayS0),
      ];
      const a = links.attach(corner, ACCESS_REACH, lot.id);
      if (a && (!out || a.length < out.access.length)) out = { corner, access: a };
    }
    let placed = 0;
    for (let k = 0; k < lot.perSide; k++) {
      const s = bayS0 + (k + 0.5) * BAY_PITCH;
      if (s > aisle.path.length - 7) break;
      const [px, py] = pointAt(aisle.path, s);
      const h = headingAt(aisle.path, s);
      const z = profileZ(prof, s);
      for (const side of [-1, 1] as const) {
        if (placed >= lot.spec.spaces) break;
        const mid = side * (LOT_AISLE / 2 + BAY_DEPTH / 2);
        const x = px - Math.sin(h) * mid;
        const y = py + Math.cos(h) * mid;
        const kerb: P3 = [px - Math.sin(h) * side * (LOT_AISLE / 2 + 0.6), py + Math.cos(h) * side * (LOT_AISLE / 2 + 0.6), z];
        let access: Attach | null = null;
        if (out) {
          const toCorner = Math.hypot(out.corner[0] - kerb[0], out.corner[1] - kerb[1]);
          access = { way: out.access.way, d: out.access.d, link: [kerb, ...out.access.link], length: toCorner + out.access.length };
        }
        bays.push({
          id: bays.length, road: lot.id, side, s, x, y, z, heading: h + side * (Math.PI / 2), style: "perpendicular", lot: lot.id,
          length: BAY_DEPTH, width: BAY_PITCH, kerb, access,
        });
        placed++;
      }
    }
  }
}

function nearestRoadS(path: { length: number; closed: boolean } & Parameters<typeof pointAt>[0], x: number, y: number): number {
  let best = 0;
  let bd = Infinity;
  for (let s = 0; s <= path.length; s += 1) {
    const [px, py] = pointAt(path, s);
    const d = Math.hypot(px - x, py - y);
    if (d < bd) { bd = d; best = s; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Residents

function residents(ctx: Ctx, buildings: Building[], bays: Bay[], issues: Issue[]): Person[] {
  const { layout } = ctx;
  const r = rng(layout.seed, "people");
  const tastes = rng(layout.seed, "bus-tastes");
  const reachable = (b: Building) => b.access !== null || b.bays.length > 0;
  const homes = buildings.filter((b) => b.residents > 0 && reachable(b));
  const capacity = homes.reduce((a, b) => a + b.residents, 0);
  const asked = layout.people.count;
  if (asked !== undefined && asked > capacity) {
    issues.push(warning("CAPACITY", `people.count is ${asked} but the reachable homes hold only ${capacity}; ${capacity} people live here (add accommodation or raise its residents)`, "people.count"));
  }
  const want = Math.min(asked ?? Math.min(capacity, AUTO_MAX), capacity);
  // Fill homes in a random order, a household at a time, sharing a surname.
  const beds: number[] = [];
  for (const b of shuffle(r, homes.slice())) for (let k = 0; k < b.residents; k++) beds.push(b.id);
  const chosen = beds.slice(0, want).sort((a, b) => a - b);
  const people: Person[] = [];
  let lastHome = -1;
  let inHousehold = 0;
  let surname = "";
  for (const home of chosen) {
    const b = buildings[home];
    const size = b.residents <= 4 ? b.residents : 2 + Math.floor(r() * 2);
    if (home !== lastHome || inHousehold >= size) {
      surname = LAST[Math.floor(r() * LAST.length)];
      inHousehold = 0;
    }
    lastHome = home;
    inHousehold++;
    const first = FIRST[Math.floor(r() * FIRST.length)];
    people.push({
      id: people.length, first, last: surname, name: `${first} ${surname}`, home, job: null, car: null,
      prefs: { walk: range(r, 0.9, 1.7), drive: range(r, 0.8, 1.4), train: range(r, 0.75, 1.3), bus: range(tastes, 0.8, 1.35) },
    });
  }
  // Jobs: workplaces' posts (and those off the board) go to people picked at random, up to the employment rate.
  const posts: Array<{ title: string; building: number; off: number; rank: number }> = [];
  for (const b of buildings) if (reachable(b) || b.station) b.jobs.forEach((title) => posts.push({ title, building: b.id, off: -1, rank: b.jobs.indexOf(title) }));
  for (const place of ctx.off.places) place.jobs.forEach((title) => posts.push({ title, building: -1, off: place.index, rank: place.jobs.indexOf(title) }));
  const workers = shuffle(r, people.slice()).slice(0, Math.min(posts.length, Math.round(people.length * EMPLOYMENT)));
  shuffle(r, posts);
  // Leading posts (the first titles of each workplace) are filled first.
  posts.sort((a, b) => a.rank - b.rank);
  workers.forEach((p, k) => { p.job = { title: posts[k].title, building: posts[k].building, off: posts[k].off }; });
  // Cars: parked at the nearest free bay to home.
  const taken = new Set<number>();
  const vehicles = layout.people.vehicles;
  for (const p of people) {
    if (r() >= layout.people.cars) continue;
    const home = buildings[p.home];
    let best: { bay: number; d: number } | null = null;
    for (const bay of bays) {
      if (taken.has(bay.id) || (!bay.access && !home.bays.some((x) => x.bay === bay.id))) continue;
      const d = Math.hypot(bay.kerb[0] - home.door[0], bay.kerb[1] - home.door[1]);
      if (d <= HOME_PARKING && (!best || d < best.d)) best = { bay: bay.id, d };
    }
    if (!best) continue;
    taken.add(best.bay);
    p.car = { object: vehicles[Math.floor(r() * vehicles.length)], bay: best.bay };
  }
  return people;
}

function shuffle<T>(r: Rng, a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** A walkway's point at d, for callers holding only the net. */
export const attachPoint = (walks: WalkNet, a: Attach): P3 => wayPoint(walks.ways[a.way] as Walkway, a.d);
