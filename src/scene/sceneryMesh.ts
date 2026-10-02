// Trees and town houses (§8.3, §5.7) drawn as InstancedMeshes: one per tree
// crown variant plus a shared trunk mesh, one per house variant plus a matching
// window mesh whose emissive glow is driven by the time of day.

import * as THREE from "three";
import type { World } from "../model/build";
import type { Placement } from "../model/scenery";
import type { HouseVariant, TreeVariant } from "../model/catalog";
import { PALETTE } from "./palette";
import { GeoBuilder, flatMaterial, toThree, type P3 } from "./geo";
import { rng } from "../util/rng";

const SMOKING_HOUSES = 0.1;

// --- trees -----------------------------------------------------------------

function cone(g: GeoBuilder, z0: number, z1: number, radius: number, color: number, sides = 6): void {
  const ring: P3[] = Array.from({ length: sides }, (_, i) => {
    const a = (i / sides) * Math.PI * 2;
    return [Math.cos(a) * radius, Math.sin(a) * radius, z0];
  });
  for (let i = 0; i < sides; i++) g.tri(ring[i], ring[(i + 1) % sides], [0, 0, z1], color, 0.9 + 0.1 * (i % 2));
}

/** Low-poly blob: an icosahedron, squashed a little, for deciduous crowns. */
function blob(radius: number, z: number, detail: 0 | 1, squash: number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(radius, detail);
  g.scale(1, squash, 1);
  g.translate(0, z, 0);
  const n = g.getAttribute("position").count;
  g.setAttribute("color", new THREE.Float32BufferAttribute(new Array(n * 3).fill(1), 3));
  g.computeVertexNormals();
  return g;
}

function crownGeometry(v: TreeVariant): THREE.BufferGeometry {
  if (v === "deciduous") return blob(3.2, 5.6, 0, 0.85);
  if (v === "bare") return blob(1.9, 6.4, 0, 1.7);   // slim, tall and grey: reads as bare twigs
  const g = new GeoBuilder();
  const snowy = v === "conifer-snow";
  cone(g, 1.6, 7.6, 2.7, snowy ? PALETTE.trees.winter.conifer[0] : 0xffffff);
  cone(g, 4.8, 10.4, 1.9, snowy ? PALETTE.snowCap : 0xffffff);
  return g.build();
}

// --- houses ----------------------------------------------------------------
// Each variant: front faces local +x. `walls` is white (tinted per instance),
// windows are a separate geometry so they can glow at night.

type HouseGeo = { body: GeoBuilder; windows: GeoBuilder; chimney: P3 | null };

function windowsOn(g: GeoBuilder, face: "x" | "y", at: number, from: number, to: number, cols: number, floors: number[], wW = 1.2, wH = 1.3): void {
  for (let c = 0; c < cols; c++) {
    const u = from + ((to - from) * (c + 0.5)) / cols;
    for (const z of floors) {
      const out = Math.sign(at) * 0.06;
      if (face === "x") {
        const x = at + out;
        const [a, b] = at > 0 ? [u - wW / 2, u + wW / 2] : [u + wW / 2, u - wW / 2];
        g.quad([x, a, z], [x, b, z], [x, b, z + wH], [x, a, z + wH], 0xffffff);
      } else {
        const y = at + out;
        const [a, b] = at > 0 ? [u + wW / 2, u - wW / 2] : [u - wW / 2, u + wW / 2];
        g.quad([a, y, z], [b, y, z], [b, y, z + wH], [a, y, z + wH], 0xffffff);
      }
    }
  }
}

