// World → THREE.Scene. Builds every static mesh once (terrain, track, roads,
// walkways, structures, scenery), the instanced trains, road vehicles and
// people, the crossing barriers, the crates of goods and the cosmetic life
// layer, and exposes one per-frame update that reads a sim snapshot and the
// time of day.

import * as THREE from "three";
import type { World } from "../model/build";
import type { SimSnapshot } from "../sim/sim";
import { terrainMeshes } from "./terrainMesh";
import { trackMeshes } from "./trackMesh";
import { structureMeshes } from "./structures";
import { roadMeshes, CrossingMeshes, SignalMeshes } from "./roadMesh";
import { VehicleMeshes } from "./vehicleMesh";
import { walkMeshes } from "./walkMesh";
import { WalkerMeshes } from "./walkerMesh";
import { SceneryMeshes } from "./sceneryMesh";
import { TrainMeshes } from "./trainMesh";
import { FreightMeshes } from "./freightMesh";
import { Life, personGeometry } from "./life";
import { DetailCuller, featureSize, SMALL } from "./detail";
import { Lighting } from "./lighting";
import { LIGHT } from "./palette";

export type DioramaScene = {
  scene: THREE.Scene;
  lighting: Lighting;
  /** Per frame: move trains, animate life, apply time of day. dt is scaled sim seconds (0 when paused). */
  update(snap: SimSnapshot, dt: number, hour: number): void;
  /**
   * Per frame, before drawing: which small things are near enough `camera` to show on a
   * screen `heightPx` tall (see setDetail). True if that changed.
   */
  view(camera: THREE.PerspectiveCamera, heightPx: number): boolean;
  /** Small things are drawn only while at least this many px tall on screen; 0 draws everything. */
  setDetail(minPixels: number): void;
  /** Whether moving things (trains, road vehicles, people, goods, barrier arms) cast shadows. */
  setMovingShadows(on: boolean): void;
  dispose(): void;
};

const LIT = 0.1;                  // window glow above which lit windows are never culled

export function buildScene(world: World, snap: SimSnapshot): DioramaScene {
  const scene = new THREE.Scene();
  const statics = [...terrainMeshes(world), ...trackMeshes(world), ...roadMeshes(world), ...walkMeshes(world), ...structureMeshes(world)];
  scene.add(...statics);
  const scenery = new SceneryMeshes(world.objects, world.scenery);
  const trains = new TrainMeshes(world, snap);
  const vehicles = new VehicleMeshes(world, snap);
  const crossings = new CrossingMeshes(world);
  const signals = new SignalMeshes(world);
  const freight = new FreightMeshes(world, snap);
  const walkers = new WalkerMeshes(world.layout.seed, snap);
  const life = new Life(scenery.chimneys);
  scene.add(scenery.group, trains.group, vehicles.group, crossings.group, signals.group, walkers.group, freight.group, life.group);
  const lighting = new Lighting(world, scene);
  lighting.setHour(world.layout.style.timeOfDay);
  // Static meshes never move: skip their per-frame matrix updates.
  for (const o of statics) {
    o.matrixAutoUpdate = false;
    o.updateMatrix();
  }
  // Small things far from the camera are left out: scenery and sleepers here, people as they move.
  const culler = new DetailCuller();
  for (const p of scenery.parts) if (p.size.some((v) => v < SMALL)) culler.add(p.mesh, p.size, p.glow);
  for (const o of statics) {
    if (!(o instanceof THREE.InstancedMesh)) continue;
    o.geometry.computeBoundingBox();
    const b = o.geometry.boundingBox!;
    culler.add(o, featureSize(b.min.toArray(), b.max.toArray()));
  }
  const figure = personGeometry();
  figure.computeBoundingBox();
  const personSize = featureSize(figure.boundingBox!.min.toArray(), figure.boundingBox!.max.toArray());
  figure.dispose();
  let minPixels = 0;
  // What casts a shadow and moves.
  const moving: THREE.Object3D[] = [];
  for (const g of [trains.group, vehicles.group, walkers.group, freight.group, crossings.group]) g.traverse((o) => { if (o.castShadow) moving.push(o); });

  return {
    scene,
    lighting,
    view(camera, heightPx) {
      const focal = heightPx / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
      walkers.setView(camera.position, minPixels > 0 ? (personSize * focal) / minPixels : Infinity);
      return culler.update(camera, focal, lighting.windows > LIT);
    },
    setDetail(px) {
      minPixels = px;
      culler.setMinPixels(px);
    },
    setMovingShadows(on) {
      for (const o of moving) o.castShadow = on;
    },
    update(s, dt, hour) {
      trains.update(s);
      vehicles.update(s);
      crossings.update(s.gates);
      signals.update(s.signals);
      freight.update(s);
      walkers.update(s);
      life.update(dt);
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
      signals.dispose();
      freight.dispose();
      walkers.dispose();
      life.dispose();
      lighting.sun.shadow.map?.dispose();
    },
  };
}
