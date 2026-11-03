/**
 * The runtime's voxel worlds and `ctx.voxels` at real boundaries: a real
 * runtime (instantiateRuntime) whose scenes carry `voxelWorld` objects, a
 * script reading and changing the world through `ctx.voxels`, the worlds
 * opened through injected ports onto region files on disk and
 * `worker_threads` workers running the bundled worker, and the engine's
 * real physics backend (Rapier through physics-rapier's port) holding the
 * collision ring's bodies.
 */
import { mkdtempSync, rmSync } from 'node:fs';
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
} from '@thirdlight/runtime';
import { chunkGrid, createWorldStore, dependentChunks, jobRadius, PLACEHOLDER_RULES, VOXEL_SIZE_M, WorkerPool, type PaletteStore, type VoxelRecord } from '@thirdlight/voxel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bundleWorker, DiskRegions, nodePoolWorker, REPO, writeWorldRegions } from './stream-node';
import { hillyWorld } from './worlds';

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

function artifact(behaviorId: string, step: (ctx: { voxels: BehaviorVoxels }) => void): BehaviorArtifact {
  return {
    behaviorId,
    sourceDigest: 'a'.repeat(64),
    manifestDigest: 'b'.repeat(64),
    outputDigest: 'c'.repeat(64),
    ownedTransforms: [],
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
}

async function harness(): Promise<Harness> {
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
      return { grid, source: disk.source(grid, 'stacked', 512), pool, close: () => void closed.push(world) };
    },
  };
  let job: ((v: BehaviorVoxels) => boolean) | null = null;
  const spec = createBehaviorModuleSpec({
    declaration: DECL,
    artifact: artifact('digger', (ctx) => {
      if (job?.(ctx.voxels) === true) job = null;
    }),
  });
  const registry = createSimulationRegistry();
  registerSimulationModule(registry, spec.id, spec);
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
        { id: 'world-a', components: { transform: { position: focusM, ...T }, voxelWorld: worldComponent('a') } },
        { id: 'digger', components: { transform: { position: [0, 0, 0], ...T }, behavior: { behaviorId: 'digger', values: {} } } },
      ],
    },
    scenes: [
      { sceneId: 'scene-main', start: true, entityIds: ['world-a', 'digger'] },
      { sceneId: 'scene-b', start: false },
    ],
  };
  const now = { t: 0 };
  const res = instantiateRuntime({ snapshot, registry, modules: [spec.id], actions: { sample: (i: number) => neutralFrame(i) }, physics: port, settings: {}, clock: () => now.t, driver: { kind: 'manual' }, voxels: ports });
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
  return { rt, port, inStep, stepUntil, until, opened, closed, poolsClosed };
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
    const reach = new Set(dependentChunks(grid, box, jobRadius(PLACEHOLDER_RULES)).map((k) => `${k.cx},${k.cy},${k.cz}`));
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
});
