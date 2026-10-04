// Scenery objects as data. An object is a list of low-poly primitive parts in its
// own frame: x = front, y = left, z = up, in metres, origin on the ground at its
// centre. This file holds the schema, colour handling and a pure-TS mesher that
// turns an object into triangles (bounds and stats here; instanced by scene/).

import { z } from "zod";
import { PALETTE, OBJECT_COLORS, type Season } from "../scene/palette";

type P3 = [number, number, number];
type Tri = [P3, P3, P3];

export const SHAPES = ["box", "pyramid", "gable", "cylinder", "cone", "sphere", "panel"] as const;
export const TINT_LISTS = ["walls", "roofs", "foliage", "needles", "people"] as const;
export const COLOR_NAMES = [...Object.keys(OBJECT_COLORS), "foliage", "needles"];
const MAX_COPIES = 400;            // grid copies per part
const GROUND = 1e-6;               // faces facing down at or below this height are never seen

const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const Named = z.enum(COLOR_NAMES as [string, ...string[]]);
const colorError = { error: `colour must be "#rrggbb" or one of: ${COLOR_NAMES.join(", ")}` };
/** A colour as "#rrggbb" or a palette name (see OBJECT_COLORS). */
export const ColorSchema = z.union([Hex, Named], colorError);
const Color = ColorSchema;
const PartColor = z.union([Hex, Named, z.literal("tint")], { error: `${colorError.error}, tint` });
const N3 = z.tuple([z.number(), z.number(), z.number()]);
const Pos = z.number().positive();
const Frac = z.number().min(0).max(1);
const Count = z.int().min(1).max(50);

export const PartSchema = z
  .strictObject({
    shape: z.enum(SHAPES).describe("box | pyramid (a box narrowing to a point) | gable (triangular roof prism, ridge along x) | cylinder | cone | sphere | panel (only the box's front (+x) face, one-sided: windows, doors, signs)"),
    at: N3.default([0, 0, 0]).describe("Bottom centre of the part in the object frame [x front, y left, z up] (m); negative z sinks it into the ground"),
    size: z.tuple([Pos, Pos, Pos]).describe("Extent [along x, along y, height] in metres, before rotation"),
    rotate: N3.default([0, 0, 0]).describe("Degrees about x, then y, then z (right-handed), pivoting on `at`"),
    color: PartColor.default("tint").describe('"#rrggbb", a named colour, or "tint": the per-placement colour picked from the object\'s `tint`'),
    winter: PartColor.optional().describe('Colour used in winter instead, e.g. "snow" on a roof'),
    seasons: z.array(z.enum(["summer", "autumn", "winter"])).min(1).optional().describe("Only draw this part in these seasons"),
    sides: z.int().min(3).max(32).optional().describe("cylinder / cone: number of sides (default 8 / 6)"),
    taper: z.union([Frac, z.tuple([Frac, Frac])]).optional()
      .describe("box, pyramid, cylinder, cone: top size as a fraction of the bottom, one number or [x, y]. Defaults: box and cylinder 1, pyramid and cone 0"),
    ridge: Frac.optional().describe("gable: where the ridge sits across the width, 0..1 (0.5 centred; 0 or 1 makes a lean-to)"),
    detail: z.union([z.literal(0), z.literal(1)]).optional().describe("sphere: 0 = 20 faces (default), 1 = 80 faces"),
    glow: z.boolean().optional().describe('Glows warmly at night (default: true for colours "window" and "lamp")'),
    smoke: z.boolean().optional().describe("A chimney: smoke rises from the top of this part when the placement smokes"),
    grid: z.tuple([Count, Count, Count]).default([1, 1, 1]).describe("Number of copies along x, y and z (windows, posts, columns)"),
    step: N3.default([0, 0, 0]).describe("Spacing between grid copies [x, y, z] (m)"),
    mirror: z.enum(["x", "y", "xy"]).optional().describe("Also draw mirror images: x flips front↔back (x → −x), y flips left↔right (y → −y), xy both"),
  })
  .superRefine((p, ctx) => {
    if (p.grid[0] * p.grid[1] * p.grid[2] > MAX_COPIES) {
      ctx.addIssue({ code: "custom", path: ["grid"], message: `at most ${MAX_COPIES} copies per part (got ${p.grid.join("×")})` });
    }
  });

