/**
 * The game host (delivery.md §3.1/§3.2/§4 — packet 55, B04/B08/B09/B13/B15).
 *
 * The LOCAL (in-page) composition: one runtime instance per mounted host,
 * the injected input owner (the browser gameplay + menu channels), the
 * injected audio owner (packet 54), the injected render adapter (the
 * three-adapter, types-only), and the host-owned HUD. The exported page
 * (packets 56–59) composes the SAME entry behind the relay channel; nothing
 * here imports the relay, the backend, the MCP, or the model service.
 *
 * Wiring rules this module enforces:
 *  - the runtime is the single frame driver (the host never adds a loop;
 *    its per-frame work runs as the runtime's `onFrame` — step → host →
 *    adapter render, runtime.md §6);
 *  - the menu/control channel is serviced BETWEEN frames, never on a tick
 *    (delivery.md §4.5: `gameCommand` is callable between frame updates —
 *    a title start / win replay succeeds with `movementSteps: 0`);
 *  - committed-view-only: the host reads `getGameView()` for HUD/audio/
 *    adapter work and never touches runtime internals or the adapter's
 *    scene graph (one scene-mutation path, C41-1);
 *  - the HUD writes `textContent` only — project strings are never HTML.
 *
 * Additive over the binding §3.1 surface (contract-change requests CC-55-1
 * / CC-55-2, recorded in the packet-55 handoff — the binding members are
 * unchanged):
 *  - `GameHostConfig.buildId` — the verified manifest buildId the wrapper
 *    passed (the §3.1 `GameHostObservation.buildId` field is unsatisfiable
 *    from the binding config, which carries no build identity);
 *  - `GameHostConfig.assetPaths` — assetId → manifest-declared relative
 *    path (the manifest is wrapper-owned; the host resolves cue bytes
 *    through the injected `readArtifact` and stays fetch-free);
 *  - `GameHostConfig.adapter` is the FACTORY `(runtime) => adapter | null`
 *    (the three-adapter instance requires the runtime it renders, which
 *    the host creates inside `mount()` — a pre-made instance cannot be
 *    injected);
 *  - `GameHost.runtime` — the additive read-only runtime seam (manual
 *    driver / Node compositions need a frame-advance handle; the binding
 *    §3.1 surface exposes none).
 */
import {
  BUILTIN_MODULES,
  behaviorModuleId,
  createBehaviorModuleSpec,
  createSimulationRegistry,
  instantiateRuntime,
  registerSimulationModule,
  type ActionFrame,
  type SimulationModuleSpec,
  type GameEvent,
  type GameView,
  type GameplaySettings,
  type PhysicsPort,
  type RuntimeError,
  type RunState,
  type Runtime,
  type RuntimeSnapshot,
  type LoadedSceneBatch,
} from '@thirdlight/runtime';
import { platformerSpec } from '@thirdlight/platformer';
import {
  platformerGameCameraSpec,
  platformerGameSessionSpec,
} from '@thirdlight/platformer-game';
import type { MenuSample } from '@thirdlight/input';
import type { GameAudioOwner, GameCueEvent, CueKind } from './audio';
import { createHud, type HostDom, type HostDomNode, type Hud, type HudState } from './hud';

/** delivery.md §3.1. */
export const GAME_HOST_API_VERSION = 1;

/** delivery.md §3.1 — the four bounded game-control actions. */
export type GameControlAction = 'start' | 'replay' | 'mute' | 'unmute';
export const GAME_CONTROL_ACTIONS: readonly GameControlAction[] = Object.freeze([
  'start',
  'replay',
  'mute',
  'unmute',
]);

/** delivery.md §3.1 — the four bridge message names (the relay channel,
 * packets 56–59, consumes these; the local host defines the constant). */
export const GAME_HOST_MESSAGES: readonly string[] = Object.freeze([
  'tl.game.control',
  'tl.game.observe',
  'tl.game.control.result',
  'tl.game.observe.result',
]);

/** The host's structural input-owner surface (the injected
 * `attachBrowserInput` return value satisfies it; the edge is types-only). */
export interface HostInputOwner {
  sample(stepIndex: number): ActionFrame;
  sampleMenu(): MenuSample;
  markConfirmConsumed(): void;
  dispose(): void;
}

/** The host's structural render-adapter surface (the three-adapter
 * `SceneAdapter` satisfies it; the edge is types-only). */
export interface HostRenderAdapter {
  renderFrame(): { ok: true } | { ok: false; error: unknown };
  dispose(): unknown;
}

