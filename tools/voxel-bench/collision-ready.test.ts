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
 *
 * Where no fine collision has come (its derives held back), a body comes to
 * rest on the coarse floor made of the far cache's 2 m ground (level-2 nodes
 * downsampled by the engine's own mip code from the same world, served from
 * memory as the far cache's reads are), standing or moving at 60 m/s; once
 * the fine ground arrives it replaces the floor and the body ends on it,
 * neither falling through nor thrown up.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createPhysicsPort3D } from '@thirdlight/physics-rapier';
import { VoxelWorldHost, type VoxelHostEvents } from '@thirdlight/runtime';
import { chunkGrid, chunkOfKey, createDenseChunk, createWorldStore, downsampleMip, encodeDenseChunk, FAR_GROUND_LEVEL, FarNodeIndex, mipChildren, mipNodeKey, VOXEL_SIZE_M, WorkerPool, type DenseChunk, type FarNodeSource, type JobRequest, type MipNode, type PaletteStore, type PoolWorker, type RegionChunkRead, type VoxelRecord, type VoxelStreamer } from '@thirdlight/voxel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bundleWorker, DiskRegions, nodePoolWorker, REPO, TEST_WORLD_ID, writeWorldRegions } from './stream-node';
import { cliffWorld, hillyWorld } from './worlds';

const grid = chunkGrid(32);
const HALF = 128;
let dir = '';
let workerFile = '';
/** The ground's top cell (y) at the column tested. */
let groundY = 0;
/** The world as written (every chunk): the fine ground's oracle and the far cache's source. */
let oracle: PaletteStore;
/** The cliff world as written (the floor's cliff case). */
let cliffOracle: PaletteStore;
/** The column tested (cells): the last cell of chunk 0 along x, next to chunk 1, whose load is held. */
const X = 31;
const Z = 4;

