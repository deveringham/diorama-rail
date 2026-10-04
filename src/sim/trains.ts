// Train state and per-tick motion (§7.3): reserve blocks ahead, choose a target
// (end of reservation, next stop, shuttle end), brake or accelerate toward it,
// advance, dwell, and reverse at shuttle ends. Positions are route coordinates r.
// Where a route leaves the board the train runs on past the edge without stopping;
// once its tail is past, it is off the board: it travels on out of sight, calls at
// the service's off-layout stops, and comes back on at the edge (the same end for a
// shuttle, the start for a loop running through) as soon as there is room.

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

export type Phase = "running" | "dwelling" | "waiting" | "off";

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
  off: number;                 // the end of the route (0 or 1) it left the board by, -1 while on it
  offT: number;                // s travelled since leaving the board
  offCall: number;             // the next call of its run off the board
  offAt: number;               // the off-layout place it is calling at, -1 if none
};

/** What a train step can report back to the sim. */
export type TrainEvent = { type: "arrived" | "departed"; station: string };

/** Shared sim state the train logic reads and writes. */
export type World4Trains = {
  owner: Int32Array;           // block -> train index, or -1
  switchStates: SwitchState[];
  rng: Rng;
  /** Distance ahead the train must stop by for level crossings that are not closed. */
  gateStop?: (t: Train) => number;
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
    const run = runFrom(t, next);
    if (!tryReserve(w, t, self, run)) return;
    if (t.dir > 0) t.hi = run[run.length - 1];
    else t.lo = run[run.length - 1];
  }
}

/** The entries to reserve together from `next`: just it, or the whole opposed stretch and room beyond. */
function runFrom(t: Train, next: number): number[] {
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
  return run;
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
 * trip, so a second train starts at the far end; routes leaving the board: their
 * runs off it count too, and a train placed there starts off the board). Blocked or
 * opposed spots are skipped by moving SPAWN_STEP metres on. Returns null if nowhere fits.
 */
