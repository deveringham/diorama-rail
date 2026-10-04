// The residents at large. Each person has at most one task — go to work, go home,
// visit somewhere, or stroll to a spot — and, when they have none, now and then
// thinks of one. For each task the planner finds the quickest journey (on foot, by
// their own car, by train, by bus, or a mix) and they follow it: walking on the
// right of walkways (waiting at kerbs and level crossings), driving their car from
// its bay to one near the destination, waiting on a platform for a train heading
// their way and riding it to their stop, or waiting at a bus stop for a bus of their
// line and riding it to theirs. At the destination they go inside for the task's
// duration (or linger at a spot). Pure TypeScript, deterministic.

import type { World } from "../model/build";
import type { Person, Building } from "../model/town";
import type { StopSide } from "../model/buses";
import { platformPoint } from "../model/town";
import { wayPoint, wayHeading } from "../model/walks";
import { locate } from "../model/routes";
import type { Plan } from "./services";
import type { Train } from "./trains";
import type { Traffic, WalkerView } from "./traffic";
import { type Place, type Route, type Leg, type WalkStep, Planner } from "./planner";
import { type Rng, rng, range } from "../util/rng";

type P3 = [number, number, number];

const SPEED: [number, number] = [0.9, 1.5];   // m/s
const IDLE_RATE = 1 / 30;       // chance per second that someone with nothing to do thinks of a task
const RETRY_RATE = 1 / 60;      // the same, after finding no way to get anywhere
const LOOK_BEFORE = 0.7;        // s at the kerb before stepping onto a zebra
const UNMARKED_GAP = 2;         // s spare beyond the time to cross, when waiting for a gap in the traffic
const GAP_PATIENCE = 8;         // s waiting for a gap before stepping out in front of cars that can stop
const CARS_PATIENCE = 5;        // s a car may wait at a zebra before the people let it through
const CARS_TURN = 4;            // s they then hold back
const GATE_MARGIN = 1;          // m short of a level crossing's zone people wait
const STUCK_AFTER = 120;        // s waiting at a kerb or crossing before someone counts as stuck
const PASS = 4;                 // s to walk through a station building between door and platform
const BOARD_TIME = 2.5;         // s to step from the platform into a train (and out)
const PLATFORM_SPREAD = 22;     // m along the platform either side of the entry where people wait
const DURATION = {              // s spent at the destination
  work: [240, 720], home: [180, 600], visit: [40, 240], stroll: [20, 90],
} as const;

export type TaskKind = keyof typeof DURATION;
export type Task = { kind: TaskKind; dest: Place; duration: number; label: string; started: number; arrived: number };
// platform: walking to a place on the platform, then waiting there; exit: off the train and across
// the platform to its entry; pass: through the station building (in or out), unseen; stop: at a
// bus stop, stepping to a place to wait and waiting; board/alight: on to or off a train or bus.
export type Mode = "inside" | "walk" | "wait" | "platform" | "board" | "train" | "alight" | "exit" | "drive" | "linger" | "pass" | "stop" | "bus";

export type PersonState = Body;
type Body = {
  id: number;
  speed: number;
  side: number;                 // 0..1: how far right of the walkway's centre they keep
  mode: Mode;
  at: Place | null;             // where they are between journeys
  task: Task | null;
  route: Route | null;
  leg: number;
  step: number;
  way: number; d: number; to: number; dir: 1 | -1;    // on a walkway step
  link: P3[] | null; linkAt: number; linkLen: number[];   // on a straight link (cumulative lengths)
  timer: number;
  waited: number;
  maxWait: number;
  odometer: number;
  car: number;                  // their car (traffic index), -1 if none
  station: number;              // waiting at, or riding to/from (town.stations index)
  entrance: number;             // the station entrance used (index into its entrances)
  platS: number;                // where along the platform they wait (track s)
  train: number;
  bus: number;                  // the bus (traffic car index) boarding, riding or leaving, else -1
  stopSide: number;             // the side of a bus stop waiting at or getting off at (world.buses.sides)
  ride: "train" | "bus";        // what boarding or alighting is about
  from: P3; dest: P3;           // boarding and alighting moves on the platform or at the kerb
  pos: P3;                      // last position (for standing still)
  heading: number;
  lastWork: number;
  trips: number;                // journeys made
  stranded: boolean;            // found no way to go anywhere last time they tried
  modes: string[];              // ways of travel used so far on this journey
  reserved: number;             // bay held for the journey's drive, -1 if none
};

