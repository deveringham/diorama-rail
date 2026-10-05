// The layout JSON schema (zod v4). Defaults are applied here so the rest of the
// pipeline sees fully-populated objects. Unknown keys are errors, to catch typos.

import { z } from "zod";
import { TRAIN_CATALOG, GOODS } from "./catalog";
import { ObjectSchema, ColorSchema, BuildingSchema } from "./objects";

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
    lanes: z.int().min(1).max(3).default(1).describe("Traffic lanes in each direction"),
    width: z.number().min(3).max(24).optional()
      .describe("Carriageway width (m); two-way traffic, drive on the right; default 6 m for each lane each way (6, 12, 18)"),
    minRadius: z.number().positive().default(10),
    maxGrade: z.number().positive().max(0.25).default(0.08),
    speed: z.number().positive().max(40).default(13).describe("Speed limit (m/s); 13 ≈ 50 km/h"),
    sidewalks: z.enum(["none", "both", "left", "right"]).default("none")
      .describe("Raised pavements beside the carriageway, left/right of the direction of increasing s; people walk on them"),
    sidewalkWidth: z.number().min(1).max(5).default(2),
    parking: z.enum(["none", "both", "left", "right"]).default("none")
      .describe("Street parking: a strip of parking bays between the carriageway and the sidewalk, left/right of increasing s"),
    parkingStyle: z.enum(["parallel", "perpendicular"]).default("parallel")
      .describe("parallel: bays along the kerb (2.4 m strip); perpendicular: nose-in bays (5.2 m strip)"),
    name: z.string().min(1).optional().describe('Street name for addresses; default from the id ("market-street" → "Market Street")'),
    from: RoadEnd.optional(),
    to: RoadEnd.optional(),
  })
  .superRefine((r, ctx) => lineChecks(r, "road", ctx))
  .transform((r) => ({ ...r, width: r.width ?? 6 * r.lanes }));

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
    station: Id.optional().describe("Station whose platform this path starts or ends at (people walk on to the platform there)"),
    at: z.union([z.number(), z.enum(["start", "end"])]).optional()
      .describe('With path or road: arc length s on it (m), or "start" / "end"'),
  })
  .superRefine((e, ctx) => {
    const given = [e.path, e.road, e.station].filter((x) => x !== undefined).length;
    if (given !== 1) ctx.addIssue({ code: "custom", path: [e.station ? "station" : e.road ? "road" : "path"], message: "give exactly one of `path`, `road` or `station`" });
    else if (!e.station && e.at === undefined) ctx.addIssue({ code: "custom", path: ["at"], message: "a path or road end needs `at`: s, \"start\" or \"end\"" });
    else if (e.station && e.at !== undefined) ctx.addIssue({ code: "custom", path: ["at"], message: "a station end takes no `at` (the path meets the platform beside the station building)" });
  });

const Path = z
  .strictObject({
    id: Id,
    kind: z.enum(["line", "loop"]).default("line"),
    points: z.array(Waypoint).min(1).describe("Waypoints like a road's; corners are rounded with `minRadius`"),
    width: z.number().min(0.8).max(6).default(2).describe("Path width (m)"),
    surface: z.enum(["gravel", "paved"]).default("gravel"),
    name: z.string().min(1).optional().describe("Name for addresses and places to visit; default from the id"),
    minRadius: z.number().positive().default(3),
    maxGrade: z.number().positive().max(0.3).default(0.12),
    from: PathEnd.optional(),
    to: PathEnd.optional(),
  })
  .superRefine((p, ctx) => lineChecks(p, "path", ctx));

const Station = z
  .strictObject({
    id: Id,
    name: z.string(),
    kind: z.enum(["passenger", "freight"]).default("passenger")
      .describe("passenger: platforms people use; freight: a goods yard, a loading dock beside the track where freight trains and lorries exchange goods"),
    track: Id,
    at: z.number().describe("s of the platform (or dock) centre (m)"),
    length: z.number().positive().default(120),
    side: z.enum(["left", "right", "both"]).default("right").describe("Which side of the track the platform is on (left/right of increasing s); a freight yard has one dock, left or right"),
    building: Id.nullable().optional()
      .describe('Object drawn as the station building behind the platform (default "station-building"), or for a freight yard the shed standing on its dock (default "goods-shed"); null for none'),
    road: Id.optional().describe("freight only: the road along the back of the dock, where lorries stop to load and unload; default the nearest one within 30 m"),
  })
  .superRefine((st, ctx) => {
    if (st.kind === "freight" && st.side === "both") ctx.addIssue({ code: "custom", path: ["side"], message: 'a freight yard has one dock: use side "left" or "right"' });
    if (st.kind !== "freight" && st.road !== undefined) ctx.addIssue({ code: "custom", path: ["road"], message: '`road` is only for freight yards (kind "freight")' });
  })
  .transform((st) => ({ ...st, building: st.building === undefined ? (st.kind === "freight" ? "goods-shed" : "station-building") : st.building }));