beforeAll(async () => {
  const base = join(REPO, 'dist', 'voxel-bench');
  dir = mkdtempSync(join(base, 'collision-ready-'));
  workerFile = await bundleWorker('stream-worker-node', join(base, `collision-ready-worker-${process.pid}.mjs`));
  oracle = createWorldStore(grid);
  writeWorldRegions(hillyWorld({ footprint: 2 * HALF }).grids[0]!, grid, join(dir, 'world'), 'stacked', 512, -HALF, -HALF, HALF, HALF, oracle);
  const v: VoxelRecord = { material: 0, role: 0, shape: 0, wetness: 0 };
  for (groundY = 200; groundY > -200 && oracle.voxelAt(X, groundY, Z, v).material === 0; groundY--);
  cliffOracle = createWorldStore(grid);
  writeWorldRegions(cliffWorld({ footprint: 2 * HALF }).grids[0]!, grid, join(dir, 'cliff'), 'stacked', 512, -HALF, -HALF, HALF, HALF, cliffOracle);
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

/**
 * The world's far cache at the floor's level, from memory: level-1 then level-2 nodes downsampled from the world's
 * chunks by the engine's mip code, stored as the far cache stores a node (its codec bytes), its index listing them.
 */
function farSource(store: PaletteStore): FarNodeSource {
  const L = FAR_GROUND_LEVEL;
  let below = new Map<string, DenseChunk | null>();
  const c = { cx: 0, cy: 0, cz: 0 };
  let present: MipNode[] = [];
  for (const key of store.chunkKeys()) {
    chunkOfKey(grid, key, c);
    present.push({ level: 0, nx: c.cx, ny: c.cy, nz: c.cz });
  }
  const bytes = new Map<string, Uint8Array>();
  const index = new FarNodeIndex(grid, L, L);
  for (let level = 1; level <= L; level++) {
    const parents = new Map<string, MipNode>();
    for (const n of present) {
      const p: MipNode = { level, nx: n.nx >> 1, ny: n.ny >> 1, nz: n.nz >> 1 };
      parents.set(mipNodeKey(p), p);
    }
    const next = new Map<string, DenseChunk | null>();
    for (const [key, n] of parents) {
      const kids = mipChildren(n).map((k): DenseChunk | null => {
        if (level > 1) return below.get(mipNodeKey(k)) ?? null;
        const d = createDenseChunk(grid);
        return store.exportChunk(k.nx, k.ny, k.nz, d) ? d : null;
      });
      const out = createDenseChunk(grid);
      next.set(key, downsampleMip(grid, kids, out) ? out : null);
      if (level === L && next.get(key) !== null) {
        const b = encodeDenseChunk(grid, out)!;
        bytes.set(key, b);
        index.add(n, b.byteLength);
      }
    }
    below = next;
    present = [...parents.values()];
  }
  return {
    grid,
    minLevel: L,
    maxLevel: L,
    index: async () => index,
    read: async (level, nodes) => nodes.map((n): RegionChunkRead => {
      const b = bytes.get(mipNodeKey({ level, nx: n.cx, ny: n.cy, nz: n.cz }));
      return b === undefined ? { cx: n.cx, cy: n.cy, cz: n.cz, kind: 'air' } : { cx: n.cx, cy: n.cy, cz: n.cz, kind: 'stored', bytes: b.slice(), raw: true };
    }),
    invalidate: () => undefined,
    memoryBytes: () => 0,
  };
}

/** The coarse floor's test rig: the runtime's world host over the world with its chunk reads held, a character on Rapier. */
async function floorRig(world = 'world', oracle: PaletteStore = defaultOracle()) {
  const r = await createPhysicsPort3D({
    character: { position: { x: 0, y: 0, z: 0 }, radius: 0.3, halfHeight: 0.5, offset: { x: 0, y: 0.8, z: 0 } },
    statics: [],
    solver: { hz: 60, gravityY: -9.81 },
    controller: { offsetSkin: 0.01, groundSnap: 0.1, maxSlopeClimbRad: 0.8, minSlopeSlideRad: 0.9, autostep: false },
  });
  if (!r.ok) throw new Error(r.error.message);
  const port = r.port;
  // The world's chunk reads are held until let go (the workers stay free): only the far cache's ground is there.
  let hold = true;
  const queue: Array<() => void> = [];
  const disk = new DiskRegions(join(dir, world));
  const chunks = disk.source(grid, 'stacked', 512);
  const source = new Proxy(chunks, {
    get(t, k) {
      if (k === 'read') return (list: Parameters<typeof chunks.read>[0]) => (hold ? new Promise<Awaited<ReturnType<typeof chunks.read>>>((ok) => queue.push(() => void chunks.read(list).then(ok))) : chunks.read(list));
      const v = Reflect.get(t, k) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
  let streamer: VoxelStreamer | null = null;
  const host = new VoxelWorldHost(
    { world: 'w', ring: { loadRadius: 48, loadHeight: 32 }, collision: { radius: 16, height: 16 } } as never,
    // The far field is not drawn here: the floor reads the far cache all the same.
    { id: 'test', lighting: 'low', voxelFarField: 'off' } as never,
    {
      open: async () => ({
        grid,
        worldId: TEST_WORLD_ID,
        source,
        pool: new WorkerPool({ size: 4, create: () => nodePoolWorker(workerFile), timeoutMs: 60_000, maxQueued: 256 }),
        far: farSource(oracle),
        present: (s) => {
          streamer = s;
        },
      }),
    },
    port,
    events,
    () => 0,
  );
  const v: VoxelRecord = { material: 0, role: 0, shape: 0, wetness: 0 };
  /** The fine ground's top (metres) under a point: its highest solid cell's top. */
  const fineGround = (x: number, z: number): number => {
    const cx = Math.floor(x / VOXEL_SIZE_M), cz = Math.floor(z / VOXEL_SIZE_M);
    let y = 200;
    while (y > -200 && oracle.voxelAt(cx, y, cz, v).material === 0) y--;
    return (y + 1) * VOXEL_SIZE_M;
  };
  // A minimal character driver on the port: gravity while not grounded, a horizontal speed, held while its column
  // has no collision (the runtime's suspension rule) and lifted where the fine ground replaced its floor over it.
  const HZ = 60;
  let fall = 0;
  let pos = { x: 0, y: 0, z: 0 };
  let speed = 0;
  const trace: Array<{ x: number; y: number; ground: number; grounded: boolean; held: boolean }> = [];
  const tick = (): void => {
    const at: [number, number, number] = [pos.x, pos.y, pos.z];
    host.step({ stream: at, collide: [at], collideVelocity: [[speed, 0, 0]] });
    const rise = host.riseAt(pos.x, pos.y, pos.z);
    if (rise !== null) {
      port.placeCharacter({ x: pos.x, y: rise, z: pos.z });
      pos = { ...pos, y: rise };
      fall = 0;
    }
    const held = !host.collisionReadyAt(pos.x, pos.z, pos.y);
    port.suspendCharacter(held);
    if (!held) {
      fall = Math.min(fall + 9.81 / HZ, 60);
      port.stageCharacterMove({ x: speed / HZ, y: -fall / HZ, z: 0 });
    }
    const res = port.step();
    pos = { x: res.position.x, y: res.position.y, z: res.position.z };
    if (res.grounded) fall = 0;
    trace.push({ x: pos.x, y: pos.y, ground: fineGround(pos.x, pos.z), grounded: res.grounded, held });
  };
  const run = async (what: string, ok: () => boolean, ms = 30_000): Promise<void> => {
    const t0 = performance.now();
    while (!ok()) {
      if (performance.now() - t0 > ms) throw new Error(`timed out waiting for ${what}: ${JSON.stringify({ last: trace.slice(-3), floors: host.stats().floors })}`);
      tick();
      await new Promise((d) => setTimeout(d, 2));
    }
  };
  await run('the world to open', () => streamer !== null);
  /** Lets the held chunk reads go (fine collision comes in). */
  const release = (): void => {
    hold = false;
    for (const go of queue.splice(0)) go();
  };
  const floorPrefix = 'voxel:w:floor:';
  /** The coarse floor's top (metres) over a point (null: no floor there now). */
  const floorTop = (x: number, z: number): number | null => {
    const h = port.raycast?.({ x, y: 400, z }, { x: 0, y: -1, z: 0 }, 800, { accept: (id: string) => id.startsWith(floorPrefix) }) ?? null;
    return h === null ? null : 400 - h.distance;
  };
  const place = (p: { x: number; y: number; z: number }): void => {
    pos = p;
    fall = 0;
    port.placeCharacter(p);
    trace.length = 0;
  };
  return { host, port, trace, tick, run, release, fineGround, floorTop, place, disk, streamer: () => streamer!, setSpeed: (v: number) => (speed = v) };
}

function defaultOracle(): PaletteStore {
  return oracle;
}

describe('the coarse floor', () => {
  it('rests a body where only far data is resident, standing and moving at 60 m/s, then hands it to the fine ground: never through, never thrown up (real workers, real Rapier)', async () => {
    const { host, trace, tick, run, release, fineGround, place, disk, streamer, setSpeed } = await floorRig();
    // Dropped 3 m over the ground near the world's −x edge (it is 128 m square round the origin, so the flight below
    // stays over it), with no fine collision anywhere: it comes to rest on the floor.
    const START = { x: -50.25, z: 2.25 };
    place({ x: START.x, y: fineGround(START.x, START.z) + 3, z: START.z });
    await run('the body to rest on the floor', () => trace.length > 30 && trace.slice(-30).every((t) => t.grounded && !t.held));
    const stats = host.stats();
    expect(stats.floors!.count).toBeGreaterThan(0);
    expect(streamer().metrics().resident).toBe(0);
    // On the floor: within a coarse cell (2 m) of the fine ground, either way (the coarse ground's error; a body under
    // the fine top is lifted onto it at the hand-over).
    const COARSE_M = VOXEL_SIZE_M * 2 ** FAR_GROUND_LEVEL;
    const rest = trace.at(-1)!;
    expect(Math.abs(rest.y - rest.ground)).toBeLessThanOrEqual(COARSE_M);
    // Moving at 60 m/s over the floor for 1.5 s (90 m): it never drops under the fine ground by more than the floor's error.
    setSpeed(60);
    trace.length = 0;
    for (let i = 0; i < 90; i++) {
      tick();
      await new Promise((d) => setTimeout(d, 2));
    }
    setSpeed(0);
    expect(trace.at(-1)!.x - trace[0]!.x).toBeGreaterThan(10);
    for (const t of trace) expect(t.y, `at x ${t.x.toFixed(1)}`).toBeGreaterThanOrEqual(t.ground - COARSE_M);
    // Standing again, the world's chunks are let in: the floor hands over, and the body ends on the fine ground.
    trace.length = 0;
    await run('the body to rest', () => trace.length > 30 && trace.slice(-30).every((t) => t.grounded && !t.held));
    const before = trace.at(-1)!;
    release();
    const top = Math.max(before.y, before.ground);
    trace.length = 0;
    await run('the floor to hand over and the body to rest on the fine ground', () => (host.stats().floors?.handedOver ?? 0) > 0 && trace.length > 60 && trace.slice(-30).every((t) => t.grounded && !t.held));
    let lowest = Infinity;
    for (const t of trace) {
      lowest = Math.min(lowest, t.y - t.ground);
      expect(t.y).toBeGreaterThanOrEqual(t.ground - COARSE_M);
      // Never thrown up: no higher than where it stood or the fine ground's top, by more than the lift's skin.
      expect(t.y).toBeLessThanOrEqual(top + 0.1);
    }
    const end = trace.at(-1)!;
    expect(Math.abs(end.y - end.ground)).toBeLessThanOrEqual(VOXEL_SIZE_M + 0.05);
    console.log(`floor ${JSON.stringify({ floors: host.stats().floors, restOnFloorAboveGround: Number((rest.y - rest.ground).toFixed(2)), lowestAfterHandOver: Number(lowest.toFixed(2)), moved: Number((before.x - START.x).toFixed(1)), endAboveGround: Number((end.y - end.ground).toFixed(2)) })}`);
    host.dispose();
    await disk.close();
  }, 180_000);

  it('on a cliff: a body on the steepest floor cells rests or slides, one under the floor\'s surface there waits instead of falling through, and both end on the fine ground at the hand-over (real workers, real Rapier)', async () => {
    const { host, trace, run, release, fineGround, floorTop, place, disk } = await floorRig('cliff', cliffOracle);
    const COARSE_M = VOXEL_SIZE_M * 2 ** FAR_GROUND_LEVEL;
    // The steepest place of the world: the largest step of the fine ground over a coarse cell, away from its edges.
    let steep = { x: 0, z: 0, step: 0 };
    for (let x = -100.25; x < 100; x += 1) for (let z = -100.25; z < 100; z += 1) {
      const g = fineGround(x, z), gx = fineGround(x + COARSE_M, z), gz = fineGround(x, z + COARSE_M);
      // Columns the oracle's scan found no ground in (under its reach) are left out.
      if (Math.min(g, gx, gz) <= -99) continue;
      const step = Math.max(Math.abs(g - gx), Math.abs(g - gz));
      if (step > steep.step) steep = { x, z, step };
    }
    // The cliff: 20 m over a coarse cell.
    expect(steep.step).toBeGreaterThan(10);
    // Dropped 3 m over the fine ground there with no fine collision: it rests on the floor or slides down it, never under the fine ground.
    place({ x: steep.x, y: fineGround(steep.x, steep.z) + 3, z: steep.z });
    await run('the body to rest on the steep floor', () => trace.length > 30 && trace.slice(-30).every((t) => t.grounded && !t.held));
    for (const t of trace) expect(t.y, `at ${t.x.toFixed(2)}`).toBeGreaterThanOrEqual(t.ground - COARSE_M);
    // Where the floor lies highest over the fine ground near it (a corner takes the highest coarse top round it).
    let under = { x: 0, z: 0, gap: -Infinity };
    for (let dx = -6; dx <= 6; dx += 0.25) for (let dz = -6; dz <= 6; dz += 0.25) {
      const x = steep.x + dx, z = steep.z + dz;
      const top = floorTop(x, z);
      if (top === null) continue;
      const g = fineGround(x, z);
      // Clear of the cliff's face by more than the capsule's radius: a body placed into the face is another case.
      if ([-0.75, 0, 0.75].some((ox) => [-0.75, 0, 0.75].some((oz) => fineGround(x + ox, z + oz) > g + VOXEL_SIZE_M))) continue;
      const gap = top - g;
      if (gap > under.gap) under = { x, z, gap };
    }
    expect(under.gap).toBeGreaterThan(1);
    // Placed on the fine ground's top there, under the floor's surface (what a placed player or a slide off a floor's
    // edge meets): no collision under it, so it waits; it never falls through the world.
    const ground = fineGround(under.x, under.z);
    place({ x: under.x, y: ground + 0.2, z: under.z });
    await run('two seconds', () => trace.length >= 120);
    const waited = trace.filter((t) => t.held).length;
    for (const t of trace) expect(t.y, 'under the floor').toBeGreaterThanOrEqual(ground - VOXEL_SIZE_M);
    // The fine ground comes in: the floor hands over and the body ends on it.
    release();
    trace.length = 0;
    await run('the hand-over on the cliff', () => (host.stats().floors?.handedOver ?? 0) > 0 && trace.length > 60 && trace.slice(-30).every((t) => t.grounded && !t.held));
    for (const t of trace) expect(t.y, 'at the hand-over').toBeGreaterThanOrEqual(t.ground - VOXEL_SIZE_M);
    const end = trace.at(-1)!;
    expect(Math.abs(end.y - end.ground)).toBeLessThanOrEqual(VOXEL_SIZE_M + 0.05);
    console.log(`cliff ${JSON.stringify({ steep, under: { ...under, gap: Number(under.gap.toFixed(2)) }, waited, endAboveGround: Number((end.y - end.ground).toFixed(2)), floors: host.stats().floors })}`);
    host.dispose();
    await disk.close();
  }, 180_000);
});