export type PersonSnapshot = { x: number; y: number; z: number; heading: number; visible: boolean; moving: boolean; step: number };
export type PeopleStats = {
  people: number; outside: number; walking: number; driving: number; riding: number; waiting: number; onBus: number; atStops: number;
  maxStopWait: number;          // s the longest anyone has waited at a bus stop
  tasks: number; trips: Record<string, number>; avgTrip: number; avgSpeed: number; maxWait: number; stuck: number; crossed: number;
};

export class People implements WalkerView {
  readonly bodies: Body[] = [];
  readonly busy: Uint8Array;
  readonly planner: Planner;
  /** People aboard each train (index into sim.trains). */
  readonly riders: number[][] = [];
  /** People aboard each bus (by traffic car index). */
  readonly onBus = new Map<number, number[]>();
  private world: World;
  private r: Rng;
  private time = 0;
  private carsTurnUntil: Float64Array;
  private crossed = 0;
  private tasksDone = 0;
  private tripTime = 0;
  private tripCount = 0;
  private trips = new Map<string, number>();
  private served = new Map<number, number>();   // train -> stop count already handled for alighting
  private busServed = new Map<number, number>();   // bus -> stop count already handled for alighting
  private stopWait = new Float64Array(0);       // s each person has been waiting at a bus stop
  private maxStopWait = 0;

  constructor(world: World, traffic: Traffic, plans: Plan[], seed: number) {
    this.world = world;
    this.r = rng(seed, "people");
    this.busy = new Uint8Array(world.walks.crossings.length);
    this.carsTurnUntil = new Float64Array(world.walks.crossings.length);
    this.stopWait = new Float64Array(world.town.people.length);
    this.planner = new Planner(world, traffic, plans);
    const town = world.town;
    for (const p of town.people) {
      const job = p.job;
      const atWork = job !== null && this.r() < 0.35;
      const place: Place = { kind: "building", id: atWork ? job!.building : p.home };
      const kind: TaskKind = atWork ? "work" : "home";
      const duration = atWork ? range(this.r, 0, 600) : range(this.r, 0, 400);
      const b = town.buildings[place.id];
      this.bodies.push({
        id: p.id, speed: range(this.r, SPEED[0], SPEED[1]), side: this.r(), mode: "inside", at: place,
        task: { kind, dest: place, duration, label: this.label(kind, place), started: 0, arrived: 0 },
        route: null, leg: 0, step: 0, way: -1, d: 0, to: 0, dir: 1, link: null, linkAt: 0, linkLen: [], timer: duration,
        waited: 0, maxWait: 0, odometer: 0, car: traffic.carOf[p.id], station: -1, entrance: -1, platS: 0, train: -1, bus: -1, stopSide: -1, ride: "train",
        from: [0, 0, 0], dest: [0, 0, 0], pos: [...b.door] as P3, heading: 0, lastWork: atWork ? 0 : -Infinity, trips: 0, stranded: false, modes: [], reserved: -1,
      });
    }
  }

  // -- describing ----------------------------------------------------------------------

  private label(kind: TaskKind, p: Place): string {
    const name = this.placeName(p);
    switch (kind) {
      case "work": return `work at ${name}`;
      case "home": return `home to ${name}`;
      case "visit": return `a visit to ${name}`;
      case "stroll": return `a stroll along ${name}`;
    }
  }

  placeName(p: Place): string {
    const town = this.world.town;
    switch (p.kind) {
      case "building": return town.buildings[p.id].name;
      case "spot": return town.spots[p.id].name;
      case "station": return `${town.stations[p.id].name} Station`;
      case "bay": {
        const b = town.bays[p.id];
        return b.lot ? town.lots.find((l) => l.id === b.lot)!.name : this.world.roads.roads.get(b.road)!.spec.name ?? b.road;
      }
    }
  }

  // -- per tick ------------------------------------------------------------------------

