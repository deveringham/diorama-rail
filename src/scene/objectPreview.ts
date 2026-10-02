// Object preview: one or more scenery objects on a small grass plinth, lit like a
// summer afternoon and framed from the front-right. Used by ?object=... and
// `npm run screenshot -- --object`, so an author can check a new object alone.

import * as THREE from "three";
import type { ObjectInfo, Placement } from "../model/scenery";
import { tintColors } from "../model/objects";
import type { Season } from "./palette";
import { DAY_KEYS, LIGHT, PALETTE } from "./palette";
import { SceneryMeshes } from "./sceneryMesh";
import { GeoBuilder, flatMaterial, toThree } from "./geo";

const GAP = 5;                         // m between objects in a gallery
const VIEW = [1, -0.8, 0.62];          // model-frame direction from target to camera (front-right)
const DAY = DAY_KEYS[4];               // mid-afternoon light

export type Preview = {
  scene: THREE.Scene;
  labels: Array<{ id: string; at: THREE.Vector3 }>;   // three.js points above each object
  frame(camera: THREE.PerspectiveCamera): THREE.Vector3; // places the camera; returns the target
  setNight(glow: number): void;
};

export function buildPreview(objects: Map<string, ObjectInfo>, ids: string[], season: Season): Preview {
  // Lay the objects out in rows along y (fronts facing +x), rows stepping back along −x.
  const sizes = ids.map((id) => objects.get(id)!.mesh);
  const rowWidth = Math.max(...sizes.map((m) => m.max[1] - m.min[1])) * Math.max(1, Math.ceil(Math.sqrt(ids.length)));
  const placements: Placement[] = [];
  const labels: Preview["labels"] = [];
  let x = 0, y = 0, rowDepth = 0;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  ids.forEach((id, i) => {
    const m = sizes[i];
    const w = m.max[1] - m.min[1];
    if (y > 0 && y + w > rowWidth) { x -= rowDepth + GAP; y = 0; rowDepth = 0; }
    const px = x - m.max[0];
    const py = y - m.min[1];
    placements.push({ object: id, x: px, y: py, z: 0, rotation: 0, scale: 1, tint: tintColors(objects.get(id)!.def, season)[0], smoke: m.chimneys.length > 0 });
    labels.push({ id, at: toThree(px, py + (m.min[1] + m.max[1]) / 2, m.max[2] + 1.5) });
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a], [px, py, 0][a] + m.min[a]);
      hi[a] = Math.max(hi[a], [px, py, 0][a] + m.max[a]);
    }
    y += w + GAP;
    rowDepth = Math.max(rowDepth, m.max[0] - m.min[0]);
  });

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(DAY.sky);
  const scenery = new SceneryMeshes(objects, placements);
  scene.add(scenery.group);
  const g = new GeoBuilder();
  const pad = 4;
  g.box((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, -1, hi[0] - lo[0] + 2 * pad, hi[1] - lo[1] + 2 * pad, 1, 0, PALETTE.terrain.earth, PALETTE.terrain[season].grass[0]);
  const plinth = new THREE.Mesh(g.build(), flatMaterial());
  plinth.receiveShadow = true;
  scene.add(plinth);

  const center = toThree((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 3);
  const radius = Math.max(4, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2 + pad);
  scene.add(new THREE.HemisphereLight(DAY.hemiSky, DAY.hemiGround, DAY.hemiI));
  const sun = new THREE.DirectionalLight(DAY.sun, DAY.sunI);
  sun.position.copy(center).add(toThree(0.5 * radius * 3, -1 * radius * 3, 1.2 * radius * 3));
  sun.target.position.copy(center);
  sun.castShadow = true;
  sun.shadow.mapSize.set(LIGHT.shadowMapSize, LIGHT.shadowMapSize);
  Object.assign(sun.shadow.camera, { left: -radius, right: radius, top: radius, bottom: -radius, near: 0.5, far: radius * 8 });
  sun.shadow.bias = -0.0005;
  scene.add(sun, sun.target);

  return {
    scene,
    labels,
    frame(camera) {
      const dir = toThree(VIEW[0], VIEW[1], VIEW[2]).normalize();
      const dist = (radius / Math.sin(((camera.fov / 2) * Math.PI) / 180)) * 0.85;
      camera.position.copy(center).addScaledVector(dir, dist);
      camera.near = Math.max(0.1, dist / 200);
      camera.far = dist * 10;
      camera.updateProjectionMatrix();
      camera.lookAt(center);
      return center;
    },
    setNight(glow) {
      scenery.setNight(glow, LIGHT.windowGlow);
    },
  };
}
