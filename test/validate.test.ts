// Validation: one failing fixture per issue code (§6), and both example layouts
// passing cleanly. Each fixture starts from a valid base layout and breaks one thing.

import { describe, it, expect } from "vitest";
import { validate } from "../src/model/build";
import { simulate } from "../src/sim/sim";
import { base, withBranch, example } from "./fixtures";

type Case = [code: string, severity: "error" | "warning", make: () => Record<string, any>];

const cases: Case[] = [
  ["SCHEMA", "error", () => { const L = base(); L.tracks[0].colour = "red"; return L; }],
  ["DUPLICATE_ID", "error", () => { const L = base(); L.stations[0].id = "main"; return L; }],
  ["UNKNOWN_REF", "error", () => { const L = base(); L.stations[0].track = "nowhere"; return L; }],
  ["TRACK_REF_CYCLE", "error", () => {
    const L = base();
    L.tracks.push(
      { id: "x", kind: "line", from: { track: "y", at: 50 }, points: [[400, 400]] },
      { id: "y", kind: "line", from: { track: "x", at: 50 }, points: [[500, 400]] },
    );
    return L;
  }],
  ["OUT_OF_BOUNDS", "error", () => { const L = base(); L.tracks[0].points[0] = [5, 200]; L.tracks[0].points[3] = [5, 600]; return L; }],
  ["FILLET_OVERLAP", "error", () => { const L = base(); L.tracks[0].minRadius = 400; return L; }],
  ["CORNER_TOO_SHARP", "error", () => {
    const L = base();
    L.tracks.push({ id: "hairpin", kind: "line", points: [[300, 350], [700, 350], [310, 352]] });
    return L;
  }],
  ["JUNCTION_UNREACHABLE", "error", () => { const L = withBranch(); L.tracks[1].points = [[630, 180], [850, 50]]; return L; }],
  ["JUNCTION_POSITION", "error", () => { const L = withBranch(); L.tracks[1].from.at = 520; return L; }],
  ["GRADE_EXCEEDED", "error", () => {
    const L = base();
    L.tracks[0].points = [{ at: [200, 200], z: 0 }, { at: [800, 200], z: 40 }, [800, 600], [200, 600]];
    return L;
  }],
  ["TRACK_CONFLICT", "error", () => {
    const L = base();
    L.tracks.push({ id: "inner", kind: "loop", minRadius: 60, points: [[202, 202], [798, 202], [798, 598], [202, 598]] });
    return L;
  }],
  ["STATION_RANGE", "error", () => {
    const L = withBranch();
    L.stations.push({ id: "b", name: "B", track: "spur", at: 5, length: 120 });
    return L;
  }],
  ["STATION_CURVE", "warning", () => { const L = base(); L.stations[0].at = 520; return L; }],
  ["STATION_STRUCTURE", "warning", () => {
    const L = base();
    L.terrain.features = [{ at: [510, 200], radius: 120, height: -18 }];
    L.tracks[0].points = L.tracks[0].points.map((p: [number, number]) => ({ at: p, z: 0 }));
    return L;
  }],
  ["ROUTE_DISCONNECTED", "error", () => {
    const L = base();
    L.tracks.push({ id: "other", kind: "loop", minRadius: 20, points: [[850, 650], [950, 650], [950, 760], [850, 760]] });
    L.services[0].route = ["main", "other"];
    return L;
  }],
  ["ROUTE_NOT_CLOSED", "error", () => {
    const L = withBranch();
    L.services.push({ id: "t", train: "tram-2", route: ["spur"], mode: "loop" });
    return L;
  }],
  ["STOP_NOT_ON_ROUTE", "error", () => {
    const L = withBranch();
    L.stations.push({ id: "b", name: "B", track: "spur", at: 120, length: 60 });
    L.services[0].stops = ["a", "b"];
    return L;
  }],
  ["TRAIN_TOO_LONG", "warning", () => { const L = base(); L.services[0].train = "express-6"; return L; }],
  ["CAPACITY", "warning", () => { const L = base(); L.services[0].count = 12; return L; }],
];

describe("validation codes", () => {
  it("accepts the base fixture", () => {
    expect(validate(base()).issues).toEqual([]);
    expect(validate(withBranch()).issues).toEqual([]);
  });

  it.each(cases)("%s (%s)", (code, severity, make) => {
    const report = validate(make());
    const hit = report.issues.find((i) => i.code === code);
    expect(hit, JSON.stringify(report.issues, null, 1)).toBeDefined();
    expect(hit!.severity).toBe(severity);
    expect(hit!.message.length).toBeGreaterThan(20);
    expect(hit!.path).toMatch(/^[a-z]/);
    if (severity === "error") expect(report.ok).toBe(false);
    else expect(report.ok).toBe(true);
  });

  it("DEADLOCK (error, from simulate)", () => {
    const L = base();
    L.tracks = [{ id: "line", kind: "line", points: [[150, 300], [850, 300]] }];
    L.stations = [
      { id: "w", name: "W", track: "line", at: 80, length: 100 },
      { id: "e", name: "E", track: "line", at: 620, length: 100 },
    ];
    L.services = [{ id: "s", train: "tram-2", route: ["line"], mode: "shuttle", stops: ["w", "e"], count: 2 }];
    expect(validate(L).ok).toBe(true);
    const res = simulate(L, 600);
    expect(res.deadlock?.code).toBe("DEADLOCK");
    expect(res.deadlock?.message).toMatch(/s-1.*s-2|s-2.*s-1/);
    expect(res.report.ok).toBe(false);
  });

  it("explains schema problems with JSON paths", () => {
    const L = base();
    delete L.tracks[0].kind;
    L.tracks[0].points[1] = { at: [800, 200], radius: -5 };
    const paths = validate(L).issues.map((i) => i.path);
    expect(paths).toContain("tracks[0].kind");
    expect(paths.some((p) => p.startsWith("tracks[0].points[1]"))).toBe(true);
  });
});

describe.each(["valley-loop", "harbour-town"])("example %s", (name) => {
  it("validates with no issues", () => {
    const report = validate(example(name));
    expect(report.issues).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.stats.triangles).toBeLessThan(600_000);
  });
});
