// Track geometry: line and arc segments, the fillet construction that turns a
// waypoint polyline into tangent-continuous track (§5.2), junction departure
// arcs (§5.3), and arc-length lookup along a track.

import {
  type V2, add, sub, scale, dot, cross, dist, norm, perp, fromAngle, angleOf, mod,
} from "../util/vec";

export type LineSeg = { type: "line"; p0: V2; p1: V2; length: number };
export type ArcSeg = { type: "arc"; center: V2; radius: number; startAngle: number; sweep: number; length: number };
export type Segment = LineSeg | ArcSeg;

const MIN_TURN = (0.5 * Math.PI) / 180;   // corners gentler than this are merged into a straight
const MAX_TURN = (170 * Math.PI) / 180;   // corners sharper than this are rejected
const EPS = 1e-6;

export const lineSeg = (p0: V2, p1: V2): LineSeg => ({ type: "line", p0, p1, length: dist(p0, p1) });
export const arcSeg = (center: V2, radius: number, startAngle: number, sweep: number): ArcSeg =>
  ({ type: "arc", center, radius, startAngle, sweep, length: radius * Math.abs(sweep) });

/** Point at distance u along the segment. */
export function segPoint(seg: Segment, u: number): V2 {
  if (seg.type === "line") {
    const k = seg.length > 0 ? u / seg.length : 0;
    return [seg.p0[0] + (seg.p1[0] - seg.p0[0]) * k, seg.p0[1] + (seg.p1[1] - seg.p0[1]) * k];
  }
  const a = seg.startAngle + (Math.sign(seg.sweep) * u) / seg.radius;
  return [seg.center[0] + seg.radius * Math.cos(a), seg.center[1] + seg.radius * Math.sin(a)];
}

/** Direction of travel (radians, CCW from +x) at distance u along the segment. */
export function segHeading(seg: Segment, u: number): number {
  if (seg.type === "line") return angleOf(sub(seg.p1, seg.p0));
  // On a circle the tangent is the radius direction turned ±90° depending on sweep sign.
  const a = seg.startAngle + (Math.sign(seg.sweep) * u) / seg.radius;
  return a + Math.sign(seg.sweep) * (Math.PI / 2);
}

/** Signed curvature (1/m); positive turns left. */
export const curvature = (seg: Segment): number => (seg.type === "line" ? 0 : Math.sign(seg.sweep) / seg.radius);

export function reverseSeg(seg: Segment): Segment {
  if (seg.type === "line") return lineSeg(seg.p1, seg.p0);
  return arcSeg(seg.center, seg.radius, seg.startAngle + seg.sweep, -seg.sweep);
}

// ---------------------------------------------------------------------------
// Paths: a list of segments with a cumulative-length table.

export type Path = { segments: Segment[]; cum: number[]; length: number; closed: boolean };

export function makePath(segments: Segment[], closed: boolean): Path {
  const cum = [0];
  for (const seg of segments) cum.push(cum[cum.length - 1] + seg.length);
  return { segments, cum, length: cum[cum.length - 1], closed };
}

/** Index of the segment containing s, and the distance u into it (binary search). */
export function segmentAt(path: Path, s: number): { index: number; u: number } {
  const L = path.length;
  s = path.closed ? mod(s, L) : Math.min(Math.max(s, 0), L);
  let lo = 0;
  let hi = path.segments.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (path.cum[mid] <= s) lo = mid;
    else hi = mid - 1;
  }
  return { index: lo, u: s - path.cum[lo] };
}

export function pointAt(path: Path, s: number): V2 {
  const { index, u } = segmentAt(path, s);
  return segPoint(path.segments[index], u);
}

export function headingAt(path: Path, s: number): number {
  const { index, u } = segmentAt(path, s);
  return segHeading(path.segments[index], u);
}

/** Radius of the segment at s (Infinity on straights). */
export function radiusAt(path: Path, s: number): number {
  const seg = path.segments[segmentAt(path, s).index];
  return seg.type === "arc" ? seg.radius : Infinity;
}

/** Evenly spaced s values about `step` apart. Loops omit the duplicate end point. */
export function sampleS(path: Path, step: number): number[] {
  const n = Math.max(1, Math.ceil(path.length / step));
  const out: number[] = [];
  const last = path.closed ? n - 1 : n;
  for (let i = 0; i <= last; i++) out.push((i * path.length) / n);
  return out;
}

// ---------------------------------------------------------------------------
// Fillet construction (§5.2)
//
//          P(i)                     Each interior corner P(i) is replaced by an
//         /    \                    arc of radius r tangent to both legs. With
//      a /      \ b                 turn angle θ, the tangent points a and b lie
//       (  arc   )                  t = r·tan(θ/2) back along each leg.
//      /          \                 Neighbouring corners must not overlap on
//  P(i-1)        P(i+1)             the leg between them: t(i) + t(i+1) ≤ |leg|.

export type GeoIssue = {
  code: "FILLET_OVERLAP" | "CORNER_TOO_SHARP" | "JUNCTION_UNREACHABLE";
  message: string;
  point: number | "from" | "to";   // polyline index (mapped to a waypoint by the caller)
  at: V2;
};

type Fillet = { segments: Segment[]; cornerS: number[]; issues: GeoIssue[] };

