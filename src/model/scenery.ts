// Scenery placement (§5.7, reworked): station props, single objects placed by the
// layout, and scattered groups. Every placement refers to an object definition
// (built-in or from the layout) and is checked against tracks and other objects.
// Deterministic from the layout seed.

import type { Layout } from "./schema";
import type { TrackGeom } from "./trackGraph";
import type { TrackPoint, Issue } from "./validate";
import type { RoadPoint } from "./roads";
import { type WalkPoint, smallEnough } from "./walks";
import { error, warning } from "./validate";
import { type Terrain, groundZ, slopeAt } from "./terrain";
import { type Profile, profileZ } from "./heights";
import { pointAt, headingAt } from "./geometry";
import { type ObjectDef, type ObjectMesh, meshObject, resolveColor, tintColors } from "./objects";
import { OBJECT_LIBRARY } from "./objectLibrary";
import { SpatialHash } from "../util/spatial";
import { poissonDisc } from "../util/poisson";
import { rng, range, pick } from "../util/rng";
import { smoothstep } from "../util/vec";
import type { Season } from "../scene/palette";

export const PLATFORM_OFFSET = 3.7;     // m from track centre to platform centre line
export const PLATFORM_WIDTH = 4;
export const PLATFORM_TOP = 0.9;        // platform surface above track z
const STATION_GAP = 1.5;                // m between platform and station building
const TRACK_GAP = 2;                    // placed objects keep this far from track centres (loading gauge)
const SCATTER_TRACK_GAP = 6;            // scattered items keep further away
const ROAD_GAP = 0.3;                   // placed objects keep this far outside a road's edge
const SCATTER_ROAD_GAP = 3;             // scattered items keep further away
const ROAD_DZ = 5;                      // m; a road this far above or below an object (bridge, tunnel) does not count
const SCATTER_WALK_GAP = 1.5;           // scattered items keep this far from paths and sidewalks
const WATER_MARGIN = 0.5;
const MAX_SCATTERED = 20000;
const FACE_TRACK_SEARCH = 400;          // m to look for the nearest track when facing "track"
const FLAT = 0.5;                       // m; objects lower than this (roads, paving) may overlap others
const GARDEN = 2;                       // m scattered items keep from placed objects, beyond their own size

export type ObjectInfo = { def: ObjectDef; mesh: ObjectMesh };

export type Placement = {
  object: string;
  x: number;
  y: number;
  z: number;
  rotation: number;      // radians, model frame: the direction the object's front (+x) faces
  scale: number;
  tint: number;          // sRGB hex for its "tint" parts
  smoke: boolean;
};

export type StationGeom = {
  id: string;
  name: string;
  track: string;
  s0: number;
  s1: number;
  sides: Array<1 | -1>;                    // +1 = left of the track direction
  people: Array<{ s: number; side: 1 | -1; lateral: number }>;   // lateral 0..1 across the platform
};

/** Every object a layout can use: the built-in library, overridden or extended by the layout's own. */
export function objectCatalog(custom: Record<string, ObjectDef>, season: Season): Map<string, ObjectInfo> {
  const defs = { ...OBJECT_LIBRARY, ...custom };
  return new Map(Object.entries(defs).map(([id, def]) => [id, { def, mesh: meshObject(def, season) }]));
}

export function buildStations(layout: Layout): StationGeom[] {
  return layout.stations.map((st) => {
    const r = rng(layout.seed, `station-${st.id}`);
    const sides: Array<1 | -1> = st.side === "both" ? [-1, 1] : st.side === "left" ? [1] : [-1];
    const s0 = st.at - st.length / 2;
    const s1 = st.at + st.length / 2;
    const people: StationGeom["people"] = [];
    for (const sd of sides) {
      const n = Math.round(st.length / 14);
      for (let k = 0; k < n; k++) people.push({ s: range(r, s0 + 4, s1 - 4), side: sd, lateral: range(r, 0.25, 0.9) });
    }
    return { id: st.id, name: st.name, track: st.track, s0, s1, sides, people };
  });
}

// ---------------------------------------------------------------------------
// Oriented footprints: each placement's x/y bounds as a rotated rectangle.

type Box = { cx: number; cy: number; hx: number; hy: number; c: number; s: number };

function boxOf(info: ObjectInfo, x: number, y: number, rotation: number, scale: number): Box {
  const { min, max } = info.mesh;
  const c = Math.cos(rotation);
  const s = Math.sin(rotation);
  const mx = ((min[0] + max[0]) / 2) * scale;
  const my = ((min[1] + max[1]) / 2) * scale;
  return { cx: x + mx * c - my * s, cy: y + mx * s + my * c, hx: ((max[0] - min[0]) / 2) * scale, hy: ((max[1] - min[1]) / 2) * scale, c, s };
}

