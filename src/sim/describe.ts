// Plain descriptions of what is on the board, for the inspect panel, the console
// (window.dr) and tests: a person (who they are, where they live and work, what
// they are doing), a building (who lives, works and is inside there), a vehicle
// (whose it is, where it is going; a bus's line, stops and passengers), a train
// (where it is going, who is aboard) and a bus stop (its lines, who is waiting).

import type { Sim } from "./sim";
import type { Place } from "./planner";
import { displayName } from "../model/roads";
import { nextStopOf } from "./trains";

export type Ref = { person?: number; building?: number; vehicle?: number; train?: number; stop?: number };
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

/** A side of a bus stop, by its stop's name. */
function sideName(sim: Sim, side: number): string {
  const net = sim.world.buses;
  const st = net.sides[side];
  return net.stops[st.stop].name;
}

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
      return leg?.mode === "train" ? `waiting at ${town.stations[leg.from].name} for a train to ${town.stations[leg.to].name}` : "on a platform";
    case "board":
      if (b.ride === "bus") return `getting on the ${busLine(sim, b.bus)} bus at ${sideName(sim, b.stopSide)}`;
      return `boarding a train at ${town.stations[b.station]?.name ?? ""}`;
    case "train":
      return leg?.mode === "train" ? `on train ${sim.trains[b.train]?.id ?? ""} to ${town.stations[leg.to].name}` : "on a train";
    case "alight":
      if (b.ride === "bus") return `getting off the bus at ${sideName(sim, b.stopSide)}`;
      return `getting off at ${town.stations[b.station]?.name ?? ""}`;
    case "exit": return `getting off at ${town.stations[b.station]?.name ?? ""}`;
    case "stop":
      return leg?.mode === "bus" ? `waiting at ${sideName(sim, leg.from)} for the ${leg.lines.map((l) => lineName(sim, l)).join(" or ")} bus to ${sideName(sim, leg.to)}` : "at a bus stop";
    case "bus":
      return leg?.mode === "bus" ? `on the ${busLine(sim, b.bus)} bus to ${sideName(sim, leg.to)}` : "on a bus";
    case "drive": return leg?.mode === "drive" ? `driving to ${bayName(sim, leg.to)}, then ${to}` : `driving ${to}`;
  }
}

export function describePerson(sim: Sim, id: number): Info {
  const town = sim.world.town;
  const p = town.people[id];
  const b = sim.people.bodies[id];
  const home = town.buildings[p.home];
  const lines: InfoLine[] = [
    { label: "Home", text: home.name, building: home.id },
    p.job ? { label: "Job", text: `${p.job.title} at ${town.buildings[p.job.building].name}`, building: p.job.building } : { label: "Job", text: "none" },
  ];
  if (b.car >= 0) {
    const car = sim.traffic.cars[b.car];
    const what = car.object.replace(/-/g, " ");
    const where = car.state === "driving" ? "on the road" : car.state === "leaving" ? `pulling out on ${bayName(sim, car.bay)}` : `parked at ${bayName(sim, car.bay)}`;
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
  if (car.owner < 0) return { title: what[0].toUpperCase() + what.slice(1), subtitle: "through traffic", lines: [{ label: "Driver", text: "passing through from off the board" }], lists: [] };
  const owner = sim.world.town.people[car.owner];
  if (car.state === "driving") {
    lines.push({ label: "Driver", text: owner.name, person: owner.id });
    if (car.goal >= 0) lines.push({ label: "Going to", text: bayName(sim, car.goal) });
  } else {
    lines.push({ label: car.state === "leaving" ? "Pulling out" : "Parked", text: bayName(sim, car.bay) });
    lines.push({ label: "Owner", text: `${owner.name} (${doing(sim, owner.id)})`, person: owner.id });
  }
  return { title: `${owner.name}'s ${what}`, subtitle: car.state === "driving" ? "on the road" : "parked", lines, lists: [] };
}

export function describeTrain(sim: Sim, ti: number): Info {
  const t = sim.trains[ti];
  const town = sim.world.town;
  const riders = sim.people.riders[ti] ?? [];
  const stationName = (id: string | null) => (id ? sim.world.layout.stations.find((s) => s.id === id)?.name ?? id : "—");
  const lines: InfoLine[] = [
    { label: "Service", text: `${t.plan.svc.id} (${t.plan.svc.train}, ${t.plan.svc.mode})` },
    { label: t.atStation ? "At" : "Next stop", text: t.atStation ? stationName(t.atStation) : stationName(nextStopOf(t)) },
  ];
  const items = riders.map((id) => {
    const leg = sim.people.bodies[id].route?.legs[sim.people.bodies[id].leg];
    const to = leg?.mode === "train" ? ` → ${town.stations[leg.to].name}` : "";
    return { text: `${town.people[id].name}${to}`, person: id };
  });
  return { title: `Train ${t.id}`, subtitle: `${article(t.plan.svc.train)} on ${t.plan.svc.id}`, lines, lists: [{ title: `Passengers (${riders.length})`, items }] };
}

function describeBus(sim: Sim, ci: number): Info {
  const car = sim.traffic.cars[ci];
  const net = sim.world.buses;
  const line = net.lines[car.line];
  const town = sim.world.town;
  const riders = sim.people.onBus.get(ci) ?? [];
  const stopOf = (v: number) => net.sides[line.visits[v].side].stop;
  const m = line.visits.length;
  const ahead = Array.from({ length: Math.min(m, 4) }, (_, k) => stopOf((car.nextVisit + k) % m));
  const lines: InfoLine[] = [
    { label: "Line", text: `${line.name} (${line.mode === "loop" ? "loop" : "there and back"}, ${line.count} bus${line.count > 1 ? "es" : ""}, every ${mins(line.cycle / line.count)})` },
    car.dwelling
      ? { label: "At", text: net.stops[ahead[0]].name, stop: ahead[0] }
      : { label: "Next stop", text: net.stops[ahead[0]].name, stop: ahead[0] },
  ];
  if (ahead.length > 1) lines.push({ label: "Then", text: ahead.slice(1).map((k) => net.stops[k].name).join(", ") });
  const items = riders.map((id) => {
    const leg = sim.people.bodies[id].route?.legs[sim.people.bodies[id].leg];
    const to = leg?.mode === "bus" ? ` → ${sideName(sim, leg.to)}` : "";
    return { text: `${town.people[id].name}${to}`, person: id };
  });
  return {
    title: `Bus ${line.name}`, subtitle: car.dwelling ? "at a stop" : car.hidden ? "off the board, turning round" : "on its way",
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
      const next = net.stops[net.sides[line.visits[(v + 1) % line.visits.length].side].stop].name;
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
