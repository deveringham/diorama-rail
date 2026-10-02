// Road rendering: asphalt strips with sloping verges (one merged mesh), dashed
// centre lines and level-crossing panels (a second mesh drawn just above), the
// fixed crossing furniture (posts, St Andrew's crosses, signal housings) and the
// moving parts: barrier arms and flashing lights. Junction areas are drawn by one
// road only (see model/roads.ts trims); deep tunnel interiors are skipped.

import * as THREE from "three";
import type { World } from "../model/build";
import type { GateSnapshot } from "../sim/traffic";
import { pointAt, headingAt, sampleS } from "../model/geometry";
import { profileZ, structureAt } from "../model/heights";
import { CROSSING_ROAD_Z } from "../model/roads";
import { PALETTE } from "./palette";
import { GeoBuilder, flatMaterial, toThree, type P3 } from "./geo";
import { type Frame, side } from "./trackMesh";

const STEP = 2;                  // m between cross-sections
const VERGE = 1.0;               // m the verge reaches beyond the carriageway
const VERGE_DROP = 0.6;          // m it falls over that width
const TUNNEL_VISIBLE = 14;       // m of road drawn inside each tunnel mouth
const DASH = 3;                  // m centre-line dash, then the same gap
const LINE_HALF = 0.08;
const MARK_LIFT = 0.02;
const PANEL_HALF = 1.7;          // m either side of the rails covered by crossing panels
const POST_OUT = 0.9;            // m beyond the carriageway edge for crossing posts
const PIVOT = 1.0;               // m barrier pivot height
const LAMP_Z = 1.75;
const CROSS_Z = 2.45;
const ARM_UP = (85 * Math.PI) / 180;
const RAIL_GAUGE = 1.435;
const RAIL_TOP = 0.28;

export function roadFrame(world: World, road: string, s: number): Frame {
  const r = world.roads.roads.get(road)!;
  const [x, y] = pointAt(r.path, s);
  return { x, y, z: profileZ(world.roads.profiles.get(road)!, s), h: headingAt(r.path, s) };
}

const inRanges = (s: number, ranges: Array<[number, number]>) => ranges.some(([a, b]) => s >= a && s <= b);

