// Freight on the move. Every source makes its goods into a stock (loads per hour)
// and every consumer's need grows (loads per hour) until it orders; an order is
// filled from a source with stock, picked by how quickly the goods can come from
// there — straight by road, or by road to a goods yard, on a freight train to
// another yard or an off-layout place, and by road from there. Each shipment is a
// consignment travelling leg by leg. Delivery vehicles get jobs: collect at one
// place as much as fits (for as many destinations as that takes), then drop off in
// turn — stopping in the lane at each dock, or driving off the board for an
// off-layout place. Freight trains unload what is for the yard or off-layout place
// they call at and load what waits there for a stop ahead. Deterministic.

import type { World } from "../model/build";
import type { Site } from "../model/freight";
import type { Plan } from "./services";
import type { Train } from "./trains";
import type { Traffic, TrafficLane } from "./traffic";
import { Heap } from "./planner";
import { WAGON_LOADS } from "../model/catalog";
import { type Rng, rng } from "../util/rng";
import { mod } from "../util/vec";

const ORDER_HOURS = 0.5;        // a consumer orders about this many hours' worth at a time
const STOCK_HOURS = 2;          // a source keeps at most this many hours' worth ready (at least STOCK_MIN loads)
const STOCK_MIN = 12;
const MAX_UNDER_WAY = 2;        // orders of one goods under way to one place at most, in order sizes
const BOOK = 1;                 // s between bookkeeping rounds (making, needing, ordering, dispatching)
const HANDLE = 10;              // s a delivery vehicle stands at a stop, plus HANDLE_LOAD per load moved
const HANDLE_LOAD = 2.5;
const TRAIN_HANDLE = 1.2;       // s per load moved on or off a freight train (it waits for them)
const TRAIN_HOLD_MAX = 120;     // s a freight train waits for loading at most
const DRIVE_FACTOR = 0.7;       // share of the speed limit a lorry averages, for planning
const JUNCTION = 3;             // s per junction, for planning
const TURN_OFF = 30;            // s for turning round off the board where a road leaves it, for planning
const OFF_SPEED = 12;           // m/s a delivery vehicle averages off the board
const TRIP = 60;                // s of bother per road leg (finding a vehicle, loading, unloading)
const YARD_TIME = 150;          // s counted for each change between road and rail at a yard
const RAIL_WAIT = 0.5;          // share of a service's headway counted as the wait for a train
const RAIL_FACTOR = 0.4;        // how much a train's time counts (it carries a lot at once)
const RAIL_SHARE = 0.6;         // share of its top speed a freight train averages, for planning
const CHOICE = 150;             // s: an alternative this much slower is about e times less likely
const SEND_TRIES = 30;          // ticks a vehicle keeps trying to find a way to its next stop before giving up
const RAIL_ONLY_LOAD = 24;      // loads at most per consignment that never goes by road
const RETRY = 20;               // s before a consumer whose order could not be filled tries again
const LINGER = 90;              // s a delivery vehicle drives about after a job before going to wait off the board

export type FreightLeg = { mode: "road"; from: number; to: number } | { mode: "rail"; from: number; to: number; services: string[] };

/** Goods on their way from a source to a consumer (sites), leg by leg. */
export type Consignment = {
  id: number;
  goods: string;
  amount: number;               // loads
  from: number;
  to: number;
  legs: FreightLeg[];
  leg: number;                  // the leg it is on, or waiting for
  // waiting: at its leg's start; assigned: a vehicle is on its way to collect it; carried: in a vehicle or on a train
  state: "waiting" | "assigned" | "carried";
  vehicle: number;              // traffic car index (assigned or carried by road), else -1
  train: number;                // train index (carried by rail), else -1
  created: number;              // s
  since: number;                // s it has been in its present state since
};

/** A delivery vehicle's job: stops in turn, collecting and dropping consignments. */
export type Job = { car: number; stops: Array<{ site: number; pickup: number[]; drop: number[] }>; at: number; sent: boolean; tries: number };

export type FreightStats = {
  orders: number;               // orders placed
  short: number;                // times an order waited because no source had enough ready
  unserved: number;             // orders no source could reach
  delivered: number;            // consignments delivered
  loads: number;                // loads delivered
  byRoad: number;               // consignments delivered only by road
  byRail: number;               // consignments that went by freight train
  underWay: number;             // consignments under way now
  waiting: number;              // of them, waiting at a building, yard or off-layout place
  avgTime: number;              // s from order to delivery, on average
  maxAge: number;               // s the oldest consignment under way has been
  busy: number;                 // delivery vehicles on a job now
  vehicles: number;
  onTrains: number;             // loads aboard freight trains now
  lost: number;                 // consignments given up on (no way to their next stop; should stay 0)
};