/** delivery.md §3.1 `GameHostObservation.sound`. */
export interface GameHostSound {
  readonly status: 'ready' | 'muted' | 'blocked' | 'unavailable';
  readonly unlocked: boolean;
  readonly voices: number;
  readonly muted: boolean;
  readonly gesture: 'local' | 'none';
}

/** delivery.md §3.1 `GameHostObservation`. */
export interface GameHostObservation {
  readonly runId: string;
  readonly snapshotId: string;
  readonly buildId: string;
  readonly stepIndex: number;
  readonly state: RunState;
  readonly checkpointId: string | null;
  readonly deathCount: number;
  readonly goalReached: boolean;
  readonly failed: boolean;
  readonly sound: GameHostSound;
  readonly inputMode: 'physical' | 'test';
  /** Phase 12 (c), additive: the loaded scenes and the ones being loaded (v4 games). */
  readonly scenes?: { readonly loaded: readonly string[]; readonly loading: readonly string[] };
}

/** delivery.md §3.1 `GameControlResult` (accepted submissions; the
 * runtime's own rejection rule passes through its structured error). */
export type GameControlError =
  | { code: string; reason?: string; command?: string; state?: string; message: string };

export type GameControlResult =
  | { readonly ok: true; readonly state: RunState; readonly acceptedAtStep: number }
  | { readonly ok: false; readonly error: GameControlError };

/** delivery.md §3.1 `GameHostConfig` (+ the additive CC-55-1/CC-55-2 fields). */
export interface GameHostConfig {
  /** The runtime snapshot (validated by the runtime at instantiate). */
  readonly snapshot: RuntimeSnapshot;
  /** The resolved gameplay settings (the wrapper passes the manifest's
   * `gameplaySettings` or the model default). */
  readonly settings: GameplaySettings;
  /** The injected physics port (physics-rapier in the preview; a fake in
   * tests). Absent for a scene without a game block (scene mode). */
  readonly physics?: PhysicsPort;
  /** The project's compiled behaviors (see `linkBehaviorModules`), run with the scene. */
  readonly behaviorModules?: readonly SimulationModuleSpec[];
  /**
   * The manifest's required engine module ids (derived by the build from the
   * declared dependencies). The host registers exactly these simulation
   * modules and checks the port modules it needs are injected; an id it
   * cannot provide is `host_module_unresolved`. Absent ⇒ the game set when
   * there is a game block, nothing otherwise.
   */
  readonly modules?: readonly string[];
  /** ADDITIVE (CC-55-2): the render-adapter FACTORY — the three-adapter
   * instance requires the runtime it renders, which the host creates inside
   * `mount()`. `null` = no adapter (headless composition). */
  readonly adapter: (runtime: Runtime) => HostRenderAdapter | null;
  /** The injected browser input owner (the gameplay + menu channels). */
  readonly input: HostInputOwner;
  /** The injected audio owner (packet 54). */
  readonly audio: GameAudioOwner;
  /** The injected artifact reader (manifest-declared relative paths only;
   * the host never fetches). Contract shape (delivery.md §3.1): the bytes
   * arrive as an `ArrayBuffer`; the host wraps them for the audio owner. */
  readonly readArtifact: (path: string) => Promise<ArrayBuffer>;
  /** The HUD root element the host owns (removed on dispose). */
  readonly container: HostDomNode;
  /** ADDITIVE (CC-55-1): the verified manifest buildId → `observe().buildId`. */
  readonly buildId: string;
  /** ADDITIVE (CC-55-1): assetId → manifest-declared relative path; the host
   * resolves non-null cue refs through `readArtifact` at mount. */
  readonly assetPaths?: Record<string, string>;
  /** The DOM document for HUD element creation (default: the environment's
   * `document`; Node tests inject a fake). */
  readonly document?: HostDom;
  /**
   * Phase 12 (c), additive: fetch one scene the game asked for and return
   * its resolved entities (the wrapper reads and verifies the manifest's
   * `scenes/<sceneId>.json`; see `sceneEntitiesFromDocument`). Absent: loads
   * fail with a diagnostic and the game keeps its start scenes.
   */
  readonly loadScene?: (sceneId: string) => Promise<LoadedSceneBatch['entities']>;
}

