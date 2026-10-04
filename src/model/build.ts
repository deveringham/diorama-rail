// The single model entry point: parse → validate → build a World. Never throws
// for bad input; returns a Report with precise issues instead. The World holds
// everything the sim and scene need, all derived from the JSON plus its seed.

import { LayoutSchema, type Layout } from "./schema";
import { type TrackGeom, type Junction, type Graph, trackOrder, buildTrack, junctionsOf, buildGraph } from "./trackGraph";
import { type Profile, type Span, buildProfile, classify, profileZ, structureAt } from "./heights";
import { type Terrain, buildTerrain, baseZ, shapeCorridor } from "./terrain";
import { type RoutePath, buildRoute } from "./routes";
import { type StationGeom, type Placement, type ObjectInfo, buildStations, placeScenery, objectCatalog, stationEntries } from "./scenery";
import { type RoadNet, buildRoads, emptyRoadNet, roadGeometry } from "./roads";
import { type WalkNet, buildWalks, emptyWalkNet } from "./walks";
import { planLots, lotPoints, lotIssue } from "./parking";
import { type Town, buildTown } from "./town";
import { type BusNet, buildBusStops, buildBusLines, emptyBusNet } from "./buses";
import { type OffLayout, findExits, buildOffLayout } from "./exits";
import { type FreightNet, buildFreight, emptyFreightNet } from "./freight";
import {
  type Issue, type Report, type TrackPoint, error, makeReport, zodIssues, checkReferences, checkJunctionPosition,
  checkBounds, checkConflicts, checkStations, checkServices,
} from "./validate";
import { pointAt, sampleS } from "./geometry";
import { TRAIN_CATALOG, isTrainType, trainLength } from "./catalog";
import { SpatialHash } from "../util/spatial";

const POINT_STEP = 2;      // m between dense track points (conflicts, shaping, queries)
const ROAD_BED = 0.3;      // m the ground sits below a road surface (the slab's thickness hides the rest)
const PATH_BED = 0.1;      // m the ground sits below a path's surface

export type World = {
  layout: Layout;
  tracks: Map<string, TrackGeom>;
  order: string[];                    // dependency order, parents first
  junctions: Junction[];
  graph: Graph;
  profiles: Map<string, Profile>;
  spans: Map<string, Span[]>;
  terrain: Terrain;
  points: TrackPoint[];
  pointHash: SpatialHash<TrackPoint>;
  stations: StationGeom[];
  routes: Map<string, RoutePath>;
  objects: Map<string, ObjectInfo>;   // every usable object definition, meshed for the season
  scenery: Placement[];
  roads: RoadNet;
  walks: WalkNet;                     // footpaths, sidewalks and where people cross
  town: Town;                         // buildings, parking bays, station access and the residents
  buses: BusNet;                      // bus stops and the lines calling at them
  offLayout: OffLayout;               // where lines leave the board, and the places beyond
  freight: FreightNet;                // goods yards, what is sent and needed where, docks and the delivery fleet
  stats: Record<string, number>;
};

const hasErrors = (issues: Issue[]) => issues.some((i) => i.severity === "error");

