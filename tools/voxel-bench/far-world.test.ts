/**
 * The far world and its far cache at real boundaries: the realistic
 * landscape (deterministic, heights in range, region columns written apart
 * meeting cell for cell, its features in the cells on disk) and the terraced
 * style kept beside it; region files written
 * column by column in `worker_threads` workers and read back from disk, the
 * far cache built from them in workers and in one thread (byte for byte the
 * same), far data over every part of the world, an edit through the
 * workspace's voxel world commands rebuilding exactly its ancestors (the
 * result byte for byte a full build), the town's doors and windows
 * closed at levels 1 and 2 (no "legs" under far front walls), and the far
 * field fed visibility feedback: what the eye sees too coarse refined first,
 * what it left kept for the turn window, then coarser.
 */
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildFarNode, farCellPixels, farNodeDistance, FAR_VIEW_PIXELS_PER_RADIAN, decodeFarBricks, encodeFarBricks, FAR_BAKED_LEVELS, FAR_BRICK_BUILD, farBrickDirty, createDenseChunk, farBricksGpuBytes, DISTANCE_BRICK_SAMPLES, DISTANCE_BRICK_SIDE, farAncestors, FarField, FAR_ENTRY_CACHE_BYTES, farVertexLook, farBrickMarchedBox, marchBrickBox, FAR_POSITION_ORIGIN_CELLS, FAR_VERTEX_BYTES, FarSelection, localIndex, mipNodeKey, POSITION_STEPS_PER_CELL, regionFarSource, STREAM_POOL_SETTINGS, valueRole, VOXEL_ROLE, WORLD_RULES, WorkerPool, type FarCells, type FarEvent, type FarNodeDraw, type MipNode } from '@thirdlight/voxel';
import { buildFarCache, farCacheDir, farCacheFiles, FarCacheReader, farCacheStale, FAR_REBUILT_FOLDER, FarWorldSource, openShippedWorld, readFarCacheManifest, readVoxelWorldManifest, rebuildFarCache, VoxelWorlds } from '@thirdlight/workspace';
import { hexToBytes } from '@thirdlight/shared';
import { computeFarDrainage, PEAK } from './far-drainage';
import { farLandscape, farSurfaceHeight, farWorldColumns, farWorldDirs, finishFarWorld, writeFarWorldColumn, FAR_WORLD_GRID } from './far-world';
import { LANDSCAPE_BASE } from './far-landscape';
import { buildFarCacheInPool, FarPool, PIXELS_PER_RADIAN_720P, writeFarWorld } from './far-world-run';
import { bundleWorker, DiskRegions, nodePoolWorker, REPO } from './stream-node';
import { MAT } from './world-kit';

const root = join(tmpdir(), `tl-far-world-${process.pid}-${Date.now().toString(36)}`);
const projectDir = join(root, 'p');
/** 512 m: four region columns, the town at the centre and rolling ground round it (the mountains need kilometres). */
const SIZE_KM = 0.5;
let pool: FarPool;
let worldDir: string;

/** Every file under a folder, relative path → base64 (a far cache's rebuilt store left out: a memory of edits, not the cache). */
function filesOf(dir: string, sub = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of readdirSync(join(dir, sub), { withFileTypes: true })) {
    const rel = sub === '' ? e.name : `${sub}/${e.name}`;
    if (rel === FAR_REBUILT_FOLDER) continue;
    if (e.isDirectory()) Object.assign(out, filesOf(dir, rel));
    else out[rel] = readFileSync(join(dir, rel)).toString('base64');
  }
  return out;
}

/** A far cache's baked entries by node key (base64 of the stored bytes). */
function bakedOf(cacheDir: string): Map<string, string> {
  const r = new FarCacheReader(cacheDir);
  const out = new Map<string, string>();
  for (let l = r.manifest.minLevel; l <= r.manifest.maxLevel; l++) for (const n of r.index().nodes(l)) {
    const e = r.bricksEntry(n);
    if (e !== null && 'stored' in e) out.set(mipNodeKey(n), Buffer.from(e.stored).toString('base64'));
  }
  return out;
}

beforeAll(async () => {
  mkdirSync(root, { recursive: true });
  const file = await bundleWorker('far-worker-node', join(REPO, 'dist', 'voxel-bench', `far-worker-test-${process.pid}.mjs`));
  pool = new FarPool(file, 2);
  const w = await writeFarWorld(pool, projectDir, { sizeKm: SIZE_KM, reserveBytes: 0 });
  expect(w.stopped).toBeNull();
  worldDir = w.dir;
}, 120_000);

afterAll(async () => {
  await pool?.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(join(REPO, 'dist', 'voxel-bench', `far-worker-test-${process.pid}.mjs`), { force: true });
});

describe('the far world on disk', () => {
  it('is written by the workers exactly as one thread writes it, and reads back as a world', () => {
    const { gridDir } = farWorldDirs(projectDir);
    const here = join(root, 'one-thread');
    for (const [rx, rz] of farWorldColumns(SIZE_KM).slice(0, 2)) {
      const w = writeFarWorldColumn(here, rx, rz, { sizeKm: SIZE_KM });
      for (const f of w.files) expect(readFileSync(join(here, f)).equals(readFileSync(join(gridDir, f))), f).toBe(true);
    }
    const shipped = openShippedWorld(worldDir);
    // The town's square at the centre: ground at y 0 (its top cell is grass, the cell above air or a house).
    expect(shipped.chunkBytes({ cx: 0, cy: -1, cz: 0 })).not.toBeNull();
    // Under a mountain the chunks are whole rock: uniform entries, not stored bytes.
    const world = new FarWorldSource(worldDir);
    expect(typeof world.chunk(-16, -4, -16)).toBe('number');
  });
});

/** Two region columns of the 8 km world side by side along x (seed 97: a mountain flank with a river below it). */
const SEAM_COLUMNS: ReadonlyArray<readonly [number, number]> = [
  [-14, -4],
  [-13, -4],
];