  step(dt: number, traffic: Traffic, trains: Train[]): void {
    this.time += dt;
    while (this.riders.length < trains.length) this.riders.push([]);
    // Drivers whose car is now in its bay get out.
    for (const ci of traffic.arrivals) {
      const owner = traffic.cars[ci].owner;
      const b = owner >= 0 ? this.bodies[owner] : undefined;
      if (b && b.mode === "drive") this.nextLeg(b, traffic);
    }
    traffic.arrivals.length = 0;
    this.trainStops(trains);
    this.busStops(traffic);

    const waiting = new Uint8Array(this.busy.length);
    for (const b of this.bodies) {
      switch (b.mode) {
        case "inside":
        case "linger":
          if (b.task && b.task.arrived >= 0 && !Number.isNaN(b.task.arrived)) {
            b.timer -= dt;
            if (b.timer <= 0) this.finish(b);
          }
          if (!b.task && this.r() < dt * (b.stranded ? RETRY_RATE : IDLE_RATE)) this.think(b, traffic);
          break;
        case "pass":
          b.timer -= dt;
          if (b.timer <= 0) this.nextLeg(b, traffic);
          break;
        case "board":
          b.timer -= dt;
          if (b.timer <= 0) b.mode = b.ride === "bus" ? "bus" : "train";
          break;
        case "alight":
          b.timer -= dt;
          if (b.timer <= 0 && b.ride === "bus") {
            b.bus = -1;
            this.nextLeg(b, traffic);
          } else if (b.timer <= 0) {
            b.mode = "exit";
            this.setLink(b, [b.dest, this.entranceOf(b).entry]);
          }
          break;
        case "platform":
          this.followLink(b, b.speed * dt);
          break;
        case "stop":
          this.followLink(b, b.speed * dt);
          this.stopWait[b.id] += dt;
          this.maxStopWait = Math.max(this.maxStopWait, this.stopWait[b.id]);
          break;
        case "exit":
          if (this.followLink(b, b.speed * dt) >= 0) this.offPlatform(b, traffic);
          break;
        case "walk":
        case "wait":
          this.walk(b, dt, traffic, waiting);
          break;
        default:
          break;
      }
      if (b.mode === "wait") {
        b.waited += dt;
        b.maxWait = Math.max(b.maxWait, b.waited);
      } else b.waited = 0;
    }
    // Cars give way where someone is on a crossing, or waiting at a zebra (unless it is the cars' turn).
    this.busy.fill(0);
    for (const b of this.bodies) {
      if ((b.mode === "walk" || b.mode === "wait") && b.way >= 0 && !b.link) {
        const c = this.world.walks.ways[b.way].crossing;
        if (c >= 0) this.busy[c] = 1;
      }
    }
    this.world.walks.crossings.forEach((c, i) => {
      if (c.kind !== "zebra") return;
      if (!this.busy[i] && traffic.carWaitingAt(i) > CARS_PATIENCE && this.time >= this.carsTurnUntil[i]) this.carsTurnUntil[i] = this.time + CARS_TURN;
      if (waiting[i] && this.time >= this.carsTurnUntil[i]) this.busy[i] = 1;
    });
  }

  /** Thinks of a task and a way to do it; stays put if there is nowhere to go. */
  private think(b: Body, traffic: Traffic): void {
    const town = this.world.town;
    const person = town.people[b.id];
    const here = b.at!;
    const atHome = here.kind === "building" && here.id === person.home;
    const atWork = here.kind === "building" && person.job !== null && here.id === person.job.building;
    const options: Array<{ kind: TaskKind; w: number }> = [];
    if (!atHome) options.push({ kind: "home", w: atWork ? 4 : 3 });
    if (person.job && !atWork && this.time - b.lastWork > 900) options.push({ kind: "work", w: atHome ? 2.5 : 1 });
    options.push({ kind: "visit", w: 1.5 });
    if (town.spots.length) options.push({ kind: "stroll", w: atHome ? 1 : 0.4 });
    for (let attempt = 0; attempt < 4 && options.length; attempt++) {
      let x = this.r() * options.reduce((a, o) => a + o.w, 0);
      const k = options.findIndex((o) => (x -= o.w) < 0);
      const kind = options[k < 0 ? options.length - 1 : k].kind;
      const dest = this.destination(kind, person, here);
      if (!dest) { options.splice(Math.max(0, k), 1); continue; }
      const route = this.route(b, person, here, dest, traffic);
      if (!route) continue;
      const [lo, hi] = DURATION[kind];
      b.task = { kind, dest, duration: range(this.r, lo, hi), label: this.label(kind, dest), started: this.time, arrived: NaN };
      b.stranded = false;
      this.start(b, route, traffic);
      return;
    }
    b.stranded = true;                               // nowhere reachable just now: think again later
  }

  private destination(kind: TaskKind, person: Person, here: Place): Place | null {
    const town = this.world.town;
    if (kind === "home") return { kind: "building", id: person.home };
    if (kind === "work") return person.job ? { kind: "building", id: person.job.building } : null;
    if (kind === "stroll") return town.spots.length ? { kind: "spot", id: Math.floor(this.r() * town.spots.length) } : null;
    // A visit: landmarks most often, then workplaces (shops and the like) and friends' homes, nearer ones more likely.
    const from = this.where(here);
    const weight = (b: Building) => {
      if (here.kind === "building" && here.id === b.id) return 0;
      if (!b.access && !b.bays.length) return 0;
      const w = b.functions.includes("landmark") ? 3 : b.functions.includes("workplace") ? 1 : 0.4;
      return w / (1 + Math.hypot(b.door[0] - from[0], b.door[1] - from[1]) / 300);
    };
    const ws = town.buildings.map(weight);
    const total = ws.reduce((a, w) => a + w, 0);
    if (!total) return null;
    let x = this.r() * total;
    const id = ws.findIndex((w) => (x -= w) < 0);
    return { kind: "building", id: id < 0 ? ws.length - 1 : id };
  }

