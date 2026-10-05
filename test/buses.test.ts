// Buses: stops beside roads on one side or both, lines worked out over the lanes
// between them (calling at each stop on the side to the bus's right), the checks on
// where stops and lines may go, and simulated half hours in which buses go round,
// stop at every stop in turn, keep out of everyone's way, and carry people who wait
// at their stop and get off at the one they planned.

import { describe, it, expect } from "vitest";
import { buildWorld, validate, type World } from "../src/model/build";
import { laneTopology } from "../src/model/roads";
import { pointAt, headingAt } from "../src/model/geometry";
import { Sim, DT } from "../src/sim/sim";
import { describeVehicle, describeBusStop, describePerson } from "../src/sim/describe";
import { withBuses, example, type Fixture } from "./fixtures";

const codes = (L: Fixture, code: string) => validate(L).issues.filter((i) => i.code === code);

describe("bus stops and lines", () => {
  const { world, report } = buildWorld(withBuses());
  const net = world!.buses;
  const stop = (id: string) => net.stops.find((s) => s.id === id)!;

  it("builds without errors or warnings", () => expect(report.issues).toEqual([]));

  it("puts a stop on each side asked for, with a walkway to it", () => {
    expect(net.stops.map((s) => s.sides.length)).toEqual([2, 2, 2]);
    for (const side of net.sides) {
      expect(side.dir).toBe(-side.side);                 // driving on the right
      expect(world!.town.stops[side.id].access, net.stops[side.stop].id).not.toBeNull();
      // People wait on the sidewalk on the stop's side of the road.
      const road = world!.roads.roads.get(net.stops[side.stop].road)!;
      const [px, py] = pointAt(road.path, side.s);
      const h = headingAt(road.path, side.s);
      const lateral = -(side.at[0] - px) * Math.sin(h) + (side.at[1] - py) * Math.cos(h);
      expect(lateral * side.side).toBeGreaterThan(3);
    }
    expect(stop("houses").name).toBe("The Houses");
    expect(stop("shops").name).toBe("Shops");
  });

  it("drives each line along lanes that follow on from one another, round and back to the start", () => {
    const topo = new Map(laneTopology(world!.roads, world!.layout.terrain.size).map((t) => [t.key, t]));
    const [line] = net.lines;
    expect(line.visits.length).toBe(4);                  // there and back: houses, shops, church, shops
    line.legs.forEach((keys, k) => {
      expect(keys[0]).toBe(net.sides[line.visits[k].side].lane);
      expect(keys[keys.length - 1]).toBe(net.sides[line.visits[(k + 1) % line.visits.length].side].lane);
      for (let i = 1; i < keys.length; i++) expect(topo.get(keys[i - 1])!.next).toContain(keys[i]);
    });
    expect(line.distance).toBeGreaterThan(1000);
    expect(line.cycle).toBeGreaterThan(line.visits.length * line.dwell);
  });

  it("calls at both sides of a stop on a shuttle's way out and back", () => {
    const [line] = net.lines;
    const shops = line.visits.filter((v) => net.sides[v.side].stop === stop("shops").index).map((v) => v.side);
    expect(shops).toHaveLength(2);
    expect(shops[0]).not.toBe(shops[1]);
  });

  it("calls at a stop with one side only on the pass that has it on the right", () => {
    const L = withBuses();
    L.busStops![1].side = "left";
    const { world: w, report: r } = buildWorld(L);
    expect(r.issues).toEqual([]);
    const line = w!.buses.lines[0];
    const shops = line.visits.filter((v) => w!.buses.sides[v.side].stop === 1);
    expect(shops).toHaveLength(1);
    expect(w!.buses.sides[shops[0].side].side).toBe(1);
  });

  it("keeps parked cars out of the stops", () => {
    for (const side of net.sides) {
      const front = side.s + side.dir * 2;
      const lo = Math.min(front, front - side.dir * side.reach);
      const hi = Math.max(front, front - side.dir * side.reach);
      const bays = world!.town.bays.filter((b) => b.road === net.stops[side.stop].road && b.side === side.side && b.s + b.length / 2 > lo && b.s - b.length / 2 < hi);
      expect(bays, net.stops[side.stop].id).toEqual([]);
    }
  });

  it("refuses stops where a waiting bus would block a junction, a crossing or the end of the road", () => {
    const at = (road: string, s: number) => {
      const L = withBuses();
      L.busStops!.push({ id: "bad", road, at: s });
      L.busLines![0].stops.push("bad");
      return codes(L, "BUS_STOP_POSITION");
    };
    expect(at("north-south", 345)[0].message).toMatch(/junction at \(680, 400\)/);
    expect(at("north-south", 140)[0].message).toMatch(/level crossing/);
    expect(at("cross", 112)[0].message).toMatch(/junction at \(420, 400\); move it to about s=\d+/);
    expect(at("north-south", 700)[0].message).toMatch(/700 but road 'north-south' is 680 m long/);
    expect(at("north-south", 275)[0].message).toMatch(/too close on the same side/);
  });

  it("refuses a line between stops no road connects, and stops listed twice in a row", () => {
    const L = withBuses();
    L.roads!.push({ id: "island", points: [[100, 700], [300, 700]] });
    L.busStops!.push({ id: "island-stop", road: "island", at: 100 });
    L.busLines![0].stops.push("island-stop");
    expect(codes(L, "BUS_ROUTE")[0].message).toMatch(/no way by road from stop 'church-stop' to stop 'island-stop'/);
    const M = withBuses();
    M.busLines![0].stops = ["houses", "shops", "shops"];
    expect(codes(M, "BUS_ROUTE")[0].message).toMatch(/twice in a row/);
    const N = withBuses();
    N.busLines![0] = { ...N.busLines![0], mode: "loop", stops: ["houses", "shops", "houses"] };
    expect(codes(N, "BUS_ROUTE")[0].message).toMatch(/ends where it starts/);
  });

  it("reports unknown stops, roads and vehicles, unused stops and stops nobody can walk to", () => {
    const L = withBuses();
    L.busStops!.push({ id: "nowhere", road: "no-such-road", at: 10 });
    L.busLines![0].stops.push("no-such-stop");
    L.busLines![0].vehicle = "tram";
    expect(codes(L, "UNKNOWN_REF").map((i) => i.path).sort()).toEqual(["busLines[0].stops[3]", "busLines[0].vehicle", "busStops[3].road"]);
    const M = withBuses();
    M.busStops!.push({ id: "spare", road: "north-south", at: 600 });
    expect(codes(M, "BUS_STOP_UNUSED")[0].path).toBe("busStops[3]");
    const N = withBuses();
    N.roads![0].sidewalks = "left";                       // nothing to walk on along the east side
    const lost = codes(N, "BUS_STOP_UNREACHABLE").map((i) => i.message);
    expect(lost.some((m) => /'shops' \(right side/.test(m))).toBe(true);
    expect(lost.some((m) => /left side/.test(m))).toBe(false);
  });
});

/**
 * Runs a sim, watching the buses: the order each calls at its visits, where it stands
 * when it does, riders who are not on their bus's list, and people getting off
 * anywhere but the stop their journey planned.
 */
function runBuses(world: World, minutes: number) {
  const sim = new Sim(world);
  const lines = sim.traffic.lines;
  const order = new Map<number, number[]>();
  let overlaps = 0;
  let strayRiders = 0;
  let wrongStop = 0;
  let farFromStop = 0;
  const wasRiding = new Map<number, number>();         // person -> bus, last tick
  for (let tick = 0; tick < (minutes * 60) / DT; tick++) {
    sim.step();
    for (const line of lines) {
      for (const ci of line.buses) {
        const v = sim.traffic.busVisit(ci);
        const seen = order.get(ci) ?? [];
        order.set(ci, seen);
        if (v < 0 || seen[seen.length - 1] === v) continue;
        seen.push(v);
        // Standing with its door by where people wait (unless calling off the board).
        if (line.geom.visits[v].side < 0) continue;
        const side = world.buses.sides[line.geom.visits[v].side];
        const door = sim.traffic.busDoor(ci);
        if (Math.hypot(door[0] - side.at[0], door[1] - side.at[1]) > 6) farFromStop++;
      }
    }
    for (const b of sim.people.bodies) {
      const was = wasRiding.get(b.id);
      if (was !== undefined && b.mode === "alight") {
        const leg = b.route?.legs[b.leg];
        const v = sim.traffic.busVisit(was);
        const line = lines[sim.traffic.cars[was].line];
        if (leg?.mode !== "bus" || v < 0 || line.geom.visits[v].side !== leg.to) wrongStop++;
      }
      if (b.mode === "bus") {
        wasRiding.set(b.id, b.bus);
        if (!(sim.people.onBus.get(b.bus) ?? []).includes(b.id)) strayRiders++;
      } else wasRiding.delete(b.id);
    }
    if (tick % 15 === 0) overlaps += sim.traffic.overlapping();
  }
  const trips = sim.people.stats().trips;
  const byBus = Object.entries(trips).filter(([k]) => k.includes("bus")).reduce((a, [, n]) => a + n, 0);
  return { sim, order, overlaps, strayRiders, wrongStop, farFromStop, byBus };
}

describe("buses in the simulation", () => {
  const { world } = buildWorld(withBuses());
  const { sim, order: orders, overlaps, strayRiders, wrongStop, farFromStop, byBus } = runBuses(world!, 30);
  const line = sim.traffic.lines[0];
  const order = line.buses.map((ci) => orders.get(ci)!);

  it("places every bus", () => {
    expect(sim.traffic.busesUnplaced).toBe(0);
    expect(line.buses).toHaveLength(2);
  });

  it("calls at every stop in turn, standing by its sign", () => {
    const m = line.geom.visits.length;
    for (const seen of order) {
      expect(seen.length).toBeGreaterThan(m);
      for (let k = 1; k < seen.length; k++) expect(seen[k]).toBe((seen[k - 1] + 1) % m);
    }
    expect(sim.traffic.stats().busSkipped).toBe(0);
    expect(farFromStop).toBe(0);
  });

  it("never shares road space and keeps the traffic moving", () => {
    expect(overlaps).toBe(0);
    expect(sim.traffic.stats().stuck).toBe(0);
    expect(sim.traffic.stats().maxWait).toBeLessThan(120);
  });

  it("carries people who wait at the stop to the stop they planned", () => {
    const st = sim.people.stats();
    expect(byBus).toBeGreaterThan(1);
    expect(strayRiders).toBe(0);
    expect(wrongStop).toBe(0);
    expect(st.maxStopWait).toBeLessThan(2 * line.geom.cycle);
    expect(st.stuck).toBe(0);
  });

  it("describes buses, stops and the people on them", () => {
    const ci = line.buses[0];
    const info = describeVehicle(sim, ci);
    expect(info.title).toBe("Bus 7");
    expect(info.lines[0].text).toMatch(/^7 \(there and back, 2 buses, every \d+ min\)$/);
    expect(info.lists[0].title).toMatch(/^Passengers \(\d+ of 40\)$/);
    const stopInfo = describeBusStop(sim, 1);
    expect(stopInfo.title).toBe("Shops");
    expect(stopInfo.lines.filter((l) => /side$/.test(l.label)).map((l) => l.text).join(" ")).toMatch(/7 towards/);
    const rider = sim.people.bodies.find((b) => b.mode === "bus" || b.mode === "stop");
    if (rider) expect(describePerson(sim, rider.id).lines.find((l) => l.label === "Now")!.text).toMatch(/bus/);
  });

  it("is deterministic", () => {
    const a = new Sim(world!);
    const b = new Sim(world!);
    for (let i = 0; i < 3000; i++) { a.step(); b.step(); }
    expect(a.snapshot().vehicles).toEqual(b.snapshot().vehicles);
    expect(a.snapshot().people).toEqual(b.snapshot().people);
  });
});

describe.each(["valley-loop", "harbour-town"])("%s buses", (name) => {
  const { world, report } = buildWorld(example(name));

  it("builds its lines without issues", () => {
    expect(report.issues).toEqual([]);
    expect(world!.buses.lines.length).toBeGreaterThan(0);
    for (const side of world!.buses.sides) expect(world!.town.stops[side.id].access).not.toBeNull();
  });

  it("carries people by bus, each to the stop they planned", () => {
    const run = runBuses(world!, 20);
    expect(run.byBus).toBeGreaterThan(5);
    expect(run.sim.traffic.stats().busSkipped).toBe(0);
    expect(run.overlaps).toBe(0);
    expect(run.strayRiders).toBe(0);
    expect(run.wrongStop).toBe(0);
    expect(run.farFromStop).toBe(0);
  });
});
