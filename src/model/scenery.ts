// Deterministic scenery placement (§5.7): station props, town houses, forests and
// scattered trees. Everything is derived from the layout seed and respects the
// exclusion mask (tracks, platforms, water, steep slopes, other buildings).

import type { Layout } from "./schema";
import type { TrackGeom } from "./trackGraph";
import type { TrackPoint } from "./validate";
import { type Terrain, groundZ, slopeAt } from "./terrain";
import { pointAt, headingAt } from "./geometry";
import { HOUSE_INFO, type HouseVariant, type TreeVariant } from "./catalog";
import { PALETTE } from "../scene/palette";
import { SpatialHash } from "../util/spatial";
import { poissonDisc } from "../util/poisson";
import { rng, range, pick, type Rng } from "../util/rng";
import { type V2, lerp, smoothstep, angleOf, perp, fromAngle, add, scale } from "../util/vec";

const TRACK_CLEARANCE = 8;
const MAX_TREE_SLOPE = (35 * Math.PI) / 180;
const MAX_HOUSE_SLOPE = (15 * Math.PI) / 180;
const WATER_MARGIN = 0.5;
const FACE_TRACK_WITHIN = 50;
const MAX_TREES = 16000;
export const PLATFORM_OFFSET = 3.7;     // m from track centre to platform centre line
export const PLATFORM_WIDTH = 4;
const BUILDING_OFFSET = 13;             // m from track centre to the station building

export type Placement = {
  kind: "tree" | "house";
  variant: TreeVariant | HouseVariant;
  x: number;
  y: number;
  z: number;
  rotation: number;     // radians, model frame; for houses the direction the front faces
  scale: number;
  color: number;        // sRGB hex from the palette
};

export type StationGeom = {
  id: string;
  name: string;
  track: string;
  s0: number;
  s1: number;
  sides: Array<1 | -1>;                    // +1 = left of the track direction
  building: { x: number; y: number; z: number; rotation: number };
  benches: Array<{ s: number; side: 1 | -1 }>;
  people: Array<{ s: number; side: 1 | -1; lateral: number }>;   // lateral 0..1 across the platform
};

export function buildStations(layout: Layout, tracks: Map<string, TrackGeom>, terrain: Terrain): StationGeom[] {
  return layout.stations.map((st) => {
    const t = tracks.get(st.track)!;
    const r = rng(layout.seed, `station-${st.id}`);
    const sides: Array<1 | -1> = st.side === "both" ? [-1, 1] : st.side === "left" ? [1] : [-1];
    const s0 = st.at - st.length / 2;
    const s1 = st.at + st.length / 2;
    const p = pointAt(t.path, st.at);
    const h = headingAt(t.path, st.at);
    const side = sides[0];
    const [bx, by] = add(p, scale(perp(fromAngle(h)), side * BUILDING_OFFSET));
    const benches: StationGeom["benches"] = [];
    const people: StationGeom["people"] = [];
    for (const sd of sides) {
      for (let s = s0 + st.length * 0.25; s <= s1 - st.length * 0.25; s += 18) benches.push({ s, side: sd });
      const n = Math.round(st.length / 14);
      for (let k = 0; k < n; k++) people.push({ s: range(r, s0 + 4, s1 - 4), side: sd, lateral: range(r, 0.25, 0.9) });
    }
    return {
      id: st.id, name: st.name, track: st.track, s0, s1, sides, benches, people,
      // The building faces the track: its front points back across the platform.
      building: { x: bx, y: by, z: groundZ(terrain, bx, by), rotation: h - side * (Math.PI / 2) },
    };
  });
}

type Solid = { x: number; y: number; r: number };

