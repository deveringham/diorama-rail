// Shared CLI helpers: read a layout file (turning bad JSON into a SCHEMA issue)
// and print issues in a compact human-readable form.

import { readFileSync } from "node:fs";
import type { Issue, Report } from "../model/validate";
import { error } from "../model/validate";

export function readLayout(file: string | undefined): { json: unknown; issue?: Issue } {
  if (!file) return { json: null, issue: error("SCHEMA", "no layout file given; usage: <command> layouts/x.json", "(root)") };
  try {
    return { json: JSON.parse(readFileSync(file, "utf8")) };
  } catch (err) {
    return { json: null, issue: error("SCHEMA", `cannot read ${file} as JSON: ${(err as Error).message}`, "(root)") };
  }
}

export function printIssues(file: string, report: Report): void {
  const errors = report.issues.filter((i) => i.severity === "error").length;
  const warnings = report.issues.length - errors;
  for (const i of report.issues) {
    const where = i.at ? ` @(${i.at[0]}, ${i.at[1]})` : "";
    console.log(`${i.severity === "error" ? "error  " : "warning"} ${i.code.padEnd(20)} ${i.path}${where}\n        ${i.message}`);
  }
  console.log(`${file}: ${errors} error(s), ${warnings} warning(s)${report.ok ? " — ok" : ""}`);
}
