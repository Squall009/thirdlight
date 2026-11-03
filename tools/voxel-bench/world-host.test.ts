/**
 * The runtime's voxel worlds and `ctx.voxels` at real boundaries: a real
 * runtime (instantiateRuntime) whose scenes carry `voxelWorld` objects, a
 * script reading and changing the world through `ctx.voxels`, the worlds
 * opened through injected ports onto region files on disk and
 * `worker_threads` workers running the bundled worker, and the engine's
 * real physics backend (Rapier through physics-rapier's port) holding the
 * collision ring's bodies.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPhysicsPort3D, type RapierPhysicsPort3D } from '@thirdlight/physics-rapier';
import {
  createBehaviorModuleSpec,
  createSimulationRegistry,
  instantiateRuntime,
  neutralFrame,
  registerSimulationModule,
  type BehaviorArtifact,
  type BehaviorVoxels,
  type Runtime,
  type VoxelWorldConnection,
  type VoxelWorldPorts,
} from '@thirdlight/runtime';
import { bufferResolver as bufferResolverOf, presentVoxelWorlds, shippedVoxelPorts, type ShippedVoxelPortsOptions } from '@thirdlight/game-host';
import { bytesToHex, crc32, sha256Hex } from '@thirdlight/shared';
import { chunkDrawBatchTransfer, chunkGrid, parseRegionFileName, shippedChunkSource, shippedVoxelWorldsProblem, type ShippedVoxelWorld, createWorldStore, dependentChunks, jobRadius, lightCoverageAt, WORLD_RULES, PROP_COVERAGE_PART, propBounds, propCoverageChunk, readSave, shaderGridSide, VOXEL_SIZE_M, VoxelStreamer, WorkerPool, writeSave, type ChunkDrawBatch, type ChunkDrawWire, type PaletteStore, type PropShape, type VoxelRecord } from '@thirdlight/voxel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bundleWorker, DiskRegions, nodePoolWorker, REPO, TEST_WORLD_ID, writeWorldRegions } from './stream-node';
import { hillyWorld } from './worlds';

type SceneCatalogIoLike = ShippedVoxelPortsOptions['io'];

const grid = chunkGrid(32);
/** A 128 m hilly square centred on the origin (four region columns meet at 0, 0). */
const HALF = 128;
const DT = 1 / 60;
const DECL = { properties: [] } as never;
const T = { rotation: [0, 0, 0, 1], scale: [1, 1, 1] };

let dir = '';
let workerFile = '';
let oracle: PaletteStore;
/** The ground's top cell (y) at cell (0, 0), and the focus there in metres. */
let groundY = 0;
const disks: DiskRegions[] = [];

beforeAll(async () => {
  const base = join(REPO, 'dist', 'voxel-bench');
  dir = mkdtempSync(join(base, 'world-host-'));
  workerFile = await bundleWorker('stream-worker-node', join(base, `world-host-worker-${process.pid}.mjs`));
  oracle = createWorldStore(grid);
  writeWorldRegions(hillyWorld({ footprint: 2 * HALF }).grids[0]!, grid, join(dir, 'world'), 'stacked', 512, -HALF, -HALF, HALF, HALF, oracle);
  const v: VoxelRecord = { material: 0, role: 0, shape: 0, wetness: 0 };
  for (groundY = 200; groundY > -200 && oracle.voxelAt(0, groundY, 0, v).material === 0; groundY--);
}, 120_000);

