// Cosmetic "Wimmelbild" life (§8.5): people standing and strolling on platforms,
// boarding dwelling trains and being replaced, and chimney smoke puffs. Purely
// visual and seeded; it reads sim snapshots but never affects the sim.

import * as THREE from "three";
import type { World } from "../model/build";
import type { SimSnapshot } from "../sim/sim";
import { PLATFORM_OFFSET, PLATFORM_WIDTH } from "../model/scenery";
import { PALETTE } from "./palette";
import { GeoBuilder, flatMaterial, toThree } from "./geo";
import { frameAt } from "./trackMesh";
import { rng, range, pick, type Rng } from "../util/rng";

const PLATFORM_TOP = 0.9;
const WALKER_SHARE = 0.25;
const BOARD_SHARE = 0.3;
const BOARD_TIME = 4;           // s to walk to the train and vanish
const RESPAWN_DELAY = [3, 12];  // s after departure before replacements appear
const PUFFS = 5;
const PUFF_LIFE = 7;            // s

type Person = {
  station: string;
  x: number; y: number; z: number;     // platform-local origin (at s, on the platform centre line)
  hx: number; hy: number;              // unit vector along the platform
  nx: number; ny: number;              // unit vector toward the track
  along: number; across: number;       // current offsets (m)
  home: number; range: number; speed: number; dir: number;
  mode: "stand" | "walk" | "board" | "gone";
  timer: number;
};

/** A person, minimalist: a body block (tinted per instance) and a head. Facing +x, standing on z = 0. */
export function personGeometry(): THREE.BufferGeometry {
  const g = new GeoBuilder();
  g.box(0, 0, 0, 0.35, 0.5, 1.15, 0, 0xffffff);
  g.box(0, 0, 1.2, 0.3, 0.3, 0.35, 0, PALETTE.skin);
  return g.build();
}

export class Life {
  readonly group = new THREE.Group();
  private people: Person[] = [];
  private peopleMesh: THREE.InstancedMesh | null = null;
  private smokeMesh: THREE.InstancedMesh | null = null;
  private chimneys: THREE.Vector3[];
  private r: Rng;
  private dwelling = new Set<string>();
  private spare = new Set<string>();
  private time = 0;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private p = new THREE.Vector3();
  private s = new THREE.Vector3();
  private up = new THREE.Vector3(0, 1, 0);

  constructor(world: World, chimneys: THREE.Vector3[]) {
    this.r = rng(world.layout.seed, "life");
    this.chimneys = chimneys;
    for (const st of world.stations) {
      for (const pp of st.people) {
        const f = frameAt(world, st.track, pp.s);
        const off = pp.side * PLATFORM_OFFSET;
        const nx = -Math.sin(f.h) * pp.side, ny = Math.cos(f.h) * pp.side;   // away from track
        const roam = Math.max(0, Math.min(10, (st.s1 - st.s0) / 2 - Math.abs(pp.s - (st.s0 + st.s1) / 2) - 1));
        const walker = roam > 2 && this.r() < WALKER_SHARE;
        this.people.push({
          station: st.id, x: f.x - Math.sin(f.h) * off, y: f.y + Math.cos(f.h) * off, z: f.z + PLATFORM_TOP,
          hx: Math.cos(f.h), hy: Math.sin(f.h), nx: -nx, ny: -ny,
          along: 0, across: (pp.lateral - 0.5) * -(PLATFORM_WIDTH - 1), home: 0,
          range: roam,
          speed: range(this.r, 0.6, 1.2), dir: this.r() < 0.5 ? 1 : -1,
          mode: walker ? "walk" : "stand", timer: 0,
        });
      }
    }
    if (this.people.length) {
      this.peopleMesh = new THREE.InstancedMesh(personGeometry(), flatMaterial(), this.people.length);
      const c = new THREE.Color();
      this.people.forEach((_, i) => this.peopleMesh!.setColorAt(i, c.setHex(pick(this.r, PALETTE.people))));
      this.peopleMesh.name = "people";
      this.peopleMesh.castShadow = true;
      this.peopleMesh.frustumCulled = false;
      this.group.add(this.peopleMesh);
    }
    if (chimneys.length) {
      const geo = new THREE.IcosahedronGeometry(0.9, 0);
      const n = geo.getAttribute("position").count;
      geo.setAttribute("color", new THREE.Float32BufferAttribute(new Array(n * 3).fill(1), 3));
      geo.computeVertexNormals();
      const mat = new THREE.MeshLambertMaterial({ color: PALETTE.smoke, vertexColors: true, flatShading: true, transparent: true, opacity: 0.85 });
      this.smokeMesh = new THREE.InstancedMesh(geo, mat, chimneys.length * PUFFS);
      this.smokeMesh.name = "smoke";
      this.smokeMesh.frustumCulled = false;
      this.group.add(this.smokeMesh);
    }
    this.update(0, null);
  }

