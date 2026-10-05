// Roads of several lanes and traffic lights: lane widths and markings in the model,
// which lane each turn goes from, lights at junctions (their groups of legs, lamps and
// stop lines), and 30 simulated minutes on a wide road in which cars use both lanes,
// change lanes, never overlap (in a lane or crossing a junction), never drive turns
// that cross at once, go only on green (or amber when too close to stop), and keep moving.

import { describe, it, expect } from "vitest";
import { buildWorld, validate } from "../src/model/build";
import { laneWidth, laneLateral } from "../src/model/roads";
import { Sim, DT, type SimSnapshot } from "../src/sim/sim";
import { withLanes, example, type Fixture } from "./fixtures";

const codes = (L: Fixture, code: string) => validate(L).issues.filter((i) => i.code === code);

describe("roads of several lanes and traffic lights", () => {
  const { world, report } = buildWorld(withLanes());
  const net = world!.roads;

  it("builds without errors or warnings", () => expect(report.issues).toEqual([]));

  it("makes a road 6 m wider for each lane each way, unless told its width", () => {
    const avenue = net.roads.get("avenue")!.spec;
    expect(avenue.lanes).toBe(2);
    expect(avenue.width).toBe(12);
    expect(laneWidth(avenue)).toBe(3);
    // Lane 0 runs by the kerb on the right of the traffic; the last by the centre line.
    expect(laneLateral(avenue, 1, 0)).toBe(-4.5);
    expect(laneLateral(avenue, 1, 1)).toBe(-1.5);
    expect(laneLateral(avenue, -1, 0)).toBe(4.5);
    expect(net.roads.get("north-road")!.spec.width).toBe(6);
  });

  it("puts the lights at the junction, opposite legs green together, with lamps over the wide road", () => {
    expect(net.signals).toHaveLength(1);
    const sig = net.signals[0];
    const n = net.nodes[sig.node];
    expect(n.at).toEqual([500, 400]);
    const roadOf = (legs: number[]) => legs.map((l) => n.legs[l].road).sort();
    expect(sig.phases.map(roadOf).sort()).toEqual([["avenue", "avenue"], ["north-road", "north-road"]]);
    expect(sig.heads).toHaveLength(4);
    for (const h of sig.heads) {
      const leg = n.legs[h.leg];
      // At the stop line: clear of the other road, on the arriving drivers' right, facing them.
      const other = leg.road === "avenue" ? 3 : 6;
      expect(Math.abs(h.stopS - leg.s)).toBeCloseTo(other + 1.5, 3);
      expect(h.arm > 0).toBe(leg.road === "avenue");
    }
  });

  it("reports lights away from any junction, two at one junction, and lanes too narrow", () => {
    const L = withLanes();
    L.trafficLights = [{ at: [300, 300] }];
    expect(codes(L, "SIGNAL_POSITION")[0].message).toMatch(/not at a junction of three or more roads; the nearest is \d+ m away at \(500, 400\)/);
    const M = withLanes();
    M.trafficLights!.push({ at: [505, 402] });
    expect(codes(M, "SIGNAL_POSITION")[0].message).toMatch(/same junction as trafficLights\[0\]/);
    const N = withLanes();
    N.roads![0].width = 8;
    expect(codes(N, "ROAD_LANES")[0].message).toMatch(/2 lanes each way in 8 m, only 2.00 m a lane; give it a width of 12 m/);
  });
});

