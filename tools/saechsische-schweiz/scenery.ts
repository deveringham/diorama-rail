// Towns, villages, landmarks and industry of the Sächsische Schweiz layout.
import type { V2 } from "./lib";
import { Space, type Entry } from "./place";

type Mix = Array<[string, number]>;
const VILLAGE: Mix = [["umgebindehaus", 3], ["fachwerkhaus", 3], ["dorfhaus", 4], ["house", 1.5]];
const TOWN: Mix = [["stadthaus", 6], ["stadthaus-laden", 2.5], ["terrace", 1]];
const SMALLTOWN: Mix = [["stadthaus", 3], ["fachwerkhaus", 2], ["dorfhaus", 2], ["stadthaus-laden", 1]];
const RESORT: Mix = [["villa", 5], ["dorfhaus", 1], ["fachwerkhaus", 1]];
const BARNS: Mix = [["scheune", 3], ["barn", 1]];
const deg = (d: number) => (d * Math.PI) / 180;

export const sceneryLog: string[] = [];

/** Landmarks first (each searched for a free spot near where it belongs), then the streets fill in. */
export function settlements(sp: Space): void {
  const land = (id: string, at: V2, rotDeg: number, extra: Entry = {}, reach = 40) => {
    const e = sp.putNear(id, at[0], at[1], deg(rotDeg), extra, reach);
    if (!e) sceneryLog.push(`no room for ${id} near (${at}): ${sp.why(id, at[0], at[1], deg(rotDeg))}`);
    return e;
  };
  /** A landmark facing the nearest point of a road. */
  const facing = (id: string, road: string, s: number, side: 1 | -1, setback: number, extra: Entry = {}, maxDrop?: number) => {
    const r = sp.w.roads.roads.get(road) ?? sp.w.walks.paths.get(road)!;
    const path = r.path;
    const [px, py] = pointOn(path, s);
    const h = headingOn(path, s);
    const nx = -Math.sin(h) * side, ny = Math.cos(h) * side;
    const lateral = sp.roadSide(road) + setback + sp.dims(id).front;
    const rot = Math.atan2(-ny, -nx);
    for (const ds of [0, 6, -6, 12, -12, 18, -18, 26, -26]) {
      const [qx, qy] = pointOn(path, Math.max(0, Math.min(path.length, s + ds)));
      const e = sp.tryPut(id, qx + nx * lateral, qy + ny * lateral, rot, extra, { maxDrop });
      if (e) return e;
    }
    sceneryLog.push(`no room for ${id} on ${road} at s${s.toFixed(0)}: ${sp.why(id, px + nx * lateral, py + ny * lateral, rot)}`);
    return null;
  };
  const S = (road: string, p: V2) => sp.roadS(road, p);

  // --- Pirna: the market with the town hall, St. Marien behind it, the Breite Straße. ---------
  facing("rathaus", "pirna-markt", S("pirna-markt", [835, 878]), 1, 1, { name: "Rathaus Pirna" });
  land("stadtkirche", [800, 975], 0, { name: "St. Marien" });
  facing("post-office", "b172-pirna", S("b172-pirna", [600, 925]), -1, 1, { name: "Postamt Pirna" });
  facing("pub", "pirna-markt", S("pirna-markt", [890, 905]), 1, 0.5, { name: "Ratskeller" });
  facing("hotel", "b172-pirna", S("b172-pirna", [700, 940]), 1, 1, { name: "Hotel Deutsches Haus" });
  sp.street("pirna-markt", 0, 400, { pick: TOWN, gap: [0.2, 0.8], setback: [0, 0.4] });
  sp.street("b172-pirna", 10, 453, { pick: TOWN, gap: [0.2, 1.5], setback: [0, 0.6] });
  sp.street("pirna-bahnhofstrasse", 0, 60, { pick: TOWN, gap: [0.5, 2], setback: [0, 1] });
  sp.street("b172-west", 260, 520, { sides: [-1], pick: SMALLTOWN, gap: [1, 4], setback: [1, 3] });
  sp.street("struppener-strasse", 0, 70, { pick: SMALLTOWN, gap: [1, 3], setback: [0.5, 2] });
  // --- Copitz along the north bank, under the vineyards. -------------------------------------
  facing("weingut", "s165", S("s165", [430, 1250]), 1, 1, { name: "Weingut Pirna-Copitz" }, 5);
  facing("dorfkirche", "s165", S("s165", [700, 1262]), -1, 4, { name: "Kirche Copitz" });
  sp.street("s165", 150, 900, { sides: [-1], pick: [...VILLAGE, ["stadthaus", 2]], gap: [2, 7], setback: [1, 5] });
  // --- Königstein below its fortress. -------------------------------------------------------
  facing("dorfkirche", "b172-koenigstein", S("b172-koenigstein", [1300, 1105]), -1, 3, { name: "Stadtkirche Königstein", scale: 1.1 });
  facing("hotel", "b172-koenigstein", S("b172-koenigstein", [1405, 1110]), 1, 1, { name: "Hotel Lilienstein" });
  facing("gasthof", "b172-koenigstein", S("b172-koenigstein", [1230, 1080]), 1, 1, { name: "Gasthof Zum Bergmann" });
  sp.street("b172-koenigstein", 0, 423, { pick: SMALLTOWN, gap: [0.5, 3], setback: [0.3, 2] });
  sp.street("bielatal", 0, 150, { pick: VILLAGE, gap: [3, 8], setback: [2, 5] });
  // --- Bad Schandau: the Elbkai, the market, villas toward Postelwitz and Schmilka. ------------
  facing("dorfkirche", "bs-markt", S("bs-markt", [2330, 1343]), 1, 2, { name: "St. Johannis", scale: 1.15 });
  facing("kurhaus", "elbkai", S("elbkai", [2590, 1290]), 1, 6, { name: "Kurhaus Bad Schandau" });
  facing("hotel", "elbkai", S("elbkai", [2200, 1250]), 1, 1, { name: "Hotel Elbresidenz" });
  facing("post-office", "elbkai", S("elbkai", [2370, 1282]), 1, 1, { name: "Postamt Bad Schandau" });
  sp.street("bs-markt", 0, 200, { pick: TOWN, gap: [0.2, 1], setback: [0, 0.5] });
  sp.street("elbkai", 250, 760, { sides: [1], pick: [...TOWN, ["villa", 3]], gap: [0.5, 3], setback: [0.5, 3] });
  sp.street("elbkai", 760, 1104, { sides: [1], pick: [...RESORT, ["umgebindehaus", 2]], gap: [4, 12], setback: [1, 4] });
  sp.street("sebnitzer-strasse", 0, 260, { pick: SMALLTOWN, gap: [1, 4], setback: [0.5, 3] });
  sp.street("b172-hub", 0, 339, { sides: [-1], pick: SMALLTOWN, gap: [0.5, 3], setback: [0.5, 2] });
  sp.street("ostrau-dorf", 0, 161, { pick: RESORT, gap: [4, 9], setback: [2, 5] });
  sp.street("ostrau-west", 0, 151, { pick: RESORT, gap: [4, 9], setback: [2, 5] });
  // --- Kurort Rathen, car-free along its lane from the Amselgrund to the Elbe.
  for (const [id, at, rot, name] of [["gasthof", [1048, 1292], -100, "Gasthof Amselgrund"]] as Array<[string, V2, number, string]>) {
    // Rathen is car-free: its inns are supplied by the ferry, not by lorries.
    if (!sp.putNear(id, at[0], at[1], deg(rot), { name, building: { demands: {} } }, 25, { maxDrop: 5 })) sceneryLog.push(`no room for ${id} near (${at}): ${sp.why(id, at[0], at[1], deg(rot))}`);
  }
  sp.street("rathen-dorfweg", 95, 200, { pick: [...RESORT, ["umgebindehaus", 2], ["fachwerkhaus", 2]], gap: [2, 6], setback: [1, 3], maxDrop: 4 });
  // --- Krippen under the Krippengrund. --------------------------------------------------------
  facing("gasthof", "s168", S("s168", [2790, 1092]), -1, 2, { name: "Gasthof Krippen" });
  sp.street("s168", 40, 350, { sides: [-1], pick: VILLAGE, gap: [4, 10], setback: [2, 5] });

  // --- Villages on the plateaus. -----------------------------------------------------------
  const village = (road: string, s0: number, s1: number, church?: [V2, string], inn?: [V2, string], sides?: Array<1 | -1>) => {
    if (church) land("dorfkirche", church[0], 0, { name: church[1] }, 40);
    if (inn) facing("gasthof", road, S(road, inn[0]), sides?.[0] ?? 1, 2, { name: inn[1] });
    sp.street(road, s0, s1, { sides, pick: VILLAGE, gap: [6, 16], setback: [3, 8], behind: { chance: 0.45, pick: BARNS, distance: 3 } });
  };
  village("lohmen-nord", 20, 330, [[548, 1700], "Kirche Lohmen"], [[600, 1680], "Gasthof Lohmen"]);
  facing("dorfkirche", "hohnstein-markt", S("hohnstein-markt", [1450, 1906]), -1, 3, { name: "Stadtkirche Hohnstein" });
  facing("gasthof", "hohnstein-markt", S("hohnstein-markt", [1380, 1900]), 1, 1, { name: "Gasthof Zur Aussicht" });
  sp.street("hohnstein-markt", 0, 233, { pick: SMALLTOWN, gap: [1, 4], setback: [0.5, 2] });
  village("ehrenberger-strasse", 20, 290, undefined, [[1760, 1832], "Gasthof Ehrenberg"]);
  village("altendorf-dorf", 0, 284, [[2010, 1740], "Kirche Altendorf"], [[1990, 1785], "Gasthof Altendorf"]);
  village("mittelndorfer-strasse", 380, 720, undefined, [[2560, 1960], "Gasthof Mittelndorf"]);
  village("struppen-dorf", 0, 241, [[740, 590], "Kirche Struppen"], [[640, 562], "Gasthof Struppen"]);
  village("saegewerkstrasse", 420, 718, undefined, [[1700, 300], "Gasthof Cunnersdorf"], [-1]);
  facing("hotel", "gohrisch-dorf", S("gohrisch-dorf", [1930, 420]), 1, 2, { name: "Kurhotel Gohrisch" });
  sp.street("gohrisch-dorf", 0, 220, { pick: [...VILLAGE, ["villa", 4]], gap: [5, 12], setback: [2, 6] });
  village("papstdorfer-strasse", 80, 445, [[2230, 640], "Kirche Papstdorf"], [[2150, 605], "Gasthof Papstdorf"]);
  village("reinhardtsdorf-dorf", 0, 344, [[2560, 660], "Kirche Reinhardtsdorf"], [[2480, 605], "Gasthof Reinhardtsdorf"]);
}

