// World → THREE.Scene. Builds every static mesh once (terrain, track,
// structures, scenery), the instanced trains and the cosmetic life layer, and
// exposes one per-frame update that reads a sim snapshot and the time of day.

import * as THREE from "three";
import type { World } from "../model/build";
import type { SimSnapshot } from "../sim/sim";
import { terrainMeshes } from "./terrainMesh";
import { trackMeshes } from "./trackMesh";
import { structureMeshes } from "./structures";
import { SceneryMeshes } from "./sceneryMesh";
import { TrainMeshes } from "./trainMesh";
import { Life } from "./life";
import { Lighting } from "./lighting";
import { LIGHT } from "./palette";

export type DioramaScene = {
  scene: THREE.Scene;
  lighting: Lighting;
  /** Per frame: move trains, animate life, apply time of day. dt is scaled sim seconds (0 when paused). */
  update(snap: SimSnapshot, dt: number, hour: number): void;
  dispose(): void;
};

export function buildScene(world: World, snap: SimSnapshot): DioramaScene {
  const scene = new THREE.Scene();
  const statics = [...terrainMeshes(world), ...trackMeshes(world), ...structureMeshes(world)];
  scene.add(...statics);
  const scenery = new SceneryMeshes(world);
  const trains = new TrainMeshes(world, snap);
  const life = new Life(world, scenery.chimneys);
  scene.add(scenery.group, trains.group, life.group);
  const lighting = new Lighting(world, scene);
  lighting.setHour(world.layout.style.timeOfDay);
  // Static meshes never move: skip their per-frame matrix updates.
  for (const o of statics) {
    o.matrixAutoUpdate = false;
    o.updateMatrix();
  }

  return {
    scene,
    lighting,
    update(s, dt, hour) {
      trains.update(s);
      life.update(dt, s);
      lighting.setHour(hour);
      scenery.setNight(lighting.windows, LIGHT.windowGlow);
    },
    dispose() {
      for (const o of statics) {
        const mesh = o as THREE.Mesh;
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
      }
      scenery.dispose();
      trains.dispose();
      life.dispose();
      lighting.sun.shadow.map?.dispose();
    },
  };
}
