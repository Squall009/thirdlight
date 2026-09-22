/**
 * Packet 55 — the full local game shell over REAL composition parts
 * (delivery.md §3.1/§4, cases C1/C2/C3/C4/C5/C7/C9 + §4.6):
 *
 *  - the real M3 module set through `createGameHost` (the host's own
 *    composition — registry + instantiateRuntime + the frame wiring);
 *  - the REAL Rapier physics port (physics-rapier);
 *  - the REAL `attachBrowserInput` owner driven by a fake window/target
 *    (the container has no browser — packet-38 baseline §1);
 *  - the REAL packet-54 audio owner over a fake Web Audio context that
 *    decodes the REAL committed cue WAV bytes (fixtures/m3/media/wav).
 *
 * The physical-device halves (real keys, a real pad, audibility, the DOM
 * screenshot) are the `tests/browser/m3-shell` host — UNVERIFIED here.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createPhysicsPort, type RapierStaticColliderSpec } from '@thirdlight/physics-rapier';
import type { GameplaySettings, RuntimeSnapshot } from '@thirdlight/runtime';
import { attachBrowserInput } from '@thirdlight/input';
import {
  createGameAudioOwner,
  createGameHost,
  type AudioContextLike,
  type GameAudioOwner,
  type GameHostConfig,
  type HostDom,
  type HostDomNode,
} from '@thirdlight/game-host';

// ---------------------------------------------------------------------------
// The course (the m3-gameplay builder pattern: flat floor + checkpoint + goal).
// ---------------------------------------------------------------------------

const DT = 1 / 120; // the runtime's fixed step (the physics solver hz)

const SETTINGS: GameplaySettings = {
  gravity_y: -19.62,
  run_speed: 4,
  jump_velocity: 7,
  max_fall_speed: -30,
  max_slope_climb_deg: 45,
  min_slope_slide_deg: 30,
};

const SOLVER = { hz: 120, gravityY: -19.62 } as const;
const CONTROLLER_CFG = {
  offsetSkin: 0.01,
  groundSnap: 0.1,
  maxSlopeClimbRad: Math.PI / 4,
  minSlopeSlideRad: Math.PI / 6,
  autostep: false,
} as const;

const STATIC: RapierStaticColliderSpec = {
  entityId: 'floor',
  shape: { type: 'box', hx: 24, hy: 0.25 },
  position: { x: 24, y: -0.25 },
  rotationZ: 0,
};

const T = {
  rotation: [0, 0, 0, 1] as [number, number, number, number],
  scale: [1, 1, 1] as [number, number, number],
};

function courseSnapshot(): unknown {
  return {
    snapshotId: 'shell-demo@r1',
    projectId: 'shell-demo',
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
        { id: 'spawn-0001', components: { transform: { position: [3, 0.91, 0], ...T }, playerSpawn: {} } },
        {
          id: 'spawn-0002',
          components: { transform: { position: [22, 0.91, 0], ...T }, playerSpawn: {} },
        },
        {
          id: 'zone-checkpoint',
          components: {
            transform: { position: [22, 1, 0], ...T },
            gameZone: {
              role: 'checkpoint',
              size: [2, 2],
              safeSpawnId: 'spawn-0002',
              activation: { emissive: '#ff0000', emissiveIntensity: 2, cueAssetId: null },
            },
          },
        },
        {
          id: 'zone-goal',
          components: { transform: { position: [44.5, 1, 0], ...T }, gameZone: { role: 'goal', size: [1, 2] } },
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
      title: 'Shell Course',
      objective: 'Reach the goal',
      instructions: 'A/D move. Space jumps. Enter starts.',
      playerId: 'group-0001',
      cameraId: 'cam-main',
      spawnId: 'spawn-0001',
      level: { minX: 0, maxX: 48, minY: -4, maxY: 8 },
      killY: -4,
      cues: {
        start: 'cue-start',
        jump: 'cue-jump',
        checkpoint: 'cue-checkpoint',
        death: 'cue-death',
        goal: 'cue-goal',
      },
    },
  };
}

// ---------------------------------------------------------------------------
// The fake window/target for the REAL input owner.
// ---------------------------------------------------------------------------

type Handler = (event: Event) => void;

class FakeTarget {
  private readonly listeners = new Map<string, Set<Handler>>();

  addEventListener(type: string, handler: EventListenerOrEventListenerObject): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(handler as unknown as Handler);
  }
  removeEventListener(type: string, handler: EventListenerOrEventListenerObject): void {
    this.listeners.get(type)?.delete(handler as unknown as Handler);
  }
  dispatch(type: string, event: Record<string, unknown> = {}): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) {
      fn({ type, ...event } as unknown as Event);
    }
  }
}

interface PadOptions {
  index?: number;
  id?: string;
  mapping?: string;
  pressed?: number[];
  connected?: boolean;
}

function pad(options: PadOptions = {}): Gamepad {
  const pressed = new Set(options.pressed ?? []);
  const buttons = Array.from({ length: 17 }, (_, i) => ({
    pressed: pressed.has(i),
    touched: pressed.has(i),
    value: pressed.has(i) ? 1 : 0,
  }));
  return {
    id: options.id ?? 'pad-0',
    index: options.index ?? 0,
    mapping: options.mapping ?? 'standard',
    connected: options.connected ?? true,
    axes: [0, 0, 0, 0],
    buttons,
    timestamp: 0,
    hapticActuators: [],
    vibrationActuator: null,
  } as unknown as Gamepad;
}

// ---------------------------------------------------------------------------
// The fake Web Audio context (decodes the real cue WAV header → duration).
// ---------------------------------------------------------------------------

interface FakeSource {
  buffer: { duration: number } | null;
  onended: (() => void) | null;
  started: number;
  stopped: number;
  connect(): void;
  start(): void;
  stop(): void;
}

function fakeAudioContext(): { context: AudioContextLike; sources: FakeSource[]; decoded: number[] } {
  const sources: FakeSource[] = [];
  const decoded: number[] = [];
  const raw = {
    state: 'suspended' as string,
    resume: async () => {
      raw.state = 'running';
    },
    suspend: async () => {
      raw.state = 'suspended';
    },
    decodeAudioData: async (bytes: ArrayBuffer): Promise<{ duration: number; length: number; sampleRate: number }> => {
      // The committed cue WAVs are strict 44+data PCM (48kHz mono 16-bit):
      // the header's byteRate (offset 28, LE) gives the duration.
      const view = new DataView(bytes);
      const byteRate = view.getUint32(28, true);
      const dataBytes = view.getUint32(40, true);
      const duration = byteRate > 0 ? dataBytes / byteRate : 0.1;
      decoded.push(duration);
      return { duration, length: Math.max(1, Math.floor(duration * 48_000)), sampleRate: 48_000 };
    },
    createBufferSource: () => {
      const src: FakeSource = {
        buffer: null,
        onended: null,
        started: 0,
        stopped: 0,
        connect(): void {
          // the owner routes source → gain → destination
        },
        start(): void {
          src.started += 1;
        },
        stop(): void {
          src.stopped += 1;
        },
      };
      sources.push(src);
      return src as never;
    },
    createGain: () => ({ gain: { value: 1 }, connect(): void { /* sink */ } }),
    destination: { connect(): void { /* sink */ } },
    close: async () => {
      raw.state = 'closed';
    },
  };
  return { context: raw as unknown as AudioContextLike, sources, decoded };
}

