// Seeded 2D simplex noise and fractal sum (fbm), used for terrain relief and
// for subtle colour variation. Classic Gustavson simplex, permutation from rng.

import { mulberry32 } from "./rng";

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;
const GRAD: ReadonlyArray<readonly [number, number]> = [
  [1, 1], [-1, 1], [1, -1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1],
];

export type Noise2 = (x: number, y: number) => number;

/** Returns simplex noise in roughly [-1, 1]. */
export function simplex2(seed: number): Noise2 {
  const r = mulberry32(seed);
  const p = new Uint8Array(256).map((_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  const perm = new Uint8Array(512).map((_, i) => p[i & 255]);

  return (x, y) => {
    const s = (x + y) * F2;
    const i = Math.floor(x + s);
    const j = Math.floor(y + s);
    const t = (i + j) * G2;
    const x0 = x - (i - t);
    const y0 = y - (j - t);
    const i1 = x0 > y0 ? 1 : 0;
    const j1 = 1 - i1;
    const corners: Array<[number, number, number]> = [
      [x0, y0, perm[(i & 255) + perm[j & 255]]],
      [x0 - i1 + G2, y0 - j1 + G2, perm[((i + i1) & 255) + perm[(j + j1) & 255]]],
      [x0 - 1 + 2 * G2, y0 - 1 + 2 * G2, perm[((i + 1) & 255) + perm[(j + 1) & 255]]],
    ];
    let n = 0;
    for (const [cx, cy, h] of corners) {
      const tt = 0.5 - cx * cx - cy * cy;
      if (tt > 0) {
        const g = GRAD[h & 7];
        n += tt * tt * tt * tt * (g[0] * cx + g[1] * cy);
      }
    }
    return 70 * n;
  };
}

/** Fractal Brownian motion: octaves of noise, each twice the frequency, half the amplitude. */
export function fbm(noise: Noise2, x: number, y: number, octaves = 4): number {
  let sum = 0;
  let amp = 1;
  let freq = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise(x * freq, y * freq);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}
