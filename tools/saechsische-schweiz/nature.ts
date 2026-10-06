// Land cover: strips of fields behind the villages (Waldhufen), meadows on the valley floors,
// vineyards at Copitz, forest over everything else (traced from a mask into hole-free
// polygons), rock towers on the sandstone, cows, tents, orchards.
import type { V2 } from "./lib";
import { rng, chaikin, r1, insidePoly, blob } from "./lib";
import { type World, pointAt, headingAt, groundZ, slopeAt } from "./world";
import type { Space, Entry } from "./place";

export const natureLog: string[] = [];

// ---------------------------------------------------------------------------------------------
// Contours: marching squares on a sampled field, linked into closed loops.

function loopsOf(val: (i: number, j: number) => number, ni: number, nj: number, toXY: (fi: number, fj: number) => V2): V2[][] {
  // Grid points i in [-1, ni+1], j in [-1, nj+1]; the outer ring counts as outside (0).
  const v = (i: number, j: number) => (i < 0 || j < 0 || i > ni || j > nj ? 0 : val(i, j));
  const segs: Array<[string, string]> = [];
  const pt = new Map<string, V2>();
  const edge = (i0: number, j0: number, i1: number, j1: number) => {
    const key = `${i0},${j0},${i1},${j1}`;
    if (!pt.has(key)) {
      const a = v(i0, j0), b = v(i1, j1);
      const t = Math.abs(b - a) < 1e-9 ? 0.5 : (0.5 - a) / (b - a);
      pt.set(key, toXY(i0 + (i1 - i0) * t, j0 + (j1 - j0) * t));
    }
    return key;
  };
  for (let i = -1; i <= ni; i++) {
    for (let j = -1; j <= nj; j++) {
      const a = v(i, j) >= 0.5 ? 1 : 0, b = v(i + 1, j) >= 0.5 ? 1 : 0, c = v(i + 1, j + 1) >= 0.5 ? 1 : 0, d = v(i, j + 1) >= 0.5 ? 1 : 0;
      const code = a | (b << 1) | (c << 2) | (d << 3);
      if (code === 0 || code === 15) continue;
      const S = () => edge(i, j, i + 1, j), E = () => edge(i + 1, j, i + 1, j + 1), N = () => edge(i, j + 1, i + 1, j + 1), W = () => edge(i, j, i, j + 1);
      const centre = (v(i, j) + v(i + 1, j) + v(i + 1, j + 1) + v(i, j + 1)) / 4 >= 0.5;
      switch (code) {
        case 1: case 14: segs.push([S(), W()]); break;
        case 2: case 13: segs.push([S(), E()]); break;
        case 3: case 12: segs.push([W(), E()]); break;
        case 4: case 11: segs.push([E(), N()]); break;
        case 6: case 9: segs.push([S(), N()]); break;
        case 7: case 8: segs.push([W(), N()]); break;
        case 5: if (centre) { segs.push([S(), E()], [W(), N()]); } else { segs.push([S(), W()], [E(), N()]); } break;
        case 10: if (centre) { segs.push([S(), W()], [E(), N()]); } else { segs.push([S(), E()], [W(), N()]); } break;
      }
    }
  }
  const at = new Map<string, number[]>();
  segs.forEach(([p, q], k) => { for (const e of [p, q]) { const l = at.get(e); if (l) l.push(k); else at.set(e, [k]); } });
  const used = new Uint8Array(segs.length);
  const loops: V2[][] = [];
  for (let k = 0; k < segs.length; k++) {
    if (used[k]) continue;
    const loop: V2[] = [];
    let cur = k, from = segs[k][0];
    for (;;) {
      used[cur] = 1;
      const to = segs[cur][0] === from ? segs[cur][1] : segs[cur][0];
      loop.push(pt.get(to)!);
      const next = (at.get(to) ?? []).find((m) => !used[m]);
      if (next === undefined) break;
      from = to; cur = next;
    }
    if (loop.length >= 4) loops.push(loop);
  }
  return loops;
}

