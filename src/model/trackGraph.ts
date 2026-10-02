// Builds every track's geometry in dependency order (parents before branches),
// then the track graph: nodes (buffer stops, loop seams, switches), edges
// (track sub-ranges between nodes) and the switch topology used for routing.

import type { Layout, TrackSpec } from "./schema";
import { waypoint } from "./schema";
import {
  type GeoIssue, type Path, type Segment, makePath, filletPolyline, junctionArc, pointAt, headingAt, reverseSeg,
} from "./geometry";
import type { V2 } from "../util/vec";
import { mod } from "../util/vec";

export type TrackGeom = {
  id: string;
  index: number;            // position in layout.tracks (for JSON paths)
  spec: TrackSpec;
  path: Path;
  waypointS: number[];      // s nearest each waypoint (used for z constraints)
};

export type Junction = {
  id: string;               // e.g. "hill.from"
  parentTrack: string;
  parentS: number;
  branchTrack: string;
  branchEnd: "start" | "end";
  heading: "forward" | "backward";
  at: V2;
  jsonPath: string;         // "tracks[1].from"
};

// --------------------------------------------------------------------------
// Dependency order

/** Topologically sorts tracks so parents come first. Returns the cycle if there is one. */
export function trackOrder(layout: Layout): { order: string[]; cycle: string[] | null } {
  const byId = new Map(layout.tracks.map((t) => [t.id, t]));
  const state = new Map<string, "visiting" | "done">();
  const order: string[] = [];
  let cycle: string[] | null = null;
  const visit = (id: string, stack: string[]) => {
    if (cycle || state.get(id) === "done") return;
    if (state.get(id) === "visiting") {
      cycle = [...stack.slice(stack.indexOf(id)), id];
      return;
    }
    state.set(id, "visiting");
    const t = byId.get(id);
    for (const end of [t?.from, t?.to]) if (end && byId.has(end.track)) visit(end.track, [...stack, id]);
    state.set(id, "done");
    order.push(id);
  };
  for (const t of layout.tracks) visit(t.id, []);
  return { order, cycle };
}

// --------------------------------------------------------------------------
// Track construction

type BuiltTrack = { track: TrackGeom | null; issues: Array<GeoIssue & { jsonPath: string }> };

/** Builds one track. Parent tracks referenced by from/to must already be in `built`. */
export function buildTrack(spec: TrackSpec, index: number, built: Map<string, TrackGeom>): BuiltTrack {
  const wps = spec.points.map(waypoint);
  const pts: V2[] = wps.map((w) => w.at);
  const radii = wps.map((w) => w.radius ?? spec.minRadius);
  const issues: BuiltTrack["issues"] = [];
  const base = `tracks[${index}]`;
  const lead: Segment[] = [];
  const tail: Segment[] = [];

  // Junction ends: an arc tangent to the parent, then the polyline continues from its end.
  for (const which of ["from", "to"] as const) {
    const end = spec[which];
    const parent = end && built.get(end.track);
    if (!end || !parent) continue;
    const J = pointAt(parent.path, end.at);
    let h = headingAt(parent.path, end.at) + (end.heading === "backward" ? Math.PI : 0);
    // A `to` end is built outward from the parent with the heading reversed, then flipped.
    if (which === "to") h += Math.PI;
    const W = which === "from" ? pts[0] : pts[pts.length - 1];
    const res = junctionArc(J, h, W, spec.minRadius);
    if (res.error) {
      issues.push({ code: "JUNCTION_UNREACHABLE", point: which, at: J, message: `track '${spec.id}' cannot leave the junction: ${res.error}`, jsonPath: `${base}.${which}` });
      continue;
    }
    if (which === "from") {
      if (res.arc) lead.push(res.arc);
      pts.unshift(res.end);
      radii.unshift(spec.minRadius);
    } else {
      if (res.arc) tail.push(reverseSeg(res.arc));
      pts.push(res.end);
      radii.push(spec.minRadius);
    }
  }
  if (issues.length) return { track: null, issues };

  const offset = spec.from ? 1 : 0;
  const fillet = filletPolyline(pts, radii, spec.kind === "loop");
  for (const is of fillet.issues) {
    const p = typeof is.point === "number" ? is.point - offset : is.point;
    const jsonPath = typeof p === "number" && p >= 0 && p < wps.length ? `${base}.points[${p}]` : `${base}.${p === -1 ? "from" : "to"}`;
    issues.push({ ...is, jsonPath, message: `track '${spec.id}': ${renumber(is.message, offset, wps.length)}` });
  }
  if (issues.length) return { track: null, issues };

  const segments = [...lead, ...fillet.segments, ...tail];
  const leadLen = lead.reduce((a, s) => a + s.length, 0);
  const waypointS = fillet.cornerS.slice(offset, offset + wps.length).map((s) => s + leadLen);
  const path = makePath(segments, spec.kind === "loop");
  if (!spec.from && spec.kind === "line") waypointS[0] = 0;
  if (!spec.to && spec.kind === "line") waypointS[wps.length - 1] = path.length;
  return { track: { id: spec.id, index, spec, path, waypointS }, issues };
}