/** What the scene draws: loads waiting at each yard, ready at each site, and aboard each train, by goods (indices into `goods`). */
export type FreightSnapshot = { goods: string[]; yards: number[][]; stock: number[][]; trains: number[][] };

type Pos = { lane: TrafficLane; d: number };

export class Freight {
  readonly world: World;
  readonly sites: Site[];
  readonly goods: string[];
  /** Consignments under way, by id. */
  readonly consignments = new Map<number, Consignment>();
  /** Delivery vehicles' jobs, by traffic car index. */
  readonly jobs = new Map<number, Job>();
  /** Consignments aboard each train (index into sim.trains). */
  readonly aboard: number[][] = [];
  /** Per site and goods index: loads ready to send, need built up, loads ordered and not yet delivered. */
  readonly stock: Float64Array[];
  readonly need: Float64Array[];
  readonly underWay: Float64Array[];
  private size: Float64Array[];             // order size per site and goods
  private cap: Float64Array[];              // stock kept at most
  private supplyRate: Float64Array[];
  private demandRate: Float64Array[];
  private retryAt: Float64Array[];          // when a consumer may try again after an order could not be filled
  private traffic: Traffic;
  private plans: Plan[];
  private r: Rng;
  private time = 0;
  private book = 0;
  private nextId = 0;
  private served = new Map<number, number>();
  private idleSince = new Map<number, number>();   // delivery vehicle → when it last finished a job
  private fleet: number[];                  // traffic car indices of the delivery vehicles
  private siteOfStop = new Map<string, number>();
  private rail = new Map<number, Array<{ to: number; cost: number; services: string[] }>>();
  private roadExits: ReturnType<Traffic["roadExitLanes"]>;
  private laneTimes = new Map<string, Float64Array>();
  private totals = { orders: 0, short: 0, unserved: 0, delivered: 0, loads: 0, byRoad: 0, byRail: 0, time: 0, lost: 0 };

  constructor(world: World, traffic: Traffic, plans: Plan[], seed: number) {
    this.world = world;
    this.traffic = traffic;
    this.plans = plans;
    this.r = rng(seed, "freight");
    const net = world.freight;
    this.sites = net.sites;
    this.goods = net.goods;
    const G = this.goods.length;
    const gi = new Map(this.goods.map((g, i) => [g, i]));
    const per = () => this.sites.map(() => new Float64Array(G));
    this.stock = per(); this.need = per(); this.underWay = per(); this.size = per(); this.cap = per();
    this.supplyRate = per(); this.demandRate = per(); this.retryAt = per();
    for (const s of this.sites) {
      for (const x of s.supplies) {
        const g = gi.get(x.goods)!;
        this.supplyRate[s.id][g] = x.rate;
        this.cap[s.id][g] = Math.max(STOCK_MIN, x.rate * STOCK_HOURS);
        this.stock[s.id][g] = s.kind === "off" ? this.cap[s.id][g] : Math.round(this.cap[s.id][g] * (0.3 + 0.4 * this.r()));
      }
      for (const x of s.demands) {
        const g = gi.get(x.goods)!;
        this.demandRate[s.id][g] = x.rate;
        this.size[s.id][g] = Math.max(1, Math.round(x.rate * ORDER_HOURS));
        // Everyone part-way to their next order, so orders come steadily from the start.
        this.need[s.id][g] = this.r() * this.size[s.id][g];
      }
      if (s.stop) this.siteOfStop.set(s.stop, s.id);
    }
    this.fleet = traffic.cars.filter((c) => c.fleet >= 0).map((c) => c.index);
    this.roadExits = traffic.roadExitLanes();
    this.buildRail();
  }

  /** Trains are known once the sim has spawned them. */
  attach(trains: Train[]): void {
    while (this.aboard.length < trains.length) this.aboard.push([]);
  }

  // -- planning ------------------------------------------------------------------------

