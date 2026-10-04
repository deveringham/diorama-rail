// People on paths and sidewalks: one InstancedMesh in the same minimalist style as
// the station passengers (body block and head), moved every frame from the sim
// snapshot, with a slight bob while walking. People off the board shrink to nothing.

import * as THREE from "three";
import type { SimSnapshot } from "../sim/sim";
import { PALETTE } from "./palette";
import { flatMaterial, toThree } from "./geo";
import { personGeometry } from "./life";
import { hashString } from "../util/rng";

const BOB = 0.05;                // m
const STRIDE = 0.75;             // m per step

export class WalkerMeshes {
  readonly group = new THREE.Group();
  private mesh: THREE.InstancedMesh | null = null;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private p = new THREE.Vector3();
  private s = new THREE.Vector3();
  private up = new THREE.Vector3(0, 1, 0);

  constructor(seed: number, snapshot: SimSnapshot) {
    const n = snapshot.people.length;
    if (!n) return;
    this.mesh = new THREE.InstancedMesh(personGeometry(), flatMaterial(), n);
    const c = new THREE.Color();
    for (let i = 0; i < n; i++) this.mesh.setColorAt(i, c.setHex(PALETTE.people[hashString(`${seed}-walker-${i}`) % PALETTE.people.length]));
    this.mesh.name = "walkers";
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);
    this.update(snapshot);
  }

  update(snapshot: SimSnapshot): void {
    if (!this.mesh) return;
    snapshot.people.forEach((w, i) => {
      const bob = w.moving ? BOB * Math.abs(Math.sin((w.step / STRIDE) * Math.PI)) : 0;
      toThree(w.x, w.y, w.z + bob, this.p);
      this.q.setFromAxisAngle(this.up, w.heading);
      this.s.setScalar(w.visible ? 1 : 0);
      this.mesh!.setMatrixAt(i, this.m.compose(this.p, this.q, this.s));
    });
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    if (!this.mesh) return;
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