function houseGeometry(v: HouseVariant): HouseGeo {
  const body = new GeoBuilder();
  const windows = new GeoBuilder();
  const roof = PALETTE.roofs[v];
  switch (v) {
    case "house":
      body.box(0, 0, -3, 7, 9, 8.2, 0, 0xffffff);
      body.gable(0, 0, 5.2, 9, 7, 3.4, Math.PI / 2, roof);
      body.box(1.4, 2.6, 6, 0.9, 0.9, 3.0, 0, roof, PALETTE.chimney);
      for (const x of [3.5, -3.5]) windowsOn(windows, "x", x, -3.2, 3.2, 2, [1.0, 3.3]);
      for (const y of [4.5, -4.5]) windowsOn(windows, "y", y, -2.5, 2.5, 1, [1.0, 3.3]);
      return { body, windows, chimney: [1.4, 2.6, 9.1] };
    case "terrace":
      body.box(0, 0, -3, 8, 22, 10.5, 0, 0xffffff);
      body.gable(0, 0, 7.5, 22, 8, 3.6, Math.PI / 2, roof);
      for (const y of [-7, 0, 7]) body.box(0, y, 9.5, 1.0, 1.4, 2.6, 0, roof, PALETTE.chimney);
      for (const x of [4, -4]) windowsOn(windows, "x", x, -10.5, 10.5, 6, [1.0, 4.4]);
      return { body, windows, chimney: [0, -7, 12.1] };
    case "flats":
      body.box(0, 0, -3, 12, 16, 18, 0, 0xffffff);
      body.box(0, 0, 15, 12.4, 16.4, 0.7, 0, roof);
      body.box(-2, 3, 15.7, 3, 3, 1.8, 0, roof);
      for (const x of [6, -6]) windowsOn(windows, "x", x, -7, 7, 4, [1.2, 4.6, 8.0, 11.4]);
      for (const y of [8, -8]) windowsOn(windows, "y", y, -5, 5, 3, [1.2, 4.6, 8.0, 11.4]);
      return { body, windows, chimney: null };
    case "church":
      body.box(-3, 0, -3, 20, 10, 12, 0, 0xffffff);
      body.gable(-3, 0, 9, 20, 10, 5.5, 0, roof);
      body.box(9, 0, -3, 5, 5, 25, 0, 0xffffff);
      body.tri([11.6, -2.6, 22], [11.6, 2.6, 22], [9, 0, 31], roof);
      body.tri([11.6, 2.6, 22], [6.4, 2.6, 22], [9, 0, 31], roof, 0.9);
      body.tri([6.4, 2.6, 22], [6.4, -2.6, 22], [9, 0, 31], roof, 0.85);
      body.tri([6.4, -2.6, 22], [11.6, -2.6, 22], [9, 0, 31], roof, 0.9);
      for (const y of [5, -5]) windowsOn(windows, "y", y, -12, 6, 4, [2.0], 1.0, 4.0);
      windowsOn(windows, "x", 11.5, -1, 1, 1, [14], 1.2, 2.2);
      return { body, windows, chimney: null };
  }
}

export class SceneryMeshes {
  readonly group = new THREE.Group();
  readonly windowMaterial = new THREE.MeshLambertMaterial({ color: PALETTE.window, emissive: PALETTE.windowLit, emissiveIntensity: 0 });
  readonly chimneys: THREE.Vector3[] = [];

  constructor(world: World) {
    const trees = world.scenery.filter((p) => p.kind === "tree");
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const color = new THREE.Color();
    const matrixOf = (p: Placement) => m.compose(toThree(p.x, p.y, p.z, pos), q.setFromAxisAngle(up, p.rotation), scl.setScalar(p.scale));

    // One trunk mesh for every tree.
    if (trees.length) {
      const tb = new GeoBuilder();
      tb.box(0, 0, -0.5, 0.55, 0.55, 3.0, 0, PALETTE.trunk);
      const trunks = new THREE.InstancedMesh(tb.build(), flatMaterial(), trees.length);
      trees.forEach((p, i) => trunks.setMatrixAt(i, matrixOf(p)));
      this.add(trunks, "trunks");
    }
    const groups = new Map<string, Placement[]>();
    for (const p of world.scenery) {
      const key = `${p.kind}:${p.variant}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(p);
    }
    const smoke = rng(world.layout.seed, "smoke");
    for (const [key, list] of groups) {
      const [kind, variant] = key.split(":");
      if (kind === "tree") {
        const mesh = new THREE.InstancedMesh(crownGeometry(variant as TreeVariant), flatMaterial(), list.length);
        list.forEach((p, i) => {
          mesh.setMatrixAt(i, matrixOf(p));
          if (variant !== "conifer-snow") mesh.setColorAt(i, color.setHex(p.color));
        });
        this.add(mesh, key);
        continue;
      }
      const geo = houseGeometry(variant as HouseVariant);
      const body = new THREE.InstancedMesh(geo.body.build(), flatMaterial(), list.length);
      const wins = new THREE.InstancedMesh(geo.windows.build(), this.windowMaterial, list.length);
      list.forEach((p, i) => {
        body.setMatrixAt(i, matrixOf(p));
        wins.setMatrixAt(i, m);
        body.setColorAt(i, color.setHex(p.color));
        if (geo.chimney && smoke() < SMOKING_HOUSES) {
          const [cx, cy, cz] = geo.chimney;
          const c = Math.cos(p.rotation), s = Math.sin(p.rotation);
          this.chimneys.push(toThree(p.x + (cx * c - cy * s) * p.scale, p.y + (cx * s + cy * c) * p.scale, p.z + cz * p.scale));
        }
      });
      wins.castShadow = false;
      this.add(body, key);
      this.add(wins, `${key}:windows`);
    }
  }

  private add(mesh: THREE.InstancedMesh, name: string): void {
    mesh.name = name;
    mesh.castShadow = !name.endsWith("windows");
    mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    this.group.add(mesh);
  }

  /** 0 = daylight, 1 = full night glow. */
  setNight(glow: number, intensity: number): void {
    this.windowMaterial.emissiveIntensity = glow * intensity;
  }

  dispose(): void {
    this.group.traverse((o) => {
      if (o instanceof THREE.InstancedMesh) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
  }
}

