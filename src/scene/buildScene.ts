// World → THREE.Scene. Builds every static mesh once (terrain, track, roads,
// structures, scenery), the instanced trains and road vehicles, the crossing
// barriers and the cosmetic life layer, and exposes one per-frame update that
// reads a sim snapshot and the time of day.

import * as THREE from "three";
import type { World } from "../model/build";
import type { SimSnapshot } from "../sim/sim";
import { terrainMeshes } from "./terrainMesh";
import { trackMeshes } from "./trackMesh";
import { structureMeshes } from "./structures";
import { roadMeshes, CrossingMeshes } from "./roadMesh";
import { VehicleMeshes } from "./vehicleMesh";
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
  const statics = [...terrainMeshes(world), ...trackMeshes(world), ...roadMeshes(world), ...structureMeshes(world)];
  scene.add(...statics);
  const scenery = new SceneryMeshes(world.objects, world.scenery);
  const trains = new TrainMeshes(world, snap);
  const vehicles = new VehicleMeshes(world, snap);
  const crossings = new CrossingMeshes(world);
  const life = new Life(world, scenery.chimneys);
  scene.add(scenery.group, trains.group, vehicles.group, crossings.group, life.group);
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
      vehicles.update(s);
      crossings.update(s.gates);
      life.update(dt, s);
      lighting.setHour(hour);
      scenery.setNight(lighting.windows, LIGHT.windowGlow);
      vehicles.setNight(lighting.windows, LIGHT.windowGlow);
    },
    dispose() {
      for (const o of statics) {
        const mesh = o as THREE.Mesh;
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
      }
      scenery.dispose();
      trains.dispose();
      vehicles.dispose();
      crossings.dispose();
      life.dispose();
      lighting.sun.shadow.map?.dispose();
    },
  };
}