  private where(p: Place): P3 {
    const town = this.world.town;
    switch (p.kind) {
      case "building": return town.buildings[p.id].door;
      case "spot": return town.spots[p.id].at;
      case "station": return town.stations[p.id].entrances[0]?.entry ?? [0, 0, 0];
      case "bay": return town.bays[p.id].kerb;
    }
  }

  private route(b: Body, person: Person, from: Place, to: Place, traffic: Traffic): Route | null {
    const car = b.car;
    const carBay = car >= 0 && traffic.cars[car].state === "parked" ? traffic.cars[car].bay : -1;
    return this.planner.plan(person, from, to, carBay, car);
  }

  /** Sets off on a journey: out of the building (or away from the spot). */
  private start(b: Body, route: Route, traffic: Traffic): void {
    b.route = route;
    b.leg = -1;
    b.at = null;
    // Hold the bay it will park in, so nobody else plans to take it meanwhile.
    if (b.reserved >= 0 && traffic.bayCar[b.reserved] === b.car) traffic.bayCar[b.reserved] = -1;
    b.reserved = -1;
    const drive = route.legs.find((l) => l.mode === "drive");
    if (drive?.mode === "drive") { traffic.bayCar[drive.to] = drive.car; b.reserved = drive.to; }
    this.nextLeg(b, traffic);
  }

  /** On to the next leg of the journey, or arrival. */
  private nextLeg(b: Body, traffic: Traffic): void {
    const route = b.route!;
    b.leg++;
    b.step = 0;
    if (b.leg >= route.legs.length) { this.arrive(b); return; }
    const leg = route.legs[b.leg];
    if (b.modes[b.modes.length - 1] !== leg.mode) b.modes.push(leg.mode);
    if (leg.mode === "walk") {
      // A walk that starts on a crossing starts at its kerb (where the person checks the traffic).
      const first = leg.steps[0];
      if (first.kind === "way" && this.world.walks.ways[first.way].crossing >= 0) {
        leg.steps.unshift({ kind: "link", pts: [wayPoint(this.world.walks.ways[first.way], first.from)] });
      }
      b.mode = "walk";
      this.startStep(b);
    } else if (leg.mode === "bus") {
      // At the stop: step to a place to wait near the sign.
      const side = this.world.buses.sides[leg.from];
      b.stopSide = leg.from;
      b.mode = "stop";
      this.stopWait[b.id] = 0;
      this.setLink(b, [side.at, this.stopSpot(side)]);
    } else if (leg.mode === "drive") {
      // The bay may have been taken since: then think again from here.
      if (traffic.bayCar[leg.to] >= 0 && traffic.bayCar[leg.to] !== leg.car) { this.replan(b, { kind: "bay", id: leg.from }, traffic); return; }
      traffic.drive(leg.car, leg.lanes, leg.to);
      b.reserved = -1;
      b.mode = "drive";
    } else {
      // On the platform (the side of the entrance used): find a place to wait.
      b.station = leg.from;
      if (b.entrance < 0) b.entrance = this.entranceAt(leg.from, this.lastPoint(b));
      const e = this.entranceOf(b);
      b.mode = "platform";
      b.platS = this.clampS(leg.from, e.entryS + range(this.r, -PLATFORM_SPREAD, PLATFORM_SPREAD));
      this.setLink(b, [e.entry, this.platform(leg.from, b.platS, range(this.r, 0.35, 0.9), e.side)]);
    }
  }

  private replan(b: Body, here: Place, traffic: Traffic): void {
    const person = this.world.town.people[b.id];
    const route = b.task ? this.route(b, person, here, b.task.dest, traffic) : null;
    if (!route) {
      // Stranded: give up the task and stay put (at a bay, wait there as if at a spot).
      b.task = null;
      b.route = null;
      b.mode = "linger";
      b.at = here;
      b.pos = [...this.where(here)] as P3;
      return;
    }
    this.start(b, route, traffic);
  }

  private arrive(b: Body): void {
    const task = b.task!;
    const rt = b.route!;
    b.link = null;
    task.arrived = this.time;
    b.timer = task.duration;
    b.at = task.dest;
    b.route = null;
    b.trips++;
    this.tripCount++;
    this.tripTime += this.time - task.started;
    const modes = b.modes.join(" → ") || rt.modes;
    this.trips.set(modes, (this.trips.get(modes) ?? 0) + 1);
    b.modes = [];
    if (task.dest.kind === "building") b.mode = "inside";
    else {
      b.mode = "linger";
      b.pos = [...this.where(task.dest)] as P3;
    }
  }

