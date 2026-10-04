// Validation rules (§6). Geometry builders report their own construction errors;
// this file holds the Issue/Report types, zod-error conversion, and the checks
// that look across tracks, stations and services. All produce stable codes.

import type { ZodError } from "zod";
import type { Layout, TrackSpec } from "./schema";
import type { TrackGeom, Junction } from "./trackGraph";
import type { Span } from "./heights";
import type { RoutePath } from "./routes";
import { radiusAt, pointAt } from "./geometry";
import { isTrainType, TRAIN_CATALOG, trainLength } from "./catalog";
import { OBJECT_LIBRARY } from "./objectLibrary";
import { SpatialHash } from "../util/spatial";
import { mod, round } from "../util/vec";

export type Issue = {
  code: string;
  severity: "error" | "warning";
  message: string;
  path: string;
  at?: [number, number];
};
export type Report = { ok: boolean; issues: Issue[]; stats: Record<string, number> };

export const error = (code: string, message: string, path: string, at?: [number, number]): Issue =>
  ({ code, severity: "error", message, path, ...(at ? { at: [round(at[0]), round(at[1])] } : {}) });
export const warning = (code: string, message: string, path: string, at?: [number, number]): Issue =>
  ({ ...error(code, message, path, at), severity: "warning" });

export const makeReport = (issues: Issue[], stats: Record<string, number> = {}): Report =>
  ({ ok: !issues.some((i) => i.severity === "error"), issues, stats });

const OUT_OF_BOUNDS_MARGIN = 20;
const CONFLICT_DISTANCE = 4.5;
const CONFLICT_DZ = 6;
const JUNCTION_IGNORE = 60;
const TURNOUT_MIN_RADIUS = 150;
const PLATFORM_MIN_RADIUS = 300;
const CAPACITY_HEADWAY = 150;

/** JSON path string from a zod path array: ["tracks", 1, "points"] -> "tracks[1].points". */
export function jsonPath(parts: ReadonlyArray<PropertyKey>): string {
  return parts.reduce<string>((acc, p) => (typeof p === "number" ? `${acc}[${p}]` : acc ? `${acc}.${String(p)}` : String(p)), "");
}

/** Zod issues as SCHEMA errors; `prefix` places a sub-schema's paths inside the layout. */
export function zodIssues(err: ZodError, prefix: PropertyKey[] = []): Issue[] {
  return err.issues.map((i) => {
    const where = jsonPath([...prefix, ...i.path]) || "(root)";
    let msg = i.message;
    if (i.code === "unrecognized_keys") msg = `unknown key${i.keys.length > 1 ? "s" : ""} ${i.keys.map((k) => `"${k}"`).join(", ")}; check spelling against docs/schema.json`;
    else if (i.code === "invalid_type" && i.input === undefined) msg = `missing required field (expected ${i.expected})`;
    return error("SCHEMA", `${where}: ${msg}`, where);
  });
}

