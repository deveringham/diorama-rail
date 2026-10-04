// Plain descriptions of what is on the board, for the inspect panel, the console
// (window.dr) and tests: a person (who they are, where they live and work, what
// they are doing), a building (who lives, works and is inside there), a vehicle
// (whose it is, where it is going; a bus's line, stops and passengers; a delivery
// van's job and load), a train (where it is going, who or what is aboard), a bus
// stop (its lines, who is waiting) and a goods yard (what waits there) —
// including whatever is out of sight off the board, at the off-layout places.

import type { Sim } from "./sim";
import type { Place } from "./planner";
import type { Consignment } from "./freight";
import { displayName } from "../model/roads";
import { goodsName, WAGON_LOADS } from "../model/catalog";
import { siteName } from "../model/freight";
import { nextStopOf } from "./trains";

export type Ref = { person?: number; building?: number; vehicle?: number; train?: number; stop?: number; yard?: number };
export type InfoLine = { label: string; text: string } & Ref;
export type InfoItem = { text: string } & Ref;
export type Info = { title: string; subtitle: string; lines: InfoLine[]; lists: Array<{ title: string; items: InfoItem[] }> };

const mins = (s: number) => (s < 90 ? `${Math.max(0, Math.round(s))} s` : `${Math.round(s / 60)} min`);
const article = (s: string) => (/^[aeiou]/i.test(s) ? `an ${s}` : `a ${s}`);

/** Where a bay is, in words: its car park or its street. */
function bayName(sim: Sim, bay: number): string {
  const b = sim.world.town.bays[bay];
  if (b.lot) return sim.world.town.lots.find((l) => l.id === b.lot)!.name;
  return displayName(sim.world.roads.roads.get(b.road)!.spec);
}

/** An off-layout place by name. */
const offName = (sim: Sim, p: number) => sim.world.offLayout.places[p].name;

/** A side of a bus stop (or −1 − p, an off-layout place), by its stop's name. */
function sideName(sim: Sim, side: number): string {
  if (side < 0) return offName(sim, -1 - side);
  const net = sim.world.buses;
  return net.stops[net.sides[side].stop].name;
}

/** A train stop: a station (index into town.stations) or −1 − p, an off-layout place. */
function stationName(sim: Sim, ref: number): string {
  return ref < 0 ? offName(sim, -1 - ref) : sim.world.town.stations[ref].name;
}

/** Where a drive ends: a bay, or (−1 − p) off the board at an off-layout place. */
const driveTo = (sim: Sim, to: number) => (to < 0 ? `${offName(sim, -1 - to)} (off the board)` : bayName(sim, to));

/** A bus line's name, by its id. */
function lineName(sim: Sim, id: string): string {
  const line = sim.world.buses.lines.find((l) => l.id === id);
  return line ? line.name : id;
}

function placeRef(p: Place): Ref {
  return p.kind === "building" ? { building: p.id } : {};
}