export function buildWorld(json: unknown): { world: World | null; report: Report } {
  const parsed = LayoutSchema.safeParse(json);
  if (!parsed.success) return { world: null, report: makeReport(zodIssues(parsed.error)) };
  const layout = parsed.data;
  const issues: Issue[] = checkReferences(layout);
  if (hasErrors(issues)) return { world: null, report: makeReport(issues) };

  const { order, cycle } = trackOrder(layout);
  if (cycle) {
    const i = layout.tracks.findIndex((t) => t.id === cycle[0]);
    issues.push(error("TRACK_REF_CYCLE", `tracks reference each other in a cycle (${cycle.join(" → ")}); a branch's from/to must point at a track that does not depend on it`, `tracks[${i}]`));
    return { world: null, report: makeReport(issues) };
  }

  // Geometry and heights, parents first. A branch of a failed parent is skipped.
  const terrain = buildTerrain(layout);
  const base = (x: number, y: number) => baseZ(terrain, x, y);
  const tracks = new Map<string, TrackGeom>();
  const profiles = new Map<string, Profile>();
  const spans = new Map<string, Span[]>();
  for (const id of order) {
    const index = layout.tracks.findIndex((t) => t.id === id);
    const spec = layout.tracks[index];
    const parents = [spec.from, spec.to].filter((e) => e !== undefined);
    if (parents.some((e) => !tracks.has(e.track))) continue;
    const posIssues = checkJunctionPosition(layout, spec, index, tracks);
    issues.push(...posIssues);
    if (hasErrors(posIssues)) continue;
    const built = buildTrack(spec, index, tracks);
    issues.push(...built.issues.map((g) => error(g.code, g.message, g.jsonPath, g.at)));
    if (!built.track) continue;
    const t = built.track;
    tracks.set(id, t);
    const pins = parents.map((e, k) => ({
      s: k === 0 && spec.from ? 0 : t.path.length,
      z: profileZ(profiles.get(e.track)!, e.at),
    }));
    const { profile, issues: gradeIssues } = buildProfile(t, base, pins);
    for (const g of gradeIssues) issues.push(error("GRADE_EXCEEDED", g.message, `tracks[${index}]`, pointAt(t.path, g.s0)));
    profiles.set(id, profile);
    spans.set(id, classify(t, profile, base));
  }

  // Dense points for bounds, conflicts, shaping and queries.
  const points: TrackPoint[] = [];
  for (const t of tracks.values()) {
    const p = profiles.get(t.id)!;
    for (const s of sampleS(t.path, POINT_STEP)) {
      const [x, y] = pointAt(t.path, s);
      points.push({ track: t.id, s, x, y, z: profileZ(p, s) });
    }
  }
  const pointHash = new SpatialHash<TrackPoint>(10);
  for (const p of points) pointHash.insert(p.x, p.y, p);
  issues.push(...checkBounds(layout, tracks, points));
  if (tracks.size < layout.tracks.length) return { world: null, report: makeReport(issues) };

  const junctions = junctionsOf(tracks);
  const graph = buildGraph(tracks, junctions);
  // Car parks become dead-end aisle roads joined to the nearest road (or the one named).
  const planned = layout.parking.length ? planLots(layout, roadGeometry(layout.roads)) : { lots: [], specs: [], issues: [] };
  issues.push(...planned.issues);
  const roadLayout = planned.specs.length ? { ...layout, roads: [...layout.roads, ...planned.specs] } : layout;
  const built = buildRoads({ layout: roadLayout, tracks, trackProfiles: profiles, trackSpans: spans, junctions, terrain });
  issues.push(...built.issues.map((i) => lotIssue(i, layout, planned.lots)));
  const roads = built.net ?? emptyRoadNet();
  if (built.net && planned.lots.length) {
    const lp = lotPoints(planned.lots, roads, pointHash);
    issues.push(...lp.issues);
    for (const p of lp.points) { roads.points.push(p); roads.hash.insert(p.x, p.y, p); }
  }
  const objects = objectCatalog(layout.objects, layout.style.season);
  const entries = stationEntries(layout, tracks, profiles, objects);
  const walked = built.net
    ? buildWalks({ layout, stationEntries: entries, tracks, trackProfiles: profiles, trackSpans: spans, junctions, terrain, roads })
    : null;
  if (walked) issues.push(...walked.issues);
  const walks = walked?.net ?? emptyWalkNet();
  // Where tracks, roads and paths leave the board, and the places beyond.
  const found = findExits(layout, { tracks: [...tracks.values()], roads: [...roads.roads.values()], paths: [...walks.paths.values()] });
  issues.push(...found.issues);
  const offPlaces = buildOffLayout(layout, found.exits);
  issues.push(...offPlaces.issues);
  const offLayout: OffLayout = { exits: found.exits, places: offPlaces.places };
  for (const n of walks.nodes) {
    // A path's or sidewalk's end where its path or road leaves the board.
    if (n.ways.length !== 1) continue;
    const owner = walks.ways[n.ways[0].way].owner;
    const e = found.exits.find((x) => x.kind !== "track" && x.line === owner && Math.hypot(x.at[0] - n.at[0], x.at[1] - n.at[1]) < 15);
    if (e) n.exit = e.id;
  }
  const busCtx = { layout, roads, walks, objects, lots: new Set(planned.lots.map((l) => l.id)), off: offLayout };
  const bused = built.net ? buildBusStops(busCtx) : null;
  if (bused) issues.push(...bused.issues);
  const buses = bused?.net ?? emptyBusNet();
  // Shaping in passes: track beds first, then roads, then paths, each keeping what came before flat.
  const bed = shapeCorridor(terrain, points.map((p) => ({ x: p.x, y: p.y, z: p.z, ground: structureAt(spans.get(p.track)!, p.s) === "ground" })));
  const roadBed = shapeCorridor(terrain, roads.points.map((p) => ({ x: p.x, y: p.y, z: p.z, ground: p.ground, flat: p.reach + 1, depth: ROAD_BED })), bed);
  for (let v = 0; v < bed.length; v++) roadBed[v] |= bed[v];
  shapeCorridor(terrain, walks.points.filter((p) => p.kind === "path").map((p) => ({ x: p.x, y: p.y, z: p.z, ground: p.ground, flat: p.width / 2 + 0.6, depth: PATH_BED })), roadBed);
  issues.push(...checkConflicts(tracks, junctions, points));
  issues.push(...checkStations(layout, tracks, spans));

  const stationById = new Map(layout.stations.map((s) => [s.id, s]));
  const routes = new Map<string, RoutePath>();
  layout.services.forEach((svc, i) => {
    if (!isTrainType(svc.train)) return;
    const res = buildRoute(svc, i, graph, tracks, stationById, trainLength(TRAIN_CATALOG[svc.train]), offLayout);
    issues.push(...res.issues.map((r) => error(r.code, r.message, r.jsonPath)));
    if (res.route) routes.set(svc.id, res.route);
  });
  issues.push(...checkServices(layout, routes));

  const stations = buildStations(layout);
  const placed = placeScenery({ layout, tracks, profiles, terrain, trackHash: pointHash, roadHash: roads.hash, walkHash: walks.hash, stations, objects });
  issues.push(...placed.issues);
  if (hasErrors(issues)) return { world: null, report: makeReport(issues) };
  const town = buildTown({
    layout, tracks, profiles, spans, trackHash: pointHash, roads, walks, lots: planned.lots, stations, stationEntries: entries, objects,
    scenery: placed.placements, buses, off: offLayout,
  });
  issues.push(...town.issues);
  // Bus lines, calling at the sides of stops people can walk to where they can.
  issues.push(...buildBusLines(busCtx, buses, (side) => town.town.stops[side]?.access != null));
  if (hasErrors(issues)) return { world: null, report: makeReport(issues) };
  // Freight: goods yards, who sends and needs what, where lorries stop, and the fleet.
  const freighted = built.net
    ? buildFreight({ layout, tracks, profiles, roads, walks, buses, town: town.town, off: offLayout, objects, lots: busCtx.lots })
    : { net: emptyFreightNet(), issues: [] };
  issues.push(...freighted.issues);
  const world: World = {
    layout, tracks, order, junctions, graph, profiles, spans, terrain, points, pointHash, stations, routes, objects,
    scenery: placed.placements, roads, walks, town: town.town, buses, offLayout, freight: freighted.net, stats: {},
  };
  world.stats = computeStats(world);
  return { world, report: makeReport(issues, world.stats) };
}

