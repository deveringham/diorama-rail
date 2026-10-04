// Freight: buildings and off-layout places send out and need goods; delivery vans
// and lorries carry them by road, stopping at each building's dock, and freight
// trains carry them between goods yards and off-layout places, where lorries pick
// them up and drop them off.

import { describe, it, expect } from "vitest";
import { buildWorld, validate } from "../src/model/build";
import { Sim, DT } from "../src/sim/sim";
import { describeVehicle, describeTrain, describeYard, describeBuilding } from "../src/sim/describe";
import { DOCK_OFFSET, DOCK_WIDTH, PLATFORM_TOP } from "../src/model/scenery";
import { profileZ } from "../src/model/heights";
import { withTown, withFreight, example, type Fixture } from "./fixtures";

const codes = (L: Fixture, code: string) => validate(L).issues.filter((i) => i.code === code);

describe("goods yards, sites and the fleet", () => {
  const { world, report } = buildWorld(withFreight());
  const net = world!.freight;

  it("builds without errors or warnings", () => expect(report.issues).toEqual([]));

  it("makes a goods yard with a dock along a road and its shed on the dock", () => {
    expect(net.yards).toHaveLength(1);
    const y = net.yards[0];
    expect(y.dock?.road).toBe("depot-road");
    const shed = world!.town.buildings[y.building];
    expect(shed.object).toBe("goods-shed");
    expect(shed.name).toBe("Depot");
    const dockTop = profileZ(world!.profiles.get("goods-spur")!, y.at) + PLATFORM_TOP;
    expect(shed.at[2]).toBeCloseTo(dockTop, 3);
    // The lorry stops beside the dock's back edge, on the road side.
    const target = y.dock!.target;
    expect(Math.hypot(y.dock!.kerb[0] - target[0], y.dock!.kerb[1] - target[1])).toBeLessThan(15);
    // Nobody boards there: no passenger access, and the planner ignores it.
    expect(world!.town.stations.map((s) => s.station)).toEqual(["a"]);
    expect(DOCK_OFFSET + DOCK_WIDTH / 2).toBeGreaterThan(8);
  });

  it("knows who sends and needs what, and where lorries stop for them", () => {
    const farm = net.sites.find((s) => s.name === "Hill Farm")!;
    expect(farm.supplies).toEqual([{ goods: "food", rate: 10 }]);
    expect(farm.dock?.road).toBe("north-south");
    const port = net.sites.find((s) => s.kind === "off")!;
    expect(port.stop).toBe("port");
    expect(port.demands).toEqual([{ goods: "food", rate: 10 }]);
    const homes = net.sites.filter((s) => s.kind === "building" && world!.town.buildings[s.ref].kind === "House");
    expect(homes.length).toBe(17);
    expect(homes.every((s) => s.dock && s.demands[0].goods === "mail")).toBe(true);
    expect(net.goods).toEqual(["drinks", "food", "goods", "mail"]);
    expect(net.services).toEqual(["goods"]);
  });

  it("takes its fleet from the layout, or makes one when there is something to move", () => {
    expect(net.fleet.map((f) => [f.name, f.object, f.count, f.capacity])).toEqual([["Van", "van", 2, 6], ["Lorry", "truck", 1, 12]]);
    // The plain town has shops and houses that need goods but nothing that sends any: no fleet.
    expect(buildWorld(withTown()).world!.freight.fleet).toEqual([]);
    const L = withTown();
    L.scenery!.push({ object: "barn", at: [655, 250], rotation: 0 });
    const auto = buildWorld(L).world!.freight.fleet;
    expect(auto.map((f) => f.object)).toEqual(["van", "truck"]);
  });

  it("turns a freight shuttle at its yard when its line leaves the board", () => {
    const route = world!.routes.get("goods")!;
    expect(route.stops).toEqual([{ station: "depot", r: expect.any(Number) }]);
    expect(route.stops[0].r).toBeCloseTo(37, 0);                // the train centred on the dock at r = 0
    expect(route.off[1]!.calls).toEqual([{ place: 0, at: 1500 }]);
  });

  it("reports yards and freight that cannot work", () => {
    const L = withFreight();
    L.paths!.push({ id: "to-yard", from: { road: "cross", at: 60 }, to: { station: "depot" }, points: [[150, 330]] });
    expect(codes(L, "STATION_KIND")[0].message).toMatch(/freight yard, which has no platform for people/);
    const M = withFreight();
    M.services[0].stops!.push("depot");
    expect(codes(M, "STOP_KIND")[0].message).toMatch(/passenger service 's' stops at freight yard 'depot'/);
    const N = withFreight();
    N.stations[1].side = "both";
    expect(codes(N, "SCHEMA")[0].message).toMatch(/a freight yard has one dock/);
    const O = withFreight();
    O.stations[1].road = "nowhere";
    expect(codes(O, "UNKNOWN_REF")[0].path).toBe("stations[1].road");
    const P = withFreight();
    P.stations[1].road = "lane";
    expect(codes(P, "YARD_ROAD")[0].message).toMatch(/road 'lane' has no room for a lorry to stop beside its dock/);
    const Q = withFreight();
    Q.offLayout![0].supplies = { goods: 30, mail: 40 };
    expect(codes(Q, "FREIGHT_UNMATCHED")[0].message).toMatch(/drinks \('drinks'\) is needed by '2 North South' but nothing sends it/);
    const R = withFreight();
    R.scenery!.push({ object: "factory", at: [480, 300], rotation: 0, name: "Works" });
    expect(codes(R, "FREIGHT_UNREACHABLE")[0].message).toMatch(/factory 'Works' has no road within 40 m of its door/);
    const S = withFreight();
    S.freight!.vehicles![0].object = "hovercraft";
    expect(codes(S, "UNKNOWN_REF")[0].path).toBe("freight.vehicles[0].object");
  });
});