/** Duplicate ids and unresolved references. Runs before any geometry. */
export function checkReferences(layout: Layout): Issue[] {
  const issues: Issue[] = [];
  const seen = new Map<string, string>();
  const note = (id: string, path: string) => {
    const prev = seen.get(id);
    if (prev) issues.push(error("DUPLICATE_ID", `id '${id}' is used twice (also at ${prev}); ids must be unique across tracks, roads, paths, car parks, stations and services`, path));
    else seen.set(id, path);
  };
  layout.tracks.forEach((t, i) => note(t.id, `tracks[${i}].id`));
  layout.stations.forEach((s, i) => note(s.id, `stations[${i}].id`));
  layout.services.forEach((s, i) => note(s.id, `services[${i}].id`));
  layout.roads.forEach((r, i) => note(r.id, `roads[${i}].id`));
  layout.paths.forEach((p, i) => note(p.id, `paths[${i}].id`));
  layout.parking.forEach((p, i) => note(p.id, `parking[${i}].id`));

  const trackIds = new Set(layout.tracks.map((t) => t.id));
  const stationIds = new Set(layout.stations.map((s) => s.id));
  const unknown = (kind: string, id: string, path: string, known: Set<string>) =>
    issues.push(error("UNKNOWN_REF", `unknown ${kind} '${id}'; known: ${[...known].join(", ") || "(none)"}`, path));
  layout.tracks.forEach((t, i) => {
    for (const w of ["from", "to"] as const) {
      const end = t[w];
      if (end && !trackIds.has(end.track)) unknown("track", end.track, `tracks[${i}].${w}.track`, trackIds);
      if (end && end.track === t.id) issues.push(error("TRACK_REF_CYCLE", `track '${t.id}' cannot branch from itself`, `tracks[${i}].${w}.track`));
    }
  });
  layout.stations.forEach((s, i) => {
    if (!trackIds.has(s.track)) unknown("track", s.track, `stations[${i}].track`, trackIds);
  });
  layout.services.forEach((s, i) => {
    if (!isTrainType(s.train)) unknown("train type", s.train, `services[${i}].train`, new Set(Object.keys(TRAIN_CATALOG)));
    s.route.forEach((r, k) => { if (!trackIds.has(r)) unknown("track", r, `services[${i}].route[${k}]`, trackIds); });
    s.stops.forEach((r, k) => { if (!stationIds.has(r)) unknown("station", r, `services[${i}].stops[${k}]`, stationIds); });
  });
  const objectIds = new Set([...Object.keys(OBJECT_LIBRARY), ...Object.keys(layout.objects)]);
  const known = () => new Set([...objectIds].sort());
  layout.stations.forEach((s, i) => {
    if (s.building && !objectIds.has(s.building)) unknown("object", s.building, `stations[${i}].building`, known());
  });
  layout.scenery.forEach((e, i) => {
    if (e.object && !objectIds.has(e.object)) unknown("object", e.object, `scenery[${i}].object`, known());
    e.scatter?.forEach((id, k) => { if (!objectIds.has(id)) unknown("object", id, `scenery[${i}].scatter[${k}]`, known()); });
  });
  const roadIds = new Set(layout.roads.map((r) => r.id));
  layout.roads.forEach((r, i) => {
    for (const w of ["from", "to"] as const) {
      const end = r[w];
      if (end && !roadIds.has(end.road)) unknown("road", end.road, `roads[${i}].${w}.road`, roadIds);
      if (end && end.road === r.id) issues.push(error("TRACK_REF_CYCLE", `road '${r.id}' cannot branch from itself`, `roads[${i}].${w}.road`));
    }
  });
  layout.traffic.vehicles.forEach((id, k) => { if (!objectIds.has(id)) unknown("object", id, `traffic.vehicles[${k}]`, known()); });
  layout.people.vehicles.forEach((id, k) => { if (!objectIds.has(id)) unknown("object", id, `people.vehicles[${k}]`, known()); });
  layout.parking.forEach((p, i) => { if (p.road && !roadIds.has(p.road)) unknown("road", p.road, `parking[${i}].road`, roadIds); });
  const pathIds = new Set(layout.paths.map((p) => p.id));
  layout.paths.forEach((p, i) => {
    for (const w of ["from", "to"] as const) {
      const end = p[w];
      if (end?.path && !pathIds.has(end.path)) unknown("path", end.path, `paths[${i}].${w}.path`, pathIds);
      if (end?.road && !roadIds.has(end.road)) unknown("road", end.road, `paths[${i}].${w}.road`, roadIds);
      if (end?.station && !stationIds.has(end.station)) unknown("station", end.station, `paths[${i}].${w}.station`, stationIds);
      if (end?.path === p.id) issues.push(error("TRACK_REF_CYCLE", `path '${p.id}' cannot branch from itself`, `paths[${i}].${w}.path`));
    }
  });
  return issues;
}

