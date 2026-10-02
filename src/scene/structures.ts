// Structures (§8.3): bridge decks with piers and parapets, tunnel portals at
// every ground↔tunnel transition, and station platforms, canopies, buildings
// and benches. All merged into one static mesh.

import * as THREE from "three";
import type { World } from "../model/build";
import { groundZ, baseZ } from "../model/terrain";
import { PLATFORM_OFFSET, PLATFORM_WIDTH } from "../model/scenery";
import { PALETTE } from "./palette";
import { GeoBuilder, flatMaterial } from "./geo";
import { type Frame, frameAt, side } from "./trackMesh";

const STEP = 2;
const DECK_HALF = 2.8;
const DECK_TOP = -0.7;            // deck top relative to track z (under the ballast)
const DECK_THICK = 1.1;
const PIER_SPACING = 25;
const PLATFORM_TOP = 0.9;         // above track z
const CANOPY_HEIGHT = 4.2;        // above platform top

export function structureMeshes(world: World): THREE.Object3D[] {
  const g = new GeoBuilder();
  for (const t of world.tracks.values()) {
    const spans = world.spans.get(t.id)!;
    spans.forEach((sp, k) => {
      if (sp.kind === "bridge") bridge(world, g, t.id, sp.s0, sp.s1);
      // A portal wherever ground meets tunnel, facing out of the hill.
      const prev = spans[k - 1];
      if (sp.kind === "tunnel" && prev?.kind !== "tunnel" && (k > 0 || !t.path.closed)) portal(g, frameAt(world, t.id, sp.s0), 0);
      const next = spans[k + 1];
      if (sp.kind === "tunnel" && next && next.kind !== "tunnel") portal(g, frameAt(world, t.id, sp.s1), Math.PI);
    });
  }
  for (const st of world.stations) station(world, g, st);
  const mesh = new THREE.Mesh(g.build(), flatMaterial());
  mesh.name = "structures";
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return [mesh];
}

function bridge(world: World, g: GeoBuilder, track: string, s0: number, s1: number): void {
  const n = Math.max(1, Math.round((s1 - s0) / STEP));
  const fr: Frame[] = Array.from({ length: n + 1 }, (_, i) => frameAt(world, track, s0 + ((s1 - s0) * i) / n));
  for (let i = 0; i < n; i++) {
    const [a, b] = [fr[i], fr[i + 1]];
    const top = (f: Frame, l: number) => side(f, l, DECK_TOP);
    const bot = (f: Frame, l: number) => side(f, l, DECK_TOP - DECK_THICK);
    g.quad(top(a, DECK_HALF), top(b, DECK_HALF), bot(b, DECK_HALF), bot(a, DECK_HALF), PALETTE.bridge, 0.9);
    g.quad(bot(a, -DECK_HALF), bot(b, -DECK_HALF), top(b, -DECK_HALF), top(a, -DECK_HALF), PALETTE.bridge, 0.9);
    g.quad(bot(a, DECK_HALF), bot(b, DECK_HALF), bot(b, -DECK_HALF), bot(a, -DECK_HALF), PALETTE.bridge, 0.7);
    g.quad(top(a, -DECK_HALF), top(b, -DECK_HALF), top(b, DECK_HALF), top(a, DECK_HALF), PALETTE.bridge);
    // Parapets: low walls along both edges.
    for (const l of [DECK_HALF - 0.15, -DECK_HALF + 0.15]) {
      const p = (f: Frame, d: number, z: number) => side(f, l + d, z);
      g.quad(p(a, -0.15, 0.9), p(b, -0.15, 0.9), p(b, 0.15, 0.9), p(a, 0.15, 0.9), PALETTE.parapet);
      g.quad(p(a, 0.15, 0.9), p(b, 0.15, 0.9), p(b, 0.15, DECK_TOP), p(a, 0.15, DECK_TOP), PALETTE.parapet, 0.92);
      g.quad(p(a, -0.15, DECK_TOP), p(b, -0.15, DECK_TOP), p(b, -0.15, 0.9), p(a, -0.15, 0.9), PALETTE.parapet, 0.92);
    }
  }
  // Piers down to the ground (or the sea floor), plus abutments at both ends.
  const sea = world.terrain.seaLevel;
  for (let s = s0 + PIER_SPACING; s < s1 - PIER_SPACING / 3; s += PIER_SPACING) {
    const f = frameAt(world, track, s);
    const bottom = Math.min(groundZ(world.terrain, f.x, f.y), baseZ(world.terrain, f.x, f.y), sea ?? Infinity) - 1;
    const top = f.z + DECK_TOP - DECK_THICK;
    if (top > bottom) g.box(f.x, f.y, bottom, 2.2, 4.4, top - bottom, f.h, PALETTE.pier);
  }
  for (const s of [s0, s1]) {
    const f = frameAt(world, track, s);
    g.box(f.x, f.y, f.z - 6, 3, 7, 6 + DECK_TOP, f.h, PALETTE.pier, PALETTE.bridge);
  }
}

