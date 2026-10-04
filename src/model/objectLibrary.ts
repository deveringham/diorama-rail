// Built-in scenery objects, in exactly the format a layout's "objects" section
// uses (see model/objects.ts and docs/LAYOUT_GUIDE.md). Add an entry here to make
// an object available to every layout; a layout may also redefine any of these.

import { ObjectSchema, type ObjectDef, type ObjectInput } from "./objects";

const LIBRARY: Record<string, ObjectInput> = {
  // --- buildings ------------------------------------------------------------
  house: {
    description: "Two-storey house, 7 × 9 m, front door facing +x, chimney that sometimes smokes",
    tint: "walls",
    building: { functions: ["accommodation"], residents: 3, kind: "House" },
    smoke: 0.1,
    parts: [
      { shape: "box", at: [0, 0, -3], size: [7, 9, 8.2] },
      { shape: "gable", at: [0, 0, 5.2], size: [9.8, 7.8, 3.4], rotate: [0, 0, 90], color: "roof", winter: "snow" },
      { shape: "box", at: [1.4, 2.6, 6], size: [0.9, 0.9, 3], color: "chimney", smoke: true },
      { shape: "panel", at: [3.53, -1.6, 1], size: [0.1, 1.2, 1.3], color: "window", grid: [1, 2, 2], step: [0, 3.2, 2.3], mirror: "x" },
      { shape: "panel", at: [0, 4.5, 1], size: [0.1, 1.2, 1.3], rotate: [0, 0, 90], color: "window", grid: [1, 1, 2], step: [0, 0, 2.3], mirror: "y" },
      { shape: "panel", at: [3.53, 0, 0], size: [0.1, 1.1, 2.1], color: "timber" },
    ],
  },
  terrace: {
    description: "Row of three terraced houses, 8 × 22 m, fronts facing +x",
    tint: "walls",
    building: { functions: ["accommodation"], residents: 7, kind: "Terrace" },
    smoke: 0.1,
    parts: [
      { shape: "box", at: [0, 0, -3], size: [8, 22, 10.5] },
      { shape: "gable", at: [0, 0, 7.5], size: [22.8, 8.8, 3.6], rotate: [0, 0, 90], color: "roof-dark", winter: "snow" },
      { shape: "box", at: [0, -7, 9.5], size: [1, 1.4, 2.6], color: "chimney", grid: [1, 2, 1], step: [0, 14, 0] },
      { shape: "box", at: [0, 0, 9.5], size: [1, 1.4, 2.6], color: "chimney", smoke: true },
      { shape: "panel", at: [4.03, -8.75, 1.2], size: [0.1, 1.2, 1.4], color: "window", grid: [1, 6, 2], step: [0, 3.5, 3.4], mirror: "x" },
      { shape: "box", at: [4.03, -7, 0], size: [0.1, 1.1, 2.2], color: "timber", grid: [1, 3, 1], step: [0, 7, 0] },
    ],
  },
  flats: {
    description: "Four-storey block of flats, 12 × 16 m, flat roof",
    tint: "walls",
    building: { functions: ["accommodation"], residents: 20, kind: "Flats" },
    parts: [
      { shape: "box", at: [0, 0, -3], size: [12, 16, 18] },
      { shape: "box", at: [0, 0, 15], size: [12.4, 16.4, 0.7], color: "roof-grey", winter: "snow" },
      { shape: "box", at: [-2, 3, 15.7], size: [3, 3, 1.8], color: "roof-grey" },
      { shape: "panel", at: [6.03, -5.25, 1.2], size: [0.1, 1.3, 1.4], color: "window", grid: [1, 4, 4], step: [0, 3.5, 3.4], mirror: "x" },
      { shape: "panel", at: [-3.3, 8, 1.2], size: [0.1, 1.3, 1.4], rotate: [0, 0, 90], color: "window", grid: [3, 1, 4], step: [3.3, 0, 3.4], mirror: "y" },
    ],
  },
  church: {
    description: "Village church with a west tower and spire; the tower end faces +x",
    tint: ["#f4f0e8", "#ece4d4"],
    building: { functions: ["landmark", "workplace"], jobs: 2, titles: ["Vicar", "Verger"], kind: "Church" },
    parts: [
      { shape: "box", at: [-3, 0, -3], size: [20, 10, 12] },
      { shape: "gable", at: [-3, 0, 9], size: [20.8, 10.8, 5.5], color: "roof-slate", winter: "snow" },
      { shape: "box", at: [9, 0, -3], size: [5, 5, 25] },
      { shape: "pyramid", at: [9, 0, 22], size: [5.6, 5.6, 9], color: "roof-slate" },
      { shape: "panel", at: [-10.5, 5, 2], size: [0.1, 1, 4], rotate: [0, 0, 90], color: "window", grid: [4, 1, 1], step: [4.5, 0, 0], mirror: "y" },
      { shape: "panel", at: [11.53, 0, 14], size: [0.1, 1.2, 2.2], color: "window" },
      { shape: "panel", at: [11.53, 0, 0], size: [0.1, 1.6, 3], color: "timber" },
    ],
  },
  barn: {
    description: "Timber barn, 10 × 16 m, big doors facing +x",
    tint: ["#8a4a3a", "#7a5a44", "#6e6a5e"],
    building: { functions: ["workplace"], jobs: 2, titles: ["Farmer", "Farmhand"], kind: "Farm" },
    parts: [
      { shape: "box", at: [0, 0, -2], size: [10, 16, 7] },
      { shape: "gable", at: [0, 0, 5], size: [16.8, 11, 4.5], rotate: [0, 0, 90], color: "roof-grey", winter: "snow" },
      { shape: "panel", at: [5.03, 0, 0], size: [0.1, 4.5, 4.2], color: "timber" },
    ],
  },
  "station-building": {
    description: "Station building, 9 × 16 m, front facing +x (toward the track); used for every station unless overridden",
    tint: ["#e4d4b4", "#e8d2a6"],
    building: { functions: ["landmark", "workplace"], jobs: 3, titles: ["Station master", "Ticket clerk", "Porter"], kind: "Station", door: [-4.5, 0] },
    parts: [
      { shape: "box", at: [0, 0, -3], size: [9, 16, 9.5] },
      { shape: "gable", at: [0, 0, 6.5], size: [16.8, 9.8, 3.6], rotate: [0, 0, 90], color: "#8e4a3a", winter: "snow" },
      { shape: "panel", at: [4.53, -6, 0.8], size: [0.1, 1.4, 2.2], color: "window", grid: [1, 5, 1], step: [0, 3, 0], mirror: "x" },
      { shape: "panel", at: [4.53, -6, 4], size: [0.1, 1.2, 1.3], color: "window", grid: [1, 5, 1], step: [0, 3, 0], mirror: "x" },
      { shape: "panel", at: [4.53, 0, 5.4], size: [0.15, 1, 1], color: "white" },
    ],
  },
  shop: {
    description: "Shop with a flat above, 8 × 10 m, shop window and awning facing +x",
    tint: "walls",
    building: { functions: ["workplace", "landmark"], jobs: 2, titles: ["Shopkeeper", "Shop assistant"], kind: "Shop" },
    parts: [
      { shape: "box", at: [0, 0, -3], size: [8, 10, 9.2] },
      { shape: "gable", at: [0, 0, 6.2], size: [10.6, 8.6, 2.8], rotate: [0, 0, 90], color: "roof", winter: "snow" },
      { shape: "panel", at: [4.03, -1.9, 0.5], size: [0.1, 4.6, 1.9], color: "window" },
      { shape: "panel", at: [4.03, 2.9, 0], size: [0.1, 1.2, 2.3], color: "timber" },
      { shape: "panel", at: [4.04, -0.6, 2.8], size: [0.1, 7.6, 0.6], color: "white" },
      { shape: "box", at: [4.6, 0, 2.55], size: [1.4, 9.8, 0.1], rotate: [0, 18, 0], color: "green" },
      { shape: "panel", at: [4.03, -3, 4], size: [0.1, 1.2, 1.3], color: "window", grid: [1, 3, 1], step: [0, 3, 0] },
      { shape: "panel", at: [0, 5.03, 4], size: [0.1, 1.2, 1.3], rotate: [0, 0, 90], color: "window", grid: [2, 1, 1], step: [3, 0, 0], mirror: "y" },
    ],
  },
  office: {
    description: "Office block, 14 × 20 m, three storeys of window bands, entrance facing +x",
    tint: ["#d8d4cc", "#c9cfd4", "#e2dccf"],
    building: { functions: ["workplace"], jobs: 16, titles: ["Director", "Accountant", "Engineer", "Clerk"], kind: "Offices" },
    parts: [
      { shape: "box", at: [0, 0, -3], size: [14, 20, 15] },
      { shape: "box", at: [0, 0, 12], size: [14.4, 20.4, 0.6], color: "concrete", winter: "snow" },
      { shape: "box", at: [-2, 4, 12.6], size: [4, 5, 2], color: "metal" },
      { shape: "panel", at: [7.03, 0, 4.4], size: [0.1, 18.4, 1.6], color: "window", grid: [1, 1, 2], step: [0, 0, 3.6], mirror: "x" },
      { shape: "panel", at: [7.03, -5.6, 1.2], size: [0.1, 7.2, 1.6], color: "window", grid: [1, 2, 1], step: [0, 11.2, 0], mirror: "x" },
      { shape: "panel", at: [0, 10.03, 1.2], size: [0.1, 12.4, 1.6], rotate: [0, 0, 90], color: "window", grid: [1, 1, 3], step: [0, 0, 3.6], mirror: "y" },
      { shape: "panel", at: [7.03, 0, 0], size: [0.1, 2.6, 2.6], color: "#33404c" },
      { shape: "box", at: [7.7, 0, 2.9], size: [1.4, 4.2, 0.25], color: "concrete" },
    ],
  },
  pub: {
    description: "Village inn, 10 × 12 m, two storeys, sign beside the door facing +x",
    tint: ["#f0e7d5", "#e8d2a6", "#d9c4a0"],
    smoke: 0.5,
    building: { functions: ["workplace", "landmark"], jobs: 3, titles: ["Landlord", "Cook", "Bar staff"], kind: "Inn" },
    parts: [
      { shape: "box", at: [0, 0, -3], size: [10, 12, 9.5] },
      { shape: "gable", at: [0, 0, 6.5], size: [12.8, 10.8, 3.8], rotate: [0, 0, 90], color: "roof-dark", winter: "snow" },
      { shape: "box", at: [-1.5, 4.2, 7.5], size: [1, 1, 3.5], color: "chimney", smoke: true },
      { shape: "panel", at: [5.03, -3.8, 0.9], size: [0.1, 1.6, 1.3], color: "window", grid: [1, 2, 2], step: [0, 7.6, 3.1] },
      { shape: "panel", at: [5.03, 0, 0], size: [0.1, 1.3, 2.2], color: "timber" },
      { shape: "box", at: [5.5, 1.7, 2.9], size: [1, 0.08, 0.08], color: "dark" },
      { shape: "box", at: [5.7, 1.7, 2.0], size: [0.8, 0.06, 0.8], color: "red" },
      { shape: "panel", at: [0, 6.03, 0.9], size: [0.1, 1.4, 1.3], rotate: [0, 0, 90], color: "window", grid: [2, 1, 2], step: [4, 0, 3.1], mirror: "y" },
    ],
  },
  bench: {
    description: "Platform bench, 1.8 m long along y",
    parts: [{ shape: "box", at: [0, 0, 0], size: [0.6, 1.8, 0.5], color: "wood" }],
  },
  "lamp-post": {
    description: "Street lamp, 4.5 m, lit at night",
    parts: [
      { shape: "cylinder", at: [0, 0, 0], size: [0.18, 0.18, 4.2], sides: 5, color: "dark" },
      { shape: "box", at: [0, 0, 4.2], size: [0.5, 0.5, 0.35], color: "lamp" },
      { shape: "pyramid", at: [0, 0, 4.55], size: [0.6, 0.6, 0.3], color: "dark" },
    ],
  },
  fence: {
    description: "10 m of wooden fence along y",
    parts: [
      { shape: "box", at: [0, -5, 0], size: [0.15, 0.15, 1.2], color: "timber", grid: [1, 6, 1], step: [0, 2, 0] },
      { shape: "box", at: [0, 0, 0.45], size: [0.08, 10, 0.12], color: "wood", grid: [1, 1, 2], step: [0, 0, 0.5] },
    ],
  },

  paving: {
    description: "10 × 10 m paved square, 0.2 m proud of the ground (lay several for a town square; roads are a layout's `roads`, not objects)",
    parts: [{ shape: "box", at: [0, 0, -0.8], size: [10, 10, 1], color: "#b9b2a3", winter: "#dfe2e4" }],
  },

  // --- vehicles (driven by road traffic; front faces +x, origin at the centre) ---
  car: {
    description: "Small car, 4.2 m long; headlights glow at night",
    tint: ["#b8473a", "#4f6f9a", "#e6e2da", "#3a3a3c", "#8d9196", "#5f8a4e", "#d9a441"],
    parts: [
      { shape: "box", at: [0, 0, 0.28], size: [4.2, 1.8, 0.72] },
      { shape: "box", at: [-0.35, 0, 1], size: [2.3, 1.66, 0.52], taper: [0.78, 0.9] },
      { shape: "box", at: [-0.35, 0, 1.5], size: [1.8, 1.5, 0.03] },
      { shape: "panel", at: [0.79, 0, 1.02], size: [0.05, 1.5, 0.44], rotate: [0, -24, 0], color: "#33404c" },
      { shape: "panel", at: [-0.35, 0.84, 1.03], size: [0.05, 1.9, 0.4], rotate: [0, 0, 90], color: "#33404c", mirror: "y" },
      { shape: "cylinder", at: [1.3, 0.92, 0.32], size: [0.64, 0.64, 0.24], rotate: [90, 0, 0], sides: 8, color: "dark", grid: [2, 1, 1], step: [-2.6, 0, 0], mirror: "y" },
      { shape: "panel", at: [2.11, 0.58, 0.68], size: [0.05, 0.34, 0.16], color: "lamp", mirror: "y" },
      { shape: "panel", at: [-2.11, 0.62, 0.7], size: [0.05, 0.3, 0.16], rotate: [0, 0, 180], color: "#c0302a", glow: true, mirror: "y" },
    ],
  },
  van: {
    description: "Delivery van, 5 m long",
    tint: ["#f4f2ee", "#d9d4c8", "#5a7fa8", "#b8473a", "#e2b33c"],
    parts: [
      { shape: "box", at: [-0.3, 0, 0.32], size: [4.4, 1.95, 2.05] },
      { shape: "box", at: [2.15, 0, 0.32], size: [0.6, 1.95, 1.0] },
      { shape: "panel", at: [1.93, 0, 1.42], size: [0.05, 1.75, 0.8], rotate: [0, -20, 0], color: "#33404c" },
      { shape: "panel", at: [1.3, 0.985, 1.45], size: [0.05, 0.9, 0.7], rotate: [0, 0, 90], color: "#33404c", mirror: "y" },
      { shape: "cylinder", at: [1.5, 0.98, 0.34], size: [0.68, 0.68, 0.26], rotate: [90, 0, 0], sides: 8, color: "dark", grid: [2, 1, 1], step: [-3.1, 0, 0], mirror: "y" },
      { shape: "panel", at: [2.46, 0.66, 0.85], size: [0.05, 0.34, 0.18], color: "lamp", mirror: "y" },
      { shape: "panel", at: [-2.51, 0.78, 0.8], size: [0.05, 0.22, 0.3], rotate: [0, 0, 180], color: "#c0302a", glow: true, mirror: "y" },
    ],
  },
  bus: {
    description: "Single-deck bus, 11 m long; windows lit at night",
    tint: ["#e2b33c", "#c8553d", "#4f6f9a", "#5f8a4e", "#e6e2da"],
    parts: [
      { shape: "box", at: [0, 0, 0.35], size: [11, 2.5, 2.75] },
      { shape: "box", at: [0, 0, 3.1], size: [10.6, 2.3, 0.2], color: "#e6e2da" },
      { shape: "panel", at: [-0.4, 1.255, 1.45], size: [0.05, 9.2, 1.05], rotate: [0, 0, 90], color: "window", mirror: "y" },
      { shape: "panel", at: [5.505, 0, 1.25], size: [0.05, 2.2, 1.55], color: "#33404c" },
      { shape: "panel", at: [5.505, 0, 2.9], size: [0.05, 1.6, 0.3], color: "lamp" },
      { shape: "cylinder", at: [3.6, 1.26, 0.5], size: [1, 1, 0.3], rotate: [90, 0, 0], sides: 8, color: "dark", grid: [2, 1, 1], step: [-6.8, 0, 0], mirror: "y" },
      { shape: "panel", at: [5.505, 0.9, 0.7], size: [0.05, 0.4, 0.2], color: "lamp", mirror: "y" },
      { shape: "panel", at: [-5.505, 1, 0.75], size: [0.05, 0.3, 0.3], rotate: [0, 0, 180], color: "#c0302a", glow: true, mirror: "y" },
    ],
  },
  truck: {
    description: "Box lorry, 8 m long",
    tint: ["#f4f2ee", "#cfc9bd", "#7d8288", "#4f6f9a"],
    parts: [
      { shape: "box", at: [0, 0, 0.45], size: [8, 2.1, 0.4], color: "dark" },
      { shape: "box", at: [3.05, 0, 0.6], size: [1.9, 2.4, 2.4], color: "#b8473a" },
      { shape: "panel", at: [4.005, 0, 1.75], size: [0.05, 2.1, 1.0], color: "#33404c" },
      { shape: "box", at: [-1.05, 0, 0.85], size: [5.9, 2.5, 2.75] },
      { shape: "cylinder", at: [3, 1.1, 0.5], size: [1, 1, 0.3], rotate: [90, 0, 0], sides: 8, color: "dark", mirror: "y" },
      { shape: "cylinder", at: [-1.6, 1.1, 0.5], size: [1, 1, 0.3], rotate: [90, 0, 0], sides: 8, color: "dark", grid: [2, 1, 1], step: [-1.15, 0, 0], mirror: "y" },
      { shape: "panel", at: [4.005, 0.85, 0.85], size: [0.05, 0.36, 0.2], color: "lamp", mirror: "y" },
      { shape: "panel", at: [-4.005, 0.95, 0.6], size: [0.05, 0.3, 0.2], rotate: [0, 0, 180], color: "#c0302a", glow: true, mirror: "y" },
    ],
  },

  // --- nature ----------------------------------------------------------------
  conifer: {
    description: "Spruce, about 10 m; snow on the top in winter",
    tint: "needles",
    maxSlope: 35,
    parts: [
      { shape: "box", at: [0, 0, -0.5], size: [0.55, 0.55, 3], color: "trunk" },
      { shape: "cone", at: [0, 0, 1.6], size: [5.4, 5.4, 6] },
      { shape: "cone", at: [0, 0, 4.8], size: [3.8, 3.8, 5.6], winter: "snow" },
    ],
  },
  deciduous: {
    description: "Broadleaf tree, about 8.5 m; autumn colours, bare in winter",
    tint: "foliage",
    maxSlope: 35,
    parts: [
      { shape: "box", at: [0, 0, -0.5], size: [0.55, 0.55, 3.5], color: "trunk" },
      { shape: "sphere", at: [0, 0, 2.9], size: [6.4, 6.4, 5.4], seasons: ["summer", "autumn"] },
      { shape: "sphere", at: [0, 0, 3.2], size: [3.8, 3.8, 6.5], seasons: ["winter"] },
    ],
  },
  poplar: {
    description: "Tall narrow poplar, about 16 m",
    tint: "foliage",
    maxSlope: 35,
    parts: [
      { shape: "box", at: [0, 0, -0.5], size: [0.5, 0.5, 3], color: "trunk" },
      { shape: "sphere", at: [0, 0, 2], size: [3.2, 3.2, 14], detail: 1 },
    ],
  },
  bush: {
    description: "Low bush, 2.5 m across",
    tint: "foliage",
    maxSlope: 40,
    parts: [{ shape: "sphere", at: [0, 0, -0.3], size: [2.6, 2.4, 1.8] }],
  },
  rock: {
    description: "Boulder, about 3 m across",
    tint: ["stone", "#8f897e", "#a59f93"],
    maxSlope: 60,
    parts: [{ shape: "sphere", at: [0, 0, -0.6], size: [3.2, 2.6, 2.4] }],
  },
};

/** Built-in objects with all defaults applied. */
export const OBJECT_LIBRARY: Record<string, ObjectDef> = Object.fromEntries(
  Object.entries(LIBRARY).map(([id, def]) => [id, ObjectSchema.parse(def)]),
);
