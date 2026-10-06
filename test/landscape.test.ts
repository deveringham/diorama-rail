// Landscape and railway features: terrain features (mesas, levels, ramps), water,
// ground cover, scatter in polygons and rows, station groups, diamond crossings,
// stabled trains — and the Sächsische Schweiz layout that uses them all.

import { describe, it, expect } from "vitest";
import { validate, buildWorld } from "../src/model/build";
import { baseZ, groundZ } from "../src/model/terrain";
import { Sim } from "../src/sim/sim";
import { base, example, type Fixture } from "./fixtures";

const codes = (L: Fixture) => validate(L).issues.map((i) => `${i.severity} ${i.code}`);
const terrainOf = (L: Fixture) => buildWorld(L).world!.terrain;

describe("terrain features", () => {
  it("raises a mesa with a flat top and a cliff", () => {
    const L = base();
    L.terrain.features = [{ at: [500, 400], radius: 100, height: 40, shape: "mesa", plateau: 0.5, cliff: 0.8 }];
    const t = terrainOf(L);
    const top = baseZ(t, 500, 400);
    expect(top).toBeGreaterThan(38);
    expect(Math.abs(baseZ(t, 540, 400) - top)).toBeLessThan(1.5);        // flat out to half the radius
    expect(top - baseZ(t, 562, 400)).toBeGreaterThan(20);                  // the cliff falls most of the way at once
    expect(baseZ(t, 610, 400)).toBeLessThan(3);                            // nothing left beyond the foot
  });

  it("pulls the ground to a level, only down or only up", () => {
    const L = base();
    L.terrain.features = [
      { at: [300, 400], radius: 120, height: 30 },
      { area: [[250, 350], [350, 350], [350, 450], [250, 450]], radius: 30, level: 12, direction: "down" },
      { area: [[600, 350], [700, 350], [700, 450], [600, 450]], radius: 30, level: 12, direction: "down" },
    ];
    const t = terrainOf(L);
    expect(baseZ(t, 300, 400)).toBeCloseTo(12, 0);                         // the hill cut down to a terrace
    expect(baseZ(t, 650, 400)).toBeLessThan(2);                            // "down" never raises low ground
  });

  it("ramps along a line with levels on its points", () => {
    const L = base();
    L.terrain.features = [{ points: [[300, 400, 0], [700, 400, 40]], radius: 30, shape: "mesa", plateau: 0.6 }];
    const t = terrainOf(L);
    expect(baseZ(t, 300, 400)).toBeCloseTo(0, 0);
    expect(baseZ(t, 500, 400)).toBeCloseTo(20, 0);
    expect(baseZ(t, 700, 400)).toBeCloseTo(40, 0);
  });

  it("asks for exactly one place and one height", () => {
    const L = base();
    L.terrain.features = [{ at: [300, 300], points: [[1, 1], [2, 2]], radius: 10, height: 5 } as never, { at: [300, 300], radius: 10 } as never];
    expect(codes(L).filter((c) => c === "error SCHEMA").length).toBeGreaterThanOrEqual(2);
  });
});

describe("water", () => {
  const river = (L: Fixture) => {
    L.water = [{ id: "river", kind: "river", width: 30, points: [[0, 400], [400, 420], [1000, 400]] }];
    return L;
  };

  it("carves a river below its banks and finds it", () => {
    const { world, report } = buildWorld(river(base()));
    expect(report.issues.filter((i) => i.severity === "error")).toEqual([]);
    const hit = world!.water.at(400, 418);
    expect(hit).not.toBeNull();
    expect(groundZ(world!.terrain, 400, 418)).toBeLessThan(hit!.surface);
    expect(groundZ(world!.terrain, 400, 470)).toBeGreaterThan(hit!.surface);
  });

  it("lifts lines over water onto bridges, and reports one pinned too low", () => {
    const L = river(base());
    const { world, report } = buildWorld(L);
    expect(report.issues).toEqual([]);
    expect(world!.spans.get("main")!.filter((sp) => sp.kind === "bridge").length).toBe(2);   // both sides of the loop
    L.roads = [{ id: "ford", points: [[500, 300], { at: [500, 413], z: -2 }, [500, 520]], maxGrade: 0.25 }];
    expect(codes(L)).toContain("error WATER_CLEARANCE");
  });

  it("warns when a river climbs and when an object stands in the water", () => {
    const L = base();
    L.water = [{ id: "up", kind: "stream", points: [{ at: [300, 400], z: 2 }, { at: [700, 400], z: 6 }] }];
    expect(codes(L)).toContain("warning WATER_FLOW");
    const M = river(base());
    M.scenery = [{ object: "rock", at: [400, 418] }];
    expect(codes(M)).toContain("warning SCENERY_IN_WATER");
    M.scenery = [{ object: "rock", at: [400, 418], z: 1 }];
    expect(codes(M)).not.toContain("warning SCENERY_IN_WATER");
  });

  it("fills a lake to its level", () => {
    const L = base();
    L.water = [{ id: "lake", kind: "lake", level: 4, points: [[400, 330], [600, 330], [600, 470], [400, 470]] }];
    const { world } = buildWorld(L);
    expect(world!.water.at(500, 400)!.surface).toBe(4);
    expect(groundZ(world!.terrain, 500, 400)).toBeLessThan(4);
  });
});

