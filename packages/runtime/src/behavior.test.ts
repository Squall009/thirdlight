/**
 * Packet 34 — the trusted behavior host (runtime.md §14).
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
  return { schemaVersion: 2, sceneId: 'scene-main', revision: 1, entities };
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

describe('behavior host lifecycle (runtime.md §14.3)', () => {
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

describe('validated intents (runtime.md §14.4/§14.5)', () => {
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

  it('rejects a transform write outside the transform phase (detail phase)', () => {
    const art = artifact('behavior-0001', (_s, ctx) => {
      const c = ctx as { emit: (i: unknown) => void };
      c.emit({ kind: 'transform', entityId: 'box-0001', position: { x: 1 } });
    }, { ownedTransforms: ['box-0001'] });
    const h = boot([art], sceneWithBehaviors([{ entityId: 'box-0001', behaviorId: 'behavior-0001' }]));
    h.boot();
    const d = h.diag();
    expect(d.state).toBe('failed');
    expect(d.errors[0]?.reason).toBe('behavior_intent_invalid');
    expect(d.errors[0]?.detail).toBe('phase');
  });

  it('rejects an invalid control_move value and a malformed shape', () => {
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
      expect(d.state).toBe('failed');
      expect(d.errors[0]?.code).toBe('module_error');
      expect(d.errors[0]?.reason).toBe('behavior_intent_invalid');
      expect(d.errors[0]?.detail).toBe(detail);
      expect(d.failedModuleId).toBe('thirdlight.behavior:behavior-0001');
    }
  });

  it('rejects a transform intent for an entity the module does not own', () => {
    const art = artifact('behavior-0001', (_s, ctx) => {
      const c = ctx as { phase: string; emit: (i: unknown) => void };
      if (c.phase === 'transform') c.emit({ kind: 'transform', entityId: 'cam-main', position: { x: 1 } });
    }, { ownedTransforms: ['box-0001'] });
    const h = boot([art], sceneWithBehaviors([{ entityId: 'box-0001', behaviorId: 'behavior-0001' }]));
    h.boot();
    const d = h.diag();
    expect(d.state).toBe('failed');
    expect(d.errors[0]?.reason).toBe('behavior_transform_forbidden');
    expect(d.errors[0]?.detail).toBe('not_owner');
  });

  it('rejects a duplicate transform write to the same axis in one step', () => {
    const art = artifact('behavior-0001', (_s, ctx) => {
      const c = ctx as { phase: string; emit: (i: unknown) => void };
      if (c.phase === 'transform') {
        c.emit({ kind: 'transform', entityId: 'box-0001', position: { x: 1 } });
        c.emit({ kind: 'transform', entityId: 'box-0001', position: { x: 2 } });
      }
    }, { ownedTransforms: ['box-0001'] });
    const h = boot([art], sceneWithBehaviors([{ entityId: 'box-0001', behaviorId: 'behavior-0001' }]));
    h.boot();
    const d = h.diag();
    expect(d.state).toBe('failed');
    expect(d.errors[0]?.reason).toBe('behavior_intent_conflict');
    expect(d.errors[0]?.detail).toBe('duplicate_intent');
  });

  it('rejects two writers of one control channel (duplicate_writer carrying both module IDs)', () => {
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
    const d = h.diag();
    expect(d.state).toBe('failed');
    expect(d.errors[0]?.reason).toBe('behavior_intent_conflict');
    expect(d.errors[0]?.detail).toBe('duplicate_writer');
    expect(d.errors[0]?.message).toContain('thirdlight.behavior:behavior-0001');
    expect(d.errors[0]?.message).toContain('thirdlight.behavior:behavior-0002');
  });

  it('accepts the five-channel closed maximum and rejects a sixth write as duplicate_intent (the per-instance cap is defense in depth)', () => {
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
    expect(d.state).toBe('failed');
    expect(d.errors[0]?.reason).toBe('behavior_intent_conflict');
    expect(d.errors[0]?.detail).toBe('duplicate_intent');
    // The five distinct channels of the first pre-roll step committed before
    // the sixth write was rejected.
    expect(d.intentCommitCount).toBe(5);
  });
});

describe('bounded logs (runtime.md §14.8)', () => {
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

describe('step failures and the frozen prepare object (runtime.md §14.1/§14.3.1)', () => {
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

describe('create-time failures (runtime.md §14.3.1/§14.6)', () => {
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
      detail: 'camera',
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
      createBehaviorModuleSpec({ declaration: { properties: [] }, artifact: art }),
    ).toThrow(BehaviorHostError);
    const res = instantiateRuntime({
      snapshot: snapshot(sceneWithBehaviors([{ entityId: 'box-0001', behaviorId: 'behavior-0001' }])),
      registry,
      modules: [],
      driver: { kind: 'manual' },
      clock: () => 0,
    });
    expect(res.ok).toBe(true);
  });

  it('discards the whole step on an invalid intent (no partial transform write)', () => {
    const art = artifact('behavior-0001', (_s, ctx) => {
      const c = ctx as { phase: string; emit: (i: unknown) => void };
      if (c.phase === 'transform') {
        c.emit({ kind: 'transform', entityId: 'box-0001', position: { x: 9 } });
        c.emit({ kind: 'transform', entityId: 'box-0001', position: { x: 9 } }); // duplicate → fail-stop
      }
    }, { ownedTransforms: ['box-0001'] });
    const h = boot([art], sceneWithBehaviors([{ entityId: 'box-0001', behaviorId: 'behavior-0001' }]));
    h.boot();
    const state = h.rt.getInterpolatedState();
    if (!state.ok) throw new Error('state failed');
    // The committed state is the pre-roll state; the abandoned step's write is
    // not observable (fail-stop keeps the last committed state).
    expect(state.state.transforms.find((t) => t.id === 'box-0001')?.position).toEqual([0, 0, 0]);
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
    const art = artifact('bad_id', () => {});
    expect(() => createBehaviorModuleSpec({ declaration: { properties: [{ ...SPEED }] }, artifact: art })).toThrow(
      BehaviorHostError,
    );
  });
});
