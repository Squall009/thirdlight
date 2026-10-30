/**
 * M2 module phases, transform ownership and the write guard.
 *
 * Synthetic, dependency-free modules prove the canonical phase order, the
 * one-owner-per-transform rule, the phase-scoped write guard and the
 * unsupported-combination rejection at instantiate (no partial start).
 */
import { describe, expect, it } from 'vitest';
import { character3DSpec, instantiateRuntime, registerSimulationModule, type SimulationModuleSpec, type ActionFrame } from './index';
import {
  makeFakePort,
  makeM2Runtime,
  probeSpec,
  recordingSource,
  registryWith,
  v2Scene,
  v2Snapshot,
} from './m2-helpers';
import { baseScene, cloneJson, snapshotOf, boxMotionSpec } from './test-helpers';

const DT = 1 / 120;

interface InstantiateError {
  code: string;
  reason?: string;
}

function registerSimulationModuleForTest(
  registry: ReturnType<typeof registryWith>,
  spec: SimulationModuleSpec,
): InstantiateError | null {
  const res = registerSimulationModule(registry, spec.id, spec);
  return res.ok ? null : { code: res.error.code, reason: res.error.reason };
}

function instantiateError(
  modules: string[],
  specs: SimulationModuleSpec[],
  registry?: ReturnType<typeof registryWith>,
  physics?: ReturnType<typeof makeFakePort>,
  snapshot?: unknown,
): InstantiateError | null {
  const r = registry ?? registryWith(specs);
  const res = instantiateRuntime({
    snapshot: snapshot ?? v2Snapshot(),
    registry: r,
    modules,
    driver: { kind: 'manual' },
    clock: () => 0,
    ...(physics ? { physics } : {}),
  });
  if (res.ok) {
    res.runtime.dispose();
    return null;
  }
  return { code: res.error.code, reason: res.error.reason };
}

