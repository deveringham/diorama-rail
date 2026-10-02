// Terrain heightmap (§5.6): bumps + fbm noise on a regular grid, then corridor
// shaping that pulls the ground to the track on `ground` spans, forming
// embankments and cuttings. Provides bilinear ground height queries.

import type { Layout } from "./schema";
import { simplex2, fbm } from "../util/noise";
import { hashString } from "../util/rng";
import { clamp, lerp } from "../util/vec";

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
};

/** A track point used for shaping: position, rail height, and whether it is on plain ground. */
export type ShapePoint = { x: number; y: number; z: number; ground: boolean };

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
      const x = i * cx;
      const y = j * cy;
      let z = baseHeight + noise.amplitude * fbm(n2, x / noise.scale, y / noise.scale);
      for (const f of features) {
        const d2 = ((x - f.at[0]) ** 2 + (y - f.at[1]) ** 2) / (f.radius * f.radius);
        z += f.height * Math.exp(-FEATURE_FALLOFF * d2);
      }
      base[j * (nx + 1) + i] = z;
    }
  }
  return { width, height, nx, ny, cx, cy, base, shaped: base.slice(), seaLevel };
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
 */
export function shapeCorridor(t: Terrain, points: ShapePoint[]): void {
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
  for (let v = 0; v < count; v++) {
    const p = points[bestP[v]];
    if (!p || !p.ground) continue;
    const target = p.z - BED_DEPTH;
    const reach = FLAT_HALF_WIDTH + SIDE_SLOPE * Math.abs(t.base[v] - target);
    const d = bestD[v];
    if (d >= reach) continue;
    const weight = d <= FLAT_HALF_WIDTH ? 1 : 1 - (d - FLAT_HALF_WIDTH) / (reach - FLAT_HALF_WIDTH);
    t.shaped[v] = lerp(t.base[v], target, weight);
  }
}
