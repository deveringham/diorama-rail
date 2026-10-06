// Terrain and water of the Sächsische Schweiz layout.
import type { V2 } from "./lib";
import { W, H, meander } from "./lib";

/** The Elbe, west → east as drawn (it flows east → west). */
export const ELBE: V2[] = [[0, 1100], [260, 1105], [520, 1125], [760, 1165], [960, 1215], [1110, 1262], [1390, 1292], [1500, 1210],
  [1555, 1085], [1600, 940], [1680, 840], [1800, 798], [1935, 842], [2040, 935], [2140, 1060], [2290, 1160], [2480, 1215], [2750, 1240], [3000, 1245]];

/** Where roads and paths pass under the corridor: the ground dips so the tracks cross on a short bridge. */
export const UNDERPASSES: Array<{ at: V2; to?: V2; radius: number; level?: number }> = [
  { at: [1101, 975], radius: 26 },    // B172 under the fast pair west of Königstein
  { at: [1478, 842], radius: 26 },    // B172 under the fast pair east of Königstein
  { at: [863, 1000], to: [866, 1086], radius: 24 },   // Pirna: the Elbe bridge road under both pairs of tracks
  { at: [1028, 882], radius: 22 },    // B172 under the industrial line in Pirna
  { at: [1116, 384], radius: 20 },    // Bielatalstraße under the industrial line's Biela viaduct
  { at: [1737, 1884], to: [1737, 1910], radius: 12, level: 39 },   // the Malerweg under the ring line east of Hohnstein
];

