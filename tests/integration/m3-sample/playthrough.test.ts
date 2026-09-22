/**
 * Beacon Reach played start to finish headlessly through the production
 * composition: the real game host, browser input owner (synthetic key and
 * gamepad events), Rapier physics, and the audio owner decoding the sample's
 * WAV cues (fake AudioContext). Jumps are scripted at fixed x windows, so
 * this proves the level is traversable and the game flow/cues are wired —
 * not how it feels to play.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createGameAudioOwner, createGameHost } from '@thirdlight/game-host';
import { attachBrowserInput } from '@thirdlight/input';
import { createPhysicsPort } from '@thirdlight/physics-rapier';

const SAMPLE = resolve(import.meta.dirname, '..', '..', '..', 'samples', 'beacon-reach');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const cap: Any = JSON.parse(readFileSync(join(SAMPLE, 'captured', 'project.json'), 'utf8'));
const DT = 1 / 120;
/** x positions where the scripted player starts a jump (steps and hazards). */
const JUMPS = [5.4, 9.5, 14.8, 27.0, 30.5, 35.4];

class FakeTarget {
  private listeners = new Map<string, Set<(e: Any) => void>>();
  addEventListener(t: string, h: (e: Any) => void): void {
    if (!this.listeners.has(t)) this.listeners.set(t, new Set());
    this.listeners.get(t)!.add(h);
  }
  removeEventListener(t: string, h: (e: Any) => void): void {
    this.listeners.get(t)?.delete(h);
  }
  dispatch(t: string, e: Any = {}): void {
    for (const f of [...(this.listeners.get(t) ?? [])]) f({ type: t, ...e });
  }
}
class FakeNode {
  textContent = '';
  children: Any[] = [];
  appendChild(c: Any): void {
    this.children.push(c);
  }
  remove(): void {}
  setAttribute(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}
function pad(pressed: number[]): Any {
  const s = new Set(pressed);
  const buttons = Array.from({ length: 17 }, (_, i) => ({ pressed: s.has(i), touched: s.has(i), value: s.has(i) ? 1 : 0 }));
  return { id: 'pad', index: 0, mapping: 'standard', connected: true, axes: [0, 0, 0, 0], buttons, timestamp: 0 };
}

async function play(mode: 'keys' | 'pad', jumps: readonly number[]) {
  const target = new FakeTarget();
  const win: Any = new FakeTarget();
  const doc: Any = new FakeTarget();
  win.document = doc;
  let pads: Any[] = [];
  win.navigator = { getGamepads: () => pads };
  win.isSecureContext = true;
  const input = attachBrowserInput(target as Any, { window: win, document: doc, navigator: win.navigator, getGamepads: () => pads } as Any);

  // A fake AudioContext that records which cue (by its WAV duration) started.
  const played: number[] = [];
  const ctx: Any = {
    state: 'suspended',
    resume: async () => {
      ctx.state = 'running';
    },
    suspend: async () => {},
    close: async () => {},
    decodeAudioData: async (b: ArrayBuffer) => {
      const v = new DataView(b);
      return { duration: v.getUint32(40, true) / 2 / v.getUint32(24, true), length: 1, sampleRate: 48000 };
    },
    createBufferSource: () => {
      const s: Any = {
        buffer: null,
        onended: null,
        connect() {},
        start() {
          played.push(Math.round(s.buffer.duration * 1000));
          setTimeout(() => s.onended?.(), 0);
        },
        stop() {},
      };
      return s;
    },
    createGain: () => ({ gain: { value: 1 }, connect() {} }),
    destination: {},
  };
  const audio = createGameAudioOwner({ contextFactory: () => ctx });

  const statics = cap.scene.entities
    .filter((e: Any) => e.components.collider)
    .map((e: Any) => ({ entityId: e.id, shape: e.components.collider.shape, position: { x: e.components.transform.position[0], y: e.components.transform.position[1] }, rotationZ: 0 }));
  const player = cap.scene.entities.find((e: Any) => e.id === cap.content.game.playerId);
  const physics = await createPhysicsPort({
    character: { x: player.components.transform.position[0], y: player.components.transform.position[1] },
    statics,
    solver: { hz: 120, gravityY: cap.content.settings.gravity_y },
    controller: { offsetSkin: 0.01, groundSnap: 0.1, maxSlopeClimbRad: Math.PI / 4, minSlopeSlideRad: Math.PI / 6, autostep: false },
  } as Any);
  if (!physics.ok) throw new Error(JSON.stringify(physics.error));
  const assetPaths: Record<string, string> = {};
  for (const [kind, id] of Object.entries(cap.content.game.cues)) assetPaths[id as string] = `audio/cue-${kind}.wav`;
  const host = createGameHost({
    snapshot: { snapshotId: `br@r${cap.scene.revision}`, projectId: 'br', revision: cap.scene.revision, scene: cap.scene, game: cap.content.game },
    settings: cap.content.settings,
    physics: physics.port,
    adapter: () => null,
    input,
    audio,
    readArtifact: async (p: string) => new Uint8Array(readFileSync(join(SAMPLE, 'assets', p))).buffer,
    container: new FakeNode(),
    buildId: 'b',
    assetPaths,
    document: { createElement: () => new FakeNode() },
  } as Any);
  const mounted = host.mount();
  if (!mounted.ok) throw new Error(JSON.stringify(mounted.error));
  await new Promise((r) => setTimeout(r, 50)); // cue bytes decode

  let now = 0;
  const tick = (): void => {
    now += DT;
    const r = host.runtime.tick(now);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
  };
  const x = (): number => {
    const s: Any = host.runtime.getInterpolatedState();
    return s.state.transforms.find((t: Any) => t.id === player.id).position[0];
  };
  const obs = (): Any => (host.observe() as Any).observation;
  const key = (code: string, down = true): void =>
    target.dispatch(down ? 'keydown' : 'keyup', { code, target: { tagName: 'CANVAS', isContentEditable: false }, repeat: false });

  tick();
  await audio.unlock();
  // Start from the title screen.
  if (mode === 'keys') {
    key('Enter');
    tick();
    tick();
    key('Enter', false);
  } else {
    pads = [pad([0])];
    tick();
    tick();
    pads = [pad([])];
    tick();
  }

  const done = new Set<number>();
  let hold = 0;
  for (let step = 0; step < 120 * 60; step++) {
    const o = obs();
    if (o.goalReached || o.deathCount >= 1) break;
    const px = x();
    const w = jumps.find((j) => !done.has(j) && px >= j && px < j + 1.5);
    if (w !== undefined) {
      done.add(w);
      hold = 30;
    }
    const jump = hold > 0;
    if (hold > 0) hold--;
    if (mode === 'keys') {
      key('KeyD');
      if (jump && hold === 29) key('Space');
      if (!jump) key('Space', false);
    } else {
      pads = [pad(jump ? [0, 15] : [15])];
    }
    tick();
    if (step % 20 === 0) await new Promise((r) => setTimeout(r, 1));
  }
  // Release all input and let the flow settle (respawn takes a moment).
  key('KeyD', false);
  key('Space', false);
  pads = [pad([])];
  for (let i = 0; i < 240; i++) {
    tick();
    await new Promise((r) => setTimeout(r, 1));
  }
  const result = { ...obs(), x: x(), played };
  host.dispose();
  input.dispose();
  audio.dispose();
  physics.port.dispose();
  return result;
}

const CUE_MS = { start: 180, jump: 140, checkpoint: 220, death: 320, goal: 420 };

describe('Beacon Reach playthrough (headless, production composition)', () => {
  for (const mode of ['keys', 'pad'] as const) {
    it(`${mode}: start → checkpoint → goal, with every cue`, async () => {
      const r = await play(mode, JUMPS);
      expect(r.goalReached).toBe(true);
      expect(r.state).toBe('won');
      expect(r.deathCount).toBe(0);
      expect(r.checkpointId).not.toBeNull();
      for (const ms of [CUE_MS.start, CUE_MS.jump, CUE_MS.checkpoint, CUE_MS.goal]) expect(r.played).toContain(ms);
    }, 60_000);
  }

  it('a missed jump dies on the first hazard and respawns at the start', async () => {
    const r = await play('keys', JUMPS.slice(0, 1));
    expect(r.deathCount).toBe(1);
    expect(r.played).toContain(CUE_MS.death);
    expect(r.x).toBeLessThan(6);
  }, 60_000);
});
