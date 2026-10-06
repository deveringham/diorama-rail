// Roads: the B172 along the left bank, Elbe bridges, roads up to the plateaus, village streets.
import type { V2, WP } from "./lib";
import { r1, wpJson } from "./lib";
import type { World } from "./world";
import { pointAt, sOf, trackZ } from "./world";

export type Road = Record<string, unknown> & { id: string };
type P = V2 | WP;
const pts = (list: P[]) => list.map((p) => (Array.isArray(p) ? (p.map(r1) as V2) : wpJson({ ...p, at: p.at.map(r1) as V2 })));

export function road(id: string, points: P[], opts: Record<string, unknown> = {}): Road {
  return { id, ...opts, points: pts(points) };
}

/** s along a built road nearest a point. */
export function roadS(w: World, id: string, p: V2): number {
  const r = w.roads.roads.get(id);
  if (!r) throw new Error(`no road '${id}'`);
  let best = 0, bd = Infinity;
  for (let s = 0; s <= r.path.length; s += 0.5) {
    const [x, y] = pointAt(r.path, s);
    const d = Math.hypot(x - p[0], y - p[1]);
    if (d < bd) { bd = d; best = s; }
  }
  return r1(best);
}

const z = (at: V2, zz: number): WP => ({ at, z: zz });
const c = (at: V2, radius: number): WP => ({ at, radius });

/** Main roads that need no junction positions. */
export function mainRoads(): Road[] {
  const out: Road[] = [];
  const country = { speed: 16, minRadius: 25 };
  // --- B172 along the left bank: Pirna, under the fast tracks, through Königstein, round the bend, to Bad Schandau.
  out.push(road("b172-west", [[0, 908], [300, 905], [520, 912]], { ...country, name: "Pirnaer Landstraße", sidewalks: "both" }));
  out.push(road("b172-pirna", [[650, 935], [800, 945], [925, 935], [960, 905]], { from: { road: "b172-west", at: "end" }, name: "Breite Straße", sidewalks: "both", parking: "both", minRadius: 20 }));
  out.push(road("b172-gottleuba", [c([990, 884], 25), z([1016, 882], 4.4), z([1028, 882], 4.0), z([1040, 885], 4.4), c([1060, 902], 25), [1077, 935], z([1092, 962], 1.0), z([1101, 975], 0.8), z([1110, 988], 1.0), c([1134, 1018], 25), [1160, 1048]], { from: { road: "b172-pirna", at: "end" }, ...country, name: "Königsteiner Straße" }));
  out.push(road("b172-koenigstein", [[1260, 1092], [1350, 1118], c([1420, 1100], 25), c([1455, 1030], 30), [1468, 960]], { from: { road: "b172-gottleuba", at: "end" }, name: "Pirnaer Straße", sidewalks: "both", minRadius: 20 }));
  out.push(road("b172-bend", [c([1474, 900], 30), z([1476, 856], 1.0), z([1478, 842], 0.8), z([1481, 828], 1.0), c([1490, 790], 40), c([1560, 690], 60), c([1700, 630], 80), c([1870, 610], 80), c([2020, 660], 80), c([2150, 800], 80), c([2270, 940], 80), [2330, 1005]],
    { from: { road: "b172-koenigstein", at: "end" }, ...country, name: "Schandauer Straße", sidewalks: "right" }));
  out.push(road("b172-hub", [c([2370, 1045], 25), [2500, 1072], [2650, 1082]], { from: { road: "b172-bend", at: "end" }, name: "Bahnhofstraße", sidewalks: "both", parking: "right", minRadius: 20 }));
  out.push(road("s168", [z([2702, 1085], 7.0), [2760, 1088], [2900, 1095], [3000, 1100]], { from: { road: "b172-hub", at: "end" }, ...country, name: "Krippener Straße", sidewalks: "right" }));
  // --- The north bank: Pirna-Copitz to Rathen's car park; Bad Schandau's Elbkai to Schmilka and the border.
  out.push(road("s165", [[0, 1252], [250, 1242], [520, 1256], [700, 1262], [870, 1262], [925, 1266]], { ...country, name: "Pillnitzer Straße", sidewalks: "both" }));
  out.push(road("elbkai", [[1900, 1240], c([2100, 1236], 60), [2240, 1264], [2400, 1281], [2600, 1291], [2800, 1301], z([2958, 1306], 4), [3000, 1308]], { ...country, name: "Elbkai", sidewalks: "both" }));
  // --- Up the Lachsbach to Sebnitz, up the Kirnitzsch to Hinterhermsdorf.

  // --- Across the northern plateau: Lohmen – Waltersdorf – Hohnstein – Ehrenberg – Altendorf.
  out.push(road("lohmen-dorf", [[560, 1600], z([610, 1603], 45.6), z([640, 1604], 46.2), z([670, 1608], 46.7), z([682, 1609.6], 46.9), z([694, 1611.2], 47.1), z([706, 1612.8], 47.1), z([718, 1614.4], 46.9), z([730, 1616], 46.7), z([760, 1619], 46.3), [780, 1622]], { name: "Lohmen Dorfstraße", sidewalks: "both", parking: "left", minRadius: 20 }));
  out.push(road("hohnsteiner-strasse", [[880, 1700], [1050, 1790], [1150, 1820], [1250, 1860], [1330, 1890]], { from: { road: "lohmen-dorf", at: "end" }, ...country, name: "Hohnsteiner Straße" }));
  out.push(road("hohnstein-markt", [[1400, 1905], [1500, 1910], [1560, 1900]], { from: { road: "hohnsteiner-strasse", at: "end" }, name: "Hohnstein Markt", sidewalks: "both", parking: "right", minRadius: 15 }));
  out.push(road("ehrenberger-strasse", [[1650, 1870], [1760, 1830], [1850, 1800]], { from: { road: "hohnstein-markt", at: "end" }, ...country, name: "Ehrenberger Straße", sidewalks: "both" }));
  out.push(road("altendorf-dorf", [[1950, 1790], [2020, 1765], [2070, 1800], [2120, 1795]], { from: { road: "ehrenberger-strasse", at: "end" }, name: "Altendorf Dorfstraße", sidewalks: "both", parking: "left", minRadius: 15 }));
  // --- The southern plateau: Struppen – Pfaffenstein; Cunnersdorf – Gohrisch – Papstdorf – Reinhardtsdorf.
  out.push(road("struppen-dorf", [[560, 565], [680, 560], [800, 548]], { name: "Struppen Dorfstraße", sidewalks: "both", parking: "right", minRadius: 15 }));
  return out;
}

