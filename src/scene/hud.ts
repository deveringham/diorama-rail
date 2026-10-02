// HUD (§8.7): a small overlay in the bottom-left corner (hidden by default)
// with layout name, sim time, fps and renderer stats, plus a dismissible panel
// that lists validation issues.

import type { Issue } from "../model/validate";

const CSS = `
.dr-hud { position: fixed; left: 12px; bottom: 12px; padding: 8px 11px; border-radius: 8px;
  background: rgba(24, 26, 30, 0.62); color: #eef0f2; font: 12px/1.45 ui-monospace, Menlo, Consolas, monospace;
  pointer-events: none; white-space: pre; display: none; }
.dr-hud.on { display: block; }
.dr-issues { position: fixed; top: 12px; left: 12px; right: 12px; max-width: 760px; max-height: 60vh; overflow: auto;
  padding: 12px 14px; border-radius: 10px; background: rgba(40, 16, 16, 0.9); color: #fbeaea;
  font: 13px/1.5 system-ui, sans-serif; display: none; }
.dr-issues.on { display: block; }
.dr-issues button { float: right; border: 0; border-radius: 6px; padding: 3px 9px; cursor: pointer; }
.dr-issues code { color: #ffd2a8; }
.dr-issues li { margin: 4px 0; }
`;

export type HudInfo = {
  name: string;
  time: number;              // simulated seconds
  hour: number;
  speed: number;             // time scale
  paused: boolean;
  fps: number;
  calls: number;
  triangles: number;
  follow: { service: string; nextStop: string | null } | null;
};

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
const clock = (h: number) => `${String(Math.floor(h) % 24).padStart(2, "0")}:${String(Math.floor((h % 1) * 60)).padStart(2, "0")}`;

export class Hud {
  private el = document.createElement("div");
  private issuesEl = document.createElement("div");
  private last = 0;
  visible = false;

  constructor(parent: HTMLElement) {
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.append(style);
    this.el.className = "dr-hud";
    this.issuesEl.className = "dr-issues";
    parent.append(this.el, this.issuesEl);
  }

  toggle(): void {
    this.visible = !this.visible;
    this.el.classList.toggle("on", this.visible);
  }

  /** Updates the text at most 4 times a second. */
  update(info: HudInfo, now: number): void {
    if (!this.visible || now - this.last < 250) return;
    this.last = now;
    const m = Math.floor(info.time / 60);
    const lines = [
      info.name,
      `sim ${m}:${String(Math.floor(info.time % 60)).padStart(2, "0")}  ${clock(info.hour)}  ${info.paused ? "paused" : `${info.speed}×`}`,
      `${info.fps.toFixed(0)} fps  ${info.calls} calls  ${(info.triangles / 1000).toFixed(0)}k tris`,
    ];
    if (info.follow) lines.push(`following ${info.follow.service} → ${info.follow.nextStop ?? "—"}`);
    this.el.textContent = lines.join("\n");
  }

  /** Shows errors (and warnings) until dismissed; hides the panel when there are none. */
  showIssues(issues: Issue[]): void {
    const list = issues.filter((i) => i.severity === "error");
    if (!list.length) {
      this.issuesEl.classList.remove("on");
      return;
    }
    this.issuesEl.innerHTML = `<button type="button">dismiss</button><strong>Layout has ${list.length} error${list.length > 1 ? "s" : ""}</strong><ul>${list
      .map((i) => `<li><code>${esc(i.code)}</code> <code>${esc(i.path)}</code> ${esc(i.message)}</li>`)
      .join("")}</ul>`;
    this.issuesEl.querySelector("button")!.onclick = () => this.issuesEl.classList.remove("on");
    this.issuesEl.classList.add("on");
  }
}
