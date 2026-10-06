// The railway: the four-track Elbe valley corridor, Pirna's yards, the ring line over the
// northern plateau, the industrial line through the southern hills, crossovers and sidings.
import { type V2, type WP, wpJson, filletCurve, offsetCurve, fitWps, piecewise, minRadius, smoothstep, r1 } from "./lib";
import { type World, sOf, beside, trackLen, trackZ, pointAt, headingAt } from "./world";

export const zCorr = (_s: number, p: V2) => piecewise([[0, 8], [800, 8], [1000, 8.5], [1300, 9], [2000, 9], [2400, 9.5], [3000, 9.5]], p[0]);

// Centre lines, west → east, as vertices [x, y, radius]: K for the slow pair (S-Bahn, regional),
// KF for the fast pair (EC/IC, freight), which cuts across the Königstein lobe in a tunnel under
// the fortress rock and meets K again on the straight before the bend under the Lilienstein.
const A4: V2 = [1555, 860];
const A5: V2 = [1880, 670];
const B3: V2 = [A4[0] + 0.863 * 150, A4[1] - 0.505 * 150];
const KV: Array<[number, number, number?]> = [[0, 1012], [820, 1028, 500], [1050, 1172, 400], [1397, 1217, 230], [A4[0], A4[1], 260],
  [A5[0], A5[1], 260], [2110, 870, 300], [2290, 1092, 300], [2850, 1156, 1500], [3000, 1170]];
const KFV: Array<[number, number, number?]> = [[0, 1012], [760, 1027, 800], [1000, 1015, 500], [B3[0], B3[1], 300],
  [A5[0], A5[1], 260], [2110, 870, 300], [2290, 1092, 300], [2850, 1156, 1500], [3000, 1170]];

export const OFF = { sw: 10.4, se: 3.0, fw: -3.0, fe: -10.4 };
/** The eastbound fast track swings out round Pirna's yard: this much further south, west of x = 380. */
const YARD_SWING = 27;

export type Track = Record<string, unknown> & { id: string };
export type Dir = "forward" | "backward";
export const trackLog: string[] = [];

function lineTrack(id: string, wps: WP[], reverse: boolean, extra: Record<string, unknown> = {}): Track {
  const pts = reverse ? [...wps].reverse() : wps;
  trackLog.push(`${id}: ${wps.length} pts, min radius ${minRadius(wps).toFixed(0)}`);
  return { id, kind: "line", minRadius: 300, maxGrade: 0.03, ...extra, points: pts.map(wpJson) };
}

export function corridor(): Track[] {
  const K = filletCurve(KV);
  const KF = filletCurve(KFV);
  const swing = (p: V2) => YARD_SWING * (1 - smoothstep(380, 560, p[0]));
  return [
    lineTrack("s-east", fitWps(offsetCurve(K, OFF.se), { zAt: zCorr }), false),
    lineTrack("s-west", fitWps(offsetCurve(K, OFF.sw), { zAt: zCorr }), true),
    lineTrack("f-east", fitWps(offsetCurve(KF, (p) => OFF.fe - swing(p)), { zAt: zCorr }), false),
    lineTrack("f-west", fitWps(offsetCurve(KF, OFF.fw), { zAt: zCorr }), true),
  ];
}

export type End = { track: string; at: number; heading: Dir };
/** A branch track: from/to junctions and sparse waypoints (the engine fillets them). */
export function branch(id: string, spec: { from?: End; to?: End; points: Array<V2 | WP>; minRadius?: number; maxGrade?: number }): Track {
  const pts = spec.points.map((p) => (Array.isArray(p) ? (p.map(r1) as V2) : wpJson({ ...p, at: p.at.map(r1) as V2 })));
  return {
    id, kind: "line", minRadius: spec.minRadius ?? 190, maxGrade: spec.maxGrade ?? 0.035,
    ...(spec.from ? { from: { ...spec.from, at: r1(spec.from.at) } } : {}), points: pts, ...(spec.to ? { to: { ...spec.to, at: r1(spec.to.at) } } : {}),
  };
}