/** Stone portal; `into` turns f.h to point into the tunnel. The mouth is a dark recessed wall. */
function portal(g: GeoBuilder, f: Frame, into: number): void {
  const h = f.h + into;
  const at = (lat: number, fwd: number): [number, number] => {
    const [x, y] = side(f, lat, 0);
    return [x + Math.cos(h) * fwd, y + Math.sin(h) * fwd];
  };
  const z0 = f.z - 1.2;
  for (const lat of [3.6, -3.6]) {
    const [x, y] = at(lat, 0);
    g.box(x, y, z0, 2.4, 2.4, 8.4, h, PALETTE.portal);
  }
  const [lx, ly] = at(0, 0);
  g.box(lx, ly, f.z + 6.0, 2.4, 9.6, 1.6, h, PALETTE.portal);
  const [bx, by] = at(0, 2.5);
  g.box(bx, by, z0, 0.4, 4.8, 7.2, h, PALETTE.portalDark);
  // Wing walls holding back the hillside.
  for (const lat of [6.5, -6.5]) {
    const [x, y] = at(lat, -0.6);
    g.box(x, y, z0, 1.6, 4.2, 7.0, h, PALETTE.portal);
  }
}

function station(world: World, g: GeoBuilder, st: World["stations"][number]): void {
  const n = Math.max(2, Math.round((st.s1 - st.s0) / STEP));
  const fr = Array.from({ length: n + 1 }, (_, i) => frameAt(world, st.track, st.s0 + ((st.s1 - st.s0) * i) / n));
  for (const sd of st.sides) {
    const inner = sd * (PLATFORM_OFFSET - PLATFORM_WIDTH / 2);
    const outer = sd * (PLATFORM_OFFSET + PLATFORM_WIDTH / 2);
    const edge = sd * (PLATFORM_OFFSET - PLATFORM_WIDTH / 2 + 0.4);
    for (let i = 0; i < n; i++) {
      const [a, b] = sd > 0 ? [fr[i], fr[i + 1]] : [fr[i + 1], fr[i]];
      const p = (f: Frame, l: number, z: number) => side(f, l, z);
      g.quad(p(a, edge, PLATFORM_TOP), p(b, edge, PLATFORM_TOP), p(b, outer, PLATFORM_TOP), p(a, outer, PLATFORM_TOP), PALETTE.platform);
      g.quad(p(a, inner, PLATFORM_TOP), p(b, inner, PLATFORM_TOP), p(b, edge, PLATFORM_TOP), p(a, edge, PLATFORM_TOP), PALETTE.platformEdge);
      g.quad(p(a, inner, -0.6), p(b, inner, -0.6), p(b, inner, PLATFORM_TOP), p(a, inner, PLATFORM_TOP), PALETTE.platform, 0.8);
      g.quad(p(b, outer, -1.5), p(a, outer, -1.5), p(a, outer, PLATFORM_TOP), p(b, outer, PLATFORM_TOP), PALETTE.platform, 0.8);
    }
    // Canopy over the middle 60%: posts and a roof slab.
    const c0 = st.s0 + (st.s1 - st.s0) * 0.2;
    const c1 = st.s1 - (st.s1 - st.s0) * 0.2;
    for (let s = c0; s <= c1 + 0.1; s += 10) {
      const [x, y, z] = side(frameAt(world, st.track, s), sd * (PLATFORM_OFFSET + 0.6), PLATFORM_TOP);
      g.box(x, y, z, 0.3, 0.3, CANOPY_HEIGHT, 0, PALETTE.canopyPost);
    }
    const m = Math.max(1, Math.round((c1 - c0) / 6));
    for (let i = 0; i < m; i++) {
      const f = frameAt(world, st.track, c0 + ((c1 - c0) * (i + 0.5)) / m);
      const [x, y, z] = side(f, sd * PLATFORM_OFFSET, PLATFORM_TOP + CANOPY_HEIGHT);
      g.box(x, y, z, (c1 - c0) / m + 0.05, PLATFORM_WIDTH + 0.4, 0.3, f.h, PALETTE.canopy);
    }
  }
  for (const b of st.benches) {
    const [x, y, z] = side(frameAt(world, st.track, b.s), b.side * (PLATFORM_OFFSET + 1.1), PLATFORM_TOP);
    g.box(x, y, z, 1.8, 0.6, 0.5, frameAt(world, st.track, b.s).h, PALETTE.bench);
  }
  // Station building: a long two-storey house with a hipped-look gable roof.
  const bd = st.building;
  g.box(bd.x, bd.y, bd.z - 3, 9, 16, 9.5, bd.rotation, PALETTE.stationWall);
  g.gable(bd.x, bd.y, bd.z + 6.5, 16, 9, 3.6, bd.rotation + Math.PI / 2, PALETTE.stationRoof);
}