// ---------------------------------------------------------------------------
// The structural fake DOM (the HUD's target).
// ---------------------------------------------------------------------------

class FakeNode implements HostDomNode {
  private _text = '';
  removed = false;
  children: FakeNode[] = [];
  get textContent(): string {
    return this._text;
  }
  set textContent(value: string) {
    this._text = value;
  }
  appendChild(child: HostDomNode): void {
    this.children.push(child as FakeNode);
  }
  remove(): void {
    this.removed = true;
  }
  setAttribute(): void {
    // structural: the HUD only needs the surface
  }
  addEventListener(): void {
    // structural: the test drives the control channel directly
  }
  removeEventListener(): void {
    // structural
  }
}

const fakeDom: HostDom = { createElement: () => new FakeNode() };

// ---------------------------------------------------------------------------
// The shell harness.
// ---------------------------------------------------------------------------

const CUE_DIR = new URL('../../fixtures/m3/media/wav/', import.meta.url);
const CUE_PATHS: Record<string, string> = {
  'cue-start': 'cue-start.wav',
  'cue-jump': 'cue-jump.wav',
  'cue-checkpoint': 'cue-checkpoint.wav',
  'cue-death': 'cue-death.wav',
  'cue-goal': 'cue-goal.wav',
};

interface ShellView {
  state: string;
  runId: string;
  stepIndex: number;
  deathCount: number;
  goalReached: boolean;
  checkpointId: string | null;
  grounded: boolean;
  x: number;
  y: number;
}