export const FUNCTIONS = ["accommodation", "workplace", "landmark"] as const;

/** What a building is for: where people live, work and go. */
export const BuildingSchema = z.strictObject({
  functions: z.array(z.enum(FUNCTIONS)).min(1)
    .describe("accommodation: people live here; workplace: people work here; landmark: people visit it (a church, a shop, a pub)"),
  residents: z.int().min(0).max(500).optional().describe("accommodation: how many people live here (default 3)"),
  jobs: z.int().min(0).max(500).optional().describe("workplace: how many people work here (default 3)"),
  titles: z.array(z.string().min(1)).min(1).optional()
    .describe('workplace: job titles; the first job gets the first title and so on, the last title fills the rest (default ["Employee"])'),
  kind: z.string().min(1).optional().describe('What sort of place it is, shown with its address, e.g. "Church" or "Bakery"'),
  door: z.tuple([z.number(), z.number()]).optional()
    .describe("Entrance [x, y] in the object frame; default the middle of the front (+x) face"),
});

export const ObjectSchema = z.strictObject({
  description: z.string().optional().describe("What it is, for people and LLMs reading the layout"),
  building: BuildingSchema.optional().describe("Makes every placement of this object a building people can live in, work at or visit"),
  parts: z.array(PartSchema).min(1).max(300),
  tint: z.union([z.enum(TINT_LISTS), z.array(Color).min(1)]).default("walls")
    .describe(`Colours for parts coloured "tint": one is picked per placement. A palette list (${TINT_LISTS.join(", ")}; foliage and needles follow the season) or an array of colours`),
  smoke: Frac.default(0).describe("Share of placements whose chimney parts smoke (a placement's `smoke` overrides)"),
  maxSlope: z.number().min(0).max(90).default(30).describe("Steepest ground (degrees) a scatter will put this object on"),
});

export type ObjectDef = z.output<typeof ObjectSchema>;
export type BuildingDef = z.output<typeof BuildingSchema>;
export type BuildingFunction = (typeof FUNCTIONS)[number];
export type ObjectInput = z.input<typeof ObjectSchema>;
export type PartDef = ObjectDef["parts"][number];

// ---------------------------------------------------------------------------
// Colours

export function resolveColor(c: string, season: Season): number {
  if (c.startsWith("#")) return parseInt(c.slice(1), 16);
  if (c === "foliage") return PALETTE.trees[season].deciduous[0];
  if (c === "needles") return PALETTE.trees[season].conifer[0];
  return OBJECT_COLORS[c as keyof typeof OBJECT_COLORS];
}

/** The colours a "tint" part can take for this object and season. */
export function tintColors(def: ObjectDef, season: Season): readonly number[] {
  if (Array.isArray(def.tint)) return def.tint.map((c) => resolveColor(c, season));
  switch (def.tint) {
    case "walls": return PALETTE.walls;
    case "roofs": return Object.values(PALETTE.roofs);
    case "foliage": return PALETTE.trees[season].deciduous;
    case "needles": return PALETTE.trees[season].conifer;
    case "people": return PALETTE.people;
  }
}

// ---------------------------------------------------------------------------
// Primitives, each standing on z = 0 and centred on the z axis. Triangles are
// counter-clockwise seen from outside (degenerate ones are dropped later).

const quad = (a: P3, b: P3, c: P3, d: P3): Tri[] => [[a, b, c], [a, c, d]];

/** Box whose top is scaled by (tx, ty): 1,1 is a box, 0,0 a pyramid, 1,0 a wedge-like hip. */
function frustum(l: number, w: number, h: number, tx: number, ty: number): Tri[] {
  const b: P3[] = [[-l / 2, -w / 2, 0], [l / 2, -w / 2, 0], [l / 2, w / 2, 0], [-l / 2, w / 2, 0]];
  const t: P3[] = b.map(([x, y]) => [x * tx, y * ty, h]);
  const out = [...quad(t[0], t[1], t[2], t[3]), ...quad(b[0], b[3], b[2], b[1])];
  for (let i = 0; i < 4; i++) out.push(...quad(b[i], b[(i + 1) % 4], t[(i + 1) % 4], t[i]));
  return out;
}

