// Structures (§8.3): bridge decks with piers and parapets, tunnel portals at
// every ground↔tunnel transition (for tracks, roads and paths alike), and station
// platforms and canopies. All merged into one static mesh. (Station buildings and
// benches are scenery objects.)

import * as THREE from "three";
import type { World } from "../model/build";
import { groundZ, baseZ } from "../model/terrain";
import { PLATFORM_OFFSET, PLATFORM_WIDTH, PLATFORM_TOP } from "../model/scenery";
import { PALETTE } from "./palette";
import { GeoBuilder, flatMaterial } from "./geo";
import { type Frame, frameAt, side } from "./trackMesh";
import { roadFrame, pathFrame } from "./roadMesh";
import { roadReach } from "../model/roads";
import { type Span, tunnelMouths, MOUTH } from "../model/heights";

const STEP = 2;
const DECK_HALF = 2.8;
const DECK_TOP = -0.7;            // deck top relative to track z (under the ballast)
const DECK_THICK = 1.1;
const PIER_SPACING = 25;
const CANOPY_HEIGHT = 4.2;        // above platform top
const TRACK_CLEAR = 2.4;          // half the width of a tunnel mouth
// A portal's box: the first stretch of tunnel built out of the hill, hiding where the
// ground climbs back over the track beyond the cut-away mouth (heights.MOUTH).
const BOX = MOUTH + 6;            // m long
const BOX_TOP = 7.2;              // its roof above the track
const BOX_BOTTOM = -1.2;
const MOUTH_TOP = 6.0;            // the opening's height
const MOUTH_DEPTH = 2;            // m in to the dark wall closing the opening

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
    const reach = roadReach(r.spec);
    spanStructures(world, g, world.roads.spans.get(r.id)!, r.path.closed, (s) => roadFrame(world, r.id, s),
      { half: Math.max(w / 2 + 0.8, reach + 0.5), top: -0.03, pier: w * 0.6 }, reach + 0.6);
  }
  for (const p of world.walks.paths.values()) {
    const w = p.spec.width;
    spanStructures(world, g, world.walks.spans.get(p.id)!, p.path.closed, (s) => pathFrame(world, p.id, s),
      { half: w / 2 + 0.45, top: 0, pier: 1.2 }, w / 2 + 0.6);
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
  for (const sp of spans) if (sp.kind === "bridge") bridge(world, g, frame, sp.s0, sp.s1, deck);
  const L = spans.length ? spans[spans.length - 1].s1 : 0;
  for (const m of tunnelMouths(spans, closed)) {
    // Frames from the mouth into the hill, turned so that forward is inward.
    const end = closed ? m.s + m.into * BOX : Math.min(Math.max(m.s + m.into * BOX, 0), L);
    const n = Math.max(1, Math.round(Math.abs(end - m.s) / STEP));
    const fr = Array.from({ length: n + 1 }, (_, i) => {
      const f = frame(m.s + ((end - m.s) * i) / n);
      return m.into > 0 ? f : { ...f, h: f.h + Math.PI };
    });
    portal(g, fr, Math.abs(end - m.s), clear);
  }
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
 * Stone portal at fr[0], facing out of the hill, and its box running in along the
 * frames (forward is into the hill) over `len` metres. `clear` is half the opening's
 * width; the opening is closed MOUTH_DEPTH in by a dark wall, with dark sides and roof.
 */
function portal(g: GeoBuilder, fr: Frame[], len: number, clear: number): void {
  const f = fr[0];
  const W = clear + 2;                       // the box's half-width; the face stands a little proud of it
  const at = (lat: number, fwd: number): [number, number] => {
    const [x, y] = side(f, lat, 0);
    return [x + Math.cos(f.h) * fwd, y + Math.sin(f.h) * fwd];
  };
  const p = (q: Frame, l: number, z: number) => side(q, l, z);
  const inside = Math.max(1, Math.round((MOUTH_DEPTH / Math.max(len, 1e-6)) * (fr.length - 1)));
  for (let i = 0; i + 1 < fr.length; i++) {
    const [a, b] = [fr[i], fr[i + 1]];
    g.quad(p(b, W, BOX_BOTTOM), p(a, W, BOX_BOTTOM), p(a, W, BOX_TOP), p(b, W, BOX_TOP), PALETTE.portal, 0.9);
    g.quad(p(a, -W, BOX_BOTTOM), p(b, -W, BOX_BOTTOM), p(b, -W, BOX_TOP), p(a, -W, BOX_TOP), PALETTE.portal, 0.9);
    g.quad(p(a, -W, BOX_TOP), p(b, -W, BOX_TOP), p(b, W, BOX_TOP), p(a, W, BOX_TOP), PALETTE.portal);
    if (i >= inside) continue;
    // The dark inside of the opening: walls and roof.
    g.quad(p(a, clear, BOX_BOTTOM), p(b, clear, BOX_BOTTOM), p(b, clear, MOUTH_TOP), p(a, clear, MOUTH_TOP), PALETTE.portalDark);
    g.quad(p(b, -clear, BOX_BOTTOM), p(a, -clear, BOX_BOTTOM), p(a, -clear, MOUTH_TOP), p(b, -clear, MOUTH_TOP), PALETTE.portalDark);
    g.quad(p(a, clear, MOUTH_TOP), p(b, clear, MOUTH_TOP), p(b, -clear, MOUTH_TOP), p(a, -clear, MOUTH_TOP), PALETTE.portalDark);
  }
  const back = fr[Math.min(inside, fr.length - 1)];
  g.quad(p(back, clear, BOX_BOTTOM), p(back, -clear, BOX_BOTTOM), p(back, -clear, MOUTH_TOP), p(back, clear, MOUTH_TOP), PALETTE.portalDark);
  const e = fr[fr.length - 1];
  g.quad(p(e, -W, BOX_BOTTOM), p(e, W, BOX_BOTTOM), p(e, W, BOX_TOP), p(e, -W, BOX_TOP), PALETTE.portal, 0.8);
  // The face: pillars, a lintel and wing walls holding back the hillside.
  const z0 = f.z + BOX_BOTTOM;
  for (const lat of [clear + 1.2, -clear - 1.2]) {
    const [x, y] = at(lat, 0);
    g.box(x, y, z0, 2.4, 2.4, MOUTH_TOP + 1.2 - BOX_BOTTOM, f.h, PALETTE.portal);
  }
  const [lx, ly] = at(0, 0);
  g.box(lx, ly, f.z + MOUTH_TOP, 2.4, 2 * clear + 4.8, 1.6, f.h, PALETTE.portal);
  for (const lat of [clear + 4.1, -clear - 4.1]) {
    const [x, y] = at(lat, -0.6);
    g.box(x, y, z0, 1.6, 4.2, 7.0, f.h, PALETTE.portal);
  }
}

function station(world: World, g: GeoBuilder, st: World["stations"][number]): void {
  const n = Math.max(2, Math.round((st.s1 - st.s0) / STEP));
  const fr = Array.from({ length: n + 1 }, (_, i) => frameAt(world, st.track, st.s0 + ((st.s1 - st.s0) * i) / n));
  if (st.kind === "freight") { dock(g, st, fr); return; }
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

/** A goods yard's loading dock: a wide concrete slab at platform height, with a kerb on the track side. */
function dock(g: GeoBuilder, st: World["stations"][number], fr: Frame[]): void {
  for (const sd of st.sides) {
    const inner = sd * (st.offset - st.width / 2);
    const outer = sd * (st.offset + st.width / 2);
    const edge = sd * (st.offset - st.width / 2 + 0.5);
    const n = fr.length - 1;
    for (let i = 0; i < n; i++) {
      const [a, b] = sd > 0 ? [fr[i], fr[i + 1]] : [fr[i + 1], fr[i]];
      const p = (f: Frame, l: number, z: number) => side(f, l, z);
      g.quad(p(a, edge, PLATFORM_TOP), p(b, edge, PLATFORM_TOP), p(b, outer, PLATFORM_TOP), p(a, outer, PLATFORM_TOP), PALETTE.dock);
      g.quad(p(a, inner, PLATFORM_TOP), p(b, inner, PLATFORM_TOP), p(b, edge, PLATFORM_TOP), p(a, edge, PLATFORM_TOP), PALETTE.dockEdge);
      g.quad(p(a, inner, -0.6), p(b, inner, -0.6), p(b, inner, PLATFORM_TOP), p(a, inner, PLATFORM_TOP), PALETTE.dock, 0.8);
      g.quad(p(b, outer, -1.5), p(a, outer, -1.5), p(a, outer, PLATFORM_TOP), p(b, outer, PLATFORM_TOP), PALETTE.dock, 0.75);
    }
    // Its ends: walls down to the ground.
    for (const [f, k] of [[fr[0], -1], [fr[n], 1]] as const) {
      const p = (l: number, z: number) => side(f, l, z);
      const [x0, x1] = sd * k < 0 ? [outer, inner] : [inner, outer];
      g.quad(p(x0, -1.5), p(x1, -1.5), p(x1, PLATFORM_TOP), p(x0, PLATFORM_TOP), PALETTE.dock, 0.85);
    }
  }
}
