// Shared test fixtures: the example layouts and a small flat base layout that
// individual tests tweak into exactly one failure each.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const example = (name: string): Record<string, any> =>
  JSON.parse(readFileSync(resolve(import.meta.dirname, `../layouts/${name}.json`), "utf8"));

/** A flat 1000×800 board with one rectangular loop and a station. */
export function base(): Record<string, any> {
  return {
    version: 1,
    name: "Fixture",
    seed: 3,
    terrain: { size: [1000, 800], features: [], noise: { amplitude: 0.5, scale: 200 } },
    tracks: [{ id: "main", kind: "loop", minRadius: 60, points: [[200, 200], [800, 200], [800, 600], [200, 600]] }],
    stations: [{ id: "a", name: "A", track: "main", at: 250, length: 120 }],
    services: [{ id: "s", train: "regional-3", route: ["main"], mode: "loop", stops: ["a"] }],
    scenery: { scatterTrees: 0 },
  };
}

/** Base plus a branch line leaving the loop's bottom straight. */
export function withBranch(): Record<string, any> {
  const L = base();
  L.tracks.push({ id: "spur", kind: "line", minRadius: 60, from: { track: "main", at: 350 }, points: [[700, 110], [850, 50]] });
  return L;
}
