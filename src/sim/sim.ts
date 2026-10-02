// The simulation clock (§7): a fixed 1/30 s step over all trains, block
// reservations and switch states, plus events, deadlock detection and
// allocation-free snapshots for the scene. Pure TypeScript, runs in Node.

import type { World } from "../model/build";
import { buildWorld } from "../model/build";
import { type Issue, error } from "../model/validate";
import type { Report } from "../model/validate";
import { locate } from "../model/routes";
import { pointAt, headingAt } from "../model/geometry";
import { profileZ } from "../model/heights";
import type { SwitchState } from "../model/trackGraph";
import { TIME_SCALE } from "../model/catalog";
import { type Blocks, buildBlocks } from "./blocks";
import { type Plan, buildPlans } from "./services";
import { type Train, type Phase, type World4Trains, spawn, stepTrain, forEachCar, nextStopOf, entryOf } from "./trains";
import { rng } from "../util/rng";

export const DT = (1 / 30) * TIME_SCALE;
const DEADLOCK_AFTER = 120;      // s stationary (not dwelling) before trains count as stuck

export type SimEvent =
  | { t: number; type: "arrived" | "departed"; train: string; service: string; station: string }
  | { t: number; type: "deadlock"; issue: Issue };

export type CarPose = { x: number; y: number; z: number; heading: number; pitch: number };
export type TrainSnapshot = {
  id: string;
  service: string;
  train: string;              // catalog type
  phase: Phase;
  speed: number;
  track: string;
  s: number;
  direction: 1 | -1;
  heading: number;
  length: number;             // m, whole consist
  atStation: string | null;
  nextStop: string | null;
  cars: CarPose[];
  reserved: number[];
};
export type SimSnapshot = { time: number; trains: TrainSnapshot[]; switches: SwitchState[]; blocks: number[] };

export class Sim {
  readonly world: World;
  readonly blocks: Blocks;
  readonly plans: Plan[];
  readonly trains: Train[] = [];
  events: SimEvent[] = [];
  deadlock: Issue | null = null;
  private state: World4Trains;
  private ticks = 0;

  constructor(world: World, opts: { seed?: number } = {}) {
    this.world = world;
    this.blocks = buildBlocks(world);
    this.plans = buildPlans(world, this.blocks);
    this.state = {
      owner: new Int32Array(this.blocks.blocks.length).fill(-1),
      switchStates: world.graph.switches.map(() => "straight"),
      rng: rng(opts.seed ?? world.layout.seed, "sim"),
    };
    this.plans.forEach((plan, pi) => {
      for (let k = 0; k < plan.svc.count; k++) {
        const t = spawn(this.state, plan, k, pi, `${plan.svc.id}-${k + 1}`, this.trains.length);
        if (t) this.trains.push(t);
      }
    });
  }

  get time(): number {
    return this.ticks * DT;
  }

  step(): void {
    this.ticks++;
    this.trains.forEach((t, i) => {
      const ev = stepTrain(this.state, t, i, DT);
      if (ev) this.events.push({ t: this.time, type: ev.type, train: t.id, service: t.plan.svc.id, station: ev.station });
    });
    if (this.ticks % 30 === 0 && !this.deadlock) this.checkDeadlock();
  }

  /** §7.4: everyone stuck, or a cycle of stuck trains each waiting on another's blocks. */
  private checkDeadlock(): void {
    const stuck = (t: Train) => t.phase !== "dwelling" && t.stoppedFor > DEADLOCK_AFTER;
    const owner = this.state.owner;
    let ring: Train[] | null = this.trains.length > 0 && this.trains.every(stuck) ? this.trains : null;
    for (const start of this.trains) {
      if (ring || !stuck(start)) continue;
      const path: Train[] = [start];
      for (let cur = start; ;) {
        const next = cur.wants.map((b) => this.trains[owner[b]]).find((o) => o && stuck(o));
        if (!next) break;
        const at = path.indexOf(next);
        if (at >= 0) { ring = path.slice(at); break; }
        path.push(next);
        cur = next;
      }
    }
    if (!ring) return;
    const held = (t: Train) => this.held(t).join(", ");
    const desc = ring.map((t) => `${t.id} (holds blocks ${held(t)}; wants ${t.wants.join(", ") || "nothing"})`).join("; ");
    const svcIndex = this.world.layout.services.findIndex((s) => s.id === ring![0].plan.svc.id);
    this.deadlock = error("DEADLOCK", `trains stopped for over ${DEADLOCK_AFTER} s waiting on each other: ${desc}; add a passing loop, reduce train count, or change routes`, `services[${svcIndex}]`);
    this.events.push({ t: this.time, type: "deadlock", issue: this.deadlock });
  }

