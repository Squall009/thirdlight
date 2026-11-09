/**
 * When the runtime's voxel world lets a body stand on its ground, at real
 * boundaries: the runtime's world host streaming region files on disk
 * through `worker_threads` workers running the bundled worker, its chunk
 * bodies in the engine's Rapier port. A chunk's first `chunk` event comes
 * with the sections that could derive; one whose apron reaches a chunk not
 * loaded yet waits. Here a neighbour's load is held, so the chunk under
 * the point has had its event and a body while the sections next to that
 * neighbour (the ground under the point) have none: the column must not
 * count as settled until they do, or a body let go there falls through.
 * (A section waiting for a chunk that is not coming, at the load ring's
 * edge, counts as the world's edge, as it is drawn.)
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createPhysicsPort3D } from '@thirdlight/physics-rapier';
import { VoxelWorldHost, type VoxelHostEvents } from '@thirdlight/runtime';
import { chunkGrid, createWorldStore, VOXEL_SIZE_M, WorkerPool, type JobRequest, type PoolWorker, type VoxelRecord, type VoxelStreamer } from '@thirdlight/voxel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bundleWorker, DiskRegions, nodePoolWorker, REPO, TEST_WORLD_ID, writeWorldRegions } from './stream-node';
import { hillyWorld } from './worlds';

const grid = chunkGrid(32);
const HALF = 128;
let dir = '';
let workerFile = '';
/** The ground's top cell (y) at the column tested. */
let groundY = 0;
/** The column tested (cells): the last cell of chunk 0 along x, next to chunk 1, whose load is held. */
const X = 31;
const Z = 4;

beforeAll(async () => {
  const base = join(REPO, 'dist', 'voxel-bench');
  dir = mkdtempSync(join(base, 'collision-ready-'));
  workerFile = await bundleWorker('stream-worker-node', join(base, `collision-ready-worker-${process.pid}.mjs`));
  const oracle = createWorldStore(grid);
  writeWorldRegions(hillyWorld({ footprint: 2 * HALF }).grids[0]!, grid, join(dir, 'world'), 'stacked', 512, -HALF, -HALF, HALF, HALF, oracle);
  const v: VoxelRecord = { material: 0, role: 0, shape: 0, wetness: 0 };
  for (groundY = 200; groundY > -200 && oracle.voxelAt(X, groundY, Z, v).material === 0; groundY--);
}, 120_000);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(workerFile, { force: true });
});

/** A worker whose load replies for chunks `held` names wait in `queue` until the test lets them go. */
function gatedWorker(held: (m: JobRequest) => boolean, queue: Array<() => void>): PoolWorker {
  const w = nodePoolWorker(workerFile);
  const ids = new Set<number>();
  return {
    post: (m, t) => {
      if (held(m)) ids.add(m.id);
      w.post(m, t);
    },
    listen: (onMessage, onError) =>
      w.listen((d) => {
        if (ids.has((d as { id: number }).id)) queue.push(() => onMessage(d));
        else onMessage(d);
      }, onError),
    terminate: () => w.terminate(),
  };
}

const events: VoxelHostEvents = { changed: () => undefined, answered: () => undefined, nextWait: () => 0, saved: () => undefined, nextSave: () => 0, mismatch: () => undefined, warn: (m) => console.warn(m) };

describe('a voxel world under a body', () => {
  it('counts a column settled only once every section of its chunks has its result, not at a chunk’s first event', async () => {
    const r = await createPhysicsPort3D({
      character: { position: { x: 0, y: 0, z: 0 }, radius: 0.3, halfHeight: 0.5, offset: { x: 0, y: 0.8, z: 0 } },
      noCharacter: true,
      statics: [],
      solver: { hz: 60, gravityY: -9.81 },
      controller: { offsetSkin: 0.01, groundSnap: 0.1, maxSlopeClimbRad: 0.8, minSlopeSlideRad: 0.9, autostep: false },
    });
    if (!r.ok) throw new Error(r.error.message);
    const cy = Math.floor(groundY / grid.edge);
    const queue: Array<() => void> = [];
    // The chunk beside the ground's chunk (+x): its load is held (its worker stays busy with it, so the pool has spares).
    const holds = (m: JobRequest): boolean => {
      if (m.kind !== 'load') return false;
      const c = (m.input as { chunk?: { cx: number; cy: number; cz: number } }).chunk;
      return c !== undefined && c.cx === 1 && c.cy === cy && c.cz === 0;
    };
    const disk = new DiskRegions(join(dir, 'world'));
    // The chunks that have had their first `chunk` event (what the host marks derived).
    const chunkEvents = new Set<string>();
    let streamer: VoxelStreamer | null = null;
    const host = new VoxelWorldHost(
      { world: 'w', ring: { loadRadius: 32, loadHeight: 32 }, collision: { radius: 16, height: 16 } } as never,
      null,
      {
        open: async () => ({
          grid,
          worldId: TEST_WORLD_ID,
          source: disk.source(grid, 'stacked', 512),
          pool: new WorkerPool({ size: 4, create: () => gatedWorker(holds, queue), timeoutMs: 60_000, maxQueued: 256 }),
          present: (s) => {
            streamer = s;
            s.on((e) => {
              if (e.type === 'chunk') chunkEvents.add(`${e.cx},${e.cy},${e.cz}`);
            });
          },
        }),
      },
      r.port,
      events,
      () => 0,
    );
    const at: [number, number, number] = [(X + 0.5) * VOXEL_SIZE_M, (groundY + 2) * VOXEL_SIZE_M, (Z + 0.5) * VOXEL_SIZE_M];
    const step = (): void => host.step({ stream: at, collide: [at] });
    const until = async (what: string, ok: () => boolean, ms = 30_000): Promise<void> => {
      const t0 = performance.now();
      while (!ok()) {
        if (performance.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
        step();
        await new Promise((d) => setTimeout(d, 5));
      }
    };
    // The column's chunks have all had their first event (the ground chunk's sections next to chunk 1 wait on it).
    await until('the world to open', () => streamer !== null);
    await until('the ground chunk’s first event, with chunk 1 held', () => chunkEvents.has(`0,${cy},0`) && queue.length > 0);
    for (let i = 0; i < 30; i++) step();
    expect(streamer!.isResident(1, cy, 0)).toBe(false);
    expect(streamer!.chunkReady(0, cy, 0)).toBe(false);
    // The column is not settled: the ground under the point is in a section still waiting.
    expect(host.collisionReadyAt(at[0], at[2])).toBe(false);
    // Chunk 1 lands: every section derives, and the column settles on the ground's body.
    for (const go of queue.splice(0)) go();
    await until('the column to settle', () => host.collisionReadyAt(at[0], at[2]));
    expect(streamer!.chunkReady(0, cy, 0)).toBe(true);
    // The ground under the point collides now, at the ground's top (within a cell: the terrain mesher's slopes).
    const top = at[1] + 4;
    const hit = r.port.raycast({ x: at[0], y: top, z: at[2] }, { x: 0, y: -1, z: 0 }, 20);
    expect(hit).not.toBeNull();
    expect(Math.abs(top - hit!.distance - (groundY + 1) * VOXEL_SIZE_M)).toBeLessThanOrEqual(VOXEL_SIZE_M);
    host.dispose();
    await disk.close();
  }, 120_000);
});
