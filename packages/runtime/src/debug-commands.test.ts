/**
 * Phase 23.8 — test and debug entry points in the runtime.
 *
 * - Injected variables (`InstantiateConfig.variables`) are the scripts'
 *   `ctx.save` values from step 0, under ctx.save's own rules.
 * - Debug commands: a script declares one with `ctx.debug.command(name,
 *   { args })`; a queued call rides on the next sampled step's input frame
 *   (`ActionFrame.commands`) and reaches every declaring instance in the
 *   intent phase (the handler runs once per call); bad calls are refused or
 *   dropped with a diagnostic; the applied log carries the step of each call.
 * - Replays: a recording whose frames carry the calls at the logged steps
 *   reproduces the run exactly (the same script observations, step by step).
 *
 * Neutral fixtures; the physics port keeps the player at the origin.
 */
import { describe, expect, it } from 'vitest';

import {
  createBehaviorModuleSpec,
  createRecordedActionSource,
  createSimulationRegistry,
  instantiateRuntime,
  neutralFrame,
  registerSimulationModule,
  validateActionFrame,
  type ActionFrame,
  type ActionSource,
  type DebugCommandArgs,
  type DebugCommandOptions,
  type Runtime,
  type SimulationModuleSpec,
} from './index';

const HZ = 120;
const DT = 1 / HZ;
const T = { rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const at = (x: number, y: number, z = 0): { position: number[]; rotation: number[]; scale: number[] } => ({ position: [x, y, z], ...T });
const BOX = { size: [1, 1, 1], material: { color: '#ffffff' } };
const DECL = { properties: [] } as never;

interface Ctx {
  stepIndex: number;
  phase: string;
  entityId: string;
  save?: { get(k: string): unknown; set(k: string, v: unknown): boolean; keys(): string[] };
  debug?: { command(name: string, options?: DebugCommandOptions, handler?: (args: DebugCommandArgs) => void): readonly DebugCommandArgs[] };
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

const carrier = (id: string, behaviorId: string): unknown => ({ id, components: { transform: at(5, -5), box: BOX, behavior: { behaviorId, values: {} } } });

function instantiate(behaviors: Record<string, (ctx: Ctx) => void>, entities: unknown[], extra: { variables?: unknown; actions?: ActionSource } = {}) {
  const specs = [...Object.entries(behaviors).map(([id, step]) => createBehaviorModuleSpec({ declaration: DECL, artifact: artifact(id, step) })), stubGameplay, stubCamera];
  const registry = createSimulationRegistry();
  for (const s of specs) registerSimulationModule(registry, s.id, s);
  const now = { t: 0 };
  const res = instantiateRuntime({
    snapshot: {
      snapshotId: 'debugcmd@r1',
      projectId: 'debugcmd',
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
      game: { configVersion: 2, title: 'Debug commands', objective: 'o', instructions: 'i', playerId: 'player-0001', cameraId: 'cam-main', spawnId: 'spawn-0001', cues: { start: null, jump: null, checkpoint: null, death: null, goal: null } },
    },
    registry,
    modules: specs.map((s) => s.id),
    actions: extra.actions ?? { sample: (i: number) => neutralFrame(i) },
    physics: port() as never,
    fixedStepHz: HZ,
    clock: () => now.t,
    driver: { kind: 'manual' },
    ...(extra.variables !== undefined ? { variables: extra.variables } : {}),
  } as never);
  return { res, now };
}

function harness(behaviors: Record<string, (ctx: Ctx) => void>, entities: unknown[], extra: { variables?: unknown; actions?: ActionSource } = {}) {
  const { res, now } = instantiate(behaviors, entities, extra);
  if (!res.ok) throw new Error(`instantiate failed: ${JSON.stringify(res.error)}`);
  const rt: Runtime = res.runtime;
  expect(rt.start().ok).toBe(true);
  expect(rt.tick(now.t).ok).toBe(true);
  rt.gameCommand('start');
  const tick = (n = 1): void => {
    for (let i = 0; i < n; i += 1) {
      now.t += DT;
      const r = rt.tick(now.t);
      if (!r.ok && r.error.code === 'runtime_failed') return;
      if (!r.ok) throw new Error(`tick failed: ${JSON.stringify(r.error)}`);
    }
  };
  const diag = () => (rt.getDiagnostics() as { diagnostics: { state: string; stepIndex: number; errors: { code: string; reason?: string; message: string }[] } }).diagnostics;
  return { rt, tick, diag };
}

describe('phase 23.8: injected variables', () => {
  it('the scripts read them with ctx.save from the very first step they run', () => {
    const seen: string[] = [];
    const reader = (ctx: Ctx): void => {
      if (ctx.phase !== 'intent' || seen.length > 0) return;
      seen.push(`${ctx.stepIndex}:${JSON.stringify(ctx.save!.get('gold'))}:${JSON.stringify(ctx.save!.get('party'))}:${ctx.save!.keys().join(',')}`);
    };
    const { rt } = harness({ reader }, [carrier('box-0001', 'reader')], { variables: { gold: 100, party: ['a', 'b'] } });
    // The first step any script ran (the settle pre-roll's step 0 included) already saw them.
    expect(seen).toEqual(['0:100:["a","b"]:gold,party']);
    expect(rt.runState?.().values).toEqual({ gold: 100, party: ['a', 'b'] });
  });

  it('without variables nothing is saved (the default start is unchanged)', () => {
    const { rt } = harness({ idle: () => undefined }, [carrier('box-0001', 'idle')]);
    expect(rt.runState?.().values).toEqual({});
  });

  it('variables break ctx.save rules: config_invalid', () => {
    for (const bad of [{ 'bad key': 1 }, { big: 'x'.repeat(5000) }, Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`k${i}`, i])), 'text', [1]]) {
      const { res } = instantiate({ idle: () => undefined }, [carrier('box-0001', 'idle')], { variables: bad });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe('config_invalid');
    }
  });
});

