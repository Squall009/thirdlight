/**
 * `ctx.scenes.reload(sceneId)` through a real runtime with a scene catalog
 * (the host's part, serving scenes, is the test's): at the next step boundary
 * the scene's objects are back as authored, the copies its objects spawned
 * are gone, its scripts start over from their reset hook (made again, no leave
 * callbacks), its sounds stop; kept objects, the other scenes, `ctx.save`
 * and the counters stay. The reloadScene UI event does the same for a named
 * or the active scene. A start scene's kept objects survive a reload and an
 * unload/load followed by a run restart. The deprecated run restarts write one
 * problem per kind.
 */
import { describe, expect, it } from 'vitest';

import { createBehaviorModuleSpec, createSimulationRegistry, instantiateRuntime, neutralFrame, registerSimulationModule, type AudioCommand, type BehaviorArtifact, type Runtime } from './index';

const DT = 1 / 120;
const DECL = { properties: [] } as never;
const T = { rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const at = (x: number, y: number, z = 0): { position: number[]; rotation: number[]; scale: number[] } => ({ position: [x, y, z], ...T });
const box = { size: [1, 1, 1], material: { color: '#808080' } };

type Ctx = {
  entityId: string;
  stepIndex: number;
  phase: string;
  audio: { play(id: string, o?: unknown): number };
  scenes: { reload(id: string): void; unload(id: string): void; load(id: string): void };
  spawn(prefab: string, o: unknown): string | null;
  entity(id: string): { set(c: string, v: unknown): { ok: boolean } } | null;
  save: { get(k: string): unknown; set(k: string, v: unknown): boolean };
  game: { add(name: string, n: number): boolean };
  lifecycle: { restart(): boolean };
};

interface Log {
  made: string[];
  disposed: string[];
  destroyed: string[];
  copies: string[];
}

function artifact(behaviorId: string, log: Log, step: (state: Record<string, number>, ctx: Ctx) => void): BehaviorArtifact {
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
        instantiate: (_r: unknown, i: { entityId: string }) => {
          log.made.push(i.entityId);
          return { n: 0 };
        },
        dispose: (_r: unknown, s: Record<string, number>) => void log.disposed.push(`n=${s['n']}`),
        onDestroy: (_s: unknown, ctx: { entityId: string }) => void log.destroyed.push(ctx.entityId),
        step: (s: Record<string, number>, c: unknown) => {
          if ((c as Ctx).phase !== 'intent') return;
          s['n'] = (s['n'] ?? 0) + 1;
          step(s, c as Ctx);
        },
      },
    },
  };
}

/** The level: a crate whose script moves it, spawns a copy, starts two loops (its own, its scene's) and counts. */
const LEVEL = [
  { id: 'crate-level', components: { transform: at(10, 0), box, behavior: { behaviorId: 'level', values: {} } } },
  { id: 'spawn-level', components: { transform: at(12, 0.91), playerSpawn: {} } },
];

