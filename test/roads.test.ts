// Roads: network building (junctions, crossroads, level crossings, heights) and
// road traffic invariants over 30 simulated minutes — cars never share road space,
// never stand on a level crossing while a train is over it, keep moving, and
// trains are not held up by crossings.

import { describe, it, expect } from "vitest";
import { buildWorld, type World } from "../src/model/build";
import { query } from "../src/api";
import { Sim, DT, type SimSnapshot } from "../src/sim/sim";
import { locate } from "../src/model/routes";
import { profileZ } from "../src/model/heights";
import { CROSSING_ROAD_Z } from "../src/model/roads";
import { withRoads, base, example } from "./fixtures";

describe("road network", () => {
  const { world, report } = buildWorld(withRoads());
  const net = world!.roads;

  it("builds every road", () => {
    expect(report.ok).toBe(true);
    expect([...net.roads.keys()].sort()).toEqual(["cross", "lane", "north-south"]);
  });

  it("finds the crossroads and the T-junction", () => {
    const legs = (x: number, y: number) => net.nodes.find((n) => Math.hypot(n.at[0] - x, n.at[1] - y) < 2)?.legs.length;
    expect(legs(680, 400)).toBe(4);          // north-south × cross
    expect(legs(420, 400)).toBe(3);          // lane joins cross at s = 120
    expect(legs(680, 60)).toBe(1);           // dead ends
    expect(legs(420, 520)).toBe(1);
  });

  it("puts a level crossing wherever a road meets a track at grade, level with the rails", () => {
    expect(net.crossings.map((c) => c.track)).toEqual(["main", "main"]);
    for (const c of net.crossings) {
      expect(c.angle).toBeCloseTo(90, 0);
      expect(profileZ(net.profiles.get(c.road)!, c.roadS)).toBeCloseTo(c.z + CROSSING_ROAD_Z, 2);
      expect(c.z).toBeCloseTo(query(world!).pointAt(c.track, c.trackS).z, 2);
    }
  });

  it("joins the later of two crossing roads at the earlier one's height", () => {
    const n = net.nodes.find((x) => x.legs.length === 4)!;
    const z = (id: string) => profileZ(net.profiles.get(id)!, n.legs.find((l) => l.road === id)!.s);
    expect(z("cross")).toBeCloseTo(z("north-south"), 2);
  });

  it("finds roads by position", () => {
    const hit = query(world!).roadAt(500, 403)!;
    expect(hit.road).toBe("cross");
    expect(hit.s).toBeCloseTo(200, 0);
    expect(hit.dist).toBeCloseTo(3, 1);
  });

  it('joins at a road\'s "start" or "end" as a corner', () => {
    const L = withRoads();
    L.roads!.push({ id: "corner", from: { road: "lane", at: "end" }, points: [[330, 520]] });
    const { world: w } = buildWorld(L);
    const n = w!.roads.nodes.find((x) => Math.hypot(x.at[0] - 420, x.at[1] - 520) < 2)!;
    expect(n.legs.map((l) => l.road).sort()).toEqual(["corner", "lane"]);
  });

  it("passes under a track on a bridge when far enough below it", () => {
    const L = base();
    L.tracks[0].points = [[200, 200], { at: [660, 200], z: 9 }, [800, 200], [800, 600], [200, 600]];
    L.tracks[0].maxGrade = 0.04;
    L.roads = [{ id: "under", points: [[650, 60], [650, 340]] }];
    const { world: w, report: r } = buildWorld(L);
    expect(r.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(w!.roads.crossings).toEqual([]);
  });

  it("works level crossings over double track as one", () => {
    const L = base();
    L.stations = [];
    L.services[0].stops = [];
    L.tracks.push({ id: "loop2", kind: "line", minRadius: 150, from: { track: "main", at: 150 }, points: [[480, 207], [600, 207]], to: { track: "main", at: 400 } });
    L.roads = [{ id: "r", points: [[540, 100], [540, 300]] }];
    const { world: w, report: r } = buildWorld(L);
    expect(r.issues.filter((i) => i.severity === "error")).toEqual([]);
    const [a, b] = w!.roads.crossings;
    expect(w!.roads.crossings.length).toBe(2);
    expect(b.group).toBe(a.group);
    const sim = new Sim(w!);
    let apart = 0;
    for (let i = 0; i < (10 * 60) / DT; i++) {
      sim.step();
      if (sim.traffic.gates[0].state !== sim.traffic.gates[1].state) apart++;
    }
    expect(apart).toBe(0);
    expect(sim.traffic.stats().closures).toBeGreaterThan(2);
    expect(sim.traffic.stats().stuck).toBe(0);
  });

  it.each(["none", "both"] as const)("never queues across a level crossing with little road before the next (sidewalks: %s)", (sidewalks) => {
    // The road crosses the line twice, 46 m apart along it, at a shallow angle: a train
    // over one crossing waits for the other, and on one sidewalk their zones overlap.
    const L = base();
    L.terrain.seaLevel = 0.38;
    L.roads = [
      { id: "twice", sidewalks, points: [[164.72, 535.33], [347.37, 679.78], [591.15, 778.29]] },
      { id: "other", points: [[861.97, 53.2], [740.26, 87.9]] },
    ];
    L.traffic = { cars: 24 };
    L.pedestrians = { count: 100 };
    const { world: w, report: r } = buildWorld(L);
    expect(r.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(w!.roads.crossings.length).toBe(2);
    expect(w!.roads.crossings[0].group).not.toBe(w!.roads.crossings[1].group);
    const sim = new Sim(w!);
    for (let i = 0; i < (20 * 60) / DT && !sim.deadlock; i++) sim.step();
    expect(sim.deadlock).toBeNull();
    expect(sim.traffic.stats().stuck).toBe(0);
    expect(sim.walkers.stats().stuck).toBe(0);
  });

  it("keeps roads above the sea", () => {
    const L = withRoads();
    L.terrain.seaLevel = 0.5;
    const { world: w } = buildWorld(L);
    // Away from the level crossings, where the road must meet the rails.
    const near = (p: { x: number; y: number }) => w!.roads.crossings.some((c) => Math.hypot(c.at[0] - p.x, c.at[1] - p.y) < 30);
    for (const p of w!.roads.points) if (!near(p)) expect(p.z).toBeGreaterThanOrEqual(1.5 - 1e-6);
  });

  it("keeps scattered trees off the roads and can face objects to a road", () => {
    const L = withRoads();
    L.scenery = [{ scatter: ["conifer"], spacing: 12 }, { object: "house", at: [700, 300], face: "road" }];
    const { world: w } = buildWorld(L);
    const q = query(w!);
    for (const p of w!.scenery.filter((s) => s.object === "conifer")) expect(q.roadAt(p.x, p.y, 5)).toBeNull();
    expect(w!.scenery.find((p) => p.object === "house")!.rotation).toBeCloseTo(Math.PI, 1);
  });
});

/** Whether any train's consist covers a level crossing (within the road's width along the track). */
function trainOver(world: World, sim: Sim, c: World["roads"]["crossings"][number]): boolean {
  const road = world.roads.roads.get(c.road)!;
  const half = road.spec.width / 2 / Math.sin((c.angle * Math.PI) / 180) + 1;
  return sim.trains.some((t) => {
    for (let d = 0; d <= t.plan.length; d += 1) {
      const at = locate(t.plan.route, world.tracks, t.r - t.dir * d);
      if (at.track === c.track && Math.abs(at.s - c.trackS) < half) return true;
    }
    return false;
  });
}

describe.each([
  ["road fixture", () => withRoads()],
  ["valley-loop", () => example("valley-loop")],
  ["harbour-town", () => example("harbour-town")],
])("%s traffic", (_, make) => {
  const { world } = buildWorld(make());
  const sim = new Sim(world!);
  const snap: SimSnapshot = { time: 0, trains: [], switches: [], blocks: [], vehicles: [], gates: [], walkers: [] };
  let overlaps = 0;
  let unsafe = 0;
  const closedSeen = new Set<number>();
  for (let tick = 0; tick < (30 * 60) / DT; tick++) {
    sim.step();
    if (tick % 15) continue;
    overlaps += sim.traffic.overlapping();
    world!.roads.crossings.forEach((c, i) => {
      if (sim.traffic.gates[i].state === "closed") closedSeen.add(i);
      if (trainOver(world!, sim, c) && sim.traffic.carOnCrossing(i)) unsafe++;
    });
  }
  sim.snapshot(snap);

  it("places every vehicle", () => {
    expect(sim.traffic.unplaced).toBe(0);
    expect(snap.vehicles.length).toBe(sim.traffic.cars.length);
    expect(sim.traffic.cars.length).toBeGreaterThan(10);
  });

  it("never lets two vehicles share road space", () => expect(overlaps).toBe(0));

  it("never has a vehicle on a level crossing while a train is over it", () => expect(unsafe).toBe(0));

  it("closes every level crossing for passing trains", () => {
    expect(closedSeen.size).toBe(world!.roads.crossings.length);
  });

  it("keeps the traffic moving", () => {
    const st = sim.traffic.stats();
    expect(st.stuck).toBe(0);
    expect(st.maxWait).toBeLessThan(120);
    expect(st.avgSpeed).toBeGreaterThan(3);
    for (const c of sim.traffic.cars) expect(c.odometer, `car ${c.index}`).toBeGreaterThan(500);
  });

  it("does not hold up the trains", () => {
    const L = make();
    L.roads = [];
    L.paths = [];
    const plain = new Sim(buildWorld(L).world!);
    for (let i = 0; i < (30 * 60) / DT; i++) plain.step();
    const run = (s: Sim) => s.trains.reduce((a, t) => a + t.odometer, 0);
    expect(run(sim)).toBeGreaterThan(0.97 * run(plain));
  });

  it("is deterministic", () => {
    const a = new Sim(world!);
    const b = new Sim(world!);
    for (let i = 0; i < 2000; i++) { a.step(); b.step(); }
    expect(a.snapshot().vehicles).toEqual(b.snapshot().vehicles);
  });
});
