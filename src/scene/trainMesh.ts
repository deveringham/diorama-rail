// Train rendering (§8.4): one InstancedMesh per (train type, vehicle kind) with
// merged body, roof, window band and underframe. Per-instance colour comes
// from the service; matrices are updated every frame without allocating.

import * as THREE from "three";
import type { World } from "../model/build";
import type { SimSnapshot } from "../sim/sim";
import { TRAIN_CATALOG, WAGON_LOADS, goodsColor, type TrainType, type TrainTypeId, type WagonShape } from "../model/catalog";
import { PALETTE } from "./palette";
import { GeoBuilder, flatMaterial, toThree } from "./geo";
import type { CarPose } from "../sim/sim";
import type { StabledSpec } from "../model/schema";
import { stabledVehicles } from "../model/validate";
import { pointAt } from "../model/geometry";
import { profileZ } from "../model/heights";

const RAIL_TOP = 0.28;   // car wheels sit on the rail top above track z
type Kind = "loco" | "car" | "wagon";

/** One vehicle, front toward +x, standing on z = 0. */
export function vehicleGeometry(t: TrainType, kind: Kind, length: number): THREE.BufferGeometry {
  const g = new GeoBuilder();
  const w = t.carWidth;
  const h = kind === "loco" ? Math.min(t.carHeight, 4.1) : t.carHeight;
  const tram = t.shape === "tram";
  const floor = tram ? 0.45 : 1.0;
  for (const u of [-length * 0.35, length * 0.35]) g.box(u, 0, 0, tram ? 1.6 : 2.6, w * 0.7, floor, 0, PALETTE.trainUnder);
  if (kind === "wagon") {
    wagonBody(g, t.wagon ?? "open", length, w, h, floor);
    return g.build();
  }
  const roofZ = h - 0.45;
  g.box(0, 0, floor, length - 0.5, w, roofZ - floor, 0, 0xffffff);
  g.box(0, 0, roofZ, length - 1.0, w - 0.5, 0.45, 0, PALETTE.trainRoof);
  // Window band: a thin dark strip proud of each side.
  const band = (u0: number, u1: number, z = floor + 0.9) => {
    for (const v of [w / 2 + 0.03, -w / 2 - 0.03]) g.box((u0 + u1) / 2, v, z, u1 - u0, 0.06, 1.0, 0, PALETTE.trainWindow);
  };
  if (kind === "loco") {
    band(length / 2 - 3, length / 2 - 1);
    g.box(length / 2 - 0.3, 0, floor + 0.9, 0.12, w - 0.6, 1.0, 0, PALETTE.trainWindow);
  } else if (t.shape === "double-deck") {
    // Two decks: a low window band between the bogies, a high one along the whole car.
    band(-length / 2 + 4, length / 2 - 4, floor - 0.35);
    band(-length / 2 + 1.2, length / 2 - 1.2, floor + 1.75);
    for (const u of [length / 2 - 0.2, -length / 2 + 0.2]) g.box(u, 0, floor + 1.75, 0.12, w - 0.6, 1.0, 0, PALETTE.trainWindow);
  } else {
    band(-length / 2 + 1.2, length / 2 - 1.2);
    for (const u of [length / 2 - 0.2, -length / 2 + 0.2]) g.box(u, 0, floor + 0.9, 0.12, w - 0.6, 1.0, 0, PALETTE.trainWindow);
  }
  return g.build();
}

