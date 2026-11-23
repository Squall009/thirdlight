/**
 * A page's far field after an edit, against a real backend over HTTP: the backend answers the command before it
 * builds the far cache under it, so the world a page opened (RangeWorld, as the voxel world page, the Scene view and
 * Play open one) reads the far nodes over the change again once that rebuild has landed, and nothing else: the near
 * refresh is the edit's own, once.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createTestBackend, testTempBase } from '@thirdlight/backend/testing';
import type { Backend } from '@thirdlight/backend/services';
import { chunkGrid, createWorldStore, type ChunkCoord, type VoxelStreamer } from '@thirdlight/voxel';
import { FAR_REBUILT_FOLDER, farCacheDir, writeVoxelWorld } from '@thirdlight/workspace';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RangeWorld, type WorldChange } from '../../../packages/editor/src/voxel-world/range-world';
import { flatGround } from '../../../tools/voxel-bench/scenes';

const ORIGIN = 'http://127.0.0.1:8513';
const TOKEN = 'far-page-token';
const PROJECT = 'farpage';
const WORLD = 'ground';
const WORLD_ID = '1f2e3d4c5b6a79889786a5b4c3d2e1f0';
const grid = chunkGrid(32);

let root = '';
let backend: Backend;
let teardown: () => Promise<void>;
let worldDir = '';
const opened: RangeWorld[] = [];

const base = (): string => `http://127.0.0.1:${backend.portAuthoring}`;
const auth = { authorization: `Bearer ${TOKEN}` };
const worldUrl = (): string => `${base()}/api/v1/projects/${PROJECT}/voxels/${WORLD}`;

const dig = async (x: number, z: number): Promise<{ status: number; json: Record<string, unknown> }> => {
  const r = await fetch(`${base()}/api/v1/projects/${PROJECT}/commands`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ op: 'editVoxels', projectId: PROJECT, requestId: `req-${randomBytes(16).toString('hex')}`, args: { world: WORLD, command: { v: 2, grid: 0, kind: 'brush', shape: 'sphere', size: [2, 2, 2], points: [x, -5, z], mode: 'dig', smooth: false } } }),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
};

/** The far info once the cache is current (a whole build is waited for). */
async function farInfo(): Promise<Record<string, unknown>> {
  for (let i = 0; i < 600; i++) {
    const r = await fetch(`${worldUrl()}/far`, { headers: auth });
    if (r.status === 200) return (await r.json()) as Record<string, unknown>;
    await new Promise((ok) => setTimeout(ok, 100));
  }
  throw new Error('the far cache never became current');
}

