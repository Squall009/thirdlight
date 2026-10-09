/**
 * The game host.
 *
 * The LOCAL (in-page) composition: one runtime instance per mounted host,
 * the injected input owner (the browser gameplay + menu channels), the
 * injected audio owner, the injected render adapter (the
 * three-adapter, types-only), and the host-owned overlays (project UI, the
 * game shell, letterbox, fade, debug console). The exported page
 * composes the SAME entry behind the relay channel; nothing
 * here imports the relay, the backend, the MCP, or the model service.
 *
 * Wiring rules this module enforces:
 *  - the runtime is the single frame driver (the host never adds a loop;
 *    its per-frame work runs as the runtime's `onFrame` — step → host →
 *    adapter render);
 *  - the menu/control channel is serviced BETWEEN frames, never on a tick
 *    (a restart or a UI event rides on the next step's
 *    input frame);
 *  - the host reads the runtime's published views (interpolated state,
 *    UI, audio, camera) and never touches runtime internals or the
 *    adapter's scene graph (one scene-mutation path);
 *  - overlays write `textContent` only — project strings are never HTML.
 *
 * Additive over the binding host surface (the binding members are
 * unchanged):
 *  - `GameHostConfig.buildId` — the verified manifest buildId the wrapper
 *    passed (the `GameHostObservation.buildId` field is unsatisfiable
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
 *    surface exposes none).
 */
import {
  BUILTIN_MODULES,
  ENGINE_STATS_NONE,
  type BehaviorStats,
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
import type { ScenePreloader } from './scene-preload';
import type { ResourceManager, RuntimeDiagnostics } from '@thirdlight/runtime';
import { createHostAssets, type GameResourcesObservation, type HostAssets } from './host-assets';
import { createHostAudio, type AudioRow, type HostAudio, type HostAudioConfig } from './host-audio';
import type { MenuSample } from '@thirdlight/input';
import type { AudioObservation, AudioSpatialLike, GameAudioOwner } from './audio';
import type { HostDom, HostDomNode, UiEdges } from './dom';
import { actionPrompts, resolveCursorMode, type InputConfigLike } from './bindings';
import { createInputBindings, type InputBindingsController } from './rebind';
import type { Captured } from './input-bindings';
import { createSettingsStore, type SaveStorage } from './storage';
import { readProjectSettings, type DeviceStorage, type ProjectSaveBackend, type ProjectSaveService } from './project-saves';
import { savesObservation as savesObservationOf, shellSaves, slotPictures, startHostSaves, type ProjectSavesObservation } from './host-saves';
import { createDebugConsole, type DebugConsole } from './debug-console';
import { createHostStats } from './frame-stats';
import { createStatsOverlay, statsOverlayModeOf, type StatsOverlay } from './stats-overlay';
import { createUiLayer, pageUiView, type UiElementObservation, type UiLayer, type UiLayerObservation, type UiProjector } from './ui-layer';
import { hitUiTargets, type UiHitTarget } from './ui-hit';
import { createPausePanel, type PausePanel } from './pause-panel';
import { createShellController, type ShellConfigLike, type ShellController, type ShellObservation } from './shell';
import { createReadAhead } from './scene-read-ahead';

export const GAME_HOST_API_VERSION = 1;

/** The bounded game-control actions (`replay`: restart the game). */
export type GameControlAction = 'replay' | 'mute' | 'unmute' | 'clearSave';
export const GAME_CONTROL_ACTIONS: readonly GameControlAction[] = Object.freeze([
  'replay',
  'mute',
  'unmute',
  // Forget this game's saves and settings (the editor's "clear Play save").
  'clearSave',
]);

/** The four bridge message names (the relay channel consumes these; the
 * local host defines the constant). */
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
  /** Menu edges, key capture and rebinding (the browser owner has them). */
  sampleUi?(): UiEdges;
  captureKey?(onKey: (code: string | null) => void): () => void;
  /** The next pad button pressed (the settings screen's pad rebinding). */
  capturePadButton?(onButton: (button: number | null) => void): () => void;
  configure?(config: { actions: readonly { name: string; type: string; map: string; bindings: readonly unknown[] }[] }): void;
  /** The device the player used last (the input prompts name its bindings; absent: keyboard). */
  activeDevice?(): 'keyboard' | 'gamepad';
  /** Only these input action maps feed the frame (null: every map) — a focused UI document's map. */
  setActiveMaps?(maps: readonly string[] | null): void;
  /** The cursor the game wants (free / locked); the owner locks, releases and hides it. */
  applyCursor?(mode: 'free' | 'locked'): void;
  /** The UI hit test (x, y fractions of the view): the owner reports the pointer over the UI (`overUi`) and leaves presses there to the UI. */
  setUiHitTest?(hit: ((x: number, y: number) => boolean) | null): void;
  /** The cursor as it is (observers). */
  cursorState?(): { mode: 'free' | 'locked'; locked: boolean; hidden: boolean };
  /** Listen for the next input for a rebind (a cancel key gives null). */
  captureInput?(options: { devices?: readonly ('keyboard' | 'mouse' | 'gamepad')[]; cancelKeys?: readonly string[] }, onInput: (input: Captured | null) => void): () => void;
  /** The device used last with the active pad's id. */
  activeDeviceInfo?(): { device: 'keyboard' | 'gamepad'; gamepadId: string | null };
  /** What the host adds to the next sampled frame (`ActionFrame.input`). */
  setFrameInput?(source: (() => import('@thirdlight/runtime').InputStatusEntry | undefined) | null): void;
}

/**
 * The pointer and the cursor as an observer sees them —
 * the pointer the simulation read last (position in the view, held buttons,
 * over the view, locked), the cursor mode in effect and whether the browser
 * holds the lock / hides it; and the objects scripts hid.
 */
export interface GameHostInputObservation {
  readonly pointer?: { readonly x: number; readonly y: number; readonly buttons: number; readonly over: boolean; readonly locked: boolean; readonly overUi?: boolean };
  readonly cursor?: { readonly mode: 'free' | 'locked'; readonly locked: boolean; readonly hidden: boolean };
  /** The ids of the objects scripts hid (`ctx.game.setVisible`), sorted, at most 64. */
  readonly hidden?: readonly string[];
  /**
   * The player's bindings — the device used last (pad id and
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
  /** Draw a frame and return it downscaled (a save slot's picture). */
  captureThumbnail?(width: number, height: number, type: 'image/jpeg' | 'image/webp', quality: number): { dataUrl: string; width: number; height: number } | null;
  /** The renderer is still starting (a capture now would draw nothing). */
  rendererStarting?(): boolean;
  /** Project an entity or world point through the rendered camera (world-anchored UI widgets). */
  projectToScreen?: UiProjector;
  /** The scene set revision the last presented frame drew (a transition fades in once it is on screen). */
  presentedSceneRevision?(): number;
  /** The last frame's counts (the frame stats read draw calls and triangles). */
  diagnostics?(): { ok: true; diagnostics: { frame?: { drawCalls: number; triangles: number } } } | { ok: false };
  /** GPU time measured since the last call; null without timestamp queries. */
  takeGpuTime?(): { ms: number; frames: number; worst: number } | null;
  /** The quality level drawn. */
  qualityLevel?(): string;
  /** A player's render settings (AO kind, render scale, dynamic resolution; unset parts keep their value). */
  setRenderSettings?(settings: { readonly ambientOcclusion?: 'off' | 'ssao' | 'gtao'; readonly renderScale?: number; readonly dynamicResolution?: boolean }): void;
}

export type { ProjectSavesObservation } from './host-saves';

/** `GameHostObservation.sound`. */
export interface GameHostSound {
  readonly status: 'ready' | 'muted' | 'blocked' | 'unavailable';
  readonly unlocked: boolean;
  readonly voices: number;
  readonly muted: boolean;
  readonly gesture: 'local' | 'none';
  /** Sounds the owner has started (scripts' `ctx.audio`, event cues) per bus. */
  readonly played?: { readonly sfx: number; readonly ui: number };
}

