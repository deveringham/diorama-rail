// Plane polygons and polylines on plain [x, y] tuples: point-in-polygon, distance
// to a polyline, bounding boxes, and a coarse grid index so many polygons can be
// tested against many points quickly (ground cover, scatter areas, water).

import type { V2 } from "./vec";

export type Box2 = { x0: number; y0: number; x1: number; y1: number };

export function bboxOf(pts: readonly V2[], pad = 0): Box2 {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
}

export const inBox = (b: Box2, x: number, y: number) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1;

/** Even-odd rule: whether (x, y) lies inside the closed polygon. */
export function insidePolygon(poly: readonly V2[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Distance from (x, y) to the segment a–b, and how far along it (0..1) the nearest point lies. */
export function segmentDistance(a: V2, b: V2, x: number, y: number): { d: number; t: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const L2 = dx * dx + dy * dy;
  const t = L2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L2)) : 0;
  return { d: Math.hypot(x - (a[0] + dx * t), y - (a[1] + dy * t)), t };
}

/** Distance from (x, y) to an open polyline (or a closed ring with `closed`). */
export function polylineDistance(pts: readonly V2[], x: number, y: number, closed = false): number {
  let best = Infinity;
  const n = pts.length;
  if (n === 1) return Math.hypot(x - pts[0][0], y - pts[0][1]);
  for (let i = 0; i + 1 < n + (closed ? 1 : 0); i++) {
    const d = segmentDistance(pts[i], pts[(i + 1) % n], x, y).d;
    if (d < best) best = d;
  }
  return best;
}

/** Signed area (positive when counter-clockwise). */
export function polygonArea(poly: readonly V2[]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j][0] - poly[i][0]) * (poly[j][1] + poly[i][1]);
  return a / 2;
}

/**
 * A coarse grid over polygons' bounding boxes: `find` returns the last polygon (in
 * insertion order) containing the point, so later ones lie on top of earlier ones.
 */
export class PolygonIndex<T> {
  private cells = new Map<number, number[]>();
  private items: Array<{ poly: readonly V2[]; box: Box2; value: T }> = [];
  constructor(private cell = 50) {}

  add(poly: readonly V2[], value: T): void {
    const box = bboxOf(poly);
    const k = this.items.push({ poly, box, value }) - 1;
    for (let i = Math.floor(box.x0 / this.cell); i <= Math.floor(box.x1 / this.cell); i++) {
      for (let j = Math.floor(box.y0 / this.cell); j <= Math.floor(box.y1 / this.cell); j++) {
        const key = (i + 32768) * 65536 + (j + 32768);
        const list = this.cells.get(key);
        if (list) list.push(k);
        else this.cells.set(key, [k]);
      }
    }
  }

  get size(): number {
    return this.items.length;
  }

  find(x: number, y: number): T | undefined {
    const list = this.cells.get((Math.floor(x / this.cell) + 32768) * 65536 + (Math.floor(y / this.cell) + 32768));
    if (!list) return undefined;
    for (let n = list.length - 1; n >= 0; n--) {
      const it = this.items[list[n]];
      if (inBox(it.box, x, y) && insidePolygon(it.poly, x, y)) return it.value;
    }
    return undefined;
  }
}