  /** Freight services: from each yard or off-layout site they call at to every other, with the expected wait and ride. */
  private buildRail(): void {
    for (const plan of this.plans) {
      if (plan.type.shape !== "freight") continue;
      const route = plan.route;
      const L = route.length;
      const stops: Array<{ site: number; r: number }> = [];
      for (const st of route.stops) {
        const site = this.siteOfStop.get(st.station);
        if (site !== undefined && !stops.some((x) => x.site === site)) stops.push({ site, r: st.r });
      }
      route.off.forEach((o, e) => {
        for (const c of o?.calls ?? []) {
          const site = this.siteOfStop.get(this.world.offLayout.places[c.place].id);
          if (site !== undefined && !stops.some((x) => x.site === site)) stops.push({ site, r: e === 1 ? L + c.at : -c.at });
        }
      });
      if (stops.length < 2) continue;
      const v = plan.type.maxSpeed * RAIL_SHARE;
      const offLen = route.off.reduce((a, o) => a + (o?.length ?? 0), 0);
      const loop = route.closed || route.through;
      const round = route.closed ? L : route.through ? L + offLen : 2 * L + offLen;
      const cycle = round / v + plan.svc.dwell * (loop ? stops.length : 2 * stops.length);
      const wait = (cycle / plan.svc.count) * RAIL_WAIT;
      for (const a of stops) {
        for (const b of stops) {
          if (a === b) continue;
          const dist = loop ? mod(b.r - a.r, round) : Math.abs(b.r - a.r);
          const yards = [a, b].filter((x) => this.sites[x.site].kind === "yard").length;
          const cost = RAIL_FACTOR * (wait + dist / v) + yards * YARD_TIME;
          const list = this.rail.get(a.site) ?? [];
          const e = list.find((x) => x.to === b.site);
          if (e) { e.cost = Math.min(e.cost, cost); if (!e.services.includes(plan.svc.id)) e.services.push(plan.svc.id); }
          else list.push({ to: b.site, cost, services: [plan.svc.id] });
          this.rail.set(a.site, list);
        }
      }
    }
  }

  private speed(l: TrafficLane): number {
    return Math.max(3, l.road.spec.speed * DRIVE_FACTOR);
  }

  /** Seconds from a position to the start of every lane (Infinity where it cannot get), cached. */
  private fromPos(p: Pos): Float64Array {
    const key = `${p.lane.id}:${p.d.toFixed(1)}`;
    const hit = this.laneTimes.get(key);
    if (hit) return hit;
    const lanes = this.traffic.laneList;
    const best = new Float64Array(lanes.length).fill(Infinity);
    const heap = new Heap();
    // (Where a lane runs off the board, a vehicle may turn round out there and come back on.)
    const beyond = (l: TrafficLane) => (this.traffic.endsOffBoard(l) ? TURN_OFF : 0);
    const first = (p.lane.length - p.d) / this.speed(p.lane) + JUNCTION + beyond(p.lane);
    for (const n of p.lane.next) if (first < best[n.id]) { best[n.id] = first; heap.push(first, n.id); }
    while (heap.size) {
      const [t, id] = heap.pop();
      if (t > best[id]) continue;
      const l = lanes[id];
      const nt = t + l.length / this.speed(l) + JUNCTION + beyond(l);
      for (const n of l.next) if (nt < best[n.id]) { best[n.id] = nt; heap.push(nt, n.id); }
    }
    this.laneTimes.set(key, best);
    return best;
  }

  /** Seconds to drive from a position to offset d of a lane, or Infinity. */
  private drive(p: Pos, to: TrafficLane, d: number): number {
    if (p.lane === to && d >= p.d + 1) return (d - p.d) / this.speed(to);
    return this.fromPos(p)[to.id] + d / this.speed(to);
  }

  /** A site's dock as a lane position, or null. */
  private dockPos(site: number): Pos | null {
    const dock = this.sites[site].dock;
    const lane = dock && this.traffic.laneOf(dock.lane);
    return lane ? { lane, d: Math.min(Math.max(this.traffic.dockD(dock!.lane, dock!.d), 0.5), lane.length - 0.1) } : null;
  }

  /** An off-layout site's ways by road: each exit, its distance out there, and the lanes on and off the board there. */
  private offWays(site: number): Array<{ exit: number; distance: number; enter: TrafficLane | null; leave: TrafficLane[] }> {
    const s = this.sites[site];
    if (s.kind !== "off") return [];
    return this.world.offLayout.places[s.ref].via.flatMap((v) => {
      const x = this.roadExits.get(v.exit);
      return x ? [{ exit: v.exit, distance: v.distance, enter: x.enter, leave: x.leave }] : [];
    });
  }

