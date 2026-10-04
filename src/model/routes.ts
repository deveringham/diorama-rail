// Service routes: turns a service's list of track ids into one continuous path
// of (track, s-range, direction) pieces with a route coordinate r along it.
// Shuttle paths end where the train's head stops at each terminus — or where the
// line leaves the board, if it does: then the trains run off the edge, call at the
// service's off-layout stops out there and come back. A loop whose first and last
// tracks leave the board runs through: off at the end, back on at the start.

import type { ServiceSpec, StationSpec } from "./schema";
import type { Graph, Switch, SwitchState, TrackGeom } from "./trackGraph";
import type { OffLayout } from "./exits";
import { mod } from "../util/vec";

const BUFFER_MARGIN = 3;        // m a shuttle stops short of a buffer stop
const OFF_TURN = 400;           // m beyond the edge where a shuttle with no stops out there turns round
const OFF_THROUGH = 1500;       // m off the board between the ends of a loop running through it, with no stops given
const OFF_CLEAR = 300;          // m beyond the farthest stop before a through loop comes back

/**
 * The trains' run off the board beyond one end of a route: calls at off-layout
 * places at distances along it (m from leaving the edge), its length, and the end
 * of the route it comes back on at (the same for a shuttle, the start for a loop).
 */
export type OffRun = { exit: number; calls: Array<{ place: number; at: number }>; length: number; reenter: 0 | 1 };

export type PathPiece = { track: string; s0: number; s1: number; dir: 1 | -1; r0: number; length: number };
export type RoutePath = {
  service: string;
  closed: boolean;              // loop mode: r wraps at `length`
  pieces: PathPiece[];
  length: number;
  stops: Array<{ station: string; r: number }>;             // r of each platform centre
  switches: Array<{ sw: number; r: number; state: SwitchState }>;
  through: boolean;             // a loop through the off-board world: on at r = 0, off at r = length
  off: [OffRun | null, OffRun | null];                      // runs off the board beyond r = 0 and r = length
};
export type RouteIssue = { code: "ROUTE_DISCONNECTED" | "ROUTE_NOT_CLOSED" | "STOP_NOT_ON_ROUTE"; message: string; jsonPath: string };

type Hop = { sw: number; sOut: number; dirOut: 1 | -1; sIn: number; dirIn: 1 | -1 };

/** Ways to pass from track a to track b at a switch, with the direction needed on each side. */
function hops(g: Graph, tracks: Map<string, TrackGeom>, a: string, b: string): Hop[] {
  const out: Hop[] = [];
  g.switches.forEach((sw: Switch, i) => {
    const toeDir = sw.toe.end === "end" ? 1 : -1;             // direction on the parent arriving at the toe
    const branchL = tracks.get(sw.branchTrack)!.path.length;
    const bS = sw.branchEnd === "start" ? 0 : branchL;
    const bDirAway = sw.branchEnd === "start" ? 1 : -1;        // direction on the branch leaving the junction
    if (sw.parentTrack === a && sw.branchTrack === b) out.push({ sw: i, sOut: sw.parentS, dirOut: toeDir, sIn: bS, dirIn: bDirAway });
    if (sw.branchTrack === a && sw.parentTrack === b) out.push({ sw: i, sOut: bS, dirOut: (-bDirAway) as 1 | -1, sIn: sw.parentS, dirIn: (-toeDir) as 1 | -1 });
  });
  return out;
}

/** Distance travelled from s0 to s1 in direction dir, or -1 if a line can't do it. */
function travel(t: TrackGeom, s0: number, s1: number, dir: 1 | -1): number {
  const d = (s1 - s0) * dir;
  if (t.path.closed) return mod(d, t.path.length);
  return d > 1e-6 ? d : -1;
}

/**
 * Builds the path of one service. `trainLen` places shuttle ends so the train is
 * centred on terminal platforms. Returns issues instead of a path when it fails.
 */
