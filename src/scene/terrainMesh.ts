// Terrain as a diorama block: the shaped heightmap with per-face colour bands,
// earthen skirt sides, a base frame and a wooden table underneath, plus a
// translucent water plane at sea level. The ground is cut into tiles about TILE
// metres across, so a close-up view skips the ones off screen.

import * as THREE from "three";
import type { World } from "../model/build";
import { groundZ } from "../model/terrain";
import { PALETTE } from "./palette";
import { GeoBuilder, flatMaterial, rgb, type P3 } from "./geo";
import { simplex2 } from "../util/noise";
import { PolygonIndex, polygonArea } from "../util/polygon";
import type { V2 } from "../util/vec";

/** A hex colour scaled toward black. */
const shade = (hex: number, k: number) => (Math.round(((hex >> 16) & 255) * k) << 16) | (Math.round(((hex >> 8) & 255) * k) << 8) | Math.round((hex & 255) * k);

const SKIRT_DEPTH = 0.025;      // block thickness below the lowest point, × the longer side
const TABLE_MARGIN = 0.08;      // table extends this fraction beyond the block
const ROCK_NORMAL_Z = 0.8;      // faces steeper than ~37° show rock
const SNOW_LINE = 26;           // m; winter snow above this even on rock
const WATER_CELL = 25;
const TILE = 500;               // m: about how big each ground tile is
const STRATUM = 2.6;            // m: height of the bands in a layout's own rock colour
const STEEP_COVER_Z = 0.62;     // vineyards and scree keep their colour up to ~52° before rock shows
const WATER_OVER = 2.5;         // m the water surface reaches under the banks beyond its edge
const RAPIDS = 0.05;            // a stream falling faster than this (5%) foams
const RAPIDS_SPAN = 3;          // cross-sections either side over which the fall is measured
const RIBBON_STEP = 3;          // every n-th point of a river's line makes a cross-section