  /** Seconds by road from one site to another (Infinity if no road leads there). */
  roadTime(a: number, b: number): number {
    const starts: Array<{ p: Pos; t: number }> = [];
    const pa = this.dockPos(a);
    if (pa) starts.push({ p: pa, t: 0 });
    for (const w of this.offWays(a)) if (w.enter) starts.push({ p: { lane: w.enter, d: 0 }, t: w.distance / OFF_SPEED });
    const ends: Array<{ lane: TrafficLane; d: number; t: number }> = [];
    const pb = this.dockPos(b);
    if (pb) ends.push({ lane: pb.lane, d: pb.d, t: 0 });
    for (const w of this.offWays(b)) for (const l of w.leave) ends.push({ lane: l, d: l.length, t: w.distance / OFF_SPEED });
    let best = Infinity;
    for (const s of starts) for (const e of ends) best = Math.min(best, s.t + this.drive(s.p, e.lane, e.d) + e.t);
    return best;
  }

  /** Whether some delivery vehicle may carry these goods. */
  private carried(goods: string): boolean {
    return this.world.freight.fleet.some((f) => f.count > 0 && (!f.goods || f.goods.includes(goods)));
  }

  /**
   * The quickest ways for goods from one site to another: the quickest by road
   * alone and the quickest that goes by freight train (by road to and from yards
   * and off-layout stops), each with its cost — whichever exist.
   */
  itineraries(from: number, to: number, goods: string): Array<{ legs: FreightLeg[]; cost: number }> {
    const byRoad = this.carried(goods);
    // The places worth passing through: both ends, the yards and the off-layout stops of freight trains.
    const nodes = [from, to, ...this.sites.filter((s) => s.id !== from && s.id !== to && (s.kind === "yard" || this.rail.has(s.id))).map((s) => s.id)];
    // States: a site, and whether the goods have been on a train yet.
    const key = (n: number, rail: number) => n * 2 + rail;
    const best = new Map<number, number>([[key(from, 0), 0]]);
    const prev = new Map<number, { at: number; leg: FreightLeg }>();
    const done = new Set<number>();
    for (;;) {
      let cur = -1;
      for (const [k, c] of best) if (!done.has(k) && (cur < 0 || c < best.get(cur)!)) cur = k;
      if (cur < 0) break;
      done.add(cur);
      const at = cur >> 1;
      const rail = cur & 1;
      if (at === to) continue;
      const c = best.get(cur)!;
      const relax = (k: number, cost: number, leg: FreightLeg) => {
        if (!done.has(k) && cost < (best.get(k) ?? Infinity)) { best.set(k, cost); prev.set(k, { at: cur, leg }); }
      };
      if (byRoad) {
        for (const n of nodes) {
          // Through a yard by road again is no use, so only to the destination or on to a train.
          if (n === at || (n !== to && !this.rail.has(n))) continue;
          const t = this.roadTime(at, n);
          if (Number.isFinite(t)) relax(key(n, rail), c + t + TRIP, { mode: "road", from: at, to: n });
        }
      }
      for (const e of this.rail.get(at) ?? []) relax(key(e.to, 1), c + e.cost, { mode: "rail", from: at, to: e.to, services: e.services });
    }
    const out: Array<{ legs: FreightLeg[]; cost: number }> = [];
    for (const rail of [0, 1]) {
      const end = key(to, rail);
      if (!prev.has(end)) continue;
      const legs: FreightLeg[] = [];
      for (let k = end; k !== key(from, 0); k = prev.get(k)!.at) legs.unshift(prev.get(k)!.leg);
      out.push({ legs, cost: best.get(end)! });
    }
    return out;
  }

  /** The quickest way for goods from one site to another, or null. */
  itinerary(from: number, to: number, goods: string): { legs: FreightLeg[]; cost: number } | null {
    return this.itineraries(from, to, goods).sort((a, b) => a.cost - b.cost)[0] ?? null;
  }

  // -- per tick ------------------------------------------------------------------------

  step(dt: number, trains: Train[]): void {
    this.time += dt;
    this.attach(trains);
    this.vehicleEvents();
    this.trainStops(trains);
    this.book += dt;
    if (this.book < BOOK) return;
    const span = this.book;
    this.book = 0;
    this.makeAndNeed(span);
    this.dispatch();
  }

