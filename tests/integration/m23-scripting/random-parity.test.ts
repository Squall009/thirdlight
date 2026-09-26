/**
 * Phase 23.7: `ctx.random` (and the other scripting conveniences) draw and
 * decide exactly the same in the page and in the simulation worker, and in
 * every replay of a recording.
 *
 * A neutral level with three wandering objects. Their script — TypeScript
 * compiled by the real behavior compiler — steps each object by a random
 * amount every step (the main stream), turns it to face a target picked at
 * random among the entities named "Target" (`ctx.world.findAll` and a
 * `facing` pose, a sub-stream), and now and then spawns a coin at a random
 * place (another sub-stream). The project sets `random_seed`. The same
 * recording is run in the page (single thread) and in the worker (a Node
 * worker thread running the game-host worker core); the digest of every
 * executed step's committed state (every transform bit for bit, counters,
 * spawned entities) must be identical at every step, and again in a second
 * page run of the same recording (a replay). Another seed must change them.
 */
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { M2_PINNED_MODULES, compileBehavior } from '@thirdlight/behavior-build';

import { startHarness, type Harness, type Mode } from '../m22-worker/harness';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const HZ = 120;
const DT = 1 / HZ;
const T = { rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const at = (x: number, y: number, z = 0) => ({ position: [x, y, z], ...T });
const SETTINGS = { run_speed: 5, jump_velocity: 8, gravity_y: -20, max_fall_speed: -20, max_slope_climb_deg: 45, min_slope_slide_deg: 30, random_seed: 20260926 };
const BOX = { size: [0.5, 0.5, 0.5], material: { color: '#88aacc' } };

const PREFABS = [{ prefabId: 'coin', displayName: 'Coin', createdRevision: 1, entityCount: 1, depth: 1, entities: [{ localId: 'box-0002', components: { transform: at(0, 0), box: { size: [0.4, 0.4, 0.1], material: { color: '#ffcc00' } }, pickup: { kind: 'coin', value: 1, size: [0.6, 0.6] } } }] }];

/** The script (TypeScript, compiled by the real compiler). */
const WANDERER = `import type { BehaviorContext } from '@thirdlight/runtime';

type State = { x: number; y: number; target: string | undefined; made: number };

export default {
  instantiate(): State {
    return { x: 0, y: 0, target: undefined, made: 0 };
  },
  step(state: State, ctx: BehaviorContext): void {
    if (ctx.phase === 'intent') {
      if (state.target === undefined || ctx.random.stream('aim').chance(0.02)) {
        state.target = ctx.random.stream('aim').pick(ctx.world.findAll('Target'));
      }
      if (ctx.spawn && state.made < 4 && ctx.random.stream('drops').chance(0.01)) {
        ctx.spawn('coin', { position: [ctx.random.stream('drops').range(2, 40), ctx.random.stream('drops').int(1, 3)] });
        state.made += 1;
      }
      return;
    }
    const me = ctx.world.transform(ctx.entityId);
    if (me === undefined) return;
    if (state.x === 0 && state.y === 0) {
      state.x = me.position[0];
      state.y = me.position[1];
    }
    state.x += ctx.random.range(-0.05, 0.05);
    state.y += ctx.random.range(-0.02, 0.02);
    ctx.emit({ kind: 'transform', entityId: ctx.entityId, position: { x: state.x, y: state.y } });
    const aim = state.target === undefined ? undefined : ctx.world.transform(state.target);
    if (aim !== undefined) {
      const dx = aim.position[0] - state.x;
      const dz = aim.position[2] - me.position[2];
      if (Math.abs(dx) + Math.abs(dz) > 1e-6) ctx.emit({ kind: 'pose', entityId: ctx.entityId, facing: [dx, 0, dz] });
    }
  },
};
`;

async function compiledWanderer(): Promise<{ row: Any; url: string }> {
  const container = { graphVersion: 1, entryPath: 'src/index.ts', requiredModules: ['@thirdlight/runtime'], ownedTransforms: ['@self'], files: [{ path: 'src/index.ts', text: WANDERER }] };
  const bytes = new TextEncoder().encode(`${JSON.stringify(container, null, 2)}\n`);
  const r = await compileBehavior({ behaviorId: 'wanderer', declaration: { properties: [] }, containerBytes: bytes, pinnedModules: M2_PINNED_MODULES });
  if (!r.ok) throw new Error(`compile failed: ${JSON.stringify(r)}`);
  const source = r.outputBytes;
  return {
    row: {
      behaviorId: 'wanderer',
      sourceDigest: createHash('sha256').update(bytes).digest('hex'),
      manifestDigest: r.manifestDigest,
      outputDigest: r.outputDigest,
      declaration: r.manifest.declaration,
      ownedTransforms: r.manifest.ownedTransforms,
      requiredModules: r.manifest.requiredModules,
      path: 'wanderer',
    },
    url: `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`,
  };
}

function level(): { snapshot: Any; physics: Any } {
  const wanderer = (id: string, x: number, y: number) => ({ id, components: { transform: at(x, y), box: BOX, behavior: { behaviorId: 'wanderer', values: {} } } });
  const entities: Any[] = [
    { id: 'cam-main', components: { transform: at(0, 4, 12), camera: { type: 'perspective', fovY: 45, near: 0.1, far: 200 }, cameraFollow: { deadZone: { x: 0.5, y: 0.5 }, smoothing: 0.2 } } },
    { id: 'player-0001', components: { transform: at(0, 0.91), controller: {} } },
    { id: 'spawn-0001', components: { transform: at(0, 0.91), playerSpawn: {} } },
    { id: 'floor-0001', components: { transform: at(20, -0.5), box: { size: [80, 1, 2], material: { color: '#888888' } }, collider: { shape: { type: 'box', hx: 40, hy: 0.5 } } } },
    { id: 'box-t1', name: 'Target', components: { transform: at(-6, 2, 3), box: BOX } },
    { id: 'box-t2', name: 'Target', components: { transform: at(8, 3, -4), box: BOX } },
    { id: 'box-t3', name: 'Target', components: { transform: at(15, 1, 5), box: BOX } },
    wanderer('box-w1', 2, 3),
    wanderer('box-w2', 6, 4),
    wanderer('box-w3', 10, 5),
  ];
  const statics = [{ entityId: 'floor-0001', shape: { type: 'box', hx: 40, hy: 0.5 }, position: { x: 20, y: -0.5 }, rotationZ: 0 }];
  return {
    snapshot: {
      snapshotId: 'wander@r1',
      projectId: 'wander',
      revision: 1,
      scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities },
      game: { configVersion: 2, title: 'Wander', objective: 'o', instructions: 'i', playerId: 'player-0001', cameraId: 'cam-main', spawnId: 'spawn-0001', cues: { start: null, jump: null, checkpoint: null, death: null, goal: null } },
      prefabs: PREFABS,
    },
    physics: {
      character: { x: 0, y: 0.91 },
      statics,
      solver: { hz: HZ, gravityY: SETTINGS.gravity_y },
      controller: { offsetSkin: 0.01, groundSnap: 0.1, maxSlopeClimbRad: Math.PI / 4, minSlopeSlideRad: Math.PI / 6, autostep: false },
    },
  };
}

