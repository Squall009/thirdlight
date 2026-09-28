/**
 * Phase 25.24e — scene transitions never leave an empty world: a
 * transition's unloads wait for its scene and leave in the step it arrives
 * (one scene set revision), an optional fade runs out before the swap, the
 * loading state is readable by scripts (`ctx.scenes.loading()`,
 * `ctx.scenes.transition()`) and the page (`sceneLoadingView`), and a scene
 * that cannot be read keeps the world it has.
 */
import { describe, expect, it } from 'vitest';

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

function port(): unknown {
  const neutral = { x: 0, y: 0 };
  let p = { x: 3, y: 0.91 };
  return {
    stageCharacterMove() {},
    step() {
      return { requested: { ...neutral }, applied: { ...neutral }, position: { ...p }, grounded: true, supportNormal: { x: 0, y: 1 }, contacts: { ground: true, wall: false, head: false, steepSlope: false }, snapped: false };
    },
    reset() {},
    clearCharacterMotion() {},
    placeCharacter(c: { x: number; y: number }) {
      p = { x: c.x, y: c.y };
      return { ok: true, supportNormal: { x: 0, y: 1 } };
    },
    characterClearance() {
      return { ok: true, supportNormal: { x: 0, y: 1 } };
    },
    addStaticColliders() {},
    removeStaticColliders() {},
    diagnostics() {
      return {};
    },
    dispose() {},
  };
}

interface Ctx {
  scenes: {
    load(id: string, o?: unknown): void;
    loading(): readonly string[];
    transition(): { scene: string; phase: string; fade: number } | null;
  };
}

function artifact(step: (ctx: Ctx) => void): BehaviorArtifact {
  return {
    behaviorId: 'loader',
    sourceDigest: 'a'.repeat(64),
    manifestDigest: 'b'.repeat(64),
    outputDigest: 'c'.repeat(64),
    ownedTransforms: [],
    requiredModules: [],
    enginePins: [],
    namespace: { default: { instantiate: () => ({}), step: (_s: unknown, ctx: never) => step(ctx as unknown as Ctx), dispose: () => undefined } },
  };
}

