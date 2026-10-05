// Browser entry: loads the layout named in the URL, builds world + sim + scene,
// runs the fixed-step loop, handles keys, HUD, graphics settings, hot reload and
// screenshot mode.
// URL: ?layout=valley-loop&seed=N&t=SECONDS&view=overview|top|follow&shot=1
//      &cam=x,y,z,tx,ty,tz (optional eye and target in model metres, for close-up shots)
//      &quality=low|medium|high (graphics preset for this visit; screenshots default to high)
//      &object=id[,id...]|* (preview scenery objects alone; &season=summer|autumn|winter)

import * as THREE from "three";
import * as api from "./api";
import type { World } from "./model/build";
import { Sim, DT, type SimSnapshot } from "./sim/sim";
import { buildScene, type DioramaScene } from "./scene/buildScene";
import { CameraRig } from "./scene/camera";
import { Hud } from "./scene/hud";
import { Toolbar } from "./scene/toolbar";
import { QualityMenu } from "./scene/qualityMenu";
import { PRESETS, DETAIL_PIXELS, STORAGE_KEY, initialQuality, lower, presetOf, sanitize, serialize, type Level, type Quality, type ShadowMode, type Stored } from "./scene/quality";
import { Inspector } from "./scene/inspect";
import { LIGHT, type Season } from "./scene/palette";
import { buildPreview } from "./scene/objectPreview";
import { LayoutSchema } from "./model/schema";
import { objectCatalog } from "./model/scenery";
import { type Issue, error, zodIssues } from "./model/validate";

const MAX_STEPS_PER_FRAME = 8;
const SPEEDS = { Digit1: 1, Digit2: 2, Digit3: 4 } as const;
const BASE_PIXEL_RATIO = Math.min(devicePixelRatio, 1.5);
const SHADOW_STEP = 0.05;         // hours of day between redraws of static shadows (the sun turns 15° an hour)
const AUTO_FPS = 40;              // Auto steps down while the frame rate stays below this
const AUTO_SETTLE = 2000;         // ms after a change (or the start) before measuring
const AUTO_WINDOW = 3000;         // ms per measurement; two slow ones in a row step down

declare global {
  interface Window {
    dr: unknown;
    __drReady?: boolean;
    __drError?: unknown;
    __drStats?: { calls: number; triangles: number };
  }
}

const params = new URLSearchParams(location.search);
const layoutName = params.get("layout") ?? "valley-loop";
const layoutUrl = /[/.]/.test(layoutName) ? layoutName : `layouts/${layoutName}.json`;
const shot = params.get("shot") === "1";
const view = params.get("view") ?? "overview";
const startAt = Number(params.get("t") ?? 0);
const cam = params.get("cam")?.split(",").map(Number);
const objectParam = params.get("object");

// Graphics settings: ?quality=, else what was chosen last time, else Auto. Screenshots draw at high.
let gfx: Stored = initialQuality(params.get("quality"), shot ? null : readStored());
if (shot) gfx.auto = false;
let antialiased = gfx.quality.antialias;     // what the current canvas was made with
let renderer = makeRenderer(antialiased);
if (gfx.auto && !readStored() && isSoftware(renderer)) gfx = { auto: true, quality: { ...PRESETS.low } };
document.body.append(renderer.domElement);

const rig = new CameraRig(renderer.domElement, innerWidth / innerHeight);
const hud = new Hud(document.body, innerWidth >= 700);   // on a phone the panel waits for the ? button
const inspector = new Inspector(document.body);
// Buttons for what the keys do, for visitors without a keyboard.
const toolbar = shot || objectParam ? null : new Toolbar(document.body, layoutName, {
  pause: () => { paused = !paused; },
  speed: () => { speed = speed === 1 ? 2 : speed === 2 ? 4 : 1; },
  follow: () => { rig.cycleFollow(snap.trains.length); follow = rig.follow ?? -1; },
  stopFollow: () => { rig.stopFollow(); follow = -1; },
  graphics: () => menu?.toggle(),
  help: () => hud.toggle(),
});
const menu = shot || objectParam ? null : new QualityMenu(document.body, gfx, (next) => setGraphics(next));
if (shot) {
  rig.controls.autoRotate = false;
  hud.hideAll();
}

