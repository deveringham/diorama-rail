// Road traffic and level crossings. Cars drive on the right along lanes between
// road nodes, keep their distance to the car ahead, pick turns at random and pass
// junctions one at a time, never stopping where they would block a junction or a
// crossing. Level crossings warn, lower their barriers once the road is clear and
// stay closed while a train is near; trains stop short of a crossing that is not
// closed. Pure TypeScript, deterministic from the layout seed.

import type { World } from "../model/build";
import type { RoadGeom, RoadNode, LevelCrossing } from "../model/roads";
import { type Plan, curveLimit } from "./services";
import type { Train } from "./trains";
import { rOnPiece } from "../model/routes";
import { pointAt, headingAt, radiusAt } from "../model/geometry";
import { profileZ } from "../model/heights";
import { type Rng, rng, range, pick } from "../util/rng";
import { mod, wrapAngle, clamp } from "../util/vec";

const ACCEL = 2.0;              // m/s²
const DECEL = 3.0;              // m/s² planned braking toward stop points and slower stretches
const HARD_DECEL = 6;           // m/s²: a car this close to a crossing's stop line when the lights start keeps going
const MIN_GAP = 2.5;            // m to the car ahead when stopped
const HEADWAY = 1.2;            // s kept to the car ahead
const FOLLOW_GAIN = 0.5;        // 1/s: how firmly a car closes or opens the gap to the car ahead
const LATERAL = 2.0;            // m/s² allowed in curves and turns
const TURN_MIN = 3;             // m/s
const CREEP = 0.8;              // m/s minimum approach speed so stops finish
const ARRIVE = 0.05;            // m
const LOOK = 90;                // m of path planned ahead
const SPEED_STEP = 5;           // m between lane speed-limit samples
const STOP_GAP = 1.5;           // m between a crossing's stop line and its zone
const LOCK_REACH = 8;           // m beyond braking distance at which a car asks for a junction
const REROUTE_AFTER = 4;        // s waiting for room beyond a junction before trying another way
const QUEUED = 2;               // m/s: slower than this, the car ahead counts as queueing
const PORTAL_EDGE = 30;         // m: dead ends this close to the board edge lead off the board
const AWAY: [number, number] = [4, 16];   // s a car stays off the board
const DEAD_END_TURN = 6;        // m of road a car uses to turn round at a dead end
const SPAWN_GAP = 10;           // m between spawned cars, beyond their length
const AUTO_SPACING = 70;        // m of road per car when traffic.cars is not given
const AUTO_MAX = 60;
const STUCK_AFTER = 120;        // s stationary before a car counts as stuck

// Level crossings.
const WARN = 3;                 // s the lights flash before the barriers drop
const LOWER = 4;                // s for the barriers to come down
const RAISE = 3;                // s to go up again
const SLACK = 4;                // s spare in a train's warning time
const GATE_MARGIN = 4;          // m a train stops short of a crossing that is not closed
const MIN_APPROACH = 30;        // m: a standing train this close keeps the crossing closed
const TAIL_CLEAR = 5;           // m the tail must be past before the crossing opens
const ETA_STEP = 5;             // m steps when estimating a train's arrival
const HOLD = 2;                 // s a crossing stays wanted after the last train wanted it (no flicker)

export type GateState = "open" | "warning" | "lowering" | "closed" | "raising";

type Lane = {
  kind: "lane";
  id: number;
  road: RoadGeom;
  dir: 1 | -1;
  s0: number;                   // road s where the lane starts
  length: number;
  end: number | null;           // node at the end (null: a loop road without nodes runs into itself)
  lateral: number;              // offset along the road's left normal (driving on the right)
  limit: Float32Array;          // speed limit every SPEED_STEP m
  // Level crossings as lane offsets: stop line and the far end of the zone. Only the
  // first crossing of a group (see Gate.group) is a place to stop; its zone runs to
  // the end of the group's.
  crossings: Array<{ gate: number; stop: number; zoneEnd: number; lead: boolean }>;
  next: Lane[];                 // lanes a car may take at the end
};
type Turn = { kind: "turn"; node: number; junction: boolean; to: Lane; length: number; speed: number; pts: Float64Array; cum: Float64Array };
type Away = { kind: "away"; node: number; back: Lane; length: number };
type Seg = Lane | Turn | Away;

type Car = {
  index: number;
  object: string;
  length: number;
  centre: number;               // the object's x-centre offset in its own frame
  pace: number;                 // fraction of the limit this driver keeps to
  path: Seg[];                  // path[0] holds the front
  d: number;                    // front position along path[0]
  trail: Seg[];                 // segments behind, most recent first
  speed: number;
  held: Turn[];                 // junction turns it holds (until the whole car is through)
  asking: Turn | null;          // the junction turn it has asked for
  request: number;              // when it asked, NaN if not asking
  hidden: boolean;
  awayLeft: number;
  stopped: number;              // s at speed 0
  odometer: number;
  maxWait: number;
};