/** The conversation in the observation (bounded; from the dialogue view model). */
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
 * The play state every game reports — the simulation runs, or the
 * engine pause holds it (a menu, the pause panel, a game mode's pause), or
 * an error stopped it (`failed`: a script threw, a physics or module
 * failure; it never steps again until a fresh start). `stopped` is the
 * play's end (a disposed host has nothing to observe).
 */
export type PlayState = 'running' | 'paused' | 'failed' | 'stopped';

/** The error that stopped a failed run, as the observation carries it (the source line: the run's diagnostics). */
export interface PlayFailure {
  readonly code: string;
  readonly message: string;
  readonly stepIndex?: number;
  readonly moduleId?: string;
}

/** The environment preset blend as observed (the frame's interpolated weights). */
export interface GameHostEnvironmentObservation {
  readonly target: string | null;
  readonly progress: number;
  readonly weights: Readonly<Record<string, number>>;
  /** The active scene once it is not the start scene: its look blending in from `from`'s (`weight`: its share, 1 when done). */
  readonly scene?: { readonly active: string | null; readonly from: string | null; readonly weight: number };
}

/**
 * `GameHostObservation` (the one observation — every game plays as a
 * scene): its step and time, the play state, the sound
 * status, where its character (the controller entity) is, in 3D, and the
 * additive blocks of the systems the game uses.
 */
export interface GameHostObservation {
  readonly snapshotId: string;
  readonly buildId: string;
  readonly stepIndex: number;
  readonly simTime: number;
  /** The generic play state. */
  readonly state: PlayState;
  /** A failed run: the error that stopped it. */
  readonly error?: PlayFailure;
  readonly sound: GameHostSound;
  readonly inputMode: 'physical' | 'test';
  readonly player?: { readonly x: number; readonly y: number; readonly z: number };
  /** A game with several player controllers (local co-op): each one's object and position, in controller order (`player` is the first's). */
  readonly players?: readonly { readonly id: string; readonly x: number; readonly y: number; readonly z: number }[];
  /** The loaded scenes and the ones being loaded. */
  readonly scenes?: {
    readonly loaded: readonly string[];
    readonly loading: readonly string[];
    /** The transition waiting for its scene (phase out/loading, how far the view faded), when one is. */
    readonly transition?: import('@thirdlight/runtime').SceneTransitionView;
    /** The scenes read ahead (being prepared, ready). */
    readonly preloading?: readonly string[];
    readonly preloaded?: readonly string[];
  };
  /** The audio sources' live loops (entity id → gain). */
  readonly loops?: Readonly<Record<string, number>>;
  /** The resolved camera while the game has virtual cameras (live camera, blend, pose, lens, letterbox). */
  readonly camera?: CameraViewInfo;
  /** The environment preset blend once a script changed it (target, progress, weights by key; '' = the base look). */
  readonly environment?: GameHostEnvironmentObservation;
  /** The Web Audio graph (live voices with gain/pan/rate, music, buses, listener) once scripts used audio or a positional loop plays. */
  readonly audio?: AudioObservation;
  /** The project UI — the documents shown, the screen's document, the focus. */
  readonly ui?: UiLayerObservation;
  /** The conversation (once the project's dialogue ran). */
  readonly dialogue?: DialogueObservation;
  /** The pointer, the cursor and the objects scripts hid. */
  readonly pointer?: GameHostInputObservation['pointer'];
  readonly cursor?: GameHostInputObservation['cursor'];
  readonly hidden?: readonly string[];
  /** The player's bindings (device, profile, listening, changed actions, glyphs). */
  readonly inputBindings?: GameHostInputObservation['inputBindings'];
  /** The objects riding on sockets (only while some do) and their world positions. */
  readonly sockets?: readonly SocketObservation[];
  /** The game modes (only a project with modes) and the engine pause. */
  readonly mode?: ModeView;
  readonly paused?: boolean;
  /** The engine's pause panel (a paused game with modes and no pause screen of its own). */
  readonly pausePanel?: { readonly focus: 'resume' };
  /** The project saves (slot metadata, settings document). */
  readonly saves?: ProjectSavesObservation;
  /** The timelines (screen fade/letterbox, plays, the last step's events) once one played. */
  readonly timeline?: import('@thirdlight/runtime').TimelineView;
  /** The game shell (its screen, the listed scene, the HUD shown). */
  readonly shell?: ShellObservation;
  /** The named counters (at most 32) and every object's health (object id → current/max; at most 64) — Play and the export alike. */
  readonly counters?: Readonly<Record<string, number>>;
  readonly health?: Readonly<Record<string, { readonly current: number; readonly max: number }>>;
  /** What is loaded from assets: resident count and bytes per kind, loads, frees, script handles alive. */
  readonly resources?: GameResourcesObservation;
}

/** One object riding on a socket, as the host observes it (its interpolated world position). */
export interface SocketObservation {
  readonly entityId: string;
  readonly target: string;
  readonly node: string;
  readonly position: readonly [number, number, number];
}

/** `GameControlResult` (accepted submissions; the
 * runtime's own rejection rule passes through its structured error). */
export type GameControlError =
  | { code: string; reason?: string; command?: string; state?: string; message: string };

export type GameControlResult =
  | { readonly ok: true; readonly state: PlayState; readonly acceptedAtStep: number }
  | { readonly ok: false; readonly error: GameControlError };

/**
 * Where a test or debug start begins (Play from…, `tl_play_start`)
 * — resolved by the backend against the project, applied by the host at mount.
 */
export interface GameStartOptions {
  /** The scenes the game starts with (the start scenes plus the chosen one). */
  readonly scenes?: readonly string[];
  /** ...and the player spawn it starts at (absent: the game's own). */
  readonly spawnId?: string;
  /** The game mode the run starts in (validated by the backend against the project's modes). */
  readonly mode?: string;
  /** A project save document loaded at the first step (slot 0), or a project save slot of this page. */
  readonly projectSave?: ProjectSaveFile;
  readonly projectSaveSlot?: number;
}

/** What became of the start options (`GameHost.startOutcome`). */
export type GameStartOutcome = { readonly ok: true; readonly applied: readonly string[] } | { readonly ok: false; readonly reason: string };

/** `GameHostConfig` (+ the additive buildId, assetPaths and adapter-factory fields). */
export interface GameHostConfig {
  /** The runtime snapshot (validated by the runtime at instantiate). */
  readonly snapshot: RuntimeSnapshot;
  /** The resolved gameplay settings (the wrapper passes the manifest's
   * `gameplaySettings` or the model default). */
  readonly settings: GameplaySettings;
  /** A problem for the author (Play's Problems; one per kind and Play). */
  readonly onProblem?: (code: string, message: string) => void;
  /** The injected physics port (physics-rapier in the preview; a fake in
   * tests). Absent: a game without physics. */
  readonly physics?: PhysicsPort | PhysicsPort3D;
  /** The project's compiled behaviors (see `linkBehaviorModules`), run with the scene. */
  readonly behaviorModules?: readonly SimulationModuleSpec[];
  /**
   * The manifest's required engine module ids (derived by the build from the
   * declared dependencies). The host registers exactly these simulation
   * modules and checks the port modules it needs are injected; an id it
   * cannot provide is `host_module_unresolved`. Absent ⇒ none (there
   * is no default set).
   */
  readonly modules?: readonly string[];
  /**
   * The simulation module specs this composition provides beyond
   * the runtime's built-ins, keyed by their manifest module id (`spec.id`)
   * and listed in dependency order (a module after those it needs). The
   * composition entry (the Play preview, the export bootstrap, the
   * simulation worker) registers them; the host imports no module package.
   */
  readonly moduleSpecs?: readonly SimulationModuleSpec[];
  /** ADDITIVE: the render-adapter FACTORY — the three-adapter
   * instance requires the runtime it renders, which the host creates inside
   * `mount()`. `null` = no adapter (headless composition). */
  readonly adapter: (runtime: Runtime) => HostRenderAdapter | null;
  /** The injected browser input owner (the gameplay + menu channels). */
  readonly input: HostInputOwner;
  /** The injected audio owner. */
  readonly audio: GameAudioOwner;
  /** The injected artifact reader (manifest-declared relative paths only;
   * the host never fetches). Contract shape: the bytes
   * arrive as an `ArrayBuffer`; the host wraps them for the audio owner. */
  readonly readArtifact: (path: string) => Promise<ArrayBuffer>;
  /** The overlay root element the host draws into (UI documents, letterbox, fade, console). */
  readonly container: HostDomNode;
  /** ADDITIVE: the verified manifest buildId → `observe().buildId`. */
  readonly buildId: string;
  /** ADDITIVE: assetId → manifest-declared relative path; the host
   * resolves non-null cue refs through `readArtifact` at mount. */
  readonly assetPaths?: Record<string, string>;
  /** The DOM document for overlay element creation (default: the environment's
   * `document`; Node tests inject a fake). */
  readonly document?: HostDom;
  /**
   * Fetch one scene the game asked for and return
   * its resolved entities (the wrapper reads and verifies the manifest's
   * `scenes/<sceneId>.json`; see `sceneEntitiesFromDocument`). Absent: loads
   * fail with a diagnostic and the game keeps its start scenes.
   */
  readonly loadScene?: (sceneId: string) => Promise<LoadedSceneBatch['entities']>;
  /**
   * The page's scene preloader (its `load` answers the game's
   * loads instead of `loadScene`; the host names the scenes to read ahead).
   * The page sets its preparation once the adapter exists.
   */
  readonly scenes?: ScenePreloader;
  /** The manifest's game shell (menus and HUD as UI documents, the scene list) — a game that plays as a scene. */
  readonly shell?: ShellConfigLike;
  /** The input actions the game runs with (the settings screen rebinds them). */
  readonly inputConfig?: { actions: readonly { name: string; type: string; map: string; bindings: readonly unknown[] }[]; cursor?: { [map: string]: 'free' | 'locked' | undefined } };
  /** Each declared asset's kind (glyph images and UI images are read by it). */
  readonly assetKinds?: Readonly<Record<string, string>>;
  /**
   * An asset the maps above do not name (a build whose catalog is read as
   * the game needs it): its path and kind, or undefined when the build does
   * not have it.
   */
  readonly lookupAsset?: (assetId: string) => Promise<{ readonly path: string; readonly kind: string } | undefined>;
  /** The audio files a scene names, with their preload setting (read with the scene when it loads). */
  readonly sceneAudio?: (sceneId: string) => Promise<readonly AudioRow[]>;
  /** The audio files the project-wide blocks name (event cues, timelines, the shell), read after the mount when preloaded. */
  readonly projectAudio?: () => Promise<readonly AudioRow[]>;
  /**
   * The page's resource manager (everything loaded from assets is held
   * there: the reader's bytes, the adapter's models and textures, the audio
   * owner's decoded sounds, the UI's images and fonts). The host settles it
   * after each frame and reports it. Absent: a manager of the host's own.
   */
  readonly resources?: ResourceManager;
  /**
   * Scripts' loads by key (`ctx.assets.load`): the page resolves the key,
   * loads what it names and holds it for `holder` (see host-assets.ts).
   */
  readonly loadAssets?: (key: string, holder: string) => Promise<readonly string[]>;
  /** The page's texture streamer report (in the resources observation). */
  readonly textureStreaming?: () => object;
  /** Where the player's settings go (localStorage in the browser; see `storage.ts`) and this game's key prefix. */
  readonly saveStorage?: SaveStorage;
  readonly saveNamespace?: string;
  /**
   * Where project save slots go (IndexedDB in the browser; see
   * `browserProjectSaveBackend`), under `saveNamespace`. Absent with a save
   * schema: slots last for this page only (a memory store).
   */
  readonly projectSaveBackend?: ProjectSaveBackend;
  /** The browser's storage manager (`navigator.storage`): persistence asked at the first save, usage and quota. */
  readonly deviceStorage?: DeviceStorage;
  /** Apply a player's or the game-control API's quality level (the wrapper forwards it to the renderer); false: the project has no such level. */
  readonly setQuality?: (level: string) => boolean;
  /** The project's quality level ids, lowest first, and the one a game starts at (the game shell's quality setting steps through them). */
  readonly qualityLevels?: { readonly ids: readonly string[]; readonly start: string };
  /**
   * Where the simulation runs. Absent: in this page — `mount()`
   * composes the runtime (`composeGameRuntime`) with `physics`,
   * `behaviorModules` and `modules`. Present: the wrapper already composed
   * it elsewhere (the simulation worker) and this factory returns the
   * runtime the host presents (a mirror of the worker's; `onFrame` runs
   * after each simulated frame arrives). Everything else — UI, shell, audio,
   * saves, the adapter — stays in this page either way.
   */
  readonly runtimeFactory?: (onFrame: () => void) => { readonly ok: true; readonly runtime: Runtime } | { readonly ok: false; readonly error: GameControlError };
  /**
   * Script variables the scripts see in `ctx.save` from step 0
   * (used when the host composes the runtime; a worker gets them in its init).
   */
  readonly variables?: Readonly<Record<string, unknown>>;
  /** A test/debug start (see `GameStartOptions`). */
  readonly start?: GameStartOptions;
  /**
   * Show the in-game debug console (the backquote key). Play
   * always passes true; an export only with the project's `debug_console`
   * setting on. Absent: no console.
   */
  readonly debugConsole?: boolean;
  /** Give the keyboard back to the game (the console closed). */
  readonly focusGame?: () => void;
  /**
   * How audio sources are heard — `legacy` (louder as
   * the player comes near along X, no panning; absent) or `panner` (a panner
   * per source, the listener on the active camera, the source's distance
   * model). Script sounds with a place always use the panner.
   */
  readonly audioSpatial?: 'legacy' | 'panner';
  /**
   * The project UI (the manifest's documents and themes). The
   * host draws the documents the simulation and the shell show; absent or
   * empty: no project UI.
   */
  readonly ui?: { readonly documents: readonly UiDocument[]; readonly themes?: readonly UiTheme[] };
}

/** `GameHost`. */
export interface GameHost {
  /** The binding members. */
  mount(): { readonly ok: true } | { readonly ok: false; readonly error: GameControlError };
  control(action: GameControlAction): GameControlResult;
  observe():
    | { readonly ok: true; readonly observation: GameHostObservation }
    | { readonly ok: false; readonly error: GameControlError };
  /** `dispose(): void` (idempotent). */
  dispose(): void;
  /** ADDITIVE: the host's runtime seam (read-only; the manual
   * driver / Node compositions advance frames through it). */
  readonly runtime: Runtime;
  /** Request a scene load/unload (the same rules as a script's `ctx.scenes`). */
  scene(op: 'load' | 'unload', sceneId: string): { readonly ok: true } | { readonly ok: false; readonly error: GameControlError };
  /**
   * Run a project debug command — queued into the next
   * simulation step's input (so a recording of the run replays it). The
   * result carries the step it was accepted at; refused when no script
   * declared the command or the arguments do not match.
   */
  debugCommand?(name: string, args?: Readonly<Record<string, number | string | boolean>>): GameControlResult;
  /**
   * Draw at a quality level for the rest of this session (game control: compare levels in one run). Presentation
   * only: not simulation input, not kept in the player's settings; refused when the project has no such level.
   */
  setQuality?(level: string): GameControlResult;
  /** The in-game debug console (null: this game has none). */
  readonly debugConsole?: DebugConsole | null;
  /** What became of `config.start` (null: no start options). */
  readonly startOutcome?: GameStartOutcome | null;
  /** The project saves service (null: the project declares no save schema). */
  readonly projectSaves?: ProjectSaveService | null;
  /**
   * The rebinding API (list, listen, conflicts, reset,
   * profiles, the device used last, glyphs) — for project UI and tools; null
   * before mount or without an input config.
   */
  readonly bindings?: InputBindingsController | null;
  /**
   * Where a pointer press goes to the UI instead of
   * the game (the engine pause panel, then the project UI's buttons, inputs
   * and modal backdrops), topmost first — the pointer's UI hit test.
   */
  uiHitTargets?(): readonly UiHitTarget[];
  /** Click the UI target with this key (a relayed pointer click); false when it is gone. */
  clickUi?(key: string): boolean;
  /** The shown UI widgets with their rectangles (tl_game_observe). */
  uiElements?(max?: number): UiElementObservation[];
  /** `@font-face` rules of the UI's project fonts (a screenshot draws the UI outside the page). */
  uiFontRules?(): Promise<string>;
  /** The play state now (running; paused: the engine pause, a menu or the debugger hold the simulation; failed: an error stopped the run). */
  playState?(): PlayState;
  /** The last stats window (`ctx.stats`; null before the first ends) — Play diagnostics carry it. */
  frameStats?(): BehaviorStats | null;
  /** The built-in stats overlay (null: the project's stats_overlay setting is off). */
  readonly statsOverlay?: StatsOverlay | null;
}

// --- the sound-status mapping (`sound.status`) ---------------------------

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
  if (typeof config.input.sampleMenu !== 'function') return 'config.input.sampleMenu must be a function (the menu channel)';
  if (typeof config.input.markConfirmConsumed !== 'function') return 'config.input.markConfirmConsumed must be a function';
  if (typeof config.input.dispose !== 'function') return 'config.input.dispose must be a function';
  if (!isPlainObject(config.audio)) return 'config.audio must be the injected audio owner';
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

/** The `scenes` observation block (absent without a scene catalog). */
function scenesObservation(rt: Runtime, preload: ScenePreloader | undefined): { scenes?: NonNullable<GameHostObservation['scenes']> } {
  const set = rt.sceneSet?.();
  if (set === undefined || Object.keys(set.status).length === 0) return {};
  const loading = Object.entries(set.status).filter(([, st]) => st === 'loading').map(([id]) => id);
  const transition = rt.sceneLoadingView?.().transition ?? null;
  const ahead = preload?.view();
  return {
    scenes: {
      loaded: set.batches.map((b) => b.sceneId),
      loading,
      ...(transition !== null ? { transition } : {}),
      ...(ahead !== undefined && ahead.preloading.length > 0 ? { preloading: ahead.preloading } : {}),
      ...(ahead !== undefined && ahead.preloaded.length > 0 ? { preloaded: ahead.preloaded } : {}),
    },
  };
}

/** `$flow.scenes` — whether a scene is loading, which, and the transition waiting (a loading screen binds these). */
function sceneFlowValues(rt: Runtime): { loading: boolean; scenes: readonly string[]; transition: { scene: string; phase: string; fade: number } | null } {
  const v = rt.sceneLoadingView!();
  const t = v.transition;
  return { loading: v.loading.length > 0, scenes: v.loading, transition: t === null ? null : { scene: t.scene, phase: t.phase, fade: t.fade } };
}

/**
 * The scenes a game is likely to load next — the targets of the
 * scene transitions in its loaded scenes (in load order) and the shell's next
 * listed scene — that are not loaded.
 */
function toControlError(error: RuntimeError): GameControlError {
  const out: GameControlError = { code: error.code, message: error.message };
  if (error.reason !== undefined) out.reason = error.reason;
  if (error.command !== undefined) out.command = error.command;
  if (error.state !== undefined) out.state = error.state;
  return out;
}

// --- the host ---------------------------------------------------------------

/**
 * Create the game host. The host owns its runtime
 * instance and overlays; the input owner, audio owner, and canvas are
 * wrapper-owned and injected (a new host on the same snapshot reuses them).
 */
/**
 * The runtime's own simulation modules a manifest can name (the 3D
 * character controller). Every other simulation module comes from the
 * composition's injected spec table (`moduleSpecs`).
 */
const RUNTIME_SIMULATION_SPECS: readonly SimulationModuleSpec[] = [character3DSpec];
/** The port modules the delivery wrapper injects (checked, not registered). */
const PORT_MODULES = new Set(['thirdlight.physics-rapier:2d', 'thirdlight.physics-rapier:3d', 'thirdlight.input:keyboard-gamepad', 'thirdlight.three-adapter:gltf-loader']);

/**
 * Select the simulation modules from the manifest's module list (the build's
 * derived set) out of the runtime's built-ins and the injected spec table.
 * No list, no modules — the host has no default set. The
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
  // A module's entity requirement is its own declaration.
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
 * What the simulation needs to run — the single place the game's
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
  /** The injected simulation module specs (see `GameHostConfig.moduleSpecs`). */
  readonly moduleSpecs?: readonly SimulationModuleSpec[];
  readonly actions: ActionSource;
  readonly onFrame?: () => void;
  /** The frame driver (absent: rAF where the environment has it, else manual). A worker passes manual: the main thread drives it. */
  readonly driver?: { readonly kind: 'raf' | 'manual' };
  /** Script variables injected at the start (ctx.save from step 0). */
  readonly variables?: Readonly<Record<string, unknown>>;
  /** The game mode runs start in (a start option). */
  readonly startMode?: string;
  /** The stored project settings document. */
  readonly projectSettings?: Readonly<Record<string, unknown>>;
}

