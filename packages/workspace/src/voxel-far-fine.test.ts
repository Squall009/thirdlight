/**
 * A voxel world's fine far levels baked into its far cache, with real region
 * files and far caches on disk, through the voxel worlds' own far jobs: a
 * world baked to 1 m stores level 1, one baked to 0.5 m levels 1 and 0, every
 * stored node byte for byte the fine builder's bricks of the same block (the
 * block the page reads from the streamer and checks its GPU build against);
 * a bake stopped part way goes on from the columns it wrote and ends equal
 * to one that never stopped; an edit builds again exactly the fine nodes
 * over its chunks and leaves the cache equal to a fresh bake of the edited
 * world; an export ships the fine levels the scenes ask, whole, and no finer;
 * a format-2 cache still reads and is current for a world baked to 2 m; an
 * unknown format is refused.
 */
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalShippedVoxelWorld,
  chunkGrid,
  createWorldStore,
  encodeFarBricks,
  farBrickCount,
  farBrickOcclusion,
  farBricksFromBlock,
  farFineDirty,
  gatherFarCells,
  mipNodeKey,
  packFarFine,
  shippedVoxelWorldsProblem,
  SHAPE_FULL,
  unpackFarFine,
  VOXEL_ROLE,
  type ChunkCells,
  type FarBakeLevelM,
  type PaletteStore,
  type RegionEntry,
} from '@thirdlight/voxel';
import { afterAll, describe, expect, it } from 'vitest';
import { FAR_REBUILT_FOLDER } from './voxel-far-bake';
import { buildFarCache, FAR_CACHE_MANIFEST, farCacheDir, farCacheFiles, farCacheStale, readFarCacheManifest } from './voxel-far-cache';
import { farFineColumns, farFineStored, rebakeFarFine } from './voxel-far-fine';
import { inProcessFarJobs, type FarCacheJobs } from './voxel-far-jobs';
import { FarWorldSource } from './voxel-far-cache';
import { readVoxelWorldManifest, VoxelWorlds, writeVoxelWorld } from './voxel-worlds';
import { zstdDecompress } from './voxel-world-files';

const grid = chunkGrid(32);
const root = join(tmpdir(), `tl-voxel-far-fine-${process.pid}-${Date.now().toString(36)}`);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const ROCK = 7;
const GRASS = 9;
const WALL = 12;
const TILE = 14;

/** Cells the test world reaches from the origin each way: a corner of four region columns. */
const HALF = 64;

/**
 * Hills of whole and part-full cells over four region columns (64 m square round the origin), a house with a doorway
 * across the column corner and a 45° gable roof of roof cells (drawn as the roof mesher's planes).
 */
function worldStore(): PaletteStore {
  const s = createWorldStore(grid);
  for (let x = -HALF; x < HALF; x++) for (let z = -HALF; z < HALF; z++) {
    const h = 20 + 6 * Math.sin(x / 23) + 5 * Math.cos(z / 17);
    const top = Math.floor(h);
    for (let y = 0; y < top; y++) s.setVoxel(x, y, z, { material: y === top - 1 ? GRASS : ROCK, role: VOXEL_ROLE.terrain, shape: SHAPE_FULL, wetness: 0 });
    const part = Math.round((h - top) * SHAPE_FULL);
    if (part > 0) s.setVoxel(x, top, z, { material: GRASS, role: VOXEL_ROLE.terrain, shape: part, wetness: 1 });
  }
  for (let x = -8; x < 8; x++) for (let z = -6; z < 6; z++) for (let y = 26; y < 36; y++) {
    const shell = x === -8 || x === 7 || z === -6 || z === 5;
    const door = z === -6 && x >= -2 && x <= 0 && y < 31;
    if (shell && !door) s.setVoxel(x, y, z, { material: WALL, role: VOXEL_ROLE.wall, shape: SHAPE_FULL, wetness: 0 });
  }
  for (let x = -7; x < 7; x++) for (let z = 10; z < 24; z++) s.setVoxel(x, 30 + Math.min(z - 10 + 1, 24 - z), z, { material: TILE, role: VOXEL_ROLE.roof, shape: SHAPE_FULL, wetness: 0 });
  return s;
}

