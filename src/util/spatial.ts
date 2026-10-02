// A uniform-grid spatial hash over points. Used for track samples (conflicts,
// corridor shaping, scenery exclusion, trackAt queries) and placed buildings.

export class SpatialHash<T> {
  private cells = new Map<number, T[]>();
  constructor(private cell: number) {}

  private key(ix: number, iy: number): number {
    return (ix + 32768) * 65536 + (iy + 32768);
  }

  insert(x: number, y: number, item: T): void {
    const k = this.key(Math.floor(x / this.cell), Math.floor(y / this.cell));
    const list = this.cells.get(k);
    if (list) list.push(item);
    else this.cells.set(k, [item]);
  }

  /** Calls fn for every item whose cell overlaps the square around (x, y) of half-size r. */
  near(x: number, y: number, r: number, fn: (item: T) => void): void {
    const x0 = Math.floor((x - r) / this.cell);
    const x1 = Math.floor((x + r) / this.cell);
    const y0 = Math.floor((y - r) / this.cell);
    const y1 = Math.floor((y + r) / this.cell);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iy = y0; iy <= y1; iy++) {
        const list = this.cells.get(this.key(ix, iy));
        if (list) for (const item of list) fn(item);
      }
    }
  }
}
