/**
 * Phase 23.7 — scripting conveniences.
 *
 * - `ctx.random`: the pure streams (same seed and ids → the same numbers,
 *   another seed / script / object / stream → others; sub-streams are
 *   independent; bounds; bad calls; a new run starts over) and in the
 *   runtime (two runs and a replay draw the same numbers, `random_seed`
 *   changes them, bad calls fail-stop as script errors).
 * - `ctx.world.find / findAll / withComponent`: load order, spawned copies
 *   included, bad calls fail-stop.
 * - Rotation forms on `transform` / `pose` intents: a quaternion (normalized)
 *   or a facing (+Z forward, optional up) — exactly one form, validated; the
 *   old forms parse and apply exactly as before.
 *
 * Neutral fixtures; the physics port keeps the player at the origin.
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RANDOM_SEED,
  MAX_RANDOM_STREAMS,
  createBehaviorModuleSpec,
  createSimulationRegistry,
  facingQuaternion,
  instantiateRuntime,
  neutralFrame,
  normalizedQuaternion,
  randomSeedOf,
  registerSimulationModule,
  validateIntentShape,
  validateIntentValue,
  type BehaviorRandom,
  type BehaviorWorldView,
  type Runtime,
  type SimulationModuleSpec,
} from './index';
import { InstanceRandom, RandomCallError, hashSeed } from './random';

const HZ = 120;
const DT = 1 / HZ;
const T = { rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const at = (x: number, y: number, z = 0): { position: number[]; rotation: number[]; scale: number[] } => ({ position: [x, y, z], ...T });
const BOX = { size: [1, 1, 1], material: { color: '#ffffff' } };
const DECL = { properties: [] } as never;

const draw = (r: BehaviorRandom, n: number): number[] => Array.from({ length: n }, () => r.next());

describe('ctx.random: the seeded streams (pure)', () => {
  it('the same seed, script and object draw the same numbers; any other part draws others', () => {
    const a = draw(new InstanceRandom(0, 'mover', 'box-0001').api, 32);
    expect(draw(new InstanceRandom(0, 'mover', 'box-0001').api, 32)).toEqual(a);
    expect(draw(new InstanceRandom(1, 'mover', 'box-0001').api, 32)).not.toEqual(a);
    expect(draw(new InstanceRandom(0, 'other', 'box-0001').api, 32)).not.toEqual(a);
    expect(draw(new InstanceRandom(0, 'mover', 'box-0002').api, 32)).not.toEqual(a);
    for (const v of a) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      expect(Number.isInteger(v * 2 ** 32)).toBe(true);
    }
    expect(hashSeed('abc')).toEqual(hashSeed('abc'));
    expect(hashSeed('abc')).not.toEqual(hashSeed('abd'));
    expect(a.slice(0, 3).map((v) => v * 2 ** 32)).toEqual(PINNED_FIRST_THREE);
  });

  it('sub-streams are independent of the main stream and of each other; one name is one stream', () => {
    const plain = new InstanceRandom(7, 'b', 'e').api;
    const mixed = new InstanceRandom(7, 'b', 'e').api;
    const mainA = draw(plain, 10);
    const loot = mixed.stream('loot');
    const lootFirst = draw(loot as BehaviorRandom, 5);
    // Drawing from 'loot' did not move the main stream.
    expect(draw(mixed, 10)).toEqual(mainA);
    // The same name is the same stream (continues), another name is another.
    expect(mixed.stream('loot')).toBe(loot);
    const fresh = new InstanceRandom(7, 'b', 'e').api;
    expect(draw(fresh.stream('loot') as BehaviorRandom, 5)).toEqual(lootFirst);
    expect(draw(fresh.stream('moves') as BehaviorRandom, 5)).not.toEqual(lootFirst);
    expect(lootFirst).not.toEqual(mainA.slice(0, 5));
  });

  it('range, int, chance and pick keep their bounds; int covers both ends', () => {
    const r = new InstanceRandom(3, 'b', 'e').api;
    const ints = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const x = r.range(-2, 5);
      expect(x >= -2 && x < 5).toBe(true);
      const k = r.int(1, 6);
      expect(Number.isInteger(k) && k >= 1 && k <= 6).toBe(true);
      ints.add(k);
    }
    expect([...ints].sort()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(r.int(6, 1)).toBeGreaterThanOrEqual(1); // bounds in any order
    expect(r.int(2.2, 2.8)).toBe(3); // no whole number between: the rounded-up lower bound
    expect(r.int(4, 4)).toBe(4);
    expect(r.chance(0)).toBe(false);
    expect(r.chance(1)).toBe(true);
    const hits = Array.from({ length: 4000 }, () => r.chance(0.25)).filter(Boolean).length;
    expect(hits).toBeGreaterThan(800);
    expect(hits).toBeLessThan(1200);
    expect(r.pick([])).toBeUndefined();
    const seen = new Set(Array.from({ length: 200 }, () => r.pick(['a', 'b', 'c'])));
    expect([...seen].sort()).toEqual(['a', 'b', 'c']);
  });

  it('bad calls throw a script error; at most 64 named streams; reset starts every stream over', () => {
    const inst = new InstanceRandom(0, 'b', 'e');
    const r = inst.api;
    for (const bad of [() => r.range(0, Number.NaN), () => r.int(0, Infinity), () => r.chance('x' as never), () => r.pick('abc' as never), () => r.stream(''), () => r.stream('a b'), () => r.stream(3 as never)]) {
      expect(bad).toThrow(RandomCallError);
    }
    for (let i = 0; i < MAX_RANDOM_STREAMS; i++) r.stream(`s${i}`);
    expect(() => r.stream('one-more')).toThrow(/at most 64/);
    expect(() => r.stream('s3')).not.toThrow();
    const kept = r.stream('s1');
    const first = [r.next(), kept.next()];
    r.next();
    kept.next();
    inst.reset();
    expect([r.next(), kept.next()]).toEqual(first);
  });

  it('the run seed is the random_seed setting (a uint32), else the default', () => {
    expect(DEFAULT_RANDOM_SEED).toBe(0);
    expect(randomSeedOf({})).toBe(0);
    expect(randomSeedOf({ random_seed: 42 })).toBe(42);
    expect(randomSeedOf({ random_seed: 4294967295 })).toBe(4294967295);
    expect(randomSeedOf({ random_seed: -1 })).toBe(0);
    expect(randomSeedOf(undefined)).toBe(0);
  });
});

// The first three 32-bit outputs of seed 0, script "mover", object "box-0001": pinned
// once — the generator (cyrb128 seed, sfc32) must never change, or every recorded run would.
const PINNED_FIRST_THREE = [2567244580, 3460116579, 3170957246];

// ---- the runtime -----------------------------------------------------------------------

interface Ctx {
  stepIndex: number;
  phase: string;
  entityId: string;
  random: BehaviorRandom;
  world: BehaviorWorldView;
  spawn?: (prefabId: string, options: { position: number[] }) => string | null;
  emit(intent: unknown): void;
}

function artifact(behaviorId: string, step: (ctx: Ctx) => void, ownedTransforms: string[] = []): never {
  return {
    behaviorId,
    sourceDigest: 'a'.repeat(64),
    manifestDigest: 'b'.repeat(64),
    outputDigest: 'c'.repeat(64),
    ownedTransforms,
    requiredModules: [],
    enginePins: [],
    namespace: { default: { step: (_s: unknown, ctx: Ctx) => step(ctx) } },
  } as never;
}

const stubGameplay: SimulationModuleSpec = { id: 'thirdlight.teststub:gameplay', phases: ['gameplay'], create: () => ({ transformOwners: [], step() {} }) };
const stubCamera: SimulationModuleSpec = { id: 'thirdlight.teststub:camera', phases: ['camera'], create: () => ({ transformOwners: ['cam-main'], step() {} }) };

function port(): unknown {
  const zero = { x: 0, y: 0 };
  return {
    stageCharacterMove() {},
    step() {
      return { requested: { ...zero }, applied: { ...zero }, position: { x: 0, y: 0 }, grounded: true, supportNormal: { x: 0, y: 1 }, contacts: { ground: true, wall: false, head: false, steepSlope: false }, snapped: false };
    },
    reset() {},
    clearCharacterMotion() {},
    placeCharacter: () => ({ ok: true, supportNormal: { x: 0, y: 1 } }),
    characterClearance: () => ({ ok: true, supportNormal: { x: 0, y: 1 } }),
    addStaticColliders() {},
    removeStaticColliders() {},
    setKinematicPositions() {},
    diagnostics: () => ({}),
    dispose() {},
  };
}

const PREFABS = [
  { prefabId: 'marker', displayName: 'Marker', createdRevision: 1, entityCount: 1, depth: 1, entities: [{ localId: 'box-0001', name: 'Marker', components: { transform: at(0, 0), box: BOX } }] },
];

interface BehaviorDef {
  step: (ctx: Ctx) => void;
  owned?: string[];
}

function harness(behaviors: Record<string, BehaviorDef>, entities: unknown[], settings: Record<string, number> = {}) {
  const specs = [...Object.entries(behaviors).map(([id, b]) => createBehaviorModuleSpec({ declaration: DECL, artifact: artifact(id, b.step, b.owned) })), stubGameplay, stubCamera];
  const registry = createSimulationRegistry();
  for (const s of specs) registerSimulationModule(registry, s.id, s);
  const now = { t: 0 };
  const res = instantiateRuntime({
    snapshot: {
      snapshotId: 'conveniences@r1',
      projectId: 'conveniences',
      revision: 1,
      scene: {
        schemaVersion: 4,
        sceneId: 'scene-main',
        revision: 1,
        entities: [
          { id: 'cam-main', components: { transform: at(0, 4, 12), camera: { type: 'perspective', fovY: 45, near: 0.1, far: 100 }, cameraFollow: { deadZone: { x: 0.5, y: 0.5 }, smoothing: 0.2 } } },
          { id: 'player-0001', components: { transform: at(0, 0) } },
          { id: 'spawn-0001', components: { transform: at(0, 0), playerSpawn: {} } },
          ...entities,
        ],
      },
      game: { configVersion: 2, title: 'Conveniences', objective: 'o', instructions: 'i', playerId: 'player-0001', cameraId: 'cam-main', spawnId: 'spawn-0001', cues: { start: null, jump: null, checkpoint: null, death: null, goal: null } },
      prefabs: PREFABS,
    },
    registry,
    modules: specs.map((s) => s.id),
    actions: { sample: (i: number) => neutralFrame(i) },
    physics: port() as never,
    settings,
    fixedStepHz: HZ,
    clock: () => now.t,
    driver: { kind: 'manual' },
  } as never);
  if (!res.ok) throw new Error(`instantiate failed: ${JSON.stringify(res.error)}`);
  const rt: Runtime = res.runtime;
  expect(rt.start().ok).toBe(true);
  expect(rt.tick(now.t).ok).toBe(true);
  // (A script that fails in the settle pre-roll already stopped the run: the bad-call cases read the diagnostics.)
  rt.gameCommand('start');
  const tick = (n = 1): void => {
    for (let i = 0; i < n; i += 1) {
      now.t += DT;
      const r = rt.tick(now.t);
      if (!r.ok && r.error.code === 'runtime_failed') return; // a script failed: the diagnostics say why
      if (!r.ok) throw new Error(`tick failed: ${JSON.stringify(r.error)}`);
    }
  };
  const diag = () => (rt.getDiagnostics() as { diagnostics: { state: string; errors: { code: string; reason?: string; detail?: string; message: string }[] } }).diagnostics;
  const rotationOf = (id: string): number[] => {
    const s = rt.getInterpolatedState();
    if (!s.ok) throw new Error('no state');
    return [...s.state.transforms.find((t) => t.id === id)!.rotation];
  };
  return { rt, tick, diag, rotationOf };
}

const carrier = (id: string, behaviorId: string, name?: string): unknown => ({ id, ...(name !== undefined ? { name } : {}), components: { transform: at(5, -5), box: BOX, behavior: { behaviorId, values: {} } } });

describe('ctx.random in the runtime', () => {
  const roller = (log: string[]): BehaviorDef => ({
    step: (ctx) => {
      if (ctx.phase !== 'intent' || ctx.stepIndex % 10 !== 0) return;
      log.push(`${ctx.entityId}:${ctx.random.int(1, 1000)}:${ctx.random.stream('loot').next().toFixed(6)}`);
    },
  });

  it('two runs draw the same numbers; each object its own; a replay starts over; random_seed changes them', () => {
    const run = (settings: Record<string, number> = {}) => {
      const log: string[] = [];
      const h = harness({ roller: roller(log) }, [carrier('box-0001', 'roller'), carrier('box-0002', 'roller')], settings);
      log.length = 0; // the settle pre-roll's draws (the start of the run starts every stream over)
      h.tick(100);
      return { h, log };
    };
    const a = run();
    const b = run();
    expect(a.log.length).toBeGreaterThan(10);
    expect(b.log).toEqual(a.log);
    const one = a.log.filter((l) => l.startsWith('box-0001')).map((l) => l.slice(9));
    const two = a.log.filter((l) => l.startsWith('box-0002')).map((l) => l.slice(9));
    expect(one).not.toEqual(two);
    // Replay: the same sequence again from its start.
    const first = [...a.log];
    a.log.length = 0;
    expect(a.h.rt.gameCommand('replay').ok).toBe(true);
    a.h.tick(100);
    expect(a.log).toEqual(first);
    expect(a.h.diag().state).toBe('running');
    // Another project seed: other numbers; the default seed equals an explicit 0.
    expect(run({ random_seed: 99 }).log).not.toEqual(first);
    expect(run({ random_seed: 0 }).log).toEqual(first);
  });

  it('a bad ctx.random call is a script error (fail-stop with its reason)', () => {
    const h = harness({ bad: { step: (ctx) => void (ctx.stepIndex === 5 && ctx.random.stream('no spaces')) } }, [carrier('box-0001', 'bad')]);
    h.tick(10);
    const d = h.diag();
    expect(d.state).toBe('failed');
    expect(d.errors[0]?.reason).toBe('behavior_random_invalid');
  });
});

describe('ctx.world queries by name and component', () => {
  it('find, findAll and withComponent answer in load order, spawned copies included', () => {
    const seen: Record<string, unknown> = {};
    const h = harness(
      {
        finder: {
          step: (ctx) => {
            if (ctx.phase !== 'intent') return;
            if (ctx.stepIndex === 3) {
              seen['find'] = ctx.world.find('Marker');
              seen['all'] = ctx.world.findAll('Marker');
              seen['none'] = ctx.world.find('marker'); // case-sensitive
              seen['lights'] = ctx.world.withComponent('light');
              seen['behaviors'] = ctx.world.withComponent('behavior');
              seen['spawnPoints'] = ctx.world.withComponent('playerSpawn');
              seen['spawned'] = ctx.spawn?.('marker', { position: [2, 2] });
            }
            if (ctx.stepIndex === 6) {
              seen['allAfter'] = ctx.world.findAll('Marker');
              seen['boxesAfter'] = ctx.world.withComponent('box').length;
            }
          },
        },
      },
      [
        { id: 'box-0010', name: 'Marker', components: { transform: at(1, 1), box: BOX } },
        carrier('box-0011', 'finder', 'Finder'),
        { id: 'light-0001', components: { transform: at(0, 5), light: { type: 'point', color: '#ffffff', intensity: 1, range: 10 } } },
        { id: 'box-0012', name: 'Marker', components: { transform: at(3, 1), box: BOX } },
      ],
    );
    h.tick(8);
    expect(h.diag().state).toBe('running');
    expect(seen['find']).toBe('box-0010');
    expect(seen['all']).toEqual(['box-0010', 'box-0012']);
    expect(seen['none']).toBeUndefined();
    expect(seen['lights']).toEqual(['light-0001']);
    expect(seen['behaviors']).toEqual(['box-0011']);
    expect(seen['spawnPoints']).toEqual(['spawn-0001']);
    expect(typeof seen['spawned']).toBe('string');
    expect(seen['allAfter']).toEqual(['box-0010', 'box-0012', seen['spawned']]);
    expect(seen['boxesAfter']).toBe(4);
  });

  it('a query with a non-text argument is a script error', () => {
    const h = harness({ bad: { step: (ctx) => void (ctx.stepIndex === 5 && ctx.world.findAll(3 as never)) } }, [carrier('box-0001', 'bad')]);
    h.tick(10);
    expect(h.diag().state).toBe('failed');
    expect(h.diag().errors[0]?.reason).toBe('behavior_query_invalid');
  });
});

describe('rotation forms on transform and pose intents', () => {
  const close = (a: number[], b: number[]): void => {
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) expect(a[i]!).toBeCloseTo(b[i]!, 12);
  };
  const posed = (intent: (ctx: Ctx) => unknown) => {
    const h = harness({ turner: { step: (ctx) => void (ctx.phase === 'transform' && ctx.emit(intent(ctx))), owned: ['@self'] } }, [carrier('box-0001', 'turner')]);
    h.tick(3);
    return h;
  };

  it('facingQuaternion: +Z with the default up is exactly the identity; the result turns +Z onto the facing', () => {
    expect(facingQuaternion([0, 0, 1])).toEqual([0, 0, 0, 1]);
    expect(facingQuaternion([0, 0, 5])).toEqual([0, 0, 0, 1]);
    const rotate = (q: number[], v: number[]): number[] => {
      const [x, y, z, w] = q as [number, number, number, number];
      const [vx, vy, vz] = v as [number, number, number];
      const tx = 2 * (y * vz - z * vy);
      const ty = 2 * (z * vx - x * vz);
      const tz = 2 * (x * vy - y * vx);
      return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
    };
    for (const [f, up] of [[[1, 0, 0]], [[-1, 0, 0]], [[0, 0, -1]], [[1, 2, 3]], [[0, 1, 0]], [[0, -1, 0]], [[1, 0, 0], [0, 0, 1]], [[0, 0, -1], [1, 0, 0]]] as [number[], number[]?][]) {
      const q = facingQuaternion(f, up)!;
      const len = Math.hypot(...f);
      close(rotate(q, [0, 0, 1]), f.map((v) => v / len));
      expect(Math.hypot(...q)).toBeCloseTo(1, 12);
      // The top leans towards up (positive dot with it).
      const top = rotate(q, [0, 1, 0]);
      const u = up ?? (Math.abs(f[1]!) === len ? [0, 0, f[1]! > 0 ? -1 : 1] : [0, 1, 0]);
      expect(top[0]! * u[0]! + top[1]! * u[1]! + top[2]! * u[2]!).toBeGreaterThan(0);
    }
    expect(facingQuaternion([0, 1, 0], [0, 2, 0])).toBeNull();
    close(normalizedQuaternion([0, 2, 0, 2]), [0, Math.SQRT1_2, 0, Math.SQRT1_2]);
  });

  it('a pose facing +X equals a yaw of 90°; a quaternion is normalized; a transform may face as it moves', () => {
    const yaw = posed((ctx) => ({ kind: 'pose', entityId: ctx.entityId, rotation: { yaw: 90 } }));
    const face = posed((ctx) => ({ kind: 'pose', entityId: ctx.entityId, facing: [1, 0, 0] }));
    close(face.rotationOf('box-0001'), yaw.rotationOf('box-0001'));
    const quat = posed((ctx) => ({ kind: 'pose', entityId: ctx.entityId, quaternion: [0, 3, 0, 3], scale: 2 }));
    close(quat.rotationOf('box-0001'), [0, Math.SQRT1_2, 0, Math.SQRT1_2]);
    const moved = posed((ctx) => ({ kind: 'transform', entityId: ctx.entityId, position: { x: 1 }, facing: [0, 0, -1], up: [0, 1, 0] }));
    close(moved.rotationOf('box-0001'), [0, 1, 0, 0]); // half a turn about +Y
    const s = moved.rt.getInterpolatedState();
    expect(s.ok && s.state.transforms.find((t) => t.id === 'box-0001')!.position[0]).toBe(1);
    for (const h of [yaw, face, quat, moved]) expect(h.diag().state).toBe('running');
  });

  it('refuses two rotation forms, up without facing, zero or parallel vectors, and a second rotation write', () => {
    const cases: [unknown, string, string][] = [
      [{ kind: 'pose', entityId: 'box-0001', rotation: { yaw: 1 }, quaternion: [0, 0, 0, 1] }, 'behavior_intent_invalid', 'shape'],
      [{ kind: 'pose', entityId: 'box-0001', quaternion: [0, 0, 0, 1], facing: [1, 0, 0] }, 'behavior_intent_invalid', 'shape'],
      [{ kind: 'pose', entityId: 'box-0001', up: [0, 1, 0] }, 'behavior_intent_invalid', 'shape'],
      [{ kind: 'pose', entityId: 'box-0001', quaternion: [0, 0, 1] }, 'behavior_intent_invalid', 'shape'],
      [{ kind: 'pose', entityId: 'box-0001', scale: 1, facing: [1, 0, 0] }, 'behavior_intent_invalid', 'shape'], // order
      [{ kind: 'pose', entityId: 'box-0001', quaternion: [0, 0, 0, 0] }, 'behavior_intent_invalid', 'value'],
      [{ kind: 'pose', entityId: 'box-0001', facing: [0, Number.NaN, 1] }, 'behavior_intent_invalid', 'value'],
      [{ kind: 'pose', entityId: 'box-0001', facing: [0, 1, 0], up: [0, -3, 0] }, 'behavior_intent_invalid', 'value'],
      [{ kind: 'transform', entityId: 'box-0001', position: { x: 1 }, quaternion: [0, 0, 0, 1], facing: [1, 0, 0] }, 'behavior_intent_invalid', 'shape'],
      [{ kind: 'transform', entityId: 'box-0001', position: { x: 1 }, up: [0, 1, 0] }, 'behavior_intent_invalid', 'shape'],
      [{ kind: 'transform', entityId: 'box-0001', quaternion: [0, 0, 0, 1], position: { x: 1 } }, 'behavior_intent_invalid', 'shape'],
      [{ kind: 'transform', entityId: 'box-0001', position: { x: 1 }, spin: 1 }, 'behavior_intent_invalid', 'shape'],
      [{ kind: 'transform', entityId: 'box-0001', position: { x: 1 }, facing: [0, 0, 0] }, 'behavior_intent_invalid', 'value'],
    ];
    for (const [bad, reason, detail] of cases) {
      const h = posed(() => bad);
      expect(h.diag().state, JSON.stringify(bad)).toBe('failed');
      expect(h.diag().errors[0]?.reason, JSON.stringify(bad)).toBe(reason);
      expect(h.diag().errors[0]?.detail, JSON.stringify(bad)).toBe(detail);
    }
    // A pose rotation and a transform facing in one step write the rotation twice.
    const twice = harness(
      {
        turner: {
          step: (ctx) => {
            if (ctx.phase !== 'transform') return;
            ctx.emit({ kind: 'pose', entityId: ctx.entityId, rotation: { yaw: 10 } });
            ctx.emit({ kind: 'transform', entityId: ctx.entityId, position: { y: 1 }, facing: [1, 0, 0] });
          },
          owned: ['@self'],
        },
      },
      [carrier('box-0001', 'turner')],
    );
    twice.tick(3);
    expect(twice.diag().state).toBe('failed');
    expect(twice.diag().errors[0]?.reason).toBe('behavior_intent_conflict');
  });

  it('the old forms parse exactly as before (no new keys) and a legacy pose applies the same rotation', () => {
    const t = validateIntentShape({ kind: 'transform', entityId: 'e', position: { x: 1, z: 2 } });
    expect(t.ok && t.intent).toEqual({ kind: 'transform', entityId: 'e', position: { x: 1, z: 2 } });
    expect(t.ok && Object.keys(t.intent)).toEqual(['kind', 'entityId', 'position']);
    const p = validateIntentShape({ kind: 'pose', entityId: 'e', rotation: { yaw: 30, roll: 5 }, scale: [1, 2, 3] });
    expect(p.ok && Object.keys(p.intent)).toEqual(['kind', 'entityId', 'rotation', 'scale']);
    expect(p.ok && validateIntentValue(p.intent)).toBeNull();
    // The Euler path is untouched: yaw 90 + roll 90 is still (0.5, 0.5, 0.5, 0.5) exactly as before.
    const h = posed((ctx) => ({ kind: 'pose', entityId: ctx.entityId, rotation: { yaw: 90, roll: 90 } }));
    for (const v of h.rotationOf('box-0001')) expect(v).toBeCloseTo(0.5, 12);
    const q = validateIntentShape({ kind: 'transform', entityId: 'e', position: { x: 1 }, quaternion: [0, 0, 0, 2] });
    expect(q.ok && q.intent).toEqual({ kind: 'transform', entityId: 'e', position: { x: 1 }, quaternion: [0, 0, 0, 2] });
  });
});
