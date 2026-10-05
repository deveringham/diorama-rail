// Goods you can see: crates stacked on each goods yard's dock (what waits there for
// a lorry or a train) and beside the door of every building with goods ready to go
// out, each in its goods' colour. One InstancedMesh, refilled every frame from the
// sim snapshot; unused crates are scaled to nothing.

import * as THREE from "three";
import type { World } from "../model/build";
import type { SimSnapshot } from "../sim/sim";
import { goodsColor } from "../model/catalog";
import { profileZ } from "../model/heights";
import { PLATFORM_TOP } from "../model/scenery";
import { pointAt, headingAt } from "../model/geometry";
import { PALETTE } from "./palette";
import { GeoBuilder, flatMaterial, toThree } from "./geo";

const CRATE_L = 1.2;            // m along the dock (or the facade)
const CRATE_W = 1.0;
const CRATE_H = 0.9;
const STEP_ALONG = 1.5;         // m between crates along the dock
const COLUMNS = [3.0, 4.2, 5.4, 6.6, 7.8];   // m from the track centre, across the dock
const LAYERS = 2;
const YARD_MAX = 160;           // crates drawn per yard at most
const DOOR_SLOTS = 6;           // crates beside a building's door at most

type Slot = { x: number; y: number; z: number; h: number };

export class FreightMeshes {
  readonly group = new THREE.Group();
  private mesh: THREE.InstancedMesh | null = null;
  private yards: Slot[][] = [];
  private sites: Array<{ site: number; slots: Slot[] }> = [];
  private colors: THREE.Color[] = [];
  private goods: string[] = [];
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler(0, 0, 0, "YZX");
  private p = new THREE.Vector3();
  private one = new THREE.Vector3(1, 1, 1);
  private none = new THREE.Vector3(0, 0, 0);

  constructor(world: World, snapshot: SimSnapshot) {
    const net = world.freight;
    this.goods = net.goods;
    this.colors = net.goods.map((g) => new THREE.Color(goodsColor(g)));
    // On each yard's dock: outward from the shed, from the road side toward the track, two high.
    for (const y of net.yards) {
      const t = world.tracks.get(y.track)!;
      const prof = world.profiles.get(y.track)!;
      const b = y.building >= 0 ? world.town.buildings[y.building] : null;
      const mesh = b ? world.objects.get(b.object)!.mesh : null;
      const shed = mesh ? (mesh.max[1] - mesh.min[1]) / 2 + 1.5 : 0;
      const L = t.path.length;
      const slots: Slot[] = [];
      for (let k = 0; slots.length < YARD_MAX; k++) {
        const d = shed + 1 + k * STEP_ALONG;
        if (d > y.length / 2 - 2) break;
        for (const sg of [1, -1]) {
          const s0 = y.at + sg * d;
          const s = t.path.closed ? ((s0 % L) + L) % L : Math.min(Math.max(s0, 0), L);
          const [px, py] = pointAt(t.path, s);
          const h = headingAt(t.path, s);
          const z = profileZ(prof, s) + PLATFORM_TOP;
          for (const lat of [...COLUMNS].reverse()) {
            for (let layer = 0; layer < LAYERS; layer++) {
              const l = y.side * lat;
              slots.push({ x: px - Math.sin(h) * l, y: py + Math.cos(h) * l, z: z + layer * CRATE_H, h });
            }
          }
        }
      }
      this.yards.push(slots.slice(0, YARD_MAX));
    }
    // Beside each supplying building's door, along its front, two high.
    for (const s of net.sites) {
      if (s.kind !== "building" || !s.supplies.length) continue;
      const b = world.town.buildings[s.ref];
      const p = world.scenery[b.placement];
      const [c, sn] = [Math.cos(p.rotation), Math.sin(p.rotation)];
      const slots: Slot[] = [];
      for (let k = 0; k < DOOR_SLOTS / LAYERS; k++) {
        const along = 1.8 + k * (CRATE_L + 0.2);
        for (let layer = 0; layer < LAYERS; layer++) {
          // Out from the door a little, then along the facade to its right.
          const x = b.door[0] + c * 0.6 + sn * along;
          const y = b.door[1] + sn * 0.6 - c * along;
          slots.push({ x, y, z: b.door[2] + layer * CRATE_H, h: p.rotation + Math.PI / 2 });
        }
      }
      this.sites.push({ site: s.id, slots });
    }
    const total = this.yards.reduce((a, l) => a + l.length, 0) + this.sites.reduce((a, x) => a + x.slots.length, 0);
    if (!total) return;
    const g = new GeoBuilder();
    g.box(0, 0, 0, CRATE_L, CRATE_W, CRATE_H, 0, 0xffffff, 0xc8c8c8);
    g.box(0, 0, CRATE_H * 0.45, CRATE_L + 0.04, CRATE_W + 0.04, 0.12, 0, PALETTE.crateLid);
    this.mesh = new THREE.InstancedMesh(g.build(), flatMaterial(), total);
    this.mesh.name = "freight-crates";
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    for (let k = 0; k < total; k++) this.mesh.setColorAt(k, this.colors[0] ?? new THREE.Color(0xffffff));   // so the shader has instance colours from the start
    this.group.add(this.mesh);
    this.update(snapshot);
  }

  update(snapshot: SimSnapshot): void {
    const mesh = this.mesh;
    if (!mesh) return;
    const f = snapshot.freight;
    let i = 0;
    const fill = (slots: Slot[], counts: number[] | undefined) => {
      let used = 0;
      if (counts && f.goods === this.goods) {
        for (let g = 0; g < counts.length; g++) {
          for (let n = 0; n < counts[g] && used < slots.length; n++) this.place(i + used++, slots[used - 1], g);
        }
      }
      for (let k = used; k < slots.length; k++) mesh.setMatrixAt(i + k, this.m.compose(this.p.set(0, -100, 0), this.q.identity(), this.none));
      i += slots.length;
    };
    this.yards.forEach((slots, k) => fill(slots, f.yards[k]));
    for (const x of this.sites) fill(x.slots, f.stock[x.site]);
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  private place(index: number, s: Slot, g: number): void {
    toThree(s.x, s.y, s.z, this.p);
    this.q.setFromEuler(this.e.set(0, s.h, 0));
    this.mesh!.setMatrixAt(index, this.m.compose(this.p, this.q, this.one));
    this.mesh!.setColorAt(index, this.colors[g]);
  }

  dispose(): void {
    if (!this.mesh) return;
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
