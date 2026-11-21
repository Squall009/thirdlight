/**
 * A structure grid streamed as the runtime streams one (VoxelGridHost): a town house in its own grid by the anchor
 * rule, written as a grid's region file on disk, read by range through a RegionChunkSource of that grid, the chunks
 * its file holds read from its table, and a world streamer of that grid id reading only round them (real workers):
 * it is one region file, every chunk it holds derives with the world's rules and kit pieces, and it is drawn at
 * level 0 near the focus. The same house in the world grid derives the same cells: the grid's results are equal.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_QUALITY_LEVELS, resolveVoxelWorld, type VoxelWorldComponent } from '@thirdlight/project-model';
import { applyWorldRings, buildPieceTable, canonicalEditCommand, chunkGrid, collisionRingBounds, createDenseChunk, DirtyTracker, GRID_EXTENT_MARGIN_CHUNKS, gridChunkExtent, grownChunkBox, packRegionChunk, regionFileName, RegionChunkSource, WorkerPool, WORLD_RULES, worldStreamer, writeRegion, type RegionEntry } from '@thirdlight/voxel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pickStore } from './regions';
import { bundleWorker, DiskRegions, nodePoolWorker, REPO, TEST_WORLD_ID, writeWorldRegions } from './stream-node';
import { fullTestKit } from './test-kits';
import { houseGrid, townHouses, townWorld } from './town';
import { chunkRange, MAT } from './world-kit';

const grid = chunkGrid(32);
let dir = '';
let workerFile = '';
const pools: WorkerPool[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tl-structure-grid-'));
  workerFile = await bundleWorker('stream-worker-node', join(REPO, 'dist', 'voxel-bench', `stream-worker-grid-${process.pid}.mjs`));
}, 120_000);
afterAll(() => {
  for (const p of pools) p.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(workerFile, { force: true });
});

describe('a structure grid streamed on its own', () => {
  it("reads round the chunks its one region file holds, derives them with kit pieces and draws them at level 0 near the focus", async () => {
    const h = townHouses()[0]!;
    const g = houseGrid(h.house, 'house');
    const folder = join(dir, 'grid-7');
    mkdirSync(folder, { recursive: true });
    const store = pickStore(grid);
    const cells = createDenseChunk(grid);
    const entries: RegionEntry[] = [];
    const [x0, x1] = chunkRange(grid, g.bounds.min[0], g.bounds.max[0]);
    const [y0, y1] = chunkRange(grid, g.bounds.min[1], g.bounds.max[1]);
    const [z0, z1] = chunkRange(grid, g.bounds.min[2], g.bounds.max[2]);
    for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) for (let cz = z0; cz <= z1; cz++) {
      if (!g.fill(grid, cx, cy, cz, cells)) continue;
      store.importChunk(cx, cy, cz, cells);
      entries.push(packRegionChunk(grid, cx, cy, cz, store.encodeChunk(cx, cy, cz)!, 'none', (b) => b));
    }
    // The anchor rule: the house is one region file.
    expect([x0, y0, z0]).toEqual([0, 0, 0]);
    const name = regionFileName('stacked', 0, 0, 0);
    writeFileSync(join(folder, name), writeRegion({ worldId: TEST_WORLD_ID, gridId: 7, layout: 'stacked', grid, footprint: 512, rx: 0, ry: 0, rz: 0, compressor: 'none' }, entries));
    const disk = new DiskRegions(folder);
    const source = new RegionChunkSource({ worldId: TEST_WORLD_ID, gridId: 7, grid, layout: 'stacked', footprint: 512, open: (n) => disk.open(n), maxOpen: 4 });
    const extent = await gridChunkExtent(source, 'stacked', [name]);
    const top = (k: 'cx' | 'cy' | 'cz'): number => Math.max(...entries.map((e) => e[k]));
    const max = [top('cx'), top('cy'), top('cz')] as const;
    expect(extent).toEqual({ min: [0, 0, 0], max });
    const pool = new WorkerPool({ size: 2, create: () => nodePoolWorker(workerFile), timeoutMs: 10_000, maxQueued: 256 });
    pools.push(pool);
    const pieces = buildPieceTable([fullTestKit('house', [MAT.stone, MAT.timber, MAT.plaster, MAT.brick, MAT.plank, MAT.roofTile], 1)], WORLD_RULES, 0).table;
    // At the high tier: its relief ring reaches the house too.
    const settings = resolveVoxelWorld({ world: 'w' } as VoxelWorldComponent, DEFAULT_QUALITY_LEVELS.find((l) => l.id === 'high')!);
    const s = worldStreamer({ grid, source, pool, gridId: 7, tracker: new DirtyTracker(), extent: grownChunkBox(extent!, GRID_EXTENT_MARGIN_CHUNKS), pieces }, settings);
    // 20 m in front of the house (grid cells), 2 m up.
    s.setFocus(-40, 4, -40);
    await s.settle();
    const m = s.metrics();
    const box = (n: number): number => (n + 2 * GRID_EXTENT_MARGIN_CHUNKS);
    expect(m.resident).toBe(box(max[0] + 1) * box(max[1] + 1) * box(max[2] + 1));
    let instances = 0;
    let drawn0 = 0;
    for (const { cx, cy, cz } of entries) {
      if (!s.chunkReady(cx, cy, cz)) continue;
      const j = s.joinedChunk(cx, cy, cz);
      instances += j?.instances?.count ?? 0;
      if (s.mips?.lod.drawn.drawn(0, cx, cy, cz) === true) drawn0++;
    }
    console.log(`[structure grid] house ${h.house.w}×${h.house.d}×${h.house.storeys}: chunks ${entries.length}, resident ${m.resident}, kit instances ${instances}, drawn at level 0 ${drawn0}, lod ${JSON.stringify(s.mips?.lod.counters)}`);
    expect(instances).toBeGreaterThan(0);
    expect(drawn0).toBe(entries.length);
  }, 60_000);
});

describe('a structure grid beside its world grid', () => {
  it('shares the world grid\'s pool and job ids and stays drawn at level 0 with its pieces across a tier change, a reset and the focus moving away and back', async () => {
    // A stone room with a porch slab, a door in the wall the porch faces (one chunk at cell 0).
    const folder = join(dir, 'grid-1');
    mkdirSync(folder, { recursive: true });
    const store = pickStore(grid);
    const v = (role: number) => ({ material: MAT.stone, role, shape: 15, wetness: 0 });
    for (let x = 0; x < 12; x++) for (let z = 0; z < 16; z++) {
      store.setVoxel(x, 0, z, v(4));
      if (z < 6) continue;
      const edge = x === 0 || x === 11 || z === 6 || z === 15;
      for (let y = 1; y <= 6; y++) if (edge && !(z === 6 && x >= 5 && x <= 7 && y <= 5)) store.setVoxel(x, y, z, v(3));
    }
    const entries = [packRegionChunk(grid, 0, 0, 0, store.encodeChunk(0, 0, 0)!, 'none', (b) => b)];
    writeFileSync(join(folder, 'r.0.0.0.vxr'), writeRegion({ worldId: TEST_WORLD_ID, gridId: 1, layout: 'stacked', grid, footprint: 512, rx: 0, ry: 0, rz: 0, compressor: 'none' }, entries));
    const disk = new DiskRegions(folder);
    const source = new RegionChunkSource({ worldId: TEST_WORLD_ID, gridId: 1, grid, layout: 'stacked', footprint: 512, open: (n) => disk.open(n), maxOpen: 4 });
    const extent = await gridChunkExtent(source, 'stacked', ['r.0.0.0.vxr']);
    const pool = new WorkerPool({ size: 2, create: () => nodePoolWorker(workerFile), timeoutMs: 10_000, maxQueued: 256 });
    pools.push(pool);
    const pieces = buildPieceTable([fullTestKit('stone', [MAT.stone], 1)], WORLD_RULES, 0).table;
    const settings = resolveVoxelWorld({ world: 'w' } as VoxelWorldComponent, DEFAULT_QUALITY_LEVELS.find((l) => l.id === 'high')!);
    const low = resolveVoxelWorld({ world: 'w' } as VoxelWorldComponent, DEFAULT_QUALITY_LEVELS.find((l) => l.id === 'low')!);
    const wdisk = new DiskRegions(join(dir, 'grid-0'));
    writeWorldRegions(townWorld({ footprint: 256 }).grids[0]!, grid, join(dir, 'grid-0'), 'stacked', 512, 0, 0, 256, 256);
    const w = worldStreamer({ grid, source: wdisk.source(grid, 'stacked', 512), pool, pieces }, low);
    const s = worldStreamer({ grid, source, pool, gridId: 1, tracker: w.tracker, extent: grownChunkBox(extent!, GRID_EXTENT_MARGIN_CHUNKS), pieces }, low);
    for (let i = 0; i < 100; i++) {
      w.setFocus(100, 10, 100);
      s.setFocus(-35.6, 10, 0.1);
      s.update();
      w.update();
      await new Promise((r) => setTimeout(r, 8));
    }
    applyWorldRings(s, settings);
    applyWorldRings(w, settings);
    s.collision!.bounds = collisionRingBounds({ radius: 135, height: 67 });
    for (let i = 0; i < 400; i++) {
      s.setFocus(-35.6, 10, 0.1);
      s.mips?.lod.setFoci([{ x: -60, y: 2, z: 20 }]);
      s.collision?.setFoci([{ x: -35.6, y: 10, z: 0.1 }, { x: -60, y: 2, z: 20 }]);
      s.update();
      w.setFocus(100 + (i % 50), 10, 100);
      w.update();
      await new Promise((r) => setTimeout(r, 8));
    }
    expect([s.chunkReady(0, 0, 0), s.mips?.lod.drawn.drawn(0, 0, 0, 0)]).toEqual([true, true]);
    s.clearOverlay();
    const spots = [[-35.6, 10, 0.1], [-80, 30, 60], [10, 8, 10], [-200, 10, -100], [-35.6, 10, 0.1]];
    for (let i = 0; i < 500; i++) {
      const p = spots[Math.min(spots.length - 1, Math.floor(i / 60))]!;
      s.setFocus(p[0]!, p[1]!, p[2]!);
      w.setFocus(p[0]! + 100, p[1]!, p[2]! + 100);
      w.update();
      s.update();
      await new Promise((r) => setTimeout(r, 8));
    }
    expect([s.chunkReady(0, 0, 0), s.mips?.lod.drawn.drawn(0, 0, 0, 0)]).toEqual([true, true]);
    expect(s.joinedChunk(0, 0, 0)?.instances.count ?? 0).toBeGreaterThan(0);
    // An edit in the grid's streamer (a cell of the front wall dug) is rebuilt and swaps like the world grid's.
    let swapped = 0;
    s.on((e) => {
      if (e.type === 'swap') swapped++;
    });
    s.edit(canonicalEditCommand({ v: 2, grid: 1, kind: 'dig', cells: [0, 1, 6] }));
    for (let i = 0; i < 200 && swapped === 0; i++) {
      s.update();
      await new Promise((r) => setTimeout(r, 8));
    }
    expect(swapped).toBeGreaterThan(0);
    expect(s.voxelAt(0, 1, 6, { material: 1, role: 1, shape: 1, wetness: 0 }).material).toBe(0);
    // The world grid streamed and derived beside it in the same pool.
    expect(w.metrics().resident).toBeGreaterThan(100);
  }, 60_000);
});