/** Every far cache file by path, with its hash (the store of rebuilt contents aside). */
function farState(): Record<string, string> {
  const dir = farCacheDir(backend._test.service.projectDir(PROJECT)!, WORLD);
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (e.name !== FAR_REBUILT_FOLDER) walk(p);
      } else out[relative(dir, p)] = createHash('sha256').update(readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

/**
 * What a streamer is asked by the world: the near refreshes (an edit's chunks read again and derived) and the far
 * field's (its nodes read again), each with the far cache's files as they were at that moment.
 */
function recordingStreamer(): { streamer: VoxelStreamer; near: ChunkCoord[][]; far: Array<{ chunks: ChunkCoord[]; cache: Record<string, string> }> } {
  const near: ChunkCoord[][] = [];
  const far: Array<{ chunks: ChunkCoord[]; cache: Record<string, string> }> = [];
  const streamer = {
    refresh: (chunks: readonly ChunkCoord[]) => {
      near.push([...chunks]);
      return 1;
    },
    far: { refresh: (chunks: readonly ChunkCoord[]) => far.push({ chunks: [...chunks], cache: farState() }) },
  };
  return { streamer: streamer as unknown as VoxelStreamer, near, far };
}

/** A world opened as a page opens one (its pool's workers are stand-ins: nothing here is decoded). */
async function openWorld(): Promise<RangeWorld> {
  const w = await RangeWorld.open({ url: worldUrl(), headers: auth, workerUrl: 'stand-in.js', workers: 1 });
  opened.push(w);
  return w;
}

const keys = (cs: readonly ChunkCoord[]): string[] => cs.map((c) => `${c.cx},${c.cy},${c.cz}`).sort();

beforeAll(async () => {
  // The world's pool starts module workers; no derive runs here, so a stand-in answers nothing.
  (globalThis as unknown as { Worker: unknown }).Worker = class {
    postMessage(): void {}
    addEventListener(): void {}
    terminate(): void {}
  };
  root = mkdtempSync(join(testTempBase(), 'tl-voxel-far-page-'));
  const tb = await createTestBackend({ dataRoot: join(root, 'data'), authoringOrigin: ORIGIN, previewOrigin: 'http://127.0.0.1:8514', authoringOrigins: [ORIGIN], tokens: [{ token: TOKEN, scope: `authoring:${PROJECT}` }] });
  backend = tb.backend;
  teardown = tb.teardown;
  expect(backend._test.service.createProject(PROJECT, 'Far page').ok).toBe(true);
  worldDir = join(backend._test.service.projectDir(PROJECT)!, 'voxels', WORLD);
  const s = createWorldStore(grid);
  flatGround(s, -48, 48, -48, 48, 6, -3);
  writeVoxelWorld(worldDir, { worldId: WORLD_ID, edge: 32, layout: 'stacked', footprint: 512 }, s);
}, 60_000);

afterAll(async () => {
  for (const w of opened) w.pool.close();
  await teardown();
  rmSync(root, { recursive: true, force: true });
}, 60_000);

describe("a page's far field after an edit", () => {
  it('reads the far nodes over an edit again once its deferred rebuild landed, a burst of edits once, and derives nothing near for it', async () => {
    await farInfo();
    const world = await openWorld();
    // The far field reads the cache's index (what a page does when it first draws far).
    await world.far.index();
    const { streamer, near, far } = recordingStreamer();
    const before = farState();

    const a = await dig(3, 3);
    expect(a.status, JSON.stringify(a.json)).toBe(200);
    expect(a.json['far']).toMatchObject({ queued: expect.any(Number) });
    world.applyChange(streamer, a.json as unknown as WorldChange);
    // The edit's own near refresh, at once; the far nodes wait for the rebuild.
    expect(near).toHaveLength(1);
    expect(far).toHaveLength(0);
    await world.farCurrent();
    expect(far).toHaveLength(1);
    expect(keys(far[0]!.chunks)).toEqual(keys(near[0]!));
    // Read again from the rebuilt cache: its files had changed when the far field was told.
    expect(far[0]!.cache).not.toEqual(before);
    expect(far[0]!.cache).toEqual(farState());
    expect(near).toHaveLength(1);

    // Three edits in a burst: three near refreshes, one far re-read of all their chunks.
    const burst: Array<Record<string, unknown>> = [];
    for (const x of [-9, -5, 7]) {
      const r = await dig(x, -7);
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      burst.push(r.json);
      world.applyChange(streamer, r.json as unknown as WorldChange);
    }
    await world.farCurrent();
    expect(near).toHaveLength(4);
    expect(far).toHaveLength(2);
    expect(keys(far[1]!.chunks)).toEqual([...new Set(near.slice(1).flatMap((c) => keys(c)))].sort());
    expect(far[1]!.cache).toEqual(farState());
  }, 120_000);

  it('a world whose far field never read the cache asks nothing of it after an edit', async () => {
    const world = await openWorld();
    const { streamer, near, far } = recordingStreamer();
    const r = await dig(11, 11);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    world.applyChange(streamer, r.json as unknown as WorldChange);
    await world.farCurrent();
    expect(near).toHaveLength(1);
    expect(far).toHaveLength(0);
  }, 60_000);
});
