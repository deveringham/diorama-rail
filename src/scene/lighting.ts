// Lighting and day/night (§8.6): a hemisphere light plus one shadow-casting
// directional "sun" (moon at night) whose colour, intensity and direction follow
// the palette keyframes by hour. Also drives sky background, fog and window glow.

import * as THREE from "three";
import type { World } from "../model/build";
import { DAY_KEYS, LIGHT } from "./palette";
import { toThree } from "./geo";

const DEG = Math.PI / 180;

export class Lighting {
  readonly hemi = new THREE.HemisphereLight();
  readonly sun = new THREE.DirectionalLight();
  readonly sky = new THREE.Color();
  /** 0..1: how lit house windows should be. */
  windows = 0;
  private fog: THREE.Fog;
  private center = new THREE.Vector3();
  private radius: number;
  private a = new THREE.Color();
  private b = new THREE.Color();

  constructor(world: World, scene: THREE.Scene) {
    const t = world.terrain;
    toThree(t.width / 2, t.height / 2, 0, this.center);
    this.radius = Math.hypot(t.width, t.height) / 2 + 40;
    const cam = this.sun.shadow.camera;
    cam.left = -this.radius;
    cam.right = this.radius;
    cam.top = this.radius;
    cam.bottom = -this.radius;
    cam.near = 1;
    cam.far = this.radius * 5;
    this.sun.shadow.mapSize.set(LIGHT.shadowMapSize, LIGHT.shadowMapSize);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.8;
    this.sun.castShadow = true;
    this.sun.target.position.copy(this.center);
    scene.add(this.hemi, this.sun, this.sun.target);
    scene.background = this.sky;
    this.fog = new THREE.Fog(this.sky, this.radius * LIGHT.fogNear, this.radius * LIGHT.fogFar);
    scene.fog = this.fog;
  }

  setShadows(on: boolean): void {
    this.sun.castShadow = on;
  }

  /** Apply the time of day (hours, wraps at 24). */
  setHour(hour: number): void {
    const h = ((hour % 24) + 24) % 24;
    let k = 0;
    while (k < DAY_KEYS.length - 2 && DAY_KEYS[k + 1].hour <= h) k++;
    const k0 = DAY_KEYS[k];
    const k1 = DAY_KEYS[k + 1];
    const f = (h - k0.hour) / (k1.hour - k0.hour);
    const mix = (out: THREE.Color, c0: number, c1: number) => out.lerpColors(this.a.setHex(c0), this.b.setHex(c1), f);
    mix(this.sky, k0.sky, k1.sky);
    this.fog.color.copy(this.sky);
    mix(this.sun.color, k0.sun, k1.sun);
    mix(this.hemi.color, k0.hemiSky, k1.hemiSky);
    mix(this.hemi.groundColor, k0.hemiGround, k1.hemiGround);
    this.sun.intensity = k0.sunI + (k1.sunI - k0.sunI) * f;
    this.hemi.intensity = k0.hemiI + (k1.hemiI - k0.hemiI) * f;
    this.windows = k0.windows + (k1.windows - k0.windows) * f;

    // The light sweeps 15°/h; by night the same arc stands in for the moon, so it never jumps.
    const az = (LIGHT.sunAzimuthNoon + (12 - h) * 15) * DEG;
    const el = Math.max(10, Math.abs(Math.sin(((h - 6) / 12) * Math.PI)) * LIGHT.sunMaxElevation) * DEG;
    const dir = toThree(Math.cos(az) * Math.cos(el), Math.sin(az) * Math.cos(el), Math.sin(el), this.sun.position);
    dir.multiplyScalar(this.radius * 2).add(this.center);
  }
}
