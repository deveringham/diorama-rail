// Off the board: tracks, roads and paths that end on the board's edge lead off it;
// off-layout places beyond are stops for trains and buses and destinations for
// errands. Trains, buses, cars and people go out over the edge, out of sight, and
// come back — and while they are away they are still kept track of.

import { describe, it, expect } from "vitest";
import { buildWorld, validate } from "../src/model/build";
import { Sim, DT } from "../src/sim/sim";
import { onBoard } from "../src/sim/trains";
import { describePerson, describeTrain } from "../src/sim/describe";
import { base, withExits, example, type Fixture } from "./fixtures";

const codes = (L: Fixture, code: string) => validate(L).issues.filter((i) => i.code === code);

describe("exits and off-layout places", () => {
  const { world, report } = buildWorld(withExits());
  const off = world!.offLayout;

  it("builds without errors or warnings", () => expect(report.issues).toEqual([]));

  it("finds where tracks, roads and paths leave the board", () => {
    expect(off.exits.map((e) => `${e.kind} ${e.line} ${e.end}`).sort()).toEqual(["path hike 1", "road north-south 1", "track east-line 1"]);
    for (const e of off.exits) {
      const [x, y] = e.at;
      expect(Math.min(x, y, 1000 - x, 800 - y)).toBeLessThan(1);
    }
    // The road's sidewalks and the path end at the edge, where people walk off the board.
    const walkExits = world!.walks.nodes.filter((n) => n.exit >= 0).map((n) => off.exits[n.exit].line).sort();
    expect(walkExits).toEqual(["hike", "north-south", "north-south"]);
  });

  it("resolves each place's ways out to exits", () => {
    const [city] = off.places;
    expect(city.name).toBe("The City");
    expect(city.via.map((v) => off.exits[v.exit].kind).sort()).toEqual(["path", "road", "track"]);
    expect(city.jobs).toHaveLength(12);
    expect(world!.town.people.filter((p) => p.job?.off === 0).length).toBeGreaterThan(0);
  });

  it("runs a shuttle off its end and back, calling out there", () => {
    const route = world!.routes.get("x")!;
    expect(route.off[0]).toBeNull();
    expect(route.off[1]!.calls).toEqual([{ place: 0, at: 3000 }]);
    expect(route.off[1]!.reenter).toBe(1);
  });

  it("lets a loop run through the board between two exits", () => {
    const L = base();
    L.tracks.push({ id: "cross-line", kind: "line", minRadius: 60, points: [[0, 720], [1000, 720]] });
    L.stations.push({ id: "mid", name: "Mid", track: "cross-line", at: 500, length: 100 });
    L.offLayout = [
      { id: "west-town", via: [{ track: "cross-line", end: "start", distance: 2000 }] },
      { id: "east-town", via: [{ track: "cross-line", end: "end", distance: 1500 }] },
    ];
    L.services.push({ id: "thru", train: "tram-2", route: ["cross-line"], mode: "loop", stops: ["mid", "west-town", "east-town"], count: 2 });
    const { world: w, report: r } = buildWorld(L);
    expect(r.issues).toEqual([]);
    const route = w!.routes.get("thru")!;
    expect(route.through).toBe(true);
    // Out at the east end: east town first, then on round to the west town and back on in the west.
    expect(route.off[1]!.calls.map((c) => c.place)).toEqual([1, 0]);
    expect(route.off[1]!.reenter).toBe(0);
    const sim = new Sim(w!);
    for (let i = 0; i < (10 * 60) / DT; i++) sim.step();
    const calls = sim.events.filter((e) => e.type === "arrived" && e.service === "thru").map((e) => (e as { station: string }).station);
    expect(calls).toEqual(expect.arrayContaining(["mid", "west-town", "east-town"]));
    expect(sim.deadlock).toBeNull();
  });

  it("reports lines near but not on the edge, oblique exits and bad references", () => {
    const L = base();
    L.paths = [{ id: "p", points: [[2, 300], [100, 300]] }];
    expect(codes(L, "OUT_OF_BOUNDS")[0].path).toBe("paths[0].points");
    const M = base();
    M.paths = [{ id: "p", points: [[100, 300], [0, 420]] }];
    expect(codes(M, "EXIT_POSITION")[0].message).toMatch(/meets it at only 40°/);
    const N = withExits();
    N.offLayout![0].via.push({ road: "cross", distance: 100 });
    expect(codes(N, "EXIT_REF")[0].message).toMatch(/road 'cross', which does not leave the board/);
    const O = withExits();
    O.offLayout![0].via.push({ track: "nowhere" });
    expect(codes(O, "UNKNOWN_REF")[0].path).toBe("offLayout[0].via[3].track");
    const P = withExits();
    P.services[0].stops!.push("city");                     // the loop never leaves the board
    expect(codes(P, "STOP_NOT_ON_ROUTE")[0].message).toMatch(/off the board but the route does not leave the board/);
    const Q = withExits();
    Q.offLayout!.push({ id: "town-by-rail", via: [{ track: "east-line", distance: 500 }] });
    Q.busLines![0].stops.push("town-by-rail");
    expect(codes(Q, "BUS_ROUTE")[0].message).toMatch(/no road leads off the board to it/);
  });
});