  private finish(b: Body): void {
    if (b.task?.kind === "work") b.lastWork = this.time;
    b.task = null;
    this.tasksDone++;
  }

  private clampS(station: number, s: number): number {
    const spec = this.world.layout.stations.find((x) => x.id === this.world.town.stations[station].station)!;
    return Math.min(spec.at + spec.length / 2 - 3, Math.max(spec.at - spec.length / 2 + 3, s));
  }

  private platform(station: number, s: number, across: number, side: 1 | -1): P3 {
    return platformPoint(this.world, this.world.town.stations[station].station, this.clampS(station, s), across, side);
  }

  private entranceOf(b: Body) {
    const st = this.world.town.stations[b.station];
    return st.entrances[Math.max(0, Math.min(b.entrance, st.entrances.length - 1))];
  }

  /** The entrance of station si whose walkway end (its entry, or the building's door) is nearest p. */
  private entranceAt(si: number, p: P3 | null): number {
    const list = this.world.town.stations[si].entrances;
    if (!p) return 0;
    let best = 0;
    let bd = Infinity;
    list.forEach((e, k) => {
      const q = e.door ?? e.entry;
      const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (d < bd) { bd = d; best = k; }
    });
    return best;
  }

  /** The last point of the walk leg just finished (where it reached the station). */
  private lastPoint(b: Body): P3 | null {
    const leg = b.route?.legs[b.leg - 1];
    const step = leg?.mode === "walk" ? leg.steps[leg.steps.length - 1] : undefined;
    return step?.kind === "link" ? step.pts[step.pts.length - 1] : null;
  }

  // -- walking -----------------------------------------------------------------------------

