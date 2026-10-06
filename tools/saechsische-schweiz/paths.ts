// Footpaths: the Malerweg round the board (gravel trails joined up by village sidewalks),
// the Rathen footbridge, paths up the summits, to the stations and the campsites.
import type { V2, WP } from "./lib";
import { r1, wpJson } from "./lib";
import type { World } from "./world";
import { pointAt } from "./world";

export type PathSpec = Record<string, unknown> & { id: string };
type P = V2 | WP;
const pts = (list: P[]) => list.map((p) => (Array.isArray(p) ? (p.map(r1) as V2) : wpJson({ ...p, at: p.at.map(r1) as V2 })));
const z = (at: V2, zz: number): WP => ({ at, z: zz });

/** s along a road or a path nearest a point. */
function sOn(w: World, id: string, p: V2): number {
  const line = w.roads.roads.get(id) ?? w.walks.paths.get(id);
  if (!line) throw new Error(`no road or path '${id}'`);
  let best = 0, bd = Infinity;
  for (let s = 0; s <= line.path.length; s += 0.5) {
    const [x, y] = pointAt(line.path, s);
    const d = Math.hypot(x - p[0], y - p[1]);
    if (d < bd) { bd = d; best = s; }
  }
  return r1(best);
}

const TRAIL = { width: 1.8, surface: "gravel", maxGrade: 0.3, minRadius: 3 };
const LANE = { width: 3, surface: "paved", maxGrade: 0.14, minRadius: 4 };

/** The trails, in two rounds: the second joins paths of the first. */
export function trails(w: World): PathSpec[] {
  const road = (id: string, p: V2) => ({ road: id, at: sOn(w, id, p) });
  const out: PathSpec[] = [];
  const path = (id: string, points: P[], opts: Record<string, unknown>) => out.push({ id, ...TRAIL, ...opts, points: pts(points) });
  const mw = (name: string) => ({ name: `Malerweg (${name})` });

  // 1: Pirna-Copitz up the Liebethaler Grund to Lohmen station.
  path("malerweg-1", [[742, 1300], [735, 1360], [726, 1420], [722, 1480], [722, 1540], [735, 1580], [765, 1605], [768, 1640], [748, 1680], [735, 1700]],
    { from: road("s165", [745, 1262]), to: { station: "lohmen-a" }, ...mw("Liebethaler Grund") });
  // 3: the Bastei, down the Schwedenlöcher into the Amselgrund, up it to Hohnstein.
  path("malerweg-3", [[975, 1525], [1000, 1490], [1018, 1455], [1033, 1420], [1042, 1395], [1052, 1430], [1075, 1470], z([1086, 1528], 15.2), [1102, 1590], [1120, 1650],
    [1140, 1720], [1160, 1790], [1178, 1840], [1205, 1872], [1260, 1885], [1300, 1888]],
    { from: { road: "bastei-strasse", at: "end" }, to: { road: "hohnstein-markt", at: "start" }, ...mw("Schwedenlöcher und Amselgrund") });
  // 4: Hohnstein, under the railway, down into the Polenztal and up to Altendorf.
  path("malerweg-4", [[1738, 1868], z([1737, 1897], 39.2), [1740, 1930], [1745, 1990], [1770, 2060], [1805, 2095], [1880, 2075], [1950, 2050], [2010, 2025],
    [2070, 1998], [2100, 1975], [2088, 1925], [2082, 1865]],
    { from: road("ehrenberger-strasse", [1735, 1840]), to: road("altendorf-dorf", [2100, 1797]), ...mw("Polenztal") });
  // 5: Mittelndorf across the plateau and down to the Lichtenhainer Wasserfall.
  path("malerweg-5", [[2480, 1870], [2560, 1850], [2650, 1828], [2740, 1792], [2790, 1772], [2815, 1760], [2830, 1752]],
    { from: road("mittelndorfer-strasse", [2470, 1888]), to: { station: "tram-wasserfall" }, ...mw("Kirnitzschtal") });
  // 7: Reinhardtsdorf over the Papststein to Gohrisch.
  path("malerweg-7", [[2275, 560], [2272, 500], [2205, 415], [2150, 362], [2120, 345], [2085, 352], [2052, 362], [1990, 395], [1972, 412]],
    { from: road("papstdorfer-strasse", [2275, 602]), to: road("gohrisch-dorf", [1952, 432]), ...mw("Papststein") });
  // 8: Gohrisch to Königstein.
  path("malerweg-8", [[1860, 395], [1820, 440], [1760, 500], [1680, 560], [1615, 625]],
    { from: road("gohrisch-dorf", [1885, 352]), to: road("b172-bend", [1595, 668]), ...mw("Gohrisch – Königstein") });

  // Spurs up the summits and to the castle.
  path("pfaffenstein-weg", [[520, 562], [450, 558], [395, 522], [470, 488], [512, 466], [535, 462]], { from: { road: "struppen-dorf", at: "start" }, name: "Pfaffensteinpfad" });
  path("winterberg-weg", [[2600, 2040], [2660, 2040], [2712, 2030]], { from: road("mittelndorfer-strasse", [2582, 2040]), name: "Winterbergweg" });
  path("burgweg", [[1545, 1890], [1528, 1878], [1512, 1866]], { from: road("hohnstein-markt", [1545, 1902]), name: "Burgweg" });
  // Station paths: Lohmen village to its station; the tram stop across the Kirnitzsch at the Kurpark.
  path("lohmen-bahnhofsweg", [[620, 1787], [660, 1788], z([690, 1788], 43.9), z([716, 1787], 43.9), [738, 1772], [745, 1735]],
    { from: road("lohmen-nord", [588, 1787]), to: { station: "lohmen-a" }, ...LANE, name: "Bahnhofsweg Lohmen" });
  path("kurpark-steg", [z([2680, 1398], 8.8), z([2665, 1397], 8.8)], { from: road("kirnitzschtalstrasse", [2696, 1396]), to: { station: "tram-kurpark-b" }, ...LANE, name: "Kurparksteg" });
  // The Waldbad Gohrisch and its campsite.
  path("waldbad-weg", [[1845, 300], [1855, 250], [1830, 190], [1790, 165], [1730, 160]], { from: road("saegewerkstrasse", [1805, 326]), ...LANE, surface: "gravel", name: "Am Waldbad" });
  return out;
}