/** Start scenes: scene-main (camera, the character, a loader box, maybe an exit) and scene-a (a floor); scene-b loads on demand. */
function harness(opts: { script?: (ctx: Ctx) => void; exit?: Record<string, unknown> } = {}) {
  const main = [
    { id: 'cam-main', components: { transform: at(0, 4, 12), camera: { type: 'perspective', fovY: 45, near: 0.1, far: 100 } } },
    { id: 'player-0001', components: { transform: at(3, 0.91), controller: {} } },
    { id: 'spawn-0001', components: { transform: at(3, 0.91), playerSpawn: {} } },
    { id: 'box-loader', components: { transform: at(0, -5), box: { size: [1, 1, 1], material: { color: '#ffffff' } }, behavior: { behaviorId: 'loader', values: {} } } },
    ...(opts.exit !== undefined ? [{ id: 'box-exit', components: { transform: at(3, 1), trigger: { size: [2, 2], signal: 'exit', sceneTransition: opts.exit } } }] : []),
  ];
  const sceneA = [{ id: 'box-a', components: { transform: at(0, 0), box: { size: [10, 1, 1], material: { color: '#aa3333' } } } }];
  const sceneB = [
    { id: 'box-b', components: { transform: at(40, 0), box: { size: [10, 1, 1], material: { color: '#33aa33' } } } },
    { id: 'spawn-b', components: { transform: at(41, 1), playerSpawn: {} } },
  ];
  const spec = createBehaviorModuleSpec({ declaration: DECL, artifact: artifact((ctx) => opts.script?.(ctx)) });
  const registry = createSimulationRegistry();
  registerSimulationModule(registry, spec.id, spec);
  const now = { t: 0 };
  const res = instantiateRuntime({
    snapshot: {
      snapshotId: 'tr-0001@r1',
      projectId: 'tr-0001',
      revision: 1,
      scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities: [...main, ...sceneA] },
      scenes: [
        { sceneId: 'scene-main', start: true, entityIds: main.map((e) => e.id) },
        { sceneId: 'scene-a', start: true, entityIds: ['box-a'] },
        { sceneId: 'scene-b', start: false },
      ],
    },
    registry,
    modules: [spec.id],
    actions: { sample: (i: number) => neutralFrame(i) },
    physics: port() as never,
    settings: {},
    clock: () => now.t,
    driver: { kind: 'manual' },
  } as never);
  if (!res.ok) throw new Error(`instantiate failed: ${JSON.stringify(res.error)}`);
  const rt: Runtime = res.runtime;
  expect(rt.start().ok).toBe(true);
  expect(rt.tick(now.t).ok).toBe(true);
  /** Every revision the scene set went through, with the loaded scenes (an empty world would show as a revision without a or b). */
  const history: { revision: number; loaded: string[] }[] = [];
  const record = (): void => {
    const set = rt.sceneSet!();
    const last = history[history.length - 1];
    if (last === undefined || last.revision !== set.revision) history.push({ revision: set.revision, loaded: set.batches.map((b) => b.sceneId) });
  };
  record();
  const tick = (n = 1): void => {
    for (let i = 0; i < n; i += 1) {
      now.t += DT;
      const r = rt.tick(now.t);
      if (!r.ok) throw new Error(`tick failed: ${JSON.stringify(r.error)}`);
      record();
    }
  };
  const serve = (ok = true): string[] => {
    const reqs = rt.takeSceneRequests!();
    for (const r of reqs) rt.provideScene!(r.sceneId, ok ? { ok: true, entities: sceneB as never } : { ok: false, message: 'read failed' });
    return reqs.map((r) => r.sceneId);
  };
  const loaded = (): string[] => rt.sceneSet!().batches.map((b) => b.sceneId);
  const errors = (): { code: string; message: string }[] => (rt.getDiagnostics() as { diagnostics: { errors: { code: string; message: string }[] } }).diagnostics.errors;
  return { rt, tick, serve, loaded, history, errors };
}

