// The stable public API (§9), usable from Node and from the browser console
// (window.dr). Everything here is pure: no DOM, no three.js.

import type { World } from "./model/build";
import { pointAt, headingAt } from "./model/geometry";
import { profileZ, structureAt as spanAt, type StructureKind } from "./model/heights";
import { groundZ as shapedZ } from "./model/terrain";

export { LayoutSchema, type Layout, layoutJsonSchema } from "./model/schema";
export { buildWorld, validate, type World } from "./model/build";
export type { Issue, Report } from "./model/validate";
export { Sim, simulate, type SimReport, type SimSnapshot, type SimEvent } from "./sim/sim";
export { TRAIN_CATALOG } from "./model/catalog";
export { OBJECT_LIBRARY } from "./model/objectLibrary";

const f0 = (x: number) => x.toFixed(0);

export function query(world: World) {
  const track = (id: string) => {
    const t = world.tracks.get(id);
    if (!t) throw new Error(`unknown track '${id}'`);
    return t;
  };
  return {
    /** Nearest track point within `radius` metres of (x, y), or null. */
    trackAt(x: number, y: number, radius = 10): { track: string; s: number; dist: number } | null {
      let best: { track: string; s: number; dist: number } | null = null;
      world.pointHash.near(x, y, radius, (p) => {
        const d = Math.hypot(p.x - x, p.y - y);
        if (d <= radius && (!best || d < best.dist)) best = { track: p.track, s: p.s, dist: d };
      });
      if (!best) return null;
      // Refine between the 2 m samples.
      const b: { track: string; s: number; dist: number } = best;
      const path = track(b.track).path;
      for (let ds = -2; ds <= 2; ds += 0.05) {
        const s = path.closed ? (b.s + ds + path.length) % path.length : Math.min(Math.max(b.s + ds, 0), path.length);
        const [px, py] = pointAt(path, s);
        const d = Math.hypot(px - x, py - y);
        if (d < b.dist) Object.assign(b, { s, dist: d });
      }
      return b;
    },
    pointAt(id: string, s: number) {
      const t = track(id);
      const [x, y] = pointAt(t.path, s);
      return { x, y, z: profileZ(world.profiles.get(id)!, s), heading: headingAt(t.path, s) };
    },
    structureAt(id: string, s: number): StructureKind {
      track(id);
      return spanAt(world.spans.get(id)!, s);
    },
    groundZ(x: number, y: number): number {
      return shapedZ(world.terrain, x, y);
    },
    /** Compact plain-text summary for LLMs and humans. */
    describe(): string {
      const L = world.layout;
      const out: string[] = [];
      out.push(`Layout "${L.name}" seed ${L.seed}; terrain ${L.terrain.size[0]}×${L.terrain.size[1]} m; sea level ${L.terrain.seaLevel ?? "none"}; ${L.style.season}, ${L.style.timeOfDay}h${L.style.dayLengthSeconds ? `, day ${L.style.dayLengthSeconds}s` : ""}`);
      out.push("Tracks:");
      for (const id of world.order) {
        const t = world.tracks.get(id)!;
        const z = world.profiles.get(id)!.z;
        const radii = t.path.segments.filter((s) => s.type === "arc").map((s) => (s.type === "arc" ? s.radius : 0));
        const ends = (["from", "to"] as const).map((w) => (t.spec[w] ? `${w} ${t.spec[w]!.track}@${t.spec[w]!.at} ${t.spec[w]!.heading}` : "")).filter(Boolean);
        const spans = world.spans.get(id)!.filter((s) => s.kind !== "ground").map((s) => `${s.kind} ${f0(s.s0)}–${f0(s.s1)}`);
        out.push(`  ${id} ${t.spec.kind} ${f0(t.path.length)} m; min radius ${radii.length ? f0(Math.min(...radii)) : "∞"} m; z ${Math.min(...z).toFixed(1)}..${Math.max(...z).toFixed(1)}`
          + (ends.length ? `; ${ends.join(", ")}` : "") + (spans.length ? `; ${spans.join(", ")}` : ""));
      }
      if (world.junctions.length) {
        out.push("Junctions:");
        for (const j of world.junctions) out.push(`  ${j.id}: ${j.branchTrack} ${j.branchEnd} ↔ ${j.parentTrack} s=${f0(j.parentS)} (${j.heading}) at (${f0(j.at[0])}, ${f0(j.at[1])})`);
      }
      if (world.stations.length) {
        out.push("Stations:");
        for (const s of world.stations) out.push(`  ${s.id} "${s.name}" on ${s.track} s=${f0(s.s0)}–${f0(s.s1)} sides ${s.sides.map((d) => (d > 0 ? "left" : "right")).join("+")}`);
      }
      if (L.services.length) {
        out.push("Services:");
        for (const s of L.services) {
          const r = world.routes.get(s.id);
          out.push(`  ${s.id} ${s.train}×${s.count} ${s.mode} route [${s.route.join(", ")}] stops [${s.stops.join(", ")}] path ${r ? f0(r.length) : "?"} m`);
        }
      }
      const counts = new Map<string, number>();
      for (const p of world.scenery) counts.set(p.object, (counts.get(p.object) ?? 0) + 1);
      out.push(`Scenery: ${[...counts].sort((a, b) => b[1] - a[1]).map(([id, n]) => `${id}×${n}`).join(", ") || "none"}`);
      const custom = Object.keys(L.objects);
      out.push(`Objects available: ${[...world.objects.keys()].sort().join(", ")}${custom.length ? ` (defined by this layout: ${custom.join(", ")})` : ""}`);
      const st = world.stats;
      out.push(`Stats: ${Object.entries(st).map(([k, v]) => `${k} ${v}`).join(", ")}`);
      return out.join("\n");
    },
  };
}
