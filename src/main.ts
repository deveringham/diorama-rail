// Browser entry: loads the layout named in the URL, builds world + sim + scene,
// runs the fixed-step loop, handles keys, HUD, hot reload and screenshot mode.
// URL: ?layout=valley-loop&seed=N&t=SECONDS&view=overview|top|follow&shot=1
//      &cam=x,y,z,tx,ty,tz (optional eye and target in model metres, for close-up shots)

import * as THREE from "three";
import * as api from "./api";
import type { World } from "./model/build";
import { Sim, DT, type SimSnapshot } from "./sim/sim";
import { buildScene, type DioramaScene } from "./scene/buildScene";
import { CameraRig } from "./scene/camera";
import { Hud } from "./scene/hud";
import { LIGHT } from "./scene/palette";

const MAX_STEPS_PER_FRAME = 8;
const SPEEDS = { Digit1: 1, Digit2: 2, Digit3: 4 } as const;

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

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance", preserveDrawingBuffer: shot });
renderer.setPixelRatio(shot ? 1 : Math.min(devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMappingExposure = LIGHT.exposure;
document.body.append(renderer.domElement);

const rig = new CameraRig(renderer.domElement, innerWidth / innerHeight);
const hud = new Hud(document.body);
if (shot) {
  rig.controls.autoRotate = false;
  hud.hideAll();
}

let world: World | null = null;
let sim: Sim | null = null;
let dscene: DioramaScene | null = null;
const snap: SimSnapshot = { time: 0, trains: [], switches: [], blocks: [] };
let paused = false;
let speed = 1;
let shadows = true;
let follow = -1;            // followed train index, kept across hot reloads

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
  sim.snapshot(snap);
  dscene = buildScene(world, snap);
  dscene.lighting.setShadows(shadows);
  rig.setWorld(world, first);
  if (pose) rig.setPose(pose);
  if (follow >= 0) rig.follow = Math.min(follow, snap.trains.length - 1);
  window.dr = { ...api, world, sim, scene: dscene.scene, renderer };
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
let fps = 60;
function frame(now: number): void {
  if (!shot) requestAnimationFrame(frame);
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
  dscene.update(snap, simDt, hourNow());
  rig.update(dt, snap);
  renderer.render(dscene.scene, rig.camera);
  fps += (1 / Math.max(dt, 1e-3) - fps) * 0.05;
  const tr = rig.follow !== null ? snap.trains[rig.follow] : undefined;
  hud.update({
    name: world!.layout.name, time: sim.time, hour: hourNow(), speed, paused, shadows,
    autoRotate: rig.controls.autoRotate, fps,
    calls: renderer.info.render.calls, triangles: renderer.info.render.triangles,
    follow: tr ? { service: tr.service, nextStop: tr.nextStop } : null,
  }, now);
}

// --- input -------------------------------------------------------------------------
addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.code === "Space") { paused = !paused; e.preventDefault(); }
  else if (e.code in SPEEDS) speed = SPEEDS[e.code as keyof typeof SPEEDS];
  else if (e.code === "KeyF") { rig.cycleFollow(snap.trains.length); follow = rig.follow ?? -1; }
  else if (e.code === "Escape") { rig.stopFollow(); follow = -1; }
  else if (e.code === "KeyS") { shadows = !shadows; dscene?.lighting.setShadows(shadows); }
  else if (e.code === "KeyH") hud.toggle();
  else if (e.code === "KeyR") rig.controls.autoRotate = !rig.controls.autoRotate;
});
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
void start();
