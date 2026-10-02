// Train state and per-tick motion (§7.3): reserve blocks ahead, choose a target
// (end of reservation, next stop, shuttle end), brake or accelerate toward it,
// advance, dwell, and reverse at shuttle ends. Positions are route coordinates r.

import type { Plan } from "./services";
import { curveLimit, CURVE_STEP } from "./services";
import type { SwitchState } from "../model/trackGraph";
import type { Rng } from "../util/rng";

const SAFETY = 5;              // m kept clear before the end of the reservation
const LOOKAHEAD = 50;          // m reserved beyond the braking distance
const RUN_ROOM = 10;           // m of spare room needed after an opposed run
const ARRIVE = 0.05;           // m; closer than this counts as arrived
const CREEP = 0.6;             // m/s minimum approach speed so arrivals finish
const SPAWN_STEP = 25;         // m to shift a spawn position that is blocked
const TURNAROUND = 15;         // s pause at a shuttle end without a station
const SERVICE_STAGGER = 0.37;  // fraction of a lap between the first trains of successive services

export type Phase = "running" | "dwelling" | "waiting";

export type Train = {
  id: string;
  plan: Plan;
  r: number;                   // head position along the route (unwrapped on loops)
  dir: 1 | -1;                 // travel direction along r
  speed: number;
  phase: Phase;
  dwellLeft: number;
  atStation: string | null;
  servedR: number;             // head r at the last stop served, so it isn't served twice
  lo: number;                  // held entries, as global entry indices lo..hi
  hi: number;
  wants: number[];             // blocks it failed to reserve this tick
  stoppedFor: number;          // s at speed 0 while not dwelling
  flipped: boolean;            // consist reversed relative to its spawn orientation
  odometer: number;
  stops: number;
  waited: number;              // s of the current wait
  maxWait: number;
};

/** What a train step can report back to the sim. */
export type TrainEvent = { type: "arrived" | "departed"; station: string };

/** Shared sim state the train logic reads and writes. */
export type World4Trains = {
  owner: Int32Array;           // block -> train index, or -1
  switchStates: SwitchState[];
  rng: Rng;
};

// -- entry index helpers (global index K = lap·E + i on loops) --------------

const E = (p: Plan) => p.entries.length;
const lapOf = (p: Plan, K: number) => (p.route.closed ? Math.floor(K / E(p)) : 0);
export const entryOf = (p: Plan, K: number) => p.entries[K - lapOf(p, K) * E(p)];
const r0 = (p: Plan, K: number) => entryOf(p, K).r0 + lapOf(p, K) * p.route.length;
const r1 = (p: Plan, K: number) => entryOf(p, K).r1 + lapOf(p, K) * p.route.length;

function indexAt(p: Plan, r: number): number {
  const L = p.route.length;
  const lap = p.route.closed ? Math.floor(r / L) : 0;
  const x = r - lap * L;
  let lo = 0;
  let hi = E(p) - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (p.entries[mid].r0 <= x) lo = mid;
    else hi = mid - 1;
  }
  return lap * E(p) + lo;
}

/** Whether K may join train t's window (shuttle bounds; loops must not wrap onto themselves). */
function inPath(t: Train, K: number): boolean {
  const p = t.plan;
  if (!p.route.closed) return K >= 0 && K < E(p);
  return t.dir > 0 ? K - t.lo < E(p) : t.hi - K < E(p);
}

const opposed = (t: Train, K: number) => t.plan.opposed[t.dir > 0 ? 0 : 1][K - lapOf(t.plan, K) * E(t.plan)] === 1;

// -- reservation --------------------------------------------------------------

function tryReserve(w: World4Trains, t: Train, self: number, Ks: number[]): boolean {
  const blocked = Ks.map((K) => entryOf(t.plan, K).block).filter((b) => w.owner[b] !== -1 && w.owner[b] !== self);
  if (blocked.length) {
    t.wants = [...new Set(blocked)];
    return false;
  }
  for (const K of Ks) {
    const e = entryOf(t.plan, K);
    w.owner[e.block] = self;
    for (const sw of e.switches) w.switchStates[sw.sw] = sw.state;
  }
  return true;
}

/**
 * Extend the reservation to cover the braking distance plus LOOKAHEAD. Entering an
 * opposed stretch reserves all of it, plus room for the whole train beyond, in one
 * go (or nothing): a train never stops half-way along a single-track section that
 * an opposing train needs, so head-on deadlocks can't form.
 */
