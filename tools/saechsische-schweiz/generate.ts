// Generator for layouts/saechsische-schweiz.json.
import { writeFileSync } from "node:fs";
import { terrain, waters } from "./terrain";
import { corridor, stageB, stageC, stageD, stageE, tram, trackLog } from "./tracks";
import { build, issues } from "./world";
import { Space } from "./place";
import { trails, trailBranches, trailBranches2 } from "./paths";
import { busStops, busLines, roadPlaces } from "./buses";
import { settlements, landmarks, carParks, trailFurniture, sceneryLog } from "./scenery";
import { nature, natureLog } from "./nature";
import { stations, services, stabled, offLayout, stationLog } from "./stations";
import { objects } from "./objects";
import { mainRoads, joiningRoads, climbingRoads, lateRoads, townRoads } from "./roads";

const OUT = process.argv[2] ?? new URL("../../layouts/saechsische-schweiz.json", import.meta.url).pathname;
const base = { version: 1, name: "Sächsische Schweiz", seed: 1835, terrain: terrain(), water: waters(), style: { season: "summer", timeOfDay: 11 } };

const tracks = corridor();
const wA = build({ ...base, tracks }, "A corridor");
tracks.push(...stageB(wA));
const wB = build({ ...base, tracks }, "B branches");
tracks.push(...stageC(wB));
const wC = build({ ...base, tracks }, "C ring and industrial");
tracks.push(...stageD(wC), tram());
const wD0 = build({ ...base, tracks }, "D loops and depot");
tracks.push(...stageE(wD0));
const wD = build({ ...base, tracks }, "D2 yard sidings");
const rail = { stations: stations(wD), services: services(), stabled: stabled(wD), offLayout: offLayout(), objects: objects() };
const roads = mainRoads();
const wE = build({ ...base, tracks, ...rail, roads }, "E main roads");
roads.push(...joiningRoads(wE));
const wF = build({ ...base, tracks, ...rail, roads }, "F joining roads");
roads.push(...climbingRoads(wF));
const wG = build({ ...base, tracks, ...rail, roads }, "G climbing roads");
roads.push(...lateRoads(wG));
const wH = build({ ...base, tracks, ...rail, roads }, "H late roads");
roads.push(...townRoads(wH));
const wI = build({ ...base, tracks, ...rail, roads }, "I town streets");
const paths = trails(wI);
const wK1 = build({ ...base, tracks, ...rail, roads, paths }, "K1 trails");
paths.push(...trailBranches(wK1));
const wK2 = build({ ...base, tracks, ...rail, roads, paths }, "K2 trail branches");
paths.push(...trailBranches2(wK2));
const wK = build({ ...base, tracks, ...rail, roads, paths }, "K3 more branches");
const space = new Space(wK);
const parking = carParks(space);
landmarks(space);
settlements(space);
trailFurniture(space);
const land = nature(space);
const terrainWithAreas = { ...base.terrain, areas: land.areas };
const bus = { busStops: busStops(wK), busLines: busLines() };
const offLayoutAll = [...rail.offLayout, ...roadPlaces()];
const freight = { vehicles: [{ name: "Delivery van", object: "van", count: 10, capacity: 6 }, { name: "Lorry", object: "truck", count: 8, capacity: 14 }] };
const layout = { ...base, terrain: terrainWithAreas, tracks, ...rail, offLayout: offLayoutAll, roads, paths, parking, ...bus, freight, people: { count: 1200, cars: 0.4 },
  scenery: [...space.entries, ...land.scenery] };
console.log(natureLog.join("\n"));
const wJ = build(layout, "J scenery");
console.log(sceneryLog.join("\n"));
console.log(`scenery: ${space.entries.length} entries, ${wJ.town.buildings.length} buildings`);
for (const i of issues(layout).filter((i) => i.code.startsWith("SCENERY") || i.code.startsWith("BUILDING"))) console.log(i.severity, i.code, i.path, i.message.slice(0, 120));
console.log(stationLog.join("\n"));
console.log(trackLog.join("\n"));
/** JSON with objects spread over lines but number lists and point lists kept on one line. */
function fmt(v: unknown, ind = ""): string {
  const flat = (x: unknown): boolean => typeof x !== "object" || x === null || (Array.isArray(x) && x.every((y) => typeof y !== "object" || y === null || (Array.isArray(y) && y.every((z) => typeof z !== "object"))));
  if (Array.isArray(v)) {
    if (v.every(flat) && v.every((x) => !Array.isArray(x) || x.every((y) => !Array.isArray(y)))) return JSON.stringify(v).replace(/,/g, ", ");
    const inner = ind + "  ";
    return `[\n${v.map((x) => inner + fmt(x, inner)).join(",\n")}\n${ind}]`;
  }
  if (v && typeof v === "object") {
    const inner = ind + "  ";
    const entries = Object.entries(v).filter(([, x]) => x !== undefined);
    if (!entries.length) return "{}";
    return `{\n${entries.map(([k, x]) => `${inner}${JSON.stringify(k)}: ${fmt(x, inner)}`).join(",\n")}\n${ind}}`;
  }
  return JSON.stringify(v);
}
writeFileSync(OUT, fmt(layout) + "\n");
console.log(`wrote ${OUT}`);
