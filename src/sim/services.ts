// Per-service plans: the route path cut into block "entries" in travel order,
// stop positions, curve speed limits along the route, and which entries are
// "opposed" (another train may run through them the other way).

import type { World } from "../model/build";
import type { ServiceSpec } from "../model/schema";
import type { RoutePath } from "../model/routes";
import { locate } from "../model/routes";
import type { SwitchState } from "../model/trackGraph";
import { radiusAt } from "../model/geometry";
import { TRAIN_CATALOG, carLengths, type TrainType, type TrainTypeId } from "../model/catalog";
import type { Blocks } from "./blocks";
import { mod } from "../util/vec";

const LATERAL_ACCEL = 1.0;     // m/s² allowed in curves: v = sqrt(a·r)
export const CURVE_STEP = 5;   // m between curve speed-limit samples
const OFF_SPEED = 0.8;         // share of its top speed a train averages off the board

export type Entry = {
  block: number;
  r0: number;
  r1: number;
  legs: Array<{ track: string; dir: 1 | -1 }>;     // track pieces inside this block, with s-direction for +r travel
  switches: Array<{ sw: number; state: SwitchState }>;
};

/** A run off the board in time: calls at off-layout places (s of travel from the edge), total travel, where it comes back on. */
export type OffTrain = { calls: Array<{ place: number; id: string; at: number }>; total: number; reenter: 0 | 1; speed: number };

export type Plan = {
  svc: ServiceSpec;
  type: TrainType;
  cars: number[];             // vehicle lengths, front to back
  length: number;
  route: RoutePath;
  entries: Entry[];
  curve: Float32Array;        // speed limit (m/s) every CURVE_STEP metres of r
  opposed: [Uint8Array, Uint8Array];   // per entry, for travel +r and −r
  offRuns: [OffTrain | null, OffTrain | null];   // off the board beyond r = 0 and r = length
};

export function buildPlans(world: World, blocks: Blocks): Plan[] {
  const plans = world.layout.services.map((svc) => {
    const type: TrainType = TRAIN_CATALOG[svc.train as TrainTypeId];
    const route = world.routes.get(svc.id)!;
    const cars = carLengths(type);
    const entries = cutEntries(world, blocks, route);
    const curve = new Float32Array(Math.ceil(route.length / CURVE_STEP) + 1);
    for (let i = 0; i < curve.length; i++) {
      const at = locate(route, world.tracks, Math.min(i * CURVE_STEP, route.length));
      const radius = radiusAt(world.tracks.get(at.track)!.path, at.s);
      curve[i] = Math.min(type.maxSpeed, Math.sqrt(LATERAL_ACCEL * radius));
    }
    // Off the board the trains keep up a steady speed.
    const speed = type.maxSpeed * OFF_SPEED;
    const offRuns = route.off.map((o) => o && {
      calls: o.calls.map((c) => ({ place: c.place, id: world.offLayout.places[c.place].id, at: c.at / speed })),
      total: o.length / speed, reenter: o.reenter, speed,
    }) as Plan["offRuns"];
    return {
      svc, type, cars, length: cars.reduce((a, b) => a + b, 0), route, entries, curve,
      opposed: [new Uint8Array(entries.length), new Uint8Array(entries.length)] as [Uint8Array, Uint8Array], offRuns,
    };
  });
  markOpposed(plans);
  return plans;
}

/** Walks the route and splits it wherever it crosses a block boundary. */
function cutEntries(world: World, blocks: Blocks, route: RoutePath): Entry[] {
  const entries: Entry[] = [];
  for (const p of route.pieces) {
    const L = world.tracks.get(p.track)!.path.length;
    const list = blocks.byTrack.get(p.track)!;
    let s = p.s0;
    let left = p.length;
    let r = p.r0;
    while (left > 1e-9) {
      if (p.dir > 0 && s >= L - 1e-9) s = 0;
      if (p.dir < 0 && s <= 1e-9) s = L;
      const piece = list.find((b) => (p.dir > 0 ? b.s0 <= s + 1e-9 && s < b.s1 - 1e-9 : b.s0 < s - 1e-9 && s <= b.s1 + 1e-9))!;
      const take = Math.min(left, p.dir > 0 ? piece.s1 - s : s - piece.s0);
      const last = entries[entries.length - 1];
      if (last && last.block === piece.block) {
        last.r1 = r + take;
        if (!last.legs.some((l) => l.track === p.track)) last.legs.push({ track: p.track, dir: p.dir });
      } else {
        entries.push({ block: piece.block, r0: r, r1: r + take, legs: [{ track: p.track, dir: p.dir }], switches: [] });
      }
      s += p.dir * take;
      r += take;
      left -= take;
    }
  }
  for (const sw of route.switches) {
    const e = entries.find((en) => sw.r >= en.r0 - 1e-6 && sw.r <= en.r1 + 1e-6);
    if (e && blocks.blocks[e.block].switches.includes(sw.sw)) e.switches.push({ sw: sw.sw, state: sw.state });
  }
  return entries;
}

/**
 * An entry is opposed for a train when some other train may traverse the same
 * block piece in the opposite direction. Shuttles use their path both ways, so a
 * shuttle with several trains opposes itself. Trains reserve whole opposed runs
 * at once, which is what keeps single-track sections from deadlocking.
 */
function markOpposed(plans: Plan[]): void {
  const users = new Map<string, Set<number>>();
  const key = (block: number, track: string, dir: number) => `${block}|${track}|${dir}`;
  plans.forEach((pl, i) => {
    for (const e of pl.entries) {
      for (const leg of e.legs) {
        const dirs = pl.svc.mode === "shuttle" ? [leg.dir, -leg.dir] : [leg.dir];
        for (const d of dirs) {
          const k = key(e.block, leg.track, d);
          if (!users.has(k)) users.set(k, new Set());
          users.get(k)!.add(i);
        }
      }
    }
  });
  plans.forEach((pl, i) => {
    const selfOpposed = pl.svc.mode === "shuttle" && pl.svc.count > 1;
    pl.entries.forEach((e, k) => {
      for (const [t, travel] of [[0, 1], [1, -1]] as const) {
        pl.opposed[t][k] = e.legs.some((leg) => {
          const against = users.get(key(e.block, leg.track, -leg.dir * travel));
          return !!against && [...against].some((j) => j !== i || selfOpposed);
        }) ? 1 : 0;
      }
    });
  });
}

/** Curve speed limit at route coordinate r. */
export function curveLimit(plan: Plan, r: number): number {
  const L = plan.route.length;
  const x = plan.route.closed ? mod(r, L) : Math.min(Math.max(r, 0), L);
  return plan.curve[Math.min(plan.curve.length - 1, Math.round(x / CURVE_STEP))];
}
