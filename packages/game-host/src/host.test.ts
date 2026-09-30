/**
 * The game host, exercised in Node against injected fakes: a structural DOM, a
 * deterministic fixed-floor physics port (the character controller module
 * runs for real), a fake input owner (the menu seam), a fake render adapter
 * (the frame hook), and the REAL audio owner over a fake Web Audio
 * context (the sound-status mapping). Every game plays as a
 * scene — there is no game session, run state or classic HUD.
 */
import { describe, expect, it } from 'vitest';
import type { GameplaySettings, PhysicsPort, RuntimeSnapshot } from '@thirdlight/runtime';
import {
  createGameAudioOwner,
  type AudioContextLike,
  type GameAudioOwner,
} from './audio';
import {
  GAME_CONTROL_ACTIONS,
  GAME_HOST_API_VERSION,
  GAME_HOST_MESSAGES,
  createGameHost,
  type GameHostConfig,
  type HostInputOwner,
  type HostRenderAdapter,
} from './host';
import type { HostDom, HostDomNode } from './dom';
import { createSettingsStore } from './storage';
// The host imports no module package; like a composition entry,
// the test injects the spec table and names the modules its snapshot references.
import { characterControllerSpec } from '@thirdlight/character';

// ---------------------------------------------------------------------------
// The structural fake DOM (records every surface the overlays write).
// ---------------------------------------------------------------------------

class FakeNode implements HostDomNode {
  tag = 'div';
  children: FakeNode[] = [];
  removed = false;
  innerHTMLWrites = 0;
  private _textContent = '';
  attrs: Record<string, string> = {};
  listeners: Record<string, Set<() => void>> = {};

  get textContent(): string {
    return this._textContent;
  }
  set textContent(value: string) {
    // A real DOM node's `textContent` setter replaces children; the fake
    // just records the write (overlays write literal text, never markup).
    this._textContent = value;
  }
  set innerHTML(value: string) {
    // The host must never use this; the test asserts zero writes.
    void value;
    this.innerHTMLWrites += 1;
  }
  appendChild(child: HostDomNode): void {
    this.children.push(child as FakeNode);
  }
  remove(): void {
    this.removed = true;
  }
  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }
  addEventListener(type: string, handler: () => void): void {
    let set = this.listeners[type];
    if (!set) {
      set = new Set();
      this.listeners[type] = set;
    }
    set.add(handler);
  }
  removeEventListener(type: string, handler: () => void): void {
    this.listeners[type]?.delete(handler);
  }
  /** Walk every node this root owns (for the innerHTML-write audit). */
  every(): FakeNode[] {
    const out: FakeNode[] = [this];
    for (const c of this.children) out.push(...c.every());
    return out;
  }
  click(type: string): void {
    for (const fn of [...(this.listeners[type] ?? [])]) fn();
  }
}

function fakeDom(): HostDom {
  return { createElement: (tag: string): HostDomNode => Object.assign(new FakeNode(), { tag }) };
}

// ---------------------------------------------------------------------------
// The deterministic fixed-floor physics port (with the reset port surface).
// ---------------------------------------------------------------------------

interface FakePhysics {
  port: PhysicsPort;
  /** The committed capsule centre after the last step. */
  position(): { x: number; y: number };
}

