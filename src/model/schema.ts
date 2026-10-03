// The layout JSON schema (zod v4). Defaults are applied here so the rest of the
// pipeline sees fully-populated objects. Unknown keys are errors, to catch typos.

import { z } from "zod";
import { TRAIN_CATALOG } from "./catalog";
import { ObjectSchema, ColorSchema } from "./objects";

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

const RoadEnd = z.strictObject({
  road: Id.describe("Road this one starts (from) or ends (to) on, forming a T-junction"),
  at: z.union([z.number(), z.enum(["start", "end"])])
    .describe('Arc length s on that road (m), or "start" / "end" to join at one of its ends (a corner)'),
});

const Road = z
  .strictObject({
    id: Id,
    kind: z.enum(["line", "loop"]).default("line"),
    points: z.array(Waypoint).min(1).describe("Waypoints like a track's; corners are rounded with `minRadius`"),
    width: z.number().min(3).max(14).default(6).describe("Carriageway width (m); two-way traffic, drive on the right"),
    minRadius: z.number().positive().default(10),
    maxGrade: z.number().positive().max(0.25).default(0.08),
    speed: z.number().positive().max(40).default(13).describe("Speed limit (m/s); 13 ≈ 50 km/h"),
    sidewalks: z.enum(["none", "both", "left", "right"]).default("none")
      .describe("Raised pavements beside the carriageway, left/right of the direction of increasing s; people walk on them"),
    sidewalkWidth: z.number().min(1).max(5).default(2),
    from: RoadEnd.optional(),
    to: RoadEnd.optional(),
  })
  .superRefine((r, ctx) => lineChecks(r, "road", ctx));

/** Point counts and from/to rules shared by roads and paths. */
function lineChecks(r: { kind: string; points: unknown[]; from?: unknown; to?: unknown }, noun: string, ctx: z.RefinementCtx): void {
  const need = r.kind === "loop" ? 3 : r.from || r.to ? 1 : 2;
  if (r.points.length < need) {
    ctx.addIssue({ code: "custom", path: ["points"], message: `a ${r.kind} ${noun}${r.kind === "line" && need === 1 ? " with from/to" : ""} needs at least ${need} points, got ${r.points.length}` });
  }
  if (r.kind === "loop" && (r.from || r.to)) {
    ctx.addIssue({ code: "custom", path: [r.from ? "from" : "to"], message: `from/to are only allowed on line ${noun}s` });
  }
}

const PathEnd = z
  .strictObject({
    path: Id.optional().describe("Path this one starts (from) or ends (to) on, forming a T-junction"),
    road: Id.optional().describe("Road whose edge this path starts or ends at, joining its sidewalk on that side"),
    at: z.union([z.number(), z.enum(["start", "end"])])
      .describe('Arc length s on that path or road (m), or "start" / "end"'),
  })
  .superRefine((e, ctx) => {
    if (!!e.path === !!e.road) ctx.addIssue({ code: "custom", path: [e.path ? "road" : "path"], message: "give exactly one of `path` or `road`" });
  });

const Path = z
  .strictObject({
    id: Id,
    kind: z.enum(["line", "loop"]).default("line"),
    points: z.array(Waypoint).min(1).describe("Waypoints like a road's; corners are rounded with `minRadius`"),
    width: z.number().min(0.8).max(6).default(2).describe("Path width (m)"),
    surface: z.enum(["gravel", "paved"]).default("gravel"),
    minRadius: z.number().positive().default(3),
    maxGrade: z.number().positive().max(0.3).default(0.12),
    from: PathEnd.optional(),
    to: PathEnd.optional(),
  })
  .superRefine((p, ctx) => lineChecks(p, "path", ctx));

