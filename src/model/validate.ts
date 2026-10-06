// Validation rules (§6). Geometry builders report their own construction errors;
// this file holds the Issue/Report types, zod-error conversion, and the checks
// that look across tracks, stations and services. All produce stable codes.

import type { ZodError } from "zod";
import type { Layout, TrackSpec, StabledSpec } from "./schema";
import type { TrackGeom, Junction } from "./trackGraph";
import type { Span } from "./heights";
import type { RoutePath } from "./routes";
import { radiusAt, pointAt, headingAt } from "./geometry";
import { isTrainType, TRAIN_CATALOG, trainLength, carLengths, type TrainType, type TrainTypeId } from "./catalog";
import { OBJECT_LIBRARY } from "./objectLibrary";
import { offEdge } from "./exits";
import { SpatialHash } from "../util/spatial";
import { mod, round, wrapAngle } from "../util/vec";

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
const MIN_DIAMOND_ANGLE = 12;   // degrees: tracks crossing at least this squarely form a diamond crossing

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
    if (prev) issues.push(error("DUPLICATE_ID", `id '${id}' is used twice (also at ${prev}); ids must be unique across tracks, roads, paths, car parks, stations (and freight yards), services, bus stops, bus lines and off-layout places`, path));
    else seen.set(id, path);
  };
  layout.tracks.forEach((t, i) => note(t.id, `tracks[${i}].id`));
  layout.stations.forEach((s, i) => note(s.id, `stations[${i}].id`));
  layout.services.forEach((s, i) => note(s.id, `services[${i}].id`));
  layout.roads.forEach((r, i) => note(r.id, `roads[${i}].id`));
  layout.paths.forEach((p, i) => note(p.id, `paths[${i}].id`));
  layout.parking.forEach((p, i) => note(p.id, `parking[${i}].id`));
  layout.busStops.forEach((p, i) => note(p.id, `busStops[${i}].id`));
  layout.busLines.forEach((p, i) => note(p.id, `busLines[${i}].id`));
  layout.offLayout.forEach((p, i) => note(p.id, `offLayout[${i}].id`));

  const trackIds = new Set(layout.tracks.map((t) => t.id));
  const stationIds = new Set(layout.stations.map((s) => s.id));
  const offIds = new Set(layout.offLayout.map((p) => p.id));
  const unknown = (kind: string, id: string, path: string, known: Set<string>) =>
    issues.push(error("UNKNOWN_REF", `unknown ${kind} '${id}'; known: ${[...known].join(", ") || "(none)"}`, path));
  layout.tracks.forEach((t, i) => {
    for (const w of ["from", "to"] as const) {
      const end = t[w];
      if (end && !trackIds.has(end.track)) unknown("track", end.track, `tracks[${i}].${w}.track`, trackIds);
      if (end && end.track === t.id) issues.push(error("TRACK_REF_CYCLE", `track '${t.id}' cannot branch from itself`, `tracks[${i}].${w}.track`));
    }
  });
  const roadIds = new Set(layout.roads.map((r) => r.id));
  layout.stations.forEach((s, i) => {
    if (!trackIds.has(s.track)) unknown("track", s.track, `stations[${i}].track`, trackIds);
    if (s.road && !roadIds.has(s.road)) unknown("road", s.road, `stations[${i}].road`, roadIds);
  });
  layout.services.forEach((s, i) => {
    if (!isTrainType(s.train)) unknown("train type", s.train, `services[${i}].train`, new Set(Object.keys(TRAIN_CATALOG)));
    s.route.forEach((r, k) => { if (!trackIds.has(r)) unknown("track", r, `services[${i}].route[${k}]`, trackIds); });
    s.stops.forEach((r, k) => { if (!stationIds.has(r) && !offIds.has(r)) unknown("station", r, `services[${i}].stops[${k}]`, new Set([...stationIds, ...offIds])); });
  });
  layout.stabled.forEach((s, i) => {
    if (!trackIds.has(s.track)) unknown("track", s.track, `stabled[${i}].track`, trackIds);
    if (!isTrainType(s.train)) unknown("train type", s.train, `stabled[${i}].train`, new Set(Object.keys(TRAIN_CATALOG)));
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
  layout.roads.forEach((r, i) => {
    for (const w of ["from", "to"] as const) {
      const end = r[w];
      if (end && !roadIds.has(end.road)) unknown("road", end.road, `roads[${i}].${w}.road`, roadIds);
      if (end && end.road === r.id) issues.push(error("TRACK_REF_CYCLE", `road '${r.id}' cannot branch from itself`, `roads[${i}].${w}.road`));
    }
  });
  layout.traffic.vehicles.forEach((id, k) => { if (!objectIds.has(id)) unknown("object", id, `traffic.vehicles[${k}]`, known()); });
  layout.people.vehicles.forEach((id, k) => { if (!objectIds.has(id)) unknown("object", id, `people.vehicles[${k}]`, known()); });
  (layout.freight.vehicles ?? []).forEach((f, k) => { if (!objectIds.has(f.object)) unknown("object", f.object, `freight.vehicles[${k}].object`, known()); });
  layout.parking.forEach((p, i) => { if (p.road && !roadIds.has(p.road)) unknown("road", p.road, `parking[${i}].road`, roadIds); });
  layout.busStops.forEach((b, i) => { if (!roadIds.has(b.road)) unknown("road", b.road, `busStops[${i}].road`, roadIds); });
  const stopIds = new Set(layout.busStops.map((b) => b.id));
  layout.busLines.forEach((l, i) => {
    l.stops.forEach((id, k) => {
      if (!stopIds.has(id) && !offIds.has(id)) unknown("bus stop", id, `busLines[${i}].stops[${k}]`, new Set([...stopIds, ...offIds]));
      else if (k > 0 && l.stops[k - 1] === id) issues.push(error("BUS_ROUTE", `bus line '${l.id}' calls at stop '${id}' twice in a row; list each stop once per visit`, `busLines[${i}].stops[${k}]`));
    });
    if (l.mode === "loop" && l.stops.length > 1 && l.stops[0] === l.stops[l.stops.length - 1]) {
      issues.push(error("BUS_ROUTE", `bus line '${l.id}' is a loop but ends where it starts ('${l.stops[0]}'); a loop returns to its first stop by itself, so leave the last one out`, `busLines[${i}].stops[${l.stops.length - 1}]`));
    }
    if (!objectIds.has(l.vehicle)) unknown("object", l.vehicle, `busLines[${i}].vehicle`, known());
  });
  const pathIds = new Set(layout.paths.map((p) => p.id));
  layout.paths.forEach((p, i) => {
    for (const w of ["from", "to"] as const) {
      const end = p[w];
      if (end?.path && !pathIds.has(end.path)) unknown("path", end.path, `paths[${i}].${w}.path`, pathIds);
      if (end?.road && !roadIds.has(end.road)) unknown("road", end.road, `paths[${i}].${w}.road`, roadIds);
      if (end?.station && !stationIds.has(end.station)) unknown("station", end.station, `paths[${i}].${w}.station`, stationIds);
      else if (end?.station && layout.stations.find((st) => st.id === end.station)!.kind === "freight") {
        issues.push(error("STATION_KIND", `path '${p.id}' ends at '${end.station}', a freight yard, which has no platform for people; end it at a passenger station, a road or another path`, `paths[${i}].${w}.station`));
      }
      if (end?.path === p.id) issues.push(error("TRACK_REF_CYCLE", `path '${p.id}' cannot branch from itself`, `paths[${i}].${w}.path`));
    }
  });
  layout.offLayout.forEach((p, i) => {
    p.via.forEach((v, k) => {
      if (v.track && !trackIds.has(v.track)) unknown("track", v.track, `offLayout[${i}].via[${k}].track`, trackIds);
      if (v.road && !roadIds.has(v.road)) unknown("road", v.road, `offLayout[${i}].via[${k}].road`, roadIds);
      if (v.path && !pathIds.has(v.path)) unknown("path", v.path, `offLayout[${i}].via[${k}].path`, pathIds);
    });
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
    const out = points.filter((p) => p.track === t.id && (p.x < m || p.y < m || p.x > W - m || p.y > H - m) && !offEdge(layout.terrain.size, t, p.s, m));
    if (out.length) {
      const p = out[0];
      issues.push(error("OUT_OF_BOUNDS", `track '${t.id}' leaves the terrain (keep ${m} m from the edge of [0,0]–[${W},${H}]) around s=${p.s.toFixed(0)}, (${p.x.toFixed(0)}, ${p.y.toFixed(0)}); move the nearby waypoints inward, or end the track on the edge to let it leave the board`, `tracks[${t.index}].points`, [p.x, p.y]));
    }
  }
  return issues;
}

/** Two tracks crossing at grade: a diamond crossing, where trains on either go over the other's rails. */
export type Diamond = { a: string; sa: number; b: string; sb: number; at: [number, number]; angle: number };

/**
 * Tracks closer than 4.5 m in plan at similar height, away from their shared junctions,
 * are a conflict — unless they cross each other at a real angle (MIN_DIAMOND_ANGLE or
 * more), which makes a diamond crossing.
 */
export function checkConflicts(tracks: Map<string, TrackGeom>, junctions: Junction[], points: TrackPoint[]): { issues: Issue[]; diamonds: Diamond[] } {
  const hash = new SpatialHash<number>(CONFLICT_DISTANCE * 2);
  points.forEach((p, i) => hash.insert(p.x, p.y, i));
  const nearJunction = (a: TrackPoint, b: TrackPoint) =>
    junctions.some((j) => ((j.parentTrack === a.track && j.branchTrack === b.track) || (j.parentTrack === b.track && j.branchTrack === a.track))
      && (Math.hypot(a.x - j.at[0], a.y - j.at[1]) < JUNCTION_IGNORE || Math.hypot(b.x - j.at[0], b.y - j.at[1]) < JUNCTION_IGNORE));

  type Cluster = { a: string; b: string; sA: number[]; min: number; at: [number, number]; pa: TrackPoint; pb: TrackPoint };
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
        if (d < c.min) Object.assign(c, { min: d, at: [a.x, a.y], pa: a, pb: b });
      } else clusters.push({ a: a.track, b: b.track, sA: [a.s], min: d, at: [a.x, a.y], pa: a, pb: b });
    });
  });
  const issues: Issue[] = [];
  const diamonds: Diamond[] = [];
  for (const c of clusters) {
    const d = crossingOf(tracks.get(c.a)!, c.pa.s, tracks.get(c.b)!, c.pb.s);
    if (d && d.angle >= MIN_DIAMOND_ANGLE) {
      diamonds.push({ a: c.a, sa: d.sa, b: c.b, sb: d.sb, at: d.at, angle: d.angle });
      continue;
    }
    issues.push(error("TRACK_CONFLICT", d
      ? `tracks '${c.a}' and '${c.b}' cross at only ${d.angle.toFixed(0)}° near (${c.at[0].toFixed(0)}, ${c.at[1].toFixed(0)}); a diamond crossing needs ${MIN_DIAMOND_ANGLE}° or more: cross more squarely, or separate them by 6 m in height`
      : `tracks '${c.a}' and '${c.b}' come within ${c.min.toFixed(1)} m of each other near (${c.at[0].toFixed(0)}, ${c.at[1].toFixed(0)}) at similar height; keep parallel tracks at least 5 m apart or separate them by 6 m in height`,
    `tracks[${tracks.get(c.a)!.index}]`, c.at));
  }
  return { issues, diamonds };
}

