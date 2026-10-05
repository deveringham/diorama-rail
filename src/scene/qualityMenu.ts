// Graphics menu: a panel under the toolbar to pick a quality preset (or Auto, which
// steps down while the frame rate stays low) or set each setting on its own, with the
// frame rate and triangle count alongside so the effect shows straight away.

import { PRESETS, presetOf, type Level, type Quality, type Stored } from "./quality";

const CSS = `
.dr-gfx { position: fixed; z-index: 2; top: 56px; left: 10px; width: 350px; max-width: calc(100vw - 20px); max-height: calc(100vh - 70px);
  overflow: auto; box-sizing: border-box; padding: 12px 14px 10px; border-radius: 10px; background: rgba(24, 26, 30, 0.92);
  color: #eef0f2; font: 13px/1.35 system-ui, sans-serif; display: none; }
.dr-gfx.on { display: block; }
.dr-gfx h2 { margin: 0 0 8px; font-size: 14px; font-weight: 600; display: flex; align-items: baseline; gap: 8px; }
.dr-gfx h2 .live { margin-left: auto; font: 12px ui-monospace, Menlo, Consolas, monospace; color: #9fb6c9; font-weight: 400; }
.dr-gfx h2 button { border: 0; background: none; color: #eef0f2; font-size: 18px; line-height: 1; cursor: pointer; padding: 0 2px; }
.dr-gfx .row { display: grid; grid-template-columns: 100px 1fr; align-items: center; gap: 8px; margin: 7px 0; }
.dr-gfx .row.preset { padding-bottom: 9px; margin-bottom: 9px; border-bottom: 1px solid rgba(255, 255, 255, 0.14); }
.dr-gfx .seg { display: flex; gap: 3px; }
.dr-gfx .seg button { flex: 1; min-width: 0; height: 28px; padding: 0 4px; border: 0; border-radius: 6px; cursor: pointer;
  background: rgba(255, 255, 255, 0.09); color: #eef0f2; font: inherit; font-size: 12px; white-space: nowrap; }
.dr-gfx .seg button:hover { background: rgba(255, 255, 255, 0.18); }
.dr-gfx .seg button[aria-pressed="true"] { background: #2f6f9f; }
.dr-gfx .seg button:disabled { opacity: 0.4; cursor: default; }
.dr-gfx .note { margin: 8px 0 0; color: #b8c2cc; font-size: 12px; }
.dr-gfx-toast { position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%); max-width: calc(100vw - 40px); width: max-content;
  padding: 8px 14px; border-radius: 10px; background: rgba(24, 26, 30, 0.82); color: #eef0f2; font: 13px/1.4 system-ui, sans-serif;
  pointer-events: none; opacity: 0; transition: opacity 0.5s; }
.dr-gfx-toast.on { opacity: 1; }
`;

type Choice<T> = { label: string; value: T; tip?: string };
type Row<K extends keyof Quality> = { key: K; label: string; tip: string; choices: Array<Choice<Quality[K]>> };

const ROWS: Array<Row<keyof Quality>> = [
  { key: "resolution", label: "Resolution", tip: "Pixels drawn, relative to the screen's own: fewer is faster on a weak graphics chip",
    choices: [{ label: "50%", value: 0.5 }, { label: "75%", value: 0.75 }, { label: "100%", value: 1 }] },
  { key: "antialias", label: "Smooth edges", tip: "Antialiasing (multisampling); switching it restarts the renderer",
    choices: [{ label: "Off", value: false }, { label: "On", value: true }] },
  { key: "shadows", label: "Shadows", tip: "Static: buildings, trees and bridges only, redrawn now and then as the sun moves",
    choices: [{ label: "Off", value: "off" }, { label: "Static", value: "static" }, { label: "Full", value: "full" }] },
  { key: "shadowSize", label: "Shadow detail", tip: "Shadow map size: 1024, 2048 or 4096 px",
    choices: [{ label: "Low", value: 1024 }, { label: "Medium", value: 2048 }, { label: "High", value: 4096 }] },
  { key: "detail", label: "Small things", tip: "How far away lamp posts, benches, windows, sleepers and people are still drawn",
    choices: [{ label: "Near", value: "low" }, { label: "Mid", value: "medium" }, { label: "All", value: "high" }] },
  { key: "fpsCap", label: "Frame rate", tip: "A cap keeps the frame rate steady and the fan quiet",
    choices: [{ label: "Unlimited", value: 0 }, { label: "30 fps", value: 30 }] },
] as Array<Row<keyof Quality>>;

