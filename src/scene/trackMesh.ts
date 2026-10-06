// Track rendering (§8.2): merged ballast and rails for all tracks, sleepers as
// one InstancedMesh, and buffer stops at plain line ends. Hidden tunnel
// interiors are skipped to save triangles.

import * as THREE from "three";
import type { World } from "../model/build";
import { pointAt, headingAt, sampleS } from "../model/geometry";
import { profileZ } from "../model/heights";
import { PALETTE } from "./palette";
import { GeoBuilder, flatMaterial, toThree, type P3 } from "./geo";
import { keepPoints } from "./simplify";

const STEP = 2;                  // m between cross-sections
const BALLAST_TOP = 1.6;         // half-widths (m)
const BALLAST_BOTTOM = 2.7;
const BALLAST_DEPTH = 0.7;
const RAIL_GAUGE = 1.435;
const RAIL_HEIGHT = 0.28;        // rail top above track z
const SLEEPER_SPACING = 0.65;
const MAX_SLEEPERS = 40000;      // beyond this, sleepers every 1.3 m (slightly wider)
const TUNNEL_VISIBLE = 14;       // m of track drawn inside each tunnel mouth

export type Frame = { x: number; y: number; z: number; h: number };

export function frameAt(world: World, track: string, s: number): Frame {
  const t = world.tracks.get(track)!;
  const [x, y] = pointAt(t.path, s);
  return { x, y, z: profileZ(world.profiles.get(track)!, s), h: headingAt(t.path, s) };
}

/** Offset a frame sideways (left of travel is positive) and vertically. */
export const side = (f: Frame, lateral: number, dz: number): P3 =>
  [f.x - Math.sin(f.h) * lateral, f.y + Math.cos(f.h) * lateral, f.z + dz];

/** Whether s is deep inside a tunnel (invisible). */
function hidden(world: World, track: string, s: number): boolean {
  return world.spans.get(track)!.some((sp) => sp.kind === "tunnel" && s > sp.s0 + TUNNEL_VISIBLE && s < sp.s1 - TUNNEL_VISIBLE);
}

export function trackMeshes(world: World): THREE.Object3D[] {
  const g = new GeoBuilder();
  const sleeperAt: Frame[] = [];
  let total = 0;
  for (const t of world.tracks.values()) total += t.path.length;
  const spacing = total / SLEEPER_SPACING > MAX_SLEEPERS ? SLEEPER_SPACING * 2 : SLEEPER_SPACING;

  for (const t of world.tracks.values()) {
    const all = sampleS(t.path, STEP);
    if (t.path.closed) all.push(t.path.length);
    const fine = all.map((s) => frameAt(world, t.id, s));
    // Only the cross-sections a straight stretch can't stand in for, keeping those either side
    // of where the track disappears into (or comes out of) a tunnel's hidden interior.
    const deep = all.map((s) => hidden(world, t.id, s));
    const keep = keepPoints(fine.map((f) => f.x), fine.map((f) => f.y), fine.map((f) => f.z),
      (i) => deep[i] !== deep[i - 1] || deep[i] !== deep[i + 1]);
    const ss = keep.map((i) => all[i]);
    const frames = keep.map((i) => fine[i]);
    for (let i = 0; i + 1 < frames.length; i++) {
      if (hidden(world, t.id, ss[i]) && hidden(world, t.id, ss[i + 1])) continue;
      const a = frames[i];
      const b = frames[i + 1];
      // Ballast: trapezoid section, top plus two sloping sides.
      const lb = (f: Frame) => side(f, BALLAST_BOTTOM, -BALLAST_DEPTH);
      const lt = (f: Frame) => side(f, BALLAST_TOP, 0);
      const rt = (f: Frame) => side(f, -BALLAST_TOP, 0);
      const rb = (f: Frame) => side(f, -BALLAST_BOTTOM, -BALLAST_DEPTH);
      g.quad(rt(a), rt(b), lt(b), lt(a), PALETTE.ballast);
      g.quad(lt(a), lt(b), lb(b), lb(a), PALETTE.ballastSide);
      g.quad(rb(a), rb(b), rt(b), rt(a), PALETTE.ballastSide);
      // Rails: thin box strips (top and both sides).
      for (const off of [RAIL_GAUGE / 2, -RAIL_GAUGE / 2]) {
        const o = (f: Frame, d: number, z: number) => side(f, off + d, z);
        g.quad(o(a, -0.04, RAIL_HEIGHT), o(b, -0.04, RAIL_HEIGHT), o(b, 0.04, RAIL_HEIGHT), o(a, 0.04, RAIL_HEIGHT), PALETTE.rail, 1.25);
        g.quad(o(a, 0.04, RAIL_HEIGHT), o(b, 0.04, RAIL_HEIGHT), o(b, 0.04, 0.12), o(a, 0.04, 0.12), PALETTE.rail);
        g.quad(o(a, -0.04, 0.12), o(b, -0.04, 0.12), o(b, -0.04, RAIL_HEIGHT), o(a, -0.04, RAIL_HEIGHT), PALETTE.rail);
      }
    }
    for (let s = spacing / 2; s < t.path.length; s += spacing) if (!hidden(world, t.id, s)) sleeperAt.push(frameAt(world, t.id, s));

    // Buffer stops where a line simply ends (not where it leaves the board).
    if (!t.path.closed) {
      const leaves = (end: 0 | 1) => world.offLayout.exits.some((e) => e.kind === "track" && e.line === t.id && e.end === end);
      if (!t.spec.from && !leaves(0)) bufferStop(g, frameAt(world, t.id, 1.5), Math.PI);
      if (!t.spec.to && !leaves(1)) bufferStop(g, frameAt(world, t.id, t.path.length - 1.5), 0);
    }
  }

  const track = new THREE.Mesh(g.build(), flatMaterial());
  track.name = "track";
  track.receiveShadow = true;

  const sb = new GeoBuilder();
  sb.box(0, 0, 0, 0.26, spacing > SLEEPER_SPACING ? 2.8 : 2.5, 0.14, 0, PALETTE.sleeper);
  const sleepers = new THREE.InstancedMesh(sb.build(), flatMaterial(), sleeperAt.length);
  sleepers.name = "sleepers";
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const p = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);
  sleeperAt.forEach((f, i) => {
    q.setFromAxisAngle(up, f.h);
    sleepers.setMatrixAt(i, m.compose(toThree(f.x, f.y, f.z, p), q, one));
  });
  sleepers.receiveShadow = true;
  sleepers.computeBoundingSphere();
  return [track, sleepers];
}

function bufferStop(g: GeoBuilder, f: Frame, turn: number): void {
  const h = f.h + turn;
  g.box(f.x, f.y, f.z, 1.2, 3.0, 1.0, h, PALETTE.frame);
  const [x, y] = side({ ...f, h }, 0, 0);
  g.box(x + Math.cos(h) * 0.3, y + Math.sin(h) * 0.3, f.z + 0.9, 0.5, 3.2, 0.6, h, PALETTE.bufferStop);
}