export function terrainMeshes(world: World): THREE.Object3D[] {
  const t = world.terrain;
  const season = world.layout.style.season;
  const pal = PALETTE.terrain[season];
  const sea = t.seaLevel;
  const tx = Math.max(1, Math.round(t.width / TILE));
  const ty = Math.max(1, Math.round(t.height / TILE));
  const tiles = Array.from({ length: tx * ty }, () => new GeoBuilder());
  const g = new GeoBuilder();          // skirt, frame and table
  const w = t.nx + 1;
  const vz = (i: number, j: number) => t.shaped[j * w + i];
  const P = (i: number, j: number): P3 => [i * t.cx, j * t.cy, vz(i, j)];
  const patch = simplex2(world.layout.seed + 101);
  let minZ = Infinity;
  for (const z of t.shaped) minZ = Math.min(minZ, z);

  // Bare rock in the layout's colour (sandstone, granite…) or the default grey.
  const rockHex = world.layout.terrain.rock ? parseInt(world.layout.terrain.rock.slice(1), 16) : null;
  const rock = rockHex === null ? PALETTE.terrain.rock : [rockHex, shade(rockHex, 0.9), shade(rockHex, 0.8)];
  // Ground cover: the topmost area containing a face's centre.
  const areas = new PolygonIndex<{ colors: readonly number[]; rows: [number, number] | null; width: number; kind: string }>();
  for (const a of world.layout.terrain.areas) {
    const own = a.color ? parseInt(a.color.slice(1), 16) : null;
    const colors = own !== null ? [own, shade(own, 0.92)] : PALETTE.cover[a.cover][season];
    const rows: [number, number] | null = a.rows === undefined ? null : [-Math.sin((a.rows * Math.PI) / 180), Math.cos((a.rows * Math.PI) / 180)];
    areas.add(a.points, { colors, rows, width: a.rowWidth, kind: a.cover });
  }
  const wet = t.wet;
  const isWet = (i: number, j: number, flag: number) => {
    const v = j * w + i;
    return !!wet && wet[v] === flag && Math.abs(t.shaped[v] - t.base[v]) < 0.5;
  };

  const faceColor = (a: P3, b: P3, c: P3, vs: Array<[number, number]>): number => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz2 = c[2] - a[2];
    const nx = uy * vz2 - uz * vy, ny = uz * vx - ux * vz2, nz = ux * vy - uy * vx;
    const up = Math.abs(nz) / Math.hypot(nx, ny, nz);
    const z = (a[2] + b[2] + c[2]) / 3;
    const cx = (a[0] + b[0] + c[0]) / 3, cy = (a[1] + b[1] + c[1]) / 3;
    const hash = Math.abs(Math.sin(cx * 12.9898 + cy * 78.233) * 43758.5453) % 1;
    if (wet) {
      // Under water the bed, at the water's edge the shore: gravel by a river, mud and reeds by a lake.
      if (vs.every(([i, j]) => isWet(i, j, 3))) return PALETTE.inland.bed;
      const lakeShore = vs.some(([i, j]) => isWet(i, j, 2));
      if (lakeShore || vs.some(([i, j]) => isWet(i, j, 1) || isWet(i, j, 3))) {
        const list = lakeShore ? PALETTE.inland.lakeShore : PALETTE.inland.riverShore;
        return season === "winter" ? PALETTE.terrain.snow : list[hash < 0.5 ? 0 : 1];
      }
    }
    if (season === "winter" && z > SNOW_LINE) return PALETTE.terrain.snow;
    const area = areas.size ? areas.find(cx, cy) : undefined;
    // Vines and fields climb steeper slopes than meadow does before the rock shows.
    if (up < (area && (area.kind === "vineyard" || area.kind === "rock") ? STEEP_COVER_Z : ROCK_NORMAL_Z)) {
      // Bedding planes: bands of slightly different rock a few metres high.
      if (rock.length > 2) return rock[[0, 1, 0, 2][Math.floor(z / STRATUM + hash * 0.5) & 3]];
      return rock[(cx + cy) % 7 < 3.5 ? 0 : 1];
    }
    if (area) {
      if (area.rows) return area.colors[Math.floor((cx * area.rows[0] + cy * area.rows[1]) / area.width) & 1];
      return area.colors[hash < 0.5 ? 0 : 1];
    }
    if (sea !== null && z < sea + 1.2) return PALETTE.terrain.sand;
    // Mostly meadow with per-face jitter; the odd field, darker grass up the hills.
    const n = patch(cx / 160, cy / 160);
    if (n > 0.8) return pal.field;
    if (z > 18 + 6 * n) return pal.grassDark[hash < 0.5 ? 0 : 1];
    return pal.grass[Math.floor(hash * pal.grass.length)];
  };

  for (let j = 0; j < t.ny; j++) {
    const row = Math.min(ty - 1, Math.floor((j * ty) / t.ny)) * tx;
    for (let i = 0; i < t.nx; i++) {
      const tile = tiles[row + Math.min(tx - 1, Math.floor((i * tx) / t.nx))];
      const a = P(i, j), b = P(i + 1, j), c = P(i + 1, j + 1), d = P(i, j + 1);
      // Alternate the diagonal so the low-poly facets don't all lean one way.
      const [va, vb, vc, vd]: Array<[number, number]> = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]];
      if ((i + j) % 2 === 0) {
        tile.tri(a, b, c, faceColor(a, b, c, [va, vb, vc]));
        tile.tri(a, c, d, faceColor(a, c, d, [va, vc, vd]));
      } else {
        tile.tri(a, b, d, faceColor(a, b, d, [va, vb, vd]));
        tile.tri(b, c, d, faceColor(b, c, d, [vb, vc, vd]));
      }
    }
  }

  // Skirt: vertical earth faces around the block, darker toward the bottom.
  const bottom = minZ - Math.max(12, SKIRT_DEPTH * Math.max(t.width, t.height));
  const mid = (z: number) => bottom + (z - bottom) * 0.45;
  const edge = (pts: P3[]) => {
    for (let k = 0; k + 1 < pts.length; k++) {
      const [p, q] = [pts[k], pts[k + 1]];
      const pm: P3 = [p[0], p[1], mid(p[2])], qm: P3 = [q[0], q[1], mid(q[2])];
      g.quad(pm, qm, q, p, PALETTE.terrain.earth);
      g.quad([p[0], p[1], bottom], [q[0], q[1], bottom], qm, pm, PALETTE.terrain.earthDark);
    }
  };
  const row = (j: number) => Array.from({ length: w }, (_, i) => P(i, j));
  const col = (i: number) => Array.from({ length: t.ny + 1 }, (_, j) => P(i, j));
  edge(row(0));
  edge(row(t.ny).reverse());
  edge(col(0).reverse());
  edge(col(t.nx));

  // Base frame and table.
  const W = t.width, H = t.height;
  const fw = 3;
  g.box(W / 2, -fw / 2, bottom - 2, W + 2 * fw, fw, 3, 0, PALETTE.frame);
  g.box(W / 2, H + fw / 2, bottom - 2, W + 2 * fw, fw, 3, 0, PALETTE.frame);
  g.box(-fw / 2, H / 2, bottom - 2, H, fw, 3, Math.PI / 2, PALETTE.frame);
  g.box(W + fw / 2, H / 2, bottom - 2, H, fw, 3, Math.PI / 2, PALETTE.frame);
  const m = Math.max(W, H) * TABLE_MARGIN;
  g.box(W / 2, H / 2, bottom - 6, W + 2 * m, H + 2 * m, 4, 0, PALETTE.table);

  const material = flatMaterial();
  const out: THREE.Object3D[] = [];
  for (const b of [...tiles, g]) {
    if (!b.triangles) continue;
    const ground = new THREE.Mesh(b.build(), material);
    ground.name = b === g ? "terrain-base" : "terrain";
    ground.receiveShadow = true;
    ground.castShadow = false;   // 175k triangles; flat shading already shows the relief
    out.push(ground);
  }
  if (sea !== null && minZ < sea) out.push(waterMesh(world, sea));
  if (world.water.bodies.length) out.push(inlandWaterMesh(world));
  return out;
}