/** Douglas–Peucker simplification of a closed loop (tolerance in m). */
export function simplify(poly: V2[], tol: number): V2[] {
  if (poly.length < 8) return poly;
  const dp = (pts: V2[]): V2[] => {
    if (pts.length < 3) return pts;
    const [a, b] = [pts[0], pts[pts.length - 1]];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    let best = -1, bd = -1;
    for (let k = 1; k < pts.length - 1; k++) {
      const d = Math.abs((b[0] - a[0]) * (a[1] - pts[k][1]) - (a[0] - pts[k][0]) * (b[1] - a[1])) / L;
      if (d > bd) { bd = d; best = k; }
    }
    if (bd <= tol) return [a, b];
    const l = dp(pts.slice(0, best + 1)), r = dp(pts.slice(best));
    return [...l.slice(0, -1), ...r];
  };
  // Split the loop at its farthest pair so both halves are open lines.
  const half = Math.floor(poly.length / 2);
  const out = [...dp(poly.slice(0, half + 1)).slice(0, -1), ...dp([...poly.slice(half), poly[0]]).slice(0, -1)];
  return out.length >= 3 ? out : poly;
}

const area = (p: V2[]) => p.reduce((a, q, i) => { const r = p[(i + 1) % p.length]; return a + q[0] * r[1] - r[0] * q[1]; }, 0) / 2;

/**
 * Hole-free polygons covering where `inside` holds, tile by tile: a tile whose region has
 * holes is split in four (down to `minTile`, where holes are filled).
 */
export function regions(inside: (x: number, y: number) => boolean, x0: number, y0: number, x1: number, y1: number, h: number, tile: number, minTile: number): V2[][] {
  const out: V2[][] = [];
  const work = (tx0: number, ty0: number, size: number) => {
    const tx1 = Math.min(x1, tx0 + size), ty1 = Math.min(y1, ty0 + size);
    const ni = Math.max(1, Math.round((tx1 - tx0) / h)), nj = Math.max(1, Math.round((ty1 - ty0) / h));
    const hx = (tx1 - tx0) / ni, hy = (ty1 - ty0) / nj;
    const grid = new Float32Array((ni + 1) * (nj + 1));
    let any = 0;
    for (let i = 0; i <= ni; i++) for (let j = 0; j <= nj; j++) {
      const f = inside(tx0 + i * hx, ty0 + j * hy) ? 1 : 0;
      grid[i * (nj + 1) + j] = f; any += f;
    }
    if (!any) return;
    const loops = loopsOf((i, j) => grid[i * (nj + 1) + j], ni, nj, (fi, fj) => [tx0 + fi * hx, ty0 + fj * hy]);
    const holes = loops.filter((l) => loops.some((o) => o !== l && Math.abs(area(o)) > Math.abs(area(l)) && insidePoly(o, l[0][0], l[0][1])));
    if (holes.length && size / 2 >= minTile) {
      const half = size / 2;
      for (const [dx, dy] of [[0, 0], [half, 0], [0, half], [half, half]]) if (tx0 + dx < x1 && ty0 + dy < y1) work(tx0 + dx, ty0 + dy, half);
      return;
    }
    for (const l of loops) {
      if (holes.includes(l) || Math.abs(area(l)) < h * h * 3) continue;
      const simple = l.filter((_, k) => k % 2 === 0);
      out.push(simplify(chaikin(simple.length >= 4 ? simple : l, true, 2), 2.5).map((p) => [r1(p[0]), r1(p[1])] as V2));
    }
  };
  for (let x = x0; x < x1; x += tile) for (let y = y0; y < y1; y += tile) work(x, y, tile);
  return out;
}

/** A closed polygon pushed `d` m outward along its vertex normals. */
function grow(poly: V2[], d: number): V2[] {
  const s = area(poly) > 0 ? 1 : -1;
  return poly.map((p, k) => {
    const a = poly[(k + poly.length - 1) % poly.length], c = poly[(k + 1) % poly.length];
    const tx = c[0] - a[0], ty = c[1] - a[1];
    const L = Math.hypot(tx, ty) || 1;
    return [r1(p[0] + (ty / L) * d * s), r1(p[1] - (tx / L) * d * s)] as V2;
  });
}

// ---------------------------------------------------------------------------------------------

type Crop = { color: string; cover?: string; rows?: boolean; width?: number };
const CROPS: Crop[] = [
  { color: "#d8c47a", rows: true, width: 7 },   // wheat
  { color: "#cdb06a", rows: true, width: 6 },   // barley
  { color: "#e3d64a", rows: true, width: 9 },   // rapeseed
  { color: "#86a650", rows: true, width: 5 },   // maize
  { color: "#6f8f4a", rows: true, width: 4 },   // potatoes
  { color: "#8f7556", rows: true, width: 3 },   // ploughed
  { color: "#9fbf6a", cover: "meadow" },        // hay meadow
  { color: "#8db35e", cover: "pasture" },       // pasture
];