function fakePhysics(base: { x: number; y: number }): FakePhysics {
  let off = { x: 0, y: 0 };
  let pending = { x: 0, y: 0 };
  const position = (): { x: number; y: number } => ({
    x: base.x + off.x,
    y: Math.max(base.y, base.y + off.y),
  });
  const port = {
    implementation: 'fake-host-test',
    stageCharacterMove(delta: { x: number; y: number }): void {
      pending.x += delta.x;
      pending.y += delta.y;
    },
    step() {
      const before = position();
      const after = { x: before.x + pending.x, y: Math.max(base.y, before.y + pending.y) };
      const applied = { x: after.x - before.x, y: after.y - before.y };
      off = { x: after.x - base.x, y: after.y - base.y };
      pending = { x: 0, y: 0 };
      return {
        requested: { x: applied.x, y: applied.y },
        applied,
        position: after,
        grounded: true,
        supportNormal: { x: 0, y: 1 },
        contacts: { ground: true, wall: false, head: false, steepSlope: false },
        snapped: false,
      };
    },
    // The reset-barrier surface (PhysicsResetPort — the runtime requires
    // it for the modules it runs; the host's config type is the base port).
    clearCharacterMotion(): void {
      pending = { x: 0, y: 0 };
      off = { x: 0, y: 0 };
    },
    placeCharacter(center: { x: number; y: number }): { ok: boolean; supportNormal: { x: number; y: number } } {
      off = { x: center.x - base.x, y: Math.max(0, center.y - base.y) };
      pending = { x: 0, y: 0 };
      return { ok: true, supportNormal: { x: 0, y: 1 } };
    },
    characterClearance(): { ok: boolean; supportNormal: { x: number; y: number } } {
      return { ok: true, supportNormal: { x: 0, y: 1 } };
    },
    dispose(): void {
      // no-op
    },
  };
  return { position, port: port as unknown as PhysicsPort };
}

// ---------------------------------------------------------------------------
// The v3 snapshot (the m3-gameplay builder pattern, trimmed).
// ---------------------------------------------------------------------------

const T = {
  rotation: [0, 0, 0, 1] as [number, number, number, number],
  scale: [1, 1, 1] as [number, number, number],
};

const MODULE_SPECS = [characterControllerSpec];
/** The manifest modules of the snapshot (a controller entity on the 2D plane). */
const GAME_MODULES = ['thirdlight.input:keyboard-gamepad', 'thirdlight.physics-rapier:2d', 'thirdlight.character:controller'];

function hostSnapshot(): unknown {
  return {
    snapshotId: 'host-demo@r1',
    projectId: 'host-demo',
    revision: 1,
    scene: {
      schemaVersion: 3,
      sceneId: 'scene-main',
      revision: 1,
      entities: [
        {
          id: 'cam-main',
          name: 'Gameplay camera',
          components: {
            transform: { position: [0, 4, 12], ...T },
            camera: { type: 'perspective', fovY: 45, near: 0.1, far: 100 },
          },
        },
        {
          id: 'group-0001',
          name: 'Player',
          components: { transform: { position: [3, 0.9, 0], ...T }, controller: {} },
        },
        {
          id: 'spawn-0001',
          components: { transform: { position: [3, 0.91, 0], ...T }, playerSpawn: {} },
        },
        {
          id: 'static-0001',
          components: {
            transform: { position: [24, -0.25, 0], ...T },
            box: { size: [48, 0.5, 1], material: { color: '#6f6f6f' } },
            collider: { shape: { type: 'box', hx: 24, hy: 0.25 } },
          },
        },
      ],
    },
  };
}

const SETTINGS: GameplaySettings = {
  gravity_y: -19.62,
  run_speed: 4,
  jump_velocity: 7,
  max_fall_speed: -30,
  max_slope_climb_deg: 45,
  min_slope_slide_deg: 30,
};

// ---------------------------------------------------------------------------
// The fake input owner (the menu seam) and the fake render adapter.
// ---------------------------------------------------------------------------

interface FakeInputOptions {
  /** Queue of menu samples (shifted per `sampleMenu` call). */
  menu?: Array<{ confirm?: boolean; mute?: boolean }>;
}

function fakeInput(options: FakeInputOptions = {}): HostInputOwner & {
  consumed: { value: number };
  disposed: { value: boolean };
} {
  const queue = options.menu ?? [];
  const consumed = { value: 0 };
  const disposed = { value: false };
  return {
    sample: (stepIndex: number) => ({ stepIndex, moveX: 0, jump: 'none' as const }),
    sampleMenu: () => {
      const next = queue.shift() ?? { confirm: false, mute: false };
      return {
        confirm: next.confirm === true,
        mute: next.mute === true,
        confirmNeedsRelease: false,
        confirmDevice: null,
        suppressKeyboardJump: false,
        suppressGamepadJump: false,
      };
    },
    markConfirmConsumed: () => {
      consumed.value += 1;
    },
    dispose: () => {
      disposed.value = true;
    },
    consumed,
    disposed,
  };
}

