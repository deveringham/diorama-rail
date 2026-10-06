// Block division (§7.2). Every graph edge is cut into blocks of at most 200 m.
// The 30 m either side of each switch node (on all three legs) forms one
// "fouling" block, so only one train at a time can be inside a junction; so does
// the stretch of both tracks where they cross at a diamond.

import type { World } from "../model/build";

export const MAX_BLOCK = 200;
export const FOULING = 30;
const DIAMOND_CLEAR = 3.2;     // m across two trains' bodies: where one fouls the other at a diamond, ÷ sin(angle)
const DIAMOND_MARGIN = 6;      // m beyond that on either side

export type BlockPiece = { edge: number; track: string; s0: number; s1: number };
export type Block = { id: number; pieces: BlockPiece[]; switches: number[] };
export type Blocks = {
  blocks: Block[];
  byTrack: Map<string, Array<{ s0: number; s1: number; block: number }>>;   // sorted by s0
};

export function buildBlocks(world: World): Blocks {
  const { graph } = world;
  const switchAtNode = new Map(graph.switches.map((sw, i) => [sw.node, i]));

  // Union-find over switches whose fouling zones touch (short edges between them).
  const parent = graph.switches.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a: number, b: number) => { parent[find(a)] = find(b); };

  // Diamonds join the union-find after the switches.
  const S = graph.switches.length;
  world.diamonds.forEach((_, k) => parent.push(S + k));
  type Cut = { edge: number; s0: number; s1: number; sw: number | null };
  const cuts: Cut[] = [];
  for (const e of graph.edges) {
    const a = switchAtNode.get(e.start);
    const b = switchAtNode.get(e.end);
    const len = e.s1 - e.s0;
    const head = a !== undefined ? FOULING : 0;
    const tail = b !== undefined ? FOULING : 0;
    if (len <= head + tail) {
      // The whole edge is inside fouling zones; it joins them into one block.
      if (a !== undefined && b !== undefined) union(a, b);
      cuts.push({ edge: e.id, s0: e.s0, s1: e.s1, sw: (a ?? b)! });
      continue;
    }
    if (a !== undefined) cuts.push({ edge: e.id, s0: e.s0, s1: e.s0 + head, sw: a });
    const m0 = e.s0 + head;
    const m1 = e.s1 - tail;
    const n = Math.ceil((m1 - m0) / MAX_BLOCK);
    for (let k = 0; k < n; k++) cuts.push({ edge: e.id, s0: m0 + ((m1 - m0) * k) / n, s1: m0 + ((m1 - m0) * (k + 1)) / n, sw: null });
    if (b !== undefined) cuts.push({ edge: e.id, s0: e.s1 - tail, s1: e.s1, sw: b });
  }

  // Each diamond's zone on both its tracks: cut out of whatever covers it, and fouled together.
  world.diamonds.forEach((d, k) => {
    const zone = DIAMOND_CLEAR / Math.sin((Math.max(d.angle, 5) * Math.PI) / 180) + DIAMOND_MARGIN;
    for (const [track, s] of [[d.a, d.sa], [d.b, d.sb]] as const) {
      const lo = s - zone;
      const hi = s + zone;
      for (let i = cuts.length - 1; i >= 0; i--) {
        const c = cuts[i];
        if (graph.edges[c.edge].track !== track || c.s1 <= lo || c.s0 >= hi) continue;
        const parts: Cut[] = [];
        if (c.s0 < lo) parts.push({ ...c, s1: lo });
        parts.push({ edge: c.edge, s0: Math.max(c.s0, lo), s1: Math.min(c.s1, hi), sw: S + k });
        if (c.sw !== null) union(c.sw, S + k);
        if (c.s1 > hi) parts.push({ ...c, s0: hi });
        cuts.splice(i, 1, ...parts);
      }
    }
  });

  const blocks: Block[] = [];
  const foulingBlock = new Map<number, number>();
  for (const c of cuts) {
    let id: number;
    if (c.sw === null) {
      id = blocks.push({ id: blocks.length, pieces: [], switches: [] }) - 1;
    } else {
      const root = find(c.sw);
      if (!foulingBlock.has(root)) foulingBlock.set(root, blocks.push({ id: blocks.length, pieces: [], switches: [] }) - 1);
      id = foulingBlock.get(root)!;
      if (c.sw < S && !blocks[id].switches.includes(c.sw)) blocks[id].switches.push(c.sw);
    }
    blocks[id].pieces.push({ edge: c.edge, track: graph.edges[c.edge].track, s0: c.s0, s1: c.s1 });
  }

  const byTrack: Blocks["byTrack"] = new Map();
  for (const b of blocks) {
    for (const p of b.pieces) {
      if (!byTrack.has(p.track)) byTrack.set(p.track, []);
      byTrack.get(p.track)!.push({ s0: p.s0, s1: p.s1, block: b.id });
    }
  }
  for (const list of byTrack.values()) list.sort((a, b) => a.s0 - b.s0);
  return { blocks, byTrack };
}
