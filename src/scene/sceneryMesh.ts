// Scenery objects drawn as InstancedMeshes (§8.3, generalised): for each object
// in use, up to three meshes share the instance matrices — parts with their own
// colour, parts tinted per placement (instanceColor), and glowing parts (windows,
// lamps) whose emissive strength follows the time of day.

import * as THREE from "three";
import type { ObjectInfo, Placement } from "../model/scenery";
import type { TriList } from "../model/objects";
import { PALETTE } from "./palette";
import { GeoBuilder, flatMaterial, toThree } from "./geo";

function geometry(list: TriList): THREE.BufferGeometry | null {
  if (list.color.length === 0) return null;
  const g = new GeoBuilder();
  const p = list.pos;
  for (let t = 0; t < list.color.length; t++) {
    const i = t * 9;
    g.tri([p[i], p[i + 1], p[i + 2]], [p[i + 3], p[i + 4], p[i + 5]], [p[i + 6], p[i + 7], p[i + 8]], list.color[t]);
  }
  return g.build();
}

export class SceneryMeshes {
  readonly group = new THREE.Group();
  /** Shared by every glowing part; its emissive intensity is set by setNight(). */
  readonly glowMaterial = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, emissive: PALETTE.windowLit, emissiveIntensity: 0 });
  /** World positions (three.js frame) of chimneys that smoke. */
  readonly chimneys: THREE.Vector3[] = [];

  constructor(objects: Map<string, ObjectInfo>, placements: Placement[]) {
    const byObject = new Map<string, Placement[]>();
    for (const p of placements) {
      if (!byObject.has(p.object)) byObject.set(p.object, []);
      byObject.get(p.object)!.push(p);
    }
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const color = new THREE.Color();
    for (const [id, list] of byObject) {
      const { mesh } = objects.get(id)!;
      const parts: Array<[THREE.BufferGeometry | null, THREE.Material, "fixed" | "tint" | "glow"]> = [
        [geometry(mesh.fixed), flatMaterial(), "fixed"],
        [geometry(mesh.tint), flatMaterial(), "tint"],
        [geometry(mesh.glow), this.glowMaterial, "glow"],
      ];
      for (const [geo, mat, kind] of parts) {
        if (!geo) continue;
        const inst = new THREE.InstancedMesh(geo, mat, list.length);
        list.forEach((p, i) => {
          inst.setMatrixAt(i, m.compose(toThree(p.x, p.y, p.z, pos), q.setFromAxisAngle(up, p.rotation), scl.setScalar(p.scale)));
          if (kind === "tint") inst.setColorAt(i, color.setHex(p.tint));
        });
        inst.name = `${id}:${kind}`;
        inst.castShadow = kind !== "glow";
        inst.receiveShadow = true;
        inst.computeBoundingSphere();
        this.group.add(inst);
      }
      for (const p of list) {
        if (!p.smoke) continue;
        const c = Math.cos(p.rotation), s = Math.sin(p.rotation);
        for (const [x, y, z] of mesh.chimneys) {
          this.chimneys.push(toThree(p.x + (x * c - y * s) * p.scale, p.y + (x * s + y * c) * p.scale, p.z + z * p.scale));
        }
      }
    }
  }

  /** 0 = daylight, 1 = full night glow. */
  setNight(glow: number, intensity: number): void {
    this.glowMaterial.emissiveIntensity = glow * intensity;
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