/** Junction placement for one track: on the parent, away from line ends, not on a tight curve. */
export function checkJunctionPosition(layout: Layout, t: TrackSpec, i: number, tracks: Map<string, TrackGeom>): Issue[] {
  const issues: Issue[] = [];
  for (const w of ["from", "to"] as const) {
    const end = t[w];
    const parent = end && tracks.get(end.track);
    if (!end || !parent) continue;
    const L = parent.path.length;
    const path = `tracks[${i}].${w}.at`;
    if (end.at < 0 || end.at > L || (!parent.path.closed && (end.at < 1 || end.at > L - 1))) {
      issues.push(error("JUNCTION_POSITION", `junction at s=${end.at} is outside track '${end.track}' (length ${L.toFixed(0)} m); use a value between 1 and ${(L - 1).toFixed(0)}`, path));
      continue;
    }
    const r = radiusAt(parent.path, end.at);
    if (r < TURNOUT_MIN_RADIUS) {
      issues.push(error("JUNCTION_POSITION", `junction at s=${end.at} on '${end.track}' sits on a ${r.toFixed(0)} m radius curve; turnouts need straight track or radius >= ${TURNOUT_MIN_RADIUS} m, so move it onto a straight`, path, pointAt(parent.path, end.at)));
    }
    const others = layout.tracks.flatMap((o) => [o.from, o.to]).filter((e) => e && e !== end && e.track === end.track);
    if (others.some((o) => Math.abs(mod(o!.at - end.at + L / 2, L) - L / 2) < 1)) {
      issues.push(error("JUNCTION_POSITION", `two junctions on '${end.track}' at s=${end.at} are less than 1 m apart; move one of them`, path));
    }
  }
  return issues;
}

export type TrackPoint = { track: string; s: number; x: number; y: number; z: number };

export function checkBounds(layout: Layout, tracks: Map<string, TrackGeom>, points: TrackPoint[]): Issue[] {
  const [W, H] = layout.terrain.size;
  const m = OUT_OF_BOUNDS_MARGIN;
  const issues: Issue[] = [];
  for (const t of tracks.values()) {
    const out = points.filter((p) => p.track === t.id && (p.x < m || p.y < m || p.x > W - m || p.y > H - m));
    if (out.length) {
      const p = out[0];
      issues.push(error("OUT_OF_BOUNDS", `track '${t.id}' leaves the terrain (keep ${m} m from the edge of [0,0]–[${W},${H}]) around s=${p.s.toFixed(0)}, (${p.x.toFixed(0)}, ${p.y.toFixed(0)}); move the nearby waypoints inward`, `tracks[${t.index}].points`, [p.x, p.y]));
    }
  }
  return issues;
}

/** Tracks closer than 4.5 m in plan at similar height, away from their shared junctions. */
export function checkConflicts(tracks: Map<string, TrackGeom>, junctions: Junction[], points: TrackPoint[]): Issue[] {
  const hash = new SpatialHash<number>(CONFLICT_DISTANCE * 2);
  points.forEach((p, i) => hash.insert(p.x, p.y, i));
  const nearJunction = (a: TrackPoint, b: TrackPoint) =>
    junctions.some((j) => ((j.parentTrack === a.track && j.branchTrack === b.track) || (j.parentTrack === b.track && j.branchTrack === a.track))
      && (Math.hypot(a.x - j.at[0], a.y - j.at[1]) < JUNCTION_IGNORE || Math.hypot(b.x - j.at[0], b.y - j.at[1]) < JUNCTION_IGNORE));

  type Cluster = { a: string; b: string; sA: number[]; min: number; at: [number, number] };
  const clusters: Cluster[] = [];
  points.forEach((p, i) => {
    hash.near(p.x, p.y, CONFLICT_DISTANCE, (j) => {
      if (j <= i) return;
      const q = points[j];
      const d = Math.hypot(p.x - q.x, p.y - q.y);
      if (d >= CONFLICT_DISTANCE || Math.abs(p.z - q.z) >= CONFLICT_DZ) return;
      if (p.track === q.track) {
        const L = tracks.get(p.track)!.path.length;
        const ds = Math.abs(p.s - q.s);
        if ((tracks.get(p.track)!.path.closed ? Math.min(ds, L - ds) : ds) < 30) return;
      } else if (nearJunction(p, q)) return;
      const [a, b] = p.track <= q.track ? [p, q] : [q, p];
      const c = clusters.find((k) => k.a === a.track && k.b === b.track && k.sA.some((s) => Math.abs(s - a.s) < 25));
      if (c) {
        c.sA.push(a.s);
        if (d < c.min) { c.min = d; c.at = [a.x, a.y]; }
      } else clusters.push({ a: a.track, b: b.track, sA: [a.s], min: d, at: [a.x, a.y] });
    });
  });
  return clusters.map((c) => error("TRACK_CONFLICT",
    `tracks '${c.a}' and '${c.b}' come within ${c.min.toFixed(1)} m of each other near (${c.at[0].toFixed(0)}, ${c.at[1].toFixed(0)}) at similar height; keep parallel tracks at least 5 m apart or separate them by 6 m in height`,
    `tracks[${tracks.get(c.a)!.index}]`, c.at));
}

