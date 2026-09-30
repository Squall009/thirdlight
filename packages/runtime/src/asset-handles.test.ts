/**
 * Scripts' asset handles (`ctx.assets`) in the runtime: a load answers a
 * handle at once and asks the host after the step; the host's answer enters
 * as the next sampled step's input and the script sees ready (or failed) in
 * that step; a release asks the host to let go; a late answer for a
 * released handle changes nothing; a run's end releases the open handles and
 * says so; a recorded input takes no live answer on top of its own.
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
  validateAssetAnswers,
  type ActionFrame,
  type ActionSource,
  type BehaviorAssets,
  type Runtime,
} from './index';

const HZ = 120;
const DT = 1 / HZ;
const T = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };

interface Ctx {
  stepIndex: number;
  phase: string;
  assets: BehaviorAssets;
}

/** What the script saw, step by step. */
interface Seen {
  handle: number;
  states: { step: number; state: string | null; ids: readonly string[]; error: string }[];
}

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

/**
 * A runtime with one script that loads `key` in its first intent step and
 * releases the handle `releaseAt` steps after it is ready (never when absent).
 */
function harness(key: string, opts: { releaseAt?: number; actions?: ActionSource } = {}) {
  const seen: Seen = { handle: 0, states: [] };
  let readyStep = -1;
  const step = (ctx: Ctx): void => {
    if (ctx.phase !== 'intent') return;
    if (seen.handle === 0) {
      seen.handle = ctx.assets.load(key);
      return;
    }
    const state = ctx.assets.state(seen.handle);
    seen.states.push({ step: ctx.stepIndex, state, ids: ctx.assets.ids(seen.handle), error: ctx.assets.error(seen.handle) });
    if (state === 'ready' && readyStep < 0) readyStep = ctx.stepIndex;
    if (opts.releaseAt !== undefined && readyStep >= 0 && ctx.stepIndex === readyStep + opts.releaseAt) ctx.assets.release(seen.handle);
  };
  const artifact = {
    behaviorId: 'loader',
    sourceDigest: 'a'.repeat(64),
    manifestDigest: 'b'.repeat(64),
    outputDigest: 'c'.repeat(64),
    ownedTransforms: [],
    requiredModules: [],
    enginePins: [],
    namespace: { default: { step: (_s: unknown, ctx: Ctx) => step(ctx) } },
  } as never;
  const spec = createBehaviorModuleSpec({ declaration: { properties: [] } as never, artifact });
  const registry = createSimulationRegistry();
  registerSimulationModule(registry, spec.id, spec);
  const now = { t: 0 };
  const res = instantiateRuntime({
    snapshot: {
      snapshotId: 'handles@r1',
      projectId: 'handles',
      revision: 1,
      scene: {
        schemaVersion: 4,
        sceneId: 'scene-main',
        revision: 1,
        entities: [
          { id: 'cam-main', components: { transform: { ...T, position: [0, 4, 12] }, camera: { type: 'perspective', fovY: 45, near: 0.1, far: 100 } } },
          { id: 'player-0001', components: { transform: T, controller: {} } },
          { id: 'spawn-0001', components: { transform: T, playerSpawn: {} } },
          { id: 'loader-0001', components: { transform: T, behavior: { behaviorId: 'loader', values: {} } } },
        ],
      },
    },
    registry,
    modules: [spec.id],
    actions: opts.actions ?? { sample: (i: number) => neutralFrame(i) },
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
  const tick = (n = 1): void => {
    for (let i = 0; i < n; i += 1) {
      now.t += DT;
      const r = rt.tick(now.t);
      if (!r.ok) throw new Error(`tick failed: ${JSON.stringify(r.error)}`);
    }
  };
  const logs = (): string[] => {
    const d = rt.getDiagnostics();
    return d.ok ? d.diagnostics.errors.filter((e) => e.code === 'behavior_log').map((e) => e.message) : [];
  };
  return { rt, tick, seen, logs };
}

describe('asset answers in an input frame', () => {
  it('a frame carries answers: ready with ids, or failed with why; a bad answer is refused', () => {
    const ok = validateActionFrame({ stepIndex: 3, assets: [{ handle: 1, ok: true, assets: ['tex-a', 'model-b'] }, { handle: 2, ok: false, message: 'gone' }] });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.frame.assets).toEqual([{ handle: 1, ok: true, assets: ['tex-a', 'model-b'] }, { handle: 2, ok: false, message: 'gone' }]);
    expect(validateAssetAnswers([{ handle: 0, ok: true }]).ok).toBe(false);
    expect(validateAssetAnswers([{ handle: 1, ok: 'yes' }]).ok).toBe(false);
    expect(validateAssetAnswers([{ handle: 1, ok: true, assets: [''] }]).ok).toBe(false);
    expect(validateAssetAnswers([{ handle: 1, ok: true, extra: 1 }]).ok).toBe(false);
    // A label may name any number of assets: one answer carries them all.
    const many = Array.from({ length: 5000 }, (_, i) => `asset-${i}`);
    expect(validateAssetAnswers([{ handle: 1, ok: true, assets: many }]).ok).toBe(true);
  });
});

describe('ctx.assets in the runtime', () => {
  it('loading until the host answers, ready in the step the answer rides on, released on request', () => {
    const h = harness('batch', { releaseAt: 3 });
    h.tick(2);
    expect(h.seen.handle).toBe(1);
    // The load left the simulation after its step; nothing answered yet: still loading.
    expect(h.rt.takeAssetRequests!()).toEqual([{ op: 'load', handle: 1, key: 'batch' }]);
    h.tick(5);
    expect(h.seen.states.every((s) => s.state === 'loading')).toBe(true);
    const before = h.seen.states.length;
    expect(h.rt.queueAssetAnswer!({ handle: 1, ok: true, assets: ['tex-b', 'tex-a'] }).ok).toBe(true);
    h.tick(1);
    // The script sees ready in the very step the answer rode on, with the ids (sorted).
    expect(h.seen.states[before]).toMatchObject({ state: 'ready', ids: ['tex-a', 'tex-b'] });
    h.tick(4);
    expect(h.rt.takeAssetRequests!()).toEqual([{ op: 'release', handle: 1 }]);
    // Released: unknown to the script, and a late second answer changes nothing.
    expect(h.seen.states.at(-1)!.state).toBeNull();
    expect(h.rt.queueAssetAnswer!({ handle: 1, ok: true, assets: ['tex-a'] }).ok).toBe(true);
    h.tick(2);
    expect(h.seen.states.at(-1)!.state).toBeNull();
  });

  it('a failed load is failed with its reason (and logged); a bad key gets no handle', () => {
    const h = harness('missing-label');
    h.tick(2);
    h.rt.queueAssetAnswer!({ handle: 1, ok: false, message: 'nothing in this build is named "missing-label"' });
    h.tick(1);
    expect(h.seen.states.at(-1)).toMatchObject({ state: 'failed', error: 'nothing in this build is named "missing-label"' });
    expect(h.logs().some((m) => m.includes('missing-label'))).toBe(true);
    const bad = harness('');
    bad.tick(2);
    expect(bad.seen.handle).toBe(0);
    expect(bad.rt.takeAssetRequests!()).toEqual([]);
  });

  it('a run that ends with a handle open releases it and reports it', () => {
    const h = harness('batch');
    h.tick(2);
    h.rt.takeAssetRequests!();
    h.rt.queueAssetAnswer!({ handle: 1, ok: true, assets: ['tex-a'] });
    h.tick(2);
    expect(h.rt.queueUiEvent!({ kind: 'restart', doc: '', widget: '', name: '' }).ok).toBe(true);
    h.tick(2);
    const reqs = h.rt.takeAssetRequests!();
    expect(reqs[0]).toEqual({ op: 'release', handle: 1, runEnded: true });
    expect(h.logs().some((m) => m.includes('not released when the run ended') && m.includes('"batch"'))).toBe(true);
  });

  it('a recorded input replays its answers at their steps and takes no live answer on top', () => {
    // The live run: the answer arrived at step 30.
    const recording: ActionFrame[] = [{ stepIndex: 30, assets: [{ handle: 1, ok: true, assets: ['tex-a'] }] }];
    const seenAt = (answerLive: 'early' | 'late' | 'never'): number => {
      const h = harness('batch', { actions: createRecordedActionSource(recording) });
      for (let i = 0; i < 60; i += 1) {
        // The replay's own host answers at another time: it is not taken (the recording has the answer).
        if ((answerLive === 'early' && i === 3) || (answerLive === 'late' && i === 45)) h.rt.queueAssetAnswer!({ handle: 1, ok: true, assets: ['tex-a'] });
        h.tick(1);
      }
      return h.seen.states.find((s) => s.state === 'ready')!.step;
    };
    expect(seenAt('never')).toBe(30);
    expect(seenAt('early')).toBe(30);
    expect(seenAt('late')).toBe(30);
  });
});