import { pointAt as pointOn, headingAt as headingOn } from "./world";

import { groundZ } from "./world";
import { r1 } from "./lib";
import { fortressWalls, fortressBuildings } from "./fortress";
import { DAM, BASTEI_BRIDGE, BASTEI_DECK_TOP } from "./sites";

/** Industry, landmarks on the rocks, the farm, the depot, boats on the river. */
export function landmarks(sp: Space): void {
  const w = sp.w;
  const gz = (x: number, y: number) => groundZ(w.terrain, x, y);
  const log = (id: string, at: V2, e: Entry | null) => { if (!e) sceneryLog.push(`no room for ${id} near (${at}): ${sp.why(id, at[0], at[1], 0)}`); return e; };
  const near = (id: string, at: V2, rotDeg: number, extra: Entry = {}, reach = 25, maxDrop?: number) =>
    log(id, at, sp.putNear(id, at[0], at[1], deg(rotDeg), extra, reach, { maxDrop }));
  /** Exactly here, at a given height (rocks, the river), without checks. */
  const fixed = (id: string, at: V2, rotDeg: number, z: number, extra: Entry = {}) => sp.put(id, at[0], at[1], deg(rotDeg), { z: r1(z), ...extra });

  // --- The colliery in the Gottleuba valley: headframe, engine house, chimney, offices, spoil tip.
  near("foerdergeruest", [1080, 790], 180, { name: "Schacht Gottleuba" });
  near("maschinenhaus", [1085, 745], 180, { name: "Fördermaschinenhaus" }, 25);
  near("schornstein", [1100, 815], 0, {}, 20);
  near("kaue", [1072, 700], 180, { name: "Steinkohlenwerk Gottleuba" }, 25);
  near("halde", [1082, 610], 0, {}, 25, 12);
  near("kohlehaufen", [1060, 660], 0, {}, 25);

  // --- The sawmill: the saw hall by the road, log piles between the tracks and the forest.
  near("saegehalle", [1300, 262], 90, { name: "Sägewerk Cunnersdorf" }, 20);
  near("forsthaus", [1420, 262], 90, { name: "Revierförsterei" }, 25);
  for (const [x, y] of [[1260, 360], [1290, 362], [1320, 364], [1350, 364], [1380, 362], [1410, 360], [1440, 358]] as V2[]) near("stammholz", [x, y], 90, {}, 8);
  for (const [x, y] of [[1370, 262], [1250, 262]] as V2[]) near("bretterstapel", [x, y], 90, {}, 12);

  // --- Woodcutting in the Biela forest: a clearing with log piles, stumps and the harvester.
  for (const [x, y, r] of [[1150, 160, 15], [1175, 140, 10], [1135, 128, 20], [1200, 175, 0]] as Array<[number, number, number]>) near("stammholz", [x, y], r, {}, 15, 4);
  near("harvester", [1185, 115], 35, {}, 15, 4);

  // --- The sandstone quarry by the Steinbruchsee.
  near("steinbruch-kran", [1392, 568], 200, {}, 15, 3);
  near("steinbruch-kran", [1372, 598], -30, {}, 15, 3);
  // --- The Gottleuba reservoir's dam.
  fixed("staumauer", DAM.at, DAM.rotation, DAM.z, { name: "Talsperre Gottleuba" });

  // --- Königstein fortress: ramparts along the rim of the rock, barracks and bastions on the flat top.
  for (const p of [...fortressWalls().placed, ...fortressBuildings()]) {
    fixed(p.object, p.at, p.rotation, p.z, { ...(p.name ? { name: p.name } : {}), ...(p.scale ? { scale: p.scale } : {}) });
  }

  // --- The Bastei: the bridge between the rocks, the Berghotel at the end of the road.
  fixed("basteibruecke", BASTEI_BRIDGE.at, BASTEI_BRIDGE.rotation, BASTEI_BRIDGE.deck - BASTEI_DECK_TOP);
  near("hotel", [925, 1535], 0, { name: "Berghotel Bastei" }, 20, 4);
  // --- Burg Hohnstein on its rock.
  fixed("burg", [1492, 1856], 10, gz(1492, 1856) - 1, { name: "Burg Hohnstein" });
  // --- Inns and towers on the summits.
  const summit = (id: string, at: V2, rot: number, extra: Entry = {}) => fixed(id, at, rot, gz(at[0], at[1]) - 0.5, extra);
  summit("schutzhuette", [1790, 1010], 30, { name: "Lilienstein-Hütte", scale: 1.6 });
  summit("obelisk", [1745, 985], 0, { name: "Lilienstein-Obelisk" });
  near("baude", [560, 450], 180, { name: "Berggasthaus Pfaffenstein" }, 25, 5);
  near("aussichtsturm", [545, 485], 0, { name: "Aussichtsturm Pfaffenstein" }, 20, 5);
  summit("felsturm", [612, 395], 0, { name: "Barbarine", scale: 1.2 });
  near("baude", [2105, 318], 90, { name: "Berggaststätte Papststein" }, 25, 5);
  near("aussichtsturm", [2740, 2020], 0, { name: "Aussichtsturm Großer Winterberg", scale: 1.3 }, 20, 6);
  near("baude", [2722, 2048], 180, { name: "Berghotel Großer Winterberg" }, 25, 6);
  summit("felsturm", [2860, 740], 0, { name: "Zirkelstein", scale: 1.4 });
  summit("felsturm", [2590, 770], 40, { name: "Kaiserkrone" });
  summit("felsturm", [1560, 180], 15, { name: "Gohrischstein", scale: 1.2 });

  // --- The dairy farm at Reinhardtsdorf, by the fish ponds.
  near("kuhstall", [2480, 576], 90, { name: "Agrargenossenschaft Reinhardtsdorf" }, 20, 4);
  near("hochsilo", [2445, 548], 0, {}, 20, 4);
  near("hochsilo", [2455, 538], 0, {}, 25, 4);
  near("scheune", [2535, 588], 90, { name: "Futterscheune" }, 15, 4);
  near("traktor", [2505, 545], 30, {}, 20, 4);

  // --- The engine depot at Pirna: the shed at the end of the lead, coaling stage, water cranes, a turntable.
  sp.put("lokschuppen", 528, 941.5, deg(173), { name: "Bahnbetriebswerk Pirna" });   // its doors at the ends of the shed roads
  near("bekohlung", [440, 958], 180, {}, 15, 4);
  near("wasserkran", [470, 948], 0, {}, 10, 4);
  near("drehscheibe", [420, 972], 0, {}, 15, 4);
  near("stellwerk", [320, 966], 90, { name: "Stellwerk Pirna Gbf" }, 20, 4);
  near("stellwerk", [2620, 1110], 90, { name: "Stellwerk Bad Schandau" }, 25, 4);

  // --- Boats on the Elbe: steamers, the Rathen ferry, landing stages, rowing boats.
  const river = (id: string, at: V2, rot: number, extra: Entry = {}) => {
    const hit = w.water.at(at[0], at[1]);
    if (!hit) { sceneryLog.push(`${id} at (${at}) is not on the water`); return; }
    fixed(id, at, rot, hit.surface, extra);
  };
  river("raddampfer", [2380, 1205], 10, { name: "Dampfer Krippen" });
  river("raddampfer", [700, 1150], -170, { name: "Dampfer Pirna" });
  river("raddampfer", [1525, 1150], 110, { name: "Dampfer Kurort Rathen" });
  river("faehre", [960, 1215], 90, { name: "Fähre Rathen" });
  river("faehre", [2960, 1250], 90, { name: "Fähre Schmilka" });
  river("anleger", [2330, 1196], 5, { name: "Schiffsanlegestelle Bad Schandau" });
  river("anleger", [1460, 1255], -40, { name: "Anlegestelle Königstein" });
  for (const [x, y, r] of [[1000, 1238, 80], [1006, 1241, 95], [2560, 1250, 170], [470, 1150, 10]] as Array<[number, number, number]>) river("ruderboot", [x, y], r);
}