/** Queries on a built world for laying out branches. */
export function q(w: World) {
  const path = (t: string) => {
    const g = w.tracks.get(t);
    if (!g) throw new Error(`no track '${t}'`);
    return g.path;
  };
  return {
    /** s on a track where it passes x (for tracks running roughly east–west). */
    atX(track: string, x: number): number {
      const p = path(track);
      let best = 0, bd = Infinity;
      for (let s = 0; s <= p.length; s += 0.5) {
        const d = Math.abs(pointAt(p, s)[0] - x);
        if (d < bd) { bd = d; best = s; }
      }
      return r1(best);
    },
    s: (track: string, p: V2) => sOf(w, track, p),
    len: (track: string) => trackLen(w, track),
    /** Point `lateral` m left of the track at s (s clamped). */
    beside: (track: string, s: number, lateral: number) => beside(w, track, Math.max(0, Math.min(trackLen(w, track), s)), lateral),
    point: (track: string, s: number) => pointAt(path(track), s) as V2,
    heading: (track: string, s: number) => headingAt(path(track), s),
    z: (track: string, s: number) => trackZ(w, track, Math.max(0, Math.min(trackLen(w, track), s))),
  };
}

/**
 * A crossover from parallel track a to b, both travelled the same way: from a at sa (in
 * `head` direction along a), arriving on b at the point beside sa + `length` along a.
 */
export function crossover(w: World, id: string, a: string, sa: number, headA: Dir, b: string, headB: Dir, length = 100): Track {
  const Q = q(w);
  const dir = headA === "forward" ? 1 : -1;
  const pEnd = Q.point(a, sa + dir * length);
  const sb = Q.s(b, pEnd);
  const pb = Q.point(b, sb);
  // Which side of a (relative to increasing s) b lies on, and how far.
  const h = Q.heading(a, sa + dir * length);
  const lat = -(pb[0] - pEnd[0]) * Math.sin(h) + (pb[1] - pEnd[1]) * Math.cos(h);
  const p1 = Q.beside(a, sa + dir * length * 0.38, lat * 0.25);
  const p2 = Q.beside(a, sa + dir * length * 0.62, lat * 0.75);
  const z1 = Q.z(a, sa + dir * length * 0.38);
  const z2 = Q.z(a, sa + dir * length * 0.62);
  return branch(id, { from: { track: a, at: sa, heading: headA }, points: [{ at: p1, z: r1(z1) }, { at: p2, z: r1(z2) }], to: { track: b, at: sb, heading: headB }, minRadius: 160 });
}

/** Points on a circle from angle a0 to a1 (degrees), every `step` degrees. */
export function arcPts(c: V2, R: number, a0: number, a1: number, step: number): V2[] {
  const n = Math.max(1, Math.round(Math.abs(a1 - a0) / step));
  return Array.from({ length: n + 1 }, (_, k) => {
    const a = ((a0 + ((a1 - a0) * k) / n) * Math.PI) / 180;
    return [r1(c[0] + R * Math.cos(a)), r1(c[1] + R * Math.sin(a))] as V2;
  });
}

/** Stage B: tracks branching off the corridor. */
export function stageB(w: World): Track[] {
  const Q = q(w);
  const out: Track[] = [];
  // --- Pirna yard (Rangierbahnhof): a ladder off the westbound fast track into stub sidings ---------------
  const ladJ = Q.atX("f-west", 372);
  out.push(branch("yard-ladder", { from: { track: "f-west", at: ladJ, heading: "forward" },
    points: [{ at: Q.beside("f-west", ladJ + 45, 4.5), z: 8 }, Q.beside("f-west", ladJ + 245, 28), { at: Q.beside("f-west", Q.atX("f-west", 25), 28), z: 8 }], minRadius: 150 }));
  // Goods loop south of the eastbound fast track, with the dock; and a crossover to the westbound track.
  const g0 = Q.atX("f-east", 60), g1 = Q.atX("f-east", 368);
  out.push(branch("pirna-goods", { from: { track: "f-east", at: g0, heading: "forward" }, points: [{ at: Q.beside("f-east", g0 + 60, -6), z: 8 }, { at: Q.beside("f-east", g1 - 60, -6), z: 8 }], to: { track: "f-east", at: g1, heading: "forward" } }));
  // --- Crossovers for trains running the single-lead junctions ---------------------------------------------
  out.push(crossover(w, "xo-pirna-sw-se", "s-west", Q.atX("s-west", 425), "backward", "s-east", "forward"));
  out.push(crossover(w, "xo-pirna-fe-fw-2", "f-east", Q.atX("f-east", 878), "backward", "f-west", "forward"));
  out.push(crossover(w, "xo-schandau-se-sw", "s-east", Q.atX("s-east", 2662), "forward", "s-west", "backward"));
  return out;
}

