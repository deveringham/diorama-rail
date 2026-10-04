// Plain descriptions of what is on the board, for the inspect panel, the console
// (window.dr) and tests: a person (who they are, where they live and work, what
// they are doing), a building (who lives, works and is inside there), a vehicle
// (whose it is, where it is going) and a train (where it is going, who is aboard).

import type { Sim } from "./sim";
import type { Place } from "./planner";
import { displayName } from "../model/roads";
import { nextStopOf } from "./trains";

export type Ref = { person?: number; building?: number; vehicle?: number; train?: number };
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
    case "board": return `boarding a train at ${town.stations[b.station]?.name ?? ""}`;
    case "train":
      return leg?.mode === "train" ? `on train ${sim.trains[b.train]?.id ?? ""} to ${town.stations[leg.to].name}` : "on a train";
    case "alight":
    case "exit": return `getting off at ${town.stations[b.station]?.name ?? ""}`;
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
  lines.push({ label: "Now", text: doing(sim, id), ...(b.mode === "train" ? { train: b.train } : b.mode === "drive" ? { vehicle: b.car } : b.at ? placeRef(b.at) : {}) });
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

export function describeVehicle(sim: Sim, ci: number): Info {
  const car = sim.traffic.cars[ci];
  const what = car.object.replace(/-/g, " ");
  const lines: InfoLine[] = [];
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
