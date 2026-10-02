// Every colour and lighting constant in one place. Plain sRGB hex numbers and
// numbers only (no three.js), so the model can pick scenery colours from here.
// Aim: soft, slightly desaturated, warm light and cool shadows.

export type Season = "summer" | "autumn" | "winter";

export const PALETTE = {
  terrain: {
    summer: { grass: [0x93b36b, 0x8aad66, 0x9cba72], grassDark: [0x759a57, 0x6e9152], field: 0xb9b878 },
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
  bench: 0x6a4a35,
  stationWall: 0xe4d4b4,
  stationRoof: 0x8e4a3a,
  bridge: 0xa8a196,
  pier: 0x918a7f,
  parapet: 0xb7b0a4,
  portal: 0x8f877b,
  portalDark: 0x2a2724,
  walls: [0xf0e7d5, 0xe8d2a6, 0xdfbba6, 0xcbd5d6, 0xf4f0e8, 0xe4c99d, 0xd6c3b0],
  roofs: { house: 0xa9573f, terrace: 0x6e5c58, flats: 0x8b8a86, church: 0x5d6672 },
  window: 0x3c4651,
  windowLit: 0xffc477,
  trunk: 0x6b5140,
  trees: {
    summer: { deciduous: [0x6f9a4f, 0x7aa457, 0x648f48, 0x86ad5e], conifer: [0x4f7a4f, 0x587f52, 0x46704a] },
    autumn: { deciduous: [0xd0873e, 0xc8603a, 0xdcae4a, 0xa94f34, 0xb9a043], conifer: [0x4f7350, 0x557852] },
    winter: { deciduous: [0x7a6a5e, 0x6f6157], conifer: [0x4c6b55, 0x52705a] },
  },
  snowCap: 0xf6f8fa,
  people: [0xc0504d, 0x4f81bd, 0x9bbb59, 0xf2c14e, 0x8064a2, 0x4bacc6, 0xf79646, 0x5b5b5b, 0xe6e0d0],
  skin: 0xe8c4a8,
  smoke: 0xe9e6e1,
  trainWindow: 0x2d3640,
  trainUnder: 0x3a3a3c,
  trainRoof: 0xb9b6b0,
  freightLoco: 0xb8473a,
  chimney: 0x575350,
} as const;

/** Sky, fog and light keyframes over the day, interpolated by hour. */
export const DAY_KEYS = [
  { hour: 0, sky: 0x101a2c, sun: 0x8ea2d6, sunI: 0.35, hemiSky: 0x34466a, hemiGround: 0x15181c, hemiI: 0.45, windows: 1 },
  { hour: 5, sky: 0x1c2640, sun: 0x8ea2d6, sunI: 0.35, hemiSky: 0x3c4c70, hemiGround: 0x1a1d22, hemiI: 0.5, windows: 1 },
  { hour: 6.5, sky: 0xe7b394, sun: 0xffb27f, sunI: 1.4, hemiSky: 0xd6c6c0, hemiGround: 0x5a4e46, hemiI: 0.9, windows: 0.6 },
  { hour: 8.5, sky: 0xbcd3e3, sun: 0xfff0da, sunI: 2.9, hemiSky: 0xcfe0ec, hemiGround: 0x6d6250, hemiI: 1.0, windows: 0 },
  { hour: 16, sky: 0xc3d6e2, sun: 0xffeccf, sunI: 2.9, hemiSky: 0xd3e1ea, hemiGround: 0x6e6150, hemiI: 1.0, windows: 0 },
  { hour: 18.5, sky: 0xeeb48c, sun: 0xffa66a, sunI: 1.5, hemiSky: 0xdcc2b4, hemiGround: 0x5d4c42, hemiI: 0.95, windows: 0.5 },
  { hour: 20, sky: 0x3c4466, sun: 0x9aa8d8, sunI: 0.45, hemiSky: 0x46527a, hemiGround: 0x1e2026, hemiI: 0.55, windows: 1 },
  { hour: 24, sky: 0x101a2c, sun: 0x8ea2d6, sunI: 0.35, hemiSky: 0x34466a, hemiGround: 0x15181c, hemiI: 0.45, windows: 1 },
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