/** What someone is doing right now, in a few words. */
export function doing(sim: Sim, id: number): string {
  const b = sim.people.bodies[id];
  const town = sim.world.town;
  const dest = b.task ? sim.people.placeName(b.task.dest) : "";
  const to = b.task ? `${b.task.kind === "home" ? "home to" : b.task.kind === "work" ? "work at" : "to"} ${dest}` : "";
  const leg = b.route?.legs[b.leg];
  switch (b.mode) {
    case "inside": return b.at?.kind === "building" ? `inside ${town.buildings[b.at.id].name}` : "indoors";
    case "linger": return b.at ? `at ${sim.people.placeName(b.at)}` : "standing about";
    case "walk": return `walking ${to}`;
    case "wait": return `waiting to cross, on the way ${to}`;
    case "pass": return `going through ${town.stations[b.station]?.name ?? ""} station`;
    case "platform":
      return leg?.mode === "train" ? `waiting at ${town.stations[leg.from].name} for a train to ${stationName(sim, leg.to)}` : "on a platform";
    case "board":
      if (b.ride === "bus") return `getting on the ${busLine(sim, b.bus)} bus at ${sideName(sim, b.stopSide)}`;
      return `boarding a train at ${town.stations[b.station]?.name ?? ""}`;
    case "train":
      return leg?.mode === "train" ? `on train ${sim.trains[b.train]?.id ?? ""} to ${stationName(sim, leg.to)}` : "on a train";
    case "alight":
      if (b.ride === "bus") return `getting off the bus at ${sideName(sim, b.stopSide)}`;
      return `getting off at ${town.stations[b.station]?.name ?? ""}`;
    case "exit": return `getting off at ${town.stations[b.station]?.name ?? ""}`;
    case "stop":
      return leg?.mode === "bus" ? `waiting at ${sideName(sim, leg.from)} for the ${leg.lines.map((l) => lineName(sim, l)).join(" or ")} bus to ${sideName(sim, leg.to)}` : "at a bus stop";
    case "bus":
      return leg?.mode === "bus" ? `on the ${busLine(sim, b.bus)} bus to ${sideName(sim, leg.to)}` : "on a bus";
    case "drive":
      if (leg?.mode !== "drive") return `driving ${to}`;
      return leg.to < 0 && b.task?.dest.kind === "off" && b.task.dest.id === -1 - leg.to ? `driving ${to} (off the board)` : `driving to ${driveTo(sim, leg.to)}, then ${to}`;
    case "away": {
      const where = offName(sim, b.off);
      if (leg?.mode === "train") return `waiting in ${where} (off the board) for a train to ${stationName(sim, leg.to)}`;
      if (leg?.mode === "bus") return `waiting in ${where} (off the board) for the ${leg.lines.map((l) => lineName(sim, l)).join(" or ")} bus to ${sideName(sim, leg.to)}`;
      return b.task?.kind === "work" ? `at work in ${where} (off the board)` : `in ${where} (off the board)`;
    }
    case "transit": {
      const st = leg?.mode === "walk" ? leg.steps[b.step] : undefined;
      const where = offName(sim, b.off);
      return st?.kind === "off" && !st.out ? `walking back from ${where}, ${to}` : `walking to ${where} (off the board)`;
    }
  }
}

export function describePerson(sim: Sim, id: number): Info {
  const town = sim.world.town;
  const p = town.people[id];
  const b = sim.people.bodies[id];
  const home = town.buildings[p.home];
  const lines: InfoLine[] = [
    { label: "Home", text: home.name, building: home.id },
    !p.job ? { label: "Job", text: "none" }
      : p.job.off >= 0 ? { label: "Job", text: `${p.job.title} in ${offName(sim, p.job.off)} (off the board)` }
        : { label: "Job", text: `${p.job.title} at ${town.buildings[p.job.building].name}`, building: p.job.building },
  ];
  if (b.car >= 0) {
    const car = sim.traffic.cars[b.car];
    const what = car.object.replace(/-/g, " ");
    const where = car.state === "driving" ? (car.hidden ? "off the board" : "on the road") : car.state === "leaving" ? `pulling out on ${bayName(sim, car.bay)}`
      : car.state === "off" ? `parked in ${offName(sim, car.offPlace)} (off the board)` : car.state === "entering" ? "on its way back on to the board" : `parked at ${bayName(sim, car.bay)}`;
    lines.push({ label: "Car", text: `${what}, ${where}`, vehicle: b.car });
  } else lines.push({ label: "Car", text: "none" });
  const now: Ref = b.mode === "train" ? { train: b.train } : b.mode === "drive" ? { vehicle: b.car } : b.mode === "bus" ? { vehicle: b.bus }
    : b.mode === "stop" ? { stop: sim.world.buses.sides[b.stopSide].stop } : b.at ? placeRef(b.at) : {};
  lines.push({ label: "Now", text: doing(sim, id), ...now });
  if (b.task) {
    const t = b.task;
    const there = !Number.isNaN(t.arrived);
    lines.push({ label: "Task", text: `${t.label}, for ${mins(t.duration)}${there ? ` (${mins(b.timer)} left)` : ""}`, ...placeRef(t.dest) });
    if (b.route) {
      const legs = b.route.legs.map((l, k) => (k === b.leg ? `[${l.mode}]` : l.mode)).join(" → ");
      lines.push({ label: "Journey", text: legs });
    }
  } else lines.push({ label: "Task", text: "none yet" });
  return { title: p.name, subtitle: p.job ? p.job.title : "resident", lines, lists: [] };
}