const Station = z.strictObject({
  id: Id,
  name: z.string(),
  track: Id,
  at: z.number().describe("s of the platform centre (m)"),
  length: z.number().positive().default(120),
  side: z.enum(["left", "right", "both"]).default("right"),
  building: Id.nullable().default("station-building")
    .describe("Object drawn as the station building beside the platform, or null for none"),
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

/**
 * One scenery entry: either a single `object` at a point, or a `scatter` of
 * objects over a circle (or the whole map). One schema with checks, rather than a
 * union, so mistakes get field-level messages.
 */
const SceneryEntry = z
  .strictObject({
    object: Id.optional().describe("Place one object (built-in or from `objects`) at `at`"),
    scatter: z.array(Id).min(1).optional()
      .describe("Scatter many objects, picked at random from these ids (repeat an id to make it more common)"),
    at: Vec2.optional().describe("object: where it stands. scatter: circle centre (omit with radius for the whole map)"),
    radius: z.number().positive().optional().describe("scatter: circle radius (m)"),
    spacing: z.number().min(1.5).optional().describe("scatter: minimum distance between items (m)"),
    rotation: z.number().optional().describe("object: degrees counter-clockwise from east that the object's front (+x) faces; default 0"),
    face: z.union([z.enum(["track", "road"]), Vec2]).optional()
      .describe('object: turn the front toward the nearest track ("track"), the nearest road ("road") or a point [x, y]; overrides rotation'),
    scale: z.union([z.number().positive(), z.tuple([z.number().positive(), z.number().positive()])]).optional()
      .describe("object: size factor (default 1). scatter: [min, max] range (default [0.8, 1.2])"),
    z: z.number().optional().describe("object: absolute base height (m); default the ground (or the platform top on a platform)"),
    color: ColorSchema.optional().describe('object: colour for its "tint" parts; default one picked from the object\'s tint list'),
    smoke: z.boolean().optional().describe("object: whether its chimneys smoke; default by the object's smoke share"),
  })
  .superRefine((e, ctx) => {
    const say = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    if (!!e.object === !!e.scatter) say(e.object ? "scatter" : "object", "each scenery entry needs exactly one of `object` (one item) or `scatter` (many items)");
    if (e.object) {
      if (!e.at) say("at", "an `object` entry needs `at`: [x, y]");
      for (const k of ["radius", "spacing"] as const) if (e[k] !== undefined) say(k, `\`${k}\` only applies to scatter entries`);
      if (Array.isArray(e.scale)) say("scale", "an `object` entry takes one scale number; [min, max] is for scatter");
    }
    if (e.scatter) {
      if (e.spacing === undefined) say("spacing", "a `scatter` entry needs `spacing` (m between items)");
      if ((e.at === undefined) !== (e.radius === undefined)) say(e.at ? "radius" : "at", "give both `at` and `radius` for a circle, or neither for the whole map");
      for (const k of ["rotation", "face", "z", "color", "smoke"] as const) if (e[k] !== undefined) say(k, `\`${k}\` only applies to single \`object\` entries`);
      if (typeof e.scale === "number") say("scale", "a `scatter` entry takes a scale range [min, max]");
    }
  });

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
  roads: z.array(Road).default([]).describe("Road network: crossroads form automatically, level crossings where a road meets a track at grade"),
  paths: z.array(Path).default([])
    .describe("Footpaths: junctions form automatically, zebra crossings where a path crosses a road, foot crossings over tracks"),
  pedestrians: z.strictObject({
    count: z.int().min(0).max(1000).optional().describe("People walking the paths and sidewalks; default about one per 25 m of walkway"),
  }).prefault({}),
  traffic: z.strictObject({
    cars: z.int().min(0).max(400).optional().describe("Number of vehicles; default about one per 70 m of road"),
    vehicles: z.array(Id).min(1).default(["car", "car", "car", "van", "bus", "truck"])
      .describe("Object ids to drive, picked at random (repeat an id to make it more common)"),
  }).prefault({}),
  objects: z.record(Id, ObjectSchema).default({})
    .describe("Custom scenery objects for this layout, by id; they may also redefine built-in ids"),
  scenery: z.array(SceneryEntry).default([]).describe("Placed objects and scattered groups"),
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
export type SceneryEntrySpec = Layout["scenery"][number];
export type RoadSpec = Layout["roads"][number];
export type PathSpec = Layout["paths"][number];

/** Normalises a waypoint to { at, z?, radius? }. */
export function waypoint(w: WaypointSpec): { at: [number, number]; z?: number; radius?: number } {
  return Array.isArray(w) ? { at: w } : w;
}

export const layoutJsonSchema = (): object => z.toJSONSchema(LayoutSchema, { io: "input" });