function fakeAdapter(): HostRenderAdapter & { frames: { value: number }; disposed: { value: boolean } } {
  const frames = { value: 0 };
  const disposed = { value: false };
  return {
    renderFrame: () => {
      frames.value += 1;
      return { ok: true as const };
    },
    dispose: () => {
      disposed.value = true;
    },
    frames,
    disposed,
  };
}

// ---------------------------------------------------------------------------
// The harness.
// ---------------------------------------------------------------------------

interface HarnessOptions {
  menu?: Array<{ confirm?: boolean; mute?: boolean }>;
  assetPaths?: Record<string, string>;
  assetKinds?: Record<string, string>;
  /** Bytes the fake readArtifact returns per path. */
  artifacts?: Record<string, number>;
  realAudio?: boolean;
}

interface Harness {
  host: ReturnType<typeof createGameHost>;
  container: FakeNode;
  input: ReturnType<typeof fakeInput>;
  adapter: ReturnType<typeof fakeAdapter>;
  physics: FakePhysics;
  audio: GameAudioOwner;
  audioCalls: { register: string[]; submit: unknown[][]; setMuted: boolean[] };
  artifactReads: { value: string[] };
  tick: (now?: number) => void;
  /** The config the harness built (tests derive variants from it). */
  config: GameHostConfig;
}

function harness(options: HarnessOptions = {}): Harness {
  const container = new FakeNode();
  const dom = fakeDom();
  const input = fakeInput({ menu: options.menu });
  const adapter = fakeAdapter();
  const physics = fakePhysics({ x: 3, y: 0.9 });
  const audioCalls = { register: [] as string[], submit: [] as unknown[][], setMuted: [] as boolean[] };
  const artifactReads = { value: [] as string[] };

  let audio: GameAudioOwner;
  if (options.realAudio === true) {
    const raw = {
      state: 'suspended' as string,
      resume: async () => {
        raw.state = 'running';
      },
      suspend: async () => {
        raw.state = 'suspended';
      },
      decodeAudioData: async (): Promise<never> => {
        throw new Error('the host tests never decode through the real owner');
      },
      createBufferSource: () => ({ buffer: null, onended: null, connect() {}, start() {}, stop() {} }),
      createGain: () => ({ gain: { value: 1 }, connect() {} }),
      destination: { connect() {} },
      close: async () => {
        raw.state = 'closed';
      },
    };
    const ctx = raw as unknown as AudioContextLike;
    audio = createGameAudioOwner({ contextFactory: () => ctx });
  } else {
    audio = {
      registerCue: (assetId: string, bytes: Uint8Array): { ok: true } => {
        void bytes;
        audioCalls.register.push(assetId);
        return { ok: true };
      },
      submit: (events: readonly unknown[]): { ok: true } => {
        audioCalls.submit.push([...(events as readonly unknown[])]);
        return { ok: true };
      },
      unlock: async (): Promise<never> => {
        throw new Error('unused');
      },
      setMuted: (muted: boolean) => {
        audioCalls.setMuted.push(muted);
        return { state: 'ready', muted, unlocked: true };
      },
      setHidden: () => ({ state: 'ready', muted: false, unlocked: true }),
      status: () => ({ state: 'ready', muted: false, unlocked: true }),
      dispose: () => ({ ok: true }),
      diagnostics: () => [],
      liveVoices: () => 0,
    } as unknown as GameAudioOwner;
  }

  const config: GameHostConfig = {
    snapshot: hostSnapshot() as RuntimeSnapshot,
    settings: SETTINGS,
    modules: GAME_MODULES,
    moduleSpecs: MODULE_SPECS,
    physics: physics.port,
    adapter: () => adapter,
    input,
    audio,
    readArtifact: async (path: string) => {
      artifactReads.value.push(path);
      const bytes = options.artifacts?.[path] ?? 4;
      return new Uint8Array(bytes).buffer;
    },
    container,
    buildId: 'test-build-id',
    assetPaths: options.assetPaths,
    ...(options.assetKinds !== undefined ? { assetKinds: options.assetKinds } : {}),
    document: dom,
  };
  const host = createGameHost(config);

  let now = 0;
  const tick = (t?: number): void => {
    const t0 = t ?? now;
    now += 1 / 60;
    const res = host.runtime.tick(t0);
    if (!res.ok) throw new Error(`tick failed: ${JSON.stringify(res.error)}`);
  };
  return { host, container, input, adapter, physics, audio, audioCalls, artifactReads, tick, config };
}

