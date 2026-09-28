/**
 * The game host (delivery.md §3.1/§3.2/§4 — packet 55, B04/B08/B09/B13/B15).
 *
 * The LOCAL (in-page) composition: one runtime instance per mounted host,
 * the injected input owner (the browser gameplay + menu channels), the
 * injected audio owner (packet 54), the injected render adapter (the
 * three-adapter, types-only), and the host-owned overlays (project UI, the
 * game shell, letterbox, fade, debug console). The exported page
 * (packets 56–59) composes the SAME entry behind the relay channel; nothing
 * here imports the relay, the backend, the MCP, or the model service.
 *
 * Wiring rules this module enforces:
 *  - the runtime is the single frame driver (the host never adds a loop;
 *    its per-frame work runs as the runtime's `onFrame` — step → host →
 *    adapter render, runtime.md §6);
 *  - the menu/control channel is serviced BETWEEN frames, never on a tick
 *    (delivery.md §4.5: a restart or a UI event rides on the next step's
 *    input frame);
 *  - the host reads the runtime's published views (interpolated state,
 *    UI, audio, camera) and never touches runtime internals or the
 *    adapter's scene graph (one scene-mutation path, C41-1);
 *  - overlays write `textContent` only — project strings are never HTML.
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
  character3DSpec,
  behaviorModuleId,
  createBehaviorModuleSpec,
  createSimulationRegistry,
  instantiateRuntime,
  registerSimulationModule,
  type ActionFrame,
  type ActionSource,
  type CameraViewInfo,
  type UiDocument,
  type UiTheme,
  type SimulationModuleSpec,
  type GameplaySettings,
  type PhysicsPort,
  type PhysicsPort3D,
  type RuntimeError,
  type Runtime,
  type RuntimeSnapshot,
  type LoadedSceneBatch,
  type ModeView,
  type ProjectSaveFile,
} from '@thirdlight/runtime';
import type { MenuSample } from '@thirdlight/input';
import type { AudioObservation, AudioSpatialLike, GameAudioOwner } from './audio';
import type { HostDom, HostDomNode, UiEdges } from './dom';
import { actionPrompts, resolveCursorMode, type InputConfigLike } from './bindings';
import { createInputBindings, type InputBindingsController } from './rebind';
import type { Captured } from './input-bindings';
import { createSettingsStore, type SaveStorage } from './storage';
import { createProjectSaveService, memoryProjectSaveBackend, readProjectSettings, type ProjectSaveBackend, type ProjectSaveService, type ProjectSlotObservation } from './project-saves';
import { createDebugConsole, type DebugConsole } from './debug-console';
import { createUiLayer, type UiLayer, type UiLayerObservation, type UiProjector } from './ui-layer';
import { createPausePanel, type PausePanel } from './pause-panel';
import { createShellController, type ShellConfigLike, type ShellController, type ShellObservation } from './shell';

/** delivery.md §3.1. */
export const GAME_HOST_API_VERSION = 1;