/** Roads that join the main roads part-way along: needs the main roads built. */
export function joiningRoads(w: World): Road[] {
  const out: Road[] = [];
  const at = (id: string, p: V2) => ({ road: id, at: roadS(w, id, p) });
  const country = { speed: 16, minRadius: 25 };
  // Elbe bridges, each passing under the corridor first.
  out.push(road("elbbruecke-pirna", [[862, 975], z([863, 998], 0.8), z([864, 1012], 0.6), z([864, 1043], 0.8), z([866, 1074], 0.6), z([866, 1090], 0.8), [868, 1140], [870, 1200]], { from: at("b172-pirna", [860, 944]), to: at("s165", [871, 1262]), name: "Elbbrücke Pirna", sidewalks: "both", minRadius: 30, maxGrade: 0.11 }));
  out.push(road("elbbruecke-schandau", [[2138, 835], c([2160, 885], 30), z([2200, 935], 16.5), z([2204, 955], 16.6), z([2207, 975], 16.7), z([2210, 995], 16.8), z([2213, 1015], 16.8), z([2216, 1035], 16.7), z([2219, 1060], 16.5), [2222, 1120], [2226, 1200]], { from: at("b172-bend", [2138, 788]), to: at("elbkai", [2228, 1262]), name: "Elbbrücke Bad Schandau", sidewalks: "both", minRadius: 30 }));
  out.push(road("bielatal", [c([1205, 1000], 30), c([1180, 880], 40), c([1158, 760], 40), c([1138, 620], 40), c([1125, 470], 40), z([1116, 384], 19.0), c([1110, 330], 40), [1095, 200], [1078, 0]],
    { from: at("b172-koenigstein", [1192, 1064]), ...country, name: "Bielatalstraße", sidewalks: "both" }));
  out.push(road("sebnitzer-strasse", [[2285, 1320], [2272, 1450], [2238, 1600], [2205, 1750], [2180, 1900], [2152, 2050], [2135, 2200]], { from: at("elbkai", [2285, 1275]), ...country, name: "Sebnitzer Straße", minRadius: 30, sidewalks: "both" }));
  out.push(road("kirnitzschtalstrasse", [[2655, 1335], [2722, 1430], [2782, 1530], [2850, 1640], [2918, 1750], c([2950, 1870], 40), [3000, 1895]], { from: at("elbkai", [2640, 1294]), ...country, speed: 13, name: "Kirnitzschtalstraße", minRadius: 30, sidewalks: "both" }));
  return out;
}

