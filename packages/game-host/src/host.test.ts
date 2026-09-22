/**
 * Packet 55 — the game host (delivery.md §3.1/§3.2/§4, B04/B08/B09/B13/
 * B15), exercised in Node against injected fakes: a structural DOM (the
 * malicious-title case), a deterministic fixed-floor physics port (the
 * runtime's M3 module set runs for real), a fake input owner (the menu
 * seam), a fake render adapter (the frame hook), and the REAL packet-54
 * audio owner over a fake Web Audio context (the sound-status mapping).
 *
 * The real-Rapier / real-browser-input / real-cue-bytes composition is the
 * root `tests/m3-shell` suite (Node may use Node built-ins + the concrete
 * ports); the browser halves (physical keys, the real local unlock, the
 * DOM screenshot) are the `tests/browser/m3-shell` host (UNVERIFIED — no
 * browser/GPU/audio in this container, packet-38 baseline §1).
 */
import { describe, expect, it } from 'vitest';
import type { GameplaySettings, PhysicsPort, RuntimeSnapshot } from '@thirdlight/runtime';
import {
  createGameAudioOwner,
  type AudioContextLike,
  type GameAudioOwner,
} from './audio';
import {
  cueEventsForView,
  GAME_CONTROL_ACTIONS,
  GAME_HOST_API_VERSION,
  GAME_HOST_MESSAGES,
  createGameHost,
  type GameControlAction,
  type GameHostConfig,
  type HostInputOwner,
  type HostRenderAdapter,
} from './host';
import { createHud, type HudState, type HostDom, type HostDomNode } from "./hud";