/** delivery.md §3.1 — the bounded game-control actions (`replay`: restart the game). */
export type GameControlAction = 'replay' | 'mute' | 'unmute' | 'clearSave';
export const GAME_CONTROL_ACTIONS: readonly GameControlAction[] = Object.freeze([
  'replay',
  'mute',
  'unmute',
  // Phase 9.11: forget this game's saves and settings (the editor's "clear Play save").
  'clearSave',
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
  /** Phase 9.10: menu edges, key capture and rebinding (the browser owner has them). */
  sampleUi?(): UiEdges;
  captureKey?(onKey: (code: string | null) => void): () => void;
  /** Phase 14.5: the next pad button pressed (the settings screen's pad rebinding). */
  capturePadButton?(onButton: (button: number | null) => void): () => void;
  configure?(config: { actions: readonly { name: string; type: string; map: string; bindings: readonly unknown[] }[] }): void;
  /** Phase 15.5: the device the player used last (the input prompts name its bindings; absent: keyboard). */
  activeDevice?(): 'keyboard' | 'gamepad';
  /** Phase 23.9a: only these input action maps feed the frame (null: every map) — a focused UI document's map. */
  setActiveMaps?(maps: readonly string[] | null): void;
  /** Phase 23.3: the cursor the game wants (free / locked); the owner locks, releases and hides it. */
  applyCursor?(mode: 'free' | 'locked'): void;
  /** Phase 23.3: the cursor as it is (observers). */
  cursorState?(): { mode: 'free' | 'locked'; locked: boolean; hidden: boolean };
  /** Phase 23.14: listen for the next input for a rebind (a cancel key gives null). */
  captureInput?(options: { devices?: readonly ('keyboard' | 'mouse' | 'gamepad')[]; cancelKeys?: readonly string[] }, onInput: (input: Captured | null) => void): () => void;
  /** Phase 23.14: the device used last with the active pad's id. */
  activeDeviceInfo?(): { device: 'keyboard' | 'gamepad'; gamepadId: string | null };
  /** Phase 23.14: what the host adds to the next sampled frame (`ActionFrame.input`). */
  setFrameInput?(source: (() => import('@thirdlight/runtime').InputStatusEntry | undefined) | null): void;
}

/**
 * Phase 23.3, additive: the pointer and the cursor as an observer sees them —
 * the pointer the simulation read last (position in the view, held buttons,
 * over the view, locked), the cursor mode in effect and whether the browser
 * holds the lock / hides it; and the objects scripts hid.
 */
export interface GameHostInputObservation {
  readonly pointer?: { readonly x: number; readonly y: number; readonly buttons: number; readonly over: boolean; readonly locked: boolean };
  readonly cursor?: { readonly mode: 'free' | 'locked'; readonly locked: boolean; readonly hidden: boolean };
  /** The ids of the objects scripts hid (`ctx.game.setVisible`), sorted, at most 64. */
  readonly hidden?: readonly string[];
  /**
   * Phase 23.14: the player's bindings — the device used last (pad id and
   * family), the profile, a rebind listening now, the actions the player
   * changed and each action's glyph for the device used last.
   */
  readonly inputBindings?: ReturnType<InputBindingsController['observe']>;
}

/** The host's structural render-adapter surface (the three-adapter
 * `SceneAdapter` satisfies it; the edge is types-only). */
export interface HostRenderAdapter {
  renderFrame(): { ok: true } | { ok: false; error: unknown };
  dispose(): unknown;
  /** Phase 23.19, optional: draw a frame and return it downscaled (a save slot's picture). */
  captureThumbnail?(width: number, height: number, type: 'image/jpeg' | 'image/webp', quality: number): { dataUrl: string; width: number; height: number } | null;
  /** Phase 23.9a: project an entity or world point through the rendered camera (world-anchored UI widgets). */
  projectToScreen?: UiProjector;
}

/** Phase 23.19: the project saves as observers see them (a project with a save schema). */
export interface ProjectSavesObservation {
  readonly slotCount: number;
  readonly storage: 'indexeddb' | 'memory';
  /** The first 32 used slots. */
  readonly slots: readonly ProjectSlotObservation[];
  readonly settings: Readonly<Record<string, boolean | number | string>>;
}

/** delivery.md §3.1 `GameHostObservation.sound`. */
export interface GameHostSound {
  readonly status: 'ready' | 'muted' | 'blocked' | 'unavailable';
  readonly unlocked: boolean;
  readonly voices: number;
  readonly muted: boolean;
  readonly gesture: 'local' | 'none';
  /** Phase 22.0, additive: sounds the owner has started (scripts' `ctx.audio`, event cues) per bus. */
  readonly played?: { readonly sfx: number; readonly ui: number };
}

/** Phase 23.16: the conversation in the observation (bounded; from the dialogue view model). */
export interface DialogueObservation {
  readonly running: boolean;
  readonly dialogueId: string;
  readonly node: string;
  /** line, choice, signal, wait, or ''. */
  readonly kind: string;
  readonly line: { readonly id: string; readonly speaker: string; readonly name: string; readonly expression: string; readonly portrait: string; readonly text: string; readonly reveal: number; readonly total: number; readonly voiced: boolean } | null;
  readonly choices: readonly string[];
  readonly backlog: number;
  readonly backlogTail: readonly { readonly speaker: string; readonly text: string; readonly choice: boolean }[];
  readonly backlogOpen: boolean;
  readonly skip: boolean;
  readonly auto: boolean;
}

/**
 * Phase 24.6: the play state every game reports — the simulation runs, or the
 * engine pause holds it (a menu, the pause panel, a game mode's pause).
 * `stopped` is the play's end (a disposed host has nothing to observe).
 */
export type PlayState = 'running' | 'paused' | 'stopped';

/** Phase 23.18: the environment preset blend as observed (the frame's interpolated weights). */
export interface GameHostEnvironmentObservation {
  readonly target: string | null;
  readonly progress: number;
  readonly weights: Readonly<Record<string, number>>;
}

/**
 * delivery.md §3.1 `GameHostObservation` (phase 24.7: the one observation —
 * every game plays as a scene): its step and time, the play state, the sound
 * status, where its character (the controller entity) is, in 3D, and the
 * additive blocks of the systems the game uses.
 */
export interface GameHostObservation {
  readonly snapshotId: string;
  readonly buildId: string;
  readonly stepIndex: number;
  readonly simTime: number;
  /** Phase 24.6: the generic play state. */
  readonly state: PlayState;
  readonly sound: GameHostSound;
  readonly inputMode: 'physical' | 'test';
  readonly player?: { readonly x: number; readonly y: number; readonly z: number };
  /** Phase 12 (c), additive: the loaded scenes and the ones being loaded. */
  readonly scenes?: { readonly loaded: readonly string[]; readonly loading: readonly string[] };
  /** Phase 9.10, additive: the audio sources' live loops (entity id → gain). */
  readonly loops?: Readonly<Record<string, number>>;
  /** Phase 23.4, additive: the resolved camera while the game has virtual cameras (live camera, blend, pose, lens, letterbox). */
  readonly camera?: CameraViewInfo;
  /** Phase 23.18, additive: the environment preset blend once a script changed it (target, progress, weights by key; '' = the base look). */
  readonly environment?: GameHostEnvironmentObservation;
  /** Phase 23.13, additive: the Web Audio graph (live voices with gain/pan/rate, music, buses, listener) once scripts used audio or a positional loop plays. */
  readonly audio?: AudioObservation;
  /** Phase 23.9a, additive: the project UI — the documents shown, the screen's document, the focus. */
  readonly ui?: UiLayerObservation;
  /** Phase 23.16, additive: the conversation (once the project's dialogue ran). */
  readonly dialogue?: DialogueObservation;
  /** Phase 23.3, additive: the pointer, the cursor and the objects scripts hid. */
  readonly pointer?: GameHostInputObservation['pointer'];
  readonly cursor?: GameHostInputObservation['cursor'];
  readonly hidden?: readonly string[];
  /** Phase 23.14, additive: the player's bindings (device, profile, listening, changed actions, glyphs). */
  readonly inputBindings?: GameHostInputObservation['inputBindings'];
  /** Phase 23.11, additive: the objects riding on sockets (only while some do) and their world positions. */
  readonly sockets?: readonly SocketObservation[];
  /** Phase 23.10, additive: the game modes (only a project with modes) and the engine pause. */
  readonly mode?: ModeView;
  readonly paused?: boolean;
  /** Phase 23.10, additive: the engine's pause panel (a paused game with modes and no pause screen of its own). */
  readonly pausePanel?: { readonly focus: 'resume' | 'restart' };
  /** Phase 23.19, additive: the project saves (slot metadata, settings document). */
  readonly saves?: ProjectSavesObservation;
  /** Phase 23.17, additive: the timelines (screen fade/letterbox, plays, the last step's events) once one played. */
  readonly timeline?: import('@thirdlight/runtime').TimelineView;
  /** Phase 24.4j, additive: the game shell (its screen, the listed scene, the HUD shown). */
  readonly shell?: ShellObservation;
  /** Phase 24.7, additive: the named counters (at most 32) and every object's health (object id → current/max; at most 64) — Play and the export alike. */
  readonly counters?: Readonly<Record<string, number>>;
  readonly health?: Readonly<Record<string, { readonly current: number; readonly max: number }>>;
}

/** Phase 23.11: one object riding on a socket, as the host observes it (its interpolated world position). */
export interface SocketObservation {
  readonly entityId: string;
  readonly target: string;
  readonly node: string;
  readonly position: readonly [number, number, number];
}

/** delivery.md §3.1 `GameControlResult` (accepted submissions; the
 * runtime's own rejection rule passes through its structured error). */
export type GameControlError =
  | { code: string; reason?: string; command?: string; state?: string; message: string };

export type GameControlResult =
  | { readonly ok: true; readonly state: PlayState; readonly acceptedAtStep: number }
  | { readonly ok: false; readonly error: GameControlError };

/**
 * Phase 23.8: where a test or debug start begins (Play from…, `tl_play_start`)
 * — resolved by the backend against the project, applied by the host at mount.
 */
export interface GameStartOptions {
  /** The scenes the game starts with (the start scenes plus the chosen one). */
  readonly scenes?: readonly string[];
  /** ...and the player spawn it starts at (absent: the game's own). */
  readonly spawnId?: string;
  /** Phase 23.10: the game mode the run starts in (validated by the backend against the project's modes). */
  readonly mode?: string;
  /** Phase 23.19: a project save document loaded at the first step (slot 0), or a project save slot of this page. */
  readonly projectSave?: ProjectSaveFile;
  readonly projectSaveSlot?: number;
}

/** Phase 23.8: what became of the start options (`GameHost.startOutcome`). */
export type GameStartOutcome = { readonly ok: true; readonly applied: readonly string[] } | { readonly ok: false; readonly reason: string };

/** delivery.md §3.1 `GameHostConfig` (+ the additive CC-55-1/CC-55-2 fields). */
export interface GameHostConfig {
  /** The runtime snapshot (validated by the runtime at instantiate). */
  readonly snapshot: RuntimeSnapshot;
  /** The resolved gameplay settings (the wrapper passes the manifest's
   * `gameplaySettings` or the model default). */
  readonly settings: GameplaySettings;
  /** The injected physics port (physics-rapier in the preview; a fake in
   * tests). Absent: a game without physics. */
  readonly physics?: PhysicsPort | PhysicsPort3D;
  /** The project's compiled behaviors (see `linkBehaviorModules`), run with the scene. */
  readonly behaviorModules?: readonly SimulationModuleSpec[];
  /**
   * The manifest's required engine module ids (derived by the build from the
   * declared dependencies). The host registers exactly these simulation
   * modules and checks the port modules it needs are injected; an id it
   * cannot provide is `host_module_unresolved`. Absent ⇒ none (phase 24.3:
   * there is no default set).
   */
  readonly modules?: readonly string[];
  /**
   * Phase 24.3: the simulation module specs this composition provides beyond
   * the runtime's built-ins, keyed by their manifest module id (`spec.id`)
   * and listed in dependency order (a module after those it needs). The
   * composition entry (the Play preview, the export bootstrap, the
   * simulation worker) registers them; the host imports no module package.
   */
  readonly moduleSpecs?: readonly SimulationModuleSpec[];
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
  /** The overlay root element the host draws into (UI documents, letterbox, fade, console). */
  readonly container: HostDomNode;
  /** ADDITIVE (CC-55-1): the verified manifest buildId → `observe().buildId`. */
  readonly buildId: string;
  /** ADDITIVE (CC-55-1): assetId → manifest-declared relative path; the host
   * resolves non-null cue refs through `readArtifact` at mount. */
  readonly assetPaths?: Record<string, string>;
  /** The DOM document for overlay element creation (default: the environment's
   * `document`; Node tests inject a fake). */
  readonly document?: HostDom;
  /**
   * Phase 12 (c), additive: fetch one scene the game asked for and return
   * its resolved entities (the wrapper reads and verifies the manifest's
   * `scenes/<sceneId>.json`; see `sceneEntitiesFromDocument`). Absent: loads
   * fail with a diagnostic and the game keeps its start scenes.
   */
  readonly loadScene?: (sceneId: string) => Promise<LoadedSceneBatch['entities']>;
  /** Phase 24.4j: the manifest's game shell (menus and HUD as UI documents, the scene list) — a game that plays as a scene. */
  readonly shell?: ShellConfigLike;
  /** Phase 9.10: the input actions the game runs with (the settings screen rebinds them). */
  readonly inputConfig?: { actions: readonly { name: string; type: string; map: string; bindings: readonly unknown[] }[]; cursor?: { [map: string]: 'free' | 'locked' | undefined } };
  /** Phase 9.10: each declared asset's kind (the host registers every audio asset for scripts, event cues and audio sources). */
  readonly assetKinds?: Readonly<Record<string, string>>;
  /** Phase 9.11: where the player's settings go (localStorage in the browser; see `storage.ts`) and this game's key prefix. */
  readonly saveStorage?: SaveStorage;
  readonly saveNamespace?: string;
  /**
   * Phase 23.19: where project save slots go (IndexedDB in the browser; see
   * `browserProjectSaveBackend`), under `saveNamespace`. Absent with a save
   * schema: slots last for this page only (a memory store).
   */
  readonly projectSaveBackend?: ProjectSaveBackend;
  /** Phase 9.10: apply a player's quality setting (the wrapper forwards it to the renderer). */
  readonly setQuality?: (level: 'low' | 'medium' | 'high') => void;
  /**
   * Phase 22.0: where the simulation runs. Absent: in this page — `mount()`
   * composes the runtime (`composeGameRuntime`) with `physics`,
   * `behaviorModules` and `modules`. Present: the wrapper already composed
   * it elsewhere (the simulation worker) and this factory returns the
   * runtime the host presents (a mirror of the worker's; `onFrame` runs
   * after each simulated frame arrives). Everything else — UI, shell, audio,
   * saves, the adapter — stays in this page either way.
   */
  readonly runtimeFactory?: (onFrame: () => void) => { readonly ok: true; readonly runtime: Runtime } | { readonly ok: false; readonly error: GameControlError };
  /**
   * Phase 23.8: script variables the scripts see in `ctx.save` from step 0
   * (used when the host composes the runtime; a worker gets them in its init).
   */
  readonly variables?: Readonly<Record<string, unknown>>;
  /** Phase 23.8: a test/debug start (see `GameStartOptions`). */
  readonly start?: GameStartOptions;
  /**
   * Phase 23.8: show the in-game debug console (the backquote key). Play
   * always passes true; an export only with the project's `debug_console`
   * setting on. Absent: no console.
   */
  readonly debugConsole?: boolean;
  /** Phase 23.8: give the keyboard back to the game (the console closed). */
  readonly focusGame?: () => void;
  /**
   * Phase 23.13: how audio sources are heard — `legacy` (phase 9.10: louder as
   * the player comes near along X, no panning; absent) or `panner` (a panner
   * per source, the listener on the active camera, the source's distance
   * model). Script sounds with a place always use the panner.
   */
  readonly audioSpatial?: 'legacy' | 'panner';
  /**
   * Phase 23.9a: the project UI (the manifest's documents and themes). The
   * host draws the documents the simulation and the shell show; absent or
   * empty: no project UI.
   */
  readonly ui?: { readonly documents: readonly UiDocument[]; readonly themes?: readonly UiTheme[] };
}

/** delivery.md §3.1 `GameHost`. */
export interface GameHost {
  /** The binding §3.1 members. */
  mount(): { readonly ok: true } | { readonly ok: false; readonly error: GameControlError };
  control(action: GameControlAction): GameControlResult;
  observe():
    | { readonly ok: true; readonly observation: GameHostObservation }
    | { readonly ok: false; readonly error: GameControlError };
  /** delivery.md §3.1: `dispose(): void` (idempotent). */
  dispose(): void;
  /** ADDITIVE (CC-55-1b): the host's runtime seam (read-only; the manual
   * driver / Node compositions advance frames through it). */
  readonly runtime: Runtime;
  /** Phase 12 (c), additive: request a scene load/unload (the same rules as a script's `ctx.scenes`). */
  scene(op: 'load' | 'unload', sceneId: string): { readonly ok: true } | { readonly ok: false; readonly error: GameControlError };
  /**
   * Phase 23.8, additive: run a project debug command — queued into the next
   * simulation step's input (so a recording of the run replays it). The
   * result carries the step it was accepted at; refused when no script
   * declared the command or the arguments do not match.
   */
  debugCommand?(name: string, args?: Readonly<Record<string, number | string | boolean>>): GameControlResult;
  /** Phase 23.8, additive: the in-game debug console (null: this game has none). */
  readonly debugConsole?: DebugConsole | null;
  /** Phase 23.8, additive: what became of `config.start` (null: no start options). */
  readonly startOutcome?: GameStartOutcome | null;
  /** Phase 23.19, additive: the project saves service (null: the project declares no save schema). */
  readonly projectSaves?: ProjectSaveService | null;
  /**
   * Phase 23.14, additive: the rebinding API (list, listen, conflicts, reset,
   * profiles, the device used last, glyphs) — for project UI and tools; null
   * before mount or without an input config.
   */
  readonly bindings?: InputBindingsController | null;
}

// --- the sound-status mapping (delivery.md §3.1 `sound.status`) -----------

export function mapSoundStatus(owner: GameAudioOwner): GameHostSound {
  const st = owner.status();
  if (st.state === 'ready') {
    const played = owner.soundsPlayed?.();
    return {
      status: st.muted ? 'muted' : 'ready',
      unlocked: st.unlocked,
      voices: owner.liveVoices(),
      muted: st.muted,
      gesture: st.unlocked ? 'local' : 'none',
      ...(played !== undefined ? { played } : {}),
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
  if (!isPlainObject(config.container)) return 'config.container must be the overlay root element';
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
 * instance and overlays; the input owner, audio owner, and canvas are
 * wrapper-owned and injected (a new host on the same snapshot reuses them).
 */
/**
 * The runtime's own simulation modules a manifest can name (phase 23.2: the
 * 3D character controller). Every other simulation module comes from the
 * composition's injected spec table (`moduleSpecs`, phase 24.3).
 */
const RUNTIME_SIMULATION_SPECS: readonly SimulationModuleSpec[] = [character3DSpec];
/** The port modules the delivery wrapper injects (checked, not registered). */
const PORT_MODULES = new Set(['thirdlight.physics-rapier:2d', 'thirdlight.physics-rapier:3d', 'thirdlight.input:keyboard-gamepad', 'thirdlight.three-adapter:gltf-loader']);

/**
 * Select the simulation modules from the manifest's module list (the build's
 * derived set) out of the runtime's built-ins and the injected spec table.
 * Phase 24.3: no list, no modules — the host has no default set. The
 * selected specs register in table order (built-ins first, then the
 * injected table's dependency order).
 */
function selectModules(
  modulesIn: readonly string[] | undefined,
  table: readonly SimulationModuleSpec[],
  hasPhysics: boolean,
  entities: readonly { readonly components?: unknown }[],
): { ok: true; specs: SimulationModuleSpec[] } | { ok: false; error: GameControlError } {
  if (modulesIn === undefined) return { ok: true, specs: [] };
  const byId = new Map<string, SimulationModuleSpec>();
  for (const spec of table) if (!byId.has(spec.id)) byId.set(spec.id, spec);
  const picked = new Set<SimulationModuleSpec>();
  const ports: string[] = [];
  for (const id of modulesIn) {
    const spec = byId.get(id);
    if (spec !== undefined) {
      picked.add(spec);
      continue;
    }
    if (id === 'thirdlight.demo:box-motion') continue; // a runtime built-in (already registered)
    if (PORT_MODULES.has(id)) {
      ports.push(id);
      continue;
    }
    return { ok: false, error: { code: 'host_module_unresolved', message: `module ${id} is required but this engine does not provide it` } };
  }
  // A module's entity requirement is its own declaration (phase 24.3).
  for (const spec of picked) {
    for (const component of spec.requiresEntityWith ?? []) {
      if (!entities.some((e) => ((e.components ?? {}) as Record<string, unknown>)[component] !== undefined)) {
        return { ok: false, error: { code: 'host_config_invalid', reason: component, message: `module ${spec.id} needs an entity with a ${component} component; the scene has none` } };
      }
    }
  }
  for (const id of ports) {
    if ((id === 'thirdlight.physics-rapier:2d' || id === 'thirdlight.physics-rapier:3d') && !hasPhysics) {
      return { ok: false, error: { code: 'host_module_unresolved', message: `module ${id} is required but no physics port was injected` } };
    }
  }
  return { ok: true, specs: [...byId.values()].filter((spec) => picked.has(spec)) };
}

/**
 * Phase 22.0: what the simulation needs to run — the single place the game's
 * runtime is composed (module selection, the registry, `instantiateRuntime`,
 * `start`). The in-page host calls it in `mount()`; the simulation worker
 * calls it with the same inputs, so both run the same deterministic steps.
 */
export interface GameRuntimeArgs {
  readonly snapshot: RuntimeSnapshot;
  readonly settings: GameplaySettings;
  readonly physics?: PhysicsPort | PhysicsPort3D;
  readonly behaviorModules?: readonly SimulationModuleSpec[];
  readonly modules?: readonly string[];
  /** Phase 24.3: the injected simulation module specs (see `GameHostConfig.moduleSpecs`). */
  readonly moduleSpecs?: readonly SimulationModuleSpec[];
  readonly actions: ActionSource;
  readonly onFrame?: () => void;
  /** The frame driver (absent: rAF where the environment has it, else manual). A worker passes manual: the main thread drives it. */
  readonly driver?: { readonly kind: 'raf' | 'manual' };
  /** Phase 23.8: script variables injected at the start (ctx.save from step 0). */
  readonly variables?: Readonly<Record<string, unknown>>;
  /** Phase 23.10: the game mode runs start in (a start option). */
  readonly startMode?: string;
  /** Phase 23.19: the stored project settings document. */
  readonly projectSettings?: Readonly<Record<string, unknown>>;
}

/** Phase 22.0: compose and start the game's runtime (see `GameRuntimeArgs`). */
export function composeGameRuntime(args: GameRuntimeArgs): { ok: true; runtime: Runtime } | { ok: false; error: GameControlError } {
  const snapshot = args.snapshot;
  const scene = snapshot.scene;
  if (scene.schemaVersion !== 3 && scene.schemaVersion !== 4) {
    return { ok: false, error: { code: 'host_config_invalid', reason: 'snapshot', message: 'the game host requires a v3 or v4 snapshot' } };
  }

  const registry = createSimulationRegistry();
  // The registry carries the runtime built-ins (inert unless selected —
  // the M2 export-composition pattern); the SELECTED modules are the ones
  // the manifest names (phase 24.3: resolved through the runtime's specs and
  // the injected table), plus the project's compiled behaviors.
  for (const spec of BUILTIN_MODULES) registerSimulationModule(registry, spec.id, spec);
  // (the typed `EntityComponents` union is per-schema; component presence is read structurally.)
  const selected = selectModules(args.modules, [...RUNTIME_SIMULATION_SPECS, ...(args.moduleSpecs ?? [])], args.physics !== undefined, scene.entities as readonly { readonly components?: unknown }[]);
  if (!selected.ok) return selected;
  const modules: string[] = [];
  for (const spec of selected.specs) {
    const r = registerSimulationModule(registry, spec.id, spec);
    if (r.ok === false) {
      return { ok: false, error: { code: 'host_module_registration_failed', message: `registering ${spec.id} failed: ${r.error.message}` } };
    }
    modules.push(spec.id);
  }
  for (const spec of args.behaviorModules ?? []) {
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
    actions: args.actions,
    ...(args.physics !== undefined ? { physics: args.physics } : {}),
    settings: args.settings,
    // Phase 15.3: the project's step rate (absent: the runtime's 120 Hz).
    ...(args.settings.fixed_step_hz !== undefined ? { fixedStepHz: args.settings.fixed_step_hz } : {}),
    ...(args.onFrame !== undefined ? { onFrame: args.onFrame } : {}),
    ...(args.driver !== undefined ? { driver: { kind: args.driver.kind } } : {}),
    ...(args.variables !== undefined ? { variables: args.variables } : {}),
    ...(args.startMode !== undefined ? { startMode: args.startMode } : {}),
    ...(args.projectSettings !== undefined ? { projectSettings: args.projectSettings } : {}),
  });
  if (res.ok === false) {
    return { ok: false, error: toControlError(res.error) };
  }
  const started = res.runtime.start();
  if (started.ok === false) {
    res.runtime.dispose();
    return { ok: false, error: toControlError(started.error) };
  }
  return { ok: true, runtime: res.runtime };
}

export function createGameHost(config: GameHostConfig): GameHost {
  const invalid = validateConfig(config);
  const configError: GameControlError = invalid !== null
    ? { code: 'host_config_invalid', reason: 'config', message: invalid }
    : { code: 'host_config_invalid', reason: 'config', message: 'invalid game host config' };

  let disposed = false;
  let mounted = false;
  let runtime: Runtime | null = null;
  /**
   * Phase 15.5: the bindings the game runs with — the project's actions with
   * the player's saved rebinding and any rebinding made while playing. The
   * input prompts name these.
   */
  let promptInput: InputConfigLike = config.inputConfig ?? { actions: [] };
  /** Phase 24.4j: the game shell (a game with `content.shell`). */
  let shellCtl: ShellController | null = null;
  /** Phase 23.14: the player's bindings (created at mount when the game has an input config). */
  let bindings: InputBindingsController | null = null;
  /** Phase 23.14: the project's glyph images as object URLs (loaded on first use). */
  const glyphUrls = new Map<string, string | null>();
  const glyphImageUrl = (assetId: string): string | null => {
    if (glyphUrls.has(assetId)) return glyphUrls.get(assetId)!;
    glyphUrls.set(assetId, null);
    const path = config.assetPaths?.[assetId];
    const urls = (globalThis as { URL?: { createObjectURL?: (b: Blob) => string } }).URL;
    if (typeof path === 'string' && typeof urls?.createObjectURL === 'function' && typeof Blob === 'function') {
      void config.readArtifact(path).then(
        (buffer) => {
          if (!disposed) glyphUrls.set(assetId, urls.createObjectURL!(new Blob([buffer])));
        },
        () => undefined,
      );
    }
    return null;
  };
  let adapter: HostRenderAdapter | null = null;
  /** Phase 23.8: the debug console (config.debugConsole) and what became of config.start. */
  let debugConsole: DebugConsole | null = null;
  let startOutcome: GameStartOutcome | null = null;
  /** Phase 23.19: project saves (a project with a save schema). */
  const saveSchema = config.snapshot.saveSchema;
  const saveNamespace = config.saveNamespace ?? `thirdlight:${String((config.snapshot as { projectId?: string }).projectId ?? 'game')}`;
  let projectSaves: ProjectSaveService | null = null;
  const savesObservation = (): { saves?: ProjectSavesObservation } =>
    projectSaves === null || saveSchema === undefined
      ? {}
      : { saves: { slotCount: saveSchema.slots, storage: projectSaves.storage, slots: projectSaves.slots().slice(0, 32), settings: { ...(runtime?.projectSettings?.() ?? projectSaves.settings()) } } };
  /** Phase 23.9a: the project UI layer (null without UI documents). */
  let uiLayer: UiLayer | null = null;
  /**
   * Phase 23.10: the engine pause of a game with game modes and no shell (the
   * mode allows it), the engine's pause panel (a mode without a pause screen
   * of its own), and the input maps in effect: a focused UI document's action
   * map, else the current mode's maps, else every map.
   */
  let scenePaused = false;
  let pausePanel: PausePanel | null = null;
  let modeMaps: readonly string[] | null = null;
  let uiMaps: readonly string[] | null = null;
  let appliedMaps = '*';
  const applyMaps = (): void => {
    const effective = uiMaps ?? modeMaps;
    const key = effective === null ? '*' : effective.join(',');
    if (key === appliedMaps) return;
    appliedMaps = key;
    config.input.setActiveMaps?.(effective);
  };
  /** The current mode (null: the game has none); its input maps become the input's active maps. */
  const serviceModes = (rt: Runtime): ModeView | null => {
    const mv = rt.modeView?.() ?? null;
    const maps = mv === null ? null : mv.inputMaps;
    if ((maps === null ? '*' : maps.join(',')) !== (modeMaps === null ? '*' : modeMaps.join(','))) {
      modeMaps = maps;
      applyMaps();
    }
    return mv;
  };
  /** A restart of the game: an input-frame entry (so recordings replay it). */
  const sceneRestart = (): void => {
    const r = runtime?.queueUiEvent?.({ kind: 'restart', doc: '', widget: '', name: '' });
    if (r !== undefined && r.ok === false) console.warn('[game-host] restart refused:', r.error.message);
    setScenePause(false);
  };
  const setScenePause = (on: boolean): void => {
    const rt = runtime;
    if (rt === null || on === scenePaused) return;
    const mv = rt.modeView?.() ?? null;
    if (on && (mv === null || !mv.pause)) return;
    scenePaused = on;
    rt.setPaused?.(on);
    if (on) {
      if (mv!.pauseScreen !== undefined && uiLayer !== null) uiLayer.showScreen(mv!.pauseScreen);
      else if (hostDom !== null) {
        pausePanel ??= createPausePanel(hostDom, config.container, { resume: () => setScenePause(false), restart: sceneRestart });
        pausePanel.show();
      }
    } else {
      uiLayer?.showScreen(null);
      pausePanel?.hide();
    }
  };
  /** Phase 24.4j: the input prompts generated from the declared actions (the active maps; the rebinding's labels for the device used last). */
  let promptsCache: { key: string; list: ReturnType<typeof actionPrompts> } | null = null;
  const currentActionPrompts = (): ReturnType<typeof actionPrompts> => {
    const key = `${bindings?.revision() ?? 0}|${config.input.activeDevice?.() ?? 'keyboard'}|${modeMaps?.join(',') ?? ''}`;
    if (promptsCache !== null && promptsCache.key === key) return promptsCache.list;
    const b = bindings;
    const list = actionPrompts(promptInput, b !== null ? (name) => b.glyph(name)?.label ?? '' : undefined, modeMaps ?? ['gameplay']);
    promptsCache = { key, list };
    return list;
  };
  const promptsText = (): string => currentActionPrompts().map((p) => p.text).join(' · ');

  /** Phase 24.4j: the game shell over this runtime (its seams: the engine pause, UI events, project saves, the UI layer). */
  const makeShell = (rt: Runtime): ShellController =>
    createShellController({
      shell: config.shell!,
      showScreen: (docId) => uiLayer?.showScreen(docId),
      setHud: (ids) => uiLayer?.setHud(ids),
      setPaused: (on) => {
        scenePaused = on;
        rt.setPaused?.(on);
      },
      restart: () => {
        const r = rt.queueUiEvent?.({ kind: 'restart', doc: '', widget: '', name: '' });
        if (r !== undefined && r.ok === false) console.warn('[game-host] restart refused:', r.error.message);
      },
      goToScene: (index) => {
        const r = rt.queueUiEvent?.({ kind: 'scene', doc: '', widget: '', name: '', value: index });
        if (r !== undefined && r.ok === false) console.warn('[game-host] scene move refused:', r.error.message);
      },
      listedScene: () => rt.listedSceneIndex?.() ?? -1,
      saves:
        projectSaves !== null && saveSchema !== undefined
          ? {
              slotCount: saveSchema.slots,
              slots: () => projectSaves?.slots() ?? [],
              save: (slot, meta) => {
                const r = rt.requestSave?.(slot, meta);
                return r === undefined ? 'this runtime cannot save' : r.ok ? null : r.error.message;
              },
              load: (slot) => void projectSaves?.loadSlot(slot),
            }
          : null,
      pauseAllowed: () => {
        const mv = rt.modeView?.() ?? null;
        return mv === null || mv.pause;
      },
      modePauseScreen: () => rt.modeView?.()?.pauseScreen,
      pausePanel: () => {
        if (hostDom === null) return null;
        pausePanel ??= createPausePanel(hostDom, config.container, {
          resume: () => shellCtl?.engine({ do: 'engine', action: 'resume' }),
          restart: () => shellCtl?.engine({ do: 'engine', action: 'restartLevel' }),
        });
        return pausePanel;
      },
      setVolume: (bus, value) => config.audio.setVolume?.(bus, value),
      setQuality: (q) => config.setQuality?.(q),
      ...(config.saveStorage !== undefined ? { storage: config.saveStorage } : {}),
      namespace: saveNamespace,
      prompts: promptsText,
      ...(hostDom !== null ? { dom: hostDom } : {}),
      container: config.container,
      log: (message) => console.warn(`[game-host] ${message}`),
    });

  /** A project UI document's engine action in a game without a shell (with modes: pause, resume, restart). */
  const sceneEngineAction = (a: { readonly action: string }): void => {
    switch (a.action) {
      case 'resume':
      case 'back':
        setScenePause(false);
        break;
      case 'pause':
        setScenePause(true);
        break;
      case 'restartLevel':
      case 'newGame':
      case 'quitToTitle':
        sceneRestart();
        break;
      default:
        break; // settings and saves belong to the game shell
    }
  };
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

  /** Phase 21.2: one entity's interpolated transform into `out` (the allocation-free read when the runtime has it). */
  const playerAt = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
  const sourceAt = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
  const readTransform = (rt: Runtime, id: string, out: { position: number[]; rotation: number[]; scale: number[] }): boolean => {
    if (rt.readInterpolated !== undefined) return rt.readInterpolated(id, out.position, out.rotation, out.scale);
    const st = rt.getInterpolatedState();
    const t = st.ok ? st.state.transforms.find((x) => x.id === id) : undefined;
    if (t === undefined) return false;
    for (let k = 0; k < 3; k += 1) out.position[k] = t.position[k]!;
    for (let k = 0; k < 4; k += 1) out.rotation[k] = t.rotation[k]!;
    for (let k = 0; k < 3; k += 1) out.scale[k] = t.scale[k]!;
    return true;
  };

  /**
   * Phase 23.4: the letterbox bars — two black bars over the top and bottom of
   * the view, each the live camera's share of the view height (interpolated
   * like the camera; blended between cameras). Made the first time a camera
   * asks for one; a game without virtual cameras never has them.
   */
  let letterbox: { readonly top: HostDomNode; readonly bottom: HostDomNode; shown: string } | null = null;
  let hostDom: HostDom | null = null;
  const lbPos: number[] = [0, 0, 0];
  const lbRot: number[] = [0, 0, 0, 1];
  /**
   * Phase 23.3: the cursor mode in effect, handed to the input owner every
   * frame: the ui map's setting while a menu is open or the game is paused,
   * else a script's request or the setting of the active maps (phase 25.6:
   * a focused document's or the game mode's maps; every map without modes).
   */
  const serviceCursor = (rt: Runtime): void => {
    if (config.input.applyCursor === undefined) return;
    const menu = rt.isPaused === true;
    config.input.applyCursor(resolveCursorMode(config.inputConfig as InputConfigLike | undefined, menu ? 'menu' : (uiMaps ?? modeMaps), rt.cursorRequest?.() ?? null));
  };

  /** Phase 23.3: the pointer and cursor as an observer sees them, and the objects scripts hid. */
  const inputObservation = (rt: Runtime): GameHostInputObservation => {
    const p = rt.readPointer?.() ?? null;
    const cursor = config.input.cursorState?.();
    const hidden = rt.hiddenEntities?.();
    return {
      ...(p !== null ? { pointer: { x: p.x, y: p.y, buttons: p.buttons ?? 0, over: p.over !== false, locked: p.locked === true } } : {}),
      ...(cursor !== undefined ? { cursor: { mode: cursor.mode, locked: cursor.locked, hidden: cursor.hidden } } : {}),
      ...(hidden !== undefined && hidden.size > 0 ? { hidden: [...hidden].sort().slice(0, 64) } : {}),
      ...(bindings !== null ? { inputBindings: bindings.observe() } : {}),
    };
  };

  /** Phase 23.14: the bindings as UI documents read them (`$flow.input`), rebuilt when they change. */
  let inputUi: { key: string; value: Record<string, unknown> } | null = null;
  const inputUiValues = (): Record<string, unknown> => {
    const b = bindings!;
    const l = b.listening();
    const key = `${b.revision()}|${l === null ? '' : `${l.action}:${l.index}:${l.part ?? ''}`}`;
    if (inputUi !== null && inputUi.key === key) return inputUi.value;
    const d = b.device();
    const value = {
      device: d.kind,
      family: d.family ?? null,
      profile: b.profile(),
      listening: l === null ? null : { ...l },
      actions: b.actions().map((a) => ({
        name: a.name,
        map: a.map,
        changed: a.changed === true,
        keys: b.glyph(a.name, 'keyboardMouse')?.label ?? '',
        pad: b.glyph(a.name, 'gamepad')?.label ?? '',
        glyph: b.glyph(a.name)?.label ?? '',
      })),
    };
    inputUi = { key, value };
    return value;
  };

  /** Phase 23.14: the rebind timeout, the device used last and the scripts' binding requests (after each frame). */
  const serviceBindings = (rt: Runtime): void => {
    const taken = rt.takeBindingRequests?.();
    if (bindings === null) return;
    bindings.tick();
    if (taken === undefined) return;
    if (taken.requests.length > 0) bindings.handle(taken.requests);
    if (taken.dropped > 0) console.warn(`[game-host] ${taken.dropped} binding request(s) dropped: at most 8 a step`);
  };

  const serviceLetterbox = (rt: Runtime): void => {
    const lens = rt.readCameraView?.(lbPos, lbRot) ?? null;
    // Phase 23.17: a timeline's letterbox track shows over the camera's (the larger bars win).
    const tlBars = rt.timelineView?.()?.screen.letterbox ?? 0;
    const amount = Math.max(lens === null || !Number.isFinite(lens.letterbox) ? 0 : Math.max(0, Math.min(0.5, lens.letterbox)), Number.isFinite(tlBars) ? Math.max(0, Math.min(0.5, tlBars)) : 0);
    if (letterbox === null) {
      if (amount <= 0 || hostDom === null) return;
      const top = hostDom.createElement('div');
      const bottom = hostDom.createElement('div');
      top.setAttribute?.('data-tl-letterbox', 'top');
      bottom.setAttribute?.('data-tl-letterbox', 'bottom');
      config.container.appendChild(top);
      config.container.appendChild(bottom);
      letterbox = { top, bottom, shown: '' };
    }
    const pct = String(Math.round(amount * 10000) / 100);
    if (letterbox.shown === pct) return;
    letterbox.shown = pct;
    const bar = (edge: 'top' | 'bottom'): string => `position:fixed;left:0;right:0;${edge}:0;height:${pct}%;background:#000;pointer-events:none;z-index:4;${amount > 0 ? '' : 'display:none;'}`;
    // Through the CSSOM (a page's content security policy may refuse style attributes).
    const apply = (node: HostDomNode, css: string): void => {
      const styled = node as HostDomNode & { style?: { cssText?: string } };
      if (styled.style !== undefined) styled.style.cssText = css;
      else node.setAttribute?.('style', css);
    };
    apply(letterbox.top, bar('top'));
    apply(letterbox.bottom, bar('bottom'));
  };

  /**
   * Phase 23.17: a timeline's full-screen fade — one element over the view and
   * the letterbox bars, under the project UI (a title can show over black).
   * Made the first time a timeline fades; `data-tl-fade` carries the opacity.
   */
  let fadeNode: { readonly node: HostDomNode; shown: string } | null = null;
  const serviceFade = (rt: Runtime): void => {
    const screen = rt.timelineView?.()?.screen;
    const opacity = screen === undefined || !Number.isFinite(screen.opacity) ? 0 : Math.max(0, Math.min(1, screen.opacity));
    if (fadeNode === null) {
      if (opacity <= 0 || hostDom === null) return;
      const node = hostDom.createElement('div');
      node.setAttribute?.('data-tl-fade', '0');
      config.container.appendChild(node);
      fadeNode = { node, shown: '' };
    }
    const color = screen !== undefined && /^#[0-9a-f]{6}$/.test(screen.fade) ? screen.fade : '#000000';
    const key = `${color}|${Math.round(opacity * 1000) / 1000}`;
    if (fadeNode.shown === key) return;
    fadeNode.shown = key;
    const css = `position:fixed;inset:0;background:${color};opacity:${Math.round(opacity * 1000) / 1000};pointer-events:none;z-index:5;${opacity > 0 ? '' : 'display:none;'}`;
    const styled = fadeNode.node as HostDomNode & { style?: { cssText?: string } };
    if (styled.style !== undefined) styled.style.cssText = css;
    else fadeNode.node.setAttribute?.('style', css);
    fadeNode.node.setAttribute?.('data-tl-fade', String(Math.round(opacity * 1000) / 1000));
  };

  /** Phase 23.17: the timelines as observers see them (once one played). */
  const timelineObservation = (rt: Runtime): { timeline?: import('@thirdlight/runtime').TimelineView } => {
    const v = rt.timelineView?.() ?? null;
    return v === null ? {} : { timeline: v };
  };

  /** Phase 9.10: the loaded audio sources (recomputed when the scene set changes). */
  let sourcesRevision = -1;
  let sources: { id: string; assetId: string; volume: number; range: number; spatial: AudioSpatialLike }[] = [];
  const liveLoops = new Set<string>();
  const musicAsked = new Set<string>();
  /** The character (the first controller entity; null: none) — the legacy audio-source model hears from it. */
  let characterId: string | null | undefined;
  const serviceAudioSources = (rt: Runtime): void => {
    if (config.audio.setLoop === undefined) return;
    const set = rt.sceneSet?.();
    const revision = set?.revision ?? 0;
    if (revision !== sourcesRevision) {
      sourcesRevision = revision;
      const loaded = set !== undefined && set.batches.length > 0 ? set.batches.flatMap((b) => b.entities) : config.snapshot.scene.entities;
      // Phase 14.1: a spawned copy's audio source plays too.
      const entities = [...loaded, ...((set?.spawned ?? []) as unknown as typeof loaded)];
      sources = [];
      for (const e of entities) {
        const a = ((e.components ?? {}) as unknown as { audioSource?: { assetId: string; volume: number; range: number; distanceModel?: AudioSpatialLike['distanceModel']; refDistance?: number; rolloff?: number } }).audioSource;
        // Phase 23.13: the panner model's distance fade — the range is its max distance; absent fields keep the
        // legacy curve's shape (linear from a quarter of the range).
        if (a !== undefined) sources.push({ id: e.id, assetId: a.assetId, volume: a.volume, range: a.range, spatial: { distanceModel: a.distanceModel ?? 'linear', refDistance: Math.min(a.range, a.refDistance ?? a.range / 4), maxDistance: a.range, rolloff: a.rolloff ?? 1 } });
      }
      // A music-kind source needs its bytes registered (once).
      for (const s of sources) {
        if (config.assetKinds?.[s.assetId] !== 'music' || musicAsked.has(s.assetId)) continue;
        musicAsked.add(s.assetId);
        const path = config.assetPaths?.[s.assetId];
        if (typeof path === 'string' && config.audio.registerMusic !== undefined) {
          void config.readArtifact(path)
            .then((buffer) => {
              if (!disposed) config.audio.registerMusic?.(s.assetId, new Uint8Array(buffer));
            })
            .catch(() => undefined);
        }
      }
    }
    if (sources.length === 0 && liveLoops.size === 0) return;
    // Phase 21.2: only the character and the sources are read (no per-frame copy of every transform).
    characterId ??= config.snapshot.scene.entities.find((e) => ((e.components ?? {}) as unknown as Record<string, unknown>)['controller'] !== undefined)?.id ?? null;
    const player = characterId !== null && readTransform(rt, characterId, playerAt) ? playerAt : undefined;
    const seen = new Set<string>();
    for (const s of sources) {
      if (!readTransform(rt, s.id, sourceAt)) continue;
      const t = sourceAt;
      if (panner && config.audio.setSpatialLoop !== undefined) {
        // Phase 23.13: a panner per source; the listener is the active camera (spatialFrame).
        config.audio.setSpatialLoop(s.id, s.assetId, s.volume, t.position, s.spatial);
        seen.add(s.id);
        liveLoops.add(s.id);
        continue;
      }
      const dx = player !== undefined ? Math.abs(t.position[0]! - player.position[0]!) : 0;
      const near = s.range / 4;
      const gain = s.volume * Math.max(0, Math.min(1, 1 - (dx - near) / Math.max(1e-6, s.range - near)));
      config.audio.setLoop(s.id, s.assetId, gain);
      seen.add(s.id);
      liveLoops.add(s.id);
    }
    for (const id of [...liveLoops]) {
      if (seen.has(id)) continue;
      config.audio.setLoop(id, null, 0);
      liveLoops.delete(id);
    }
  };

  /** Phase 23.13: audio sources in the panner model (the project's `audio_spatial`). */
  const panner = config.audioSpatial === 'panner';
  /** Script sounds: execute the simulation's audio commands (music-kind assets get their bytes on first use). */
  const scriptMusicAsked = new Set<string>();
  const serviceScriptAudio = (rt: Runtime): void => {
    const commands = rt.takeAudioRequests?.() ?? [];
    for (const c of commands) {
      const assetId = c.op === 'play' || c.op === 'music' ? c.assetId : null;
      if (assetId !== null && config.assetKinds?.[assetId] === 'music' && !scriptMusicAsked.has(assetId) && !musicAsked.has(assetId)) {
        scriptMusicAsked.add(assetId);
        const path = config.assetPaths?.[assetId];
        if (typeof path === 'string' && config.audio.registerMusic !== undefined) {
          void config.readArtifact(path)
            .then((buffer) => {
              if (!disposed) config.audio.registerMusic?.(assetId, new Uint8Array(buffer));
            })
            .catch(() => undefined);
        }
      }
      if (config.audio.command !== undefined) config.audio.command(c);
      else if (c.op === 'play') config.audio.playSound?.(c.assetId, c.volume);
    }
    if (config.audio.spatialFrame !== undefined) config.audio.spatialFrame(listenerOf(rt), (entityId) => (readTransform(rt, entityId, spatialAt) ? spatialAt.position : null));
  };
  const spatialAt = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
  const listenerAt = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
  let cameraEntityId: string | null | undefined;
  /** The listener: the active camera — the resolved virtual camera (phase 23.4), else the scene camera. */
  const listenerOf = (rt: Runtime): { position: readonly number[]; rotation: readonly number[] } | null => {
    if (rt.readCameraView?.(listenerAt.position, listenerAt.rotation) != null) return listenerAt;
    cameraEntityId ??= config.snapshot.scene.entities.find((e) => ((e.components ?? {}) as unknown as Record<string, unknown>)['camera'] !== undefined)?.id ?? null;
    if (cameraEntityId !== null && readTransform(rt, cameraEntityId, listenerAt)) return listenerAt;
    return null;
  };

  /** Phase 23.9a: the simulation's UI diff, then the layer's frame (bindings, $flow values, the view size). */
  const serviceUi = (rt: Runtime): void => {
    if (uiLayer === null) return;
    const out = rt.takeUiOutput?.() ?? null;
    if (out !== null) uiLayer.applyOutput(out);
    uiLayer.frame();
  };
  /** Phase 23.9a: world-anchored widgets follow the frame just rendered. */
  const serviceAnchors = (): void => {
    const project = adapter?.projectToScreen;
    if (uiLayer !== null && project !== undefined) uiLayer.updateAnchors(project);
  };

  const hostFrame = (): void => {
    if (disposed || !mounted || runtime === null) return;
    serviceSceneRequests(runtime);
    debugConsole?.frame();
    serviceBindings(runtime);
    serviceUi(runtime);
    // (1) The menu/control channel — serviced BETWEEN frames, never on a
    // tick (delivery.md §4.5). What it asks for (a restart, a UI event)
    // rides on the next step's input frame.
    const menu: MenuSample = config.input.sampleMenu();
    // Phase 23.9a: a focused project UI document takes the ui edges it uses (navigation, submit, its cancel) first.
    const uiFocus = uiLayer !== null && uiLayer.hasFocus();
    // Phase 23.10: the game modes (their input maps); a game with modes has the engine pause.
    const modeView = serviceModes(runtime);
    if (shellCtl !== null) {
      // Phase 24.4j: the game shell takes what the focused document left (pause, cancel, the pause panel's navigation).
      const raw = config.input.sampleUi?.() ?? { up: false, down: false, left: false, right: false, submit: menu.confirm, cancel: false, pause: false };
      const rest = uiFocus ? uiLayer!.handleEdges(raw) : raw;
      shellCtl.handleEdges(rest);
    } else if (modeView !== null) {
      const raw = config.input.sampleUi?.() ?? { up: false, down: false, left: false, right: false, submit: menu.confirm, cancel: false, pause: false };
      const rest = uiFocus ? uiLayer!.handleEdges(raw) : raw;
      if (rest.pause) setScenePause(!scenePaused);
      else if (pausePanel?.shown === true) pausePanel.handleEdges(rest);
    } else if (uiFocus) {
      const edges = config.input.sampleUi?.();
      if (edges !== undefined) uiLayer!.handleEdges(edges);
      else if (menu.confirm) uiLayer!.handleEdges({ up: false, down: false, left: false, right: false, submit: true, cancel: false, pause: false });
    }
    if (menu.mute) {
      const st = config.audio.status();
      void control(st.state === 'ready' && st.muted ? 'unmute' : 'mute');
    }
    // (2) The overlays, sounds and the adapter — read from the runtime's
    // published views; no runtime internals, no scene-graph mutation (C41-1).
    // Phase 23.4: the live camera's letterbox (an overlay the host draws over the view).
    serviceLetterbox(runtime);
    // Phase 23.17: a timeline's fade over the view.
    serviceFade(runtime);
    // Phase 23.3: the cursor (free/locked per input map, a script's request; hidden while a gamepad drives).
    serviceCursor(runtime);
    // Phase 23.19: the simulation's save requests (a thumbnail is drawn now, in this frame).
    if (projectSaves !== null) {
      const reqs = runtime.takeSaveRequests?.() ?? [];
      if (reqs.length > 0) projectSaves.handle(reqs);
    }
    // Phase 23.13: the sounds of scripts and event cues (the runtime's audio intent log), and the audio sources' loops.
    serviceScriptAudio(runtime);
    serviceAudioSources(runtime);
    adapter?.renderFrame();
    serviceAnchors();
  };

  /** Phase 24.6: the generic play state (the engine pause, a menu or the debugger hold the simulation). */
  const playState = (): PlayState => (disposed ? 'stopped' : runtime?.isPaused === true || scenePaused ? 'paused' : 'running');

  const control = (action: GameControlAction): GameControlResult => {
    if (disposed) return { ok: false, error: { code: 'host_disposed', message: 'the host is disposed' } };
    if (!mounted || runtime === null) {
      return { ok: false, error: { code: 'host_not_mounted', message: 'the host is not mounted' } };
    }
    switch (action) {
      case 'replay': {
        // Phase 24.6: replay restarts the game (the pause panel's restart: an input-frame entry, so a recording replays it).
        if (runtime.queueUiEvent === undefined) return { ok: false, error: { code: 'game_command_invalid', reason: 'replay', message: 'this runtime cannot restart' } };
        const q = runtime.queueUiEvent({ kind: 'restart', doc: '', widget: '', name: '' });
        if (q.ok === false) return { ok: false, error: toControlError(q.error) };
        break;
      }
      case 'clearSave':
        if (config.saveStorage !== undefined && config.saveNamespace !== undefined) createSettingsStore(config.saveStorage, config.saveNamespace).clear();
        // Phase 24.7: and the project save slots (the level flow's saves this cleared were deleted).
        void projectSaves?.clear();
        break;
      case 'mute':
        config.audio.setMuted(true);
        break;
      case 'unmute':
        config.audio.setMuted(false);
        break;
    }
    return { ok: true, state: playState(), acceptedAtStep: stepNow(runtime) };
  };

  /** The runtime's current step (0 when its diagnostics are unavailable). */
  const stepNow = (rt: Runtime): number => {
    const d = rt.getDiagnostics();
    return d.ok ? d.diagnostics.stepIndex : 0;
  };

  /**
   * Phase 23.8: apply the start options — the start scenes plus the chosen
   * one (loaded) and the spawn the character arrives at, a project save, a
   * game mode.
   */
  const applyStart = (rt: Runtime, start: GameStartOptions): GameStartOutcome => {
    const applied: string[] = [];
    if (start.scenes !== undefined && start.scenes.length > 0) {
      const loaded = new Set(rt.sceneSet?.().batches.map((b) => b.sceneId) ?? []);
      for (const id of start.scenes) {
        if (loaded.has(id)) continue;
        const r = rt.requestScene?.('load', id);
        if (r === undefined || !r.ok) return { ok: false, reason: r === undefined ? 'this game has no scenes to load' : r.error.message };
      }
      // Phase 24.6: the character starts at the chosen scene's spawn (arriving once that scene is loaded).
      if (start.spawnId !== undefined) {
        const r = rt.requestArrival?.(start.scenes[start.scenes.length - 1]!, start.spawnId);
        if (r === undefined || !r.ok) return { ok: false, reason: r === undefined ? 'this game cannot place the character' : r.error.message };
        applied.push(`spawn ${start.spawnId}`);
      }
      applied.push(`scenes ${start.scenes.join(', ')}`);
    }
    // Phase 23.19: a project save document or slot (loaded at the first step).
    if (start.projectSave !== undefined || start.projectSaveSlot !== undefined) {
      if (projectSaves === null) return { ok: false, reason: 'a project save needs a project save schema' };
      if (start.projectSave !== undefined) {
        projectSaves.loadDocument(start.projectSave);
        applied.push('project save');
      } else {
        void projectSaves.loadSlot(start.projectSaveSlot!);
        applied.push(`project save slot ${start.projectSaveSlot!}`);
      }
    }
    // Phase 23.10: the run started in this mode (the runtime was composed with it).
    if (start.mode !== undefined) {
      const mv = rt.modeView?.() ?? null;
      if (mv === null) applied.push(`mode ${start.mode} (ignored: the game has no modes)`);
      else if (!mv.modes.includes(start.mode)) return { ok: false, reason: `the game has no mode "${start.mode}"` };
      else applied.push(`mode ${start.mode}`);
    }
    return { ok: true, applied };
  };

  /** Phase 23.8: queue one debug command call into the next step's input. */
  const debugCommand = (name: string, args: Readonly<Record<string, number | string | boolean>> = {}): GameControlResult => {
    if (disposed) return { ok: false, error: { code: 'host_disposed', message: 'the host is disposed' } };
    if (!mounted || runtime === null) return { ok: false, error: { code: 'host_not_mounted', message: 'the host is not mounted' } };
    if (typeof runtime.queueDebugCommand !== 'function') return { ok: false, error: { code: 'game_command_invalid', reason: 'debug_command', message: 'this game has no debug commands' } };
    const r = runtime.queueDebugCommand({ name, args });
    if (!r.ok) return { ok: false, error: toControlError(r.error) };
    return { ok: true, state: playState(), acceptedAtStep: stepNow(runtime) };
  };

  /** The audio assets' bytes for the owner (scripts' sounds, event cues, audio sources). */
  const registerSounds = (): void => {
    // Resolve every audio asset through the injected reader (async — the
    // game plays silently until a sound's bytes arrive and decode; the owner
    // skips unregistered assets with a bounded diagnostic). The host stays
    // fetch-free: `readArtifact` is injected.
    if (config.assetPaths !== undefined) {
      const registered = new Set<string>();
      const soundIds = Object.entries(config.assetKinds ?? {}).filter(([, k]) => k === 'audio').map(([id]) => id);
      for (const assetId of soundIds) {
        if (registered.has(assetId)) continue;
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
  };

  const mount = (): { ok: true } | { ok: false; error: GameControlError } => {
    if (disposed) return { ok: false, error: { code: 'host_disposed', message: 'the host is disposed' } };
    if (mounted) return { ok: false, error: { code: 'host_already_mounted', message: 'the host is already mounted (dispose before remounting)' } };
    if (configError.reason === 'config' && configError.message !== 'invalid game host config') {
      return { ok: false, error: configError };
    }
    const snapshot = config.snapshot;
    // Phase 22.0: the simulation runs where the wrapper chose — composed here
    // in this page, or in a worker (the factory hands over its mirror runtime,
    // composed by the worker with the same `composeGameRuntime`).
    let composed: { ok: true; runtime: Runtime } | { ok: false; error: GameControlError };
    if (config.runtimeFactory !== undefined) {
      composed = config.runtimeFactory(hostFrame);
    } else {
      composed = composeGameRuntime({
        snapshot,
        settings: config.settings,
        ...(config.physics !== undefined ? { physics: config.physics } : {}),
        ...(config.behaviorModules !== undefined ? { behaviorModules: config.behaviorModules } : {}),
        ...(config.modules !== undefined ? { modules: config.modules } : {}),
        ...(config.moduleSpecs !== undefined ? { moduleSpecs: config.moduleSpecs } : {}),
        actions: config.input,
        onFrame: hostFrame,
        ...(config.variables !== undefined ? { variables: config.variables } : {}),
        ...(saveSchema !== undefined ? { projectSettings: readProjectSettings(saveSchema, config.saveStorage, saveNamespace) } : {}),
        ...(config.start?.mode !== undefined ? { startMode: config.start.mode } : {}),
      });
    }
    if (!composed.ok) return composed;
    const res = { runtime: composed.runtime };
    runtime = res.runtime;

    adapter = config.adapter(res.runtime);
    if (adapter !== null && (typeof adapter.renderFrame !== 'function' || typeof adapter.dispose !== 'function')) {
      adapter = null; // a malformed factory result degrades to headless (the game keeps playing)
    }

    // Phase 23.4: the document the overlays (letterbox bars, fade, UI documents) are made in.
    hostDom = config.document ?? (globalThis as { document?: HostDom }).document ?? null;
    const dom: HostDom = hostDom ?? { createElement: () => { throw new Error('no document available for the overlays'); } };
    if (config.debugConsole === true) {
      const rt0 = res.runtime;
      debugConsole = createDebugConsole({
        dom,
        container: config.container,
        state: () => rt0.debugCommandState?.() ?? null,
        run: (name, args) => {
          const r = debugCommand(name, args);
          return r.ok ? { ok: true } : { ok: false, message: r.error.message };
        },
        ...(config.focusGame !== undefined ? { focusGame: config.focusGame } : {}),
      });
    }

    // Phase 23.19: project saves — the page owns the slots; the simulation gets the list and answers as input.
    if (saveSchema !== undefined) {
      const rtS = res.runtime;
      projectSaves = createProjectSaveService({
        schema: saveSchema,
        backend: config.projectSaveBackend ?? memoryProjectSaveBackend(),
        namespace: saveNamespace,
        queue: (event) => {
          if (disposed) return;
          const r = rtS.queueSaveEvent?.(event);
          if (r !== undefined && !r.ok) console.warn('[game-host] save answer refused:', r.error.message);
        },
        ...(config.saveStorage !== undefined ? { settingsStorage: config.saveStorage } : {}),
        captureThumbnail: (w, h, type, q) => adapter?.captureThumbnail?.(w, h, type, q) ?? null,
        applyEngine: (binding, value) => {
          if (binding === 'quality') {
            if (value === 'low' || value === 'medium' || value === 'high') config.setQuality?.(value);
          } else if (typeof value === 'number') config.audio.setVolume?.(binding, value);
        },
        log: (message) => console.warn(`[game-host] ${message}`),
      });
      void projectSaves.start();
    }
    // Phase 23.14: the player's bindings (saved per profile).
    if (config.inputConfig !== undefined) {
      bindings = createInputBindings({
        defaults: config.inputConfig,
        input: config.input,
        ...(config.saveStorage !== undefined && config.saveNamespace !== undefined ? { store: createSettingsStore(config.saveStorage, config.saveNamespace) } : {}),
        onChange: (c) => {
          promptInput = c as InputConfigLike;
        },
        imageUrl: glyphImageUrl,
      });
    }

    // Phase 23.9a: the project UI layer.
    if (config.ui !== undefined && config.ui.documents.length > 0 && hostDom !== null) {
      const rt = res.runtime;
      uiLayer = createUiLayer({
        dom: hostDom,
        container: config.container,
        documents: config.ui.documents,
        ...(config.ui.themes !== undefined ? { themes: config.ui.themes } : {}),
        ...(config.assetPaths !== undefined ? { assetPaths: config.assetPaths } : {}),
        readArtifact: config.readArtifact,
        queueEvent: (event) => {
          const r = rt.queueUiEvent?.(event);
          if (r !== undefined && r.ok === false) console.warn('[game-host] UI event refused:', r.error.message);
        },
        // Phase 23.16: the dialogue UI's buttons (advance, choose, skip, auto, backlog) ride on the next input frame.
        dialogueInput: (input) => {
          const r = rt.queueDialogueInput?.(input);
          if (r !== undefined && r.ok === false) console.warn('[game-host] dialogue input refused:', r.error.message);
        },
        engineAction: (a) => {
          // Phase 23.14: rebinding from project UI (the same bindings API as scripts and the settings screen).
          if (a.action === 'rebind' || a.action === 'cancelRebind' || a.action === 'resetBindings') {
            if (bindings === null) return;
            const ex = a as { input?: string; device?: 'keyboardMouse' | 'gamepad'; index?: number; part?: 'negative'; policy?: 'swap' };
            if (a.action === 'cancelRebind') bindings.cancel();
            else if (a.action === 'resetBindings') bindings.reset(ex.input);
            else if (ex.input !== undefined) bindings.listen(ex.input, { ...(ex.device !== undefined ? { device: ex.device } : {}), ...(ex.index !== undefined ? { index: ex.index } : {}), ...(ex.part !== undefined ? { part: ex.part } : {}), ...(ex.policy !== undefined ? { policy: ex.policy } : {}) });
            return;
          }
          if (a.action === 'mute' || a.action === 'unmute') {
            void control(a.action);
            return;
          }
          // Phase 23.10: a game without a shell has the engine pause (with modes) and the restart.
          if (shellCtl !== null) shellCtl.engine(a);
          else sceneEngineAction(a);
        },
        // Phase 23.14: `$flow.input` — the device used last, the rebind listening and every action's keys/pad glyph (a project settings document lists them).
        // Phase 24.4j: + the game shell, the named counters, every object's health and the generated input prompts.
        flowValues: () => {
          const rtNow = runtime;
          return {
            ...(bindings !== null ? { input: inputUiValues() } : {}),
            ...(shellCtl !== null ? { shell: shellCtl.values() } : {}),
            counters: rtNow?.gameCounters?.().counters ?? {},
            health: rtNow?.healthsView?.() ?? {},
            prompts: promptsText(),
            promptList: currentActionPrompts(),
          };
        },
        // Phase 23.14: {action:name} glyphs in UI texts.
        ...(bindings !== null
          ? {
              glyph: (action: string) => {
                const g = bindings?.glyph(action) ?? null;
                return g === null || bindings === null ? null : { label: g.label, icon: g.icon, url: bindings.glyphImage(g) };
              },
              glyphKey: () => String(bindings?.revision() ?? 0),
            }
          : {}),
        // Phase 23.10: a focused document's map wins over the game mode's maps (applyMaps).
        ...(config.input.setActiveMaps !== undefined
          ? {
              setActiveMaps: (maps: readonly string[] | null) => {
                uiMaps = maps;
                applyMaps();
              },
            }
          : {}),
      });
    }
    // Phase 24.4j: the game shell (a title, pause, settings, controls, save/load screens and the HUD as UI documents).
    if (config.shell !== undefined) shellCtl = makeShell(res.runtime);
    mounted = true;
    // Phase 23.13: script sounds, event cues and audio sources.
    registerSounds();
    if (config.start !== undefined) startOutcome = applyStart(res.runtime, config.start);
    // A start given by a test or the debugger begins in play (no title).
    shellCtl?.start(config.start !== undefined);
    return { ok: true };
  };

  /** Phase 23.10: the game modes, the engine pause and its panel (a project with modes). */
  const modeObservation = (rt: Runtime): { mode?: ModeView; paused?: boolean; pausePanel?: { focus: 'resume' | 'restart' } } => {
    const mv = rt.modeView?.() ?? null;
    if (mv === null) return {};
    return { mode: mv, paused: scenePaused, ...(pausePanel?.shown === true ? { pausePanel: { focus: pausePanel.focus } } : {}) };
  };

  /** Phase 23.11: the objects riding on sockets and where they are (world position, composed up their parents). */
  const socketsObservation = (rt: Runtime): { sockets?: SocketObservation[] } => {
    const list = rt.socketAttachments?.() ?? [];
    if (list.length === 0) return {};
    const parents = new Map<string, string>();
    for (const e of config.snapshot.scene.entities as readonly { id: string; parentId?: string }[]) if (e.parentId !== undefined) parents.set(e.id, e.parentId);
    const p = [0, 0, 0];
    const r = [0, 0, 0, 1];
    const s = [1, 1, 1];
    const worldOf = (id: string): [number, number, number] | null => {
      if (rt.readInterpolated === undefined || !rt.readInterpolated(id, p, r, s)) return null;
      let x = p[0]!, y = p[1]!, z = p[2]!;
      for (let cur = parents.get(id), guard = 0; cur !== undefined && guard < 64; cur = parents.get(cur), guard += 1) {
        if (!rt.readInterpolated(cur, p, r, s)) break;
        // x := parentPos + parentRot · (parentScale ⊙ x)
        const sx = x * s[0]!, sy = y * s[1]!, sz = z * s[2]!;
        const [ax, ay, az, aw] = r as [number, number, number, number];
        const tx = 2 * (ay * sz - az * sy), ty = 2 * (az * sx - ax * sz), tz = 2 * (ax * sy - ay * sx);
        x = p[0]! + sx + aw * tx + (ay * tz - az * ty);
        y = p[1]! + sy + aw * ty + (az * tx - ax * tz);
        z = p[2]! + sz + aw * tz + (ax * ty - ay * tx);
      }
      return [x, y, z];
    };
    const out: SocketObservation[] = [];
    for (const a of list.slice(0, 64)) {
      const at = worldOf(a.entityId);
      if (at !== null) out.push({ entityId: a.entityId, target: a.target, node: a.node, position: at });
    }
    return out.length > 0 ? { sockets: out } : {};
  };

  /**
   * Phase 23.16: the conversation as the dialogue UI shows it (read from the
   * view model the runner publishes, so threaded Play reports it the same).
   */
  const dialogueObservation = (rt: Runtime): { dialogue?: DialogueObservation } => {
    const d = (rt.uiView?.().model as { dialogue?: Record<string, unknown> } | undefined)?.dialogue;
    if (d === undefined || d === null || typeof d !== 'object') return {};
    const line = d['line'] as Record<string, unknown> | null | undefined;
    const choices = Array.isArray(d['choices']) ? (d['choices'] as { text?: unknown }[]) : [];
    const backlog = Array.isArray(d['backlog']) ? (d['backlog'] as { text?: unknown; speaker?: unknown; choice?: unknown }[]) : [];
    const str = (v: unknown, n = 256): string => (typeof v === 'string' ? v.slice(0, n) : '');
    return {
      dialogue: {
        running: d['active'] === true,
        dialogueId: str(d['dialogueId'], 64),
        node: str(d['node'], 64),
        kind: str(d['kind'], 16),
        line:
          line !== null && line !== undefined && typeof line === 'object'
            ? { id: str(line['id'], 64), speaker: str(line['speaker'], 64), name: str(line['plainName'], 64), expression: str(line['expression'], 32), portrait: str(line['portrait'], 64), text: str(line['text']), reveal: typeof line['reveal'] === 'number' ? line['reveal'] : 0, total: typeof line['total'] === 'number' ? line['total'] : 0, voiced: line['voiced'] === true }
            : null,
        choices: choices.slice(0, 16).map((c) => str(c.text, 128)),
        backlog: backlog.length,
        backlogTail: backlog.slice(-8).map((b) => ({ speaker: str(b.speaker, 64), text: str(b.text, 128), choice: b.choice === true })),
        backlogOpen: d['backlogOpen'] === true,
        skip: d['skipMode'] === true,
        auto: d['autoMode'] === true,
      },
    };
  };

  /** Phase 23.18: the environment blend, once a script changed it (weights by key: '' the base look, a preset id, a patched preset's key). */
  const environmentObservation = (rt: Runtime): { environment?: GameHostEnvironmentObservation } => {
    const v = rt.readEnvironmentBlend?.() ?? null;
    if (v === null) return {};
    const weights: Record<string, number> = {};
    for (const [k, w] of v.weights) weights[k] = w;
    return { environment: { target: v.target, progress: v.progress, weights } };
  };

  /** Phase 23.4: the resolved camera, while the game has virtual cameras. */
  const cameraObservation = (rt: Runtime): { camera?: CameraViewInfo } => {
    const c = rt.cameraView?.() ?? null;
    return c === null ? {} : { camera: c };
  };

  const observe = ():
    | { ok: true; observation: GameHostObservation }
    | { ok: false; error: GameControlError } => {
    if (disposed) return { ok: false, error: { code: 'host_disposed', message: 'the host is disposed' } };
    if (!mounted || runtime === null) return { ok: false, error: { code: 'host_not_mounted', message: 'the host is not mounted' } };
    const snap = config.snapshot;
    const d = runtime.getDiagnostics();
    const player = snap.scene.entities.find((e) => ((e.components ?? {}) as unknown as Record<string, unknown>)['controller'] !== undefined);
    const st = player !== undefined ? runtime.getInterpolatedState() : null;
    const tr = st !== null && st.ok ? st.state.transforms.find((t) => t.id === player!.id) : undefined;
    return {
      ok: true,
      observation: {
        snapshotId: snap.snapshotId,
        buildId: config.buildId,
        stepIndex: d.ok ? d.diagnostics.stepIndex : 0,
        simTime: d.ok ? d.diagnostics.simTime : 0,
        state: playState(),
        sound: mapSoundStatus(config.audio),
        inputMode: 'physical',
        ...(tr !== undefined ? { player: { x: tr.position[0], y: tr.position[1], z: tr.position[2] } } : {}),
        ...scenesObservation(runtime),
        ...(liveLoops.size > 0 && config.audio.loops !== undefined ? { loops: config.audio.loops() } : {}),
        ...cameraObservation(runtime),
        ...environmentObservation(runtime),
        ...audioObservation(),
        ...socketsObservation(runtime),
        ...savesObservation(),
        ...(uiLayer !== null ? { ui: uiLayer.observe() } : {}),
        ...dialogueObservation(runtime),
        ...inputObservation(runtime),
        ...modeObservation(runtime),
        ...timelineObservation(runtime),
        ...(shellCtl !== null ? { shell: shellCtl.observe(), paused: scenePaused } : {}),
        ...countersAndHealth(runtime),
      },
    };
  };

  /** Phase 24.7: the named counters and every object's health (bounded; absent while empty). */
  const countersAndHealth = (rt: Runtime): Pick<GameHostObservation, 'counters' | 'health'> => {
    const c = Object.entries(rt.gameCounters?.().counters ?? {}).slice(0, 32);
    const hp = Object.entries(rt.healthsView?.() ?? {}).slice(0, 64);
    return {
      ...(c.length > 0 ? { counters: Object.fromEntries(c) } : {}),
      ...(hp.length > 0 ? { health: Object.fromEntries(hp.map(([id, x]) => [id, { current: x.current, max: x.max }])) } : {}),
    };
  };

  /** Phase 23.13: the Web Audio graph, once scripts used audio or a positional loop plays. */
  const audioObservation = (): { audio?: AudioObservation } => {
    const a = config.audio.observeAudio?.() ?? null;
    return a === null ? {} : { audio: a };
  };

  const scene = (op: 'load' | 'unload', sceneId: string): { ok: true } | { ok: false; error: GameControlError } => {
    if (disposed) return { ok: false, error: { code: 'host_disposed', message: 'the host is disposed' } };
    if (!mounted || runtime === null) return { ok: false, error: { code: 'host_not_mounted', message: 'the host is not mounted' } };
    if (typeof runtime.requestScene !== 'function') return { ok: false, error: { code: 'scene_invalid', message: 'this runtime has no scene set' } };
    const res = runtime.requestScene(op, sceneId);
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
    // Phase 21.5: what this host started on the wrapper-owned audio owner
    // stops with it — the loops of audio sources — so a new composition on
    // the same owner (a new Play snapshot) does not keep the old one's loops
    // playing.
    if (config.audio.setLoop !== undefined) {
      for (const id of liveLoops) {
        try {
          config.audio.setLoop(id, null, 0);
        } catch {
          /* a closed context: nothing plays */
        }
      }
    }
    liveLoops.clear();
    // Phase 23.13: and the scripts' sounds, music hold, duck and mix.
    try {
      config.audio.command?.({ op: 'reset', stepIndex: 0 });
    } catch {
      /* a closed context: nothing plays */
    }
    debugConsole?.dispose();
    debugConsole = null;
    bindings?.dispose();
    for (const url of glyphUrls.values()) if (url !== null) (globalThis as { URL?: { revokeObjectURL?: (u: string) => void } }).URL?.revokeObjectURL?.(url);
    glyphUrls.clear();
    if (uiLayer !== null) {
      uiLayer.dispose();
      uiLayer = null;
    }
    shellCtl?.dispose();
    shellCtl = null;
    pausePanel?.dispose();
    pausePanel = null;
    // Phase 23.10: the input's maps back to every map (the owner outlives this host).
    if (appliedMaps !== '*') {
      appliedMaps = '*';
      config.input.setActiveMaps?.(null);
    }
    if (letterbox !== null) {
      letterbox.top.remove();
      letterbox.bottom.remove();
      letterbox = null;
    }
    if (fadeNode !== null) {
      fadeNode.node.remove();
      fadeNode = null;
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
    // delivery.md §3.1). Its loops and music were stopped above; residual
    // cues end on their own; the wrapper's final dispose closes the context.
  };

  return {
    mount,
    control,
    observe,
    dispose,
    scene,
    debugCommand,
    get debugConsole(): DebugConsole | null {
      return debugConsole;
    },
    get projectSaves(): ProjectSaveService | null {
      return projectSaves;
    },
    get bindings(): InputBindingsController | null {
      return bindings;
    },
    get startOutcome(): GameStartOutcome | null {
      return startOutcome;
    },
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

