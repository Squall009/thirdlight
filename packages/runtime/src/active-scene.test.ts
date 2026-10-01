/**
 * The active scene: with several scenes loaded, the active scene's look is
 * the base look. The first start scene is active; `ctx.scenes.setActive`
 * changes it (its look blending in over `blend` seconds, whole steps); a
 * transition that unloads the active scene makes its own scene active over
 * the transition's fade; unloading the active scene otherwise makes the first
 * scene still loaded active at once. All of it is simulation state (the
 * digest, saves), absent until the active scene first changes, and a restart
 * starts over from the first start scene with no preset.
 */
import { describe, expect, it } from 'vitest';

import { EnvironmentDirector } from './environment-director';
import {
  createBehaviorModuleSpec,
  createSimulationRegistry,
  instantiateRuntime,
  neutralFrame,
  registerSimulationModule,
  type BehaviorArtifact,
  type Runtime,
} from './index';

const DT = 1 / 120;
const DECL = { properties: [] } as never;
const T = { rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const at = (x: number, y: number, z = 0): unknown => ({ position: [x, y, z], ...T });

interface Ctx {
  scenes: {
    load(id: string, o?: unknown): void;
    unload(id: string): void;
    active(): string | null;
    setActive(id: string, o?: unknown): void;
  };
  environment?: { set(id: string, o?: unknown): boolean };
}

function artifact(step: (ctx: Ctx) => void): BehaviorArtifact {
  return {
    behaviorId: 'director',
    sourceDigest: 'a'.repeat(64),
    manifestDigest: 'b'.repeat(64),
    outputDigest: 'c'.repeat(64),
    ownedTransforms: [],
    requiredModules: [],
    enginePins: [],
    namespace: { default: { instantiate: () => ({}), step: (_s: unknown, ctx: never) => step(ctx as unknown as Ctx), dispose: () => undefined } },
  };
}

/** Start scenes scene-main (camera, the director) and scene-a; scene-b loads on demand. */
function harness(script: (ctx: Ctx) => void) {
  const main = [
    { id: 'cam-main', components: { transform: at(0, 4, 12), camera: { type: 'perspective', fovY: 45, near: 0.1, far: 100 } } },
    { id: 'box-director', components: { transform: at(0, -5), box: { size: [1, 1, 1], material: { color: '#ffffff' } }, behavior: { behaviorId: 'director', values: {} } } },
  ];
  const sceneA = [{ id: 'box-a', components: { transform: at(0, 0), box: { size: [10, 1, 1], material: { color: '#aa3333' } } } }];
  const sceneB = [{ id: 'box-b', components: { transform: at(40, 0), box: { size: [10, 1, 1], material: { color: '#33aa33' } } } }];
  const spec = createBehaviorModuleSpec({ declaration: DECL, artifact: artifact(script) });
  const registry = createSimulationRegistry();
  registerSimulationModule(registry, spec.id, spec);
  const now = { t: 0 };
  const res = instantiateRuntime({
    snapshot: {
      snapshotId: 'as-0001@r1',
      projectId: 'as-0001',
      revision: 1,
      scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities: [...main, ...sceneA] },
      scenes: [
        { sceneId: 'scene-main', start: true, entityIds: main.map((e) => e.id) },
        { sceneId: 'scene-a', start: true, entityIds: ['box-a'] },
        { sceneId: 'scene-b', start: false },
      ],
      environmentPresets: ['night'],
    },
    registry,
    modules: [spec.id],
    actions: { sample: (i: number) => neutralFrame(i) },
    settings: {},
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
  const serve = (): void => {
    for (const r of rt.takeSceneRequests!()) rt.provideScene!(r.sceneId, { ok: true, entities: sceneB as never });
  };
  const view = () => rt.readEnvironmentBlend!();
  return { rt, tick, serve, view };
}

describe('the active scene', () => {
  it('is the first start scene, reported nowhere until it changes; setActive changes it at once or over a blend', () => {
    let ask: ((ctx: Ctx) => void) | null = null;
    const seen: (string | null)[] = [];
    const h = harness((ctx) => {
      seen.push(ctx.scenes.active());
      ask?.(ctx);
      ask = null;
    });
    h.tick(2);
    expect(seen[seen.length - 1]).toBe('scene-main');
    expect(h.view()).toBeNull();
    expect(h.rt.environmentState!()).toBeNull();

    ask = (ctx) => ctx.scenes.setActive('scene-a');
    h.tick(2);
    expect(seen[seen.length - 1]).toBe('scene-a');
    expect(h.view()?.scene).toEqual({ active: 'scene-a', from: null, weight: 1 });
    // The presets were never used: the base weight alone.
    expect(h.view()?.weights).toEqual([['', 1]]);
    const digest = h.rt.environmentState!();
    expect(digest).toContain('scene-a');

    // Back to scene-main over half a second (60 steps), eased in: the share grows step by step.
    ask = (ctx) => ctx.scenes.setActive('scene-main', { blend: 0.5, easing: 'easeIn' });
    h.tick();
    const shares: number[] = [];
    for (let i = 0; i < 60; i += 1) {
      h.tick();
      const s = h.view()!.scene!;
      expect(s.active).toBe('scene-main');
      shares.push(s.weight);
    }
    expect(h.view()!.scene!.from).toBe('scene-a');
    expect(shares[0]!).toBeLessThan(0.01);
    expect(shares[29]!).toBeGreaterThan(0.2);
    expect(shares[29]!).toBeLessThan(0.3); // easeIn at half way: 0.25
    expect(shares.every((w, i) => i === 0 || w >= shares[i - 1]!)).toBe(true);
    h.tick(2);
    expect(h.view()!.scene).toEqual({ active: 'scene-main', from: null, weight: 1 });
  });

  it('refuses a scene that is not loaded and options out of range, naming why', () => {
    const errors: string[] = [];
    let ask: ((ctx: Ctx) => void) | null = (ctx) => {
      for (const call of [() => ctx.scenes.setActive('scene-b'), () => ctx.scenes.setActive('nope'), () => ctx.scenes.setActive('scene-a', { blend: 601 }), () => ctx.scenes.setActive('scene-a', { easing: 'bounce' })]) {
        try {
          call();
          errors.push('accepted');
        } catch (e) {
          errors.push(String((e as Error).message));
        }
      }
    };
    const h = harness((ctx) => {
      ask?.(ctx);
      ask = null;
    });
    h.tick(2);
    expect(errors[0]).toContain('"scene-b" is not loaded');
    expect(errors[1]).toContain('"nope" is not loaded');
    expect(errors[2]).toContain('blend is 0–600 seconds');
    expect(errors[3]).toContain('easing is one of');
    expect(h.view()).toBeNull();
  });

  it("a transition that unloads the active scene makes its scene active over the fade; a plain unload of the active scene falls back to the first loaded one", () => {
    let ask: ((ctx: Ctx) => void) | null = (ctx) => ctx.scenes.setActive('scene-a');
    const h = harness((ctx) => {
      ask?.(ctx);
      ask = null;
    });
    h.tick(2);
    expect(h.rt.environmentState!()).toContain('scene-a');
    ask = (ctx) => ctx.scenes.load('scene-b', { unload: ['scene-a'], fade: 0.1 });
    h.tick();
    h.serve();
    // The view fades out over 12 steps, then the swap; until then scene-a stays active.
    h.tick(11);
    expect(h.view()!.scene!.active).toBe('scene-a');
    h.tick();
    expect(h.rt.sceneSet!().batches.map((b) => b.sceneId)).toEqual(['scene-main', 'scene-b']);
    expect(h.view()!.scene).toMatchObject({ active: 'scene-b', from: 'scene-a' });
    // Its look blends in over the fade (0.1 s: 12 steps, linear).
    h.tick(6);
    expect(h.view()!.scene!.weight).toBeGreaterThan(0.4);
    expect(h.view()!.scene!.weight).toBeLessThan(0.6);
    h.tick(8);
    expect(h.view()!.scene).toEqual({ active: 'scene-b', from: null, weight: 1 });
    // A plain unload of the active scene: scene-main (the first still loaded) at once.
    ask = (ctx) => ctx.scenes.unload('scene-b');
    h.tick(2);
    expect(h.view()!.scene).toEqual({ active: 'scene-main', from: null, weight: 1 });
  });

  it('a restart starts over from the first start scene and no preset', () => {
    let ask: ((ctx: Ctx) => void) | null = (ctx) => {
      ctx.scenes.setActive('scene-a');
      ctx.environment?.set('night');
    };
    const h = harness((ctx) => {
      ask?.(ctx);
      ask = null;
    });
    h.tick(2);
    expect(h.view()).toMatchObject({ target: 'night', scene: { active: 'scene-a' } });
    expect(h.rt.queueUiEvent!({ kind: 'restart', doc: '', widget: '', name: '' }).ok).toBe(true);
    h.tick(3);
    expect(h.view()).toBeNull();
    expect(h.rt.environmentState!()).toBeNull();
  });
});

describe('the environment director keeps the active scene in its save', () => {
  it('saves and restores it with its blend; a save without one restores the start scene when it is loaded', () => {
    const d = new EnvironmentDirector(60, ['night'], () => undefined, 'scene-main');
    expect(d.saveState()).toBeUndefined();
    d.activate('scene-a', 1);
    for (let i = 0; i < 30; i += 1) d.step();
    const saved = d.saveState()!;
    expect(saved.scene).toEqual({ active: 'scene-a', from: 'scene-main', elapsed: 30, total: 60, easing: 'linear' });
    expect(d.checkState(saved)).toBeNull();
    expect(d.checkState({ ...saved, scene: { ...saved.scene!, total: -1 } })).toContain('environment scene');
    const e = new EnvironmentDirector(60, ['night'], () => undefined, 'scene-main');
    e.restoreState(saved, () => true);
    expect(e.digestText()).toBe(d.digestText());
    expect(e.view(1)!.scene!.weight).toBeCloseTo(0.5, 9);
    // The presets stay unused (only the scene changed).
    expect(e.api.state().target).toBe('');
    // A save whose active scene is not loaded: the look stays.
    const f = new EnvironmentDirector(60, [], () => undefined, 'scene-main');
    f.restoreState(saved, (id) => id !== 'scene-a');
    expect(f.activeScene()).toBe('scene-main');
    // A save without a scene part: the start scene, when loaded.
    e.restoreState(undefined, () => true);
    expect(e.activeScene()).toBe('scene-main');
    expect(e.view(1)).toBeNull();
  });
});