  /** Sources make goods; consumers need them, and order when they need enough. */
  private makeAndNeed(span: number): void {
    const hours = span / 3600;
    for (const s of this.sites) {
      const id = s.id;
      for (let g = 0; g < this.goods.length; g++) {
        if (this.supplyRate[id][g] > 0) this.stock[id][g] = Math.min(this.cap[id][g], this.stock[id][g] + this.supplyRate[id][g] * hours);
        if (this.demandRate[id][g] <= 0) continue;
        const size = this.size[id][g];
        this.need[id][g] = Math.min(3 * size, this.need[id][g] + this.demandRate[id][g] * hours);
        if (this.need[id][g] >= size && this.underWay[id][g] + size <= MAX_UNDER_WAY * size && this.time >= this.retryAt[id][g]) this.order(id, g, size);
      }
    }
  }

  /**
   * An order of `amount` loads of goods g for site `to`: from the source it comes
   * from best (as much as it has ready, if none has it all), as consignments.
   */
  private order(to: number, g: number, amount: number): void {
    const goods = this.goods[g];
    const options: Array<{ from: number; legs: FreightLeg[]; cost: number; amount: number }> = [];
    let any = false;
    for (const s of this.sites) {
      if (s.id === to || this.supplyRate[s.id][g] <= 0) continue;
      const routes = this.itineraries(s.id, to, goods);
      if (!routes.length) continue;
      any = true;
      const ready = Math.min(amount, Math.floor(this.stock[s.id][g]));
      if (ready >= 1) for (const route of routes) options.push({ from: s.id, ...route, amount: ready });
    }
    if (!options.length) {
      this.retryAt[to][g] = this.time + RETRY;
      if (any) this.totals.short++;
      else {
        this.totals.unserved++;
        this.need[to][g] = 0;                       // nothing can come: stop asking for a while
      }
      return;
    }
    // Quicker sources and ways are likelier, and sources with all of it ready more so.
    const low = Math.min(...options.map((o) => o.cost));
    const weights = options.map((o) => Math.exp(-(o.cost - low) / CHOICE) * (o.amount / amount) ** 2);
    let x = this.r() * weights.reduce((a, b) => a + b, 0);
    const pick = options.find((_, i) => (x -= weights[i]) < 0) ?? options[options.length - 1];
    amount = pick.amount;
    this.stock[pick.from][g] -= amount;
    this.need[to][g] -= amount;
    this.underWay[to][g] += amount;
    this.totals.orders++;
    // Split into loads a vehicle can take (or a train-sized lot if it never goes by road).
    const road = pick.legs.some((l) => l.mode === "road");
    const most = road ? this.largestFor(goods) : RAIL_ONLY_LOAD;
    for (let left = amount; left > 0; left -= most) {
      const c: Consignment = {
        id: this.nextId++, goods, amount: Math.min(most, left), from: pick.from, to, legs: pick.legs, leg: 0,
        state: "waiting", vehicle: -1, train: -1, created: this.time, since: this.time,
      };
      this.consignments.set(c.id, c);
    }
  }

  private largestFor(goods: string): number {
    return Math.max(1, ...this.world.freight.fleet.filter((f) => f.count > 0 && (!f.goods || f.goods.includes(goods))).map((f) => f.capacity));
  }

  /** On to its next leg, or delivered. `at` is the site it has reached. */
  private reached(c: Consignment, at: number): void {
    c.leg++;
    c.vehicle = -1;
    c.train = -1;
    c.since = this.time;
    if (c.leg < c.legs.length && at !== c.to) {
      c.state = "waiting";
      return;
    }
    this.consignments.delete(c.id);
    const g = this.goods.indexOf(c.goods);
    this.underWay[c.to][g] = Math.max(0, this.underWay[c.to][g] - c.amount);
    this.totals.delivered++;
    this.totals.loads += c.amount;
    this.totals.time += this.time - c.created;
    if (c.legs.some((l) => l.mode === "rail")) this.totals.byRail++;
    else this.totals.byRoad++;
  }

  // -- delivery vehicles ---------------------------------------------------------------------

