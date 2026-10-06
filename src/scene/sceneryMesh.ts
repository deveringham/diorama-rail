// Scenery objects drawn as InstancedMeshes (§8.3, generalised): for each object
// in use, up to two meshes share the instance matrices — its body (parts with their
// own colour and parts tinted per placement, told apart by a per-vertex mask so one
// draw call does both) and its glowing parts (windows, lamps), whose emissive
// strength follows the time of day.

import * as THREE from "three";
import type { ObjectInfo, Placement } from "../model/scenery";
import type { TriList } from "../model/objects";
import { PALETTE } from "./palette";
import { GeoBuilder, flatMaterial, toThree } from "./geo";
import { featureSize, panelSize } from "./detail";

function addList(g: GeoBuilder, list: TriList): void {
  const p = list.pos;
  for (let t = 0; t < list.color.length; t++) {
    const i = t * 9;
    g.tri([p[i], p[i + 1], p[i + 2]], [p[i + 3], p[i + 4], p[i + 5]], [p[i + 6], p[i + 7], p[i + 8]], list.color[t]);
  }
}

/** A mesher triangle list as a vertex-coloured geometry, or null if empty. */
export function geometry(list: TriList): THREE.BufferGeometry | null {
  if (list.color.length === 0) return null;
  const g = new GeoBuilder();
  addList(g, list);
  return g.build();
}

/**
 * An object's own-coloured and tinted parts as one geometry, or null if it has
 * neither. Its `tintMask` attribute is 1 on the tinted parts: with bodyMaterial,
 * an instance colour tints those alone.
 */
export function bodyGeometry(fixed: TriList, tint: TriList): THREE.BufferGeometry | null {
  const nf = fixed.color.length;
  const n = nf + tint.color.length;
  if (n === 0) return null;
  const g = new GeoBuilder();
  addList(g, fixed);
  addList(g, tint);
  const geo = g.build();
  geo.setAttribute("tintMask", new THREE.Float32BufferAttribute(new Float32Array(n * 3).fill(1, nf * 3), 1));
  return geo;
}

/** three's colour chunk, with the instance colour applied by tintMask. */
export const TINT_COLOR_VERTEX = THREE.ShaderChunk.color_vertex.replace(
  "vColor.rgb *= instanceColor.rgb;", "vColor.rgb *= mix( vec3( 1.0 ), instanceColor.rgb, tintMask );");

/** The flat, vertex-coloured material for bodyGeometry meshes. */
export function bodyMaterial(): THREE.MeshLambertMaterial {
  const m = flatMaterial();
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float tintMask;")
      .replace("#include <color_vertex>", TINT_COLOR_VERTEX);
  };
  m.customProgramCacheKey = () => "tint-mask";
  return m;
}

export class SceneryMeshes {
  readonly group = new THREE.Group();
  /** Shared by every glowing part; its emissive intensity is set by setNight(). */
  readonly glowMaterial = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, emissive: PALETTE.windowLit, emissiveIntensity: 0 });
  /** Shared by every body. */
  readonly bodyMaterial = bodyMaterial();
  /** World positions (three.js frame) of chimneys that smoke. */
  readonly chimneys: THREE.Vector3[] = [];
  /** Every instanced mesh with each instance's size on screen (m, see detail.ts), for distance culling. */
  readonly parts: Array<{ mesh: THREE.InstancedMesh; size: Float32Array; glow: boolean }> = [];

  constructor(objects: Map<string, ObjectInfo>, placements: Placement[]) {
    const byObject = new Map<string, number[]>();
    placements.forEach((p, i) => {
      if (!byObject.has(p.object)) byObject.set(p.object, []);
      byObject.get(p.object)!.push(i);
    });
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const color = new THREE.Color();
    for (const [id, indices] of byObject) {
      const list = indices.map((i) => placements[i]);
      const { mesh } = objects.get(id)!;
      // Whole objects look as big as their middle dimension; windows and lamps as one of their panels.
      const body = featureSize(mesh.min, mesh.max);
      const panel = panelSize(mesh.glow.pos);
      const parts: Array<[THREE.BufferGeometry | null, THREE.Material, "body" | "glow"]> = [
        [bodyGeometry(mesh.fixed, mesh.tint), this.bodyMaterial, "body"],
        [geometry(mesh.glow), this.glowMaterial, "glow"],
      ];
      const tinted = mesh.tint.color.length > 0;
      for (const [geo, mat, kind] of parts) {
        if (!geo) continue;
        const inst = new THREE.InstancedMesh(geo, mat, list.length);
        list.forEach((p, i) => {
          inst.setMatrixAt(i, m.compose(toThree(p.x, p.y, p.z, pos), q.setFromAxisAngle(up, p.rotation), scl.setScalar(p.scale)));
          if (kind === "body" && tinted) inst.setColorAt(i, color.setHex(p.tint));
        });
        inst.name = `${id}:${kind}`;
        inst.userData.placements = indices;           // instance -> index into world.scenery (for picking)
        inst.castShadow = kind !== "glow";
        inst.receiveShadow = true;
        inst.computeBoundingSphere();
        this.group.add(inst);
        this.parts.push({ mesh: inst, size: Float32Array.from(list, (p) => (kind === "glow" ? panel : body) * p.scale), glow: kind === "glow" });
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