export function buildRoute(
  svc: ServiceSpec, index: number, g: Graph, tracks: Map<string, TrackGeom>,
  stations: Map<string, StationSpec>, trainLen: number, off: OffLayout,
): { route: RoutePath | null; issues: RouteIssue[] } {
  const base = `services[${index}]`;
  const ids = svc.route;
  const fail = (code: RouteIssue["code"], message: string, jsonPath = `${base}.route`) =>
    ({ route: null, issues: [{ code, message: `service '${svc.id}': ${message}`, jsonPath }] });
  const exitAt = (track: string, end: 0 | 1) => off.exits.find((e) => e.kind === "track" && e.line === track && e.end === end);
  const exitsOf = (track: string) => off.exits.filter((e) => e.kind === "track" && e.line === track).length;

  // A loop that cannot close on the board runs through it if its first and last tracks leave it.
  let through = false;
  if (svc.mode === "loop") {
    const first = tracks.get(ids[0])!;
    const last = tracks.get(ids[ids.length - 1])!;
    if (ids.length === 1 && !first.path.closed) {
      if (!(exitAt(first.id, 0) && exitAt(first.id, 1))) {
        return fail("ROUTE_NOT_CLOSED", `mode "loop" needs a closed route but '${ids[0]}' is a line; use mode "shuttle", add tracks that lead back to the start, or let both ends of the line leave the board`);
      }
      through = true;
    } else if (ids.length > 1 && !hops(g, tracks, ids[ids.length - 1], ids[0]).length && !first.path.closed && !last.path.closed && exitsOf(first.id) && exitsOf(last.id)) {
      through = true;
    }
  }
  const closed = svc.mode === "loop" && !through;

  // Candidate hops between consecutive tracks (and back to the start for loops).
  const pairCount = closed && ids.length > 1 ? ids.length : ids.length - 1;
  const options: Hop[][] = [];
  for (let k = 0; k < pairCount; k++) {
    const a = ids[k];
    const b = ids[(k + 1) % ids.length];
    const h = hops(g, tracks, a, b);
    if (h.length === 0) return fail("ROUTE_DISCONNECTED", `tracks '${a}' and '${b}' are not joined by a junction; add a from/to between them or insert the connecting track`, `${base}.route[${(k + 1) % ids.length}]`);
    options.push(h);
  }
  if (closed && ids.length === 1 && !tracks.get(ids[0])!.path.closed) {
    return fail("ROUTE_NOT_CLOSED", `mode "loop" needs a closed route but '${ids[0]}' is a line; use mode "shuttle" or add tracks that lead back to the start`);
  }

  // Depth-first search for hops whose directions agree on every track in between.
  const chosen: Hop[] = [];
  const consistent = (k: number): boolean => {
    if (k === pairCount) {
      if (!closed || ids.length === 1) return true;
      const t = tracks.get(ids[0])!;
      const last = chosen[pairCount - 1];
      return last.dirIn === chosen[0].dirOut && travel(t, last.sIn, chosen[0].sOut, last.dirIn) > 0;
    }
    for (const h of options[k]) {
      if (k > 0) {
        const prev = chosen[k - 1];
        if (prev.dirIn !== h.dirOut || travel(tracks.get(ids[k])!, prev.sIn, h.sOut, h.dirOut) <= 0) continue;
      }
      chosen.push(h);
      if (consistent(k + 1)) return true;
      chosen.pop();
    }
    return false;
  };
  if (!consistent(0)) {
    return fail(closed && pairCount === ids.length ? "ROUTE_NOT_CLOSED" : "ROUTE_DISCONNECTED",
      closed ? "the route cannot be driven round in one direction without reversing; check junction headings or use mode \"shuttle\""
        : "the junctions between these tracks face the wrong way for a through run (a train would have to reverse); check `heading` on from/to");
  }

  // Assemble pieces.
  const svcStops = svc.stops.map((id) => stations.get(id)).filter((s): s is StationSpec => !!s);
  // `via` is the hop that leads onto each piece (none for the first piece of a shuttle or single loop).
  const pieces: Array<Omit<PathPiece, "r0" | "length"> & { via?: Hop }> = [];
  if (closed) {
    if (ids.length === 1) pieces.push({ track: ids[0], s0: 0, s1: tracks.get(ids[0])!.path.length, dir: 1 });
    for (let k = 0; k < pairCount && ids.length > 1; k++) {
      const into = chosen[k];
      const out = chosen[(k + 1) % pairCount];
      pieces.push({ track: ids[(k + 1) % ids.length], s0: into.sIn, s1: out.sOut, dir: into.dirIn, via: into });
    }
  } else {
    const ends = shuttleEnds(ids, chosen, tracks, svcStops, trainLen, (t, e) => !!exitAt(t, e));
    if (through) {
      const startEnd = ids.length === 1 ? 0 : chosen[0].dirOut > 0 ? 0 : 1;
      const endEnd = ids.length === 1 ? 1 : chosen[ids.length - 2].dirIn > 0 ? 1 : 0;
      if (!exitAt(ids[0], startEnd) || !exitAt(ids[ids.length - 1], endEnd)) {
        return fail("ROUTE_NOT_CLOSED", `a loop through the board's edge must start on a track coming in over the edge and end on one leaving it ('${ids[0]}' must leave the board at its ${startEnd ? "end" : "start"}, '${ids[ids.length - 1]}' at its ${endEnd ? "end" : "start"}); reverse the route or use mode "shuttle"`);
      }
    }
    for (let k = 0; k < ids.length; k++) {
      const s0 = k === 0 ? ends.start : chosen[k - 1].sIn;
      const s1 = k === ids.length - 1 ? ends.end : chosen[k].sOut;
      const dir = k === 0 ? (ids.length === 1 ? 1 : chosen[0].dirOut) : chosen[k - 1].dirIn;
      pieces.push({ track: ids[k], s0, s1, dir, via: k > 0 ? chosen[k - 1] : undefined });
    }
  }

  let r = 0;
  const route: RoutePath = { service: svc.id, closed, pieces: [], length: 0, stops: [], switches: [], through, off: [null, null] };
  for (const { via, ...p } of pieces) {
    const t = tracks.get(p.track)!;
    const length = closed && ids.length === 1 ? t.path.length : Math.max(0, travel(t, p.s0, p.s1, p.dir));
    // Switches passed: diverging at each hop, straight wherever a piece runs through a junction.
    if (via) route.switches.push({ sw: via.sw, r, state: "diverging" });
    route.pieces.push({ ...p, r0: r, length });
    r += length;
  }
  route.length = r;
  const full = route.pieces;
  full.forEach((p) => {
    g.switches.forEach((sw, i) => {
      if (sw.parentTrack !== p.track) return;
      const r1 = rOnPiece(p, sw.parentS, tracks);
      if (r1 !== null && r1 > p.r0 + 1e-6 && r1 < p.r0 + p.length - 1e-6) route.switches.push({ sw: i, r: r1, state: "straight" });
    });
  });

  // Where the route leaves the board: the exits its ends lie on.
  const ends: Array<number | null> = [null, null];
  if (!closed) {
    const p0 = full[0];
    const pN = full[full.length - 1];
    const sEnd = (p: PathPiece) => p.s0 + p.dir * p.length;
    const at = (track: string, sv: number) => {
      const L = tracks.get(track)!.path.length;
      return Math.abs(sv) < 1e-6 ? exitAt(track, 0) : Math.abs(sv - L) < 1e-6 ? exitAt(track, 1) : undefined;
    };
    ends[0] = at(p0.track, p0.s0)?.id ?? null;
    ends[1] = at(pN.track, sEnd(pN))?.id ?? null;
  }

  const issues: RouteIssue[] = [];
  const offStops: Array<{ k: number; place: number; via: Array<{ exit: number; distance: number }> }> = [];
  svc.stops.forEach((id, k) => {
    const place = off.places.find((p) => p.id === id);
    if (place) {
      const via = place.via.filter((v) => v.exit === ends[0] || v.exit === ends[1]);
      if (!via.length) {
        const leaving = ends.filter((e) => e !== null).map((e) => `track '${off.exits[e!].line}'`);
        const why = leaving.length ? `it is reached by none of the route's ends leaving the board (${leaving.join(", ")}); give it a via on one of them` : "the route does not leave the board; end its first or last track on the board's edge";
        issues.push({ code: "STOP_NOT_ON_ROUTE", jsonPath: `${base}.stops[${k}]`, message: `service '${svc.id}': stop '${id}' is off the board but ${why}` });
      } else offStops.push({ k, place: place.index, via });
      return;
    }
    const st = stations.get(id);
    if (!st) return;
    const rs = full.map((p) => (p.track === st.track ? rOnPiece(p, st.at, tracks) : null)).find((x) => x !== null);
    if (rs === undefined || rs === null) {
      const why = ids.includes(st.track) ? `the route only uses part of track '${st.track}' and the platform at s=${st.at} is not on it` : `its track '${st.track}' is not in the route [${ids.join(", ")}]`;
      issues.push({ code: "STOP_NOT_ON_ROUTE", jsonPath: `${base}.stops[${k}]`, message: `service '${svc.id}': stop '${id}' is not on the route: ${why}` });
    } else route.stops.push({ station: id, r: rs });
  });
  route.stops.sort((a, b) => a.r - b.r);

  // The runs off the board beyond each end.
  if (through) {
    // Off at the end and back on at the start, along one way out there: the stops beyond the end
    // (nearest first), then those beyond the start (farthest first); a place on both lies at both distances.
    const d = (v: Array<{ exit: number; distance: number }>, e: number | null) => v.find((x) => x.exit === e)?.distance;
    const out = offStops.filter((st) => d(st.via, ends[1]) !== undefined && d(st.via, ends[0]) === undefined).map((st) => d(st.via, ends[1])!);
    const back = offStops.filter((st) => d(st.via, ends[0]) !== undefined && d(st.via, ends[1]) === undefined).map((st) => d(st.via, ends[0])!);
    const both = offStops.filter((st) => d(st.via, ends[0]) !== undefined && d(st.via, ends[1]) !== undefined).map((st) => d(st.via, ends[0])! + d(st.via, ends[1])!);
    const far = (list: number[]) => (list.length ? Math.max(...list) : 0);
    const length = Math.max(OFF_THROUGH, ...both, far(out) + far(back) + OFF_CLEAR);
    const calls = offStops
      .map((st) => ({ place: st.place, at: d(st.via, ends[1]) ?? length - d(st.via, ends[0])! }))
      .sort((a, b) => a.at - b.at);
    route.off[1] = { exit: ends[1]!, calls, length, reenter: 0 };
  } else if (!closed) {
    // A shuttle runs out past its stops beyond an end (nearest first), turns at the last and calls again coming back.
    for (const e of [0, 1] as const) {
      if (ends[e] === null) continue;
      const here = offStops
        .map((st) => ({ place: st.place, at: st.via.find((v) => v.exit === ends[e])?.distance, other: st.via.find((v) => v.exit === ends[1 - e])?.distance }))
        .filter((x) => x.at !== undefined && (x.other === undefined || x.at <= x.other))
        .sort((a, b) => a.at! - b.at!);
      const far = here.length ? here[here.length - 1].at! : OFF_TURN;
      const calls = [
        ...here.map((x) => ({ place: x.place, at: x.at! })),
        ...here.slice(0, -1).reverse().map((x) => ({ place: x.place, at: 2 * far - x.at! })),
      ];
      route.off[e] = { exit: ends[e]!, calls, length: 2 * far, reenter: e };
    }
  }
  return { route: issues.length ? null : route, issues };
}