const PRESET_CHOICES: Array<Choice<Level | "auto">> = [
  { label: "Auto", value: "auto", tip: "Starts high and steps down while the frame rate stays below 40 fps" },
  { label: "Low", value: "low" },
  { label: "Medium", value: "medium" },
  { label: "High", value: "high" },
];

export class QualityMenu {
  readonly el = document.createElement("div");
  private live = document.createElement("span");
  private note = document.createElement("p");
  private toast = document.createElement("div");
  private buttons: Array<{ b: HTMLButtonElement; pressed: (s: Stored) => boolean; disabled?: (s: Stored) => boolean }> = [];
  private state: Stored;
  private lastLive = 0;
  private toastTimer = 0;

  constructor(parent: HTMLElement, state: Stored, private onChange: (s: Stored) => void) {
    this.state = state;
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.append(style);
    this.el.className = "dr-gfx";
    this.el.setAttribute("role", "dialog");
    this.el.setAttribute("aria-label", "Graphics settings");
    const h = document.createElement("h2");
    h.textContent = "Graphics";
    this.live.className = "live";
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "×";
    close.title = "Close (G)";
    close.setAttribute("aria-label", "Close");
    close.onclick = () => this.toggle(false);
    h.append(this.live, close);
    this.el.append(h);

    this.el.append(this.row("Preset", "A set of everything below", PRESET_CHOICES.map((c) => ({
      ...c,
      pressed: (s: Stored) => (c.value === "auto" ? s.auto : !s.auto && presetOf(s.quality) === c.value),
      pick: () => this.change(c.value === "auto" ? { auto: true, quality: this.state.quality } : { auto: false, quality: { ...PRESETS[c.value] } }),
    })), true));
    for (const r of ROWS) {
      this.el.append(this.row(r.label, r.tip, r.choices.map((c) => ({
        ...c,
        pressed: (s: Stored) => s.quality[r.key] === c.value,
        disabled: r.key === "shadowSize" ? (s: Stored) => s.quality.shadows === "off" : undefined,
        pick: () => this.change({ auto: false, quality: { ...this.state.quality, [r.key]: c.value } }),
      }))));
    }
    this.note.className = "note";
    this.el.append(this.note);
    this.toast.className = "dr-gfx-toast";
    this.toast.setAttribute("role", "status");
    parent.append(this.el, this.toast);
    this.sync(state);
  }

  get open(): boolean {
    return this.el.classList.contains("on");
  }

  toggle(on = !this.open): void {
    // Just under the toolbar, which wraps onto a second row on a narrow screen.
    const bar = document.querySelector(".dr-bar");
    if (on && bar) this.el.style.top = `${Math.round(bar.getBoundingClientRect().bottom + 8)}px`;
    this.el.classList.toggle("on", on);
  }

  /** Shows these settings as chosen. */
  sync(s: Stored): void {
    this.state = s;
    for (const { b, pressed, disabled } of this.buttons) {
      b.setAttribute("aria-pressed", String(pressed(s)));
      b.disabled = disabled?.(s) ?? false;
    }
    const p = presetOf(s.quality);
    this.note.textContent = s.auto
      ? `Auto: now ${p === "custom" ? "custom" : p}; it steps down if the frame rate stays below 40 fps.`
      : p === "custom" ? "Custom settings." : "";
  }

  /** Frame rate and triangles, a few times a second while open. */
  showLive(fps: number, triangles: number, now: number): void {
    if (!this.open || now - this.lastLive < 300) return;
    this.lastLive = now;
    this.live.textContent = `${fps.toFixed(fps < 10 ? 1 : 0)} fps · ${(triangles / 1000).toFixed(0)}k tris`;
  }

  /** A short message at the bottom of the screen. */
  notify(text: string): void {
    this.toast.textContent = text;
    this.toast.classList.add("on");
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toast.classList.remove("on"), 6000);
  }

  private change(s: Stored): void {
    this.sync(s);
    this.onChange(s);
  }

  private row(label: string, tip: string, choices: Array<{ label: string; tip?: string; pressed: (s: Stored) => boolean;
    disabled?: (s: Stored) => boolean; pick: () => void }>, preset = false): HTMLElement {
    const row = document.createElement("div");
    row.className = preset ? "row preset" : "row";
    const name = document.createElement("span");
    name.textContent = label;
    name.title = tip;
    const seg = document.createElement("div");
    seg.className = "seg";
    seg.setAttribute("role", "group");
    seg.setAttribute("aria-label", label);
    for (const c of choices) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = c.label;
      b.title = c.tip ?? tip;
      b.onclick = () => { c.pick(); b.blur(); };
      seg.append(b);
      this.buttons.push({ b, pressed: c.pressed, disabled: c.disabled });
    }
    row.append(name, seg);
    return row;
  }
}