/** Goods by id with loads per hour (supplies and demands of buildings and off-layout places). */
export const GoodsRates = z.record(Id, z.number().min(0).max(500))
  .describe(`Goods by id with loads per hour, e.g. { "food": 6, "mail": 1 }; built-in goods: ${Object.keys(GOODS).join(", ")} (any other id works too)`);

const Service = z.strictObject({
  id: Id,
  train: z.string().describe(`Train type id: ${Object.keys(TRAIN_CATALOG).join(", ")}`),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "color must be a hex string like #c8553d").optional(),
  route: z.array(Id).min(1).describe("Ordered track ids; consecutive ids must share a junction"),
  mode: z.enum(["loop", "shuttle"]),
  stops: z.array(Id).default([]).describe("Station ids, and off-layout place ids reached by a track at an end of the route that leaves the board"),
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
    name: z.string().min(1).optional().describe('object: the building\'s name or address, e.g. "St. Mary\'s Church" or "4 Mill Lane"; default an address from the nearest street'),
    building: BuildingSchema.partial().optional()
      .describe("object: what this building is for, overriding the object's own `building` (functions, residents, jobs, titles, kind)"),
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
      for (const k of ["rotation", "face", "z", "color", "smoke", "name", "building"] as const) if (e[k] !== undefined) say(k, `\`${k}\` only applies to single \`object\` entries`);
      if (typeof e.scale === "number") say("scale", "a `scatter` entry takes a scale range [min, max]");
    }
  });

const ParkingLot = z.strictObject({
  id: Id,
  name: z.string().min(1).optional().describe('Shown as its address; default from the id ("station-car-park" → "Station Car Park")'),
  at: Vec2.describe("Centre of the car park"),
  spaces: z.int().min(2).max(200).default(20).describe("Number of bays, in two rows either side of an aisle"),
  rotation: z.number().optional().describe("Degrees counter-clockwise from east that the entrance faces; default toward the road it joins"),
  road: Id.optional().describe("Road its driveway joins; default the nearest"),
});

const OffVia = z
  .strictObject({
    track: Id.optional().describe("A track that leaves the board toward the place"),
    road: Id.optional().describe("A road that leaves the board toward the place (cars and buses; people on foot along its sidewalks)"),
    path: Id.optional().describe("A footpath that leaves the board toward the place"),
    end: z.enum(["start", "end"]).optional().describe("Which end of the line leaves the board, if both do"),
    distance: z.number().positive().default(2000).describe("m from the board's edge to the place along this way"),
  })
  .superRefine((v, ctx) => {
    if ([v.track, v.road, v.path].filter((x) => x !== undefined).length !== 1) {
      ctx.addIssue({ code: "custom", path: [v.road ? "road" : v.path ? "path" : "track"], message: "give exactly one of `track`, `road` or `path`" });
    }
  });

const OffPlace = z.strictObject({
  id: Id,
  name: z.string().min(1).optional().describe('Shown in journeys and timetables; default from the id ("neustadt" → "Neustadt")'),
  via: z.array(OffVia).min(1).describe("The lines leading off the board to it, each with the distance beyond the edge"),
  jobs: z.int().min(0).max(1000).default(0).describe("Posts there that residents of the board may hold (they commute)"),
  titles: z.array(z.string().min(1)).min(1).default(["Employee"]).describe("Job titles, as for buildings: the last fills the rest"),
  visits: z.number().min(0).max(20).default(1).describe("How often people go there on a visit; 1 ≈ one landmark on the board"),
  supplies: GoodsRates.default({}).describe("Goods sent out from there (loads per hour), by freight train or lorry"),
  demands: GoodsRates.default({}).describe("Goods delivered there (loads per hour)"),
});

const FleetEntry = z.strictObject({
  name: z.string().min(1).optional().describe('What these vehicles are called, e.g. "Post van"; default "Delivery van" or "Lorry" (from the object)'),
  object: Id.default("van").describe("Object id drawn as the vehicle"),
  count: z.int().min(0).max(40).default(2),
  capacity: z.int().min(1).max(100).default(6).describe("Loads it carries at once"),
  goods: z.array(Id).min(1).optional().describe("Only these goods (default: any)"),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "color must be a hex string like #c8553d").optional()
    .describe("Colour of these vehicles; default one picked per vehicle"),
});

