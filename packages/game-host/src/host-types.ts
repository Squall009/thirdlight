/**
 * The game host's public surface: its API version, the control actions and
 * messages, what it is given (`GameHostConfig`, the injected input owner and
 * render adapter) and what it reports (`GameHostObservation` and its parts).
 * `host.ts` composes the host and re-exports all of these.
 */

import type {
  BehaviorStats,
  ActionFrame,
  CameraViewInfo,
  UiDocument,
  UiTheme,
  SimulationModuleSpec,
  GameplaySettings,
  PhysicsPort3D,
  Runtime,
  RuntimeSnapshot,
  LoadedSceneBatch,
  ModeView,
  ProjectSaveFile,
} from '@thirdlight/runtime';
import type { ScenePreloader } from './scene-preload';
import type { ResourceManager } from '@thirdlight/runtime';
import type { GameResourcesObservation } from './host-assets';
import type { AudioRow } from './host-audio';
import type { MenuSample } from '@thirdlight/input';
import type { AudioObservation, GameAudioOwner } from './audio';
import type { HostDom, HostDomNode, UiEdges } from './dom';
import type { InputBindingsController } from './rebind';
import type { Captured } from './input-bindings';
import type { SaveStorage } from './storage';
import type { DeviceStorage, ProjectSaveBackend, ProjectSaveService } from './project-saves';
import type { ProjectSavesObservation } from './host-saves';
import type { DebugConsole } from './debug-console';
import type { StatsOverlay } from './stats-overlay';
import type { UiElementObservation, UiLayerObservation, UiProjector } from './ui-layer';
import type { UiHitTarget } from './ui-hit';
import type { ShellConfigLike, ShellObservation } from './shell';

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
  diagnostics?(): { ok: true; diagnostics: { frame?: { drawCalls: number; triangles: number }; occlusion?: { path: 'off' | 'hiz'; tested: number; culled: number } } } | { ok: false };
  /** GPU time measured since the last call; null without timestamp queries. */
  takeGpuTime?(): { ms: number; frames: number; worst: number } | null;
  /** The quality level drawn. */
  qualityLevel?(): string;
  /** A player's render settings (AO kind, render scale, dynamic resolution; unset parts keep their value). */
  setRenderSettings?(settings: { readonly ambientOcclusion?: 'off' | 'ssao' | 'gtao'; readonly renderScale?: number; readonly dynamicResolution?: boolean }): void;
}


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
  readonly physics?: PhysicsPort3D;
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
  readonly qualityLevels?: { readonly ids: readonly string[]; readonly start: string; readonly now?: () => string };
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
