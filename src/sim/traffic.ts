// Road traffic and level crossings. Cars drive on the right along lanes between
// road nodes, keep their distance to the car ahead and pass junctions one at a
// time, never stopping where they would block a junction or a crossing. Through
// traffic picks turns at random; residents' cars stand in parking bays until their
// owner drives them along a planned route to another bay, pulling out when there
// is a gap and turning in at the end — or out over the board's edge, to an
// off-layout place, and back. Buses go round their line's route, stopping in their
// lane at each stop while people get on and off (and calling at off-layout places
// out of sight beyond the edge). Level crossings warn, lower their barriers
// once the road is clear and stay closed while a train is near; trains stop short
// of a crossing that is not closed. Pure TypeScript, deterministic from the seed.

import type { World } from "../model/build";
import { throughTraffic } from "../model/build";
import { PULL_OUT } from "../model/town";
import { type BusLineGeom, DOOR_BACK, OFF_BUS_SPEED, roadExits } from "../model/buses";
import { type RoadGeom, type RoadNode, type LevelCrossing, isPortal, laneTopology, nextNode } from "../model/roads";
import { type Plan, curveLimit } from "./services";
import { type Train, approach } from "./trains";
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
const SHORT_GAP = 60;           // m: crossings along a lane with less road than this between them are one to the cars
const ZEBRA_GAP = 1.0;          // m between a zebra's stop line and its stripes
const LOCK_REACH = 8;           // m beyond braking distance at which a car asks for a junction
const REROUTE_AFTER = 4;        // s waiting for room beyond a junction before trying another way
const QUEUED = 2;               // m/s: slower than this, the car ahead counts as queueing
const AWAY: [number, number] = [4, 16];   // s a car stays off the board
const SPAWN_GAP = 10;           // m between spawned cars, beyond their length
const STUCK_AFTER = 120;        // s stationary before a car counts as stuck
const BAY_SPEED = 2.5;          // m/s turning into or out of a bay
const REVERSE_SPEED = 1.4;      // m/s backing out of a nose-in bay
const MERGE_PATIENCE = 30;      // s waiting to pull out before accepting a shorter gap
const TURN_IN = 6;              // m before a parallel bay where a car leaves the lane (nose-in: TURN_IN_NOSE)
const TURN_IN_NOSE = 3.5;
const HOLD_SHARE = 0.6;         // a bus closer than this share of the even spacing behind the next waits at its stop
const MAX_HOLD = 45;            // s at most that it waits for that

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
const OFF_LOOKAHEAD = 60;       // s before a train comes back on the board that the crossings start to count it

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
  // Level crossings as lane offsets: stop line, centre and the far end of the zone.
  // Crossings of a group (see Gate.group), or with too little road between them for a
  // queue, are one to the cars: only the first (the lead) is a place to stop, for all of
  // their gates, and its zone runs to the end of the last. `from` is the lead's stop
  // line: a car past it is committed to every crossing up to `zoneEnd`.
  crossings: Array<{ gate: number; stop: number; at: number; zoneEnd: number; lead: boolean; from: number; gates: number[] }>;
  // Where people cross this lane (see WalkNet.crossings): stop line and far edge, as lane offsets.
  zebras: Array<{ c: number; stop: number; zoneEnd: number }>;
  next: Lane[];                 // lanes a car may take at the end
};

/** What traffic needs to know about the people (see sim/walkers.ts). */
export type WalkerView = {
  busy: Uint8Array;             // per road crossing: cars must give way there
  inGate(gate: number): boolean;   // someone within a level or foot crossing's zone
};
type Turn = { kind: "turn"; node: number; junction: boolean; to: Lane; length: number; speed: number; pts: Float64Array; cum: Float64Array };
type Away = { kind: "away"; node: number; back: Lane; length: number };
/**
 * Into a parking bay from a lane (`into`), or out of one on to it. Out of a nose-in
 * bay the car backs out (`reverse`: the path is its rear's); `laneD` is where its
 * front is on the lane when it leaves the lane (into) or joins it (out).
 */
type BaySeg = {
  kind: "bay"; bay: number; into: boolean; reverse: boolean; lane: Lane; laneD: number;
  length: number; speed: number; pts: Float64Array; cum: Float64Array;
};
/**
 * Off the board: past the end of the lane into exit node `node`, `total` s of travel
 * out of sight — a bus calls at off-layout places on the way (`calls`, s into the
 * run) — then back on along `back`; a car leaving for an off-layout place (`back`
 * null) stays out there, parked at `place`.
 */
type OffSeg = {
  kind: "off"; node: number; back: Lane | null; length: number; calls: Array<{ at: number; visit: number }>; total: number; place: number;
};
type Seg = Lane | Turn | Away | BaySeg | OffSeg;
export type { Lane as TrafficLane };