function computeStats(w: World): Record<string, number> {
  let trackLength = 0;
  let bridgeLength = 0;
  let tunnelLength = 0;
  for (const t of w.tracks.values()) {
    trackLength += t.path.length;
    for (const sp of w.spans.get(t.id)!) {
      if (sp.kind === "bridge") bridgeLength += sp.s1 - sp.s0;
      if (sp.kind === "tunnel") tunnelLength += sp.s1 - sp.s0;
    }
  }
  const isTree = (id: string) => ["foliage", "needles"].includes(String(w.objects.get(id)!.def.tint));
  const trees = w.scenery.filter((p) => isTree(p.object)).length;
  const objectTris = w.scenery.reduce((a, p) => a + w.objects.get(p.object)!.mesh.triangles, 0);
  const trains = w.layout.services.reduce((a, s) => a + s.count, 0);
  const cars = w.layout.services.reduce((a, s) => a + s.count * (isTrainType(s.train) ? TRAIN_CATALOG[s.train].cars : 0), 0);
  const roadLength = [...w.roads.roads.values()].reduce((a, r) => a + r.path.length, 0);
  const pathLength = [...w.walks.paths.values()].reduce((a, p) => a + p.path.length, 0);
  const sidewalkLength = w.walks.ways.filter((x) => x.kind === "sidewalk" || x.kind === "corner").reduce((a, x) => a + x.length, 0);
  const people = w.town.people.length;
  const ownCars = w.town.people.filter((p) => p.car).length;
  const through = throughTraffic(w);
  const meanTris = (ids: string[]) => ids.reduce((a, id) => a + (w.objects.get(id)?.mesh.triangles ?? 0), 0) / Math.max(1, ids.length);
  const vehicleTris = through * meanTris(w.layout.traffic.vehicles) + ownCars * meanTris(w.layout.people.vehicles)
    + w.buses.lines.reduce((a, l) => a + l.count * meanTris([l.vehicle]), 0) + w.freight.fleet.reduce((a, f) => a + f.count * meanTris([f.object]), 0);
  // Triangle budget: terrain grid + skirt, scenery objects, track (sleepers, rails, ballast), roads
  // (surface, verges, markings), trains, vehicles, platforms.
  const triangles = 2 * w.terrain.nx * w.terrain.ny + 4 * (w.terrain.nx + w.terrain.ny) + objectTris
    + Math.round(trackLength / 0.65) * 10 + Math.round(trackLength / 2) * 22 + Math.round(roadLength / 2) * 6 + Math.round(roadLength / 6) * 2
    + cars * 60 + Math.round(vehicleTris) + w.stations.length * 300 + (w.roads.crossings.length + w.walks.footCrossings.length) * 400
    + Math.round((pathLength + sidewalkLength) / 1) * 6 + people * 24 + w.town.bays.length * 4 + w.buses.sides.length * 60;
  const r1 = (x: number) => Math.round(x);
  return {
    trackLength: r1(trackLength), tracks: w.tracks.size, junctions: w.junctions.length,
    bridgeLength: r1(bridgeLength), tunnelLength: r1(tunnelLength), stations: w.stations.length,
    services: w.layout.services.length, trains, roadLength: r1(roadLength), roads: w.roads.roads.size,
    levelCrossings: w.roads.crossings.length, pathLength: r1(pathLength), sidewalkLength: r1(sidewalkLength),
    zebras: w.walks.crossings.filter((c) => c.kind === "zebra").length, footCrossings: w.walks.footCrossings.length,
    buildings: w.town.buildings.length, people, cars: ownCars, parkingBays: w.town.bays.length, carParks: w.town.lots.length, throughTraffic: through,
    busStops: w.buses.stops.length, busLines: w.buses.lines.length, buses: w.buses.lines.reduce((a, l) => a + l.count, 0),
    exits: w.offLayout.exits.length, offLayoutPlaces: w.offLayout.places.length,
    freightYards: w.freight.yards.length, freightSites: w.freight.sites.filter((s) => s.kind !== "yard").length,
    deliveryVehicles: w.freight.fleet.reduce((a, f) => a + f.count, 0),
    objects: w.scenery.length, trees, triangles,
  };
}

export const validate = (json: unknown): Report => buildWorld(json).report;

/** How many through-traffic vehicles drive about: traffic.cars, or about one per 200 m of road (at most 30). */
export function throughTraffic(w: Pick<World, "layout" | "roads" | "town">): number {
  if (!w.roads.roads.size) return 0;
  const lots = new Set(w.town.lots.map((l) => l.id));
  const roadLength = [...w.roads.roads.values()].filter((r) => !lots.has(r.id)).reduce((a, r) => a + r.path.length, 0);
  return w.layout.traffic.cars ?? Math.min(30, Math.round(roadLength / 200));
}