function observed(host: Harness['host']): { state: string; stepIndex: number } {
  const res = host.observe();
  if (!res.ok) throw new Error(`observe failed: ${JSON.stringify(res.error)}`);
  return { state: res.observation.state, stepIndex: res.observation.stepIndex };
}
// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe('the surface constants', () => {
  it('the version, actions and message names are the delivery.md rows', () => {
    expect(GAME_HOST_API_VERSION).toBe(1);
    // No start action: every game plays as a scene, there is no run to start.
    expect(GAME_CONTROL_ACTIONS).toEqual(['replay', 'mute', 'unmute', 'clearSave']);
    expect(GAME_HOST_MESSAGES).toEqual([
      'tl.game.control',
      'tl.game.observe',
      'tl.game.control.result',
      'tl.game.observe.result',
    ]);
  });
});

describe('mount (B04/B15)', () => {
  it('mounts the runtime; a game without project UI adds no overlay and writes no markup', () => {
    const { host, container } = harness();
    expect(host.mount()).toEqual({ ok: true });
    expect(container.children.length).toBe(0);
    expect(container.every().every((n) => n.innerHTMLWrites === 0)).toBe(true);
    host.dispose();
  });

  it('a second mount is rejected (dispose before remounting)', () => {
    const { host } = harness();
    expect(host.mount()).toEqual({ ok: true });
    const again = host.mount();
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe('host_already_mounted');
    host.dispose();
  });

  it('a snapshot with no modules and no adapter mounts and is observed', () => {
    const cfg: GameHostConfig = {
      snapshot: hostSnapshot() as RuntimeSnapshot,
      settings: SETTINGS,
      physics: fakePhysics({ x: 3, y: 0.9 }).port,
      adapter: () => null,
      input: fakeInput(),
      audio: {
        registerCue: () => ({ ok: true }),
        submit: () => ({ ok: true }),
        unlock: async () => ({ state: 'unsupported', reason: 'no_audio_context' }),
        setMuted: () => ({ state: 'unsupported', reason: 'no_audio_context' }),
        setHidden: () => ({ state: 'unsupported', reason: 'no_audio_context' }),
        status: () => ({ state: 'unsupported', reason: 'no_audio_context' }),
        dispose: () => ({ ok: true }),
        diagnostics: () => [],
        liveVoices: () => 0,
      } as unknown as GameAudioOwner,
      readArtifact: async () => new ArrayBuffer(0),
      container: new FakeNode(),
      buildId: 'b',
    };
    const h2 = createGameHost(cfg);
    const res = h2.mount();
    expect(res.ok).toBe(true);
    expect((cfg.container as unknown as FakeNode).children.length).toBe(0);
    const o = h2.observe();
    expect(o.ok).toBe(true);
    if (o.ok) expect(o.observation.sound.status).toBe('unavailable');
    h2.dispose();
  });

  it('a malformed config is rejected at mount with a structured error', () => {
    const bad = createGameHost({
      snapshot: {},
      settings: {},
      physics: {},
      adapter: null,
      input: {},
      audio: {},
      readArtifact: async () => new ArrayBuffer(0),
      container: {},
      buildId: '',
    } as unknown as GameHostConfig);
    const res = bad.mount();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('host_config_invalid');
  });
});