/** Fillet messages count polyline points; shift them back to the author's waypoint indices. */
function renumber(msg: string, offset: number, count: number): string {
  if (offset === 0 && !msg.includes(`waypoint ${count}`)) return msg;
  return msg.replace(/waypoints? (\d+)( and (\d+))?/g, (_m, a: string, _b, c?: string) => {
    const f = (x: string) => { const i = Number(x) - offset; return i < 0 || i >= count ? "(junction)" : String(i); };
    return c ? `waypoints ${f(a)} and ${f(c)}` : `waypoint ${f(a)}`;
  });
}

/** All junctions declared by from/to, with the parent position normalised for loops. */
export function junctionsOf(tracks: Map<string, TrackGeom>): Junction[] {
  const out: Junction[] = [];
  for (const t of tracks.values()) {
    for (const which of ["from", "to"] as const) {
      const end = t.spec[which];
      const parent = end && tracks.get(end.track);
      if (!end || !parent) continue;
      let s = parent.path.closed ? mod(end.at, parent.path.length) : end.at;
      if (parent.path.closed && s > parent.path.length - 1e-6) s = 0;
      out.push({
        id: `${t.id}.${which}`, parentTrack: end.track, parentS: s, branchTrack: t.id,
        branchEnd: which === "from" ? "start" : "end", heading: end.heading,
        at: pointAt(parent.path, s), jsonPath: `tracks[${t.index}].${which}`,
      });
    }
  }
  return out;
}

// --------------------------------------------------------------------------
// Graph

export type Port = { edge: number; end: "start" | "end" };
export type GraphNode = { id: number; kind: "buffer" | "seam" | "switch"; track: string; s: number; at: V2 };
export type Edge = { id: number; track: string; s0: number; s1: number; start: number; end: number };
export type SwitchState = "straight" | "diverging";
export type Switch = Junction & { node: number; toe: Port; straight: Port; diverging: Port };

export type Graph = {
  nodes: GraphNode[];
  edges: Edge[];
  switches: Switch[];
  trackEdges: Map<string, number[]>;            // edges of each track, sorted by s0
  links: Map<string, Port>;                     // plain node connections (loop seams)
  switchPorts: Map<string, { sw: number; role: "toe" | "straight" | "diverging" }>;
};

export const portKey = (p: Port): string => `${p.edge}:${p.end}`;

