// Train catalog plus the few global tuning constants the model and sim share.
// Add a new train type here (see README). Scenery objects live in objectLibrary.ts.

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
  "freight-4": { cars: 5, carLength: 14, locoLength: 18, carWidth: 3, carHeight: 3.4, maxSpeed: 22, accel: 0.35, decel: 0.6, color: "#5c6b4e", shape: "freight" },
  "tram-2": { cars: 2, carLength: 14, carWidth: 2.6, carHeight: 3.4, maxSpeed: 15, accel: 1.0, decel: 1.2, color: "#e2b33c", shape: "tram" },
} satisfies Record<string, TrainType>;

export type TrainTypeId = keyof typeof TRAIN_CATALOG;

export const isTrainType = (id: string): id is TrainTypeId => Object.hasOwn(TRAIN_CATALOG, id);

/** Length of every vehicle in the consist, front to back. */
export function carLengths(t: TrainType): number[] {
  return Array.from({ length: t.cars }, (_, i) => (i === 0 && t.locoLength ? t.locoLength : t.carLength));
}

export const trainLength = (t: TrainType): number => carLengths(t).reduce((a, b) => a + b, 0);

/** Loads of goods one freight wagon carries. */
export const WAGON_LOADS = 8;

/** Built-in goods: how they are named and the colour of their crates (any other id is named after itself). */
export const GOODS: Record<string, { name: string; color: string }> = {
  mail: { name: "mail", color: "#d9a43a" },
  food: { name: "food", color: "#6f9a4e" },
  goods: { name: "goods", color: "#4f6f9a" },
  drinks: { name: "drinks", color: "#8a4a3a" },
  materials: { name: "building materials", color: "#b0a898" },
  timber: { name: "timber", color: "#a0703e" },
  coal: { name: "coal", color: "#3a3a3c" },
  fuel: { name: "fuel", color: "#c0392b" },
  fish: { name: "fish", color: "#7fb0c0" },
};
const SPARE = ["#7a5a9e", "#3a8f8f", "#c87a3d", "#9a9a3a", "#c85a8a", "#5a7a3a"];

export const goodsName = (id: string): string => GOODS[id]?.name ?? id.replace(/-/g, " ");
export function goodsColor(id: string): string {
  if (GOODS[id]) return GOODS[id].color;
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return SPARE[h % SPARE.length];
}

/** Simulation speed multiplier applied to the fixed 1/30 s step. */
export const TIME_SCALE = 1;
