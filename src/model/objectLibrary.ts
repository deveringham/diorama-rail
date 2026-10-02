// Built-in scenery objects, in exactly the format a layout's "objects" section
// uses (see model/objects.ts and docs/LAYOUT_GUIDE.md). Add an entry here to make
// an object available to every layout; a layout may also redefine any of these.

import { ObjectSchema, type ObjectDef, type ObjectInput } from "./objects";

const LIBRARY: Record<string, ObjectInput> = {
  // --- buildings ------------------------------------------------------------
  house: {
    description: "Two-storey house, 7 × 9 m, front door facing +x, chimney that sometimes smokes",
    tint: "walls",
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
    parts: [
      { shape: "box", at: [0, 0, -2], size: [10, 16, 7] },
      { shape: "gable", at: [0, 0, 5], size: [16.8, 11, 4.5], rotate: [0, 0, 90], color: "roof-grey", winter: "snow" },
      { shape: "panel", at: [5.03, 0, 0], size: [0.1, 4.5, 4.2], color: "timber" },
    ],
  },
  "station-building": {
    description: "Station building, 9 × 16 m, front facing +x (toward the track); used for every station unless overridden",
    tint: ["#e4d4b4", "#e8d2a6"],
    parts: [
      { shape: "box", at: [0, 0, -3], size: [9, 16, 9.5] },
      { shape: "gable", at: [0, 0, 6.5], size: [16.8, 9.8, 3.6], rotate: [0, 0, 90], color: "#8e4a3a", winter: "snow" },
      { shape: "panel", at: [4.53, -6, 0.8], size: [0.1, 1.4, 2.2], color: "window", grid: [1, 5, 1], step: [0, 3, 0], mirror: "x" },
      { shape: "panel", at: [4.53, -6, 4], size: [0.1, 1.2, 1.3], color: "window", grid: [1, 5, 1], step: [0, 3, 0], mirror: "x" },
      { shape: "panel", at: [4.53, 0, 5.4], size: [0.15, 1, 1], color: "white" },
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

  road: {
    description: "10 m of 6 m wide road along x, a slab 0.2 m proud of the ground; lay segments end to end on gentle ground",
    parts: [
      { shape: "box", at: [0, 0, -0.8], size: [10, 6, 1], color: "#8f8b84", winter: "#d9dde0" },
      { shape: "box", at: [0, 0, -0.8], size: [4, 0.25, 1.02], color: "#d8d2c0" },
    ],
  },
  paving: {
    description: "10 × 10 m paved square, 0.2 m proud of the ground (lay several for a town square)",
    parts: [{ shape: "box", at: [0, 0, -0.8], size: [10, 10, 1], color: "#b9b2a3", winter: "#dfe2e4" }],
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