/** r of track position s if it lies on this piece. */
export function rOnPiece(p: PathPiece, s: number, tracks: Map<string, TrackGeom>): number | null {
  const t = tracks.get(p.track)!;
  const d = t.path.closed ? mod((s - p.s0) * p.dir, t.path.length) : (s - p.s0) * p.dir;
  return d >= -1e-6 && d <= p.length + 1e-6 ? p.r0 + d : null;
}

/** Track position of route coordinate r (wrapping for loop routes). */
export function locate(route: RoutePath, tracks: Map<string, TrackGeom>, r: number): { track: string; s: number; dir: 1 | -1 } {
  r = route.closed ? mod(r, route.length) : Math.min(Math.max(r, 0), route.length);
  let lo = 0;
  let hi = route.pieces.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (route.pieces[mid].r0 <= r) lo = mid;
    else hi = mid - 1;
  }
  const p = route.pieces[lo];
  const t = tracks.get(p.track)!;
  const s = p.s0 + p.dir * (r - p.r0);
  return { track: p.track, s: t.path.closed ? mod(s, t.path.length) : s, dir: p.dir };
}

/**
 * Where a shuttle turns round. Each end is the farthest stop on the end track
 * (so the train is centred on that platform), else the track end, else for a
 * loop end track the point half a lap from the junction.
 */
