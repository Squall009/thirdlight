/**
 * Phase 12 (c) — the runtime scene set: start scenes from the snapshot
 * catalog, loads requested by a script (`ctx.scenes`) and fetched by the host
 * (`takeSceneRequests` / `provideScene`), applied at a step boundary with
 * their colliders, behaviors, tags and zones; unloads releasing all of it;
 * exit zones (load + move the player to a spawn); a replay returning to the
 * start scenes; the `respawn` intent and `ctx.world`.
 *
 * The gameplay/camera modules are test stubs and the physics port records
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
  type SimulationModuleSpec,
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

function recordingPort(log: PortLog): unknown {
  const neutral = { x: 0, y: 0 };
  return {
    stageCharacterMove() {},
    step() {
      return { requested: { ...neutral }, applied: { ...neutral }, position: { x: 0, y: 0 }, grounded: true, supportNormal: { x: 0, y: 1 }, contacts: { ground: true, wall: false, head: false, steepSlope: false }, snapped: false };
    },
    reset() {},
    clearCharacterMotion() {},
    placeCharacter(c: { x: number; y: number }) {
      log.placed.push({ ...c });
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

/** The start scene: camera, player, start spawn, a loader box (behavior), an exit zone far away. */
function mainEntities(exitAt: [number, number]): unknown[] {
  return [
    { id: 'cam-main', components: { transform: at(0, 4, 12), camera: { type: 'perspective', fovY: 45, near: 0.1, far: 100 }, cameraFollow: { deadZone: { x: 0.5, y: 0.5 }, smoothing: 0.2 } } },
    { id: 'player-0001', components: { transform: at(3, 0.91) } },
    { id: 'spawn-0001', components: { transform: at(3, 0.91), playerSpawn: {} } },
    { id: 'box-loader', components: { transform: at(0, -5), box: { size: [1, 1, 1], material: { color: '#ffffff' } }, behavior: { behaviorId: 'loader', values: {} } } },
    { id: 'zone-exit', components: { transform: at(exitAt[0], exitAt[1]), gameZone: { role: 'exit', size: [2, 2], load: ['scene-cave'], spawnId: 'spawn-cave' } } },
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
    game: {
      configVersion: 2,
      title: 'Cave',
      objective: 'Find the cave',
      instructions: 'Walk.',
      playerId: 'player-0001',
      cameraId: 'cam-main',
      spawnId: 'spawn-0001',
      cues: { start: null, jump: null, checkpoint: null, death: null, goal: null },
    },
    tags: [{ name: 'Rock', bit: 0 }],
    scenes: [
      { sceneId: 'scene-main', start: true, entityIds: ['cam-main', 'player-0001', 'spawn-0001', 'box-loader', 'zone-exit'] },
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

const stubGameplay: SimulationModuleSpec = {
  id: 'thirdlight.teststub:gameplay',
  phases: ['gameplay'],
  create: () => ({ transformOwners: [], step() {} }),
};
const stubCamera: SimulationModuleSpec = {
  id: 'thirdlight.teststub:camera',
  phases: ['camera'],
  create: () => ({ transformOwners: ['cam-main'], step() {} }),
};

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
  const specs = [loader, rock, stubGameplay, stubCamera];
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
      if (!r.ok) throw new Error(`tick failed: ${JSON.stringify(r.error)}`);
    }
  };
  /** Serve every pending load request from the cave fixture (the host's job). */
  const serve = (): string[] => {
    const reqs = rt.takeSceneRequests!();
    for (const r of reqs) rt.provideScene!(r.sceneId, { ok: true, entities: caveEntities() as never });
    return reqs.map((r) => r.sceneId);
  };
  const ids = (): string[] => rt.getInterpolatedState().ok ? (rt.getInterpolatedState() as { state: { transforms: { id: string }[] } }).state.transforms.map((t) => t.id) : [];
  const diag = () => (rt.getDiagnostics() as { diagnostics: { errors: { code: string; message: string }[] } }).diagnostics;
  return { rt, log, calls, tick, serve, ids, diag, now };
}

describe('runtime scene set (phase 12 c)', () => {
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

  it('refuses bad requests and keeps the start scene holding the camera and player', () => {
    const h = harness();
    const pinned = h.rt.requestScene!('unload', 'scene-main');
    expect(pinned.ok).toBe(false);
    expect(!pinned.ok && pinned.error.code).toBe('scene_invalid');
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

  it('phase 14.5: a paused game still applies scene loads and unloads (no step runs)', () => {
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

  it('an exit zone loads its scene and moves the player to its spawn; a replay returns to the start scenes', () => {
    // The exit sits on the start spawn, so the player is inside it once the run starts.
    const h = harness({ exitAt: [3, 1] });
    expect(h.rt.gameCommand('start').ok).toBe(true);
    h.tick(2);
    expect(h.rt.sceneSet!().status['scene-cave']).toBe('loading');
    h.serve();
    h.tick(2);
    expect(h.rt.sceneSet!().status['scene-cave']).toBe('loaded');
    expect(h.log.placed.at(-1)).toEqual({ x: 41, y: 1 });
    const player = (h.rt.getInterpolatedState() as { state: { transforms: { id: string; position: number[] }[] } }).state.transforms.find((t) => t.id === 'player-0001');
    expect(player?.position.slice(0, 2)).toEqual([41, 1]);

    expect(h.rt.gameCommand('replay').ok).toBe(true);
    h.tick();
    expect(h.rt.sceneSet!().batches.map((b) => b.sceneId)).toEqual(['scene-main']);
    expect(h.ids()).not.toContain('box-rock');
  });

  it('a script reads transforms through ctx.world and kills the player with a respawn intent', () => {
    let killBelow: number | null = null;
    let seenY: number | undefined;
    const h = harness({
      loader: (ctx) => {
        const p = ctx.world.transform('player-0001');
        seenY = p?.position[1];
        if (killBelow !== null && p !== undefined && (p.position[1] ?? 0) < killBelow) ctx.emit({ kind: 'respawn' });
      },
    });
    expect(h.rt.gameCommand('start').ok).toBe(true);
    h.tick(2);
    expect(seenY).toBeCloseTo(0.91);
    killBelow = 5; // the player is below it: the script kills them
    h.tick();
    const v = h.rt.getGameView();
    expect(v.ok && v.view.state).toBe('respawning');
    expect(v.ok && v.view.deathCount).toBe(1);
  });
});

// Keep the StepContext import used by the type checker (scripts see it through the host).
export type { StepContext };