let world: World | null = null;
let sim: Sim | null = null;
let dscene: DioramaScene | null = null;
const snap: SimSnapshot = { time: 0, trains: [], switches: [], blocks: [], vehicles: [], gates: [], signals: [], people: [], freight: { goods: [], yards: [], stock: [], trains: [] } };
let paused = false;
let speed = 1;
let follow = -1;            // followed train index, kept across hot reloads
let lastShadows: ShadowMode = gfx.quality.shadows === "off" ? "full" : gfx.quality.shadows;   // what S turns back on
let shadowsDirty = true;    // static shadows: redraw at the next frame
let shadowHour = NaN;       // the hour they were last drawn for

// --- graphics settings -------------------------------------------------------------
function readStored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;              // storage blocked: settings last for the visit
  }
}

function pixelRatio(q: Quality): number {
  return (shot ? 1 : BASE_PIXEL_RATIO) * q.resolution;
}

function makeRenderer(antialias: boolean): THREE.WebGLRenderer {
  const r = new THREE.WebGLRenderer({ antialias, powerPreference: "high-performance", preserveDrawingBuffer: shot });
  r.setPixelRatio(pixelRatio(gfx.quality));
  r.setSize(innerWidth, innerHeight);
  r.shadowMap.enabled = true;
  r.shadowMap.type = THREE.PCFShadowMap;
  r.toneMappingExposure = LIGHT.exposure;
  r.domElement.addEventListener("pointerdown", onPointerDown);
  r.domElement.addEventListener("pointerup", onPointerUp);
  return r;
}

/** A software rasteriser (no graphics chip, or a blocked one): start Auto at low. */
function isSoftware(r: THREE.WebGLRenderer): boolean {
  const gl = r.getContext();
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  const name = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  return /swiftshader|llvmpipe|software|basic render/i.test(name);
}

/** Antialiasing is fixed when a WebGL context is made: draw on a new canvas from now on. */
function swapRenderer(antialias: boolean): void {
  const old = renderer;
  renderer = makeRenderer(antialias);
  antialiased = antialias;
  old.domElement.replaceWith(renderer.domElement);
  rig.controls.connect(renderer.domElement);
  old.dispose();
  old.forceContextLoss();
  dscene?.lighting.dropShadowMap();        // made by the old context
  if (window.dr && typeof window.dr === "object") (window.dr as { renderer: THREE.WebGLRenderer }).renderer = renderer;
}

/** Puts the current settings into effect on the renderer and the scene. */
function applyGraphics(): void {
  const q = gfx.quality;
  if (q.antialias !== antialiased) swapRenderer(q.antialias);
  renderer.setPixelRatio(pixelRatio(q));
  renderer.shadowMap.autoUpdate = q.shadows === "full";
  if (q.shadows !== "off") lastShadows = q.shadows;
  shadowsDirty = true;
  if (dscene) {
    dscene.lighting.setShadows(q.shadows !== "off");
    dscene.lighting.setShadowSize(q.shadowSize);
    dscene.setMovingShadows(q.shadows === "full");
    dscene.setDetail(DETAIL_PIXELS[q.detail]);
  }
  menu?.sync(gfx);
}

function setGraphics(next: Stored): void {
  gfx = { auto: next.auto, quality: sanitize(next.quality) };
  applyGraphics();
  autoRestart();
  if (shot) return;
  try {
    localStorage.setItem(STORAGE_KEY, serialize(gfx));
  } catch {
    // Not stored; fine for this visit.
  }
}

// Auto: measure the frame rate in windows; after two slow ones in a row, the next preset down.
let autoFrom = 0;           // when the current window starts (after settling)
const autoFrames: number[] = [];
let autoSlow = 0;
function autoRestart(now = performance.now()): void {
  autoFrom = now + AUTO_SETTLE;
  autoFrames.length = 0;
  autoSlow = 0;
}
function autoTick(now: number, dt: number): void {
  if (!gfx.auto || shot || now < autoFrom) return;
  autoFrames.push(dt);
  if (now - autoFrom < AUTO_WINDOW) return;
  autoFrames.sort((a, b) => a - b);
  const fps = 1 / Math.max(autoFrames[autoFrames.length >> 1], 1e-3);
  autoFrames.length = 0;
  autoFrom = now;
  const target = gfx.quality.fpsCap ? gfx.quality.fpsCap * 0.85 : AUTO_FPS;
  if (fps >= target) { autoSlow = 0; return; }
  if (++autoSlow < 2) return;
  const next = lower(presetOf(gfx.quality));
  if (!next) return;
  setGraphics({ auto: true, quality: { ...PRESETS[next] } });
  menu?.notify(`About ${Math.round(fps)} fps, so graphics are now ${next}. The Graphics button changes that.`);
}