function shuttleEnds(
  ids: string[], hopsChosen: Hop[], tracks: Map<string, TrackGeom>,
  stops: StationSpec[], trainLen: number, exit: (track: string, end: 0 | 1) => boolean,
): { start: number; end: number } {
  const first = tracks.get(ids[0])!;
  const last = tracks.get(ids[ids.length - 1])!;
  const L0 = first.path.length;
  const L1 = last.path.length;
  const clampLine = (t: TrackGeom, s: number) => (t.path.closed ? mod(s, t.path.length) : Math.min(Math.max(s, BUFFER_MARGIN), t.path.length - BUFFER_MARGIN));
  const on = (t: TrackGeom) => stops.filter((st) => st.track === t.id).map((st) => st.at);

  if (ids.length === 1) {
    const at = on(first);
    const ends = at.length >= 2 ? { start: clampLine(first, Math.min(...at) - trainLen / 2), end: clampLine(first, Math.max(...at) + trainLen / 2) }
      : first.path.closed ? { start: 0, end: L0 / 2 } : { start: BUFFER_MARGIN, end: L0 - BUFFER_MARGIN };
    // An end that leaves the board: the trains run off it.
    if (!first.path.closed && exit(first.id, 0)) ends.start = 0;
    if (!first.path.closed && exit(first.id, 1)) ends.end = L0;
    return ends;
  }

  // First track: the train travels from the end toward the junction in direction d.
  const h0 = hopsChosen[0];
  const before = on(first).map((c) => ({ c, d: first.path.closed ? mod((h0.sOut - c) * h0.dirOut, L0) : (h0.sOut - c) * h0.dirOut })).filter((x) => x.d > 0);
  let start: number;
  if (!first.path.closed && exit(first.id, h0.dirOut > 0 ? 0 : 1)) start = h0.dirOut > 0 ? 0 : L0;
  else if (before.length) start = clampLine(first, before.reduce((a, b) => (b.d > a.d ? b : a)).c - h0.dirOut * (trainLen / 2));
  else if (first.path.closed) start = mod(h0.sOut - h0.dirOut * (L0 / 2), L0);
  else start = h0.dirOut > 0 ? BUFFER_MARGIN : L0 - BUFFER_MARGIN;

  // Last track: from the junction toward the end.
  const hN = hopsChosen[ids.length - 2];
  const after = on(last).map((c) => ({ c, d: last.path.closed ? mod((c - hN.sIn) * hN.dirIn, L1) : (c - hN.sIn) * hN.dirIn })).filter((x) => x.d > 0);
  let end: number;
  if (!last.path.closed && exit(last.id, hN.dirIn > 0 ? 1 : 0)) end = hN.dirIn > 0 ? L1 : 0;
  else if (after.length) end = clampLine(last, after.reduce((a, b) => (b.d > a.d ? b : a)).c + hN.dirIn * (trainLen / 2));
  else if (last.path.closed) end = mod(hN.sIn + hN.dirIn * (L1 / 2), L1);
  else end = hN.dirIn > 0 ? L1 - BUFFER_MARGIN : BUFFER_MARGIN;
  return { start, end };
}
