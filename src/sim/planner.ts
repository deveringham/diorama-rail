// Journey planning for the residents: one shortest-time search over walking,
// driving and riding trains. Walkways are split wherever a door, parking bay,
// station or place to stroll joins them; each road lane is a node for driving;
// trains join stations served by a common service (with the expected wait). States
// carry a layer: 0 on foot with one's own car still parked, 1 driving, 2 on foot
// with no car to use (none owned, or parked again), so a car is picked up at most
// once and only where it stands. Costs are seconds, scaled by the person's tastes.

import type { World } from "../model/build";
import type { Person } from "../model/town";
import type { Plan } from "./services";
import type { Traffic, TrafficLane } from "./traffic";
import { TRAIN_CATALOG, type TrainTypeId } from "../model/catalog";
import { mod } from "../util/vec";

type P3 = [number, number, number];

export const WALK_SPEED = 1.2;          // m/s assumed when planning
const CROSSING_PENALTY = 4;             // s for crossing a road on foot
const GATE_PENALTY = 6;                 // s for walking over the line
const GET_IN = 60;                      // s of bother getting the car out (keys, getting in, pulling out)
const PARK = 45;                        // s of bother finding the bay, parking and getting out
const JUNCTION = 3;                     // s per junction driven through
const BOARD = 25;                       // s for buying a ticket and boarding
const DRIVE_FACTOR = 0.75;              // share of the speed limit cars average

/** Where a journey starts or ends. */
export type Place =
  | { kind: "building"; id: number }
  | { kind: "spot"; id: number }
  | { kind: "station"; id: number }
  | { kind: "bay"; id: number };

/** One stretch of a walk: along a walkway from d `from` to `to`, or a straight link through `pts`. */
export type WalkStep = { kind: "way"; way: number; from: number; to: number } | { kind: "link"; pts: P3[] };

export type Leg =
  | { mode: "walk"; steps: WalkStep[] }
  | { mode: "drive"; car: number; from: number; to: number; lanes: TrafficLane[] }      // from and to are bays
  | { mode: "train"; from: number; to: number; services: string[] };                    // stations (indices into town.stations)

export type Route = { legs: Leg[]; cost: number; modes: string };

type Edge = {
  to: number;
  cost: number;                         // seconds before the person's tastes
  mode: "walk" | "drive" | "train" | "getIn" | "getOut";
  step?: WalkStep;                      // walk
  lane?: TrafficLane;                   // drive: the lane it enters (null when it stays on the same lane)
  bay?: number;                         // getIn / getOut / drive edges ending at a bay
  train?: { from: number; to: number; services: string[] };
};

/** A binary min-heap of (key, value) pairs. */
class Heap {
  private keys: number[] = [];
  private vals: number[] = [];
  get size(): number { return this.keys.length; }
  push(k: number, v: number): void {
    const { keys, vals } = this;
    let i = keys.length;
    keys.push(k);
    vals.push(v);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= k) break;
      keys[i] = keys[p]; vals[i] = vals[p];
      i = p;
    }
    keys[i] = k; vals[i] = v;
  }
  pop(): [number, number] {
    const { keys, vals } = this;
    const top: [number, number] = [keys[0], vals[0]];
    const k = keys.pop()!;
    const v = vals.pop()!;
    const n = keys.length;
    if (n) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const c = l + 1 < n && keys[l + 1] < keys[l] ? l + 1 : l;
        if (keys[c] >= k) break;
        keys[i] = keys[c]; vals[i] = vals[c];
        i = c;
      }
      keys[i] = k; vals[i] = v;
    }
    return top;
  }
}

export class Planner {
  private adj: Edge[][] = [];
  readonly buildingNode: number[] = [];
  readonly spotNode: number[] = [];
  readonly stationNode: number[] = [];
  readonly kerbNode: number[] = [];       // per bay: its driver's side, on foot
  private bayStart: number[] = [];        // per bay: a car pulling out of it
  private bayArrive: number[] = [];       // per bay: a car pulling into it
  private laneNode = new Map<TrafficLane, number>();
  private traffic: Traffic;