/** Loads the layout JSON. Errors carry a message written for the person reading the page. */
async function fetchLayout(): Promise<unknown> {
  const res = await fetch(layoutUrl, { cache: "no-store" });
  const text = await res.text();
  // A missing file is a 404 from our dev/preview server, or an HTML page from a
  // static host with an SPA fallback; either way, say which layouts do exist.
  if (!res.ok || /^\s*</.test(text)) throw new Error(await notFound());
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new Error(`${layoutUrl} is not valid JSON: ${(err as Error).message}`);
  }
  const seed = params.get("seed");
  if (seed !== null && json && typeof json === "object") (json as { seed?: number }).seed = Number(seed);
  return json;
}

async function notFound(): Promise<string> {
  let names: unknown = [];
  try {
    names = await (await fetch("layouts/index.json", { cache: "no-store" })).json();
  } catch {
    // No index available (e.g. a plain static host): just report the path.
  }
  if (!Array.isArray(names) || names.length === 0 || layoutUrl === layoutName) return `no layout file at ${layoutUrl}`;
  const guess = closest(layoutName, names.map(String));
  return `no layout named '${layoutName}' (looked for ${layoutUrl}); available: ${names.join(", ")}${guess ? `. Did you mean '${guess}'?` : ""}`;
}

/** The option within a few typing edits of `name` (harbor → harbour), if any. */
function closest(name: string, options: string[]): string | null {
  const edits = (a: string, b: string) => {
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[b.length];
  };
  const best = options.map((o) => ({ o, d: edits(name, o) })).sort((x, y) => x.d - y.d)[0];
  return best && best.d <= Math.max(2, name.length / 3) ? best.o : null;
}

const loadIssue = (err: unknown) =>
  ({ code: "LOAD", severity: "error" as const, message: err instanceof Error ? err.message : String(err), path: layoutUrl });

/** Build everything from JSON. On errors keep whatever is showing and list the issues. */
function rebuild(json: unknown, preStep: number): boolean {
  const { world: next, report } = api.buildWorld(json);
  hud.showIssues(report.issues);
  if (!next) {
    console.warn("layout has errors", report.issues);
    return false;
  }
  const first = world === null;
  const pose = first ? null : rig.getPose();
  dscene?.dispose();
  world = next;
  sim = new Sim(world);
  if (sim.unplaced.length) console.warn(`no room to place trains: ${sim.unplaced.join(", ")}`);
  for (let i = 0; i < Math.round(preStep / DT); i++) sim.step();
  snap.trains.length = 0;
  snap.vehicles.length = 0;
  snap.gates.length = 0;
  snap.people.length = 0;
  sim.snapshot(snap);
  dscene = buildScene(world, snap);
  applyGraphics();
  autoRestart();
  dscene.scene.add(inspector.marker);
  inspector.setWorld(world);
  rig.setWorld(world, first);
  if (pose) rig.setPose(pose);
  if (follow >= 0) rig.follow = Math.min(follow, snap.trains.length - 1);
  window.dr = {
    ...api, world, sim, scene: dscene.scene, view: dscene, renderer, camera: rig.camera, rig, inspector,
    /** The graphics settings now, and a way to change them: a preset name or some settings. */
    graphics: () => ({ ...gfx, preset: presetOf(gfx.quality) }),
    setGraphics: (q: Level | Partial<Quality>) =>
      setGraphics(typeof q === "string" ? { auto: false, quality: { ...PRESETS[q] } } : { auto: false, quality: { ...gfx.quality, ...q } }),
  };
  return true;
}

function hourNow(): number {
  if (!world || !sim) return 15;
  const { timeOfDay, dayLengthSeconds } = world.layout.style;
  return dayLengthSeconds ? timeOfDay + (sim.time / dayLengthSeconds) * 24 : timeOfDay;
}