export function checkStations(layout: Layout, tracks: Map<string, TrackGeom>, spans: Map<string, Span[]>): Issue[] {
  const issues: Issue[] = [];
  layout.stations.forEach((st, i) => {
    const t = tracks.get(st.track);
    if (!t) return;
    const L = t.path.length;
    const s0 = st.at - st.length / 2;
    const s1 = st.at + st.length / 2;
    const path = `stations[${i}]`;
    if (t.path.closed ? st.length >= L || st.at < 0 || st.at > L : s0 < 0 || s1 > L) {
      issues.push(error("STATION_RANGE", `platform of '${st.id}' spans s=${s0.toFixed(0)}–${s1.toFixed(0)} but track '${st.track}' is ${L.toFixed(0)} m long; move 'at' or shorten 'length'`, `${path}.at`));
      return;
    }
    let tightest = Infinity;
    for (let s = s0; s <= s1; s += 5) tightest = Math.min(tightest, radiusAt(t.path, s));
    const at = pointAt(t.path, st.at);
    if (tightest < PLATFORM_MIN_RADIUS) {
      issues.push(warning("STATION_CURVE", `platform of '${st.id}' lies on a ${tightest.toFixed(0)} m radius curve (want >= ${PLATFORM_MIN_RADIUS} m); move it onto a straight`, `${path}.at`, at));
    }
    const struct = (spans.get(st.track) ?? []).find((sp) => sp.kind !== "ground" && overlaps(sp.s0, sp.s1, s0, s1, L, t.path.closed));
    if (struct) {
      issues.push(warning("STATION_STRUCTURE", `platform of '${st.id}' overlaps a ${struct.kind} (s=${struct.s0.toFixed(0)}–${struct.s1.toFixed(0)}); move the station onto level ground`, `${path}.at`, at));
    }
  });
  return issues;
}

function overlaps(a0: number, a1: number, b0: number, b1: number, L: number, closed: boolean): boolean {
  if (!closed) return a0 < b1 && b0 < a1;
  return [-L, 0, L].some((k) => a0 < b1 + k && b0 + k < a1);
}

/** Warnings about train length vs platforms and how many trains a route can hold. */
export function checkServices(layout: Layout, routes: Map<string, RoutePath>): Issue[] {
  const issues: Issue[] = [];
  const stations = new Map(layout.stations.map((s) => [s.id, s]));
  layout.services.forEach((svc, i) => {
    if (!isTrainType(svc.train)) return;
    const len = trainLength(TRAIN_CATALOG[svc.train]);
    svc.stops.forEach((id, k) => {
      const st = stations.get(id);
      if (st && len > st.length) {
        issues.push(warning("TRAIN_TOO_LONG", `service '${svc.id}' runs ${len} m trains but platform '${id}' is ${st.length} m; lengthen the platform or pick a shorter train`, `services[${i}].stops[${k}]`));
      }
    });
    const route = routes.get(svc.id);
    if (!route) return;
    const fit = route.length / (len + CAPACITY_HEADWAY);
    if (svc.count > fit) {
      issues.push(warning("CAPACITY", `service '${svc.id}' has ${svc.count} trains but its ${route.length.toFixed(0)} m route holds about ${Math.max(1, Math.floor(fit))}; reduce count or lengthen the route`, `services[${i}].count`));
    }
  });
  return issues;
}