  constructor(world: World, traffic: Traffic, plans: Plan[]) {
    this.traffic = traffic;
    const { walks, town } = world;
    const node = () => { this.adj.push([]); return this.adj.length - 1; };
    const link = (a: number, b: number, e: Omit<Edge, "to">, back?: Omit<Edge, "to">) => {
      this.adj[a].push({ to: b, ...e });
      if (back) this.adj[b].push({ to: a, ...back });
    };
    for (let i = 0; i < walks.nodes.length; i++) node();

    // Walkways, split where places join them.
    const joins = new Map<number, Array<{ d: number; node: number }>>();
    const joinAt = (way: number, d: number): number => {
      const w = walks.ways[way];
      if (d <= 0.05) return w.a;
      if (d >= w.length - 0.05) return w.b;
      const list = joins.get(way) ?? [];
      const found = list.find((j) => Math.abs(j.d - d) < 0.05);
      if (found) return found.node;
      const n = node();
      list.push({ d, node: n });
      joins.set(way, list);
      return n;
    };
    const linkPlace = (place: number, a: { way: number; d: number; link: P3[]; length: number }) => {
      const j = joinAt(a.way, a.d);
      const cost = a.length / WALK_SPEED;
      link(place, j, { cost, mode: "walk", step: { kind: "link", pts: a.link } },
        { cost, mode: "walk", step: { kind: "link", pts: a.link.slice().reverse() } });
    };
    for (const b of town.buildings) {
      const n = node();
      this.buildingNode.push(n);
      if (b.access) linkPlace(n, b.access);
    }
    for (const s of town.spots) this.spotNode.push(joinAt(s.way, s.d));
    for (const st of town.stations) {
      const n = node();
      this.stationNode.push(n);
      // Through the station building people go in at its door (and come out on the platform).
      for (const e of st.entrances) linkPlace(n, { ...e.access, link: e.via === "building" ? e.access.link : [e.entry, ...e.access.link.slice(1)] });
    }
    for (const bay of town.bays) {
      const k = node();
      this.kerbNode.push(k);
      if (bay.access) linkPlace(k, bay.access);
      this.bayStart.push(node());
      this.bayArrive.push(node());
      link(k, this.bayStart[bay.id], { cost: GET_IN, mode: "getIn", bay: bay.id });
      link(this.bayArrive[bay.id], k, { cost: PARK, mode: "getOut", bay: bay.id });
    }
    for (const b of town.buildings) {
      for (const x of b.bays) {
        const cost = x.length / WALK_SPEED;
        link(this.buildingNode[b.id], this.kerbNode[x.bay], { cost, mode: "walk", step: { kind: "link", pts: x.link } },
          { cost, mode: "walk", step: { kind: "link", pts: x.link.slice().reverse() } });
      }
    }
    for (const w of walks.ways) {
      const pts = [{ d: 0, node: w.a }, ...(joins.get(w.id) ?? []).sort((x, y) => x.d - y.d), { d: w.length, node: w.b }];
      const extra = (w.kind === "zebra" || w.kind === "crossing" ? CROSSING_PENALTY : 0) + (w.gates.length ? GATE_PENALTY : 0);
      for (let k = 0; k + 1 < pts.length; k++) {
        const [p, q] = [pts[k], pts[k + 1]];
        const cost = (q.d - p.d) / WALK_SPEED + extra;
        link(p.node, q.node, { cost, mode: "walk", step: { kind: "way", way: w.id, from: p.d, to: q.d } },
          { cost, mode: "walk", step: { kind: "way", way: w.id, from: q.d, to: p.d } });
      }
    }

    // Driving: a node at the start of every lane; bays leave from and arrive at their lane.
    const lanes = traffic.laneList;
    for (const l of lanes) this.laneNode.set(l, node());
    const time = (l: TrafficLane, from: number, to: number) => Math.max(0, to - from) / Math.max(2, l.road.spec.speed * DRIVE_FACTOR);
    for (const l of lanes) {
      for (const next of traffic.nextLanes(l)) {
        link(this.laneNode.get(l)!, this.laneNode.get(next)!, { cost: time(l, 0, l.length) + JUNCTION, mode: "drive", lane: next });
      }
    }
    town.bays.forEach((bay) => {
      const at = traffic.bayAt[bay.id];
      if (!at) return;
      const startD = traffic.pullOutD(bay.id);
      for (const next of traffic.nextLanes(at.lane)) {
        link(this.bayStart[bay.id], this.laneNode.get(next)!, { cost: time(at.lane, startD, at.lane.length) + JUNCTION, mode: "drive", lane: next });
      }
      link(this.laneNode.get(at.lane)!, this.bayArrive[bay.id], { cost: time(at.lane, 0, traffic.turnInD(bay.id)), mode: "drive", bay: bay.id });
    });
    // Bays further along the same lane, straight from a bay.
    const byLane = new Map<TrafficLane, number[]>();
    town.bays.forEach((bay) => {
      const at = traffic.bayAt[bay.id];
      if (at) byLane.set(at.lane, [...(byLane.get(at.lane) ?? []), bay.id]);
    });
    for (const [lane, list] of byLane) {
      for (const a of list) {
        const startD = traffic.pullOutD(a);
        for (const b of list) {
          const endD = traffic.turnInD(b);
          if (b === a || endD < startD + 8) continue;
          link(this.bayStart[a], this.bayArrive[b], { cost: time(lane, startD, endD), mode: "drive", bay: b });
        }
      }
    }

    // Trains: from each station to every later stop of each passenger service calling there.
    const stationIndex = new Map(town.stations.map((s, i) => [s.station, i]));
    for (const plan of plans) {
      const type = TRAIN_CATALOG[plan.svc.train as TrainTypeId];
      if (!type || type.shape === "freight" || plan.route.stops.length < 2) continue;
      const v = type.maxSpeed * 0.6;
      const L = plan.route.length;
      const stops = plan.route.stops.filter((s) => stationIndex.has(s.station));
      const dwell = plan.svc.dwell;
      const cycle = plan.route.closed ? L / v + dwell * stops.length : (2 * L) / v + dwell * 2 * stops.length;
      const wait = cycle / plan.svc.count / 2;
      for (const a of stops) {
        for (const b of stops) {
          if (a.station === b.station) continue;
          const dist = plan.route.closed ? mod(b.r - a.r, L) : Math.abs(b.r - a.r);
          const between = stops.filter((s) => s !== a && s !== b && (plan.route.closed ? mod(s.r - a.r, L) < dist : Math.abs(s.r - a.r) < dist && Math.sign(s.r - a.r) === Math.sign(b.r - a.r))).length;
          const cost = wait + dist / v + between * dwell + BOARD;
          const from = stationIndex.get(a.station)!;
          const to = stationIndex.get(b.station)!;
          const existing = this.adj[this.stationNode[from]].find((e) => e.mode === "train" && e.train!.to === to);
          if (existing) {
            existing.train!.services.push(plan.svc.id);
            existing.cost = Math.min(existing.cost, cost);
          } else {
            link(this.stationNode[from], this.stationNode[to], { cost, mode: "train", train: { from, to, services: [plan.svc.id] } });
          }
        }
      }
    }
  }

