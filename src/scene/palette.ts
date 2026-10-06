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
  /** Ground cover (terrain.areas): two shades each, alternated in stripes for rows or jittered otherwise. */
  cover: {
    meadow: { summer: [0xa6bf70, 0x9fb96b], autumn: [0xb4b26e, 0xadab69], winter: [0xedf0f2, 0xe6eaed] },
    pasture: { summer: [0x8db564, 0x84ad5e], autumn: [0x9fae66, 0x97a660], winter: [0xe9edf0, 0xe1e7ea] },
    field: { summer: [0xcdb767, 0xa9b55e], autumn: [0x9a7a55, 0x8a6c4b], winter: [0xedf0f1, 0xd8dbd6] },
    vineyard: { summer: [0x86a050, 0xa08562], autumn: [0xc29a45, 0x9d7a55], winter: [0xe3e5e5, 0xc8c2b8] },
    orchard: { summer: [0x9cbd6d, 0x93b566], autumn: [0xaeb26c, 0xa6a966], winter: [0xeaeef0, 0xe2e7ea] },
    garden: { summer: [0x86b25e, 0x9a8a62], autumn: [0x9aa75f, 0x8e7d5c], winter: [0xe6eaec, 0xd9d6d0] },
    park: { summer: [0x7fb25c, 0x87b862], autumn: [0x95aa5e, 0x8da459], winter: [0xeaeef0, 0xe3e8eb] },
    forest: { summer: [0x637f47, 0x5b7742], autumn: [0x7d6c42, 0x726a44], winter: [0xdce2e5, 0xd2d9dc] },
    heath: { summer: [0x8f8a5c, 0x8e7a6a], autumn: [0x8f7458, 0x86705a], winter: [0xe2e5e6, 0xd8dbdc] },
    marsh: { summer: [0x77905a, 0x6c8761], autumn: [0x8f8a57, 0x7f805a], winter: [0xd9e0e3, 0xcdd6da] },
    sand: { summer: [0xdacc9d, 0xd2c494], autumn: [0xd4c595, 0xccbd8d], winter: [0xece9df, 0xe4e0d4] },
    gravel: { summer: [0xb7ae9c, 0xaca492], autumn: [0xb2a997, 0xa79f8d], winter: [0xe3e4e2, 0xd7d8d5] },
    rock: { summer: [0xa99d85, 0x9d917a], autumn: [0xa59980, 0x998d76], winter: [0xe0e1df, 0xc9c6bf] },
    spoil: { summer: [0x4d4a47, 0x585450], autumn: [0x4d4a47, 0x585450], winter: [0x8e8c8a, 0x6e6c6a] },
    yard: { summer: [0xa09c93, 0x969189], autumn: [0x9d9990, 0x938e86], winter: [0xd8dadb, 0xcdd0d1] },
    town: { summer: [0x93a66c, 0x9ba677], autumn: [0xa1a56d, 0x9a9b6c], winter: [0xe5e9eb, 0xdde2e5] },
  },
  /** Inland water and its shores. */
  inland: {
    river: [0x5b8e8e, 0x649892, 0x56868a],
    stream: [0x6a9fa3, 0x74a9aa, 0x63979c],
    lake: [0x4f8798, 0x5890a0, 0x4a7f91],
    pond: [0x587f6a, 0x5f876f, 0x527864],
    foam: 0xdde8e6,
    bed: 0x6b6a58,
    riverShore: [0xbcb193, 0xb0a588],
    lakeShore: [0x8b9160, 0x7f8a5c],
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
  dock: 0xa9a59c,                    // a goods yard's loading dock
  dockEdge: 0x8a857c,
  crateLid: 0x5a4632,
  canopy: 0x6f8a8c,
  canopyPost: 0x4e5a5c,
  bridge: 0xa8a196,
  pier: 0x918a7f,
  parapet: 0xb7b0a4,
  portal: 0x8f877b,
  portalDark: 0x2a2724,
  road: { summer: 0x7d7a75, autumn: 0x7b7873, winter: 0xc8cdd1 },
  parking: { summer: 0x8a8781, autumn: 0x88857f, winter: 0xd2d6d9 },
  verge: { summer: 0x9d9686, autumn: 0x9b9282, winter: 0xe2e7ea },
  roadLine: 0xece8dc,
  busMark: 0xe3bf3a,
  busSign: 0x3f8a5a,
  busPost: 0x8d9196,
  shelterGlass: 0xa9c4cf,
  shelterFrame: 0x4b5258,
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
  signalPole: 0x44484c,
  signalHousing: 0x24262a,
  lights: { red: [0xff3b22, 0x3a1612], amber: [0xffb020, 0x3a2a12], green: [0x3fe06e, 0x123a1e] },
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