/** Car parks for walkers and at the stations (reserved in the occupancy map before anything else is placed). */
export function carParks(sp: Space): Entry[] {
  const lots: Array<[string, string, V2, number, string?]> = [
    ["parkplatz-bastei", "Parkplatz Bastei", [910, 1612], 40],
    ["parkplatz-rathen", "Parkplatz Kurort Rathen", [906, 1232], 30],
    ["pr-bad-schandau", "P+R Bad Schandau", [2472, 1029], 30],
    ["parkplatz-kirnitzschtal", "Parkplatz Lichtenhainer Wasserfall", [2975, 1830], 24],
    ["parkplatz-festung", "Parkplatz Festung Königstein", [1215, 860], 30],
  ];
  return lots.map(([id, name, at, spaces, road]) => {
    sp.reserve([[at[0] - 26, at[1] - 26], [at[0] + 26, at[1] - 26], [at[0] + 26, at[1] + 26], [at[0] - 26, at[1] + 26]]);
    return { id, name, at, spaces, ...(road ? { road } : {}) };
  });
}

/** Signposts where the Malerweg meets roads and other paths; shelters and benches at the viewpoints. */
export function trailFurniture(sp: Space): void {
  for (const at of [[748, 1270], [752, 1692], [958, 1518], [1046, 1392], [1305, 1880], [1735, 1850], [2084, 1806], [2476, 1878], [2816, 1764],
    [2280, 594], [1958, 420], [1878, 358], [1602, 664], [552, 570], [2588, 2036], [1550, 1896], [2795, 1572], [1012, 1294]] as V2[]) {
    sp.putNear("wegweiser", at[0] + 2.5, at[1] + 2.5, 0.6, {}, 8, { maxDrop: 2 });
  }
  for (const [at, rot] of [[[1004, 1508], 30], [[2160, 372], 200], [[525, 476], 0], [[1890, 2070], 90], [[2768, 1786], 160], [[2700, 2028], 0], [[1206, 1874], 45]] as Array<[V2, number]>) {
    sp.putNear("schutzhuette", at[0], at[1], deg(rot), {}, 15, { maxDrop: 2.5 });
  }
  for (const [at, rot] of [[[985, 1512], 0], [[2140, 350], 90], [[540, 470], 180], [[2720, 2040], 0], [[1505, 1872], 90]] as Array<[V2, number]>) {
    sp.putNear("bench", at[0], at[1], deg(rot), {}, 10, { maxDrop: 1.5 });
  }
}