export function describeBuilding(sim: Sim, id: number): Info {
  const town = sim.world.town;
  const b = town.buildings[id];
  const residents = town.people.filter((p) => p.home === id);
  const workers = town.people.filter((p) => p.job?.building === id);
  const inside = sim.people.bodies.filter((x) => x.mode === "inside" && x.at?.kind === "building" && x.at.id === id);
  const lists: Info["lists"] = [];
  if (b.residents) lists.push({ title: `Lives here (${residents.length} of ${b.residents})`, items: residents.map((p) => ({ text: p.name, person: p.id })) });
  if (b.jobs.length) lists.push({ title: `Works here (${workers.length} of ${b.jobs.length})`, items: workers.map((p) => ({ text: `${p.job!.title}: ${p.name}`, person: p.id })) });
  lists.push({ title: `Inside now (${inside.length})`, items: inside.map((x) => ({ text: town.people[x.id].name, person: x.id })) });
  const lines: InfoLine[] = [];
  if (!b.access && !b.bays.length) lines.push({ label: "Access", text: "no walkway or parking nearby" });
  const yard = sim.world.freight.yards.findIndex((y) => y.building === id);
  if (yard >= 0) lines.push({ label: "Yard", text: sim.world.freight.yards[yard].name, yard });
  const site = sim.world.freight.buildingSite.get(id);
  if (site !== undefined) {
    const f = freightLines(sim, site);
    lines.push(...f.lines);
    lists.push(...f.lists);
  }
  return { title: b.name, subtitle: `${b.kind} · ${b.functions.join(", ")}`, lines, lists };
}

/** A bus's line name, by its traffic car index. */
function busLine(sim: Sim, ci: number): string {
  const car = sim.traffic.cars[ci];
  return car && car.line >= 0 ? sim.world.buses.lines[car.line].name : "";
}

export function describeVehicle(sim: Sim, ci: number): Info {
  const car = sim.traffic.cars[ci];
  const what = car.object.replace(/-/g, " ");
  const lines: InfoLine[] = [];
  if (car.line >= 0) return describeBus(sim, ci);
  if (car.fleet >= 0) return describeDelivery(sim, ci);
  if (car.owner < 0) return { title: what[0].toUpperCase() + what.slice(1), subtitle: "through traffic", lines: [{ label: "Driver", text: "passing through from off the board" }], lists: [] };
  const owner = sim.world.town.people[car.owner];
  if (car.state === "driving" || car.state === "entering") {
    lines.push({ label: "Driver", text: owner.name, person: owner.id });
    if (car.goal !== -1) lines.push({ label: "Going to", text: driveTo(sim, car.goal) });
  } else if (car.state === "off") {
    lines.push({ label: "Parked", text: `in ${offName(sim, car.offPlace)} (off the board)` });
    lines.push({ label: "Owner", text: `${owner.name} (${doing(sim, owner.id)})`, person: owner.id });
  } else {
    lines.push({ label: car.state === "leaving" ? "Pulling out" : "Parked", text: bayName(sim, car.bay) });
    lines.push({ label: "Owner", text: `${owner.name} (${doing(sim, owner.id)})`, person: owner.id });
  }
  const subtitle = car.hidden ? "off the board" : car.state === "driving" ? "on the road" : "parked";
  return { title: `${owner.name}'s ${what}`, subtitle, lines, lists: [] };
}

