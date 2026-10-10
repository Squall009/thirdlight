/**
 * The trusted behavior host.
 *
 * The `BehaviorSpec` lifecycle, the validated-intent API (shape/phase/value/
 * ownership/duplicate/writer/caps), the per-instance log ring and flood
 * accounting, the frozen `prepare` object and the fail-stop reasons are
 * exercised against deterministic in-repo artifacts (plain objects). The real
 * compiled artifact is executed by `tests/browser/m2-behaviors/**`.
 */
import { describe, expect, it } from 'vitest';
import {
  BehaviorHostError,
  BehaviorIntentError,
  INTENT_LIMITS,
  createBehaviorModuleSpec,
  createSimulationRegistry,
  instantiateRuntime,
  registerSimulationModule,
  type BehaviorArtifact,
  type Runtime,
  type RuntimeDiagnostics,
} from './index';
import type { DeclaredProperty } from '@thirdlight/project-model';
import { probeSpec } from './m2-helpers';

const DT = 1 / 120;

interface SpecCall {
  kind: 'prepare' | 'instantiate' | 'step' | 'dispose';
  entityId?: string;
  phase?: string;
}

/** A deterministic artifact whose `step` is supplied by the test. */
function artifact(
  behaviorId: string,
  step: (state: unknown, ctx: unknown) => unknown,
  opts: {
    prepare?: (cfg: unknown) => unknown;
    instantiate?: (prepared: unknown, inst: unknown) => unknown;
    dispose?: (prepared: unknown, state: unknown) => void;
    ownedTransforms?: string[];
    calls?: SpecCall[];
  } = {},
): BehaviorArtifact {
  const calls = opts.calls;
  return {
    behaviorId,
    sourceDigest: 'a'.repeat(64),
    manifestDigest: 'b'.repeat(64),
    outputDigest: 'c'.repeat(64),
    ownedTransforms: opts.ownedTransforms ?? [],
    requiredModules: [],
    enginePins: [],
    namespace: {
      default: {
        prepare: (cfg: unknown) => {
          calls?.push({ kind: 'prepare' });
          return opts.prepare ? opts.prepare(cfg) : { t: 0 };
        },
        instantiate: (prepared: unknown, inst: unknown) => {
          calls?.push({ kind: 'instantiate', entityId: (inst as { entityId: string }).entityId });
          return opts.instantiate ? opts.instantiate(prepared, inst) : { t: 0 };
        },
        step: (state: unknown, ctx: unknown) => {
          calls?.push({ kind: 'step', phase: (ctx as { phase: string }).phase });
          return step(state, ctx);
        },
        dispose: (prepared: unknown, state: unknown) => {
          calls?.push({ kind: 'dispose' });
          opts.dispose?.(prepared, state);
        },
      },
    },
  };
}

const SPEED: DeclaredProperty = {
  key: 'speed',
  label: 'Speed',
  type: 'number',
  default: 3.5,
  min: -1000,
  max: 1000,
  step: 0.25,
};