describe('phase 23.8: debug commands on input frames', () => {
  it('a frame with commands validates to frozen copies; a frame without keeps its exact shape', () => {
    const plain = validateActionFrame({ stepIndex: 3, moveX: 0, jump: 'none' });
    expect(plain.ok && JSON.stringify(plain.frame)).toBe('{"stepIndex":3,"moveX":0,"jump":"none"}');
    const withCmd = validateActionFrame({ stepIndex: 3, moveX: 0, jump: 'none', commands: [{ name: 'give', args: { item: 'key', count: 2, loud: true } }] });
    expect(withCmd.ok).toBe(true);
    if (withCmd.ok) {
      expect(withCmd.frame.commands).toEqual([{ name: 'give', args: { count: 2, item: 'key', loud: true } }]);
      expect(Object.isFrozen(withCmd.frame.commands)).toBe(true);
      expect(Object.isFrozen(withCmd.frame.commands![0]!.args)).toBe(true);
    }
    for (const commands of [
      'give',
      [{ name: '1bad', args: {} }],
      [{ name: 'give', args: { a: Number.NaN } }],
      [{ name: 'give', args: { a: 'x'.repeat(257) } }],
      [{ name: 'give', args: { a: {} } }],
      [{ name: 'give', extra: 1 }],
      Array.from({ length: 9 }, () => ({ name: 'give', args: {} })),
    ]) {
      expect(validateActionFrame({ stepIndex: 3, moveX: 0, jump: 'none', commands }).ok, JSON.stringify(commands).slice(0, 60)).toBe(false);
    }
  });

  it('a queued call reaches every declaring instance in the next step (intent phase), once, with its args and the handler', () => {
    const got: string[] = [];
    const handled: string[] = [];
    const giver = (ctx: Ctx): void => {
      const calls = ctx.debug!.command('giveItem', { description: 'Give the party an item', args: [{ name: 'item', type: 'string' }, { name: 'count', type: 'number', optional: true }] }, (a) => handled.push(`${ctx.entityId}:${String(a.item)}`));
      for (const a of calls) got.push(`${ctx.stepIndex}:${ctx.phase}:${ctx.entityId}:${JSON.stringify(a)}`);
    };
    const { rt, tick, diag } = harness({ giver }, [carrier('box-0001', 'giver'), carrier('box-0002', 'giver')]);
    const state = rt.debugCommandState!();
    expect(state.registered).toEqual([{ name: 'giveItem', description: 'Give the party an item', args: [{ name: 'item', type: 'string' }, { name: 'count', type: 'number', optional: true }] }]);
    tick(3);
    const before = diag().stepIndex;
    expect(rt.queueDebugCommand!({ name: 'giveItem', args: { item: 'lantern', count: 2 } }).ok).toBe(true);
    tick(2);
    // The next executed step carries the index the runtime reports now.
    const step = before;
    expect(got).toEqual([`${step}:intent:box-0001:{"count":2,"item":"lantern"}`, `${step}:intent:box-0002:{"count":2,"item":"lantern"}`]);
    expect(handled).toEqual(['box-0001:lantern', 'box-0002:lantern']);
    expect(rt.debugCommandState!().applied).toEqual([{ stepIndex: step, name: 'giveItem', args: { count: 2, item: 'lantern' } }]);
  });

  it('refuses an undeclared command or mismatched args; a second declaration with other args is a script error', () => {
    const one = (ctx: Ctx): void => void ctx.debug!.command('warp', { args: [{ name: 'x', type: 'number' }] });
    const { rt, tick } = harness({ one }, [carrier('box-0001', 'one')]);
    tick(1);
    const q = rt.queueDebugCommand!.bind(rt);
    for (const [call, text] of [
      [{ name: 'nothere', args: {} }, 'no script declared'],
      [{ name: 'warp', args: {} }, 'needs its argument "x"'],
      [{ name: 'warp', args: { x: 'far' } }, 'must be a number'],
      [{ name: 'warp', args: { x: 1, y: 2 } }, 'has no argument "y"'],
      [{ name: 'bad name', args: {} }, 'debug command'],
    ] as const) {
      const r = q(call as never);
      expect(r.ok, text).toBe(false);
      if (!r.ok) expect(r.error.message).toContain(text);
    }
    for (let i = 0; i < 16; i++) expect(q({ name: 'warp', args: { x: i } }).ok).toBe(true);
    expect(q({ name: 'warp', args: { x: 99 } }).ok).toBe(false); // 16 waiting at most

    const clash = harness(
      {
        a: (ctx: Ctx) => void ctx.debug!.command('heal', { args: [{ name: 'n', type: 'number' }] }),
        b: (ctx: Ctx) => void ctx.debug!.command('heal', { args: [{ name: 'n', type: 'string' }] }),
      },
      [carrier('box-0001', 'a'), carrier('box-0002', 'b')],
    );
    clash.tick(2);
    const errors = clash.diag().errors;
    expect(clash.diag().state).toBe('failed');
    expect(errors.some((e) => e.reason === 'behavior_debug_invalid' && e.message.includes('already declared with other options'))).toBe(true);
  });

  it('a recording with the calls at their steps reproduces the run exactly (a replay)', () => {
    const script = (log: string[]) => (ctx: Ctx): void => {
      if (ctx.phase !== 'intent') return;
      const hp = (ctx.save!.get('hp') as number | undefined) ?? 10;
      let next = hp;
      for (const a of ctx.debug!.command('damage', { args: [{ name: 'amount', type: 'number' }] })) next -= a.amount as number;
      for (const a of ctx.debug!.command('rename', { args: [{ name: 'to', type: 'string' }] })) ctx.save!.set('name', a.to);
      if (next !== hp) ctx.save!.set('hp', next);
      log.push(`${ctx.stepIndex}:${next}:${String(ctx.save!.get('name') ?? '-')}`);
    };
    // The live run: calls queued between frames, like the console and tl_game_control.
    const liveLog: string[] = [];
    const live = harness({ s: script(liveLog) }, [carrier('box-0001', 's')]);
    live.tick(5);
    live.rt.queueDebugCommand!({ name: 'damage', args: { amount: 3 } });
    live.tick(7);
    live.rt.queueDebugCommand!({ name: 'rename', args: { to: 'Ash' } });
    live.rt.queueDebugCommand!({ name: 'damage', args: { amount: 1 } });
    live.tick(10);
    const applied = live.rt.debugCommandState!().applied;
    expect(applied.map((a) => a.name)).toEqual(['damage', 'rename', 'damage']);
    // The recording: neutral frames, the calls at the steps the log names.
    const frames: ActionFrame[] = [];
    const last = live.diag().stepIndex + 5;
    for (let s = 0; s <= last; s += 1) {
      const calls = applied.filter((a) => a.stepIndex === s).map((a) => ({ name: a.name, args: a.args }));
      frames.push(calls.length > 0 ? { ...neutralFrame(s), commands: calls } : neutralFrame(s));
    }
    const replayLog: string[] = [];
    const replay = harness({ s: script(replayLog) }, [carrier('box-0001', 's')], { actions: createRecordedActionSource(frames) });
    replay.tick(22);
    expect(replayLog).toEqual(liveLog);
    expect(replay.rt.debugCommandState!().applied).toEqual(applied);
    expect(liveLog.at(-1)).toMatch(/:6:Ash$/);
  });

  it('a recorded call no script declared is dropped with a diagnostic, and the run goes on', () => {
    // (Step 30: past the settle pre-roll, whose steps run on neutral frames.)
    const frames: ActionFrame[] = [{ ...neutralFrame(30), commands: [{ name: 'ghost', args: {} }] }];
    const { tick, diag } = harness({ idle: () => undefined }, [carrier('box-0001', 'idle')], { actions: createRecordedActionSource(frames) });
    tick(40);
    expect(diag().state).not.toBe('failed');
    expect(diag().errors.some((e) => e.reason === 'debug_command_invalid' && e.message.includes('ghost'))).toBe(true);
  });
});
