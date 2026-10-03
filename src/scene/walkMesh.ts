// Walkway rendering: sidewalks and their corners as raised paved strips with kerbs,
// footpaths as gravel or paved strips, zebra stripes across roads, and the boarded
// panels of foot crossings. Two merged meshes: the strips, and the markings drawn
// just above the road (polygon offset).

import * as THREE from "three";
import type { World } from "../model/build";
import type { Walkway } from "../model/walks";
import { headingAt } from "../model/geometry";
import { PALETTE } from "./palette";
import { GeoBuilder, flatMaterial, type P3 } from "./geo";
import { side } from "./trackMesh";
import { roadFrame, crossingApproaches, furniture } from "./roadMesh";

const PATH_LIFT = 0.04;          // path surface above its profile height
const SKIRT = 0.35;              // m strips' edges reach down, so they meet the ground (or the road) cleanly
const STRIPE = 0.5;              // m zebra stripe width, with the same gap
const MARK_LIFT = 0.02;
const RAIL_GAUGE = 1.435;
const RAIL_TOP = 0.28;
const FOOT_PANEL_HALF = 1.6;     // m either side of the rails boarded over at a foot crossing
const FOOT_Z = 0.2;

/** A walkway drawn as a strip with sloping-down edges; `lift` raises its top. */
function strip(g: GeoBuilder, w: Walkway, lift: number, top: number, edge: number): void {
  const n = w.x.length;
  const half = w.width / 2;
  const left: P3[] = [];
  const right: P3[] = [];
  for (let i = 0; i < n; i++) {
    // Normal averaged over the neighbouring segments.
    const a = Math.max(0, i - 1);
    const b = Math.min(n - 1, i + 1);
    const h = Math.atan2(w.y[b] - w.y[a], w.x[b] - w.x[a]);
    const nx = -Math.sin(h);
    const ny = Math.cos(h);
    const z = w.z[i] + lift;
    left.push([w.x[i] + nx * half, w.y[i] + ny * half, z]);
    right.push([w.x[i] - nx * half, w.y[i] - ny * half, z]);
  }
  const down = (p: P3): P3 => [p[0], p[1], p[2] - SKIRT];
  for (let i = 0; i + 1 < n; i++) {
    g.quad(right[i], right[i + 1], left[i + 1], left[i], top);
    g.quad(left[i], left[i + 1], down(left[i + 1]), down(left[i]), edge);
    g.quad(down(right[i]), down(right[i + 1]), right[i + 1], right[i], edge);
  }
}

export function walkMeshes(world: World): THREE.Object3D[] {
  const net = world.walks;
  if (!net.ways.length && !net.footCrossings.length) return [];
  const season = world.layout.style.season;
  const g = new GeoBuilder();
  const marks = new GeoBuilder();
  net.ways.forEach((w) => {
    if (w.kind === "sidewalk" || w.kind === "corner") strip(g, w, 0, PALETTE.sidewalk[season], PALETTE.kerb);
    else if (w.kind === "path") {
      // Paths at one node overlap; a hair's difference in height keeps them from flickering.
      const k = net.paths.get(w.owner)!.index % 5;
      const top = w.surface === "paved" ? PALETTE.sidewalk[season] : PALETTE.gravel[season];
      strip(g, w, PATH_LIFT + k * 0.004, top, PALETTE.pathEdge[season]);
    }
  });

  // Zebra stripes, along the road, side by side across it.
  if (season !== "winter") {
    for (const c of net.crossings) {
      if (c.kind !== "zebra") continue;
      const r = world.roads.roads.get(c.road)!;
      const half = r.spec.width / 2 - 0.3;
      const a = roadFrame(world, c.road, Math.max(0, c.roadS - c.half));
      const b = roadFrame(world, c.road, Math.min(r.path.length, c.roadS + c.half));
      for (let l = -half; l + STRIPE <= half + 1e-6; l += 2 * STRIPE) {
        marks.quad(side(a, l, MARK_LIFT), side(b, l, MARK_LIFT), side(b, l + STRIPE, MARK_LIFT), side(a, l + STRIPE, MARK_LIFT), PALETTE.roadLine);
      }
    }
  }

  // Foot crossings: boards over the track the width of the path, with the rail heads showing.
  for (const c of net.footCrossings) {
    const t = world.tracks.get(c.track)!;
    const p = net.paths.get(c.road)!;
    const ht = headingAt(t.path, c.trackS);
    const hp = headingAt(p.path, c.roadS);
    const sin = Math.max(Math.abs(Math.sin(hp - ht)), 0.25);
    const along = (c.width / 2 + 0.3) / sin;
    const across = FOOT_PANEL_HALF / sin;
    const z = c.z + FOOT_Z + MARK_LIFT;
    const corner = (u: number, v: number): P3 => [
      c.at[0] + Math.cos(ht) * u + Math.cos(hp) * v, c.at[1] + Math.sin(ht) * u + Math.sin(hp) * v, z,
    ];
    const ccw = Math.sin(hp - ht) > 0;
    const panel = (u0: number, u1: number, v0: number, v1: number, color: number, lift = 0) => {
      const q = [corner(u0, v0), corner(u1, v0), corner(u1, v1), corner(u0, v1)].map((x): P3 => [x[0], x[1], x[2] + lift]);
      if (ccw) marks.quad(q[0], q[1], q[2], q[3], color);
      else marks.quad(q[3], q[2], q[1], q[0], color);
    };
    panel(-along, along, -across, across, PALETTE.boards);
    for (const g0 of [RAIL_GAUGE / 2, -RAIL_GAUGE / 2]) {
      const v = g0 / sin;
      panel(-along, along, v - 0.05 / sin, v + 0.05 / sin, PALETTE.rail, RAIL_TOP - FOOT_Z - MARK_LIFT);
    }
    for (const a of crossingApproaches(world, c)) if (a) furniture(g, a);
  }

  const out: THREE.Object3D[] = [];
  if (g.triangles) {
    const mesh = new THREE.Mesh(g.build(), flatMaterial());
    mesh.name = "walkways";
    mesh.receiveShadow = true;
    out.push(mesh);
  }
  if (marks.triangles) {
    const m = flatMaterial();
    m.polygonOffset = true;
    m.polygonOffsetFactor = -2;
    m.polygonOffsetUnits = -2;
    const mesh = new THREE.Mesh(marks.build(), m);
    mesh.name = "walk-markings";
    mesh.receiveShadow = true;
    out.push(mesh);
  }
  return out;
}
