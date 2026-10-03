// Simulation invariants over 30 simulated minutes (§7.5): exclusive block
// reservations, trains never closer than 2 m on the same track, at least one stop
// per route traversal, and no deadlock. Run for both example layouts.

import { describe, it, expect } from "vitest";
import { buildWorld } from "../src/model/build";
import { Sim, DT, type SimSnapshot } from "../src/sim/sim";
import { locate } from "../src/model/routes";
import type { World } from "../src/model/build";
import { example } from "./fixtures";

const MINUTES = 30;
const CHECK_EVERY = 30;     // ticks between geometric checks (1 s)

/** Track positions covered by each train's consist, sampled every 0.5 m. */
function occupancy(world: World, sim: Sim): Array<Array<{ track: string; s: number }>> {
  return sim.trains.map((t) => {
    const out: Array<{ track: string; s: number }> = [];
    for (let d = 0; d <= t.plan.length; d += 0.5) out.push(locate(t.plan.route, world.tracks, t.r - t.dir * d));
    return out;
  });
}

describe.each(["valley-loop", "harbour-town"])("%s simulation", (name) => {
  const { world } = buildWorld(example(name));
  const sim = new Sim(world!);
  const snap: SimSnapshot = { time: 0, trains: [], switches: [], blocks: [], vehicles: [], gates: [], walkers: [] };
  let doubleBooked = 0;
  let closest = Infinity;

  for (let tick = 0; tick < (MINUTES * 60) / DT; tick++) {
    sim.step();
    if (tick % CHECK_EVERY) continue;
    sim.snapshot(snap);
    const seen = new Set<number>();
    for (const t of snap.trains) for (const b of t.reserved) (seen.has(b) ? doubleBooked++ : seen.add(b));
    const occ = occupancy(world!, sim);
    for (let i = 0; i < occ.length; i++) {
      for (let j = i + 1; j < occ.length; j++) {
        for (const a of occ[i]) {
          for (const b of occ[j]) {
            if (a.track !== b.track) continue;
            const L = world!.tracks.get(a.track)!.path;
            const ds = Math.abs(a.s - b.s);
            closest = Math.min(closest, L.closed ? Math.min(ds, L.length - ds) : ds);
          }
        }
      }
    }
  }

  it("spawned every train", () => {
    expect(sim.trains.length).toBe(world!.layout.services.reduce((a, s) => a + s.count, 0));
  });

  it("never reserves a block for two trains", () => expect(doubleBooked).toBe(0));

  it("keeps consists at least 2 m apart", () => expect(closest).toBeGreaterThanOrEqual(2));

  it("makes at least one stop per route traversal", () => {
    for (const t of sim.trains) {
      if (t.plan.svc.stops.length === 0) continue;
      const traversals = Math.floor(t.odometer / t.plan.route.length);
      expect(t.stops, t.id).toBeGreaterThanOrEqual(Math.max(1, traversals));
    }
  });

  it("does not deadlock", () => {
    expect(sim.deadlock).toBeNull();
    expect(sim.events.some((e) => e.type === "deadlock")).toBe(false);
    for (const t of sim.trains) expect(t.odometer, t.id).toBeGreaterThan(1000);
  });

  it("is deterministic", () => {
    const again = new Sim(world!);
    for (let i = 0; i < 3000; i++) again.step();
    const b = new Sim(world!);
    for (let i = 0; i < 3000; i++) b.step();
    expect(again.trains.map((t) => t.r)).toEqual(b.trains.map((t) => t.r));
  });
});