// --- main loop ---------------------------------------------------------------------
let last = performance.now();
let acc = 0;
let fps = 60;               // frames drawn per second, counted over half a second or more
let fpsFrames = 0;
let fpsSince = performance.now();
function frame(now: number): void {
  if (!shot) requestAnimationFrame(frame);
  // With a cap, skip screen refreshes until the next frame is due.
  const cap = gfx.quality.fpsCap;
  if (cap && !shot && now - last < 1000 / cap - 3) return;
  const dt = Math.min((now - last) / 1000, 0.25);
  last = now;
  if (document.hidden || !sim || !dscene) return;
  const simDt = paused || shot ? 0 : dt * speed;
  acc += simDt;
  let steps = 0;
  while (acc >= DT && steps < MAX_STEPS_PER_FRAME) {
    sim.step();
    acc -= DT;
    steps++;
  }
  if (steps === MAX_STEPS_PER_FRAME) acc = 0;     // too slow to keep up: drop the backlog
  sim.events.length = 0;
  sim.snapshot(snap);
  const hour = hourNow();
  dscene.update(snap, simDt, hour);
  rig.update(dt, snap);
  dscene.view(rig.camera, renderer.domElement.height);
  // Static shadows are drawn once and again only as the sun moves on.
  if (gfx.quality.shadows === "static" && (shadowsDirty || Math.abs(hour - shadowHour) > SHADOW_STEP)) {
    renderer.shadowMap.needsUpdate = true;
    shadowHour = hour;
    shadowsDirty = false;
  }
  inspector.update(sim, snap, rig.camera, simDt, now);
  renderer.render(dscene.scene, rig.camera);
  fpsFrames++;
  if (now - fpsSince >= 500) {
    fps = (fpsFrames * 1000) / (now - fpsSince);
    fpsFrames = 0;
    fpsSince = now;
  }
  autoTick(now, dt);
  menu?.showLive(fps, renderer.info.render.triangles, now);
  const tr = rig.follow !== null ? snap.trains[rig.follow] : undefined;
  hud.update({
    name: world!.layout.name, time: sim.time, hour, speed, paused, shadows: gfx.quality.shadows,
    autoRotate: rig.controls.autoRotate, fps,
    calls: renderer.info.render.calls, triangles: renderer.info.render.triangles,
    follow: tr ? { service: tr.service, nextStop: tr.nextStop } : null,
  }, now);
  toolbar?.sync({ paused, speed, following: rig.follow !== null, graphics: menu?.open ?? false, help: hud.visible });
}

// --- input -------------------------------------------------------------------------
addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.code === "Space") { paused = !paused; e.preventDefault(); }
  else if (e.code in SPEEDS) speed = SPEEDS[e.code as keyof typeof SPEEDS];
  else if (e.code === "KeyF") { rig.cycleFollow(snap.trains.length); follow = rig.follow ?? -1; }
  else if (e.code === "Escape") { rig.stopFollow(); follow = -1; inspector.select(null); }
  else if (e.code === "KeyS") setGraphics({ auto: false, quality: { ...gfx.quality, shadows: gfx.quality.shadows === "off" ? lastShadows : "off" } });
  else if (e.code === "KeyG") menu?.toggle();
  else if (e.code === "KeyH") hud.toggle();
  else if (e.code === "KeyR") rig.controls.autoRotate = !rig.controls.autoRotate;
});
// --- click to inspect (a click, not the end of a drag); bound to each canvas in makeRenderer ---
let press: { x: number; y: number; t: number } | null = null;
function onPointerDown(e: PointerEvent): void {
  press = { x: e.clientX, y: e.clientY, t: performance.now() };
}
function onPointerUp(e: PointerEvent): void {
  if (!press || !dscene || e.button !== 0) return;
  const moved = Math.hypot(e.clientX - press.x, e.clientY - press.y);
  const quick = performance.now() - press.t < 400;
  press = null;
  if (moved > 5 || !quick) return;
  const rect = renderer.domElement.getBoundingClientRect();
  inspector.select(inspector.pick(e.clientX - rect.left, e.clientY - rect.top, renderer.domElement, rig.camera, snap, dscene.scene));
}
addEventListener("resize", () => {
  renderer.setSize(innerWidth, innerHeight);
  rig.resize(innerWidth / innerHeight);
});

