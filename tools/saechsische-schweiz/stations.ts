// Stations, services and the places beyond the board.
import type { V2 } from "./lib";
import { r1 } from "./lib";
import { type World } from "./world";
import { q } from "./tracks";
import { radiusAt } from "../../src/model/geometry";

export const stationLog: string[] = [];

export function stations(w: World) {
  const Q = q(w);
  const out: Array<Record<string, unknown>> = [];
  const st = (id: string, name: string, track: string, near: V2 | number, length: number, side: "left" | "right" | "both", extra: Record<string, unknown> = {}) => {
    const at = typeof near === "number" ? near : Q.s(track, near);
    const t = w.tracks.get(track)!;
    let minR = Infinity;
    for (let s = at - length / 2; s <= at + length / 2; s += 2) minR = Math.min(minR, radiusAt(t.path, Math.max(0, Math.min(t.path.length, s))));
    if (minR < 300) stationLog.push(`station ${id}: platform radius ${minR.toFixed(0)}`);
    out.push({ id, name, track, at: r1(at), length, side, ...extra });
  };
  // --- The corridor: island platforms between each pair, a side platform with the station building.
  st("pirna-sw", "Pirna", "s-west", [610, 1031], 140, "left", { building: null, group: "pirna" });
  st("pirna-se", "Pirna", "s-east", [610, 1024], 140, "left", { building: null, group: "pirna" });
  st("pirna-fw", "Pirna", "f-west", [690, 1023], 210, "left", { building: null, group: "pirna" });
  st("pirna-fe", "Pirna", "f-east", [690, 1015], 210, "both", { building: "bahnhof-gross", group: "pirna" });
  st("rathen-sw", "Kurort Rathen", "s-west", [950, 1121], 130, "both", { building: "bahnhof-klein", group: "rathen" });
  st("rathen-se", "Kurort Rathen", "s-east", [952, 1114], 130, "left", { building: null, group: "rathen" });
  st("koenigstein-sw", "Königstein", "s-west", [1501, 1013], 110, "left", { building: null, group: "koenigstein" });
  st("koenigstein-se", "Königstein", "s-east", [1494, 1006], 110, "both", { building: "bahnhof-klein", group: "koenigstein" });
  st("bs-sw", "Bad Schandau", "s-west", [2530, 1137], 150, "left", { building: null, group: "bad-schandau" });
  st("bs-se", "Bad Schandau", "s-east", [2530, 1130], 150, "left", { building: null, group: "bad-schandau" });
  st("bs-fw", "Bad Schandau", "f-west", [2540, 1124], 215, "left", { building: null, group: "bad-schandau" });
  st("bs-fe", "Bad Schandau", "f-east", [2540, 1117], 215, "both", { building: "bahnhof-gross", group: "bad-schandau" });
  // --- The ring line: passing stations with an island between the line and its loop.
  st("lohmen-a", "Lohmen (Sachs)", "ring", [705, 1720], 64, "both", { building: "bahnhof-klein", group: "lohmen" });
  st("lohmen-b", "Lohmen (Sachs)", "ring-loop-lohmen", [698, 1720], 64, "left", { building: null, group: "lohmen" });
  st("hohnstein-a", "Hohnstein", "ring", [1418, 1961], 90, "both", { building: "bahnhof-klein", group: "hohnstein" });
  st("hohnstein-b", "Hohnstein", "ring-loop-hohnstein", [1416, 1954], 90, "right", { building: null, group: "hohnstein" });
  st("altendorf-a", "Altendorf", "ring", [1815, 1876], 110, "both", { building: "bahnhof-klein", group: "altendorf" });
  st("altendorf-b", "Altendorf", "ring-loop-altendorf", [1813, 1869], 110, "right", { building: null, group: "altendorf" });
  st("bs-ostrau", "Bad Schandau-Ostrau", "ring", [2450, 1517], 100, "right", { building: "bahnhof-klein" });
  // --- The Kirnitzschtalbahn: a tram up the Kirnitzsch valley, round a loop at the Lichtenhainer Wasserfall and back.
  // Up the valley the stops lie beside the road; down it, across the Kirnitzsch, each has a shelter.
  const tramStop = (id: string, name: string, near: V2, building: string | null = "wartehalle") => st(id, name, "tram", near, 35, "left", { building });
  tramStop("tram-kurpark-a", "Bad Schandau Kurpark", [2702, 1378], null);
  tramStop("tram-muehle-a", "Ostrauer Mühle", [2769, 1484], null);
  tramStop("tram-forsthaus-a", "Forsthaus", [2832, 1587], null);
  st("tram-wasserfall", "Lichtenhainer Wasserfall", "tram", [2850, 1748], 35, "right", { building: "wartehalle" });
  tramStop("tram-forsthaus-b", "Forsthaus", [2800, 1651]);
  tramStop("tram-muehle-b", "Ostrauer Mühle", [2731, 1529]);
  tramStop("tram-kurpark-b", "Bad Schandau Kurpark", [2648, 1393]);
  // --- Goods: Pirna's goods dock, the colliery's loading bunker, the sawmill's timber dock.
  st("pirna-gbf", "Pirna Güterbahnhof", "pirna-goods", [210, 973], 150, "right", { kind: "freight", building: "goods-shed" });
  st("colliery", "Steinkohlenwerk Gottleuba", "industrial-loop-colliery", w.tracks.get("industrial-loop-colliery")!.path.length / 2, 122, "right", { kind: "freight", building: "kohlebunker" });
  st("sawmill", "Sägewerk Cunnersdorf", "industrial", [1350, 322], 150, "right", { kind: "freight", building: "goods-shed" });
  return out;
}

