/**
 * A voxel world's far cache built in the background, with real region
 * files and far caches on disk: while a full build is under way the
 * world's commands are answered (they do not wait for it), its far route
 * says `far_cache_building`, and an export that stops waiting ships the
 * world without the far cache and says why; once the build lands, the
 * changes made meanwhile are built into it, so the cache equals a full
 * build of the edited world byte for byte, and the export ships it.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chunkGrid, createWorldStore, VOXEL_ROLE } from '@thirdlight/voxel';
import { afterAll, describe, expect, it } from 'vitest';
import { buildFarCache, farCacheDir, swapFarCache } from './voxel-far-cache';
import { inProcessFarJobs, type FarCacheJobs } from './voxel-far-jobs';
import { FAR_REBUILT_FOLDER } from './voxel-far-bake';
import { VoxelWorlds, writeVoxelWorld } from './voxel-worlds';

const grid = chunkGrid(32);
const root = join(tmpdir(), `tl-voxel-far-jobs-${process.pid}-${Date.now().toString(36)}`);
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Every file under a folder, relative path → base64. */
function filesOf(dir: string, sub = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of readdirSync(join(dir, sub), { withFileTypes: true })) {
    const rel = sub === '' ? e.name : `${sub}/${e.name}`;
    // The rebuilt store remembers edits' bricks by content; it is not part of the cache a build makes.
    if (rel === FAR_REBUILT_FOLDER) continue;
    if (e.isDirectory()) Object.assign(out, filesOf(dir, rel));
    else out[rel] = readFileSync(join(dir, rel)).toString('base64');
  }
  return out;
}

/** A project with one world of stone ground over four region columns. */
function project(name: string): { projectDir: string; worldDir: string } {
  const projectDir = join(root, name);
  const worldDir = join(projectDir, 'voxels', 'w');
  mkdirSync(worldDir, { recursive: true });
  const s = createWorldStore(grid);
  const v = { material: 2, role: VOXEL_ROLE.terrain, shape: 15, wetness: 0 };
  for (let x = -96; x < 96; x++) for (let z = -96; z < 96; z++) for (let y = 0; y < 6; y++) s.setVoxel(x, y, z, v);
  writeVoxelWorld(
    worldDir,
    {
      worldId: 'a0112233445566778899aabbccddeeff',
      edge: 32,
      layout: 'stacked',
      footprint: 512,
    },
    s,
  );
  return { projectDir, worldDir };
}

/** The real far jobs, with a full build held after it has read the world until `release`. */
function heldJobs(): {
  jobs: FarCacheJobs;
  built: Promise<void>;
  release: () => void;
} {
  const real = inProcessFarJobs();
  let release!: () => void;
  const gate = new Promise<void>((ok) => (release = ok));
  let builtOk!: () => void;
  const built = new Promise<void>((ok) => (builtOk = ok));
  const jobs: FarCacheJobs = {
    build: async (worldDir, fresh) => {
      await real.build(worldDir, fresh);
      builtOk();
      await gate;
    },
    rebuild: (...a) => real.rebuild(...a),
    bakeFine: (tasks) => real.bakeFine(tasks),
    close: () => undefined,
  };
  return { jobs, built, release };
}

const DIG = {
  v: 2,
  grid: 0,
  kind: 'fill',
  min: [-20, 3, -20],
  max: [20, 5, 20],
  mode: 'dig',
};

describe('a far cache built in the background', () => {
  it('answers commands and exports while it builds, then lands with their changes built in', async () => {
    const { projectDir, worldDir } = project('held');
    const held = heldJobs();
    const worlds = new VoxelWorlds({
      projectDir: (id) => (id === 'p' ? projectDir : null),
      farJobs: held.jobs,
      farExportWaitMs: 20,
    });
    const first = await worlds.farInfo('p', 'w');
    expect(first.ok === false && first.error.code).toBe('far_cache_building');
    // The build has read the world as it was; the dig lands while it is held.
    await held.built;
    const r = await worlds.command('p', {
      op: 'editVoxels',
      projectId: 'p',
      args: { world: 'w', command: DIG },
    });
    expect(r.ok).toBe(true);
    expect(r.ok && r.far).toMatchObject({
      stale: expect.stringContaining('being built'),
    });
    const during = await worlds.farInfo('p', 'w');
    expect(during.ok === false && during.error.code).toBe('far_cache_building');
    // An export that stops waiting ships the world's region files without the far cache, and says so.
    const early = await worlds.shippedFiles('p', 'w');
    expect(early.ok).toBe(true);
    if (!early.ok) return;
    expect(early.files.length).toBeGreaterThan(0);
    expect(early.far).toBeUndefined();
    expect(early.farNote).toMatch(/ships without its far field/);
    // Landed: current with the world's revision, and equal to a full build of the edited world.
    held.release();
    let after = await worlds.farInfo('p', 'w');
    for (let i = 0; i < 100 && !after.ok; i++) {
      await new Promise((ok) => setTimeout(ok, 20));
      after = await worlds.farInfo('p', 'w');
    }
    expect(after.ok && after.manifest.revision).toBe(r.ok ? r.revision : -1);
    const fresh = join(root, 'held-fresh');
    await buildFarCache(worldDir, fresh);
    expect(filesOf(farCacheDir(projectDir, 'w'))).toEqual(filesOf(fresh));
    const shipped = await worlds.shippedFiles('p', 'w');
    expect(shipped.ok && shipped.farNote).toBeUndefined();
    expect(shipped.ok && shipped.far?.files.length).toBeGreaterThan(0);
    // A later edit rebuilds the landed cache's ancestors before it is answered.
    const r2 = await worlds.command('p', {
      op: 'undoVoxels',
      projectId: 'p',
      args: { world: 'w' },
    });
    expect(r2.ok && r2.far).toMatchObject({ nodes: expect.any(Number) });
    const fresh2 = join(root, 'held-fresh-2');
    await buildFarCache(worldDir, fresh2);
    expect(filesOf(farCacheDir(projectDir, 'w'))).toEqual(filesOf(fresh2));
  });

  it('swaps a cache in whole and leaves no old or half-built folder beside it', () => {
    const dir = join(root, 'swap');
    mkdirSync(join(dir, 'cache'), { recursive: true });
    mkdirSync(join(dir, 'cache.building'), { recursive: true });
    mkdirSync(join(dir, 'cache.old'), { recursive: true });
    swapFarCache(join(dir, 'cache.building'), join(dir, 'cache'));
    expect(readdirSync(dir).sort()).toEqual(['cache']);
  });
});