type Car = {
  index: number;
  owner: number;                // person whose car it is, -1 for through traffic and buses
  offT: number;                 // s travelled on its current run off the board
  offPlace: number;             // the off-layout place where it is parked (state "off"), else -1
  line: number;                 // the bus line it serves (index into world.buses.lines), -1 if not a bus
  seqPos: number;               // bus: its line's itinerary entry that the end of its path is
  nextVisit: number;            // bus: the visit (index into the line's visits) it calls at next
  dwelling: boolean;            // bus: standing at a stop
  dwellLeft: number;            // s still to stand there
  heldFor: number;              // s kept at the stop beyond its dwell to even out the gaps between buses
  stopCount: number;            // bus: stops made (the people serve each once)
  skipped: number;              // bus: stops passed without stopping (should stay 0)
  // leaving: in its bay, waiting for a gap to pull out; off: parked at an off-layout place;
  // entering: on its way back from one, out of sight, then waiting for room to come on to the board
  state: "driving" | "parked" | "leaving" | "off" | "entering";
  bay: number;                  // bay while parked or leaving, else -1
  goal: number;                 // bay it is driving to, -1 for through traffic
  exitD: number;                // where its front leaves the last lane for the goal bay
  waitMerge: number;            // s waiting to pull out
  reversing: boolean;
  enterD: number;               // where it joined path[0] (part-way along a lane after pulling out), else 0
  trailLen: number[];           // how much of each trail segment it drove (its end, for the last lane before a bay)
  object: string;
  length: number;
  width: number;
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

type Occupant = { car: Car; front: number; rear: number; virtual?: boolean };

export type VehicleSnapshot = {
  object: string; x: number; y: number; z: number; heading: number; pitch: number; visible: boolean;
  color: string | null;         // a bus's line colour (other vehicles: null, a colour picked per vehicle)
};
export type GateSnapshot = { id: string; state: GateState; barrier: number; lights: boolean };
export type TrafficStats = {
  cars: number;                 // through traffic
  buses: number;
  busStops: number;             // stops made by buses in all
  busSkipped: number;           // stops buses drove past (0 unless something went wrong)
  own: number;                  // residents' cars
  driving: number;              // residents' cars on the road now
  ownDistance: number;          // m driven by residents' cars in all
  unplaced: number; avgSpeed: number; maxWait: number; stuck: number; closures: number; closedShare: number;
};

export class Traffic {
  readonly cars: Car[] = [];
  /** Cars that came to rest in their goal bay this tick (the people read and clear it). */
  readonly arrivals: number[] = [];
  /** Each resident's car index, or -1. */
  readonly carOf: Int32Array;
  /** The lane serving each parking bay and the bay's offset along it (null: no lane reaches it). */
  bayAt: Array<{ lane: Lane; d: number } | null> = [];
  /** Which car stands in each bay (or is driving to it), -1 if free. */
  readonly bayCar: Int32Array;
  /** Each bus line's itinerary (lanes and turns round and round, with its stops) and its buses' car indices. */
  readonly lines: Array<{
    geom: BusLineGeom;
    seq: Array<{ seg: Seg; stops: Array<{ d: number; visit: number }> }>;
    cum: number[];              // m from the itinerary's start to each entry's
    total: number;              // m round the itinerary
    visitAt: number[];          // m from the start to each visit's stop
    buses: number[];
  }> = [];
  /** Buses that could not be placed at the start. */
  busesUnplaced = 0;
  readonly gates: Gate[] = [];
  readonly closed: Uint8Array;
  unplaced = 0;
  private lanes: Lane[] = [];
  private laneByKey = new Map<string, Lane>();
  private topo = new Map<string, ReturnType<typeof laneTopology>[number]>();
  private turns = new Map<string, Turn>();
  private aways = new Map<number, Away>();
  private holder: Int32Array;
  private occ = new Map<Seg, Occupant[]>();
  private planGates: Array<Array<{ gate: number; r: number }>>;
  private groups: number[][] = [];          // gate indices per group, the group's lead first
  private r: Rng;
  private time = 0;
  private world: World;
  /** The people, once the sim attaches them. */
  walkers: WalkerView | null = null;

  constructor(world: World, plans: Plan[], seed: number) {
    this.world = world;
    this.r = rng(seed, "traffic");
    const net = world.roads;
    this.holder = new Int32Array(net.nodes.length).fill(-1);
    // Road level crossings first, then foot crossings (paths over tracks): the order of SimSnapshot.gates.
    for (const c of [...net.crossings, ...world.walks.footCrossings]) {
      const half = c.width / 2 / Math.max(Math.sin((c.angle * Math.PI) / 180), 0.25) + 1;
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
    this.carOf = new Int32Array(world.town.people.length).fill(-1);
    this.bayCar = new Int32Array(world.town.bays.length).fill(-1);
    this.buildLanes();
    this.mapBays();
    this.buildLines();
    this.spawnBuses();
    this.spawn();
    this.parkOwnCars();
  }

  /** The lanes (for the route planner). */
  get laneList(): readonly Lane[] {
    return this.lanes;
  }

  /** For each road exit (world.offLayout.exits id): the lane coming on to the board there and the lanes leaving by it. */
  roadExitLanes(): Map<number, { enter: Lane | null; leave: Lane[] }> {
    const out = new Map<number, { enter: Lane | null; leave: Lane[] }>();
    for (const [e, x] of roadExits(this.world.roads, this.world.offLayout, this.topo)) {
      out.set(e, { enter: x.enter ? this.laneByKey.get(x.enter)! : null, leave: x.leave.map((k) => this.laneByKey.get(k)!) });
    }
    return out;
  }

  /** Lanes a car may take after `lane` without leaving the board. */
  nextLanes(lane: Lane): Lane[] {
    if (lane.end === null) return [lane];
    const n = this.world.roads.nodes[lane.end];
    return n.legs.length === 1 && this.portal(n) ? [] : lane.next;
  }

  /** Each bay's lane: the one on its side driving the way a parked car faces. */
  private mapBays(): void {
    this.bayAt = this.world.town.bays.map((b) => {
      const dir: 1 | -1 = b.side > 0 ? -1 : 1;
      for (const lane of this.lanes) {
        if (lane.road.id !== b.road || lane.dir !== dir) continue;
        const L = lane.road.path.length;
        let d = (b.s - lane.s0) * dir;
        if (lane.road.path.closed) d = mod(d, L);
        if (d >= 1 && d <= lane.length - 1) return { lane, d };
      }
      return null;
    });
  }

  /** Residents' cars, parked in their bays. */
  private parkOwnCars(): void {
    for (const p of this.world.town.people) {
      if (!p.car || !this.bayAt[p.car.bay] || this.bayCar[p.car.bay] >= 0) continue;
      const car = this.newCar(p.car.object, []);
      car.owner = p.id;
      car.state = "parked";
      car.bay = p.car.bay;
      this.cars.push(car);
      this.carOf[p.id] = car.index;
      this.bayCar[p.car.bay] = car.index;
    }
  }

  private newCar(object: string, path: Seg[]): Car {
    const mesh = this.world.objects.get(object)!.mesh;
    return {
      index: this.cars.length, owner: -1, offT: 0, offPlace: -1, line: -1, seqPos: 0, nextVisit: 0, dwelling: false, dwellLeft: 0, heldFor: 0, stopCount: 0, skipped: 0,
      state: "driving", bay: -1, goal: -1, exitD: NaN, waitMerge: 0, reversing: false, enterD: 0, trailLen: [],
      object, length: Math.max(1, mesh.max[0] - mesh.min[0]), width: mesh.max[1] - mesh.min[1], centre: (mesh.max[0] + mesh.min[0]) / 2, pace: range(this.r, 0.85, 1.02),
      path, d: 0, trail: [], speed: 0, held: [], asking: null, request: NaN, hidden: false, awayLeft: 0, stopped: 0, odometer: 0, maxWait: 0,
    };
  }

  // -- residents' driving ----------------------------------------------------------

  /**
   * Sends a resident's car along `lanes` to bay `goal` (reserved for it), or (goal
   * −1 − p) off the board by the exit the last lane runs into, `offOut` s on to
   * off-layout place p. A car in a bay pulls out once there is a gap; one parked off
   * the board travels `offIn` s back to the edge and comes on at the first lane's start.
   */
  drive(ci: number, lanes: Lane[], goal: number, offIn = 0, offOut = 0): void {
    const car = this.cars[ci];
    const fromOff = car.state === "off";
    const path: Seg[] = fromOff ? [] : [this.outSeg(car, car.bay, this.bayAt[car.bay]!)];
    lanes.forEach((lane, k) => {
      if (k > 0) path.push(this.turn(lanes[k - 1], lane));
      path.push(lane);
    });
    if (goal >= 0) {
      const into = this.inSeg(car, goal, this.bayAt[goal]!);
      path.push(into);
      car.exitD = into.laneD;
      this.bayCar[goal] = ci;
    } else {
      path.push({ kind: "off", node: lanes[lanes.length - 1].end!, back: null, length: 0, calls: [], total: offOut, place: -1 - goal });
      car.exitD = NaN;
    }
    car.path = path;
    car.goal = goal;
    car.waitMerge = 0;
    car.d = 0;
    car.trail = [];
    car.trailLen = [];
    if (fromOff) {
      car.state = "entering";
      car.awayLeft = offIn;
      car.offPlace = -1;
    } else car.state = "leaving";
  }

  /** Where the front of a car `length` m long, pulling out of bay `bay`, is when it joins the lane. */
  pullOutD(bay: number, length = 4.5): number {
    const at = this.bayAt[bay]!;
    const b = this.world.town.bays[bay];
    return b.style === "parallel" ? Math.min(at.d + PULL_OUT, at.lane.length - 0.3)
      : Math.min(Math.max(0.3, at.d - 1.5) + length, at.lane.length - 0.1);
  }

  /** Where a car heading for bay `bay` leaves its lane. */
  turnInD(bay: number): number {
    const at = this.bayAt[bay]!;
    const b = this.world.town.bays[bay];
    return Math.max(0.3, at.d - (b.style === "parallel" ? TURN_IN : TURN_IN_NOSE));
  }

  private bezier(p0: number[], p1: number[], p2: number[], p3: number[]): { pts: Float64Array; cum: Float64Array } {
    const N = 16;
    const pts = new Float64Array((N + 1) * 3);
    const cum = new Float64Array(N + 1);
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const [a, b, c, d] = [(1 - t) ** 3, 3 * t * (1 - t) ** 2, 3 * t * t * (1 - t), t ** 3];
      for (let k = 0; k < 3; k++) pts[i * 3 + k] = a * p0[k] + b * p1[k] + c * p2[k] + d * p3[k];
      if (i > 0) cum[i] = cum[i - 1] + Math.hypot(pts[i * 3] - pts[i * 3 - 3], pts[i * 3 + 1] - pts[i * 3 - 2]);
    }
    return { pts, cum };
  }

  private outSeg(car: Car, bay: number, at: { lane: Lane; d: number }): BaySeg {
    const b = this.world.town.bays[bay];
    const [bc, bs] = [Math.cos(b.heading), Math.sin(b.heading)];
    const half = car.length / 2;
    const laneD = this.pullOutD(bay, car.length);
    if (b.style === "parallel") {
      const q = { ...this.lanePose(at.lane, laneD) };
      const f = [b.x + bc * half, b.y + bs * half, b.z];
      const { pts, cum } = this.bezier(f, [f[0] + bc * 2.5, f[1] + bs * 2.5, f[2]],
        [q.x - Math.cos(q.h) * 3, q.y - Math.sin(q.h) * 3, q.z], [q.x, q.y, q.z]);
      return { kind: "bay", bay, into: false, reverse: false, lane: at.lane, laneD, length: cum[cum.length - 1], speed: BAY_SPEED, pts, cum };
    }
    // Back out: the rear swings upstream so the car ends up facing along the lane.
    const r1 = { ...this.lanePose(at.lane, laneD - car.length) };
    const r0 = [b.x - bc * half, b.y - bs * half, b.z];
    const { pts, cum } = this.bezier(r0, [r0[0] - bc * 3, r0[1] - bs * 3, r0[2]],
      [r1.x + Math.cos(r1.h) * 3, r1.y + Math.sin(r1.h) * 3, r1.z], [r1.x, r1.y, r1.z]);
    return { kind: "bay", bay, into: false, reverse: true, lane: at.lane, laneD, length: cum[cum.length - 1], speed: REVERSE_SPEED, pts, cum };
  }

  private inSeg(car: Car, bay: number, at: { lane: Lane; d: number }): BaySeg {
    const b = this.world.town.bays[bay];
    const [bc, bs] = [Math.cos(b.heading), Math.sin(b.heading)];
    const laneD = this.turnInD(bay);
    const e = { ...this.lanePose(at.lane, laneD) };
    const t = [b.x + bc * car.length / 2, b.y + bs * car.length / 2, b.z];
    const back = b.style === "parallel" ? car.length * 0.6 : car.length;
    const { pts, cum } = this.bezier([e.x, e.y, e.z], [e.x + Math.cos(e.h) * 2.5, e.y + Math.sin(e.h) * 2.5, e.z],
      [t[0] - bc * back, t[1] - bs * back, t[2]], t);
    return { kind: "bay", bay, into: true, reverse: false, lane: at.lane, laneD, length: cum[cum.length - 1], speed: BAY_SPEED, pts, cum };
  }

  /** Room to pull out: nobody where the car will be, and nobody coming who could not stop for it. */
  private canMerge(car: Car): boolean {
    const out = car.path[0] as BaySeg;
    const lane = out.lane;
    const patient = car.waitMerge > MERGE_PATIENCE;
    // After a long wait it takes any gap just big enough, as long as whoever comes can stop.
    const a = out.laneD - car.length - (patient ? 1 : 4);
    const b = out.laneD + (patient ? 1 : 3);
    const margin = patient ? 0 : 2;
    for (const o of this.occ.get(lane) ?? []) if (o.car !== car && o.front > a - margin && o.rear < b + margin) return false;
    // Never pull out on to a crossing people are using.
    for (const z of lane.zebras) if (z.stop < b + 1 && z.zoneEnd > a - 1 && this.walkers?.busy[z.c]) return false;
    for (const other of this.cars) {
      if (other === car || other.state !== "driving" || other.hidden) continue;
      const p0 = other.path[0];
      if (p0.kind === "bay" && !p0.into && p0.lane === lane && Math.abs(p0.laneD - out.laneD) < 15) return false;
      const dist = this.distanceTo(other, lane, Math.max(0, a));
      if (dist === null) continue;
      const v = other.speed;
      if (dist < (patient ? (v * v) / (2 * DECEL) + 3 : v * 4 + 8)) return false;
    }
    return true;
  }

  /** Where the car will join path segment k (k > 0): part-way along a lane after pulling out of a bay, else 0. */
  private segStart(car: Car, k: number): number {
    const prev = k > 0 ? car.path[k - 1] : undefined;
    return prev && prev.kind === "bay" && !prev.into ? prev.laneD : 0;
  }

  /** The car's length along path segment k: its exit point on the last lane before a bay, else the segment's length. */
  private segLen(car: Car, k: number): number {
    const next = car.path[k + 1];
    return next && next.kind === "bay" && next.into ? car.exitD : car.path[k].length;
  }

  // -- network -------------------------------------------------------------------

  private portal(n: RoadNode): boolean {
    return isPortal(n, this.world.layout.terrain.size);
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
        kind: "lane", id: this.lanes.length, road, dir, s0, length, end, lateral: (-dir * road.spec.width) / 4, limit, crossings: [], zebras: [], next: [],
      };
      this.lanes.push(lane);
      return lane;
    };
    // The network's lanes, each starting and ending clear of its nodes' junction areas.
    const topo = laneTopology(net, this.world.layout.terrain.size);
    for (const t of topo) this.topo.set(t.key, t);
    for (const t of topo) {
      const road = net.roads.get(t.road)!;
      const L = road.path.length;
      const s0 = t.end === null ? t.s : road.path.closed ? mod(t.s + t.dir * t.box0, L) : t.s + t.dir * t.box0;
      this.laneByKey.set(t.key, make(road, t.dir, s0, t.end === null ? t.dist : Math.max(0.5, t.dist - t.box0 - t.box1), t.end));
    }
    for (const t of topo) this.laneByKey.get(t.key)!.next = t.next.map((k) => this.laneByKey.get(k)!);
    // Level crossings on each lane: stop line and the end of the zone, as lane offsets.
    this.gates.forEach((g, gi) => {
      const c = g.crossing;
      for (const lane of this.lanes) {
        if (c.kind !== "road" || lane.road.id !== c.road) continue;
        const L = lane.road.path.length;
        let at = (c.roadS - lane.s0) * lane.dir;
        if (lane.road.path.closed) at = mod(at, L);
        if (at < 0 || at > lane.length) continue;
        const stop = at - c.zone - STOP_GAP;
        lane.crossings.push({ gate: gi, stop, at, zoneEnd: at + c.zone, lead: true, from: stop, gates: [gi] });
      }
    });
    this.world.walks.crossings.forEach((wc, ci) => {
      for (const lane of this.lanes) {
        if (lane.road.id !== wc.road) continue;
        const L = lane.road.path.length;
        let at = (wc.roadS - lane.s0) * lane.dir;
        if (lane.road.path.closed) at = mod(at, L);
        if (at < -wc.half || at > lane.length + wc.half) continue;
        lane.zebras.push({ c: ci, stop: at - wc.half - ZEBRA_GAP, zoneEnd: at + wc.half });
      }
    });
    for (const lane of this.lanes) {
      lane.zebras.sort((a, b) => a.stop - b.stop);
      lane.crossings.sort((a, b) => a.stop - b.stop);
      let lead: Lane["crossings"][number] | null = null;
      for (const x of lane.crossings) {
        if (lead && (this.gates[lead.gate].group === this.gates[x.gate].group || x.stop - lead.zoneEnd < SHORT_GAP)) {
          x.lead = false;
          x.from = lead.stop;
          lead.zoneEnd = Math.max(lead.zoneEnd, x.zoneEnd);
          if (!lead.gates.includes(x.gate)) lead.gates.push(x.gate);
        } else lead = x;
      }
    }
  }

  /** Distance from a lane's end to its end node's centre. */
  private boxBeyond(lane: Lane): number {
    if (lane.end === null) return 0;
    const next = nextNode(this.world.roads, lane.road, lane.s0, lane.dir);
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
    if (seg.kind === "off") return seg.back ? this.lanePose(seg.back, 0) : this.pose;
    const { pts, cum } = seg as Turn | BaySeg;
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

  // -- buses -----------------------------------------------------------------------

  /**
   * Each line's itinerary: the lanes from stop to stop (with the turns between them)
   * as one repeating list, every stop marked on the lane where the bus stands.
   */
  private buildLines(): void {
    const net = this.world.buses;
    const off = this.world.offLayout;
    const exits = roadExits(this.world.roads, off, net.lanes);
    const exitAt = new Map([...exits].map(([e, x]) => [x.node, e]));
    const distance = (p: number, exit: number) => off.places[p].via.find((v) => v.exit === exit)!.distance;
    const between = (p: number, q: number) => Math.min(...off.places[p].via.flatMap((v) => off.places[q].via.filter((w) => w.exit === v.exit).map((w) => Math.abs(w.distance - v.distance))));
    for (const geom of net.lines) {
      // Round the line: lanes (with the stops in them) and off-layout places ("@p", a call there if `visit`).
      type Tok = { key: string; stops: Array<{ d: number; visit: number }>; visit: number };
      const tokOf = (v: number): Tok => {
        const side = geom.visits[v].side;
        if (side < 0) return { key: `@${-1 - side}`, stops: [], visit: v };
        const st = net.sides[side];
        return { key: st.lane, stops: [{ d: st.d - net.lanes.get(st.lane)!.box0, visit: v }], visit: -1 };
      };
      const m = geom.visits.length;
      const toks: Tok[] = [tokOf(0)];
      geom.legs.forEach((keys, i) => {
        for (let k = 1; k < keys.length; k++) toks.push({ key: keys[k], stops: [], visit: -1 });
        const to = tokOf((i + 1) % m);
        const last = toks[toks.length - 1];
        if (to.visit >= 0) last.visit = to.visit;
        else last.stops.push(...to.stops);
      });
      // The round ends where it began: the last token is the first one again.
      const end = toks.pop()!;
      toks[0].stops.unshift(...end.stops.filter((x) => x.visit !== 0));
      // Start on a lane, so each run off the board is in one piece.
      const first = toks.findIndex((t) => !t.key.startsWith("@"));
      const ring = [...toks.slice(first), ...toks.slice(0, first)];
      const seq: Array<{ seg: Seg; stops: Array<{ d: number; visit: number }> }> = [];
      ring.forEach((t, k) => {
        if (t.key.startsWith("@")) return;
        const lane = this.laneByKey.get(t.key)!;
        t.stops.sort((a, b) => a.d - b.d);
        seq.push({ seg: lane, stops: t.stops });
        const next = ring[(k + 1) % ring.length];
        if (!next.key.startsWith("@")) {
          if (lane.end !== null) seq.push({ seg: this.turn(lane, this.laneByKey.get(next.key)!), stops: [] });
          return;
        }
        // Off the board until the next lane: out to each place in turn (calling where it is a visit), then back on.
        const out = exitAt.get(lane.end!)!;
        const calls: OffSeg["calls"] = [];
        let time = 0;
        let place = -1;
        let j = (k + 1) % ring.length;
        while (ring[j].key.startsWith("@")) {
          const p = Number(ring[j].key.slice(1));
          time += (place < 0 ? distance(p, out) : between(place, p)) / OFF_BUS_SPEED;
          if (ring[j].visit >= 0) calls.push({ at: time, visit: ring[j].visit });
          place = p;
          j = (j + 1) % ring.length;
        }
        const back = this.laneByKey.get(ring[j].key)!;
        time += distance(place, exitAt.get(Number(ring[j].key.split("|")[0]))!) / OFF_BUS_SPEED;
        seq.push({ seg: { kind: "off", node: lane.end!, back, length: 0, calls, total: time, place: -1 }, stops: [] });
      });
      // Distances round the itinerary, a run off the board counting as the road it would cover.
      const len = (e: (typeof seq)[number]) => (e.seg.kind === "off" ? e.seg.total * OFF_BUS_SPEED : e.seg.length);
      const cum: number[] = [];
      let total = 0;
      for (const e of seq) { cum.push(total); total += len(e); }
      const visitAt = geom.visits.map(() => 0);
      seq.forEach((e, k) => {
        for (const x of e.stops) visitAt[x.visit] = cum[k] + x.d;
        if (e.seg.kind === "off") for (const c of e.seg.calls) visitAt[c.visit] = cum[k] + c.at * OFF_BUS_SPEED;
      });
      this.lines.push({ geom, seq, cum, total, visitAt, buses: [] });
    }
  }

  /** Each line's buses, spread evenly round its itinerary where there is room. */
  private spawnBuses(): void {
    this.lines.forEach((line, li) => {
      const { seq, geom } = line;
      const total = seq.reduce((a, e) => a + e.seg.length, 0);
      for (let k = 0; k < geom.count; k++) {
        let placed = false;
        for (let tries = 0; tries * 5 < total && !placed; tries++) {
          let x = mod(k * total / geom.count + tries * 5, total);
          let idx = 0;
          while (x > seq[idx].seg.length) { x -= seq[idx].seg.length; idx++; }
          const lane = seq[idx].seg;
          if (lane.kind !== "lane") continue;
          const car = this.newCar(geom.vehicle, [lane]);
          const d = Math.max(x, car.length + 0.5);
          if (d > lane.length) continue;
          if (lane.crossings.some((c) => d > c.from - 2 && d - car.length < c.zoneEnd + 2)) continue;
          if (lane.zebras.some((c) => d > c.stop - 1 && d - car.length < c.zoneEnd + 1)) continue;
          if (this.cars.some((o) => o.path[0] === lane && Math.abs(o.d - d) < Math.max(o.length, car.length) + SPAWN_GAP)) continue;
          car.line = li;
          car.pace = 0.95;
          car.seqPos = idx;
          car.d = d;
          car.nextVisit = this.visitAhead(line.seq, idx, d);
          this.plan(car);
          this.cars.push(car);
          line.buses.push(car.index);
          placed = true;
        }
        if (!placed) this.busesUnplaced++;
      }
    });
  }

  /** The first visit marked after offset d of itinerary entry idx (a stop in a lane, or a call off the board). */
  private visitAhead(seq: Traffic["lines"][number]["seq"], idx: number, d: number): number {
    for (let k = 0; k <= seq.length; k++) {
      const e = seq[(idx + k) % seq.length];
      if (k > 0 && e.seg.kind === "off" && e.seg.calls.length) return e.seg.calls[0].visit;
      const stop = e.stops.find((x) => k > 0 || x.d > d + 0.1);
      if (stop) return stop.visit;
    }
    return 0;
  }

  /** The itinerary entry of a bus's path segment k. */
  private seqAt(car: Car, k: number): Traffic["lines"][number]["seq"][number] {
    const seq = this.lines[car.line].seq;
    return seq[mod(car.seqPos - (car.path.length - 1 - k), seq.length)];
  }

  /** How far ahead of a bus's front its next stop is, or null if not within its path. */
  private busStopAhead(car: Car): number | null {
    let cum = -car.d;
    for (let k = 0; k < car.path.length; k++) {
      const stop = this.seqAt(car, k).stops.find((x) => x.visit === car.nextVisit);
      if (stop && (k > 0 || stop.d >= car.d - 1)) return cum + stop.d;
      cum += car.path[k].length;
    }
    return null;
  }

  /**
   * A bus at its stop starts to wait; one done waiting moves on (and one that drove
   * past its stop this tick, from `before`, goes on to the next).
   */
  private stepBus(car: Car, dt: number, before: number): void {
    const line = this.lines[car.line];
    const m = line.geom.visits.length;
    if (car.dwelling) {
      car.dwellLeft -= dt;
      if (car.dwellLeft > 0) return;
      // Too close behind the bus ahead: wait a little longer, so the buses keep apart.
      if (line.buses.length > 1 && car.heldFor < MAX_HOLD) {
        const me = this.busAt(car);
        const gap = Math.min(...line.buses.filter((ci) => ci !== car.index).map((ci) => mod(this.busAt(this.cars[ci]) - me, line.total)));
        if (gap < HOLD_SHARE * line.total / line.buses.length) {
          car.heldFor += dt;
          car.dwellLeft = dt;
          return;
        }
      }
      car.dwelling = false;
      car.heldFor = 0;
      car.nextVisit = (car.nextVisit + 1) % m;
      return;
    }
    const stop = this.seqAt(car, 0).stops.find((x) => x.visit === car.nextVisit);
    if (!stop) return;
    if (car.d >= stop.d - 0.3 && car.d <= stop.d + 1 && car.speed < 0.3) {
      car.dwelling = true;
      car.dwellLeft = line.geom.dwell;
      car.speed = 0;
      car.stopCount++;
    } else if (car.d > stop.d + 1 && before <= stop.d + 1) {
      car.skipped++;
      car.nextVisit = (car.nextVisit + 1) % m;
    }
  }

  /** How far round its line's itinerary a bus is (m from the start). */
  private busAt(car: Car): number {
    const line = this.lines[car.line];
    const k = mod(car.seqPos - (car.path.length - 1), line.seq.length);
    const seg = line.seq[k].seg;
    return line.cum[k] + (seg.kind === "off" ? car.offT * OFF_BUS_SPEED : Math.min(car.d, seg.length));
  }

  /** About how many seconds until bus ci stands at visit v (0 if it is there now). */
  busDue(ci: number, v: number): number {
    const car = this.cars[ci];
    const line = this.lines[car.line];
    if (car.dwelling && car.nextVisit === v) return 0;
    const ahead = mod(line.visitAt[v] - this.busAt(car), line.total);
    return (ahead / line.total) * line.geom.cycle;
  }

  /** Keeps a bus at its stop at least `seconds` longer (while people get on and off). */
  holdBus(ci: number, seconds: number): void {
    const car = this.cars[ci];
    if (car.dwelling) car.dwellLeft = Math.max(car.dwellLeft, seconds);
  }

  /** The visit a bus is standing at, or -1. */
  busVisit(ci: number): number {
    const car = this.cars[ci];
    return car.line >= 0 && car.dwelling ? car.nextVisit : -1;
  }

  /** Where people get on and off a bus: beside its front door, on the kerb side. */
  busDoor(ci: number): [number, number, number] {
    const car = this.cars[ci];
    const p = this.along(car, DOOR_BACK);
    const h = p.h;
    const w = car.width / 2 + 0.35;
    return [p.x + Math.sin(h) * w, p.y - Math.cos(h) * w, p.z];
  }

  // -- spawning -------------------------------------------------------------------

  private spawn(): void {
    const layout = this.world.layout;
    const total = this.lanes.reduce((a, l) => a + l.length, 0);
    if (!total) return;
    const want = throughTraffic(this.world);
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
        if (lane.crossings.some((c) => d > c.from - 2 && d - length < c.zoneEnd + 2)) continue;
        if (lane.zebras.some((c) => d > c.stop - 1 && d - length < c.zoneEnd + 1)) continue;
        const clash = this.cars.some((o) => o.path[0] === lane && Math.abs(o.d - d) < Math.max(o.length, length) + SPAWN_GAP);
        if (clash) continue;
        const car = this.newCar(object, [lane]);
        car.d = d;
        this.plan(car);
        this.cars.push(car);
        placed = true;
      }
      if (!placed) this.unplaced++;
    }
  }

  /** Extends a through-traffic car's path at least LOOK metres ahead, choosing turns at random. */
  private plan(car: Car): void {
    if (car.owner >= 0) return;
    if (car.line >= 0) {
      // A bus follows its line's itinerary.
      const seq = this.lines[car.line].seq;
      let ahead = car.path.reduce((a, x) => a + x.length, 0) - car.d;
      while (ahead < LOOK + 20 && car.path.length < 12) {
        car.seqPos = (car.seqPos + 1) % seq.length;
        car.path.push(seq[car.seqPos].seg);
        ahead += seq[car.seqPos].seg.length;
      }
      return;
    }
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
      // On the board, or off it but about to come back on (as if already heading for the edge).
      const at = approach(t, OFF_LOOKAHEAD);
      if (!at) continue;
      const L = t.plan.route.length;
      const brake = (at.speed * at.speed) / (2 * t.plan.type.decel);
      for (const pg of this.planGates[planIndex(t)]) {
        const g = this.gates[pg.gate];
        const behind = t.plan.length + g.half + TAIL_CLEAR;
        let ahead = (pg.r - at.r) * at.dir;
        if (t.plan.route.closed) ahead = mod(ahead + behind, L) - behind;
        if (ahead < -behind) continue;
        const toStop = ahead - g.half - GATE_MARGIN;
        // Over it, or too close to stop comfortably without it closing in time, or arriving soon.
        const warning = WARN + LOWER + SLACK;
        // A train held at a signal, still short of where it stops for this crossing, asks again when it can go
        // (it stops short of a crossing that is not closed).
        const held = t.phase === "waiting" && t.wants.length > 0 && toStop > 1;
        if (ahead < 0 || (!held && (toStop < brake + at.speed * warning + MIN_APPROACH || this.eta(t, at, toStop) <= warning))) g.wantedAt = this.time;
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
  private eta(t: Train, at: NonNullable<ReturnType<typeof approach>>, dist: number): number {
    let time = at.delay;
    let v = at.speed;
    const limit = WARN + LOWER + SLACK;
    for (let x = 0; x < dist && time <= limit; x += ETA_STEP) {
      const ds = Math.min(ETA_STEP, dist - x);
      const v2 = Math.min(Math.max(curveLimit(t.plan, at.r + at.dir * x), 1), Math.sqrt(v * v + 2 * t.plan.type.accel * ds));
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
    if (this.walkers?.inGate(gate)) return false;
    for (const lane of this.lanes) {
      for (const c of lane.crossings) {
        if (c.gate !== gate) continue;
        for (const o of this.occ.get(lane) ?? []) if (o.front > c.from + 0.1 && o.rear < c.zoneEnd) return false;
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
      if (car.hidden || car.state !== "driving") continue;
      const seg = car.path[0];
      add(seg, { car, front: Math.min(car.d, seg.length), rear: Math.max(car.enterD, car.d - car.length) });
      if (seg.kind === "bay" && !seg.into) {
        // Pulling out: it holds the stretch of lane it is about to take.
        add(seg.lane, { car, front: seg.laneD + 1, rear: Math.max(0, seg.laneD - car.length - 1), virtual: true });
        continue;
      }
      let left = car.length - (car.d - car.enterD);
      car.trail.forEach((t, k) => {
        if (left <= 0) return;
        const end = car.trailLen[k] ?? t.length;
        add(t, { car, front: end, rear: Math.max(0, end - left) });
        left -= end;
      });
    }
  }

  private stepCars(dt: number): void {
    this.grantJunctions();
    for (const car of this.cars) {
      if (car.hidden) { this.stepAway(car, dt); continue; }
      if (car.state === "parked") continue;
      if (car.state === "leaving") {
        car.waitMerge += dt;
        car.maxWait = Math.max(car.maxWait, car.waitMerge);
        if (!this.canMerge(car)) continue;
        car.state = "driving";
        if (this.bayCar[car.bay] === car.index) this.bayCar[car.bay] = -1;
        car.bay = -1;
        car.reversing = (car.path[0] as BaySeg).reverse;
        car.stopped = 0;
      }
      const v = this.control(car);
      car.speed = car.speed < v ? Math.min(v, car.speed + ACCEL * dt) : v;
      const before = car.d;
      const seg = car.path[0];
      this.advance(car, car.speed * dt);
      if (car.line >= 0 && !car.hidden) this.stepBus(car, dt, car.path[0] === seg ? before : -Infinity);
      if (car.dwelling) car.stopped = 0;
      else if (car.speed < 0.05) {
        car.stopped += dt;
        car.maxWait = Math.max(car.maxWait, car.stopped);
      } else car.stopped = 0;
    }
    this.occupy();                // where the cars are now, for the people deciding whether to cross
  }

  /** Junctions go to one car at a time, longest waiting first, and only if it can get clear beyond. */
  private grantJunctions(): void {
    const asking = this.cars.filter((c) => !c.hidden && c.asking).sort((a, b) => a.request - b.request || a.index - b.index);
    for (const car of asking) {
      let turn = car.asking!;
      if (this.holder[turn.node] !== -1) continue;
      if (this.roomBeyond(car, turn) < car.length + MIN_GAP) {
        // Kept waiting because the way it chose is full: take another way out if one has room.
        if (this.time - car.request < REROUTE_AFTER || car.line >= 0 || !this.reroute(car, turn)) continue;
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
    if (car.owner >= 0) {
      // A resident's car finds a new way from there to its bay (or to the lane leaving the board).
      const into = car.path[car.path.length - 1] as BaySeg | OffSeg;
      const target = into.kind === "bay" ? into.lane : (car.path[car.path.length - 2] as Lane);
      const rest = this.lanePath(best, 0, target, into.kind === "bay" ? into.laneD : target.length - 0.5);
      if (!rest) return false;
      car.path.length = k;
      car.path.push(via);
      rest.forEach((l, i) => { if (i > 0) car.path.push(this.turn(rest[i - 1], l)); car.path.push(l); });
      car.path.push(into);
    } else {
      car.path.length = k;
      car.path.push(via, best);
      this.plan(car);
    }
    car.asking = via;
    return true;
  }

  /** Quickest lanes from offset fromD of `from` to offset toD of `to` (both included), or null. */
  lanePath(from: Lane, fromD: number, to: Lane, toD: number): Lane[] | null {
    if (from === to && toD >= fromD + 1) return [from];
    const time = (l: Lane) => l.length / Math.max(3, l.road.spec.speed * 0.8);
    const best = new Map<Lane, number>([[from, 0]]);
    const prev = new Map<Lane, Lane>();
    const open: Array<{ lane: Lane; t: number }> = [{ lane: from, t: 0 }];
    while (open.length) {
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (open[i].t < open[bi].t) bi = i;
      const { lane, t } = open.splice(bi, 1)[0];
      if (t > (best.get(lane) ?? Infinity)) continue;
      for (const next of this.nextLanes(lane)) {
        const nt = t + time(lane) + 3;
        if (next === to) {
          if (nt < (best.get(to) ?? Infinity) || !prev.has(to)) { best.set(to, nt); prev.set(to, lane); }
          continue;
        }
        if (nt < (best.get(next) ?? Infinity)) {
          best.set(next, nt);
          prev.set(next, lane);
          open.push({ lane: next, t: nt });
        }
      }
    }
    if (!prev.has(to)) return null;
    const out: Lane[] = [to];
    for (let l = prev.get(to)!; ; l = prev.get(l)!) {
      out.unshift(l);
      if (l === from) break;
    }
    return out;
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
      if (seg.kind === "away" || seg.kind === "off" || seg.kind === "bay") return Infinity;     // off the board, or into its own bay
      if (seg.kind === "turn" && seg.junction) return cum;
      const len = this.segLen(car, k);
      let room = len;
      for (const o of this.occ.get(seg) ?? []) if (o.car !== car && o.rear < len) room = Math.min(room, o.rear);
      if (seg.kind === "lane") {
        for (const c of seg.crossings) if (this.gates[c.gate].state !== "open" && c.from < len) room = Math.min(room, c.from);
        for (const z of seg.zebras) if (this.walkers?.busy[z.c] && z.stop < len) room = Math.min(room, z.stop);
      }
      if (room < len || cum + room >= need) return cum + room;
      cum += len;
    }
    return cum;
  }

  /** Free road at the start of a lane: up to the first car or a crossing that is not open. */
  private exitRoom(lane: Lane): number {
    let room = lane.length;
    for (const o of this.occ.get(lane) ?? []) room = Math.min(room, o.rear);
    for (const c of lane.crossings) if (this.gates[c.gate].state !== "open") room = Math.min(room, c.from);
    for (const z of lane.zebras) if (this.walkers?.busy[z.c]) room = Math.min(room, z.stop);
    return room;
  }

  /**
   * Out of sight beyond the board's edge: turning round (through traffic), on a run
   * off the board (buses calling at off-layout places; residents' cars on their way
   * to one, or back), and coming back on when there is room.
   */
  private stepAway(car: Car, dt: number): void {
    if (car.state === "off") return;                    // parked off the board
    if (car.state === "entering") {
      car.awayLeft -= dt;
      const lane = car.path[0] as Lane;
      if (car.awayLeft > 0 || this.exitRoom(lane) < car.length + MIN_GAP + 2) return;
      car.state = "driving";
      this.comeBack(car, lane, false);
      return;
    }
    const seg = car.path[0];
    if (seg.kind === "off") {
      if (car.dwelling) {
        car.dwellLeft -= dt;
        if (car.dwellLeft > 0) return;
        car.dwelling = false;
        car.nextVisit = (car.nextVisit + 1) % this.lines[car.line].geom.visits.length;
        return;
      }
      if (car.offT < seg.total) {
        car.offT = Math.min(seg.total, car.offT + dt);
        const call = seg.calls.find((c) => c.visit === car.nextVisit && c.at <= car.offT);
        if (call) {
          car.dwelling = true;
          car.dwellLeft = this.lines[car.line].geom.dwell;
          car.stopCount++;
        }
        return;
      }
      if (!seg.back) {
        // A resident's car has arrived out there: parked off the board.
        car.state = "off";
        car.offPlace = seg.place;
        car.goal = -1;
        car.path = [];
        car.trail = [];
        car.trailLen = [];
        this.arrivals.push(car.index);
        return;
      }
      if (this.exitRoom(seg.back) < car.length + MIN_GAP + 2) return;
      this.comeBack(car, seg.back, true);
      return;
    }
    car.awayLeft -= dt;
    const away = seg as Away;
    if (car.awayLeft > 0 || this.exitRoom(away.back) < car.length + MIN_GAP + 2) return;
    this.comeBack(car, away.back, true);
  }

  /** Back on the board at the start of `lane` (dropping the segment off the board ahead of it, if `shift`). */
  private comeBack(car: Car, lane: Lane, shift: boolean): void {
    if (shift) car.path.shift();
    car.d = Math.min(car.length, lane.length);
    car.trail = [];
    car.trailLen = [];
    car.hidden = false;
    car.speed = 0;
    car.stopped = 0;
    this.plan(car);
    // Claim the space now, so a second car coming back this tick waits.
    const list = this.occ.get(lane) ?? [];
    list.push({ car, front: car.d, rear: Math.max(0, car.d - car.length) });
    this.occ.set(lane, list);
  }

  /** The highest speed the car may have this tick. */
  private control(car: Car): number {
    if (car.dwelling) return 0;
    const v = car.speed;
    const lane0 = car.path[0];
    let cap = lane0.kind === "lane" ? lane0.limit[Math.min(lane0.limit.length - 1, Math.round(car.d / SPEED_STEP))] * car.pace
      : (lane0 as Turn | BaySeg).speed;
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
      if (seg.kind === "away" || seg.kind === "off") break;            // nothing beyond the board's edge is in the way
      const len = this.segLen(car, k);
      const start = this.segStart(car, k);
      for (const o of this.occ.get(seg) ?? []) {
        if (o.car === car || (k === 0 && o.front <= car.d + 1e-3) || o.rear > len + 1 || o.front < start) continue;
        obstacles.push({ rel: cum + Math.max(0, o.rear - start), speed: o.car.speed });
      }
      cum += len - start;
    }
    obstacles.sort((a, b) => a.rel - b.rel);
    const leader = obstacles[0];
    if (leader) {
      const gap = leader.rel - MIN_GAP;
      cap = Math.min(cap, Math.sqrt(leader.speed * leader.speed + 2 * DECEL * Math.max(0, gap)),
        Math.max(0, leader.speed + FOLLOW_GAIN * (gap - HEADWAY * leader.speed)));
      if (gap <= ARRIVE) cap = 0;
    }

    // A bus stops at its next stop (and asks for no junction beyond it until it has).
    const busHalt = car.line >= 0 ? this.busStopAhead(car) : null;
    if (busHalt !== null) stopAt(busHalt);

    // Crossings for people that the car is already on (on any of its lanes): it carries on over them.
    const onZebras = new Set<number>();
    for (const seg of [lane0, ...car.trail]) {
      if (seg.kind !== "lane" || !seg.zebras.length) continue;
      const me = this.occ.get(seg)?.find((o) => o.car === car);
      if (me) for (const z of seg.zebras) if (me.front > z.stop + 0.1 && me.rear < z.zoneEnd) onZebras.add(z.c);
    }

    // Stop lines, slower stretches and turns ahead.
    cum = -car.d;
    let clear = true;                                       // nothing holds the car before the next junction
    for (let k = 0; k < car.path.length && cum < LOOK; k++) {
      const seg = car.path[k];
      const len = this.segLen(car, k);
      const start = this.segStart(car, k);
      cum -= start;                                         // offsets below are from the lane's start
      if (seg.kind === "bay") {
        slowTo(seg.speed, cum);
        // Come to rest in the bay, or before driving forward after backing out.
        if (seg.into || seg.reverse) stopAt(cum + seg.length);
        if (seg.into) break;
      } else if (seg.kind === "lane") {
        for (let i = Math.max(0, Math.ceil((k === 0 ? car.d : start) / SPEED_STEP)); i < seg.limit.length; i++) {
          const rel = cum + i * SPEED_STEP;
          if (rel > brake + 20) break;
          slowTo(seg.limit[i] * car.pace, rel);
        }
        for (const c of seg.crossings) {
          if (!c.lead || c.stop > len || c.stop < start) continue;   // committed already, beyond the car's bay, or behind where it joins
          const stop = cum + c.stop;
          if (stop < -0.1) continue;                      // already past the stop line: carry on
          // Too close to stop when the lights start: keep going (the barriers wait for the car).
          const late = stop < (v * v) / (2 * HARD_DECEL);
          let halt = c.gates.some((gi) => { const g = this.gates[gi].state; return g !== "open" && !(g === "warning" && late); });
          // Don't stop on the crossing: wait until there is room beyond it.
          if (!halt) halt = obstacles.some((o) => o.rel > cum + c.stop && o.rel < cum + c.zoneEnd + car.length + MIN_GAP && o.speed < QUEUED);
          if (halt) { stopAt(stop); clear = false; }
        }
        // People crossing: give way if there is still room to stop, and never stop on the crossing.
        for (const z of seg.zebras) {
          const stop = cum + z.stop;
          if (stop < -0.1 || onZebras.has(z.c) || z.stop > len || z.stop < start) continue;
          let halt = !!this.walkers?.busy[z.c] && (stop >= (v * v) / (2 * HARD_DECEL) || v < 0.5);
          if (!halt) halt = obstacles.some((o) => o.rel > stop && o.rel < cum + z.zoneEnd + car.length + MIN_GAP && o.speed < QUEUED);
          if (halt) { stopAt(stop); clear = false; }
        }
      } else if (seg.kind === "away" || seg.kind === "off") {
        break;                                             // off the board: nothing beyond matters yet
      } else if (seg.kind === "turn") {
        slowTo(seg.speed, cum);
        if (seg.junction && !car.held.includes(seg)) {
          // Ask for the junction when close, first in the queue and not held up before it.
          if (clear && cum < brake + LOCK_REACH && (!leader || leader.rel > cum) && (busHalt === null || busHalt > cum)) {
            if (car.asking !== seg) { car.asking = seg; car.request = this.time; }
          }
          stopAt(cum - 0.5);
          break;                                           // nothing beyond a junction we don't hold matters yet
        }
      }
      cum += len;
    }
    return Math.max(0, cap);
  }

  private advance(car: Car, move: number): void {
    car.d += move;
    car.odometer += move;
    // (A car backing out stops at the end of its path before driving off: near enough counts.)
    const doneAt = (seg: Seg) => this.segLen(car, 0) - (seg.kind === "bay" && seg.reverse ? 2 * ARRIVE : 0);
    while (car.path.length > 1 && car.d >= doneAt(car.path[0]) && car.path[0].kind !== "away" && car.path[0].kind !== "off") {
      const seg = car.path[0];
      const len = this.segLen(car, 0);
      if (car.line >= 0 && this.seqAt(car, 0).stops.some((x) => x.visit === car.nextVisit && x.d > car.d - move)) {
        // Past its stop without stopping (should not happen): on to the next one.
        car.skipped++;
        car.nextVisit = (car.nextVisit + 1) % this.lines[car.line].geom.visits.length;
      }
      car.d -= len;
      car.path.shift();
      car.enterD = 0;
      if (seg.kind === "bay" && seg.reverse) {
        // Backed out: now it drives forward along the lane, its whole body on it.
        car.d = seg.laneD;
        car.reversing = false;
        car.speed = 0;
        car.trail = [];
        car.trailLen = [];
        continue;
      }
      if (seg.kind === "bay") { car.d += seg.laneD; car.enterD = seg.laneD; }
      car.trail.unshift(seg);
      car.trailLen.unshift(len);
      if (car.trail.length > 3) { car.trail.length = 3; car.trailLen.length = 3; }
      const next = car.path[0] as Seg;
      if (next.kind === "away" || next.kind === "off") {
        // Over the board's edge: out of sight.
        car.hidden = true;
        car.asking = null;
        car.request = NaN;
        car.awayLeft = next.kind === "off" ? next.total : range(this.r, AWAY[0], AWAY[1]);
        car.offT = 0;
        car.d = 0;
        car.speed = 0;
        for (const t of car.held) this.release(car, t);
        return;
      }
    }
    // In its goal bay: parked.
    const last = car.path[0];
    if (last.kind === "bay" && last.into && car.d >= last.length - 2 * ARRIVE) {
      for (const t of car.held) this.release(car, t);
      car.state = "parked";
      car.bay = last.bay;
      car.goal = -1;
      car.path = [];
      car.trail = [];
      car.trailLen = [];
      car.speed = 0;
      car.d = 0;
      car.asking = null;
      car.request = NaN;
      this.arrivals.push(car.index);
      return;
    }
    // Hand the junction back once the whole car is through it.
    for (const held of car.held) {
      if (car.path.includes(held)) continue;
      let left = car.length - (car.d - car.enterD);
      let inside = false;
      car.trail.forEach((t, k) => {
        if (left <= 0) return;
        if (t === held) inside = true;
        left -= car.trailLen[k] ?? t.length;
      });
      if (!inside) this.release(car, held);
    }
    this.plan(car);
  }

  private release(car: Car, turn: Turn): void {
    if (this.holder[turn.node] === car.index) this.holder[turn.node] = -1;
    car.held = car.held.filter((t) => t !== turn);
  }

  // -- for the people ----------------------------------------------------------------

  /**
   * Whether stepping onto road crossing c now would be unsafe: a car is on it, or
   * coming that could not stop in time (`gap` = 0, a zebra) or would arrive within
   * `gap` seconds (an unmarked crossing, where people wait for a gap).
   */
  crossingThreat(c: number, gap: number): boolean {
    for (const lane of this.lanes) {
      for (const z of lane.zebras) {
        if (z.c !== c) continue;
        for (const o of this.occ.get(lane) ?? []) if (o.front > z.stop + 0.1 && o.rear < z.zoneEnd) return true;
        // Cars still on their way: on this lane before the stop line, or on the segments leading to it.
        for (const car of this.cars) {
          if (car.hidden) continue;
          const dist = this.distanceTo(car, lane, z.stop);
          if (dist === null) continue;
          // A car standing before the stop line is no danger: it will wait for anyone on the crossing.
          const v = car.speed;
          if (v > 0.3 && dist < (gap > 0 ? v * gap + 2 : (v * v) / (2 * DECEL) + 1)) return true;
        }
      }
    }
    return false;
  }

  /** How far a car's front is before offset `at` of a lane, along its planned path (null: not heading there soon). */
  private distanceTo(car: Car, lane: Lane, at: number): number | null {
    if (car.state !== "driving" || car.hidden) return null;
    let cum = -car.d;
    for (let k = 0; k < car.path.length && cum < LOOK; k++) {
      const seg = car.path[k];
      if (seg.kind === "away" || seg.kind === "off") return null;
      const len = this.segLen(car, k);
      const start = this.segStart(car, k);
      if (seg === lane) {
        if (at > len + 0.1 || at < start - 0.1) return null;   // it turns into a bay before, or joins after, that point
        const d = cum + at - start;
        return d >= -0.1 ? d : null;
      }
      cum += len - start;
    }
    return null;
  }

  /** Seconds the longest-waiting car has stood at road crossing c's stop line. */
  carWaitingAt(c: number): number {
    let longest = 0;
    for (const lane of this.lanes) {
      for (const z of lane.zebras) {
        if (z.c !== c) continue;
        for (const o of this.occ.get(lane) ?? []) {
          if (o.front <= z.stop + 0.1 && o.front > z.stop - 1.5 && o.car.speed < 0.1) longest = Math.max(longest, o.car.stopped);
        }
      }
    }
    return longest;
  }

  /** For tests: whether any car body is on road crossing c. */
  carOnRoadCrossing(c: number): boolean {
    for (const lane of this.lanes) {
      for (const z of lane.zebras) {
        if (z.c !== c) continue;
        for (const o of this.occ.get(lane) ?? []) if (o.front > z.stop + ZEBRA_GAP && o.rear < z.zoneEnd) return true;
      }
    }
    return false;
  }

  // -- output ---------------------------------------------------------------------

  /** Pose of a point `back` metres behind the car's front, walking back over its trail. */
  private along(car: Car, back: number) {
    let off = car.d - back;
    if (off >= car.enterD || !car.trail.length) return this.segPose(car.path[0], off);
    off -= car.enterD;
    for (let k = 0; k < car.trail.length; k++) {
      off += car.trailLen[k] ?? car.trail[k].length;
      if (off >= 0) return this.segPose(car.trail[k], off);
    }
    return this.segPose(car.trail[car.trail.length - 1], 0);
  }

  snapshotCars(out: VehicleSnapshot[]): VehicleSnapshot[] {
    this.cars.forEach((car, i) => {
      const s = out[i] ?? (out[i] = { object: car.object, x: 0, y: 0, z: 0, heading: 0, pitch: 0, visible: true, color: null });
      s.object = car.object;
      s.color = car.line >= 0 ? this.lines[car.line].geom.color : null;
      s.visible = !car.hidden;
      if (car.hidden) return;
      if (car.state !== "driving") {
        const b = this.world.town.bays[car.bay];
        s.x = b.x - Math.cos(b.heading) * car.centre;
        s.y = b.y - Math.sin(b.heading) * car.centre;
        s.z = b.z;
        s.heading = b.heading;
        s.pitch = 0;
        return;
      }
      const a = this.along(car, car.length * 0.2);
      const ax = a.x, ay = a.y, az = a.z;
      const b = this.along(car, car.length * 0.8);
      // Backing out, the path's leading point is the rear.
      const h = car.reversing ? Math.atan2(b.y - ay, b.x - ax) : Math.atan2(ay - b.y, ax - b.x);
      const mx = (ax + b.x) / 2 - Math.cos(h) * car.centre;
      const my = (ay + b.y) / 2 - Math.sin(h) * car.centre;
      s.x = mx; s.y = my; s.z = (az + b.z) / 2;
      s.heading = h;
      s.pitch = Math.atan2(az - b.z, Math.hypot(ax - b.x, ay - b.y)) * (car.reversing ? -1 : 1);
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
    const through = this.cars.filter((c) => c.owner < 0 && c.line < 0);
    const own = this.cars.filter((c) => c.owner >= 0);
    const buses = this.cars.filter((c) => c.line >= 0);
    const n = through.length;
    return {
      cars: n,
      buses: buses.length,
      busStops: buses.reduce((a, c) => a + c.stopCount, 0),
      busSkipped: buses.reduce((a, c) => a + c.skipped, 0),
      own: own.length,
      driving: own.filter((c) => c.state === "driving").length,
      ownDistance: own.reduce((a, c) => a + c.odometer, 0),
      unplaced: this.unplaced,
      avgSpeed: n ? through.reduce((a, c) => a + c.odometer, 0) / n / Math.max(this.time, 1e-9) : 0,
      maxWait: this.cars.reduce((a, c) => Math.max(a, c.maxWait), 0),
      stuck: this.cars.filter((c) => (c.state === "driving" && c.stopped > STUCK_AFTER) || (c.state === "leaving" && c.waitMerge > STUCK_AFTER)).length,
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
          if (a.car !== b.car && !a.virtual && !b.virtual && a.rear < b.front - 1e-6 && b.rear < a.front - 1e-6) n++;
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
        const zone = g.crossing.zone;
        for (const o of this.occ.get(lane) ?? []) if (o.front > c.at - zone && o.rear < c.at + zone) return true;
      }
    }
    return false;
  }
}