/** Hairpin climbs, plateau links, dock roads and the north exits: needs the main and joining roads built. */
export function climbingRoads(w: World): Road[] {
  const out: Road[] = [];
  /** A road waypoint level with the track it crosses there (a level crossing). */
  const onTrack = (track: string, p: V2): WP => ({ at: p, z: r1(trackZ(w, track, sOf(w, track, p)) + 0.2) });
  const at = (id: string, p: V2) => ({ road: id, at: roadS(w, id, p) });
  const country = { speed: 13, minRadius: 12, maxGrade: 0.09 };
  const steige = { speed: 9, minRadius: 9, maxGrade: 0.1 };
  // Copitz up through the vineyards to Lohmen.
  out.push(road("lohmener-steige", [[630, 1300], c([560, 1335], 10), c([650, 1360], 10), c([585, 1392], 10), c([660, 1420], 10), onTrack("ring", [634, 1481]), [600, 1540]],
    { from: at("s165", [640, 1260]), to: at("lohmen-dorf", [575, 1600]), ...steige, name: "Lohmener Steige" }));
  // Pirna up to Struppen.
  out.push(road("struppener-strasse", [[700, 880], c([630, 835], 10), c([745, 800], 10), c([640, 765], 10), c([740, 725], 10), c([660, 680], 10), [690, 620]],
    { from: at("b172-pirna", [700, 938]), to: at("struppen-dorf", [690, 560]), ...steige, name: "Struppener Straße", sidewalks: "both" }));
  // Struppen across the Gottleuba valley to the Bielatal.
  out.push(road("pfaffensteinweg", [[870, 538], z([925, 529], 31), z([960, 521], 30.5), z([995, 512], 31), [1050, 495], [1090, 465]], { from: at("struppen-dorf", [800, 548]), to: at("bielatal", [1124, 432]), ...country, name: "Pfaffensteinweg", sidewalks: "both" }));
  // The sawmill's yard road on to Gohrisch, Papstdorf and Reinhardtsdorf, and down to Krippen.
  out.push(road("saegewerkstrasse", [[1180, 305], [1300, 302], [1420, 292], c([1560, 295], 40), c([1700, 300], 40), [1820, 330]],
    { from: at("bielatal", [1108, 300]), ...country, name: "Sägewerkstraße", sidewalks: "right" }));
  out.push(road("gohrisch-dorf", [[1900, 360], [1945, 420], [1958, 478]], { from: { road: "saegewerkstrasse", at: "end" }, name: "Gohrisch Dorfstraße", sidewalks: "both", minRadius: 15 }));
  out.push(road("papstdorfer-strasse", [onTrack("industrial", [1963, 528]), c([1985, 585], 30), [2100, 605], [2200, 602], [2320, 600]], { from: { road: "gohrisch-dorf", at: "end" }, ...country, name: "Papstdorfer Straße", sidewalks: "both" }));
  out.push(road("reinhardtsdorf-dorf", [[2450, 600], [2560, 625], [2660, 640]], { from: { road: "papstdorfer-strasse", at: "end" }, name: "Reinhardtsdorf Dorfstraße", sidewalks: "both", parking: "left", minRadius: 15 }));
  out.push(road("krippener-steige", [[2740, 700], c([2800, 790], 30), c([2740, 860], 10), c([2830, 900], 10), c([2760, 950], 10), c([2840, 990], 10), [2850, 1040]],
    { from: { road: "reinhardtsdorf-dorf", at: "end" }, to: at("s168", [2855, 1093]), ...steige, name: "Krippener Steige", sidewalks: "both" }));
  // Bad Schandau: up the slope to Ostrau; down from Altendorf into the Lachsbach; the Bastei road; the goods yard road.
  out.push(road("ostrauer-steige", [[2415, 1310], c([2540, 1335], 10), c([2410, 1372], 10), c([2540, 1408], 10), c([2425, 1440], 10), [2500, 1470]],
    { from: at("elbkai", [2400, 1283]), ...steige, name: "Ostrauer Steige", sidewalks: "both" }));
  out.push(road("ostrau-dorf", [[2560, 1478], [2660, 1465]], { from: { road: "ostrauer-steige", at: "end" }, name: "Ostrau Dorfstraße", sidewalks: "both", minRadius: 15 }));
  out.push(road("ostrau-west", [[2420, 1480], [2350, 1482]], { from: { road: "ostrauer-steige", at: "end" }, name: "Am Bahnhof Ostrau", sidewalks: "both", minRadius: 15 }));
  out.push(road("altendorfer-steige", [[2095, 1760], c([2160, 1735], 9), c([2090, 1700], 9), c([2160, 1670], 9), c([2095, 1640], 9), [2150, 1610]],
    { from: { road: "altendorf-dorf", at: "end" }, to: at("sebnitzer-strasse", [2240, 1588]), ...steige, name: "Altendorfer Steige" }));
  out.push(road("bastei-strasse", [[930, 1680], [960, 1580], [955, 1510]], { from: at("hohnsteiner-strasse", [920, 1715]), ...country, name: "Basteistraße", sidewalks: "both" }));
  out.push(road("gueterbahnhofstrasse", [[60, 948], [330, 952]], { from: at("b172-west", [40, 907]), ...country, name: "Güterbahnhofstraße", sidewalks: "both" }));
  // North: from the plateau villages off the board.
  out.push(road("lohmen-nord", [[590, 1720], [575, 1900], [560, 2200]], { from: at("lohmen-dorf", [600, 1602]), ...country, name: "Stolpener Straße", sidewalks: "both" }));
  out.push(road("hohnstein-nord", [[1622, 1900], onTrack("ring", [1615, 1925]), [1605, 2050], [1570, 2200]], { from: at("ehrenberger-strasse", [1625, 1878]), ...country, name: "Sebnitzer Weg" }));
  out.push(road("mittelndorfer-strasse", [z([2100, 1828], 44.8), z([2125, 1843], 45.1), z([2150, 1856], 45.4), z([2175, 1869], 45.7), z([2200, 1882], 46), z([2225, 1894], 46.3), [2255, 1905], [2450, 1885], c([2540, 1935], 60), [2575, 2050], [2590, 2200]], { from: at("altendorf-dorf", [2082, 1798]), ...country, name: "Mittelndorfer Straße", sidewalks: "both" }));
  return out;
}

