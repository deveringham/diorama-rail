// Terrain heightmap (§5.6): bumps, ridges and mesas + fbm noise on a regular grid, then corridor
// shaping that pulls the ground to the track on `ground` spans, forming
// embankments and cuttings. Provides bilinear ground height queries.

import type { Layout, FeatureSpec } from "./schema";
import { simplex2, fbm } from "../util/noise";
import { hashString } from "../util/rng";
import { clamp, lerp, smoothstep } from "../util/vec";
import { bboxOf, polylineDistance } from "../util/polygon";

const FEATURE_FALLOFF = 3;      // exp(-3·(d/r)²): ~5% of a feature's height remains at its radius
const BED_DEPTH = 0.4;          // ground sits this far below the rail-level track z
const FLAT_HALF_WIDTH = 4;      // m either side of the track that are fully flattened
const SIDE_SLOPE = 1.5;         // horizontal metres per metre of height difference (1:1.5)
const MAX_REACH = 40;           // m, cap on how far shaping can reach

export type Terrain = {
  width: number;
  height: number;
  nx: number;                   // cells along x (vertices = nx + 1)
  ny: number;
  cx: number;                   // cell size along x and y (≈ layout cell)
  cy: number;
  base: Float32Array;           // unmodified heights, (nx+1)·(ny+1), row-major by y
  shaped: Float32Array;         // after corridor shaping
  seaLevel: number | null;
  /** Per vertex: 0 dry land, 1 a river's or stream's shore, 2 a lake's or pond's shore, 3 under water (water.ts). */
  wet?: Uint8Array;
};

/**
 * A track or road point used for shaping: position, surface height, whether it is
 * on plain ground, and optionally its flat half-width and bed depth (track defaults).
 */
export type ShapePoint = { x: number; y: number; z: number; ground: boolean; flat?: number; depth?: number };

export function buildTerrain(layout: Layout): Terrain {
  const { size, cell, baseHeight, features, noise, seaLevel } = layout.terrain;
  const [width, height] = size;
  const nx = Math.max(1, Math.round(width / cell));
  const ny = Math.max(1, Math.round(height / cell));
  const cx = width / nx;
  const cy = height / ny;
  const n2 = simplex2(layout.seed ^ hashString("terrain"));
  const base = new Float32Array((nx + 1) * (ny + 1));
  for (let j = 0; j <= ny; j++) {
    for (let i = 0; i <= nx; i++) {
      base[j * (nx + 1) + i] = baseHeight + noise.amplitude * fbm(n2, (i * cx) / noise.scale, (j * cy) / noise.scale);
    }
  }
  // Each feature only within its reach, so many small ones stay cheap.
  features.forEach((f, k) => {
    const height = featureHeight(f, layout.seed, k);
    const pts = f.points ?? [f.at!];
    const reach = f.radius * (f.shape === "mesa" ? 1 : REACH) * (1 + 0.7 * f.rough) + cell;
    const box = bboxOf(pts, reach);
    const i0 = Math.max(0, Math.floor(box.x0 / cx));
    const i1 = Math.min(nx, Math.ceil(box.x1 / cx));
    const j0 = Math.max(0, Math.floor(box.y0 / cy));
    const j1 = Math.min(ny, Math.ceil(box.y1 / cy));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) base[j * (nx + 1) + i] += height(i * cx, j * cy);
    }
  });
  return { width, height, nx, ny, cx, cy, base, shaped: base.slice(), seaLevel };
}

const REACH = 1.8;              // × radius beyond which a bump adds nothing worth computing (exp(−3·1.8²) ≈ 0.006%)
const CLIFF_RUN = 0.2;          // share of a mesa's slope (from the plateau's edge to its foot) taken by the cliff

/**
 * A feature's height above the ground around it, at any point. Distances are to its
 * centre or (a ridge) its polyline, stretched by noise when it is `rough` so the
 * outline wanders. A mesa falls from its flat top in a sheer cliff, then a talus slope:
 *
 *        plateau          ← flat top, `plateau` · radius
 *      ___________
 *     |           |       ← cliff: `cliff` · height over 20% of the slope
 *    /             \      ← talus, easing out to the foot at `radius`
 */