  /** Gives free vehicles the oldest consignments waiting for the road, as many from one place as fit. */
  private dispatch(): void {
    const waiting = [...this.consignments.values()].filter((c) => c.state === "waiting" && c.legs[c.leg].mode === "road");
    // Vehicles that have driven about with nothing to do for a while go and wait off the board, if a road leads there.
    for (const ci of this.fleet) {
      const car = this.traffic.cars[ci];
      if (this.jobs.has(ci) || car.state !== "driving" || car.target || this.time - (this.idleSince.get(ci) ?? 0) < LINGER) continue;
      if (this.traffic.fleetFree(ci)) this.park(ci);
    }
    if (!waiting.length) return;
    waiting.sort((a, b) => a.since - b.since || a.id - b.id);
    const free = new Set(this.fleet.filter((ci) => !this.jobs.has(ci) && this.traffic.fleetFree(ci)));
    for (const c of waiting) {
      if (!free.size) return;
      if (c.state !== "waiting") continue;
      const site = c.legs[c.leg].from;
      const at = this.siteAt(site);
      // The nearest free vehicle that may take these goods and has room for them.
      const fits = [...free].filter((ci) => {
        const f = this.world.freight.fleet[this.traffic.cars[ci].fleet];
        return f.capacity >= c.amount && (!f.goods || f.goods.includes(c.goods));
      });
      fits.sort((a, b) => this.dist(this.traffic.carAt(a), at) - this.dist(this.traffic.carAt(b), at) || a - b);
      for (const ci of fits) {
        const f = this.world.freight.fleet[this.traffic.cars[ci].fleet];
        // Everything else waiting there for the road that fits, nearest destinations first.
        const load = [c];
        let room = f.capacity - c.amount;
        const others = waiting.filter((o) => o !== c && o.state === "waiting" && o.legs[o.leg].from === site && o.amount <= room && (!f.goods || f.goods.includes(o.goods)));
        const dest = (o: Consignment) => o.legs[o.leg].to;
        const here = this.siteAt(dest(c));
        others.sort((a, b) => (dest(a) === dest(c) ? 0 : 1) - (dest(b) === dest(c) ? 0 : 1) || this.dist(this.siteAt(dest(a)), here) - this.dist(this.siteAt(dest(b)), here) || a.id - b.id);
        for (const o of others) if (o.amount <= room) { load.push(o); room -= o.amount; }
        // Drop-offs in turn, each time to the nearest place still to go.
        const stops: Job["stops"] = [{ site, pickup: load.map((x) => x.id), drop: [] }];
        const left = new Set(load.map(dest));
        let from = this.siteAt(site);
        while (left.size) {
          const next = [...left].sort((a, b) => this.dist(this.siteAt(a), from) - this.dist(this.siteAt(b), from) || a - b)[0];
          left.delete(next);
          stops.push({ site: next, pickup: [], drop: load.filter((x) => dest(x) === next).map((x) => x.id) });
          from = this.siteAt(next);
        }
        const job: Job = { car: ci, stops, at: 0, sent: false, tries: 0 };
        if (!this.send(job)) continue;
        this.jobs.set(ci, job);
        free.delete(ci);
        for (const x of load) { x.state = "assigned"; x.vehicle = ci; x.since = this.time; }
        break;
      }
    }
  }

  /** Where a site is on the map (an off-layout one: where its nearest road leaves the board). */
  private siteAt(site: number): [number, number] {
    const s = this.sites[site];
    if (s.dock) return [s.dock.kerb[0], s.dock.kerb[1]];
    const ways = this.offWays(site);
    const e = ways.length ? this.world.offLayout.exits[ways[0].exit] : null;
    return e ? e.at : [NaN, NaN];
  }

  private dist(a: [number, number], b: [number, number]): number {
    const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
    return Number.isFinite(d) ? d : 1e6;
  }

  /** Sends a job's vehicle to its current stop; false if no way leads there from where it is. */
  private send(job: Job): boolean {
    const site = job.stops[job.at].site;
    const s = this.sites[site];
    let ok = false;
    if (s.dock) ok = this.traffic.sendFleet(job.car, { dock: { lane: s.dock.lane, d: s.dock.d } });
    else {
      // Off the board by the road out that is nearest the vehicle.
      const here = this.traffic.carAt(job.car);
      const ways = this.offWays(site).filter((w) => w.enter && w.leave.length)
        .sort((a, b) => a.distance + this.dist(here, this.world.offLayout.exits[a.exit].at) - b.distance - this.dist(here, this.world.offLayout.exits[b.exit].at));
      for (const w of ways) {
        const t = w.distance / OFF_SPEED;
        if (this.traffic.sendFleet(job.car, { exit: w.exit, place: s.ref, out: t, back: t })) { ok = true; break; }
      }
    }
    job.sent = ok;
    return ok;
  }

