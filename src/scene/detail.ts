// Distance culling for small things. Each instanced mesh registered here keeps the
// full list of its instances and draws only those that would come out at least
// `minPixels` tall on screen, copied to the front of its buffers: lamp posts,
// benches and sleepers far away, and windows by day (lit windows always show, the
// city at night is mostly them). Recomputed only when the camera has moved a few
// metres, the threshold or the screen size changed, or the windows lit up or went dark.

import * as THREE from "three";

type Entry = {
  mesh: THREE.InstancedMesh;
  matrices: Float32Array;          // every instance's matrix, 16 floats each
  colors: Float32Array | null;     // and colour, 3 each
  at: Float32Array;                // positions in the three.js frame, 3 each
  size: Float32Array;              // what decides how small it looks (m)
  placements: Int32Array | null;   // every instance's scenery index, for picking
  picks: Int32Array | null;        // the drawn instances' (mesh.userData.placements; first `count` valid)
  glow: boolean;                   // windows and lamps: all drawn while lit
  shown: Int32Array;               // the instances drawn now, in order
  count: number;                   // how many of shown are in use
};

const MOVE = 2;                    // m the camera moves before culling again
/** m: anything at least this big (trees, buildings) is always drawn, whatever the setting. */
export const SMALL = 3;

export class DetailCuller {
  private entries: Entry[] = [];
  private minPixels = 0;
  private last = new THREE.Vector3(Infinity, Infinity, Infinity);
  private lastFocal = 0;
  private lastLit = false;
  private dirty = true;
  private sel = new Int32Array(0);

  /**
   * Takes over an instanced mesh whose instances are all set: `size` is one value for
   * all of them or one per instance; `glow` marks a mesh of lit windows or lamps.
   */
  add(mesh: THREE.InstancedMesh, size: number | ArrayLike<number>, glow = false): void {
    const n = mesh.count;
    const matrices = (mesh.instanceMatrix.array as Float32Array).slice(0, n * 16);
    const colors = mesh.instanceColor ? (mesh.instanceColor.array as Float32Array).slice(0, n * 3) : null;
    const at = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) at.set(matrices.subarray(i * 16 + 12, i * 16 + 15), i * 3);
    const sizes = typeof size === "number" ? new Float32Array(n).fill(size) : Float32Array.from(size);
    const placements = Array.isArray(mesh.userData.placements) ? Int32Array.from(mesh.userData.placements as number[]) : null;
    const picks = placements ? placements.slice() : null;
    if (picks) mesh.userData.placements = picks;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor?.setUsage(THREE.DynamicDrawUsage);
    const shown = Int32Array.from({ length: n }, (_, i) => i);
    this.entries.push({ mesh, matrices, colors, at, size: sizes, placements, picks, glow, shown, count: n });
    if (this.sel.length < n) this.sel = new Int32Array(n);
    this.dirty = true;
  }

  /** Smallest on-screen size (px) to draw; 0 draws everything. */
  setMinPixels(px: number): void {
    if (px === this.minPixels) return;
    this.minPixels = px;
    this.dirty = true;
  }

  /**
   * Per frame: `focal` is the screen's pixels per metre at 1 m from the camera (its
   * height in px over 2·tan(fov/2)); `lit` whether windows glow. True if anything changed.
   */
  update(camera: THREE.Camera, focal: number, lit: boolean): boolean {
    const p = camera.position;
    if (!this.dirty && p.distanceToSquared(this.last) < MOVE * MOVE && focal === this.lastFocal && lit === this.lastLit) return false;
    this.dirty = false;
    this.last.copy(p);
    this.lastFocal = focal;
    this.lastLit = lit;
    // Something of size s comes out s·focal/d px tall at distance d: drawn while d ≤ s·focal/minPixels.
    const k = this.minPixels > 0 ? focal / this.minPixels : Infinity;
    let changed = false;
    for (const e of this.entries) {
      const total = e.size.length;
      const all = k === Infinity || (e.glow && lit);
      let n = 0;
      if (all) {
        for (let i = 0; i < total; i++) this.sel[n++] = i;
      } else {
        for (let i = 0; i < total; i++) {
          const dx = e.at[i * 3] - p.x, dy = e.at[i * 3 + 1] - p.y, dz = e.at[i * 3 + 2] - p.z;
          const far = e.size[i] * k;
          if (e.size[i] >= SMALL || dx * dx + dy * dy + dz * dz <= far * far) this.sel[n++] = i;
        }
      }
      if (n === e.count && sameStart(this.sel, e.shown, n)) continue;
      changed = true;
      this.apply(e, n);
    }
    return changed;
  }

  /** Copies the selected instances to the front of the mesh's buffers. */
  private apply(e: Entry, n: number): void {
    const { mesh } = e;
    const m = mesh.instanceMatrix.array as Float32Array;
    const c = mesh.instanceColor?.array as Float32Array | undefined;
    for (let j = 0; j < n; j++) {
      const i = this.sel[j];
      e.shown[j] = i;
      m.set(e.matrices.subarray(i * 16, i * 16 + 16), j * 16);
      if (c && e.colors) c.set(e.colors.subarray(i * 3, i * 3 + 3), j * 3);
      if (e.picks) e.picks[j] = e.placements![i];
    }
    e.count = n;
    mesh.count = n;
    mesh.visible = n > 0;
    mesh.instanceMatrix.clearUpdateRanges();
    mesh.instanceMatrix.addUpdateRange(0, n * 16);
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) {
      mesh.instanceColor.clearUpdateRanges();
      mesh.instanceColor.addUpdateRange(0, n * 3);
      mesh.instanceColor.needsUpdate = true;
    }
  }
}

function sameStart(a: Int32Array, b: Int32Array, n: number): boolean {
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** What decides how small a thing looks: its middle dimension (a lamp post is as thin as its post). */
export function featureSize(min: ArrayLike<number>, max: ArrayLike<number>): number {
  const d = [max[0] - min[0], max[1] - min[1], max[2] - min[2]].sort((a, b) => a - b);
  return Math.max(d[1], 0.05);
}

/** A typical panel's size (m) in a triangle list (two triangles per panel): windows, lamp heads. */
export function panelSize(pos: ArrayLike<number>): number {
  let area = 0;
  const tris = pos.length / 9;
  for (let t = 0; t < tris; t++) {
    const i = t * 9;
    const ux = pos[i + 3] - pos[i], uy = pos[i + 4] - pos[i + 1], uz = pos[i + 5] - pos[i + 2];
    const vx = pos[i + 6] - pos[i], vy = pos[i + 7] - pos[i + 1], vz = pos[i + 8] - pos[i + 2];
    area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
  }
  return tris ? Math.sqrt((2 * area) / tris) : 0;
}
