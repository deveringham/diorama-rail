// Geometry invariants (§13 milestone 2): tangent continuity at every segment join,
// arc length matching dense sampling, and the fillet / junction constructions.

import { describe, it, expect } from "vitest";
import { buildWorld } from "../src/model/build";
import { filletPolyline, junctionArc, makePath, pointAt, headingAt, segHeading, segPoint, sampleS } from "../src/model/geometry";
import { wrapAngle, dist } from "../src/util/vec";
import { example } from "./fixtures";

const turn = (a: number, b: number) => Math.abs(wrapAngle(a - b));

describe.each(["valley-loop", "harbour-town"])("%s geometry", (name) => {
  const { world } = buildWorld(example(name));
  it("builds", () => expect(world).not.toBeNull());

  it("is tangent-continuous at every segment join (within 1e-6 rad)", () => {
    for (const t of world!.tracks.values()) {
      const segs = t.path.segments;
      const joins = t.path.closed ? segs.length : segs.length - 1;
      for (let i = 0; i < joins; i++) {
        const a = segs[i];
        const b = segs[(i + 1) % segs.length];
        expect(turn(segHeading(a, a.length), segHeading(b, 0)), `${t.id} join ${i}`).toBeLessThan(1e-6);
        expect(dist(segPoint(a, a.length), segPoint(b, 0)), `${t.id} gap ${i}`).toBeLessThan(1e-6);
      }
    }
  });

  it("joins branches tangentially to their parents", () => {
    for (const j of world!.junctions) {
      const parent = world!.tracks.get(j.parentTrack)!.path;
      const branch = world!.tracks.get(j.branchTrack)!.path;
      const sB = j.branchEnd === "start" ? 0 : branch.length;
      const flip = j.heading === "backward" ? Math.PI : 0;
      expect(turn(headingAt(branch, sB), headingAt(parent, j.parentS) + flip)).toBeLessThan(1e-6);
      expect(dist(pointAt(branch, sB), pointAt(parent, j.parentS))).toBeLessThan(1e-6);
    }
  });

  it("has arc length equal to the sampled length (within 0.1 m)", () => {
    for (const t of world!.tracks.values()) {
      const ss = sampleS(t.path, 0.25);
      if (t.path.closed) ss.push(t.path.length);
      let sum = 0;
      for (let i = 1; i < ss.length; i++) sum += dist(pointAt(t.path, ss[i - 1]), pointAt(t.path, ss[i]));
      expect(Math.abs(sum - t.path.length), t.id).toBeLessThan(0.1);
    }
  });
});

describe("fillets", () => {
  it("rounds a square loop and starts s = 0 just after waypoint 0", () => {
    const pts: Array<[number, number]> = [[0, 0], [100, 0], [100, 100], [0, 100]];
    const f = filletPolyline(pts, [20, 20, 20, 20], true);
    expect(f.issues).toEqual([]);
    const path = makePath(f.segments, true);
    // Four straights of 100 − 2·20 and four quarter circles of radius 20.
    expect(path.length).toBeCloseTo(4 * 60 + 2 * Math.PI * 20, 6);
    const [x, y] = pointAt(path, 0);
    expect(x).toBeCloseTo(20, 9);
    expect(y).toBeCloseTo(0, 9);
    expect(headingAt(path, 0)).toBeCloseTo(0, 9);
  });

  it("merges nearly straight corners and reports overlaps with their shortfall", () => {
    const straight = filletPolyline([[0, 0], [100, 0.1], [200, 0]], [50, 50, 50], false);
    expect(straight.segments.every((s) => s.type === "line")).toBe(true);
    const tight = filletPolyline([[0, 0], [100, 0], [110, 100], [0, 100]], [60, 60, 60, 60], true);
    const overlap = tight.issues.find((i) => i.code === "FILLET_OVERLAP");
    expect(overlap?.message).toMatch(/overlap by \d+\.\d m/);
  });

  it("finds the tangent from the junction circle to the first waypoint", () => {
    const res = junctionArc([0, 0], 0, [100, 50], 40);
    expect(res.error).toBeUndefined();
    const arc = res.arc!;
    // The arc ends where its tangent points straight at the waypoint.
    const h = segHeading(arc, arc.length);
    const toW = Math.atan2(50 - res.end[1], 100 - res.end[0]);
    expect(turn(h, toW)).toBeLessThan(1e-9);
    expect(junctionArc([0, 0], 0, [10, 30], 40).error).toMatch(/inside/);
  });
});