export function services() {
  const S1 = "#c8102e", RB = "#2e8b57", EC = "#2f4f7f", IC = "#e9eef0";
  return [
    { id: "s1-east", name: undefined, train: "s-bahn-dd", color: S1, route: ["s-east"], mode: "loop", dwell: 22, count: 3,
      stops: ["pirna-se", "rathen-se", "koenigstein-se", "bs-se", "schoena", "dresden"] },
    { id: "s1-west", train: "s-bahn-dd", color: S1, route: ["s-west"], mode: "loop", dwell: 22, count: 3,
      stops: ["bs-sw", "koenigstein-sw", "rathen-sw", "pirna-sw", "dresden", "schoena"] },
    { id: "rb71", train: "railcar-2", color: RB, route: ["s-west", "ring"], mode: "loop", dwell: 20, count: 2,
      stops: ["lohmen-a", "hohnstein-a", "altendorf-a", "bs-ostrau", "bs-sw", "koenigstein-sw", "rathen-sw", "pirna-sw"] },
    { id: "rb72", train: "railcar-2", color: RB, mode: "loop", dwell: 20, count: 2,
      route: ["s-east", "xo-schandau-se-sw", "s-west", "ring", "ring-loop-altendorf", "ring", "ring-loop-hohnstein", "ring", "ring-loop-lohmen", "ring", "s-west", "xo-pirna-sw-se"],
      stops: ["pirna-se", "rathen-se", "koenigstein-se", "bs-se", "bs-ostrau", "altendorf-b", "hohnstein-b", "lohmen-b"] },
    { id: "ec-east", train: "eurocity-7", color: EC, route: ["f-east"], mode: "loop", dwell: 40, count: 1, stops: ["pirna-fe", "bs-fe", "decin", "praha", "dresden"] },
    { id: "ec-west", train: "eurocity-7", color: EC, route: ["f-west"], mode: "loop", dwell: 40, count: 1, stops: ["bs-fw", "pirna-fw", "dresden", "praha"] },
    { id: "ic-east", train: "intercity-dd", color: IC, route: ["f-east"], mode: "loop", dwell: 35, count: 1, stops: ["pirna-fe", "bs-fe", "decin", "dresden"] },
    { id: "ic-west", train: "intercity-dd", color: IC, route: ["f-west"], mode: "loop", dwell: 35, count: 1, stops: ["bs-fw", "pirna-fw", "dresden", "decin"] },
    { id: "timber-east", train: "freight-timber", color: "#6b5640", mode: "loop", dwell: 45, count: 1,
      route: ["f-east", "pirna-goods", "f-east", "industrial", "f-east"], stops: ["pirna-gbf", "sawmill", "decin", "dresden"] },
    { id: "coal-west", train: "freight-coal", color: "#4a4440", mode: "loop", dwell: 45, count: 1,
      route: ["f-west", "xo-schandau-fw-fe", "f-east", "industrial", "industrial-loop-sawmill", "industrial", "industrial-loop-colliery", "industrial", "f-east", "xo-pirna-fe-fw-2", "f-west"],
      stops: ["colliery", "dresden", "decin"] },
    { id: "container-east", train: "freight-container", color: "#56606a", mode: "loop", dwell: 40, count: 1,
      route: ["f-east", "pirna-goods", "f-east"], stops: ["pirna-gbf", "decin", "dresden"] },
    { id: "tank-west", train: "freight-tank", color: "#3b3f44", route: ["f-west"], mode: "loop", count: 1, stops: [] },
    { id: "box-east", train: "freight-box", color: "#8a4a3a", route: ["f-east"], mode: "loop", count: 1, stops: [] },
    { id: "tram-241", train: "tram-2", color: "#e8c547", route: ["tram"], mode: "loop", dwell: 15, count: 3,
      stops: ["tram-kurpark-a", "tram-muehle-a", "tram-forsthaus-a", "tram-wasserfall", "tram-forsthaus-b", "tram-muehle-b", "tram-kurpark-b"] },
    { id: "shunter", train: "shunter", color: "#b8473a", route: ["bw-lead", "pirna-goods"], mode: "shuttle", dwell: 30, count: 1, stops: ["pirna-gbf"] },
  ].map((s) => Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined)));
}