/** Triangular prism: ridge along x at height h, `ridge` across the width (0..1). */
function gable(l: number, w: number, h: number, ridge: number): Tri[] {
  const yr = (ridge - 0.5) * w;
  const [x0, x1, y0, y1] = [-l / 2, l / 2, -w / 2, w / 2];
  return [
    ...quad([x0, y0, 0], [x1, y0, 0], [x1, yr, h], [x0, yr, h]),
    ...quad([x1, y1, 0], [x0, y1, 0], [x0, yr, h], [x1, yr, h]),
    [[x1, y0, 0], [x1, y1, 0], [x1, yr, h]],
    [[x0, y1, 0], [x0, y0, 0], [x0, yr, h]],
    ...quad([x0, y0, 0], [x0, y1, 0], [x1, y1, 0], [x1, y0, 0]),
  ];
}

/** n-sided (elliptical) cylinder, top scaled by (tx, ty); a cone when the taper is 0. */
function cylinder(l: number, w: number, h: number, n: number, tx: number, ty: number): Tri[] {
  const ring = (z: number, sx: number, sy: number): P3[] => Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n + Math.PI / n;      // a flat face toward +x
    return [(Math.cos(a) * l * sx) / 2, (Math.sin(a) * w * sy) / 2, z];
  });
  const b = ring(0, 1, 1);
  const t = ring(h, tx, ty);
  const out: Tri[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    out.push(...quad(b[i], b[j], t[j], t[i]));
    if (i > 0 && j > 0) out.push([t[0], t[i], t[j]], [b[0], b[j], b[i]]);
  }
  return out;
}