const STEPS = 900;
/** A recorded input: the player walks right with pauses (the scripts do not read it; it drives the level). */
function recording(): Any[] {
  const frames: Any[] = [];
  for (let s = 0; s < STEPS + 200; s += 1) frames.push({ stepIndex: s, moveX: s % 300 < 40 ? 0 : 0.6, jump: 'none' });
  return frames;
}
const PATTERN = [1, 2, 1, 0, 3, 1, 1, 2, 0, 1];

async function run(mode: Mode, behavior: { row: Any; url: string }, settings: Any = SETTINGS): Promise<{ h: Harness; digests: string[]; end: Any }> {
  const { snapshot, physics } = level();
  const h = await startHarness(mode, { snapshot, settings, physics, behaviors: [behavior], enginePins: M2_PINNED_MODULES, digestSteps: true, replay: recording() });
  let now = 10;
  await h.tick(now);
  const started = h.host.control('start');
  if (!started.ok) throw new Error(JSON.stringify(started.error));
  let i = 0;
  while (h.digests.length < STEPS) {
    const steps = PATTERN[i++ % PATTERN.length]!;
    now += steps * DT + DT * 0.25 * ((i % 3) - 1) * 0.5;
    await h.tick(now);
  }
  const state = h.rt.getInterpolatedState().state;
  const end = {
    wanderers: state.transforms.filter((t: Any) => t.id.startsWith('box-w')).map((t: Any) => ({ id: t.id, position: [...t.position], rotation: [...t.rotation] })),
    spawned: h.rt.sceneSet().spawned.map((e: Any) => e.id),
    failed: (h.rt.getDiagnostics() as Any).diagnostics?.errors?.map((e: Any) => e.message) ?? [],
  };
  return { h, digests: [...h.digests], end };
}

describe('phase 23.7: ctx.random gives identical results in the page, the worker and a replay', () => {
  it('a compiled script with random streams, name queries and facing poses: every step digest is equal', async () => {
    const behavior = await compiledWanderer();
    const a = await run('single', behavior);
    const b = await run('worker', behavior);
    const c = await run('single', behavior); // the recording played again
    try {
      expect(a.end.failed).toEqual([]);
      expect(a.digests.length).toBeGreaterThanOrEqual(STEPS);
      expect(new Set(a.digests).size).toBeGreaterThan(STEPS - 50);
      for (const other of [b, c]) {
        const n = Math.min(a.digests.length, other.digests.length);
        const firstDiff = a.digests.slice(0, n).findIndex((d, k) => d !== other.digests[k]);
        expect(firstDiff, `first differing step ${firstDiff}`).toBe(-1);
        expect(other.end).toEqual(a.end);
      }
      // The script really used its streams: the objects moved off their start, turned, and spawned coins.
      expect(a.end.spawned.length).toBeGreaterThan(0);
      for (const w of a.end.wanderers) {
        expect(w.rotation).not.toEqual([0, 0, 0, 1]);
        expect(Math.hypot(w.rotation[0], w.rotation[1], w.rotation[2], w.rotation[3])).toBeCloseTo(1, 12);
      }
      expect(a.end.wanderers.map((w: Any) => w.position[0])).not.toEqual([2, 6, 10]);
    } finally {
      await a.h.dispose();
      await b.h.dispose();
      await c.h.dispose();
    }
  }, 180_000);

  it('another random_seed changes the run (the seed reaches the worker)', async () => {
    const behavior = await compiledWanderer();
    const a = await run('worker', behavior);
    const b = await run('worker', behavior, { ...SETTINGS, random_seed: 7 });
    try {
      expect(b.end.failed).toEqual([]);
      expect(b.digests.slice(0, 300)).not.toEqual(a.digests.slice(0, 300));
      expect(b.end.wanderers).not.toEqual(a.end.wanderers);
    } finally {
      await a.h.dispose();
      await b.h.dispose();
    }
  }, 180_000);
});