const store = worldStore();

/** A project holding the test world. */
function project(name: string): { projectDir: string; worldDir: string } {
  const projectDir = join(root, name);
  const worldDir = join(projectDir, 'voxels', 'w');
  mkdirSync(worldDir, { recursive: true });
  writeVoxelWorld(worldDir, { worldId: 'a0112233445566778899aabbccddeeff', edge: 32, layout: 'stacked', footprint: 512 }, store);
  return { projectDir, worldDir };
}

/** Every file under a folder (the rebuilt store left out: it remembers edits, it is not what a bake makes), path → base64. */
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

/** The voxel worlds of one project `p` whose scene bakes world `w` to `bake` metres (2 m: the scene sets none). */
function worldsOf(projectDir: string, bake: FarBakeLevelM, farJobs: FarCacheJobs = inProcessFarJobs()): VoxelWorlds {
  const voxelWorld = bake === 2 ? { world: 'w' } : { world: 'w', bakeLevel: bake };
  return new VoxelWorlds({ projectDir: (id) => (id === 'p' ? projectDir : null), farJobs, scenes: () => [{ entities: [{ id: 'world-000001', components: { voxelWorld } }] }] });
}

/** Asks for the far cache until it is built and its fine bake (if any) has finished. */
async function baked(worlds: VoxelWorlds): Promise<void> {
  for (let i = 0; i < 2000; i++) {
    const r = await worlds.farInfo('p', 'w');
    if (r.ok && (r.fine === undefined || (!r.fine.baking && r.fine.levels.every((l) => l.done === l.total)))) return;
    await new Promise((ok) => setTimeout(ok, 10));
  }
  throw new Error('the fine bake did not finish');
}

/** The streamer's read of the world: its chunks as a store exports them (what a page's fine block is gathered from). */
const streamed = (s: PaletteStore): ChunkCells => (cx, cy, cz, out) => s.exportChunk(cx, cy, cz, out);

/** The fine builder's bricks of a node's block, as the page checks its GPU build against them; null: it draws nothing. */
function oracle(s: PaletteStore, level: number, nx: number, ny: number, nz: number): Uint8Array | null {
  const packed = packFarFine(gatherFarCells(grid, streamed(s), [nx, ny, nz], 2 ** level, true));
  if (packed === null) return null;
  const cpu = farBricksFromBlock(grid, unpackFarFine(packed));
  return farBrickCount(cpu) === 0 ? null : encodeFarBricks({ ...cpu, occlusion: farBrickOcclusion(cpu) });
}

const bytesOf = (e: RegionEntry): Uint8Array => {
  if ('uniform' in e) throw new Error('a baked node is never uniform');
  return e.raw ? e.stored : zstdDecompress(e.stored);
};

/** Every fine node of `level` over the world's chunks, with the oracle's bytes where it draws something. */
function oracleLevel(s: PaletteStore, level: number): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const S = 2 ** level;
  const lo = Math.floor(-HALF / grid.edge / S), hi = Math.floor((HALF / grid.edge - 1) / S);
  for (let nx = lo; nx <= hi; nx++) for (let nz = lo; nz <= hi; nz++) for (let ny = 0; ny <= Math.floor(1 / S); ny++) {
    const b = oracle(s, level, nx, ny, nz);
    if (b !== null) out.set(mipNodeKey({ level, nx, ny, nz }), b);
  }
  return out;
}

const DIG = { v: 2, grid: 0, kind: 'fill', min: [20, 10, -30], max: [50, 30, 10], mode: 'dig' } as const;

