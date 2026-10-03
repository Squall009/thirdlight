/**
 * The runtime scene set: start scenes from the snapshot
 * catalog, loads requested by a script (`ctx.scenes`) and fetched by the host
 * (`takeSceneRequests` / `provideScene`), applied at a step boundary with
 * their colliders, behaviors and tags; unloads releasing all of it;
 * scene-transition triggers (load + move the character to a spawn); a
 * restart returning to the start scenes; the `respawn` intent and `ctx.world`.
 *
 * The character is the scene's controller entity; the physics port records
 * the collider calls; the real browser path is covered by the e2e suite.
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
  type StaticColliderSpec,
  type StepContext,
} from './index';

const DT = 1 / 120;
const DECL = { properties: [{ key: 'speed', label: 'Speed', type: 'number', default: 1, min: 0, max: 10, step: 1 }] } as never;
const T = { rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const at = (x: number, y: number, z = 0): unknown => ({ position: [x, y, z], ...T });

interface PortLog {
  added: string[];
  removed: string[];
  placed: { x: number; y: number }[];
}

/** A port that keeps the character where it was last placed (it starts on the start spawn). */
function recordingPort(log: PortLog): unknown {
  const neutral = { x: 0, y: 0 };
  let at = { x: 3, y: 0.91 };
  return {
    stageCharacterMove() {},
    step() {
      return { requested: { ...neutral }, applied: { ...neutral }, position: { ...at }, grounded: true, supportNormal: { x: 0, y: 1 }, contacts: { ground: true, wall: false, head: false, steepSlope: false }, snapped: false };
    },
    reset() {},
    clearCharacterMotion() {},
    placeCharacter(c: { x: number; y: number }) {
      log.placed.push({ ...c });
      at = { x: c.x, y: c.y };
      return { ok: true, supportNormal: { x: 0, y: 1 } };
    },
    characterClearance() {
      return { ok: true, supportNormal: { x: 0, y: 1 } };
    },
    addStaticColliders(specs: readonly StaticColliderSpec[]) {
      log.added.push(...specs.map((s) => s.entityId));
    },
    removeStaticColliders(ids: readonly string[]) {
      log.removed.push(...ids);
    },
    diagnostics() {
      return {};
    },
    dispose() {},
  };
}

/** The start scene: camera, the character (the controller entity), start spawn, a loader box (behavior), a scene-transition trigger far away. */
function mainEntities(exitAt: [number, number]): unknown[] {
  return [
    { id: 'cam-main', components: { transform: at(0, 4, 12), camera: { type: 'perspective', fovY: 45, near: 0.1, far: 100 } } },
    { id: 'player-0001', components: { transform: at(3, 0.91), controller: {} } },
    { id: 'spawn-0001', components: { transform: at(3, 0.91), playerSpawn: {} } },
    { id: 'box-loader', components: { transform: at(0, -5), box: { size: [1, 1, 1], material: { color: '#ffffff' } }, behavior: { behaviorId: 'loader', values: {} } } },
    { id: 'box-exit', components: { transform: at(exitAt[0], exitAt[1]), trigger: { size: [2, 2], signal: 'exit', sceneTransition: { scene: 'scene-cave', spawn: 'spawn-cave' } } } },
  ];
}

/** The cave scene (loaded on demand): a floor collider, a rock with a behavior, a spawn, a tagged box. */
function caveEntities(): unknown[] {
  return [
    { id: 'box-floor', components: { transform: at(40, 0), box: { size: [10, 1, 1], material: { color: '#333333' } }, collider: { shape: { type: 'box', hx: 5, hy: 0.5 } } } },
    { id: 'box-rock', tags: 1, components: { transform: at(42, 1), box: { size: [1, 1, 1], material: { color: '#777777' } }, behavior: { behaviorId: 'rock', values: {} } } },
    { id: 'spawn-cave', components: { transform: at(41, 1), playerSpawn: {} } },
  ];
}

function snapshot(exitAt: [number, number]): unknown {
  return {
    snapshotId: 'cave-0001@r1',
    projectId: 'cave-0001',
    revision: 1,
    scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities: mainEntities(exitAt) },
    tags: [{ name: 'Rock', bit: 0 }],
    scenes: [
      { sceneId: 'scene-main', start: true, entityIds: ['cam-main', 'player-0001', 'spawn-0001', 'box-loader', 'box-exit'] },
      { sceneId: 'scene-cave', start: false },
    ],
  };
}

