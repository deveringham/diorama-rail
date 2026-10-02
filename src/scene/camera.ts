// Camera rig (§8.6): a 30° perspective camera framing the whole diorama from
// about 35° elevation, OrbitControls with damping and slow auto-rotate, a
// straight-down "top" view for screenshots, and a smoothed train-follow mode.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { World } from "../model/build";
import type { SimSnapshot } from "../sim/sim";
import { toThree } from "./geo";

const FOV = 30;
const ELEVATION = 35 * (Math.PI / 180);
const VIEW_FROM = [-0.3, -1];        // model-frame direction from target to camera (south-south-west)
const AUTO_ROTATE = 0.15;
const FOLLOW_BACK = 40;              // m behind the head, plus 60% of the train length
const FOLLOW_UP = 16;
const FOLLOW_EASE = 2.2;             // 1/s smoothing rate

export type Pose = { position: THREE.Vector3; target: THREE.Vector3 };

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  follow: number | null = null;       // index into snapshot.trains
  private look = new THREE.Vector3();
  private want = new THREE.Vector3();
  private wantLook = new THREE.Vector3();
  private center = new THREE.Vector3();
  private fit = 1000;

  constructor(dom: HTMLElement, aspect: number) {
    this.camera = new THREE.PerspectiveCamera(FOV, aspect, 1, 10000);
    this.controls = new OrbitControls(this.camera, dom);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = AUTO_ROTATE;
    this.controls.minPolarAngle = (15 * Math.PI) / 180;
    this.controls.maxPolarAngle = (75 * Math.PI) / 180;
    this.controls.screenSpacePanning = false;
  }

  /** Recompute framing for a (new) world. Keeps the current pose unless `reset`. */
  setWorld(world: World, reset: boolean): void {
    const t = world.terrain;
    let zSum = 0;
    for (const z of t.shaped) zSum += z;
    toThree(t.width / 2, t.height / 2, zSum / t.shaped.length, this.center);
    const tanV = Math.tan((FOV / 2) * (Math.PI / 180));
    const tanH = tanV * this.camera.aspect;
    this.fit = Math.max((t.width * 0.58) / tanH, (t.height * Math.sin(ELEVATION) * 0.62 + 40) / tanV, 200);
    this.controls.minDistance = 25;
    this.controls.maxDistance = this.fit * 2.2;
    if (reset) this.overview();
  }

  overview(): void {
    const [dx, dy] = VIEW_FROM;
    const k = Math.hypot(dx, dy);
    const c = Math.cos(ELEVATION);
    const off = toThree((dx / k) * c * this.fit, (dy / k) * c * this.fit, Math.sin(ELEVATION) * this.fit);
    this.camera.up.set(0, 1, 0);
    this.camera.position.copy(this.center).add(off);
    this.controls.target.copy(this.center);
    this.controls.update();
  }

  /** Straight down, north up. OrbitControls can't do this, so it is left disabled. */
  top(world: World): void {
    const t = world.terrain;
    const tanV = Math.tan((FOV / 2) * (Math.PI / 180));
    const h = Math.max(t.height / 2 / tanV, t.width / 2 / (tanV * this.camera.aspect)) * 1.06;
    this.controls.enabled = false;
    this.camera.up.set(0, 0, -1);
    this.camera.position.set(this.center.x, this.center.y + h, this.center.z);
    this.camera.lookAt(this.center);
  }

  getPose(): Pose {
    return { position: this.camera.position.clone(), target: this.controls.target.clone() };
  }

  setPose(p: Pose): void {
    this.camera.position.copy(p.position);
    this.controls.target.copy(p.target);
    this.controls.update();
  }

  cycleFollow(count: number): void {
    this.follow = count === 0 ? null : this.follow === null ? 0 : (this.follow + 1) % count;
    this.controls.enabled = this.follow === null;
    if (this.follow !== null) this.look.copy(this.controls.target);
  }

  stopFollow(): void {
    if (this.follow === null) return;
    this.follow = null;
    this.controls.target.copy(this.look);
    this.controls.enabled = true;
  }

  update(dt: number, snap: SimSnapshot | null, jump = false): void {
    const tr = this.follow !== null ? snap?.trains[this.follow] : undefined;
    if (tr) {
      const car = tr.cars[0];
      const back = FOLLOW_BACK + 0.6 * tr.length;
      const fx = Math.cos(tr.heading), fy = Math.sin(tr.heading);
      toThree(car.x - fx * back, car.y - fy * back, car.z + FOLLOW_UP + 0.1 * tr.length, this.want);
      toThree(car.x + fx * 12, car.y + fy * 12, car.z + 2, this.wantLook);
      const k = jump ? 1 : 1 - Math.exp(-dt * FOLLOW_EASE);
      this.camera.position.lerp(this.want, k);
      this.look.lerp(this.wantLook, k);
      this.camera.lookAt(this.look);
    } else if (this.controls.enabled) {
      this.controls.update(dt);
    }
    // Keep depth precision: near plane scales with distance to what we're looking at.
    const dist = this.camera.position.distanceTo(tr ? this.look : this.controls.target);
    const near = Math.min(Math.max(dist * 0.003, 0.5), 20);
    if (Math.abs(near - this.camera.near) / this.camera.near > 0.1) {
      this.camera.near = near;
      this.camera.far = Math.max(dist * 8, 8000);
      this.camera.updateProjectionMatrix();
    }
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }
}