/** Paths joining the trails. */
export function trailBranches(w: World): PathSpec[] {
  const at = (id: string, p: V2) => ({ path: id, at: sOn(w, id, p) });
  const road = (id: string, p: V2) => ({ road: id, at: sOn(w, id, p) });
  const out: PathSpec[] = [];
  const path = (id: string, points: P[], opts: Record<string, unknown>) => out.push({ id, ...TRAIL, ...opts, points: pts(points) });
  // 2: Lohmen through the Uttewalder Grund to the Bastei.
  path("malerweg-2", [[760, 1700], [795, 1688], [830, 1650], [868, 1595], [905, 1548]],
    { from: at("malerweg-1", [748, 1680]), to: { road: "bastei-strasse", at: "end" }, name: "Malerweg (Uttewalder Grund)" });
  // 6: from the Wasserfall down the valley past the tram stops, over the Kirnitzsch to the road at the Ostrauer Mühle.
  path("malerweg-6", [[2800, 1730], [2788, 1700], [2775, 1660], [2760, 1620], [2748, 1590], [2736, 1570], [2752, 1566], z([2781, 1565], 12.4)],
    { from: at("malerweg-5", [2815, 1760]), to: road("kirnitzschtalstrasse", [2805, 1565]), name: "Malerweg (Ostrauer Mühle)" });
  // Rathen: down the Amselgrund into the village, and the footbridge over the Elbe to the station.
  path("rathen-dorfweg", [[1036, 1360], [1022, 1320], [1005, 1292], [975, 1282], [950, 1272]],
    { from: at("malerweg-3", [1042, 1395]), to: { road: "s165", at: "end" }, ...LANE, name: "Rathen Dorfweg" });
  return out;
}

/** Paths joining the branches. */
export function trailBranches2(w: World): PathSpec[] {
  const at = (id: string, p: V2) => ({ path: id, at: sOn(w, id, p) });
  const out: PathSpec[] = [];
  const path = (id: string, points: P[], opts: Record<string, unknown>) => out.push({ id, ...TRAIL, ...opts, points: pts(points) });
  path("rathener-steg", [z([963, 1262], 8), z([962, 1240], 8.6), z([961, 1210], 9), z([960, 1180], 8.8), z([959, 1160], 8.4), [958, 1145]],
    { from: at("rathen-dorfweg", [968, 1279]), to: { station: "rathen-sw" }, ...LANE, name: "Rathener Steg" });
  return out;
}