  /** Vehicles that reached a stop load and unload there; those done move on to their next stop, or are free again. */
  private vehicleEvents(): void {
    const t = this.traffic;
    for (const ci of t.fleetArrivals) {
      const job = this.jobs.get(ci);
      if (!job) { t.holdFleet(ci, 1); continue; }
      const stop = job.stops[job.at];
      let moved = 0;
      for (const id of stop.drop) {
        const c = this.consignments.get(id);
        if (!c) continue;
        moved += c.amount;
        this.reached(c, stop.site);
      }
      for (const id of stop.pickup) {
        const c = this.consignments.get(id);
        if (!c) continue;
        moved += c.amount;
        c.state = "carried";
        c.since = this.time;
      }
      t.holdFleet(ci, HANDLE + HANDLE_LOAD * moved);
    }
    t.fleetArrivals.length = 0;
    for (const ci of t.fleetReady) {
      const job = this.jobs.get(ci);
      if (!job) continue;
      job.at++;
      if (job.at >= job.stops.length) {
        this.jobs.delete(ci);
        this.idle(ci);
        continue;
      }
      job.tries = 0;
      this.send(job);
    }
    t.fleetReady.length = 0;
    // Vehicles that could not find a way to their next stop try again, and in the end give up.
    for (const job of this.jobs.values()) {
      if (job.sent) continue;
      if (this.send(job)) continue;
      if (++job.tries < SEND_TRIES) continue;
      for (const stop of job.stops.slice(job.at)) {
        for (const id of [...stop.pickup, ...stop.drop]) {
          const c = this.consignments.get(id);
          if (!c || c.vehicle !== job.car) continue;
          if (c.state === "assigned") { c.state = "waiting"; c.vehicle = -1; continue; }
          this.consignments.delete(id);
          this.underWay[c.to][this.goods.indexOf(c.goods)] -= c.amount;
          this.totals.lost++;
        }
      }
      this.jobs.delete(job.car);
      this.idle(job.car);
    }
  }

  /** A delivery vehicle with nothing more to do drives about for now (see `park`). */
  private idle(ci: number): void {
    this.traffic.releaseFleet(ci);
    this.idleSince.set(ci, this.time);
  }

  /**
   * A delivery vehicle that has had nothing to do for a while goes to wait off the
   * board beyond the nearest road leaving it (staying out there if it is out there
   * already). Where no road leaves the board, it keeps driving about.
   */
  private park(ci: number): void {
    const t = this.traffic;
    const here = t.carAt(ci);
    const depots = t.depots().sort((a, b) => this.dist(here, this.world.offLayout.exits[a].at) - this.dist(here, this.world.offLayout.exits[b].at) || a - b);
    for (const e of depots) if (t.parkFleet(ci, e)) return;
  }

  // -- freight trains ------------------------------------------------------------------------

  /** Freight trains at a yard or off-layout stop: unload what is for there, load what waits there for a stop ahead. */
  private trainStops(trains: Train[]): void {
    trains.forEach((t, ti) => {
      if (t.plan.type.shape !== "freight") return;
      const stopId = t.off >= 0 ? (t.offAt >= 0 ? this.world.offLayout.places[t.offAt].id : null) : t.phase === "dwelling" ? t.atStation : null;
      const site = stopId === null ? undefined : this.siteOfStop.get(stopId);
      if (site === undefined) return;
      let moved = 0;
      if (this.served.get(ti) !== t.stops) {
        this.served.set(ti, t.stops);
        const stay: number[] = [];
        for (const id of this.aboard[ti]) {
          const c = this.consignments.get(id);
          if (!c) continue;
          if (c.legs[c.leg].to === site) { moved += c.amount; this.reached(c, site); }
          else stay.push(id);
        }
        this.aboard[ti] = stay;
      }
      if (t.dwellLeft > 2) {
        const capacity = (t.plan.cars.length - 1) * WAGON_LOADS;
        let load = this.aboard[ti].reduce((a, id) => a + (this.consignments.get(id)?.amount ?? 0), 0);
        for (const c of this.consignments.values()) {
          if (c.state !== "waiting") continue;
          const leg = c.legs[c.leg];
          if (leg.mode !== "rail" || leg.from !== site || !leg.services.includes(t.plan.svc.id) || load + c.amount > capacity) continue;
          if (!this.headsFor(t, this.sites[leg.to].stop!)) continue;
          c.state = "carried";
          c.train = ti;
          c.since = this.time;
          this.aboard[ti].push(c.id);
          load += c.amount;
          moved += c.amount;
        }
      }
      // It waits while the goods are moved.
      if (moved) t.dwellLeft = Math.max(t.dwellLeft, Math.min(TRAIN_HOLD_MAX, 4 + moved * TRAIN_HANDLE));
    });
  }

