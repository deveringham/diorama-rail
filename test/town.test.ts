// The town and its people: buildings with addresses and uses, parking bays, station
// entrances and the residents; journeys planned on foot, by car and by train; and
// simulated half hours in which cars only ever stand in free bays, drivers are in
// their own cars, passengers ride trains that call at their stop, and everyone
// gets about.

import { describe, it, expect } from "vitest";
import { buildWorld, validate } from "../src/model/build";
import { Sim, DT } from "../src/sim/sim";
import { describePerson, describeBuilding, describeVehicle, describeTrain } from "../src/sim/describe";
import { withTown, example, type Fixture } from "./fixtures";

describe("town model", () => {
  const { world, report } = buildWorld(withTown());
  const town = world!.town;
  const byName = (name: string) => town.buildings.find((b) => b.name === name)!;

  it("builds without errors or warnings", () => expect(report.issues).toEqual([]));

  it("names buildings by their street, odd numbers on the left and even on the right, unless the layout names them", () => {
    expect(byName("Corner Shop").kind).toBe("Shop");
    expect(byName("St. Peter's").kind).toBe("Church");
    expect(byName("A Station").station).toBe("a");
    const houses = town.buildings.filter((b) => b.kind === "House");
    expect(houses).toHaveLength(17);
    for (const h of houses) {
      const [n, street] = h.name.split(" ");
      expect(street).toBe("Cross");
      expect(Number(n) % 2).toBe(h.at[1] > 400 ? 1 : 0);      // north of the road is its left
    }
    expect(new Set(houses.map((h) => h.name)).size).toBe(17);
  });

  it("gives buildings the uses, homes and jobs of their objects", () => {
    expect(byName("Corner Shop").functions).toEqual(["workplace", "landmark"]);
    expect(byName("Corner Shop").jobs).toEqual(["Shopkeeper", "Shop assistant"]);
    const office = town.buildings.find((b) => b.kind === "Offices")!;
    expect(office.jobs).toHaveLength(16);
    expect(office.jobs.slice(0, 4)).toEqual(["Director", "Accountant", "Engineer", "Clerk"]);
    expect(office.jobs[15]).toBe("Clerk");                     // the last title fills the rest
    expect(town.buildings.filter((b) => b.kind === "House").every((b) => b.residents === 3)).toBe(true);
  });

  it("joins every building's door to a walkway", () => {
    for (const b of town.buildings) expect(b.access, b.name).not.toBeNull();
  });

  it("lays out bays along the parking strips and in the car park, clear of junctions and crossings", () => {
    const street = town.bays.filter((b) => !b.lot);
    expect(street.filter((b) => b.road === "north-south" && b.side > 0).length).toBeGreaterThan(10);
    expect(street.filter((b) => b.road === "north-south" && b.side < 0).length).toBeGreaterThan(10);
    expect(street.filter((b) => b.road === "cross" && b.side < 0)).toEqual([]);   // parking on its left only
    expect(town.bays.filter((b) => b.lot === "car-park")).toHaveLength(12);
    for (const b of street) {
      expect(Math.hypot(b.x - 680, b.y - 400), "crossroads").toBeGreaterThan(9);
      for (const c of world!.roads.crossings) expect(Math.hypot(b.x - c.at[0], b.y - c.at[1]), "level crossing").toBeGreaterThan(c.zone + 3);
    }
  });

  it("reaches the station by its path and through its building", () => {
    expect(town.stations[0].entrances.map((e) => e.via).sort()).toEqual(["building", "path"]);
  });

  it("houses everyone, gives jobs only at workplaces, and parks cars near home", () => {
    expect(town.people).toHaveLength(51);
    const posts = new Map<number, number>();
    for (const p of town.people) {
      expect(town.buildings[p.home].functions).toContain("accommodation");
      if (p.job) {
        const w = town.buildings[p.job.building];
        expect(w.jobs).toContain(p.job.title);
        posts.set(w.id, (posts.get(w.id) ?? 0) + 1);
      }
      if (p.car) {
        const bay = town.bays[p.car.bay];
        const door = town.buildings[p.home].door;
        expect(Math.hypot(bay.kerb[0] - door[0], bay.kerb[1] - door[1])).toBeLessThanOrEqual(150);
      }
    }
    for (const [w, n] of posts) expect(n).toBeLessThanOrEqual(town.buildings[w].jobs.length);
    const bays = town.people.filter((p) => p.car).map((p) => p.car!.bay);
    expect(new Set(bays).size).toBe(bays.length);
  });

  it("is the same every time", () => {
    const again = buildWorld(withTown()).world!.town;
    expect(again.people.map((p) => [p.name, p.home, p.job?.title, p.car?.bay])).toEqual(town.people.map((p) => [p.name, p.home, p.job?.title, p.car?.bay]));
  });

  it("lets the layout repurpose a placed building", () => {
    const L = withTown();
    Object.assign(L.scenery![0], { name: "Town Museum", building: { functions: ["landmark", "workplace"], kind: "Museum", jobs: 2, titles: ["Curator"] } });
    const b = buildWorld(L).world!.town.buildings.find((x) => x.name === "Town Museum")!;
    expect(b.kind).toBe("Museum");
    expect(b.residents).toBe(0);
    expect(b.jobs).toEqual(["Curator", "Curator"]);
  });
});

