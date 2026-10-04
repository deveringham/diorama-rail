// Exits and the world beyond the board. A track, road or footpath line whose first
// or last waypoint lies on the board's edge (and that does not join another line
// there) leaves the board at that end: trains, cars, buses and people go on past
// the edge, out of sight, and come back the same way or another. `offLayout`
// names places out there — a town, a city, a village over the hill — each reached
// through one or more exits at some distance beyond the edge. They have no model:
// they are stops for train services and bus lines and destinations for errands.

import type { Layout } from "./schema";
import type { Path } from "./geometry";
import { pointAt, headingAt } from "./geometry";
import { type Issue, error } from "./validate";

const titleCase = (spec: { id: string; name?: string }) => spec.name ?? spec.id.split("-").map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");

export const EDGE_SNAP = 1;            // m: a line end this close to the edge is on it
const EXIT_ANGLE = 45;                 // degrees: the least angle at which a line may cross the edge

export type ExitKind = "track" | "road" | "path";

/** Where a line leaves the board. */
export type Exit = {
  id: number;
  kind: ExitKind;
  line: string;                        // track, road or path id
  end: 0 | 1;                          // at the line's start (s = 0) or end (s = length)
  at: [number, number];                // the point on the edge
  heading: number;                     // the line's heading there, pointing off the board
};

/** A place off the board and the exits that lead to it. */
export type OffPlace = {
  id: string;
  index: number;
  name: string;
  via: Array<{ exit: number; distance: number }>;   // m beyond the edge along that way
  jobs: string[];                      // a title per job residents may hold there
  visits: number;                      // how much people like going there
};

export type OffLayout = { exits: Exit[]; places: OffPlace[] };

export const emptyOffLayout = (): OffLayout => ({ exits: [], places: [] });

type Line = { id: string; spec: { kind?: string; from?: unknown; to?: unknown }; path: Path };

/**
 * The edge a line end lies on (its outward normal), if it is free and on the edge;
 * also how squarely the line crosses it (sine of the angle, 1 = square).
 */
export function edgeEnd(size: readonly [number, number], line: Line, end: 0 | 1): { normal: [number, number]; sin: number } | null {
  if (line.path.closed || line.spec.kind === "loop" || (end === 0 ? line.spec.from : line.spec.to)) return null;
  const s = end === 0 ? 0 : line.path.length;
  const [x, y] = pointAt(line.path, s);
  const [W, H] = size;
  const d = [x, W - x, y, H - y];
  const k = d.indexOf(Math.min(...d));
  if (d[k] > EDGE_SNAP) return null;
  const normal: [number, number] = k === 0 ? [-1, 0] : k === 1 ? [1, 0] : k === 2 ? [0, -1] : [0, 1];
  const h = headingAt(line.path, s) + (end === 0 ? Math.PI : 0);
  return { normal, sin: Math.cos(h) * normal[0] + Math.sin(h) * normal[1] };
}

/**
 * Whether s on a line lies on the stretch running off the board at one of its
 * exits, where it may come closer to the edge than `margin` (the usual bounds).
 */
export function offEdge(size: readonly [number, number], line: Line, s: number, margin: number): boolean {
  for (const end of [0, 1] as const) {
    const e = edgeEnd(size, line, end);
    if (!e) continue;
    const reach = (margin + 1) / Math.max(e.sin, 0.25);
    if (end === 0 ? s <= reach : s >= line.path.length - reach) return true;
  }
  return false;
}

/** Every exit, and errors for lines that meet the edge too obliquely. */
export function findExits(layout: Layout, lines: { tracks: Line[]; roads: Line[]; paths: Line[] }): { exits: Exit[]; issues: Issue[] } {
  const exits: Exit[] = [];
  const issues: Issue[] = [];
  const minSin = Math.sin((EXIT_ANGLE * Math.PI) / 180);
  for (const [kind, list, key] of [["track", lines.tracks, "tracks"], ["road", lines.roads, "roads"], ["path", lines.paths, "paths"]] as const) {
    for (const line of list) {
      for (const end of [0, 1] as const) {
        const e = edgeEnd(layout.terrain.size, line, end);
        if (!e) continue;
        const s = end === 0 ? 0 : line.path.length;
        const at = pointAt(line.path, s) as [number, number];
        if (e.sin < minSin) {
          const index = (layout[key] as Array<{ id: string }>).findIndex((x) => x.id === line.id);
          const deg = (Math.asin(Math.max(-1, Math.min(1, e.sin))) * 180) / Math.PI;
          issues.push(error("EXIT_POSITION", `${kind} '${line.id}' ends on the board's edge but meets it at only ${deg.toFixed(0)}°; let it leave the board at ${EXIT_ANGLE}° or more (ideally square) by moving the waypoint before its end`, `${key}[${index}].points`, at));
          continue;
        }
        exits.push({ id: exits.length, kind, line: line.id, end, at, heading: headingAt(line.path, s) + (end === 0 ? Math.PI : 0) });
      }
    }
  }
  return { exits, issues };
}

/** The off-layout places, with each `via` resolved to an exit. */
export function buildOffLayout(layout: Layout, exits: Exit[]): { places: OffPlace[]; issues: Issue[] } {
  const places: OffPlace[] = [];
  const issues: Issue[] = [];
  layout.offLayout.forEach((spec, i) => {
    const via: OffPlace["via"] = [];
    spec.via.forEach((v, k) => {
      const kind: ExitKind = v.track ? "track" : v.road ? "road" : "path";
      const line = (v.track ?? v.road ?? v.path)!;
      const where = `offLayout[${i}].via[${k}]`;
      const ends = exits.filter((e) => e.kind === kind && e.line === line);
      const end = v.end === undefined ? undefined : v.end === "start" ? 0 : 1;
      const pick = end === undefined ? ends : ends.filter((e) => e.end === end);
      if (!ends.length) {
        issues.push(error("EXIT_REF", `off-layout place '${spec.id}' is reached by ${kind} '${line}', which does not leave the board; put its first or last waypoint on the board's edge (x = 0 or ${layout.terrain.size[0]}, y = 0 or ${layout.terrain.size[1]})`, where));
      } else if (!pick.length) {
        issues.push(error("EXIT_REF", `${kind} '${line}' does not leave the board at its ${v.end}; use "end": "${ends[0].end === 0 ? "start" : "end"}"`, `${where}.end`));
      } else if (pick.length > 1) {
        issues.push(error("EXIT_REF", `${kind} '${line}' leaves the board at both ends; say which leads to '${spec.id}' with "end": "start" or "end"`, where));
      } else via.push({ exit: pick[0].id, distance: v.distance });
    });
    const jobs = Array.from({ length: spec.jobs }, (_, j) => spec.titles[Math.min(j, spec.titles.length - 1)]);
    places.push({ id: spec.id, index: i, name: titleCase(spec), via, jobs, visits: spec.visits });
  });
  return { places, issues };
}
