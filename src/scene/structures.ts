// Structures (§8.3): bridge decks with piers and parapets, tunnel portals at
// every ground↔tunnel transition (for tracks and roads alike), and station
// platforms and canopies. All merged into one static mesh. (Station buildings and
// benches are scenery objects.)

import * as THREE from "three";
import type { World } from "../model/build";
import { groundZ, baseZ } from "../model/terrain";
import { PLATFORM_OFFSET, PLATFORM_WIDTH, PLATFORM_TOP } from "../model/scenery";
import { PALETTE } from "./palette";
import { GeoBuilder, flatMaterial } from "./geo";
import { type Frame, frameAt, side } from "./trackMesh";
import { roadFrame } from "./roadMesh";
import type { Span } from "../model/heights";

const STEP = 2;
const DECK_HALF = 2.8;
const DECK_TOP = -0.7;            // deck top relative to track z (under the ballast)
const DECK_THICK = 1.1;
const PIER_SPACING = 25;
const CANOPY_HEIGHT = 4.2;        // above platform top
const TRACK_CLEAR = 2.4;          // half the width of a tunnel mouth

/** A bridge deck's half-width, top (relative to the path's z) and pier width. */
type Deck = { half: number; top: number; pier: number };
const TRACK_DECK: Deck = { half: DECK_HALF, top: DECK_TOP, pier: 4.4 };

export function structureMeshes(world: World): THREE.Object3D[] {
  const g = new GeoBuilder();
  for (const t of world.tracks.values()) {
    spanStructures(world, g, world.spans.get(t.id)!, t.path.closed, (s) => frameAt(world, t.id, s), TRACK_DECK, TRACK_CLEAR);
  }
  for (const r of world.roads.roads.values()) {
    const w = r.spec.width;
    spanStructures(world, g, world.roads.spans.get(r.id)!, r.path.closed, (s) => roadFrame(world, r.id, s),
      { half: w / 2 + 0.8, top: -0.03, pier: w * 0.6 }, w / 2 + 0.6);
  }
  for (const st of world.stations) station(world, g, st);
  const mesh = new THREE.Mesh(g.build(), flatMaterial());
  mesh.name = "structures";
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return [mesh];
}

/** Bridges over every bridge span and a portal wherever ground meets tunnel, facing out of the hill. */
function spanStructures(world: World, g: GeoBuilder, spans: Span[], closed: boolean, frame: (s: number) => Frame, deck: Deck, clear: number): void {
  spans.forEach((sp, k) => {
    if (sp.kind === "bridge") bridge(world, g, frame, sp.s0, sp.s1, deck);
    const prev = spans[k - 1];
    if (sp.kind === "tunnel" && prev?.kind !== "tunnel" && (k > 0 || !closed)) portal(g, frame(sp.s0), 0, clear);
    const next = spans[k + 1];
    if (sp.kind === "tunnel" && next && next.kind !== "tunnel") portal(g, frame(sp.s1), Math.PI, clear);
  });
}

function bridge(world: World, g: GeoBuilder, frame: (s: number) => Frame, s0: number, s1: number, deck: Deck): void {
  const { half, top: deckTop } = deck;
  const n = Math.max(1, Math.round((s1 - s0) / STEP));
  const fr: Frame[] = Array.from({ length: n + 1 }, (_, i) => frame(s0 + ((s1 - s0) * i) / n));
  for (let i = 0; i < n; i++) {
    const [a, b] = [fr[i], fr[i + 1]];
    const top = (f: Frame, l: number) => side(f, l, deckTop);
    const bot = (f: Frame, l: number) => side(f, l, deckTop - DECK_THICK);
    g.quad(top(a, half), top(b, half), bot(b, half), bot(a, half), PALETTE.bridge, 0.9);
    g.quad(bot(a, -half), bot(b, -half), top(b, -half), top(a, -half), PALETTE.bridge, 0.9);
    g.quad(bot(a, half), bot(b, half), bot(b, -half), bot(a, -half), PALETTE.bridge, 0.7);
    g.quad(top(a, -half), top(b, -half), top(b, half), top(a, half), PALETTE.bridge);
    // Parapets: low walls along both edges.
    for (const l of [half - 0.15, -half + 0.15]) {
      const p = (f: Frame, d: number, z: number) => side(f, l + d, z);
      g.quad(p(a, -0.15, 0.9), p(b, -0.15, 0.9), p(b, 0.15, 0.9), p(a, 0.15, 0.9), PALETTE.parapet);
      g.quad(p(a, 0.15, 0.9), p(b, 0.15, 0.9), p(b, 0.15, deckTop), p(a, 0.15, deckTop), PALETTE.parapet, 0.92);
      g.quad(p(a, -0.15, deckTop), p(b, -0.15, deckTop), p(b, -0.15, 0.9), p(a, -0.15, 0.9), PALETTE.parapet, 0.92);
    }
  }
  // Piers down to the ground (or the sea floor), plus abutments at both ends.
  const sea = world.terrain.seaLevel;
  for (let s = s0 + PIER_SPACING; s < s1 - PIER_SPACING / 3; s += PIER_SPACING) {
    const f = frame(s);
    const bottom = Math.min(groundZ(world.terrain, f.x, f.y), baseZ(world.terrain, f.x, f.y), sea ?? Infinity) - 1;
    const top = f.z + deckTop - DECK_THICK;
    if (top > bottom) g.box(f.x, f.y, bottom, 2.2, deck.pier, top - bottom, f.h, PALETTE.pier);
  }
  for (const s of [s0, s1]) {
    const f = frame(s);
    g.box(f.x, f.y, f.z - 6, 3, half * 2.5, 6 + deckTop, f.h, PALETTE.pier, PALETTE.bridge);
  }
}

/**
 * Stone portal; `into` turns f.h to point into the tunnel; `clear` is half the
 * width of the mouth, a dark recessed wall.
 */
function portal(g: GeoBuilder, f: Frame, into: number, clear: number): void {
  const h = f.h + into;
  const at = (lat: number, fwd: number): [number, number] => {
    const [x, y] = side(f, lat, 0);
    return [x + Math.cos(h) * fwd, y + Math.sin(h) * fwd];
  };
  const z0 = f.z - 1.2;
  for (const lat of [clear + 1.2, -clear - 1.2]) {
    const [x, y] = at(lat, 0);
    g.box(x, y, z0, 2.4, 2.4, 8.4, h, PALETTE.portal);
  }
  const [lx, ly] = at(0, 0);
  g.box(lx, ly, f.z + 6.0, 2.4, 2 * clear + 4.8, 1.6, h, PALETTE.portal);
  const [bx, by] = at(0, 2.5);
  g.box(bx, by, z0, 0.4, 2 * clear, 7.2, h, PALETTE.portalDark);
  // Wing walls holding back the hillside.
  for (const lat of [clear + 4.1, -clear - 4.1]) {
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
}