export function describeTrain(sim: Sim, ti: number): Info {
  const t = sim.trains[ti];
  const town = sim.world.town;
  const riders = sim.people.riders[ti] ?? [];
  const named = (id: string | null) => {
    if (!id) return "—";
    const place = sim.world.offLayout.places.find((p) => p.id === id);
    return place ? `${place.name} (off the board)` : sim.world.layout.stations.find((s) => s.id === id)?.name ?? id;
  };
  const lines: InfoLine[] = [{ label: "Service", text: `${t.plan.svc.id} (${t.plan.svc.train}, ${t.plan.svc.mode})` }];
  if (t.off >= 0) {
    // Out of sight: calling at an off-layout place, or on its way.
    const run = t.plan.offRuns[t.off]!;
    if (t.offAt >= 0) lines.push({ label: "At", text: `${offName(sim, t.offAt)} (off the board)` });
    else if (t.offCall < run.calls.length) lines.push({ label: "Next stop", text: `${offName(sim, run.calls[t.offCall].place)} (off the board)` });
    else lines.push({ label: "Next", text: `back on the board in about ${mins(Math.max(0, run.total - t.offT))}` });
  } else lines.push({ label: t.atStation ? "At" : "Next stop", text: t.atStation ? named(t.atStation) : named(nextStopOf(t)) });
  const items = riders.map((id) => {
    const leg = sim.people.bodies[id].route?.legs[sim.people.bodies[id].leg];
    const to = leg?.mode === "train" ? ` → ${stationName(sim, leg.to)}` : "";
    return { text: `${town.people[id].name}${to}`, person: id };
  });
  const subtitle = `${article(t.plan.svc.train)} on ${t.plan.svc.id}${t.off >= 0 ? ", off the board" : ""}`;
  if (t.plan.type.shape === "freight") {
    // A freight train: its goods, by where they come off.
    const goods = sim.freight.onTrain(ti);
    const capacity = (t.plan.cars.length - 1) * WAGON_LOADS;
    const load = goods.reduce((a, c) => a + c.amount, 0);
    const cargo = goods.map((c) => ({ text: `${loads(c.amount, c.goods)} → ${siteName(sim.freight.sites[c.legs[c.leg].to])}${c.legs[c.leg].to !== c.to ? ` (for ${siteName(sim.freight.sites[c.to])})` : ""}` }));
    return { title: `Train ${t.id}`, subtitle, lines, lists: [{ title: `Goods (${load} of ${capacity} loads)`, items: cargo }] };
  }
  return { title: `Train ${t.id}`, subtitle, lines, lists: [{ title: `Passengers (${riders.length})`, items }] };
}

// ---------------------------------------------------------------------------
// Freight

/** "3 loads of food". */
export const loads = (n: number, goods: string) => `${n} load${n === 1 ? "" : "s"} of ${goodsName(goods)}`;

/** A freight site by name, linked to its building or yard. */
function siteRef(sim: Sim, site: number): Ref {
  const s = sim.freight.sites[site];
  return s.kind === "building" ? { building: s.ref } : s.kind === "yard" ? { yard: s.ref } : {};
}

/** Where a consignment is and what is happening to it, in a few words. */
export function freightStatus(sim: Sim, c: Consignment): string {
  const sites = sim.freight.sites;
  const leg = c.legs[c.leg];
  if (c.state === "carried") {
    if (c.train >= 0) return `on train ${sim.trains[c.train].id} to ${siteName(sites[leg.to])}`;
    const f = sim.world.freight.fleet[sim.traffic.cars[c.vehicle].fleet];
    return `in a ${f.name.toLowerCase()} to ${siteName(sites[leg.to])}`;
  }
  const at = siteName(sites[leg.from]);
  if (c.state === "assigned") return `waiting at ${at} for the ${sim.world.freight.fleet[sim.traffic.cars[c.vehicle].fleet].name.toLowerCase()} on its way`;
  return leg.mode === "rail" ? `waiting at ${at} for a freight train` : c.leg === 0 ? `ready at ${at} for collection` : `waiting at ${at} for a lorry`;
}

