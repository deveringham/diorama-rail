// Shared test fixtures: the example layouts and a small flat base layout that
// individual tests tweak into exactly one failure each.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { LayoutInput } from "../src/model/schema";

/** Layout input with the optional lists filled in, so tests can index them directly. */
export type Fixture = LayoutInput & Required<Pick<LayoutInput, "stations" | "services">>;

export const example = (name: string): Fixture =>
  JSON.parse(readFileSync(resolve(import.meta.dirname, `../layouts/${name}.json`), "utf8"));

/** A flat 1000×800 board with one rectangular loop and a station. */
export function base(): Fixture {
  return {
    version: 1,
    name: "Fixture",
    seed: 3,
    terrain: { size: [1000, 800], features: [], noise: { amplitude: 0.5, scale: 200 } },
    tracks: [{ id: "main", kind: "loop", minRadius: 60, points: [[200, 200], [800, 200], [800, 600], [200, 600]] }],
    stations: [{ id: "a", name: "A", track: "main", at: 250, length: 120 }],
    services: [{ id: "s", train: "regional-3", route: ["main"], mode: "loop", stops: ["a"] }],
  };
}

/** Base plus a branch line leaving the loop's bottom straight. */
export function withBranch(): Fixture {
  const L = base();
  L.tracks.push({ id: "spur", kind: "line", minRadius: 60, from: { track: "main", at: 350 }, points: [[700, 110], [850, 50]] });
  return L;
}

/**
 * Base plus roads: one crossing the loop's bottom and top straights at level
 * crossings, a cross street meeting it at a crossroads, and a lane joining that
 * street at a T-junction.
 */
export function withRoads(): Fixture {
  const L = base();
  L.roads = [
    { id: "north-south", points: [[680, 60], [680, 740]] },
    { id: "cross", points: [[300, 400], [740, 400]] },
    { id: "lane", from: { road: "cross", at: 120 }, points: [[420, 520]] },
  ];
  L.traffic = { cars: 16 };
  return L;
}
