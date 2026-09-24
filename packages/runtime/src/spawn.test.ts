/**
 * Phase 14.1 — `ctx.spawn` / `ctx.destroy`: project prefabs copied into the
 * running game (never the project). The pure expansion and option rules, and
 * the runtime: requests queue with the step and apply at the next boundary in
 * order, colliders go to the physics port, scripts and gameplay blocks attach,
 * destroy releases all of it, engine limits refuse with a diagnostic, a new
 * run removes every copy (ids are never reused), saves keep none, and
 * the same inputs give the same ids and transforms.
 *
 * The gameplay/camera modules are test stubs and the physics port records
 * the collider calls; Rapier is covered by tests/integration/m14-spawn.
 */
import { describe, expect, it } from 'vitest';

import {
  MAX_LIVE_SPAWNED,
  MAX_SPAWNS_PER_STEP,
  createBehaviorModuleSpec,
  createSimulationRegistry,
  expandPrefab,
  instantiateRuntime,
  neutralFrame,
  parseSpawnOptions,
  registerSimulationModule,
  type Runtime,
  type SimulationModuleSpec,
  type StaticColliderSpec,
} from './index';

const DT = 1 / 120;
const DECL = { properties: [{ key: 'target', label: 'Target', type: 'entityRef', default: null }] } as never;
const T = { rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const at = (x: number, y: number, z = 0): { position: number[]; rotation: number[]; scale: number[] } => ({ position: [x, y, z], ...T });

/** Neutral prefabs: a crate that blocks, a coin, a sliding block (mover), a two-part thing with a script whose property names its child. */
const PREFABS = [
  { prefabId: 'crate', displayName: 'Crate', createdRevision: 1, entityCount: 1, depth: 1, entities: [{ localId: 'box-0001', components: { transform: at(5, 5, -1), box: { size: [1, 1, 1], material: { color: '#aa7733' } }, collider: { shape: { type: 'box', hx: 0.5, hy: 0.5 } } } }] },
  { prefabId: 'coin', displayName: 'Coin', createdRevision: 1, entityCount: 1, depth: 1, entities: [{ localId: 'box-0002', components: { transform: at(0, 0), box: { size: [0.4, 0.4, 0.1], material: { color: '#ffcc00' } }, pickup: { kind: 'coin', value: 1, size: [0.6, 0.6] } } }] },
  { prefabId: 'slider', displayName: 'Slider', createdRevision: 1, entityCount: 1, depth: 1, entities: [{ localId: 'box-0003', components: { transform: at(0, 0), box: { size: [0.2, 0.2, 0.2], material: { color: '#ffffff' } }, mover: { waypoints: [[10, 0, 0]], speed: 30, mode: 'once' } } }] },
  {
    prefabId: 'pair',
    displayName: 'Pair',
    createdRevision: 1,
    entityCount: 2,
    depth: 2,
    entities: [
      { localId: 'group-0001', name: 'Pair', components: { transform: at(0, 0, 2), behavior: { behaviorId: 'part', values: { target: 'box-0009' } } } },
      { localId: 'box-0009', parentLocalId: 'group-0001', components: { transform: at(1, 0), box: { size: [1, 1, 1], material: { color: '#3366ff' } } } },
    ],
  },
];

interface PortLog {
  added: string[];
  removed: string[];
}

function recordingPort(log: PortLog): unknown {
  const zero = { x: 0, y: 0 };
  return {
    stageCharacterMove() {},
    step() {
      return { requested: { ...zero }, applied: { ...zero }, position: { x: 0, y: 0 }, grounded: true, supportNormal: { x: 0, y: 1 }, contacts: { ground: true, wall: false, head: false, steepSlope: false }, snapped: false };
    },
    reset() {},
    clearCharacterMotion() {},
    placeCharacter() {
      return { ok: true, supportNormal: { x: 0, y: 1 } };
    },
    characterClearance() {
      return { ok: true, supportNormal: { x: 0, y: 1 } };
    },
    addStaticColliders(specs: readonly StaticColliderSpec[]) {
      log.added.push(...specs.map((s) => `${s.entityId}@${s.position.x},${s.position.y}`));
    },
    removeStaticColliders(ids: readonly string[]) {
      log.removed.push(...ids);
    },
    setKinematicPositions() {},
    diagnostics() {
      return {};
    },
    dispose() {},
  };
}

const stubGameplay: SimulationModuleSpec = { id: 'thirdlight.teststub:gameplay', phases: ['gameplay'], create: () => ({ transformOwners: [], step() {} }) };
const stubCamera: SimulationModuleSpec = { id: 'thirdlight.teststub:camera', phases: ['camera'], create: () => ({ transformOwners: ['cam-main'], step() {} }) };

interface SpawnCtx {
  stepIndex: number;
  phase: string;
  entityId: string;
  emit(intent: unknown): void;
  spawn(prefabId: string, options: unknown): string | null;
  destroy(id: string): boolean;
  world: { transform(id: string): { position: readonly number[] } | undefined };
}

function artifact(behaviorId: string, step: (ctx: SpawnCtx) => void, calls: string[], ownedTransforms: string[] = []): never {
  return {
    behaviorId,
    sourceDigest: 'a'.repeat(64),
    manifestDigest: 'b'.repeat(64),
    outputDigest: 'c'.repeat(64),
    ownedTransforms,
    requiredModules: [],
    enginePins: [],
    namespace: {
      default: {
        instantiate: (_p: unknown, inst: { entityId: string; properties: Record<string, unknown> }) => {
          calls.push(`instantiate ${behaviorId} ${inst.entityId}${inst.properties['target'] !== undefined && inst.properties['target'] !== null ? ` -> ${String(inst.properties['target'])}` : ''}`);
          return {};
        },
        step: (_s: unknown, ctx: SpawnCtx) => step(ctx),
        dispose: (_p: unknown, _state: unknown) => calls.push(`dispose ${behaviorId}`),
      },
    },
  } as never;
}

function harness(script: (ctx: SpawnCtx) => void, more: { specs?: SimulationModuleSpec[]; prefabs?: unknown[]; entities?: unknown[] } = {}) {
  const log: PortLog = { added: [], removed: [] };
  const calls: string[] = [];
  const spawner = createBehaviorModuleSpec({ declaration: DECL, artifact: artifact('spawner', script, calls) });
  const part = createBehaviorModuleSpec({ declaration: DECL, artifact: artifact('part', () => {}, calls) });
  const specs = [spawner, part, ...(more.specs ?? []), stubGameplay, stubCamera];
  const registry = createSimulationRegistry();
  for (const s of specs) registerSimulationModule(registry, s.id, s);
  const now = { t: 0 };
  const res = instantiateRuntime({
    snapshot: {
      snapshotId: 'spawns@r1',
      projectId: 'spawns',
      revision: 1,
      scene: {
        schemaVersion: 4,
        sceneId: 'scene-main',
        revision: 1,
        entities: [
          { id: 'cam-main', components: { transform: at(0, 4, 12), camera: { type: 'perspective', fovY: 45, near: 0.1, far: 100 }, cameraFollow: { deadZone: { x: 0.5, y: 0.5 }, smoothing: 0.2 } } },
          { id: 'player-0001', components: { transform: at(0, 0) } },
          { id: 'spawn-0001', components: { transform: at(0, 0), playerSpawn: {} } },
          { id: 'box-spawner', components: { transform: at(0, -5), box: { size: [1, 1, 1], material: { color: '#ffffff' } }, behavior: { behaviorId: 'spawner', values: {} } } },
          ...(more.entities ?? []),
        ],
      },
      game: { configVersion: 2, title: 'Spawns', objective: 'o', instructions: 'i', playerId: 'player-0001', cameraId: 'cam-main', spawnId: 'spawn-0001', cues: { start: null, jump: null, checkpoint: null, death: null, goal: null } },
      prefabs: [...PREFABS, ...(more.prefabs ?? [])],
    },
    registry,
    modules: specs.map((s) => s.id),
    actions: { sample: (i: number) => neutralFrame(i) },
    physics: recordingPort(log) as never,
    settings: {},
    clock: () => now.t,
    driver: { kind: 'manual' },
  });
  if (!res.ok) throw new Error(`instantiate failed: ${JSON.stringify(res.error)}`);
  const rt: Runtime = res.runtime;
  expect(rt.start().ok).toBe(true);
  expect(rt.tick(now.t).ok).toBe(true); // settle pre-roll
  expect(rt.gameCommand('start').ok).toBe(true);
  const tick = (n = 1): void => {
    for (let i = 0; i < n; i += 1) {
      now.t += DT;
      const r = rt.tick(now.t);
      if (!r.ok) throw new Error(`tick failed: ${JSON.stringify(r.error)}`);
    }
  };
  const transforms = (): Map<string, readonly number[]> => {
    const st = rt.getInterpolatedState();
    return new Map(st.ok ? st.state.transforms.map((t) => [t.id, t.position] as const) : []);
  };
  const diag = () => (rt.getDiagnostics() as { diagnostics: { state: string; errors: { code: string; reason?: string; message: string }[] } }).diagnostics;
  const spawned = (): string[] => rt.sceneSet!().spawned.map((e) => e.id);
  return { rt, log, calls, tick, transforms, diag, spawned };
}

describe('spawn: expandPrefab and parseSpawnOptions (pure)', () => {
  const pair = PREFABS[3] as never;
  const crate = PREFABS[0] as never;
  it('places the root, keeps children local, remaps ids, parents and entity references, records provenance', () => {
    const parsed = parseSpawnOptions(pair, { position: [3, 4] });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // [x, y]: the root keeps its authored z (2).
    expect(parsed.placement).toEqual({ position: [3, 4, 2], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
    const out = expandPrefab(pair, ['spawn-7', 'spawn-8'], parsed.placement) as unknown as { id: string; name?: string; parentId?: string; components: Record<string, unknown> }[];
    expect(out.map((e) => [e.id, e.parentId ?? null, e.name ?? null])).toEqual([['spawn-7', null, 'Pair'], ['spawn-8', 'spawn-7', null]]);
    expect((out[0]!.components['transform'] as { position: number[] }).position).toEqual([3, 4, 2]);
    expect((out[1]!.components['transform'] as { position: number[] }).position).toEqual([1, 0, 0]);
    expect(out[0]!.components['behavior']).toEqual({ behaviorId: 'part', values: { target: 'spawn-8' } });
    expect(out[1]!.components['prefab']).toEqual({ prefabId: 'pair', localId: 'box-0009' });
    // The definition itself is untouched.
    expect((PREFABS[3]!.entities[0]!.components as { behavior: { values: { target: string } } }).behavior.values.target).toBe('box-0009');
  });

  it('takes [x, y, z], a normalized rotation and a scale; refuses bad options', () => {
    const r = parseSpawnOptions(pair, { position: [1, 2, 3], rotation: [0, 0, 2, 0], scale: 2 });
    expect(r.ok && r.placement).toEqual({ position: [1, 2, 3], rotation: [0, 0, 1, 0], scale: [2, 2, 2] });
    for (const bad of [undefined, {}, { position: [1] }, { position: [1, Number.NaN] }, { position: [0, 0], scale: 0 }, { position: [0, 0], rotation: [0, 0, 0, 0] }, { position: [0, 0], speed: 3 }]) {
      expect(parseSpawnOptions(pair, bad).ok).toBe(false);
    }
    // A collider stays at unit scale and turns about Z only.
    expect(parseSpawnOptions(crate, { position: [0, 0], rotation: [0, 0, 0.7071068, 0.7071068] }).ok).toBe(true);
    expect(parseSpawnOptions(crate, { position: [0, 0], rotation: [0.7071068, 0, 0, 0.7071068] }).ok).toBe(false);
    expect(parseSpawnOptions(crate, { position: [0, 0], scale: 2 }).ok).toBe(false);
  });
});

describe('spawn: the runtime (ctx.spawn / ctx.destroy)', () => {
  it('spawns at the next step boundary with colliders and scripts, returns fresh ids; destroy releases them', () => {
    const got: Record<string, unknown> = {};
    let destroyAt = -1;
    const h = harness((ctx) => {
      if (ctx.stepIndex === 20) {
        got['crate'] = ctx.spawn('crate', { position: [4, 0.5] });
        got['pair'] = ctx.spawn('pair', { position: [8, 1, 0] });
        got['seenNow'] = ctx.world.transform('spawn-1');
      }
      if (ctx.stepIndex === 21) got['seenNext'] = ctx.world.transform('spawn-1')?.position;
      if (ctx.stepIndex === destroyAt) {
        got['destroyPair'] = ctx.destroy('spawn-2');
        got['destroyAgain'] = ctx.destroy('spawn-2');
        got['destroyChildOfGone'] = ctx.destroy('spawn-3');
        got['destroyUnknown'] = ctx.destroy('spawn-99');
      }
    });
    h.tick(30);
    expect(got['crate']).toBe('spawn-1');
    expect(got['pair']).toBe('spawn-2');
    expect(got['seenNow']).toBeUndefined(); // it appears at the next boundary
    expect(got['seenNext']).toEqual([4, 0.5, -1]);
    expect(h.spawned()).toEqual(['spawn-1', 'spawn-2', 'spawn-3']);
    expect(h.log.added).toEqual(['spawn-1@4,0.5']);
    const t = h.transforms();
    expect(t.get('spawn-2')).toEqual([8, 1, 0]);
    expect(t.get('spawn-3')).toEqual([1, 0, 0]); // local to its parent
    // The pair's script runs on the copy, its entity reference remapped.
    expect(h.calls).toContain('instantiate part spawn-2 -> spawn-3');
    destroyAt = 50;
    h.tick(15);
    expect(got['destroyPair']).toBe(true);
    expect(got['destroyAgain']).toBe(false);
    expect(got['destroyChildOfGone']).toBe(true); // still live when asked; gone with its parent
    expect(got['destroyUnknown']).toBe(false);
    expect(h.spawned()).toEqual(['spawn-1']);
    expect(h.calls.filter((c) => c === 'dispose part')).toHaveLength(1);
    expect(h.transforms().has('spawn-3')).toBe(false);
    expect(h.diag().state).toBe('running');
  });

  it('destroy frees a spawned collider; a spawned coin is collected and counted; a spawned mover moves', () => {
    let destroyed = false;
    const h = harness((ctx) => {
      if (ctx.stepIndex === 20) {
        ctx.spawn('crate', { position: [4, 0.5] });
        ctx.spawn('coin', { position: [0, 0] }); // on the player (the recording port keeps it at 0, 0)
        ctx.spawn('slider', { position: [0, 3] });
      }
      if (ctx.stepIndex === 60 && !destroyed) destroyed = ctx.destroy('spawn-1');
    });
    h.tick(30);
    expect(h.rt.gameCounters!().counters).toEqual({ coins: 1 });
    expect(h.rt.hiddenEntities!().has('spawn-2')).toBe(true);
    const x = h.transforms().get('spawn-3')![0]!;
    expect(x).toBeGreaterThan(0.5);
    h.tick(40);
    expect(destroyed).toBe(true);
    expect(h.log.removed).toEqual(['spawn-1']);
    expect(h.transforms().get('spawn-3')![0]).toBeCloseTo(10, 6); // `once`: it stops at its last point
    // Saves never keep spawned entities.
    expect(h.rt.runState!().collected).toEqual([]);
  });

  it('refuses authored entities and unknown prefabs (a script error fail-stops like ctx.scenes)', () => {
    const a = harness((ctx) => {
      if (ctx.stepIndex === 20) ctx.destroy('box-spawner');
    });
    expect(() => a.tick(25)).toThrow();
    expect(a.diag().state).toBe('failed');
    expect(a.diag().errors.some((e) => e.reason === 'behavior_destroy_refused' && e.message.includes('setVisible'))).toBe(true);
    const b = harness((ctx) => {
      if (ctx.stepIndex === 20) ctx.spawn('nope', { position: [0, 0] });
    });
    expect(() => b.tick(25)).toThrow();
    expect(b.diag().errors.some((e) => e.reason === 'behavior_spawn_invalid' && e.message.includes('crate'))).toBe(true);
  });

  it(`limits: ${MAX_SPAWNS_PER_STEP} spawns per step, ${MAX_LIVE_SPAWNED} live; a refusal returns null with one diagnostic`, () => {
    const results: (string | null)[] = [];
    let burst = true;
    const h = harness((ctx) => {
      if (!burst) return;
      if (ctx.stepIndex >= 20 && ctx.stepIndex < 20 + 17) {
        for (let i = 0; i < MAX_SPAWNS_PER_STEP + 1; i++) results.push(ctx.spawn('coin', { position: [50 + i, 50] }));
      }
    });
    h.tick(40);
    burst = false;
    // Step 20: 64 accepted, the 65th refused.
    expect(results.slice(0, MAX_SPAWNS_PER_STEP).every((r) => typeof r === 'string')).toBe(true);
    expect(results[MAX_SPAWNS_PER_STEP]).toBeNull();
    expect(h.spawned()).toHaveLength(MAX_LIVE_SPAWNED);
    const accepted = results.filter((r) => r !== null);
    expect(accepted).toHaveLength(MAX_LIVE_SPAWNED);
    expect(new Set(accepted).size).toBe(MAX_LIVE_SPAWNED);
    const refusals = h.diag().errors.filter((e) => e.code === 'spawn_refused');
    expect(refusals.length).toBeGreaterThanOrEqual(2);
    expect(refusals.some((e) => e.message.includes(`${MAX_LIVE_SPAWNED} spawned entities alive`))).toBe(true);
    expect(h.diag().state).toBe('running');
  });

  it('a new run removes every spawned entity (ids are never reused); the same inputs give the same game', () => {
    const record = (): { h: ReturnType<typeof harness>; ids: string[] } => {
      const ids: string[] = [];
      const h = harness((ctx) => {
        if (ctx.stepIndex % 10 === 0) {
          const id = ctx.spawn(ctx.stepIndex % 20 === 0 ? 'crate' : 'slider', { position: [ctx.stepIndex / 10, 1] });
          if (id !== null) ids.push(id);
        }
        if (ctx.stepIndex % 30 === 5 && ids.length > 1) ctx.destroy(ids[ids.length - 2]!);
      });
      return { h, ids };
    };
    const a = record();
    const b = record();
    a.h.tick(95);
    b.h.tick(95);
    expect(a.ids).toEqual(b.ids);
    expect([...a.h.transforms()]).toEqual([...b.h.transforms()]);
    expect(a.h.spawned().length).toBeGreaterThan(3);
    const before = a.h.spawned();
    // A replay: none left (colliders freed); ids keep counting, so an old id names nothing.
    expect(a.h.rt.gameCommand('replay').ok).toBe(true);
    const firstAfter = a.ids.length;
    a.h.tick(1);
    expect(a.h.spawned()).toEqual([]);
    for (const id of before) if (id !== undefined && a.h.log.added.some((s) => s.startsWith(`${id}@`))) expect(a.h.log.removed).toContain(id);
    a.h.tick(20);
    expect(a.ids[firstAfter]).toBe(`spawn-${firstAfter + 1}`);
  });
});

describe('spawn: a copy moves itself ("@self" in ownedTransforms)', () => {
  /** A bolt flies right 0.05 m per step by its own script; an authored bolt does too; a crate with a collider may not own itself. */
  const BOLT_PREFABS = [
    { prefabId: 'bolt', displayName: 'Bolt', createdRevision: 1, entityCount: 1, depth: 1, entities: [{ localId: 'box-0020', components: { transform: at(0, 0), box: { size: [0.2, 0.2, 0.2], material: { color: '#ff00ff' } }, behavior: { behaviorId: 'bolt', values: {} } } }] },
    { prefabId: 'bolt-crate', displayName: 'Bolt crate', createdRevision: 1, entityCount: 1, depth: 1, entities: [{ localId: 'box-0021', components: { transform: at(0, 0), box: { size: [1, 1, 1], material: { color: '#aa7733' } }, collider: { shape: { type: 'box', hx: 0.5, hy: 0.5 } }, behavior: { behaviorId: 'bolt', values: {} } } }] },
  ];
  const boltSpec = (poke?: { other: string | null }) => createBehaviorModuleSpec({
    declaration: DECL,
    artifact: artifact('bolt', (ctx) => {
      if (ctx.phase !== 'transform') return;
      const me = ctx.world.transform(ctx.entityId)!;
      ctx.emit({ kind: 'transform', entityId: ctx.entityId, position: { x: me.position[0]! + 0.05 } });
      if (poke?.other !== null && poke?.other !== undefined && ctx.entityId === 'spawn-2') ctx.emit({ kind: 'transform', entityId: poke.other, position: { y: 9 } });
    }, [], ['@self']),
  });

  it('each copy (and an authored carrier) moves its own entity; deterministically; a destroyed copy is released', () => {
    const run = () => {
      let shots = 0;
      let kill = false;
      const h = harness((ctx) => {
        if (ctx.stepIndex >= 20 && shots < 2 && ctx.stepIndex % 5 === 0) {
          ctx.spawn('bolt', { position: [0, 2 + shots] });
          shots += 1;
        }
        if (kill) {
          ctx.destroy('spawn-1');
          kill = false;
        }
      }, { specs: [boltSpec()], prefabs: BOLT_PREFABS, entities: [{ id: 'box-bolt', components: { transform: at(-10, 1), box: { size: [0.2, 0.2, 0.2], material: { color: '#ff00ff' } }, behavior: { behaviorId: 'bolt', values: {} } } }] });
      h.tick(40);
      const mid = h.transforms();
      kill = true;
      h.tick(10);
      return { h, mid, end: h.transforms() };
    };
    const a = run();
    const b = run();
    expect(a.h.diag().state).toBe('running');
    // The copies flew right from x 0 at 0.05 m per step (spawned 5 steps apart).
    const x1 = a.mid.get('spawn-1')![0]!;
    const x2 = a.mid.get('spawn-2')![0]!;
    expect(x1).toBeGreaterThan(0.5);
    expect(x1 - x2).toBeCloseTo(0.25, 9);
    expect(a.mid.get('spawn-2')![1]).toBe(3);
    expect(a.mid.get('box-bolt')![0]).toBeGreaterThan(-10 + 1);
    // Destroyed copy gone; the other keeps flying; same inputs, same result.
    expect(a.end.has('spawn-1')).toBe(false);
    expect(a.end.get('spawn-2')![0]).toBeCloseTo(x2 + 0.5, 9);
    expect([...a.end]).toEqual([...b.end]);
  });

  it('"@self" owns only the instance\'s own entity; a physics copy may not own itself', () => {
    const poke = { other: 'spawn-1' as string | null };
    let n = 0;
    const a = harness((ctx) => {
      if (ctx.stepIndex >= 20 && n < 2) {
        ctx.spawn('bolt', { position: [0, 2] });
        n += 1;
      }
    }, { specs: [boltSpec(poke)], prefabs: BOLT_PREFABS });
    expect(() => a.tick(30)).toThrow();
    expect(a.diag().errors.some((e) => e.reason === 'not_owner' || e.message.includes('ownedTransforms'))).toBe(true);
    let asked = false;
    const b = harness((ctx) => {
      if (ctx.stepIndex >= 20 && !asked) {
        asked = true;
        ctx.spawn('bolt-crate', { position: [0, 2] });
      }
    }, { specs: [boltSpec()], prefabs: BOLT_PREFABS });
    expect(() => b.tick(30)).toThrow();
    expect(b.diag().errors.some((e) => e.message.includes('physics'))).toBe(true);
  });
});