/** A wagon's body above its underframe, in the train's colour (white here, tinted per instance). */
function wagonBody(g: GeoBuilder, shape: WagonShape, length: number, w: number, h: number, floor: number): void {
  const L = length - 0.6;
  switch (shape) {
    case "open":
      g.box(0, 0, floor, L, w, h * 0.42, 0, 0xffffff);
      g.box(0, 0, floor + h * 0.42, length - 1.2, w - 0.4, 0.3, 0, PALETTE.trainUnder);
      return;
    case "hopper":
      // Chutes below, a deep body above, sloping ends.
      for (const u of [-L * 0.22, L * 0.22]) g.box(u, 0, floor - 0.5, L * 0.3, w * 0.55, 0.6, 0, PALETTE.trainUnder);
      g.box(0, 0, floor + 0.1, L, w, h * 0.62, 0, 0xffffff);
      g.box(0, 0, floor + 0.1 + h * 0.62, L - 0.6, w - 0.4, 0.2, 0, PALETTE.trainUnder);
      return;
    case "flat":
      // A deck with stakes along both sides.
      g.box(0, 0, floor, L, w, 0.3, 0, 0xffffff);
      for (let u = -L / 2 + 0.6; u <= L / 2 - 0.5; u += L / 5) {
        for (const v of [w / 2 - 0.1, -w / 2 + 0.1]) g.box(u, v, floor + 0.3, 0.16, 0.16, 1.7, 0, PALETTE.trainUnder);
      }
      return;
    case "container":
      g.box(0, 0, floor, L, w, 0.35, 0, PALETTE.trainUnder);
      return;
    case "box":
      g.box(0, 0, floor, L, w, h - floor - 0.25, 0, 0xffffff);
      g.box(0, 0, h - 0.25, L - 0.2, w - 0.2, 0.25, 0, PALETTE.trainRoof);
      // Sliding doors, a shade darker.
      for (const v of [w / 2 + 0.02, -w / 2 - 0.02]) g.box(0, v, floor + 0.2, 3, 0.05, h - floor - 0.7, 0, PALETTE.trainUnder);
      return;
    case "tank": {
      // An octagonal barrel along the wagon, with a dome.
      g.box(0, 0, floor, L, w * 0.8, 0.3, 0, PALETTE.trainUnder);
      const r = w * 0.46;
      const zc = floor + 0.3 + r;
      const n = 8;
      const ring = (u: number) => Array.from({ length: n }, (_, k) => {
        const a = ((k + 0.5) / n) * 2 * Math.PI;
        return [u, Math.cos(a) * r, zc + Math.sin(a) * r] as [number, number, number];
      });
      const [a, b] = [ring(-L / 2 + 0.2), ring(L / 2 - 0.2)];
      for (let k = 0; k < n; k++) {
        const k1 = (k + 1) % n;
        g.quad(a[k], b[k], b[k1], a[k1], 0xffffff);
        g.tri([L / 2 - 0.2, 0, zc], b[k1], b[k], 0xffffff, 0.92);
        g.tri([-L / 2 + 0.2, 0, zc], a[k], a[k1], 0xffffff, 0.92);
      }
      g.box(0, 0, zc + r - 0.1, 1.2, 1.2, 0.6, 0, 0xffffff);
      return;
    }
  }
}

const kindOf = (t: TrainType, car: number): Kind =>
  car === 0 && (t.shape === "loco-hauled" || t.shape === "double-deck" || t.shape === "freight") ? "loco" : t.shape === "freight" ? "wagon" : "car";

/**
 * How a freight train's loads show in its wagons (null: they don't, in closed vans and
 * tanks): a heap rising above the sides, logs between the stakes, or containers.
 */
function loadShape(t: TrainType): { length: number; width: number; base: number; height: number; box: boolean } | null {
  if (t.shape !== "freight" || t.cars < 2) return null;
  const L = t.carLength;
  switch (t.wagon ?? "open") {
    case "open": return { length: L - 1.8, width: t.carWidth - 0.7, base: 1.0 + t.carHeight * 0.42 + 0.3, height: LOAD_HEIGHT, box: false };
    case "hopper": return { length: L - 2.2, width: t.carWidth - 0.8, base: 1.0 + t.carHeight * 0.62 - 0.1, height: LOAD_HEIGHT * 0.9, box: false };
    case "flat": return { length: L - 1.4, width: t.carWidth - 0.6, base: 1.3, height: 1.7, box: false };
    case "container": return { length: L - 1.2, width: t.carWidth - 0.4, base: 1.35, height: 2.6, box: true };
    default: return null;
  }
}