describe('fine far levels baked by a world', () => {
  it('stores level 1 for a 1 m world and levels 1 and 0 for a 0.5 m world, every node the fine builder’s bricks of its block', async () => {
    for (const [name, bake, levels] of [
      ['one-metre', 1, [1]],
      ['half-metre', 0.5, [1, 0]],
    ] as const) {
      const { projectDir } = project(name);
      const worlds = worldsOf(projectDir, bake);
      await baked(worlds);
      const dir = farCacheDir(projectDir, 'w');
      const m = readFarCacheManifest(dir);
      expect(m.format).toBe(3);
      expect(m.fine?.bakeLevel).toBe(levels.at(-1));
      expect(m.fine?.levels.map((l) => l.level)).toEqual(levels);
      for (const level of [0, 1]) {
        const stored = farFineStored(dir, level);
        if (!(levels as readonly number[]).includes(level)) {
          expect(stored.size).toBe(0);
          continue;
        }
        const want = oracleLevel(store, level);
        expect(want.size).toBeGreaterThanOrEqual(level === 0 ? 16 : 4);
        expect([...stored.keys()].sort()).toEqual([...want.keys()].sort());
        for (const [k, e] of stored) expect(Buffer.from(bytesOf(e)).equals(Buffer.from(want.get(k)!)), k).toBe(true);
      }
      // The files are listed and served like the coarse levels' bricks.
      for (const l of m.fine!.levels) for (const f of l.regions) expect(farCacheFiles(dir)).toContain(`B${l.level}/${f}`);
      worlds.close();
    }
  });

  it('goes on after a bake stopped part way, baking only the columns it had not written, and ends as one that never stopped', async () => {
    const { projectDir, worldDir } = project('resume');
    const real = inProcessFarJobs();
    // A bake that stops (the backend stopped) after two columns have landed.
    let landed = 0;
    const stopping: FarCacheJobs = {
      ...real,
      bakeFine: (tasks) => ({
        async *[Symbol.asyncIterator]() {
          for await (const r of real.bakeFine(tasks)) {
            if (landed++ >= 2) throw new Error('stopped');
            yield r;
          }
        },
      }),
    };
    const first = worldsOf(projectDir, 0.5, stopping);
    for (let i = 0; i < 2000 && landed < 3; i++) {
      await first.farInfo('p', 'w');
      await new Promise((ok) => setTimeout(ok, 10));
    }
    const info = await first.farInfo('p', 'w');
    expect(info.ok && info.fine?.levels.reduce((s, l) => s + l.done, 0)).toBe(2);
    first.close();
    // Started again: only the columns not written are baked.
    const sent: number[] = [];
    const counting: FarCacheJobs = { ...real, bakeFine: (tasks) => (sent.push(tasks.length), real.bakeFine(tasks)) };
    const again = worldsOf(projectDir, 0.5, counting);
    await baked(again);
    const world = new FarWorldSource(worldDir);
    const all = farFineColumns(world, 1).length + farFineColumns(world, 0).length;
    expect(sent).toEqual([all - 2]);
    // Equal, file for file, to a bake that never stopped.
    const whole = project('resume-whole');
    await baked(worldsOf(whole.projectDir, 0.5));
    expect(filesOf(farCacheDir(projectDir, 'w'))).toEqual(filesOf(farCacheDir(whole.projectDir, 'w')));
    again.close();
  });

  it('answers a failed bake with why, starts it again on no far read, and goes on from its columns on a resume', async () => {
    const { projectDir } = project('failed');
    const real = inProcessFarJobs();
    let sent = 0;
    let full = true;
    const disk: FarCacheJobs = {
      ...real,
      bakeFine: (tasks) => {
        sent++;
        if (!full) return real.bakeFine(tasks);
        return {
          async *[Symbol.asyncIterator]() {
            let n = 0;
            for await (const r of real.bakeFine(tasks)) {
              if (n++ >= 1) throw new Error('ENOSPC: no space left on device, write');
              yield r;
            }
          },
        };
      },
    };
    const worlds = worldsOf(projectDir, 0.5, disk);
    let info = await worlds.farInfo('p', 'w');
    for (let i = 0; i < 2000 && !(info.ok && info.fine?.failed !== undefined); i++) {
      await new Promise((ok) => setTimeout(ok, 10));
      info = await worlds.farInfo('p', 'w');
    }
    expect(info.ok && info.fine?.failed).toMatch(/ENOSPC/);
    expect(info.ok && info.fine?.baking).toBe(false);
    expect(info.ok && info.fine?.levels.reduce((s, l) => s + l.done, 0)).toBe(1);
    // Far reads do not start it again into the same full disk.
    for (let i = 0; i < 5; i++) await worlds.farInfo('p', 'w');
    expect(sent).toBe(1);
    // Room again, resumed: it goes on from the column it wrote and ends baked, the failure gone.
    full = false;
    const resumed = await worlds.fineBakeControl('p', 'w', true);
    expect(resumed.ok && resumed.fine?.failed).toBeUndefined();
    await baked(worlds);
    const done = await worlds.farInfo('p', 'w');
    expect(done.ok && done.fine?.levels.every((l) => l.done === l.total)).toBe(true);
    expect(done.ok && done.fine?.failed).toBeUndefined();
    worlds.close();
  });

  it('builds again exactly the fine nodes over an edit, reuses them by content, and equals a fresh bake of the edited world', async () => {
    const { projectDir, worldDir } = project('edit');
    const worlds = worldsOf(projectDir, 0.5);
    await baked(worlds);
    const dir = farCacheDir(projectDir, 'w');
    const before = new Map([0, 1].flatMap((l) => [...farFineStored(dir, l)]));
    const r = await worlds.command('p', { op: 'editVoxels', projectId: 'p', args: { world: 'w', command: DIG } });
    expect(r.ok ? null : r.error).toBeNull();
    if (!r.ok) return;
    const dirty = farFineDirty(r.chunks.map(([cx, cy, cz]) => ({ cx, cy, cz })));
    const far = r.far as { fine?: { dirty: number; built: number; reused: number } };
    // Nodes reading the same chunks (all air past the world, all rock under it) share a content key: built once.
    expect(far.fine?.dirty).toBe(dirty.length);
    expect(far.fine!.built + far.fine!.reused).toBe(dirty.length);
    expect(far.fine!.built).toBeGreaterThan(0);
    // Only the dirty nodes changed; the rest of the fine levels kept their bytes.
    const dirtyKeys = new Set(dirty.map(mipNodeKey));
    const after = new Map([0, 1].flatMap((l) => [...farFineStored(dir, l)]));
    let changed = 0;
    for (const k of new Set([...before.keys(), ...after.keys()])) {
      const a = before.get(k), b = after.get(k);
      const same = a !== undefined && b !== undefined && Buffer.from(bytesOf(a)).equals(Buffer.from(bytesOf(b)));
      if (same) continue;
      changed++;
      expect(dirtyKeys.has(k), k).toBe(true);
    }
    expect(changed).toBeGreaterThan(0);
    // The cache equals a fresh build and bake of the edited world.
    const fresh = project('edit-fresh');
    rmSync(fresh.worldDir, { recursive: true, force: true });
    cpSync(worldDir, fresh.worldDir, { recursive: true });
    await baked(worldsOf(fresh.projectDir, 0.5));
    expect(filesOf(dir)).toEqual(filesOf(farCacheDir(fresh.projectDir, 'w')));
    // Undone, then the same dig again: the dig's nodes come back from the rebuilt store by their content.
    const u = await worlds.command('p', { op: 'undoVoxels', projectId: 'p', args: { world: 'w' } });
    const undone = u.ok ? (u.far as { fine?: { dirty: number; built: number; reused: number } }).fine : undefined;
    expect(undone!.dirty).toBe(dirty.length);
    expect(undone!.built + undone!.reused).toBe(dirty.length);
    const again = await worlds.command('p', { op: 'editVoxels', projectId: 'p', args: { world: 'w', command: DIG } });
    expect(again.ok && (again.far as { fine?: unknown }).fine).toMatchObject({ dirty: dirty.length, built: 0, reused: dirty.length });
    // A column landing while a bake runs builds again only its own nodes over the changes made meanwhile: the
    // columns' shares add up to the whole change's.
    const m = readFarCacheManifest(dir);
    const dug = r.chunks.map(([cx, cy, cz]) => ({ cx, cy, cz }));
    let shares = 0;
    for (const l of m.fine!.levels) for (const c of l.columns) {
      const [rx, rz] = c.split(',').map(Number) as [number, number];
      const one = rebakeFarFine(worldDir, dir, dug, { level: l.level, rx, rz });
      expect(one!.dirty).toBeLessThan(dirty.length);
      shares += one!.dirty;
    }
    expect(shares).toBe(dirty.length);
    worlds.close();
  });

  it('ships the fine levels the scenes ask, whole, and no finer; a world baked to 2 m ships none', async () => {
    const { projectDir } = project('ship');
    const fine = worldsOf(projectDir, 0.5);
    await baked(fine);
    const all = await fine.shippedFiles('p', 'w');
    expect(all.ok && all.far?.bakeLevel).toBe(0);
    const names = all.ok ? all.far!.files.map((f) => f.name) : [];
    expect(names.some((n) => n.startsWith('B0/'))).toBe(true);
    expect(names.some((n) => n.startsWith('B1/'))).toBe(true);
    // The catalog row takes it (fine bricks files below the kept levels, named by the bake level).
    const row = all.ok ? canonicalShippedVoxelWorld({ ...all.world, files: all.files, far: { minLevel: all.far!.minLevel, maxLevel: all.far!.maxLevel, files: all.far!.files, bakeLevel: all.far!.bakeLevel! } }) : null;
    expect(shippedVoxelWorldsProblem([row])).toBeNull();
    expect(shippedVoxelWorldsProblem([{ ...row!, far: { ...row!.far!, bakeLevel: undefined } }].map((w) => JSON.parse(JSON.stringify(w)) as unknown))).toMatch(/far\.files/);
    fine.close();
    // The same cache, now asked only to 1 m: level 0 stays home.
    const metre = worldsOf(projectDir, 1);
    const one = await metre.shippedFiles('p', 'w');
    expect(one.ok && one.far?.bakeLevel).toBe(1);
    expect(one.ok && one.far!.files.some((f) => f.name.startsWith('B0/'))).toBe(false);
    metre.close();
    const coarse = worldsOf(projectDir, 2);
    const none = await coarse.shippedFiles('p', 'w');
    expect(none.ok && none.far?.bakeLevel).toBeUndefined();
    expect(none.ok && none.far!.files.some((f) => /^B[01]\//.test(f.name))).toBe(false);
    coarse.close();
  });

  it('reads a format-2 cache, current for a world baked to 2 m, and refuses an unknown format', async () => {
    const { projectDir, worldDir } = project('format');
    const dir = farCacheDir(projectDir, 'w');
    await buildFarCache(worldDir, dir);
    const m = JSON.parse(readFileSync(join(dir, FAR_CACHE_MANIFEST), 'utf8')) as Record<string, unknown>;
    writeFileSync(join(dir, FAR_CACHE_MANIFEST), JSON.stringify({ ...m, format: 2 }));
    expect(readFarCacheManifest(dir).fine).toBeUndefined();
    expect(farCacheStale(dir, readVoxelWorldManifest(worldDir))).toBeNull();
    const coarse = worldsOf(projectDir, 2);
    const info = await coarse.farInfo('p', 'w');
    expect(info.ok && info.manifest.format).toBe(2);
    expect(info.ok && info.fine).toBeUndefined();
    coarse.close();
    writeFileSync(join(dir, FAR_CACHE_MANIFEST), JSON.stringify({ ...m, format: 4 }));
    expect(() => readFarCacheManifest(dir)).toThrow(/far cache format 4/);
  });
});
