// npm run check -- layouts/x.json [--json]
// Validates a layout. Prints issues (or the raw Report with --json); exit 1 on errors.

import { parseArgs } from "node:util";
import { validate } from "../model/build";
import { makeReport } from "../model/validate";
import { readLayout, printIssues } from "./io";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { json: { type: "boolean", default: false } } });
const file = positionals[0];
const { json, issue } = readLayout(file);
const report = issue ? makeReport([issue]) : validate(json);
if (values.json) console.log(JSON.stringify(report, null, 2));
else {
  printIssues(file ?? "(none)", report);
  if (report.ok) console.log(Object.entries(report.stats).map(([k, v]) => `${k}=${v}`).join(" "));
}
process.exit(report.ok ? 0 : 1);