describe("ground cover and scatter", () => {
  it("takes ground areas and rejects unknown covers", () => {
    const L = base();
    L.terrain.areas = [{ cover: "vineyard", points: [[300, 300], [500, 300], [500, 400]], rows: 0, rowWidth: 3 }];
    expect(validate(L).issues).toEqual([]);
    L.terrain.areas = [{ cover: "lava" as never, points: [[300, 300], [500, 300], [500, 400]] }];
    expect(codes(L)).toContain("error SCHEMA");
  });

  it("scatters inside a polygon and in rows", () => {
    const L = base();
    const area: Array<[number, number]> = [[300, 300], [700, 300], [700, 500], [300, 500]];
    L.scenery = [{ scatter: ["bush"], area, rows: { angle: 0, spacing: 10 }, spacing: 8 }];
    const { world } = buildWorld(L);
    const items = world!.scenery.filter((p) => p.object === "bush");
    expect(items.length).toBeGreaterThan(400);
    expect(items.every((p) => p.x >= 300 && p.x <= 700 && p.y >= 300 && p.y <= 500)).toBe(true);
    // In rows 10 m apart: the y values cluster on a handful of lines, each facing along the row.
    const lines = new Set(items.map((p) => Math.round(p.y / 10)));
    expect(lines.size).toBeLessThanOrEqual(22);
    expect(items.every((p) => Math.abs(Math.sin(p.rotation)) < 0.1)).toBe(true);
  });
});

describe("stations of several platforms", () => {
  /** A passing loop south of the main line's bottom straight, a platform on each, a path to one. */
  const twoPlatforms = (group: boolean): Fixture => {
    const L = base();
    L.tracks.push({ id: "pass", kind: "line", minRadius: 60, from: { track: "main", at: 120 }, points: [[420, 192.6], [640, 192.6]], to: { track: "main", at: 470 } });
    L.stations = [
      { id: "a", name: "A", track: "main", at: 280, length: 80, side: "left", building: null, ...(group ? { group: "g" } : {}) },
      { id: "b", name: "A", track: "pass", at: 175, length: 80, side: "right", building: null, ...(group ? { group: "g" } : {}) },
    ];
    L.services[0].stops = ["a"];
    L.paths = [{ id: "way", points: [[540, 320], [540, 260]], to: { station: "a" } }];
    return L;
  };
  const entrances = (L: Fixture, id: string) => buildWorld(L).world!.town.stations.find((s) => s.station === id)!.entrances.length;

  it("lets a group share its ways in", () => {
    expect(validate(twoPlatforms(true)).issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(entrances(twoPlatforms(false), "b")).toBe(0);
    expect(entrances(twoPlatforms(true), "b")).toBeGreaterThan(0);
  });
});

describe("diamond crossings", () => {
  it("lets tracks cross at grade at a real angle, but not glancingly", () => {
    const L = base();
    L.tracks.push({ id: "across", kind: "line", minRadius: 60, points: [[500, 20], [500, 780]] });
    const { world, report } = buildWorld(L);
    expect(report.issues.filter((i) => i.code === "TRACK_CONFLICT")).toEqual([]);
    expect(world!.diamonds.length).toBe(2);
    const M = base();
    M.tracks.push({ id: "glance", kind: "line", minRadius: 60, points: [[300, 160], [700, 240]] });
    expect(codes(M)).toContain("error TRACK_CONFLICT");
  });
});

describe("stabled trains", () => {
  const withSiding = (): Fixture => {
    const L = base();
    L.tracks.push({ id: "siding", kind: "line", minRadius: 60, from: { track: "main", at: 120 }, points: [[420, 192.6], [700, 192.6]] });
    return L;
  };

  it("stands trains on a siding", () => {
    const L = withSiding();
    L.stabled = [{ track: "siding", at: 180, train: "freight-coal", cars: 5, loco: false, load: "coal" }, { track: "siding", at: 240, train: "shunter" }];
    const r = validate(L);
    expect(r.issues).toEqual([]);
    expect(r.stats.stabled).toBe(2);
  });

  it("keeps them on their track, apart, and off the routes", () => {
    const L = withSiding();
    L.stabled = [{ track: "siding", at: 10, train: "freight-coal" }];
    expect(codes(L)).toContain("error STABLED_RANGE");
    L.stabled = [{ track: "siding", at: 180, train: "shunter" }, { track: "siding", at: 184, train: "shunter" }];
    expect(codes(L)).toContain("warning STABLED_OVERLAP");
    L.stabled = [{ track: "main", at: 900, train: "shunter" }];
    expect(codes(L)).toContain("error STABLED_ON_ROUTE");
  });
});

describe("example saechsische-schweiz", () => {
  const { world, report } = buildWorld(example("saechsische-schweiz"));

  it("validates with no issues", () => {
    expect(report.issues).toEqual([]);
    expect(report.stats.stabled).toBeGreaterThan(0);
    expect(report.stats.waters).toBeGreaterThan(10);
  });

  it("runs every service for ten minutes without deadlock", () => {
    const sim = new Sim(world!);
    for (let i = 0; i < 10 * 60 * 30; i++) sim.step();
    expect(sim.deadlock).toBeFalsy();
    const stopped = new Set(sim.trains.filter((t) => t.stops > 0).map((t) => t.plan.svc.id));
    const stopping = world!.layout.services.filter((s) => s.stops.some((id) => world!.layout.stations.some((st) => st.id === id)));
    for (const s of stopping) expect(stopped.has(s.id), s.id).toBe(true);
  });
});