describe('the menu/control channel between frames (B04/B08)', () => {
  it('replay restarts the game: accepted at the current step, applied at the next step', () => {
    const { host, tick } = harness();
    host.mount();
    tick();
    tick();
    const before = observed(host);
    const res = host.control('replay');
    expect(res).toEqual({ ok: true, state: 'running', acceptedAtStep: before.stepIndex });
    tick();
    expect(observed(host).state).toBe('running');
    host.dispose();
  });

  it('a menu confirm is gameplay input: the host never marks it consumed (there is no title or win screen)', () => {
    const { host, tick, input } = harness({ menu: [{ confirm: true }, { confirm: true }] });
    host.mount();
    tick();
    tick();
    expect(input.consumed.value).toBe(0);
    host.dispose();
  });

  it('a menu mute press toggles mute through the audio owner', () => {
    const { host, tick, audioCalls } = harness({ menu: [{ mute: true }] });
    host.mount();
    tick();
    expect(audioCalls.setMuted).toEqual([true]);
    host.dispose();
  });

  it('the player\'s saved bindings reach the input owner and the glyphs, and follow the pad in use', () => {
    const { host: h0, config } = harness();
    h0.dispose();
    const data = new Map<string, string>();
    const storage = { get: (k: string) => data.get(k) ?? null, set: (k: string, v: string) => void data.set(k, v), remove: (k: string) => void data.delete(k) };
    createSettingsStore(storage, 'g').writeBindings('default', { jump: [{ kind: 'key', code: 'KeyK' }, { kind: 'gamepadButton', button: 2 }] });
    const configured: { actions: readonly { name: string; bindings: readonly unknown[] }[] }[] = [];
    let device: 'keyboard' | 'gamepad' = 'keyboard';
    const inputConfig = {
      actions: [
        { name: 'move', type: 'axis1d', map: 'gameplay', bindings: [{ kind: 'keys1d', negative: 'KeyJ', positive: 'KeyL' }] },
        { name: 'jump', type: 'button', map: 'gameplay', bindings: [{ kind: 'key', code: 'Space' }, { kind: 'gamepadButton', button: 0 }] },
      ],
    };
    const host = createGameHost({
      ...config,
      inputConfig,
      saveStorage: storage,
      saveNamespace: 'g',
      input: { ...config.input, configure: (c) => void configured.push(c), activeDevice: () => device },
    });
    expect(host.mount()).toEqual({ ok: true });
    // The saved rebinding reaches the input owner (K, not the project's Space).
    expect(configured).toHaveLength(1);
    expect(configured[0]!.actions.find((a) => a.name === 'jump')!.bindings[0]).toEqual({ kind: 'key', code: 'KeyK' });
    expect(host.bindings!.glyph('jump')?.label).toBe('K');
    device = 'gamepad';
    host.bindings!.tick();
    expect(host.bindings!.glyph('jump')?.label).toBe('X');
    host.dispose();
  });

  it('clearSave forgets the stored settings of this game only', () => {
    const { host: h0, config } = harness();
    h0.dispose();
    const data = new Map<string, string>([['g:bindings:default', '{}'], ['g:shell-settings', '{}'], ['g:project-settings', '{}'], ['other:shell-settings', '{}']]);
    const storage = { get: (k: string) => data.get(k) ?? null, set: (k: string, v: string) => void data.set(k, v), remove: (k: string) => void data.delete(k) };
    const host = createGameHost({ ...config, saveStorage: storage, saveNamespace: 'g' });
    host.mount();
    expect(host.control('clearSave').ok).toBe(true);
    expect([...data.keys()]).toEqual(['other:shell-settings']);
    host.dispose();
  });

  it('mute/unmute route through the injected audio owner', () => {
    const { host, audioCalls } = harness();
    host.mount();
    expect(host.control('mute').ok).toBe(true);
    expect(host.control('unmute').ok).toBe(true);
    expect(audioCalls.setMuted).toEqual([true, false]);
    host.dispose();
  });
});

