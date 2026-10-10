/**
 * Script sounds have an owner: a sound, stinger or music track a script
 * starts belongs to the script's object (or its scene, or nothing) and
 * stops with its fade-out when that owner leaves the game. Driven through a
 * real runtime with a scene catalog; the host's part (fetching scenes) is
 * played by the test, and what is heard is the intent log's state and
 * commands (the browser path is the e2e suite's).
 */
import { describe, expect, it } from 'vitest';

import { createBehaviorModuleSpec, createSimulationRegistry, instantiateRuntime, neutralFrame, registerSimulationModule, type AudioCommand, type BehaviorArtifact, type Runtime } from './index';

const DT = 1 / 120;
const DECL = { properties: [] } as never;
const T = { rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const at = (x: number, y: number, z = 0): unknown => ({ position: [x, y, z], ...T });
const LEVELS = 20;

type Ctx = {
  entityId: string;
  stepIndex: number;
  audio: {
    play(id: string, o?: unknown): number;
    music(id: string | null, fade?: number, o?: unknown): void;
    musicState(): { owner: string; track: string | null };
    stopAll(bus?: string, fade?: number): number;
  };
  scenes: { load(id: string): void; unload(id: string): void };
};

function artifact(behaviorId: string, step: (state: Record<string, unknown>, ctx: Ctx) => void): BehaviorArtifact {
  return {
    behaviorId,
    sourceDigest: 'a'.repeat(64),
    manifestDigest: 'b'.repeat(64),
    outputDigest: 'c'.repeat(64),
    ownedTransforms: [],
    requiredModules: [],
    enginePins: [],
    namespace: { default: { instantiate: () => ({}), step: (s: Record<string, unknown>, c: unknown) => step(s, c as Ctx) } },
  };
}

/** A level's one object: it runs `level` (its scene is `level-<n>`). */
const levelEntities = (n: number): unknown[] => [{ id: `amb-${n}`, components: { transform: at(n, 0), behavior: { behaviorId: 'level', values: {} } } }];

function game(level: (s: Record<string, unknown>, ctx: Ctx, n: number) => void, main?: (s: Record<string, unknown>, ctx: Ctx) => void) {
  const levelSpec = createBehaviorModuleSpec({ declaration: DECL, artifact: artifact('level', (s, ctx) => level(s, ctx, Number(ctx.entityId.slice(4)))) });
  const mainSpec = createBehaviorModuleSpec({ declaration: DECL, artifact: artifact('main', (s, ctx) => main?.(s, ctx)) });
  const registry = createSimulationRegistry();
  for (const spec of [levelSpec, mainSpec]) registerSimulationModule(registry, spec.id, spec);
  const snapshot = {
    snapshotId: 'sounds-0001@r1',
    projectId: 'sounds-0001',
    revision: 1,
    scene: {
      schemaVersion: 4,
      sceneId: 'scene-main',
      revision: 1,
      entities: [
        { id: 'cam-main', components: { transform: at(0, 4, 12), camera: { type: 'perspective', fovY: 45, near: 0.1, far: 100 } } },
        { id: 'player-0001', components: { transform: at(0, 1), controller: {} } },
        { id: 'director', components: { transform: at(0, -5), behavior: { behaviorId: 'main', values: {} } } },
      ],
    },
    scenes: [
      { sceneId: 'scene-main', start: true, entityIds: ['cam-main', 'player-0001', 'director'] },
      ...Array.from({ length: LEVELS }, (_, i) => ({ sceneId: `level-${i + 1}`, start: false })),
    ],
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
      // The host serves every scene asked for.
      for (const q of rt.takeSceneRequests!()) rt.provideScene?.(q.sceneId, { ok: true, entities: levelEntities(Number(q.sceneId.slice(6))) as never });
      commands.push(...(rt.takeAudioRequests?.() ?? []));
    }
  };
  /** The live voices: [handle, assetId, bus, loop, pitch, pos, volume, stopping]. */
  const voices = (): unknown[][] => ((rt.audioState?.() as { voices?: unknown[][] } | null)?.voices ?? []);
  const loopsPlaying = (): number => voices().filter((v) => v[3] === true && v[7] === false).length;
  return { rt, tick, voices, loopsPlaying, commands };
}

/** Each level starts a loop on its first step, then moves on: loads the next level and unloads its own scene. */
function walk(options: Record<string, unknown>) {
  return (s: Record<string, unknown>, ctx: Ctx, n: number): void => {
    if (s['started'] === undefined) {
      s['started'] = ctx.stepIndex;
      ctx.audio.play('amb-loop', { loop: true, ...options });
      return;
    }
    if (s['left'] === undefined && ctx.stepIndex - Number(s['started']) >= 10) {
      s['left'] = true;
      if (n < LEVELS) ctx.scenes.load(`level-${n + 1}`);
      ctx.scenes.unload(`level-${n}`);
    }
  };
}

function walkAll(g: ReturnType<typeof game>, during?: () => void): void {
  g.rt.requestScene!('load', 'level-1');
  let lastLoaded = false;
  for (let i = 0; i < LEVELS * 20; i += 1) {
    g.tick();
    during?.();
    const last = g.rt.sceneSet!().status[`level-${LEVELS}`];
    if (last === 'loaded') lastLoaded = true;
    else if (lastLoaded && last === 'unloaded') break;
  }
  expect(g.rt.sceneSet!().status[`level-${LEVELS}`]).toBe('unloaded');
}

