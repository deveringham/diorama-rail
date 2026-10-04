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

/**
 * Roads plus walkways: sidewalks on both main roads, a path crossing the side lane
 * and the cross road at zebras, one from the cross road's sidewalk over the track at
 * a foot crossing, and a spur joining the first at a T.
 */
export function withWalks(): Fixture {
  const L = withRoads();
  L.roads![0].sidewalks = "both";
  L.roads![1].sidewalks = "both";
  L.paths = [
    { id: "park", points: [[330, 470], [560, 470], [560, 330]] },
    { id: "track-walk", from: { road: "cross", at: 20 }, points: [[320, 330], [320, 120], [500, 120]] },
    { id: "spur", from: { path: "park", at: 120 }, points: [[450, 545]] },
  ];
  return L;
}

/**
 * Walkways plus a town: houses along the cross road, a shop and an inn on the main
 * road, an office block and a church, street parking, a car park south of the line,
 * and a path to the station.
 */
export function withTown(): Fixture {
  const L = withWalks();
  L.roads![0].parking = "both";
  L.roads![1].parking = "left";
  L.paths!.push({ id: "station-path", from: { path: "track-walk", at: 380 }, to: { station: "a" }, points: [[460, 160]] });
  L.parking = [{ id: "car-park", at: [725, 130], spaces: 12, rotation: 180 }];
  L.scenery = [
    ...[340, 356, 372, 388, 445, 461, 477, 493, 509].map((x) => ({ object: "house", at: [x, 413.5] as [number, number], rotation: 270 })),
    ...[340, 356, 372, 388, 445, 461, 477, 493].map((x) => ({ object: "house", at: [x, 387.5] as [number, number], rotation: 90 })),
    { object: "shop", at: [693.5, 300], rotation: 180, name: "Corner Shop" },
    { object: "pub", at: [695, 340], rotation: 180 },
    { object: "office", at: [662, 480], rotation: 0 },
    { object: "church", at: [650, 690], rotation: 0, name: "St. Peter's" },
  ];
  L.traffic = { cars: 6 };
  L.people = { cars: 0.4 };
  return L;
}

/**
 * The town plus a bus line: stops on both sides of the cross road among the houses, of
 * the main road by the shops and up by the church, served there and back by two buses.
 */
export function withBuses(): Fixture {
  const L = withTown();
  L.busStops = [
    { id: "houses", name: "The Houses", road: "cross", at: 200 },
    { id: "shops", road: "north-south", at: 270 },
    { id: "church-stop", name: "St. Peter's", road: "north-south", at: 640 },
  ];
  L.busLines = [{ id: "town-bus", name: "7", stops: ["houses", "shops", "church-stop"], count: 2 }];
  return L;
}

/**
 * The bus town with ways off the board: the main road runs on to the top edge, a
 * branch line off the loop to the east edge, and a footpath to the south edge, all
 * leading to The City — where a shuttle train and the bus line call, and some
 * residents work.
 */
export function withExits(): Fixture {
  const L = withBuses();
  L.roads![0].points = [[680, 60], [680, 800]];
  L.tracks.push({ id: "east-line", kind: "line", minRadius: 60, from: { track: "main", at: 644 }, points: [[900, 480], [1000, 480]] });
  L.services.push({ id: "x", train: "regional-3", route: ["main", "east-line"], mode: "shuttle", stops: ["a", "city"], count: 2 });
  L.paths!.push({ id: "hike", from: { path: "track-walk", at: "end" }, points: [[500, 40], [500, 0]] });
  L.offLayout = [{
    id: "city", name: "The City", jobs: 12, titles: ["Clerk"], visits: 2,
    via: [{ road: "north-south", distance: 2000 }, { track: "east-line", distance: 3000 }, { path: "hike", distance: 900 }],
  }];
  L.busLines![0].stops = ["houses", "shops", "church-stop", "city"];
  return L;
}
