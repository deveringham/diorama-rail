// Scenery objects: every built-in parses and meshes in every season, primitives
// face outward under any rotation and mirror, and grids, panels, seasons, winter
// colours, glow and chimneys behave as documented.

import { describe, it, expect } from "vitest";
import { ObjectSchema, meshObject, SHAPES, type ObjectInput, type TriList } from "../src/model/objects";
import { OBJECT_LIBRARY } from "../src/model/objectLibrary";

const SEASONS = ["summer", "autumn", "winter"] as const;
const one = (part: ObjectInput["parts"][number], extra: Partial<ObjectInput> = {}) => ObjectSchema.parse({ parts: [part], ...extra });

/** Triangles whose normal points toward the centroid of their own copy (should be none for convex parts). */
function inward(list: TriList, copies: number): number {
  const p = list.pos;
  const per = p.length / 9 / copies;
  let bad = 0;
  for (let c = 0; c < copies; c++) {
    const centre = [0, 0, 0];
    for (let t = c * per; t < (c + 1) * per; t++) for (let k = 0; k < 9; k++) centre[k % 3] += p[t * 9 + k] / (per * 3);
    for (let t = c * per; t < (c + 1) * per; t++) {
      const a = p.slice(t * 9, t * 9 + 9);
      const u = [a[3] - a[0], a[4] - a[1], a[5] - a[2]];
      const v = [a[6] - a[0], a[7] - a[1], a[8] - a[2]];
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const g = [0, 1, 2].map((k) => (a[k] + a[k + 3] + a[k + 6]) / 3 - centre[k]);
      if (n[0] * g[0] + n[1] * g[1] + n[2] * g[2] <= 0) bad++;
    }
  }
  return bad;
}

describe("built-in library", () => {
  it.each(Object.keys(OBJECT_LIBRARY))("%s meshes in every season", (id) => {
    for (const season of SEASONS) {
      const m = meshObject(OBJECT_LIBRARY[id], season);
      expect(m.triangles).toBeGreaterThan(0);
      expect(m.triangles).toBeLessThan(1000);
      expect(m.max[2]).toBeGreaterThan(m.min[2]);
    }
  });
});

describe("primitives", () => {
  const solids = SHAPES.filter((s) => s !== "panel");
  it.each(solids)("%s faces outward under rotation and mirroring", (shape) => {
    for (const rotate of [[0, 0, 0], [30, 45, 60], [180, 0, 0]] as Array<[number, number, number]>) {
      for (const [mirror, copies] of [[undefined, 1], ["x", 2], ["xy", 4]] as const) {
        const m = meshObject(one({ shape, at: [0, 0, 3], size: [4, 3, 2], rotate, mirror, detail: 1 }), "summer");
        expect(inward(m.tint, copies), `${shape} ${rotate} ${mirror}`).toBe(0);
      }
    }
  });

  it("drops faces lying face-down on the ground", () => {
    expect(meshObject(one({ shape: "box", size: [2, 2, 2] }), "summer").triangles).toBe(10);
    expect(meshObject(one({ shape: "box", at: [0, 0, 1], size: [2, 2, 2] }), "summer").triangles).toBe(12);
  });

  it("makes a panel a single front-facing quad", () => {
    const m = meshObject(one({ shape: "panel", at: [3, 0, 1], size: [0.2, 1, 1] }), "summer");
    expect(m.triangles).toBe(2);
    expect(m.min[0]).toBeCloseTo(3.1);
    expect(m.max[0]).toBeCloseTo(3.1);
  });

  it("repeats parts on a grid and mirrors them", () => {
    const m = meshObject(one({ shape: "panel", at: [2, 0, 0], size: [0.1, 1, 1], grid: [1, 3, 2], step: [0, 2, 1.5], mirror: "x" }), "summer");
    expect(m.triangles).toBe(2 * 3 * 2 * 2);
    expect(m.min[0]).toBeCloseTo(-2.05);
    expect(m.max[1]).toBeCloseTo(4.5);
    expect(m.max[2]).toBeCloseTo(2.5);
  });
});

describe("colours, seasons and chimneys", () => {
  const def = ObjectSchema.parse({
    tint: ["#112233"],
    parts: [
      { shape: "box", size: [4, 4, 3] },                                            // tint
      { shape: "gable", at: [0, 0, 3], size: [4, 4, 2], color: "roof", winter: "snow" },
      { shape: "panel", at: [2, 0, 1], size: [0.1, 1, 1], color: "window" },       // glows
      { shape: "box", at: [1, 1, 4], size: [0.5, 0.5, 1.5], color: "chimney", smoke: true },
      { shape: "sphere", at: [0, 0, 6], size: [1, 1, 1], seasons: ["winter"], color: "white" },
    ],
  });

  it("sorts parts into fixed, tinted and glowing groups", () => {
    const m = meshObject(def, "summer");
    expect(m.tint.color.length).toBe(10);
    expect(m.glow.color).toEqual([0x3c4651, 0x3c4651]);
    expect(m.fixed.color.every((c) => c !== 0xffffff)).toBe(true);
  });

  it("uses winter colours and season-only parts", () => {
    const summer = meshObject(def, "summer");
    const winter = meshObject(def, "winter");
    expect(winter.triangles - summer.triangles).toBe(20);                         // the winter-only sphere
    expect(winter.fixed.color).toContain(0xf6f8fa);                               // snow on the roof
    expect(summer.fixed.color).not.toContain(0xf6f8fa);
  });

  it("finds chimney tops", () => {
    expect(meshObject(def, "summer").chimneys).toEqual([[1, 1, 5.5]]);
  });

  it("rejects bad parts with field paths", () => {
    const res = ObjectSchema.safeParse({ parts: [{ shape: "tube", size: [1, 1, 1] }, { shape: "box", size: [1, -1, 1], color: "purple" }] });
    expect(res.success).toBe(false);
    const paths = res.error!.issues.map((i) => i.path.join("."));
    expect(paths).toEqual(expect.arrayContaining(["parts.0.shape", "parts.1.size.1", "parts.1.color"]));
  });
});
