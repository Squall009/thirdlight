/**
 * The shell's scene list as a way to change levels is deprecated, through a
 * real runtime with a scene catalog (the host's part, serving scenes, is the
 * test's): `ctx.shell.nextScene()` and the nextScene UI engine action still
 * move along the list (the next entry's scene loads, the previous one
 * unloads), and each writes one Problems line per Play naming the scene API;
 * a new game's move to the first entry writes no nextScene line.
 */
import { describe, expect, it } from 'vitest';

import { createBehaviorModuleSpec, createSimulationRegistry, instantiateRuntime, neutralFrame, registerSimulationModule, type BehaviorArtifact, type Runtime } from './index';

const DT = 1 / 120;
const T = { rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const at = (x: number): { position: number[]; rotation: number[]; scale: number[] } => ({ position: [x, 0, 0], ...T });
const box = { size: [1, 1, 1], material: { color: '#808080' } };

type Shell = { nextScene(): boolean; sceneIndex(): number; sceneCount(): number };

function game(script: (n: number, shell: Shell) => void) {
  let n = 0;
  const artifact: BehaviorArtifact = {
    behaviorId: 'director',
    sourceDigest: 'a'.repeat(64),
    manifestDigest: 'b'.repeat(64),
    outputDigest: 'c'.repeat(64),
    ownedTransforms: [],
    requiredModules: [],
    enginePins: [],
    namespace: {
      default: {
        instantiate: () => ({}),
        step: (_s: unknown, ctx: { phase: string; shell: Shell }) => {
          if (ctx.phase === 'intent') script((n += 1), ctx.shell);
        },
      },
    },
  };
  const spec = createBehaviorModuleSpec({ declaration: { properties: [] } as never, artifact });
  const registry = createSimulationRegistry();
  registerSimulationModule(registry, spec.id, spec);
  const snapshot = {
    snapshotId: 'list-0001@r1',
    projectId: 'list-0001',
    revision: 1,
    scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities: [{ id: 'director', keepLoaded: true, components: { transform: at(0), behavior: { behaviorId: 'director', values: {} } } }] },
    scenes: [
      { sceneId: 'scene-main', start: true },
      { sceneId: 'level-a', start: false },
      { sceneId: 'level-b', start: false },
    ],
    sceneList: [{ scene: 'scene-main' }, { scene: 'level-a' }, { scene: 'level-b' }],
  };
  const now = { t: 0 };
  const res = instantiateRuntime({ snapshot, registry, modules: [spec.id], actions: { sample: (i: number) => neutralFrame(i) }, settings: {}, clock: () => now.t, driver: { kind: 'manual' } } as never);
  if (!res.ok) throw new Error(`instantiate failed: ${JSON.stringify(res.error)}`);
  const rt: Runtime = res.runtime;
  expect(rt.start().ok).toBe(true);
  expect(rt.tick(now.t).ok).toBe(true);
  const tick = (count = 1): void => {
    for (let i = 0; i < count; i += 1) {
      now.t += DT;
      const r = rt.tick(now.t);
      if (!r.ok) throw new Error(`tick failed: ${JSON.stringify(r.error)}`);
      for (const q of rt.takeSceneRequests!()) rt.provideScene!(q.sceneId, { ok: true, entities: [{ id: `crate-${q.sceneId}`, components: { transform: at(5), box } }] as never });
    }
  };
  const loaded = (): string[] => Object.entries(rt.sceneSet!().status).filter(([, s]) => s === 'loaded').map(([id]) => id).sort();
  /** Tick until the script has run its step `step` (ticks and steps are not one to one). */
  const until = (step: number): void => {
    while (n < step) tick();
  };
  return { rt, tick, until, loaded };
}

describe('the scene list move (deprecated)', () => {
  it('ctx.shell still moves along the list and reads it, with one Problems line per Play', () => {
    const reads: number[][] = [];
    const g = game((n, shell) => {
      if (n === 3) reads.push([shell.sceneIndex(), shell.sceneCount(), shell.nextScene() ? 1 : 0]);
      if (n === 100) reads.push([shell.sceneIndex(), shell.nextScene() ? 1 : 0]);
      if (n === 200) reads.push([shell.sceneIndex(), shell.nextScene() ? 1 : 0]);
    });
    g.until(90);
    expect(g.loaded()).toEqual(['level-a', 'scene-main']);
    g.until(190);
    // The previous listed scene unloads (it is not a start scene); the end of the list says false.
    expect(g.loaded()).toEqual(['level-b', 'scene-main']);
    g.until(210);
    expect(reads).toEqual([[0, 3, 1], [1, 1], [2, 0]]);
    const problems = g.rt.takeProblems!();
    expect(problems.map((p) => p.code)).toEqual(['deprecated_shell_scene_list']);
    expect(problems[0]!.message).toContain('ctx.shell.sceneIndex() is deprecated');
    expect(problems[0]!.message).toContain('ctx.scenes.load(next, {unload: [current]})');
    expect(problems[0]!.message).toContain('ctx.scenes.setActive');
  });

  it("the nextScene UI engine action still moves, with one Problems line per Play; a new game's move writes none", () => {
    const g = game(() => {});
    g.tick(2);
    expect(g.rt.queueUiEvent!({ kind: 'scene', doc: '', widget: '', name: 'newGame', value: 0 }).ok).toBe(true);
    g.tick(2);
    expect(g.rt.takeProblems!().map((p) => p.code)).not.toContain('deprecated_next_scene');
    expect(g.rt.queueUiEvent!({ kind: 'scene', doc: '', widget: '', name: 'nextScene', value: 1 }).ok).toBe(true);
    g.tick(4);
    expect(g.loaded()).toEqual(['level-a', 'scene-main']);
    expect(g.rt.queueUiEvent!({ kind: 'scene', doc: '', widget: '', name: 'nextScene', value: 2 }).ok).toBe(true);
    g.tick(4);
    expect(g.loaded()).toEqual(['level-b', 'scene-main']);
    expect(g.rt.listedSceneIndex!()).toBe(2);
    const problems = g.rt.takeProblems!();
    expect(problems.map((p) => p.code)).toEqual(['deprecated_next_scene']);
    expect(problems[0]!.message).toContain("the nextScene engine action is deprecated and will be removed (it moves along the shell's scene list)");
    expect(problems[0]!.message).toContain('loadScene and unloadScene (ctx.scenes.load / unload)');
    expect(problems[0]!.message).toContain('ctx.scenes.setActive');
  });
});