/** Flat sea with gentle colour variation, and "resin" sides where the block edge is below sea level. */
function waterMesh(world: World, sea: number): THREE.Mesh {
  const t = world.terrain;
  const nx = Math.ceil(t.width / WATER_CELL);
  const ny = Math.ceil(t.height / WATER_CELL);
  const pos: number[] = [];
  const colors: number[] = [];
  const shade = simplex2(world.layout.seed + 7);
  const push = (x: number, y: number, z: number, c: [number, number, number]) => {
    pos.push(x, z, -y);
    colors.push(...c);
  };
  const tint = (x: number, y: number) => rgb(PALETTE.water[Math.floor((shade(x / 140, y / 140) * 0.5 + 0.5) * 2.999)], 1);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x0 = (i * t.width) / nx, x1 = ((i + 1) * t.width) / nx;
      const y0 = (j * t.height) / ny, y1 = ((j + 1) * t.height) / ny;
      for (const [x, y] of [[x0, y0], [x1, y0], [x1, y1], [x0, y0], [x1, y1], [x0, y1]]) push(x, y, sea, tint(x, y));
    }
  }
  const side = rgb(PALETTE.waterSide);
  const w = t.nx + 1;
  const sides: Array<[number, number, number, number]> = [];
  for (let i = 0; i < t.nx; i++) sides.push([i, 0, i + 1, 0], [i + 1, t.ny, i, t.ny]);
  for (let j = 0; j < t.ny; j++) sides.push([0, j + 1, 0, j], [t.nx, j, t.nx, j + 1]);
  for (const [i0, j0, i1, j1] of sides) {
    const za = Math.min(sea, t.shaped[j0 * w + i0]);
    const zb = Math.min(sea, t.shaped[j1 * w + i1]);
    if (za >= sea && zb >= sea) continue;
    const a = [i0 * t.cx, j0 * t.cy], b = [i1 * t.cx, j1 * t.cy];
    for (const [x, y, z] of [[a[0], a[1], za], [b[0], b[1], zb], [b[0], b[1], sea], [a[0], a[1], za], [b[0], b[1], sea], [a[0], a[1], sea]]) push(x, y, z, side);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  g.computeVertexNormals();
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: 0.82, flatShading: true });
  const mesh = new THREE.Mesh(g, mat);
  mesh.name = "water";
  mesh.receiveShadow = true;
  mesh.renderOrder = 1;
  return mesh;
}

/**
 * Rivers and streams as ribbons following their surface down the valley (foaming where
 * they fall fast), lakes and ponds as flat sheets over their shores; each reaches a
 * little under its banks, so the ground draws the waterline. Where a river runs off
 * the board, a pane of "resin" closes the channel in the block's side.
 */