export function placeScenery(
  layout: Layout, tracks: Map<string, TrackGeom>, terrain: Terrain, trackHash: SpatialHash<TrackPoint>, stations: StationGeom[],
): Placement[] {
  const { seed, scenery, style } = layout;
  const season = style.season;
  const [W, H] = layout.terrain.size;
  const solids = new SpatialHash<Solid>(30);
  const out: Placement[] = [];
  for (const st of stations) solids.insert(st.building.x, st.building.y, { x: st.building.x, y: st.building.y, r: 10 });

  const trackDistance = (x: number, y: number, within: number): { d: number; p: TrackPoint | null } => {
    let best = { d: Infinity, p: null as TrackPoint | null };
    trackHash.near(x, y, within, (p) => {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < best.d) best = { d, p };
    });
    return best;
  };
  const clearOfSolids = (x: number, y: number, r: number) => {
    let ok = true;
    solids.near(x, y, r + 15, (s) => { if (Math.hypot(s.x - x, s.y - y) < s.r + r) ok = false; });
    return ok;
  };
  const usable = (x: number, y: number, r: number, maxSlope: number) => {
    if (x < r + 2 || y < r + 2 || x > W - r - 2 || y > H - r - 2) return false;
    if (layout.terrain.seaLevel !== null && groundZ(terrain, x, y) < layout.terrain.seaLevel + WATER_MARGIN) return false;
    if (slopeAt(terrain, x, y) > maxSlope) return false;
    return trackDistance(x, y, TRACK_CLEARANCE + r).d >= TRACK_CLEARANCE + r && clearOfSolids(x, y, r);
  };

  // Towns ---------------------------------------------------------------
  const townCentres: Array<{ c: V2; radius: number }> = [];
  scenery.towns.forEach((town, ti) => {
    const r = rng(seed, `town-${ti}`);
    let c: V2;
    if (typeof town.near === "string") {
      const st = layout.stations.find((s) => s.id === town.near)!;
      c = pointAt(tracks.get(st.track)!.path, st.at);
    } else c = town.near;
    townCentres.push({ c, radius: town.radius });
    const spacing = lerp(30, 12, town.density);
    const pts = poissonDisc(r, c[0] - town.radius, c[1] - town.radius, c[0] + town.radius, c[1] + town.radius, spacing,
      (x, y) => Math.hypot(x - c[0], y - c[1]) <= town.radius)
      .sort((a, b) => Math.hypot(a[0] - c[0], a[1] - c[1]) - Math.hypot(b[0] - c[0], b[1] - c[1]));
    let church = town.radius < 80;   // small hamlets get no church
    for (const [x, y] of pts) {
      const rel = Math.hypot(x - c[0], y - c[1]) / town.radius;
      // Denser, taller buildings toward the centre; a church near the middle.
      const wish: HouseVariant[] = !church ? ["church", "house"]
        : rel < 0.4 && town.density > 0.5 ? [pick(r, ["flats", "flats", "terrace", "house"] as const), "house"]
          : rel < 0.75 ? [pick(r, ["terrace", "house", "house"] as const), "house"] : ["house"];
      const variant = wish.find((v) => usable(x, y, HOUSE_INFO[v].radius, MAX_HOUSE_SLOPE));
      if (!variant || (rel > 0.6 && r() < (rel - 0.6) * 1.5)) continue;   // thin out the edges
      if (variant === "church") church = true;
      const near = trackDistance(x, y, FACE_TRACK_WITHIN);
      const target = near.p && near.d < FACE_TRACK_WITHIN ? [near.p.x, near.p.y] : c;
      const facing = Math.hypot(target[0] - x, target[1] - y) > 1 ? angleOf([target[0] - x, target[1] - y]) : r() * 2 * Math.PI;
      solids.insert(x, y, { x, y, r: HOUSE_INFO[variant].radius });
      out.push({
        kind: "house", variant, x, y, z: groundZ(terrain, x, y),
        rotation: facing + range(r, -1, 1) * (15 * Math.PI) / 180, scale: range(r, 0.9, 1.1),
        color: variant === "church" ? PALETTE.walls[4] : pick(r, PALETTE.walls),
      });
    }
  });

  // Trees ---------------------------------------------------------------
  const trees = PALETTE.trees[season];
  const addTree = (r: Rng, x: number, y: number) => {
    if (out.length > MAX_TREES || !usable(x, y, 1.5, MAX_TREE_SLOPE)) return;
    const z = groundZ(terrain, x, y);
    const conifer = r() < 0.3 + 0.45 * smoothstep(8, 40, z);
    const variant: TreeVariant = conifer ? (season === "winter" ? "conifer-snow" : "conifer") : season === "winter" ? "bare" : "deciduous";
    out.push({
      kind: "tree", variant, x, y, z, rotation: r() * 2 * Math.PI, scale: range(r, 0.75, 1.3),
      color: pick(r, conifer ? trees.conifer : trees.deciduous),
    });
  };
  scenery.forests.forEach((f, fi) => {
    const r = rng(seed, `forest-${fi}`);
    const pts = poissonDisc(r, f.at[0] - f.radius, f.at[1] - f.radius, f.at[0] + f.radius, f.at[1] + f.radius, lerp(14, 5, f.density),
      (x, y) => Math.hypot(x - f.at[0], y - f.at[1]) <= f.radius);
    for (const [x, y] of pts) {
      const rel = Math.hypot(x - f.at[0], y - f.at[1]) / f.radius;
      if (r() < smoothstep(0.65, 1, rel) * 0.8) continue;      // ragged forest edge
      addTree(r, x, y);
    }
  });
  if (scenery.scatterTrees > 0) {
    const r = rng(seed, "scatter");
    const inForest = (x: number, y: number) => scenery.forests.some((f) => Math.hypot(x - f.at[0], y - f.at[1]) < f.radius);
    const inTown = (x: number, y: number) => townCentres.some((t) => Math.hypot(x - t.c[0], y - t.c[1]) < t.radius * 0.7);
    for (const [x, y] of poissonDisc(r, 0, 0, W, H, lerp(90, 22, scenery.scatterTrees))) {
      if (!inForest(x, y) && !inTown(x, y)) addTree(r, x, y);
    }
  }
  return out;
}