describe("goods on the move", () => {
  const { world } = buildWorld(withFreight());
  const sim = new Sim(world!);
  const yardSite = world!.freight.yardSite[0];
  let maxOnTrain = 0;
  let maxAtYard = 0;
  let wagonLoads = 0;
  let crateMismatch = 0;
  let dockMiss = 0;
  let overlaps = 0;
  let trainAtYardWithGoods = false;
  for (let i = 0; i < (35 * 60) / DT; i++) {
    sim.step();
    if (i % 30) continue;
    const st = sim.freight.stats();
    maxOnTrain = Math.max(maxOnTrain, st.onTrains);
    const snap = sim.snapshot();
    const atYard = snap.freight.yards[0].reduce((a, b) => a + b, 0);
    maxAtYard = Math.max(maxAtYard, atYard);
    if (atYard !== sim.freight.at(yardSite).reduce((a, c) => a + c.amount, 0)) crateMismatch++;
    wagonLoads = Math.max(wagonLoads, ...snap.freight.trains.map((t) => t.reduce((a, b) => a + b, 0)));
    // A vehicle standing at a building's dock is beside it.
    for (const [ci, job] of sim.freight.jobs) {
      const car = sim.traffic.cars[ci];
      const dock = sim.freight.sites[job.stops[job.at].site].dock;
      if (!car.dwelling || car.hidden || !dock) continue;
      const [x, y] = sim.traffic.carAt(ci);
      if (Math.hypot(x - dock.kerb[0], y - dock.kerb[1]) > 8) dockMiss++;
    }
    const t = sim.trains.find((x) => x.plan.svc.id === "goods")!;
    if (t.atStation === "depot" && sim.freight.onTrain(sim.trains.indexOf(t)).length) trainAtYardWithGoods = true;
    if (i % 300 === 0) overlaps += sim.traffic.overlapping();
  }
  const stats = sim.freight.stats();

  it("delivers by road and by freight train, losing nothing", () => {
    // The port is reached only by rail: its goods, mail and drinks come by train and lorry, the farm's food by lorry alone.
    expect(stats.orders).toBeGreaterThan(8);
    expect(stats.byRoad).toBeGreaterThan(0);
    expect(stats.byRail).toBeGreaterThan(3);
    expect(stats.lost).toBe(0);
    expect(stats.unserved).toBe(0);
  });

  it("loads freight trains at the yard and the port and unloads them there", () => {
    expect(maxOnTrain).toBeGreaterThan(0);
    expect(wagonLoads).toBeGreaterThan(0);
    expect(maxAtYard).toBeGreaterThan(0);
    expect(trainAtYardWithGoods).toBe(true);
    const calls = sim.events.filter((e) => e.type === "arrived" && e.service === "goods").map((e) => (e as { station: string }).station);
    expect(calls).toEqual(expect.arrayContaining(["depot", "port"]));
  });

  it("stops delivery vehicles at the docks without getting in anyone's way for good", () => {
    expect(sim.traffic.stats().fleetStops).toBeGreaterThan(10);
    expect(dockMiss).toBe(0);
    expect(overlaps).toBe(0);
    expect(sim.traffic.stats().stuck).toBe(0);
    expect(sim.people.stats().stuck).toBe(0);
    expect(sim.deadlock).toBeNull();
    expect(sim.traffic.cars.filter((c) => c.fleet >= 0).every((c) => c.skipped === 0)).toBe(true);
  });

  it("shows the crates waiting at the yard", () => expect(crateMismatch).toBe(0));

  it("says what the vehicles, trains, yard and buildings are doing", () => {
    const van = sim.traffic.cars.find((c) => c.fleet === 0)!;
    const info = describeVehicle(sim, van.index);
    expect(info.title).toBe("Van");
    expect(info.lines[0]).toEqual({ label: "Carries", text: "up to 6 loads" });
    const train = describeTrain(sim, sim.trains.findIndex((t) => t.plan.svc.id === "goods"));
    expect(train.lists[0].title).toMatch(/^Goods \(\d+ of 32 loads\)$/);
    const yard = describeYard(sim, 0);
    expect(yard.title).toBe("Depot");
    expect(yard.lines.find((l) => l.label === "Freight trains")!.text).toBe("goods");
    const farm = world!.town.buildings.find((b) => b.name === "Hill Farm")!;
    expect(describeBuilding(sim, farm.id).lines.find((l) => l.label === "Sends out")!.text).toMatch(/^food 10 loads an hour \(ready now: \d+ food\)$/);
  });

  it("is deterministic", () => {
    const a = new Sim(world!);
    const b = new Sim(world!);
    for (let i = 0; i < 6000; i++) { a.step(); b.step(); }
    expect(a.freight.stats()).toEqual(b.freight.stats());
    expect(a.snapshot().freight).toEqual(b.snapshot().freight);
  });
});

describe.each(["valley-loop", "harbour-town"])("%s freight", (name) => {
  const { world, report } = buildWorld(example(name));

  it("has a goods yard served by a freight train and a road", () => {
    expect(report.issues).toEqual([]);
    expect(world!.freight.yards.length).toBe(1);
    expect(world!.freight.yards[0].dock).not.toBeNull();
    expect(world!.freight.services.length).toBeGreaterThan(0);
  });

  it("moves goods by road and puts some on the freight train", () => {
    const sim = new Sim(world!);
    let onTrain = 0;
    for (let i = 0; i < (30 * 60) / DT; i++) {
      sim.step();
      if (i % 60 === 0) onTrain = Math.max(onTrain, sim.freight.stats().onTrains);
    }
    const st = sim.freight.stats();
    expect(st.delivered).toBeGreaterThan(15);
    expect(st.lost).toBe(0);
    expect(onTrain + st.byRail).toBeGreaterThan(0);
    expect(sim.deadlock).toBeNull();
    expect(sim.traffic.stats().stuck).toBe(0);
  });
});