  private held(t: Train): number[] {
    const out = new Set<number>();
    for (let k = t.lo; k <= t.hi; k++) out.add(entryOf(t.plan, k).block);
    return [...out];
  }

  /** Position on the map of route coordinate r for a plan; reuses one object. */
  private pos = { x: 0, y: 0, z: 0 };
  private at(plan: Plan, r: number) {
    const loc = locate(plan.route, this.world.tracks, r);
    const [x, y] = pointAt(this.world.tracks.get(loc.track)!.path, loc.s);
    this.pos.x = x;
    this.pos.y = y;
    this.pos.z = profileZ(this.world.profiles.get(loc.track)!, loc.s);
    return this.pos;
  }

  /** Current state. Pass the previous snapshot as `out` to update it in place. */
  snapshot(out?: SimSnapshot): SimSnapshot {
    const snap: SimSnapshot = out ?? { time: 0, trains: [], switches: [], blocks: [] };
    snap.time = this.time;
    snap.switches = this.state.switchStates;
    const owner = this.state.owner;
    if (snap.blocks.length !== owner.length) snap.blocks = new Array<number>(owner.length);
    for (let b = 0; b < owner.length; b++) snap.blocks[b] = owner[b];
    this.trains.forEach((t, i) => {
      const loc = locate(t.plan.route, this.world.tracks, t.r);
      const path = this.world.tracks.get(loc.track)!.path;
      const ts: TrainSnapshot = snap.trains[i] ?? {
        id: t.id, service: t.plan.svc.id, train: t.plan.svc.train, phase: t.phase, speed: 0, track: "", s: 0,
        direction: 1, heading: 0, length: t.plan.length, atStation: null, nextStop: null, cars: t.plan.cars.map(() => ({ x: 0, y: 0, z: 0, heading: 0, pitch: 0 })), reserved: [],
      };
      ts.phase = t.phase;
      ts.speed = t.speed;
      ts.track = loc.track;
      ts.s = loc.s;
      ts.direction = (loc.dir * t.dir) as 1 | -1;
      ts.heading = headingAt(path, loc.s) + (ts.direction < 0 ? Math.PI : 0);
      ts.atStation = t.atStation;
      ts.nextStop = nextStopOf(t);
      ts.reserved.length = 0;
      for (let b = 0; b < owner.length; b++) if (owner[b] === i) ts.reserved.push(b);
      forEachCar(t, (r) => this.at(t.plan, r), (c, x, y, z, heading, pitch) => {
        const car = ts.cars[c];
        car.x = x; car.y = y; car.z = z; car.heading = heading; car.pitch = pitch;
      });
      snap.trains[i] = ts;
    });
    return snap;
  }
}

export type ServiceStats = { service: string; stops: number; avgSpeed: number; maxWait: number };
export type SimReport = { report: Report; events: SimEvent[]; perService: ServiceStats[]; deadlock?: Issue };

/** Validate, then run the sim headlessly for `seconds` of simulated time. */
export function simulate(json: unknown, seconds: number): SimReport {
  const { world, report } = buildWorld(json);
  if (!world) return { report, events: [], perService: [] };
  const sim = new Sim(world);
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps && !sim.deadlock; i++) sim.step();
  const perService = world.layout.services.map((svc) => {
    const trains = sim.trains.filter((t) => t.plan.svc.id === svc.id);
    return {
      service: svc.id,
      stops: trains.reduce((a, t) => a + t.stops, 0),
      avgSpeed: trains.length ? trains.reduce((a, t) => a + t.odometer, 0) / trains.length / Math.max(sim.time, 1e-9) : 0,
      maxWait: trains.reduce((a, t) => Math.max(a, t.maxWait), 0),
    };
  });
  if (!sim.deadlock) return { report, events: sim.events, perService };
  const withDeadlock = { ...report, ok: false, issues: [...report.issues, sim.deadlock] };
  return { report: withDeadlock, events: sim.events, perService, deadlock: sim.deadlock };
}