/** Turns a polyline into lines and arcs. cornerS[i] is the s nearest polyline point i. */
export function filletPolyline(pts: V2[], radii: number[], closed: boolean): Fillet {
  const n = pts.length;
  const legs = closed ? n : n - 1;
  const issues: GeoIssue[] = [];
  const dirs: V2[] = [];
  for (let i = 0; i < legs; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    if (dist(a, b) < EPS) {
      issues.push({ code: "FILLET_OVERLAP", point: i, at: a, message: `waypoints ${i} and ${(i + 1) % n} coincide; remove one of them` });
    }
    dirs.push(norm(sub(b, a)));
  }
  if (issues.length) return { segments: [], cornerS: [], issues };

  // Tangent length t and arc for every corner (endpoints of a line have t = 0).
  const t = new Array<number>(n).fill(0);
  const arcs = new Array<ArcSeg | null>(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (!closed && (i === 0 || i === n - 1)) continue;
    const d1 = dirs[(i - 1 + legs) % legs];
    const d2 = dirs[i];
    const theta = Math.atan2(cross(d1, d2), dot(d1, d2));
    if (Math.abs(theta) < MIN_TURN) continue;
    if (Math.abs(theta) > MAX_TURN) {
      const deg = Math.round((Math.abs(theta) * 180) / Math.PI);
      issues.push({ code: "CORNER_TOO_SHARP", point: i, at: pts[i], message: `corner at waypoint ${i} turns ${deg}°, more than 170°; add an intermediate waypoint to split the turn` });
      continue;
    }
    const r = radii[i];
    t[i] = r * Math.tan(Math.abs(theta) / 2);
    const a = sub(pts[i], scale(d1, t[i]));
    const center = add(a, scale(perp(d1), r * Math.sign(theta)));
    arcs[i] = arcSeg(center, r, angleOf(sub(a, center)), theta);
  }

  for (let i = 0; i < legs; i++) {
    const j = (i + 1) % n;
    const legLen = dist(pts[i], pts[j]);
    const shortfall = t[i] + t[j] - legLen;
    if (shortfall > EPS) {
      issues.push({
        code: "FILLET_OVERLAP", point: i, at: pts[i],
        message: `curves at waypoints ${i} and ${j} overlap by ${shortfall.toFixed(1)} m (leg is ${legLen.toFixed(1)} m, curves need ${(t[i] + t[j]).toFixed(1)} m); move the waypoints apart or use a smaller radius`,
      });
    }
  }
  if (issues.length) return { segments: [], cornerS: [], issues };

  // Assemble: straight from the end of corner i to the start of corner i+1, then that arc.
  // For loops s = 0 is just after the fillet at waypoint 0.
  const segments: Segment[] = [];
  const cornerS = new Array<number>(n).fill(0);
  let s = 0;
  for (let i = 0; i < legs; i++) {
    const j = (i + 1) % n;
    const start = add(pts[i], scale(dirs[i], t[i]));
    const end = sub(pts[j], scale(dirs[i], t[j]));
    if (dist(start, end) > 1e-9) {
      segments.push(lineSeg(start, end));
      s += segments[segments.length - 1].length;
    }
    const arc = arcs[j];
    if (arc && (closed || j < n - 1)) {
      cornerS[j] = s + arc.length / 2;
      segments.push(arc);
      s += arc.length;
    } else {
      cornerS[j] = s;
    }
  }
  if (closed) cornerS[0] = arcs[0] ? s - arcs[0].length / 2 : 0;
  return { segments, cornerS, issues };
}

// ---------------------------------------------------------------------------
// Junction departure (§5.3)
//
//   J ──h──►.                The branch starts at J tangent to the parent
//            `.  arc         heading h and bends (radius r) toward the first
//              `.            waypoint W. It stops at T, where its tangent line
//                T─────► W   passes through W: the classic tangent from an
//                            external point to a circle, |CT| ⟂ |TW|.

export function junctionArc(J: V2, h: number, W: V2, r: number): { arc: ArcSeg | null; end: V2; error?: string } {
  const d = fromAngle(h);
  const rel = sub(W, J);
  const side = cross(d, rel);
  if (Math.abs(side) < 1e-9) {
    return dot(d, rel) > 0 ? { arc: null, end: J } : { arc: null, end: J, error: "the first waypoint lies directly behind the junction; flip `heading`" };
  }
  const sgn = Math.sign(side);
  const center = add(J, scale(perp(d), r * sgn));
  const D = dist(W, center);
  if (D < r + EPS) {
    return { arc: null, end: J, error: `the first waypoint is ${D.toFixed(1)} m from the turning-circle centre, inside its ${r} m radius; move it further from the junction` };
  }
  const alpha = Math.acos(r / D);
  const base = angleOf(sub(W, center));
  let tAngle = base + alpha;
  for (const cand of [base + alpha, base - alpha]) {
    const T = add(center, scale(fromAngle(cand), r));
    if (dot(fromAngle(cand + sgn * (Math.PI / 2)), sub(W, T)) > 0) tAngle = cand;
  }
  const start = angleOf(sub(J, center));
  const sweep = sgn > 0 ? mod(tAngle - start, 2 * Math.PI) : -mod(start - tAngle, 2 * Math.PI);
  if (Math.abs(sweep) > Math.PI) {
    return { arc: null, end: J, error: "the first waypoint is behind the junction (the branch would turn more than 180°); flip `heading` or move the waypoint" };
  }
  const arc = arcSeg(center, r, start, sweep);
  return { arc, end: segPoint(arc, arc.length) };
}
