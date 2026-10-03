// npm run simulate -- layouts/x.json [--minutes 30] [--json]
// Validates, then runs the simulation headlessly and prints per-service stats,
// road traffic and pedestrian stats and any deadlock. Exit 1 on validation errors or deadlock.

import { parseArgs } from "node:util";
import { simulate, type SimReport } from "../sim/sim";
import { makeReport } from "../model/validate";
import { readLayout, printIssues } from "./io";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { minutes: { type: "string", default: "30" }, json: { type: "boolean", default: false } },
});
const file = positionals[0];
const minutes = Number(values.minutes);
const { json, issue } = readLayout(file);
const res: SimReport = issue ? { report: makeReport([issue]), events: [], perService: [] } : simulate(json, minutes * 60);
if (values.json) {
  console.log(JSON.stringify({ ...res, events: res.events.length > 500 ? res.events.slice(0, 500) : res.events }, null, 2));
} else {
  printIssues(file ?? "(none)", res.report);
  if (res.perService.length) {
    console.log(`\nafter ${minutes} simulated minutes:`);
    console.log("service".padEnd(14) + "stops".padStart(7) + "avg m/s".padStart(10) + "max wait s".padStart(12));
    for (const s of res.perService) {
      console.log(s.service.padEnd(14) + String(s.stops).padStart(7) + s.avgSpeed.toFixed(1).padStart(10) + s.maxWait.toFixed(0).padStart(12));
    }
  }
  const tr = res.traffic;
  if (tr) {
    console.log(`\nroad traffic: ${tr.cars} through-traffic vehicles, avg ${tr.avgSpeed.toFixed(1)} m/s; ${tr.own} residents' cars drove ${(tr.ownDistance / 1000).toFixed(1)} km;`
      + ` longest wait ${tr.maxWait.toFixed(0)} s${tr.stuck ? `, ${tr.stuck} stuck` : ""}; level crossings closed ${tr.closures} times, ${(tr.closedShare * 100).toFixed(0)}% of the time`);
  }
  const pp = res.people;
  if (pp) {
    console.log(`people: ${pp.people} residents, ${pp.tasks} errands done, ${Object.values(pp.trips).reduce((a, b) => a + b, 0)} journeys (avg ${(pp.avgTrip / 60).toFixed(1)} min),`
      + ` longest wait ${pp.maxWait.toFixed(0)} s${pp.stuck ? `, ${pp.stuck} stuck` : ""}; ${pp.crossed} road crossings`);
    console.log(`  journeys by way of travel: ${Object.entries(pp.trips).map(([k, n]) => `${k} ${n}`).join("; ") || "none"}`);
    console.log(`  now: ${pp.outside} outside (${pp.walking} walking, ${pp.waiting} on platforms), ${pp.driving} driving, ${pp.riding} on trains`);
  }
  if (res.deadlock) console.log(`\nDEADLOCK: ${res.deadlock.message}`);
}
process.exit(res.report.ok && !res.deadlock ? 0 : 1);