  private setLink(b: Body, pts: P3[]): void {
    b.link = pts;
    b.linkAt = 0;
    b.linkLen = [0];
    for (let i = 1; i < pts.length; i++) b.linkLen.push(b.linkLen[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    b.way = -1;
  }

  private startStep(b: Body): void {
    const leg = b.route!.legs[b.leg] as Extract<Leg, { mode: "walk" }>;
    const st = leg.steps[b.step];
    if (st.kind === "link") { this.setLink(b, st.pts); return; }
    b.link = null;
    b.way = st.way;
    b.d = st.from;
    b.to = st.to;
    b.dir = st.to >= st.from ? 1 : -1;
  }

  /** Moves along a link; returns the distance left over at its end (or -1 if not there yet). */
  private followLink(b: Body, move: number): number {
    const total = b.linkLen[b.linkLen.length - 1];
    const left = total - b.linkAt;
    if (move < left) {
      b.linkAt += move;
      b.odometer += move;
      return -1;
    }
    b.linkAt = total;
    b.odometer += left;
    return move - left;
  }

  private walk(b: Body, dt: number, traffic: Traffic, waiting: Uint8Array): void {
    let left = b.speed * dt;
    const ways = this.world.walks.ways;
    for (let guard = 0; guard < 8; guard++) {
      const leg = b.route!.legs[b.leg] as Extract<Leg, { mode: "walk" }>;
      if (b.link) {
        const rest = this.followLink(b, left);
        if (rest < 0) { b.mode = "walk"; return; }
        // At the kerb of a crossing at the end of the link: step onto it only when it is safe.
        const next = leg.steps[b.step + 1];
        const c = next?.kind === "way" ? ways[next.way].crossing : -1;
        if (c >= 0 && !this.mayCross(b, c, next as Extract<WalkStep, { kind: "way" }>, traffic)) {
          b.mode = "wait";
          waiting[c] = 1;
          return;
        }
        left = rest;
      } else {
        const w = ways[b.way];
        const toEnd = Math.abs(b.to - b.d);
        // Wait short of level and foot crossings that are not open, unless already in their zone.
        let gateStop = Infinity;
        for (const g of w.gates) {
          const stop = b.dir > 0 ? g.at - g.zone - GATE_MARGIN : g.at + g.zone + GATE_MARGIN;
          const ahead = (stop - b.d) * b.dir;
          if (ahead < -0.05 || ahead > toEnd) continue;
          const shut = traffic.gates[g.gate].state !== "open" || g.also.some((k) => traffic.gates[k].state !== "open");
          if (shut) gateStop = Math.min(gateStop, Math.max(0, ahead));
        }
        if (gateStop < toEnd) {
          const move = Math.min(left, gateStop);
          this.advance(b, move);
          b.mode = left > gateStop ? "wait" : "walk";
          return;
        }
        if (left < toEnd) {
          this.advance(b, left);
          b.mode = "walk";
          return;
        }
        // At the kerb of a crossing: step onto it only when it is safe.
        const next = leg.steps[b.step + 1];
        const c = next?.kind === "way" ? ways[next.way].crossing : -1;
        if (c >= 0 && w.crossing < 0 && !this.mayCross(b, c, next as Extract<WalkStep, { kind: "way" }>, traffic)) {
          this.advance(b, toEnd);
          b.mode = "wait";
          waiting[c] = 1;
          return;
        }
        this.advance(b, toEnd);
        left -= toEnd;
        if (w.crossing >= 0 && (next?.kind !== "way" || ways[next.way].crossing < 0)) this.crossed++;
      }
      b.mode = "walk";
      b.step++;
      if (b.step >= leg.steps.length) { this.endWalk(b, traffic); return; }
      this.startStep(b);
    }
  }

  private advance(b: Body, move: number): void {
    b.d += b.dir * move;
    b.odometer += move;
  }

  private mayCross(b: Body, c: number, next: Extract<WalkStep, { kind: "way" }>, traffic: Traffic): boolean {
    const crossing = this.world.walks.crossings[c];
    if (crossing.kind === "zebra") {
      if (this.time < this.carsTurnUntil[c]) return false;
      if (b.mode !== "wait" || b.waited < LOOK_BEFORE) return false;
      return !traffic.crossingThreat(c, 0);
    }
    // Unmarked: wait for a gap in the traffic, but after a while just make sure the cars can stop.
    const len = Math.abs(next.to - next.from);
    return !traffic.crossingThreat(c, b.waited > GAP_PATIENCE ? 0 : len / b.speed + UNMARKED_GAP);
  }

  /** The end of a walking leg: at a station (in through its building if that is the way), a car, or the destination. */
  private endWalk(b: Body, traffic: Traffic): void {
    const next = b.route!.legs[b.leg + 1];
    const leg = b.route!.legs[b.leg];
    const last = leg.mode === "walk" ? leg.steps[leg.steps.length - 1] : undefined;
    if (next?.mode === "train") {
      b.station = next.from;
      b.entrance = this.entranceAt(next.from, last?.kind === "link" ? last.pts[last.pts.length - 1] : null);
    }
    if (next?.mode === "train" && this.entranceOf(b).via === "building") {
      b.mode = "pass";
      b.timer = PASS;
      b.link = null;
      return;
    }
    this.nextLeg(b, traffic);
  }

  /** Across the platform after getting off: on through the building, or straight on. */
  private offPlatform(b: Body, traffic: Traffic): void {
    b.link = null;
    if (this.entranceOf(b).via === "building") {
      b.mode = "pass";
      b.timer = PASS;
      return;
    }
    this.nextLeg(b, traffic);
  }

  // -- trains ------------------------------------------------------------------------------

  /** Passengers get off trains at their stop, and waiting people get on trains heading their way. */
  private trainStops(trains: Train[]): void {
    const town = this.world.town;
    trains.forEach((t, ti) => {
      if (t.phase !== "dwelling" || !t.atStation) return;
      const si = town.stations.findIndex((s) => s.station === t.atStation);
      if (si < 0) return;
      // Alight once per stop.
      if (this.served.get(ti) !== t.stops) {
        this.served.set(ti, t.stops);
        const stay: number[] = [];
        for (const id of this.riders[ti]) {
          const b = this.bodies[id];
          const leg = b.route?.legs[b.leg];
          if (leg?.mode === "train" && leg.to === si) this.alight(b, t, si);
          else stay.push(id);
        }
        this.riders[ti] = stay;
      }
      if (t.dwellLeft < 2) return;
      for (const b of this.bodies) {
        if (b.mode !== "platform" || b.station !== si || b.linkAt < b.linkLen[b.linkLen.length - 1]) continue;
        const leg = b.route!.legs[b.leg] as Extract<Leg, { mode: "train" }>;
        if (!leg.services.includes(t.plan.svc.id) || !this.headsFor(t, town.stations[leg.to].station)) continue;
        b.mode = "board";
        b.ride = "train";
        b.timer = BOARD_TIME;
        b.train = ti;
        b.from = [...b.pos] as P3;
        b.dest = this.platform(si, b.platS, 0.05, this.entranceOf(b).side);
        b.link = null;
        this.riders[ti].push(b.id);
      }
    });
  }

  /** Whether a train standing at a station will reach `station` before turning back. */
  private headsFor(t: Train, station: string): boolean {
    const route = t.plan.route;
    if (route.closed) return true;
    const stop = route.stops.find((s) => s.station === station);
    if (!stop) return false;
    const end = t.dir > 0 ? route.length : 0;
    const dir = Math.abs(t.r - end) < 0.5 ? -t.dir : t.dir;     // at a terminus it is about to reverse
    const centre = t.r - (t.dir * t.plan.length) / 2;
    return (stop.r - centre) * dir > 0;
  }

  private alight(b: Body, t: Train, si: number): void {
    const st = this.world.town.stations[si];
    const spec = this.world.layout.stations.find((x) => x.id === st.station)!;
    // Out of a door somewhere along the train, on the platform's edge.
    const loc = locate(t.plan.route, this.world.tracks, t.r - t.dir * range(this.r, 0.1, 0.9) * t.plan.length);
    const s = loc.track === spec.track ? loc.s : spec.at;
    b.train = -1;
    b.station = si;
    const next = b.route!.legs[b.leg + 1];
    const first = next?.mode === "walk" ? next.steps[0] : undefined;
    b.entrance = this.entranceAt(si, first?.kind === "link" ? first.pts[0] : null);
    const side = this.entranceOf(b).side;
    b.mode = "alight";
    b.ride = "train";
    b.timer = BOARD_TIME;
    b.from = this.platform(si, s, 0.05, side);
    b.dest = this.platform(si, s, 0.45, side);
    b.pos = [...b.dest] as P3;
    b.link = null;
  }



  // -- buses -------------------------------------------------------------------------------

  /** Passengers get off buses at their stop, and people waiting there get on buses of their line. */
  private busStops(traffic: Traffic): void {
    traffic.lines.forEach((line) => {
      for (const ci of line.buses) {
        const v = traffic.busVisit(ci);
        if (v < 0) continue;
        const side = line.geom.visits[v].side;
        const car = traffic.cars[ci];
        let riders = this.onBus.get(ci);
        if (!riders) this.onBus.set(ci, (riders = []));
        // Off once per stop.
        if (this.busServed.get(ci) !== car.stopCount) {
          this.busServed.set(ci, car.stopCount);
          const stay: number[] = [];
          for (const id of riders) {
            const b = this.bodies[id];
            const leg = b.route?.legs[b.leg];
            if (leg?.mode === "bus" && leg.to === side) {
              this.alightBus(b, ci, side, traffic);
              traffic.holdBus(ci, BOARD_TIME + 0.5);
            } else stay.push(id);
          }
          riders.length = 0;
          riders.push(...stay);
        }
        if (car.dwellLeft < 1) continue;
        for (const b of this.bodies) {
          if (riders.length >= line.geom.capacity) break;
          if (b.mode !== "stop" || b.stopSide !== side || b.linkAt < b.linkLen[b.linkLen.length - 1]) continue;
          const leg = b.route!.legs[b.leg] as Extract<Leg, { mode: "bus" }>;
          if (!leg.lines.includes(line.geom.id)) continue;
          b.mode = "board";
          b.ride = "bus";
          b.timer = BOARD_TIME;
          b.bus = ci;
          b.from = [...b.pos] as P3;
          b.dest = traffic.busDoor(ci);
          b.link = null;
          riders.push(b.id);
          traffic.holdBus(ci, BOARD_TIME + 0.5);
        }
      }
    });
  }

  private alightBus(b: Body, ci: number, side: number, traffic: Traffic): void {
    b.mode = "alight";
    b.ride = "bus";
    b.timer = BOARD_TIME;
    b.stopSide = side;
    b.from = traffic.busDoor(ci);
    b.dest = [...this.world.buses.sides[side].at] as P3;
    b.pos = [...b.dest] as P3;
    b.link = null;
  }

  /** Somewhere to wait at a stop: on the sidewalk near the sign (or beside the road where there is none). */
  private stopSpot(side: StopSide): P3 {
    const h = side.heading;
    const along = range(this.r, -3.5, 1.5);
    const across = side.width > 0 ? range(this.r, -0.3, 0.3) * side.width : range(this.r, 0, 0.6);
    return [side.at[0] + Math.cos(h) * along + Math.sin(h) * across, side.at[1] + Math.sin(h) * along - Math.cos(h) * across, side.at[2]];
  }

  // -- for traffic and the scene -----------------------------------------------------------

  /** Someone is within a level or foot crossing's zone (for lowering the barriers). */
  inGate(gate: number): boolean {
    const ways = this.world.walks.ways;
    for (const b of this.bodies) {
      if ((b.mode !== "walk" && b.mode !== "wait") || b.way < 0 || b.link) continue;
      for (const g of ways[b.way].gates) {
        if ((g.gate === gate || g.also.includes(gate)) && Math.abs(b.d - g.at) < g.zone + 0.5) return true;
      }
    }
    return false;
  }

  /** Whether anyone is on road crossing c (for tests). */
  onCrossing(c: number): boolean {
    return this.bodies.some((b) => (b.mode === "walk" || b.mode === "wait") && !b.link && b.way >= 0 && this.world.walks.ways[b.way].crossing === c);
  }

  snapshot(out: PersonSnapshot[]): PersonSnapshot[] {
    const ways = this.world.walks.ways;
    this.bodies.forEach((b, i) => {
      const s = out[i] ?? (out[i] = { x: 0, y: 0, z: 0, heading: 0, visible: true, moving: false, step: 0 });
      s.step = b.odometer;
      s.visible = b.mode === "walk" || b.mode === "wait" || b.mode === "platform" || b.mode === "board" || b.mode === "alight" || b.mode === "exit"
        || b.mode === "linger" || b.mode === "stop";
      s.moving = b.mode === "walk" || b.mode === "board" || b.mode === "alight" || b.mode === "exit"
        || ((b.mode === "platform" || b.mode === "stop") && b.link !== null && b.linkAt < b.linkLen[b.linkLen.length - 1]);
      if (!s.visible) return;
      let x: number, y: number, z: number, h: number;
      if (b.mode === "board" || b.mode === "alight") {
        const u = 1 - Math.max(0, b.timer) / BOARD_TIME;
        const [a, c] = [b.from, b.dest];
        x = a[0] + (c[0] - a[0]) * u; y = a[1] + (c[1] - a[1]) * u; z = a[2] + (c[2] - a[2]) * u;
        h = Math.atan2(c[1] - a[1], c[0] - a[0]);
      } else if (b.link) {
        const p = this.linkPoint(b);
        [x, y, z, h] = p;
      } else if (b.mode === "linger" || b.mode === "platform") {
        [x, y, z] = b.pos;
        h = b.heading;
      } else {
        const w = ways[b.way];
        const p = wayPoint(w, b.d);
        const wh = wayHeading(w, b.d);
        // Keep right: offset to the right of the walking direction.
        const lateral = -b.dir * (w.width / 2 - 0.35) * (0.2 + 0.7 * b.side);
        x = p[0] - Math.sin(wh) * lateral;
        y = p[1] + Math.cos(wh) * lateral;
        z = p[2];
        h = wh + (b.dir < 0 ? Math.PI : 0);
      }
      s.x = x; s.y = y; s.z = z; s.heading = h;
      b.pos = [x, y, z];
      b.heading = h;
    });
    out.length = this.bodies.length;
    return out;
  }

  private linkPoint(b: Body): [number, number, number, number] {
    const pts = b.link!;
    const cum = b.linkLen;
    if (pts.length === 1) return [pts[0][0], pts[0][1], pts[0][2], b.heading];
    let i = 1;
    while (i < pts.length - 1 && cum[i] < b.linkAt) i++;
    const seg = cum[i] - cum[i - 1];
    const u = seg > 1e-9 ? Math.min(1, Math.max(0, (b.linkAt - cum[i - 1]) / seg)) : 1;
    const [a, c] = [pts[i - 1], pts[i]];
    return [a[0] + (c[0] - a[0]) * u, a[1] + (c[1] - a[1]) * u, a[2] + (c[2] - a[2]) * u, seg > 1e-9 ? Math.atan2(c[1] - a[1], c[0] - a[0]) : b.heading];
  }

  stats(): PeopleStats {
    const n = this.bodies.length;
    const count = (m: Mode[]) => this.bodies.filter((b) => m.includes(b.mode)).length;
    return {
      people: n,
      outside: count(["walk", "wait", "platform", "board", "alight", "exit", "linger", "stop"]),
      walking: count(["walk", "wait"]),
      driving: count(["drive"]),
      riding: count(["train"]),
      waiting: count(["platform"]),
      onBus: count(["bus"]),
      atStops: count(["stop"]),
      maxStopWait: this.maxStopWait,
      tasks: this.tasksDone,
      trips: Object.fromEntries([...this.trips].sort((a, b) => b[1] - a[1])),
      avgTrip: this.tripCount ? this.tripTime / this.tripCount : 0,
      avgSpeed: n ? this.bodies.reduce((a, b) => a + b.odometer, 0) / n / Math.max(this.time, 1e-9) : 0,
      maxWait: this.bodies.reduce((a, b) => Math.max(a, b.maxWait), 0),
      stuck: this.bodies.filter((b) => b.waited > STUCK_AFTER).length,
      crossed: this.crossed,
    };
  }
}