describe('scene transitions (phase 25.24e)', () => {
  it('a load that unloads scenes swaps them in one step boundary once its scene is in (the old world stays until then)', () => {
    let ask = false;
    const seen: { loading?: readonly string[]; transition?: unknown }[] = [];
    const h = harness({
      script: (ctx) => {
        if (ask) {
          ctx.scenes.load('scene-b', { unload: ['scene-a'] });
          ask = false;
        }
        seen.push({ loading: ctx.scenes.loading(), transition: ctx.scenes.transition() });
      },
    });
    ask = true;
    h.tick();
    expect(h.rt.sceneSet!().status['scene-b']).toBe('loading');
    h.tick(3); // the read takes a while: scene-a stays
    expect(h.loaded()).toEqual(['scene-main', 'scene-a']);
    expect(h.rt.sceneLoadingView!()).toEqual({ loading: ['scene-b'], transition: { scene: 'scene-b', phase: 'loading', fade: 1, seconds: 0, color: '#000000', unload: ['scene-a'] }, swap: null });
    expect(seen[seen.length - 1]).toEqual({ loading: ['scene-b'], transition: expect.objectContaining({ scene: 'scene-b', phase: 'loading' }) });
    expect(h.serve()).toEqual(['scene-b']);
    h.tick();
    expect(h.loaded()).toEqual(['scene-main', 'scene-b']);
    // Never a revision with neither: the unload and the load are one revision.
    expect(h.history.map((x) => x.loaded)).toEqual([
      ['scene-main', 'scene-a'],
      ['scene-main', 'scene-b'],
    ]);
    const view = h.rt.sceneLoadingView!();
    expect(view.loading).toEqual([]);
    expect(view.transition).toBeNull();
    expect(view.swap).toEqual({ scene: 'scene-b', revision: h.rt.sceneSet!().revision, seconds: 0, color: '#000000' });
    h.tick();
    expect(seen[seen.length - 1]).toEqual({ loading: [], transition: null });
  });

  it('a fade runs out (in steps) before the swap, even when the scene is in sooner', () => {
    let ask = false;
    const h = harness({
      script: (ctx) => {
        if (ask) ctx.scenes.load('scene-b', { unload: ['scene-a'], fade: 0.1, fadeColor: '#102030' });
        ask = false;
      },
    });
    ask = true;
    h.tick();
    h.serve();
    const fades: number[] = [];
    for (let i = 0; i < 11; i += 1) {
      h.tick();
      const t = h.rt.sceneLoadingView!().transition;
      expect(t?.phase).toBe('out');
      expect(t?.color).toBe('#102030');
      fades.push(t!.fade);
      expect(h.loaded()).toEqual(['scene-main', 'scene-a']);
    }
    expect(fades.every((f, i) => i === 0 || f > fades[i - 1]!)).toBe(true);
    h.tick(); // the 12th step (0.1 s at 120 Hz): faded out, swapped
    expect(h.loaded()).toEqual(['scene-main', 'scene-b']);
    expect(h.rt.sceneLoadingView!().swap).toEqual(expect.objectContaining({ scene: 'scene-b', seconds: 0.1, color: '#102030' }));
  });

  it('a trigger\'s scene transition keeps the scenes it unloads until its scene is in', () => {
    const h = harness({ exit: { scene: 'scene-b', spawn: 'spawn-b', unload: ['scene-a'] } });
    h.tick(2); // the character stands in the exit
    expect(h.rt.sceneSet!().status['scene-b']).toBe('loading');
    h.tick(5);
    expect(h.loaded()).toEqual(['scene-main', 'scene-a']);
    h.serve();
    h.tick(2);
    expect(h.loaded()).toEqual(['scene-main', 'scene-b']);
    expect(h.history.map((x) => x.loaded)).toEqual([
      ['scene-main', 'scene-a'],
      ['scene-main', 'scene-b'],
    ]);
  });

  it('a scene that cannot be read keeps the world it has; bad options are refused', () => {
    let ask: unknown = null;
    const refused: string[] = [];
    const h = harness({
      script: (ctx) => {
        if (ask === null) return;
        try {
          ctx.scenes.load('scene-b', ask);
        } catch (e) {
          refused.push(e instanceof Error ? e.message : String(e));
        }
        ask = null;
      },
    });
    for (const bad of [{ unload: ['scene-b'] }, { unload: ['scene-nope'] }, { fade: 9 }, { fade: -1 }, { fadeColor: 'red' }, { unload: 'scene-a' }]) {
      ask = bad;
      h.tick();
    }
    expect(refused).toHaveLength(6);
    expect(refused[0]).toContain('names the scene it loads');
    ask = { unload: ['scene-a'] };
    h.tick();
    h.serve(false);
    h.tick(2);
    expect(h.loaded()).toEqual(['scene-main', 'scene-a']);
    expect(h.rt.sceneLoadingView!().transition).toBeNull();
    expect(h.errors().some((e) => e.code === 'scene_load_failed')).toBe(true);
  });

  it('a transition to a scene that is already in unloads at once', () => {
    let ask = 0;
    const h = harness({
      script: (ctx) => {
        if (ask === 1) ctx.scenes.load('scene-b');
        if (ask === 2) ctx.scenes.load('scene-b', { unload: ['scene-a'] });
        ask = 0;
      },
    });
    ask = 1;
    h.tick();
    h.serve();
    h.tick();
    expect(h.loaded()).toEqual(['scene-main', 'scene-a', 'scene-b']);
    ask = 2;
    h.tick(2);
    expect(h.loaded()).toEqual(['scene-main', 'scene-b']);
  });
});
