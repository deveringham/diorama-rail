// Sites whose outline the terrain, the ground cover and the scenery all follow: the sandstone
// quarry dug into the plateau's edge, the sawmill's timber yard, the Gottleuba reservoir
// in its valley behind the dam, and the landings of the Bastei bridge.
import type { V2 } from "./lib";

/** The quarry floor: a pit cut into the plateau (34 m), open to the valley on its north-east side. */
export const QUARRY: V2[] = [
  [1290, 505], [1335, 492], [1380, 505], [1405, 540], [1420, 585], [1442, 615], [1402, 632], [1360, 612], [1318, 600], [1290, 575], [1278, 540],
];
export const QUARRY_LEVEL = 20;
/** The flooded old workings in the west of the quarry floor. */
export const QUARRY_POND: V2[] = [[1296, 522], [1330, 508], [1354, 528], [1346, 560], [1316, 572], [1292, 552]];

/** The sawmill's yard: round the saw hall north of the road, the log piles south of the siding. */
export const SAWMILL_YARD: V2[] = [
  [1228, 314], [1236, 292], [1240, 252], [1262, 240], [1345, 238], [1392, 246], [1402, 288], [1460, 298], [1484, 314],
  [1462, 340], [1455, 372], [1420, 381], [1330, 383], [1262, 379], [1244, 364], [1236, 336],
];

/** The forester's house and garden beside the yard, dug level with the road. */
export const FORSTHAUS_PLOT: V2[] = [[1404, 246], [1442, 246], [1448, 288], [1400, 288]];

/** The Gottleuba valley above and below the dam (x, y, floor level). */
export const RESERVOIR_VALLEY: Array<[number, number, number]> = [
  [655, 30, 33], [640, 120, 32.5], [668, 200, 32], [700, 270, 32], [707, 311, 32], [708, 319, 24.5], [713, 350, 24.2], [775, 392, 23.9], [850, 428, 23.5], [905, 480, 22.8],
];
export const RESERVOIR_LEVEL = 31;
/** The reservoir: the flooded valley, up to the dam's upstream face. */
export const RESERVOIR: V2[] = [
  [680, 309], [734, 309], [731, 280], [722, 250], [705, 215], [695, 185], [680, 150], [672, 120], [678, 90], [672, 60], [660, 45],
  [645, 55], [622, 90], [612, 125], [625, 165], [640, 200], [655, 230], [668, 262], [675, 290],
];
/** The dam across the valley: centre, rotation (front, +x, facing downstream), height of its base point. */
export const DAM = { at: [707, 315] as V2, rotation: 90, z: 29 };
/** The line across the valley at the dam, along which the ground stands higher. */
export const DAM_SHOULDERS: V2[] = [[620, 318], [795, 312]];

/** The Bastei bridge: its centre (spanning x ± 38 m), and the level of its deck, which the rock at both ends meets. */
export const BASTEI_BRIDGE = { at: [923, 1392] as V2, rotation: -90, deck: 68 };
/** The deck's top above the bridge object's base point. */
export const BASTEI_DECK_TOP = 17.2;