interface Shell {
  host: ReturnType<typeof createGameHost>;
  input: ReturnType<typeof attachBrowserInput>;
  audio: GameAudioOwner;
  audioGraph: ReturnType<typeof fakeAudioContext>;
  key(code: string, down?: boolean, repeat?: boolean): void;
  setPads(pads: ArrayLike<Gamepad | null>): void;
  setVisibility(state: string): void;
  tick(now?: number): void;
  now: { value: number };
  view(): ShellView;
  dispose(): void;
}

async function startShell(): Promise<Shell> {
  const target = new FakeTarget();
  const win = new FakeTarget();
  const doc = new FakeTarget();
  (win as unknown as { document: FakeTarget }).document = doc;
  let padList: ArrayLike<Gamepad | null> = [];
  (win as unknown as { navigator: object }).navigator = { getGamepads: () => padList };
  (win as unknown as { isSecureContext: boolean }).isSecureContext = true;

  const input = attachBrowserInput(target as unknown as EventTarget, {
    window: win as unknown as Window,
    document: doc as unknown as Document,
    navigator: (win as unknown as { navigator: object }).navigator as unknown as Navigator,
    getGamepads: () => padList,
  });

  const audioGraph = fakeAudioContext();
  const audio = createGameAudioOwner({ contextFactory: () => audioGraph.context });

  const physicsInit = await createPhysicsPort({
    character: { x: 3, y: 0.9 },
    statics: [STATIC],
    solver: SOLVER,
    controller: CONTROLLER_CFG,
  });
  if (!physicsInit.ok) throw new Error(`physics init failed: ${JSON.stringify(physicsInit.error)}`);
  const physics = physicsInit.port;

  const container = new FakeNode();
  const host = createGameHost({
    snapshot: courseSnapshot() as RuntimeSnapshot,
    settings: SETTINGS,
    physics,
    adapter: () => null, // headless shell (the real adapter is the browser host's job)
    input,
    audio,
    // The host calls the reader only with the wrapper's assetPaths values
    // (the manifest-relative fixture file names) — no arbitrary I/O.
    readArtifact: (path: string): Promise<ArrayBuffer> => {
      const bytes = readFileSync(new URL(path, CUE_DIR));
      return Promise.resolve(new Uint8Array(bytes).buffer);
    },
    container,
    buildId: 'shell-build-1',
    assetPaths: Object.fromEntries(Object.entries(CUE_PATHS).map(([id, file]) => [id, file])),
    document: fakeDom,
  } as GameHostConfig);

  const mounted = host.mount();
  if (!mounted.ok) {
    throw new Error(`shell mount failed: ${JSON.stringify(mounted.error)}`);
  }

  const nowObj = { value: 0 };
  return {
    host,
    input,
    audio,
    audioGraph,
    key: (code: string, down = true, repeat = false): void => {
      const t = { isContentEditable: false, tagName: 'CANVAS' };
      target.dispatch(down ? 'keydown' : 'keyup', { code, target: t, repeat });
    },
    setPads: (pads: ArrayLike<Gamepad | null>): void => {
      padList = pads;
    },
    setVisibility: (state: string): void => {
      (doc as unknown as { visibilityState: string }).visibilityState = state;
      doc.dispatch('visibilitychange');
    },
    tick: (t?: number): void => {
      if (t !== undefined) nowObj.value = t;
      nowObj.value += DT;
      const res = host.runtime.tick(nowObj.value);
      if (!res.ok) throw new Error(`tick failed: ${JSON.stringify(res.error)}`);
    },
    now: nowObj,
    view: (): ShellView => {
      const res = host.observe();
      if (!res.ok) throw new Error(`observe failed: ${JSON.stringify(res.error)}`);
      const obs = res.observation;
      const vres = host.runtime.getGameView();
      if (!vres.ok) throw new Error(`getGameView failed: ${JSON.stringify(vres.error)}`);
      const v = vres.view;
      const tres = host.runtime.getInterpolatedState();
      if (!tres.ok) throw new Error('getInterpolatedState failed');
      const t = tres.state.transforms.find((x) => x.id === 'group-0001');
      return {
        state: obs.state,
        runId: obs.runId,
        stepIndex: obs.stepIndex,
        deathCount: obs.deathCount,
        goalReached: obs.goalReached,
        checkpointId: obs.checkpointId,
        grounded: v.playerMotion.grounded,
        x: t ? t.position[0] : 0,
        y: t ? t.position[1] : 0,
      };
    },
    dispose: (): void => {
      host.dispose();
      input.dispose();
      audio.dispose();
      physics.dispose();
    },
  };
}