describe('the realistic landscape', () => {
  it('is the same drainage every time, with heights in range and no NaN over the whole 8 km world', () => {
    const half = 8192;
    const a = computeFarDrainage(half, 97);
    const b = computeFarDrainage(half, 97);
    expect(Buffer.from(a.height.buffer).equals(Buffer.from(b.height.buffer))).toBe(true);
    expect(Buffer.from(a.receiver.buffer).equals(Buffer.from(b.receiver.buffer))).toBe(true);
    // Another seed is another world (a 2 km one: quicker).
    expect(Buffer.from(computeFarDrainage(1024, 98).height.buffer).equals(Buffer.from(computeFarDrainage(1024, 97).height.buffer))).toBe(false);
    let max = -Infinity;
    let min = Infinity;
    let over1km = 0;
    let n = 0;
    for (let x = -half; x < half; x += 96) for (let z = -half; z < half; z += 96) {
      const h = farSurfaceHeight(x, z, { sizeKm: 8 });
      expect(Number.isFinite(h), `${x},${z}`).toBe(true);
      max = Math.max(max, h);
      min = Math.min(min, h);
      if (h > 2000) over1km++;
      n++;
    }
    // Mountains to about 1.5 km (gullies and crags may add a little), nothing under the world's base, the town flat at 0.
    expect(max).toBeGreaterThan(0.8 * PEAK);
    expect(max).toBeLessThan(1.1 * PEAK);
    expect(min).toBeGreaterThan(LANDSCAPE_BASE);
    expect(over1km / n).toBeGreaterThan(0.005);
    expect(farSurfaceHeight(0, 0, { sizeKm: 8 })).toBe(0);
    expect(farLandscape(8).archCount).toBeGreaterThan(0);
  }, 60_000);

  it('writes region columns apart that meet cell for cell, with rock, scree, grass, wet river beds and overhangs on disk', () => {
    const { dir, gridDir } = farWorldDirs(join(root, 'realistic'));
    const files: string[] = [];
    for (const [rx, rz] of SEAM_COLUMNS) files.push(...writeFarWorldColumn(gridDir, rx, rz, { sizeKm: 8 }).files);
    // The same column again: the same bytes.
    const again = join(root, 'realistic-again');
    for (const f of writeFarWorldColumn(again, SEAM_COLUMNS[0]![0], SEAM_COLUMNS[0]![1], { sizeKm: 8 }).files) {
      expect(readFileSync(join(again, f)).equals(readFileSync(join(gridDir, f))), f).toBe(true);
    }
    finishFarWorld(dir, files);
    const world = new FarWorldSource(dir);
    const g = FAR_WORLD_GRID;
    const e = g.edge;
    // The seam: x = −13 × 512 cells. A chunk column straddling it, written here from the landscape alone, holds exactly
    // the cells the two region columns wrote on both sides of it.
    const seam = SEAM_COLUMNS[1]![0] * 512;
    const z0 = SEAM_COLUMNS[1]![1] * 512;
    const land = farLandscape(8);
    const cells = createDenseChunk(g);
    let compared = 0;
    for (let cz = z0 / e; cz < z0 / e + 16; cz += 3) {
      const col = land.plan(g, seam - e / 2, cz * e);
      for (let cy = LANDSCAPE_BASE >> g.shift; cy <= Math.floor(col.high) >> g.shift; cy++) {
        const y0 = cy * e;
        if (y0 + e + 8 <= col.low) continue;
        col.fill(cells, y0);
        for (const lx of [e / 2 - 2, e / 2 - 1, e / 2, e / 2 + 1]) {
          const wx = seam - e / 2 + lx;
          const c = world.chunk(wx >> g.shift, cy, cz);
          for (let lz = 0; lz < e; lz++) for (let ly = 0; ly < e; ly++) {
            const here = localIndex(g, lx, ly, lz);
            const there = localIndex(g, wx & (e - 1), ly, lz);
            const want = c === null ? [0, 0, 0, 0] : typeof c === 'number' ? null : [c.material[there], c.role[there], c.shape[there], c.wetness[there]];
            if (want === null) continue;
            expect([cells.material[here], cells.role[here], cells.shape[here], cells.wetness[here]], `${wx},${y0 + ly},${cz * e + lz}`).toEqual(want);
            compared++;
          }
        }
      }
    }
    expect(compared).toBeGreaterThan(10_000);
    // What the columns hold: the materials of a flank and a valley, wet beds, and ground over air (outcrops, boulders).
    const seen = new Set<number>();
    let wet = 0;
    let overhangs = 0;
    for (const [rx, rz] of SEAM_COLUMNS) for (let cx = rx * 16; cx < rx * 16 + 16; cx += 1) for (let cz = rz * 16; cz < rz * 16 + 16; cz += 1) {
      for (let cy = -4; cy < 48; cy++) {
        const c = world.chunk(cx, cy, cz);
        if (c === null || typeof c === 'number') continue;
        for (let x = 0; x < e; x++) for (let z = 0; z < e; z++) {
          let below = -1;
          for (let y = 0; y < e; y++) {
            const i = localIndex(g, x, y, z);
            const solid = c.shape[i]! > 0;
            if (solid) {
              seen.add(c.material[i]!);
              if (c.wetness[i]! > 0) wet++;
              if (below === 0) overhangs++;
            }
            below = solid ? 1 : 0;
          }
        }
      }
    }
    for (const m of [MAT.rock, MAT.soil, MAT.grass, MAT.gravel]) expect(seen.has(m), `${[...seen]}`).toBe(true);
    expect(wet).toBeGreaterThan(1000);
    expect(overhangs).toBeGreaterThan(0);
  }, 120_000);

  it('keeps the terraced style: written the same every time and not the realistic ground', () => {
    const a = join(root, 'terraced-a');
    const b = join(root, 'terraced-b');
    const [rx, rz] = SEAM_COLUMNS[0]!;
    const fa = writeFarWorldColumn(a, rx, rz, { sizeKm: 8, style: 'terraced' }).files;
    writeFarWorldColumn(b, rx, rz, { sizeKm: 8, style: 'terraced' });
    expect(fa.length).toBeGreaterThan(0);
    for (const f of fa) expect(readFileSync(join(a, f)).equals(readFileSync(join(b, f))), f).toBe(true);
    expect(farSurfaceHeight(rx * 512 + 100, rz * 512 + 100, { sizeKm: 8, style: 'terraced' })).not.toBe(farSurfaceHeight(rx * 512 + 100, rz * 512 + 100, { sizeKm: 8 }));
  }, 60_000);
});