function inlandWaterMesh(world: World): THREE.Mesh {
  const pos: number[] = [];
  const colors: number[] = [];
  const shadeN = simplex2(world.layout.seed + 11);
  const push = (p: P3, c: [number, number, number]) => {
    pos.push(p[0], p[2], -p[1]);
    colors.push(...c);
  };
  const pick = (list: readonly number[], x: number, y: number) => list[Math.floor((shadeN(x / 90, y / 90) * 0.5 + 0.5) * (list.length - 0.001))];
  // Without a colour, each corner takes the body's shade where it lies, so the shades blend across the surface.
  let palette: readonly number[] = PALETTE.inland.lake;
  const tri = (a: P3, b: P3, c: P3, col?: [number, number, number]) => {
    for (const p of [a, b, c]) push(p, col ?? rgb(pick(palette, p[0], p[1])));
  };
  const t = world.terrain;
  const W = t.width;
  const H = t.height;
  for (const b of world.water.bodies) {
    palette = PALETTE.inland[b.kind];
    if (b.closed) {
      // The shore pushed out a little, then cut into triangles.
      const ring = b.line.filter((_, k) => k % 2 === 0);
      const ccw = polygonArea(ring) > 0 ? 1 : -1;
      const out: V2[] = ring.map((p, k) => {
        const a = ring[(k + ring.length - 1) % ring.length];
        const c = ring[(k + 1) % ring.length];
        const dx = c[0] - a[0], dy = c[1] - a[1];
        const L = Math.hypot(dx, dy) || 1;
        return [p[0] + (dy / L) * WATER_OVER * ccw, p[1] - (dx / L) * WATER_OVER * ccw];
      });
      const z = b.surface[0];
      const faces = THREE.ShapeUtils.triangulateShape(out.map(([x, y]) => new THREE.Vector2(x, y)), []);
      for (const [i, j, k] of faces) {
        const [p, q, r] = [out[i], out[j], out[k]];
        // three's triangulation winds them clockwise for a clockwise outline; face them up.
        const cross = (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
        if (cross >= 0) tri([p[0], p[1], z], [q[0], q[1], z], [r[0], r[1], z]);
        else tri([p[0], p[1], z], [r[0], r[1], z], [q[0], q[1], z]);
      }
      continue;
    }
    // A ribbon: cross-sections every few points, each as wide as the river plus the overlap.
    const ks: number[] = [];
    for (let k = 0; k < b.line.length; k += RIBBON_STEP) ks.push(k);
    if (ks[ks.length - 1] !== b.line.length - 1) ks.push(b.line.length - 1);
    const section = (k: number): [P3, P3] => {
      const a = b.line[Math.max(0, k - 1)];
      const c = b.line[Math.min(b.line.length - 1, k + 1)];
      const dx = c[0] - a[0], dy = c[1] - a[1];
      const L = Math.hypot(dx, dy) || 1;
      const h = b.half[k] + WATER_OVER;
      const [x, y] = b.line[k];
      return [[x - (dy / L) * h, y + (dx / L) * h, b.surface[k]], [x + (dy / L) * h, y - (dx / L) * h, b.surface[k]]];
    };
    let prev = section(ks[0]);
    for (let n = 1; n < ks.length; n++) {
      const cur = section(ks[n]);
      // The fall over a few sections either side, so a single step in the bed doesn't foam.
      const [k0, k1] = [ks[Math.max(0, n - 1 - RAPIDS_SPAN)], ks[Math.min(ks.length - 1, n + RAPIDS_SPAN)]];
      const fall = (b.surface[k0] - b.surface[k1]) / Math.max(1e-6, b.s[k1] - b.s[k0]);
      const col = fall > RAPIDS ? rgb(PALETTE.inland.foam) : undefined;
      // prev = [left, right]; the river runs from prev to cur: left, right, then cur's right and left.
      tri(prev[1], cur[1], cur[0], col);
      tri(prev[1], cur[0], prev[0], col);
      prev = cur;
    }
    // Resin panes where the course leaves the board.
    const side = rgb(PALETTE.waterSide);
    for (const k of [0, b.line.length - 1]) {
      const [x, y] = b.line[k];
      if (!(x < 1 || y < 1 || x > W - 1 || y > H - 1)) continue;
      const [l, r] = section(k);
      const clampP = (p: P3): P3 => [Math.min(W, Math.max(0, p[0])), Math.min(H, Math.max(0, p[1])), p[2]];
      const [L0, R0] = [clampP(l), clampP(r)];
      const n = 8;
      for (let i = 0; i < n; i++) {
        const f0 = i / n, f1 = (i + 1) / n;
        const p0: V2 = [L0[0] + (R0[0] - L0[0]) * f0, L0[1] + (R0[1] - L0[1]) * f0];
        const p1: V2 = [L0[0] + (R0[0] - L0[0]) * f1, L0[1] + (R0[1] - L0[1]) * f1];
        const z0 = Math.min(b.surface[k], groundZ(world.terrain, p0[0], p0[1]));
        const z1 = Math.min(b.surface[k], groundZ(world.terrain, p1[0], p1[1]));
        const s = b.surface[k];
        tri([p0[0], p0[1], z0], [p1[0], p1[1], z1], [p1[0], p1[1], s], side);
        tri([p0[0], p0[1], z0], [p1[0], p1[1], s], [p0[0], p0[1], s], side);
        tri([p0[0], p0[1], z0], [p1[0], p1[1], s], [p1[0], p1[1], z1], side);
        tri([p0[0], p0[1], z0], [p0[0], p0[1], s], [p1[0], p1[1], s], side);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  g.computeVertexNormals();
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: 0.86, flatShading: true });
  const mesh = new THREE.Mesh(g, mat);
  mesh.name = "inland-water";
  mesh.receiveShadow = true;
  mesh.renderOrder = 1;
  return mesh;
}
