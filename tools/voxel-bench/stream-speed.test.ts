/**
 * Streaming round a focus at racing speed (150 m/s) against real boundaries:
 * `worker_threads` workers running the bundled worker module, region files
 * on disk, a hilly test world with the world's rules derived. At speed the
 * load ring narrows (stream-ring.ts `speedRing`) and the pool takes the
 * chunks under and ahead of the focus first (stream-reads.ts
 * `motionDistance2`), so the ground under a fast camera is resident and
 * derived (what its collision is made of) soon after it arrives.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chunkGrid, createWorldStore, jobRadius, motionDistance2, speedRing, STREAM_FULL_RING_SPEED, STREAM_MIN_SPEED_RADIUS, VoxelStreamer, WorkerPool, WORLD_RULES, type PaletteStore, type StreamRing } from '@thirdlight/voxel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pickStore, surfaceY } from './regions';
import { bundleWorker, DiskRegions, nodePoolWorker, REPO, writeWorldRegions } from './stream-node';
import { hillyWorld } from './worlds';

const grid = chunkGrid(32);
/** A 512 m hilly square centred on the origin. */
const HALF = 512;
const world = hillyWorld({ footprint: 2 * HALF });
/** The default load ring (cells). */
const RING: StreamRing = { loadRadius: 384, unloadRadius: 448, loadHeight: 192, unloadHeight: 256, nearRadius: 192 };
/** 150 m/s in cells a second. */
const SPEED = 300;

let dir = '';
let workerFile = '';
let oracle: PaletteStore;
const closers: Array<() => unknown> = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tl-voxel-speed-'));
  workerFile = await bundleWorker('stream-worker-node', join(REPO, 'dist', 'voxel-bench', `stream-worker-speed-${process.pid}.mjs`));
  oracle = pickStore(grid);
  writeWorldRegions(world.grids[0]!, grid, join(dir, 'world'), 'stacked', 512, -HALF, -HALF, HALF, HALF, oracle);
}, 240_000);

afterAll(async () => {
  for (const c of closers) await c();
  rmSync(dir, { recursive: true, force: true });
  rmSync(workerFile, { force: true });
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('streaming at racing speed', () => {
  it('narrows the load ring with speed (whole chunks, never under the collision radius) and orders work along the way ahead', () => {
    expect(speedRing(RING, STREAM_FULL_RING_SPEED, 32)).toBe(RING);
    expect(speedRing(RING, 0, 32)).toBe(RING);
    // 60 m/s: a third of the radius (128 cells), whole chunks; the unload gap and heights kept.
    expect(speedRing(RING, 120, 32)).toEqual({ loadRadius: 128, unloadRadius: 192, loadHeight: 192, unloadHeight: 256, nearRadius: 128 });
    // 150 m/s: the floor.
    expect(speedRing(RING, SPEED, 32).loadRadius).toBe(STREAM_MIN_SPEED_RADIUS);
    for (let v = 41; v < 2000; v += 37) {
      const r = speedRing(RING, v, 32);
      expect(r.loadRadius % 32 === 0 || r.loadRadius === STREAM_MIN_SPEED_RADIUS).toBe(true);
      expect(r.loadRadius).toBeLessThanOrEqual(RING.loadRadius);
      expect(r.loadRadius).toBeGreaterThanOrEqual(STREAM_MIN_SPEED_RADIUS);
    }
    // Moving along +x with a lead 300 cells ahead: under the focus first, then ahead, the sides after, behind last.
    const f = { x: 16, y: 16, z: 16 }, lead = { x: 316, y: 16, z: 16 };
    const at = (cx: number, cz: number) => motionDistance2(grid, f, lead, cx, 0, cz);
    expect(at(0, 0)).toBeLessThan(at(3, 0));
    expect(at(3, 0)).toBeLessThan(at(9, 0));
    expect(at(9, 0)).toBeLessThan(at(3, 6));
    expect(at(3, 3)).toBeLessThan(at(-3, 0));
    // Still (no lead point): the plain distance.
    expect(motionDistance2(grid, f, f, 2, 0, 0)).toBe(64 * 64);
  });

  it('keeps the ground under a focus flying at 150 m/s resident and derived (real workers): the ring narrows in flight and widens when it stops, the ground under it is known within a second of stopping', async () => {
    const disk = new DiskRegions(join(dir, 'world'));
    closers.push(() => disk.close());
    const pool = new WorkerPool({ size: 4, create: () => nodePoolWorker(workerFile), timeoutMs: 10_000, maxQueued: 256 });
    closers.push(() => pool.close());
    const s = new VoxelStreamer({ store: createWorldStore(grid), source: disk.source(grid, 'stacked', 512), pool, ring: RING, budgetBytes: 512 * 1024 * 1024, dependencyRadius: jobRadius(WORLD_RULES), derive: true, rules: WORLD_RULES, sectionEdge: 32 });
    // 30 m over the ground under the line z = 0 (cells).
    const yAt = (x: number) => (surfaceY(oracle, Math.round(x), 0, 600, -200) ?? 0) + 60;
    const x0 = -HALF + 96, x1 = HALF - 96;
    s.setFocus(x0, yAt(x0), 0);
    await s.settle();
    const radii: number[] = [];
    const t0 = performance.now();
    let x = x0;
    while (x < x1) {
      x = Math.min(x1, x0 + (SPEED * (performance.now() - t0)) / 1000);
      s.setFocus(x, yAt(x), 0);
      s.update();
      radii.push(s.ring.loadRadius);
      await sleep(8);
    }
    const flight = s.metrics();
    // In flight the ring narrowed to the floor (after the velocity's smoothing), never to anything but whole chunks or the floor.
    expect(Math.min(...radii)).toBe(STREAM_MIN_SPEED_RADIUS);
    expect(radii.slice(-20).every((r) => r === STREAM_MIN_SPEED_RADIUS)).toBe(true);
    expect(flight.counters.speedRings).toBeGreaterThan(0);
    // Stopped: the ground under the focus is known within a second (updates every 8 ms); the ring is the base again once still.
    const missedBefore = s.metrics().coverage.groundMissing;
    const stop = performance.now();
    let knownAfterMs = -1;
    let lastMissed = missedBefore;
    while (performance.now() - stop < 3000) {
      s.update();
      const m = s.metrics().coverage.groundMissing;
      if (m === lastMissed && knownAfterMs < 0) knownAfterMs = performance.now() - stop;
      if (m !== lastMissed) knownAfterMs = -1;
      lastMissed = m;
      await sleep(8);
    }
    expect(knownAfterMs).toBeGreaterThanOrEqual(0);
    expect(knownAfterMs).toBeLessThan(1000);
    expect(s.ring.loadRadius).toBe(RING.loadRadius);
    console.log(`speed ${JSON.stringify({ updates: flight.coverage.updates, groundMissing: flight.coverage.groundMissing, aheadMissing: flight.coverage.aheadMissing, knownAfterMs: Math.round(knownAfterMs), speedRings: flight.counters.speedRings })}`);
  }, 120_000);
});
