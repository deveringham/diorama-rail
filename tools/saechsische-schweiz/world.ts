// Building the world from a partial layout and querying it, for the generator.
import { buildWorld, type World } from "../../src/model/build";
import { pointAt, headingAt } from "../../src/model/geometry";
import { profileZ } from "../../src/model/heights";
import { groundZ, baseZ, slopeAt } from "../../src/model/terrain";
import type { V2 } from "./lib";

export type { World };
export { pointAt, headingAt, profileZ, groundZ, baseZ, slopeAt };

export function build(layout: unknown, label = ""): World {
  const { world, report } = buildWorld(layout);
  const errors = report.issues.filter((i) => i.severity === "error");
  if (errors.length || !world) {
    console.log(`--- ${label}: ${errors.length} errors`);
    for (const e of errors.slice(0, 40)) console.log(`${e.code} ${e.path} ${e.at ? `@${e.at.join(",")}` : ""}\n   ${e.message}`);
    if (!world) throw new Error(`world '${label}' failed`);
  }
  return world;
}

export function issues(layout: unknown) {
  return buildWorld(layout).report.issues;
}

/** s on a track nearest a point (searched every 1 m, then refined). */
export function sOf(w: World, track: string, p: V2): number {
  const t = w.tracks.get(track);
  if (!t) throw new Error(`no track ${track}`);
  let best = 0, bd = Infinity;
  for (let s = 0; s <= t.path.length; s += 1) {
    const [x, y] = pointAt(t.path, s);
    const d = Math.hypot(x - p[0], y - p[1]);
    if (d < bd) { bd = d; best = s; }
  }
  for (let s = best - 1; s <= best + 1; s += 0.05) {
    const [x, y] = pointAt(t.path, Math.max(0, Math.min(t.path.length, s)));
    const d = Math.hypot(x - p[0], y - p[1]);
    if (d < bd) { bd = d; best = s; }
  }
  return Math.round(best * 10) / 10;
}

/** A point beside a track: `lateral` m to the left (negative: right) of its direction at s. */
export function beside(w: World, track: string, s: number, lateral: number): V2 {
  const t = w.tracks.get(track)!;
  const [x, y] = pointAt(t.path, s);
  const h = headingAt(t.path, s);
  return [Math.round((x - Math.sin(h) * lateral) * 10) / 10, Math.round((y + Math.cos(h) * lateral) * 10) / 10];
}

export const trackZ = (w: World, track: string, s: number) => profileZ(w.profiles.get(track)!, s);
export const trackLen = (w: World, track: string) => w.tracks.get(track)!.path.length;