type Gate = {
  crossing: LevelCrossing;
  half: number;                 // m along the track covered by the road
  state: GateState;
  t: number;                    // s in the current state
  barrier: number;              // 0 up .. 1 down
  group: number;                // see LevelCrossing.group: grouped crossings change state together
  want: boolean;
  wantedAt: number;             // last time a train wanted it
  closures: number;
  closedFor: number;            // s in total not open
};

type Occupant = { car: Car; front: number; rear: number };

export type VehicleSnapshot = { object: string; x: number; y: number; z: number; heading: number; pitch: number; visible: boolean };
export type GateSnapshot = { id: string; state: GateState; barrier: number; lights: boolean };
export type TrafficStats = { cars: number; unplaced: number; avgSpeed: number; maxWait: number; stuck: number; closures: number; closedShare: number };

export class Traffic {
  readonly cars: Car[] = [];
  readonly gates: Gate[] = [];
  readonly closed: Uint8Array;
  unplaced = 0;
  private lanes: Lane[] = [];
  private turns = new Map<string, Turn>();
  private aways = new Map<number, Away>();
  private holder: Int32Array;
  private occ = new Map<Seg, Occupant[]>();
  private planGates: Array<Array<{ gate: number; r: number }>>;
  private groups: number[][] = [];          // gate indices per group, the group's lead first
  private r: Rng;
  private time = 0;
  private world: World;

  constructor(world: World, plans: Plan[], seed: number) {
    this.world = world;
    this.r = rng(seed, "traffic");
    const net = world.roads;
    this.holder = new Int32Array(net.nodes.length).fill(-1);
    for (const c of net.crossings) {
      const road = net.roads.get(c.road)!;
      const half = road.spec.width / 2 / Math.max(Math.sin((c.angle * Math.PI) / 180), 0.25) + 1;
      this.gates.push({ crossing: c, half, state: "open", t: 0, barrier: 0, group: c.group, want: false, wantedAt: -Infinity, closures: 0, closedFor: 0 });
    }
    this.groups = this.gates.map((_, i) => i).filter((i) => this.gates[i].group === i)
      .map((i) => this.gates.map((_, k) => k).filter((k) => this.gates[k].group === i));
    this.closed = new Uint8Array(this.gates.length);
    this.planGates = plans.map((plan) => {
      const out: Array<{ gate: number; r: number }> = [];
      this.gates.forEach((g, gi) => {
        for (const p of plan.route.pieces) {
          if (p.track !== g.crossing.track) continue;
          const r = rOnPiece(p, g.crossing.trackS, world.tracks);
          if (r !== null && !out.some((o) => o.gate === gi && Math.abs(o.r - r) < 1)) out.push({ gate: gi, r });
        }
      });
      return out;
    });
    this.buildLanes();
    this.spawn();
  }

  // -- network -------------------------------------------------------------------

  private nodeBox(n: RoadNode, legIndex: number): number {
    const net = this.world.roads;
    const leg = n.legs[legIndex];
    const road = net.roads.get(leg.road)!;
    let box: number;
    if (n.legs.length === 1) box = this.portal(n) ? 0 : DEAD_END_TURN;
    else if (n.legs.length === 2) box = 1;
    else {
      // Stop clear of every other road at the junction, further back when it meets at an angle.
      const h = headingAt(road.path, leg.s) + (leg.dir < 0 ? Math.PI : 0);
      box = 2;
      for (const o of n.legs) {
        if (o.road === leg.road) continue;
        const other = net.roads.get(o.road)!;
        const sin = Math.abs(Math.sin(headingAt(other.path, o.s) - h));
        box = Math.max(box, other.spec.width / 2 / Math.max(sin, 0.4) + 1.5);
      }
    }
    // Never more than half way to the next node along this leg.
    const next = this.nextStop(road, leg.s, leg.dir);
    if (next) box = Math.min(box, Math.max(0, next.dist / 2 - 0.5));
    return box;
  }

  private portal(n: RoadNode): boolean {
    const [W, H] = this.world.layout.terrain.size;
    return Math.min(n.at[0], n.at[1], W - n.at[0], H - n.at[1]) < PORTAL_EDGE;
  }

  /** The next node along a road from s in direction dir (wrapping on loops), not counting s itself. */
  private nextStop(road: RoadGeom, s: number, dir: 1 | -1): { node: number; s: number; dist: number } | null {
    const list = this.world.roads.stops.get(road.id)!;
    const L = road.path.length;
    let best: { node: number; s: number; dist: number } | null = null;
    for (const x of list) {
      let dist = (x.s - s) * dir;
      if (road.path.closed) dist = mod(dist, L);
      if (dist <= 1e-6 && road.path.closed) dist += L;
      if (dist <= 1e-6) continue;
      if (!best || dist < best.dist) best = { node: x.node, s: x.s, dist };
    }
    return best;
  }

