// Sidewalks, footpaths and people: the walk network (sidewalks, corners, crossings,
// zebras, foot crossings, piers), its validation codes, and pedestrian invariants
// over 30 simulated minutes — nobody on a crossing a car is on, nobody in a level or
// foot crossing's zone while a train is over it, nobody stuck.

import { describe, it, expect } from "vitest";
import { buildWorld, validate, type World } from "../src/model/build";
import { query } from "../src/api";
import { Sim, DT } from "../src/sim/sim";
import { locate } from "../src/model/routes";
import { KERB } from "../src/model/walks";
import { profileZ } from "../src/model/heights";
import { base, withWalks, example, type Fixture } from "./fixtures";

describe("walk network", () => {
  const { world, report } = buildWorld(withWalks());
  const net = world!.walks;
  const kinds = (k: string) => net.ways.filter((w) => w.kind === k);

  it("builds sidewalks, corners and crossings round the junctions", () => {
    expect(report.issues).toEqual([]);
    expect(kinds("sidewalk").every((w) => w.owner === "north-south" || w.owner === "cross")).toBe(true);
    expect(kinds("corner").length).toBe(4 + 1);                 // the crossroads, and the T's far side (the lane has none)
    // Unmarked crossings over every leg of the crossroads, and over the cross road either side of the T.
    expect(net.crossings.filter((c) => c.kind === "crossing").length).toBe(4 + 2);
  });

  it("raises sidewalks above the road and keeps them beside it", () => {
    const w = kinds("sidewalk").find((x) => x.owner === "cross")!;
    const i = Math.floor(w.x.length / 2);
    const road = world!.roads.roads.get("cross")!;
    const q = query(world!).roadAt(w.x[i], w.y[i], 10)!;
    expect(q.road).toBe("cross");
    expect(q.dist).toBeCloseTo(road.spec.width / 2 + road.spec.sidewalkWidth / 2, 1);
    expect(w.z[i]).toBeCloseTo(profileZ(world!.roads.profiles.get("cross")!, q.s) + KERB, 1);
  });

  it("puts zebras where a path crosses a road, and a foot crossing over the track", () => {
    const zebras = net.crossings.filter((c) => c.kind === "zebra");
    expect(zebras.map((c) => c.road).sort()).toEqual(["cross", "lane"]);
    expect(net.footCrossings.map((c) => [c.road, c.track])).toEqual([["track-walk", "main"]]);
    const way = net.ways.find((w) => w.owner === "track-walk")!;
    expect(way.gates.length).toBe(1);
    expect(way.gates[0].gate).toBe(world!.roads.crossings.length);    // foot crossings follow the road crossings
  });

  it("joins paths to sidewalks and to each other", () => {
    // The track walk starts on the cross road's south sidewalk.
    const start = net.nodes[net.ways.find((w) => w.owner === "track-walk")!.a];
    expect(start.ways.some((o) => net.ways[o.way].kind === "sidewalk")).toBe(true);
    // The spur meets the park path at a T.
    const spur = net.ways.find((w) => w.owner === "spur")!;
    expect(net.nodes[spur.a].ways.length).toBe(3);
  });

  it("gives level crossings gates for the people on the sidewalks", () => {
    const gated = kinds("sidewalk").filter((w) => w.gates.length);
    expect(gated.length).toBe(4);                               // both sides, at both level crossings
  });

  it("turns a path over the sea into a pier", () => {
    const L = base();
    L.terrain.features = [{ at: [500, 60], radius: 160, height: -12 }];
    L.terrain.seaLevel = -1;
    L.roads = [{ id: "front", points: [[300, 120], [700, 120]], sidewalks: "left" }];
    L.paths = [{ id: "pier", from: { road: "front", at: 200 }, points: [[500, 40]] }];
    const { world: w, report: r } = buildWorld(L);
    expect(r.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(w!.walks.spans.get("pier")!.some((s) => s.kind === "bridge")).toBe(true);
  });

  it("keeps scattered trees off walkways and lets lamp posts stand on sidewalks", () => {
    const L = withWalks();
    L.scenery = [{ scatter: ["conifer"], spacing: 12 }, { object: "lamp-post", at: [684, 300] }];
    const { world: w, report: r } = buildWorld(L);
    expect(r.issues.filter((i) => i.severity === "error")).toEqual([]);
    for (const p of w!.scenery.filter((s) => s.object === "conifer")) {
      w!.walks.hash.near(p.x, p.y, 4, (q) => expect(Math.hypot(q.x - p.x, q.y - p.y)).toBeGreaterThan(q.width / 2 + 1));
    }
  });
});

describe("walkway validation", () => {
  const cases: Array<[code: string, severity: "error" | "warning", path: string, make: () => Fixture]> = [
    ["SCENERY_ON_PATH", "error", "scenery[0].at", () => { const L = withWalks(); L.scenery = [{ object: "house", at: [450, 472] }]; return L; }],
    ["SCENERY_ON_PATH", "error", "scenery[0].at", () => { const L = withWalks(); L.scenery = [{ object: "bush", at: [685, 300] }]; return L; }],
    ["PATH_CONFLICT", "error", "paths[0]", () => { const L = base(); L.paths = [{ id: "p", points: [[300, 202], [420, 202]] }]; return L; }],
    ["PATH_CONFLICT", "error", "paths[3]", () => {
      const L = withWalks();
      L.paths!.push({ id: "along", points: [[330, 405], [400, 405]] });
      return L;
    }],
    ["PATH_CONFLICT", "error", "paths[3]", () => {
      const L = withWalks();
      L.paths!.push({ id: "near-junction", points: [[690, 330], [690, 470]] });   // crosses the cross road beside the crossroads
      return L;
    }],
    ["LEVEL_CROSSING_POSITION", "error", "paths[0]", () => { const L = base(); L.paths = [{ id: "p", points: [[510, 120], [510, 300]] }]; return L; }],
    ["LEVEL_CROSSING_POSITION", "error", "paths[0]", () => { const L = base(); L.paths = [{ id: "p", points: [[400, 120], [400, 204]] }]; return L; }],
    ["LEVEL_CROSSING_ANGLE", "warning", "paths[0]", () => { const L = base(); L.paths = [{ id: "p", points: [[590, 160], [740, 215]] }]; return L; }],
    ["LEVEL_CROSSING_ANGLE", "error", "paths[0]", () => { const L = base(); L.paths = [{ id: "p", points: [[560, 185], [760, 215]] }]; return L; }],
    ["UNKNOWN_REF", "error", "paths[2].from.path", () => { const L = withWalks(); L.paths![2].from = { path: "nowhere", at: 10 }; return L; }],
    ["UNKNOWN_REF", "error", "paths[1].from.road", () => { const L = withWalks(); L.paths![1].from = { road: "nowhere", at: 10 }; return L; }],
    ["DUPLICATE_ID", "error", "paths[0].id", () => { const L = withWalks(); L.paths![0].id = "cross"; return L; }],
    ["TRACK_REF_CYCLE", "error", "paths[3]", () => {
      const L = withWalks();
      L.paths!.push({ id: "x", from: { path: "y", at: 5 }, points: [[350, 700]] }, { id: "y", from: { path: "x", at: 5 }, points: [[450, 700]] });
      return L;
    }],
    ["JUNCTION_POSITION", "error", "paths[2].from.at", () => { const L = withWalks(); L.paths![2].from = { path: "park", at: 900 }; return L; }],
    ["GRADE_EXCEEDED", "error", "paths[0]", () => {
      const L = base();
      L.paths = [{ id: "p", points: [[300, 300], { at: [350, 300], z: 0 }, { at: [360, 300], z: 6 }, [450, 300]] }];
      return L;
    }],
    ["OUT_OF_BOUNDS", "error", "paths[0].points", () => { const L = base(); L.paths = [{ id: "p", points: [[1, 300], [100, 300]] }]; return L; }],
    ["SCHEMA", "error", "paths[2].from.road", () => { const L = withWalks(); L.paths![2].from = { path: "park", road: "cross", at: 10 }; return L; }],
  ];
  it.each(cases)("%s (%s) at %s", (code, severity, path, make) => {
    const report = validate(make());
    const hit = report.issues.find((i) => i.code === code && i.path === path);
    expect(hit, JSON.stringify(report.issues, null, 1)).toBeDefined();
    expect(hit!.severity).toBe(severity);
    expect(report.ok).toBe(severity === "warning");
  });
});

/** Whether any train's consist covers a level or foot crossing. */
function trainOver(world: World, sim: Sim, c: World["roads"]["crossings"][number]): boolean {
  const half = c.width / 2 / Math.sin((c.angle * Math.PI) / 180) + 1;
  return sim.trains.some((t) => {
    for (let d = 0; d <= t.plan.length; d += 1) {
      const at = locate(t.plan.route, world.tracks, t.r - t.dir * d);
      if (at.track === c.track && Math.abs(at.s - c.trackS) < half) return true;
    }
    return false;
  });
}

describe.each([
  ["walk fixture", () => withWalks()],
  ["valley-loop", () => example("valley-loop")],
  ["harbour-town", () => example("harbour-town")],
])("%s pedestrians", (_, make) => {
  const { world } = buildWorld(make());
  const sim = new Sim(world!);
  const gates = [...world!.roads.crossings, ...world!.walks.footCrossings];
  let carAndPerson = 0;
  let trainAndPerson = 0;
  let carsYielded = 0;
  for (let tick = 0; tick < (30 * 60) / DT; tick++) {
    sim.step();
    if (tick % 10) continue;
    world!.walks.crossings.forEach((c, i) => {
      if (sim.walkers.onCrossing(i) && sim.traffic.carOnRoadCrossing(i)) carAndPerson++;
      if (c.kind === "zebra" && sim.traffic.carWaitingAt(i) > 0) carsYielded++;
    });
    gates.forEach((c, g) => { if (sim.walkers.inGate(g) && trainOver(world!, sim, c)) trainAndPerson++; });
  }

  it("places everyone", () => expect(sim.walkers.people.length).toBe(world!.stats.pedestrians));

  it("never has a car on a crossing someone is on", () => expect(carAndPerson).toBe(0));

  it("never has anyone in a crossing's zone while a train is over it", () => expect(trainAndPerson).toBe(0));

  it("keeps people moving and crossing roads", () => {
    const st = sim.walkers.stats();
    expect(st.stuck).toBe(0);
    expect(st.maxWait).toBeLessThan(180);
    expect(st.avgSpeed).toBeGreaterThan(0.6);
    expect(st.crossed).toBeGreaterThan(20);
  });

  it("keeps the cars moving too", () => {
    const st = sim.traffic.stats();
    expect(st.stuck).toBe(0);
    if (world!.walks.crossings.some((c) => c.kind === "zebra")) expect(carsYielded).toBeGreaterThan(0);
  });

  it("is deterministic", () => {
    const a = new Sim(world!);
    const b = new Sim(world!);
    for (let i = 0; i < 1500; i++) { a.step(); b.step(); }
    expect(a.snapshot().walkers).toEqual(b.snapshot().walkers);
  });
});