/** delivery.md §3.1 `GameHost`. */
export interface GameHost {
  /** The binding §3.1 members. */
  mount(): { readonly ok: true } | { readonly ok: false; readonly error: GameControlError };
  control(action: GameControlAction): GameControlResult;
  observe():
    | { readonly ok: true; readonly observation: GameHostObservation }
    | { readonly ok: false; readonly error: GameControlError };
  setViewport(width: number, height: number): { readonly ok: true } | { readonly ok: false; readonly error: GameControlError };
  /** delivery.md §3.1: `dispose(): void` (idempotent). */
  dispose(): void;
  /** ADDITIVE (CC-55-1b): the host's runtime seam (read-only; the manual
   * driver / Node compositions advance frames through it). */
  readonly runtime: Runtime;
  /** Phase 12 (c), additive: request a scene load/unload (the same rules as a script's `ctx.scenes`). */
  scene(op: 'load' | 'unload', sceneId: string): { readonly ok: true } | { readonly ok: false; readonly error: GameControlError };
}

// --- the committed-view → cue mapping (delivery.md §4.1, B13) -------------

/** The committed `GameEventKind` → cue-kind map. `respawned`/`replayed` are
 * run-boundary bookkeeping (no cue); `jump` is DERIVED from the committed
 * `playerMotion` grounded→airborne transition (the closed `GameEventKind`
 * vocabulary has no jump event — the committed motion is the only committed
 * airborne signal; a walk-off cliff also fires it: a documented limitation
 * of the committed-view vocabulary). */
const CUE_EVENT_KIND: Readonly<Record<GameEvent['kind'], CueKind | null>> = Object.freeze({
  runStarted: 'start',
  died: 'death',
  checkpointActivated: 'checkpoint',
  goalReached: 'goal',
  respawned: null,
  replayed: null,
});

/** Map one committed view to the cue events the audio owner should try
 * (the owner dedupes by id per runId, so re-submitting the bounded event
 * ring every frame is safe and idempotent). */
export function cueEventsForView(
  view: GameView,
  cues: { readonly start: string | null; readonly jump: string | null; readonly checkpoint: string | null; readonly death: string | null; readonly goal: string | null },
  previousGrounded: boolean,
): GameCueEvent[] {
  const out: GameCueEvent[] = [];
  for (const ev of view.events) {
    const kind = CUE_EVENT_KIND[ev.kind];
    if (kind === null) continue;
    const assetId = cues[kind];
    if (assetId === null) continue;
    out.push({ id: ev.id, kind, assetId, runId: view.runId, stepIndex: ev.stepIndex });
  }
  if (
    cues.jump !== null &&
    view.state === 'playing' &&
    previousGrounded &&
    view.playerMotion.grounded === false
  ) {
    out.push({
      id: `${view.runId}/jump/${view.stepIndex}`,
      kind: 'jump',
      assetId: cues.jump,
      runId: view.runId,
      stepIndex: view.stepIndex,
    });
  }
  return out;
}

// --- the sound-status mapping (delivery.md §3.1 `sound.status`) -----------

export function mapSoundStatus(owner: GameAudioOwner): GameHostSound {
  const st = owner.status();
  if (st.state === 'ready') {
    return {
      status: st.muted ? 'muted' : 'ready',
      unlocked: st.unlocked,
      voices: owner.liveVoices(),
      muted: st.muted,
      gesture: st.unlocked ? 'local' : 'none',
    };
  }
  const status = st.state === 'blocked' ? 'blocked' : 'unavailable';
  return { status, unlocked: false, voices: 0, muted: false, gesture: 'none' };
}