/** Stage C: the ring line over the northern plateau and the industrial line through the southern hills. */
export function stageC(w: World): Track[] {
  const Q = q(w);
  const out: Track[] = [];
  const v = (x: number, y: number, radius?: number, z?: number): WP => ({ at: [x, y], ...(radius ? { radius } : {}), ...(z !== undefined ? { z } : {}) });
  // --- The Elbsandstein ring: Pirna → (horseshoe over the Elbe, up the vineyards) → Lohmen → Hohnstein →
  // Altendorf → Bad Schandau Ostrau → (horseshoe down through the Schrammsteine, over the Elbe) → Bad Schandau.
  const jA = Q.atX("s-west", 380);
  const pA = Q.point("s-west", jA);
  const hsA = arcPts([380, pA[1] + 200], 200, -130, -270, 20).map((p, k, a) => v(p[0], p[1], 185, k === a.length - 1 ? 30 : undefined));
  const jB = Q.atX("s-west", 2790);
  const pB = Q.point("s-west", jB);
  const hsB = arcPts([2790, pB[1] + 175], 175, 90, -70, 20).map((p, k) => v(p[0], p[1], 165, k === 0 ? 31 : undefined));
  out.push(branch("ring", {
    from: { track: "s-west", at: jA, heading: "forward" },
    points: [
      ...hsA,
      v(600, 1440, 180), v(700, 1560, 200), v(705, 1720, 400), v(705, 1890, 150, 46), v(870, 1995, 300),
      v(1300, 1985, 600, 47), v(1700, 1905, 400), v(1960, 1840, 300, 47), v(2160, 1700, 250), v(2280, 1530, 250, 40),
      v(2550, 1509, 400, 35),
      ...hsB,
    ],
    to: { track: "s-west", at: jB, heading: "forward" },
    minRadius: 160, maxGrade: 0.04,
  }));
  // --- The industrial line: Pirna → up the Gottleuba valley to the colliery → across the southern plateau
  // past the sawmill → down to the corridor east of Bad Schandau.
  out.push(branch("industrial", {
    from: { track: "f-east", at: Q.atX("f-east", 905), heading: "forward" },
    points: [v(1030, 960, 120), v(1025, 860, 250, 12), v(985, 560, 150, 15), v(905, 420, 85), v(1080, 400, 150), v(1220, 335, 300, 30.5),
      v(1480, 310, 300), v(1700, 330, 400), v(2000, 560, 400, 35), v(2220, 770, 500), v(2440, 980, 250), v(2600, 1000, 200), v(2720, 1100, 85, 8.2)],
    to: { track: "f-east", at: Q.atX("f-east", 2795), heading: "forward" },
    minRadius: 85, maxGrade: 0.04,
  }));
  return out;
}

/**
 * A passing loop beside `parent` between s0 and s1 (s0 < s1), `lateral` m to its left
 * (negative: right), for trains travelling `heading` along the parent.
 */
export function passingLoop(w: World, id: string, parent: string, s0: number, s1: number, lateral: number, heading: Dir, minRadius = 160): Track {
  const Q = q(w);
  const lead = 1.9 * Math.sqrt(minRadius * Math.abs(lateral)) + 10;
  const a = Q.beside(parent, s0 + lead, lateral);
  const b = Q.beside(parent, s1 - lead, lateral);
  const za = r1(Q.z(parent, s0 + lead));
  const zb = r1(Q.z(parent, s1 - lead));
  const [first, last, sFrom, sTo] = heading === "forward" ? [a, b, s0, s1] : [b, a, s1, s0];
  const [zf, zl] = heading === "forward" ? [za, zb] : [zb, za];
  return branch(id, { from: { track: parent, at: sFrom, heading }, points: [{ at: first, z: zf }, { at: last, z: zl }], to: { track: parent, at: sTo, heading }, minRadius });
}

