// Festung Königstein: the rock's plateau outline, ramparts that follow it side by side,
// and the buildings and bastions on the flat top. The terrain raises the outline to
// FORT_LEVEL (terrain.ts), so everything here stands at one known height.
import type { V2 } from "./lib";
import { r1 } from "./lib";

/** The fortress plateau's rim, counter-clockwise, with the Friedrichsburg bastion at the north-east tip. */
export const FORT: V2[] = [
  [1250, 920], [1258, 893], [1280, 874], [1312, 864], [1348, 865], [1380, 875], [1406, 893], [1420, 920],
  [1418, 950], [1406, 972], [1392, 992], [1366, 990], [1336, 996], [1302, 990], [1274, 974], [1256, 950],
];
/** Height of the plateau (m). */
export const FORT_LEVEL = 66;

const WALL_THICK = 2.8;      // m
const WALL_HIGH = 6.5;       // m above the plateau to the wall top
const WALL_DEEP = 26;        // m the wall reaches below the plateau: its ends, past the corners, stand on the falling cliff
const OVERLAP = 1.4;         // m each wall runs on past its corner, so neighbours close the joint
const MERLON_STEP = 2.6;     // m between merlons

type Obj = Record<string, unknown>;
export type Placed = { object: string; at: V2; rotation: number; z: number; name?: string; scale?: number };

const signedArea = (p: V2[]) => p.reduce((a, q, i) => { const r = p[(i + 1) % p.length]; return a + q[0] * r[1] - r[0] * q[1]; }, 0) / 2;

/**
 * One wall object per side of the outline, each exactly as long as its side (plus the
 * corner overlap), with merlons along the outer edge; placed with its outer face on the
 * rim and its front (+x) facing out.
 */
export function fortressWalls(): { objects: Record<string, Obj>; placed: Placed[] } {
  const ccw = signedArea(FORT) > 0;
  const objects: Record<string, Obj> = {};
  const placed: Placed[] = [];
  FORT.forEach((a, k) => {
    const b = FORT[(k + 1) % FORT.length];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const side = Math.hypot(dx, dy);
    // Outward normal: to the right of the direction of travel round a counter-clockwise outline.
    const out: V2 = ccw ? [dy / side, -dx / side] : [-dy / side, dx / side];
    const L = r1(side + 2 * OVERLAP);
    const n = Math.max(2, Math.floor((L - 2) / MERLON_STEP) + 1);
    const step = r1((L - 2.4) / (n - 1) * 100) / 100;
    const id = `festungswall-${k + 1}`;
    objects[id] = {
      description: `Rampart of the Königstein fortress, ${L} m along y: a sandstone wall on the cliff edge with merlons on its outer edge (+x)`,
      tint: ["#c9b48c", "#bfa77c"], maxSlope: 80,
      parts: [
        { shape: "box", at: [0, 0, -WALL_DEEP], size: [WALL_THICK, L, WALL_DEEP + WALL_HIGH] },
        { shape: "box", at: [WALL_THICK / 2 - 0.08, 0, WALL_HIGH - 2.2], size: [0.2, L, 0.35], color: "#a8946c" },
        { shape: "box", at: [WALL_THICK / 2 - 0.45, -L / 2 + 1.2, WALL_HIGH], size: [0.9, 1.3, 1.1], grid: [1, n, 1], step: [0, step, 0], color: "#a8946c" },
      ],
    };
    const mid: V2 = [(a[0] + b[0]) / 2 - out[0] * (WALL_THICK / 2), (a[1] + b[1]) / 2 - out[1] * (WALL_THICK / 2)];
    placed.push({ object: id, at: [r1(mid[0]), r1(mid[1])], rotation: r1((Math.atan2(out[1], out[0]) * 180) / Math.PI), z: FORT_LEVEL });
  });
  return { objects, placed };
}

/** The buildings, bastions and the well house on the plateau. */
export function fortressBuildings(): Placed[] {
  const z = FORT_LEVEL;
  return [
    { object: "festung-turm", at: [1385, 983], rotation: 45, z, name: "Friedrichsburg" },
    { object: "festung-turm", at: [1274, 903], rotation: 0, z, name: "Torhaus", scale: 0.75 },
    { object: "festung-turm", at: [1407, 922], rotation: 0, z, name: "Seigerturm", scale: 0.6 },
    { object: "festung-bau", at: [1340, 884], rotation: 90, z, name: "Magdalenenburg" },
    { object: "festung-bau", at: [1300, 958], rotation: 0, z, name: "Georgenburg" },
    { object: "festung-bau", at: [1374, 936], rotation: 90, z, name: "Altes Zeughaus", scale: 0.8 },
    { object: "festung-kirche", at: [1346, 974], rotation: 180, z, name: "Garnisonkirche" },
    { object: "weinberghaus", at: [1326, 916], rotation: 0, z, name: "Brunnenhaus", scale: 1.3 },
  ];
}

/** Points a little way out from each corner of the rim, where rock towers stand on the talus. */
export function fortressRocks(distance: number): V2[] {
  const ccw = signedArea(FORT) > 0;
  return FORT.filter((_, k) => k % 2 === 0).map((p, j) => {
    const k = j * 2;
    const a = FORT[(k + FORT.length - 1) % FORT.length], c = FORT[(k + 1) % FORT.length];
    const tx = c[0] - a[0], ty = c[1] - a[1];
    const L = Math.hypot(tx, ty);
    const out: V2 = ccw ? [ty / L, -tx / L] : [-ty / L, tx / L];
    return [r1(p[0] + out[0] * distance), r1(p[1] + out[1] * distance)] as V2;
  });
}