describe('M2 phase order', () => {
  it('runs sample → intent → controller → physics → transform → render in exact order per step', () => {
    const calls: string[] = [];
    const port = makeFakePort({ onStep: () => calls.push('physics') });
    const spec = probeSpec({
      id: 'thirdlight.test:phase-probe',
      phases: ['intent', 'controller', 'transform'],
      owners: ['char-0001'],
      requiresPhysicsPort: true,
      step: (phase, ctx) => {
        calls.push(phase);
        if (phase === 'controller') ctx.physics.stageCharacterMove('char-0001', { x: 0.01, y: 0 });
      },
    });
    const frames = recordingSource();
    const h = makeM2Runtime({
      modules: [spec.id],
      specs: [spec],
      physics: port,
      actions: frames,
      onFrame: () => calls.push('render'),
    });
    h.boot(); // frame 1: 12 neutral pre-roll steps, no sampling
    expect(frames.sampled).toEqual([]);
    expect(h.diag().settleSteps).toBe(12);
    expect(h.diag().stepIndex).toBe(12);
    expect(h.diag().inputSamples).toBe(0);
    expect(calls.slice(0, 4)).toEqual(['intent', 'controller', 'physics', 'transform']);
    expect(calls.filter((c) => c === 'intent').length).toBe(12);
    expect(calls.filter((c) => c === 'physics').length).toBe(12);
    expect(calls.at(-1)).toBe('render');

    calls.length = 0;
    h.tick(DT); // one executed step at index 12
    expect(frames.sampled).toEqual([12]);
    expect(calls).toEqual(['intent', 'controller', 'physics', 'transform', 'render']);
    expect(h.diag().stepIndex).toBe(13);
    expect(h.diag().inputSamples).toBe(1);
    expect(h.diag().physicsSteps).toBe(13);
    h.rt.dispose();
  });

  it('ctx.action is the identical sampled frame in every phase; ctx and non-curr state are frozen', () => {
    const seen: ActionFrame[] = [];
    const spec = probeSpec({
      id: 'thirdlight.test:frame-probe',
      phases: ['intent', 'transform'],
      owners: ['box-0001'],
      step: (phase, ctx) => {
        seen.push({ ...ctx.action });
        if (phase === 'intent') {
          expect(() => {
            (ctx as { stepIndex: number }).stepIndex = 9;
          }).toThrow(/frozen/);
          expect(() => {
            ctx.state.curr.set('box-0001', ctx.state.curr.get('box-0001')!);
          }).toThrow(/not allowed/);
          expect(() => {
            ctx.state.curr.get('box-0001')!.position[0] = 99;
          }).toThrow(/not allowed/);
          expect(() => {
            (ctx.state as { stepIndex: number }).stepIndex = 7;
          }).toThrow(/read-only/);
        }
      },
    });
    const h = makeM2Runtime({
      modules: [spec.id],
      specs: [spec],
      actions: recordingSource([{ stepIndex: 12, actions: { move: { v: 1, p: 'none' }, jump: { v: 1, p: 'pressed' } } }]),
    });
    h.boot();
    seen.length = 0;
    h.tick(DT);
    expect(seen).toHaveLength(2);
    for (const frame of seen) expect(frame).toEqual({ stepIndex: 12, actions: { move: { v: 1, p: 'none' }, jump: { v: 1, p: 'pressed' } } });
    h.rt.dispose();
  });

  it('transform ownership: only declared entities are writable and only in the transform phase', () => {
    const spec = probeSpec({
      id: 'thirdlight.test:owner-probe',
      phases: ['intent', 'transform'],
      owners: ['box-0001'],
      step: (phase, ctx) => {
        if (phase === 'transform') {
          ctx.state.curr.get('box-0001')!.position[0] = 2;
          expect(() => {
            ctx.state.curr.get('char-0001')!.position[0] = 3;
          }).toThrow(/not allowed/);
        }
      },
    });
    const h = makeM2Runtime({ modules: [spec.id], specs: [spec] });
    h.boot();
    const st = h.rt.getInterpolatedState();
    if (!st.ok) throw new Error('state failed');
    expect(st.state.transforms.find((t) => t.id === 'box-0001')!.position[0]).toBe(2);
    expect(st.state.transforms.find((t) => t.id === 'char-0001')!.position[0]).toBe(0);
    h.rt.dispose();
  });

  it('an unknown/unowned/duplicate transform claim is rejected at instantiate (no runtime instance)', () => {
    const a = probeSpec({ id: 'thirdlight.test:a', phases: ['transform'], owners: ['box-0001'] });
    const b = probeSpec({ id: 'thirdlight.test:b', phases: ['transform'], owners: ['box-0001'] });
    const dup = instantiateError([a.id, b.id], [a, b]);
    expect(dup).toMatchObject({ code: 'transform_owner_conflict', reason: 'box-0001' });

    const missing = instantiateError(['thirdlight.test:a'], [
      probeSpec({ id: 'thirdlight.test:a', phases: ['transform'], owners: ['nope-9999'] }),
    ]);
    expect(missing).toMatchObject({ code: 'transform_owner_conflict', reason: 'nope-9999' });

    // A camera is a shot like any object: a module may pose it.
    const camera = instantiateError(['thirdlight.test:a'], [
      probeSpec({ id: 'thirdlight.test:a', phases: ['transform'], owners: ['cam-main'] }),
    ]);
    expect(camera).toBeNull();

    const physicsEntity = instantiateError(['thirdlight.test:a'], [
      probeSpec({ id: 'thirdlight.test:a', phases: ['transform'], owners: ['char-0001'] }),
    ]);
    expect(physicsEntity).toMatchObject({ code: 'transform_owner_forbidden', reason: 'physics_entity' });

    // A collider no mover moves is script-drivable (the runtime poses it as a kinematic body).
    const floor = instantiateError(['thirdlight.test:a'], [
      probeSpec({ id: 'thirdlight.test:a', phases: ['transform'], owners: ['floor-0001'] }),
    ]);
    expect(floor).toBeNull();
  });

  it('module phase order mismatch (out of canonical order / duplicate / empty) is rejected at registration', () => {
    const badLists = [
      ['transform', 'intent'],
      ['controller', 'intent'],
      ['intent', 'intent'],
      [],
    ] as unknown as import('./index').SimulationPhase[][];
    for (const phases of badLists) {
      const registry = registryWith([]);
      const spec = probeSpec({ id: 'thirdlight.test:bad-order', phases });
      const res = registerSimulationModuleForTest(registry, spec);
      expect(res, JSON.stringify(phases)).toMatchObject({ code: 'config_invalid', reason: 'module_phases' });
    }
  });

  it('unsupported combination: a module that excludes the controller module is rejected (module_combination_unsupported)', () => {
    const exclusive = probeSpec({ id: 'thirdlight.test:exclusive', phases: ['transform'], excludes: [character3DSpec.id] });
    const err = instantiateError([exclusive.id, character3DSpec.id], [exclusive, character3DSpec], registryWith([exclusive, character3DSpec]), makeFakePort());
    expect(err).toMatchObject({ code: 'module_combination_unsupported' });
  });

  it('controller set without a port ⇒ config_invalid physics_port; no controller entity is a game without a player yet; v1/v2 scene ⇒ snapshot_invalid', () => {
    const controller = probeSpec({
      id: 'thirdlight.test:controller',
      phases: ['controller', 'transform'],
      owners: ['char-0001'],
      requiresPhysicsPort: true,
    });
    expect(instantiateError([controller.id], [controller])).toMatchObject({
      code: 'config_invalid',
      reason: 'physics_port',
    });

    // A player may arrive later with a scene: a controller module starts without one.
    const noController = v2Scene();
    noController.entities = (noController.entities as Array<{ id: string }>).filter((e) => e.id !== 'char-0001');
    const withoutPlayer = probeSpec({ id: 'thirdlight.test:controller', phases: ['controller', 'transform'], owners: [], requiresPhysicsPort: true });
    expect(
      instantiateError([withoutPlayer.id], [withoutPlayer], undefined, makeFakePort(), {
        snapshotId: 'demo-0001@r4',
        projectId: 'demo-0001',
        revision: 4,
        scene: noController,
      }),
    ).toBeNull();

    // A v1/v2 scene is not a playable snapshot at all.
    expect(
      instantiateError([controller.id], [controller], undefined, makeFakePort(), snapshotOf({ ...cloneJson(baseScene()), schemaVersion: 2 } as { revision: number })),
    ).toMatchObject({ code: 'snapshot_invalid' });
  });

  it('a module without phases cannot join a phased set (it would own no transform)', () => {
    const intent = probeSpec({ id: 'thirdlight.test:intent-only', phases: ['intent'] });
    const err = instantiateError([boxMotionSpec.id, intent.id], [intent], registryWith([boxMotionSpec, intent]));
    expect(err).toMatchObject({ code: 'config_invalid', reason: 'module_phases' });
  });
});