afterAll(async () => {
  for (const d of disks) await d.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(workerFile, { force: true });
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** What a test script sees: its phase, `ctx.voxels`, and `emit` for the transforms it owns. */
interface ScriptCtx {
  readonly phase: string;
  readonly entityId: string;
  readonly voxels: BehaviorVoxels;
  emit(intent: { kind: 'transform'; entityId: string; position: { x: number; y: number; z: number } }): void;
}

function artifact(behaviorId: string, step: (ctx: ScriptCtx) => void, ownedTransforms: readonly string[] = []): BehaviorArtifact {
  return {
    behaviorId,
    sourceDigest: 'a'.repeat(64),
    manifestDigest: 'b'.repeat(64),
    outputDigest: 'c'.repeat(64),
    ownedTransforms: [...ownedTransforms],
    requiredModules: [],
    enginePins: [],
    namespace: { default: { instantiate: () => ({}), step: (_s: unknown, ctx: never) => step(ctx), dispose: () => {} } },
  };
}

/** A small ring (32 m around, 32 m up and down) and bodies within 16 m, so the test world fills fast. */
const worldComponent = (world: string): unknown => ({ world, ring: { loadRadius: 32, loadHeight: 32 }, collision: { radius: 16, height: 16 } });

interface Harness {
  rt: Runtime;
  port: RapierPhysicsPort3D;
  /** Runs `fn` inside the script's next step (with its ctx.voxels, which only answers inside a step) and returns its result. */
  inStep<R>(fn: (v: BehaviorVoxels) => R): Promise<R>;
  /** Runs `fn` in every step until it answers something other than undefined. */
  stepUntil<R>(fn: (v: BehaviorVoxels) => R | undefined, what: string): Promise<R>;
  /** Ticks steps (letting worker replies in between) until `done` holds. */
  until(done: () => boolean, what: string, maxMs?: number): Promise<number>;
  opened: string[];
  closed: string[];
  /** Worlds whose pools were closed (their workers ended). */
  poolsClosed: string[];
  /** Every change the script's steps were given, in order, with the ground under (0.25, 0.25) as that step saw it. */
  changeLog: { change: BehaviorVoxels['changes'][number]; probe: unknown }[];
  /** Read in the step that is given each change (its answer goes in the log). */
  probe?: () => unknown;
  /** Runs once in the script's next step with its whole ctx (then cleared). */
  once?: (ctx: unknown) => void;
  /** Places an owned object (world metres) at the script's next transform phase. */
  move(entityId: string, position: readonly [number, number, number]): void;
}

/** A test's own scene objects and world settings (beside world a's object and the script's). */
interface SceneOptions {
  /** World a's `voxelWorld` component (default {@link worldComponent}). */
  readonly world?: unknown;
  readonly entities?: readonly unknown[];
  /** Objects a mover script rides on, to move them (`Harness.move`). */
  readonly movers?: readonly string[];
  readonly modelBounds?: Readonly<Record<string, { min: readonly number[]; max: readonly number[] }>>;
}

/** `wrap`: the ports the runtime gets, made from the test's (the game host's presentation, say). */
async function harness(wrap: (ports: VoxelWorldPorts) => VoxelWorldPorts = (p) => p, onStream?: (world: string, s: VoxelStreamer) => void, scene: SceneOptions = {}): Promise<Harness> {
  const r = await createPhysicsPort3D({
    character: { position: { x: 0, y: 0, z: 0 }, radius: 0.3, halfHeight: 0.5, offset: { x: 0, y: 0.8, z: 0 } },
    noCharacter: true,
    statics: [],
    solver: { hz: 60, gravityY: -9.81 },
    controller: { offsetSkin: 0.01, groundSnap: 0.1, maxSlopeClimbRad: 0.8, minSlopeSlideRad: 0.9, autostep: false },
  });
  if (!r.ok) throw new Error(r.error.message);
  const port = r.port;
  const opened: string[] = [];
  const closed: string[] = [];
  const poolsClosed: string[] = [];
  const ports = {
    open: async (world: string): Promise<VoxelWorldConnection> => {
      opened.push(world);
      // Both test worlds read the same files: what one game changes must stay in its own world.
      const disk = new DiskRegions(join(dir, 'world'));
      disks.push(disk);
      const pool = new WorkerPool({ size: 2, create: () => nodePoolWorker(workerFile), timeoutMs: 10_000, maxQueued: 256 });
      const close = pool.close.bind(pool);
      pool.close = () => {
        poolsClosed.push(world);
        close();
      };
      return { grid, worldId: TEST_WORLD_ID, source: disk.source(grid, 'stacked', 512), pool, close: () => void closed.push(world), present: (stream) => onStream?.(world, stream) };
    },
  };
  let job: ((v: BehaviorVoxels) => boolean) | null = null;
  let lastChanges: BehaviorVoxels['changes'] | null = null;
  const changeLog: Harness['changeLog'] = [];
  const moves = new Map<string, readonly [number, number, number]>();
  const spec = createBehaviorModuleSpec({
    declaration: DECL,
    artifact: artifact('digger', (ctx) => {
      // Every step's changes, whether or not a test job is waiting in that step (a script hook runs once a phase).
      if (ctx.voxels.changes !== lastChanges) {
        lastChanges = ctx.voxels.changes;
        for (const c of lastChanges) changeLog.push({ change: c, probe: h.probe?.() });
      }
      if (job?.(ctx.voxels) === true) job = null;
      const once = h.once;
      h.once = undefined;
      once?.(ctx);
    }),
  });
  // Each object the test moves carries a mover, which places its own object.
  const mover = createBehaviorModuleSpec({
    declaration: DECL,
    artifact: artifact(
      'mover',
      (ctx) => {
        const to = moves.get(ctx.entityId);
        if (ctx.phase !== 'transform' || to === undefined) return;
        ctx.emit({ kind: 'transform', entityId: ctx.entityId, position: { x: to[0], y: to[1], z: to[2] } });
        moves.delete(ctx.entityId);
      },
      ['@self'],
    ),
  });
  const registry = createSimulationRegistry();
  registerSimulationModule(registry, spec.id, spec);
  registerSimulationModule(registry, mover.id, mover);
  const movable = (id: string, components: Record<string, unknown>): Record<string, unknown> => (scene.movers?.includes(id) === true ? { ...components, behavior: { behaviorId: 'mover', values: {} } } : components);
  const focusM = [0, (groundY + 1) * VOXEL_SIZE_M, 0];
  const snapshot = {
    snapshotId: 'voxels-0001@r1',
    projectId: 'voxels-0001',
    revision: 1,
    scene: {
      schemaVersion: 4,
      sceneId: 'scene-main',
      revision: 1,
      entities: [
        { id: 'world-a', components: movable('world-a', { transform: { position: focusM, ...T }, voxelWorld: scene.world ?? worldComponent('a') }) },
        { id: 'digger', components: { transform: { position: [0, 0, 0], ...T }, behavior: { behaviorId: 'digger', values: {} } } },
        ...(scene.entities ?? []).map((e) => {
          const o = e as { id: string; components: Record<string, unknown> };
          return { ...o, components: movable(o.id, o.components) };
        }),
      ],
    },
    ...(scene.modelBounds !== undefined ? { modelBounds: scene.modelBounds } : {}),
    scenes: [
      { sceneId: 'scene-main', start: true, entityIds: ['world-a', 'digger', ...(scene.entities ?? []).map((e) => (e as { id: string }).id)] },
      { sceneId: 'scene-b', start: false },
    ],
  };
  const now = { t: 0 };
  const res = instantiateRuntime({ snapshot, registry, modules: scene.movers !== undefined ? [spec.id, mover.id] : [spec.id], actions: { sample: (i: number) => neutralFrame(i) }, physics: port, settings: {}, clock: () => now.t, driver: { kind: 'manual' }, voxels: wrap(ports) });
  if (!res.ok) throw new Error(`instantiate failed: ${JSON.stringify(res.error)}`);
  const rt = res.runtime;
  expect(rt.start().ok).toBe(true);
  const tick = (): void => {
    now.t += DT;
    const t = rt.tick(now.t);
    if (!t.ok) throw new Error(`tick failed: ${JSON.stringify(t.error)}`);
  };
  const until = async (done: () => boolean, what: string, maxMs = 30_000): Promise<number> => {
    const t0 = performance.now();
    while (!done()) {
      if (performance.now() - t0 > maxMs) throw new Error(`timed out waiting for ${what}`);
      tick();
      await sleep(1);
    }
    return performance.now() - t0;
  };
  const stepUntil = async <R>(fn: (v: BehaviorVoxels) => R | undefined, what: string): Promise<R> => {
    let out: { r: R } | null = null;
    job = (v) => {
      const r = fn(v);
      if (r !== undefined) out = { r };
      return out !== null;
    };
    await until(() => out !== null, what);
    return out!.r;
  };
  const inStep = <R>(fn: (v: BehaviorVoxels) => R): Promise<R> => stepUntil(fn, 'the script step');
  const h: Harness = { rt, port, inStep, stepUntil, until, opened, closed, poolsClosed, changeLog, move: (id, p) => void moves.set(id, p) };
  return h;
}

/** The first collider hit straight down from high above (x, z metres): its height and body id. */
function groundBelow(port: RapierPhysicsPort3D, x: number, z: number): { y: number; id: string } | null {
  const top = 150;
  const hit = port.raycast({ x, y: top, z }, { x: 0, y: -1, z: 0 }, 400);
  return hit === null ? null : { y: top - hit.distance, id: hit.entityId };
}

describe('voxel worlds in the runtime (ctx.voxels)', () => {
  it('reads and edits through the overlay in one step, swaps meshes, colliders and shader data together, keeps worlds apart and disposes with the scene', async () => {
    const h = await harness();
    const cx = 0.25;
    const cz = 0.25;
    const surfaceM = (groundY + 1) * VOXEL_SIZE_M;
    const pit = { center: [cx, surfaceM - 1, cz] as [number, number, number], radius: 2 };
    expect(await h.inStep((v) => v.worlds())).toEqual(['a']);
    expect(h.opened).toEqual(['a']);

    // Loaded around the world's object (no live camera); bodies only near it.
    await h.stepUntil((v) => (v.isResident(pit) ? true : undefined), 'the pit region to load');
    // A wait is answered at a later step's start, for that step only: one script asks and watches.
    let wait = 0;
    const answer = await h.stepUntil((v) => {
      if (wait === 0) wait = v.whenResident(pit);
      return v.waits.find((w) => w.wait === wait);
    }, 'the wait to be answered');
    expect(answer.resident).toBe(true);
    await h.until(() => groundBelow(h.port, cx, cz)?.id.startsWith('voxel:a:') === true, 'a body under the focus');
    const before = groundBelow(h.port, cx, cz)!;
    expect(before.y).toBeGreaterThan(surfaceM - 1.5);
    expect(before.y).toBeLessThan(surfaceM + 0.5);

    // Far away and outside the ring: null, never air; changes there are refused.
    const far = await h.inStep((v) => ({ get: v.get(5000, surfaceM, 5000), resident: v.isResident({ at: [5000, surfaceM, 5000] }), dig: v.dig({ at: [5000, surfaceM, 5000] }) }));
    expect(far.get).toBeNull();
    expect(far.resident).toBe(false);
    expect(far.dig).toMatchObject({ ok: false, reason: 'not_resident' });

    // A 4 m dig: the cells read air in the same step; the collider stands until the swap.
    const dug = await h.inStep((v) => {
      const solid = v.get(cx, surfaceM - 1, cz);
      const t0 = performance.now();
      const r = v.dig(pit);
      const ms = performance.now() - t0;
      const set = v.set({ at: [cx + 4, surfaceM - 0.25, cz] }, { material: 7, role: 1, wetness: 2 });
      return { solid, r, ms, after: v.get(cx, surfaceM - 1, cz), placed: v.get(cx + 4, surfaceM - 0.25, cz), set, swapsNow: v.changes.length };
    });
    const editAt = performance.now();
    expect(dug.solid?.material).not.toBe(0);
    expect(dug.r.ok).toBe(true);
    if (!dug.r.ok) return;
    const digEdit = dug.r.edit;
    expect(dug.r.cells).toBeGreaterThan(200);
    expect(dug.after).toEqual({ material: 0, role: 0, shape: 0, wetness: 0 });
    expect(dug.placed).toEqual({ material: 7, role: 1, shape: 15, wetness: 2 });
    expect(groundBelow(h.port, cx, cz)!.y).toBeCloseTo(before.y, 5);
    console.log(`step ms of the 4 m dig (overlay apply on the step's thread): ${dug.ms.toFixed(2)}`);

    // The change arrives once, after its swap, naming the chunks whose data was replaced; the body is replaced with it.
    const seen: number[] = [];
    const change = await h.stepUntil((v) => {
      for (const x of v.changes) seen.push(x.edit);
      return v.changes.find((x) => x.edit === digEdit);
    }, 'the dig to swap');
    // The change is not reported again.
    await h.inStep((v) => seen.push(...v.changes.map((x) => x.edit)));
    console.log(`edit → change reported (swap + next step), ms: ${(performance.now() - editAt).toFixed(1)}`);
    expect(seen.filter((e) => e === digEdit)).toHaveLength(1);
    expect(change.world).toBe('a');
    expect(change.shaderOnly).toBe(false);
    const m = grid.edge * VOXEL_SIZE_M;
    const named = change.chunks.map((b) => `${Math.round(b.min[0] / m)},${Math.round(b.min[1] / m)},${Math.round(b.min[2] / m)}`);
    expect(new Set(named).size).toBe(named.length);
    const c = (v: number): number => Math.floor(v / VOXEL_SIZE_M);
    const box = { minX: c(cx - 2), minY: c(surfaceM - 3), minZ: c(cz - 2), maxX: c(cx + 2), maxY: c(surfaceM + 1), maxZ: c(cz + 2) };
    const reach = new Set(dependentChunks(grid, box, jobRadius(WORLD_RULES)).map((k) => `${k.cx},${k.cy},${k.cz}`));
    for (const n of named) expect(reach.has(n)).toBe(true);
    expect(named).toContain(`${Math.floor(c(cx) / 32)},${Math.floor(c(surfaceM - 1) / 32)},${Math.floor(c(cz) / 32)}`);
    for (const b of change.chunks) expect(b.max[0] - b.min[0]).toBe(m);
    const afterDig = groundBelow(h.port, cx, cz)!;
    expect(afterDig.y).toBeLessThan(before.y - 2.5);

    // Paint: material and wetness read at once; only shader data changes (bodies stand).
    const rim = { center: [cx + 4, surfaceM - 1, cz] as [number, number, number], radius: 1 };
    const colliders = h.port.diagnostics().worldColliderCount;
    const painted = await h.inStep((v) => ({ r: v.paint(rim, { wetness: 5 }), at: v.get(cx + 4, surfaceM - 1.25, cz) }));
    expect(painted.r.ok).toBe(true);
    expect(painted.at?.wetness).toBe(5);
    if (!painted.r.ok) return;
    const paintEdit = painted.r.edit;
    const paintChange = await h.stepUntil((v) => v.changes.find((x) => x.edit === paintEdit), 'the paint to swap');
    expect(paintChange.shaderOnly).toBe(true);
    expect(h.port.diagnostics().worldColliderCount).toBe(colliders);
    expect(groundBelow(h.port, cx, cz)!.y).toBeCloseTo(afterDig.y, 5);
    expect((await h.inStep((v) => v.paint(rim, { material: 0 as never }))).ok).toBe(false);

    // More 4 m digs for the timings (each read at once, then swapped and reported once).
    const timings: string[] = [];
    for (const [dx, dz] of [[-6, 0], [0, -6], [6, 6]] as const) {
      const at = [cx + dx, surfaceM - 1, cz + dz] as [number, number, number];
      const d = await h.inStep((v) => {
        const t0 = performance.now();
        const r = v.dig({ center: at, radius: 2 });
        return { r, ms: performance.now() - t0, air: v.get(...at)?.material === 0 };
      });
      const t0 = performance.now();
      expect(d.air).toBe(true);
      if (!d.r.ok) throw new Error(d.r.message);
      const id = d.r.edit;
      await h.stepUntil((v) => v.changes.find((x) => x.edit === id), 'a dig to swap');
      timings.push(`step ${d.ms.toFixed(2)} ms, reported after ${(performance.now() - t0).toFixed(1)} ms`);
    }
    console.log(`4 m digs: ${timings.join('; ')}`);

    // A second world from a scene loaded later: its own host, the same files, none of world a's changes.
    const bodiesA = h.port.diagnostics().worldBodyCount;
    expect(h.rt.requestScene!('load', 'scene-b').ok).toBe(true);
    for (const q of h.rt.takeSceneRequests!()) h.rt.provideScene!(q.sceneId, { ok: true, entities: [{ id: 'world-b', components: { transform: { position: [0, surfaceM, 0], ...T }, voxelWorld: worldComponent('b') } }] as never });
    await h.stepUntil((v) => (v.world('b')?.isResident(pit) === true ? true : undefined), 'world b to load');
    expect(h.opened).toEqual(['a', 'b']);
    expect(await h.inStep((v) => v.worlds())).toEqual(['a', 'b']);
    const both = await h.inStep((v) => ({ a: v.get(cx, surfaceM - 1, cz), b: v.world('b')!.get(cx, surfaceM - 1, cz), bSet: v.world('b')!.set({ at: [cx, surfaceM + 3, cz] }, { material: 9, role: 1 }), aAbove: v.get(cx, surfaceM + 3, cz) }));
    expect(both.a?.material).toBe(0);
    expect(both.b).toEqual(dug.solid);
    expect(both.bSet.ok).toBe(true);
    expect(both.aAbove?.material).toBe(0);
    await h.until(() => h.port.diagnostics().worldBodyCount > bodiesA, "world b's bodies");

    // Unloading its scene disposes world b: bodies out of physics, workers stopped, waits answered.
    const answers: { wait: number; resident: boolean }[] = [];
    let pending = 0;
    await h.stepUntil((v) => {
      answers.push(...v.waits);
      if (pending === 0) {
        pending = v.world('b')!.whenResident({ at: [3000, surfaceM, 3000] });
        expect(h.rt.requestScene!('unload', 'scene-b').ok).toBe(true);
      }
      return v.world('b') === null && answers.length > 0 ? true : undefined;
    }, 'world b to unload');
    expect(answers).toEqual([{ wait: pending, resident: false }]);
    expect(h.closed).toEqual(['b']);
    expect(h.port.diagnostics().worldBodyCount).toBe(bodiesA);
    expect(h.poolsClosed).toEqual(['b']);
    expect((await h.inStep((v) => v.get(cx, surfaceM - 1, cz)))?.material).toBe(0);

    expect(h.rt.dispose().ok).toBe(true);
    expect(h.closed).toEqual(['b', 'a']);
    expect(h.poolsClosed).toEqual(['b', 'a']);
  }, 120_000);

  it("sends the world's draws to the page as one batch a streamer task: a swap's chunks in one message, equal to fresh joins, handed over without detaching the streamer's buffers", async () => {
    const batches: ChunkDrawBatch[] = [];
    let stream: VoxelStreamer | null = null;
    // As a worker posts them: each batch structured-cloned with its buffers transferred.
    let presentation: ReturnType<typeof presentVoxelWorlds> | null = null;
    const h = await harness(
      (ports) => (presentation = presentVoxelWorlds(ports, (b) => batches.push(structuredClone(b, { transfer: chunkDrawBatchTransfer(b) })))).ports,
      (_w, s) => (stream = s),
    );
    const surfaceM = (groundY + 1) * VOXEL_SIZE_M;
    const pit = { center: [0.25, surfaceM - 1, 0.25] as [number, number, number], radius: 2 };
    await h.stepUntil((v) => (v.isResident(pit) ? true : undefined), 'the pit region to load');
    await h.until(() => groundBelow(h.port, 0.25, 0.25)?.id.startsWith('voxel:a:') === true, 'a body under the focus');
    // Until the ring is filled: no batch for 40 steps.
    let quiet = 0;
    let seenBatches = -1;
    await h.until(() => {
      quiet = batches.length === seenBatches ? quiet + 1 : 0;
      seenBatches = batches.length;
      return quiet >= 40;
    }, 'the ring to fill');
    const s = stream! as VoxelStreamer;
    // What the page holds after applying every batch in order.
    const drawn = new Map<string, ChunkDrawWire>();
    const apply = (b: ChunkDrawBatch): void => {
      expect(b.world).toBe('a');
      for (const c of b.chunks) {
        const k = `${c.cx},${c.cy},${c.cz}`;
        if (c.kind === 'remove') drawn.delete(k);
        else if (c.kind === 'draw') drawn.set(k, c);
        else drawn.set(k, { ...drawn.get(k)!, solid: c.solid!, ...(c.cells !== undefined ? { cells: c.cells } : {}) });
      }
    };
    const side = shaderGridSide(grid.edge);
    const cells = new Uint16Array(side ** 3);
    const sameAsFresh = (): number => {
      let n = 0;
      for (const [k, c] of drawn) {
        const [cx, cy, cz] = k.split(',').map(Number) as [number, number, number];
        if (!s.isResident(cx, cy, cz)) continue;
        const d = s.joinedChunk(cx, cy, cz, undefined, cells)!;
        expect(d, k).not.toBeNull();
        for (const part of ['ground', 'base'] as const) {
          expect(Buffer.from(c[part]!.vertices).equals(Buffer.from(d[part].vertices)), `${k} ${part}`).toBe(true);
          expect([...c[part]!.indices], `${k} ${part}`).toEqual([...d[part].indices]);
        }
        expect(Buffer.from(c.instances!.data).equals(Buffer.from(d.instances.data)), k).toBe(true);
        expect(c.solid, k).toBe(d.solid);
        if (d.solid < 0) expect(Buffer.from(c.cells!.buffer).equals(Buffer.from(cells.buffer)), k).toBe(true);
        n++;
      }
      return n;
    };
    for (const b of batches.splice(0)) apply(b);
    expect(sameAsFresh()).toBeGreaterThan(10);

    // A dig: its swap's chunks arrive in one batch with the swap, and the page's chunks equal fresh joins again.
    const dug = await h.inStep((v) => v.dig(pit));
    expect(dug.ok).toBe(true);
    if (!dug.ok) return;
    const id = dug.edit;
    await h.stepUntil((v) => v.changes.find((x) => x.edit === id), 'the dig to swap');
    const withSwap = batches.filter((b) => b.swaps.length > 0);
    expect(withSwap).toHaveLength(1);
    const swapBatch = withSwap[0]!;
    expect(swapBatch.swaps).toHaveLength(1);
    const swapped = new Set(swapBatch.chunks.filter((c) => c.kind === 'draw').map((c) => `${c.cx},${c.cy},${c.cz}`));
    expect(swapped.size).toBe(swapBatch.swaps[0]!.chunks);
    expect(swapBatch.swaps[0]!.sections).toBeGreaterThan(1);
    for (const b of batches.splice(0)) apply(b);
    expect(sameAsFresh()).toBeGreaterThan(10);

    // The page's GPU bytes of a drawn chunk count as its mesh part of the world's budget, and those of its nodes and
    // seams (one sum) in the mip share.
    const [k0] = [...drawn.keys()].filter((k) => s.isResident(...(k.split(',').map(Number) as [number, number, number])));
    const before = s.metrics().bytes;
    presentation!.drawn('a', [...k0!.split(',').map(Number), 100_000], 30_000);
    // Nothing reported bytes for it before (no page here), so the total grows by exactly these.
    expect(s.metrics().bytes.total - before.total).toBe(130_000);
    expect(s.metrics().bytes.mips - before.mips).toBe(30_000);
    // A later report replaces the sum.
    presentation!.drawn('a', [], 10_000);
    expect(s.metrics().bytes.mips - before.mips).toBe(10_000);
    expect(h.rt.dispose().ok).toBe(true);
    // The world closed: the page is told to let go of its draws.
    expect(batches.at(-1)).toMatchObject({ world: 'a', closed: true, chunks: [] });
  }, 120_000);

  it("keeps a reloaded world's draws when the connection it replaced finishes opening last (out-of-order opens in Play)", async () => {
    const batches: ChunkDrawBatch[] = [];
    // The first open of the world waits until the test lets it go; later opens answer at once (as two fetches can resolve).
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    let opens = 0;
    const slowFirst = (ports: VoxelWorldPorts): VoxelWorldPorts => ({
      open: async (world) => {
        const first = opens++ === 0;
        const conn = await ports.open(world);
        if (first) await held;
        return conn;
      },
    });
    const h = await harness((ports) => presentVoxelWorlds(slowFirst(ports), (b) => batches.push(b)).ports);
    // The scene reloads while its world is still opening: the first host is disposed, a second one opens and draws.
    await h.until(() => opens === 1, 'the first open');
    h.once = (ctx) => (ctx as { scenes: { reload(id: string): void } }).scenes.reload('scene-main');
    await h.until(() => opens === 2 && batches.some((b) => b.chunks.length > 0), "the reloaded world's first draws");
    // Now the first connection arrives, to a host already gone: it is closed, and must not close the second's draws.
    release();
    await h.until(() => h.poolsClosed.length === 1, 'the stale connection to close');
    expect(batches.filter((b) => b.closed === true)).toHaveLength(0);
    // The world still draws: a dig's swap reaches the page.
    const surfaceM = (groundY + 1) * VOXEL_SIZE_M;
    const pit = { center: [0.25, surfaceM - 1, 0.25] as [number, number, number], radius: 2 };
    await h.stepUntil((v) => (v.isResident(pit) ? true : undefined), 'the pit region to load');
    const before = batches.length;
    const dug = await h.inStep((v) => v.dig(pit));
    expect(dug.ok).toBe(true);
    if (!dug.ok) return;
    const id = dug.edit;
    await h.stepUntil((v) => v.changes.find((x) => x.edit === id), 'the dig to swap');
    expect(batches.slice(before).some((b) => b.swaps.length > 0 && b.chunks.some((c) => c.kind === 'draw'))).toBe(true);
    expect(h.rt.dispose().ok).toBe(true);
    // Only the live world's dispose tells the page to let go.
    expect(batches.filter((b) => b.closed === true)).toHaveLength(1);
  }, 120_000);

  it("saves the game's changes as the game's own bytes (saved fields only) and restores them into a new run's overlay, before and after their chunks load; a changed base is the game's choice", async () => {
    const h = await harness();
    const surfaceM = (groundY + 1) * VOXEL_SIZE_M;
    const pitAt: [number, number, number] = [0.25, surfaceM - 1, 0.25];
    const pit = { center: pitAt, radius: 2 };
    const rimAt: [number, number, number] = [4.25, surfaceM - 1.25, 0.25];
    await h.stepUntil((v) => (v.isResident(pit) ? true : undefined), 'the pit region to load');
    await h.until(() => groundBelow(h.port, 0.25, 0.25)?.id.startsWith('voxel:a:') === true, 'a body under the focus');
    const before = groundBelow(h.port, 0.25, 0.25)!;
    const shipped = await h.inStep((v) => ({ pit: v.get(...pitAt), rim: v.get(...rimAt) }));
    expect(shipped.pit?.material).not.toBe(0);
    expect(shipped.rim?.material).not.toBe(0);
    expect(shipped.rim?.wetness).toBe(0);

    // A dig and rain: the save keeps the hole, not the wetness (the world's default fields).
    const edits = await h.inStep((v) => [v.dig(pit), v.paint({ center: [4.25, surfaceM - 1, 0.25], radius: 1 }, { wetness: 6 })]);
    expect(edits.every((e) => e.ok)).toBe(true);
    const ids = edits.map((e) => (e.ok ? e.edit : 0));
    await h.stepUntil((v) => (ids.every((id) => v.changes.some((c) => c.edit === id)) ? true : undefined), 'both edits to swap');
    expect((await h.inStep((v) => v.get(...rimAt)))?.wetness).toBe(6);
    const save = async (): Promise<{ save: number; ok: boolean; bytes: Uint8Array | null; text: string | null; chunks: number; message?: string }> => {
      let id = 0;
      return h.stepUntil((v) => {
        if (id === 0) id = v.save();
        return v.saves.find((s) => s.save === id);
      }, 'the save to be answered');
    };
    const saved = await save();
    expect(saved).toMatchObject({ ok: true });
    expect(saved.chunks).toBeGreaterThan(0);
    const bytes = saved.bytes!;
    expect(Buffer.from(saved.text!, 'base64').equals(Buffer.from(bytes))).toBe(true);
    const file = readSave(bytes, grid, TEST_WORLD_ID, () => {
      throw new Error('not compressed');
    });
    expect(file.chunks).toHaveLength(saved.chunks);
    // Every field saved: the rain is kept too (more entries or more bytes).
    expect(await h.inStep((v) => v.setSavedFields(['material', 'role', 'shape', 'wetness']))).toBe(true);
    expect(await h.inStep((v) => v.setSavedFields(['colour' as never]))).toBe(false);
    const wet = await save();
    expect(wet.ok).toBe(true);
    expect(wet.bytes!.length).toBeGreaterThan(bytes.length);

    // A new run: the game's changes go and the world's saved fields come back; the restore is read at once and
    // swapped as one change; the hole is back and the rain is not.
    expect(h.rt.queueUiEvent!({ kind: 'restart', doc: '', widget: '', name: '' }).ok).toBe(true);
    await h.stepUntil((v) => (v.get(...pitAt)?.material === shipped.pit?.material ? true : undefined), 'the new run to read the files again');
    await h.until(() => Math.abs(groundBelow(h.port, 0.25, 0.25)!.y - before.y) < 1e-3, 'the body back on the shipped ground');
    const restored = await h.inStep((v) => ({ r: v.restore(saved.text!, 'save'), pit: v.get(...pitAt), rim: v.get(...rimAt) }));
    expect(restored.r).toMatchObject({ ok: true, chunks: saved.chunks });
    expect(restored.pit?.material).toBe(0);
    expect(restored.rim).toEqual(shipped.rim);
    if (!restored.r.ok) return;
    const restoreEdit = restored.r.edit;
    await h.stepUntil((v) => v.changes.find((c) => c.edit === restoreEdit), 'the restore to swap');
    expect(groundBelow(h.port, 0.25, 0.25)!.y).toBeLessThan(before.y - 2.5);
    // Saved again with the world's fields: the same bytes.
    expect(Buffer.from((await save()).bytes!).equals(Buffer.from(bytes))).toBe(true);

    // Another save's world, a broken save and a bad choice are refused, and change nothing.
    const otherWorld = writeSave({ ...file, worldId: new Uint8Array(16).fill(3) }, 'none', (b) => b);
    const refused = await h.inStep((v) => [v.restore(otherWorld, 'save'), v.restore(bytes.slice(0, 50), 'save'), v.restore('not base64!', 'save'), v.restore(bytes, 'maybe' as never)]);
    expect(refused.map((r) => (r.ok ? 'ok' : r.reason))).toEqual(['invalid', 'invalid', 'invalid', 'invalid']);
    expect((await h.inStep((v) => v.get(...pitAt)))?.material).toBe(0);

    // A world whose chunks are not loaded yet (a scene loaded later, the same files): restored as they land.
    expect(h.rt.requestScene!('load', 'scene-b').ok).toBe(true);
    for (const q of h.rt.takeSceneRequests!()) h.rt.provideScene!(q.sceneId, { ok: true, entities: [{ id: 'world-b', components: { transform: { position: [0, surfaceM, 0], ...T }, voxelWorld: worldComponent('b') } }] as never });
    const early = await h.stepUntil((v) => {
      const b = v.world('b');
      if (b === null) return undefined;
      const r = b.restore(bytes, 'save');
      return r.ok ? { r, resident: b.isResident(pit), pit: b.get(...pitAt) } : undefined;
    }, 'world b to open');
    expect(early.resident).toBe(false);
    expect(early.pit).toBeNull();
    await h.stepUntil((v) => (v.world('b')!.isResident(pit) ? true : undefined), 'world b to load the pit');
    const landed = await h.inStep((v) => ({ pit: v.world('b')!.get(...pitAt), rim: v.world('b')!.get(...rimAt) }));
    expect(landed.pit?.material).toBe(0);
    expect(landed.rim).toEqual(shipped.rim);

    // Made on other files (each entry's base hash changed, as a re-exported world would): the game's choice wins and
    // each chunk is reported.
    const moved = writeSave({ ...file, chunks: file.chunks.map((c) => ({ ...c, base: new Uint8Array(16).fill(7) })) }, 'none', (b) => b);
    for (const choice of ['base', 'save'] as const) {
      // Reported at the next step (one step only), so one script asks and watches.
      let r: ReturnType<BehaviorVoxels['restore']> | null = null;
      const reported = await h.stepUntil((v) => {
        if (r === null) {
          r = v.restore(moved, choice);
          return undefined;
        }
        return v.mismatches.length > 0 ? v.mismatches : undefined;
      }, 'the mismatches');
      expect(r!.ok).toBe(true);
      expect(reported.length).toBe(file.chunks.length);
      expect(reported.every((m) => m.world === 'a' && m.kept === (choice === 'save'))).toBe(true);
      expect((await h.inStep((v) => v.get(...pitAt)))?.material).toBe(choice === 'save' ? 0 : shipped.pit?.material);
    }

    // Save sizes: 10 and 100 digs of a 1 m ball at the ground, each at its own spot of the loaded square (the world's default fields).
    expect(h.rt.queueUiEvent!({ kind: 'restart', doc: '', widget: '', name: '' }).ok).toBe(true);
    await h.stepUntil((v) => (v.get(...pitAt)?.material === shipped.pit?.material ? true : undefined), 'the next run');
    const sizes: string[] = [];
    let n = 0;
    for (const target of [10, 100]) {
      while (n < target) {
        const k = n++;
        // A 10 x 10 grid of spots 4.8 m apart, the first ten digs one row of it.
        const x = (k % 10) * 4.8 - 21.35;
        const z = Math.floor(k / 10) * 4.8 - 21.35;
        const ok = await h.inStep((v) => {
          let y = surfaceM + 12;
          while (y > surfaceM - 20 && (v.get(x, y, z)?.material ?? 1) === 0) y -= VOXEL_SIZE_M;
          return v.dig({ center: [x, y, z], radius: 1 }).ok;
        });
        expect(ok).toBe(true);
      }
      const s = await save();
      expect(s.ok).toBe(true);
      sizes.push(`${target} digs: ${s.bytes!.length} B in ${s.chunks} chunks (${s.text!.length} chars as text)`);
    }
    console.log(`save sizes: ${sizes.join('; ')}`);
    expect(h.rt.dispose().ok).toBe(true);
  }, 180_000);

  it('stamps props marked affectsLighting into the lighting occupancy: built as chunks load, rebuilt only where a prop left and entered, equal to a fresh build, never saved, back after an unload', async () => {
    const surfaceM = (groundY + 1) * VOXEL_SIZE_M;
    const yaw = 0.52;
    const rockAt = (x: number): [number, number, number] => [x, surfaceM + 1.3, -0.2];
    const treeAt: [number, number, number] = [8.13, surfaceM - 0.4, -5.07];
    // The script's oracle: the same props in the voxelizer's own form (a yaw and a uniform scale).
    const rock = (at: readonly [number, number, number]): PropShape => ({ inside: (x, y, z) => Math.abs(x) <= 1.3 && Math.abs(y) <= 0.9 && Math.abs(z) <= 0.7, min: [-1.3, -0.9, -0.7], max: [1.3, 0.9, 0.7], position: at, yaw: [Math.cos(yaw), Math.sin(yaw)], scale: 1 });
    const tree: PropShape = { inside: (x, y, z) => Math.abs(x) <= 1 && y >= 0 && y <= 4 && Math.abs(z) <= 1, min: [-1, 0, -1], max: [1, 4, 1], position: treeAt, yaw: [1, 0], scale: 1.5 };
    const model = (assetId: string, lit: boolean): unknown => ({ asset: { assetId }, ...(lit ? { affectsLighting: true } : {}) });
    const entities = [
      // A crate-sized rock with a box collider, turned about +y: its collider is its light shape.
      { id: 'rock', components: { transform: { position: rockAt(0.1), rotation: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)], scale: [1, 1, 1] }, model: model('model-rock', true), collider: { shape: { type: 'box', hx: 1.3, hy: 0.9, hz: 0.7 } } } },
      // A tree without a collider: its model's recorded bounds, scaled with the object.
      { id: 'tree', components: { transform: { position: treeAt, rotation: [0, 0, 0, 1], scale: [1.5, 1.5, 1.5] }, model: model('model-tree', true) } },
      // Not marked: blocks no light.
      { id: 'pebble', components: { transform: { position: [-6.2, surfaceM + 1.5, 4.1], ...T }, model: model('model-rock', false), collider: { shape: { type: 'box', hx: 1, hy: 1, hz: 1 } } } },
    ];
    let stream: VoxelStreamer | null = null;
    const builds: { key: string; bytes: number }[] = [];
    const h = await harness(
      (p) => p,
      (_w, s) => {
        stream = s;
        // Every channel build lands as the chunk's budget part.
        const set = s.setPart.bind(s);
        s.setPart = (cx, cy, cz, part, bytes) => {
          if (part === PROP_COVERAGE_PART) builds.push({ key: `${cx},${cy},${cz}`, bytes });
          return set(cx, cy, cz, part, bytes);
        };
      },
      { world: { world: 'a', ring: { loadRadius: 48, unloadRadius: 56, loadHeight: 32, unloadHeight: 40 }, collision: { radius: 16, height: 16 } }, entities, movers: ['rock', 'world-a'], modelBounds: { 'model-tree': { min: [-1, 0, -1], max: [1, 4, 1] } } },
    );
    const s = (): VoxelStreamer => stream!;
    const sh = grid.shift;
    const chunksOf = (p: PropShape): string[] => {
      const b = propBounds(p);
      const c = (m: number): number => Math.floor(m / VOXEL_SIZE_M) >> sh;
      const out: string[] = [];
      for (let cx = c(b.min[0]!); cx <= c(b.max[0]!); cx++) for (let cy = c(b.min[1]!); cy <= c(b.max[1]!); cy++) for (let cz = c(b.min[2]!); cz <= c(b.max[2]!); cz++) out.push(`${cx},${cy},${cz}`);
      return out;
    };
    /** Every derive section of the chunks has a result. */
    const derived = (chunks: readonly string[]): boolean => {
      const sec = s().sections;
      const per = grid.edge / sec.edge;
      return chunks.every((id) => {
        const [cx, cy, cz] = id.split(',').map(Number) as [number, number, number];
        for (let i = 0; i < per ** 3; i++) if (s().derivedOf(cx * per + (i % per), cy * per + (Math.floor(i / per) % per), cz * per + Math.floor(i / per / per), true) === null) return false;
        return true;
      });
    };
    /** Nothing read, decoded or derived for 30 steps, and the chunks derived. */
    const settle = async (what: string, chunks: readonly string[]): Promise<void> => {
      let quiet = 0;
      await h.until(() => {
        const m = s().metrics();
        quiet = m.reading + m.decoding + m.deriving === 0 ? quiet + 1 : 0;
        return quiet >= 30 && derived(chunks);
      }, what, 60_000);
    };
    /** Every cell of the chunks: `coverageAt` (read by the script) = the drawn construction joined with a fresh build of the props. */
    const sameAsFresh = async (props: readonly PropShape[], chunks: readonly string[]): Promise<number> => {
      const sec = s().sections;
      const r = await h.inStep((v) => {
        let covered = 0;
        const bad: string[] = [];
        for (const id of chunks) {
          const [cx, cy, cz] = id.split(',').map(Number) as [number, number, number];
          if (!s().isResident(cx, cy, cz)) {
            bad.push(`${id} not resident`);
            continue;
          }
          const want = propCoverageChunk(grid, cx, cy, cz, props, VOXEL_SIZE_M);
          for (let x = 0; x < grid.edge; x++) for (let z = 0; z < grid.edge; z++) for (let y = 0; y < grid.edge; y++) {
            const gx = (cx << sh) + x;
            const gy = (cy << sh) + y;
            const gz = (cz << sh) + z;
            const d = s().derivedOf(gx >> sec.shift, gy >> sec.shift, gz >> sec.shift, true);
            const got = v.coverageAt((gx + 0.5) * VOXEL_SIZE_M, (gy + 0.5) * VOXEL_SIZE_M, (gz + 0.5) * VOXEL_SIZE_M);
            if (d === null) {
              if (bad.length < 5) bad.push(`${gx},${gy},${gz} has no derive`);
              continue;
            }
            const p = want === null ? 0 : want[(((x << sh) | z) << sh) | y]!;
            if (p > 0) covered++;
            const m = sec.mask;
            const light = d.assembly?.light;
            const e = light === undefined ? p : lightCoverageAt(light, ((((gx & m) << sec.shift) | (gz & m)) << sec.shift) | (gy & m), p);
            if (got !== e / 255 && bad.length < 5) bad.push(`${gx},${gy},${gz}: ${got} vs ${e / 255}`);
          }
        }
        return { covered, bad };
      });
      expect(r.bad).toEqual([]);
      return r.covered;
    };
    /** Each of the world's files and its checksum. */
    const files = (): string[] => {
      const out: string[] = [];
      for (const f of readdirSync(join(dir, 'world'), { recursive: true, withFileTypes: true })) if (f.isFile()) out.push(`${join(f.parentPath, f.name)} ${crc32(readFileSync(join(f.parentPath, f.name)))}`);
      return out.sort();
    };
    const filesBefore = files();

    const area = { min: [-12, surfaceM - 6, -12] as [number, number, number], max: [12, surfaceM + 8, 12] as [number, number, number] };
    const rockChunks = chunksOf(rock(rockAt(0.1)));
    const treeChunks = chunksOf(tree);
    const moved = chunksOf(rock(rockAt(20.1)));
    const all = [...new Set([...rockChunks, ...treeChunks, ...chunksOf(rock([-6.2, surfaceM + 1.5, 4.1]))])];
    const watched = [...new Set([...all, ...moved])];
    await h.stepUntil((v) => (v.isResident(area) ? true : undefined), 'the props to load');
    await settle('the ring to settle', watched);
    expect(rockChunks.length).toBe(4);
    expect(await sameAsFresh([rock(rockAt(0.1)), tree], all)).toBeGreaterThan(100);
    const at = await h.inStep((v) => ({ rock: v.coverageAt(...rockAt(0.1)), pebble: v.coverageAt(-6.2, surfaceM + 1.5, 4.1), far: v.coverageAt(5000, surfaceM, 5000) }));
    expect(at).toEqual({ rock: 1, pebble: 0, far: null });
    // Counted in the budget: a covered chunk's 32³ bytes, an uncovered one nothing.
    const last = new Map(builds.map((b) => [b.key, b.bytes]));
    for (const k of rockChunks) expect(last.get(k)).toBe(grid.cellsPerChunk);
    expect([...last.values()].filter((b) => b > 0).length).toBeGreaterThanOrEqual(rockChunks.length);

    // The game's changes and their save, before the rock moves.
    const dig = await h.inStep((v) => v.dig({ center: [-8, surfaceM - 1, 6], radius: 1.5 }));
    expect(dig.ok).toBe(true);
    const saveNow = async (): Promise<Uint8Array> => {
      let id = 0;
      const a = await h.stepUntil((v) => {
        if (id === 0) id = v.save();
        return v.saves.find((x) => x.save === id);
      }, 'a save');
      expect(a.ok).toBe(true);
      return a.bytes!;
    };
    const saved = await saveNow();
    await settle('the dig to settle', watched);
    const overlay = s().metrics().bytes.overlay;

    // The rock moves 20 m along x: rebuilt are exactly the four chunks it left and the two it entered.
    builds.length = 0;
    h.move('rock', rockAt(20.1));
    await h.stepUntil((v) => (v.coverageAt(...rockAt(20.1)) === 1 ? true : undefined), 'the rock to be stamped where it went');
    expect(builds.map((b) => b.key).sort()).toEqual([...new Set([...rockChunks, ...moved])].sort());
    expect(await sameAsFresh([rock(rockAt(20.1)), tree], [...new Set([...all, ...moved])])).toBeGreaterThan(100);
    expect(await h.inStep((v) => v.coverageAt(...rockAt(0.1)))).toBeLessThan(1);
    // Never saved, never in the voxels or the files: the save, the overlay and the world's files are as they were.
    expect(await saveNow()).toEqual(saved);
    expect(s().metrics().bytes.overlay).toBe(overlay);
    expect(files()).toEqual(filesBefore);

    // The world's focus goes 100 m away (the props' chunks unload) and comes back: the channel is built again as they load.
    h.move('world-a', [100, surfaceM, 0]);
    await h.stepUntil((v) => (v.coverageAt(...rockAt(20.1)) === null && v.coverageAt(...treeAt) === null ? true : undefined), 'the props to unload');
    builds.length = 0;
    h.move('world-a', [0, surfaceM, 0]);
    await h.stepUntil((v) => (v.isResident(area) && v.isResident({ at: rockAt(20.1) }) ? true : undefined), 'the props to load again');
    await settle('the ring to settle again', watched);
    for (const k of [...moved, ...treeChunks]) expect(builds.some((b) => b.key === k)).toBe(true);
    expect(await sameAsFresh([rock(rockAt(20.1)), tree], [...new Set([...all, ...moved])])).toBeGreaterThan(100);
    expect(await h.inStep((v) => v.coverageAt(...rockAt(20.1)))).toBe(1);
    expect(h.rt.dispose().ok).toBe(true);
  }, 180_000);

  it('reports a dig made in the step its region turned resident exactly once, in the step after its whole rebuild swapped (the sections that waited for neighbours too)', async () => {
    let streamer: VoxelStreamer | null = null;
    const h = await harness((p) => p, (_w, s) => void (streamer = s));
    const surfaceM = (groundY + 1) * VOXEL_SIZE_M;
    const pit = { center: [0.25, surfaceM - 1, 0.25] as [number, number, number], radius: 2 };
    // The sections within the rules' reach of the pit whose chunks are resident (they are rebuilt by the dig).
    const c = Math.floor(0.25 / VOXEL_SIZE_M);
    const r = Math.ceil(2 / VOXEL_SIZE_M) + 1;
    const box = { minX: c - r, minY: groundY - 1 - r, minZ: c - r, maxX: c + r, maxY: groundY - 1 + r, maxZ: c + r };
    const rebuilt = (): { cx: number; cy: number; cz: number }[] => {
      const s = streamer!;
      const up = grid.shift - s.sections.shift;
      return dependentChunks(s.sections, box, jobRadius(WORLD_RULES)).filter((d) => s.isResident(d.cx >> up, d.cy >> up, d.cz >> up));
    };
    // The dig goes in the first step that finds the pit resident: its neighbours are still loading, so some of the
    // sections it rebuilds cannot derive yet.
    const dug = await h.stepUntil((v) => (v.isResident(pit) ? { r: v.dig(pit), at: v.get(...pit.center), sections: rebuilt() } : undefined), 'the pit to load');
    expect(dug.r.ok).toBe(true);
    expect(dug.at?.material).toBe(0);
    if (!dug.r.ok) return;
    const edit = dug.r.edit;
    // The step given the change counts those sections still waiting for their new result.
    h.probe = () => dug.sections.filter((d) => streamer!.derivedOf(d.cx, d.cy, d.cz) === null).length;
    const mine = (): typeof h.changeLog => h.changeLog.filter((e) => e.change.edit === edit);
    await h.until(() => mine().length > 0, 'the dig to be reported');
    // Two more seconds of steps: the change is never reported again.
    const t0 = performance.now();
    await h.until(() => performance.now() - t0 > 2000, 'two seconds of steps');
    expect(mine().length).toBe(1);
    const [seen] = mine();
    expect(dug.sections.length).toBeGreaterThan(0);
    expect(seen!.change.chunks.length).toBeGreaterThan(0);
    expect(seen!.probe).toBe(0);
    h.probe = undefined;
    // At the ring's edge, where neighbours never come, a dig still swaps (without the sections that cannot derive).
    const edge = { center: [30.5, surfaceM - 1, 0.25] as [number, number, number], radius: 1 };
    expect(await h.inStep((v) => v.isResident(edge) && !v.isResident({ at: [32.5, surfaceM - 1, 0.25] }))).toBe(true);
    const far = await h.inStep((v) => v.dig(edge));
    expect(far.ok).toBe(true);
    if (far.ok) await h.until(() => h.changeLog.some((e) => e.change.edit === far.edit), 'the dig at the ring edge to be reported', 10_000);
    expect(h.rt.dispose().ok).toBe(true);
  }, 120_000);

  it('opens a world as an export ships it: its region files as content files read whole once and checked, the same voxels as the files, a dig read at once and swapped; a changed file is damaged, never air', async () => {
    // The export's layout: each listed region file at content/sha256/<digest>, and the catalog's row naming them.
    const worldDir = join(dir, 'world');
    const shipDir = mkdtempSync(join(dir, 'shipped-'));
    mkdirSync(join(shipDir, 'content', 'sha256'), { recursive: true });
    const files = readdirSync(worldDir).filter((n) => n.endsWith('.vxr')).sort().map((name) => {
      const bytes = readFileSync(join(worldDir, name));
      const digest = sha256Hex(bytes);
      writeFileSync(join(shipDir, 'content', 'sha256', digest), bytes);
      return { name, digest, byteLength: bytes.length };
    });
    expect(files.length).toBeGreaterThan(1);
    const row: ShippedVoxelWorld = { world: 'a', worldId: bytesToHex(TEST_WORLD_ID), edge: 32, layout: 'stacked', footprint: 512, revision: 0, files };
    expect(shippedVoxelWorldsProblem([row])).toBeNull();
    const reads = new Map<string, number>();
    const io = (root: string): SceneCatalogIoLike => ({
      read: async (path) => {
        reads.set(path, (reads.get(path) ?? 0) + 1);
        const b = readFileSync(join(root, path));
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
      },
      sha256Hex: async (b) => sha256Hex(b),
    });
    const ports = shippedVoxelPorts({ worlds: [row], io: io(shipDir), workerUrl: 'unused', createWorker: () => nodePoolWorker(workerFile), workers: 2 });
    const h = await harness(() => ports);
    const surfaceM = (groundY + 1) * VOXEL_SIZE_M;
    const pit = { center: [0.25, surfaceM - 1, 0.25] as [number, number, number], radius: 2 };
    // Every cell of a 16 m × 16 m × 8 m block round the focus reads as the files hold it.
    const block = { min: [-8, (groundY - 8) * VOXEL_SIZE_M, -8] as const, max: [8, (groundY + 8) * VOXEL_SIZE_M, 8] as const };
    await h.stepUntil((v) => (v.isResident(pit) && v.isResident(block) ? true : undefined), 'the block round the focus to load');
    const v0: VoxelRecord = { material: 0, role: 0, shape: 0, wetness: 0 };
    const mismatches = await h.inStep((v) => {
      let bad = 0;
      for (let x = -16; x < 16; x++) for (let z = -16; z < 16; z++) for (let y = groundY - 8; y < groundY + 8; y++) {
        const got = v.get((x + 0.5) * VOXEL_SIZE_M, (y + 0.5) * VOXEL_SIZE_M, (z + 0.5) * VOXEL_SIZE_M);
        const want = oracle.voxelAt(x, y, z, v0);
        if (got === null || got.material !== want.material || got.role !== want.role || got.shape !== want.shape) bad++;
      }
      return bad;
    });
    expect(mismatches).toBe(0);
    // A file is read whole once, however many chunks of it are read.
    expect(reads.size).toBeGreaterThan(0);
    for (const [path, n] of reads) expect(n, path).toBe(1);
    const dug = await h.inStep((v) => ({ r: v.dig(pit), at: v.get(...pit.center) }));
    expect(dug.r.ok).toBe(true);
    expect(dug.at?.material).toBe(0);
    if (dug.r.ok) {
      const edit = dug.r.edit;
      await h.until(() => h.changeLog.some((e) => e.change.edit === edit), 'the dig to swap');
    }
    expect(h.rt.dispose().ok).toBe(true);

    // One file's bytes changed (same length): its chunks are damaged, the others read; nothing reads as air in its place.
    const bad = files.find((f) => f.byteLength > 4096)!;
    const broken = Buffer.from(readFileSync(join(shipDir, 'content', 'sha256', bad.digest)));
    broken[broken.length - 1] = broken[broken.length - 1]! ^ 0xff;
    writeFileSync(join(shipDir, 'content', 'sha256', bad.digest), broken);
    const resolve = bufferResolverOf(files, io(shipDir));
    const source = shippedChunkSource(row, async (f) => new Uint8Array(await resolve(f.digest)));
    const disk = new DiskRegions(worldDir);
    disks.push(disk);
    const plain = disk.source(grid, 'stacked', 512);
    const at = parseRegionFileName('stacked', bad.name)!;
    const side = 512 / 32;
    // Every chunk of the region, and the same chunks of a good region.
    const chunks = Array.from({ length: side ** 3 }, (_, i) => ({ cx: at.rx * side + (i % side), cy: at.ry * side + (Math.floor(i / side) % side), cz: at.rz * side + Math.floor(i / side ** 2) }));
    const [shipped, onDisk] = [await source.read(chunks), await plain.read(chunks)];
    expect(onDisk.some((r) => r.kind !== 'air' && r.kind !== 'damaged')).toBe(true);
    for (const r of shipped) expect(r.kind).toBe('damaged');
    const good = files.find((f) => f !== bad)!;
    const g = parseRegionFileName('stacked', good.name)!;
    const other = chunks.map((c) => ({ cx: c.cx + (g.rx - at.rx) * side, cy: c.cy + (g.ry - at.ry) * side, cz: c.cz + (g.rz - at.rz) * side }));
    expect((await source.read(other)).map((r) => r.kind)).toEqual((await plain.read(other)).map((r) => r.kind));
    // The good file is held whole and counts in the budget with its table; the damaged one holds nothing.
    const goodOnly = disk.source(grid, 'stacked', 512);
    await goodOnly.read(other);
    expect(goodOnly.memoryBytes()).toBeGreaterThan(0);
    expect(source.memoryBytes()).toBe(goodOnly.memoryBytes() + good.byteLength);
    rmSync(shipDir, { recursive: true, force: true });
  }, 120_000);
});
