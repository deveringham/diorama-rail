// Buses: stops beside the roads and the lines calling at them, out to the towns beyond the board.
import type { V2 } from "./lib";
import { r1 } from "./lib";
import type { World } from "./world";
import { pointAt } from "./world";

function sOn(w: World, id: string, p: V2): number {
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

export function busStops(w: World) {
  const stop = (id: string, name: string, road: string, p: V2, ds = 0, side?: "left" | "right") => ({ id, name, road, at: r1(sOn(w, road, p) + ds), ...(side ? { side } : {}) });
  return [
    stop("pirna-bf", "Pirna, Bahnhof", "pirna-bahnhofstrasse", [641, 962]),
    stop("hst-pirna-markt", "Pirna, Markt", "b172-pirna", [820, 942]),
    stop("copitz", "Pirna-Copitz, Kirche", "s165", [660, 1260], 7),
    stop("lohmen", "Lohmen, Markt", "lohmen-nord", [588, 1660]),
    stop("bastei", "Bastei", "bastei-strasse", [952, 1560]),
    stop("hohnstein", "Hohnstein, Markt", "hohnstein-markt", [1420, 1905]),
    stop("ehrenberg", "Ehrenberg", "ehrenberger-strasse", [1760, 1832]),
    stop("altendorf", "Altendorf", "altendorf-dorf", [1990, 1782]),
    stop("mittelndorf", "Mittelndorf", "mittelndorfer-strasse", [2560, 1975]),
    stop("hst-bs-markt", "Bad Schandau, Markt", "elbkai", [2300, 1275], 13),
    stop("bs-kurpark", "Bad Schandau, Kurpark", "elbkai", [2560, 1290]),
    stop("ostrau", "Ostrau", "ostrau-dorf", [2585, 1475]),
    stop("schmilka", "Schmilka", "elbkai", [2900, 1302]),
    stop("bs-bf", "Bad Schandau, Bahnhof", "b172-hub", [2560, 1078]),
    stop("krippen", "Krippen", "s168", [2760, 1090], 0, "right"),
    stop("reinhardtsdorf", "Reinhardtsdorf", "reinhardtsdorf-dorf", [2500, 612]),
    stop("papstdorf", "Papstdorf", "papstdorfer-strasse", [2180, 604]),
    stop("gohrisch", "Kurort Gohrisch", "gohrisch-dorf", [1930, 418]),
    stop("cunnersdorf", "Cunnersdorf", "saegewerkstrasse", [1640, 297], 0, "right"),
    stop("koenigstein", "Königstein, Bahnhof", "b172-koenigstein", [1445, 1060]),
    stop("struppen", "Struppen", "struppen-dorf", [700, 556], 17),
    stop("rathen", "Kurort Rathen, Parkplatz", "s165", [845, 1262]),
  ];
}

export function busLines() {
  return [
    { id: "linie-237", name: "237 Pirna – Lohmen – Hohnstein – Bad Schandau", color: "#d9a441", count: 3, dwell: 15,
      stops: ["pirna-bf", "hst-pirna-markt", "copitz", "lohmen", "hohnstein", "ehrenberg", "altendorf", "hst-bs-markt"] },
    { id: "linie-241", name: "241 Pirna – Königstein – Gohrisch – Bad Schandau", color: "#4f6f9a", count: 3, dwell: 15,
      stops: ["pirna-bf", "hst-pirna-markt", "struppen", "koenigstein", "cunnersdorf", "gohrisch", "papstdorf", "reinhardtsdorf", "krippen", "bs-bf"] },
    { id: "linie-252", name: "252 Bad Schandau – Ostrau – Schmilka", color: "#5f8a4e", count: 2, dwell: 12,
      stops: ["bs-bf", "hst-bs-markt", "ostrau", "bs-kurpark", "schmilka"] },
    { id: "bastei-express", name: "Bastei-Express", color: "#b8473a", count: 2, dwell: 20,
      stops: ["pirna-bf", "copitz", "rathen", "lohmen", "bastei"] },
    { id: "linie-261", name: "261 Lohmen – Stolpen", color: "#8a6a9a", count: 2, dwell: 12, stops: ["hst-pirna-markt", "lohmen", "stolpen"] },
    { id: "linie-264", name: "264 Bad Schandau – Sebnitz", color: "#c8553d", count: 2, dwell: 12, stops: ["hst-bs-markt", "altendorf", "mittelndorf", "sebnitz"] },
  ];
}

/** Places off the board that roads (and footpaths) lead to. */
export function roadPlaces() {
  return [
    { id: "stolpen", name: "Stolpen", via: [{ road: "lohmen-nord", end: "end", distance: 2500 }], jobs: 20, titles: ["Clerk", "Craftsman", "Nurse"], visits: 1 },
    { id: "sebnitz", name: "Sebnitz", via: [{ road: "sebnitzer-strasse", end: "end", distance: 3000 }], jobs: 30, titles: ["Factory worker", "Clerk", "Teacher"], visits: 1,
      supplies: { goods: 4 }, demands: { timber: 3, food: 2 } },
    { id: "hinterhermsdorf", name: "Hinterhermsdorf", via: [{ road: "kirnitzschtalstrasse", end: "end", distance: 3000 }], jobs: 6, visits: 0.8 },
    { id: "rosenthal", name: "Rosenthal-Bielatal", via: [{ road: "bielatal", end: "end", distance: 2500 }], jobs: 8, visits: 0.6, demands: { coal: 2 } },
    { id: "neustadt", name: "Neustadt in Sachsen", via: [{ road: "hohnstein-nord", end: "end", distance: 3500 }, { road: "mittelndorfer-strasse", end: "end", distance: 4000 }], jobs: 30, titles: ["Machinist", "Clerk", "Nurse"], visits: 1 },
  ];
}