/** Where each vehicle of a stabled consist stands: centred on its `at`, bogie to bogie along the track. */
export function stabledPoses(world: World, st: StabledSpec): Array<{ pose: CarPose; car: number; length: number }> {
  const t = world.tracks.get(st.track)!;
  const prof = world.profiles.get(st.track)!;
  const at = (s: number) => {
    const [x, y] = pointAt(t.path, s);
    return { x, y, z: profileZ(prof, s) };
  };
  const vehicles = stabledVehicles(st);
  const total = vehicles.reduce((a, v) => a + v.length, 0);
  const dir = st.reverse ? -1 : 1;
  let front = st.at + (dir * total) / 2;
  return vehicles.map((v) => {
    const a = at(front - dir * 0.15 * v.length);
    const b = at(front - dir * 0.85 * v.length);
    front -= dir * v.length;
    return {
      car: v.car, length: v.length,
      pose: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2, heading: Math.atan2(a.y - b.y, a.x - b.x), pitch: Math.atan2(a.z - b.z, Math.hypot(a.x - b.x, a.y - b.y)), visible: true },
    };
  });
}

const LOAD_HEIGHT = 1.5;          // m of goods heaped in a full wagon

export class TrainMeshes {
  readonly group = new THREE.Group();
  /** For every train and car: which mesh and instance index draws it. */
  private slots: Array<Array<{ mesh: THREE.InstancedMesh; index: number }>> = [];
  /** Goods in freight wagons: one instance per wagon. */
  private loads: THREE.InstancedMesh | null = null;
  private wagons: Array<{ train: number; car: number; length: number; width: number; base: number; height: number; box: boolean }> = [];
  private goodsColors: THREE.Color[] = [];
  private goodsIds: string[] = [];
  private take: number[] = [];
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler(0, 0, 0, "YZX");
  private p = new THREE.Vector3();
  private one = new THREE.Vector3(1, 1, 1);
  private none = new THREE.Vector3(0, 0, 0);
  private scale = new THREE.Vector3();

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
    // Trains stabled on sidings: the same meshes, placed once.
    const parked: Array<{ mesh: string; index: number; pose: CarPose }> = [];
    const parkedLoads: Array<{ pose: CarPose; load: NonNullable<ReturnType<typeof loadShape>>; color: number }> = [];
    world.layout.stabled.forEach((st) => {
      const t: TrainType = TRAIN_CATALOG[st.train as TrainTypeId];
      for (const { pose, car, length } of stabledPoses(world, st)) {
        const kind = kindOf(t, car);
        const key = `${st.train}/${kind}/${length}`;
        if (!meshes.has(key)) meshes.set(key, { geo: vehicleGeometry(t, kind, length), colors: [], owners: [] });
        const entry = meshes.get(key)!;
        entry.colors.push(new THREE.Color(kind === "loco" && t.shape === "freight" ? PALETTE.freightLoco : st.color ?? t.color));
        entry.owners.push([-1, -1]);
        parked.push({ mesh: key, index: entry.owners.length - 1, pose });
        const load = loadShape(t);
        if (kind === "wagon" && st.load && load) parkedLoads.push({ pose, load, color: parseInt(goodsColor(st.load).slice(1), 16) });
      }
    });
    // Freight wagons carry goods: a heap in the colour of what fills most of each (or containers).
    snapshot.trains.forEach((tr, ti) => {
      const t: TrainType = TRAIN_CATALOG[tr.train as TrainTypeId];
      const load = loadShape(t);
      if (!load) return;
      for (let c = 1; c < tr.cars.length; c++) this.wagons.push({ train: ti, car: c, ...load });
    });
    if (this.wagons.length) {
      const g = new GeoBuilder();
      g.box(0, 0, 0, 1, 1, 1, 0, 0xffffff, 0xd8d8d8);
      this.loads = new THREE.InstancedMesh(g.build(), flatMaterial(), this.wagons.length);
      this.loads.name = "wagon-loads";
      this.loads.castShadow = true;
      this.loads.frustumCulled = false;
      for (let k = 0; k < this.wagons.length; k++) this.loads.setColorAt(k, new THREE.Color(0xffffff));
      this.group.add(this.loads);
    }
    const byKey = new Map<string, THREE.InstancedMesh>();
    for (const [key, { geo, colors, owners }] of meshes) {
      const mesh = new THREE.InstancedMesh(geo, flatMaterial(), owners.length);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;     // instances move; skip stale bounding spheres
      owners.forEach(([ti, c], i) => {
        mesh.setColorAt(i, colors[i]);
        if (ti >= 0) (this.slots[ti] ??= [])[c] = { mesh, index: i };
      });
      byKey.set(key, mesh);
      this.group.add(mesh);
    }
    for (const p of parked) byKey.get(p.mesh)!.setMatrixAt(p.index, this.pose(p.pose, RAIL_TOP));
    if (parkedLoads.length) {
      const g = new GeoBuilder();
      g.box(0, 0, 0, 1, 1, 1, 0, 0xffffff, 0xd8d8d8);
      const mesh = new THREE.InstancedMesh(g.build(), flatMaterial(), parkedLoads.length);
      mesh.name = "stabled-loads";
      mesh.castShadow = true;
      parkedLoads.forEach(({ pose, load, color }, k) => {
        toThree(pose.x, pose.y, pose.z + RAIL_TOP + load.base, this.p);
        this.q.setFromEuler(this.e.set(0, pose.heading, pose.pitch));
        mesh.setMatrixAt(k, this.m.compose(this.p, this.q, this.scale.set(load.length, load.box ? load.height : load.height * 0.8, load.width)));
        mesh.setColorAt(k, new THREE.Color(color));
      });
      this.group.add(mesh);
    }
    this.update(snapshot);
  }

  /** The matrix of a car standing at a pose, raised `lift` above the track. */
  private pose(c: CarPose, lift: number): THREE.Matrix4 {
    toThree(c.x, c.y, c.z + lift, this.p);
    this.q.setFromEuler(this.e.set(0, c.heading, c.pitch));
    return this.m.clone().compose(this.p, this.q, this.one);
  }

  update(snapshot: SimSnapshot): void {
    snapshot.trains.forEach((tr, ti) => {
      tr.cars.forEach((car, c) => {
        const slot = this.slots[ti][c];
        toThree(car.x, car.y, car.z + RAIL_TOP, this.p);
        this.q.setFromEuler(this.e.set(0, car.heading, car.pitch));
        // Cars out past the board's edge (or off it altogether) are scaled to nothing.
        slot.mesh.setMatrixAt(slot.index, this.m.compose(this.p, this.q, car.visible ? this.one : this.none));
      });
    });
    this.updateLoads(snapshot);
    for (const child of this.group.children) (child as THREE.InstancedMesh).instanceMatrix.needsUpdate = true;
  }

  /** Each wagon filled in turn, front to back, from what its train carries. */
  private updateLoads(snapshot: SimSnapshot): void {
    const mesh = this.loads;
    if (!mesh) return;
    const f = snapshot.freight;
    if (f.goods !== this.goodsIds) {
      this.goodsIds = f.goods;
      this.goodsColors = f.goods.map((g) => new THREE.Color(goodsColor(g)));
    }
    let train = -1;
    this.wagons.forEach((w, k) => {
      if (w.train !== train) {
        train = w.train;
        this.take = (f.trains[train] ?? []).slice();
      }
      // Up to a wagonful, goods by goods.
      let left = WAGON_LOADS;
      let most = -1;
      let mostAmount = 0;
      for (let g = 0; g < this.take.length && left > 0; g++) {
        const n = Math.min(left, this.take[g]);
        if (n <= 0) continue;
        this.take[g] -= n;
        left -= n;
        if (n > mostAmount) { mostAmount = n; most = g; }
      }
      const fill = (WAGON_LOADS - left) / WAGON_LOADS;
      const car = snapshot.trains[w.train].cars[w.car];
      if (fill <= 0 || !car.visible) {
        mesh.setMatrixAt(k, this.m.compose(this.p.set(0, -100, 0), this.q.identity(), this.none));
        return;
      }
      toThree(car.x, car.y, car.z + RAIL_TOP + w.base, this.p);
      this.q.setFromEuler(this.e.set(0, car.heading, car.pitch));
      // Heaps rise as they fill; containers stand full height, one per half wagon.
      if (w.box) this.scale.set(w.length * (fill > 0.5 ? 1 : 0.48), w.height, w.width);
      else this.scale.set(w.length, w.height * Math.max(0.15, fill), w.width);
      mesh.setMatrixAt(k, this.m.compose(this.p, this.q, this.scale));
      mesh.setColorAt(k, this.goodsColors[most]);
    });
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    for (const child of this.group.children) {
      const mesh = child as THREE.InstancedMesh;
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
  }
}