/**
 * Where two tracks near (sa, sb) actually cross: the intersection of their tangents,
 * refined a few times, if it lies close by; with the angle between them (0–90°).
 */
function crossingOf(A: TrackGeom, sa: number, B: TrackGeom, sb: number): { sa: number; sb: number; at: [number, number]; angle: number } | null {
  const clampS = (t: TrackGeom, s: number) => (t.path.closed ? mod(s, t.path.length) : Math.min(Math.max(s, 0), t.path.length));
  for (let k = 0; k < 4; k++) {
    const [ax, ay] = pointAt(A.path, sa);
    const [bx, by] = pointAt(B.path, sb);
    const ha = headingAt(A.path, sa);
    const hb = headingAt(B.path, sb);
    const [dax, day, dbx, dby] = [Math.cos(ha), Math.sin(ha), Math.cos(hb), Math.sin(hb)];
    const den = dax * dby - day * dbx;
    if (Math.abs(den) < 1e-6) return null;                   // parallel
    const u = ((bx - ax) * dby - (by - ay) * dbx) / den;
    const v = ((bx - ax) * day - (by - ay) * dax) / den;
    if (Math.abs(u) > 40 || Math.abs(v) > 40) return null;    // they only come close, without crossing here
    sa = clampS(A, sa + u);
    sb = clampS(B, sb + v);
  }
  const [ax, ay] = pointAt(A.path, sa);
  const [bx, by] = pointAt(B.path, sb);
  if (Math.hypot(ax - bx, ay - by) > 0.5) return null;
  const turn = Math.abs(wrapAngle(headingAt(A.path, sa) - headingAt(B.path, sb)));
  const angle = (Math.min(turn, Math.PI - turn) * 180) / Math.PI;
  return { sa, sb, at: [ax, ay], angle };
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
    const freight = TRAIN_CATALOG[svc.train].shape === "freight";
    svc.stops.forEach((id, k) => {
      const st = stations.get(id);
      if (st && st.kind === "freight" && !freight) {
        issues.push(warning("STOP_KIND", `passenger service '${svc.id}' stops at freight yard '${id}', where nobody can get on or off; leave it out of the stops, or run a freight train (${Object.entries(TRAIN_CATALOG).filter(([, t]) => t.shape === "freight").map(([k]) => k).join(", ")})`, `services[${i}].stops[${k}]`));
      }
      if (st && len > st.length) {
        issues.push(warning("TRAIN_TOO_LONG", `service '${svc.id}' runs ${len} m trains but ${st.kind === "freight" ? "the dock of freight yard" : "platform"} '${id}' is ${st.length} m; lengthen the ${st.kind === "freight" ? "yard" : "platform"} or pick a shorter train`, `services[${i}].stops[${k}]`));
      }
    });
    const route = routes.get(svc.id);
    if (!route) return;
    // Trains also wait off the board where the route leaves it.
    const fit = (route.length + route.off.reduce((a, o) => a + (o ? o.length / 2 : 0), 0)) / (len + CAPACITY_HEADWAY);
    if (svc.count > fit) {
      issues.push(warning("CAPACITY", `service '${svc.id}' has ${svc.count} trains but its ${route.length.toFixed(0)} m route holds about ${Math.max(1, Math.floor(fit))}; reduce count or lengthen the route`, `services[${i}].count`));
    }
  });
  return issues;
}

