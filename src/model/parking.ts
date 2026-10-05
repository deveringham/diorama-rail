// Car parks: two rows of nose-in bays either side of an aisle. The aisle is a road
// of its own — a dead end joined to the network by a driveway — so cars reach the
// bays under the ordinary traffic rules. The paved area around it is kept clear
// like a wide road (scenery, paths) and drawn with its bay markings by the scene.

import type { Layout, ParkingLotSpec, RoadSpec } from "./schema";
import { type RoadGeom, type RoadNet, type RoadPoint, roadReach, displayName } from "./roads";
import { pointAt, headingAt } from "./geometry";
import { profileZ } from "./heights";
import type { TrackPoint } from "./validate";
import { type Issue, error } from "./validate";
import { SpatialHash } from "../util/spatial";
import { type V2, mod } from "../util/vec";

export const LOT_AISLE = 6;            // m: the aisle road's width
export const BAY_PITCH = 2.6;          // m between nose-in bays
export const BAY_DEPTH = 5.2;          // m from the aisle's edge to the back of a bay
const LOT_HEAD = 2;                    // m of lot between the entrance and the first bays
const LOT_TAIL = 8;                    // m beyond the last bays, where cars turn round
const DRIVE_MAX = 60;                  // m from the entrance to the road's edge at most
const DRIVE_MIN = 1;                   // m of driveway at least, outside the road
const SEARCH = 300;                    // m to look for the nearest road
const GRID = 2;                        // m between the lot's clearance points
const AISLE_RADIUS = 6;                // m: the driveway's turn into the aisle
const TURN_MAX = (150 * Math.PI) / 180; // the sharpest turn a driveway is allowed room for

export type LotGeom = {
  id: string;
  index: number;
  name: string;
  spec: ParkingLotSpec;
  centre: V2;
  heading: number;                     // direction the entrance faces (from the back to the entrance)
  length: number;                      // along the aisle
  width: number;                       // across: the aisle and both rows of bays
  entrance: V2;
  perSide: number;
  parent: string;                      // the road the driveway joins
};

