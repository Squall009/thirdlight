/**
 * The voxel faces' table kept across changes: after random runs of chunks
 * coming, going, being drawn again and moving on the cache's pages, every
 * face reads what a table made at once from the resident chunks reads; a
 * change writes slots only for the faces of the chunks it changed (and the
 * few a deletion shifts), counted, never timed; the lookup and the resolve
 * table packed through it equal their whole packs.
 */
import { mulberry32 } from '@thirdlight/shared';
import { describe, expect, it } from 'vitest';

import { SURFACE_CHART_BORDER, SURFACE_PAGE_TEXELS, areaTexels } from './surface-cache-atlas';
import { voxelChunkCharts, voxelChunkTile, type VoxelTile, type VoxelTileMesh } from './surface-cache-voxels';
import { VoxelFaceTable, voxelAreaTexels, voxelFaceEntries, writeSlotRuns, type VoxelFaceResident } from './surface-voxel-faces';

const EDGE = 32;

/** A chunk's surface (metres from its corner): rolling ground that runs to the chunk's faces and past them by a cell, and a wall. */
function chunkMesh(seed: number): VoxelTileMesh {
  const r = mulberry32(seed);
  const pos: number[] = [];
  const idx: number[] = [];
  const n = 34;
  const a = r() * 2;
  const b = r() * 2;
  const h = (x: number, z: number): number => 3 + 0.6 * Math.sin(x * 0.3 + a) + 0.5 * Math.cos(z * 0.25 + b);
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) pos.push(i * 0.5 - 0.5, h(i * 0.5, j * 0.5), j * 0.5 - 0.5);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const q = j * (n + 1) + i;
    idx.push(q, q + n + 1, q + 1, q + 1, q + n + 1, q + n + 2);
  }
  const w = pos.length / 3;
  const x = 2 + Math.floor(r() * 12);
  pos.push(x, 4, 1, x, 7, 1, x, 4, 9, x, 7, 9);
  idx.push(w, w + 1, w + 2, w + 2, w + 1, w + 3);
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) };
}

/** Chunks of a 4 × 4 field, each with a few versions of its mesh (an edit draws it again). */
function field(): { key: string; versions: VoxelTile[] }[] {
  const out: { key: string; versions: VoxelTile[] }[] = [];
  for (let cz = 0; cz < 4; cz++) for (let cx = 0; cx < 4; cx++) {
    const key = `w/${cx},${cz}`;
    const cell0: [number, number, number] = [cx * EDGE, 0, cz * EDGE];
    const versions = [0, 1].map((v) => {
      const m = chunkMesh(cx * 31 + cz * 7 + v * 1000 + 1);
      const t = voxelChunkTile(key, v + 1, cell0, EDGE, () => m);
      t.made = voxelChunkCharts(m.positions, m.indices, cell0, EDGE);
      return t;
    });
    out.push({ key, versions });
  }
  return out;
}

/** What the cache holds of a tile: a level and its charts' places on pages. */
function residentOf(tile: VoxelTile, level: number, page: number): VoxelFaceResident {
  const charts = tile.made!.charts;
  return {
    level,
    blocks: [{ page, x: 0, y: 0, side: 256 }],
    packing: { level, blocks: [0], bytes: 0, places: charts.map((_, c) => ({ block: 0, x: (c * 7) % 200, y: (c * 13) % 200, w: 4, h: 4 })) },
    charts,
  };
}

function snapshot(t: VoxelFaceTable): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k0, k1, w2, w3] of t.faces()) out.set(`${k0},${k1}`, `${w2},${w3}`);
  return out;
}