function game(opts: { director?: (s: Record<string, number>, ctx: Ctx) => void; playerKept?: boolean } = {}) {
  const log: Log = { made: [], disposed: [], destroyed: [], copies: [] };
  const levelSpec = createBehaviorModuleSpec({
    declaration: DECL,
    artifact: artifact('level', log, (s, ctx) => {
      if (s['n'] !== 3) return;
      ctx.entity('crate-level')!.set('transform', { position: [5, 5, 0] });
      const copy = ctx.spawn('prefab-0001', { position: [20, 0, 0] });
      if (copy !== null) log.copies.push(copy);
      ctx.audio.play('own-loop', { loop: true });
      ctx.audio.play('scene-loop', { loop: true, owner: 'scene' });
      ctx.save.set('reached', true);
      ctx.game.add('tally', 1);
    }),
  });
  const mainSpec = createBehaviorModuleSpec({ declaration: DECL, artifact: artifact('main', log, (s, ctx) => opts.director?.(s, ctx)) });
  const registry = createSimulationRegistry();
  for (const spec of [levelSpec, mainSpec]) registerSimulationModule(registry, spec.id, spec);
  const snapshot = {
    snapshotId: 'reload-0001@r1',
    projectId: 'reload-0001',
    revision: 1,
    scene: {
      schemaVersion: 4,
      sceneId: 'scene-main',
      revision: 1,
      entities: [
        { id: 'cam-main', keepLoaded: true, components: { transform: at(0, 4, 12), virtualCamera: { rig: 'fixed' } } },
        { id: 'player-0001', ...(opts.playerKept === false ? {} : { keepLoaded: true }), components: { transform: at(0, 1), controller: {} } },
        { id: 'lamp-0001', keepLoaded: true, components: { transform: at(-3, 0), box } },
        { id: 'director', components: { transform: at(0, -5), behavior: { behaviorId: 'main', values: {} } } },
      ],
    },
    scenes: [
      { sceneId: 'scene-main', start: true },
      { sceneId: 'level', start: false },
    ],
    prefabs: [{ prefabId: 'prefab-0001', displayName: 'Copy', createdRevision: 1, entityCount: 1, depth: 1, entities: [{ localId: 'root', components: { transform: at(0, 0), box } }] }],
  };
  const now = { t: 0 };
  const res = instantiateRuntime({ snapshot, registry, modules: [levelSpec.id, mainSpec.id], actions: { sample: (i: number) => neutralFrame(i) }, settings: {}, clock: () => now.t, driver: { kind: 'manual' } } as never);
  if (!res.ok) throw new Error(`instantiate failed: ${JSON.stringify(res.error)}`);
  const rt: Runtime = res.runtime;
  expect(rt.start().ok).toBe(true);
  expect(rt.tick(now.t).ok).toBe(true);
  const commands: AudioCommand[] = [];
  const tick = (n = 1): void => {
    for (let i = 0; i < n; i += 1) {
      now.t += DT;
      const r = rt.tick(now.t);
      if (!r.ok) throw new Error(`tick failed: ${JSON.stringify(r.error)}`);
      for (const q of rt.takeSceneRequests!()) rt.provideScene?.(q.sceneId, { ok: true, entities: (q.sceneId === 'level' ? LEVEL : []) as never });
      commands.push(...(rt.takeAudioRequests?.() ?? []));
    }
  };
  const ids = (): string[] => (rt.getInterpolatedState() as { state: { transforms: { id: string }[] } }).state.transforms.map((t) => t.id);
  const positionOf = (id: string): number[] | undefined => (rt.getInterpolatedState() as { state: { transforms: { id: string; position: number[] }[] } }).state.transforms.find((t) => t.id === id)?.position;
  const loops = (): string[] => (((rt.audioState?.() as { voices?: unknown[][] } | null)?.voices ?? []).filter((v) => v[3] === true && v[7] === false).map((v) => String(v[1])));
  const errors = (): { code: string; message: string }[] => ((rt.getDiagnostics() as { diagnostics?: { errors?: { code: string; message: string }[] } }).diagnostics?.errors ?? []);
  return { rt, tick, ids, positionOf, loops, commands, log, errors };
}