export function spawn(w: World4Trains, plan: Plan, k: number, planIndex: number, id: string, self: number): Train | null {
  const L = plan.route.length;
  const len = plan.length;
  const closed = plan.route.closed;
  if (!closed && len > L && !plan.offRuns[0] && !plan.offRuns[1]) return null;
  // The round: on along the route, off beyond its end, (shuttles) back along it, off beyond its start.
  const offLen = (e: 0 | 1) => (plan.offRuns[e] ? plan.offRuns[e]!.total * plan.offRuns[e]!.speed : 0);
  const segs: Array<{ kind: "on" | "back" | "off"; len: number; end: 0 | 1 }> = closed ? [{ kind: "on", len: L, end: 1 }]
    : plan.route.through ? [{ kind: "on", len: L, end: 1 }, { kind: "off", len: offLen(1), end: 1 }]
      : [{ kind: "on", len: L, end: 1 }, { kind: "off", len: offLen(1), end: 1 }, { kind: "back", len: L, end: 0 }, { kind: "off", len: offLen(0), end: 0 }];
  const cycle = segs.reduce((a, x) => a + x.len, 0);
  // Loop services start at staggered offsets so different services don't all queue at r = 0.
  const offset = closed ? ((planIndex * SERVICE_STAGGER) % 1) * L : 0;
  for (let a = 0; a * SPAWN_STEP < cycle; a++) {
    let p = (((offset + (k * cycle) / plan.svc.count + a * SPAWN_STEP) % cycle) + cycle) % cycle;
    let seg = segs[0];
    for (const x of segs) { seg = x; if (p < x.len) break; p -= x.len; }
    const t: Train = {
      id, plan, r: 0, dir: 1, speed: 0, phase: "running", dwellLeft: 0, atStation: null, servedR: NaN,
      lo: 0, hi: 0, wants: [], stoppedFor: 0, flipped: false, odometer: 0, stops: 0, waited: 0, maxWait: 0,
      off: -1, offT: 0, offCall: 0, offAt: -1,
    };
    if (seg.kind === "off") {
      // Out of sight, part-way along its run.
      const run = plan.offRuns[seg.end]!;
      t.off = seg.end;
      t.dir = seg.end === 1 ? 1 : -1;
      t.r = seg.end === 1 ? L : 0;
      t.offT = p / run.speed;
      t.offCall = run.calls.findIndex((c) => c.at > t.offT);
      if (t.offCall < 0) t.offCall = run.calls.length;
      t.phase = "off";
      return t;
    }
    if (len > L) continue;
    if (closed) t.r = L + p;                              // lap 1, so the tail index stays positive
    else if (seg.kind === "on") t.r = Math.min(Math.max(p, len), L);
    else { t.dir = -1; t.r = Math.min(Math.max(L - p, 0), L - len); }
    const r = t.r;
    const dir = t.dir;
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

/** The next stop's id: a station on the board, or (if none comes first) the first off-layout stop beyond the edge it is heading for. */
export function nextStopOf(t: Train): string | null {
  if (t.off >= 0) {
    const run = t.plan.offRuns[t.off]!;
    return run.calls[t.offCall]?.id ?? null;
  }
  const on = nextStop(t)?.station;
  if (on) return on;
  const route = t.plan.route;
  const run = route.closed ? null : t.plan.offRuns[route.through || t.dir > 0 ? 1 : 0];
  return run?.calls[0]?.id ?? null;
}

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
  if (t.off >= 0) return stepOff(w, t, self, dt);
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
  // Where the route leaves the board, its end is no place to stop: the train runs off.
  const exitAhead = !route.closed && plan.offRuns[t.dir > 0 ? 1 : 0] !== null;
  const resEnd = t.dir > 0 ? r1(plan, t.hi) : r0(plan, t.lo);
  const resLimit = atPathEnd && exitAhead ? Infinity : (resEnd - t.r) * t.dir - (atPathEnd ? 0 : SAFETY);
  const gate = w.gateStop ? w.gateStop(t) : Infinity;
  const limit = Math.min(resLimit, gate);
  const stop = nextStop(t);
  const toStop = stop && stop.dist <= limit;
  const dist = Math.max(0, toStop ? stop.dist : limit);
  const terminal = toStop || (atPathEnd && !exitAhead && gate >= resLimit);

  let vStop = Math.sqrt(2 * type.decel * dist);
  if (dist > ARRIVE && vStop < CREEP) vStop = CREEP;
  const cap = Math.min(type.maxSpeed, curveCap(t), vStop);
  t.speed = t.speed < cap ? Math.min(cap, t.speed + type.accel * dt) : cap;
  const move = Math.min(t.speed * dt, dist);
  t.r += t.dir * move;
  t.odometer += move;
  release(w, t, self);
  if (exitAhead && atPathEnd && (t.r - t.dir * plan.length - (t.dir > 0 ? route.length : 0)) * t.dir >= 0) {
    leave(w, t, self);
    return event;
  }

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

// -- off the board --------------------------------------------------------------

/** The tail is past the edge: the train hands back its blocks and is off the board. */
function leave(w: World4Trains, t: Train, self: number): void {
  for (let K = t.lo; K <= t.hi; K++) {
    const b = entryOf(t.plan, K).block;
    if (w.owner[b] === self) w.owner[b] = -1;
  }
  t.off = t.dir > 0 ? 1 : 0;
  t.offT = 0;
  t.offCall = 0;
  t.offAt = -1;
  t.phase = "off";
  t.stoppedFor = 0;
  t.waited = 0;
  t.wants = [];
}

/** Off the board: travel, call at off-layout stops, then come back on when there is room. */
function stepOff(w: World4Trains, t: Train, self: number, dt: number): TrainEvent | null {
  const run = t.plan.offRuns[t.off]!;
  if (t.offAt >= 0) {
    t.dwellLeft -= dt;
    if (t.dwellLeft > 0) return null;
    const station = run.calls[t.offCall - 1].id;
    t.offAt = -1;
    return { type: "departed", station };
  }
  if (t.offT < run.total) {
    const step = Math.min(dt, run.total - t.offT);
    t.offT += step;
    t.odometer += step * run.speed;
    const call = run.calls[t.offCall];
    if (call && t.offT >= call.at) {
      t.offCall++;
      t.offAt = call.place;
      t.dwellLeft = t.plan.svc.dwell * (0.85 + 0.3 * w.rng());
      t.stops++;
      return { type: "arrived", station: call.id };
    }
    return null;
  }
  if (!reenter(w, t, self, run)) {
    t.stoppedFor += dt;
    t.waited += dt;
    t.maxWait = Math.max(t.maxWait, t.waited);
  }
  return null;
}

/** Back on at the edge if the first stretch is free, at a speed it can stop from in the room it has. */
function reenter(w: World4Trains, t: Train, self: number, run: NonNullable<Plan["offRuns"][number]>): boolean {
  const p = t.plan;
  const L = p.route.length;
  const end = run.reenter;
  const dir: 1 | -1 = end === 0 ? 1 : -1;
  t.dir = dir;
  t.r = end === 0 ? 0 : L;
  const K = indexAt(p, end === 0 ? 1e-6 : L - 1e-6);
  t.lo = t.hi = K;
  if (!tryReserve(w, t, self, runFrom(t, K))) return false;
  const Ks = runFrom(t, K);
  t.lo = Math.min(...Ks);
  t.hi = Math.max(...Ks);
  // A shuttle comes back the other way round: its old tail leads.
  if (end === t.off) t.flipped = !t.flipped;
  t.off = -1;
  t.offAt = -1;
  t.phase = "running";
  t.servedR = NaN;
  t.stoppedFor = 0;
  t.waited = 0;
  t.speed = run.speed;
  extend(w, t, self);
  const ahead = (dir > 0 ? r1(p, t.hi) - t.r : t.r - r0(p, t.lo)) - SAFETY;
  const room = Math.max(0, Math.min(ahead, w.gateStop ? w.gateStop(t) : Infinity));
  t.speed = Math.min(run.speed, curveCap(t), Math.sqrt(2 * p.type.decel * room));
  return true;
}

/**
 * Where a train is for the level crossings: on the board, or (off it) due back
 * within `within` seconds, as if already running toward the edge it comes back at.
 */
export function approach(t: Train, within: number): { r: number; dir: 1 | -1; speed: number; delay: number } | null {
  if (t.off < 0) return { r: t.r, dir: t.dir, speed: t.speed, delay: t.phase === "dwelling" ? t.dwellLeft : 0 };
  const run = t.plan.offRuns[t.off]!;
  const left = run.total - t.offT + (t.offAt >= 0 ? t.dwellLeft : 0);
  if (left > within || t.offCall < run.calls.length) return null;
  if (left <= 0 && t.wants.length) return null;           // waiting for room to come back on: it asks again then
  const dir: 1 | -1 = run.reenter === 0 ? 1 : -1;
  const edge = run.reenter === 0 ? 0 : t.plan.route.length;
  return { r: edge - dir * left * run.speed, dir, speed: run.speed, delay: 0 };
}

/** Whether a car whose middle is at route coordinate r is on the board (not out past an edge). */
export function onBoard(t: Train, r: number): boolean {
  if (t.off >= 0) return false;
  const route = t.plan.route;
  if (route.closed) return true;
  return !((r < 0 && t.plan.offRuns[0]) || (r > route.length && t.plan.offRuns[1]));
}

/** Bogie-based pose of every car (§7.3): front bogie 15% into the car, rear 70% further back. */
export function forEachCar(
  t: Train, at: (r: number) => { x: number; y: number; z: number },
  fn: (car: number, x: number, y: number, z: number, heading: number, pitch: number, mid: number) => void,
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
    fn(c, (ax + b.x) / 2, (ay + b.y) / 2, (az + b.z) / 2, heading, pitch, t.r - t.dir * (lead + 0.5 * l));
    front += l;
  }
}