/**
 * The vehicles of a stabled consist, front (toward higher s, or lower if reversed) to
 * back: `car` 0 is a locomotive (for trains that have one). Without its locomotive,
 * `cars` counts the coaches or wagons alone.
 */
export function stabledVehicles(st: StabledSpec): Array<{ car: number; length: number }> {
  const t: TrainType = TRAIN_CATALOG[st.train as TrainTypeId];
  const hasLoco = t.shape === "loco-hauled" || t.shape === "double-deck" || t.shape === "freight";
  if (hasLoco && !st.loco) return Array.from({ length: st.cars ?? Math.max(1, t.cars - 1) }, () => ({ car: 1, length: t.carLength }));
  const lengths = carLengths(t);
  return Array.from({ length: st.cars ?? t.cars }, (_, i) => ({ car: i === 0 ? 0 : 1, length: i === 0 ? lengths[0] : t.carLength }));
}

/** Stabled trains must stand on their track, clear of every service's route and of each other. */
export function checkStabled(layout: Layout, tracks: Map<string, TrackGeom>, routes: Map<string, RoutePath>): Issue[] {
  const issues: Issue[] = [];
  const spans: Array<{ track: string; s0: number; s1: number; i: number }> = [];
  layout.stabled.forEach((st, i) => {
    const t = tracks.get(st.track);
    if (!t || !isTrainType(st.train)) return;
    const len = stabledVehicles(st).reduce((a, v) => a + v.length, 0);
    const s0 = st.at - len / 2;
    const s1 = st.at + len / 2;
    const L = t.path.length;
    if (!t.path.closed && (s0 < 0 || s1 > L)) {
      issues.push(error("STABLED_RANGE", `the ${len.toFixed(0)} m train stabled on '${st.track}' at s=${st.at} runs off its ${L.toFixed(0)} m; move it to s between ${(len / 2).toFixed(0)} and ${(L - len / 2).toFixed(0)}, or give it fewer cars`, `stabled[${i}].at`));
      return;
    }
    for (const [id, r] of routes) {
      const hit = r.pieces.some((p) => {
        if (p.track !== st.track) return false;
        const a = Math.min(p.s0, p.s0 + p.dir * p.length);
        const b = Math.max(p.s0, p.s0 + p.dir * p.length);
        return t.path.closed ? true : a < s1 && s0 < b;
      });
      if (hit) {
        issues.push(error("STABLED_ON_ROUTE", `service '${id}' runs over the train stabled on '${st.track}' at s=${st.at.toFixed(0)}; stable it on a siding no service uses (or a stretch of track the service does not reach)`, `stabled[${i}]`, pointAt(t.path, st.at)));
        break;
      }
    }
    const other = spans.find((x) => x.track === st.track && x.s0 < s1 && s0 < x.s1);
    if (other) issues.push(warning("STABLED_OVERLAP", `trains stabled on '${st.track}' at s=${st.at} and stabled[${other.i}] overlap; move one along the track`, `stabled[${i}].at`, pointAt(t.path, st.at)));
    spans.push({ track: st.track, s0, s1, i });
  });
  return issues;
}
