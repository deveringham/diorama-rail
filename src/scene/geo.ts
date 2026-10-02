// Scene geometry helpers: the single model→three coordinate mapping (toThree)
// and a small builder that collects flat-shaded, vertex-coloured triangles in
// model coordinates (x east, y north, z up) and bakes them into a BufferGeometry.

import * as THREE from "three";

export type P3 = [number, number, number];

/** Model (x, y, z) → three.js (x, z, −y). The only place the two frames meet. */
export function toThree(x: number, y: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(x, z, -y);
}

/** A model-frame yaw (CCW from +x around +z) is a three.js rotation about +y. */
export const yawToThree = (heading: number) => heading;

/** Shared material for nearly everything: colour lives in vertex colours. */
export const flatMaterial = () => new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });

const tmp = new THREE.Color();

/** Linear-space RGB of an sRGB hex colour, optionally scaled (for subtle variation). */
export function rgb(hex: number, k = 1): [number, number, number] {
  tmp.setHex(hex);
  return [tmp.r * k, tmp.g * k, tmp.b * k];
}

export class GeoBuilder {
  private pos: number[] = [];
  private col: number[] = [];

  get triangles(): number {
    return this.pos.length / 9;
  }

  /** One triangle, counter-clockwise when seen from its front side. */
  tri(a: P3, b: P3, c: P3, color: number, k = 1): void {
    const [r, g, bl] = rgb(color, k);
    for (const p of [a, b, c]) {
      this.pos.push(p[0], p[2], -p[1]);
      this.col.push(r, g, bl);
    }
  }

  /** Quad a-b-c-d, counter-clockwise from the front. */
  quad(a: P3, b: P3, c: P3, d: P3, color: number, k = 1): void {
    this.tri(a, b, c, color, k);
    this.tri(a, c, d, color, k);
  }

  /**
   * Box standing on z0, centred on (cx, cy), `length` along `yaw`, `width` across.
   * The bottom face is skipped (it is never seen). `top` overrides the top colour.
   */
  box(cx: number, cy: number, z0: number, length: number, width: number, height: number, yaw: number, color: number, top = color): void {
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const corner = (u: number, v: number, z: number): P3 => [cx + u * c - v * s, cy + u * s + v * c, z];
    const l = length / 2;
    const w = width / 2;
    const z1 = z0 + height;
    const b = [corner(-l, -w, z0), corner(l, -w, z0), corner(l, w, z0), corner(-l, w, z0)];
    const t = [corner(-l, -w, z1), corner(l, -w, z1), corner(l, w, z1), corner(-l, w, z1)];
    this.quad(t[0], t[1], t[2], t[3], top);
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      this.quad(b[i], b[j], t[j], t[i], color);
    }
  }

  /** Gable roof over a w×d rectangle: ridge along local x, eaves at z0, ridge at z0 + rise. */
  gable(cx: number, cy: number, z0: number, length: number, width: number, rise: number, yaw: number, color: number, overhang = 0.4): void {
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const p = (u: number, v: number, z: number): P3 => [cx + u * c - v * s, cy + u * s + v * c, z];
    const l = length / 2 + overhang;
    const w = width / 2 + overhang;
    const r0 = p(-l, 0, z0 + rise);
    const r1 = p(l, 0, z0 + rise);
    this.quad(p(-l, -w, z0), p(l, -w, z0), r1, r0, color);
    this.quad(p(l, w, z0), p(-l, w, z0), r0, r1, color, 0.9);
    this.tri(p(l, -w, z0), p(l, w, z0), r1, color, 0.95);
    this.tri(p(-l, w, z0), p(-l, -w, z0), r0, color, 0.95);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.col, 3));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}
