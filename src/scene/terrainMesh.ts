// Terrain as a diorama block: the shaped heightmap with per-face colour bands,
// earthen skirt sides, a base frame and a wooden table underneath, plus a
// translucent water plane at sea level.

import * as THREE from "three";
import type { World } from "../model/build";
import { PALETTE } from "./palette";
import { GeoBuilder, flatMaterial, rgb, type P3 } from "./geo";
import { simplex2 } from "../util/noise";

const SKIRT_DEPTH = 0.025;      // block thickness below the lowest point, × the longer side
const TABLE_MARGIN = 0.08;      // table extends this fraction beyond the block
const ROCK_NORMAL_Z = 0.8;      // faces steeper than ~37° show rock
const SNOW_LINE = 26;           // m; winter snow above this even on rock
const WATER_CELL = 25;

export function terrainMeshes(world: World): THREE.Object3D[] {
  const t = world.terrain;
  const season = world.layout.style.season;
  const pal = PALETTE.terrain[season];
  const sea = t.seaLevel;
  const g = new GeoBuilder();
  const w = t.nx + 1;
  const vz = (i: number, j: number) => t.shaped[j * w + i];
  const P = (i: number, j: number): P3 => [i * t.cx, j * t.cy, vz(i, j)];
  const patch = simplex2(world.layout.seed + 101);
  let minZ = Infinity;
  for (const z of t.shaped) minZ = Math.min(minZ, z);

  const faceColor = (a: P3, b: P3, c: P3): number => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz2 = c[2] - a[2];
    const nx = uy * vz2 - uz * vy, ny = uz * vx - ux * vz2, nz = ux * vy - uy * vx;
    const up = Math.abs(nz) / Math.hypot(nx, ny, nz);
    const z = (a[2] + b[2] + c[2]) / 3;
    const cx = (a[0] + b[0] + c[0]) / 3, cy = (a[1] + b[1] + c[1]) / 3;
    if (season === "winter" && z > SNOW_LINE) return PALETTE.terrain.snow;
    if (up < ROCK_NORMAL_Z) return PALETTE.terrain.rock[(cx + cy) % 7 < 3.5 ? 0 : 1];
    if (sea !== null && z < sea + 1.2) return PALETTE.terrain.sand;
    // Mostly meadow with per-face jitter; the odd field, darker grass up the hills.
    const n = patch(cx / 160, cy / 160);
    if (n > 0.8) return pal.field;
    const hash = Math.abs(Math.sin(cx * 12.9898 + cy * 78.233) * 43758.5453) % 1;
    if (z > 18 + 6 * n) return pal.grassDark[hash < 0.5 ? 0 : 1];
    return pal.grass[Math.floor(hash * pal.grass.length)];
  };

  for (let j = 0; j < t.ny; j++) {
    for (let i = 0; i < t.nx; i++) {
      const a = P(i, j), b = P(i + 1, j), c = P(i + 1, j + 1), d = P(i, j + 1);
      // Alternate the diagonal so the low-poly facets don't all lean one way.
      if ((i + j) % 2 === 0) {
        g.tri(a, b, c, faceColor(a, b, c));
        g.tri(a, c, d, faceColor(a, c, d));
      } else {
        g.tri(a, b, d, faceColor(a, b, d));
        g.tri(b, c, d, faceColor(b, c, d));
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

  const ground = new THREE.Mesh(g.build(), flatMaterial());
  ground.name = "terrain";
  ground.receiveShadow = true;
  ground.castShadow = true;
  const out: THREE.Object3D[] = [ground];
  if (sea !== null && minZ < sea) out.push(waterMesh(world, sea));
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