/** Static road meshes: surfaces and verges, markings, and crossing furniture. */
export function roadMeshes(world: World): THREE.Object3D[] {
  const net = world.roads;
  if (!net.roads.size) return [];
  const season = world.layout.style.season;
  const g = new GeoBuilder();
  const marks = new GeoBuilder();

  for (const r of net.roads.values()) {
    const L = r.path.length;
    const half = r.spec.width / 2;
    const spans = net.spans.get(r.id)!;
    const trims = net.trims.get(r.id)!;
    const hidden = (s: number) => spans.some((sp) => sp.kind === "tunnel" && s > sp.s0 + TUNNEL_VISIBLE && s < sp.s1 - TUNNEL_VISIBLE);
    // Cross-sections every STEP metres plus exactly at every trim and span boundary.
    const cuts = new Set(sampleS(r.path, STEP));
    if (r.path.closed) cuts.add(L);
    for (const [a, b] of trims) { cuts.add(a); cuts.add(b); }
    for (const sp of spans) { cuts.add(sp.s0); cuts.add(sp.s1); }
    const ss = [...cuts].filter((s) => s >= 0 && s <= L).sort((a, b) => a - b);
    const frames = ss.map((s) => roadFrame(world, r.id, s));
    for (let i = 0; i + 1 < ss.length; i++) {
      const mid = (ss[i] + ss[i + 1]) / 2;
      if (ss[i + 1] - ss[i] < 1e-3 || inRanges(mid, trims) || hidden(mid)) continue;
      const [a, b] = [frames[i], frames[i + 1]];
      g.quad(side(a, -half, 0), side(b, -half, 0), side(b, half, 0), side(a, half, 0), PALETTE.road[season]);
      if (structureAt(spans, mid) === "bridge") continue;
      g.quad(side(a, half, 0), side(b, half, 0), side(b, half + VERGE, -VERGE_DROP), side(a, half + VERGE, -VERGE_DROP), PALETTE.verge[season]);
      g.quad(side(a, -half - VERGE, -VERGE_DROP), side(b, -half - VERGE, -VERGE_DROP), side(b, -half, 0), side(a, -half, 0), PALETTE.verge[season]);
    }

    // A line road ending where another road joins it (a corner or the head of a T):
    // carry the surface on across the joining road's half-width so the corner is closed.
    if (!r.path.closed) {
      for (const [s, out] of [[0, Math.PI], [L, 0]] as const) {
        const n = net.nodes.find((x) => x.legs.some((l) => l.road === r.id && Math.abs(l.s - s) < 1e-3));
        const others = n ? n.legs.filter((l) => l.road !== r.id) : [];
        if (!others.length) continue;
        const ext = Math.max(...others.map((l) => net.roads.get(l.road)!.spec.width)) / 2;
        const a = roadFrame(world, r.id, s);
        const b = { ...a, x: a.x + Math.cos(a.h + out) * ext, y: a.y + Math.sin(a.h + out) * ext };
        const [p, q] = out ? [b, a] : [a, b];         // p → q runs along the road
        g.quad(side(p, -half, 0), side(q, -half, 0), side(q, half, 0), side(p, half, 0), PALETTE.road[season]);
      }
    }

    // Dashed centre line, kept out of junctions, crossings and narrow lanes; snow hides it.
    if (r.spec.width < 5 || season === "winter") continue;
    const quiet: Array<[number, number]> = trims.map(([a, b]) => [a - 2, b + 2]);
    for (const n of net.nodes) {
      if (n.legs.length < 3) continue;
      const mine = n.legs.find((l) => l.road === r.id);
      if (!mine) continue;
      const widest = Math.max(...n.legs.filter((l) => l.road !== r.id).map((l) => net.roads.get(l.road)!.spec.width));
      quiet.push([mine.s - widest / 2 - 3, mine.s + widest / 2 + 3]);
    }
    for (const c of net.crossings) if (c.road === r.id) quiet.push([c.roadS - c.zone - 2, c.roadS + c.zone + 2]);
    if (!r.path.closed) quiet.push([-Infinity, 2], [L - 2, Infinity]);
    for (let s = 1; s + DASH <= L; s += 2 * DASH) {
      if (inRanges(s, quiet) || inRanges(s + DASH, quiet) || hidden(s)) continue;
      const a = roadFrame(world, r.id, s);
      const b = roadFrame(world, r.id, s + DASH);
      marks.quad(side(a, -LINE_HALF, MARK_LIFT), side(b, -LINE_HALF, MARK_LIFT), side(b, LINE_HALF, MARK_LIFT), side(a, LINE_HALF, MARK_LIFT), PALETTE.roadLine);
    }
  }

  // Level crossings: a dark panel over the track the width of the road, and posts on both approaches.
  for (const c of net.crossings) {
    const r = net.roads.get(c.road)!;
    const t = world.tracks.get(c.track)!;
    const ht = headingAt(t.path, c.trackS);
    const hr = headingAt(r.path, c.roadS);
    const sin = Math.max(Math.abs(Math.sin(hr - ht)), 0.25);
    const along = r.spec.width / 2 / sin;                   // along the track to the road edges
    const across = PANEL_HALF / sin;                        // along the road to the panel edges
    const z = c.z + CROSSING_ROAD_Z + MARK_LIFT;
    const corner = (a: number, b: number): P3 => [
      c.at[0] + Math.cos(ht) * a + Math.cos(hr) * b, c.at[1] + Math.sin(ht) * a + Math.sin(hr) * b, z,
    ];
    const ccw = Math.sin(hr - ht) > 0;
    const panel = (a0: number, a1: number, b0: number, b1: number, color: number, lift = 0) => {
      const q = [corner(a0, b0), corner(a1, b0), corner(a1, b1), corner(a0, b1)].map((p): P3 => [p[0], p[1], p[2] + lift]);
      if (ccw) marks.quad(q[0], q[1], q[2], q[3], color);
      else marks.quad(q[3], q[2], q[1], q[0], color);
    };
    panel(-along, along, -across, across, PALETTE.crossingPanel);
    // The rail heads show through the panel (the offset markings would otherwise hide them).
    for (const g0 of [RAIL_GAUGE / 2, -RAIL_GAUGE / 2]) {
      const b = g0 / sin;
      panel(-along, along, b - 0.05 / sin, b + 0.05 / sin, PALETTE.rail, RAIL_TOP - CROSSING_ROAD_Z - MARK_LIFT);
    }
    for (const a of crossingApproaches(world, c)) if (a) furniture(g, a);
  }

  const roads = new THREE.Mesh(g.build(), flatMaterial());
  roads.name = "roads";
  roads.receiveShadow = true;
  const out: THREE.Object3D[] = [roads];
  if (marks.triangles) {
    const m = flatMaterial();
    m.polygonOffset = true;
    m.polygonOffsetFactor = -2;
    m.polygonOffsetUnits = -2;
    const markings = new THREE.Mesh(marks.build(), m);
    markings.name = "road-markings";
    markings.receiveShadow = true;
    out.push(markings);
  }
  return out;
}

