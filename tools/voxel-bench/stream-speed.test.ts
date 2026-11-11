/**
 * Streaming round a focus at racing speed (150 m/s) against real boundaries:
 * `worker_threads` workers running the bundled worker module, region files
 * on disk, a hilly test world with the world's rules derived. At speed the
 * load ring narrows (stream-ring.ts `speedRing`) and the pool takes the
 * chunks under and ahead of the focus first (stream-reads.ts
 * `motionDistance2`). Checked in counts: the ring narrows in flight, every
 * update counts the ground under the focus, and once stopped the ground
 * under it (what its collision is made of) is resident and derived after a
 * small share of the jobs that refill the ring. How often the ground is
 * missing while flying is the coverage bench's to report (`run.mjs coverage`).
 * Past STREAM_DETAIL_SPEED level 0 is held back: no level-0 derive is sent for
 * a chunk outside the collision ring of the focus, the levels drawn add level
 * 0 only as a stand-in beside the focus, and once the speed has stayed down
 * level 0 comes back by swaps nearest the focus first.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chunkGrid, chunkNearFoci, createWorldStore, jobRadius, levelNodeDistance, motionDistance2, speedRing, STREAM_FULL_RING_SPEED, STREAM_MIN_SPEED_RADIUS, VoxelStreamer, WorkerPool, WORLD_RULES, type Focus, type LevelNode, type PaletteStore, type PoolJob, type StreamRing } from '@thirdlight/voxel';
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

  it('narrows the ring in flight at 150 m/s and counts the ground under the focus every update (real workers); stopped, the ground under it is known before a tenth of the refill\'s work, then the ring widens back', async () => {
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
    const c0 = s.metrics().coverage;
    let updates = 0;
    // The flight runs in real time: the focus's speed is read from it, and the workers run beside it.
    const t0 = performance.now();
    let x = x0;
    while (x < x1) {
      x = Math.min(x1, x0 + (SPEED * (performance.now() - t0)) / 1000);
      s.setFocus(x, yAt(x), 0);
      s.update();
      updates++;
      radii.push(s.ring.loadRadius);
      await sleep(8);
    }
    const flight = s.metrics();
    // In flight the ring narrowed to the floor (after the velocity's smoothing), never to anything but whole chunks or the floor.
    expect(Math.min(...radii)).toBe(STREAM_MIN_SPEED_RADIUS);
    expect(radii.slice(-20).every((r) => r === STREAM_MIN_SPEED_RADIUS)).toBe(true);
    expect(flight.counters.speedRings).toBeGreaterThan(0);
    // Every update counted the ground under the focus and its lead point. How often it was missing in flight is the
    // coverage bench's to report (`run.mjs coverage`): the share reads how fast this host's workers ran beside it.
    const inFlight = { updates: flight.coverage.updates - c0.updates, groundMissing: flight.coverage.groundMissing - c0.groundMissing, aheadMissing: flight.coverage.aheadMissing - c0.aheadMissing, outOfReach: flight.coverage.outOfReach - c0.outOfReach };
    expect(inFlight.updates).toBe(updates);
    expect(inFlight.groundMissing + inFlight.outOfReach).toBeLessThanOrEqual(inFlight.updates);
    expect(inFlight.aheadMissing).toBeLessThanOrEqual(inFlight.updates);
    // Stopped: the chunks under the focus come before the rest of the ring (nearest first along no motion), so the
    // ground under it is known after a small share of the work that fills the widened ring. Counted in jobs done
    // (loads and derives), not in time.
    const work = (): number => s.counters.loads + s.counters.derives;
    const w0 = work();
    let knownAt = -1;
    // Until the focus has no speed left (its smoothing reads the clock) and the ring is the base again; the count of
    // updates only guards a hang.
    for (let i = 0; i < 5000 && (knownAt < 0 || s.ring.loadRadius !== RING.loadRadius); i++) {
      const missed = s.metrics().coverage.groundMissing;
      s.update();
      if (knownAt < 0 && s.metrics().coverage.groundMissing === missed) knownAt = work() - w0;
      await sleep(8);
    }
    expect(s.ring.loadRadius).toBe(RING.loadRadius);
    await s.settle();
    const refill = work() - w0;
    expect(knownAt, 'the ground under the stopped focus is known').toBeGreaterThanOrEqual(0);
    expect(refill).toBeGreaterThan(0);
    expect(knownAt, `ground known after ${knownAt} of the refill's ${refill} jobs`).toBeLessThan(refill / 10);
    console.log(`speed ${JSON.stringify({ ...inFlight, knownAfterJobs: knownAt, refillJobs: refill, speedRings: flight.counters.speedRings })}`);
  }, 120_000);
  it('holds level 0 back at 150 m/s: no level-0 derive past the collision ring, level 0 drawn only as a stand-in beside the focus; stopped, it comes back nearest first (real workers)', async () => {
    const disk = new DiskRegions(join(dir, 'world'));
    closers.push(() => disk.close());
    const pool = new WorkerPool({ size: 4, create: () => nodePoolWorker(workerFile), timeoutMs: 10_000, maxQueued: 256 });
    closers.push(() => pool.close());
    const s = new VoxelStreamer({ store: createWorldStore(grid), source: disk.source(grid, 'stacked', 512), pool, ring: RING, budgetBytes: 512 * 1024 * 1024, dependencyRadius: jobRadius(WORLD_RULES), derive: true, rules: WORLD_RULES });
    expect(s.mips).not.toBeNull();
    let focus: Focus = { x: 0, y: 0, z: 0 };
    // Every level-0 derive job sent while level 0 is held, against the collision ring round the focus it was sent at.
    let held = 0;
    let outside = 0;
    const submit = pool.submit.bind(pool);
    pool.submit = ((job: PoolJob) => {
      const input = job.input as { chunk?: { cx: number; cy: number; cz: number }; level?: number };
      if (job.kind === 'derive' && input.level === undefined && s.detail.held && input.chunk !== undefined) {
        held++;
        const b = s.detail.bounds;
        if (!chunkNearFoci(grid, [focus], input.chunk.cx, input.chunk.cy, input.chunk.cz, b.keepRadius, b.keepHeight)) outside++;
      }
      return submit(job);
    }) as typeof pool.submit;
    // Level-0 nodes the level choice adds, held or not, with their distance from the focus then.
    // A swap being built when the hold begins was chosen before it (one swap is built at a time, and shown whole):
    // its level 0 counts as chosen unheld.
    const added: Array<{ held: boolean; d: number }> = [];
    let heldSwaps = 0;
    s.on((e) => {
      if (e.type !== 'levels' || e.reason !== 'swap') return;
      const held = s.detail.held && heldSwaps++ > 0;
      for (const n of e.added as readonly LevelNode[]) if (n.level === 0) added.push({ held, d: levelNodeDistance(grid, [focus], n) });
      if (!s.detail.held) heldSwaps = 0;
    });
    const yAt = (x: number) => (surfaceY(oracle, Math.round(x), 0, 600, -200) ?? 0) + 60;
    const x0 = -HALF + 96, x1 = HALF - 96;
    focus = { x: x0, y: yAt(x0), z: 0 };
    s.setFocus(focus.x, focus.y, focus.z);
    await s.settle();
    expect(added.length).toBeGreaterThan(0);
    const settled = added.length;
    const t0 = performance.now();
    let x = x0;
    let heldUpdates = 0;
    while (x < x1) {
      x = Math.min(x1, x0 + (SPEED * (performance.now() - t0)) / 1000);
      focus = { x, y: yAt(x), z: 0 };
      s.setFocus(focus.x, focus.y, focus.z);
      s.update();
      if (s.detail.held) heldUpdates++;
      await sleep(8);
    }
    expect(heldUpdates).toBeGreaterThan(0);
    expect(s.counters.detailHolds).toBe(1);
    // Held, every level-0 derive went to a chunk bodies are made of; the level choice added level 0 only as the
    // stand-in for a level-1 node not ready next to the focus (within two chunks, and the hysteresis of one drawn).
    expect(outside).toBe(0);
    const inFlight = added.slice(settled).filter((a) => a.held);
    for (const a of inFlight) expect(a.d).toBeLessThanOrEqual(64 + 16);
    // Stopped: held on until the speed stayed down, then let go once.
    for (let i = 0; i < 5000 && s.detail.held; i++) {
      s.update();
      await sleep(8);
    }
    expect(s.detail.held).toBe(false);
    expect(s.counters.detailHolds).toBe(2);
    const back = added.length;
    await s.settle();
    const after = added.slice(back).map((a) => a.d);
    expect(after.length).toBeGreaterThan(8);
    // Nearest first: the first third of level 0 to come back lies nearer the focus than the last third.
    const third = Math.floor(after.length / 3);
    const mean = (a: number[]): number => a.reduce((n, v) => n + v, 0) / a.length;
    expect(mean(after.slice(0, third))).toBeLessThan(mean(after.slice(-third)));
    console.log(`detail ${JSON.stringify({ heldUpdates, heldDerives: held, standIns: inFlight.length, back: after.length, cancelledDerives: s.counters.cancelledDerives, airDerives: s.counters.airDerives, derives: s.counters.derives })}`);
  }, 180_000);
});