describe("town validation", () => {
  const cases: Array<[string, "error" | "warning", string, () => Fixture]> = [
    ["BUILDING_UNREACHABLE", "warning", "scenery[21]", () => { const L = withTown(); L.scenery!.push({ object: "house", at: [900, 760] }); return L; }],
    ["STATION_UNREACHABLE", "warning", "stations[0]", () => {
      const L = withTown();
      L.paths = L.paths!.filter((p) => p.id !== "station-path");
      L.stations[0].building = null;
      return L;
    }],
    ["PARKING_POSITION", "error", "parking[0].at", () => { const L = withTown(); L.parking = [{ id: "lot", at: [688, 300] }]; return L; }],
    ["PARKING_POSITION", "error", "parking[0].at", () => { const L = withTown(); L.parking = [{ id: "lot", at: [120, 760] }]; return L; }],
    ["PARKING_POSITION", "error", "parking[0].at", () => { const L = withTown(); L.parking = [{ id: "lot", at: [215, 400], spaces: 30, rotation: 0 }]; return L; }],
    ["CAPACITY", "warning", "people.count", () => { const L = withTown(); L.people = { count: 500 }; return L; }],
    ["UNKNOWN_REF", "error", "parking[0].road", () => { const L = withTown(); L.parking![0].road = "nowhere"; return L; }],
    ["UNKNOWN_REF", "error", "paths[3].to.station", () => { const L = withTown(); L.paths![3].to = { station: "nowhere" }; return L; }],
    ["UNKNOWN_REF", "error", "people.vehicles[0]", () => { const L = withTown(); L.people = { vehicles: ["hovercraft"] }; return L; }],
    ["SCHEMA", "error", "paths[3].to.at", () => { const L = withTown(); L.paths![3].to = { station: "a", at: 5 }; return L; }],
    ["SCHEMA", "error", "scenery[0].building.functions[0]", () => { const L = withTown(); (L.scenery![0] as Record<string, unknown>).building = { functions: ["shop"] }; return L; }],
    ["DUPLICATE_ID", "error", "parking[0].id", () => { const L = withTown(); L.parking![0].id = "cross"; return L; }],
  ];
  it.each(cases)("%s (%s) at %s", (code, severity, path, make) => {
    const issues = validate(make()).issues;
    expect(issues.some((i) => i.code === code && i.severity === severity && i.path === path), JSON.stringify(issues.slice(0, 4))).toBe(true);
  });
});