/** Field strips running back from a village street on both sides. */
function strips(w: World, road: string, s0: number, s1: number, opts: { from?: number; depth: [number, number]; width: [number, number]; seed: number; sides?: Array<1 | -1> }): V2[][] & { crops?: Crop[] } {
  const r = w.roads.roads.get(road)!;
  const rand = rng(opts.seed);
  const out: Array<{ poly: V2[]; crop: Crop; angle: number }> = [];
  const zRoad = (s: number) => groundZ(w.terrain, ...(pointAt(r.path, s) as V2));
  for (const side of opts.sides ?? [1, -1]) {
    let s = Math.max(0, s0);
    while (s < Math.min(s1, r.path.length)) {
      const wd = opts.width[0] + rand() * (opts.width[1] - opts.width[0]);
      const sa = s, sb = Math.min(r.path.length, s + wd);
      const sm = (sa + sb) / 2;
      const h = headingAt(r.path, sm);
      const n: V2 = [-Math.sin(h) * side, Math.cos(h) * side];
      const a = opts.from ?? 40;
      let b = opts.depth[0] + rand() * (opts.depth[1] - opts.depth[0]);
      const z0 = zRoad(sm);
      const [mx, my] = pointAt(r.path, sm);
      for (let d = a; d <= b; d += 10) {
        const x = mx + n[0] * d, y = my + n[1] * d;
        if (x < 5 || y < 5 || x > w.terrain.width - 5 || y > w.terrain.height - 5 || w.water.at(x, y, 4) ||
          slopeAt(w.terrain, x, y) > 0.2 || Math.abs(groundZ(w.terrain, x, y) - z0) > 9) { b = d - 10; break; }
      }
      if (b - a >= 50) {
        const [ax, ay] = pointAt(r.path, sa), [bx, by] = pointAt(r.path, sb);
        const ha = headingAt(r.path, sa), hb = headingAt(r.path, sb);
        const na: V2 = [-Math.sin(ha) * side, Math.cos(ha) * side], nb: V2 = [-Math.sin(hb) * side, Math.cos(hb) * side];
        const poly: V2[] = [[ax + na[0] * a, ay + na[1] * a], [bx + nb[0] * a, by + nb[1] * a], [bx + nb[0] * b, by + nb[1] * b], [ax + na[0] * b, ay + na[1] * b]];
        out.push({ poly: poly.map((p) => [r1(p[0]), r1(p[1])] as V2), crop: CROPS[Math.floor(rand() * CROPS.length)], angle: (Math.atan2(n[1], n[0]) * 180) / Math.PI });
      }
      s = sb + 1;
    }
  }
  return out as never;
}