/** What a building sends out and needs, and the goods on their way there (none: it has no part in freight). */
function freightLines(sim: Sim, site: number): { lines: InfoLine[]; lists: Info["lists"] } {
  const f = sim.freight;
  const s = f.sites[site];
  const lines: InfoLine[] = [];
  const rate = (r: { goods: string; rate: number }) => `${goodsName(r.goods)} ${r.rate}`;
  if (s.supplies.length) {
    const ready = s.supplies.map((r) => `${Math.floor(f.stock[site][f.goods.indexOf(r.goods)])} ${goodsName(r.goods)}`).join(", ");
    lines.push({ label: "Sends out", text: `${s.supplies.map(rate).join(", ")} loads an hour (ready now: ${ready})` });
  }
  if (s.demands.length) lines.push({ label: "Needs", text: `${s.demands.map(rate).join(", ")} loads an hour` });
  if (!s.dock && s.kind === "building") lines.push({ label: "Deliveries", text: "no road near enough for a lorry to stop" });
  const inbound = f.inbound(site);
  const outbound = f.at(site).filter((c) => c.legs[c.leg].from === site && c.from === site);
  const lists: Info["lists"] = [];
  if (s.demands.length) lists.push({ title: `Goods on the way here (${inbound.length})`, items: inbound.map((c) => ({ text: `${loads(c.amount, c.goods)} from ${siteName(f.sites[c.from])}: ${freightStatus(sim, c)}`, ...siteRef(sim, c.from) })) });
  if (s.supplies.length) lists.push({ title: `Waiting to go out (${outbound.length})`, items: outbound.map((c) => ({ text: `${loads(c.amount, c.goods)} for ${siteName(f.sites[c.to])}`, ...siteRef(sim, c.to) })) });
  return { lines, lists };
}

function describeDelivery(sim: Sim, ci: number): Info {
  const car = sim.traffic.cars[ci];
  const f = sim.world.freight.fleet[car.fleet];
  const freight = sim.freight;
  const job = freight.jobs.get(ci);
  const lines: InfoLine[] = [{ label: "Carries", text: `up to ${f.capacity} loads${f.goods ? ` of ${f.goods.map(goodsName).join(", ")}` : ""}` }];
  const out = car.depot >= 0 ? sim.world.offLayout.exits[car.depot] : null;
  let subtitle = out ? `waiting off the board (beyond ${out.kind === "road" ? displayName(sim.world.roads.roads.get(out.line)!.spec) : out.line}) for a job`
    : car.hidden ? "off the board" : car.target?.kind === "park" ? "going off the board to wait for a job" : "driving about, free for a job";
  if (job) {
    const stop = job.stops[job.at];
    const name = siteName(freight.sites[stop.site]);
    const here = car.dwelling;
    const doing = stop.pickup.length ? (here ? "loading at" : "on its way to collect at") : here ? "unloading at" : "delivering to";
    lines.push({ label: "Now", text: `${doing} ${name}`, ...siteRef(sim, stop.site) });
    const then = job.stops.slice(job.at + 1).map((x) => siteName(freight.sites[x.site]));
    if (then.length) lines.push({ label: "Then", text: then.join(", ") });
    subtitle = car.state === "entering" ? "coming on to the board for a delivery" : car.hidden ? "off the board, on a delivery" : here ? (stop.pickup.length ? "loading" : "unloading") : "on a delivery";
  }
  const load = freight.inVehicle(ci);
  const aboard = load.filter((c) => c.state === "carried");
  const items = load.map((c) => ({ text: `${loads(c.amount, c.goods)} → ${siteName(freight.sites[c.legs[c.leg].to])}${c.state === "carried" ? "" : " (to collect)"}`, ...siteRef(sim, c.legs[c.leg].to) }));
  return { title: f.name, subtitle, lines, lists: [{ title: `Load (${aboard.reduce((a, c) => a + c.amount, 0)} of ${f.capacity})`, items }] };
}

export function describeYard(sim: Sim, k: number): Info {
  const world = sim.world;
  const y = world.freight.yards[k];
  const site = world.freight.yardSite[k];
  const freight = sim.freight;
  const lines: InfoLine[] = [];
  lines.push({ label: "Lorries stop", text: y.dock ? `on ${displayName(world.roads.roads.get(y.dock.road)!.spec)}` : "nowhere: no road along the dock" });
  const services = world.layout.services.filter((s) => s.stops.includes(y.id)).map((s) => s.id);
  lines.push({ label: "Freight trains", text: services.join(", ") || "none call here" });
  if (y.building >= 0) lines.push({ label: "Goods shed", text: world.town.buildings[y.building].name, building: y.building });
  const waiting = freight.at(site);
  const total = waiting.reduce((a, c) => a + c.amount, 0);
  const lorries = [...freight.jobs.values()].filter((j) => j.stops.slice(j.at).some((x) => x.site === site));
  return {
    title: y.name, subtitle: "goods yard", lines,
    lists: [
      { title: `On the dock (${total} load${total === 1 ? "" : "s"})`, items: waiting.map((c) => ({ text: `${loads(c.amount, c.goods)} for ${siteName(freight.sites[c.to])}: ${freightStatus(sim, c)}`, ...siteRef(sim, c.to) })) },
      { title: `Lorries coming (${lorries.length})`, items: lorries.map((j) => ({ text: world.freight.fleet[sim.traffic.cars[j.car].fleet].name, vehicle: j.car })) },
    ],
  };
}

