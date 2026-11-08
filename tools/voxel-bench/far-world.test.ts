/**
 * The far world and its far cache at real boundaries: region files written
 * column by column in `worker_threads` workers and read back from disk, the
 * far cache built from them in workers and in one thread (byte for byte the
 * same), far data over every part of the world, an edit through the
 * workspace's voxel world commands rebuilding exactly its ancestors (the
 * result byte for byte a full build), and the town's doors and windows
 * closed at levels 1 and 2 (no "legs" under far front walls).
 */
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildFarNode, farAncestors, FarSelection, localIndex, mipNodeKey, valueRole, VOXEL_ROLE, type FarCells, type MipNode } from '@thirdlight/voxel';
import { buildFarCache, FarCacheReader, FarWorldSource, openShippedWorld, rebuildFarCache, VoxelWorlds } from '@thirdlight/workspace';
import { farWorldColumns, farWorldDirs, writeFarWorldColumn, FAR_WORLD_GRID } from './far-world';
import { buildFarCacheInPool, FarPool, PIXELS_PER_RADIAN_720P, writeFarWorld } from './far-world-run';
import { bundleWorker, REPO } from './stream-node';

const root = join(tmpdir(), `tl-far-world-${process.pid}-${Date.now().toString(36)}`);
const projectDir = join(root, 'p');
/** 512 m: four region columns, the town at the centre and rolling ground round it (the mountains need kilometres). */
const SIZE_KM = 0.5;
let pool: FarPool;
let worldDir: string;

/** Every file under a folder, relative path → base64. */
function filesOf(dir: string, sub = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of readdirSync(join(dir, sub), { withFileTypes: true })) {
    const rel = sub === '' ? e.name : `${sub}/${e.name}`;
    if (e.isDirectory()) Object.assign(out, filesOf(dir, rel));
    else out[rel] = readFileSync(join(dir, rel)).toString('base64');
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
    const editedWorld = join(p, 'voxels', 'far');
    const report = rebuildFarCache(editedWorld, cache, chunks);
    const ancestors = farAncestors(chunks, built.manifest.minLevel, built.manifest.maxLevel);
    expect(report.rebuilt.map(mipNodeKey)).toEqual(ancestors.map(mipNodeKey));
    // One level-2 to level-5 chain per distinct ancestor; only the files holding them were written.
    const after = filesOf(cache);
    for (const f of Object.keys(after)) if (f !== 'far.json' && !report.files.includes(f)) expect(after[f], f).toBe(before[f]);
    expect(report.files.length).toBeLessThanOrEqual(ancestors.length);
    expect(report.files.some((f) => after[f] !== before[f])).toBe(true);
    // The rebuilt cache equals one built from scratch from the edited world.
    const fresh = join(root, 'cache-fresh');
    await buildFarCache(editedWorld, fresh);
    expect(after).toEqual(filesOf(fresh));
  }, 120_000);

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