  /** Whether a train standing at a stop will reach stop `to` (a station id, or an off-layout place's id) before turning back. */
  private headsFor(t: Train, to: string): boolean {
    const route = t.plan.route;
    if (route.closed || route.through) return true;
    const place = this.world.offLayout.places.find((p) => p.id === to);
    if (t.off >= 0) {
      // Out there a shuttle turns at its farthest call: ahead are the calls still to come, then back on the board.
      const run = t.plan.offRuns[t.off]!;
      if (place && run.calls.slice(t.offCall).some((c) => c.place === place.index)) return true;
      return !place || route.off[1 - t.off]?.calls.some((c) => c.place === place.index) === true;
    }
    const end = t.dir > 0 ? route.length : 0;
    const dir = Math.abs(t.r - end) < 0.5 ? -t.dir : t.dir;     // at a terminus it is about to reverse
    if (place) {
      const beyond = route.off[1]?.calls.some((c) => c.place === place.index) ? 1 : route.off[0]?.calls.some((c) => c.place === place.index) ? -1 : 0;
      return beyond === dir;
    }
    const stop = route.stops.find((s) => s.station === to);
    if (!stop) return false;
    const centre = t.r - (t.dir * t.plan.length) / 2;
    return (stop.r - centre) * dir > 0;
  }

  // -- for the scene, descriptions and tests ------------------------------------------------------

  /** Consignments waiting at a site (for a vehicle or a train), and those on their way there. */
  at(site: number): Consignment[] {
    return [...this.consignments.values()].filter((c) => c.state !== "carried" && c.legs[c.leg].from === site);
  }

  /** Consignments carried by a vehicle (or assigned to it), and those aboard a train. */
  inVehicle(ci: number): Consignment[] {
    return [...this.consignments.values()].filter((c) => c.vehicle === ci);
  }

  onTrain(ti: number): Consignment[] {
    return (this.aboard[ti] ?? []).map((id) => this.consignments.get(id)!).filter((c) => c);
  }

  /** Consignments on their way to a site. */
  inbound(site: number): Consignment[] {
    return [...this.consignments.values()].filter((c) => c.to === site);
  }

  snapshot(out?: FreightSnapshot): FreightSnapshot {
    const G = this.goods.length;
    const snap: FreightSnapshot = out ?? { goods: this.goods, yards: [], stock: [], trains: [] };
    if (snap.goods !== this.goods) Object.assign(snap, { goods: this.goods, yards: [], stock: [], trains: [] });   // another world
    const yards = this.world.freight.yardSite;
    while (snap.yards.length < yards.length) snap.yards.push(new Array<number>(G).fill(0));
    while (snap.stock.length < this.sites.length) snap.stock.push(new Array<number>(G).fill(0));
    while (snap.trains.length < this.aboard.length) snap.trains.push(new Array<number>(G).fill(0));
    for (const list of [snap.yards, snap.stock, snap.trains]) for (const a of list) a.fill(0);
    const gi = new Map(this.goods.map((g, i) => [g, i]));
    const yardOf = new Map(yards.map((s, k) => [s, k]));
    for (const c of this.consignments.values()) {
      const g = gi.get(c.goods)!;
      if (c.state === "carried") {
        if (c.train >= 0) snap.trains[c.train][g] += c.amount;
        continue;
      }
      const site = c.legs[c.leg].from;
      const y = yardOf.get(site);
      if (y !== undefined) snap.yards[y][g] += c.amount;
      else snap.stock[site][g] += c.amount;
    }
    for (const s of this.sites) for (let g = 0; g < G; g++) if (this.supplyRate[s.id][g] > 0 && s.kind === "building") snap.stock[s.id][g] += Math.floor(this.stock[s.id][g]);
    return snap;
  }

  stats(): FreightStats {
    const list = [...this.consignments.values()];
    return {
      orders: this.totals.orders, short: this.totals.short, unserved: this.totals.unserved,
      delivered: this.totals.delivered, loads: this.totals.loads, byRoad: this.totals.byRoad, byRail: this.totals.byRail,
      underWay: list.length, waiting: list.filter((c) => c.state !== "carried").length,
      avgTime: this.totals.delivered ? this.totals.time / this.totals.delivered : 0,
      maxAge: list.reduce((a, c) => Math.max(a, this.time - c.created), 0),
      busy: this.jobs.size, vehicles: this.fleet.length,
      onTrains: list.filter((c) => c.train >= 0).reduce((a, c) => a + c.amount, 0),
      lost: this.totals.lost,
    };
  }
}