export function offLayout() {
  const corridorWest = [{ track: "s-east", end: "start" }, { track: "s-west", end: "end" }, { track: "f-east", end: "start" }, { track: "f-west", end: "end" }];
  const corridorEast = [{ track: "s-east", end: "end" }, { track: "s-west", end: "start" }, { track: "f-east", end: "end" }, { track: "f-west", end: "start" }];
  return [
    { id: "dresden", name: "Dresden", via: corridorWest.map((v) => ({ ...v, distance: 4500 })), jobs: 160,
      titles: ["Office worker", "Engineer", "Nurse", "Shop assistant", "Teacher", "Researcher"], visits: 4,
      supplies: { goods: 24, mail: 10, drinks: 6 }, demands: { coal: 30, timber: 8, food: 12 } },
    { id: "schoena", name: "Schöna", via: [{ track: "s-east", end: "end", distance: 1500 }, { track: "s-west", end: "start", distance: 1500 }], jobs: 10, visits: 0.5 },
    { id: "decin", name: "Děčín", via: corridorEast.map((v) => ({ ...v, distance: 4000 })), jobs: 40, titles: ["Clerk", "Engineer", "Shop assistant"], visits: 1.5,
      supplies: { goods: 10, materials: 6 }, demands: { timber: 10, goods: 4 } },
    { id: "praha", name: "Praha", via: [{ track: "f-east", end: "end", distance: 12000 }, { track: "f-west", end: "start", distance: 12000 }], jobs: 6, visits: 0.6 },
  ];
}

/** Rolling stock standing in Pirna's yard and depot: rakes of wagons waiting for a train, locomotives on shed. */
export function stabled(w: World) {
  const L = (t: string) => w.tracks.get(t)!.path.length;
  const out: Array<Record<string, unknown>> = [];
  const at = (track: string, length: number, back = 6) => r1(L(track) - length / 2 - back);
  out.push({ track: "yard-1", at: at("yard-1", 120), train: "freight-box", cars: 8, loco: false });
  out.push({ track: "yard-2", at: at("yard-2", 112), train: "freight-tank", cars: 8, loco: false });
  out.push({ track: "yard-3", at: at("yard-3", 88), train: "freight-coal", cars: 7, loco: false, load: "coal" });
  out.push({ track: "yard-4", at: at("yard-4", 64), train: "freight-timber", cars: 4, loco: false, load: "timber" });
  out.push({ track: "yard-ladder", at: at("yard-ladder", 79), train: "freight-container", cars: 4, load: "goods" });
  out.push({ track: "bw-shed-n", at: at("bw-shed-n", 11, 3), train: "shunter", cars: 1 });
  out.push({ track: "bw-shed-n", at: at("bw-shed-n", 19, 20), train: "freight-coal", cars: 1 });
  return out;
}
