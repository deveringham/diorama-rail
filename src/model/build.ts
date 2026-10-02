// The single model entry point: parse → validate → build a World. Never throws
// for bad input; returns a Report with precise issues instead. The World holds
// everything the sim and scene need, all derived from the JSON plus its seed.

import { LayoutSchema, type Layout } from "./schema";
import { type TrackGeom, type Junction, type Graph, trackOrder, buildTrack, junctionsOf, buildGraph } from "./trackGraph";
import { type Profile, type Span, buildProfile, classify, profileZ, structureAt } from "./heights";
import { type Terrain, buildTerrain, baseZ, shapeCorridor } from "./terrain";
import { type RoutePath, buildRoute } from "./routes";
import { type StationGeom, type Placement, buildStations, placeScenery } from "./scenery";
import {
  type Issue, type Report, type TrackPoint, error, makeReport, zodIssues, checkReferences, checkJunctionPosition,
  checkBounds, checkConflicts, checkStations, checkServices,
} from "./validate";
import { pointAt, sampleS } from "./geometry";
import { HOUSE_INFO, TREE_TRIS, TRAIN_CATALOG, isTrainType, trainLength, type HouseVariant } from "./catalog";
import { SpatialHash } from "../util/spatial";

const POINT_STEP = 2;      // m between dense track points (conflicts, shaping, queries)

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
  scenery: Placement[];
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
  shapeCorridor(terrain, points.map((p) => ({ x: p.x, y: p.y, z: p.z, ground: structureAt(spans.get(p.track)!, p.s) === "ground" })));
  issues.push(...checkConflicts(tracks, junctions, points));
  issues.push(...checkStations(layout, tracks, spans));

  const stationById = new Map(layout.stations.map((s) => [s.id, s]));
  const routes = new Map<string, RoutePath>();
  layout.services.forEach((svc, i) => {
    if (!isTrainType(svc.train)) return;
    const res = buildRoute(svc, i, graph, tracks, stationById, trainLength(TRAIN_CATALOG[svc.train]));
    issues.push(...res.issues.map((r) => error(r.code, r.message, r.jsonPath)));
    if (res.route) routes.set(svc.id, res.route);
  });
  issues.push(...checkServices(layout, routes));
  if (hasErrors(issues)) return { world: null, report: makeReport(issues) };

  const stations = buildStations(layout, tracks, terrain);
  const scenery = placeScenery(layout, tracks, terrain, pointHash, stations);
  const world: World = {
    layout, tracks, order, junctions, graph, profiles, spans, terrain, points, pointHash, stations, routes, scenery, stats: {},
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
  const trees = w.scenery.filter((p) => p.kind === "tree").length;
  const houses = w.scenery.filter((p) => p.kind === "house");
  const trains = w.layout.services.reduce((a, s) => a + s.count, 0);
  const cars = w.layout.services.reduce((a, s) => a + s.count * (isTrainType(s.train) ? TRAIN_CATALOG[s.train].cars : 0), 0);
  // Rough triangle budget: terrain grid + skirt, trees, houses, track (sleepers, rails, ballast), trains.
  const triangles = 2 * w.terrain.nx * w.terrain.ny + 4 * (w.terrain.nx + w.terrain.ny)
    + trees * TREE_TRIS + houses.reduce((a, h) => a + HOUSE_INFO[h.variant as HouseVariant].tris, 0)
    + Math.round(trackLength / 0.65) * 10 + Math.round(trackLength / 2) * 22 + cars * 60 + w.stations.length * 400;
  const r1 = (x: number) => Math.round(x);
  return {
    trackLength: r1(trackLength), tracks: w.tracks.size, junctions: w.junctions.length,
    bridgeLength: r1(bridgeLength), tunnelLength: r1(tunnelLength), stations: w.stations.length,
    services: w.layout.services.length, trains, trees, houses: houses.length, triangles,
  };
}

export const validate = (json: unknown): Report => buildWorld(json).report;
