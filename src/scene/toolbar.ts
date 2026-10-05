// Toolbar: buttons in the top-left corner for everything the keys do that a visitor
// needs (no keyboard on a phone or tablet): which layout to show, pause, speed,
// follow a train, and the controls panel. Plus a short note on how to look around,
// shown until the first touch or click.

const CSS = `
.dr-bar { position: fixed; top: 10px; left: 10px; display: flex; flex-wrap: wrap; gap: 6px;
  max-width: calc(100vw - 20px); font: 14px/1 system-ui, sans-serif; }
.dr-bar button, .dr-bar select { height: 36px; min-width: 36px; padding: 0 12px; border: 0; border-radius: 8px; cursor: pointer;
  background: rgba(24, 26, 30, 0.72); color: #eef0f2; font: inherit; }
.dr-bar button:hover, .dr-bar select:hover { background: rgba(24, 26, 30, 0.88); }
.dr-bar button[aria-pressed="true"] { background: #2f6f9f; }
.dr-bar select { padding-right: 8px; }
.dr-welcome { position: fixed; left: 50%; top: 58px; transform: translateX(-50%); width: max-content; max-width: calc(100vw - 40px);
  padding: 9px 16px; border-radius: 10px; background: rgba(24, 26, 30, 0.72); color: #eef0f2; text-align: center;
  font: 14px/1.4 system-ui, sans-serif; pointer-events: none; transition: opacity 0.6s; }
.dr-welcome.gone { opacity: 0; }
@media (max-width: 640px) { .dr-welcome { top: 102px; } }
`;

export type ToolbarActions = {
  pause(): void;
  speed(): void;
  follow(): void;
  stopFollow(): void;
  help(): void;
};

export type ToolbarState = { paused: boolean; speed: number; following: boolean; help: boolean };

/** "harbour-town" → "Harbour Town". */
const title = (name: string) => name.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

export class Toolbar {
  private bar = document.createElement("div");
  private pauseBtn = document.createElement("button");
  private speedBtn = document.createElement("button");
  private followBtn = document.createElement("button");
  private stopBtn = document.createElement("button");
  private helpBtn = document.createElement("button");
  private welcome = document.createElement("div");
  private shown = "";

  constructor(parent: HTMLElement, layout: string, act: ToolbarActions) {
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.append(style);
    this.bar.className = "dr-bar";
    const pick = document.createElement("select");
    pick.title = "Choose a layout";
    pick.setAttribute("aria-label", "Layout");
    pick.append(new Option(title(layout), layout, true, true));
    pick.onchange = () => { location.search = new URLSearchParams({ layout: pick.value }).toString(); };
    // The other layouts the site has, once their list arrives.
    fetch("layouts/index.json").then((r) => r.json()).then((names: unknown) => {
      if (!Array.isArray(names)) return;
      for (const n of names.map(String)) if (n !== layout && !n.startsWith("_")) pick.append(new Option(title(n), n));
    }).catch(() => { /* a single layout it is */ });
    const button = (b: HTMLButtonElement, label: string, tip: string, onClick: () => void) => {
      b.type = "button";
      b.textContent = label;
      b.title = tip;
      b.onclick = () => { onClick(); b.blur(); };
    };
    button(this.pauseBtn, "Pause", "Pause or resume (Space)", act.pause);
    button(this.speedBtn, "1×", "Speed: 1×, 2× or 4× (1 2 3)", act.speed);
    button(this.followBtn, "Follow a train", "Ride along with a train; again for the next one (F)", act.follow);
    button(this.stopBtn, "Stop following", "Back to looking around freely (Esc)", act.stopFollow);
    button(this.helpBtn, "?", "Show or hide the controls (H)", act.help);
    this.helpBtn.setAttribute("aria-label", "Controls");
    this.bar.append(pick, this.pauseBtn, this.speedBtn, this.followBtn, this.stopBtn, this.helpBtn);
    this.welcome.className = "dr-welcome";
    this.welcome.textContent = "Drag to look around, scroll or pinch to zoom, and click or tap anything to see what it is doing.";
    parent.append(this.bar, this.welcome);
    // Gone after the first touch or click, or after a while.
    const hide = () => this.welcome.classList.add("gone");
    addEventListener("pointerdown", hide, { once: true });
    setTimeout(hide, 12000);
  }

  /** Shows the current state on the buttons (cheap to call every frame). */
  sync(s: ToolbarState): void {
    const key = `${s.paused}|${s.speed}|${s.following}|${s.help}`;
    if (key === this.shown) return;
    this.shown = key;
    this.pauseBtn.textContent = s.paused ? "Play" : "Pause";
    this.pauseBtn.setAttribute("aria-pressed", String(s.paused));
    this.speedBtn.textContent = `${s.speed}×`;
    this.followBtn.textContent = s.following ? "Next train" : "Follow a train";
    this.stopBtn.style.display = s.following ? "" : "none";
    this.helpBtn.setAttribute("aria-pressed", String(s.help));
  }
}