/** Distance from a point to the rectangle (0 inside). */
function boxDistance(b: Box, px: number, py: number): number {
  const dx = px - b.cx;
  const dy = py - b.cy;
  const u = Math.abs(dx * b.c + dy * b.s) - b.hx;
  const v = Math.abs(-dx * b.s + dy * b.c) - b.hy;
  return Math.hypot(Math.max(u, 0), Math.max(v, 0));
}

const boxRadius = (b: Box) => Math.hypot(b.hx, b.hy);

// ---------------------------------------------------------------------------

type Context = {
  layout: Layout;
  tracks: Map<string, TrackGeom>;
  profiles: Map<string, Profile>;
  terrain: Terrain;
  trackHash: SpatialHash<TrackPoint>;
  roadHash: SpatialHash<RoadPoint>;
  walkHash: SpatialHash<WalkPoint>;
  stations: StationGeom[];
  objects: Map<string, ObjectInfo>;
};

export function placeScenery(ctx: Context): { placements: Placement[]; issues: Issue[] } {
  const { layout, terrain, trackHash, objects } = ctx;
  const out: Placement[] = [];
  const solids: Array<{ box: Box; path: string; object: string; flat: boolean }> = [];
  const issues: Issue[] = [];
  const platforms = platformHash(ctx);

  const tintFor = (info: ObjectInfo, r: () => number, color?: string) =>
    color ? resolveColor(color, layout.style.season) : pick(r, tintColors(info.def, layout.style.season));
  const add = (object: string, x: number, y: number, z: number, rotation: number, scale: number, tint: number, smoke: boolean) =>
    out.push({ object, x, y, z, rotation, scale, tint, smoke });

  // Station buildings and benches are objects too ("station-building", "bench").
  layout.stations.forEach((st, i) => {
    const t = ctx.tracks.get(st.track)!;
    const r = rng(layout.seed, `station-props-${st.id}`);
    const sides: Array<1 | -1> = st.side === "both" ? [-1, 1] : st.side === "left" ? [1] : [-1];
    const at = (s: number, lateral: number) => {
      const [px, py] = pointAt(t.path, s);
      const h = headingAt(t.path, s);
      return { x: px - Math.sin(h) * lateral, y: py + Math.cos(h) * lateral, h };
    };
    const building = st.building ? objects.get(st.building) : undefined;
    if (building) {
      // The building faces the track; its front edge stands just behind the platform.
      const sd = sides[0];
      const p = at(st.at, sd * (PLATFORM_OFFSET + PLATFORM_WIDTH / 2 + STATION_GAP + building.mesh.max[0]));
      const rot = p.h - sd * (Math.PI / 2);
      const z = groundZ(terrain, p.x, p.y);
      const box = boxOf(building, p.x, p.y, rot, 1);
      const road = nearestRoad(ctx.roadHash, box, z);
      if (road && road.d < ROAD_GAP) {
        issues.push(error("SCENERY_ON_ROAD", `the building of station '${st.id}' stands on road '${road.road}'; move the road away from the platform side, or set "building": null`, `stations[${i}].building`, [p.x, p.y]));
      }
      const walk = nearestWalk(ctx.walkHash, box, z);
      if (walk && walk.d < 0) {
        issues.push(error("SCENERY_ON_PATH", `the building of station '${st.id}' stands on ${walk.what}; move it away from the platform side, or set "building": null`, `stations[${i}].building`, [p.x, p.y]));
      }
      add(st.building!, p.x, p.y, z, rot, 1, tintFor(building, r), false);
      solids.push({ box, path: `stations[${i}].building`, object: st.building!, flat: false });
    }
    const bench = objects.get("bench");
    for (const sd of bench ? sides : []) {
      for (let s = st.at - st.length * 0.25; s <= st.at + st.length * 0.25; s += 18) {
        const p = at(s, sd * (PLATFORM_OFFSET + 1.1));
        add("bench", p.x, p.y, profileZ(ctx.profiles.get(st.track)!, s) + PLATFORM_TOP, p.h - sd * (Math.PI / 2), 1, tintFor(bench!, r), false);
      }
    }
  });

  // Single objects, exactly where the layout puts them.
  layout.scenery.forEach((e, i) => {
    if (!e.object || !e.at) return;
    const info = objects.get(e.object);
    if (!info) return;                              // reported as UNKNOWN_REF
    const path = `scenery[${i}]`;
    const [x, y] = e.at;
    const [W, H] = layout.terrain.size;
    if (x < 0 || y < 0 || x > W || y > H) {
      issues.push(error("OUT_OF_BOUNDS", `${e.object} at (${x}, ${y}) is outside the terrain [0,0]–[${W},${H}]`, `${path}.at`, [x, y]));
      return;
    }
    const r = rng(layout.seed, `place-${i}`);
    const scale = typeof e.scale === "number" ? e.scale : 1;
    const rotation = facing(ctx, e.face, x, y) ?? ((e.rotation ?? 0) * Math.PI) / 180;
    const box = boxOf(info, x, y, rotation, scale);
    const hit = nearestTrack(trackHash, box);
    if (hit && hit.d < TRACK_GAP) {
      issues.push(error("SCENERY_ON_TRACK",
        `${e.object} at (${x}, ${y}) comes within ${hit.d.toFixed(1)} m of track '${hit.track}' (objects need ${TRACK_GAP} m from the track centre); move it about ${(TRACK_GAP - hit.d + 1).toFixed(0)} m further away or turn it`,
        `${path}.at`, [x, y]));
      return;
    }
    const onPlatform = platforms.find(x, y);
    const z = e.z ?? (onPlatform ?? groundZ(terrain, x, y));
    const road = nearestRoad(ctx.roadHash, box, z);
    if (road && road.d < ROAD_GAP) {
      issues.push(error("SCENERY_ON_ROAD",
        `${e.object} at (${x}, ${y}) ${road.d <= -road.half ? "stands in the middle of" : "reaches onto"} road '${road.road}' (keep ${ROAD_GAP} m outside its ${(2 * road.half).toFixed(0)} m carriageway); move it about ${(ROAD_GAP - road.d + 0.5).toFixed(0)} m further from the road centre or turn it`,
        `${path}.at`, [x, y]));
      return;
    }
    const walk = smallEnough(box.hx, box.hy) ? null : nearestWalk(ctx.walkHash, box, z);
    if (walk && walk.d < 0) {
      issues.push(error("SCENERY_ON_PATH",
        `${e.object} at (${x}, ${y}) stands on ${walk.what}; move it about ${(0.5 - walk.d).toFixed(0)} m further away (only things under ${1.2} m across, like lamp posts, may stand on a walkway)`,
        `${path}.at`, [x, y]));
      return;
    }
    const smoke = info.mesh.chimneys.length > 0 && (e.smoke ?? r() < info.def.smoke);
    add(e.object, x, y, z, rotation, scale, tintFor(info, r, e.color), smoke);
    const flat = info.mesh.max[2] * scale < FLAT;
    for (const other of solids) {
      if (flat || other.flat) continue;
      if (boxDistance(other.box, box.cx, box.cy) === 0 || boxDistance(box, other.box.cx, other.box.cy) === 0) {
        issues.push(warning("SCENERY_OVERLAP", `${e.object} at (${x}, ${y}) overlaps ${other.object} (${other.path}); move one of them apart`, `${path}.at`, [x, y]));
        break;
      }
    }
    solids.push({ box, path, object: e.object, flat });
  });

  // Scattered groups, kept clear of tracks, platforms, water, steep ground and solids.
  let scattered = 0;
  layout.scenery.forEach((e, i) => {
    if (!e.scatter || !e.spacing) return;
    const ids = e.scatter.filter((id) => objects.has(id));
    if (!ids.length) return;
    const r = rng(layout.seed, `scatter-${i}`);
    const [W, H] = layout.terrain.size;
    const [lo, hi] = Array.isArray(e.scale) ? e.scale : [0.8, 1.2];
    const circle = e.at && e.radius ? { c: e.at, radius: e.radius } : null;
    const pts = circle
      ? poissonDisc(r, circle.c[0] - circle.radius, circle.c[1] - circle.radius, circle.c[0] + circle.radius, circle.c[1] + circle.radius, e.spacing,
        (x, y) => Math.hypot(x - circle.c[0], y - circle.c[1]) <= circle.radius)
      : poissonDisc(r, 0, 0, W, H, e.spacing);
    for (const [x, y] of pts) {
      if (scattered >= MAX_SCATTERED) break;
      // A ragged edge: thin out the outer third of a circle.
      if (circle && r() < smoothstep(0.65, 1, Math.hypot(x - circle.c[0], y - circle.c[1]) / circle.radius) * 0.8) continue;
      const id = pick(r, ids);
      const info = objects.get(id)!;
      const scale = range(r, lo, hi);
      const rotation = r() * 2 * Math.PI;
      const box = boxOf(info, x, y, rotation, scale);
      const reach = boxRadius(box) * 0.5;
      if (x < reach || y < reach || x > W - reach || y > H - reach) continue;
      const z = groundZ(terrain, x, y);
      if (layout.terrain.seaLevel !== null && z < layout.terrain.seaLevel + WATER_MARGIN) continue;
      if (slopeAt(terrain, x, y) > (info.def.maxSlope * Math.PI) / 180) continue;
      const hit = nearestTrack(trackHash, box);
      if (hit && hit.d < SCATTER_TRACK_GAP + reach * 0.5) continue;
      const road = nearestRoad(ctx.roadHash, box, z);
      if (road && road.d < SCATTER_ROAD_GAP + reach * 0.5) continue;
      const walk = nearestWalk(ctx.walkHash, box, z);
      if (walk && walk.d < SCATTER_WALK_GAP + reach * 0.5) continue;
      if (solids.some((sol) => boxDistance(sol.box, x, y) < reach + (sol.flat ? 0 : GARDEN))) continue;
      add(id, x, y, z, rotation, scale, tintFor(info, r), info.mesh.chimneys.length > 0 && r() < info.def.smoke);
      scattered++;
    }
  });
  return { placements: out, issues };
}