// --- config validation ------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateConfig(config: GameHostConfig): string | null {
  if (!isPlainObject(config)) return 'config must be a plain object';
  if (!isPlainObject(config.snapshot)) return 'config.snapshot must be the runtime snapshot document';
  if (typeof config.settings !== 'object' || config.settings === null) return 'config.settings must be the resolved gameplay settings';
  if (config.physics !== undefined && !isPlainObject(config.physics)) return 'config.physics must be the injected physics port';
  if (config.behaviorModules !== undefined && !Array.isArray(config.behaviorModules)) return 'config.behaviorModules must be an array of behavior module specs';
  if (config.modules !== undefined && (!Array.isArray(config.modules) || !config.modules.every((m) => typeof m === 'string'))) return 'config.modules must be an array of module ids';
  if (typeof config.adapter !== 'function') return 'config.adapter must be the render-adapter factory (CC-55-2)';
  if (!isPlainObject(config.input)) return 'config.input must be the injected browser input owner';
  if (typeof config.input.sample !== 'function') return 'config.input.sample must be a function (ActionSource.sample)';
  if (typeof config.input.sampleMenu !== 'function') return 'config.input.sampleMenu must be a function (the menu channel, delivery.md §4.1)';
  if (typeof config.input.markConfirmConsumed !== 'function') return 'config.input.markConfirmConsumed must be a function (delivery.md §4.2)';
  if (typeof config.input.dispose !== 'function') return 'config.input.dispose must be a function';
  if (!isPlainObject(config.audio)) return 'config.audio must be the injected audio owner (packet 54)';
  for (const member of ['registerCue', 'submit', 'unlock', 'setMuted', 'setHidden', 'status', 'dispose', 'liveVoices'] as const) {
    if (typeof config.audio[member] !== 'function') return `config.audio.${member} must be a function`;
  }
  if (typeof config.readArtifact !== 'function') return 'config.readArtifact must be the injected artifact reader';
  if (!isPlainObject(config.container)) return 'config.container must be the HUD root element';
  if (typeof config.container.appendChild !== 'function' || typeof config.container.remove !== 'function') {
    return 'config.container must expose appendChild/remove (the structural HostDomNode surface)';
  }
  if (typeof config.buildId !== 'string' || config.buildId.length === 0) {
    return 'config.buildId must be the non-empty verified manifest buildId (CC-55-1)';
  }
  if (config.assetPaths !== undefined && !isPlainObject(config.assetPaths)) {
    return 'config.assetPaths must map assetId → manifest-declared relative path (CC-55-1)';
  }
  if (config.document !== undefined && typeof config.document.createElement !== 'function') {
    return 'config.document must expose createElement (the structural HostDom surface)';
  }
  return null;
}

/** Phase 12 (c): the `scenes` observation block (absent without a scene catalog). */
function scenesObservation(rt: Runtime): { scenes?: { loaded: readonly string[]; loading: readonly string[] } } {
  const set = rt.sceneSet?.();
  if (set === undefined || Object.keys(set.status).length === 0) return {};
  const loading = Object.entries(set.status).filter(([, st]) => st === 'loading').map(([id]) => id);
  return { scenes: { loaded: set.batches.map((b) => b.sceneId), loading } };
}

function toControlError(error: RuntimeError): GameControlError {
  const out: GameControlError = { code: error.code, message: error.message };
  if (error.reason !== undefined) out.reason = error.reason;
  if (error.command !== undefined) out.command = error.command;
  if (error.state !== undefined) out.state = error.state;
  return out;
}

// --- the host ---------------------------------------------------------------

/**
 * Create the game host (delivery.md §3.1). The host owns its runtime
 * instance and HUD; the input owner, audio owner, and canvas are
 * wrapper-owned and injected (a new host on the same snapshot reuses them).
 */
/** The simulation modules this host can register, by manifest module id. */
const SIMULATION_SPECS: Readonly<Record<string, SimulationModuleSpec>> = {
  [platformerSpec.id]: platformerSpec,
  [platformerGameSessionSpec.id]: platformerGameSessionSpec,
  [platformerGameCameraSpec.id]: platformerGameCameraSpec,
};
/** The port modules the delivery wrapper injects (checked, not registered). */
const PORT_MODULES = new Set(['thirdlight.physics-rapier:2d', 'thirdlight.input:keyboard-gamepad', 'thirdlight.three-adapter:gltf-loader']);

/**
 * Select the simulation modules from the manifest's module list (the build's
 * derived set), or the default game set when the wrapper passed none.
 */
function selectModules(
  config: GameHostConfig,
  sceneMode: boolean,
): { ok: true; specs: SimulationModuleSpec[] } | { ok: false; error: { code: 'host_module_unresolved'; message: string } } {
  if (config.modules === undefined) {
    return { ok: true, specs: sceneMode ? [] : [platformerSpec, platformerGameSessionSpec, platformerGameCameraSpec] };
  }
  const specs: SimulationModuleSpec[] = [];
  for (const id of config.modules) {
    const spec = SIMULATION_SPECS[id];
    if (spec !== undefined) {
      if (!specs.includes(spec)) specs.push(spec);
      continue;
    }
    if (id === 'thirdlight.demo:box-motion') continue; // a runtime built-in (already registered)
    if (PORT_MODULES.has(id)) {
      if (id === 'thirdlight.physics-rapier:2d' && config.physics === undefined) {
        return { ok: false, error: { code: 'host_module_unresolved', message: `module ${id} is required but no physics port was injected` } };
      }
      continue;
    }
    return { ok: false, error: { code: 'host_module_unresolved', message: `module ${id} is required but this engine does not provide it` } };
  }
  // Register in dependency order (controller before the session, session before the camera).
  const order = [platformerSpec, platformerGameSessionSpec, platformerGameCameraSpec];
  specs.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return { ok: true, specs };
}