  private buildLanes(): void {
    const net = this.world.roads;
    const make = (road: RoadGeom, dir: 1 | -1, s0: number, length: number, end: number | null): Lane => {
      const limit = new Float32Array(Math.max(1, Math.ceil(length / SPEED_STEP) + 1));
      for (let i = 0; i < limit.length; i++) {
        const s = this.laneS({ road, dir, s0 } as Lane, Math.min(i * SPEED_STEP, length));
        limit[i] = Math.min(road.spec.speed, Math.sqrt(LATERAL * radiusAt(road.path, s)));
      }
      const lane: Lane = {
        kind: "lane", id: this.lanes.length, road, dir, s0, length, end, lateral: (-dir * road.spec.width) / 4, limit, crossings: [], next: [],
      };
      this.lanes.push(lane);
      return lane;
    };
    const starts = new Map<string, Lane>();           // node|legIndex -> lane leaving along that leg
    net.nodes.forEach((n) => {
      n.legs.forEach((leg, li) => {
        const road = net.roads.get(leg.road)!;
        const next = this.nextStop(road, leg.s, leg.dir);
        if (!next) return;
        const box0 = this.nodeBox(n, li);
        const m = net.nodes[next.node];
        const back = m.legs.findIndex((l) => l.road === leg.road && l.dir === -leg.dir && Math.abs(mod(l.s - next.s + 1, road.path.length || Infinity) - 1) < 1e-3);
        const box1 = back >= 0 ? this.nodeBox(m, back) : 0;
        const L = road.path.length;
        const s0 = road.path.closed ? mod(leg.s + leg.dir * box0, L) : leg.s + leg.dir * box0;
        starts.set(`${n.id}|${li}`, make(road, leg.dir, s0, Math.max(0.5, next.dist - box0 - box1), next.node));
      });
    });
    // Loop roads with no nodes: one lane each way that runs into itself.
    for (const road of net.roads.values()) {
      if (!road.path.closed || net.stops.get(road.id)!.length) continue;
      for (const dir of [1, -1] as const) {
        const lane = make(road, dir, dir > 0 ? 0 : road.path.length, road.path.length, null);
        lane.next = [lane];
      }
    }
    // Where each lane may continue: any leg of its end node except straight back, unless that is all there is.
    for (const lane of this.lanes) {
      if (lane.end === null) continue;
      const n = net.nodes[lane.end];
      const endS = this.laneS(lane, lane.length + this.boxBeyond(lane));
      const outs = n.legs.map((leg, li) => ({ leg, lane: starts.get(`${n.id}|${li}`) })).filter((o) => o.lane);
      const reverse = (o: (typeof outs)[number]) => o.leg.road === lane.road.id && o.leg.dir === -lane.dir
        && Math.abs(mod(o.leg.s - endS + 1, lane.road.path.length || Infinity) - 1) < 0.5;
      const forward = outs.filter((o) => !reverse(o));
      lane.next = (forward.length ? forward : outs).map((o) => o.lane!);
    }
    // Level crossings on each lane: stop line and the end of the zone, as lane offsets.
    this.gates.forEach((g, gi) => {
      const c = g.crossing;
      for (const lane of this.lanes) {
        if (lane.road.id !== c.road) continue;
        const L = lane.road.path.length;
        let at = (c.roadS - lane.s0) * lane.dir;
        if (lane.road.path.closed) at = mod(at, L);
        if (at < 0 || at > lane.length) continue;
        lane.crossings.push({ gate: gi, stop: at - c.zone - STOP_GAP, zoneEnd: at + c.zone, lead: true });
      }
    });
    for (const lane of this.lanes) {
      lane.crossings.sort((a, b) => a.stop - b.stop);
      let lead: Lane["crossings"][number] | null = null;
      for (const x of lane.crossings) {
        if (lead && this.gates[lead.gate].group === this.gates[x.gate].group) {
          x.lead = false;
          lead.zoneEnd = Math.max(lead.zoneEnd, x.zoneEnd);
        } else lead = x;
      }
    }
  }

  /** Distance from a lane's end to its end node's centre. */
  private boxBeyond(lane: Lane): number {
    if (lane.end === null) return 0;
    const next = this.nextStop(lane.road, lane.s0, lane.dir);
    return next ? next.dist - lane.length : 0;
  }

  private laneS(lane: Pick<Lane, "road" | "dir" | "s0">, offset: number): number {
    const s = lane.s0 + lane.dir * offset;
    const L = lane.road.path.length;
    return lane.road.path.closed ? mod(s, L) : clamp(s, 0, L);
  }