export function terrain() {
  const features: unknown[] = [];
  const f = (x: Record<string, unknown>) => features.push(x);

  // The plateaus (Ebenheiten) either side of the Elbe canyon, raised over the valley floor.
  // North: a gentler, terraced slope at Pirna-Copitz for the vineyards, cliffs elsewhere.
  f({ area: [[-80, 1330], [560, 1330], [660, 1460], [-80, 1460]], radius: 95, level: 30, direction: "up", shape: "bump", rough: 0.3 });
  f({
    area: [[-80, 1430], [150, 1450], [380, 1470], [560, 1440], [700, 1360], [850, 1325], [1000, 1335], [1120, 1385], [1280, 1405], [1450, 1365],
      [1620, 1305], [1850, 1295], [2080, 1335], [2200, 1425], [2400, 1455], [2600, 1445], [2720, 1365], [2850, 1360], [3080, 1385], [3080, 2300], [-80, 2300]],
    radius: 70, level: 46, direction: "up", shape: "mesa", cliff: 0.65, rough: 0.55,
  });
  // South: lower, rolling farmland and forest.
  f({
    area: [[-80, 690], [200, 680], [450, 760], [640, 800], [820, 790], [1050, 830], [1200, 800], [1450, 560], [1800, 520], [2020, 620], [2200, 800],
      [2400, 950], [2700, 985], [3080, 1000], [3080, -100], [-80, -100]],
    radius: 85, level: 34, direction: "up", shape: "mesa", cliff: 0.5, rough: 0.5,
  });

  // The Ostrau terrace above Bad Schandau, lower than the plateau behind.
  f({ area: [[2290, 1440], [2690, 1430], [2700, 1590], [2300, 1600]], radius: 60, level: 37, direction: "down", shape: "mesa", cliff: 0.6, rough: 0.35 });
  // Gorges (Gründe) cut into the plateaus, each falling toward the Elbe.
  const gorge = (points: Array<[number, number, number]>, radius: number, plateau = 0.35, cliff = 0.65, rough = 0.45) =>
    f({ points, radius, shape: "mesa", plateau, cliff, rough, direction: "down" });
  gorge([[1000, 1010, 6], [995, 820, 10], [955, 620, 18], [885, 420, 25], [800, 200, 30], [740, -60, 32]], 90, 0.4, 0.5);    // Gottleuba
  gorge([[715, 1170, 6], [700, 1350, 22], [680, 1500, 31], [662, 1700, 41], [640, 1900, 45], [600, 2300, 46]], 95, 0.42, 0.6);  // Wesenitz (Liebethaler Grund)
  gorge([[1180, 1120, 5], [1160, 880, 8], [1120, 620, 15], [1090, 330, 22], [1060, -60, 28]], 70, 0.35, 0.6);                 // Biela
  gorge([[1010, 1250, 5], [1035, 1380, 9], [1070, 1500, 13], [1110, 1640, 18], [1150, 1760, 26], [1190, 1920, 34], [1230, 2300, 40]], 55, 0.3, 0.75); // Amselgrund
  gorge([[2265, 1220, 5], [2245, 1450, 10], [2205, 1650, 17], [2160, 1850, 26], [2120, 2050, 33], [2100, 2300, 38]], 85, 0.4, 0.55);   // Lachsbach
  gorge([[2600, 1240, 5], [2680, 1400, 8], [2780, 1580, 12], [2880, 1760, 16], [2980, 1950, 20], [3080, 2100, 22]], 100, 0.45, 0.65);   // Kirnitzsch
  gorge([[1250, 2300, 42], [1450, 2190, 38], [1700, 2130, 34], [1950, 2060, 31], [2135, 1965, 29]], 60, 0.3, 0.7);   // Polenz

  // Table mountains and rock massifs.
  const mesa = (at: V2, radius: number, height: number, plateau = 0.5, cliff = 0.75, rough = 0.5) =>
    f({ at, radius, height, shape: "mesa", plateau, cliff, rough });
  mesa([1790, 1010], 175, 70, 0.5, 0.75, 0.5);     // Lilienstein, in the Elbe's loop
  mesa([1330, 925], 135, 60, 0.6, 0.85, 0.3);      // Königstein, the fortress rock
  mesa([560, 450], 120, 38, 0.5, 0.8, 0.6);        // Pfaffenstein
  mesa([1560, 180], 100, 30, 0.5, 0.75, 0.6);      // Gohrisch
  mesa([2100, 330], 110, 34, 0.5, 0.8, 0.5);       // Papststein
  mesa([2860, 740], 60, 24, 0.45, 0.85, 0.4);      // Zirkelstein
  mesa([2590, 770], 50, 18, 0.35, 0.9, 0.9);       // Kaiserkrone
  // The Bastei: jagged rock above Rathen.
  for (const [at, r, h] of [[[880, 1400], 70, 22], [[975, 1385], 60, 27], [[1070, 1420], 62, 20], [[940, 1470], 80, 14], [[1150, 1450], 50, 16]] as Array<[V2, number, number]>) {
    mesa(at, r, h, 0.4, 0.9, 0.85);
  }
  // The Schrammsteine: a ragged ridge between the Elbe and the Kirnitzsch east of Bad Schandau.
  f({ points: [[2800, 1385], [2900, 1440], [2980, 1470], [3060, 1495]], radius: 65, height: 30, shape: "mesa", plateau: 0.3, cliff: 0.85, rough: 0.85 });
  // Rolling hills on the plateaus, and the Großer Winterberg at the back.
  for (const [at, radius, height] of [[[2760, 2020], 280, 34], [[620, 1920], 260, 9], [[1720, 2150], 300, 12], [[2330, 2100], 240, 8],
    [[300, 250], 260, 8], [[1320, 180], 300, 9], [[2480, 230], 300, 6], [[1900, 120], 220, 7],
    [[250, 1800], 260, 10], [[1000, 2130], 170, 8], [[1650, 1640], 210, 9], [[2450, 1720], 190, 11],
    [[250, 620], 240, 10], [[920, 140], 200, 9], [[2400, 300], 190, 9], [[2850, 250], 250, 12]] as Array<[V2, number, number]>) {
    f({ at, radius, height });
  }
  for (const u of UNDERPASSES) {
    f({ ...(u.to ? { points: [u.at, u.to] } : { at: u.at }), radius: u.radius, level: u.level ?? 0.3, direction: "down", shape: "mesa", plateau: 0.55, cliff: 0.7 });
  }
  // Hohnstein's castle rock.
  mesa([1492, 1856], 38, 11, 0.55, 0.85, 0.5);
  // Level yards dug into the slopes: the colliery's sidings and the sawmill's timber yard.
  f({ area: [[975, 600], [1035, 600], [1060, 640], [1108, 660], [1110, 830], [995, 820], [985, 700]], radius: 20, level: 13.6, direction: "down", shape: "mesa", plateau: 0.5, cliff: 0.6 });
  f({ area: [[1240, 240], [1470, 240], [1470, 385], [1240, 385]], radius: 30, level: 31, direction: "down", shape: "mesa", plateau: 0.5, cliff: 0.5 });
  // Slopes graded for the roads: inclined planes under the hairpin climbs, shelves cut into valley sides.
  const ramp = (points: Array<[number, number, number]>, radius: number, plateau = 0.75, cliff = 0.3) =>
    f({ points, radius, shape: "mesa", plateau, cliff, rough: 0 });
  ramp([[2470, 1305, 5.5], [2470, 1458, 37]], 100, 0.8);                 // Ostrauer Steige
  ramp([[615, 1290, 6.5], [620, 1445, 33.5]], 72);                         // Lohmener Steige, through the vineyards
  ramp([[690, 885, 6.5], [690, 690, 34]], 90, 0.8);                        // Struppener Straße
  ramp([[2795, 1048, 7.5], [2795, 850, 34]], 85, 0.8);                     // Krippener Steige, down the Krippengrund
  ramp([[2125, 1778, 42], [2128, 1625, 17]], 55);                          // Altendorfer Steige
  ramp([[1108, 300, 22.4], [1240, 303, 31]], 24, 0.5, 0.4);                // Sägewerkstraße, out of the Bielatal
  // Hiking paths: the Schwedenlöcher gully off the Bastei, the climbs to the summits and the castle, into the Kirnitzschtal.
  ramp([[975, 1525, 46.5], [1000, 1490, 38], [1018, 1455, 27], [1033, 1420, 16], [1042, 1395, 12]], 16, 0.6, 0.4);
  ramp([[2740, 1792, 49], [2790, 1772, 36], [2832, 1752, 20]], 14, 0.6, 0.4);
  ramp([[2272, 500, 35], [2205, 415, 52], [2150, 362, 67]], 14, 0.6, 0.4);
  ramp([[2052, 362, 67], [1990, 395, 50], [1972, 412, 36]], 14, 0.6, 0.4);
  ramp([[395, 522, 35], [470, 488, 55], [512, 466, 70]], 14, 0.6, 0.4);
  ramp([[1545, 1890, 46.5], [1528, 1878, 51], [1512, 1866, 56]], 10, 0.6, 0.4);
  ramp([[1066, 906, 5.8], [1061, 830, 10], [1049, 760, 13.6], [1041, 690, 13.6], [1036, 630, 16.5], [1031, 560, 24], [1036, 522, 27.5]], 22, 0.5, 0.4); // Gottleubatalstraße

  return {
    size: [W, H], cell: 5, baseHeight: 6, noise: { amplitude: 1.2, scale: 170 }, rock: "#b8a27e",
    features,
    areas: [] as unknown[],
  };
}