function extend(w: World4Trains, t: Train, self: number): void {
  const want = (t.speed * t.speed) / (2 * t.plan.type.decel) + LOOKAHEAD;
  t.wants = [];
  for (;;) {
    const ahead = t.dir > 0 ? r1(t.plan, t.hi) - t.r : t.r - r0(t.plan, t.lo);
    if (ahead >= want) return;
    const next = t.dir > 0 ? t.hi + 1 : t.lo - 1;
    if (!inPath(t, next)) return;
    const run = [next];
    if (opposed(t, next)) {
      let room = 0;
      for (let K = next; ; ) {
        room = opposed(t, K) ? 0 : room + (r1(t.plan, K) - r0(t.plan, K));
        if (room >= t.plan.length + RUN_ROOM) break;
        K += t.dir;
        if (!inPath(t, K)) break;
        run.push(K);
      }
    }
    if (!tryReserve(w, t, self, run)) return;
    if (t.dir > 0) t.hi = run[run.length - 1];
    else t.lo = run[run.length - 1];
  }
}

function release(w: World4Trains, t: Train, self: number): void {
  const tail = t.r - t.dir * t.plan.length;
  const drop = (K: number) => {
    const b = entryOf(t.plan, K).block;
    for (let k = t.lo; k <= t.hi; k++) if (k !== K && entryOf(t.plan, k).block === b) return;
    if (w.owner[b] === self) w.owner[b] = -1;
  };
  if (t.dir > 0) while (t.lo < t.hi && r1(t.plan, t.lo) <= tail + 1e-6) drop(t.lo++);
  else while (t.hi > t.lo && r0(t.plan, t.hi) >= tail - 1e-6) drop(t.hi--);
}

// -- spawning -------------------------------------------------------------------

/**
 * Places a train k of `count` evenly along its route (shuttles: along the round
 * trip, so a second train starts at the far end). Blocked or opposed spots are
 * skipped by moving SPAWN_STEP metres on. Returns null if nowhere fits.
 */
export function spawn(w: World4Trains, plan: Plan, k: number, planIndex: number, id: string, self: number): Train | null {
  const L = plan.route.length;
  const len = plan.length;
  const closed = plan.route.closed;
  const cycle = closed ? L : 2 * L;
  // Loop services start at staggered offsets so different services don't all queue at r = 0.
  const offset = closed ? ((planIndex * SERVICE_STAGGER) % 1) * L : 0;
  for (let a = 0; a * SPAWN_STEP < cycle; a++) {
    const p = offset + (k * cycle) / plan.svc.count + a * SPAWN_STEP;
    let r: number;
    let dir: 1 | -1 = 1;
    if (closed) r = L + (p % L);                         // lap 1, so the tail index stays positive
    else if (p % cycle < L) r = Math.min(Math.max(p % cycle, len), L);
    else { dir = -1; r = Math.min(Math.max(cycle - (p % cycle), 0), L - len); }
    if (!closed && len > L) return null;
    const t: Train = {
      id, plan, r, dir, speed: 0, phase: "running", dwellLeft: 0, atStation: null, servedR: NaN,
      lo: 0, hi: 0, wants: [], stoppedFor: 0, flipped: false, odometer: 0, stops: 0, waited: 0, maxWait: 0,
    };
    const tail = r - dir * len;
    t.lo = indexAt(plan, Math.min(r, tail) + 1e-6);
    t.hi = indexAt(plan, Math.max(r, tail) - 1e-6);
    const Ks = Array.from({ length: t.hi - t.lo + 1 }, (_, i) => t.lo + i);
    const atTerminus = !closed && (Math.min(r, tail) <= 1e-6 || Math.max(r, tail) >= L - 1e-6);
    if (!atTerminus && Ks.some((K) => opposed(t, K))) continue;
    if (tryReserve(w, t, self, Ks)) {
      // A shuttle starting at a terminus has just "arrived" there; don't serve it twice.
      if (atTerminus) t.servedR = r;
      return t;
    }
  }
  return null;
}

// -- motion ----------------------------------------------------------------------

function nextStop(t: Train): { dist: number; station: string } | null {
  const { route, length } = t.plan;
  let best: { dist: number; station: string } | null = null;
  for (const st of route.stops) {
    let cand = st.r + (t.dir * length) / 2;
    if (route.closed) {
      cand += Math.ceil((t.r - 1e-6 - cand) / route.length) * route.length;
      if (Math.abs(cand - t.servedR) < 1e-3) cand += route.length;
    } else if (cand < -1e-6 || cand > route.length + 1e-6 || Math.abs(cand - t.servedR) < 1e-3) continue;
    const dist = (cand - t.r) * t.dir;
    if (dist >= -1e-6 && (!best || dist < best.dist)) best = { dist: Math.max(0, dist), station: st.station };
  }
  return best;
}

