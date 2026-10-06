// Custom scenery objects for the Sächsische Schweiz layout.
import { moreObjects } from "./objects2";
import { fortressWalls } from "./fortress";

export function objects(): Record<string, unknown> {
  const more = moreObjects();
  return {
    ...more,
    ...fortressWalls().objects,
    // The garrison church on the fortress: the village church's shape, without a congregation to walk up.
    "festung-kirche": { ...more["dorfkirche"], description: "The fortress's garrison church: a white nave and a west tower with a slate bell-cap", building: undefined },
    "bahnhof-gross": {
      description: "Main-line station building: two storeys of sandstone, a hipped slate roof, a clock gable over the entrance; door at the back",
      tint: ["#e6d7b8", "#dccaa6", "#e9dcc4"],
      building: { functions: ["workplace", "landmark"], jobs: 6, titles: ["Station manager", "Ticket clerk", "Dispatcher"], kind: "Station", door: [-5.4, 0] },
      parts: [
        { shape: "box", at: [0, 0, -2], size: [10, 26, 9] },
        { shape: "pyramid", at: [0, 0, 7], size: [11, 27, 3.6], taper: [0.4, 0.85], color: "roof-slate", winter: "snow" },
        { shape: "box", at: [0, 0, -2], size: [12, 8, 10.5], color: "#cdb88f" },
        { shape: "gable", at: [0, 0, 8.5], size: [12.6, 8.6, 2.6], rotate: [0, 0, 90], color: "roof-slate", winter: "snow" },
        { shape: "cylinder", at: [6.05, 0, 6.6], size: [0.15, 1.4, 1.4], rotate: [0, 90, 0], sides: 12, color: "white" },
        { shape: "panel", at: [5.03, -9, 1.2], size: [0.1, 1.3, 1.6], grid: [1, 4, 2], step: [0, 2.4, 3], color: "window" },
        { shape: "panel", at: [5.03, 9, 1.2], size: [0.1, 1.3, 1.6], grid: [1, 2, 2], step: [0, -2.4, 3], color: "window" },
        { shape: "panel", at: [6.03, 0, 0], size: [0.1, 2.4, 2.8], color: "timber" },
        { shape: "panel", at: [-6.03, 0, 0], size: [0.1, 2.4, 2.8], rotate: [0, 0, 180], color: "timber" },
        { shape: "panel", at: [-5.03, 0, 1.2], size: [0.1, 1.3, 1.6], grid: [1, 6, 2], step: [0, 3.6, 3], mirror: "y", rotate: [0, 0, 180], color: "window" }
      ]
    },
    "bahnhof-klein": {
      description: "Small country station: a half-timbered upper floor over a sandstone ground floor, a steep roof with a little canopy; door at the back",
      tint: ["#efe3c8", "#e6d3ad", "#f1e8d6"],
      building: { functions: ["workplace"], jobs: 2, titles: ["Station master", "Ticket clerk"], kind: "Station", door: [-3.6, 0] },
      parts: [
        { shape: "box", at: [0, 0, -2], size: [7, 13, 5], color: "#c9b48c" },
        { shape: "box", at: [0, 0, 3], size: [7.2, 13.2, 2.8] },
        { shape: "panel", at: [3.63, 0, 3.1], size: [0.06, 13, 0.18], grid: [1, 1, 2], step: [0, 0, 2.5], color: "timber" },
        { shape: "panel", at: [3.63, -6.4, 3], size: [0.06, 0.2, 2.8], grid: [1, 7, 1], step: [0, 2.13, 0], color: "timber" },
        { shape: "gable", at: [0, 0, 5.8], size: [8.2, 14.2, 3.6], rotate: [0, 0, 90], color: "roof", winter: "snow" },
        { shape: "panel", at: [3.53, -4, 0.9], size: [0.1, 1.1, 1.5], grid: [1, 3, 1], step: [0, 4, 0], color: "window" },
        { shape: "panel", at: [3.65, -3, 3.6], size: [0.1, 1, 1.2], grid: [1, 3, 1], step: [0, 3, 0], color: "window" },
        { shape: "panel", at: [-3.53, 0, 0], size: [0.1, 1.6, 2.4], rotate: [0, 0, 180], color: "timber" },
        { shape: "box", at: [4.2, 0, 2.9], size: [2, 10, 0.2], color: "roof-dark" }
      ]
    },
    "wartehalle": {
      description: "Tram stop shelter: a little timber hut open toward the platform, a bench inside, a shingled roof",
      tint: ["#8a6a48", "#7d5e3f", "#94724e"],
      parts: [
        { shape: "box", at: [0, 0, -2.6], size: [2.6, 5.2, 2.6], color: "stone" },
        { shape: "box", at: [-1.1, 0, -0.5], size: [0.2, 5, 2.9] },
        { shape: "box", at: [0, -2.4, -0.5], size: [2.4, 0.2, 2.9], grid: [1, 2, 1], step: [0, 4.8, 0] },
        { shape: "gable", at: [0, 0, 2.4], size: [3.2, 5.8, 1.1], rotate: [0, 0, 90], color: "roof-dark", winter: "snow" },
        { shape: "box", at: [-0.7, 0, 0.45], size: [0.5, 4, 0.08], color: "timber" }
      ]
    },
    "kohlebunker": {
      description: "Colliery loading bunker: a tall concrete hopper on legs over the siding, with a conveyor housing climbing to it; door at the back",
      tint: ["#8f8a82", "#9a948b"],
      building: { functions: ["workplace"], jobs: 4, titles: ["Loader", "Weighbridge clerk"], kind: "Coal loading", door: [-2.6, 0], supplies: {}, demands: {} },
      parts: [
        { shape: "box", at: [0, -5, 0], size: [0.8, 0.8, 7], grid: [1, 2, 1], step: [0, 10, 0], mirror: "x" },
        { shape: "box", at: [0, 0, 6.5], size: [5, 14, 5], taper: [1, 1] },
        { shape: "box", at: [0, 0, 5], size: [3, 10, 1.6], taper: [0.5, 0.8], rotate: [180, 0, 0], color: "dark" },
        { shape: "gable", at: [0, 0, 11.5], size: [5.4, 14.4, 1.4], rotate: [0, 0, 90], color: "roof-grey" },
        { shape: "box", at: [-6, 4, 0], size: [2.4, 2.4, 12], rotate: [0, -25, 0], color: "#7c776f" }
      ]
    }
  };
}