/** Rotation for `face`: toward the nearest track, road or a point; undefined to use `rotation`. */
function facing(ctx: Context, face: "track" | "road" | [number, number] | undefined, x: number, y: number): number | undefined {
  if (!face) return undefined;
  let target: [number, number] | null = Array.isArray(face) ? face : null;
  if (face === "track" || face === "road") {
    let best = Infinity;
    const hash: SpatialHash<{ x: number; y: number }> = face === "track" ? ctx.trackHash : ctx.roadHash;
    hash.near(x, y, FACE_TRACK_SEARCH, (p) => {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < best) { best = d; target = [p.x, p.y]; }
    });
  }
  return target ? Math.atan2(target[1] - y, target[0] - x) : undefined;
}

/** Nearest walkway (path or sidewalk) to a footprint at height z: distance from its edge (negative: on it). */
function nearestWalk(hash: SpatialHash<WalkPoint>, box: Box, z: number): { d: number; what: string } | null {
  let best: { d: number; what: string } | null = null;
  hash.near(box.cx, box.cy, boxRadius(box) + 12, (p) => {
    if (Math.abs(p.z - z) > ROAD_DZ) return;
    const d = boxDistance(box, p.x, p.y) - p.width / 2;
    if (!best || d < best.d) best = { d, what: p.kind === "path" ? `path '${p.owner}'` : `the sidewalk of road '${p.owner.split("/")[0]}'` };
  });
  return best;
}

