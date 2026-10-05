// People on paths and sidewalks: one InstancedMesh in the same minimalist style as
// the station passengers (body block and head), moved every frame from the sim
// snapshot, with a slight bob while walking. Only people on the board, and (with
// setView) near enough the camera to show, are drawn: the rest are left out of the buffer.

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
  private colors: THREE.Color[] = [];
  private owner: Int32Array = new Int32Array(0);       // which person each instance slot draws
  private eye = new THREE.Vector3();
  private far = Infinity;

  constructor(seed: number, snapshot: SimSnapshot) {
    const n = snapshot.people.length;
    if (!n) return;
    this.mesh = new THREE.InstancedMesh(personGeometry(), flatMaterial(), n);
    for (let i = 0; i < n; i++) this.colors.push(new THREE.Color(PALETTE.people[hashString(`${seed}-walker-${i}`) % PALETTE.people.length]));
    this.mesh.setColorAt(0, this.colors[0]);
    this.owner = new Int32Array(n).fill(-1);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.name = "walkers";
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);
    this.update(snapshot);
  }

  /** From now on draw only people within `far` metres of `eye` (three.js frame); Infinity for everyone. */
  setView(eye: THREE.Vector3, far: number): void {
    this.eye.copy(eye);
    this.far = far;
  }

  update(snapshot: SimSnapshot): void {
    const mesh = this.mesh;
    if (!mesh) return;
    const far2 = this.far * this.far;
    let n = 0;
    let recolor = false;
    snapshot.people.forEach((w, i) => {
      if (!w.visible) return;
      const bob = w.moving ? BOB * Math.abs(Math.sin((w.step / STRIDE) * Math.PI)) : 0;
      toThree(w.x, w.y, w.z + bob, this.p);
      if (far2 !== Infinity && this.p.distanceToSquared(this.eye) > far2) return;
      this.q.setFromAxisAngle(this.up, w.heading);
      mesh.setMatrixAt(n, this.m.compose(this.p, this.q, this.s.setScalar(1)));
      if (this.owner[n] !== i) {
        this.owner[n] = i;
        mesh.setColorAt(n, this.colors[i]);
        recolor = true;
      }
      n++;
    });
    mesh.count = n;
    mesh.visible = n > 0;
    mesh.instanceMatrix.clearUpdateRanges();
    mesh.instanceMatrix.addUpdateRange(0, n * 16);
    mesh.instanceMatrix.needsUpdate = true;
    if (recolor && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    if (!this.mesh) return;
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
