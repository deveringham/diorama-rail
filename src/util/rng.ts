// Seeded randomness. Everything that looks random (terrain noise, scenery,
// people) draws from these generators so a layout + seed always renders the same.

export type Rng = () => number;

/** mulberry32: tiny, fast, good enough for visual randomness. Returns [0, 1). */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a string hash, used to derive independent streams from one seed. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** An independent stream for one purpose, e.g. rng(seed, "forest-2"). */
export function rng(seed: number, salt = ""): Rng {
  return mulberry32((seed ^ hashString(salt)) >>> 0);
}

export const range = (r: Rng, a: number, b: number): number => a + (b - a) * r();
export const pick = <T>(r: Rng, items: readonly T[]): T => items[Math.floor(r() * items.length)];