describe('the voxel faces table', () => {
  const chunks = field();
  for (const behind of [false, true]) {
    it(`kept across random changes reads as one made at once (${behind ? 'with' : 'without'} the cells behind surfaces)`, () => {
      const r = mulberry32(behind ? 11 : 12);
      const kept = new VoxelFaceTable(behind, behind ? 0.75 : 0.5);
      // Each chunk's state: absent, or a version at a level and page.
      const state = new Map<string, { v: number; level: number; page: number }>();
      let rebuilds = 0;
      let touchedAll = 0;
      let facesAll = 0;
      let margins = 0;
      for (let step = 0; step < 90; step++) {
        const changes = 1 + Math.floor(r() * 3);
        for (let k = 0; k < changes; k++) {
          const c = chunks[Math.floor(r() * chunks.length)]!;
          const s = state.get(c.key);
          const roll = r();
          if (s === undefined) state.set(c.key, { v: Math.floor(r() * 2), level: Math.floor(r() * 4), page: Math.floor(r() * 8) });
          else if (roll < 0.3) state.delete(c.key);
          else if (roll < 0.6) state.set(c.key, { ...s, v: 1 - s.v });
          else state.set(c.key, { ...s, level: (s.level + 1) % 4, page: Math.floor(r() * 8) });
        }
        // The listing's order changes too: the table must not depend on it.
        const order = [...chunks].sort(() => r() - 0.5);
        const tiles = order.flatMap((c) => (state.has(c.key) ? [c.versions[state.get(c.key)!.v]!] : []));
        const res = (key: string): VoxelFaceResident | undefined => {
          const s = state.get(key);
          if (s === undefined) return undefined;
          return residentOf(chunks.find((c) => c.key === key)!.versions[s.v]!, s.level, s.page);
        };
        const sync = kept.sync(tiles, res);
        if (sync.rebuilt) rebuilds += 1;
        else {
          // Slots written are the changed chunks' faces, the entries a deletion shifts back and those promoted in its place.
          expect(sync.touched).toBeLessThanOrEqual(4 * sync.faces + 8);
          touchedAll += sync.touched;
          facesAll += sync.faces;
        }
        // Compared with a table made at once every few steps (each comparison reads every face).
        if (step % 6 !== 5) continue;
        const fresh = new VoxelFaceTable(behind, behind ? 0.75 : 0.5);
        fresh.sync([...tiles].reverse(), res);
        const a = snapshot(kept);
        const b = snapshot(fresh);
        expect(a.size).toBe(b.size);
        for (const [k, v] of b) expect(a.get(k), k).toBe(v);
        expect(kept.probe).toBeGreaterThanOrEqual(0);
        if (step === 89) {
          // Neighbours key faces past their own boxes: some faces were keyed twice, and the table held one each.
          let entries = 0;
          for (const t of tiles) entries += voxelFaceEntries(t.made!, behind).own.length;
          margins = entries - kept.count;
        }
      }
      expect(facesAll).toBeGreaterThan(0);
      expect(touchedAll).toBeLessThanOrEqual(2 * facesAll);
      // Made again only as it grew or shrank by half and more, not on every change.
      expect(rebuilds).toBeLessThan(20);
      expect(margins).toBeGreaterThan(0);
    });
  }

  it('a chunk that comes writes its own faces only; one that goes takes its faces out and hands shared faces to its neighbour', () => {
    const t = new VoxelFaceTable(true, 0.75);
    const a = chunks[0]!.versions[0]!;
    const b = chunks[1]!.versions[0]!;
    const big = chunks.slice(2, 10).map((c) => c.versions[0]!);
    const res = (key: string): VoxelFaceResident | undefined => {
      const tile = [a, b, ...big].find((x) => x.key === key);
      return tile === undefined ? undefined : residentOf(tile, 0, 1);
    };
    t.sync([a, ...big], res);
    t.takeDirty();
    const nb = voxelFaceEntries(b.made!, true).own.length;
    const s1 = t.sync([a, b, ...big], res);
    expect(s1.rebuilt).toBe(false);
    expect(s1.faces).toBe(nb);
    expect(s1.touched).toBeLessThanOrEqual(nb);
    expect(t.takeDirty().slots.length).toBeLessThanOrEqual(nb);
    const s2 = t.sync([b, ...big], res);
    expect(s2.rebuilt).toBe(false);
    const fresh = new VoxelFaceTable(true, 0.75);
    fresh.sync([b, ...big], res);
    const x = snapshot(t);
    for (const [k, v] of snapshot(fresh)) expect(x.get(k)).toBe(v);
    expect(x.size).toBe(snapshot(fresh).size);
  });

  it('a voxel chart\'s texels across its columns in whole numbers equal the cache\'s', () => {
    for (let level = 0; level < 8; level++) for (let w = 1; w <= 255; w++) expect(voxelAreaTexels(w, level)).toBe(areaTexels(w * 0.5, level));
    expect(voxelAreaTexels(255, 0)).toBe(SURFACE_PAGE_TEXELS - 2 * SURFACE_CHART_BORDER);
  });

  it('dirty slots go up as runs', () => {
    const words = new Uint32Array(4 * 1000);
    const runs: [number, number][] = [];
    const bytes = writeSlotRuns([1, 2, 3, 40, 500, 501], words, 4, (from, to) => runs.push([from, to]));
    expect(runs).toEqual([[4, 164], [2000, 2008]]);
    expect(bytes).toBe((160 + 8) * 4);
  });
});
