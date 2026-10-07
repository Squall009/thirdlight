import { describe, expect, it } from 'vitest';

import { PageNodes, selectTerrainNodes, terrainLodLayout, terrainLodRanges, terrainMinLodDistance, TERRAIN_NODE_FLOATS, tileHeightBounds, type SelectStats, type SelectTile } from './terrain-quadtree';

/** A rolling heightfield in steps (one step = 1 cm), sample (gx, gz) of the whole terrain. */
const stepAt = (gx: number, gz: number): number => Math.round(3000 + 1500 * Math.sin(gx / 37) * Math.cos(gz / 23) + 400 * Math.sin((gx + gz) / 7));
const metres = (step: number): number => step * 0.01;

function terrain(tilesPerSide: number, samples: number) {
  const layout = terrainLodLayout(samples, 1);
  const n = samples - 1;
  const tiles: SelectTile[] = [];
  const heights = new Map<string, Uint16Array>();
  for (let tz = 0; tz < tilesPerSide; tz++) {
    for (let tx = 0; tx < tilesPerSide; tx++) {
      const h = new Uint16Array(samples * samples);
      for (let z = 0; z < samples; z++) for (let x = 0; x < samples; x++) h[z * samples + x] = stepAt(tx * n + x, tz * n + z);
      heights.set(`${tx},${tz}`, h);
      tiles.push({ x: tx, z: tz, page: 0, layer: tz * tilesPerSide + tx, bounds: tileHeightBounds(h, layout) });
    }
  }
  return { layout, tiles, heights };
}

interface Node {
  x0: number;
  z0: number;
  size: number;
  samples: number;
  ms: number;
  mi: number;
}

function nodesOf(p: PageNodes): Node[] {
  const out: Node[] = [];
  for (let i = 0; i < p.count; i++) {
    const d = p.data.subarray(i * TERRAIN_NODE_FLOATS);
    out.push({ x0: d[0]!, z0: d[1]!, size: d[2]!, samples: d[2]!, ms: d[6]!, mi: d[7]! });
  }
  return out;
}

/** The shader's morph factor of a grid vertex at world (x, z): by its distance to the eye, its height a sample's. */
const morphK = (n: Node, x: number, z: number, eye: readonly number[]): number => {
  const d = Math.hypot(x - eye[0]!, metres(stepAt(Math.round(x), Math.round(z))) - eye[1]!, z - eye[2]!);
  return Math.min(1, Math.max(0, (d - n.ms) * n.mi));
};

