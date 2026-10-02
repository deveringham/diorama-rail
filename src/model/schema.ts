// The layout JSON schema (zod v4). Defaults are applied here so the rest of the
// pipeline sees fully-populated objects. Unknown keys are errors, to catch typos.

import { z } from "zod";
import { TRAIN_CATALOG } from "./catalog";

const Vec2 = z.tuple([z.number(), z.number()]).describe("[x, y] in metres; x = east, y = north");
const Id = z.string().regex(/^[a-z][a-z0-9-]*$/, "ids must match /^[a-z][a-z0-9-]*$/ (lowercase, digits, dashes)");

const Waypoint = z.union(
  [
    Vec2,
    z.strictObject({
      at: Vec2,
      z: z.number().optional().describe("Fixed track height (m) at this waypoint; a hard constraint"),
      radius: z.number().positive().optional().describe("Curve radius at this corner; overrides track.minRadius"),
    }),
  ],
  { error: "waypoint must be [x, y] or { at: [x, y], z?, radius? }" },
);

const TrackEnd = z.strictObject({
  track: Id.describe("Parent track id"),
  at: z.number().describe("Arc length s on the parent track (m)"),
  heading: z.enum(["forward", "backward"]).default("forward")
    .describe("Which way along the parent the branch leaves (from) or arrives (to)"),
});

const Track = z
  .strictObject({
    id: Id,
    kind: z.enum(["loop", "line"]),
    points: z.array(Waypoint).min(1),
    minRadius: z.number().positive().default(40),
    maxGrade: z.number().positive().max(0.2).default(0.035),
    from: TrackEnd.optional().describe("line only: starts at a junction on another track"),
    to: TrackEnd.optional().describe("line only: ends at a junction on another track"),
  })
  .superRefine((t, ctx) => {
    const need = t.kind === "loop" ? 3 : t.from || t.to ? 1 : 2;
    if (t.points.length < need) {
      ctx.addIssue({ code: "custom", path: ["points"], message: `a ${t.kind}${t.kind === "line" && need === 1 ? " with from/to" : ""} needs at least ${need} points, got ${t.points.length}` });
    }
    if (t.kind === "loop" && (t.from || t.to)) {
      ctx.addIssue({ code: "custom", path: [t.from ? "from" : "to"], message: "from/to are only allowed on kind \"line\"" });
    }
  });

const Station = z.strictObject({
  id: Id,
  name: z.string(),
  track: Id,
  at: z.number().describe("s of the platform centre (m)"),
  length: z.number().positive().default(120),
  side: z.enum(["left", "right", "both"]).default("right"),
});

const Service = z.strictObject({
  id: Id,
  train: z.string().describe(`Train type id: ${Object.keys(TRAIN_CATALOG).join(", ")}`),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "color must be a hex string like #c8553d").optional(),
  route: z.array(Id).min(1).describe("Ordered track ids; consecutive ids must share a junction"),
  mode: z.enum(["loop", "shuttle"]),
  stops: z.array(Id).default([]),
  dwell: z.number().nonnegative().default(25),
  count: z.int().min(1).max(20).default(1),
});

const Area = z.strictObject({ at: Vec2, radius: z.number().positive(), density: z.number().min(0).max(1) });

export const LayoutSchema = z.strictObject({
  version: z.literal(1),
  name: z.string(),
  seed: z.int().default(1),
  terrain: z.strictObject({
    size: Vec2.describe("[width, height] in metres; origin at (0,0) bottom-left"),
    cell: z.number().min(1).max(50).default(4),
    baseHeight: z.number().default(0),
    seaLevel: z.number().nullable().default(null),
    features: z.array(z.strictObject({ at: Vec2, radius: z.number().positive(), height: z.number() })).default([])
      .describe("Smooth bumps (height > 0) or basins (height < 0), ~5% of height left at `radius`"),
    noise: z.strictObject({ amplitude: z.number().min(0), scale: z.number().positive() })
      .default({ amplitude: 2, scale: 120 }),
  }),
  tracks: z.array(Track).min(1),
  stations: z.array(Station).default([]),
  services: z.array(Service).default([]),
  scenery: z.strictObject({
    towns: z.array(z.strictObject({
      near: z.union([Id, Vec2]).describe("Station id or [x, y]"),
      radius: z.number().positive(),
      density: z.number().min(0).max(1),
    })).default([]),
    forests: z.array(Area).default([]),
    scatterTrees: z.number().min(0).max(1).default(0.15),
  }).prefault({}),
  style: z.strictObject({
    season: z.enum(["summer", "autumn", "winter"]).default("summer"),
    timeOfDay: z.number().min(0).max(24).default(15),
    dayLengthSeconds: z.number().positive().nullable().default(null),
  }).prefault({}),
});

export type Layout = z.output<typeof LayoutSchema>;
export type LayoutInput = z.input<typeof LayoutSchema>;
export type TrackSpec = Layout["tracks"][number];
export type TrackEndSpec = NonNullable<TrackSpec["from"]>;
export type WaypointSpec = TrackSpec["points"][number];
export type StationSpec = Layout["stations"][number];
export type ServiceSpec = Layout["services"][number];

/** Normalises a waypoint to { at, z?, radius? }. */
export function waypoint(w: WaypointSpec): { at: [number, number]; z?: number; radius?: number } {
  return Array.isArray(w) ? { at: w } : w;
}

export const layoutJsonSchema = (): object => z.toJSONSchema(LayoutSchema, { io: "input" });