describe('the far cache', () => {
  it('builds the same bytes in workers and in one thread, with nodes over every part of the world', async () => {
    const inPool = join(root, 'cache-pool');
    const inThread = join(root, 'cache-thread');
    const a = await buildFarCacheInPool(pool, worldDir, inPool);
    await buildFarCache(worldDir, inThread);
    expect(filesOf(inPool)).toEqual(filesOf(inThread));
    expect(a.manifest.minLevel).toBe(2);
    // 512 m: 32 chunks a side, so two level-4 nodes (one a region) span it.
    expect(a.manifest.maxLevel).toBe(4);
    const index = new FarCacheReader(inPool).index();
    // Every 64 m column of the world has far data (no part of it is missing), and so has every level.
    const half = 512 / 32;
    for (let nx = -half / 4; nx < half / 4; nx++) for (let nz = -half / 4; nz < half / 4; nz++) {
      expect(index.nodes(2).some((n) => n.nx === nx && n.nz === nz), `${nx},${nz}`).toBe(true);
    }
    for (let l = 2; l <= 4; l++) expect(index.nodes(l).length).toBeGreaterThan(0);
    // Seen from the town square, the whole world is drawn (no cut-off) inside the default budget.
    const s = new FarSelection().select(index, { eye: [0, 4, 0], pixelsPerRadian: PIXELS_PER_RADIAN_720P, near: { min: [-384, -188, -384], max: [384, 196, 384] } });
    expect(s.heldByBudget).toBe(0);
    expect(s.drawn.length).toBeGreaterThan(0);
  }, 120_000);

  it('rebuilds exactly the ancestors of an edit, and then equals a full build', async () => {
    const cache = join(root, 'cache-edit');
    const built = await buildFarCacheInPool(pool, worldDir, cache);
    // The world in a project the workspace's voxel worlds serve: one dig command through them.
    const p = join(root, 'edit');
    cpSync(projectDir, p, { recursive: true });
    const worlds = new VoxelWorlds({ projectDir: (id) => (id === 'p' ? p : null) });
    const dig = { v: 2, grid: 0, kind: 'fill', min: [300, -20, 300], max: [340, 10, 330], mode: 'dig' };
    const r = await worlds.command('p', { op: 'editVoxels', projectId: 'p', args: { world: 'far', command: dig } });
    expect(r.ok).toBe(true);
    const chunks = r.ok ? r.chunks.map(([cx, cy, cz]) => ({ cx, cy, cz })) : [];
    expect(chunks.length).toBeGreaterThan(1);
    const before = filesOf(cache);
    const bakedBefore = bakedOf(cache);
    const editedWorld = join(p, 'voxels', 'far');
    const report = rebuildFarCache(editedWorld, cache, chunks);
    const ancestors = farAncestors(chunks, built.manifest.minLevel, built.manifest.maxLevel);
    expect(report.rebuilt.map(mipNodeKey)).toEqual(ancestors.map(mipNodeKey));
    // One level-2 to level-5 chain per distinct ancestor; only the files holding them were written.
    const after = filesOf(cache);
    for (const f of Object.keys(after)) if (f !== 'far.json' && !report.files.includes(f)) expect(after[f], f).toBe(before[f]);
    expect(report.files.filter((f) => f.startsWith('L')).length).toBeLessThanOrEqual(ancestors.length);
    expect(report.files.some((f) => after[f] !== before[f])).toBe(true);
    // The bricks: exactly the dirty set (the node over the change at each level and its border neighbours), each built
    // again by the builder; the bricks files written are those holding them.
    const dirty = farBrickDirty(chunks, FAR_WORLD_GRID.edge, FAR_BRICK_BUILD, built.manifest.minLevel, built.manifest.maxLevel);
    const reader = new FarCacheReader(cache);
    const held = dirty.filter((n) => reader.entry(n) !== null);
    expect(report.bricks).toMatchObject({ dirty: dirty.length, built: held.length, reused: 0 });
    for (const l of [2, 3, 4]) expect(dirty.some((n) => n.level === l), `L${l}`).toBe(true);
    // Every other node's baked bricks are the bytes they were.
    const dirtyKeys = new Set(dirty.map(mipNodeKey));
    const bakedAfter = bakedOf(cache);
    let kept = 0;
    for (const [k, v] of bakedBefore) if (!dirtyKeys.has(k)) {
      expect(bakedAfter.get(k), k).toBe(v);
      kept++;
    }
    expect(kept).toBeGreaterThan(dirty.length);
    const bricksFiles = report.files.filter((f) => f.startsWith('B'));
    for (const n of held) expect(bricksFiles.some((f) => f.startsWith(`B${n.level}/`))).toBe(true);
    // The rebuilt cache equals one built from scratch from the edited world, bricks and all: the bricks built again
    // meet their baked neighbours as a full bake would.
    const fresh = join(root, 'cache-fresh');
    await buildFarCache(editedWorld, fresh);
    expect(after).toEqual(filesOf(fresh));
    // Undone, then done again: the redo's cells are the edit's, so every brick comes from the rebuilt store by its
    // content key (a store opened afresh, as on the next load), none is built.
    const undo = await worlds.command('p', { op: 'undoVoxels', projectId: 'p', args: { world: 'far' } });
    expect(undo.ok).toBe(true);
    const back = rebuildFarCache(editedWorld, cache, chunks);
    expect(back.bricks!.built).toBeGreaterThan(0);
    const redo = await worlds.command('p', { op: 'editVoxels', projectId: 'p', args: { world: 'far', command: dig } });
    expect(redo.ok).toBe(true);
    const again = rebuildFarCache(editedWorld, cache, chunks);
    expect(again.bricks).toMatchObject({ dirty: dirty.length, built: 0, reused: held.length });
    // Every file as the full build of the edited world has it; the manifest only names the revision the redo made.
    const { 'far.json': _m1, ...redone } = filesOf(cache);
    const { 'far.json': _m2, ...full } = filesOf(fresh);
    expect(redone).toEqual(full);
    expect(readFarCacheManifest(cache).revision).toBe(readVoxelWorldManifest(editedWorld).revision);
  }, 180_000);

  it('bakes bricks byte for byte as the far field builds them in its workers, and draws a format-1 cache (no bricks) by building them', async () => {
    const p = join(root, 'baked');
    cpSync(projectDir, p, { recursive: true });
    const world = join(p, 'voxels', 'far');
    const cacheDir = farCacheDir(p, 'far');
    const b = await buildFarCacheInPool(pool, world, cacheDir);
    expect(b.manifest.format).toBe(2);
    expect(b.manifest.bricks!.levels.map((l) => l.nodes)).toEqual(b.manifest.levels.map((l) => l.nodes));
    expect(b.brickBytes).toBeGreaterThan(0);
    // The same cache as format 1: its nodes only, as a cache built before bricks were baked.
    const old = join(root, 'baked-v1');
    cpSync(cacheDir, old, { recursive: true });
    for (const l of b.manifest.bricks!.levels) rmSync(join(old, `B${l.level}`), { recursive: true, force: true });
    const { bricks: _baked, ...nodesOnly } = b.manifest;
    writeFileSync(join(old, 'far.json'), `${JSON.stringify({ ...nodesOnly, format: 1 }, null, 2)}\n`);
    expect(readFarCacheManifest(old).bricks).toBeUndefined();
    expect(farCacheStale(old, readVoxelWorldManifest(world))).toMatch(/format 1/);
    expect(farCacheStale(cacheDir, readVoxelWorldManifest(world))).toBeNull();
    expect(farCacheFiles(cacheDir).filter((f) => f.startsWith('B')).length).toBeGreaterThan(0);
    const file = await bundleWorker('stream-worker-node', join(REPO, 'dist', 'voxel-bench', `far-baked-worker-${process.pid}.mjs`));
    const workers = new WorkerPool({ size: 2, create: () => nodePoolWorker(file), ...STREAM_POOL_SETTINGS });
    const opened: DiskRegions[] = [];
    const drawn = async (dir: string): Promise<{ bricks: Map<string, Uint8Array>; baked: boolean }> => {
      const m = readFarCacheManifest(dir);
      const open = (level: number, name: string) => {
        const d = new DiskRegions(join(dir, level >= FAR_BAKED_LEVELS ? `B${level - FAR_BAKED_LEVELS}` : `L${level}`));
        opened.push(d);
        return d.open(name);
      };
      const source = regionFarSource({ worldId: hexToBytes(m.worldId), grid: FAR_WORLD_GRID, footprint: m.footprint, minLevel: m.minLevel, maxLevel: m.maxLevel, levels: m.levels, ...(m.bricks !== undefined ? { bricks: m.bricks.levels } : {}), maxOpen: 16, open });
      const far = new FarField({ source, draw: 'bricks', errorPixels: 64 }, { grid: FAR_WORLD_GRID, pool: workers, rules: WORLD_RULES });
      const shown = new Map<string, FarNodeDraw>();
      far.on((e) => {
        for (const n of e.removed) shown.delete(mipNodeKey(n));
        for (const a of e.added) shown.set(mipNodeKey(a), a);
      });
      for (const [x, z] of [[0, 0], [-200, 200]] as const) {
        far.setEye(x, 40, z);
        far.update();
        await far.settle();
      }
      expect(far.metrics().problem).toBeNull();
      far.close();
      return { bricks: new Map([...shown].map(([k, d]) => [k, encodeFarBricks(d.bricks!)])), baked: source.baked?.(2) === true };
    };
    try {
      const fromBake = await drawn(cacheDir);
      const fromBuild = await drawn(old);
      expect(fromBake.baked).toBe(true);
      expect(fromBuild.baked).toBe(false);
      expect(fromBake.bricks.size).toBeGreaterThan(8);
      expect([...fromBake.bricks.keys()].sort()).toEqual([...fromBuild.bricks.keys()].sort());
      const levels = new Set<number>();
      for (const [k, bytes] of fromBake.bricks) {
        expect(Buffer.from(bytes).equals(Buffer.from(fromBuild.bricks.get(k)!)), k).toBe(true);
        levels.add(Number(k.split(':')[0]));
      }
      expect(levels.size).toBeGreaterThan(1);
      // And every baked node decodes to what the builder gives for its cells now (the bake's bytes as stored).
      const reader = new FarCacheReader(cacheDir);
      for (const n of reader.index().nodes(3)) {
        const e = reader.bricksEntry(n)!;
        const stored = 'stored' in e ? (e.raw ? e.stored : new Uint8Array(zstdDecompressSync(e.stored))) : null;
        expect(stored, mipNodeKey(n)).not.toBeNull();
        expect(Buffer.from(encodeFarBricks(decodeFarBricks(stored!))).equals(Buffer.from(stored!))).toBe(true);
      }
    } finally {
      for (const d of opened) await d.close();
      workers.close();
      rmSync(file, { force: true });
    }
  }, 180_000);

  it('closes the town houses’ doors and windows at levels 1 and 2 (no legs)', () => {
    const world = new FarWorldSource(worldDir);
    const l1 = new Map<string, FarCells>();
    const l2 = new Map<string, FarCells>();
    const keep = (n: MipNode, c: FarCells): void => void (n.level === 1 ? l1 : n.level === 2 ? l2 : null)?.set(mipNodeKey(n), c);
    // The town: chunks −8 … 7 on x and z, its ground and houses in chunk rows −4 … 1 (level-2 rows −1 and 0).
    for (let nx = -2; nx < 2; nx++) for (let nz = -2; nz < 2; nz++) for (const ny of [-1, 0]) {
      buildFarNode(world, { level: 2, nx, ny, nz }, keep);
    }
    const cellAt = (map: Map<string, FarCells>, level: number, x: number, y: number, z: number): number => {
      const s = FAR_WORLD_GRID.shift;
      const c = map.get(mipNodeKey({ level, nx: x >> s, ny: y >> s, nz: z >> s }));
      if (c === null || c === undefined) return VOXEL_ROLE.air;
      if (typeof c === 'number') return valueRole(c);
      return c.role[localIndex(FAR_WORLD_GRID, x & 31, y & 31, z & 31)]!;
    };
    const solid = (r: number): boolean => r !== VOXEL_ROLE.air && r !== VOXEL_ROLE.opening && r !== VOXEL_ROLE.liquid;
    // A leg gap: the coarse cell over an opening is open while the wall goes on solid on both sides of it in its row.
    const legGap = (map: Map<string, FarCells>, level: number, x: number, y: number, z: number): boolean => {
      if (solid(cellAt(map, level, x, y, z))) return false;
      return (solid(cellAt(map, level, x - 1, y, z)) && solid(cellAt(map, level, x + 1, y, z))) || (solid(cellAt(map, level, x, y, z - 1)) && solid(cellAt(map, level, x, y, z + 1)));
    };
    let openings = 0;
    let gaps1 = 0;
    let gaps2 = 0;
    for (let cx = -8; cx < 8; cx++) for (let cz = -8; cz < 8; cz++) for (let cy = -4; cy < 2; cy++) {
      const c = world.chunk(cx, cy, cz);
      if (c === null || typeof c === 'number') continue;
      for (let x = 0; x < 32; x++) for (let z = 0; z < 32; z++) for (let y = 0; y < 32; y++) {
        if (c.role[localIndex(FAR_WORLD_GRID, x, y, z)] !== VOXEL_ROLE.opening) continue;
        openings++;
        const wx = cx * 32 + x, wy = cy * 32 + y, wz = cz * 32 + z;
        if (legGap(l1, 1, wx >> 1, wy >> 1, wz >> 1)) gaps1++;
        if (legGap(l2, 2, wx >> 2, wy >> 2, wz >> 2)) gaps2++;
      }
    }
    expect(openings).toBeGreaterThan(1000);
    expect(gaps1).toBe(0);
    expect(gaps2).toBe(0);
  }, 120_000);
});