const TrafficLights = z.strictObject({
  at: Vec2.describe("Where the road junction is: the nearest junction of three or more roads within 15 m gets the lights"),
  green: z.number().min(5).max(90).default(20)
    .describe("Longest green for each direction (s); it ends sooner when nothing more is coming and someone waits on red"),
});

const BusStop = z.strictObject({
  id: Id,
  name: z.string().min(1).optional().describe('Shown on the stop and in journeys; default from the id ("market-square" → "Market Square")'),
  road: Id.describe("Road the stop stands beside"),
  at: z.number().describe("s along the road (m) of the stop's sign; buses stop with their front door beside it"),
  side: z.enum(["both", "left", "right"]).default("both")
    .describe("Which side of the road (left/right of increasing s) has a stop; buses drive on the right, so the right side serves buses going toward increasing s"),
  shelter: z.boolean().default(true).describe("Draw a shelter behind the kerb (left out where something already stands there)"),
});

const BusLine = z.strictObject({
  id: Id,
  name: z.string().min(1).optional().describe('Shown on the buses and in journeys, e.g. "3" or "Harbour Hopper"; default from the id'),
  stops: z.array(Id).min(2).describe("Bus stop ids (or off-layout place ids reached by road) in the order the buses call; they take the quickest way along the roads between them"),
  mode: z.enum(["shuttle", "loop"]).default("shuttle")
    .describe("shuttle: there and back along the list, turning round after the last stop; loop: from the last stop back to the first"),
  count: z.int().min(1).max(20).default(1).describe("Buses on the line, spread evenly along it"),
  dwell: z.number().min(2).max(120).default(12).describe("s a bus waits at each stop (longer while people get on and off)"),
  capacity: z.int().min(1).max(200).default(40).describe("Passengers a bus takes"),
  vehicle: Id.default("bus").describe("Object id drawn as the bus"),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "color must be a hex string like #c8553d").optional()
    .describe("Colour of the line's buses; default one per line"),
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
  trafficLights: z.array(TrafficLights).default([])
    .describe("Traffic lights at road junctions: opposite approaches share a green, each direction in turn"),
  parking: z.array(ParkingLot).default([]).describe("Car parks: rows of bays along an aisle, joined to a road by a driveway"),
  busStops: z.array(BusStop).default([]).describe("Bus stops beside roads, on one side or both"),
  busLines: z.array(BusLine).default([]).describe("Bus lines: buses calling at stops in order along the roads; people ride them like trains"),
  offLayout: z.array(OffPlace).default([])
    .describe("Places off the board, reached by tracks, roads and paths that leave it (end on its edge): stops for services and bus lines, and destinations for errands"),
  freight: z.strictObject({
    vehicles: z.array(FleetEntry).optional()
      .describe("Delivery vans and lorries; default a few of each when anything needs delivering by road. Idle ones drive about until given a job"),
  }).prefault({}).describe("Deliveries: goods supplied and demanded by buildings and off-layout places move by road and by freight train"),
  people: z.strictObject({
    count: z.int().min(0).max(2000).optional()
      .describe("How many people live on the board; default as many as the accommodation holds (at most 600)"),
    cars: z.number().min(0).max(1).default(0.45).describe("Share of people who own a car (when there is parking near home)"),
    vehicles: z.array(Id).min(1).default(["car", "car", "car", "van"])
      .describe("Object ids of the residents' own vehicles, picked at random"),
  }).prefault({}),
  traffic: z.strictObject({
    cars: z.int().min(0).max(400).optional()
      .describe("Through traffic: vehicles driving about at random, not owned by residents; default about one per 200 m of road (at most 30)"),
    vehicles: z.array(Id).min(1).default(["car", "car", "van", "truck"])
      .describe("Object ids for through traffic, picked at random (repeat an id to make it more common); real buses run on busLines"),
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
export type PathEndSpec = NonNullable<PathSpec["from"]>;
export type ParkingLotSpec = Layout["parking"][number];
export type BusStopSpec = Layout["busStops"][number];
export type TrafficLightsSpec = Layout["trafficLights"][number];
export type BusLineSpec = Layout["busLines"][number];
export type OffPlaceSpec = Layout["offLayout"][number];
export type FleetSpec = NonNullable<Layout["freight"]["vehicles"]>[number];

/** Normalises a waypoint to { at, z?, radius? }. */
export function waypoint(w: WaypointSpec): { at: [number, number]; z?: number; radius?: number } {
  return Array.isArray(w) ? { at: w } : w;
}

export const layoutJsonSchema = (): object => z.toJSONSchema(LayoutSchema, { io: "input" });