describe('observe and the identity (B08/B09)', () => {
  it('reports the snapshot/build identity, the play state, the character and the mapped sound', () => {
    const { host, tick } = harness();
    host.mount();
    tick();
    const res = host.observe();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.observation.snapshotId).toBe('host-demo@r1');
      expect(res.observation.buildId).toBe('test-build-id'); // the wrapper's verified manifest buildId
      expect(res.observation.state).toBe('running'); // the generic play state
      expect(res.observation.inputMode).toBe('physical');
      expect(res.observation.sound.status).toBe('ready'); // the spy owner is ready
      expect(res.observation.sound.gesture).toBe('local');
      expect(res.observation.player?.x).toBeCloseTo(3, 6); // the controller entity
      expect(res.observation).not.toHaveProperty('legacy');
    }
    host.dispose();
  });

  it('the real owner maps blocked → ready across a local unlock (B13 sound status)', async () => {
    const { host, audio } = harness({ realAudio: true });
    host.mount();
    const before = host.observe();
    expect(before.ok).toBe(true);
    if (before.ok) {
      expect(before.observation.sound.status).toBe('blocked'); // no local gesture yet
      expect(before.observation.sound.unlocked).toBe(false);
      expect(before.observation.sound.gesture).toBe('none');
    }
    const st = await audio.unlock(); // the local gesture (the wrapper wires it)
    expect(st.state).toBe('ready');
    const after = host.observe();
    if (after.ok) {
      expect(after.observation.sound.status).toBe('ready');
      expect(after.observation.sound.unlocked).toBe(true);
      expect(after.observation.sound.gesture).toBe('local');
    }
    host.dispose();
  });
});

describe('sound files: nothing read at mount', () => {
  it('the mount reads no audio file; the project-wide preloaded files are held for the play after it, the others not', async () => {
    const base = harness({ assetPaths: { 'snd-a': 'audio/a.wav', 'snd-b': 'audio/b.wav' }, assetKinds: { 'snd-a': 'audio', 'snd-b': 'audio' } });
    const holds: [string, string][] = [];
    const audio = { ...base.audio, holdAudio: (id: string, holder: string) => void holds.push([id, holder]), releaseAudio: (holder: string) => void holds.push(['-', holder]) } as unknown as GameAudioOwner;
    let asked = 0;
    const host = createGameHost({
      ...base.config,
      audio,
      projectAudio: async () => {
        asked += 1;
        return [{ assetId: 'snd-a', preload: true }, { assetId: 'snd-b', preload: false }];
      },
    });
    host.mount();
    expect(base.artifactReads.value).toEqual([]);
    await new Promise((r) => setTimeout(r, 0));
    expect(asked).toBe(1);
    expect(holds).toEqual([['snd-a', 'project']]);
    expect(base.artifactReads.value).toEqual([]);
    host.dispose();
    expect(holds.at(-1)).toEqual(['-', 'project']);
  });
});

describe('disposal (B15 lifecycle)', () => {
  it('dispose is idempotent and freezes the surface', () => {
    const { host, adapter } = harness();
    host.mount();
    host.dispose();
    host.dispose(); // idempotent (void, no throw)
    expect(adapter.disposed.value).toBe(true); // the host-created adapter is disposed
    const c = host.control('replay');
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.error.code).toBe('host_disposed');
    const o = host.observe();
    expect(o.ok).toBe(false);
    expect(() => host.runtime).toThrow(); // the seam is gone
  });

  it('dispose stops the loops it started on the wrapper-owned audio owner', () => {
    const base = harness();
    const loops: [string, string | null, number][] = [];
    const snapshot = hostSnapshot() as { scene: { schemaVersion: number; entities: unknown[] } };
    snapshot.scene.schemaVersion = 4;
    snapshot.scene.entities.push({ id: 'brook-0001', components: { transform: { position: [4, 0, 0], ...T }, audioSource: { assetId: 'brook', volume: 1, range: 10 } } });
    const host = createGameHost({
      ...base.config,
      snapshot: snapshot as unknown as RuntimeSnapshot,
      audio: { ...base.audio, setLoop: (key: string, assetId: string | null, gain: number) => void loops.push([key, assetId, gain]), loops: () => ({ 'brook-0001': 1 }) } as GameAudioOwner,
    });
    const mounted = host.mount();
    expect(mounted, JSON.stringify(mounted)).toEqual({ ok: true });
    for (let i = 0; i < 5; i += 1) host.runtime.tick(i / 60);
    // The character is 1 m from the source, inside a quarter of its range: full volume.
    expect(loops.some(([key, asset, gain]) => key === 'brook-0001' && asset === 'brook' && gain === 1)).toBe(true);
    const o = host.observe();
    expect(o.ok && o.observation.loops).toEqual({ 'brook-0001': 1 });
    host.dispose();
    expect(loops[loops.length - 1]).toEqual(['brook-0001', null, 0]);
  });

  it('a new host on the same snapshot re-mounts cleanly (the wrapper resources are reused)', () => {
    const { host, container, input, audio } = harness();
    host.mount();
    host.dispose();
    // Reuse: the SAME input owner / audio owner / container serve a new host.
    const h2 = createGameHost({
      snapshot: hostSnapshot() as RuntimeSnapshot,
      settings: SETTINGS,
      modules: GAME_MODULES,
      moduleSpecs: MODULE_SPECS,
      physics: fakePhysics({ x: 3, y: 0.9 }).port,
      adapter: () => null,
      input,
      audio,
      readArtifact: async () => new ArrayBuffer(0),
      container,
      buildId: 'test-build-id',
      document: fakeDom(),
    });
    expect(h2.mount()).toEqual({ ok: true });
    const o = h2.observe();
    expect(o.ok).toBe(true);
    h2.dispose();
    expect(input.disposed.value).toBe(false); // the host never disposes the wrapper's owner
  });
});