/** A far node's mesh triangles without its skirts (the skirts are the last ones), as world-cell edges on one axis plane. */
function planeEdges(d: FarNodeDraw, axis: 0 | 1 | 2, plane: number, which: 'crossing' | 'lying' | 'all' = 'crossing'): Set<string> {
  const m = d.mesh!;
  const view = new DataView(m.vertices.buffer, m.vertices.byteOffset, m.vertices.byteLength);
  const scale = 2 ** d.level;
  const corner = [d.nx * 32, d.ny * 32, d.nz * 32];
  // World cells × 1024 of the level, exact integers.
  const at = (v: number): number[] => [0, 1, 2].map((a) => (corner[a]! - FAR_POSITION_ORIGIN_CELLS) * POSITION_STEPS_PER_CELL + view.getUint16(v * FAR_VERTEX_BYTES + a * 2, true)).map((x) => x * scale);
  const out = new Set<string>();
  const plain = m.indices.length - m.skirtTriangles * 3;
  const want = plane * POSITION_STEPS_PER_CELL * scale;
  for (let t = 0; t < plain; t += 3) {
    // A face lying in the plane is one side's own (a wall on the boundary, toward air on the other side): faces crossing the plane end on it or on the other side's crossing faces.
    const lying = [0, 1, 2].every((k) => at(m.indices[t + k]!)[axis] === want);
    if ((which === 'crossing' && lying) || (which === 'lying' && !lying)) continue;
    for (let k = 0; k < 3; k++) {
      const a = at(m.indices[t + k]!), b = at(m.indices[t + ((k + 1) % 3)]!);
      if (a[axis] !== want || b[axis] !== want) continue;
      const ka = a.join(','), kb = b.join(',');
      out.add(ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`);
    }
  }
  return out;
}

/** The largest distance (world cells of the level) from an end of an edge in `from` to the nearest edge of `to`. */
function farthestEnd(from: ReadonlySet<string>, to: ReadonlySet<string>, scale: number): number {
  const seg = [...to].map((e) => e.split('|').map((p) => p.split(',').map(Number)));
  const gap = (p: number[]): number =>
    Math.min(
      ...seg.map(([a, b]) => {
        const ab = [0, 1, 2].map((k) => b![k]! - a![k]!);
        const ap = [0, 1, 2].map((k) => p[k]! - a![k]!);
        const len2 = ab.reduce((s, v) => s + v * v, 0);
        const t = Math.max(0, Math.min(1, ap.reduce((s, v, k) => s + v * ab[k]!, 0) / len2));
        return Math.hypot(...[0, 1, 2].map((k) => ap[k]! - ab[k]! * t));
      }),
    );
  let worst = 0;
  for (const e of from) for (const p of e.split('|')) worst = Math.max(worst, gap(p.split(',').map(Number)));
  return worst / (POSITION_STEPS_PER_CELL * scale);
}

describe('the far field drawn as meshes and as bricks', () => {
  it('meshes the selection in workers from the cache on disk, swaps whole, meets same-level neighbours exactly, colours from the cells, meshes an edit again, and switches to bricks', async () => {
    // The world in a project the workspace's voxel worlds serve, its far cache where they keep it.
    const p = join(root, 'field');
    cpSync(projectDir, p, { recursive: true });
    const world = join(p, 'voxels', 'far');
    const cacheDir = farCacheDir(p, 'far');
    await buildFarCacheInPool(pool, world, cacheDir);
    const m = readFarCacheManifest(cacheDir);
    // A file opened again after an edit is read afresh (the cache's rewritten files are new files, as a range read sees them).
    const opened: DiskRegions[] = [];
    const open = (level: number, name: string) => {
      const d = new DiskRegions(join(cacheDir, `L${level}`));
      opened.push(d);
      return d.open(name);
    };
    const source = regionFarSource({ worldId: hexToBytes(m.worldId), grid: FAR_WORLD_GRID, footprint: m.footprint, minLevel: m.minLevel, maxLevel: m.maxLevel, levels: m.levels, maxOpen: 16, open });
    const file = await bundleWorker('stream-worker-node', join(REPO, 'dist', 'voxel-bench', `far-field-worker-${process.pid}.mjs`));
    const workers = new WorkerPool({ size: 2, create: () => nodePoolWorker(file), ...STREAM_POOL_SETTINGS });
    try {
      const far = new FarField({ source, errorPixels: 2 }, { grid: FAR_WORLD_GRID, pool: workers, rules: WORLD_RULES });
      const shown = new Map<string, FarNodeDraw>();
      const events: FarEvent[] = [];
      far.on((e) => {
        events.push(e);
        for (const n of e.removed) shown.delete(mipNodeKey(n));
        for (const a of e.added) shown.set(mipNodeKey(a), a);
        // Never two drawn nodes over one place: no drawn node has a drawn ancestor.
        for (const a of shown.values()) for (let l = a.level + 1; l <= m.maxLevel; l++) expect(shown.has(mipNodeKey({ level: l, nx: a.nx >> (l - a.level), ny: a.ny >> (l - a.level), nz: a.nz >> (l - a.level) })), mipNodeKey(a)).toBe(false);
      });
      far.setEye(0, 8, 0);
      far.update();
      await far.settle();
      const metrics = far.metrics();
      expect(metrics.problem).toBeNull();
      expect(metrics.pending).toBe(0);
      expect(metrics.drawn).toBe(metrics.nodes);
      expect(shown.size).toBeGreaterThan(8);
      // Nearest at the lowest level, coarser away from the eye.
      expect(Math.min(...[...shown.values()].map((d) => d.level))).toBe(m.minLevel);
      let skirts = 0;
      const looks = new Set<number>();
      for (const d of shown.values()) {
        skirts += d.mesh!.skirtTriangles;
        const view = new DataView(d.mesh!.vertices.buffer, d.mesh!.vertices.byteOffset, d.mesh!.vertices.byteLength);
        for (let v = 0; v < d.mesh!.vertexCount; v++) looks.add(farVertexLook(view.getUint16(v * FAR_VERTEX_BYTES + 6, true)).material);
      }
      expect(skirts).toBeGreaterThan(0);
      // Every vertex has the material of a cell of the world behind it (the ground's and the town's), never air.
      expect(looks.has(0), `${[...looks]}`).toBe(false);
      for (const mat of [MAT.grass, MAT.rock]) expect(looks.has(mat), `${[...looks]}`).toBe(true);
      // Two drawn neighbours of one level meet edge for edge on the face between them (without skirts): no crack.
      let faces = 0;
      let worstGap = 0;
      for (const a of shown.values()) {
        const b = shown.get(mipNodeKey({ level: a.level, nx: a.nx + 1, ny: a.ny, nz: a.nz }));
        if (b === undefined) continue;
        const ea = planeEdges(a, 0, (a.nx + 1) * 32);
        const eb = planeEdges(b, 0, b.nx * 32);
        if (ea.size === 0 && eb.size === 0) continue;
        faces++;
        // The same boundary line from both sides: every end of one side's edges lies on an edge of the other's (a merged
        // face on one side may span what the other splits, never leaving a gap).
        // What one side's edges on the plane end on: the other side's edges there (its nodes above and below too: the
        // surface may cross into them right at the plane) and its own faces lying in the plane.
        const column = (y: FarNodeDraw): FarNodeDraw[] => [y, ...[-1, 1].flatMap((dy) => shown.get(mipNodeKey({ level: y.level, nx: y.nx, ny: y.ny + dy, nz: y.nz })) ?? [])];
        const meets = (x: FarNodeDraw, y: FarNodeDraw, px: number, py: number): Set<string> => new Set([...column(y).flatMap((c) => [...planeEdges(c, 0, py, 'all')]), ...column(x).flatMap((c) => [...planeEdges(c, 0, px, 'lying')])]);
        const s = 2 ** a.level;
        worstGap = Math.max(worstGap, farthestEnd(ea, meets(a, b, (a.nx + 1) * 32, b.nx * 32), s), farthestEnd(eb, meets(b, a, b.nx * 32, (a.nx + 1) * 32), s));
      }
      expect(faces).toBeGreaterThan(0);
      expect(worstGap).toBe(0);
      // An edit through the workspace's commands: the backend rebuilds the cache's ancestors, the far field reads them again.
      const worlds = new VoxelWorlds({ projectDir: (id) => (id === 'p' ? p : null) });
      const r = await worlds.command('p', { op: 'editVoxels', projectId: 'p', args: { world: 'far', command: { v: 2, grid: 0, kind: 'fill', min: [-40, -30, -40], max: [-8, 40, -8], mode: 'dig' } } });
      expect(r.ok && r.far).toMatchObject({ nodes: expect.any(Number) });
      const chunks = r.ok ? r.chunks.map(([cx, cy, cz]) => ({ cx, cy, cz })) : [];
      const l2 = farAncestors(chunks, m.minLevel, m.minLevel).map(mipNodeKey);
      const before = new Map([...shown].filter(([k]) => l2.includes(k)).map(([k, d]) => [k, d.mesh!.vertices.slice()]));
      expect(before.size).toBeGreaterThan(0);
      const seen = events.length;
      far.refresh(chunks);
      await far.settle();
      const again = events.slice(seen).flatMap((e) => e.added.map(mipNodeKey));
      for (const k of before.keys()) {
        expect(again, k).toContain(k);
        expect(Buffer.from(shown.get(k)!.mesh!.vertices).equals(Buffer.from(before.get(k)!)), k).toBe(false);
      }
      // The bricks mode, switched at run time: every drawn node is made again as bricks and swapped in, none drawn twice.
      const meshNodes = shown.size;
      far.setView({ draw: 'bricks' });
      await far.settle();
      expect(far.metrics().problem).toBeNull();
      expect(far.metrics().draw).toBe('bricks');
      expect([...shown.values()].every((d) => d.mesh === undefined && d.bricks !== undefined)).toBe(true);
      expect(shown.size).toBeGreaterThan(meshNodes / 2);
      const brickLooks = new Set<number>();
      let surfaceHits = 0;
      for (const d of shown.values()) {
        const b = d.bricks!;
        expect(b.samples.length / DISTANCE_BRICK_SAMPLES).toBeGreaterThan(0);
        for (let i = 0; i < b.looks.length; i += 37) brickLooks.add(farVertexLook(b.looks[i]!).material);
        // A ray straight down each stored brick's middle column meets its surface or leaves through its floor (the
        // surface may lie in a neighbour); some do meet it.
        for (let k = 0; k < b.samples.length / DISTANCE_BRICK_SAMPLES; k++) {
          const box = farBrickMarchedBox(b, k);
          if (marchBrickBox(b.samples, k, box.lo, box.hi, [4, 7.9, 4], [0, -1, 0]) !== null) surfaceHits++;
        }
      }
      expect(surfaceHits).toBeGreaterThan(shown.size);
      for (const mat of [MAT.grass, MAT.rock]) expect(brickLooks.has(mat), `${[...brickLooks]}`).toBe(true);
      // Same-level neighbours along x share their face's samples exactly (the field reads across the face).
      let shared = 0;
      for (const a of shown.values()) {
        const b = shown.get(mipNodeKey({ level: a.level, nx: a.nx + 1, ny: a.ny, nz: a.nz }));
        if (b === undefined) continue;
        for (let by = 0; by < 4; by++) for (let bz = 0; bz < 4; bz++) {
          const ia = a.bricks!.bricks[(bz * 4 + by) * 4 + 3]!;
          const ib = b.bricks!.bricks[(bz * 4 + by) * 4 + 0]!;
          if (ia < 0 || ib < 0) continue;
          for (let sz = 0; sz < DISTANCE_BRICK_SIDE; sz++) for (let sy = 0; sy < DISTANCE_BRICK_SIDE; sy++) {
            const row = (sz * DISTANCE_BRICK_SIDE + sy) * DISTANCE_BRICK_SIDE;
            expect(a.bricks!.samples[ia * DISTANCE_BRICK_SAMPLES + row + 8]).toBe(b.bricks!.samples[ib * DISTANCE_BRICK_SAMPLES + row]);
          }
          shared++;
        }
      }
      expect(shared).toBeGreaterThan(0);
      // The eye moves across the world while other work keeps the pool's queue full (a flight's near field): the far
      // field's background share still makes nodes, swaps them in where the error is largest, closes nodes behind the
      // eye, and settles with nothing held but what it draws.
      // A coarse error, so the small test world's selection changes with the eye (at 2 px it is all the lowest level).
      far.setView({ errorPixels: 64 });
      await far.settle();
      const c0 = far.metrics().counters;
      let busy = true;
      let nearId = 1_000_000;
      const nearStream = (async () => {
        while (busy) {
          const batch = Array.from({ length: 16 }, () => workers.submit({ id: nearId++, kind: 'test-sleep', lane: 'near', distance: 0, input: { ms: 5 }, transfer: [] }));
          await Promise.all(batch);
        }
      })();
      for (const [x, z] of [[-300, -300], [300, -300], [300, 300], [-300, 300], [0, 0]] as const) {
        far.setEye(x, 40, z);
        far.update();
        await far.settle();
        const mm = far.metrics();
        expect(mm.problem).toBeNull();
        expect(mm.drawn).toBe(mm.nodes);
        expect(mm.jobs).toBe(0);
      }
      busy = false;
      await nearStream;
      const c1 = far.metrics().counters;
      expect(c1.swappedIn - c0.swappedIn).toBeGreaterThan(0);
      expect(c1.swappedOut - c0.swappedOut).toBeGreaterThan(0);
      // What is drawn is the selection, nothing left from the way (the listener checked no place is drawn twice), and the
      // read nodes stay within their cache.
      expect(shown.size).toBe(far.metrics().nodes);
      expect(far.metrics().entryBytes).toBeLessThanOrEqual(FAR_ENTRY_CACHE_BYTES);
      // A GPU budget of half what is drawn: the selection opens nodes by error while they fit, and after every move
      // what is drawn (the bricks' own GPU bytes, as the view's atlas keeps them) stays within it. On the way a
      // commit puts groups in whole while the nodes that close over finer ones behind are still being made: what
      // stands drawn passes the budget by a little then, never by a quarter.
      const drawnGpu = (): number => [...shown.values()].reduce((n, d) => n + farBricksGpuBytes(d.bricks!), 0);
      expect(far.metrics().gpu.drawn).toBe(drawnGpu());
      const budget = Math.floor(drawnGpu() / 2);
      let peak = 0;
      far.on(() => (peak = Math.max(peak, drawnGpu())));
      far.setView({ gpuBudgetBytes: budget });
      await far.settle();
      for (const [x, z] of [[-300, -300], [300, -300], [300, 300], [-300, 300], [0, 0], [200, 0], [0, 200], [-200, -200]] as const) {
        far.setEye(x, 40, z);
        far.update();
        await far.settle();
        const mm = far.metrics();
        expect(mm.problem).toBeNull();
        expect(mm.drawn).toBe(mm.nodes);
        expect(drawnGpu()).toBeLessThanOrEqual(budget);
        expect(mm.gpu.drawn).toBe(drawnGpu());
        expect(mm.gpu.held).toBeGreaterThan(0);
      }
      expect(peak).toBeLessThan(budget * 1.25);
      // Asked for much finer nodes than it draws, with the near field drawing a cylinder round the eye: the nodes
      // round the cylinder's edge are made first and those wholly under the near field last, and a coarse node gives
      // way one level at a time (its children, then theirs), never straight to nodes two or more levels finer.
      far.setView({ gpuBudgetBytes: 2 ** 40, errorPixels: 64 });
      await far.settle();
      const ring = { radius: 300, height: 200, drawn: () => true };
      const eye = [0, 40, 0] as const;
      const under = (n: MipNode): boolean => {
        const s = 32 << n.level;
        const lo = [n.nx * s, n.ny * s, n.nz * s], hi = lo.map((v) => v + s);
        if (lo[1]! < eye[1] - ring.height || hi[1]! > eye[1] + ring.height) return false;
        const dx = Math.max(Math.abs(lo[0]! - eye[0]), Math.abs(hi[0]! - eye[0])), dz = Math.max(Math.abs(lo[2]! - eye[2]), Math.abs(hi[2]! - eye[2]));
        return dx * dx + dz * dz <= ring.radius ** 2;
      };
      const steps: FarEvent[] = [];
      far.on((e) => steps.push(e));
      far.setEye(...eye, ring);
      far.setView({ errorPixels: 2 });
      for (let i = 0; i < 200 && far.metrics().pending === 0; i++) await new Promise((ok) => setTimeout(ok, 10));
      const order = far.next(1 << 20);
      const hiddenAt = order.map(under);
      expect(hiddenAt.some((h) => h)).toBe(true);
      expect(hiddenAt.some((h) => !h)).toBe(true);
      expect(hiddenAt.indexOf(true)).toBeGreaterThan(hiddenAt.lastIndexOf(false));
      const first = order[0]!;
      const s0 = 32 << first.level;
      const d0 = Math.hypot(Math.max(0, Math.abs(first.nx * s0 + s0 / 2) - s0 / 2), Math.max(0, Math.abs(first.nz * s0 + s0 / 2) - s0 / 2));
      expect(d0).toBeLessThanOrEqual(ring.radius + s0);
      await far.settle();
      let refined = 0;
      for (const e of steps) for (const r of e.removed) for (const a of e.added) {
        if (a.level >= r.level || a.nx >> (r.level - a.level) !== r.nx || a.ny >> (r.level - a.level) !== r.ny || a.nz >> (r.level - a.level) !== r.nz) continue;
        refined++;
        expect(r.level - a.level, `${mipNodeKey(r)} -> ${mipNodeKey(a)}`).toBe(1);
      }
      expect(refined).toBeGreaterThan(0);
      expect(far.metrics().drawn).toBe(far.metrics().nodes);
      expect(far.metrics().standIns.pending).toBe(0);
      far.close();
      await seenFirst(source, workers, m.maxLevel);
    } finally {
      for (const d of opened) await d.close();
      workers.close();
      rmSync(file, { force: true });
    }
  }, 120_000);
});

/**
 * A far field fed rounds of visibility feedback (what the page's draws were seen at): asked for finer nodes, what the
 * eye sees too coarse is refined first; a node no longer seen keeps its detail within the turn window and coarsens
 * after it (never to nothing); a stale round changes nothing.
 */
async function seenFirst(source: ReturnType<typeof regionFarSource>, workers: WorkerPool, maxLevel: number): Promise<void> {
  const TURN = 600;
  const far = new FarField({ source, errorPixels: 64, draw: 'bricks', seenTurnMs: TURN }, { grid: FAR_WORLD_GRID, pool: workers, rules: WORLD_RULES });
  const shown = new Map<string, MipNode>();
  far.on((e) => {
    for (const n of e.removed) shown.delete(mipNodeKey(n));
    for (const a of e.added) shown.set(mipNodeKey(a), { level: a.level, nx: a.nx, ny: a.ny, nz: a.nz });
  });
  const under = (n: MipNode, s: MipNode): boolean => n.level <= s.level && n.nx >> (s.level - n.level) === s.nx && n.ny >> (s.level - n.level) === s.ny && n.nz >> (s.level - n.level) === s.nz;
  const drawnOver = (n: MipNode): MipNode | null => {
    for (let l = n.level + 1; l <= maxLevel; l++) {
      const a = shown.get(mipNodeKey({ level: l, nx: n.nx >> (l - n.level), ny: n.ny >> (l - n.level), nz: n.nz >> (l - n.level) }));
      if (a !== undefined) return a;
    }
    return null;
  };
  let round = 0;
  // A round naming these drawn nodes seen at 400 cells (200 m), 50 pixels each.
  const feed = (nodes: readonly MipNode[]): void => far.feedback({ round: ++round, farSeq: far.metrics().counters.events, nodes: nodes.flatMap((n) => [n.level, n.nx, n.ny, n.nz, 50, 400]) });
  const wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
  try {
    far.setEye(0, 40, 0);
    far.update();
    await far.settle();
    expect(far.metrics().problem).toBeNull();
    // The stand-in the eye sees: the coarse drawn node with the largest error (the nearest of them).
    const ppr = FAR_VIEW_PIXELS_PER_RADIAN;
    const errorOf = (n: MipNode): number => farCellPixels(n.level, farNodeDistance(FAR_WORLD_GRID, n, [0, 40, 0]), ppr);
    const coarse = [...shown.values()].filter((n) => n.level > FAR_MIN_TEST_LEVEL).sort((a, b) => errorOf(b) - errorOf(a));
    expect(coarse.length).toBeGreaterThan(1);
    const s = coarse[0]!;
    // Rounds for a whole turn window naming only it: from then on every other drawn node is unseen.
    const t0 = performance.now();
    while (performance.now() - t0 < TURN * 1.3) {
      feed([s]);
      await wait(50);
    }
    expect(far.metrics().seen.rounds).toBeGreaterThan(5);
    // Asked for the finest nodes everywhere: the refinements under the seen stand-in come before every other.
    far.setView({ errorPixels: 0.5 });
    for (let i = 0; i < 300 && far.metrics().pending === 0; i++) await wait(10);
    const order = far.next(1 << 20);
    const refines = order.filter((n) => drawnOver(n) !== null);
    const seenAt = refines.map((n) => under(n, s));
    expect(seenAt.some((x) => x)).toBe(true);
    expect(seenAt.some((x) => !x)).toBe(true);
    expect(seenAt.lastIndexOf(true)).toBeLessThan(seenAt.indexOf(false));
    // At half the stand-in's error, the eye on its place (rounds naming what is drawn there): it is opened, and what
    // the eye does not meet stands as at four times that (the stand-in's twice), so closes back over.
    far.setView({ errorPixels: errorOf(s) / 2 });
    for (let i = 0; i < 400; i++) {
      feed([...shown.values()].filter((n) => under(n, s)));
      await wait(25);
      const mm = far.metrics();
      if (i > 20 && mm.pending === 0 && mm.jobs === 0) break;
    }
    const fine = (): MipNode[] => [...shown.values()].filter((n) => under(n, s) && n.level < s.level);
    const kept = fine().length;
    expect(kept).toBeGreaterThan(1);
    expect(shown.has(mipNodeKey(s))).toBe(false);
    // The eye turns away: rounds go on naming nothing. Within the turn window what it left keeps its detail.
    feed(fine());
    const left = performance.now();
    feed([]);
    await wait(TURN / 4);
    feed([]);
    expect(performance.now() - left).toBeLessThan(TURN);
    expect(far.metrics().seen.unseenWanted).toBeLessThan(far.metrics().nodes);
    expect(fine().length).toBe(kept);
    // Past it, the next round selects again: the stand-in drawn again in its place, never nothing.
    const reselects = far.metrics().counters.seenReselects;
    await wait(TURN - (performance.now() - left) + 100);
    feed([]);
    for (let i = 0; i < 200 && far.metrics().counters.seenReselects === reselects; i++) await wait(10);
    for (let i = 0; i < 200 && far.metrics().pending === 0; i++) await wait(10);
    await far.settle();
    expect(far.metrics().counters.seenReselects).toBeGreaterThan(reselects);
    expect(fine().length).toBe(0);
    expect(shown.has(mipNodeKey(s))).toBe(true);
    // A stale round (a number already taken) is dropped and changes nothing.
    const stale = far.metrics().seen.stale;
    far.feedback({ round: 1, farSeq: 0, nodes: [s.level, s.nx, s.ny, s.nz, 50, 400] });
    expect(far.metrics().seen.stale).toBe(stale + 1);
  } finally {
    far.close();
  }
}

/** The far tree's lowest kept level in this world (a stand-in is coarser). */
const FAR_MIN_TEST_LEVEL = 2;