export function waters() {
  const water: unknown[] = [];
  water.push({
    id: "elbe", kind: "river", name: "Elbe", width: 72, depth: 3.5, bank: 12, clearance: 5.5,
    points: [...ELBE].reverse().map((p, i, a) => (i === 0 ? { at: p, z: 1.6 } : i === a.length - 1 ? { at: p, z: 0.2 } : p)),
  });
  let seed = 40;
  const stream = (id: string, name: string, points: Array<V2 | { at: V2; z?: number; width?: number }>, width = 6, extra: Record<string, unknown> = {}) =>
    water.push({ id, kind: "stream", name, width, points: points.every(Array.isArray) ? meander(points as V2[], width * 1.6, 70 + width * 6, seed++) : points, ...extra });
  stream("gottleuba", "Gottleuba", [[705, 322], [800, 372], [868, 432], [943, 620], [983, 820], [988, 1010], [1022, 1090], [1040, 1160], [1048, 1245]], 7);
  stream("wesenitz", "Wesenitz", [[600, 2200], [622, 1900], [645, 1700], [664, 1500], [688, 1350], [708, 1165]], 6);
  stream("biela", "Biela", [[1060, 0], [1085, 300], [1115, 600], [1155, 860], [1180, 1080], [1190, 1240]], 6);
  stream("amselgrundbach", "Amselgrundbach", [[1235, 2200], [1195, 1950], [1160, 1790], [1120, 1650], [1085, 1530]], 4);
  stream("amselgrundbach-unten", "Amselgrundbach", [[1052, 1430], [1030, 1340], [1008, 1240]], 4);
  stream("polenz", "Polenz", [[1290, 2200], [1450, 2190], [1700, 2130], [1950, 2060], [2148, 1960]], 6);
  stream("lachsbach", "Lachsbach", [[2100, 2200], [2120, 2050], [2160, 1850], [2205, 1650], [2245, 1450], [2265, 1250], [2272, 1190]], 8);
  stream("kirnitzsch", "Kirnitzsch", [[3000, 1948], [2880, 1760], [2780, 1580], [2680, 1400], [2610, 1280], [2598, 1215]], 8);
  stream("lichtenhainer-bach", "Lichtenhainer Bach", [{ at: [2995, 1640], z: 45 }, { at: [2955, 1665], z: 43 }, { at: [2928, 1690], z: 24 }, { at: [2888, 1748], z: 15.5 }], 4);

  const lake = (id: string, kind: "lake" | "pond", name: string, points: V2[], extra: Record<string, unknown> = {}) =>
    water.push({ id, kind, name, points, ...extra });
  lake("amselsee", "lake", "Amselsee", [[1040, 1440], [1078, 1448], [1100, 1488], [1092, 1528], [1062, 1512], [1046, 1478]], { depth: 2.5 });
  lake("gottleuba-talsperre", "lake", "Talsperre Gottleuba", [[600, 110], [700, 80], [770, 150], [745, 250], [690, 320], [620, 270], [585, 190]], { level: 27, depth: 6 });
  lake("steinbruchsee", "lake", "Steinbruchsee", [[1300, 520], [1345, 505], [1380, 540], [1360, 585], [1310, 590], [1285, 555]], { depth: 8 });
  lake("waldbad", "lake", "Waldbad Gohrisch", [[1700, 215], [1780, 195], [1835, 235], [1825, 295], [1760, 315], [1705, 280]], { depth: 3 });
  lake("dorfteich-lohmen", "pond", "Dorfteich Lohmen", [[505, 1690], [532, 1688], [540, 1708], [518, 1720], [500, 1708]]);
  lake("dorfteich-papstdorf", "pond", "Dorfteich Papstdorf", [[2238, 515], [2262, 512], [2268, 534], [2246, 542], [2232, 530]]);
  lake("dorfteich-altendorf", "pond", "Dorfteich Altendorf", [[1990, 1738], [2015, 1733], [2022, 1754], [2000, 1763], [1986, 1752]]);
  lake("fischteich-1", "pond", "Großer Fischteich", [[2560, 330], [2620, 322], [2632, 360], [2580, 372], [2552, 356]]);
  lake("fischteich-2", "pond", "Kleiner Fischteich", [[2645, 300], [2690, 296], [2700, 325], [2660, 334]]);
  return water;
}
