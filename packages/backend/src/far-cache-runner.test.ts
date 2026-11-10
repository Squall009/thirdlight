/**
 * The voxel far cache's worker threads, run from the script the build puts
 * beside the backend bundle (what the deployment runs): a full build in the
 * worker writes the same files a build in this thread does, an edit's
 * rebuild there leaves the cache equal to a full build of the edited world,
 * the event loop keeps running while a build is under way, a job that
 * fails is answered as an error, and an export that stops waiting for a
 * build ships the world without its far cache with a warning saying so.
 */
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFarCache, farCacheDir, FAR_REBUILT_FOLDER, gridFolder, VoxelWorlds, writeVoxelWorldManifest } from '@thirdlight/workspace';
import { afterAll, describe, expect, it } from 'vitest';
import { shipVoxelWorlds } from '@thirdlight/exporter';
import { createFarCacheJobs } from './far-cache-runner';

const root = join(tmpdir(), `tl-far-cache-runner-${process.pid}-${Date.now().toString(36)}`);
const workerUrl = new URL('../../../dist/backend/far-cache-worker.mjs', import.meta.url);
const jobs = createFarCacheJobs(workerUrl);
afterAll(() => {
  jobs.close();
  rmSync(root, { recursive: true, force: true });
});

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

/** A project with one world, written by commands: stone ground with a raised block, over four region columns. */
async function project(): Promise<{ projectDir: string; worldDir: string }> {
  const projectDir = join(root, 'p');
  const worldDir = join(projectDir, 'voxels', 'w');
  // An empty world: its grid's folder, no region files yet.
  mkdirSync(join(worldDir, gridFolder(0)), { recursive: true });
  writeVoxelWorldManifest(worldDir, { worldId: 'a0112233445566778899aabbccddeeff', edge: 32, layout: 'stacked', footprint: 512 }, []);
  const worlds = new VoxelWorlds({ projectDir: (id) => (id === 'p' ? projectDir : null) });
  // Role 1 is terrain, as a command sends it.
  const stone = { material: 2, role: 1, wetness: 0 };
  const boxes = [
    { min: [-128, 0, -128], max: [127, 5, 127] },
    { min: [-40, 6, 10], max: [60, 30, 50] },
  ];
  for (const { min, max } of boxes) {
    const r = await worlds.command('p', { op: 'editVoxels', projectId: 'p', args: { world: 'w', command: { v: 2, grid: 0, kind: 'fill', min, max, mode: 'place', voxel: stone } } });
    expect(r.ok ? null : r.error).toBeNull();
  }
  return { projectDir, worldDir };
}

describe('the far cache worker', () => {
  it('builds and rebuilds in its thread exactly as this thread does, while the event loop runs', async () => {
    const { projectDir, worldDir } = await project();
    const inWorker = join(root, 'worker.building');
    let ticks = 0;
    const tick = setInterval(() => ticks++, 1);
    const t0 = performance.now();
    await jobs.build(worldDir, inWorker);
    const ms = performance.now() - t0;
    clearInterval(tick);
    const inThread = join(root, 'thread');
    await buildFarCache(worldDir, inThread);
    expect(filesOf(inWorker)).toEqual(filesOf(inThread));
    // The loop ran timers throughout (a build in this thread would hold it between columns).
    expect(ticks).toBeGreaterThan(Math.min(10, ms / 10));
    // An edit through the voxel world commands, its ancestors rebuilt in the worker before the command is answered.
    cpSync(inThread, farCacheDir(projectDir, 'w'), { recursive: true });
    const worlds = new VoxelWorlds({
      projectDir: (id) => (id === 'p' ? projectDir : null),
      farJobs: jobs,
    });
    const r = await worlds.command('p', {
      op: 'editVoxels',
      projectId: 'p',
      args: {
        world: 'w',
        command: {
          v: 2,
          grid: 0,
          kind: 'fill',
          min: [-30, 0, -30],
          max: [30, 20, 30],
          mode: 'dig',
        },
      },
    });
    expect(r.ok && r.far).toMatchObject({ nodes: expect.any(Number) });
    const fresh = join(root, 'fresh');
    await buildFarCache(worldDir, fresh);
    expect(filesOf(farCacheDir(projectDir, 'w'))).toEqual(filesOf(fresh));
  }, 60_000);

  it('answers a job that fails with its error', async () => {
    await expect(jobs.build(join(root, 'no-world'), join(root, 'no-world.building'))).rejects.toThrow(/world\.json|ENOENT/);
    await expect(jobs.rebuild(join(root, 'no-world'), join(root, 'no-cache'), [{ cx: 0, cy: 0, cz: 0 }])).rejects.toThrow();
  });

  it('lets an export ship a world whose far cache is still being built, without it and with a warning', async () => {
    const projectDir = join(root, 'export');
    cpSync(join(root, 'p'), projectDir, { recursive: true });
    rmSync(join(projectDir, 'cache'), { recursive: true, force: true });
    let release!: () => void;
    const gate = new Promise<void>((ok) => (release = ok));
    const held = {
      build: async (w: string, f: string) => {
        await jobs.build(w, f);
        await gate;
      },
      rebuild: jobs.rebuild,
      close: () => undefined,
    };
    const worlds = new VoxelWorlds({
      projectDir: (id) => (id === 'p' ? projectDir : null),
      farJobs: held,
      farExportWaitMs: 50,
    });
    const port = { files: (p: string, w: string) => worlds.shippedFiles(p, w) };
    const early = await shipVoxelWorlds(port, 'p', ['w']);
    expect(early.ok && early.notes).toEqual([
      {
        code: 'voxel_far_cache_building',
        message: expect.stringContaining('ships without its far field'),
      },
    ]);
    expect(early.ok && early.worlds[0]!.far).toBeUndefined();
    release();
    // Once the build has landed the export ships the far cache.
    for (let i = 0; i < 300 && !(await worlds.farInfo('p', 'w')).ok; i++) await new Promise((ok) => setTimeout(ok, 50));
    const later = await shipVoxelWorlds({ files: (p, w) => worlds.shippedFiles(p, w) }, 'p', ['w']);
    expect(later.ok && later.notes).toEqual([]);
    expect(later.ok && later.worlds[0]!.far?.files.length).toBeGreaterThan(0);
  }, 60_000);
});