export const nextStopOf = (t: Train) => nextStop(t)?.station ?? null;

/** Fastest speed from which the train can still slow for every curve ahead. */
function curveCap(t: Train): number {
  const { decel } = t.plan.type;
  const reach = (t.speed * t.speed) / (2 * decel) + 100;
  let cap = Infinity;
  for (let d = 0; d <= reach; d += CURVE_STEP) {
    const v = curveLimit(t.plan, t.r + t.dir * d);
    cap = Math.min(cap, Math.sqrt(v * v + 2 * decel * d));
  }
  return cap;
}

export function stepTrain(w: World4Trains, t: Train, self: number, dt: number): TrainEvent | null {
  const { plan } = t;
  const { type, route } = plan;
  let event: TrainEvent | null = null;

  if (t.phase === "dwelling") {
    t.dwellLeft -= dt;
    t.stoppedFor = 0;
    if (t.dwellLeft > 0) return null;
    if (t.atStation) event = { type: "departed", station: t.atStation };
    t.atStation = null;
    t.phase = "running";
    const end = t.dir > 0 ? route.length : 0;
    if (!route.closed && Math.abs(t.r - end) < 0.1) {
      // Shuttle end: the old tail becomes the new head.
      t.r -= t.dir * plan.length;
      t.dir = (-t.dir) as 1 | -1;
      t.flipped = !t.flipped;
      t.servedR = t.r;
    }
  }

  extend(w, t, self);
  const atPathEnd = !route.closed && (t.dir > 0 ? t.hi === E(plan) - 1 : t.lo === 0);
  const resEnd = t.dir > 0 ? r1(plan, t.hi) : r0(plan, t.lo);
  const limit = (resEnd - t.r) * t.dir - (atPathEnd ? 0 : SAFETY);
  const stop = nextStop(t);
  const toStop = stop && stop.dist <= limit;
  const dist = Math.max(0, toStop ? stop.dist : limit);
  const terminal = toStop || atPathEnd;

  let vStop = Math.sqrt(2 * type.decel * dist);
  if (dist > ARRIVE && vStop < CREEP) vStop = CREEP;
  const cap = Math.min(type.maxSpeed, curveCap(t), vStop);
  t.speed = t.speed < cap ? Math.min(cap, t.speed + type.accel * dt) : cap;
  const move = Math.min(t.speed * dt, dist);
  t.r += t.dir * move;
  t.odometer += move;
  release(w, t, self);

  if (dist - move <= ARRIVE) {
    t.speed = 0;
    if (terminal) {
      t.r += t.dir * (dist - move);             // snap exactly onto the stopping point
      t.phase = "dwelling";
      t.servedR = t.r;
      t.waited = 0;
      if (toStop) {
        t.atStation = stop.station;
        t.dwellLeft = plan.svc.dwell * (0.85 + 0.3 * w.rng());
        t.stops++;
        event = { type: "arrived", station: stop.station };
      } else t.dwellLeft = TURNAROUND;
      return event;
    }
  }
  if (t.speed === 0) {
    t.phase = "waiting";
    t.stoppedFor += dt;
    t.waited += dt;
    t.maxWait = Math.max(t.maxWait, t.waited);
  } else {
    t.phase = "running";
    t.stoppedFor = 0;
    t.waited = 0;
  }
  return event;
}

/** Bogie-based pose of every car (§7.3): front bogie 15% into the car, rear 70% further back. */
export function forEachCar(
  t: Train, at: (r: number) => { x: number; y: number; z: number },
  fn: (car: number, x: number, y: number, z: number, heading: number, pitch: number) => void,
): void {
  const { cars, length } = t.plan;
  let front = 0;
  for (let c = 0; c < cars.length; c++) {
    const l = cars[c];
    // Distance from the current head to this car's leading end (cars keep their physical order).
    const lead = t.flipped ? length - front - l : front;
    const a = at(t.r - t.dir * (lead + 0.15 * l));
    const ax = a.x, ay = a.y, az = a.z;
    const b = at(t.r - t.dir * (lead + 0.85 * l));
    const heading = Math.atan2(ay - b.y, ax - b.x) + (t.flipped ? Math.PI : 0);
    const pitch = Math.atan2(az - b.z, Math.hypot(ax - b.x, ay - b.y)) * (t.flipped ? -1 : 1);
    fn(c, (ax + b.x) / 2, (ay + b.y) / 2, (az + b.z) / 2, heading, pitch);
    front += l;
  }
}