/** A v2 scene: camera + one owned box per behavior + optional extra entities. */
function sceneWithBehaviors(
  behaviors: { entityId: string; behaviorId: string; values?: Record<string, unknown> }[],
): unknown {
  const transform = (position: number[]): unknown => ({ position, rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
  const entities: unknown[] = [
    {
      id: 'cam-main',
      components: { transform: transform([0, 0.5, 4]), camera: { type: 'perspective', fovY: 60, near: 0.1, far: 100 } },
    },
  ];
  for (const b of behaviors) {
    entities.push({
      id: b.entityId,
      components: {
        transform: transform([0, 0, 0]),
        box: { size: [1, 1, 1], material: { color: '#ffffff' } },
        behavior: { behaviorId: b.behaviorId, values: b.values ?? { speed: 3.5 } },
      },
    });
  }
  return { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities };
}

function snapshot(scene: unknown): unknown {
  return { snapshotId: 'demo-0001@r1', projectId: 'demo-0001', revision: 1, scene };
}

interface Harness {
  rt: Runtime;
  diag: () => RuntimeDiagnostics;
  boot: () => void;
  tick: (t: number) => void;
}

function boot(
  artifacts: BehaviorArtifact[],
  scene: unknown,
  options: { declaration?: DeclaredProperty[]; extraSpecs?: Parameters<typeof registerSimulationModule>[2][] } = {},
): Harness {
  const registry = createSimulationRegistry();
  const ids: string[] = [];
  for (const a of artifacts) {
    const spec = createBehaviorModuleSpec({
      declaration: { properties: (options.declaration ?? [SPEED]).map((p) => ({ ...p })) },
      artifact: a,
    });
    const res = registerSimulationModule(registry, spec.id, spec);
    if (!res.ok) throw new Error(`register failed: ${JSON.stringify(res.error)}`);
    ids.push(spec.id);
  }
  for (const spec of options.extraSpecs ?? []) {
    const res = registerSimulationModule(registry, spec.id, spec);
    if (!res.ok) throw new Error(`register failed: ${JSON.stringify(res.error)}`);
    ids.push(spec.id);
  }
  const res = instantiateRuntime({
    snapshot: snapshot(scene),
    registry,
    modules: ids,
    driver: { kind: 'manual' },
    clock: () => 0,
  });
  if (!res.ok) throw new Error(`instantiate failed: ${JSON.stringify(res.error)}`);
  const rt = res.runtime;
  let now = 0;
  return {
    rt,
    diag: () => {
      const d = rt.getDiagnostics();
      if (!d.ok) throw new Error('diagnostics failed');
      return d.diagnostics;
    },
    boot: () => {
      const s = rt.start();
      if (!s.ok) throw new Error(`start failed: ${JSON.stringify(s.error)}`);
      const r = rt.tick(0);
      if (!r.ok) throw new Error(`boot tick failed: ${JSON.stringify(r.error)}`);
    },
    tick: (t) => {
      now = t;
      const r = rt.tick(now);
      if (r.ok) return;
      if (r.error.code === 'runtime_failed') return; // the caller asserts the failed state
      throw new Error(`tick failed: ${JSON.stringify(r.error)}`);
    },
  };
}


/** The one log line a refused script call leaves (the run goes on). */
function refusalLine(d: { state: string; errors: readonly { code: string; reason?: string; message: string }[] }, reason: string, detail?: string): string {
  expect(d.state).toBe('running');
  const lines = d.errors.filter((e) => e.code === 'behavior_log' && e.reason === 'warn' && e.message.includes('refused'));
  expect(lines.length, JSON.stringify(d.errors)).toBe(1);
  expect(lines[0]!.message).toContain(detail === undefined ? `(${reason}` : `(${reason}, ${detail})`);
  return lines[0]!.message;
}

describe('behavior host lifecycle', () => {
  it('runs prepare once, instantiate per carrying entity in document order, one step per declared phase, and dispose exactly once', () => {
    const calls: SpecCall[] = [];
    const art = artifact(
      'behavior-0001',
      (_s, ctx) => {
        void ctx;
      },
      { calls, ownedTransforms: ['box-0001', 'box-0002'] },
    );
    const h = boot([art], sceneWithBehaviors([
      { entityId: 'box-0001', behaviorId: 'behavior-0001', values: { speed: 3.5 } },
      { entityId: 'box-0002', behaviorId: 'behavior-0001', values: { speed: 4.5 } },
    ]));
    h.boot();
    expect(calls.filter((c) => c.kind === 'prepare')).toHaveLength(1);
    const instantiations = calls.filter((c) => c.kind === 'instantiate').map((c) => c.entityId);
    expect(instantiations).toEqual(['box-0001', 'box-0002']);
    // 12-step settle pre-roll + one real frame with 0 elapsed steps → 12 × 2 phases × 2 instances.
    const phaseCalls = calls.filter((c) => c.kind === 'step');
    expect(phaseCalls).toHaveLength(12 * 2 * 2);
    expect(phaseCalls[0]).toEqual({ kind: 'step', phase: 'intent' });
    expect(phaseCalls[1]).toEqual({ kind: 'step', phase: 'intent' });
    expect(phaseCalls[2]).toEqual({ kind: 'step', phase: 'transform' });
    expect(phaseCalls[3]).toEqual({ kind: 'step', phase: 'transform' });
    h.rt.dispose();
    h.rt.dispose(); // idempotent
    expect(calls.filter((c) => c.kind === 'dispose')).toHaveLength(2);
  });

  it('runs a behavior whose id has an underscore (the project model accepts it, so Play must too)', () => {
    const calls: SpecCall[] = [];
    const art = artifact('hud_label', () => {}, { calls });
    const h = boot([art], sceneWithBehaviors([{ entityId: 'box-0001', behaviorId: 'hud_label' }]));
    h.boot();
    expect(h.diag().state).toBe('running');
    expect(calls.filter((c) => c.kind === 'instantiate').map((c) => c.entityId)).toEqual(['box-0001']);
    h.rt.dispose();
  });

  it('gives each fresh runtime instance a fresh prepare() result', () => {
    let prepares = 0;
    const art = artifact('behavior-0001', () => {}, { prepare: () => ({ n: (prepares += 1) }) });
    const a = boot([art], sceneWithBehaviors([{ entityId: 'box-0001', behaviorId: 'behavior-0001' }]));
    a.boot();
    const b = boot([art], sceneWithBehaviors([{ entityId: 'box-0001', behaviorId: 'behavior-0001' }]));
    b.boot();
    expect(prepares).toBe(2);
  });
});

describe('validated intents', () => {
  it('commits a quantized control_move that a later phase module can read', () => {
    const seen: { move: number | null; moveWriter: string | null }[] = [];
    const art = artifact('behavior-0001', (_s, ctx) => {
      (ctx as { emit: (i: unknown) => void }).emit({ kind: 'control_move', value: 0.33333 });
    });
    const probe = probeSpec({
      id: 'thirdlight.test:intent-reader',
      phases: ['transform'],
      step: (_phase, ctx) => {
        seen.push({ move: ctx.intents.move, moveWriter: ctx.intents.moveWriter });
      },
    });
    const h = boot([art], sceneWithBehaviors([{ entityId: 'box-0001', behaviorId: 'behavior-0001' }]), {
      extraSpecs: [probe],
    });
    h.boot();
    expect(seen).toHaveLength(12);
    expect(seen[11]?.move).toBe(0.3333);
    expect(seen[11]?.moveWriter).toBe('thirdlight.behavior:behavior-0001');
    expect(h.diag().intentCommitCount).toBe(12);
  });

  it('applies a transform intent to the owned entity position axes in the transform phase', () => {
    const art = artifact('behavior-0001', (_s, ctx) => {
      const c = ctx as { phase: string; emit: (i: unknown) => void };
      if (c.phase === 'transform') c.emit({ kind: 'transform', entityId: 'box-0001', position: { x: 2, y: 1 } });
    }, { ownedTransforms: ['box-0001'] });
    const h = boot([art], sceneWithBehaviors([{ entityId: 'box-0001', behaviorId: 'behavior-0001' }]));
    h.boot();
    const state = h.rt.getInterpolatedState();
    if (!state.ok) throw new Error('state failed');
    const box = state.state.transforms.find((t) => t.id === 'box-0001');
    expect(box?.position).toEqual([2, 1, 0]);
    expect(h.diag().intentCommitCount).toBe(12);
  });

  it('applies a pose intent: rotation (yaw · pitch · roll, degrees) and scale on the owned entity', () => {
    const art = artifact('behavior-0001', (_s, ctx) => {
      const c = ctx as { phase: string; emit: (i: unknown) => void };
      if (c.phase === 'transform') c.emit({ kind: 'pose', entityId: 'box-0001', rotation: { yaw: 90 }, scale: [1, 2, 0.5] });
    }, { ownedTransforms: ['box-0001'] });
    const h = boot([art], sceneWithBehaviors([{ entityId: 'box-0001', behaviorId: 'behavior-0001' }]));
    h.boot();
    const state = h.rt.getInterpolatedState();
    if (!state.ok) throw new Error('state failed');
    const box = state.state.transforms.find((t) => t.id === 'box-0001')!;
    expect(box.rotation[1]).toBeCloseTo(Math.SQRT1_2, 6);
    expect(box.rotation[3]).toBeCloseTo(Math.SQRT1_2, 6);
    expect(box.scale).toEqual([1, 2, 0.5]);
    // Yaw then pitch then roll: yaw 90 + roll 90 is (0.5, 0.5, 0.5, 0.5).
    const art2 = artifact('behavior-0001', (_s, ctx) => {
      const c = ctx as { phase: string; emit: (i: unknown) => void };
      if (c.phase === 'transform') c.emit({ kind: 'pose', entityId: 'box-0001', rotation: { yaw: 90, roll: 90 } });
    }, { ownedTransforms: ['box-0001'] });
    const h2 = boot([art2], sceneWithBehaviors([{ entityId: 'box-0001', behaviorId: 'behavior-0001' }]));
    h2.boot();
    const s2 = h2.rt.getInterpolatedState();
    if (!s2.ok) throw new Error('state failed');
    for (const v of s2.state.transforms.find((t) => t.id === 'box-0001')!.rotation) expect(v).toBeCloseTo(0.5, 6);
  });

  it('refuses a bad pose (no fields, wrong order, a bad scale, another entity, outside the transform phase): emit returns false, one log line, the run goes on', () => {
    for (const [bad, reason, detail, phase] of [
      [{ kind: 'pose', entityId: 'box-0001' }, 'behavior_intent_invalid', 'shape', 'transform'],
      [{ kind: 'pose', entityId: 'box-0001', scale: 2, rotation: { yaw: 1 } }, 'behavior_intent_invalid', 'shape', 'transform'],
      [{ kind: 'pose', entityId: 'box-0001', scale: 0 }, 'behavior_intent_invalid', 'value', 'transform'],
      [{ kind: 'pose', entityId: 'cam-main', scale: 2 }, 'behavior_transform_forbidden', 'not_owner', 'transform'],
      [{ kind: 'pose', entityId: 'box-0001', rotation: { roll: 5 } }, 'behavior_intent_invalid', 'phase', 'intent'],
    ] as const) {
      const answers: boolean[] = [];
      const art = artifact('behavior-0001', (_s, ctx) => {
        const c = ctx as { phase: string; emit: (i: unknown) => boolean };
        if (c.phase === phase) answers.push(c.emit(bad));
      }, { ownedTransforms: ['box-0001'] });
      const h = boot([art], sceneWithBehaviors([{ entityId: 'box-0001', behaviorId: 'behavior-0001' }]));
      h.boot();
      h.tick(DT);
      h.tick(2 * DT);
      refusalLine(h.diag(), reason, detail);
      expect(answers.length).toBeGreaterThan(1);
      expect(answers.every((a) => !a), JSON.stringify(bad)).toBe(true);
    }
  });

  it('refuses a transform write outside the transform phase (detail phase)', () => {
    const art = artifact('behavior-0001', (_s, ctx) => {
      const c = ctx as { emit: (i: unknown) => void };
      c.emit({ kind: 'transform', entityId: 'box-0001', position: { x: 1 } });
    }, { ownedTransforms: ['box-0001'] });
    const h = boot([art], sceneWithBehaviors([{ entityId: 'box-0001', behaviorId: 'behavior-0001' }]));
    h.boot();
    refusalLine(h.diag(), 'behavior_intent_invalid', 'phase');
  });

  it('refuses an invalid control_move value and a malformed shape', () => {
    for (const [bad, detail] of [
      [{ kind: 'control_move', value: 5 }, 'value'],
      [{ kind: 'control_move' }, 'shape'],
      [{ kind: 'control_move', value: 0, extra: 1 }, 'shape'],
    ] as const) {
      const art = artifact('behavior-0001', (_s, ctx) => {
        (ctx as { emit: (i: unknown) => void }).emit(bad as unknown);
      });
      const h = boot([art], sceneWithBehaviors([{ entityId: 'box-0001', behaviorId: 'behavior-0001' }]));
      h.boot();
      const d = h.diag();
      expect(refusalLine(d, 'behavior_intent_invalid', detail)).toContain('behavior "behavior-0001"');
      expect(d.failedModuleId ?? null).toBe(null);
    }
  });

  it('refuses a transform intent for an entity the module does not own', () => {
    const art = artifact('behavior-0001', (_s, ctx) => {
      const c = ctx as { phase: string; emit: (i: unknown) => void };
      if (c.phase === 'transform') c.emit({ kind: 'transform', entityId: 'cam-main', position: { x: 1 } });
    }, { ownedTransforms: ['box-0001'] });
    const h = boot([art], sceneWithBehaviors([{ entityId: 'box-0001', behaviorId: 'behavior-0001' }]));
    h.boot();
    refusalLine(h.diag(), 'behavior_transform_forbidden', 'not_owner');
  });

  it('refuses a duplicate transform write to the same axis in one step (the first stands)', () => {
    const art = artifact('behavior-0001', (_s, ctx) => {
      const c = ctx as { phase: string; emit: (i: unknown) => void };
      if (c.phase === 'transform') {
        c.emit({ kind: 'transform', entityId: 'box-0001', position: { x: 1 } });
        c.emit({ kind: 'transform', entityId: 'box-0001', position: { x: 2 } });
      }
    }, { ownedTransforms: ['box-0001'] });
    const h = boot([art], sceneWithBehaviors([{ entityId: 'box-0001', behaviorId: 'behavior-0001' }]));
    h.boot();
    refusalLine(h.diag(), 'behavior_intent_conflict', 'duplicate_intent');
    // The first write stands.
    const st = h.rt.getInterpolatedState();
    if (!st.ok) throw new Error('state failed');
    expect(st.state.transforms.find((t) => t.id === 'box-0001')!.position[0]).toBeCloseTo(1, 6);
  });

  it('refuses the second writer of one control channel (duplicate_writer carrying both module IDs)', () => {
    const a = artifact('behavior-0001', (_s, ctx) => {
      (ctx as { emit: (i: unknown) => void }).emit({ kind: 'control_move', value: 0.5 });
    });
    const b = artifact('behavior-0002', (_s, ctx) => {
      (ctx as { emit: (i: unknown) => void }).emit({ kind: 'control_move', value: -0.5 });
    });
    const h = boot(
      [a, b],
      sceneWithBehaviors([
        { entityId: 'box-0001', behaviorId: 'behavior-0001' },
        { entityId: 'box-0002', behaviorId: 'behavior-0002' },
      ]),
    );
    h.boot();
    const line = refusalLine(h.diag(), 'behavior_intent_conflict', 'duplicate_writer');
    expect(line).toContain('thirdlight.behavior:behavior-0001');
    expect(line).toContain('thirdlight.behavior:behavior-0002');
  });

  it('accepts the five-channel closed maximum and refuses a sixth write as duplicate_intent (the per-instance cap is defense in depth)', () => {
    const art = artifact('behavior-0001', (_s, ctx) => {
      const c = ctx as { phase: string; emit: (i: unknown) => void };
      if (c.phase === 'intent') {
        c.emit({ kind: 'control_move', value: 0.5 });
        c.emit({ kind: 'control_jump', value: 'pressed' });
      } else {
        c.emit({ kind: 'transform', entityId: 'box-0001', position: { x: 1 } });
        c.emit({ kind: 'transform', entityId: 'box-0001', position: { y: 1 } });
        c.emit({ kind: 'transform', entityId: 'box-0001', position: { z: 1 } });
        c.emit({ kind: 'transform', entityId: 'box-0001', position: { x: 2 } });
      }
    }, { ownedTransforms: ['box-0001'] });
    const h = boot([art], sceneWithBehaviors([{ entityId: 'box-0001', behaviorId: 'behavior-0001' }]));
    h.boot();
    const d = h.diag();
    refusalLine(d, 'behavior_intent_conflict', 'duplicate_intent');
    // Every step committed its five distinct channels; each sixth write was refused.
    expect(d.intentCommitCount).toBeGreaterThan(5);
    expect((d.intentCommitCount ?? 0) % 5).toBe(0);
  });

  it('scales the per-step cap with the live instances (20 instances × 4 intents = 80 > 64 is accepted)', () => {
    const ids = Array.from({ length: 20 }, (_, i) => `box-${String(i + 1).padStart(4, '0')}`);
    const art = artifact('behavior-0001', (_s, ctx) => {
      const c = ctx as { phase: string; entityId: string; emit: (i: unknown) => void };
      if (c.phase !== 'transform') return;
      c.emit({ kind: 'transform', entityId: c.entityId, position: { x: 1 } });
      c.emit({ kind: 'transform', entityId: c.entityId, position: { y: 2 } });
      c.emit({ kind: 'transform', entityId: c.entityId, position: { z: 3 } });
      c.emit({ kind: 'pose', entityId: c.entityId, rotation: { yaw: 90 } });
    }, { ownedTransforms: ['@self'] });
    const h = boot([art], sceneWithBehaviors(ids.map((entityId) => ({ entityId, behaviorId: 'behavior-0001' }))));
    h.boot();
    for (let i = 1; i <= 3; i += 1) h.tick(i * DT);
    const d = h.diag();
    expect(d.state).toBe('running');
    expect(d.errors).toEqual([]);
    expect(20 * 4).toBeGreaterThan(INTENT_LIMITS.perStep);
    // Every step committed all 80.
    expect((d.intentCommitCount ?? 0) % 80).toBe(0);
    expect(d.intentCommitCount).toBeGreaterThanOrEqual(80 * 3);
  });

  it('keeps the fixed floor of 64 for intents not bounded per instance (a module without instances)', () => {
    const boxes = Array.from({ length: 22 }, (_, i) => `box-${String(i + 1).padStart(4, '0')}`);
    const flood = probeSpec({
      id: 'thirdlight.test:flood',
      phases: ['transform'],
      owners: boxes,
      step: (_phase, ctx) => {
        for (const id of boxes) for (const axis of ['x', 'y', 'z']) ctx.emit({ kind: 'transform', entityId: id, position: { [axis]: 1 } });
      },
    });
    const scene = sceneWithBehaviors([]) as { entities: unknown[] };
    for (const id of boxes) scene.entities.push({ id, components: { transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, box: { size: [1, 1, 1], material: { color: '#ffffff' } } } });
    const h = boot([], scene, { extraSpecs: [flood] });
    h.boot();
    const d = h.diag();
    expect(d.state).toBe('failed');
    expect(d.errors[0]?.reason).toBe('behavior_intent_limit');
    expect(d.errors[0]?.detail).toBe('per_step');
    expect(d.intentCommitCount).toBe(INTENT_LIMITS.perStep);
  });
});

describe('bounded logs', () => {
  it('accepts 16 logs per step per instance, counts the rest as dropped, and keeps the runtime ring bounded', () => {
    const art = artifact('behavior-0001', (_s, ctx) => {
      const c = ctx as { log: (l: string, m: string) => void };
      for (let i = 0; i < 40; i += 1) c.log('warn', `entry ${i}`);
    });
    const h = boot([art], sceneWithBehaviors([{ entityId: 'box-0001', behaviorId: 'behavior-0001' }]));
    h.boot();
    const d = h.diag();
    expect(d.state).toBe('running');
    expect(d.logCount).toBe(16 * 12);
    expect(d.logDropped).toBe(24 * 12);
    // The runtime ring keeps at most 32 entries (the contract bound).
    expect(d.errors.length).toBeLessThanOrEqual(32);
    expect(d.errors.every((e) => e.code === 'behavior_log')).toBe(true);
    expect(d.errorCount).toBe(16 * 12);
  });

  it('truncates a log message to 256 chars and keeps the per-instance ring at 32', () => {
    const long = 'x'.repeat(1000);
    const art = artifact('behavior-0001', (_s, ctx) => {
      (ctx as { log: (l: string, m: string) => void }).log('info', long);
    });
    const h = boot([art], sceneWithBehaviors([{ entityId: 'box-0001', behaviorId: 'behavior-0001' }]));
    h.boot();
    const d = h.diag();
    expect(d.logCount).toBe(12);
    const entry = d.errors[d.errors.length - 1];
    expect(entry?.code).toBe('behavior_log');
    expect(entry?.reason).toBe('info');
    expect(entry?.message.length).toBe(INTENT_LIMITS.logMessageLength);
    expect(entry?.message.endsWith('…')).toBe(true);
  });
});

describe('step failures and the frozen prepare object', () => {
  it('fail-stops on a module throw with behavior_step_failed and refuses to resume', () => {
    const art = artifact('behavior-0001', () => {
      throw new Error('boom');
    });
    const h = boot([art], sceneWithBehaviors([{ entityId: 'box-0001', behaviorId: 'behavior-0001' }]));
    h.boot();
    const d = h.diag();
    expect(d.state).toBe('failed');
    expect(d.failed).toBe(true);
    expect(d.errors[0]?.code).toBe('module_error');
    expect(d.errors[0]?.reason).toBe('behavior_step_failed');
    expect(d.failedModuleId).toBe('thirdlight.behavior:behavior-0001');
    expect(d.failedPhase).toBe('intent');
    const started = h.rt.start();
    expect(started.ok).toBe(false);
    if (!started.ok) expect(started.error.code).toBe('runtime_failed');
    expect(h.rt.getInterpolatedState().ok).toBe(true);
  });

  it('fail-stops on a thenable step return with behavior_step_async', () => {
    const art = artifact('behavior-0001', () => Promise.resolve());
    const h = boot([art], sceneWithBehaviors([{ entityId: 'box-0001', behaviorId: 'behavior-0001' }]));
    h.boot();
    expect(h.diag().errors[0]?.reason).toBe('behavior_step_async');
  });

  it('fail-stops when a step mutates the frozen prepare() result with behavior_state_shared', () => {
    const art = artifact('behavior-0001', (s) => {
      (s as { prepared: { shared: number } }).prepared.shared = 1;
    }, { prepare: () => ({ shared: 0 }), instantiate: (prepared) => ({ prepared }) });
    const h = boot([art], sceneWithBehaviors([{ entityId: 'box-0001', behaviorId: 'behavior-0001' }]));
    h.boot();
    expect(h.diag().errors[0]?.reason).toBe('behavior_state_shared');
  });

  it('records exactly one bounded entry per throw flood (the first throw stops the instance)', () => {
    const art = artifact('behavior-0001', () => {
      throw new Error('boom'.repeat(200));
    });
    const h = boot([art], sceneWithBehaviors([{ entityId: 'box-0001', behaviorId: 'behavior-0001' }]));
    h.boot();
    const d = h.diag();
    expect(d.errors).toHaveLength(1);
    expect(d.errorCount).toBe(1);
    expect((d.errors[0]?.message ?? '').length).toBeLessThanOrEqual(256);
  });
});

describe('create-time failures', () => {
  function instantiateError(art: BehaviorArtifact, scene: unknown): { code: string; reason?: string; detail?: string } {
    const registry = createSimulationRegistry();
    const spec = createBehaviorModuleSpec({ declaration: { properties: [{ ...SPEED }] }, artifact: art });
    registerSimulationModule(registry, spec.id, spec);
    const res = instantiateRuntime({
      snapshot: snapshot(scene),
      registry,
      modules: [spec.id],
      driver: { kind: 'manual' },
      clock: () => 0,
    });
    if (res.ok) throw new Error('expected instantiate failure');
    return res.error as { code: string; reason?: string; detail?: string };
  }

  it('maps a prepare throw to config_invalid/behavior_prepare_failed', () => {
    const art = artifact('behavior-0001', () => {}, { prepare: () => { throw new Error('nope'); } });
    expect(instantiateError(art, sceneWithBehaviors([{ entityId: 'box-0001', behaviorId: 'behavior-0001' }]))).toMatchObject({
      code: 'config_invalid',
      reason: 'behavior_prepare_failed',
    });
  });

  it('maps an instantiate throw to config_invalid/behavior_instantiate_failed and disposes the created instances', () => {
    const calls: SpecCall[] = [];
    const art = artifact('behavior-0001', () => {}, {
      calls,
      instantiate: (prepared, inst) => {
        if ((inst as { entityId: string }).entityId === 'box-0002') throw new Error('second');
        return { t: 0 };
      },
    });
    const err = instantiateError(art, sceneWithBehaviors([
      { entityId: 'box-0001', behaviorId: 'behavior-0001' },
      { entityId: 'box-0002', behaviorId: 'behavior-0001' },
    ]));
    expect(err).toMatchObject({ code: 'config_invalid', reason: 'behavior_instantiate_failed' });
    expect(calls.filter((c) => c.kind === 'dispose')).toHaveLength(1);
  });

  it('rejects a stored value that violates its declaration as behavior_property_invalid', () => {
    const art = artifact('behavior-0001', () => {});
    expect(instantiateError(art, sceneWithBehaviors([
      { entityId: 'box-0001', behaviorId: 'behavior-0001', values: { speed: 'fast' } },
    ]))).toMatchObject({ code: 'config_invalid', reason: 'behavior_property_invalid', detail: 'speed:type' });
  });

  it('rejects an undeclared stored key as behavior_property_invalid', () => {
    const art = artifact('behavior-0001', () => {});
    expect(instantiateError(art, sceneWithBehaviors([
      { entityId: 'box-0001', behaviorId: 'behavior-0001', values: { speed: 3.5, nope: 1 } },
    ]))).toMatchObject({ code: 'config_invalid', reason: 'behavior_property_invalid', detail: 'nope:unknown' });
  });

  it('rejects an owner that does not carry this behavior as transform_owner_forbidden/not_behavior_entity', () => {
    const art = artifact('behavior-0001', () => {}, { ownedTransforms: ['cam-main'] });
    expect(instantiateError(art, sceneWithBehaviors([{ entityId: 'box-0001', behaviorId: 'behavior-0001' }]))).toMatchObject({
      code: 'transform_owner_forbidden',
      reason: 'behavior_ownership_forbidden',
      // A camera is a shot: what refuses it here is that it does not carry the behavior.
      detail: 'not_behavior_entity',
    });
    const art2 = artifact('behavior-0001', () => {}, { ownedTransforms: ['box-0002'] });
    expect(instantiateError(art2, sceneWithBehaviors([{ entityId: 'box-0001', behaviorId: 'behavior-0001' }]))).toMatchObject({
      code: 'transform_owner_forbidden',
      reason: 'behavior_ownership_forbidden',
      detail: 'not_behavior_entity',
    });
  });

  it('rejects a declaration that is not a well-formed declaration', () => {
    const art = artifact('behavior-0001', () => {});
    const registry = createSimulationRegistry();
    expect(() =>
      createBehaviorModuleSpec({ declaration: { properties: 'none' } as never, artifact: art }),
    ).toThrow(BehaviorHostError);
    // No property at all is a valid declaration.
    expect(() => createBehaviorModuleSpec({ declaration: { properties: [] }, artifact: art })).not.toThrow();
    const res = instantiateRuntime({
      snapshot: snapshot(sceneWithBehaviors([{ entityId: 'box-0001', behaviorId: 'behavior-0001' }])),
      registry,
      modules: [],
      driver: { kind: 'manual' },
      clock: () => 0,
    });
    expect(res.ok).toBe(true);
  });

  it('keeps the step\'s other writes when one intent is refused', () => {
    const art = artifact('behavior-0001', (_s, ctx) => {
      const c = ctx as { phase: string; emit: (i: unknown) => void };
      if (c.phase === 'transform') {
        c.emit({ kind: 'transform', entityId: 'box-0001', position: { x: 9 } });
        c.emit({ kind: 'transform', entityId: 'box-0001', position: { x: 5 } }); // duplicate → refused
      }
    }, { ownedTransforms: ['box-0001'] });
    const h = boot([art], sceneWithBehaviors([{ entityId: 'box-0001', behaviorId: 'behavior-0001' }]));
    h.boot();
    const state = h.rt.getInterpolatedState();
    if (!state.ok) throw new Error('state failed');
    expect(state.state.transforms.find((t) => t.id === 'box-0001')?.position).toEqual([9, 0, 0]);
    expect(h.diag().state).toBe('running');
  });
});

describe('public surface', () => {
  it('exposes the contract reason tokens through BehaviorIntentError', () => {
    const error = new BehaviorIntentError('behavior_intent_invalid', 'shape', 'x');
    expect(error.code).toBe('module_error');
    expect(error.reason).toBe('behavior_intent_invalid');
    expect(error.detail).toBe('shape');
  });

  it('does not expose a behavior host for a behaviorId that cannot form a module ID', () => {
    const art = artifact('Bad.Id', () => {});
    expect(() => createBehaviorModuleSpec({ declaration: { properties: [{ ...SPEED }] }, artifact: art })).toThrow(
      BehaviorHostError,
    );
  });
});

describe('callbacks on the behavior spec', () => {
  const namespaceArtifact = (spec: Record<string, unknown>): BehaviorArtifact => ({
    behaviorId: 'behavior-0001',
    sourceDigest: 'a'.repeat(64),
    manifestDigest: 'b'.repeat(64),
    outputDigest: 'c'.repeat(64),
    ownedTransforms: [],
    requiredModules: [],
    enginePins: [],
    namespace: { default: spec },
  });

  it('accepts a spec with callbacks and no step; onEnable runs once per instance, in the first step, before any step', () => {
    const seen: string[] = [];
    const h = boot(
      [namespaceArtifact({ instantiate: () => ({}), onEnable: (_s: unknown, ctx: { entityId: string; stepIndex: number; phase: string }) => { seen.push(`${ctx.entityId}@${ctx.stepIndex}:${ctx.phase}`); } })],
      sceneWithBehaviors([
        { entityId: 'box-0001', behaviorId: 'behavior-0001' },
        { entityId: 'box-0002', behaviorId: 'behavior-0001' },
      ]),
    );
    h.boot();
    expect(h.diag().state).not.toBe('failed');
    expect(seen).toEqual(['box-0001@0:intent', 'box-0002@0:intent']);
  });

  it('refuses a spec with neither step nor callbacks, and a callback that is not a function', () => {
    expect(() => createBehaviorModuleSpec({ declaration: { properties: [] }, artifact: namespaceArtifact({ instantiate: () => ({}) }) })).toThrow(/step\(\) function or callbacks/);
    expect(() => createBehaviorModuleSpec({ declaration: { properties: [] }, artifact: namespaceArtifact({ step: () => undefined, onMessage: 3 }) })).toThrow(/onMessage must be a function/);
  });

  it('fail-stops on a throwing callback (the callback named) and on a callback returning a value', () => {
    const h = boot(
      [namespaceArtifact({ step: () => undefined, onEnable: () => { throw new Error('boom'); } })],
      sceneWithBehaviors([{ entityId: 'box-0001', behaviorId: 'behavior-0001' }]),
    );
    h.boot();
    const d = h.diag();
    expect(d.state).toBe('failed');
    expect(d.errors[0]?.reason).toBe('behavior_step_failed');
    expect(d.errors[0]?.message).toMatch(/onEnable threw: boom/);

    const h2 = boot(
      [namespaceArtifact({ step: () => undefined, onEnable: () => 1 })],
      sceneWithBehaviors([{ entityId: 'box-0001', behaviorId: 'behavior-0001' }]),
    );
    h2.boot();
    expect(h2.diag().errors[0]?.reason).toBe('behavior_step_async');
    expect(h2.diag().errors[0]?.message).toMatch(/onEnable returned a value/);
  });
});