function describeBus(sim: Sim, ci: number): Info {
  const car = sim.traffic.cars[ci];
  const net = sim.world.buses;
  const line = net.lines[car.line];
  const town = sim.world.town;
  const riders = sim.people.onBus.get(ci) ?? [];
  const m = line.visits.length;
  const ahead = Array.from({ length: Math.min(m, 4) }, (_, k) => line.visits[(car.nextVisit + k) % m].side);
  const first: InfoLine = { label: car.dwelling ? "At" : "Next stop", text: sideName(sim, ahead[0]) + (ahead[0] < 0 ? " (off the board)" : "") };
  if (ahead[0] >= 0) first.stop = net.sides[ahead[0]].stop;
  const lines: InfoLine[] = [
    { label: "Line", text: `${line.name} (${line.mode === "loop" ? "loop" : "there and back"}, ${line.count} bus${line.count > 1 ? "es" : ""}, every ${mins(line.cycle / line.count)})` },
    first,
  ];
  if (ahead.length > 1) lines.push({ label: "Then", text: ahead.slice(1).map((x) => sideName(sim, x)).join(", ") });
  const items = riders.map((id) => {
    const leg = sim.people.bodies[id].route?.legs[sim.people.bodies[id].leg];
    const to = leg?.mode === "bus" ? ` → ${sideName(sim, leg.to)}` : "";
    return { text: `${town.people[id].name}${to}`, person: id };
  });
  return {
    title: `Bus ${line.name}`, subtitle: car.hidden ? (car.dwelling ? "off the board, at a stop" : "off the board") : car.dwelling ? "at a stop" : "on its way",
    lines, lists: [{ title: `Passengers (${riders.length} of ${line.capacity})`, items }],
  };
}

export function describeBusStop(sim: Sim, si: number): Info {
  const net = sim.world.buses;
  const stop = net.stops[si];
  const town = sim.world.town;
  const lines: InfoLine[] = [{ label: "Street", text: displayName(sim.world.roads.roads.get(stop.road)!.spec) }];
  const lists: Info["lists"] = [];
  for (const sideId of stop.sides) {
    const side = net.sides[sideId];
    // Lines calling here, with where they go next and when the next bus is due.
    const calls: string[] = [];
    net.lines.forEach((line, li) => {
      const v = line.visits.findIndex((x) => x.side === sideId);
      if (v < 0) return;
      const next = sideName(sim, line.visits[(v + 1) % line.visits.length].side);
      const due = sim.traffic.lines[li]?.buses.map((ci) => sim.traffic.busDue(ci, v)).filter((t) => t !== null) as number[];
      const soon = due.length ? Math.min(...due) : null;
      calls.push(`${line.name} towards ${next}${soon === null ? "" : soon < 1 ? " (here now)" : ` (in about ${mins(soon)})`}`);
    });
    const where = stop.sides.length > 1 ? `${side.side > 0 ? "Left" : "Right"} side` : "Buses";
    lines.push({ label: where, text: calls.join("; ") || "no line calls here" });
    if (!town.stops[sideId]?.access) lines.push({ label: "Access", text: "no walkway nearby" });
    const waiting = sim.people.bodies.filter((b) => b.mode === "stop" && b.stopSide === sideId);
    lists.push({
      title: `Waiting${stop.sides.length > 1 ? ` (${side.side > 0 ? "left" : "right"} side)` : ""} (${waiting.length})`,
      items: waiting.map((b) => {
        const leg = b.route?.legs[b.leg];
        return { text: `${town.people[b.id].name}${leg?.mode === "bus" ? ` → ${sideName(sim, leg.to)}` : ""}`, person: b.id };
      }),
    });
  }
  return { title: stop.name, subtitle: "bus stop", lines, lists };
}