/**
 * Nearest road to a footprint at height z: distance from the rectangle's edge to the
 * carriageway edge (negative when it reaches onto the road), ignoring bridges and
 * tunnels well above or below.
 */
function nearestRoad(hash: SpatialHash<RoadPoint>, box: Box, z: number): { d: number; half: number; road: string } | null {
  let best: { d: number; half: number; road: string } | null = null;
  hash.near(box.cx, box.cy, boxRadius(box) + SCATTER_ROAD_GAP + 20, (p) => {
    if (Math.abs(p.z - z) > ROAD_DZ) return;
    const d = boxDistance(box, p.x, p.y) - p.width / 2;
    if (!best || d < best.d) best = { d, half: p.width / 2, road: p.road };
  });
  return best;
}

/** Nearest track point to a footprint, measured to the rectangle's edge. */
function nearestTrack(hash: SpatialHash<TrackPoint>, box: Box): { d: number; track: string } | null {
  let best: { d: number; track: string } | null = null;
  hash.near(box.cx, box.cy, boxRadius(box) + SCATTER_TRACK_GAP + 10, (p) => {
    const d = boxDistance(box, p.x, p.y);
    if (!best || d < best.d) best = { d, track: p.track };
  });
  return best;
}

/** Platform strips, so objects placed on a platform stand on its surface. */
function platformHash(ctx: Context) {
  const hash = new SpatialHash<{ x: number; y: number; z: number }>(10);
  for (const st of ctx.stations) {
    const t = ctx.tracks.get(st.track)!;
    const prof = ctx.profiles.get(st.track)!;
    for (const sd of st.sides) {
      for (let s = st.s0; s <= st.s1; s += 1) {
        const [px, py] = pointAt(t.path, s);
        const h = headingAt(t.path, s);
        hash.insert(px - Math.sin(h) * sd * PLATFORM_OFFSET, py + Math.cos(h) * sd * PLATFORM_OFFSET, {
          x: px - Math.sin(h) * sd * PLATFORM_OFFSET, y: py + Math.cos(h) * sd * PLATFORM_OFFSET, z: profileZ(prof, s) + PLATFORM_TOP,
        });
      }
    }
  }
  return {
    /** Platform surface height if (x, y) is on a platform, else null. */
    find(x: number, y: number): number | null {
      let z: number | null = null;
      hash.near(x, y, PLATFORM_WIDTH, (p) => { if (Math.hypot(p.x - x, p.y - y) <= PLATFORM_WIDTH / 2) z = p.z; });
      return z;
    },
  };
}
