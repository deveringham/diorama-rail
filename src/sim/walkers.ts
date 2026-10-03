// People on the paths and sidewalks. They walk on the right of each walkway at
// their own pace, now and then stop for a while, pick a way at random at every
// node, and leave and come back at walkway ends near the board edge. At a zebra they
// wait at the kerb until the cars have stopped or passed; over a junction's leg
// (unmarked) they wait for a gap; at level and foot crossings they wait while the
// lights flash. Pure TypeScript, deterministic from the layout seed.

import type { World } from "../model/build";
import { type Walkway, wayPoint, wayHeading } from "../model/walks";
import type { Traffic, WalkerView } from "./traffic";
import { type Rng, rng, range } from "../util/rng";

const SPEED: [number, number] = [0.9, 1.5];   // m/s
const PAUSE_CHANCE = 0.1;       // chance at each node of stopping there for a while
const PAUSE: [number, number] = [3, 12];      // s
const LOOK_BEFORE = 0.7;        // s at the kerb before stepping onto a zebra
const UNMARKED_GAP = 2;         // s spare beyond the time to cross, when waiting for a gap in the traffic
const GAP_PATIENCE = 8;         // s waiting for a gap before stepping out in front of cars that can stop
const CARS_PATIENCE = 5;        // s a car may wait at a zebra before the people let it through
const CARS_TURN = 4;            // s they then hold back
const GATE_MARGIN = 1;          // m short of a level crossing's zone people wait
const AWAY: [number, number] = [5, 25];       // s off the board
const AUTO_SPACING = 25;        // m of walkway per person when pedestrians.count is not given
const AUTO_MAX = 200;
const STUCK_AFTER = 120;        // s waiting before someone counts as stuck

type Mode = "walk" | "pause" | "wait" | "away";

type Walker = {
  index: number;
  way: number;
  d: number;                    // position along the way
  dir: 1 | -1;                  // walking toward the way's end (+1) or start
  speed: number;
  side: number;                 // 0..1: how far right of the way's centre they keep
  mode: Mode;
  timer: number;
  next: { way: number; dir: 1 | -1 } | null;   // where they go at the node ahead
  waited: number;               // s waiting at the current kerb or gate
  maxWait: number;
  odometer: number;
};

export type WalkerSnapshot = { x: number; y: number; z: number; heading: number; visible: boolean; moving: boolean; step: number };
export type WalkerStats = { people: number; avgSpeed: number; maxWait: number; stuck: number; crossed: number };

export class Walkers implements WalkerView {
  readonly people: Walker[] = [];
  readonly busy: Uint8Array;
  private ways: Walkway[];
  private world: World;
  private r: Rng;
  private time = 0;
  private carsTurnUntil: Float64Array;
  private crossed = 0;

  constructor(world: World, seed: number) {
    this.world = world;
    this.ways = world.walks.ways;
    this.r = rng(seed, "walkers");
    this.busy = new Uint8Array(world.walks.crossings.length);
    this.carsTurnUntil = new Float64Array(world.walks.crossings.length);
    this.spawn();
  }

  private spawn(): void {
    const ways = this.ways.filter((w) => w.crossing < 0);
    const total = ways.reduce((a, w) => a + w.length, 0);
    if (!total) return;
    const walkLength = this.ways.reduce((a, w) => a + w.length, 0);
    const want = this.world.layout.pedestrians.count ?? Math.min(AUTO_MAX, Math.round(walkLength / AUTO_SPACING));
    for (let k = 0; k < want; k++) {
      let x = this.r() * total;
      const w = ways.find((v) => (x -= v.length) < 0) ?? ways[ways.length - 1];
      let d = this.r() * w.length;
      // Not in a crossing's zone.
      for (const g of w.gates) if (Math.abs(d - g.at) < g.zone + 2) d = Math.max(0, Math.min(w.length, g.at + (d < g.at ? -1 : 1) * (g.zone + 3)));
      const p: Walker = {
        index: k, way: w.id, d, dir: this.r() < 0.5 ? 1 : -1, speed: range(this.r, SPEED[0], SPEED[1]), side: this.r(),
        mode: this.r() < 0.15 ? "pause" : "walk", timer: range(this.r, PAUSE[0], PAUSE[1]), next: null, waited: 0, maxWait: 0, odometer: 0,
      };
      this.plan(p);
      this.people.push(p);
    }
  }