/** Roads joining the climbing roads part-way along. */
export function lateRoads(w: World): Road[] {
  const out: Road[] = [];
  const at = (id: string, p: V2) => ({ road: id, at: roadS(w, id, p) });
  const country = { speed: 13, minRadius: 12, maxGrade: 0.09 };
  // Up the Gottleuba valley past the colliery's loading bunker.
  out.push(road("gottleubatal", [[1063, 840], c([1048, 760], 30), c([1036, 650], 30), [1030, 560]],
    { from: at("b172-gottleuba", [1068, 912]), to: at("pfaffensteinweg", [1040, 498]), ...country, name: "Gottleubatalstraße", sidewalks: "both" }));
  return out;
}

/** Town streets off the main roads: Pirna's station road and market, Bad Schandau's market. */
export function townRoads(w: World): Road[] {
  const out: Road[] = [];
  const at = (id: string, p: V2) => ({ road: id, at: roadS(w, id, p) });
  const street = { sidewalks: "both", minRadius: 10, speed: 9 };
  out.push(road("pirna-bahnhofstrasse", [[640, 960], [641, 985]], { from: at("b172-pirna", [640, 932]), ...street, parking: "right", name: "Bahnhofstraße" }));
  out.push(road("pirna-markt", [[782, 900], c([788, 880], 10), c([890, 876], 10), [902, 900]], { from: at("b172-pirna", [780, 939]), to: at("b172-pirna", [904, 936]), ...street, parking: "left", name: "Am Markt" }));
  out.push(road("bs-markt", [[2347, 1310], c([2350, 1342], 10)], { from: at("elbkai", [2345, 1278]), to: at("sebnitzer-strasse", [2282, 1345]), ...street, parking: "left", name: "Marktplatz" }));
  return out;
}