/** Compose and start the game's runtime (see `GameRuntimeArgs`). */
export function composeGameRuntime(args: GameRuntimeArgs): { ok: true; runtime: Runtime } | { ok: false; error: GameControlError } {
  const snapshot = args.snapshot;
  const scene = snapshot.scene;
  if (scene.schemaVersion !== 3 && scene.schemaVersion !== 4) {
    return { ok: false, error: { code: 'host_config_invalid', reason: 'snapshot', message: 'the game host requires a v3 or v4 snapshot' } };
  }

  const registry = createSimulationRegistry();
  // The registry carries the runtime built-ins (inert unless selected);
  // the SELECTED modules are the ones the manifest names (resolved through
  // the runtime's specs and the injected table), plus the project's compiled behaviors.
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
    // The project's step rate (absent: the runtime's 120 Hz).
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
   * The bindings the game runs with — the project's actions with
   * the player's saved rebinding and any rebinding made while playing. The
   * input prompts name these.
   */
  let promptInput: InputConfigLike = config.inputConfig ?? { actions: [] };
  /** The game shell (a game with `content.shell`). */
  let shellCtl: ShellController | null = null;
  /** The player's bindings (created at mount when the game has an input config). */
  let bindings: InputBindingsController | null = null;
  /** What the host loads from assets (glyph images, sounds) and the resource manager it is held in. */
  const assets: HostAssets = createHostAssets(config, () => !disposed && mounted);
  const hostAudio: HostAudio = createHostAudio({
    audio: config.audio,
    snapshot: config.snapshot as unknown as HostAudioConfig['snapshot'],
    panner: config.audioSpatial === 'panner',
    ...(config.sceneAudio !== undefined ? { sceneAudio: config.sceneAudio } : {}),
    ...(config.projectAudio !== undefined ? { projectAudio: config.projectAudio } : {}),
    readTransform: (rt, id, out) => readTransform(rt, id, out),
    live: () => !disposed && mounted,
  });
  let adapter: HostRenderAdapter | null = null;
  /** The debug console (config.debugConsole) and what became of config.start. */
  let debugConsole: DebugConsole | null = null;
  /** The frame statistics (ctx.stats, $flow.stats, Play diagnostics) and the stats overlay a project opts into. */
  let statsOverlay: StatsOverlay | null = null;
  const hostStats = createHostStats({
    adapter: () => adapter,
    entities: () => {
      const d = runtime?.getDiagnostics();
      return d?.ok === true ? d.diagnostics.entityCount : 0;
    },
    ...(config.textureStreaming !== undefined ? { textureStreaming: config.textureStreaming } : {}),
    ...(config.resources !== undefined ? { resources: config.resources } : {}),
    worker: config.runtimeFactory !== undefined,
    frameRateCap: () => {
      const p = runtime?.framePacing?.();
      if (p === undefined) return null;
      return p.pinned !== undefined ? (p.pinned === 'none' ? null : p.pinned) : p.frameRateCap;
    },
    published: (s) => {
      runtime?.setStats?.(s);
      statsOverlay?.update(s);
    },
  });
  let startOutcome: GameStartOutcome | null = null;
  /** Project saves (a project with a save schema). */
  const saveSchema = config.snapshot.saveSchema;
  const saveNamespace = config.saveNamespace ?? `thirdlight:${String((config.snapshot as { projectId?: string }).projectId ?? 'game')}`;
  let projectSaves: ProjectSaveService | null = null;
  const savesObservation = (): { saves?: ProjectSavesObservation } => savesObservationOf(projectSaves, saveSchema, runtime?.projectSettings?.());
  /** The project UI layer (null without UI documents). */
  let uiLayer: UiLayer | null = null;
  /**
   * The engine pause of a game with game modes and no shell (the
   * mode allows it), the engine's pause panel (a mode without a pause screen
   * of its own), and the input maps in effect: a focused UI document's action
   * map, else the current mode's maps, else every map.
   */
  let scenePaused = false;
  /** A shell screen whose scripts run holds the game (told to the simulation once per change). */
  let screenHeld = false;
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
  /** A restart of the game, named by the action that asked: an input-frame entry (so recordings replay it). */
  const queueRestart = (rt: Runtime | null, cause: string): void => {
    const r = rt?.queueUiEvent?.({ kind: 'restart', doc: '', widget: '', name: cause });
    if (r !== undefined && r.ok === false) console.warn('[game-host] restart refused:', r.error.message);
  };
  /** A scene engine action — reload (absent: the active scene), load, unload: an input-frame entry, so recordings replay it. */
  const queueSceneOp = (rt: Runtime | null, op: 'reload' | 'load' | 'unload', sceneId: string | undefined): void => {
    const r = rt?.queueUiEvent?.({ kind: op, doc: '', widget: '', name: '', ...(sceneId !== undefined ? { value: sceneId } : {}) });
    if (r !== undefined && r.ok === false) console.warn(`[game-host] scene ${op} refused:`, r.error.message);
  };
  const sceneRestart = (cause: string): void => {
    queueRestart(runtime, cause);
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
        pausePanel ??= createPausePanel(hostDom, config.container, { resume: () => setScenePause(false) });
        pausePanel.show();
      }
    } else {
      uiLayer?.showScreen(null);
      pausePanel?.hide();
    }
  };
  /** The input prompts generated from the declared actions (the active maps; the rebinding's labels for the device used last). */
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

  /** The game shell over this runtime (its seams: the engine pause, UI events, project saves, the UI layer). */
  const makeShell = (rt: Runtime): ShellController =>
    createShellController({
      shell: config.shell!,
      showScreen: (docId) => uiLayer?.showScreen(docId),
      setHud: (ids) => uiLayer?.setHud(ids),
      setPaused: (on) => {
        scenePaused = on;
        rt.setPaused?.(on);
      },
      setHold: (on) => {
        if (on === screenHeld) return;
        screenHeld = on;
        const r = rt.queueUiEvent?.({ kind: 'hold', doc: '', widget: '', name: '', value: on });
        if (r !== undefined && r.ok === false) console.warn('[game-host] screen hold refused:', r.error.message);
      },
      restart: (cause) => queueRestart(rt, cause),
      sceneOp: (op, sceneId) => queueSceneOp(rt, op, sceneId),
      goToScene: (index) => {
        const r = rt.queueUiEvent?.({ kind: 'scene', doc: '', widget: '', name: '', value: index });
        if (r !== undefined && r.ok === false) console.warn('[game-host] scene move refused:', r.error.message);
      },
      listedScene: () => rt.listedSceneIndex?.() ?? -1,
      saves: shellSaves(() => projectSaves, saveSchema, rt),
      pauseAllowed: () => {
        const mv = rt.modeView?.() ?? null;
        return mv === null || mv.pause;
      },
      modePauseScreen: () => rt.modeView?.()?.pauseScreen,
      pausePanel: () => {
        if (hostDom === null) return null;
        pausePanel ??= createPausePanel(hostDom, config.container, { resume: () => shellCtl?.engine({ do: 'engine', action: 'resume' }) });
        return pausePanel;
      },
      setVolume: (bus, value) => config.audio.setVolume?.(bus, value),
      setQuality: (q) => void config.setQuality?.(q),
      ...(config.qualityLevels !== undefined ? { qualityLevels: config.qualityLevels } : {}),
      frameRateCap: () => rt.frameRateCap?.() ?? null,
      setFrameRateCap: (fps) => void rt.setFrameRateCap?.(fps),
      ...(config.saveStorage !== undefined ? { storage: config.saveStorage } : {}),
      namespace: saveNamespace,
      prompts: promptsText,
      ...(hostDom !== null ? { dom: hostDom } : {}),
      container: config.container,
      log: (message) => console.warn(`[game-host] ${message}`),
    });

  /** A project UI document's engine action in a game without a shell (with modes: pause, resume; scene load, unload and reload; the deprecated restarts). */
  const sceneEngineAction = (a: { readonly action: string; readonly scene?: string }): void => {
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
        sceneRestart(a.action);
        break;
      case 'reloadScene':
        queueSceneOp(runtime, 'reload', a.scene);
        break;
      case 'loadScene':
        queueSceneOp(runtime, 'load', a.scene);
        break;
      case 'unloadScene':
        queueSceneOp(runtime, 'unload', a.scene);
        break;
      default:
        break; // settings and saves belong to the game shell
    }
  };
  /** Hand the game's scene requests to the wrapper's loader. */
  const sceneLoader = config.scenes !== undefined ? config.scenes.load : config.loadScene;
  const serviceSceneRequests = (rt: Runtime): void => {
    const requests = rt.takeSceneRequests?.() ?? [];
    for (const req of requests) {
      if (sceneLoader === undefined) {
        rt.provideScene?.(req.sceneId, { ok: false, message: 'this game page cannot load scenes' });
        continue;
      }
      void sceneLoader(req.sceneId).then(
        (entities) => {
          if (!disposed && runtime === rt) rt.provideScene?.(req.sceneId, { ok: true, entities });
        },
        (error: unknown) => {
          if (!disposed && runtime === rt) rt.provideScene?.(req.sceneId, { ok: false, message: error instanceof Error ? error.message : String(error) });
        },
      );
    }
  };

  /** Name the scenes to read ahead whenever the scene set, the listed scene or the doors near the camera change. */
  const readAhead = createReadAhead(config.scenes, config.shell?.scenes);
  const serviceReadAhead = (rt: Runtime): void => readAhead.service(rt);

  /** One entity's interpolated transform into `out` (the allocation-free read when the runtime has it). */
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
   * The letterbox bars — two black bars over the top and bottom of
   * the view, each the live camera's share of the view height (interpolated
   * like the camera; blended between cameras). Made the first time a camera
   * asks for one; a game without virtual cameras never has them.
   */
  let letterbox: { readonly top: HostDomNode; readonly bottom: HostDomNode; shown: string } | null = null;
  let hostDom: HostDom | null = null;
  const lbPos: number[] = [0, 0, 0];
  const lbRot: number[] = [0, 0, 0, 1];
  /**
   * The cursor mode in effect, handed to the input owner every
   * frame: the ui map's setting while a menu is open or the game is paused,
   * else a script's request or the setting of the active maps (a
   * focused document's or the game mode's maps; every map without modes).
   */
  const serviceCursor = (rt: Runtime): void => {
    if (config.input.applyCursor === undefined) return;
    const menu = rt.isPaused === true;
    config.input.applyCursor(resolveCursorMode(config.inputConfig as InputConfigLike | undefined, menu ? 'menu' : (uiMaps ?? modeMaps), rt.cursorRequest?.() ?? null));
  };

  /** The pointer and cursor as an observer sees them, and the objects scripts hid. */
  const inputObservation = (rt: Runtime): GameHostInputObservation => {
    const p = rt.readPointer?.() ?? null;
    const cursor = config.input.cursorState?.();
    const hidden = rt.hiddenEntities?.();
    return {
      ...(p !== null ? { pointer: { x: p.x, y: p.y, buttons: p.buttons ?? 0, over: p.over !== false, locked: p.locked === true, ...(p.overUi === true ? { overUi: true } : {}) } } : {}),
      ...(cursor !== undefined ? { cursor: { mode: cursor.mode, locked: cursor.locked, hidden: cursor.hidden } } : {}),
      ...(hidden !== undefined && hidden.size > 0 ? { hidden: [...hidden].sort().slice(0, 64) } : {}),
      ...(bindings !== null ? { inputBindings: bindings.observe() } : {}),
    };
  };

  /** The bindings as UI documents read them (`$flow.input`), rebuilt when they change. */
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

  /** The rebind timeout, the device used last and the scripts' binding requests (after each frame). */
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
    // A timeline's letterbox track shows over the camera's (the larger bars win).
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
   * A timeline's full-screen fade — one element over the view and
   * the letterbox bars, under the project UI (a title can show over black).
   * Made the first time a timeline fades; `data-tl-fade` carries the opacity.
   */
  let fadeNode: { readonly node: HostDomNode; shown: string } | null = null;
  /** A transition's fade back in — from the first presented frame that drew its swap (wall clock). */
  let fadeIn: { revision: number; seconds: number; color: string; from: number | null } | null = null;
  const nowMs = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  /** A scene transition's fade (out while it waits; in once the swap is on screen): opacity and colour. */
  const transitionFade = (rt: Runtime): { opacity: number; color: string } | null => {
    const view = rt.sceneLoadingView?.();
    if (view === undefined) return null;
    const t = view.transition;
    if (t !== null && t.seconds > 0) {
      fadeIn = null;
      return { opacity: t.fade, color: t.color };
    }
    const swap = view.swap;
    if (swap !== null && swap.seconds > 0 && (fadeIn === null || fadeIn.revision !== swap.revision)) {
      // A swap already faded in (a new run keeps no swap) is not faded again.
      if (fadeIn === null && swap.revision <= lastFadedRevision) return null;
      fadeIn = { revision: swap.revision, seconds: swap.seconds, color: swap.color, from: null };
    }
    if (fadeIn === null) return null;
    // Opaque until a presented frame drew the swap (the adapter may hold presents while it builds programs).
    const presented = adapter?.presentedSceneRevision?.() ?? fadeIn.revision;
    if (fadeIn.from === null) {
      if (presented < fadeIn.revision) return { opacity: 1, color: fadeIn.color };
      fadeIn.from = nowMs();
    }
    const k = (nowMs() - fadeIn.from) / (fadeIn.seconds * 1000);
    if (k >= 1) {
      lastFadedRevision = fadeIn.revision;
      fadeIn = null;
      return null;
    }
    return { opacity: 1 - k, color: fadeIn.color };
  };
  let lastFadedRevision = -1;
  const serviceFade = (rt: Runtime): void => {
    const screen = rt.timelineView?.()?.screen;
    const timelineOpacity = screen === undefined || !Number.isFinite(screen.opacity) ? 0 : Math.max(0, Math.min(1, screen.opacity));
    const tf = transitionFade(rt);
    const opacity = Math.max(timelineOpacity, tf?.opacity ?? 0);
    if (fadeNode === null) {
      if (opacity <= 0 || hostDom === null) return;
      const node = hostDom.createElement('div');
      node.setAttribute?.('data-tl-fade', '0');
      config.container.appendChild(node);
      fadeNode = { node, shown: '' };
    }
    const color = tf !== null && tf.opacity >= timelineOpacity ? tf.color : screen !== undefined && /^#[0-9a-f]{6}$/.test(screen.fade) ? screen.fade : '#000000';
    const key = `${color}|${Math.round(opacity * 1000) / 1000}`;
    if (fadeNode.shown === key) return;
    fadeNode.shown = key;
    const css = `position:fixed;inset:0;background:${color};opacity:${Math.round(opacity * 1000) / 1000};pointer-events:none;z-index:5;${opacity > 0 ? '' : 'display:none;'}`;
    const styled = fadeNode.node as HostDomNode & { style?: { cssText?: string } };
    if (styled.style !== undefined) styled.style.cssText = css;
    else fadeNode.node.setAttribute?.('style', css);
    fadeNode.node.setAttribute?.('data-tl-fade', String(Math.round(opacity * 1000) / 1000));
  };

  /** The timelines as observers see them (once one played). */
  const timelineObservation = (rt: Runtime): { timeline?: import('@thirdlight/runtime').TimelineView } => {
    const v = rt.timelineView?.() ?? null;
    return v === null ? {} : { timeline: v };
  };

  /** The view the UI is drawn over, for `ctx.ui.view()` (told again when it changes). */
  let reportedView = '';
  const serviceView = (rt: Runtime): void => {
    const v = uiLayer?.view() ?? pageUiView();
    const key = `${v.width}x${v.height}@${v.pixelRatio}`;
    if (key !== reportedView && rt.setUiView?.(v.width, v.height, v.pixelRatio) === true) reportedView = key;
  };
  /** The simulation's UI diff, then the layer's frame (bindings, $flow values, the view size). */
  const serviceUi = (rt: Runtime): void => {
    serviceView(rt);
    if (uiLayer === null) return;
    const out = rt.takeUiOutput?.() ?? null;
    if (out !== null) uiLayer.applyOutput(out);
    uiLayer.frame();
  };
  /** World-anchored widgets follow the frame just rendered. */
  const serviceAnchors = (): void => {
    const project = adapter?.projectToScreen;
    if (uiLayer !== null && project !== undefined) uiLayer.updateAnchors(project);
  };

  const hostFrame = (): void => {
    if (disposed || !mounted || runtime === null) return;
    hostStats.begin();
    serviceSceneRequests(runtime);
    serviceReadAhead(runtime);
    debugConsole?.frame();
    serviceBindings(runtime);
    serviceUi(runtime);
    // (1) The menu/control channel — serviced BETWEEN frames, never on a
    // tick. What it asks for (a restart, a UI event) rides on the next
    // step's input frame.
    const menu: MenuSample = config.input.sampleMenu();
    // A focused project UI document takes the ui edges it uses (navigation, submit, its cancel) first.
    const uiFocus = uiLayer !== null && uiLayer.hasFocus();
    // The game modes (their input maps); a game with modes has the engine pause.
    const modeView = serviceModes(runtime);
    if (shellCtl !== null) {
      // The game shell takes what the focused document left (pause, cancel, the pause panel's navigation).
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
    // published views; no runtime internals, no scene-graph mutation.
    // The live camera's letterbox (an overlay the host draws over the view).
    serviceLetterbox(runtime);
    // A timeline's fade over the view.
    serviceFade(runtime);
    // The cursor (free/locked per input map, a script's request; hidden while a gamepad drives).
    serviceCursor(runtime);
    // The simulation's save requests (a thumbnail is drawn now, in this frame; held ones go once it can be).
    if (projectSaves !== null) projectSaves.handle(runtime.takeSaveRequests?.() ?? []);
    // The simulation's problems for the author (Play's Problems; an export has none to show).
    for (const p of runtime.takeProblems?.() ?? []) config.onProblem?.(p.code, p.message);
    // Scripts' asset loads and releases; each answer is the next step's input.
    assets.serviceHandles(runtime.takeAssetRequests?.() ?? [], (answer) => {
      const r = disposed || runtime === null ? undefined : runtime.queueAssetAnswer?.(answer);
      if (r !== undefined && !r.ok) console.warn('[game-host] asset answer refused:', r.error.message);
    });
    // The sounds of scripts, event cues, dialogue and timelines (the runtime's audio intent log), the audio
    // sources' loops, and the files the scenes and the running conversation have loaded ahead.
    hostAudio.frame(runtime);
    adapter?.renderFrame();
    hostStats.end();
    serviceAnchors();
    // The frame drew the step's scene changes: what lost its last holder in them is freed now
    // (a model unloaded and loaded again in one transition was taken again before this).
    assets.frameDone();
  };

  /** The generic play state (the engine pause, a menu or the debugger hold the simulation; a fail-stop ends the run). */
  const playState = (): PlayState => {
    if (disposed) return 'stopped';
    const d = runtime?.getDiagnostics();
    if (d?.ok === true && d.diagnostics.state === 'failed') return 'failed';
    return runtime?.isPaused === true || scenePaused ? 'paused' : 'running';
  };

  /**
   * The error that stopped a failed run: its fail-stop entry (the step it
   * failed at; the last such, as nothing runs after it), else the last error
   * that is not a log line (a simulation worker's own failure).
   */
  const failureOf = (d: RuntimeDiagnostics): PlayFailure | undefined => {
    if (d.state !== 'failed') return undefined;
    const errors = d.errors.filter((e) => e.code !== 'behavior_log' && e.code !== 'entity_write');
    const atFail = d.failedStepIndex !== undefined ? errors.filter((e) => e.stepIndex === d.failedStepIndex) : [];
    const e = atFail.at(-1) ?? errors.at(-1);
    if (e === undefined) return { code: 'failed', message: 'the run stopped on an error (see the diagnostics)' };
    return { code: e.code, message: e.message, ...(e.stepIndex !== undefined ? { stepIndex: e.stepIndex } : {}), ...(e.moduleId !== undefined ? { moduleId: e.moduleId } : {}) };
  };

  const control = (action: GameControlAction): GameControlResult => {
    if (disposed) return { ok: false, error: { code: 'host_disposed', message: 'the host is disposed' } };
    if (!mounted || runtime === null) {
      return { ok: false, error: { code: 'host_not_mounted', message: 'the host is not mounted' } };
    }
    switch (action) {
      case 'replay': {
        // Replay restarts the game (the pause panel's restart: an input-frame entry, so a recording replays it).
        if (runtime.queueUiEvent === undefined) return { ok: false, error: { code: 'game_command_invalid', reason: 'replay', message: 'this runtime cannot restart' } };
        const q = runtime.queueUiEvent({ kind: 'restart', doc: '', widget: '', name: '' });
        if (q.ok === false) return { ok: false, error: toControlError(q.error) };
        break;
      }
      case 'clearSave':
        if (config.saveStorage !== undefined && config.saveNamespace !== undefined) createSettingsStore(config.saveStorage, config.saveNamespace).clear();
        // And the project save slots.
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
   * Apply the start options — the start scenes plus the chosen
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
      // The character starts at the chosen scene's spawn (arriving once that scene is loaded).
      if (start.spawnId !== undefined) {
        const r = rt.requestArrival?.(start.scenes[start.scenes.length - 1]!, start.spawnId);
        if (r === undefined || !r.ok) return { ok: false, reason: r === undefined ? 'this game cannot place the character' : r.error.message };
        applied.push(`spawn ${start.spawnId}`);
      }
      applied.push(`scenes ${start.scenes.join(', ')}`);
    }
    // A project save document or slot (loaded at the first step).
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
    // The run started in this mode (the runtime was composed with it).
    if (start.mode !== undefined) {
      const mv = rt.modeView?.() ?? null;
      if (mv === null) applied.push(`mode ${start.mode} (ignored: the game has no modes)`);
      else if (!mv.modes.includes(start.mode)) return { ok: false, reason: `the game has no mode "${start.mode}"` };
      else applied.push(`mode ${start.mode}`);
    }
    return { ok: true, applied };
  };

  /** Queue one debug command call into the next step's input. */
  const debugCommand = (name: string, args: Readonly<Record<string, number | string | boolean>> = {}): GameControlResult => {
    if (disposed) return { ok: false, error: { code: 'host_disposed', message: 'the host is disposed' } };
    if (!mounted || runtime === null) return { ok: false, error: { code: 'host_not_mounted', message: 'the host is not mounted' } };
    if (typeof runtime.queueDebugCommand !== 'function') return { ok: false, error: { code: 'game_command_invalid', reason: 'debug_command', message: 'this game has no debug commands' } };
    const r = runtime.queueDebugCommand({ name, args });
    if (!r.ok) return { ok: false, error: toControlError(r.error) };
    return { ok: true, state: playState(), acceptedAtStep: stepNow(runtime) };
  };

  const mount = (): { ok: true } | { ok: false; error: GameControlError } => {
    if (disposed) return { ok: false, error: { code: 'host_disposed', message: 'the host is disposed' } };
    if (mounted) return { ok: false, error: { code: 'host_already_mounted', message: 'the host is already mounted (dispose before remounting)' } };
    if (configError.reason === 'config' && configError.message !== 'invalid game host config') {
      return { ok: false, error: configError };
    }
    const snapshot = config.snapshot;
    // The simulation runs where the wrapper chose — composed here
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

    // The document the overlays (letterbox bars, fade, UI documents) are made in.
    hostDom = config.document ?? (globalThis as { document?: HostDom }).document ?? null;
    const dom: HostDom = hostDom ?? { createElement: () => { throw new Error('no document available for the overlays'); } };
    if (statsOverlayModeOf(config.settings) !== 'off' && hostDom !== null) statsOverlay = createStatsOverlay({ dom: hostDom, container: config.container, shown: statsOverlayModeOf(config.settings) === 'shown' });
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

    // Project saves — the page owns the slots; the simulation gets the list and answers as input.
    if (saveSchema !== undefined) {
      projectSaves = startHostSaves({
        schema: saveSchema,
        runtime: res.runtime,
        namespace: saveNamespace,
        ...(config.projectSaveBackend !== undefined ? { backend: config.projectSaveBackend } : {}),
        ...(config.deviceStorage !== undefined ? { device: config.deviceStorage } : {}),
        ...(config.saveStorage !== undefined ? { settingsStorage: config.saveStorage } : {}),
        captureThumbnail: (w, h, type, q) => adapter?.captureThumbnail?.(w, h, type, q) ?? null,
        pictureWaits: () => adapter?.rendererStarting?.() === true,
        ...(config.setQuality !== undefined ? { setQuality: config.setQuality } : {}),
        ...(config.audio.setVolume !== undefined ? { setVolume: (bus: 'music' | 'sfx' | 'ui', v: number) => config.audio.setVolume?.(bus, v) } : {}),
        setFrameRateCap: (fps) => void res.runtime.setFrameRateCap?.(fps),
        setRenderSettings: (s) => adapter?.setRenderSettings?.(s),
        disposed: () => disposed,
      });
    }
    // The player's bindings (saved per profile).
    if (config.inputConfig !== undefined) {
      bindings = createInputBindings({
        defaults: config.inputConfig,
        input: config.input,
        ...(config.saveStorage !== undefined && config.saveNamespace !== undefined ? { store: createSettingsStore(config.saveStorage, config.saveNamespace) } : {}),
        onChange: (c) => {
          promptInput = c as InputConfigLike;
        },
        imageUrl: (assetId: string) => assets.glyphImageUrl(assetId),
      });
    }

    // The project UI layer.
    if (config.ui !== undefined && config.ui.documents.length > 0 && hostDom !== null) {
      const rt = res.runtime;
      uiLayer = createUiLayer({
        dom: hostDom,
        container: config.container,
        documents: config.ui.documents,
        // Image widgets may show a save slot's picture (a load screen's slot cards).
        ...slotPictures(() => projectSaves),
        ...(config.ui.themes !== undefined ? { themes: config.ui.themes } : {}),
        ...(config.assetPaths !== undefined ? { assetPaths: config.assetPaths } : {}),
        ...(config.lookupAsset !== undefined ? { lookupPath: (assetId: string) => config.lookupAsset!(assetId).then((r) => r?.path) } : {}),
        readArtifact: config.readArtifact,
        resources: assets.resources,
        queueEvent: (event) => {
          const r = rt.queueUiEvent?.(event);
          if (r !== undefined && r.ok === false) console.warn('[game-host] UI event refused:', r.error.message);
        },
        // The dialogue UI's buttons (advance, choose, skip, auto, backlog) ride on the next input frame.
        dialogueInput: (input) => {
          const r = rt.queueDialogueInput?.(input);
          if (r !== undefined && r.ok === false) console.warn('[game-host] dialogue input refused:', r.error.message);
        },
        // Widgets' click, hover and focus sounds, on the menu-sound bus (the player's UI volume).
        playSound: (assetId) => void config.audio.playSound?.(assetId, 1, 'ui'),
        engineAction: (a) => {
          // Rebinding from project UI (the same bindings API as scripts and the settings screen).
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
          // A game without a shell has the engine pause (with modes) and the restart.
          if (shellCtl !== null) shellCtl.engine(a);
          else sceneEngineAction(a);
        },
        // `$flow.input` — the device used last, the rebind listening and every action's keys/pad glyph (a project settings document lists them).
        // + the game shell, the named counters, every object's health and the generated input prompts.
        flowValues: () => {
          const rtNow = runtime;
          return {
            ...(bindings !== null ? { input: inputUiValues() } : {}),
            ...(shellCtl !== null ? { shell: shellCtl.values() } : {}),
            counters: rtNow?.gameCounters?.().counters ?? {},
            // Scene loading for a loading screen (`$flow.scenes.loading`, `.transition`).
            ...(rtNow?.sceneLoadingView !== undefined ? { scenes: sceneFlowValues(rtNow) } : {}),
            health: rtNow?.healthsView?.() ?? {},
            // The engine's frame statistics (once per stats window).
            stats: hostStats.snapshot() ?? ENGINE_STATS_NONE,
            prompts: promptsText(),
            promptList: currentActionPrompts(),
          };
        },
        // {action:name} glyphs in UI texts.
        ...(bindings !== null
          ? {
              glyph: (action: string) => {
                const g = bindings?.glyph(action) ?? null;
                return g === null || bindings === null ? null : { label: g.label, icon: g.icon, url: bindings.glyphImage(g) };
              },
              glyphKey: () => String(bindings?.revision() ?? 0),
            }
          : {}),
        // A focused document's map wins over the game mode's maps (applyMaps).
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
    serviceView(res.runtime);
    // The game shell (a title, pause, settings, controls, save/load screens and the HUD as UI documents).
    if (config.shell !== undefined) shellCtl = makeShell(res.runtime);
    mounted = true;
    // The project's preloaded sounds are read now, after the mount (the scenes' as they load).
    hostAudio.start();
    if (config.start !== undefined) startOutcome = applyStart(res.runtime, config.start);
    // A start given by a test or the debugger begins in play (no title).
    shellCtl?.start(config.start !== undefined);
    return { ok: true };
  };

  /** The game modes, the engine pause and its panel (a project with modes). */
  const modeObservation = (rt: Runtime): { mode?: ModeView; paused?: boolean; pausePanel?: { focus: 'resume' } } => {
    const mv = rt.modeView?.() ?? null;
    if (mv === null) return {};
    return { mode: mv, paused: scenePaused, ...(pausePanel?.shown === true ? { pausePanel: { focus: pausePanel.focus } } : {}) };
  };

  /** The objects riding on sockets and where they are (world position, composed up their parents). */
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
      // Any depth (the snapshot's chains are acyclic: validated); one longer than the objects can only loop.
      for (let cur = parents.get(id), depth = 0; cur !== undefined; cur = parents.get(cur), depth += 1) {
        if (depth > parents.size) {
          console.error(`[game-host] the parent chain of ${id} loops back on itself`);
          break;
        }
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
   * The conversation as the dialogue UI shows it (read from the
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

  /** The environment blend, once a script changed it or the active scene changed (weights by key: '' the base look, a preset id, a patched preset's key). */
  const environmentObservation = (rt: Runtime): { environment?: GameHostEnvironmentObservation } => {
    const v = rt.readEnvironmentBlend?.() ?? null;
    if (v === null) return {};
    const weights: Record<string, number> = {};
    for (const [k, w] of v.weights) weights[k] = w;
    return { environment: { target: v.target, progress: v.progress, weights, ...(v.scene !== undefined ? { scene: { ...v.scene } } : {}) } };
  };

  /** The resolved camera, while the game has virtual cameras. */
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
    const controllers = snap.scene.entities.filter((e) => ((e.components ?? {}) as unknown as Record<string, unknown>)['controller'] !== undefined).map((e) => e.id);
    const st = controllers.length > 0 ? runtime.getInterpolatedState() : null;
    const placed = controllers.flatMap((id) => {
      const t = st !== null && st.ok ? st.state.transforms.find((x) => x.id === id) : undefined;
      return t !== undefined ? [{ id, x: t.position[0], y: t.position[1], z: t.position[2] }] : [];
    });
    const tr = placed[0]?.id === controllers[0] ? placed[0] : undefined;
    const failure = d.ok ? failureOf(d.diagnostics) : undefined;
    return {
      ok: true,
      observation: {
        snapshotId: snap.snapshotId,
        buildId: config.buildId,
        stepIndex: d.ok ? d.diagnostics.stepIndex : 0,
        simTime: d.ok ? d.diagnostics.simTime : 0,
        state: playState(),
        ...(failure !== undefined ? { error: failure } : {}),
        sound: mapSoundStatus(config.audio),
        inputMode: 'physical',
        ...(tr !== undefined ? { player: { x: tr.x, y: tr.y, z: tr.z } } : {}),
        ...(controllers.length > 1 ? { players: placed } : {}),
        ...scenesObservation(runtime, config.scenes),
        ...(hostAudio.hasLoops() && config.audio.loops !== undefined ? { loops: config.audio.loops() } : {}),
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
        resources: assets.observe(),
      },
    };
  };

  /** The named counters and every object's health (bounded; absent while empty). */
  const countersAndHealth = (rt: Runtime): Pick<GameHostObservation, 'counters' | 'health'> => {
    const c = Object.entries(rt.gameCounters?.().counters ?? {}).slice(0, 32);
    const hp = Object.entries(rt.healthsView?.() ?? {}).slice(0, 64);
    return {
      ...(c.length > 0 ? { counters: Object.fromEntries(c) } : {}),
      ...(hp.length > 0 ? { health: Object.fromEntries(hp.map(([id, x]) => [id, { current: x.current, max: x.max }])) } : {}),
    };
  };

  /** The Web Audio graph, once scripts used audio or a positional loop plays. */
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
    if (disposed) return; // idempotent (`dispose(): void`)
    disposed = true;
    mounted = false;
    // The runtime owns the frame driver: stop (cancels it) then dispose.
    // Both are no-ops/errors (never throws) when the driver is already
    // cancelled or the runtime failed.
    if (runtime !== null) {
      const rt = runtime;
      // The last steps' save requests and problems are carried out, not dropped: those the host has not
      // taken yet now, and a simulation worker's last frame (it can land after the stop) when it lands
      // (its saves then go without a picture: the view is gone).
      const saves = projectSaves;
      const finish = (): void => {
        saves?.handle(rt.takeSaveRequests?.() ?? []);
        for (const p of rt.takeProblems?.() ?? []) config.onProblem?.(p.code, p.message);
      };
      try {
        rt.stop();
        finish();
        void rt.settled?.().then(finish, () => undefined);
        rt.dispose();
      } catch {
        // The runtime is fail-stopped either way; the host drops its seam.
      }
      runtime = null;
    }
    // What this host started on the wrapper-owned audio owner stops with it (loops, script sounds, holds).
    hostAudio.dispose();
    debugConsole?.dispose();
    debugConsole = null;
    statsOverlay?.dispose();
    statsOverlay = null;
    bindings?.dispose();
    // Scripts' handles still open when the play ends are let go and reported.
    const open = assets.dispose();
    if (open.length > 0) console.warn(`[game-host] ${open.length} asset handle(s) were not released when the play ended: ${open.slice(0, 8).map((h) => `${h.handle} "${h.key}"`).join(', ')}`);
    if (uiLayer !== null) {
      uiLayer.dispose();
      uiLayer = null;
    }
    shellCtl?.dispose();
    shellCtl = null;
    pausePanel?.dispose();
    pausePanel = null;
    // The input's maps back to every map (the owner outlives this host).
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
    // does not dispose them (a new host on the same snapshot reuses them).
    // Its loops and music were stopped above; residual cues end on their own; the wrapper's final dispose closes the context.
  };

  /** The engine pause panel's targets (keys `pause:<which>`), then the project UI's. */
  const uiHitTargets = (): readonly UiHitTarget[] => {
    const g = globalThis as { innerWidth?: number; innerHeight?: number };
    const vp = { width: g.innerWidth ?? 1280, height: g.innerHeight ?? 720 };
    const panel = pausePanel?.shown === true ? pausePanel.hitTargets(vp).map((t) => ({ key: `pause:${t.key}`, rect: t.rect })) : [];
    const layer = uiLayer?.hitTargets() ?? [];
    return panel.length === 0 ? layer : [...panel, ...layer];
  };
  const clickUi = (key: string): boolean => {
    if (key.startsWith('pause:')) return pausePanel?.click(key.slice('pause:'.length)) ?? false;
    return uiLayer?.click(key) ?? false;
  };
  config.input.setUiHitTest?.((x, y) => hitUiTargets(uiHitTargets(), x, y) !== null);

  return {
    mount,
    control,
    observe,
    dispose,
    scene,
    debugCommand,
    setQuality: (level: string): GameControlResult => {
      if (disposed) return { ok: false, error: { code: 'host_disposed', message: 'the host is disposed' } };
      if (!mounted || runtime === null) return { ok: false, error: { code: 'host_not_mounted', message: 'the host is not mounted' } };
      if (config.setQuality?.(level) !== true) return { ok: false, error: { code: 'game_command_invalid', reason: 'quality_level', message: `the project has no quality level "${level}"${config.qualityLevels !== undefined ? ` (its levels: ${config.qualityLevels.ids.join(', ')})` : ''}` } };
      return { ok: true, state: playState(), acceptedAtStep: stepNow(runtime) };
    },
    uiHitTargets,
    clickUi,
    playState,
    uiElements: (max?: number) => uiLayer?.elements(max) ?? [],
    uiFontRules: () => uiLayer?.fontRules() ?? Promise.resolve(''),
    frameStats: () => hostStats.snapshot(),
    get statsOverlay(): StatsOverlay | null {
      return statsOverlay;
    },
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

