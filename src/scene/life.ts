// Cosmetic life (§8.5): chimney smoke puffs, and the minimalist person figure
// shared by everyone the people sim moves. Purely visual and seeded.

import * as THREE from "three";
import { PALETTE } from "./palette";
import { GeoBuilder } from "./geo";

const PUFFS = 5;
const PUFF_LIFE = 7;            // s

/** A person, minimalist: a body block (tinted per instance) and a head. Facing +x, standing on z = 0. */
export function personGeometry(): THREE.BufferGeometry {
  const g = new GeoBuilder();
  g.box(0, 0, 0, 0.35, 0.5, 1.15, 0, 0xffffff);
  g.box(0, 0, 1.2, 0.3, 0.3, 0.35, 0, PALETTE.skin);
  return g.build();
}

export class Life {
  readonly group = new THREE.Group();
  private smokeMesh: THREE.InstancedMesh | null = null;
  private chimneys: THREE.Vector3[];
  private time = 0;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private p = new THREE.Vector3();
  private s = new THREE.Vector3();

  constructor(chimneys: THREE.Vector3[]) {
    this.chimneys = chimneys;
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
    this.update(0);
  }

  update(dt: number): void {
    this.time += dt;
    if (!this.smokeMesh) return;
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

  dispose(): void {
    if (!this.smokeMesh) return;
    this.smokeMesh.geometry.dispose();
    (this.smokeMesh.material as THREE.Material).dispose();
  }
}