export function buildGraph(tracks: Map<string, TrackGeom>, junctions: Junction[]): Graph {
  const nodes: GraphNode[] = [];
  const edges: Edge[] = [];
  const trackEdges = new Map<string, number[]>();
  const nodeAt = new Map<string, number>();     // "track@s" -> node id for split points
  const addNode = (kind: GraphNode["kind"], track: string, s: number, at: V2) => {
    nodes.push({ id: nodes.length, kind, track, s, at });
    return nodes.length - 1;
  };

  for (const t of tracks.values()) {
    const L = t.path.length;
    const splits = junctions.filter((j) => j.parentTrack === t.id).map((j) => j.parentS);
    if (t.path.closed) splits.push(0);
    const cuts = [...new Set(splits.map((s) => (t.path.closed && s >= L - 1e-6 ? 0 : s)))].sort((a, b) => a - b);
    for (const s of cuts) {
      const isSwitch = junctions.some((j) => j.parentTrack === t.id && Math.abs(j.parentS - s) < 1e-6);
      nodeAt.set(`${t.id}@${s}`, addNode(isSwitch ? "switch" : "seam", t.id, s, pointAt(t.path, s)));
    }
    const bounds = t.path.closed ? [...cuts, L] : [0, ...cuts.filter((s) => s > 0 && s < L), L];
    const ids: number[] = [];
    for (let i = 0; i + 1 < bounds.length; i++) {
      const s0 = bounds[i];
      const s1 = bounds[i + 1];
      const nodeFor = (s: number) => nodeAt.get(`${t.id}@${t.path.closed && s === L ? 0 : s}`) ?? -1;
      edges.push({ id: edges.length, track: t.id, s0, s1, start: nodeFor(s0), end: nodeFor(s1) });
      ids.push(edges.length - 1);
    }
    trackEdges.set(t.id, ids);
  }

  // Line ends: either attached to a junction node or a buffer stop.
  for (const t of tracks.values()) {
    if (t.path.closed) continue;
    const ids = trackEdges.get(t.id)!;
    const first = edges[ids[0]];
    const last = edges[ids[ids.length - 1]];
    const jFrom = junctions.find((j) => j.branchTrack === t.id && j.branchEnd === "start");
    const jTo = junctions.find((j) => j.branchTrack === t.id && j.branchEnd === "end");
    first.start = jFrom ? nodeAt.get(`${jFrom.parentTrack}@${jFrom.parentS}`)! : addNode("buffer", t.id, 0, pointAt(t.path, 0));
    last.end = jTo ? nodeAt.get(`${jTo.parentTrack}@${jTo.parentS}`)! : addNode("buffer", t.id, t.path.length, pointAt(t.path, t.path.length));
  }

  const edgeEndingAt = (track: string, s: number) => {
    const ids = trackEdges.get(track)!;
    const L = tracks.get(track)!.path.length;
    return ids.find((e) => Math.abs(edges[e].s1 - (s === 0 && tracks.get(track)!.path.closed ? L : s)) < 1e-6)!;
  };
  const edgeStartingAt = (track: string, s: number) =>
    trackEdges.get(track)!.find((e) => Math.abs(edges[e].s0 - s) < 1e-6)!;

  // Switch topology. "Forward-ish" means a train moving +s on the parent faces the
  // switch toe and can choose between straight and diverging.
  const switches: Switch[] = [];
  const switchPorts: Graph["switchPorts"] = new Map();
  for (const j of junctions) {
    const forwardish = (j.branchEnd === "start") === (j.heading === "forward");
    const ending: Port = { edge: edgeEndingAt(j.parentTrack, j.parentS), end: "end" };
    const starting: Port = { edge: edgeStartingAt(j.parentTrack, j.parentS), end: "start" };
    const bIds = trackEdges.get(j.branchTrack)!;
    const diverging: Port = j.branchEnd === "start" ? { edge: bIds[0], end: "start" } : { edge: bIds[bIds.length - 1], end: "end" };
    const sw: Switch = {
      ...j, node: nodeAt.get(`${j.parentTrack}@${j.parentS}`)!,
      toe: forwardish ? ending : starting, straight: forwardish ? starting : ending, diverging,
    };
    for (const role of ["toe", "straight", "diverging"] as const) switchPorts.set(portKey(sw[role]), { sw: switches.length, role });
    switches.push(sw);
  }

  // Loop seams are plain through-connections.
  const links = new Map<string, Port>();
  for (const t of tracks.values()) {
    if (!t.path.closed) continue;
    const ids = trackEdges.get(t.id)!;
    const a: Port = { edge: ids[ids.length - 1], end: "end" };
    const b: Port = { edge: ids[0], end: "start" };
    if (switchPorts.has(portKey(a))) continue;
    links.set(portKey(a), b);
    links.set(portKey(b), a);
  }
  return { nodes, edges, switches, trackEdges, links, switchPorts };
}

/** The edge (and travel direction along it) a train enters after leaving `edge` in `dir`. */
export function nextEdge(g: Graph, edge: number, dir: 1 | -1, states: SwitchState[]): { edge: number; dir: 1 | -1 } | null {
  const exit: Port = { edge, end: dir > 0 ? "end" : "start" };
  const sp = g.switchPorts.get(portKey(exit));
  let entry: Port | undefined;
  if (sp) {
    const sw = g.switches[sp.sw];
    entry = sp.role !== "toe" ? sw.toe : states[sp.sw] === "diverging" ? sw.diverging : sw.straight;
  } else {
    entry = g.links.get(portKey(exit));
  }
  return entry ? { edge: entry.edge, dir: entry.end === "start" ? 1 : -1 } : null;
}

/** §5.4 signature: next edge for a train at (trackId, s) moving in `direction`, or null at a buffer stop. */
export function next(g: Graph, trackId: string, s: number, direction: 1 | -1, states: SwitchState[]) {
  const ids = g.trackEdges.get(trackId) ?? [];
  const e = ids.find((id) => (direction > 0 ? g.edges[id].s0 <= s && s < g.edges[id].s1 : g.edges[id].s0 < s && s <= g.edges[id].s1));
  return e === undefined ? null : nextEdge(g, e, direction, states);
}