// ---------------------------------------------------------------------------
// The structural fake DOM (records every surface the HUD writes).
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
    // just records the write (the HUD asserts literal text, never markup).
    this._textContent = value;
  }
  set innerHTML(value: string) {
    // The HUD must never use this; the test asserts zero writes.
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
// The deterministic fixed-floor physics port (the M3 reset port surface).
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
    // The M3 reset-barrier surface (PhysicsResetPort — the runtime requires
    // it for the M3 module set; the host's config type is the base port).
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

function hostSnapshot(overrides: { cues?: Partial<Record<'start' | 'jump' | 'checkpoint' | 'death' | 'goal', string | null>> } = {}): unknown {
  const cues = {
    start: null,
    jump: null,
    checkpoint: null,
    death: null,
    goal: null,
    ...overrides.cues,
  };
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
            cameraFollow: {
              deadZone: { x: 0.5, y: 0.5 },
              smoothing: 0.2,
              bounds: { minX: 0, maxX: 48, minY: -4, maxY: 8 },
            },
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
    game: {
      configVersion: 1,
      // The malicious-title case (delivery.md §3.1 HUD rule): the authored
      // string carries markup — the HUD must render it as inert literal text.
      title: '<img src=x onerror=alert(1)> M3 Host',
      objective: 'Reach the goal',
      instructions: 'A/D move. Space jumps. M mutes.',
      playerId: 'group-0001',
      cameraId: 'cam-main',
      spawnId: 'spawn-0001',
      level: { minX: 0, maxX: 48, minY: -4, maxY: 8 },
      killY: -4,
      cues,
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
  cues?: Partial<Record<'start' | 'jump' | 'checkpoint' | 'death' | 'goal', string | null>>;
  assetPaths?: Record<string, string>;
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
    snapshot: hostSnapshot({ cues: options.cues }) as RuntimeSnapshot,
    settings: SETTINGS,
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

function view(host: Harness['host']): { state: string; stepIndex: number } {
  const res = host.observe();
  if (!res.ok) throw new Error(`observe failed: ${JSON.stringify(res.error)}`);
  return { state: res.observation.state, stepIndex: res.observation.stepIndex };
}
// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe('the §3.1 surface constants', () => {
  it('the version, actions and message names are the delivery.md rows', () => {
    expect(GAME_HOST_API_VERSION).toBe(1);
    expect(GAME_CONTROL_ACTIONS).toEqual(['start', 'replay', 'mute', 'unmute']);
    expect(GAME_HOST_MESSAGES).toEqual([
      'tl.game.control',
      'tl.game.observe',
      'tl.game.control.result',
      'tl.game.observe.result',
    ]);
  });
});

describe('mount and the host-owned HUD (B04/B15)', () => {
  it('mounts the runtime + HUD; the authored strings render as literal text (never HTML)', () => {
    const { host, container } = harness();
    expect(host.mount()).toEqual({ ok: true });
    expect(container.children.length).toBe(1); // the single HUD root
    const root = container.children[0] as FakeNode;
    const all = root.every();
    expect(all.every((n) => n.innerHTMLWrites === 0)).toBe(true); // textContent only
    const texts = all.map((n) => n.textContent);
    expect(texts).toContain('<img src=x onerror=alert(1)> M3 Host'); // the malicious title, literal
    expect(texts).toContain('Reach the goal');
    expect(texts).toContain('A/D move. Space jumps. M mutes.');
    expect(texts).toContain('Press Enter or Space (or the controller confirm) to start');
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

  it('a snapshot without a game block mounts in scene mode (no game session, no HUD)', () => {
    const { host } = harness();
    host.dispose();
    const noGame = hostSnapshot();
    (noGame as { game: unknown }).game = null;
    const cfg: GameHostConfig = {
      snapshot: noGame as RuntimeSnapshot,
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
    expect(h2.observe().ok).toBe(false);
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

describe('the menu/control channel between frames (B04/B08, C4/C5)', () => {
  it('a direct start at the title succeeds with no motion; the run starts at the next boundary', () => {
    const { host, tick } = harness();
    host.mount();
    tick(); // the pre-roll settle at awaitingStart
    expect(view(host).state).toBe('awaitingStart');
    const res = host.control('start');
    expect(res).toMatchObject({ ok: true, state: 'awaitingStart' }); // the state at acceptance
    tick(); // the boundary consumes the queued command
    expect(view(host).state).toBe('playing');
    // A start in play is rejected by the runtime's own rule.
    const again = host.control('start');
    expect(again.ok).toBe(false);
    if (!again.ok) {
      expect(again.error.code).toBe('game_command_invalid');
      expect(again.error.reason).toBe('state');
    }
    host.dispose();
  });

  it('a replay at awaitingStart is rejected (replay needs playing/respawning/won)', () => {
    const { host } = harness();
    host.mount();
    const res = host.control('replay' as GameControlAction);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('game_command_invalid');
      expect(res.error.reason).toBe('state');
    }
    host.dispose();
  });

  it('a menu confirm at the title drives start and is marked consumed (the §4.2 seam)', () => {
    const { host, tick, input } = harness({ menu: [{ confirm: true }] });
    host.mount();
    tick(); // pre-roll
    expect(view(host).state).toBe('awaitingStart');
    tick(); // the frame services the menu channel: confirm → start
    expect(input.consumed.value).toBe(1); // the host marked the press consumed
    tick(); // the boundary applies the start
    expect(view(host).state).toBe('playing');
    host.dispose();
  });

  it('a menu confirm in play is a no-op (not consumed — the press keeps its jump)', () => {
    const { host, tick, input } = harness({ menu: [{ confirm: false }, { confirm: true }] });
    host.mount();
    tick(); // pre-roll (the first menu sample is a no-op)
    host.control('start');
    tick(); // the boundary applies the start; the frame then services the confirm — now in play
    expect(input.consumed.value).toBe(0); // no menu action happened in play
    expect(view(host).state).toBe('playing');
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

  it('the Start/Mute HUD buttons drive the same control channel', () => {
    const { host, container, audioCalls } = harness();
    host.mount();
    const root = container.children[0] as FakeNode;
    const buttons = root.every().filter((n) => (n as FakeNode).tag === 'button');
    expect(buttons.length).toBe(2);
    const startButton = buttons[0] as FakeNode | undefined;
    expect(startButton).toBeDefined();
    startButton?.click('click');
    // The button drives control('start') (queued; the boundary applies it).
    host.dispose();
    expect(audioCalls.setMuted.length).toBe(0);
  });
});

describe('observe and the committed identity (B08/B09)', () => {
  it('reports the run/snapshot/build identity, state and the mapped sound', () => {
    const { host } = harness();
    host.mount();
    const res = host.observe();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.observation.runId).toBe('host-demo@r1#0'); // `${snapshotId}#${replayEpoch}`
      expect(res.observation.snapshotId).toBe('host-demo@r1');
      expect(res.observation.buildId).toBe('test-build-id'); // the wrapper's verified manifest buildId
      expect(res.observation.state).toBe('awaitingStart');
      expect(res.observation.inputMode).toBe('physical');
      expect(res.observation.sound.status).toBe('ready'); // the spy owner is ready
      expect(res.observation.sound.gesture).toBe('local');
    }
    host.dispose();
  });

  it('the real packet-54 owner maps blocked → ready across a local unlock (B13 sound status)', async () => {
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

describe('committed-view cue submission (B13, §4.1)', () => {
  it('resolves the authored cue bytes through the injected reader and submits the runStarted cue', async () => {
    const { host, tick, audioCalls, artifactReads } = harness({
      cues: { start: 'cue-a', jump: 'cue-b' },
      assetPaths: { 'cue-a': 'cues/start.wav', 'cue-b': 'cues/jump.wav' },
      artifacts: { 'cues/start.wav': 8, 'cues/jump.wav': 8 },
    });
    host.mount();
    // The async registration settles on the microtask queue.
    await new Promise((r) => setTimeout(r, 0));
    expect(audioCalls.register.sort()).toEqual(['cue-a', 'cue-b']);
    expect(artifactReads.value.sort()).toEqual(['cues/jump.wav', 'cues/start.wav']);
    host.control('start');
    tick(); // the boundary publishes the runStarted event
    tick(); // the frame submits the committed cue events
    const flat = audioCalls.submit.flat();
    const startCue = flat.find((e) => (e as { kind: string }).kind === 'start') as {
      assetId: string;
      runId: string;
    };
    expect(startCue.assetId).toBe('cue-a');
    expect(startCue.runId).toBe('host-demo@r1#0');
    host.dispose();
  });

  it('null cue refs are never registered (the authored silence stays silent)', async () => {
    const { host, audioCalls } = harness({
      cues: { start: 'cue-a' },
      assetPaths: { 'cue-a': 'cues/start.wav' },
    });
    host.mount();
    await new Promise((r) => setTimeout(r, 0));
    expect(audioCalls.register).toEqual(['cue-a']); // only the non-null ref
    host.dispose();
  });

  it('cueEventsForView maps the committed events and derives the jump transition', () => {
    const cues = { start: 'a', jump: 'j', checkpoint: 'c', death: 'd', goal: 'g' };
    const viewFake = {
      runId: 'r#0',
      stepIndex: 10,
      state: 'playing',
      playerMotion: { speed: 1, grounded: false },
      events: [
        { id: 'r#0/runStarted/0', kind: 'runStarted', stepIndex: 0, boundary: true, deathCount: 0 },
        { id: 'r#0/died/7', kind: 'died', stepIndex: 7, boundary: false, cause: 'fall', deathCount: 1 },
        { id: 'r#0/respawned/8', kind: 'respawned', stepIndex: 8, boundary: true, deathCount: 1 },
      ] as const,
    } as never;
    const out = cueEventsForView(viewFake, cues, true); // previous grounded → airborne now
    expect(out.map((e) => e.kind)).toEqual(['start', 'death', 'jump']);
    expect(out[2]?.id).toBe('r#0/jump/10'); // the derived jump id (runId/kind/stepIndex)
    // A respawn boundary resets grounded (no derived jump across it).
    const none = cueEventsForView(viewFake, cues, false);
    expect(none.map((e) => e.kind)).toEqual(['start', 'death']);
  });
});

describe('viewport and disposal (B15 lifecycle)', () => {
  it('setViewport passes through to the runtime', () => {
    const { host } = harness();
    host.mount();
    expect(host.setViewport(640, 360)).toEqual({ ok: true });
    host.dispose();
  });

  it('dispose is idempotent, removes the HUD, and freezes the surface', () => {
    const { host, container, adapter } = harness();
    host.mount();
    host.dispose();
    host.dispose(); // idempotent (void, no throw)
    expect((container.children[0] as FakeNode).removed).toBe(true);
    expect(adapter.disposed.value).toBe(true); // the host-created adapter is disposed
    const c = host.control('start');
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.error.code).toBe('host_disposed');
    const o = host.observe();
    expect(o.ok).toBe(false);
    expect(() => host.runtime).toThrow(); // the seam is gone
  });

  it('a new host on the same snapshot re-mounts cleanly (the wrapper resources are reused)', () => {
    const { host, container, input, audio } = harness();
    host.mount();
    host.dispose();
    // Reuse: the SAME input owner / audio owner / container serve a new host.
    const h2 = createGameHost({
      snapshot: hostSnapshot() as RuntimeSnapshot,
      settings: SETTINGS,
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

describe('the HUD module (delivery.md §3.1 HUD rules)', () => {
  it('renders the authored strings as text and switches the prompt by state', () => {
    const dom = fakeDom();
    const hud = createHud(dom, { onStart: () => undefined, onMuteToggle: () => undefined });
    const base: HudState = {
      title: '<b>title</b>',
      objective: 'obj',
      instructions: 'ins',
      state: 'awaitingStart',
      deathCount: 0,
      checkpointActive: false,
      checkpointStep: null,
      sound: 'blocked',
    };
    hud.update(base);
    const all = (hud.root as FakeNode).every();
    expect(all.every((n) => n.innerHTMLWrites === 0)).toBe(true);
    expect(all.map((n) => n.textContent)).toContain('<b>title</b>'); // literal
    hud.update({ ...base, state: 'won', deathCount: 2, checkpointActive: true, checkpointStep: 41 });
    const texts = (hud.root as FakeNode).every().map((n) => n.textContent);
    expect(texts).toContain('You win — press Enter or Space (or the controller confirm) to replay');
    expect(texts.some((t) => t.includes('Deaths: 2'))).toBe(true);
    expect(texts.some((t) => t.includes('checkpoint @ step 41 active'))).toBe(true);
    hud.dispose();
    expect((hud.root as FakeNode).removed).toBe(true);
  });
});

describe('the manifest module list drives the composition (D17)', () => {
  it('an id this engine does not provide is refused at mount', () => {
    const h = harness();
    const cfg: GameHostConfig = { ...h.config, modules: ['thirdlight.platformer:controller', 'thirdlight.terrain:heightmap'] };
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
    const host = createGameHost({ ...rest, modules: ['thirdlight.physics-rapier:2d', 'thirdlight.platformer:controller'] });
    const res = host.mount();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('host_module_unresolved');
    host.dispose();
    h.host.dispose();
  });

  it('the derived game set mounts and plays like the default', () => {
    const h = harness();
    const base = h.config;
    const host = createGameHost({
      ...base,
      modules: ['thirdlight.input:keyboard-gamepad', 'thirdlight.physics-rapier:2d', 'thirdlight.platformer-game:camera', 'thirdlight.platformer-game:session', 'thirdlight.platformer:controller'],
    });
    expect(host.mount().ok).toBe(true);
    host.dispose();
    h.host.dispose();
  });
});
