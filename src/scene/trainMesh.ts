// Train rendering (§8.4): one InstancedMesh per (train type, vehicle kind) with
// merged body, roof, window band and underframe. Per-instance colour comes
// from the service; matrices are updated every frame without allocating.

import * as THREE from "three";
import type { World } from "../model/build";
import type { SimSnapshot } from "../sim/sim";
import { TRAIN_CATALOG, type TrainType, type TrainTypeId } from "../model/catalog";
import { PALETTE } from "./palette";
import { GeoBuilder, flatMaterial, toThree } from "./geo";

const RAIL_TOP = 0.28;   // car wheels sit on the rail top above track z
type Kind = "loco" | "car" | "wagon";

/** One vehicle, front toward +x, standing on z = 0. */
function vehicleGeometry(t: TrainType, kind: Kind, length: number): THREE.BufferGeometry {
  const g = new GeoBuilder();
  const w = t.carWidth;
  const h = t.carHeight;
  const tram = t.shape === "tram";
  const floor = tram ? 0.45 : 1.0;
  for (const u of [-length * 0.35, length * 0.35]) g.box(u, 0, 0, tram ? 1.6 : 2.6, w * 0.7, floor, 0, PALETTE.trainUnder);
  if (kind === "wagon") {
    g.box(0, 0, floor, length - 0.6, w, h * 0.42, 0, 0xffffff);
    g.box(0, 0, floor + h * 0.42, length - 1.2, w - 0.4, 0.3, 0, PALETTE.trainUnder);
    return g.build();
  }
  const roofZ = h - 0.45;
  g.box(0, 0, floor, length - 0.5, w, roofZ - floor, 0, 0xffffff);
  g.box(0, 0, roofZ, length - 1.0, w - 0.5, 0.45, 0, PALETTE.trainRoof);
  // Window band: a thin dark strip proud of each side.
  const band = (u0: number, u1: number) => {
    for (const v of [w / 2 + 0.03, -w / 2 - 0.03]) g.box((u0 + u1) / 2, v, floor + 0.9, u1 - u0, 0.06, 1.0, 0, PALETTE.trainWindow);
  };
  if (kind === "loco") {
    band(length / 2 - 3, length / 2 - 1);
    g.box(length / 2 - 0.3, 0, floor + 0.9, 0.12, w - 0.6, 1.0, 0, PALETTE.trainWindow);
  } else {
    band(-length / 2 + 1.2, length / 2 - 1.2);
    for (const u of [length / 2 - 0.2, -length / 2 + 0.2]) g.box(u, 0, floor + 0.9, 0.12, w - 0.6, 1.0, 0, PALETTE.trainWindow);
  }
  return g.build();
}

const kindOf = (t: TrainType, car: number): Kind =>
  car === 0 && (t.shape === "loco-hauled" || t.shape === "freight") ? "loco" : t.shape === "freight" ? "wagon" : "car";

export class TrainMeshes {
  readonly group = new THREE.Group();
  /** For every train and car: which mesh and instance index draws it. */
  private slots: Array<Array<{ mesh: THREE.InstancedMesh; index: number }>> = [];
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler(0, 0, 0, "YZX");
  private p = new THREE.Vector3();
  private one = new THREE.Vector3(1, 1, 1);

  constructor(world: World, snapshot: SimSnapshot) {
    const meshes = new Map<string, { geo: THREE.BufferGeometry; colors: THREE.Color[]; owners: Array<[number, number]> }>();
    snapshot.trains.forEach((tr, ti) => {
      const t: TrainType = TRAIN_CATALOG[tr.train as TrainTypeId];
      const svc = world.layout.services.find((s) => s.id === tr.service)!;
      tr.cars.forEach((_, c) => {
        const kind = kindOf(t, c);
        const len = c === 0 && t.locoLength ? t.locoLength : t.carLength;
        const key = `${tr.train}/${kind}/${len}`;
        if (!meshes.has(key)) meshes.set(key, { geo: vehicleGeometry(t, kind, len), colors: [], owners: [] });
        const entry = meshes.get(key)!;
        entry.colors.push(kind === "loco" && t.shape === "freight" ? new THREE.Color(PALETTE.freightLoco) : new THREE.Color(svc.color ?? t.color));
        entry.owners.push([ti, c]);
      });
    });
    for (const { geo, colors, owners } of meshes.values()) {
      const mesh = new THREE.InstancedMesh(geo, flatMaterial(), owners.length);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;     // instances move; skip stale bounding spheres
      owners.forEach(([ti, c], i) => {
        mesh.setColorAt(i, colors[i]);
        (this.slots[ti] ??= [])[c] = { mesh, index: i };
      });
      this.group.add(mesh);
    }
    this.update(snapshot);
  }

  update(snapshot: SimSnapshot): void {
    snapshot.trains.forEach((tr, ti) => {
      tr.cars.forEach((car, c) => {
        const slot = this.slots[ti][c];
        toThree(car.x, car.y, car.z + RAIL_TOP, this.p);
        this.q.setFromEuler(this.e.set(0, car.heading, car.pitch));
        slot.mesh.setMatrixAt(slot.index, this.m.compose(this.p, this.q, this.one));
      });
    });
    for (const child of this.group.children) (child as THREE.InstancedMesh).instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    for (const child of this.group.children) {
      const mesh = child as THREE.InstancedMesh;
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
  }
}
