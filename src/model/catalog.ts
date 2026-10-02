// Static catalogs: train types, building and tree variants, plus the few global
// tuning constants the model and sim share. Add a new train type here (see README).

export type CarShape = "multiple-unit" | "loco-hauled" | "tram" | "freight";

export type TrainType = {
  cars: number;            // total vehicles including any locomotive
  carLength: number;       // metres (for "freight": wagon length)
  locoLength?: number;     // first vehicle length, if it differs (locomotive)
  carWidth: number;
  carHeight: number;
  maxSpeed: number;        // m/s
  accel: number;           // m/s²
  decel: number;           // m/s²
  color: string;
  shape: CarShape;
};

export const TRAIN_CATALOG = {
  "regional-3": { cars: 3, carLength: 22, carWidth: 3, carHeight: 3.8, maxSpeed: 30, accel: 0.8, decel: 1.0, color: "#c8553d", shape: "multiple-unit" },
  "express-6": { cars: 6, carLength: 25, locoLength: 20, carWidth: 3, carHeight: 4.0, maxSpeed: 45, accel: 0.6, decel: 0.9, color: "#3d6fa8", shape: "loco-hauled" },
  "freight-10": { cars: 11, carLength: 14, locoLength: 18, carWidth: 3, carHeight: 3.4, maxSpeed: 22, accel: 0.3, decel: 0.6, color: "#5c6b4e", shape: "freight" },
  "tram-2": { cars: 2, carLength: 14, carWidth: 2.6, carHeight: 3.4, maxSpeed: 15, accel: 1.0, decel: 1.2, color: "#e2b33c", shape: "tram" },
} satisfies Record<string, TrainType>;

export type TrainTypeId = keyof typeof TRAIN_CATALOG;

export const isTrainType = (id: string): id is TrainTypeId => Object.hasOwn(TRAIN_CATALOG, id);

/** Length of every vehicle in the consist, front to back. */
export function carLengths(t: TrainType): number[] {
  return Array.from({ length: t.cars }, (_, i) => (i === 0 && t.locoLength ? t.locoLength : t.carLength));
}

export const trainLength = (t: TrainType): number => carLengths(t).reduce((a, b) => a + b, 0);

/** Simulation speed multiplier applied to the fixed 1/30 s step. */
export const TIME_SCALE = 1;

export const HOUSE_VARIANTS = ["house", "terrace", "flats", "church"] as const;
export type HouseVariant = (typeof HOUSE_VARIANTS)[number];
/** Footprint radius (m) used to keep buildings apart, and rough triangle cost for stats. */
export const HOUSE_INFO: Record<HouseVariant, { radius: number; tris: number }> = {
  house: { radius: 6, tris: 40 },
  terrace: { radius: 11, tris: 60 },
  flats: { radius: 9, tris: 60 },
  church: { radius: 13, tris: 80 },
};

export const TREE_VARIANTS = ["conifer", "deciduous", "bare", "conifer-snow"] as const;
export type TreeVariant = (typeof TREE_VARIANTS)[number];
export const TREE_TRIS = 24;