/** One approach to a level crossing: the post on the driver's right and where its barrier points. */
type Approach = { post: P3; travel: number; arm: number; length: number };

function crossingApproaches(world: World, c: World["roads"]["crossings"][number]): Array<Approach | null> {
  const r = world.roads.roads.get(c.road)!;
  const half = r.spec.width / 2;
  // In a group of crossings, barriers stand only outside the first and last.
  const group = world.roads.crossings.filter((x) => x.group === c.group);
  return ([1, -1] as const).map((k) => {
    if (group.some((x) => (x.roadS - c.roadS) * k < 0)) return null;
    const s = c.roadS - k * (c.zone + 0.5);
    const f = roadFrame(world, c.road, r.path.closed ? (s + r.path.length) % r.path.length : Math.min(Math.max(s, 0), r.path.length));
    const travel = f.h + (k < 0 ? Math.PI : 0);
    return { post: side(f, -k * (half + POST_OUT), 0), travel, arm: travel + Math.PI / 2, length: half + POST_OUT - 0.2 };
  });
}

/** A box with arbitrary orientation: centre, unit axes u, v, n and their extents. */
function orientedBox(g: GeoBuilder, c: P3, u: P3, v: P3, n: P3, lu: number, lv: number, ln: number, color: number): void {
  const p = (a: number, b: number, d: number): P3 => [
    c[0] + u[0] * a * lu / 2 + v[0] * b * lv / 2 + n[0] * d * ln / 2,
    c[1] + u[1] * a * lu / 2 + v[1] * b * lv / 2 + n[1] * d * ln / 2,
    c[2] + u[2] * a * lu / 2 + v[2] * b * lv / 2 + n[2] * d * ln / 2,
  ];
  // u × v = n for a right-handed set, so these windings face outward.
  g.quad(p(-1, -1, 1), p(1, -1, 1), p(1, 1, 1), p(-1, 1, 1), color);
  g.quad(p(-1, 1, -1), p(1, 1, -1), p(1, -1, -1), p(-1, -1, -1), color, 0.8);
  g.quad(p(1, -1, -1), p(1, 1, -1), p(1, 1, 1), p(1, -1, 1), color, 0.9);
  g.quad(p(-1, 1, -1), p(-1, -1, -1), p(-1, -1, 1), p(-1, 1, 1), color, 0.9);
  g.quad(p(-1, -1, -1), p(1, -1, -1), p(1, -1, 1), p(-1, -1, 1), color, 0.9);
  g.quad(p(1, 1, -1), p(-1, 1, -1), p(-1, 1, 1), p(1, 1, 1), color, 0.9);
}

function furniture(g: GeoBuilder, a: Approach): void {
  const [x, y, z] = a.post;
  g.box(x, y, z - 0.3, 0.16, 0.16, CROSS_Z + 0.9, a.travel, PALETTE.signalPost);
  // Barrier housing at the foot of the post.
  g.box(x + Math.cos(a.arm) * 0.25, y + Math.sin(a.arm) * 0.25, z, 0.45, 0.4, PIVOT + 0.15, a.travel, PALETTE.signalWhite);
  // Lamp back-plate facing the traffic.
  const back: P3 = [-Math.cos(a.travel), -Math.sin(a.travel), 0];
  g.box(x + back[0] * 0.12, y + back[1] * 0.12, z + LAMP_Z - 0.22, 0.08, 0.95, 0.44, a.travel, PALETTE.signalBack);
  // St Andrew's cross: red planks with white faces, crossed at ±45° in the plane facing the traffic.
  const lat: P3 = [Math.cos(a.arm), Math.sin(a.arm), 0];
  const c: P3 = [x + back[0] * 0.12, y + back[1] * 0.12, z + CROSS_Z];
  for (const sgn of [1, -1]) {
    const u: P3 = [lat[0] * Math.SQRT1_2, lat[1] * Math.SQRT1_2, sgn * Math.SQRT1_2];
    // v completes a right-handed set with n = back: v = n × u.
    const v: P3 = [back[1] * u[2] - back[2] * u[1], back[2] * u[0] - back[0] * u[2], back[0] * u[1] - back[1] * u[0]];
    orientedBox(g, c, u, v, back, 1.3, 0.24, 0.04, PALETTE.signalRed);
    const front: P3 = [c[0] + back[0] * 0.03, c[1] + back[1] * 0.03, c[2]];
    orientedBox(g, front, u, v, back, 1.18, 0.13, 0.03, PALETTE.signalWhite);
  }
}