  private turn(from: Lane, to: Lane): Seg {
    const node = from.end!;
    const n = this.world.roads.nodes[node];
    if (n.legs.length === 1 && this.portal(n)) {
      let a = this.aways.get(node);
      if (!a) this.aways.set(node, (a = { kind: "away", node, back: to, length: 0 }));
      return a;
    }
    const key = `${from.id}>${to.id}`;
    const cached = this.turns.get(key);
    if (cached) return cached;
    const p0 = { ...this.lanePose(from, from.length) };
    const p2 = { ...this.lanePose(to, 0) };
    const [c0, s0, c2, s2] = [Math.cos(p0.h), Math.sin(p0.h), Math.cos(p2.h), Math.sin(p2.h)];
    const dx = p2.x - p0.x;
    const dy = p2.y - p0.y;
    const chord = Math.hypot(dx, dy);
    const dh = Math.abs(wrapAngle(p2.h - p0.h));
    let c1x = (p0.x + p2.x) / 2;
    let c1y = (p0.y + p2.y) / 2;
    if (dh > 2.6) {
      // Turning round: bulge forward so the turn uses the end of the road.
      const reach = 2 * this.boxBeyond(from);
      c1x += c0 * reach;
      c1y += s0 * reach;
    } else if (dh > 0.15) {
      // Where the two lane lines meet.
      const den = c0 * s2 - s0 * c2;
      const t = (dx * s2 - dy * c2) / den;
      const u = (dx * s0 - dy * c0) / den;
      if (t > 0 && u > 0 && t < 3 * chord + 5 && u < 3 * chord + 5) {
        c1x = p0.x + c0 * t;
        c1y = p0.y + s0 * t;
      }
    }
    const N = 16;
    const pts = new Float64Array((N + 1) * 3);
    const cum = new Float64Array(N + 1);
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const a = (1 - t) * (1 - t);
      const b = 2 * t * (1 - t);
      const c = t * t;
      pts[i * 3] = a * p0.x + b * c1x + c * p2.x;
      pts[i * 3 + 1] = a * p0.y + b * c1y + c * p2.y;
      pts[i * 3 + 2] = p0.z + (p2.z - p0.z) * t;
      if (i > 0) cum[i] = cum[i - 1] + Math.hypot(pts[i * 3] - pts[i * 3 - 3], pts[i * 3 + 1] - pts[i * 3 - 2]);
    }
    // Tightest radius along the curve, from the turn of heading between samples.
    let rMin = Infinity;
    for (let i = 1; i < N; i++) {
      const h1 = Math.atan2(pts[i * 3 + 1] - pts[i * 3 - 2], pts[i * 3] - pts[i * 3 - 3]);
      const h2 = Math.atan2(pts[i * 3 + 4] - pts[i * 3 + 1], pts[i * 3 + 3] - pts[i * 3]);
      const dTurn = Math.abs(wrapAngle(h2 - h1));
      if (dTurn > 1e-4) rMin = Math.min(rMin, (cum[i + 1] - cum[i - 1]) / 2 / dTurn);
    }
    const speed = clamp(Math.sqrt(LATERAL * rMin), TURN_MIN, Math.min(from.road.spec.speed, to.road.spec.speed));
    const t: Turn = { kind: "turn", node, junction: n.legs.length >= 3, to, length: Math.max(cum[N], 0.5), speed, pts, cum };
    this.turns.set(key, t);
    return t;
  }

  private pose = { x: 0, y: 0, z: 0, h: 0 };
  private lanePose(lane: Lane, offset: number) {
    const path = lane.road.path;
    const L = path.length;
    const raw = lane.s0 + lane.dir * offset;
    const s = path.closed ? mod(raw, L) : clamp(raw, 0, L);
    const [x, y] = pointAt(path, s);
    const h = headingAt(path, s);
    // Beyond the end of a line road (a car's tail before it), carry on straight.
    const over = path.closed ? 0 : raw - s;
    this.pose.x = x - Math.sin(h) * lane.lateral + Math.cos(h) * over;
    this.pose.y = y + Math.cos(h) * lane.lateral + Math.sin(h) * over;
    this.pose.z = profileZ(this.world.roads.profiles.get(lane.road.id)!, s);
    this.pose.h = h + (lane.dir < 0 ? Math.PI : 0);
    return this.pose;
  }

  private segPose(seg: Seg, offset: number) {
    if (seg.kind === "lane") return this.lanePose(seg, offset);
    if (seg.kind === "away") return this.lanePose(seg.back, 0);
    const { pts, cum } = seg;
    const N = cum.length - 1;
    const d = clamp(offset, 0, cum[N]);
    let i = 0;
    while (i < N - 1 && cum[i + 1] < d) i++;
    const u = cum[i + 1] > cum[i] ? (d - cum[i]) / (cum[i + 1] - cum[i]) : 0;
    const k = i * 3;
    this.pose.x = pts[k] + (pts[k + 3] - pts[k]) * u;
    this.pose.y = pts[k + 1] + (pts[k + 4] - pts[k + 1]) * u;
    this.pose.z = pts[k + 2] + (pts[k + 5] - pts[k + 2]) * u;
    this.pose.h = Math.atan2(pts[k + 4] - pts[k + 1], pts[k + 3] - pts[k]);
    return this.pose;
  }

  // -- spawning -------------------------------------------------------------------

  private spawn(): void {
    const layout = this.world.layout;
    const total = this.lanes.reduce((a, l) => a + l.length, 0);
    if (!total) return;
    const roadLength = [...this.world.roads.roads.values()].reduce((a, r) => a + r.path.length, 0);
    const want = layout.traffic.cars ?? Math.min(AUTO_MAX, Math.round(roadLength / AUTO_SPACING));
    const objects = this.world.objects;
    for (let k = 0; k < want; k++) {
      const object = pick(this.r, layout.traffic.vehicles);
      const mesh = objects.get(object)!.mesh;
      const length = Math.max(1, mesh.max[0] - mesh.min[0]);
      let placed = false;
      for (let attempt = 0; attempt < 40 && !placed; attempt++) {
        let x = this.r() * total;
        const lane = this.lanes.find((l) => (x -= l.length) < 0) ?? this.lanes[this.lanes.length - 1];
        if (lane.length < length + 2) continue;
        const d = range(this.r, length, lane.length);
        if (lane.crossings.some((c) => d > c.stop - 2 && d - length < c.zoneEnd + 2)) continue;
        const clash = this.cars.some((o) => o.path[0] === lane && Math.abs(o.d - d) < Math.max(o.length, length) + SPAWN_GAP);
        if (clash) continue;
        const car: Car = {
          index: this.cars.length, object, length, centre: (mesh.max[0] + mesh.min[0]) / 2, pace: range(this.r, 0.85, 1.02),
          path: [lane], d, trail: [], speed: 0, held: [], asking: null, request: NaN, hidden: false, awayLeft: 0,
          stopped: 0, odometer: 0, maxWait: 0,
        };
        this.plan(car);
        this.cars.push(car);
        placed = true;
      }
      if (!placed) this.unplaced++;
    }
  }

  /** Extends a car's path at least LOOK metres ahead, choosing turns at random. */
  private plan(car: Car): void {
    let ahead = car.path.reduce((a, s) => a + s.length, 0) - car.d;
    while (ahead < LOOK && car.path.length < 8) {
      const last = car.path[car.path.length - 1] as Lane;
      if (last.end === null) {
        car.path.push(last);
        ahead += last.length;
        continue;
      }
      // Straight on is twice as likely as a turn.
      const weights = last.next.map((l) => (l.road === last.road && l.dir === last.dir ? 2 : 1));
      let x = this.r() * weights.reduce((a, b) => a + b, 0);
      const to = last.next.find((_, i) => (x -= weights[i]) < 0) ?? last.next[last.next.length - 1];
      const via = this.turn(last, to);
      car.path.push(via, to);
      ahead += via.length + to.length;
    }
  }

  // -- per tick ---------------------------------------------------------------------

  /** Distance ahead a train must stop by because of crossings that are not closed. */
  gateStop(t: Train, planIndex: number): number {
    let limit = Infinity;
    const L = t.plan.route.length;
    for (const g of this.planGates[planIndex]) {
      if (this.closed[g.gate]) continue;
      const stopR = g.r - t.dir * (this.gates[g.gate].half + GATE_MARGIN);
      let d = (stopR - t.r) * t.dir;
      if (t.plan.route.closed) d = mod(d + L / 2, L) - L / 2;
      // A train standing at the stop point stays there; one well past it is already committed.
      if (d >= -1 && d < limit) limit = Math.max(0, d);
    }
    return limit;
  }

  /** Advances crossings (given where the trains are) and then the cars. */
  step(trains: Train[], planIndex: (t: Train) => number, dt: number): void {
    this.time += dt;
    this.occupy();
    for (const g of this.gates) g.want = false;
    for (const t of trains) {
      const L = t.plan.route.length;
      const brake = (t.speed * t.speed) / (2 * t.plan.type.decel);
      for (const pg of this.planGates[planIndex(t)]) {
        const g = this.gates[pg.gate];
        const behind = t.plan.length + g.half + TAIL_CLEAR;
        let ahead = (pg.r - t.r) * t.dir;
        if (t.plan.route.closed) ahead = mod(ahead + behind, L) - behind;
        if (ahead < -behind) continue;
        const toStop = ahead - g.half - GATE_MARGIN;
        // Over it, or too close to stop comfortably without it closing in time, or arriving soon.
        const warning = WARN + LOWER + SLACK;
        if (ahead < 0 || toStop < brake + t.speed * warning + MIN_APPROACH || this.eta(t, toStop) <= warning) g.wantedAt = this.time;
      }
    }
    for (const g of this.gates) g.want = this.time - g.wantedAt < HOLD;
    // Each group of crossings changes state together: wanted if any is, lowered once all are clear.
    for (const members of this.groups) {
      const i = members[0];
      const lead = this.gates[i];
      this.stepGate(lead, members.some((k) => this.gates[k].want), () => members.every((k) => this.zoneClear(k)), dt);
      for (const k of members) {
        const g = this.gates[k];
        if (k !== i) Object.assign(g, { state: lead.state, t: lead.t, barrier: lead.barrier, closedFor: lead.closedFor });
        this.closed[k] = g.state === "closed" ? 1 : 0;
      }
    }
    this.stepCars(dt);
  }

  /**
   * Pessimistic time for a train to cover `dist` metres: after any dwell still to
   * come, accelerating from its current speed to the highest speed the line allows
   * (ignoring stops and signals on the way).
   */
  private eta(t: Train, dist: number): number {
    let time = t.phase === "dwelling" ? t.dwellLeft : 0;
    let v = t.speed;
    const limit = WARN + LOWER + SLACK;
    for (let x = 0; x < dist && time <= limit; x += ETA_STEP) {
      const ds = Math.min(ETA_STEP, dist - x);
      const v2 = Math.min(Math.max(curveLimit(t.plan, t.r + t.dir * x), 1), Math.sqrt(v * v + 2 * t.plan.type.accel * ds));
      time += ds / Math.max((v + v2) / 2, 0.5);
      v = v2;
    }
    return time;
  }

  private stepGate(g: Gate, want: boolean, clear: () => boolean, dt: number): void {
    g.t += dt;
    const go = (s: GateState) => { g.state = s; g.t = 0; };
    switch (g.state) {
      case "open":
        if (want) { go("warning"); g.closures++; }
        break;
      case "warning":
        if (!want) go("open");
        else if (g.t >= WARN && clear()) go("lowering");
        break;
      case "lowering":
        g.barrier = Math.min(1, g.barrier + dt / LOWER);
        if (g.barrier >= 1) go("closed");
        else if (!want) go("raising");
        break;
      case "closed":
        if (!want) go("raising");
        break;
      case "raising":
        g.barrier = Math.max(0, g.barrier - dt / RAISE);
        if (want && clear()) go("lowering");
        else if (g.barrier <= 0) go("open");
        break;
    }
    if (g.state !== "open") g.closedFor += dt;
  }

  /** No car between a crossing's stop lines and the far side of its zone. */
  private zoneClear(gate: number): boolean {
    for (const lane of this.lanes) {
      for (const c of lane.crossings) {
        if (c.gate !== gate) continue;
        for (const o of this.occ.get(lane) ?? []) if (o.front > c.stop + 0.1 && o.rear < c.zoneEnd) return false;
      }
    }
    return true;
  }

  /** Which stretch of which segment every visible car's body covers. */
  private occupy(): void {
    for (const list of this.occ.values()) list.length = 0;
    const add = (seg: Seg, o: Occupant) => {
      let list = this.occ.get(seg);
      if (!list) this.occ.set(seg, (list = []));
      list.push(o);
    };
    for (const car of this.cars) {
      if (car.hidden) continue;
      const seg = car.path[0];
      add(seg, { car, front: Math.min(car.d, seg.length), rear: Math.max(0, car.d - car.length) });
      let left = car.length - car.d;
      for (const t of car.trail) {
        if (left <= 0) break;
        add(t, { car, front: t.length, rear: Math.max(0, t.length - left) });
        left -= t.length;
      }
    }
  }

  private stepCars(dt: number): void {
    this.grantJunctions();
    for (const car of this.cars) {
      if (car.hidden) { this.stepAway(car, dt); continue; }
      const v = this.control(car);
      car.speed = car.speed < v ? Math.min(v, car.speed + ACCEL * dt) : v;
      this.advance(car, car.speed * dt);
      if (car.speed < 0.05) {
        car.stopped += dt;
        car.maxWait = Math.max(car.maxWait, car.stopped);
      } else car.stopped = 0;
    }
  }

  /** Junctions go to one car at a time, longest waiting first, and only if it can get clear beyond. */
  private grantJunctions(): void {
    const asking = this.cars.filter((c) => !c.hidden && c.asking).sort((a, b) => a.request - b.request || a.index - b.index);
    for (const car of asking) {
      let turn = car.asking!;
      if (this.holder[turn.node] !== -1) continue;
      if (this.roomBeyond(car, turn) < car.length + MIN_GAP) {
        // Kept waiting because the way it chose is full: take another way out if one has room.
        if (this.time - car.request < REROUTE_AFTER || !this.reroute(car, turn)) continue;
        turn = car.asking!;
        if (this.roomBeyond(car, turn) < car.length + MIN_GAP) continue;
      }
      this.holder[turn.node] = car.index;
      car.held.push(turn);
      car.asking = null;
      car.request = NaN;
    }
  }

  /** Replaces the car's way out of a junction with another that has room; false if none has. */
  private reroute(car: Car, turn: Turn): boolean {
    const k = car.path.indexOf(turn);
    const lane = car.path[k - 1] as Lane;
    const need = car.length + MIN_GAP;
    let best: Lane | null = null;
    let bestRoom = need;
    for (const to of lane.next) {
      if (to === turn.to) continue;
      const room = this.exitRoom(to);
      if (room >= bestRoom && to.length >= need) { best = to; bestRoom = room; }
    }
    if (!best) return false;
    const via = this.turn(lane, best) as Turn;
    car.path.length = k;
    car.path.push(via, best);
    this.plan(car);
    car.asking = via;
    return true;
  }

  /**
   * Free road beyond a junction along the car's planned path: up to the first car,
   * a crossing that is not open, or the stop line of the next junction. Short lanes
   * (a dead end just past a junction) count together with what follows them.
   */
  private roomBeyond(car: Car, turn: Turn): number {
    const need = car.length + MIN_GAP;
    let cum = 0;
    for (let k = car.path.indexOf(turn) + 1; k < car.path.length; k++) {
      const seg = car.path[k];
      if (seg.kind === "away") return Infinity;
      if (seg.kind === "turn" && seg.junction) return cum;
      let room = seg.length;
      for (const o of this.occ.get(seg) ?? []) if (o.car !== car) room = Math.min(room, o.rear);
      if (seg.kind === "lane") for (const c of seg.crossings) if (this.gates[c.gate].state !== "open") room = Math.min(room, c.stop);
      if (room < seg.length || cum + room >= need) return cum + room;
      cum += seg.length;
    }
    return cum;
  }

  /** Free road at the start of a lane: up to the first car or a crossing that is not open. */
  private exitRoom(lane: Lane): number {
    let room = lane.length;
    for (const o of this.occ.get(lane) ?? []) room = Math.min(room, o.rear);
    for (const c of lane.crossings) if (this.gates[c.gate].state !== "open") room = Math.min(room, c.stop);
    return room;
  }

  private stepAway(car: Car, dt: number): void {
    car.awayLeft -= dt;
    const away = car.path[0] as Away;
    if (car.awayLeft > 0 || this.exitRoom(away.back) < car.length + MIN_GAP + 2) return;
    car.path.shift();
    car.d = Math.min(car.length, away.back.length);
    car.trail = [];
    car.hidden = false;
    car.speed = 0;
    this.plan(car);
    // Claim the space now, so a second car coming back this tick waits.
    const list = this.occ.get(away.back) ?? [];
    list.push({ car, front: car.d, rear: Math.max(0, car.d - car.length) });
    this.occ.set(away.back, list);
  }

  /** The highest speed the car may have this tick. */
  private control(car: Car): number {
    const v = car.speed;
    const lane0 = car.path[0];
    let cap = lane0.kind === "lane" ? lane0.limit[Math.min(lane0.limit.length - 1, Math.round(car.d / SPEED_STEP))] * car.pace : (lane0 as Turn).speed;
    const stopAt = (rel: number) => {
      const c = rel <= ARRIVE ? 0 : Math.max(Math.sqrt(2 * DECEL * rel), Math.min(CREEP, rel / 0.2));
      cap = Math.min(cap, c);
    };
    const slowTo = (vt: number, rel: number) => { cap = Math.min(cap, Math.sqrt(vt * vt + 2 * DECEL * Math.max(0, rel))); };
    const brake = (v * v) / (2 * DECEL);

    // Obstacles along the planned path: the car ahead, and anything queueing beyond a crossing.
    const obstacles: Array<{ rel: number; speed: number }> = [];
    let cum = -car.d;
    for (let k = 0; k < car.path.length && cum < LOOK + 20; k++) {
      const seg = car.path[k];
      for (const o of this.occ.get(seg) ?? []) {
        if (o.car === car || (k === 0 && o.front <= car.d + 1e-3)) continue;
        obstacles.push({ rel: cum + o.rear, speed: o.car.speed });
      }
      cum += seg.length;
    }
    obstacles.sort((a, b) => a.rel - b.rel);
    const leader = obstacles[0];
    if (leader) {
      const gap = leader.rel - MIN_GAP;
      cap = Math.min(cap, Math.sqrt(leader.speed * leader.speed + 2 * DECEL * Math.max(0, gap)),
        Math.max(0, leader.speed + FOLLOW_GAIN * (gap - HEADWAY * leader.speed)));
      if (gap <= ARRIVE) cap = 0;
    }

    // Stop lines, slower stretches and turns ahead.
    cum = -car.d;
    let clear = true;                                       // nothing holds the car before the next junction
    for (let k = 0; k < car.path.length && cum < LOOK; k++) {
      const seg = car.path[k];
      if (seg.kind === "lane") {
        for (let i = Math.max(0, Math.ceil((k === 0 ? car.d : 0) / SPEED_STEP)); i < seg.limit.length; i++) {
          const rel = cum + i * SPEED_STEP;
          if (rel > brake + 20) break;
          slowTo(seg.limit[i] * car.pace, rel);
        }
        for (const c of seg.crossings) {
          if (!c.lead) continue;                           // inside the group's zone: committed already
          const stop = cum + c.stop;
          if (stop < -0.1) continue;                      // already past the stop line: carry on
          const g = this.gates[c.gate];
          let halt = g.state !== "open";
          if (g.state === "warning" && stop < (v * v) / (2 * HARD_DECEL)) halt = false;
          // Don't stop on the crossing: wait until there is room beyond it.
          if (!halt) halt = obstacles.some((o) => o.rel > cum + c.stop && o.rel < cum + c.zoneEnd + car.length + MIN_GAP && o.speed < QUEUED);
          if (halt) { stopAt(stop); clear = false; }
        }
      } else if (seg.kind === "away") {
        break;                                             // off the board: nothing beyond matters yet
      } else if (seg.kind === "turn") {
        slowTo(seg.speed, cum);
        if (seg.junction && !car.held.includes(seg)) {
          // Ask for the junction when close, first in the queue and not held up before it.
          if (clear && cum < brake + LOCK_REACH && (!leader || leader.rel > cum)) {
            if (car.asking !== seg) { car.asking = seg; car.request = this.time; }
          }
          stopAt(cum - 0.5);
          break;                                           // nothing beyond a junction we don't hold matters yet
        }
      }
      cum += seg.length;
    }
    return Math.max(0, cap);
  }

  private advance(car: Car, move: number): void {
    car.d += move;
    car.odometer += move;
    while (car.path.length > 1 && car.d >= car.path[0].length && car.path[0].kind !== "away") {
      car.d -= car.path[0].length;
      car.trail.unshift(car.path.shift()!);
      if (car.trail.length > 3) car.trail.length = 3;
      if ((car.path[0] as Seg).kind === "away") {
        car.hidden = true;
        car.asking = null;
        car.request = NaN;
        car.awayLeft = range(this.r, AWAY[0], AWAY[1]);
        car.d = 0;
        car.speed = 0;
        for (const t of car.held) this.release(car, t);
        return;
      }
    }
    // Hand the junction back once the whole car is through it.
    for (const held of car.held) {
      if (car.path.includes(held)) continue;
      let left = car.length - car.d;
      let inside = false;
      for (const t of car.trail) {
        if (left <= 0) break;
        if (t === held) inside = true;
        left -= t.length;
      }
      if (!inside) this.release(car, held);
    }
    this.plan(car);
  }

  private release(car: Car, turn: Turn): void {
    if (this.holder[turn.node] === car.index) this.holder[turn.node] = -1;
    car.held = car.held.filter((t) => t !== turn);
  }

  // -- output ---------------------------------------------------------------------

  /** Pose of a point `back` metres behind the car's front, walking back over its trail. */
  private along(car: Car, back: number) {
    let off = car.d - back;
    if (off >= 0 || !car.trail.length) return this.segPose(car.path[0], off);
    for (const t of car.trail) {
      off += t.length;
      if (off >= 0) return this.segPose(t, off);
    }
    return this.segPose(car.trail[car.trail.length - 1], 0);
  }

  snapshotCars(out: VehicleSnapshot[]): VehicleSnapshot[] {
    this.cars.forEach((car, i) => {
      const s = out[i] ?? (out[i] = { object: car.object, x: 0, y: 0, z: 0, heading: 0, pitch: 0, visible: true });
      s.object = car.object;
      s.visible = !car.hidden;
      if (car.hidden) return;
      const a = this.along(car, car.length * 0.2);
      const ax = a.x, ay = a.y, az = a.z;
      const b = this.along(car, car.length * 0.8);
      const h = Math.atan2(ay - b.y, ax - b.x);
      const mx = (ax + b.x) / 2 - Math.cos(h) * car.centre;
      const my = (ay + b.y) / 2 - Math.sin(h) * car.centre;
      s.x = mx; s.y = my; s.z = (az + b.z) / 2;
      s.heading = h;
      s.pitch = Math.atan2(az - b.z, Math.hypot(ax - b.x, ay - b.y));
    });
    out.length = this.cars.length;
    return out;
  }

  snapshotGates(out: GateSnapshot[]): GateSnapshot[] {
    const flash = Math.floor(this.time * 1.6) % 2 === 0;
    this.gates.forEach((g, i) => {
      const s = out[i] ?? (out[i] = { id: g.crossing.id, state: g.state, barrier: 0, lights: false });
      s.id = g.crossing.id;
      s.state = g.state;
      s.barrier = g.barrier;
      s.lights = g.state !== "open" && flash;
    });
    out.length = this.gates.length;
    return out;
  }

  stats(): TrafficStats {
    const n = this.cars.length;
    return {
      cars: n,
      unplaced: this.unplaced,
      avgSpeed: n ? this.cars.reduce((a, c) => a + c.odometer, 0) / n / Math.max(this.time, 1e-9) : 0,
      maxWait: this.cars.reduce((a, c) => Math.max(a, c.maxWait), 0),
      stuck: this.cars.filter((c) => c.stopped > STUCK_AFTER).length,
      closures: this.gates.reduce((a, g) => a + g.closures, 0),
      closedShare: this.gates.length ? this.gates.reduce((a, g) => a + g.closedFor, 0) / this.gates.length / Math.max(this.time, 1e-9) : 0,
    };
  }

  /** For tests: pairs of cars whose bodies overlap on some lane or turn. */
  overlapping(): number {
    this.occupy();
    let n = 0;
    for (const list of this.occ.values()) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const [a, b] = [list[i], list[j]];
          if (a.car !== b.car && a.rear < b.front - 1e-6 && b.rear < a.front - 1e-6) n++;
        }
      }
    }
    return n;
  }

  /** For tests: whether any car body is within a crossing's zone. */
  carOnCrossing(gate: number): boolean {
    this.occupy();
    const g = this.gates[gate];
    for (const lane of this.lanes) {
      for (const c of lane.crossings) {
        if (c.gate !== gate) continue;
        const at = (c.stop + STOP_GAP + c.zoneEnd) / 2;
        const zone = g.crossing.zone;
        for (const o of this.occ.get(lane) ?? []) if (o.front > at - zone && o.rear < at + zone) return true;
      }
    }
    return false;
  }
}