describe('scene reload', () => {
  it('puts the scene back as authored at the next boundary; kept objects, other scenes, ctx.save and counters stay', () => {
    const cmd = { reload: false };
    const directorSteps: number[] = [];
    let directorCopy: string | null = null;
    const g = game({
      director: (s, ctx) => {
        directorSteps.push(s['n']!);
        if (s['n'] === 2) directorCopy = ctx.spawn('prefab-0001', { position: [-20, 0, 0] });
        if (s['n'] === 4) ctx.entity('lamp-0001')!.set('transform', { position: [-4, 2, 0] });
        if (cmd.reload) {
          cmd.reload = false;
          ctx.scenes.reload('level');
        }
      },
    });
    g.rt.requestScene!('load', 'level');
    g.tick(8);
    expect(g.rt.sceneSet!().status['level']).toBe('loaded');
    expect(g.positionOf('crate-level')).toEqual([5, 5, 0]);
    expect(g.log.copies).toHaveLength(1);
    expect(g.ids()).toContain(g.log.copies[0]);
    expect(g.loops().sort()).toEqual(['own-loop', 'scene-loop']);
    expect(g.log.made).toEqual(['director', 'crate-level']);

    cmd.reload = true;
    g.tick(1); // the request, committed with its step
    expect(g.positionOf('crate-level')).toEqual([5, 5, 0]);
    g.tick(1); // the boundary: the reload, then the new script's first step
    expect(g.rt.sceneSet!().status['level']).toBe('loaded');
    expect(g.positionOf('crate-level')).toEqual([10, 0, 0]);
    // The level's copy went; the director's (spawned in the scene not reloaded) stays.
    expect(g.ids()).not.toContain(g.log.copies[0]);
    expect(g.ids()).toContain(directorCopy);
    // Its script started over: disposed and made again, no leave callbacks; the director ran on.
    expect(g.log.made).toEqual(['director', 'crate-level', 'crate-level']);
    expect(g.log.disposed).toEqual([expect.stringMatching(/^n=[4-9]$/)]);
    expect(g.log.destroyed).toEqual([]);
    expect(directorSteps).toEqual(directorSteps.map((_, i) => i + 1));
    // Its sounds stopped (the object's and the scene's).
    expect(g.loops()).toEqual([]);
    expect(g.commands.filter((c) => c.op === 'stop')).toHaveLength(2);
    // Kept objects as they were (the lamp where the director put it); ctx.save and the counters kept.
    expect(g.positionOf('lamp-0001')).toEqual([-4, 2, 0]);
    expect(g.ids()).toEqual(expect.arrayContaining(['cam-main', 'player-0001', 'lamp-0001', 'director']));
    expect(g.rt.gameCounters!().counters).toEqual({ tally: 1 });
    // The script runs again as at its start: at its third step it moves, spawns and plays once more.
    g.tick(2);
    expect(g.positionOf('crate-level')).toEqual([5, 5, 0]);
    expect(g.log.copies).toHaveLength(2);
    expect(g.rt.gameCounters!().counters).toEqual({ tally: 2 });
    expect(g.errors()).toEqual([]);
  });

  it('the reloadScene UI event reloads the named scene, or the active one; a scene not loaded loads', () => {
    const g = game();
    // Not loaded: a reload loads it.
    expect(g.rt.queueUiEvent!({ kind: 'reload', doc: '', widget: '', name: '', value: 'level' }).ok).toBe(true);
    g.tick(4);
    expect(g.rt.sceneSet!().status['level']).toBe('loaded');
    g.tick(4);
    expect(g.positionOf('crate-level')).toEqual([5, 5, 0]);
    expect(g.rt.queueUiEvent!({ kind: 'reload', doc: '', widget: '', name: '', value: 'level' }).ok).toBe(true);
    g.tick(2);
    expect(g.positionOf('crate-level')).toEqual([10, 0, 0]);
    expect(g.log.made.filter((x) => x === 'crate-level')).toHaveLength(2);
    // Without a scene: the active one (the start scene) — its script starts over, its kept objects stay.
    expect(g.rt.queueUiEvent!({ kind: 'reload', doc: '', widget: '', name: '' }).ok).toBe(true);
    g.tick(2);
    expect(g.log.made.filter((x) => x === 'director')).toHaveLength(2);
    expect(g.ids()).toEqual(expect.arrayContaining(['cam-main', 'player-0001', 'lamp-0001', 'director', 'crate-level']));
    expect(g.errors()).toEqual([]);
  });

  it("a start scene's kept objects stay through its reload and an unload and load, then a run restart", () => {
    const g = game();
    g.rt.queueUiEvent!({ kind: 'reload', doc: '', widget: '', name: '', value: 'scene-main' });
    g.tick(2);
    g.rt.queueUiEvent!({ kind: 'restart', doc: '', widget: '', name: '' });
    g.tick(2);
    expect(g.ids()).toEqual(expect.arrayContaining(['cam-main', 'player-0001', 'lamp-0001', 'director']));
    // Unloaded (its kept objects stay, scene-less) and loaded again: they belong to it again, so a restart keeps them.
    expect(g.rt.requestScene!('unload', 'scene-main').ok).toBe(true);
    g.tick(2);
    expect(g.ids()).not.toContain('director');
    expect(g.rt.requestScene!('load', 'scene-main').ok).toBe(true);
    g.tick(3);
    expect(g.rt.sceneSet!().status['scene-main']).toBe('loaded');
    g.rt.queueUiEvent!({ kind: 'restart', doc: '', widget: '', name: '' });
    g.tick(2);
    expect(g.ids()).toEqual(expect.arrayContaining(['cam-main', 'player-0001', 'lamp-0001', 'director']));
    expect(g.errors()).toEqual([]);
  });

  it('a scene holding a player that is not kept is not reloaded, nor an unknown one (the UI event logs why)', () => {
    const g = game({ playerKept: false });
    g.rt.queueUiEvent!({ kind: 'reload', doc: '', widget: '', name: '', value: 'scene-main' });
    g.rt.queueUiEvent!({ kind: 'reload', doc: '', widget: '', name: '', value: 'no-such-scene' });
    g.tick(3);
    expect(g.errors().map((e) => e.message)).toEqual([
      'reloadScene: scene "scene-main" holds the player "player-0001", which is not kept loaded (mark it Keep loaded to reload its scene)',
      'reloadScene: unknown scene "no-such-scene"',
    ]);
    expect(g.log.made).toEqual(['director']);
  });

  it('the deprecated run restarts work and write one problem per kind; quitToTitle and a tool restart write none', () => {
    let calls = 0;
    const g = game({
      director: (s, ctx) => {
        if (s['n'] === 2 || s['n'] === 3) {
          calls += 1;
          expect(ctx.lifecycle.restart()).toBe(true);
        }
      },
    });
    g.tick(6);
    // Each call restarted the run (the director started over each time, so it called again).
    expect(calls).toBeGreaterThanOrEqual(2);
    for (const name of ['restartLevel', 'restartLevel', 'newGame', 'quitToTitle', '']) {
      expect(g.rt.queueUiEvent!({ kind: 'restart', doc: '', widget: '', name }).ok).toBe(true);
      g.tick(1);
    }
    const problems = g.rt.takeProblems!();
    expect(problems.map((p) => p.code).sort()).toEqual(['deprecated_lifecycle_restart', 'deprecated_new_game', 'deprecated_restart_level']);
    expect(problems.find((p) => p.code === 'deprecated_restart_level')!.message).toContain('reloadScene');
    expect(problems.find((p) => p.code === 'deprecated_lifecycle_restart')!.message).toContain('ctx.scenes.reload');
    g.rt.queueUiEvent!({ kind: 'restart', doc: '', widget: '', name: 'newGame' });
    g.tick(1);
    expect(g.rt.takeProblems!()).toEqual([]);
  });
});
