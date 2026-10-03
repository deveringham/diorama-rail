// Every colour and lighting constant in one place. Plain sRGB hex numbers and
// numbers only (no three.js), so the model can pick scenery colours from here.
// Aim: soft, slightly desaturated, warm light and cool shadows.

export type Season = "summer" | "autumn" | "winter";

export const PALETTE = {
  terrain: {
    summer: { grass: [0x93b36b, 0x8aad66, 0x9cba72], grassDark: [0x759a57, 0x6e9152], field: 0xadb673 },
    autumn: { grass: [0xa5ad6a, 0x9fa565, 0xaeb26f], grassDark: [0x87905a, 0x7f8854], field: 0xc7a96a },
    winter: { grass: [0xe9edf0, 0xe2e8ec, 0xdde4e8], grassDark: [0xc9d3d8, 0xc2ccd2], field: 0xeef1f3 },
    rock: [0x9c968a, 0x8f897e],
    sand: 0xd9cb9c,
    snow: 0xf4f6f8,
    earth: 0x6e5443,        // diorama block sides
    earthDark: 0x5a4436,
  },
  table: 0x9a7d62,
  frame: 0x4b3628,
  water: [0x5c97ad, 0x6aa3b6, 0x5390a8],
  waterSide: 0x3f7488,
  ballast: 0x8d867b,
  ballastSide: 0x7a7369,
  sleeper: 0x5d4b3d,
  rail: 0x6c6a6c,
  bufferStop: 0xb8473a,
  platform: 0xbdb5a6,
  platformEdge: 0xe9e3c9,
  canopy: 0x6f8a8c,
  canopyPost: 0x4e5a5c,
  bridge: 0xa8a196,
  pier: 0x918a7f,
  parapet: 0xb7b0a4,
  portal: 0x8f877b,
  portalDark: 0x2a2724,
  road: { summer: 0x7d7a75, autumn: 0x7b7873, winter: 0xc8cdd1 },
  verge: { summer: 0x9d9686, autumn: 0x9b9282, winter: 0xe2e7ea },
  roadLine: 0xece8dc,
  sidewalk: { summer: 0xbab5ab, autumn: 0xb7b1a6, winter: 0xe4e8eb },
  kerb: 0x9a958c,
  gravel: { summer: 0xc8b996, autumn: 0xc0ad8a, winter: 0xe6e8ea },
  pathEdge: { summer: 0xa3966f, autumn: 0x9e8f6b, winter: 0xd5d9dc },
  boards: 0x7a5c44,
  crossingPanel: 0x5a5651,
  signalPost: 0xdedbd3,
  signalRed: 0xc23a2e,
  signalWhite: 0xf3f1ec,
  signalBack: 0x2b2b2d,
  lampOn: 0xff3b22,
  lampOff: 0x4a1d18,
  walls: [0xf0e7d5, 0xe8d2a6, 0xdfbba6, 0xcbd5d6, 0xf4f0e8, 0xe4c99d, 0xd6c3b0],
  roofs: { house: 0xa9573f, terrace: 0x6e5c58, flats: 0x8b8a86, church: 0x5d6672 },
  windowLit: 0xffc477,
  trees: {
    summer: { deciduous: [0x6f9a4f, 0x7aa457, 0x648f48, 0x86ad5e], conifer: [0x4f7a4f, 0x587f52, 0x46704a] },
    autumn: { deciduous: [0xd0873e, 0xc8603a, 0xdcae4a, 0xa94f34, 0xb9a043], conifer: [0x4f7350, 0x557852] },
    winter: { deciduous: [0x8d847c, 0x81786f], conifer: [0x4c6b55, 0x52705a] },
  },
  people: [0xc0504d, 0x4f81bd, 0x9bbb59, 0xf2c14e, 0x8064a2, 0x4bacc6, 0xf79646, 0x5b5b5b, 0xe6e0d0],
  skin: 0xe8c4a8,
  smoke: 0xe9e6e1,
  trainWindow: 0x2d3640,
  trainUnder: 0x3a3a3c,
  trainRoof: 0xb9b6b0,
  freightLoco: 0xb8473a,
} as const;

/**
 * Named colours scenery objects may use instead of hex (see model/objects.ts).
 * "foliage" and "needles" are seasonal and come from PALETTE.trees.
 */
export const OBJECT_COLORS = {
  wall: 0xf0e7d5, plaster: 0xe8d2a6, brick: 0xa65d47, stone: 0x9b948a, concrete: 0xb5b1a8,
  wood: 0x8a6446, timber: 0x5d4636, metal: 0x7d8288, dark: 0x3a3a3c, white: 0xf4f2ee,
  red: 0xb8473a, yellow: 0xe2b33c, blue: 0x4f6f9a, green: 0x5f8a4e,
  roof: 0xa9573f, "roof-slate": 0x5d6672, "roof-dark": 0x6e5c58, "roof-grey": 0x8b8a86,
  chimney: 0x575350, trunk: 0x6b5140, window: 0x3c4651, lamp: 0xf3e3b8,
  snow: 0xf6f8fa, sand: 0xd9cb9c, water: 0x5c97ad, grass: 0x93b36b,
} as const;

/** Sky, fog and light keyframes over the day, interpolated by hour. */
export const DAY_KEYS = [
  { hour: 0, sky: 0x16223a, sun: 0x9fb2e6, sunI: 0.7, hemiSky: 0x40547e, hemiGround: 0x1c2026, hemiI: 0.8, windows: 1 },
  { hour: 5, sky: 0x1e2a46, sun: 0x9fb2e6, sunI: 0.7, hemiSky: 0x46587e, hemiGround: 0x1e2228, hemiI: 0.85, windows: 1 },
  { hour: 6.5, sky: 0xe7b394, sun: 0xffb27f, sunI: 1.4, hemiSky: 0xd6c6c0, hemiGround: 0x5a4e46, hemiI: 0.9, windows: 0.6 },
  { hour: 8.5, sky: 0xbcd3e3, sun: 0xfff0da, sunI: 2.9, hemiSky: 0xcfe0ec, hemiGround: 0x6d6250, hemiI: 1.0, windows: 0 },
  { hour: 16, sky: 0xc3d6e2, sun: 0xffeccf, sunI: 2.9, hemiSky: 0xd3e1ea, hemiGround: 0x6e6150, hemiI: 1.0, windows: 0 },
  { hour: 18.5, sky: 0xeeb48c, sun: 0xffa66a, sunI: 1.5, hemiSky: 0xdcc2b4, hemiGround: 0x5d4c42, hemiI: 0.95, windows: 0.5 },
  { hour: 20, sky: 0x3c4466, sun: 0x9fb2e6, sunI: 0.75, hemiSky: 0x4c5a84, hemiGround: 0x20232a, hemiI: 0.85, windows: 1 },
  { hour: 24, sky: 0x16223a, sun: 0x9fb2e6, sunI: 0.7, hemiSky: 0x40547e, hemiGround: 0x1c2026, hemiI: 0.8, windows: 1 },
] as const;

export const LIGHT = {
  sunMaxElevation: 46,      // degrees at noon; lowish so relief reads
  sunAzimuthNoon: 270,      // degrees CCW from east (model frame): noon sun stands in the south
  shadowMapSize: 2048,
  fogNear: 2.4,             // × half the diorama diagonal
  fogFar: 7,
  windowGlow: 1.6,          // emissive intensity at full night
  exposure: 1.0,
} as const;