export function featureHeight(f: FeatureSpec, seed: number, k: number): (x: number, y: number) => number {
  const pts = f.points ?? [f.at!];
  const R = f.radius;
  const n = f.rough > 0 ? simplex2((seed ^ hashString(`feature-${k}`)) >>> 0) : null;
  const dist = (x: number, y: number) => {
    const d = pts.length === 1 ? Math.hypot(x - pts[0][0], y - pts[0][1]) : polylineDistance(pts, x, y);
    // Ragged outline: lobes about a third of the radius across, plus finer notches.
    if (!n) return d;
    const w = (fbm(n, x / (R * 0.45), y / (R * 0.45), 3) * 0.75 + n(x / (R * 0.12), y / (R * 0.12)) * 0.25) * 0.35 * f.rough;
    return d * (1 - w) - w * R * 0.15;
  };
  if (f.shape === "bump") return (x, y) => f.height * Math.exp(-FEATURE_FALLOFF * (dist(x, y) / R) ** 2);
  const top = f.plateau * R;
  const run = R - top;
  return (x, y) => {
    const t = (dist(x, y) - top) / run;
    if (t <= 0) return f.height;
    if (t >= 1) return 0;
    if (t < CLIFF_RUN) return f.height * (1 - f.cliff * (t / CLIFF_RUN));
    return f.height * (1 - f.cliff) * (1 - smoothstep(CLIFF_RUN, 1, t));
  };
}

/** Bilinear height from one of the terrain grids. */
export function sampleGrid(t: Terrain, grid: Float32Array, x: number, y: number): number {
  const fx = clamp(x / t.cx, 0, t.nx - 1e-9);
  const fy = clamp(y / t.cy, 0, t.ny - 1e-9);
  const i = Math.floor(fx);
  const j = Math.floor(fy);
  const u = fx - i;
  const v = fy - j;
  const w = t.nx + 1;
  const a = grid[j * w + i];
  const b = grid[j * w + i + 1];
  const c = grid[(j + 1) * w + i];
  const d = grid[(j + 1) * w + i + 1];
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}

export const baseZ = (t: Terrain, x: number, y: number) => sampleGrid(t, t.base, x, y);
export const groundZ = (t: Terrain, x: number, y: number) => sampleGrid(t, t.shaped, x, y);

/** Slope angle (radians) of the shaped terrain at (x, y). */
export function slopeAt(t: Terrain, x: number, y: number): number {
  const dzdx = (groundZ(t, x + t.cx, y) - groundZ(t, x - t.cx, y)) / (2 * t.cx);
  const dzdy = (groundZ(t, x, y + t.cy) - groundZ(t, x, y - t.cy)) / (2 * t.cy);
  return Math.atan(Math.hypot(dzdx, dzdy));
}

/**
 * Corridor shaping. Each grid vertex is pulled toward (track z − BED_DEPTH) of its
 * nearest track point: fully within FLAT_HALF_WIDTH, then fading out linearly over
 * SIDE_SLOPE·|Δz| metres, which gives roughly 1:1.5 embankment and cutting sides.
 *
 *     ____/‾‾‾‾‾‾\____      ‾‾‾\        /‾‾‾
 *  embankment (track above)     \______/  cutting (track below)
 *
 * The grid itself is the spatial index: every track point "splats" its candidate
 * distance into the vertices around it, keeping the nearest. Tunnel and bridge
 * points still win "nearest" but never shape, so the hill stays over a tunnel.
 *
 * Roads are shaped in a second pass over the result (`keep` = the first pass's
 * return value), so a track bridge does not stop the road beneath it being shaped,
 * and the road never disturbs the flat bed of a track.
 * Returns the vertices this pass flattened completely.
 */
export function shapeCorridor(t: Terrain, points: ShapePoint[], keep?: Uint8Array): Uint8Array {
  const w = t.nx + 1;
  const count = w * (t.ny + 1);
  const bestD = new Float32Array(count).fill(Infinity);
  const bestP = new Int32Array(count).fill(-1);
  points.forEach((p, k) => {
    const i0 = Math.max(0, Math.floor((p.x - MAX_REACH) / t.cx));
    const i1 = Math.min(t.nx, Math.ceil((p.x + MAX_REACH) / t.cx));
    const j0 = Math.max(0, Math.floor((p.y - MAX_REACH) / t.cy));
    const j1 = Math.min(t.ny, Math.ceil((p.y + MAX_REACH) / t.cy));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const d = Math.hypot(i * t.cx - p.x, j * t.cy - p.y);
        const v = j * w + i;
        if (d < bestD[v]) {
          bestD[v] = d;
          bestP[v] = k;
        }
      }
    }
  });
  const flattened = new Uint8Array(count);
  for (let v = 0; v < count; v++) {
    const p = points[bestP[v]];
    if (!p || !p.ground || keep?.[v]) continue;
    const from = keep ? t.shaped[v] : t.base[v];
    const flat = p.flat ?? FLAT_HALF_WIDTH;
    const target = p.z - (p.depth ?? BED_DEPTH);
    const reach = flat + SIDE_SLOPE * Math.abs(from - target);
    const d = bestD[v];
    if (d >= reach) continue;
    const weight = d <= flat ? 1 : 1 - (d - flat) / (reach - flat);
    t.shaped[v] = lerp(from, target, weight);
    if (d <= flat) flattened[v] = 1;
  }
  return flattened;
}