describe('terrain CDLOD selection', () => {
  it('covers every tile exactly once, in view first', () => {
    const { layout, tiles } = terrain(4, 129);
    const page = new PageNodes();
    const stats: SelectStats = { nodes: 0, inView: 0, perLevel: [] };
    const eye = [100, 40, 130] as const;
    // In view: x < 256.
    selectTerrainNodes(tiles, { layout, ranges: terrainLodRanges(layout, undefined, 1), eye, heightOf: metres, inView: (x) => x < 256 }, [page], stats);
    const nodes = nodesOf(page);
    expect(nodes.length).toBe(stats.nodes);
    const area = nodes.reduce((s, n) => s + n.size * n.size, 0);
    expect(area).toBe(4 * 4 * 128 * 128);
    // The ones in view lead.
    for (let i = 0; i < nodes.length; i++) expect(nodes[i]!.x0 + nodes[i]!.size / 2 < 256 || i >= page.inView, `node ${i}`).toBe(true);
    // Finer near the eye, coarser far away; the farthest tiles are drawn as their root.
    expect(stats.perLevel[0]).toBeGreaterThan(0);
    expect(stats.perLevel[layout.levels - 1]).toBeGreaterThan(0);
  });

  it('meets without cracks: neighbours differ by at most one level, the finer fully morphed and the coarser not at all along their edge', () => {
    const { layout, tiles } = terrain(6, 129);
    const page = new PageNodes();
    const stats: SelectStats = { nodes: 0, inView: 0, perLevel: [] };
    for (const eye of [
      [50, 35, 60],
      [300, 80, 400],
      [700, 20, 10],
      [384, 300, 384],
    ] as const) {
      const ranges = terrainLodRanges(layout, undefined, 1);
      selectTerrainNodes(tiles, { layout, ranges, eye, heightOf: metres, inView: null }, [page], stats);
      const nodes = nodesOf(page);
      const level = (n: Node): number => Math.log2(n.samples / layout.grid);
      let checked = 0;
      for (const a of nodes) {
        for (const b of nodes) {
          if (a === b || level(a) >= level(b)) continue;
          // a is finer than b: do they share an edge segment?
          const touchX = a.x0 + a.size === b.x0 || b.x0 + b.size === a.x0;
          const touchZ = a.z0 + a.size === b.z0 || b.z0 + b.size === a.z0;
          const overlapZ = a.z0 < b.z0 + b.size && b.z0 < a.z0 + a.size;
          const overlapX = a.x0 < b.x0 + b.size && b.x0 < a.x0 + a.size;
          if (!((touchX && overlapZ) || (touchZ && overlapX))) continue;
          expect(level(b) - level(a), `levels ${level(a)} and ${level(b)} meet`).toBe(1);
          // The shared edge's vertices.
          const edge: [number, number][] = [];
          const fineStep = a.size / layout.grid;
          if (touchX) {
            const x = a.x0 + a.size === b.x0 ? b.x0 : a.x0;
            for (let z = Math.max(a.z0, b.z0); z <= Math.min(a.z0 + a.size, b.z0 + b.size); z += fineStep) edge.push([x, z]);
          } else {
            const z = a.z0 + a.size === b.z0 ? b.z0 : a.z0;
            for (let x = Math.max(a.x0, b.x0); x <= Math.min(a.x0 + a.size, b.x0 + b.size); x += fineStep) edge.push([x, z]);
          }
          const coarseStep = b.size / layout.grid;
          for (const [x, z] of edge) {
            const onCoarse = Math.abs((x - b.x0) / coarseStep - Math.round((x - b.x0) / coarseStep)) < 1e-9 && Math.abs((z - b.z0) / coarseStep - Math.round((z - b.z0) / coarseStep)) < 1e-9;
            if (!onCoarse) expect(morphK(a, x, z, eye), `fine odd vertex at ${x},${z}`).toBe(1);
            else expect(morphK(b, x, z, eye), `coarse vertex at ${x},${z}`).toBe(0);
            checked += 1;
          }
        }
      }
      expect(checked).toBeGreaterThan(0);
    }
  });

  it('keeps the finest reach at or above the least the tile allows; the LOD bias divides it', () => {
    const layout = terrainLodLayout(257, 2);
    const least = terrainMinLodDistance(layout);
    expect(terrainLodRanges(layout, undefined, 1)[0]).toBe(least);
    expect(terrainLodRanges(layout, 10, 1)[0]).toBe(least);
    expect(terrainLodRanges(layout, least * 4, 2)[0]).toBe(least * 2);
    expect(Array.from(terrainLodRanges(layout, least * 4, 1))).toEqual([1, 2, 4, 8, 16].map((k) => least * 4 * k));
  });

  it('bounds each node by the heights it covers', () => {
    const layout = terrainLodLayout(33, 1);
    const h = new Uint16Array(33 * 33).fill(100);
    h[5 * 33 + 20] = 900;
    h[16 * 33 + 16] = 7; // a corner shared by the four leaves
    const b = tileHeightBounds(h, layout);
    expect(Array.from(b.max[0]!)).toEqual([100, 900, 100, 100]);
    expect(Array.from(b.min[0]!)).toEqual([7, 7, 7, 7]);
    expect(Array.from(b.max[1]!)).toEqual([900]);
    expect(Array.from(b.min[1]!)).toEqual([7]);
  });
});