describe("journeys", () => {
  const { world } = buildWorld(withTown());
  const sim = new Sim(world!);
  const town = world!.town;
  const house = (name: string) => town.buildings.find((b) => b.name === name)!.id;

  it("walks next door", () => {
    const p = town.people[0];
    const r = sim.people.planner.plan(p, { kind: "building", id: house("1 Cross") }, { kind: "building", id: house("3 Cross") }, -1, -1)!;
    expect(r.legs.map((l) => l.mode)).toEqual(["walk"]);
  });

  it("drives when walking is a bother, along lanes that follow on from each other", () => {
    const owner = town.people.find((p) => p.car)!;
    const lazy = { ...owner, prefs: { walk: 4, drive: 0.8, train: 1, bus: 1 } };
    const car = sim.traffic.carOf[owner.id];
    const church = town.buildings.find((b) => b.kind === "Church")!.id;
    const r = sim.people.planner.plan(lazy, { kind: "building", id: owner.home }, { kind: "building", id: church }, owner.car!.bay, car)!;
    const drive = r.legs.find((l) => l.mode === "drive");
    expect(drive?.mode).toBe("drive");
    if (drive?.mode !== "drive") return;
    expect(drive.from).toBe(owner.car!.bay);
    expect(sim.traffic.bayAt[drive.from]!.lane).toBe(drive.lanes[0]);
    expect(sim.traffic.bayAt[drive.to]!.lane).toBe(drive.lanes[drive.lanes.length - 1]);
    for (let k = 1; k < drive.lanes.length; k++) expect(sim.traffic.nextLanes(drive.lanes[k - 1])).toContain(drive.lanes[k]);
  });

  it("takes the train between towns", () => {
    const { world: h } = buildWorld(example("harbour-town"));
    const hs = new Sim(h!);
    const t = h!.town;
    const west = t.people.find((p) => !p.car && t.buildings[p.home].at[0] < 400)!;
    const east = t.buildings.find((b) => b.at[0] > 1300 && b.functions.includes("landmark"))!;
    const r = hs.people.planner.plan(west, { kind: "building", id: west.home }, { kind: "building", id: east.id }, -1, -1)!;
    expect(r.legs.map((l) => l.mode)).toContain("train");
  });
});

describe.each([
  ["town fixture", () => withTown()],
  ["harbour-town", () => example("harbour-town")],
])("%s half hour", (_, make) => {
  const { world } = buildWorld(make());
  const sim = new Sim(world!);
  let bayClash = 0;
  let wrongDriver = 0;
  let wrongTrain = 0;
  for (let tick = 0; tick < (30 * 60) / DT; tick++) {
    sim.step();
    if (tick % 30) continue;
    const inBay = new Map<number, number>();
    for (const c of sim.traffic.cars) {
      if (c.owner < 0) continue;
      if (c.state === "parked" || c.state === "leaving") {
        inBay.set(c.bay, (inBay.get(c.bay) ?? 0) + 1);
        if (sim.traffic.bayCar[c.bay] !== c.index) bayClash++;
      }
      const driver = sim.people.bodies[c.owner];
      const moving = c.state === "driving" || c.state === "leaving" || c.state === "entering";
      if (moving !== (driver.mode === "drive")) wrongDriver++;
    }
    for (const n of inBay.values()) if (n > 1) bayClash++;
    sim.people.riders.forEach((list, ti) => {
      const route = sim.trains[ti].plan.route;
      const stops = route.stops.map((s) => s.station);
      // Its destination is a station the train calls at, or an off-layout place it calls at off the board.
      const calls = (to: number) => (to >= 0 ? stops.includes(world!.town.stations[to].station) : route.off.some((o) => o?.calls.some((c) => c.place === -1 - to)));
      for (const id of list) {
        const leg = sim.people.bodies[id].route?.legs[sim.people.bodies[id].leg];
        if (leg?.mode !== "train" || !calls(leg.to)) wrongTrain++;
      }
    });
  }
  const st = sim.people.stats();

  it("only ever has one car in a bay, the one it was meant for", () => expect(bayClash).toBe(0));
  it("has every car that is not parked driven by its owner", () => expect(wrongDriver).toBe(0));
  it("has passengers only on trains that call where they are going", () => expect(wrongTrain).toBe(0));

  it("gets everyone about", () => {
    expect(st.stuck).toBe(0);
    expect(st.tasks).toBeGreaterThan(st.people);
    expect(sim.traffic.stats().stuck).toBe(0);
  });

  it("uses cars (and trains, between stations) as well as walking", () => {
    const modes = Object.keys(st.trips).join(" | ");
    expect(modes).toContain("drive");
    if (world!.layout.stations.length > 1) expect(modes).toContain("train");
  });

  it("describes what it sees", () => {
    const busy = sim.people.bodies.findIndex((b) => b.mode !== "inside");
    expect(describePerson(sim, Math.max(0, busy)).lines.length).toBeGreaterThan(3);
    expect(describeBuilding(sim, 0).title).toBe(world!.town.buildings[0].name);
    expect(describeVehicle(sim, 0).title.length).toBeGreaterThan(0);
    expect(describeTrain(sim, 0).lists[0].title).toMatch(/^Passengers/);
  });
});