// --- hot reload: the vite plugin announces layout file changes ---------------------
if (import.meta.hot) {
  import.meta.hot.on("dr:layout", async (data: { file: string }) => {
    if (!layoutUrl.endsWith(data.file.replace(/\\/g, "/"))) return;
    try {
      rebuild(await fetchLayout(), sim?.time ?? 0);
    } catch (err) {
      hud.showIssues([loadIssue(err)]);     // e.g. a half-saved file; keep the current scene
    }
  });
}

// --- start -------------------------------------------------------------------------
async function start(): Promise<void> {
  try {
    const ok = rebuild(await fetchLayout(), startAt);
    if (!ok) {
      window.__drError = (window.dr = api.validate(await fetchLayout()));
      window.__drReady = shot;
      return;
    }
  } catch (err) {
    const issue = loadIssue(err);
    hud.showIssues([issue]);
    window.__drError = issue.message;
    window.__drReady = shot;
    return;
  }
  if (shot) {
    if (view === "top") rig.top(world!);
    if (view === "follow") rig.cycleFollow(snap.trains.length);
    if (cam?.length === 6 && cam.every(Number.isFinite)) rig.lookFrom(cam);
    rig.update(0, snap, true);
    // Two frames so shadow maps and instance buffers are settled before the capture.
    frame(performance.now());
    frame(performance.now());
    window.__drStats = { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
    requestAnimationFrame(() => { window.__drReady = true; });
  } else {
    requestAnimationFrame(frame);
  }
}
// --- object preview ------------------------------------------------------------
const LABEL_CSS = "position:fixed;transform:translate(-50%,-100%);padding:1px 6px;border-radius:4px;"
  + "background:rgba(24,26,30,.7);color:#eef0f2;font:12px ui-monospace,Menlo,Consolas,monospace;pointer-events:none;white-space:nowrap";

function failPreview(issues: Issue[]): void {
  hud.showIssues(issues);
  window.__drError = issues.map((i) => `${i.code} ${i.path}: ${i.message}`).join("\n");
  window.__drReady = shot;
}

/** Renders scenery objects alone: the layout's own objects plus the built-in library. */
async function startPreview(which: string): Promise<void> {
  hud.hideAll();
  let json: Record<string, unknown> = {};
  try {
    json = (await fetchLayout()) as Record<string, unknown>;
  } catch {
    // No layout: built-in objects only.
  }
  const parsed = LayoutSchema.shape.objects.safeParse(json.objects ?? {});
  if (!parsed.success) return failPreview(zodIssues(parsed.error, ["objects"]));
  const style = (json.style ?? {}) as { season?: string };
  const season = (params.get("season") ?? style.season ?? "summer") as Season;
  if (!["summer", "autumn", "winter"].includes(season)) return failPreview([error("SCHEMA", `unknown season '${season}'`, "season")]);
  const objects = objectCatalog(parsed.data, season);
  const ids = which === "*" ? [...objects.keys()].sort() : which.split(",").map((id) => id.trim());
  const missing = ids.find((id) => !objects.has(id));
  if (missing) return failPreview([error("UNKNOWN_REF", `unknown object '${missing}'; known: ${[...objects.keys()].sort().join(", ")}`, "object")]);

  const preview = buildPreview(objects, ids, season);
  rig.controls.target.copy(preview.frame(rig.camera));
  rig.controls.autoRotate = !shot;
  rig.controls.update();
  const labels = preview.labels.map((l) => {
    const el = document.createElement("div");
    el.textContent = l.id;
    el.style.cssText = LABEL_CSS;
    document.body.append(el);
    return { el, at: l.at };
  });
  const v = new THREE.Vector3();
  const draw = () => {
    rig.controls.update();
    renderer.render(preview.scene, rig.camera);
    for (const l of labels) {
      v.copy(l.at).project(rig.camera);
      l.el.style.left = `${((v.x + 1) / 2) * innerWidth}px`;
      l.el.style.top = `${((1 - v.y) / 2) * innerHeight}px`;
      l.el.style.display = ids.length > 1 && v.z < 1 ? "block" : "none";
    }
  };
  if (shot) {
    draw();
    draw();
    window.__drStats = { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
    requestAnimationFrame(() => { window.__drReady = true; });
  } else {
    const loop = () => { requestAnimationFrame(loop); draw(); };
    loop();
  }
}

void (objectParam ? startPreview(objectParam) : start());