/** Stage D: passing loops on the ring and industrial lines, and the engine depot. */
export function stageD(w: World): Track[] {
  const Q = q(w);
  const out: Track[] = [];
  const near = (track: string, p: V2) => Q.s(track, p);
  // Ring passing loops, for trains going round the other way (backward along the ring).
  out.push(passingLoop(w, "ring-loop-lohmen", "ring", near("ring", [700, 1603]), near("ring", [709, 1839]), 7.4, "backward"));
  out.push(passingLoop(w, "ring-loop-hohnstein", "ring", near("ring", [1281, 1985]), near("ring", [1561, 1933]), -7.4, "backward"));
  out.push(passingLoop(w, "ring-loop-altendorf", "ring", near("ring", [1674, 1910]), near("ring", [1963, 1833]), -7.4, "backward"));
  // Industrial passing loops: at the colliery (the loop takes the loading dock) and at the sawmill.
  out.push(passingLoop(w, "industrial-loop-colliery", "industrial", near("industrial", [1024, 858]), near("industrial", [990, 592]), 5, "backward", 140));
  out.push(passingLoop(w, "industrial-loop-sawmill", "industrial", near("industrial", [1225, 334]), near("industrial", [1475, 311]), 7, "backward", 140));
  // The engine depot (Bahnbetriebswerk) south of the goods loop: a lead to the turntable, a shed road.
  const g = near("pirna-goods", [292, 976]);
  out.push(branch("bw-lead", { from: { track: "pirna-goods", at: g, heading: "forward" }, points: [{ at: [390, 952], z: 8 }, { at: [515, 933], z: 8 }], minRadius: 120 }));
  // Crossover for westbound freight joining the industrial line at its eastern end.
  out.push(crossover(w, "xo-schandau-fw-fe", "f-west", Q.atX("f-west", 2935), "forward", "f-east", "backward"));
  return out;
}

/** The Kirnitzschtal tram: a loop up the east side of the valley road and back down past the stream. */
export function tram(): Track {
  const pts: Array<[number, number, number, number]> = [
    [2668, 1328, 15, 7.6], [2733, 1424, 120, 9], [2793, 1524, 150, 11], [2861, 1634, 150, 13.5], [2930, 1740, 30, 16.5], [2938, 1795, 18, 17],
    [2900, 1815, 18, 17], [2862, 1782, 30, 16.5], [2836, 1712, 150, 15], [2766, 1592, 150, 12], [2680, 1436, 150, 9], [2625, 1362, 18, 7.6],
  ];
  return { id: "tram", kind: "loop", minRadius: 15, maxGrade: 0.05, points: pts.map(([x, y, radius, z]) => ({ at: [x, y], radius, z })) };
}

/** Stage E: the classification sidings of Pirna yard, off the ladder; the depot's shed roads. */
export function stageE(w: World): Track[] {
  const Q = q(w);
  const out: Track[] = [];
  // Each siding leaves the ladder's diagonal and runs west beside the westbound fast track.
  const sidings: Array<[string, number, number, number]> = [["yard-1", 75, 6, 110], ["yard-2", 122, 11.5, 90], ["yard-3", 168, 16.4, 70], ["yard-4", 214, 21.6, 60]];
  for (const [id, s, lat, xEnd] of sidings) {
    const p = Q.point("yard-ladder", s);
    const sf = Q.s("f-west", p);
    out.push(branch(id, { from: { track: "yard-ladder", at: s, heading: "forward" },
      points: [{ at: Q.beside("f-west", sf + 90, lat), z: 8 }, { at: Q.beside("f-west", Q.atX("f-west", xEnd), lat), z: 8 }], minRadius: 150 }));
  }
  // Two more roads into the engine shed, either side of the lead.
  const L = Q.len("bw-lead");
  const s0 = Q.s("bw-lead", [418, 947]);
  for (const [id, lat] of [["bw-shed-n", 6.2]] as Array<[string, number]>) {
    out.push(branch(id, { from: { track: "bw-lead", at: s0 + (lat > 0 ? 0 : 14), heading: "forward" },
      points: [{ at: Q.beside("bw-lead", s0 + 66 + (lat > 0 ? 0 : 14), lat), z: 8 }, { at: Q.beside("bw-lead", L - 1, lat), z: 8 }], minRadius: 120 }));
  }
  return out;
}