function artifact(behaviorId: string, step: (state: unknown, ctx: never) => void, calls: string[]): BehaviorArtifact {
  return {
    behaviorId,
    sourceDigest: 'a'.repeat(64),
    manifestDigest: 'b'.repeat(64),
    outputDigest: 'c'.repeat(64),
    ownedTransforms: [],
    requiredModules: [],
    enginePins: [],
    namespace: {
      default: {
        instantiate: (_p: unknown, inst: { entityId: string }) => {
          calls.push(`instantiate ${behaviorId} ${inst.entityId}`);
          return {};
        },
        step,
        dispose: () => calls.push(`dispose ${behaviorId}`),
      },
    },
  };
}

interface ScriptCtx {
  stepIndex: number;
  scenes: { load(id: string, o?: unknown): void; unload(id: string): void; status(id: string): string; loaded(): readonly string[] };
  tags: { query(mask: number): readonly string[]; mask(...n: string[]): number };
  world: { transform(id: string): { position: readonly number[] } | undefined };
  emit(intent: unknown): void;
}

function harness(opts: { exitAt?: [number, number]; loader?: (ctx: ScriptCtx) => void } = {}) {
  const log: PortLog = { added: [], removed: [], placed: [] };
  const calls: string[] = [];
  const loader = createBehaviorModuleSpec({
    declaration: DECL,
    artifact: artifact('loader', (_s, ctx) => opts.loader?.(ctx as unknown as ScriptCtx), calls),
  });
  const rock = createBehaviorModuleSpec({ declaration: DECL, artifact: artifact('rock', () => {}, calls) });
  const specs = [loader, rock];
  const registry = createSimulationRegistry();
  for (const s of specs) registerSimulationModule(registry, s.id, s);
  const now = { t: 0 };
  const res = instantiateRuntime({
    snapshot: snapshot(opts.exitAt ?? [100, 100]),
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
  const tick = (n = 1): void => {
    for (let i = 0; i < n; i += 1) {
      now.t += DT;
      const r = rt.tick(now.t);
      if (!r.ok) throw new Error(`tick failed: ${JSON.stringify(r.error)} ${JSON.stringify((rt.getDiagnostics() as { diagnostics?: { errors?: unknown } }).diagnostics?.errors)}`);
    }
  };
  /** Serve every pending load request from the cave fixture (the host's job). */
  const serve = (): string[] => {
    const reqs = rt.takeSceneRequests!();
    for (const r of reqs) rt.provideScene!(r.sceneId, { ok: true, entities: caveEntities() as never });
    return reqs.map((r) => r.sceneId);
  };
  const serveWith = (entities: unknown[]): string[] => {
    const reqs = rt.takeSceneRequests!();
    for (const r of reqs) rt.provideScene!(r.sceneId, { ok: true, entities: entities as never });
    return reqs.map((r) => r.sceneId);
  };
  const ids = (): string[] => rt.getInterpolatedState().ok ? (rt.getInterpolatedState() as { state: { transforms: { id: string }[] } }).state.transforms.map((t) => t.id) : [];
  const diag = () => (rt.getDiagnostics() as { diagnostics: { errors: { code: string; message: string }[] } }).diagnostics;
  return { rt, log, calls, tick, serve, serveWith, ids, diag, now };
}

describe('runtime scene set', () => {
  it('starts with the start scenes and loads a scene a script asks for, with its colliders, behaviors and tags', () => {
    let want = false;
    const seen: { rocks?: readonly string[]; status?: string } = {};
    const h = harness({
      loader: (ctx) => {
        if (want) {
          ctx.scenes.load('scene-cave');
          want = false;
        }
        seen.status = ctx.scenes.status('scene-cave');
        seen.rocks = ctx.tags.query(ctx.tags.mask('rock'));
      },
    });
    expect(h.rt.sceneSet!().batches.map((b) => b.sceneId)).toEqual(['scene-main']);
    expect(h.rt.sceneSet!().status).toEqual({ 'scene-main': 'loaded', 'scene-cave': 'unloaded' });
    expect(h.calls).toContain('instantiate loader box-loader');

    want = true;
    h.tick();
    expect(h.rt.sceneSet!().status['scene-cave']).toBe('loading');
    expect(h.serve()).toEqual(['scene-cave']);
    expect(h.ids()).not.toContain('box-rock');
    const rev = h.rt.sceneSet!().revision;
    h.tick(); // the boundary applies the load
    expect(h.rt.sceneSet!().revision).toBe(rev + 1);
    expect(h.rt.sceneSet!().status['scene-cave']).toBe('loaded');
    expect(h.ids()).toEqual(expect.arrayContaining(['box-floor', 'box-rock', 'spawn-cave']));
    expect(h.log.added).toEqual(['box-floor']);
    expect(h.calls).toContain('instantiate rock box-rock');
    expect(seen.status).toBe('loaded');
    expect(seen.rocks).toEqual(['box-rock']);

    // Unload from outside (host/MCP): everything of the scene is released.
    expect(h.rt.requestScene!('unload', 'scene-cave').ok).toBe(true);
    h.tick();
    expect(h.rt.sceneSet!().status['scene-cave']).toBe('unloaded');
    expect(h.ids()).not.toContain('box-rock');
    expect(h.log.removed).toEqual(['box-floor']);
    expect(h.calls).toContain('dispose rock');
    h.tick();
    expect(seen.rocks).toEqual([]);
  });

  it('refuses bad requests and keeps the start scene holding a player that is not kept loaded', () => {
    const h = harness();
    const pinned = h.rt.requestScene!('unload', 'scene-main');
    expect(pinned.ok).toBe(false);
    expect(!pinned.ok && pinned.error.code).toBe('scene_invalid');
    expect(!pinned.ok && pinned.error.message).toContain('holds the player "player-0001", which is not kept loaded');
    const unknown = h.rt.requestScene!('load', 'scene-nope');
    expect(!unknown.ok && unknown.error.message).toContain('unknown scene');
    // A failed fetch leaves the scene unloaded and says why in diagnostics.
    expect(h.rt.requestScene!('load', 'scene-cave').ok).toBe(true);
    const [req] = h.rt.takeSceneRequests!();
    h.rt.provideScene!(req!.sceneId, { ok: false, message: 'HTTP 404' });
    expect(h.rt.sceneSet!().status['scene-cave']).toBe('unloaded');
    expect(h.diag().errors.some((e) => e.code === 'scene_load_failed' && e.message.includes('HTTP 404'))).toBe(true);
    // A load offset by `at` moves the scene's root entities.
    expect(h.rt.requestScene!('load', 'scene-cave', { at: [0, 10, 0] }).ok).toBe(true);
    h.serve();
    h.tick();
    const rock = (h.rt.getInterpolatedState() as { state: { transforms: { id: string; position: number[] }[] } }).state.transforms.find((t) => t.id === 'box-rock');
    expect(rock?.position).toEqual([42, 11, 0]);
  });

  it('a later-loaded scene may hold every light kind, and its lights leave with it; a player controller stays refused', () => {
    const h = harness();
    const lights = [
      { id: 'light-sun', components: { transform: at(0, 0), light: { type: 'directional', color: '#ff0000', intensity: 1, direction: [0, -1, 0] } } },
      { id: 'light-fill', components: { transform: at(0, 0), light: { type: 'ambient', color: '#ffffff', intensity: 0.5 } } },
      { id: 'light-sky', components: { transform: at(0, 0), light: { type: 'hemisphere', color: '#ffffff', groundColor: '#444444', intensity: 0.5 } } },
      ...Array.from({ length: 12 }, (_, i) => ({ id: `light-p${i}`, components: { transform: at(i, 2), light: { type: 'point', color: '#ffffff', intensity: 30, range: 8 } } })),
      { id: 'light-spot', components: { transform: at(0, 4), light: { type: 'spot', color: '#ffffff', intensity: 80, direction: [0, -1, 0], cookie: 'tex-cookie' } } },
    ];
    expect(h.rt.requestScene!('load', 'scene-cave').ok).toBe(true);
    h.serveWith([...caveEntities(), ...lights]);
    h.tick();
    expect(h.rt.sceneSet!().status['scene-cave']).toBe('loaded');
    expect(h.ids()).toEqual(expect.arrayContaining(['light-sun', 'light-fill', 'light-sky', 'light-p11', 'light-spot']));
    expect(h.diag().errors.filter((e) => e.code === 'scene_load_failed')).toEqual([]);
    // Its lights do not pin it: it unloads, and they go.
    expect(h.rt.requestScene!('unload', 'scene-cave').ok).toBe(true);
    h.tick();
    expect(h.rt.sceneSet!().status['scene-cave']).toBe('unloaded');
    expect(h.ids()).not.toContain('light-sun');
    // The engine owns the view, so a camera in a scene is just an object: it does not tie its scene to the start set.
    expect(h.rt.requestScene!('load', 'scene-cave').ok).toBe(true);
    h.serveWith([{ id: 'cam-two', components: { transform: at(0, 0), camera: { type: 'perspective', fovY: 45, near: 0.1, far: 100 } } }]);
    h.tick();
    expect(h.rt.sceneSet!().status['scene-cave']).toBe('loaded');
    expect(h.rt.requestScene!('unload', 'scene-cave').ok).toBe(true);
    h.tick();
    expect(h.rt.sceneSet!().status['scene-cave']).toBe('unloaded');
    // The player's body is made when the game starts: a later scene cannot bring a second one.
    expect(h.rt.requestScene!('load', 'scene-cave').ok).toBe(true);
    h.serveWith([{ id: 'player-two', components: { transform: at(0, 0), controller: {} } }]);
    h.tick();
    expect(h.rt.sceneSet!().status['scene-cave']).toBe('unloaded');
    expect(h.diag().errors.some((e) => e.code === 'scene_load_failed' && e.message.includes('"player-two" is a player controller'))).toBe(true);
  });

  it('a paused game still applies scene loads and unloads (no step runs)', () => {
    const h = harness();
    h.rt.setPaused!(true);
    const steps = (h.rt.getDiagnostics() as { diagnostics: { stepIndex?: number } }).diagnostics.stepIndex;
    expect(h.rt.requestScene!('load', 'scene-cave').ok).toBe(true);
    h.serve();
    h.tick();
    expect(h.rt.sceneSet!().status['scene-cave']).toBe('loaded');
    expect(h.ids()).toContain('box-rock');
    expect(h.rt.requestScene!('unload', 'scene-cave').ok).toBe(true);
    h.tick();
    expect(h.rt.sceneSet!().status['scene-cave']).toBe('unloaded');
    expect((h.rt.getDiagnostics() as { diagnostics: { stepIndex?: number } }).diagnostics.stepIndex).toBe(steps);
  });

  it('a scene-transition trigger loads its scene and moves the character to its spawn; a restart returns to the start scenes', () => {
    // The trigger sits on the start spawn, so the character is inside it once the run starts.
    const h = harness({ exitAt: [3, 1] });
    h.tick(2);
    expect(h.rt.sceneSet!().status['scene-cave']).toBe('loading');
    h.serve();
    h.tick(2);
    expect(h.rt.sceneSet!().status['scene-cave']).toBe('loaded');
    expect(h.log.placed.at(-1)).toEqual({ x: 41, y: 1 });
    const player = (h.rt.getInterpolatedState() as { state: { transforms: { id: string; position: number[] }[] } }).state.transforms.find((t) => t.id === 'player-0001');
    expect(player?.position.slice(0, 2)).toEqual([41, 1]);

    // The engine restart (a new run): sampled in the next step, applied at the boundary after it.
    // (The character is back inside the trigger, so the fresh run asks for the cave again — a new request.)
    expect(h.rt.queueUiEvent!({ kind: 'restart', doc: '', widget: '', name: '' }).ok).toBe(true);
    h.tick(2);
    expect(h.rt.sceneSet!().batches.map((b) => b.sceneId)).toEqual(['scene-main']);
    expect(h.log.placed.at(-1)).toEqual({ x: 3, y: 0.91 }); // the character where it started
    expect(h.ids()).not.toContain('box-rock');
  });

  it('a script reads transforms through ctx.world and respawns the character with a respawn intent', () => {
    let killBelow: number | null = null;
    let seenY: number | undefined;
    const h = harness({
      loader: (ctx) => {
        const p = ctx.world.transform('player-0001');
        seenY = p?.position[1];
        if (killBelow !== null && p !== undefined && (p.position[1] ?? 0) < killBelow) ctx.emit({ kind: 'respawn' });
      },
    });
    h.tick(2);
    expect(seenY).toBeCloseTo(0.91);
    expect(h.log.placed).toEqual([]);
    killBelow = 5; // the character is below it: the script respawns them (ctx.lifecycle.respawn)
    h.tick();
    killBelow = null;
    expect(h.log.placed).toEqual([]); // the placement waits for the step boundary
    h.tick();
    expect(h.log.placed).toEqual([{ x: 3, y: 0.91 }]); // at the start spawn
  });
});

// Keep the StepContext import used by the type checker (scripts see it through the host).
export type { StepContext };