/** Barrier arms and flashing lamps, moved every frame from the sim's gate states. */
export class CrossingMeshes {
  readonly group = new THREE.Group();
  private arms: THREE.InstancedMesh | null = null;
  private lamps: THREE.InstancedMesh | null = null;
  private approaches: Array<Approach | null> = [];
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler(0, 0, 0, "YZX");
  private p = new THREE.Vector3();
  private s = new THREE.Vector3();
  private on = new THREE.Color(PALETTE.lampOn);
  private off = new THREE.Color(PALETTE.lampOff);

  constructor(world: World) {
    for (const c of world.roads.crossings) this.approaches.push(...crossingApproaches(world, c));
    const n = this.approaches.length;
    if (!n) return;
    // Arm: unit length along +x from the pivot, red and white bands; scaled per approach.
    const ag = new GeoBuilder();
    const bands = 7;
    for (let i = 0; i < bands; i++) ag.box((i + 0.5) / bands, 0, -0.06, 1 / bands, 0.1, 0.12, 0, i % 2 ? PALETTE.signalWhite : PALETTE.signalRed);
    this.arms = new THREE.InstancedMesh(ag.build(), flatMaterial(), n);
    this.arms.name = "barriers";
    this.arms.castShadow = true;
    this.arms.frustumCulled = false;
    const lg = new GeoBuilder();
    lg.box(0, 0, -0.12, 0.12, 0.24, 0.24, 0, 0xffffff);
    this.lamps = new THREE.InstancedMesh(lg.build(), new THREE.MeshBasicMaterial({ color: 0xffffff }), n * 2);
    this.lamps.name = "crossing-lamps";
    this.approaches.forEach((a, i) => {
      if (!a) return this.hide(i);
      for (const k of [0, 1]) {
        const off = (k === 0 ? 0.25 : -0.25);
        const x = a.post[0] - Math.cos(a.travel) * 0.2 + Math.cos(a.arm) * off;
        const y = a.post[1] - Math.sin(a.travel) * 0.2 + Math.sin(a.arm) * off;
        this.q.setFromEuler(this.e.set(0, a.travel, 0));
        this.lamps!.setMatrixAt(i * 2 + k, this.m.compose(toThree(x, y, a.post[2] + LAMP_Z, this.p), this.q, this.s.set(1, 1, 1)));
        this.lamps!.setColorAt(i * 2 + k, this.off);
      }
    });
    this.lamps.computeBoundingSphere();
    this.group.add(this.arms, this.lamps);
  }

  update(gates: GateSnapshot[]): void {
    if (!this.arms || !this.lamps) return;
    this.approaches.forEach((a, i) => {
      if (!a) return;
      const g = gates[i >> 1];
      const down = g ? g.barrier : 0;
      // Ease the arm's swing.
      const t = down * down * (3 - 2 * down);
      this.q.setFromEuler(this.e.set(0, a.arm, (1 - t) * ARM_UP));
      toThree(a.post[0] + Math.cos(a.arm) * 0.25, a.post[1] + Math.sin(a.arm) * 0.25, a.post[2] + PIVOT, this.p);
      this.arms!.setMatrixAt(i, this.m.compose(this.p, this.q, this.s.set(a.length, 1, 1)));
      const flashing = !!g && g.state !== "open";
      this.lamps!.setColorAt(i * 2, flashing && g.lights ? this.on : this.off);
      this.lamps!.setColorAt(i * 2 + 1, flashing && !g.lights ? this.on : this.off);
    });
    this.arms.instanceMatrix.needsUpdate = true;
    if (this.lamps.instanceColor) this.lamps.instanceColor.needsUpdate = true;
  }

  /** An approach without furniture (inside a group of crossings): its instances shrink to nothing. */
  private hide(i: number): void {
    this.m.makeScale(0, 0, 0);
    this.arms!.setMatrixAt(i, this.m);
    this.lamps!.setMatrixAt(i * 2, this.m);
    this.lamps!.setMatrixAt(i * 2 + 1, this.m);
    this.lamps!.setColorAt(i * 2, this.off);
    this.lamps!.setColorAt(i * 2 + 1, this.off);
  }

  dispose(): void {
    for (const o of [this.arms, this.lamps]) {
      if (!o) continue;
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    }
  }
}
