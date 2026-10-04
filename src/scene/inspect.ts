// Click to inspect: picks the person, vehicle, train, bus stop or building under
// the pointer (people, vehicles and stops by screen distance, since they are small;
// buildings by ray), shows a live panel describing it (names in it can be clicked in
// turn), and floats a marker over it — over the building someone is inside, the car
// they drive or the train or bus they ride.

import * as THREE from "three";
import type { World } from "../model/build";
import type { Sim, SimSnapshot } from "../sim/sim";
import { type Info, type Ref, describePerson, describeBuilding, describeVehicle, describeTrain, describeBusStop } from "../sim/describe";
import { toThree } from "./geo";

export type Selection = { kind: "person" | "building" | "vehicle" | "train" | "stop"; id: number };
const KINDS = ["person", "building", "vehicle", "train", "stop"] as const;

const PERSON_PX = 12;           // px from a person's middle that still picks them
const VEHICLE_PX = 16;
const TRAIN_PX = 26;
const STOP_PX = 14;
const MARKER_COLOR = 0xff8a1f;
const MAX_ITEMS = 40;

const CSS = `
.dr-info { position: fixed; top: 12px; right: 12px; width: 300px; max-height: calc(100vh - 24px); overflow: auto;
  padding: 10px 12px; border-radius: 8px; background: rgba(24, 26, 30, 0.82); color: #eef0f2;
  font: 12px/1.45 system-ui, sans-serif; display: none; }
.dr-info.on { display: block; }
.dr-info h3 { margin: 0 18px 1px 0; font-size: 14px; }
.dr-info .sub { color: #9fb6c9; margin-bottom: 6px; }
.dr-info table { border-collapse: collapse; width: 100%; }
.dr-info td { vertical-align: top; padding: 1px 0; }
.dr-info td.k { color: #ffd9a0; padding-right: 8px; white-space: nowrap; }
.dr-info .list { margin-top: 7px; padding-top: 6px; border-top: 1px solid rgba(255, 255, 255, 0.16); }
.dr-info .list b { display: block; color: #ffd9a0; font-weight: 600; margin-bottom: 2px; }
.dr-info a { color: #cfe6ff; cursor: pointer; text-decoration: underline dotted; }
.dr-info button { position: absolute; top: 6px; right: 8px; border: 0; background: none; color: #eef0f2; font-size: 16px; cursor: pointer; }
`;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export class Inspector {
  readonly marker: THREE.Mesh;
  selection: Selection | null = null;
  private panel = document.createElement("div");
  private body = document.createElement("div");
  private last = 0;
  private v = new THREE.Vector3();
  private ray = new THREE.Raycaster();
  private buildingOf = new Map<number, number>();     // placement -> building
  private world: World | null = null;
  private html = "";
  private time = 0;

  constructor(parent: HTMLElement) {
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.append(style);
    this.panel.className = "dr-info";
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "×";
    close.title = "close (Esc)";
    close.onclick = () => this.select(null);
    this.panel.append(close, this.body);
    this.body.addEventListener("click", (e) => {
      const a = (e.target as HTMLElement).closest("a");
      if (!a) return;
      for (const kind of KINDS) {
        const id = a.dataset[kind];
        if (id !== undefined) { this.select({ kind, id: Number(id) }); return; }
      }
    });
    parent.append(this.panel);
    const geo = new THREE.ConeGeometry(0.9, 2.2, 4);
    geo.rotateX(Math.PI);                                 // pointing down
    this.marker = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: MARKER_COLOR }));
    this.marker.name = "selection-marker";
    this.marker.visible = false;
  }

  /** A new world (after a reload): forget what pointed into the old one. */
  setWorld(world: World): void {
    this.world = world;
    this.buildingOf.clear();
    for (const b of world.town.buildings) this.buildingOf.set(b.placement, b.id);
    if (this.selection && !this.exists(this.selection)) this.select(null);
  }

  private exists(s: Selection): boolean {
    const w = this.world!;
    return s.kind === "person" ? s.id < w.town.people.length : s.kind === "building" ? s.id < w.town.buildings.length
      : s.kind === "stop" ? s.id < w.buses.stops.length : true;
  }

  select(sel: Selection | null): void {
    this.selection = sel;
    this.panel.classList.toggle("on", sel !== null);
    this.marker.visible = sel !== null;
    this.last = 0;
  }

  /** What is under screen point (x, y) in CSS pixels, or null. */
  pick(x: number, y: number, dom: HTMLElement, camera: THREE.Camera, snap: SimSnapshot, scene: THREE.Object3D): Selection | null {
    const w = dom.clientWidth;
    const h = dom.clientHeight;
    const screen = (mx: number, my: number, mz: number) => {
      this.v.copy(toThree(mx, my, mz, this.v)).project(camera);
      return { d: Math.hypot(((this.v.x + 1) / 2) * w - x, ((1 - this.v.y) / 2) * h - y), front: this.v.z < 1 };
    };
    let best: { sel: Selection; d: number } | null = null;
    const consider = (sel: Selection, d: number, within: number) => {
      if (d <= within && (!best || d / within < best.d)) best = { sel, d: d / within };
    };
    snap.people.forEach((p, i) => {
      if (!p.visible) return;
      const s = screen(p.x, p.y, p.z + 0.9);
      if (s.front) consider({ kind: "person", id: i }, s.d, PERSON_PX);
    });
    snap.vehicles.forEach((v, i) => {
      if (!v.visible) return;
      const s = screen(v.x, v.y, v.z + 0.8);
      if (s.front) consider({ kind: "vehicle", id: i }, s.d, VEHICLE_PX);
    });
    snap.trains.forEach((t, i) => {
      for (const c of t.cars) {
        if (!c.visible) continue;
        const s = screen(c.x, c.y, c.z + 2);
        if (s.front) consider({ kind: "train", id: i }, s.d, TRAIN_PX);
      }
    });
    for (const side of this.world?.buses.sides ?? []) {
      const s = screen(side.sign[0], side.sign[1], side.sign[2] + 2.4);
      if (s.front) consider({ kind: "stop", id: side.stop }, s.d, STOP_PX);
    }
    if (best) return (best as { sel: Selection }).sel;
    // Buildings: the nearest one the ray hits.
    this.ray.setFromCamera(new THREE.Vector2((x / w) * 2 - 1, -(y / h) * 2 + 1), camera);
    const targets: THREE.Object3D[] = [];
    scene.traverse((o) => { if (o instanceof THREE.InstancedMesh && o.userData.placements) targets.push(o); });
    for (const hit of this.ray.intersectObjects(targets, false)) {
      if (hit.instanceId === undefined) continue;
      const placement = (hit.object.userData.placements as number[])[hit.instanceId];
      const b = this.buildingOf.get(placement);
      if (b !== undefined) return { kind: "building", id: b };
      if (hit.distance > 0) break;                        // something else (a tree) is in front
    }
    return null;
  }

  /** Per frame: keep the marker over the selection; refresh the panel a few times a second. */
  update(sim: Sim, snap: SimSnapshot, camera: THREE.Camera, dt: number, now: number): void {
    const sel = this.selection;
    if (!sel || !this.world) return;
    this.time += dt;
    const at = this.where(sim, snap, sel);
    if (at) {
      toThree(at[0], at[1], at[2] + 0.4 * Math.sin(this.time * 3), this.marker.position);
      const dist = camera.position.distanceTo(this.marker.position);
      this.marker.scale.setScalar(Math.max(1, dist / 140));
      this.marker.position.y += this.marker.scale.x * 1.1;
      this.marker.visible = true;
    } else this.marker.visible = false;
    if (now - this.last < 250) return;
    this.last = now;
    this.render(this.info(sim, sel));
  }

  private info(sim: Sim, sel: Selection): Info {
    switch (sel.kind) {
      case "person": return describePerson(sim, sel.id);
      case "building": return describeBuilding(sim, sel.id);
      case "vehicle": return describeVehicle(sim, sel.id);
      case "train": return describeTrain(sim, sel.id);
      case "stop": return describeBusStop(sim, sel.id);
    }
  }

  /** Where to float the marker: over the thing, or over whatever hides the person. */
  private where(sim: Sim, snap: SimSnapshot, sel: Selection): [number, number, number] | null {
    const world = this.world!;
    const top = (building: number): [number, number, number] => {
      const b = world.town.buildings[building];
      const p = world.scenery[b.placement];
      return [p.x, p.y, p.z + world.objects.get(p.object)!.mesh.max[2] * p.scale + 1.5];
    };
    switch (sel.kind) {
      case "building": return top(sel.id);
      case "vehicle": {
        const v = snap.vehicles[sel.id];
        return v ? [v.x, v.y, v.z + 3] : null;
      }
      case "train": {
        const c = snap.trains[sel.id]?.cars.find((x) => x.visible);
        return c ? [c.x, c.y, c.z + 6] : null;
      }
      case "stop": {
        const side = world.buses.sides[world.buses.stops[sel.id]?.sides[0]];
        return side ? [side.sign[0], side.sign[1], side.sign[2] + 3.5] : null;
      }
      case "person": {
        const p = snap.people[sel.id];
        if (p?.visible) return [p.x, p.y, p.z + 2.4];
        const b = sim.people.bodies[sel.id];
        if (b.mode === "train" && b.train >= 0) return this.where(sim, snap, { kind: "train", id: b.train });
        if (b.mode === "drive" && b.car >= 0) return this.where(sim, snap, { kind: "vehicle", id: b.car });
        if (b.mode === "bus" && b.bus >= 0) return this.where(sim, snap, { kind: "vehicle", id: b.bus });
        if (b.at?.kind === "building") return top(b.at.id);
        if (b.mode === "pass" && b.station >= 0) {
          const st = world.town.stations[b.station];
          const e = st.entrances[Math.max(0, b.entrance)];
          return st.building >= 0 ? top(st.building) : e ? [e.entry[0], e.entry[1], e.entry[2] + 3] : null;
        }
        return null;
      }
    }
  }

  private render(info: Info): void {
    const link = (text: string, ref: Ref) => {
      for (const kind of KINDS) {
        if (ref[kind] !== undefined) return `<a data-${kind}="${ref[kind]}">${esc(text)}</a>`;
      }
      return esc(text);
    };
    const rows = info.lines.map((l) => `<tr><td class="k">${esc(l.label)}</td><td>${link(l.text, l)}</td></tr>`).join("");
    const lists = info.lists.map((list) => {
      const items = list.items.slice(0, MAX_ITEMS).map((i) => link(i.text, i)).join("<br>");
      const more = list.items.length > MAX_ITEMS ? `<br>… and ${list.items.length - MAX_ITEMS} more` : "";
      return `<div class="list"><b>${esc(list.title)}</b>${items || "—"}${more}</div>`;
    }).join("");
    const html = `<h3>${esc(info.title)}</h3><div class="sub">${esc(info.subtitle)}</div><table>${rows}</table>${lists}`;
    if (html !== this.html) this.body.innerHTML = this.html = html;     // untouched while unchanged, so links stay clickable
  }
}
