// Fewer cross-sections where nothing bends: roads, tracks, walkways and bridges are
// sampled every metre or two so curves and gradients come out smooth, but along a
// straight, evenly graded stretch most of those samples add triangles and nothing
// else. keepPoints picks the samples that matter.

/** How far (m, sideways or in height) a dropped sample may lie from the line drawn instead. */
export const SIMPLIFY_TOL = 0.03;
/** No stretch between kept samples is longer than this (m). */
const MAX_RUN = 60;

/**
 * Indices of the samples to keep, in order: the first and last, every one `must`
 * names, and enough others that each dropped sample lies within `tol` of the
 * straight line between the kept samples either side of it (sideways in plan, and
 * in height at the matching point along it).
 */
export function keepPoints(
  x: ArrayLike<number>, y: ArrayLike<number>, z: ArrayLike<number>,
  must?: (i: number) => boolean, tol = SIMPLIFY_TOL,
): number[] {
  const n = x.length;
  if (n <= 2) return Array.from({ length: n }, (_, i) => i);
  // Whether every sample strictly between a and b lies near the line a→b.
  const fits = (a: number, b: number): boolean => {
    const dx = x[b] - x[a], dy = y[b] - y[a];
    const len2 = dx * dx + dy * dy;
    if (len2 > MAX_RUN * MAX_RUN) return false;
    for (let k = a + 1; k < b; k++) {
      const ex = x[k] - x[a], ey = y[k] - y[a];
      if (len2 < 1e-12) {
        if (Math.hypot(ex, ey, z[k] - z[a]) > tol) return false;
        continue;
      }
      const t = (ex * dx + ey * dy) / len2;
      if (t < -1e-6 || t > 1 + 1e-6) return false;              // doubles back
      if (Math.abs(ex * dy - ey * dx) > tol * Math.sqrt(len2)) return false;
      if (Math.abs(z[k] - (z[a] + t * (z[b] - z[a]))) > tol) return false;
    }
    return true;
  };
  const out = [0];
  let a = 0;
  for (let b = 2; b < n; b++) {
    // Extend the run from a over b − 1, unless b − 1 has to stay or the line no longer fits.
    if (must?.(b - 1) || !fits(a, b)) {
      a = b - 1;
      out.push(a);
    }
  }
  out.push(n - 1);
  return out;
}
