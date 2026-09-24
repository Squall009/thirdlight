/**
 * Phase 14.2 — scripts: timers and sensors.
 *
 * - `ctx.timers` (pure `InstanceTimers` and in the runtime): step-counted
 *   after/every/fired/cancel, idempotent restarts, the 64-per-instance limit,
 *   bad calls fail-stop as script errors, a new run clears them, the same
 *   inputs fire in the same steps.
 * - Triggers: circle shape (tested against the capsule itself), `mode:
 *   "stay"` (the signal every step inside), and the `enter`/`exit` events a
 *   script owns in `ctx.events` (its own entity, descendants, entityRef
 *   properties; not other triggers).
 *
 * The gameplay/camera modules are test stubs; the physics port keeps the
 * player at the origin, so the triggers move (movers) through it.
 */
import { describe, expect, it } from 'vitest';

import {
  MAX_TIMERS_PER_INSTANCE,
  createBehaviorModuleSpec,
  createSimulationRegistry,
  instantiateRuntime,
  neutralFrame,
  registerSimulationModule,
  type BehaviorTimers,
  type Runtime,
  type SimulationModuleSpec,
} from './index';
import { InstanceTimers } from './timers';

const HZ = 120;
const DT = 1 / HZ;
const T = { rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const at = (x: number, y: number, z = 0): { position: number[]; rotation: number[]; scale: number[] } => ({ position: [x, y, z], ...T });
const DECL = { properties: [{ key: 'sensor', label: 'Sensor', type: 'entityRef', default: null }] } as never;

describe('timers: InstanceTimers (pure)', () => {
  const run = (t: InstanceTimers, from: number, to: number, script: (api: BehaviorTimers, step: number) => void): number[] => {
    const fired: number[] = [];
    for (let s = from; s <= to; s++) {
      t.begin(s);
      script(t.api, s);
    }
    return fired;
  };

  it('after fires once, seconds (in steps) later, and is true only in that step', () => {
    const t = new InstanceTimers(HZ);
    const seen: number[] = [];
    run(t, 0, 400, (api, s) => {
      if (s === 10) expect(api.after('door', 1)).toBe(true);
      if (api.fired('door')) seen.push(s);
    });
    expect(seen).toEqual([130]);
    expect(t.size).toBe(0);
  });

  it('every repeats at its period; calling it again with the same period changes nothing', () => {
    const t = new InstanceTimers(HZ);
    const seen: number[] = [];
    const again: boolean[] = [];
    run(t, 0, 200, (api, s) => {
      again.push(api.every('blink', 0.5)); // every step: only the first call starts it
      if (api.fired('blink')) seen.push(s);
    });
    expect(seen).toEqual([60, 120, 180]);
    expect(again.filter((a) => a)).toHaveLength(1);
  });

  it('a different length (or kind) restarts; cancel stops; after re-arms after it fired', () => {
    const t = new InstanceTimers(HZ);
    const seen: string[] = [];
    run(t, 0, 300, (api, s) => {
      if (s === 0) api.after('a', 1);
      if (s === 60) expect(api.after('a', 0.25)).toBe(true); // restarted: 60 + 30
      if (s === 0) api.every('b', 0.1);
      if (s === 50) expect(api.cancel('b')).toBe(true);
      if (s === 51) expect(api.cancel('b')).toBe(false);
      if (api.fired('a')) {
        seen.push(`a${s}`);
        if (s === 90) api.after('a', 1); // re-armed in the step it fired
      }
      if (api.fired('b')) seen.push(`b${s}`);
    });
    expect(seen).toEqual(['b12', 'b24', 'b36', 'b48', 'a90', 'a210']);
  });

  it('zero seconds fires in the next step; a skipped stretch fires a repeating timer once', () => {
    const t = new InstanceTimers(HZ);
    t.begin(5);
    t.api.after('now', 0);
    t.api.every('tick', 0.05); // 6 steps
    t.begin(6);
    expect(t.api.fired('now')).toBe(true);
    t.begin(40); // steps 7..39 not stepped
    expect(t.api.fired('tick')).toBe(true);
    // It keeps its phase (11, 17, … 41, 47): next at 41, not 40 + 6.
    t.begin(41);
    expect(t.api.fired('tick')).toBe(true);
    t.begin(42);
    expect(t.api.fired('tick')).toBe(false);
    t.begin(47);
    expect(t.api.fired('tick')).toBe(true);
  });

  it(`at most ${MAX_TIMERS_PER_INSTANCE} per instance; bad names and seconds throw; clear empties`, () => {
    const t = new InstanceTimers(HZ);
    t.begin(0);
    for (let i = 0; i < MAX_TIMERS_PER_INSTANCE; i++) t.api.after(`t${i}`, 1);
    expect(() => t.api.after('one-more', 1)).toThrow(/at most 64/);
    expect(t.api.after('t3', 2)).toBe(true); // restarting a running one is fine
    for (const [n, s] of [['', 1], ['a b', 1], [42, 1], ['ok', -1], ['ok', Number.NaN], ['ok', 3601], ['ok', '1']] as const) {
      expect(() => t.api.every(n as string, s as number)).toThrow(/ctx\.timers\.every/);
    }
    t.clear();
    expect(t.size).toBe(0);
    t.api.after('fresh', 1);
    expect(t.size).toBe(1);
  });
});

interface Ctx {
  stepIndex: number;
  phase: string;
  entityId: string;
  timers: BehaviorTimers;
  events: readonly Record<string, unknown>[];
  signals: { on(name: string): boolean };
}

function artifact(behaviorId: string, step: (ctx: Ctx) => void): never {
  return {
    behaviorId,
    sourceDigest: 'a'.repeat(64),
    manifestDigest: 'b'.repeat(64),
    outputDigest: 'c'.repeat(64),
    ownedTransforms: [],
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

/** A runtime with scripts (`behaviors`: id → step) on `entities`; the player stands at the origin. */
function harness(behaviors: Record<string, (ctx: Ctx) => void>, entities: unknown[]) {
  const specs = [...Object.entries(behaviors).map(([id, step]) => createBehaviorModuleSpec({ declaration: DECL, artifact: artifact(id, step) })), stubGameplay, stubCamera];
  const registry = createSimulationRegistry();
  for (const s of specs) registerSimulationModule(registry, s.id, s);
  const now = { t: 0 };
  const res = instantiateRuntime({
    snapshot: {
      snapshotId: 'sensors@r1',
      projectId: 'sensors',
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
      game: { configVersion: 2, title: 'Sensors', objective: 'o', instructions: 'i', playerId: 'player-0001', cameraId: 'cam-main', spawnId: 'spawn-0001', cues: { start: null, jump: null, checkpoint: null, death: null, goal: null } },
    },
    registry,
    modules: specs.map((s) => s.id),
    actions: { sample: (i: number) => neutralFrame(i) },
    physics: port() as never,
    settings: {},
    fixedStepHz: HZ,
    clock: () => now.t,
    driver: { kind: 'manual' },
  } as never);
  if (!res.ok) throw new Error(`instantiate failed: ${JSON.stringify(res.error)}`);
  const rt: Runtime = res.runtime;
  expect(rt.start().ok).toBe(true);
  expect(rt.tick(now.t).ok).toBe(true);
  expect(rt.gameCommand('start').ok).toBe(true);
  const tick = (n = 1): void => {
    for (let i = 0; i < n; i += 1) {
      now.t += DT;
      const r = rt.tick(now.t);
      if (!r.ok) throw new Error(`tick failed: ${JSON.stringify(r.error)}`);
    }
  };
  const diag = () => (rt.getDiagnostics() as { diagnostics: { state: string; errors: { code: string; reason?: string; message: string }[] } }).diagnostics;
  return { rt, tick, diag };
}

const BOX = { size: [1, 1, 1], material: { color: '#ffffff' } };
/** A trigger that slides right through the player (at the origin) at 6 m/s. */
const sweeping = (id: string, y: number, trigger: Record<string, unknown>, extra: Record<string, unknown> = {}): unknown => ({
  id,
  components: { transform: at(-3, y), box: BOX, trigger, mover: { waypoints: [[6, 0, 0]], speed: 6, mode: 'once' }, ...extra },
});

describe('timers: ctx.timers in the runtime', () => {
  it('fires in step-counted order, the same in two runs of the same inputs; a new run clears them', () => {
    const record = () => {
      const log: string[] = [];
      const h = harness(
        {
          timed: (ctx) => {
            if (ctx.phase !== 'intent') return;
            ctx.timers.every('blink', 0.25); // every step: it keeps its phase
            if (ctx.stepIndex === 20) ctx.timers.after('door', 0.5);
            if (ctx.timers.fired('blink')) log.push(`blink@${ctx.stepIndex}`);
            if (ctx.timers.fired('door')) log.push(`door@${ctx.stepIndex}`);
          },
        },
        [{ id: 'box-timed', components: { transform: at(5, -5), box: BOX, behavior: { behaviorId: 'timed', values: {} } } }],
      );
      return { h, log };
    };
    const a = record();
    const b = record();
    a.h.tick(100);
    b.h.tick(100);
    expect(a.log).toEqual(b.log);
    const door = a.log.find((l) => l.startsWith('door@'));
    expect(door).toBeDefined();
    const blinks = a.log.filter((l) => l.startsWith('blink@')).map((l) => Number(l.slice(6)));
    expect(blinks.length).toBeGreaterThanOrEqual(2);
    expect(blinks[1]! - blinks[0]!).toBe(30);
    expect(Number(door!.slice(5))).toBe(20 + 60);
    // A replay: the door timer (armed once, at step 20 of the old run) is gone.
    a.log.length = 0;
    expect(a.h.rt.gameCommand('replay').ok).toBe(true);
    a.h.tick(200);
    expect(a.log.some((l) => l.startsWith('door@'))).toBe(false);
    expect(a.log.some((l) => l.startsWith('blink@'))).toBe(true); // re-armed by the every-step call
    expect(a.h.diag().state).toBe('running');
  });

  it('a bad timer call is a script error (fail-stop with its reason)', () => {
    const h = harness({ bad: (ctx) => void (ctx.stepIndex === 20 && ctx.timers.after('x', -1)) }, [{ id: 'box-bad', components: { transform: at(5, -5), box: BOX, behavior: { behaviorId: 'bad', values: {} } } }]);
    expect(() => h.tick(25)).toThrow();
    expect(h.diag().state).toBe('failed');
    expect(h.diag().errors.some((e) => e.reason === 'behavior_timer_invalid')).toBe(true);
  });
});

describe('sensors: trigger shapes, stay mode and ctx.events', () => {
  it('events reach the owning scripts only: own entity, descendants, entityRef properties', () => {
    const seen: Record<string, string[]> = { self: [], parent: [], ref: [], none: [] };
    const watcher = (key: string) => (ctx: Ctx): void => {
      if (ctx.phase !== 'intent') return;
      for (const e of ctx.events) if (e['type'] === 'enter' || e['type'] === 'exit') seen[key]!.push(`${String(e['type'])}:${String(e['trigger'])}@${ctx.stepIndex}/${String(e['stepIndex'])}`);
    };
    const h = harness(
      { self: watcher('self'), parent: watcher('parent'), ref: watcher('ref'), none: watcher('none') },
      [
        // "self": the trigger is on the script's own entity.
        sweeping('box-self', 0, { size: [1, 1], signal: 'a' }, { behavior: { behaviorId: 'self', values: {} } }),
        // "parent": the trigger is a child of the script's entity.
        { id: 'group-parent', components: { transform: at(0, 0), behavior: { behaviorId: 'parent', values: {} } } },
        { ...(sweeping('box-child', 0, { shape: 'circle', radius: 0.5, signal: 'b' }) as object), parentId: 'group-parent' },
        // "ref": an entityRef property names the trigger.
        { id: 'group-ref', components: { transform: at(0, -20), behavior: { behaviorId: 'ref', values: { sensor: 'box-far' } } } },
        sweeping('box-far', 0, { size: [1, 1], signal: 'c' }),
        // "none": owns nothing.
        { id: 'group-none', components: { transform: at(0, -20), behavior: { behaviorId: 'none', values: {} } } },
      ],
    );
    h.tick(120);
    expect(seen['none']).toEqual([]);
    for (const [key, trig] of [['self', 'box-self'], ['parent', 'box-child'], ['ref', 'box-far']] as const) {
      const list = seen[key]!;
      expect(list.map((l) => l.split('@')[0])).toEqual([`enter:${trig}`, `exit:${trig}`]);
      // Seen in the step after it happened.
      for (const l of list) {
        const [seenAt, happened] = l.split('@')[1]!.split('/').map(Number);
        expect(seenAt).toBe(happened! + 1);
      }
    }
    // Box 1 m wide: inside while |x| < 0.8 (1.6 m at 6 m/s = 32 steps); the circle 0.5: the same across the capsule's middle.
    const span = (key: string): number => {
      const [a, b] = seen[key]!.map((l) => Number(l.split('@')[1]!.split('/')[1]));
      return b! - a!;
    };
    expect(span('self')).toBeGreaterThanOrEqual(31);
    expect(span('self')).toBeLessThanOrEqual(33);
    expect(span('parent')).toBeGreaterThanOrEqual(31);
    expect(span('parent')).toBeLessThanOrEqual(33);
  });

  it('circle vs box above the capsule, and stay mode emits every step inside', () => {
    const counts = { circle: 0, square: 0, stay: 0, enterOnly: 0 };
    const spans: Record<string, number[]> = { circle: [], square: [] };
    const h = harness(
      {
        watch: (ctx) => {
          if (ctx.phase !== 'intent') return;
          if (ctx.signals.on('c')) counts.circle++;
          if (ctx.signals.on('s')) counts.square++;
          if (ctx.signals.on('stay')) counts.stay++;
          if (ctx.signals.on('once-in')) counts.enterOnly++;
          for (const e of ctx.events) {
            const k = e['trigger'] === 'box-circle' ? 'circle' : e['trigger'] === 'box-square' ? 'square' : null;
            if (k !== null) spans[k]!.push(Number(e['stepIndex']));
          }
        },
      },
      [
        // Both 1.3 m up (the capsule's top half-circle centre is at 0.6 m): the
        // box meets the capsule's box while |x| < 0.8 m, the circle meets the
        // capsule itself only while |x| < ~0.39 m.
        { id: 'group-watch', components: { transform: at(0, 0), behavior: { behaviorId: 'watch', values: {} } } },
        { ...(sweeping('box-circle', 1.3, { shape: 'circle', radius: 0.5, signal: 'c' }) as object), parentId: 'group-watch' },
        { ...(sweeping('box-square', 1.3, { size: [1, 1], signal: 's' }) as object), parentId: 'group-watch' },
        sweeping('box-stay', 0, { size: [1, 1], signal: 'stay', mode: 'stay' }),
        sweeping('box-enter', 0, { size: [1, 1], signal: 'once-in', mode: 'enter' }),
      ],
    );
    h.tick(120);
    expect(counts.square).toBe(1);
    expect(counts.circle).toBe(1);
    const inside = (k: string): number => spans[k]![1]! - spans[k]![0]!;
    expect(spans['square']).toHaveLength(2);
    expect(spans['circle']).toHaveLength(2);
    expect(inside('square')).toBeGreaterThanOrEqual(31); // 1.6 m at 6 m/s
    expect(inside('circle')).toBeGreaterThanOrEqual(14); // ~0.78 m
    expect(inside('circle')).toBeLessThanOrEqual(17);
    expect(counts.enterOnly).toBe(1);
    // Inside for ~32 steps: the stay trigger's signal is seen every one of them.
    expect(counts.stay).toBeGreaterThanOrEqual(31);
    expect(counts.stay).toBeLessThanOrEqual(33);
    expect(h.diag().state).toBe('running');
  });

  it('once limits the signal, not the events', () => {
    const got = { signals: 0, enters: 0 };
    const h = harness(
      {
        door: (ctx) => {
          if (ctx.phase !== 'intent') return;
          if (ctx.signals.on('ping')) got.signals++;
          got.enters += ctx.events.filter((e) => e['type'] === 'enter').length;
        },
      },
      [
        {
          id: 'box-ping',
          components: { transform: at(-3, 0), box: BOX, trigger: { size: [1, 1], signal: 'ping', once: true }, mover: { waypoints: [[6, 0, 0]], speed: 6, mode: 'pingpong' }, behavior: { behaviorId: 'door', values: {} } },
        },
      ],
    );
    h.tick(250); // across and back (at ~60 and ~180 steps): two entries
    expect(got.signals).toBe(1);
    expect(got.enters).toBe(2);
  });
});
