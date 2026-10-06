// Graphics performance pieces: dropping samples a straight line can stand in for,
// the quality settings and their parsing, distance culling of small things, and the
// shader patch that lets one draw call colour an object's own and tinted parts.

import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { keepPoints, SIMPLIFY_TOL } from "../src/scene/simplify";
import { PRESETS, presetOf, lower, sanitize, initialQuality, serialize, type Quality } from "../src/scene/quality";
import { DetailCuller, featureSize, panelSize } from "../src/scene/detail";
import { bodyGeometry, TINT_COLOR_VERTEX } from "../src/scene/sceneryMesh";

/** Distance from (px, py) to segment a–b in plan, and the height error there. */
function deviation(x: number[], y: number[], z: number[], a: number, b: number, k: number): [number, number] {
  const dx = x[b] - x[a], dy = y[b] - y[a];
  const L2 = dx * dx + dy * dy;
  const t = Math.max(0, Math.min(1, ((x[k] - x[a]) * dx + (y[k] - y[a]) * dy) / L2));
  return [Math.hypot(x[a] + t * dx - x[k], y[a] + t * dy - y[k]), Math.abs(z[a] + t * (z[b] - z[a]) - z[k])];
}

describe("keepPoints", () => {
  it("keeps only the ends of a straight, evenly graded line", () => {
    const n = 41;
    const x = Array.from({ length: n }, (_, i) => i), y = x.map(() => 5), z = x.map((v) => 3 + v * 0.02);
    expect(keepPoints(x, y, z)).toEqual([0, n - 1]);
  });

  it("never lets a stretch run longer than 60 m", () => {
    const x = Array.from({ length: 201 }, (_, i) => i), y = x.map(() => 0), z = x.map(() => 0);
    const keep = keepPoints(x, y, z);
    for (let i = 0; i + 1 < keep.length; i++) expect(x[keep[i + 1]] - x[keep[i]]).toBeLessThanOrEqual(60);
  });

  it("keeps every dropped point of a curve and a hump within the tolerance", () => {
    const n = 200;
    const x: number[] = [], y: number[] = [], z: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = i / 40;                           // a 40 m-radius arc, 1 m apart
      x.push(40 * Math.sin(a));
      y.push(40 * (1 - Math.cos(a)));
      z.push(2 * Math.exp(-(((i - 120) / 15) ** 2)));
    }
    const keep = keepPoints(x, y, z);
    expect(keep.length).toBeLessThan(n / 2);
    expect(keep[0]).toBe(0);
    expect(keep[keep.length - 1]).toBe(n - 1);
    for (let j = 0; j + 1 < keep.length; j++) {
      for (let k = keep[j] + 1; k < keep[j + 1]; k++) {
        const [lat, dz] = deviation(x, y, z, keep[j], keep[j + 1], k);
        expect(lat).toBeLessThanOrEqual(SIMPLIFY_TOL + 1e-9);
        expect(dz).toBeLessThanOrEqual(SIMPLIFY_TOL + 1e-9);
      }
    }
  });

  it("keeps the points it is told to", () => {
    const x = Array.from({ length: 30 }, (_, i) => i), y = x.map(() => 0), z = x.map(() => 0);
    expect(keepPoints(x, y, z, (i) => i === 7 || i === 19)).toEqual([0, 7, 19, 29]);
  });

  it("keeps a point where the line doubles back", () => {
    const x = [0, 1, 2, 1, 0], y = [0, 0, 0, 0, 0], z = [0, 0, 0, 0, 0];
    expect(keepPoints(x, y, z)).toContain(2);
  });
});

describe("quality settings", () => {
  it("recognises each preset and anything else as custom", () => {
    for (const p of ["low", "medium", "high"] as const) expect(presetOf({ ...PRESETS[p] })).toBe(p);
    expect(presetOf({ ...PRESETS.high, fpsCap: 30 })).toBe("custom");
  });

  it("steps down one preset at a time", () => {
    expect(lower("high")).toBe("medium");
    expect(lower("custom")).toBe("medium");
    expect(lower("medium")).toBe("low");
    expect(lower("low")).toBeNull();
  });

  it("keeps valid stored fields and replaces the rest", () => {
    const q = sanitize({ resolution: 0.5, antialias: "yes", shadows: "soft", shadowSize: 4096, detail: "low", fpsCap: 45 });
    expect(q).toEqual<Quality>({ ...PRESETS.high, resolution: 0.5, shadowSize: 4096, detail: "low" });
    expect(sanitize(null)).toEqual(PRESETS.high);
  });

  it("starts from the URL, else storage, else Auto at high", () => {
    const stored = serialize({ auto: false, quality: { ...PRESETS.low, fpsCap: 30 } });
    expect(initialQuality("medium", stored)).toEqual({ auto: false, quality: PRESETS.medium });
    expect(initialQuality(null, stored)).toEqual({ auto: false, quality: { ...PRESETS.low, fpsCap: 30 } });
    expect(initialQuality("ultra", null)).toEqual({ auto: true, quality: PRESETS.high });
    expect(initialQuality(null, "{not json")).toEqual({ auto: true, quality: PRESETS.high });
  });
});