  update(dt: number, snap: SimSnapshot | null): void {
    this.time += dt;
    // Which stations have a train dwelling right now? (two sets swapped, no allocation)
    const now = this.spare;
    now.clear();
    if (snap) for (const t of snap.trains) if (t.phase === "dwelling" && t.atStation) now.add(t.atStation);
    for (const st of now) if (!this.dwelling.has(st)) this.board(st);
    for (const st of this.dwelling) if (!now.has(st)) this.respawnLater(st);
    this.spare = this.dwelling;
    this.dwelling = now;

    if (this.peopleMesh) {
      this.people.forEach((pp, i) => {
        this.stepPerson(pp, dt);
        const visible = pp.mode !== "gone";
        toThree(pp.x + pp.hx * pp.along + pp.nx * pp.across, pp.y + pp.hy * pp.along + pp.ny * pp.across, pp.z, this.p);
        this.q.setFromAxisAngle(this.up, Math.atan2(pp.hy, pp.hx));
        this.s.setScalar(visible ? 1 : 0);
        this.peopleMesh!.setMatrixAt(i, this.m.compose(this.p, this.q, this.s));
      });
      this.peopleMesh.instanceMatrix.needsUpdate = true;
    }
    if (this.smokeMesh) {
      this.chimneys.forEach((c, k) => {
        for (let j = 0; j < PUFFS; j++) {
          const age = (this.time + (j * PUFF_LIFE) / PUFFS + k * 1.37) % PUFF_LIFE;
          const u = age / PUFF_LIFE;
          this.p.set(c.x + u * 3.5, c.y + 0.5 + age * 1.3, c.z - u * 1.5);
          this.s.setScalar(0.4 + Math.sin(Math.PI * u) * 1.2);
          this.smokeMesh!.setMatrixAt(k * PUFFS + j, this.m.compose(this.p, this.q.identity(), this.s));
        }
      });
      this.smokeMesh.instanceMatrix.needsUpdate = true;
    }
  }

  private stepPerson(pp: Person, dt: number): void {
    if (pp.mode === "walk") {
      pp.along += pp.dir * pp.speed * dt;
      if (Math.abs(pp.along - pp.home) > pp.range) pp.dir = -pp.dir;
    } else if (pp.mode === "board") {
      pp.timer -= dt;
      pp.across += (PLATFORM_WIDTH / 2 / BOARD_TIME) * dt;
      if (pp.timer <= 0) pp.mode = "gone";
    } else if (pp.mode === "gone" && pp.timer > 0) {
      pp.timer -= dt;
      if (pp.timer <= 0) {
        // A new passenger appears somewhere else on the platform.
        pp.along = range(this.r, -pp.range, pp.range);
        pp.across = range(this.r, -1.2, 1.2);
        pp.mode = pp.range > 2 && this.r() < WALKER_SHARE ? "walk" : "stand";
      }
    }
  }

  private board(station: string): void {
    for (const pp of this.people) {
      if (pp.station === station && pp.mode !== "gone" && this.r() < BOARD_SHARE) {
        pp.mode = "board";
        pp.timer = BOARD_TIME;
      }
    }
  }

  private respawnLater(station: string): void {
    for (const pp of this.people) {
      if (pp.station === station && pp.mode === "gone") pp.timer = range(this.r, RESPAWN_DELAY[0], RESPAWN_DELAY[1]);
    }
  }

  dispose(): void {
    for (const mesh of [this.peopleMesh, this.smokeMesh]) {
      if (!mesh) continue;
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
  }
}
