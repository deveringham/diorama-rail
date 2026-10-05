// HUD (§8.7): a small overlay in the bottom-left corner with layout name, sim
// time, fps and renderer stats, plus the list of controls and their current
// state. Shown by default; H hides it. Also a dismissible validation-issues panel.

import type { Issue } from "../model/validate";

const CSS = `
.dr-hud { position: fixed; left: 12px; bottom: 12px; padding: 9px 12px; border-radius: 8px;
  background: rgba(24, 26, 30, 0.66); color: #eef0f2; font: 12px/1.45 ui-monospace, Menlo, Consolas, monospace;
  pointer-events: none; display: none; }
.dr-hud.on { display: block; }
.dr-stats { white-space: pre; }
.dr-keys { display: grid; grid-template-columns: auto auto auto; column-gap: 12px; margin-top: 7px; padding-top: 7px;
  border-top: 1px solid rgba(255, 255, 255, 0.16); }
.dr-keys .k { color: #ffd9a0; }
.dr-keys .s { color: #9fb6c9; }
.dr-hint { position: fixed; left: 12px; bottom: 12px; padding: 3px 8px; border-radius: 6px; pointer-events: none;
  background: rgba(24, 26, 30, 0.4); color: #eef0f2; font: 11px ui-monospace, Menlo, Consolas, monospace; display: none; }
.dr-hint.on { display: block; }
.dr-issues { position: fixed; top: 56px; left: 12px; right: 12px; max-width: 760px; max-height: 60vh; overflow: auto;
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
  shadows: boolean;
  autoRotate: boolean;
  fps: number;
  calls: number;
  triangles: number;
  follow: { service: string; nextStop: string | null } | null;
};

/** Keys, what they do, and (optionally) the state to show next to them. */
const CONTROLS: Array<[keys: string, action: string, state?: (i: HudInfo) => string]> = [
  ["drag", "orbit (one finger)"],
  ["wheel", "zoom (pinch)"],
  ["right-drag", "pan (two fingers)"],
  ["click", "inspect a person, building, vehicle, train or yard (tap)"],
  ["Space", "pause / resume", (i) => (i.paused ? "paused" : "running")],
  ["1 2 3", "speed 1× 2× 4×", (i) => `${i.speed}×`],
  ["F", "follow next train", (i) => i.follow?.service ?? "off"],
  ["Esc", "stop following, close panel"],
  ["S", "shadows", (i) => (i.shadows ? "on" : "off")],
  ["R", "auto-rotate", (i) => (i.autoRotate ? "on" : "off")],
  ["H", "hide this panel"],
];

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
const clock = (h: number) => `${String(Math.floor(h) % 24).padStart(2, "0")}:${String(Math.floor((h % 1) * 60)).padStart(2, "0")}`;

export class Hud {
  private el = document.createElement("div");
  private stats = document.createElement("div");
  private states: Array<HTMLElement | null> = [];
  private hint = document.createElement("div");
  private issuesEl = document.createElement("div");
  private last = 0;
  visible: boolean;

  constructor(parent: HTMLElement, visible = true) {
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.append(style);
    this.el.className = "dr-hud";
    this.stats.className = "dr-stats";
    const keys = document.createElement("div");
    keys.className = "dr-keys";
    for (const [k, action, state] of CONTROLS) {
      keys.insertAdjacentHTML("beforeend", `<span class="k">${esc(k)}</span><span>${esc(action)}</span><span class="s"></span>`);
      this.states.push(state ? (keys.lastElementChild as HTMLElement) : null);
    }
    this.el.append(this.stats, keys);
    this.hint.className = "dr-hint";
    this.hint.textContent = "H or ?: show HUD & controls";
    this.issuesEl.className = "dr-issues";
    parent.append(this.el, this.hint, this.issuesEl);
    this.visible = !visible;
    this.toggle();
  }

  toggle(): void {
    this.visible = !this.visible;
    this.el.classList.toggle("on", this.visible);
    this.hint.classList.toggle("on", !this.visible);
    this.last = 0;
  }

  /** Hides the HUD and its hint entirely (screenshot mode). */
  hideAll(): void {
    this.visible = false;
    this.el.classList.remove("on");
    this.hint.classList.remove("on");
  }

  /** Updates the text at most 4 times a second. */
  update(info: HudInfo, now: number): void {
    if (!this.visible || now - this.last < 250) return;
    this.last = now;
    const m = Math.floor(info.time / 60);
    const lines = [
      info.name,
      `sim ${m}:${String(Math.floor(info.time % 60)).padStart(2, "0")}  ${clock(info.hour)}`,
      `${info.fps.toFixed(0)} fps  ${info.calls} calls  ${(info.triangles / 1000).toFixed(0)}k tris`,
    ];
    if (info.follow) lines.push(`following ${info.follow.service} → ${info.follow.nextStop ?? "—"}`);
    this.stats.textContent = lines.join("\n");
    CONTROLS.forEach(([, , state], i) => {
      const cell = this.states[i];
      if (cell && state) cell.textContent = state(info);
    });
  }

  /** Shows errors until dismissed; hides the panel when there are none. */
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