  /** Chooses where to go at the node ahead: any other way there, crossings less often; back only at a dead end. */
  private plan(p: Walker): void {
    const w = this.ways[p.way];
    const node = this.world.walks.nodes[p.dir > 0 ? w.b : w.a];
    const here = { way: p.way, end: p.dir > 0 ? 1 : 0 };
    const options = node.ways.filter((o) => !(o.way === here.way && o.end === here.end));
    if (!options.length) { p.next = { way: p.way, dir: (-p.dir) as 1 | -1 }; return; }
    const weight = (o: { way: number }) => (this.ways[o.way].crossing >= 0 ? 0.5 : 1);
    let x = this.r() * options.reduce((a, o) => a + weight(o), 0);
    const o = options.find((v) => (x -= weight(v)) < 0) ?? options[options.length - 1];
    p.next = { way: o.way, dir: o.end === 0 ? 1 : -1 };
  }

  /** Advances everyone, given the cars and crossing states after this tick's traffic step. */
  step(dt: number, traffic: Traffic): void {
    this.time += dt;
    const waiting = new Uint8Array(this.busy.length);
    for (const p of this.people) {
      switch (p.mode) {
        case "away":
          p.timer -= dt;
          if (p.timer <= 0) p.mode = "walk";
          break;
        case "pause":
          p.timer -= dt;
          if (p.timer <= 0) p.mode = "walk";
          break;
        default:
          this.walk(p, dt, traffic, waiting);
      }
      if (p.mode === "wait") {
        p.waited += dt;
        p.maxWait = Math.max(p.maxWait, p.waited);
      } else p.waited = 0;
    }
    // Cars give way where someone is on a crossing, or waiting at a zebra (unless it is the cars' turn).
    this.busy.fill(0);
    for (const p of this.people) {
      if (p.mode === "away") continue;
      const c = this.ways[p.way].crossing;
      if (c >= 0) this.busy[c] = 1;
    }
    this.world.walks.crossings.forEach((c, i) => {
      if (c.kind !== "zebra") return;
      if (!this.busy[i] && traffic.carWaitingAt(i) > CARS_PATIENCE && this.time >= this.carsTurnUntil[i]) this.carsTurnUntil[i] = this.time + CARS_TURN;
      if (waiting[i] && this.time >= this.carsTurnUntil[i]) this.busy[i] = 1;
    });
  }

  private walk(p: Walker, dt: number, traffic: Traffic, waiting: Uint8Array): void {
    let left = p.speed * dt;
    for (let guard = 0; guard < 4; guard++) {
      const w = this.ways[p.way];
      const end = p.dir > 0 ? w.length : 0;
      const toEnd = Math.abs(end - p.d);
      // Wait short of level and foot crossings that are not open, unless already on them.
      let gateStop = Infinity;
      for (const g of w.gates) {
        const stop = p.dir > 0 ? g.at - g.zone - GATE_MARGIN : g.at + g.zone + GATE_MARGIN;
        const ahead = (stop - p.d) * p.dir;
        const shut = traffic.gates[g.gate].state !== "open" || g.also.some((k) => traffic.gates[k].state !== "open");
        if (ahead >= -0.05 && shut) gateStop = Math.min(gateStop, Math.max(0, ahead));
      }
      if (gateStop < toEnd) {
        const move = Math.min(left, gateStop);
        this.advance(p, move);
        p.mode = left > gateStop ? "wait" : "walk";
        return;
      }
      if (left < toEnd) {
        this.advance(p, left);
        p.mode = "walk";
        return;
      }
      // At the kerb of a crossing: step onto it only when it is safe.
      const next = p.next ?? { way: p.way, dir: (-p.dir) as 1 | -1 };
      const c = this.ways[next.way].crossing;
      if (c >= 0 && w.crossing < 0 && !this.mayCross(p, c, traffic)) {
        this.advance(p, toEnd);
        p.mode = "wait";
        waiting[c] = 1;
        return;
      }
      this.advance(p, toEnd);
      left -= toEnd;
      p.mode = "walk";
      // At the node: off the board, or on along the way chosen.
      const node = this.world.walks.nodes[p.dir > 0 ? w.b : w.a];
      if (w.crossing >= 0) this.crossed++;
      if (node.portal) {
        p.mode = "away";
        p.timer = range(this.r, AWAY[0], AWAY[1]);
        p.dir = (-p.dir) as 1 | -1;
        this.plan(p);
        return;
      }
      p.way = next.way;
      p.dir = next.dir;
      const nw = this.ways[p.way];
      p.d = p.dir > 0 ? 0 : nw.length;
      this.plan(p);
      // Now and then someone stops for a while (not on crossings or near the lines).
      if (nw.crossing < 0 && !nw.gates.length && this.r() < PAUSE_CHANCE) {
        p.mode = "pause";
        p.timer = range(this.r, PAUSE[0], PAUSE[1]);
        return;
      }
    }
  }