describe("DetailCuller", () => {
  // Ten 1 m things in a row along −z, 10 m apart, the first 10 m from the camera at the origin.
  const mesh = () => {
    const m = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial(), 10);
    const mat = new THREE.Matrix4();
    for (let i = 0; i < 10; i++) {
      m.setMatrixAt(i, mat.makeTranslation(0, 0, -10 * (i + 1)));
      m.setColorAt(i, new THREE.Color(i / 10, 0, 0));
    }
    m.userData.placements = Array.from({ length: 10 }, (_, i) => 100 + i);
    return m;
  };
  const camera = new THREE.PerspectiveCamera();

  it("draws everything until told a smallest size", () => {
    const m = mesh();
    const c = new DetailCuller();
    c.add(m, 1);
    c.update(camera, 1000, false);
    expect(m.count).toBe(10);
  });

  it("draws only what comes out big enough, nearest first, with its colour and placement", () => {
    const m = mesh();
    const c = new DetailCuller();
    c.add(m, 1);
    c.setMinPixels(20);                         // 1 m at d px/m·1000/d ≥ 20 → d ≤ 50 m
    expect(c.update(camera, 1000, false)).toBe(true);
    expect(m.count).toBe(5);
    expect(Array.from(m.userData.placements as Int32Array).slice(0, m.count)).toEqual([100, 101, 102, 103, 104]);
    const col = new THREE.Color();
    m.getColorAt(4, col);
    expect(col.r).toBeCloseTo(0.4);
    // Nothing moved: nothing to do.
    expect(c.update(camera, 1000, false)).toBe(false);
  });

  it("brings everything back for lit glowing parts, and at no threshold", () => {
    const m = mesh();
    const c = new DetailCuller();
    c.add(m, 1, true);
    c.setMinPixels(20);
    c.update(camera, 1000, false);
    expect(m.count).toBe(5);
    c.update(camera, 1000, true);
    expect(m.count).toBe(10);
    c.update(camera, 1000, false);
    c.setMinPixels(0);
    c.update(camera, 1000, false);
    expect(m.count).toBe(10);
    expect(Array.from(m.userData.placements as Int32Array)).toEqual(Array.from({ length: 10 }, (_, i) => 100 + i));
  });

  it("always draws big things", () => {
    const m = mesh();
    const c = new DetailCuller();
    c.add(m, Array.from({ length: 10 }, (_, i) => (i === 9 ? 5 : 1)));
    c.setMinPixels(20);
    c.update(camera, 1000, false);
    expect(Array.from(m.userData.placements as Int32Array).slice(0, m.count)).toEqual([100, 101, 102, 103, 104, 109]);
  });

  it("measures things by their middle dimension and panels by their area", () => {
    expect(featureSize([-0.2, -0.2, 0], [0.2, 0.2, 4])).toBeCloseTo(0.4);
    // One 2 m × 1 m panel as two triangles.
    expect(panelSize([0, 0, 0, 2, 0, 0, 2, 1, 0, 0, 0, 0, 2, 1, 0, 0, 1, 0])).toBeCloseTo(Math.SQRT2);
  });
});

describe("object bodies", () => {
  it("patches three's colour chunk so the instance colour follows tintMask", () => {
    expect(TINT_COLOR_VERTEX).toContain("mix( vec3( 1.0 ), instanceColor.rgb, tintMask )");
    expect(TINT_COLOR_VERTEX).not.toContain("vColor.rgb *= instanceColor.rgb;");
  });

  it("marks the tinted parts in one geometry with the rest", () => {
    const tri = { pos: [0, 0, 0, 1, 0, 0, 0, 1, 0], color: [0x808080] };
    const g = bodyGeometry(tri, { pos: [...tri.pos, ...tri.pos], color: [0xffffff, 0xffffff] })!;
    expect(Array.from(g.getAttribute("tintMask").array)).toEqual([0, 0, 0, 1, 1, 1, 1, 1, 1]);
    expect(g.getAttribute("position").count).toBe(9);
    expect(bodyGeometry({ pos: [], color: [] }, { pos: [], color: [] })).toBeNull();
  });
});