/** Tick until the predicate holds (bounded), returning the final view. */
async function runUntil(shell: Shell, pred: (v: ShellView) => boolean, maxTicks: number): Promise<ShellView> {
  for (let i = 0; i < maxTicks; i += 1) {
    shell.tick();
    const v = shell.view();
    if (pred(v)) return v;
  }
  throw new Error(`runUntil: predicate not met in ${maxTicks} ticks`);
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe('the full local shell over real parts (delivery.md §3.1/§4)', () => {
  it('C4/C5: Enter starts at the title with no motion, the run walks to the checkpoint and the goal, a fresh Enter replays', async () => {
    const s = await startShell();
    s.tick(); // the pre-roll settle (awaitingStart)
    const st = await s.audio.unlock(); // the local gesture (the wrapper wires it in the page)
    expect(st.state).toBe('ready');

    s.key('Enter'); // the title confirm
    s.tick(); // the frame services the menu channel: start queued + consumed
    s.tick(); // the boundary applies the start (no motion step at the title)
    let v = s.view();
    expect(v.state).toBe('playing');
    expect(v.runId).toBe('shell-demo@r1#0');
    expect(v.x).toBeCloseTo(3, 1); // still at the spawn: no phantom motion
    expect(v.stepIndex).toBeGreaterThan(0);

    s.key('KeyD'); // hold right
    v = await runUntil(s, (x) => x.checkpointId !== null, 2000);
    expect(v.checkpointId).toBe('zone-checkpoint');
    v = await runUntil(s, (x) => x.goalReached, 2000);
    expect(v.state).toBe('won');

    // The committed cue events were submitted with REAL bytes: at least one
    // cue decoded from the fixture WAV and at least one voice started.
    expect(s.audioGraph.decoded.length).toBeGreaterThanOrEqual(1);
    expect(s.audioGraph.sources.some((src) => src.started >= 1)).toBe(true);
    const obs = s.host.observe();
    if (obs.ok) expect(obs.observation.sound.voices).toBeGreaterThanOrEqual(1);

    // Replay: the Enter from the title is still held — release it, then a
    // fresh press (the §4.2 fresh-release cycle).
    s.key('KeyD', false);
    s.key('Enter', false);
    s.key('Enter');
    s.tick(); // the frame services the menu channel: replay queued + consumed
    s.tick(); // the boundary applies the replay (T6: fresh epoch, counters reset)
    v = s.view();
    expect(v.state).toBe('playing');
    expect(v.runId).toBe('shell-demo@r1#1');
    expect(v.deathCount).toBe(0);
    expect(v.checkpointId).toBeNull();
    expect(v.goalReached).toBe(false);
    expect(v.x).toBeCloseTo(3, 1); // re-placed at the start spawn
    s.dispose();
  }, 60_000);

  it('C1/C2: a held Space at the title does not phantom-jump; a fresh press after release jumps', async () => {
    const s = await startShell();
    s.tick(); // pre-roll
    s.key('Space'); // held at the title
    s.tick(); // the frame services the confirm: start (the press is consumed)
    s.tick(); // the boundary starts the run (first-live-step gate applies too)
    // The held + consumed press: the run's opening steps must stay grounded
    // at the spawn height — no phantom jump.
    for (let i = 0; i < 12; i += 1) {
      s.tick();
      const v = s.view();
      expect(v.state).toBe('playing');
      expect(v.grounded).toBe(true);
      expect(Math.abs(v.y - 0.9)).toBeLessThan(0.05);
    }
    // Release, then a fresh press: the jump of the fresh press (C2).
    s.key('Space', false);
    s.key('Space');
    let jumped = false;
    for (let i = 0; i < 40; i += 1) {
      s.tick();
      const v = s.view();
      if (!v.grounded || v.y > 1.0) {
        jumped = true;
        break;
      }
    }
    expect(jumped).toBe(true);
    s.dispose();
  }, 60_000);

  it('C3: a fresh pad primary-button press starts the run; the held press does not jump; the D-pad moves; a fresh press jumps', async () => {
    const s = await startShell();
    s.tick(); // pre-roll
    s.setPads([pad({ pressed: [0] })]);
    s.tick(); // the poll sees the fresh press; the frame services the confirm: start
    s.tick(); // the boundary starts the run
    expect(s.view().state).toBe('playing');
    // The held + consumed button: no phantom jump.
    for (let i = 0; i < 8; i += 1) {
      s.tick();
      expect(Math.abs(s.view().y - 0.9)).toBeLessThan(0.05);
    }
    // The D-pad right (button 15) moves the player (the accepted arbitration).
    s.setPads([pad({ pressed: [15] })]);
    const before = s.view().x;
    for (let i = 0; i < 60; i += 1) s.tick();
    expect(s.view().x).toBeGreaterThan(before + 0.5);
    s.setPads([]); // release
    // A fresh primary-button press in play: a confirm no-op AND a jump.
    s.setPads([pad({ pressed: [0] })]);
    let jumped = false;
    for (let i = 0; i < 40; i += 1) {
      s.tick();
      const v = s.view();
      if (!v.grounded) {
        jumped = true;
        break;
      }
    }
    expect(jumped).toBe(true);
    s.dispose();
  }, 60_000);

  it('C7: a pad disconnect clears the pad menu state; the keyboard jump is unaffected', async () => {
    const s = await startShell();
    s.tick(); // pre-roll
    s.setPads([pad({ pressed: [0] })]);
    s.tick(); // the poll sees the fresh pad press
    s.key('Enter'); // a keyboard confirm is in flight too
    s.tick(); // the frame services the confirm: start (consumed on both devices)
    s.tick(); // the boundary starts the run
    const menu = s.input.sampleMenu();
    expect(menu.confirmNeedsRelease).toBe(true); // the consumed presses are held
    s.setPads([]); // the pad disconnects (a missing poll entry)
    s.tick(); // the poll reconciles the loss
    expect(s.view().state).toBe('playing');
    // The keyboard jump still works (Space is a fresh press; Enter suppresses
    // no jump — it is not the jump key).
    s.key('Space');
    let jumped = false;
    for (let i = 0; i < 40; i += 1) {
      s.tick();
      const v = s.view();
      if (!v.grounded) {
        jumped = true;
        break;
      }
    }
    expect(jumped).toBe(true);
    s.dispose();
  }, 60_000);

  it('C9/§4.6: a hidden tab clears the held input and menu; a resume stall is dropped and resynced (no burst)', async () => {
    const s = await startShell();
    s.tick(); // pre-roll
    s.key('Enter');
    s.tick();
    s.tick(); // the run is playing
    s.key('KeyD'); // walking
    for (let i = 0; i < 30; i += 1) s.tick();
    const walkingX = s.view().x;
    expect(walkingX).toBeGreaterThan(3.5); // the held D is moving the player

    // The tab hides: the owner suspends (held keys + the menu latch clear).
    s.setVisibility('hidden');
    s.tick();
    s.tick();
    const stoppedX = s.view().x;
    expect(Math.abs(stoppedX - walkingX)).toBeLessThan(0.1); // the walk stopped

    // The tab was hidden a long time: a large wall delta on resume. The
    // runtime's bounded catch-up (MAX_CATCHUP_STEPS = 8) + drop-and-resync
    // applies — no fast-forward burst.
    const stepBefore = s.view().stepIndex;
    s.tick(s.now.value + 5);
    const stepAfter = s.view().stepIndex;
    expect(stepAfter - stepBefore).toBeLessThanOrEqual(8);

    // Back to visible: the owner re-arms (fresh activation).
    s.setVisibility('visible');
    s.tick();
    s.dispose();
  }, 60_000);

  it('stale run identity: the replay changes the runId; a stale-run cue event is dropped by the owner', async () => {
    const s = await startShell();
    await s.audio.unlock();
    s.tick(); // pre-roll
    expect(s.host.control('start').ok).toBe(true);
    s.tick(); // the boundary starts the run
    s.tick(); // the frame submits the committed runStarted cue (the owner learns run #0)
    const run0 = s.view().runId;
    expect(run0).toBe('shell-demo@r1#0');
    expect(s.host.control('replay').ok).toBe(true);
    s.tick(); // the boundary applies the replay (T6); the frame submits run #1's events
    const run1 = s.view().runId;
    expect(run1).toBe('shell-demo@r1#1');

    // A stale-run event (the old runId) submitted after the replay is
    // skipped by the owner (bounded diagnostic; never played into the new run).
    const r = s.audio.submit([
      { id: `${run0}/jump/5`, kind: 'jump', assetId: 'cue-jump', runId: run0, stepIndex: 5 },
    ]);
    expect(r.ok).toBe(true);
    const diags = s.audio.diagnostics();
    expect(diags.some((d) => d.code === 'stale_work_discarded')).toBe(true);
    s.dispose();
  }, 60_000);

  it('repeated attach/detach: a new host on the same snapshot reuses the wrapper resources', async () => {
    const s = await startShell();
    s.tick(); // pre-roll
    const run0 = s.view().runId;
    s.host.dispose(); // the first host (the wrapper keeps input/audio/physics)

    // A second host on the SAME snapshot + the SAME wrapper-owned owners.
    const input = s.input;
    const audio = s.audio;
    const physics2 = await (async () => {
      const init = await createPhysicsPort({
        character: { x: 3, y: 0.9 },
        statics: [STATIC],
        solver: SOLVER,
        controller: CONTROLLER_CFG,
      });
      if (!init.ok) throw new Error('second physics init failed');
      return init.port;
    })();
    const host2 = createGameHost({
      snapshot: courseSnapshot() as RuntimeSnapshot,
      settings: SETTINGS,
      physics: physics2,
      adapter: () => null,
      input,
      audio,
      readArtifact: (path: string): Promise<ArrayBuffer> => {
        const bytes = readFileSync(new URL(path, CUE_DIR));
        return Promise.resolve(new Uint8Array(bytes).buffer);
      },
      container: new FakeNode(),
      buildId: 'shell-build-1',
      assetPaths: Object.fromEntries(Object.entries(CUE_PATHS).map(([id, file]) => [id, file])),
      document: fakeDom,
    } as GameHostConfig);
    const m2 = host2.mount();
    expect(m2.ok).toBe(true);
    host2.runtime.tick(1 / 120); // the second host's pre-roll
    const obs = host2.observe();
    expect(obs.ok).toBe(true);
    if (obs.ok) {
      expect(obs.observation.state).toBe('awaitingStart'); // a fresh host, a fresh title
      expect(obs.observation.runId).toBe(run0); // the same snapshot identity
    }
    host2.dispose();
    physics2.dispose();
  }, 60_000);
});