/** The aisle road a car park needs, and where it lies, or an issue when it cannot be placed. */
export function planLots(layout: Layout, roads: Map<string, RoadGeom>): { lots: LotGeom[]; specs: RoadSpec[]; issues: Issue[] } {
  const lots: LotGeom[] = [];
  const specs: RoadSpec[] = [];
  const issues: Issue[] = [];
  layout.parking.forEach((spec, index) => {
    const where = `parking[${index}]`;
    const perSide = Math.ceil(spec.spaces / 2);
    const length = LOT_HEAD + perSide * BAY_PITCH + LOT_TAIL;
    const width = LOT_AISLE + 2 * BAY_DEPTH;
    // The road it joins: the one named, or the nearest.
    const candidates = spec.road ? [roads.get(spec.road)].filter((r) => r !== undefined) : [...roads.values()];
    let best: { road: RoadGeom; s: number; d: number } | null = null;
    const nearestOn = (r: RoadGeom, p: V2) => {
      let b = { s: 0, d: Infinity };
      for (let s = 0; s <= r.path.length; s += 2) {
        const [x, y] = pointAt(r.path, s);
        const d = Math.hypot(x - p[0], y - p[1]);
        if (d < b.d) b = { s, d };
      }
      for (let ds = -2; ds <= 2; ds += 0.1) {
        const s = r.path.closed ? mod(b.s + ds, r.path.length) : Math.min(Math.max(b.s + ds, 0), r.path.length);
        const [x, y] = pointAt(r.path, s);
        const d = Math.hypot(x - p[0], y - p[1]);
        if (d < b.d) b = { s, d };
      }
      return b;
    };
    for (const r of candidates) {
      const n = nearestOn(r, spec.at);
      if (n.d <= SEARCH && (!best || n.d < best.d)) best = { road: r, ...n };
    }
    if (!best) {
      issues.push(error("PARKING_POSITION", `car park '${spec.id}' has no road within ${SEARCH} m to join; move it beside a road`, `${where}.at`, spec.at));
      return;
    }
    // Facing the road unless told otherwise.
    const [rx, ry] = pointAt(best.road.path, best.s);
    const heading = spec.rotation !== undefined ? (spec.rotation * Math.PI) / 180 : Math.atan2(ry - spec.at[1], rx - spec.at[0]);
    const u: V2 = [Math.cos(heading), Math.sin(heading)];
    const entrance: V2 = [spec.at[0] + (u[0] * length) / 2, spec.at[1] + (u[1] * length) / 2];
    const back: V2 = [spec.at[0] - (u[0] * (length / 2 - 1)), spec.at[1] - (u[1] * (length / 2 - 1))];
    const join = nearestOn(best.road, entrance);
    const outside = join.d - roadReach(best.road.spec);
    if (outside < DRIVE_MIN) {
      issues.push(error("PARKING_POSITION", `car park '${spec.id}' reaches onto road '${best.road.id}'; move it about ${(DRIVE_MIN - outside + 1).toFixed(0)} m further from the road`, `${where}.at`, spec.at));
      return;
    }
    if (outside > DRIVE_MAX) {
      issues.push(error("PARKING_POSITION", `car park '${spec.id}' is ${outside.toFixed(0)} m from road '${best.road.id}' (at most ${DRIVE_MAX} m of driveway); move it closer`, `${where}.at`, spec.at));
      return;
    }
    // The lot itself must keep clear of every road (the aisle and driveway are its own).
    const n: V2 = [-u[1], u[0]];
    const onto = (px: number, py: number) => {
      const dx = px - spec.at[0];
      const dy = py - spec.at[1];
      const a = Math.abs(dx * u[0] + dy * u[1]) - length / 2;
      const b = Math.abs(dx * n[0] + dy * n[1]) - width / 2;
      return Math.hypot(Math.max(a, 0), Math.max(b, 0));
    };
    const hit = [...roads.values()].find((r) => {
      for (let s = 0; s <= r.path.length; s += 2) {
        const [px, py] = pointAt(r.path, s);
        if (onto(px, py) < roadReach(r.spec) + 0.5) return true;
      }
      return false;
    });
    if (hit) {
      issues.push(error("PARKING_POSITION", `car park '${spec.id}' (${length.toFixed(0)} × ${width.toFixed(0)} m) overlaps road '${hit.id}'; move it clear of the road (its entrance faces the road it joins)`, `${where}.at`, spec.at));
      return;
    }
    // The aisle runs straight through the lot: where the driveway comes in from the side,
    // it turns into the aisle outside the entrance, far enough out for the curve.
    const J = pointAt(best.road.path, join.s);
    let front: V2 = entrance;
    for (let i = 0; i < 3; i++) {
      const [dx, dy] = [front[0] - J[0], front[1] - J[1]];
      const turn = Math.acos(Math.max(-1, Math.min(1, -(dx * u[0] + dy * u[1]) / (Math.hypot(dx, dy) || 1))));
      const room = turn < (10 * Math.PI) / 180 ? 0 : AISLE_RADIUS * Math.tan(Math.min(turn, TURN_MAX) / 2) + 1;
      front = [entrance[0] + u[0] * room, entrance[1] + u[1] * room];
    }
    lots.push({ id: spec.id, index, name: spec.name ?? displayName(spec), spec, centre: spec.at, heading, length, width, entrance, perSide, parent: best.road.id });
    specs.push({
      id: spec.id, kind: "line", points: [front, back], lanes: 1, width: LOT_AISLE, minRadius: AISLE_RADIUS, maxGrade: 0.12, speed: 5,
      sidewalks: "none", sidewalkWidth: 2, parking: "none", parkingStyle: "parallel", name: spec.name ?? displayName(spec),
      from: { road: best.road.id, at: join.s },
    });
  });
  return { lots, specs, issues };
}

/** Where a lot's entrance is along its aisle road (s; the aisle starts at the driveway's junction), and where its bays start. */
export function lotFrame(lot: LotGeom, aisle: RoadGeom): { entranceS: number; bayS0: number } {
  let s0 = 0;
  let best = Infinity;
  for (let s = 0; s <= aisle.path.length; s += 0.25) {
    const [x, y] = pointAt(aisle.path, s);
    const d = Math.hypot(x - lot.entrance[0], y - lot.entrance[1]);
    if (d < best) { best = d; s0 = s; }
  }
  return { entranceS: s0, bayS0: s0 + LOT_HEAD };
}

