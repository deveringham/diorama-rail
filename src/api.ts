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
export { describePerson, describeBuilding, describeVehicle, describeTrain, describeBusStop, doing, type Info } from "./sim/describe";
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
    /** Nearest road point within `radius` metres of (x, y), or null. */
    roadAt(x: number, y: number, radius = 10): { road: string; s: number; dist: number } | null {
      let best: { road: string; s: number; dist: number } | null = null;
      world.roads.hash.near(x, y, radius, (p) => {
        const d = Math.hypot(p.x - x, p.y - y);
        if (d <= radius && (!best || d < best.dist)) best = { road: p.road, s: p.s, dist: d };
      });
      if (!best) return null;
      const b: { road: string; s: number; dist: number } = best;
      const path = world.roads.roads.get(b.road)!.path;
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
      const net = world.roads;
      if (net.roads.size) {
        out.push("Roads:");
        for (const id of net.order) {
          const r = net.roads.get(id)!;
          const z = net.profiles.get(id)!.z;
          const ends = (["from", "to"] as const).map((w) => (r.spec[w] ? `${w} ${r.spec[w]!.road}@${r.spec[w]!.at}` : "")).filter(Boolean);
          const spans = net.spans.get(id)!.filter((s) => s.kind !== "ground").map((s) => `${s.kind} ${f0(s.s0)}–${f0(s.s1)}`);
          const junctions = net.stops.get(id)!.filter((x) => net.nodes[x.node].legs.length >= 3).map((x) => f0(x.s));
          out.push(`  ${id} ${r.spec.kind} ${f0(r.path.length)} m, ${r.spec.width} m wide; z ${Math.min(...z).toFixed(1)}..${Math.max(...z).toFixed(1)}`
            + (ends.length ? `; ${ends.join(", ")}` : "") + (junctions.length ? `; junctions at s=${junctions.join(", ")}` : "") + (spans.length ? `; ${spans.join(", ")}` : ""));
        }
        for (const c of net.crossings) out.push(`  level crossing ${c.id}: ${c.road} s=${f0(c.roadS)} × ${c.track} s=${f0(c.trackS)} at (${f0(c.at[0])}, ${f0(c.at[1])}), ${f0(c.angle)}°`);
        const cars = L.traffic.cars;
        out.push(`  through traffic: ${cars ?? "auto"} vehicles of [${[...new Set(L.traffic.vehicles)].join(", ")}]`);
        const walked = [...net.roads.values()].filter((r) => r.spec.sidewalks !== "none").map((r) => `${r.id} (${r.spec.sidewalks})`);
        if (walked.length) out.push(`  sidewalks: ${walked.join(", ")}`);
        const parked = [...net.roads.values()].filter((r) => r.spec.parking !== "none").map((r) => `${r.id} (${r.spec.parking}${r.spec.parkingStyle === "perpendicular" ? ", nose-in" : ""})`);
        if (parked.length) out.push(`  street parking: ${parked.join(", ")}`);
        for (const lot of world.town.lots) {
          const bays = world.town.bays.filter((b) => b.lot === lot.id).length;
          out.push(`  car park ${lot.id} "${lot.name}" at (${f0(lot.centre[0])}, ${f0(lot.centre[1])}), ${bays} bays, ${f0(lot.length)}×${f0(lot.width)} m, joins ${lot.parent}`);
        }
      }
      const walks = world.walks;
      if (walks.paths.size) {
        out.push("Paths:");
        for (const id of walks.order) {
          const p = walks.paths.get(id)!;
          const ends = (["from", "to"] as const).map((w) => {
            const e = p.spec[w];
            return e ? (e.station ? `${w} station ${e.station}` : `${w} ${e.path ? `path ${e.path}` : `road ${e.road}`}@${e.at}`) : "";
          }).filter(Boolean);
          const spans = walks.spans.get(id)!.filter((s) => s.kind !== "ground").map((s) => `${s.kind} ${f0(s.s0)}–${f0(s.s1)}`);
          out.push(`  ${id} ${p.spec.kind} ${f0(p.path.length)} m, ${p.spec.width} m ${p.spec.surface}` + (ends.length ? `; ${ends.join(", ")}` : "") + (spans.length ? `; ${spans.join(", ")}` : ""));
        }
      }
      if (walks.ways.length) {
        const zebras = walks.crossings.filter((c) => c.kind === "zebra");
        for (const c of zebras) out.push(`  zebra crossing on ${c.road} s=${f0(c.roadS)} at (${f0(c.at[0])}, ${f0(c.at[1])})`);
        for (const c of walks.footCrossings) out.push(`  foot crossing ${c.id}: ${c.road} s=${f0(c.roadS)} × ${c.track} s=${f0(c.trackS)} at (${f0(c.at[0])}, ${f0(c.at[1])}), ${f0(c.angle)}°`);
        out.push(`  ${walks.crossings.length - zebras.length} unmarked crossings at road junctions`);
      }
      const town = world.town;
      if (town.buildings.length) {
        out.push("Town:");
        const kinds = new Map<string, number>();
        for (const b of town.buildings) kinds.set(b.kind, (kinds.get(b.kind) ?? 0) + 1);
        out.push(`  buildings: ${[...kinds].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}×${n}`).join(", ")}`);
        const placesOf = (fn: string) => town.buildings.filter((b) => b.functions.includes(fn as never) && b.kind !== "House");
        for (const b of [...new Set([...placesOf("workplace"), ...placesOf("landmark")])]) {
          out.push(`  ${b.name} (${b.kind}: ${b.functions.join(", ")}${b.jobs.length ? `; ${b.jobs.length} jobs` : ""}) at (${f0(b.at[0])}, ${f0(b.at[1])})${b.access || b.bays.length ? "" : " UNREACHABLE"}`);
        }
        const homes = town.buildings.filter((b) => b.residents > 0);
        out.push(`  homes: ${homes.length} buildings for ${homes.reduce((a, b) => a + b.residents, 0)} people; ${town.people.length} live here, ${town.people.filter((p) => p.job).length} with jobs, ${town.people.filter((p) => p.car).length} with cars (${town.bays.length} parking bays)`);
        for (const st of town.stations) out.push(`  station ${st.station} entered ${st.entrances.map((e) => `${e.via === "path" ? "by path" : e.via === "building" ? "through its building" : "from the nearest walkway"} (${e.side > 0 ? "left" : "right"} platform)`).join(", ") || "nowhere: no walkway reaches it"}`);
        out.push(`  places to stroll to: ${town.spots.length}`);
      }
      const buses = world.buses;
      if (buses.stops.length) {
        out.push("Buses:");
        const sideName = (id: number) => (id < 0 ? `${world.offLayout.places[-1 - id].id}(off)`
          : `${buses.stops[buses.sides[id].stop].id}${buses.stops[buses.sides[id].stop].sides.length > 1 ? `(${buses.sides[id].side > 0 ? "L" : "R"})` : ""}`);
        for (const st of buses.stops) {
          const sides = st.sides.map((k) => `${buses.sides[k].side > 0 ? "left" : "right"}${town.stops[k]?.access ? "" : " UNREACHABLE"}`);
          out.push(`  stop ${st.id} "${st.name}" on ${st.road} s=${f0(st.s)}, ${sides.join(" + ")} side${sides.length > 1 ? "s" : ""}`);
        }
        for (const l of buses.lines) {
          out.push(`  line ${l.id} "${l.name}" ${l.mode}, ${l.count}× ${l.vehicle} (${l.color}): ${l.visits.map((v) => sideName(v.side)).join(" → ")} → back; round ${f0(l.distance)} m in about ${f0(l.cycle)} s, a bus every ${f0(l.cycle / l.count)} s`);
        }
      }
      const off = world.offLayout;
      if (off.exits.length) {
        out.push("Off the board:");
        for (const e of off.exits) out.push(`  exit: ${e.kind} ${e.line} leaves at its ${e.end ? "end" : "start"}, (${f0(e.at[0])}, ${f0(e.at[1])})`);
        for (const p of off.places) {
          const via = p.via.map((v) => `${off.exits[v.exit].kind} ${off.exits[v.exit].line} ${f0(v.distance)} m`).join(", ");
          const services = L.services.filter((s) => s.stops.includes(p.id)).map((s) => s.id);
          const lines = L.busLines.filter((l) => l.stops.includes(p.id)).map((l) => l.id);
          out.push(`  place ${p.id} "${p.name}" via ${via || "nothing"}; ${p.jobs.length} jobs, visits ${p.visits}`
            + (services.length ? `; trains ${services.join(", ")}` : "") + (lines.length ? `; buses ${lines.join(", ")}` : ""));
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
