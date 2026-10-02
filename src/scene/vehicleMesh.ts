// Road vehicles: the traffic's objects drawn as InstancedMeshes, like scenery
// (fixed, tinted and glowing parts per object) but moved every frame from the
// sim snapshot. Vehicles off the board are scaled to nothing.

import * as THREE from "three";
import type { World } from "../model/build";
import type { SimSnapshot } from "../sim/sim";
import { tintColors } from "../model/objects";
import { PALETTE } from "./palette";
import { flatMaterial, toThree } from "./geo";
import { geometry } from "./sceneryMesh";
import { hashString } from "../util/rng";

export class VehicleMeshes {
  readonly group = new THREE.Group();
  readonly glowMaterial = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, emissive: PALETTE.windowLit, emissiveIntensity: 0 });
  /** For every vehicle: the meshes drawing it and its instance index in each. */
  private slots: Array<{ meshes: THREE.InstancedMesh[]; index: number }> = [];
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler(0, 0, 0, "YZX");
  private p = new THREE.Vector3();
  private one = new THREE.Vector3(1, 1, 1);
  private none = new THREE.Vector3(0, 0, 0);

  constructor(world: World, snapshot: SimSnapshot) {
    const byObject = new Map<string, number[]>();
    snapshot.vehicles.forEach((v, i) => {
      if (!byObject.has(v.object)) byObject.set(v.object, []);
      byObject.get(v.object)!.push(i);
    });
    const color = new THREE.Color();
    const season = world.layout.style.season;
    for (const [id, owners] of byObject) {
      const info = world.objects.get(id)!;
      const tints = tintColors(info.def, season);
      const meshes: THREE.InstancedMesh[] = [];
      for (const [list, kind] of [[info.mesh.fixed, "fixed"], [info.mesh.tint, "tint"], [info.mesh.glow, "glow"]] as const) {
        const geo = geometry(list);
        if (!geo) continue;
        const inst = new THREE.InstancedMesh(geo, kind === "glow" ? this.glowMaterial : flatMaterial(), owners.length);
        inst.name = `vehicle ${id}:${kind}`;
        inst.castShadow = kind !== "glow";
        inst.receiveShadow = true;
        inst.frustumCulled = false;     // instances move; skip stale bounding spheres
        if (kind === "tint") owners.forEach((v, i) => inst.setColorAt(i, color.setHex(tints[hashString(`${world.layout.seed}-${v}`) % tints.length])));
        meshes.push(inst);
        this.group.add(inst);
      }
      owners.forEach((v, i) => { this.slots[v] = { meshes, index: i }; });
    }
    this.update(snapshot);
  }

  update(snapshot: SimSnapshot): void {
    snapshot.vehicles.forEach((v, i) => {
      const slot = this.slots[i];
      if (!slot) return;
      toThree(v.x, v.y, v.z, this.p);
      this.q.setFromEuler(this.e.set(0, v.heading, v.pitch));
      this.m.compose(this.p, this.q, v.visible ? this.one : this.none);
      for (const mesh of slot.meshes) mesh.setMatrixAt(slot.index, this.m);
    });
    for (const child of this.group.children) (child as THREE.InstancedMesh).instanceMatrix.needsUpdate = true;
  }

  /** 0 = daylight, 1 = full night: headlights and lit bus windows. */
  setNight(glow: number, intensity: number): void {
    this.glowMaterial.emissiveIntensity = glow * intensity;
  }

  dispose(): void {
    for (const child of this.group.children) {
      const mesh = child as THREE.InstancedMesh;
      mesh.geometry.dispose();
      if (mesh.material !== this.glowMaterial) (mesh.material as THREE.Material).dispose();
    }
    this.glowMaterial.dispose();
  }
}
