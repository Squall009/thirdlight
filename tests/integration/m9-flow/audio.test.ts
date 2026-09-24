/**
 * Phase 9.10: sounds through the production composition — a script's
 * `ctx.audio.play` reaches the audio owner (the host plays it after the
 * step; the simulation never waits), and an audio source's loop gets louder
 * as the player walks towards it (full volume within a quarter of its range,
 * silent beyond it).
 */
import { describe, expect, it } from 'vitest';

import { createGameHost } from '@thirdlight/game-host';
import { createPhysicsPort } from '@thirdlight/physics-rapier';
import { createBehaviorModuleSpec } from '@thirdlight/runtime';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const DT = 1 / 120;
const T = { rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const at = (x: number, y: number, z = 0) => ({ position: [x, y, z], ...T });
const SETTINGS = { run_speed: 5, jump_velocity: 8, gravity_y: -20, max_fall_speed: -20, max_slope_climb_deg: 45, min_slope_slide_deg: 30 };

class FakeNode {
  textContent = '';
  appendChild(): void {}
  remove(): void {}
  setAttribute(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

/** An audio owner that records what the host asks of it. */
function spyAudio() {
  const played: { assetId: string; volume: number }[] = [];
  const loops = new Map<string, { assetId: string | null; gain: number }>();
  const registered: string[] = [];
  const owner: Any = {
    registerCue: (id: string) => {
      registered.push(id);
      return { ok: true };
    },
    submit: () => ({ ok: true }),
    unlock: async () => ({ state: 'ready', muted: false, unlocked: true }),
    setMuted: () => ({ state: 'ready', muted: false, unlocked: true }),
    setHidden: () => ({ state: 'ready', muted: false, unlocked: true }),
    status: () => ({ state: 'ready', muted: false, unlocked: true }),
    dispose: () => ({ ok: true }),
    liveVoices: () => 0,
    playSound: (assetId: string, volume: number) => {
      played.push({ assetId, volume });
      return true;
    },
    setLoop: (key: string, assetId: string | null, gain: number) => loops.set(key, { assetId, gain }),
    loops: () => Object.fromEntries([...loops].filter(([, v]) => v.assetId !== null).map(([k, v]) => [k, v.gain])),
  };
  return { owner, played, loops, registered };
}

describe('sounds (real host, Rapier)', () => {
  it('ctx.audio.play reaches the audio owner; an audio source is louder near the player', async () => {
    const entities: Any[] = [
      { id: 'cam-main', components: { transform: at(0, 4, 12), camera: { type: 'perspective', fovY: 45, near: 0.1, far: 200 }, cameraFollow: { deadZone: { x: 0.5, y: 0.5 }, smoothing: 0.2 } } },
      { id: 'player-0001', components: { transform: at(0, 0.91), controller: {}, behavior: { behaviorId: 'beeper', values: { speed: 1 } } } },
      { id: 'spawn-0001', components: { transform: at(0, 0.91), playerSpawn: {} } },
      { id: 'floor-0001', components: { transform: at(10, -0.5), box: { size: [40, 1, 2], material: { color: '#888888' } }, collider: { shape: { type: 'box', hx: 20, hy: 0.5 } } } },
      { id: 'goal-0001', components: { transform: at(28, 1), gameZone: { role: 'goal', size: [1, 2] } } },
      { id: 'brook-0001', components: { transform: at(20, 0.5), audioSource: { assetId: 'brook', volume: 0.8, range: 12 } } },
    ];
    const physics = await createPhysicsPort({
      character: { x: 0, y: 0.91 },
      statics: [{ entityId: 'floor-0001', shape: { type: 'box', hx: 20, hy: 0.5 }, position: { x: 10, y: -0.5 }, rotationZ: 0 }],
      solver: { hz: 120, gravityY: SETTINGS.gravity_y },
      controller: { offsetSkin: 0.01, groundSnap: 0.1, maxSlopeClimbRad: Math.PI / 4, minSlopeSlideRad: Math.PI / 6, autostep: false },
    } as Any);
    if (!physics.ok) throw new Error(JSON.stringify(physics.error));
    // A script that beeps once every 60 steps while playing.
    const beeper = createBehaviorModuleSpec({
      declaration: { properties: [{ key: 'speed', label: 'Speed', type: 'number', default: 1, min: 0, max: 10, step: 1 }] } as Any,
      artifact: {
        behaviorId: 'beeper',
        sourceDigest: 'a'.repeat(64),
        manifestDigest: 'b'.repeat(64),
        outputDigest: 'c'.repeat(64),
        ownedTransforms: [],
        requiredModules: [],
        enginePins: [],
        namespace: {
          default: {
            instantiate: () => ({}),
            step: (_s: unknown, ctx: Any) => {
              if (ctx.stepIndex % 60 === 0) ctx.audio?.play('beep', { volume: 0.5 });
            },
          },
        },
      } as Any,
    });
    let move = 0;
    const audio = spyAudio();
    const host = createGameHost({
      snapshot: {
        snapshotId: 'snd@r1',
        projectId: 'snd',
        revision: 1,
        scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities },
        game: { configVersion: 2, title: 'Sounds', objective: 'o', instructions: 'i', playerId: 'player-0001', cameraId: 'cam-main', spawnId: 'spawn-0001', cues: { start: null, jump: null, checkpoint: null, death: null, goal: null } },
      },
      settings: SETTINGS,
      physics: physics.port,
      behaviorModules: [beeper],
      adapter: () => null,
      input: {
        sample: (stepIndex: number) => ({ stepIndex, moveX: move, jump: 'none' }),
        sampleMenu: () => ({ confirm: false, mute: false, confirmNeedsRelease: false }),
        markConfirmConsumed: () => undefined,
        dispose: () => undefined,
      },
      audio: audio.owner,
      readArtifact: async () => new Uint8Array([1]).buffer,
      assetPaths: { beep: 'a/beep', brook: 'a/brook' },
      assetKinds: { beep: 'audio', brook: 'audio' },
      container: new FakeNode(),
      buildId: 'b',
      document: { createElement: () => new FakeNode() },
    } as Any);
    const mounted = host.mount();
    if (!mounted.ok) throw new Error(JSON.stringify(mounted.error));
    const rt: Any = host.runtime;
    let now = 0;
    const tick = (n: number): void => {
      for (let i = 0; i < n; i++) {
        now += DT;
        const r = rt.tick(now);
        if (!r.ok) throw new Error(JSON.stringify(r.error));
      }
    };
    await new Promise((r) => setTimeout(r, 0));
    expect(audio.registered.sort()).toEqual(['beep', 'brook']); // every audio asset, for scripts and sources
    tick(2);
    host.control('start');
    tick(240); // 2 s: the script beeped
    expect(audio.played.length).toBeGreaterThanOrEqual(3);
    expect(audio.played[0]).toEqual({ assetId: 'beep', volume: 0.5 });
    // Standing at x 0, 20 m from the brook (range 12): silent.
    expect(audio.loops.get('brook-0001')!.gain).toBe(0);
    move = 1;
    const gains: number[] = [];
    for (let i = 0; i < 40; i++) {
      tick(12);
      gains.push(audio.loops.get('brook-0001')!.gain);
    }
    // Louder as the player comes near; full volume (0.8) within 3 m.
    expect(Math.max(...gains)).toBeCloseTo(0.8, 5);
    const firstHeard = gains.findIndex((g) => g > 0);
    expect(firstHeard).toBeGreaterThan(0);
    expect(gains[firstHeard + 2]!).toBeGreaterThan(gains[firstHeard]!);
    expect((host.observe() as Any).observation.loops['brook-0001']).toBeGreaterThan(0);
  });
});