export function createGameHost(config: GameHostConfig): GameHost {
  const invalid = validateConfig(config);
  const configError: GameControlError = invalid !== null
    ? { code: 'host_config_invalid', reason: 'config', message: invalid }
    : { code: 'host_config_invalid', reason: 'config', message: 'invalid game host config' };

  let disposed = false;
  let mounted = false;
  let runtime: Runtime | null = null;
  let hud: Hud | null = null;
  let adapter: HostRenderAdapter | null = null;
  /** The last committed `playerMotion.grounded` (the jump-cue transition).
   * Reset to `true` at every reset boundary (the committed view publishes
   * `{ speed: 0, grounded: true }` there, so the derived cue can never fire
   * on a respawn's first frame). */
  let previousGrounded = true;
  let lastCheckpointStep: number | null = null;

  // The snapshot's `game` block is runtime-validated; the host reads its
  // authored strings + cue refs structurally (types-only, from the typed
  // RuntimeSnapshot).
  const authored = config.snapshot.game;
  const cues: Record<CueKind, string | null> = {
    start: authored?.cues?.start ?? null,
    jump: authored?.cues?.jump ?? null,
    checkpoint: authored?.cues?.checkpoint ?? null,
    death: authored?.cues?.death ?? null,
    goal: authored?.cues?.goal ?? null,
  };

  /** The host's per-frame work (the runtime's `onFrame` — runs AFTER the
   * step update, before the adapter renders; runtime.md §6 ordering). */
  const buildHudState = (state: RunState, deathCount: number, checkpointActive: boolean, checkpointStep: number | null): HudState => ({
    title: typeof authored?.title === 'string' ? authored.title : '',
    objective: typeof authored?.objective === 'string' ? authored.objective : '',
    instructions: typeof authored?.instructions === 'string' ? authored.instructions : '',
    state,
    deathCount,
    checkpointActive,
    checkpointStep: checkpointActive ? checkpointStep : null,
    sound: mapSoundStatus(config.audio).status,
  });

  /** Phase 12 (c): hand the game's scene requests to the wrapper's loader. */
  const serviceSceneRequests = (rt: Runtime): void => {
    const requests = rt.takeSceneRequests?.() ?? [];
    for (const req of requests) {
      if (config.loadScene === undefined) {
        rt.provideScene?.(req.sceneId, { ok: false, message: 'this game page cannot load scenes' });
        continue;
      }
      void config.loadScene(req.sceneId).then(
        (entities) => {
          if (!disposed && runtime === rt) rt.provideScene?.(req.sceneId, { ok: true, entities });
        },
        (error: unknown) => {
          if (!disposed && runtime === rt) rt.provideScene?.(req.sceneId, { ok: false, message: error instanceof Error ? error.message : String(error) });
        },
      );
    }
  };

  const hostFrame = (): void => {
    if (disposed || !mounted || runtime === null) return;
    serviceSceneRequests(runtime);
    // (1) The menu/control channel — serviced BETWEEN frames, never on a
    // tick (delivery.md §4.5). The run commands queue in the runtime and
    // apply at the next step boundary; at awaitingStart/won that boundary
    // performs no motion steps (C4/C5: `movementSteps: 0`).
    const menu: MenuSample = config.input.sampleMenu();
    if (menu.confirm || menu.mute) {
      const res = runtime.getGameView();
      const state: RunState | null = res.ok ? res.view.state : null;
      if (menu.confirm) {
        // The §4.2 fresh-release state machine: consumption happens when the
        // confirm DRIVES a menu action (start at the title, replay at the
        // win screen). A confirm sampled in a state with no valid action is
        // gameplay input, not a consumed menu press — its jump is
        // legitimate and must keep its full hold (no early 'released').
        let acted = false;
        if (state === 'awaitingStart') {
          const c = control('start');
          acted = c.ok === true;
          if (c.ok === false) console.warn('[game-host] menu confirm: start rejected', c.error.code);
        } else if (state === 'won') {
          const c = control('replay');
          acted = c.ok === true;
          if (c.ok === false) console.warn('[game-host] menu confirm: replay rejected', c.error.code);
        }
        if (acted) {
          // Consumed: the held press now needs a release before it may jump
          // (delivery.md §4.2 — the owner's needsRelease state suppresses the
          // same physical press from also becoming a jump).
          config.input.markConfirmConsumed();
        }
      }
      if (menu.mute) {
        const st = config.audio.status();
        void control(st.state === 'ready' && st.muted ? 'unmute' : 'mute');
      }
    }
    // (2) The committed view → cues, HUD, adapter. Committed-view-only:
    // no runtime internals, no scene-graph mutation (C41-1). Scene mode has
    // no game view: it only renders.
    const res = runtime.getGameView();
    if (res.ok === false) {
      adapter?.renderFrame();
      return;
    }
    const view = res.view;
    // `won` too: the goal event commits on the step the run is won (cue ids
    // are played at most once, so re-submitting a frame is harmless).
    if (view.state === 'playing' || view.state === 'respawning' || view.state === 'won') {
      const cueEvents = cueEventsForView(view, cues, previousGrounded);
      if (cueEvents.length > 0) config.audio.submit(cueEvents);
    }
    if (view.checkpointActive && lastCheckpointStep !== view.stepIndex) {
      lastCheckpointStep = view.stepIndex;
    }
    if (view.state === 'awaitingStart') {
      // A fresh run (or a replay) re-anchors the HUD's checkpoint line.
      lastCheckpointStep = null;
    }
    previousGrounded = view.playerMotion.grounded;
    if (hud !== null) {
      hud.update(buildHudState(view.state, view.deathCount, view.checkpointActive, lastCheckpointStep));
    }
    adapter?.renderFrame();
  };

  const control = (action: GameControlAction): GameControlResult => {
    if (disposed) return { ok: false, error: { code: 'host_disposed', message: 'the host is disposed' } };
    if (!mounted || runtime === null) {
      return { ok: false, error: { code: 'host_not_mounted', message: 'the host is not mounted' } };
    }
    switch (action) {
      case 'start':
      case 'replay': {
        const res = runtime.gameCommand(action);
        if (res.ok === false) return { ok: false, error: toControlError(res.error) };
        const viewRes = runtime.getGameView();
        return {
          ok: true,
          state: viewRes.ok ? viewRes.view.state : 'awaitingStart',
          acceptedAtStep: viewRes.ok ? viewRes.view.stepIndex : 0,
        };
      }
      case 'mute':
        config.audio.setMuted(true);
        break;
      case 'unmute':
        config.audio.setMuted(false);
        break;
    }
    const viewRes = runtime.getGameView();
    return {
      ok: true,
      state: viewRes.ok ? viewRes.view.state : 'awaitingStart',
      acceptedAtStep: viewRes.ok ? viewRes.view.stepIndex : 0,
    };
  };

  const mount = (): { ok: true } | { ok: false; error: GameControlError } => {
    if (disposed) return { ok: false, error: { code: 'host_disposed', message: 'the host is disposed' } };
    if (mounted) return { ok: false, error: { code: 'host_already_mounted', message: 'the host is already mounted (dispose before remounting)' } };
    if (configError.reason === 'config' && configError.message !== 'invalid game host config') {
      return { ok: false, error: configError };
    }
    const snapshot = config.snapshot;
    const scene = snapshot.scene;
    if (scene.schemaVersion !== 3 && scene.schemaVersion !== 4) {
      return { ok: false, error: { code: 'host_config_invalid', reason: 'game-block', message: 'the game host requires a v3 snapshot' } };
    }
    // Scene mode: without a game block the host plays the scene as authored
    // (runtime built-ins only, no game session, no HUD).
    const sceneMode = snapshot.game === null || snapshot.game === undefined;
    // (the typed `EntityComponents` union is per-schema; the host reads the
    // component presence structurally, as the M2 export-composition does.)
    if (!sceneMode && !scene.entities.some((e) => ((e.components ?? {}) as unknown as Record<string, unknown>)['controller'] !== undefined)) {
      return { ok: false, error: { code: 'host_config_invalid', reason: 'controller', message: 'the scene carries no controller entity (the M3 game requires the player controller)' } };
    }

    const registry = createSimulationRegistry();
    // The M3 module set (delivery.md §3.2: "runtime built-ins + platformer
    // controller + platformer-game session + linked behavior modules").
    // The registry carries the runtime built-ins (inert unless selected —
    // the M2 export-composition pattern); the SELECTED modules are the
    // M3 game set, plus the project's compiled behaviors.
    for (const spec of BUILTIN_MODULES) registerSimulationModule(registry, spec.id, spec);
    const selected = selectModules(config, sceneMode);
    if (!selected.ok) return selected;
    const specs = selected.specs;
    const modules: string[] = [];
    for (const spec of specs) {
      const r = registerSimulationModule(registry, spec.id, spec);
      if (r.ok === false) {
        return { ok: false, error: { code: 'host_module_registration_failed', message: `registering ${spec.id} failed: ${r.error.message}` } };
      }
      modules.push(spec.id);
    }
    for (const spec of config.behaviorModules ?? []) {
      const r = registerSimulationModule(registry, spec.id, spec);
      if (r.ok === false) {
        return { ok: false, error: { code: 'host_module_registration_failed', message: `registering ${spec.id} failed: ${r.error.message}` } };
      }
      modules.push(spec.id);
    }

    const res = instantiateRuntime({
      snapshot,
      registry,
      modules,
      actions: config.input,
      ...(config.physics !== undefined ? { physics: config.physics } : {}),
      settings: config.settings,
      onFrame: hostFrame,
    });
    if (res.ok === false) {
      return { ok: false, error: toControlError(res.error) };
    }
    const started = res.runtime.start();
    if (started.ok === false) {
      res.runtime.dispose();
      return { ok: false, error: toControlError(started.error) };
    }
    runtime = res.runtime;

    adapter = config.adapter(res.runtime);
    if (adapter !== null && (typeof adapter.renderFrame !== 'function' || typeof adapter.dispose !== 'function')) {
      adapter = null; // a malformed factory result degrades to headless (the game keeps playing)
    }

    if (sceneMode) {
      mounted = true;
      return { ok: true };
    }

    const dom: HostDom = config.document ?? (globalThis as { document?: HostDom }).document ?? { createElement: () => { throw new Error('no document available for the HUD'); } };
    hud = createHud(dom, {
      onStart: () => {
        const c = control('start');
        if (c.ok === false) console.warn('[game-host] Start button rejected', c.error.code);
      },
      onMuteToggle: () => {
        const st = config.audio.status();
        void control(st.state === 'ready' && st.muted ? 'unmute' : 'mute');
      },
    });
    config.container.appendChild(hud.root);
    mounted = true;

    // The authored content is static: the HUD shows it immediately at mount
    // (the per-frame updates follow from the committed view).
    const initial = res.runtime.getGameView();
    hud.update(
      buildHudState(
        initial.ok ? initial.view.state : 'awaitingStart',
        initial.ok ? initial.view.deathCount : 0,
        initial.ok ? initial.view.checkpointActive : false,
        null,
      ),
    );

    // Cue bytes: resolve the non-null authored cue refs through the
    // injected reader (async — the game plays silently until a cue's bytes
    // arrive and decode; the owner skips unregistered assets with a bounded
    // diagnostic). The host stays fetch-free: `readArtifact` is injected.
    if (config.assetPaths !== undefined) {
      const registered = new Set<string>();
      for (const kind of ['start', 'jump', 'checkpoint', 'death', 'goal'] as const) {
        const assetId = cues[kind];
        if (assetId === null || registered.has(assetId)) continue;
        const path = config.assetPaths[assetId];
        if (typeof path !== 'string' || path.length === 0) continue;
        registered.add(assetId);
        void config.readArtifact(path)
          .then((buffer) => {
            if (disposed || !mounted) return;
            const r = config.audio.registerCue(assetId, new Uint8Array(buffer));
            if (r.ok === false) console.warn('[game-host] cue registration failed', r.error.code);
          })
          .catch((error: unknown) => {
            // Bounded: the cue stays unregistered; the owner skips it and
            // the game plays silently (no page error, no unhandled reject).
            console.warn('[game-host] cue artifact read failed', error instanceof Error ? error.message : String(error));
          });
      }
    }
    return { ok: true };
  };

  const observe = ():
    | { ok: true; observation: GameHostObservation }
    | { ok: false; error: GameControlError } => {
    if (disposed) return { ok: false, error: { code: 'host_disposed', message: 'the host is disposed' } };
    if (!mounted || runtime === null) return { ok: false, error: { code: 'host_not_mounted', message: 'the host is not mounted' } };
    const res = runtime.getGameView();
    if (res.ok === false) return { ok: false, error: toControlError(res.error) };
    const v = res.view;
    return {
      ok: true,
      observation: {
        runId: v.runId,
        snapshotId: v.snapshotId,
        buildId: config.buildId,
        stepIndex: v.stepIndex,
        state: v.state,
        checkpointId: v.checkpointId,
        deathCount: v.deathCount,
        goalReached: v.goalReached,
        failed: v.failed,
        sound: mapSoundStatus(config.audio),
        inputMode: 'physical', // the local shell; the relay's exclusive test mode is packet 59
        ...scenesObservation(runtime),
      },
    };
  };

  const scene = (op: 'load' | 'unload', sceneId: string): { ok: true } | { ok: false; error: GameControlError } => {
    if (disposed) return { ok: false, error: { code: 'host_disposed', message: 'the host is disposed' } };
    if (!mounted || runtime === null) return { ok: false, error: { code: 'host_not_mounted', message: 'the host is not mounted' } };
    if (typeof runtime.requestScene !== 'function') return { ok: false, error: { code: 'scene_invalid', message: 'this runtime has no scene set' } };
    const res = runtime.requestScene(op, sceneId);
    if (res.ok === false) return { ok: false, error: toControlError(res.error) };
    return { ok: true };
  };

  const setViewport = (width: number, height: number): { ok: true } | { ok: false; error: GameControlError } => {
    if (disposed) return { ok: false, error: { code: 'host_disposed', message: 'the host is disposed' } };
    if (!mounted || runtime === null) return { ok: false as const, error: { code: 'host_not_mounted', message: 'the host is not mounted' } };
    const res = runtime.setViewport(width, height);
    if (res.ok === false) return { ok: false, error: toControlError(res.error) };
    return { ok: true };
  };

  const dispose = (): void => {
    if (disposed) return; // idempotent (delivery.md §3.1: `dispose(): void`)
    disposed = true;
    mounted = false;
    // The runtime owns the frame driver: stop (cancels it) then dispose.
    // Both are no-ops/errors (never throws) when the driver is already
    // cancelled or the runtime failed.
    if (runtime !== null) {
      try {
        runtime.stop();
        runtime.dispose();
      } catch {
        // The runtime is fail-stopped either way; the host drops its seam.
      }
      runtime = null;
    }
    if (hud !== null) {
      hud.dispose(); // the host-owned HUD DOM + listeners
      hud = null;
    }
    if (adapter !== null) {
      try {
        adapter.dispose(); // the host-CREATED adapter (the wrapper's canvas survives)
      } catch {
        // A failed adapter dispose is bounded: the renderer is gone with
        // the runtime anyway.
      }
      adapter = null;
    }
    // The injected input owner and audio owner are WRAPPER-owned: the host
    // does not dispose them (a new host on the same snapshot reuses them —
    // delivery.md §3.1). Their residual audio voices are short cues that
    // end on their own; the wrapper's final dispose closes the context.
  };

  return {
    mount,
    control,
    observe,
    setViewport,
    dispose,
    scene,
    get runtime(): Runtime {
      if (runtime === null) {
        throw new Error('the host has no runtime (mount first; after dispose the seam is gone)');
      }
      return runtime;
    },
  };
}