describe("traffic on a road of two lanes each way", () => {
  const { world } = buildWorld(withLanes());
  const sim = new Sim(world!);
  const lanes = sim.traffic.laneList;
  const sig = world!.roads.signals[0];
  const snap: SimSnapshot = { time: 0, trains: [], switches: [], blocks: [], vehicles: [], gates: [], signals: [], people: [], freight: { goods: [], yards: [], stock: [], trains: [] } };
  let overlaps = 0;
  let crossing = 0;
  let wrongLight = 0;
  let inner = 0;
  const greens = new Set<number>();
  const both = new Set<string>();
  let held = new Set<string>();
  for (let tick = 0; tick < (30 * 60) / DT; tick++) {
    sim.step();
    // Every car let into the junction this tick was facing green, or amber too close to stop.
    const now = sim.traffic.holds();
    for (const h of now) {
      const key = `${h.car}|${h.node}|${h.lane}`;
      if (!held.has(key) && h.light === "red") wrongLight++;
    }
    held = new Set(now.map((h) => `${h.car}|${h.node}|${h.lane}`));
    if (tick % 10) continue;
    overlaps += sim.traffic.overlapping();
    crossing += sim.traffic.conflictingHolds();
    sim.snapshot(snap);
    snap.signals.forEach((v, i) => { if (v === 2) greens.add(i); });
    // Both phases never green at once.
    const green = sig.heads.filter((_, i) => snap.signals[i] > 0).map((h) => sig.phases.findIndex((p) => p.includes(h.leg)));
    if (new Set(green).size > 1) wrongLight++;
    for (const c of sim.traffic.cars) {
      const seg = c.path[0];
      if (c.hidden || seg?.kind !== "lane" || seg.road.id !== "avenue") continue;
      both.add(`${seg.id}|${c.track}`);
      if (c.track === 1) inner++;
    }
  }
  const stats = sim.traffic.stats();

  it("drives in both lanes and changes between them", () => {
    expect(inner).toBeGreaterThan(100);
    expect(stats.laneChanges).toBeGreaterThan(20);
    // Each avenue lane (both directions, between its nodes) seen with cars side by side in both of its lanes somewhere.
    const avenueLanes = lanes.filter((l) => l.road.id === "avenue" && l.length > 60);
    expect(avenueLanes.filter((l) => both.has(`${l.id}|0`) && both.has(`${l.id}|1`)).length).toBeGreaterThan(avenueLanes.length / 2);
  });

  it("turns right from the lane by the kerb, left from the one by the centre line, straight on from either", () => {
    const n = world!.roads.nodes[sig.node];
    const into = lanes.find((l) => l.road.id === "avenue" && l.dir === 1 && l.end === n.id)!;
    const next = (road: string, dir: 1 | -1) => into.next.find((l) => l.road.id === road && l.dir === dir)!;
    expect(sim.traffic.turnLanes(into.id, next("avenue", 1).id)).toEqual([0, 1]);
    expect(sim.traffic.turnLanes(into.id, next("north-road", -1).id)).toEqual([0]);     // heading east, south is right
    expect(sim.traffic.turnLanes(into.id, next("north-road", 1).id)).toEqual([1]);
    // From the one-lane road every turn goes from its only lane.
    const minor = lanes.find((l) => l.road.id === "north-road" && l.end === n.id)!;
    for (const to of minor.next) expect(sim.traffic.turnLanes(minor.id, to.id)).toEqual([0]);
  });

  it("works the lights: each group green in turn, only one at once, cars going only on green or late amber", () => {
    expect(greens.size).toBe(sig.heads.length);
    expect(wrongLight).toBe(0);
    expect(stats.junctionGrants).toBeGreaterThan(100);
  });

  it("never lets cars overlap, in a lane or crossing a junction, nor drive crossing turns at once", () => {
    expect(overlaps).toBe(0);
    expect(crossing).toBe(0);
  });

  it("keeps the traffic moving", () => {
    expect(stats.stuck).toBe(0);
    expect(stats.maxWait).toBeLessThan(90);
    expect(stats.avgSpeed).toBeGreaterThan(4);
    for (const c of sim.traffic.cars) expect(c.odometer, `car ${c.index}`).toBeGreaterThan(500);
  });

  it("is deterministic", () => {
    const a = new Sim(world!);
    const b = new Sim(world!);
    for (let i = 0; i < 3000; i++) { a.step(); b.step(); }
    expect(a.traffic.stats()).toEqual(b.traffic.stats());
    expect(a.snapshot().signals).toEqual(b.snapshot().signals);
  });
});

describe.each(["valley-loop", "harbour-town"])("%s lanes and lights", (name) => {
  const { world } = buildWorld(example(name));

  it("has a road of two lanes each way and traffic lights on it", () => {
    expect([...world!.roads.roads.values()].some((r) => r.spec.lanes === 2)).toBe(true);
    expect(world!.roads.signals.length).toBeGreaterThanOrEqual(2);
    for (const sig of world!.roads.signals) expect(sig.phases.length).toBeGreaterThanOrEqual(2);
  });
});