export function nature(sp: Space): { areas: unknown[]; scenery: Entry[] } {
  const w = sp.w;
  const areas: unknown[] = [];          // fields, vineyards, towns… (on top)
  const under: unknown[] = [];          // meadows, then forest floor
  const scenery: Entry[] = [];
  const open: V2[][] = [];          // where no forest grows
  const field = (poly: V2[], crop: Crop, angle: number) => {
    areas.push(crop.rows ? { cover: "field", color: crop.color, points: poly, rows: Math.round(angle), rowWidth: crop.width } : { cover: crop.cover ?? "meadow", color: crop.color, points: poly });
    open.push(poly);
  };
  const addStrips = (road: string, s0: number, s1: number, opts: Omit<Parameters<typeof strips>[4], "seed">, seed: number) => {
    for (const f of strips(w, road, s0, s1, { ...opts, seed }) as unknown as Array<{ poly: V2[]; crop: Crop; angle: number }>) field(f.poly, f.crop, f.angle);
  };
  // --- Fields behind the plateau villages.
  const farm = { depth: [220, 420] as [number, number], width: [45, 80] as [number, number] };
  addStrips("lohmen-nord", 0, 600, farm, 11);
  addStrips("hohnsteiner-strasse", 0, 617, { ...farm, from: 20 }, 12);
  addStrips("ehrenberger-strasse", 0, 307, farm, 13);
  addStrips("altendorf-dorf", 0, 284, { ...farm, depth: [150, 280] }, 14);
  addStrips("mittelndorfer-strasse", 250, 775, farm, 15);
  addStrips("struppen-dorf", 0, 241, farm, 16);
  addStrips("pfaffensteinweg", 0, 120, farm, 17);
  addStrips("saegewerkstrasse", 420, 718, { ...farm, sides: [-1] }, 18);
  addStrips("gohrisch-dorf", 0, 220, { ...farm, depth: [150, 260] }, 19);
  addStrips("papstdorfer-strasse", 60, 445, farm, 20);
  addStrips("reinhardtsdorf-dorf", 0, 344, farm, 21);
  addStrips("lohmen-dorf", 0, 221, { ...farm, depth: [150, 250] }, 22);
  addStrips("ostrau-dorf", 0, 161, { depth: [80, 140], width: [40, 60], from: 30 }, 23);
  addStrips("ostrau-west", 0, 151, { depth: [80, 140], width: [40, 60], from: 30 }, 24);

  // --- Vineyards on the Copitz slope, with their little houses.
  const vineyard: V2[] = [[0, 1270], [200, 1268], [420, 1272], [575, 1276], [590, 1300], [585, 1330], [400, 1334], [200, 1332], [0, 1334]];
  areas.push({ cover: "vineyard", points: vineyard, rows: 0, rowWidth: 2.6 });
  open.push(vineyard);
  scenery.push({ scatter: ["rebzeile"], area: vineyard, rows: { angle: 0, spacing: 2.6 }, spacing: 6.2, scale: [0.95, 1.05] });
  for (const at of [[130, 1312], [360, 1316], [520, 1310]] as V2[]) sp.putNear("weinberghaus", at[0], at[1], Math.PI / 2, {}, 15, { maxDrop: 6 });
  // --- The Copitz terrace above: orchards and fields.
  const terrace: V2[][] = [
    [[0, 1340], [180, 1338], [200, 1440], [0, 1445]],
    [[200, 1338], [400, 1340], [420, 1430], [210, 1438]],
    [[410, 1342], [560, 1345], [585, 1430], [430, 1432]],
  ];
  field(terrace[0], CROPS[0], 0); field(terrace[2], CROPS[2], 90);
  areas.push({ cover: "orchard", points: terrace[1] }); open.push(terrace[1]);
  scenery.push({ scatter: ["deciduous"], area: terrace[1], rows: { angle: 10, spacing: 11 }, spacing: 10, scale: [0.5, 0.7] });

  // --- Towns, yards and other open ground.
  const town = (poly: V2[], cover = "town") => { areas.push({ cover, points: poly }); open.push(poly); };
  town([[480, 880], [960, 870], [990, 900], [970, 1000], [500, 1000]]);                    // Pirna
  town([[1150, 1040], [1420, 1080], [1480, 1000], [1500, 1130], [1180, 1140]]);             // Königstein
  town([[2160, 1250], [2700, 1262], [2700, 1340], [2380, 1330], [2290, 1380], [2160, 1300]]);  // Bad Schandau
  town([[2330, 1010], [2650, 1050], [2660, 1100], [2340, 1080]]);                           // Bad Schandau station side
  town([[0, 930], [520, 920], [520, 1000], [0, 1000]], "yard");                            // Pirna goods yard and depot
  town([[975, 600], [1110, 640], [1112, 830], [990, 830]], "yard");                         // colliery
  town([[1240, 240], [1470, 240], [1470, 385], [1240, 385]], "yard");                       // sawmill
  town([[1050, 560], [1110, 540], [1130, 600], [1060, 640]], "spoil");                      // spoil tip
  town([[1280, 490], [1400, 495], [1405, 600], [1280, 610]], "rock");                       // the quarry
  // The clearing where the woodcutters work.
  const clearing = blob([1165, 145], 55, 40, 10, 7, 0.25);
  areas.push({ cover: "heath", points: clearing }); open.push(clearing);
  scenery.push({ scatter: ["baumstumpf"], area: clearing, spacing: 6, scale: [0.8, 1.3] });
  // Meadows on the valley floors: the Elbe and its side valleys below 11 m.
  const meadowMask = (x: number, y: number) => groundZ(w.terrain, x, y) < 11 && slopeAt(w.terrain, x, y) < 0.12;
  for (const poly of regions(meadowMask, 0, 0, w.terrain.width, w.terrain.height, 10, 400, 50)) { under.push({ cover: "meadow", points: poly }); open.push(poly); }
  // Campsites: on the Copitz Elbe meadow, at the Waldbad Gohrisch, in the Kirnitzschtal.
  const camps: Array<{ poly: V2[]; name: string; hut: V2; rot: number }> = [
    { poly: [[20, 1170], [150, 1168], [160, 1235], [20, 1238]], name: "Campingplatz Pirna-Copitz", hut: [90, 1232], rot: 90 },
    { poly: [[1700, 125], [1810, 120], [1820, 175], [1705, 185]], name: "Campingplatz Waldbad Gohrisch", hut: [1760, 150], rot: 0 },
  ];
  for (const c of camps) {
    areas.push({ cover: "meadow", color: "#94b860", points: c.poly }); open.push(c.poly);
    sp.putNear("campingbaracke", c.hut[0], c.hut[1], (c.rot * Math.PI) / 180, { name: c.name }, 25);
    scenery.push({ scatter: ["zelt", "zelt", "zelt", "wohnwagen", "wohnwagen", "sonnenschirm"], area: c.poly, spacing: 9, scale: [0.9, 1.1] });
  }
  sp.putNear("badehaus", 1760, 182, Math.PI / 2, { name: "Waldbad Gohrisch" }, 20);
  // Pasture with cows by the farm, hay bales on a meadow.
  const pasture: V2[] = [[2380, 380], [2540, 370], [2560, 470], [2400, 500]];
  areas.push({ cover: "pasture", points: pasture }); open.push(pasture);
  scenery.push({ scatter: ["kuh"], area: pasture, spacing: 9, scale: [0.95, 1.05] });
  const pasture2: V2[] = [[2590, 400], [2720, 390], [2740, 480], [2600, 500]];
  areas.push({ cover: "pasture", points: pasture2 }); open.push(pasture2);
  scenery.push({ scatter: ["kuh"], area: pasture2, spacing: 12, scale: [0.95, 1.05] });
  const hay: V2[] = [[2300, 420], [2370, 415], [2375, 480], [2300, 490]];
  areas.push({ cover: "meadow", color: "#c9c07a", points: hay }); open.push(hay);
  scenery.push({ scatter: ["heuballen"], area: hay, spacing: 14, scale: [0.9, 1.1] });
  // Kurpark in Bad Schandau.
  const kurpark: V2[] = [[2560, 1300], [2640, 1300], [2650, 1340], [2570, 1350]];
  areas.push({ cover: "park", points: kurpark }); open.push(kurpark);

  // --- Forest everywhere else.
  const buildings = sp.entries.filter((e) => typeof e.object === "string" && !["felsturm", "festungsmauer", "obelisk", "aussichtsturm", "schutzhuette", "wegweiser"].includes(e.object as string))
    .map((e) => e.at as V2);
  const bgrid = new Map<string, V2[]>();
  for (const b of buildings) { const k = `${Math.floor(b[0] / 50)},${Math.floor(b[1] / 50)}`; (bgrid.get(k) ?? bgrid.set(k, []).get(k)!).push(b); }
  const nearBuilding = (x: number, y: number) => {
    const i = Math.floor(x / 50), j = Math.floor(y / 50);
    for (let a = i - 1; a <= i + 1; a++) for (let b = j - 1; b <= j + 1; b++) for (const p of bgrid.get(`${a},${b}`) ?? []) if (Math.hypot(p[0] - x, p[1] - y) < 34) return true;
    return false;
  };
  const boxes = open.map((p) => ({ p, x0: Math.min(...p.map((q) => q[0])), x1: Math.max(...p.map((q) => q[0])), y0: Math.min(...p.map((q) => q[1])), y1: Math.max(...p.map((q) => q[1])) }));
  const isOpen = (x: number, y: number) => boxes.some((b) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1 && insidePoly(b.p, x, y));
  const forestMask = (x: number, y: number) => !isOpen(x, y) && !nearBuilding(x, y) && !w.water.at(x, y, 2);
  const forests = regions(forestMask, 0, 0, w.terrain.width, w.terrain.height, 10, 300, 40);
  const rand = rng(99);
  for (const poly of forests) {
    under.push({ cover: "forest", points: grow(poly, 4) });
    // Pines on the rocks, beech in the gorges, spruce on the plateaus.
    const c = poly.reduce((a, p) => [a[0] + p[0] / poly.length, a[1] + p[1] / poly.length], [0, 0]);
    const z = groundZ(w.terrain, c[0], c[1]);
    const steep = slopeAt(w.terrain, c[0], c[1]) > 0.35;
    const mix = steep ? ["kiefer", "kiefer", "conifer", "birke"] : z < 30 ? ["deciduous", "deciduous", "conifer", "birke", "kiefer"] : ["conifer", "conifer", "conifer", "deciduous", "kiefer"];
    scenery.push({ scatter: mix, area: poly, spacing: 12 + rand() * 2, scale: [0.8, 1.35] });
  }
  natureLog.push(`forest polygons: ${forests.length}, open polygons: ${open.length}`);

  // --- Gardens behind the village houses, avenues along the country roads, willows on the Elbe banks.
  const band = (road: string, s0: number, s1: number, a: number, b: number, step = 40): V2[][] => {
    const r = w.roads.roads.get(road)!;
    const out: V2[][] = [];
    for (let s = Math.max(0, s0); s < Math.min(s1, r.path.length) - 5; s += step) {
      const t = Math.min(s + step, Math.min(s1, r.path.length));
      for (const side of [1, -1]) {
        const corner = (ss: number, d: number): V2 => {
          const [x, y] = pointAt(r.path, ss);
          const h = headingAt(r.path, ss);
          return [r1(x - Math.sin(h) * d * side), r1(y + Math.cos(h) * d * side)];
        };
        out.push([corner(s, a), corner(t, a), corner(t, b), corner(s, b)]);
      }
    }
    return out;
  };
  const gardens: Array<[string, number, number]> = [["lohmen-nord", 0, 330], ["hohnstein-markt", 0, 233], ["ehrenberger-strasse", 0, 307], ["altendorf-dorf", 0, 284],
    ["mittelndorfer-strasse", 380, 720], ["struppen-dorf", 0, 241], ["saegewerkstrasse", 420, 718], ["gohrisch-dorf", 0, 220], ["papstdorfer-strasse", 80, 445],
    ["reinhardtsdorf-dorf", 0, 344], ["s165", 150, 900], ["s168", 40, 350], ["bielatal", 0, 150], ["ostrau-dorf", 0, 161], ["ostrau-west", 0, 151], ["elbkai", 760, 1104]];
  for (const [road, s0, s1] of gardens) {
    for (const poly of band(road, s0, s1, sp.roadSide(road) + 1, 36)) scenery.push({ scatter: ["bush", "bush", "deciduous", "birke"], area: poly, spacing: 8, scale: [0.45, 0.8] });
  }
  const avenues: Array<[string, number, number, string]> = [["hohnsteiner-strasse", 20, 600, "deciduous"], ["b172-west", 0, 250, "poplar"], ["saegewerkstrasse", 30, 400, "deciduous"],
    ["papstdorfer-strasse", 0, 80, "deciduous"], ["lohmen-nord", 340, 599, "deciduous"], ["s165", 0, 140, "poplar"], ["mittelndorfer-strasse", 120, 360, "deciduous"]];
  for (const [road, s0, s1, tree] of avenues) {
    const d = sp.roadSide(road);
    for (const poly of band(road, s0, s1, d + 2.5, d + 5.5, 60)) scenery.push({ scatter: [tree], area: poly, spacing: 13, scale: [0.9, 1.15] });
  }
  for (const at of [[320, 1165], [1150, 1300], [1700, 1215], [2050, 1210], [2700, 1265], [450, 1060], [2900, 1200]] as V2[]) {
    scenery.push({ scatter: ["bush", "deciduous", "poplar", "birke"], at, radius: 45, spacing: 11, scale: [0.7, 1.1] });
  }

  // --- Sandstone rock towers on the Bastei, the Schrammsteine and round the table mountains.
  const rocks = (at: V2, radius: number, spacing: number) => scenery.push({ scatter: ["felsturm", "felsturm", "felsriff"], at, radius, spacing, scale: [0.7, 1.3] });
  /** Towers round the rim of a table mountain, in little clusters. */
  const rim = (c: V2, R: number, n: number, r: number, spacing: number) => {
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + rand() * 0.3;
      rocks([r1(c[0] + Math.cos(a) * R), r1(c[1] + Math.sin(a) * R)], r, spacing);
    }
  };
  rocks([1000, 1420], 120, 26);
  rocks([2930, 1440], 110, 24);
  rocks([2830, 1410], 60, 24);
  rim([1790, 1010], 98, 14, 26, 30);
  rim([560, 450], 68, 9, 20, 28);
  rim([2100, 330], 62, 8, 18, 28);
  rim([1560, 180], 56, 7, 18, 26);
  rim([1330, 930], 92, 12, 16, 36);
  return { areas: [...under, ...areas], scenery };
}