describe('script sounds have an owner', () => {
  it('20 scenes each starting a loop leave at most one loop playing (the object owns it by default)', () => {
    const g = game(walk({}));
    let most = 0;
    walkAll(g, () => (most = Math.max(most, g.loopsPlaying())));
    // Every level's loop started, and each stopped with its object's scene.
    expect(g.commands.filter((c) => c.op === 'play').length).toBe(LEVELS);
    expect(g.commands.filter((c) => c.op === 'stop').length).toBe(LEVELS);
    expect(most).toBe(1);
    g.tick(2);
    expect(g.voices()).toEqual([]);
  });

  it('a sound owned by nothing plays on: the same walk piles the loops up', () => {
    const g = game(walk({ owner: 'none' }));
    walkAll(g);
    expect(g.loopsPlaying()).toBe(LEVELS);
  });

  it('the owner stops a sound with the play\'s fade-out, and a scene-owned one with its scene', () => {
    const g = game(walk({ owner: 'scene', fadeOut: 0.5 }));
    g.rt.requestScene!('load', 'level-1');
    g.tick(14);
    expect(g.rt.sceneSet!().status['level-1']).toBe('unloaded');
    const stop = g.commands.find((c) => c.op === 'stop');
    expect(stop).toMatchObject({ op: 'stop', fade: 0.5 });
    // Fading out: still a voice (stopping) until the fade ends, then gone.
    expect(g.voices().some((v) => v[0] === (stop as { handle: number }).handle && v[7] === true)).toBe(true);
    g.tick(Math.round(0.5 / DT) + 1);
    expect(g.voices().some((v) => v[0] === (stop as { handle: number }).handle)).toBe(false);
  });

  it('a script\'s music track is released when its owner goes; stopAll stops one bus or everything', () => {
    const seen: { sfxStopped?: number; allStopped?: number } = {};
    const g = game(
      (s, ctx) => {
        if (s['m'] !== undefined) return;
        s['m'] = true;
        ctx.audio.music('level-theme', 0.25);
      },
      (s, ctx) => {
        const k = ((s['k'] as number | undefined) ?? 0) + 1;
        s['k'] = k;
        // The director's sounds: an sfx loop, a ui loop and an sfx loop nobody owns.
        if (k === 1) {
          ctx.audio.play('wind', { loop: true });
          ctx.audio.play('menu-hum', { loop: true, bus: 'ui' });
          ctx.audio.play('river', { loop: true, owner: 'none' });
        }
        if (k === 20) seen.sfxStopped = ctx.audio.stopAll('sfx', 0.1);
        if (k === 60) {
          ctx.audio.music('director-theme', 0.5);
          seen.allStopped = ctx.audio.stopAll();
        }
      },
    );
    g.rt.requestScene!('load', 'level-1');
    g.tick(3);
    const music = (): { op: string; assetId: string | null; release?: true }[] => g.commands.filter((c) => c.op === 'music') as never;
    expect(music()).toEqual([expect.objectContaining({ assetId: 'level-theme', fade: 0.25 })]);
    g.rt.requestScene!('unload', 'level-1');
    g.tick(1);
    expect(music().at(-1)).toMatchObject({ assetId: null, release: true, fade: 0.25 });
    expect(g.voices().map((v) => v[1]).sort()).toEqual(['menu-hum', 'river', 'wind']);

    g.tick(20);
    expect(seen.sfxStopped).toBe(2);
    expect(g.commands.filter((c) => c.op === 'stop').every((c) => (c as { fade: number }).fade === 0.1)).toBe(true);
    g.tick(Math.round(0.1 / DT) + 1);
    expect(g.voices().map((v) => v[1])).toEqual(['menu-hum']);

    g.tick(40);
    expect(seen.allStopped).toBe(1);
    expect(music().at(-1)).toMatchObject({ assetId: null, release: true });
    g.tick(1);
    expect(g.voices()).toEqual([]);
  });

  it('a run restart stops every script sound, whoever owns it', () => {
    const g = game(() => {}, (s, ctx) => {
      if (s['n'] !== undefined) return;
      s['n'] = true;
      ctx.audio.play('wind', { loop: true, owner: 'none' });
      ctx.audio.music('theme');
    });
    g.tick(2);
    expect(g.voices().length).toBe(1);
    expect(g.rt.queueUiEvent!({ kind: 'restart', doc: '', widget: '', name: '' } as never).ok).toBe(true);
    g.tick(2);
    expect(g.commands.some((c) => c.op === 'reset')).toBe(true);
    // The new run's director starts its own loop again, with the first run's handle (1): the host drops every
    // voice on the reset command, which comes before the new play.
    expect(g.voices().length).toBe(1);
    expect(g.voices()[0]![0]).toBe(1);
    const reset = g.commands.findIndex((c) => c.op === 'reset');
    expect(g.commands.map((c) => c.op).lastIndexOf('play')).toBeGreaterThan(reset);
  });
});