describe('the manifest module list drives the composition', () => {
  it('an id this engine does not provide is refused at mount', () => {
    const h = harness();
    const cfg: GameHostConfig = { ...h.config, modules: ['thirdlight.character:controller', 'thirdlight.terrain:heightmap'] };
    const host = createGameHost(cfg);
    const res = host.mount();
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('host_module_unresolved');
      expect(res.error.message).toContain('thirdlight.terrain:heightmap');
    }
    host.dispose();
    h.host.dispose();
  });

  it('a physics module without an injected physics port is refused', () => {
    const h = harness();
    const base = h.config;
    const { physics: _physics, ...rest } = base;
    void _physics;
    const host = createGameHost({ ...rest, modules: ['thirdlight.physics-rapier:2d', 'thirdlight.character:controller'] });
    const res = host.mount();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('host_module_unresolved');
    host.dispose();
    h.host.dispose();
  });

  it('no module list, no modules — there is no default set (the character stays where it is)', () => {
    const h = harness();
    const { modules: _m, ...rest } = h.config;
    void _m;
    const host = createGameHost({ ...rest, input: { ...rest.input, sample: (stepIndex: number) => ({ stepIndex, moveX: 1, jump: 'none' as const }) } });
    expect(host.mount().ok).toBe(true);
    for (let i = 0; i < 30; i += 1) host.runtime.tick(i / 60);
    const o = host.observe();
    expect(o.ok && o.observation.player?.x).toBe(3);
    host.dispose();
    h.host.dispose();
  });

  it('a manifest module the injected spec table lacks is unresolved', () => {
    const h = harness();
    const { moduleSpecs: _s, ...rest } = h.config;
    void _s;
    const host = createGameHost(rest);
    const res = host.mount();
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('host_module_unresolved');
      expect(res.error.message).toContain('thirdlight.character:controller');
    }
    host.dispose();
    h.host.dispose();
  });

  it('the entity a module needs is its own declaration', () => {
    const h = harness();
    const needy = { ...characterControllerSpec, id: 'test.needs:controller', requiresEntityWith: ['controller'] };
    const snapshot = hostSnapshot() as { scene: { entities: { components: Record<string, unknown> }[] } };
    for (const e of snapshot.scene.entities) delete e.components['controller'];
    const host = createGameHost({ ...h.config, snapshot: snapshot as unknown as RuntimeSnapshot, modules: ['test.needs:controller'], moduleSpecs: [needy] });
    const res = host.mount();
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('host_config_invalid');
      expect(res.error.reason).toBe('controller');
      expect(res.error.message).toContain('test.needs:controller');
    }
    host.dispose();
    h.host.dispose();
    // A scene with no module that needs one mounts without a controller.
    const plain = createGameHost({ ...h.config, snapshot: snapshot as unknown as RuntimeSnapshot, modules: [] });
    expect(plain.mount().ok).toBe(true);
    plain.dispose();
  });
});