const PHI = (1 + Math.sqrt(5)) / 2;
const ICO_V: P3[] = [
  [-1, PHI, 0], [1, PHI, 0], [-1, -PHI, 0], [1, -PHI, 0], [0, -1, PHI], [0, 1, PHI],
  [0, -1, -PHI], [0, 1, -PHI], [PHI, 0, -1], [PHI, 0, 1], [-PHI, 0, -1], [-PHI, 0, 1],
];
const ICO_F = [
  [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
  [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
];

/** Low-poly ellipsoid (icosahedron, optionally subdivided once), standing on z = 0. */
function sphere(l: number, w: number, h: number, detail: 0 | 1): Tri[] {
  const unit = (p: P3): P3 => { const k = Math.hypot(...p); return [p[0] / k, p[1] / k, p[2] / k]; };
  let tris: Tri[] = ICO_F.map(([a, b, c]) => [unit(ICO_V[a]), unit(ICO_V[b]), unit(ICO_V[c])]);
  if (detail === 1) {
    const mid = (a: P3, b: P3) => unit([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]);
    tris = tris.flatMap(([a, b, c]) => {
      const [ab, bc, ca] = [mid(a, b), mid(b, c), mid(c, a)];
      return [[a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]] as Tri[];
    });
  }
  return tris.map((t) => t.map(([x, y, z]) => [(x * l) / 2, (y * w) / 2, ((z + 1) * h) / 2]) as Tri);
}

function primitive(p: PartDef): Tri[] {
  const [l, w, h] = p.size;
  const taper = (dflt: number): [number, number] =>
    p.taper === undefined ? [dflt, dflt] : typeof p.taper === "number" ? [p.taper, p.taper] : p.taper;
  switch (p.shape) {
    case "box": return frustum(l, w, h, ...taper(1));
    case "pyramid": return frustum(l, w, h, ...taper(0));
    case "gable": return gable(l, w, h, p.ridge ?? 0.5);
    case "cylinder": return cylinder(l, w, h, p.sides ?? 8, ...taper(1));
    case "cone": return cylinder(l, w, h, p.sides ?? 6, ...taper(0));
    case "sphere": return sphere(l, w, h, p.detail ?? 0);
    case "panel": return quad([l / 2, -w / 2, 0], [l / 2, w / 2, 0], [l / 2, w / 2, h], [l / 2, -w / 2, h]);
  }
}

// ---------------------------------------------------------------------------
// Meshing a whole object

export type TriList = { pos: number[]; color: number[] };   // 9 coordinates and one sRGB hex per triangle
export type ObjectMesh = {
  fixed: TriList;                  // parts with their own colour
  tint: TriList;                   // parts coloured per placement (stored white)
  glow: TriList;                   // windows and lamps, lit at night
  chimneys: P3[];                  // smoke sources in the object frame
  min: P3;                         // bounds in the object frame
  max: P3;
  triangles: number;
};

/** Rotation about x, then y, then z (degrees), as a function on points. */
function rotation([rx, ry, rz]: number[]): (p: P3) => P3 {
  const [a, b, c] = [rx, ry, rz].map((d) => (d * Math.PI) / 180);
  const [ca, sa, cb, sb, cc, sc] = [Math.cos(a), Math.sin(a), Math.cos(b), Math.sin(b), Math.cos(c), Math.sin(c)];
  return ([x, y, z]) => {
    const y1 = y * ca - z * sa, z1 = y * sa + z * ca;          // about x
    const x2 = x * cb + z1 * sb, z2 = -x * sb + z1 * cb;       // about y
    return [x2 * cc - y1 * sc, x2 * sc + y1 * cc, z2];         // about z
  };
}

const area2 = ([a, b, c]: Tri) => {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
};

export function meshObject(def: ObjectDef, season: Season): ObjectMesh {
  const mesh: ObjectMesh = {
    fixed: { pos: [], color: [] }, tint: { pos: [], color: [] }, glow: { pos: [], color: [] },
    chimneys: [], min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], triangles: 0,
  };
  for (const p of def.parts) {
    if (p.seasons && !p.seasons.includes(season)) continue;
    const color = season === "winter" && p.winter ? p.winter : p.color;
    const glow = p.glow ?? (color === "window" || color === "lamp");
    const list = color === "tint" ? mesh.tint : glow ? mesh.glow : mesh.fixed;
    const hex = color === "tint" ? 0xffffff : resolveColor(color, season);
    const rot = rotation(p.rotate);
    const local = primitive(p).map((t) => t.map(rot) as Tri);
    const mirrors: Array<[number, number]> = p.mirror === "x" ? [[1, 1], [-1, 1]] : p.mirror === "y" ? [[1, 1], [1, -1]]
      : p.mirror === "xy" ? [[1, 1], [-1, 1], [1, -1], [-1, -1]] : [[1, 1]];
    for (let i = 0; i < p.grid[0]; i++) for (let j = 0; j < p.grid[1]; j++) for (let k = 0; k < p.grid[2]; k++) {
      const off: P3 = [p.at[0] + i * p.step[0], p.at[1] + j * p.step[1], p.at[2] + k * p.step[2]];
      for (const [mx, my] of mirrors) {
        const place = (q: P3): P3 => [(q[0] + off[0]) * mx, (q[1] + off[1]) * my, q[2] + off[2]];
        const flip = mx * my < 0;                                  // a mirror image turns faces inside out
        for (const t of local) {
          const tri: Tri = flip ? [place(t[0]), place(t[2]), place(t[1])] : [place(t[0]), place(t[1]), place(t[2])];
          const n = area2(tri);
          if (Math.hypot(n[0], n[1], n[2]) < 1e-9) continue;
          if (n[2] < 0 && tri.every((q) => q[2] <= GROUND)) continue;
          for (const q of tri) {
            list.pos.push(q[0], q[1], q[2]);
            for (let a = 0; a < 3; a++) {
              mesh.min[a] = Math.min(mesh.min[a], q[a]);
              mesh.max[a] = Math.max(mesh.max[a], q[a]);
            }
          }
          list.color.push(hex);
          mesh.triangles++;
        }
        if (p.smoke) mesh.chimneys.push(place(rot([0, 0, p.size[2]])));
      }
    }
  }
  if (mesh.triangles === 0) mesh.min = mesh.max = [0, 0, 0];
  return mesh;
}
