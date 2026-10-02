// Poisson-disc sampling (Bridson 2007): points no closer than `spacing`,
// filling a disc evenly. Used for town houses, forests and scatter trees.

import type { Rng } from "./rng";
import type { V2 } from "./vec";

const CANDIDATES = 20;

/**
 * Samples inside the axis-aligned box [x0,x1]×[y0,y1], keeping only points for
 * which `inside` returns true. Deterministic for a given rng.
 */
export function poissonDisc(
  r: Rng, x0: number, y0: number, x1: number, y1: number, spacing: number,
  inside: (x: number, y: number) => boolean = () => true,
): V2[] {
  const cell = spacing / Math.SQRT2;
  const gw = Math.max(1, Math.ceil((x1 - x0) / cell));
  const gh = Math.max(1, Math.ceil((y1 - y0) / cell));
  const grid = new Int32Array(gw * gh).fill(-1);
  const pts: V2[] = [];
  const active: number[] = [];
  const gridIndex = (x: number, y: number) =>
    Math.min(gh - 1, Math.floor((y - y0) / cell)) * gw + Math.min(gw - 1, Math.floor((x - x0) / cell));

  const fits = (x: number, y: number): boolean => {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    const gx = Math.floor((x - x0) / cell);
    const gy = Math.floor((y - y0) / cell);
    for (let j = Math.max(0, gy - 2); j <= Math.min(gh - 1, gy + 2); j++) {
      for (let i = Math.max(0, gx - 2); i <= Math.min(gw - 1, gx + 2); i++) {
        const k = grid[j * gw + i];
        if (k >= 0 && Math.hypot(pts[k][0] - x, pts[k][1] - y) < spacing) return false;
      }
    }
    return true;
  };
  const add = (x: number, y: number) => {
    grid[gridIndex(x, y)] = pts.length;
    active.push(pts.length);
    pts.push([x, y]);
  };

  add(x0 + r() * (x1 - x0), y0 + r() * (y1 - y0));
  while (active.length > 0) {
    const ai = Math.floor(r() * active.length);
    const [px, py] = pts[active[ai]];
    let found = false;
    for (let c = 0; c < CANDIDATES; c++) {
      const a = r() * 2 * Math.PI;
      const d = spacing * (1 + r());
      const x = px + Math.cos(a) * d;
      const y = py + Math.sin(a) * d;
      if (fits(x, y)) {
        add(x, y);
        found = true;
        break;
      }
    }
    if (!found) active.splice(ai, 1);
  }
  return pts.filter(([x, y]) => inside(x, y));
}