  private advance(p: Walker, move: number): void {
    p.d += p.dir * move;
    p.odometer += move;
  }

  private mayCross(p: Walker, c: number, traffic: Traffic): boolean {
    const crossing = this.world.walks.crossings[c];
    if (crossing.kind === "zebra") {
      if (this.time < this.carsTurnUntil[c]) return false;
      if (p.mode !== "wait" || p.waited < LOOK_BEFORE) return false;
      return !traffic.crossingThreat(c, 0);
    }
    // Unmarked: wait for a gap in the traffic, but after a while just make sure the cars can stop.
    const len = this.ways[crossing.way].length;
    return !traffic.crossingThreat(c, p.waited > GAP_PATIENCE ? 0 : len / p.speed + UNMARKED_GAP);
  }

  /** Someone is within a level or foot crossing's zone (for lowering the barriers). */
  inGate(gate: number): boolean {
    for (const p of this.people) {
      if (p.mode === "away") continue;
      for (const g of this.ways[p.way].gates) {
        if ((g.gate === gate || g.also.includes(gate)) && Math.abs(p.d - g.at) < g.zone + 0.5) return true;
      }
    }
    return false;
  }

  snapshot(out: WalkerSnapshot[]): WalkerSnapshot[] {
    this.people.forEach((p, i) => {
      const s = out[i] ?? (out[i] = { x: 0, y: 0, z: 0, heading: 0, visible: true, moving: false, step: 0 });
      s.visible = p.mode !== "away";
      s.moving = p.mode === "walk";
      s.step = p.odometer;
      if (!s.visible) return;
      const w = this.ways[p.way];
      const [x, y, z] = wayPoint(w, p.d);
      const h = wayHeading(w, p.d);
      // Keep right: offset to the right of the walking direction.
      const lateral = -p.dir * (w.width / 2 - 0.35) * (0.2 + 0.7 * p.side);
      s.x = x - Math.sin(h) * lateral;
      s.y = y + Math.cos(h) * lateral;
      s.z = z;
      s.heading = h + (p.dir < 0 ? Math.PI : 0);
    });
    out.length = this.people.length;
    return out;
  }

  stats(): WalkerStats {
    const n = this.people.length;
    return {
      people: n,
      avgSpeed: n ? this.people.reduce((a, p) => a + p.odometer, 0) / n / Math.max(this.time, 1e-9) : 0,
      maxWait: this.people.reduce((a, p) => Math.max(a, p.maxWait), 0),
      stuck: this.people.filter((p) => p.waited > STUCK_AFTER).length,
      crossed: this.crossed,
    };
  }

  /** For tests: whether anyone is on road crossing c. */
  onCrossing(c: number): boolean {
    return this.people.some((p) => p.mode !== "away" && this.ways[p.way].crossing === c);
  }
}