  /** The node of a place. */
  nodeOf(p: Place): number {
    switch (p.kind) {
      case "building": return this.buildingNode[p.id];
      case "spot": return this.spotNode[p.id];
      case "station": return this.stationNode[p.id];
      case "bay": return this.kerbNode[p.id];
    }
  }

  /**
   * The quickest journey for a person from one place to another, given where their
   * car stands (-1: none to use), or null if there is none.
   */
  plan(person: Person, from: Place, to: Place, carBay: number, car: number): Route | null {
    const start = this.nodeOf(from);
    const goal = this.nodeOf(to);
    if (start === goal) return null;
    const n = this.adj.length;
    const best = new Float64Array(n * 3).fill(Infinity);
    const prev = new Int32Array(n * 3).fill(-1);
    const via = new Array<Edge | null>(n * 3).fill(null);
    const heap = new Heap();
    const s0 = start * 3 + (carBay >= 0 && car >= 0 ? 0 : 2);
    best[s0] = 0;
    heap.push(0, s0);
    const { prefs } = person;
    const bayCar = this.traffic.bayCar;
    let end = -1;
    while (heap.size) {
      const [c, s] = heap.pop();
      if (c > best[s]) continue;
      const nd = Math.floor(s / 3);
      const layer = s - nd * 3;
      if (nd === goal && layer !== 1) { end = s; break; }
      for (const e of this.adj[nd]) {
        let to: number;
        let cost: number;
        switch (e.mode) {
          case "walk":
            if (layer === 1) continue;
            to = e.to * 3 + layer; cost = e.cost * prefs.walk; break;
          case "train":
            if (layer === 1) continue;
            to = e.to * 3 + layer; cost = e.cost * prefs.train; break;
          case "drive":
            if (layer !== 1) continue;
            to = e.to * 3 + 1; cost = e.cost * prefs.drive; break;
          case "getIn":
            if (layer !== 0 || e.bay !== carBay) continue;
            to = e.to * 3 + 1; cost = e.cost; break;
          case "getOut":
            if (layer !== 1 || (bayCar[e.bay!] >= 0 && bayCar[e.bay!] !== car)) continue;
            to = e.to * 3 + 2; cost = e.cost; break;
        }
        const nc = c + cost;
        if (nc < best[to]) {
          best[to] = nc;
          prev[to] = s;
          via[to] = e;
          heap.push(nc, to);
        }
      }
    }
    if (end < 0) return null;
    // Walk back, then group the edges into legs.
    const edges: Edge[] = [];
    for (let s = end; prev[s] >= 0; s = prev[s]) edges.unshift(via[s]!);
    const legs: Leg[] = [];
    let drive: { from: number; to: number; lanes: TrafficLane[] } | null = null;
    for (const e of edges) {
      if (e.mode === "walk") {
        const last = legs[legs.length - 1];
        if (last?.mode === "walk") last.steps.push(e.step!);
        else legs.push({ mode: "walk", steps: [e.step!] });
      } else if (e.mode === "train") {
        legs.push({ mode: "train", from: e.train!.from, to: e.train!.to, services: e.train!.services.slice() });
      } else if (e.mode === "getIn") {
        const at = this.traffic.bayAt[e.bay!]!;
        drive = { from: e.bay!, to: -1, lanes: [at.lane] };
      } else if (e.mode === "drive") {
        if (e.lane) drive!.lanes.push(e.lane);
        if (e.bay !== undefined) drive!.to = e.bay;
      } else if (e.mode === "getOut") {
        legs.push({ mode: "drive", car, from: drive!.from, to: drive!.to, lanes: drive!.lanes });
        drive = null;
      }
    }
    const modes = legs.map((l) => l.mode).join(" → ");
    return { legs, cost: best[end], modes };
  }
}