/** One manifest behavior row (runtime-content manifest v2 `behaviors[]`). */
export interface ManifestBehaviorRow {
  readonly behaviorId: string;
  readonly sourceDigest: string;
  readonly manifestDigest: string;
  readonly outputDigest: string;
  readonly declaration: unknown;
  readonly ownedTransforms?: readonly string[];
  readonly requiredModules?: readonly string[];
  readonly path: string;
}

/**
 * Link a manifest's compiled behaviors as runtime modules. `load` imports one
 * behavior module by its manifest path (the caller owns the fetch/import, so
 * the host stays fetch-free).
 */
export async function linkBehaviorModules(
  rows: readonly ManifestBehaviorRow[],
  enginePins: readonly { id: string; version: string; apiVersion: number }[],
  load: (path: string) => Promise<unknown>,
): Promise<SimulationModuleSpec[]> {
  const specs: SimulationModuleSpec[] = [];
  for (const row of rows) {
    const namespace = await load(row.path);
    const spec = createBehaviorModuleSpec({
      declaration: row.declaration as never,
      artifact: {
        behaviorId: row.behaviorId,
        sourceDigest: row.sourceDigest,
        manifestDigest: row.manifestDigest,
        outputDigest: row.outputDigest,
        ownedTransforms: row.ownedTransforms ?? [],
        requiredModules: row.requiredModules ?? [],
        enginePins,
        namespace: namespace as never,
      },
    });
    if (spec.id !== behaviorModuleId(row.behaviorId)) throw new Error(`behavior ${row.behaviorId} produced module ${spec.id}`);
    specs.push(spec);
  }
  return specs;
}