/**
 * The lot's clearance points (added to the road points, so scenery, paths and the
 * ground treat the paved lot like road), and its overlaps with tracks and roads.
 */
export function lotPoints(lots: LotGeom[], roads: RoadNet, trackHash: SpatialHash<TrackPoint>): { points: RoadPoint[]; issues: Issue[] } {
  const points: RoadPoint[] = [];
  const issues: Issue[] = [];
  for (const lot of lots) {
    const aisle = roads.roads.get(lot.id);
    if (!aisle) continue;
    const prof = roads.profiles.get(lot.id)!;
    const u: V2 = [Math.cos(lot.heading), Math.sin(lot.heading)];
    const n: V2 = [-u[1], u[0]];
    const mine: RoadPoint[] = [];
    for (let a = -lot.length / 2; a <= lot.length / 2 + 1e-6; a += GRID) {
      for (let b = -lot.width / 2; b <= lot.width / 2 + 1e-6; b += GRID) {
        const x = lot.centre[0] + u[0] * a + n[0] * b;
        const y = lot.centre[1] + u[1] * a + n[1] * b;
        // Height of the aisle level with this point.
        let bs = 0;
        let bd = Infinity;
        for (let s = 0; s <= aisle.path.length; s += 1) {
          const [px, py] = pointAt(aisle.path, s);
          const d = Math.hypot(px - x, py - y);
          if (d < bd) { bd = d; bs = s; }
        }
        mine.push({
          road: lot.id, s: bs, x, y, z: profileZ(prof, bs), heading: headingAt(aisle.path, bs), width: GRID * 1.5,
          left: GRID * 0.75, right: GRID * 0.75, reach: GRID * 0.75, ground: true, mouth: false,
        });
      }
    }
    const where = `parking[${lot.index}]`;
    const track = mine.map((p) => {
      let hit: TrackPoint | null = null;
      trackHash.near(p.x, p.y, 4, (t) => { if (!hit && Math.hypot(t.x - p.x, t.y - p.y) < 4 && Math.abs(t.z - p.z) < 4) hit = t; });
      return hit as TrackPoint | null;
    }).find((t) => t);
    if (track) issues.push(error("PARKING_POSITION", `car park '${lot.id}' overlaps track '${track.track}'; move it at least 4 m clear of the track`, `${where}.at`, lot.centre));
    const road = mine.map((p) => {
      let hit: RoadPoint | null = null;
      roads.hash.near(p.x, p.y, 20, (q) => {
        if (hit || q.road === lot.id || Math.abs(q.z - p.z) > 4) return;
        if (q.road === lot.parent && Math.hypot(q.x - lot.entrance[0], q.y - lot.entrance[1]) < DRIVE_MAX + 20) {
          // Its own road: only the lot's far parts must keep clear.
          if (Math.hypot(q.x - p.x, q.y - p.y) < q.reach + 0.5 && Math.hypot(p.x - lot.entrance[0], p.y - lot.entrance[1]) > lot.width / 2 + 1) hit = q;
          return;
        }
        if (Math.hypot(q.x - p.x, q.y - p.y) < q.reach + 0.5) hit = q;
      });
      return hit as RoadPoint | null;
    }).find((q) => q);
    if (road) issues.push(error("PARKING_POSITION", `car park '${lot.id}' overlaps road '${road.road}'; move it clear of the road`, `${where}.at`, lot.centre));
    points.push(...mine);
  }
  return { points, issues };
}

/** Issues about a car park's aisle road speak of the car park, at its place in the layout. */
export function lotIssue(issue: Issue, layout: Layout, lots: LotGeom[]): Issue {
  const m = /^roads\[(\d+)\](.*)$/.exec(issue.path);
  if (!m) return issue;
  const k = Number(m[1]) - layout.roads.length;
  if (k < 0 || k >= lots.length) return issue;
  const lot = lots[k];
  return { ...issue, path: `parking[${lot.index}]`, message: issue.message.replaceAll(`road '${lot.id}'`, `car park '${lot.id}'`) };
}