describe("going off the board and coming back", () => {
  const { world } = buildWorld(withExits());
  const sim = new Sim(world!);
  const off = world!.offLayout;
  const line = sim.traffic.lines[0];
  const cityVisit = line.geom.visits.findIndex((v) => v.side === -1);
  let heldOffBoard = 0;
  let visibleOffBoard = 0;
  let busCalls = 0;
  let maxAway = 0;
  let seenCarOff = false;
  let seenTransit = false;
  const left = new Set<string>();
  const back = new Set<string>();
  const owner = (sim as unknown as { state: { owner: Int32Array } }).state.owner;
  let wasOff = sim.trains.map((t) => t.off >= 0);
  for (let tick = 0; tick < (40 * 60) / DT; tick++) {
    sim.step();
    sim.trains.forEach((t, k) => {
      if ((t.off >= 0) !== wasOff[k]) (t.off >= 0 ? left : back).add(t.id);
    });
    wasOff = sim.trains.map((t) => t.off >= 0);
    if (tick % 15) continue;
    for (let b = 0; b < owner.length; b++) if (owner[b] >= 0 && sim.trains[owner[b]].off >= 0) heldOffBoard++;
    const snap = sim.snapshot();
    // A train off the board shows none of its cars.
    snap.trains.forEach((tr, k) => { if (sim.trains[k].off >= 0) visibleOffBoard += tr.cars.filter((c) => c.visible).length; });
    for (const ci of line.buses) if (sim.traffic.busVisit(ci) === cityVisit && sim.traffic.cars[ci].hidden) busCalls++;
    const st = sim.people.stats();
    maxAway = Math.max(maxAway, st.away);
    if (sim.traffic.cars.some((c) => c.state === "off")) seenCarOff = true;
    if (sim.people.bodies.some((b) => b.mode === "transit")) seenTransit = true;
  }

  it("takes trains off the board and brings them back, holding no blocks while away", () => {
    expect([...left].sort()).toEqual(["x-1", "x-2"]);
    expect([...back].sort()).toEqual(["x-1", "x-2"]);
    expect(heldOffBoard).toBe(0);
    expect(visibleOffBoard).toBe(0);
    const calls = sim.events.filter((e) => e.type === "arrived" && e.service === "x").map((e) => (e as { station: string }).station);
    expect(calls.filter((c) => c === "city").length).toBeGreaterThan(2);
    expect(sim.deadlock).toBeNull();
  });

  it("hides a train's cars beyond the edge and shows them on the board", () => {
    const t = sim.trains.find((x) => x.plan.svc.id === "x")!;
    const L = t.plan.route.length;
    expect(onBoard(t, L + 5)).toBe(false);
    expect(onBoard(t, L - 5)).toBe(t.off < 0);
  });

  it("has buses call at the off-layout place out of sight", () => expect(busCalls).toBeGreaterThan(0));

  it("sends people off the board and brings them back", () => {
    const trips = sim.people.stats().trips;
    expect(maxAway).toBeGreaterThan(2);
    // Journeys ending off the board (no walk at the end) and starting there (none at the start).
    expect(Object.keys(trips).some((k) => !k.endsWith("walk"))).toBe(true);
    expect(Object.keys(trips).some((k) => !k.startsWith("walk"))).toBe(true);
    expect(sim.people.stats().stuck).toBe(0);
    expect(seenCarOff || seenTransit || maxAway > 0).toBe(true);
  });

  it("says where people and trains are when off the board", () => {
    const away = sim.people.bodies.find((b) => b.mode === "away");
    if (away) expect(describePerson(sim, away.id).lines.find((l) => l.label === "Now")!.text).toMatch(/The City \(off the board\)/);
    const commuter = world!.town.people.find((p) => p.job?.off === 0)!;
    expect(describePerson(sim, commuter.id).lines.find((l) => l.label === "Job")!.text).toBe("Clerk in The City (off the board)");
    const t = sim.trains.findIndex((x) => x.off >= 0);
    if (t >= 0) expect(describeTrain(sim, t).subtitle).toMatch(/off the board/);
    expect(off.places[0].name).toBe("The City");
  });

  it("is deterministic", () => {
    const a = new Sim(world!);
    const b = new Sim(world!);
    for (let i = 0; i < 4000; i++) { a.step(); b.step(); }
    expect(a.snapshot().trains).toEqual(b.snapshot().trains);
    expect(a.people.stats()).toEqual(b.people.stats());
  });
});

describe.each(["valley-loop", "harbour-town"])("%s off the board", (name) => {
  const { world, report } = buildWorld(example(name));

  it("leads off the board to its off-layout places without issues", () => {
    expect(report.issues).toEqual([]);
    expect(world!.offLayout.places.length).toBeGreaterThan(0);
    for (const p of world!.offLayout.places) expect(p.via.length).toBeGreaterThan(0);
  });

  it("has people go out there and come back", () => {
    const sim = new Sim(world!);
    let maxAway = 0;
    for (let i = 0; i < (20 * 60) / DT; i++) {
      sim.step();
      if (i % 60 === 0) maxAway = Math.max(maxAway, sim.people.stats().away);
    }
    expect(maxAway).toBeGreaterThan(2);
    expect(sim.people.stats().stuck).toBe(0);
    expect(sim.deadlock).toBeNull();
  });
});
