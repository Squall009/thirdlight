/**
 * The messages between the page and the simulation worker.
 *
 * The worker owns the deterministic simulation (runtime, physics, gameplay
 * blocks, animators, timers, spawns, scripts); the page owns input, audio, the
 * DOM (project UI, the game shell) and rendering. Everything crosses as structured-clone
 * data; per-frame transforms go as a transferred `Float64Array` (a full array
 * or the changed entities only), or through a `SharedArrayBuffer` when the page
 * is cross-origin isolated. Environment-agnostic: a browser Worker and a Node
 * worker_threads Worker carry the same messages (`SimEndpoint`).
 */
import type {
  ActionFrame,
  AudioCommand,
  AnimatorPose,
  CameraViewInfo,
  DebugCommandCall,
  DebugCommandState,
  EffectRequest,
  LoadedSceneBatch,
  PointerSample,
  GameplaySettings,
  RuntimeDiagnostics,
  RuntimeSnapshot,
  UiEventRecord,
  UiOutput,
  ModeView,
} from '@thirdlight/runtime';
import type { ManifestBehaviorRow } from './host';
import type { RelayEffect, RelayTestFrame } from './relay-input';
import type { UiHitTarget } from './ui-hit';

/** A scene's resolved entities (as the runtime loads them). */
export type SceneEntities = LoadedSceneBatch['entities'];

/** One side of the worker channel (browser `Worker`/`self`, Node `Worker`/`parentPort`). */
export interface SimEndpoint {
  post(message: unknown, transfer?: readonly unknown[]): void;
  listen(onMessage: (message: unknown) => void): void;
}

/** The page's end also owns the worker's lifetime. */
export interface SimWorkerHandle extends SimEndpoint {
  terminate(): void;
  /** The worker could not load or crashed (a script error, a blocked URL). */
  onError?(handler: (message: string) => void): void;
}

/** Floats per entity in the transform arrays: position 3, rotation 4, scale 3. */
export const TRANSFORM_STRIDE = 10;

/**
 * Engine limit: the physics engine's WebAssembly memory may grow to
 * this many bytes; past it the simulation stops with `physics_memory_limit`
 * instead of growing without bound (a runaway spawn loop, a leak). 512 MiB is
 * far above any 2D scene (the 16 000-entity benchmark uses a few MiB).
 */
export const PHYSICS_MEMORY_CAP_BYTES = 512 * 1024 * 1024;

/** Main → worker: compose the simulation. */
export interface SimInitMessage {
  readonly t: 'init';
  readonly snapshot: RuntimeSnapshot;
  readonly settings: GameplaySettings;
  /** The physics init config (plain data; the worker creates the port). Null: no physics (scene mode). */
  readonly physics: unknown;
  readonly modules?: readonly string[];
  /** The compiled behaviors: the manifest rows and, per row path, the URL the worker imports. */
  readonly behaviors: { readonly rows: readonly ManifestBehaviorRow[]; readonly urls: Readonly<Record<string, string>>; readonly enginePins: readonly { id: string; version: string; apiVersion: number }[] };
  /** A recorded input (per step): the simulation replays it exactly; no live input. */
  readonly replay?: readonly ActionFrame[];
  /** Report a digest of every executed step's committed state (determinism checks). */
  readonly digestSteps?: boolean;
  /** Transforms through shared memory (only when the page is cross-origin isolated). */
  readonly shared?: boolean;
  readonly memoryCapBytes?: number;
  /** Script variables injected at the start (ctx.save from step 0). */
  readonly variables?: Readonly<Record<string, unknown>>;
  /** The game mode runs start in (a Play start option). */
  readonly startMode?: string;
  /** The stored project settings document. */
  readonly projectSettings?: Readonly<Record<string, unknown>>;
}

/** Main → worker: one frame (the page's clock and its one input sample). */
export interface SimTickMessage {
  readonly t: 'tick';
  readonly seq: number;
  readonly now: number;
  readonly frame: ActionFrame | null;
  /** A transform buffer the page has finished with (reused by the worker). */
  readonly give?: ArrayBuffer;
  /** The page's UI hit targets when they changed while an input exercise runs. */
  readonly uiTargets?: readonly UiHitTarget[];
}

export type SimCommand =
  | { readonly op: 'setPaused'; readonly paused: boolean }
  | { readonly op: 'requestScene'; readonly sceneOp: 'load' | 'unload'; readonly sceneId: string }
  | { readonly op: 'requestArrival'; readonly sceneId: string; readonly spawnId: string }
  /** The viewport the view is drawn in (screen↔world projection's aspect). */
  | { readonly op: 'setCameraViewport'; readonly width: number; readonly height: number }
  // A debug command call, queued in the worker's runtime for its next step.
  | { readonly op: 'debugCommand'; readonly call: DebugCommandCall }
  // A storage answer (slot list, outcome, loaded save), queued in the worker's runtime for its next step.
  | { readonly op: 'saveEvent'; readonly event: import('@thirdlight/runtime').SaveEvent }
  // The page's answer to a script's asset load, queued in the worker's runtime for its next step.
  | { readonly op: 'assetAnswer'; readonly answer: import('@thirdlight/runtime').AssetHandleAnswer }
  // The player's save from the game shell (made in the worker now, between steps).
  | { readonly op: 'requestSave'; readonly slot: number; readonly meta?: import('@thirdlight/runtime').SaveMeta }
  /** A UI event, queued in the worker's runtime for its next sampled frame. */
  | { readonly op: 'uiEvent'; readonly event: UiEventRecord }
  /** A dialogue input, queued in the worker's runtime for its next sampled frame. */
  | { readonly op: 'dialogueInput'; readonly input: import('@thirdlight/runtime').DialogueInputRecord }
  | { readonly op: 'stop' };

export type SimQuery =
  | { readonly op: 'raycast'; readonly rays: readonly { origin: { x: number; y: number }; dir: { x: number; y: number }; maxDistance: number }[] }
  | { readonly op: 'overlap'; readonly shape: unknown; readonly at: { x: number; y: number } }
  | { readonly op: 'behaviorProperties'; readonly entityId: string }
  | { readonly op: 'diagnostics' }
  | { readonly op: 'debug.request'; readonly request: unknown }
  | { readonly op: 'debug.control'; readonly command: 'debugPause' | 'debugResume' | 'debugStep' }
  | { readonly op: 'debug.observation' }
  /** The run digest now and after the last exercise. */
  | { readonly op: 'runDigests' };

export type MainToWorker =
  | SimInitMessage
  | SimTickMessage
  | { readonly t: 'cmd'; readonly command: SimCommand }
  | { readonly t: 'scene'; readonly sceneId: string; readonly result: { ok: true; entities: SceneEntities } | { ok: false; message: string } }
  | { readonly t: 'relay'; readonly frames: readonly RelayTestFrame[]; readonly uiTargets?: readonly UiHitTarget[]; readonly restart?: boolean; readonly hold?: boolean }
  /** A page frame in which the game is paused while an exercise runs. */
  | { readonly t: 'relay.idle' }
  | { readonly t: 'query'; readonly id: number; readonly query: SimQuery }
  | { readonly t: 'dispose' };

/** The loaded scenes as the page mirrors them (entities only for a batch the page does not have yet). */
export interface SceneSetWire {
  readonly revision: number;
  readonly status: Readonly<Record<string, string>>;
  /** Per loaded batch: `pinned` — it holds the camera, player or start spawn, so an unload is refused. */
  readonly batches: readonly { sceneId: string; start: boolean; pinned?: string; entities?: SceneEntities }[];
  /**
   * The live spawned entities in order, each by a token that stays the same
   * while it is the same runtime object (renderers compare the objects); the
   * entity itself only the first time.
   */
  readonly spawned: readonly { readonly k: number; readonly e?: SceneEntities[number] }[];
}

/** Worker → main: the simulation's state after one frame (unchanged parts omitted). */
export interface FrameState {
  readonly seq: number;
  readonly stepIndex: number;
  readonly simTime: number;
  readonly alpha: number;
  readonly frameCount: number;
  readonly state: RuntimeDiagnostics['state'];
  readonly paused: boolean;
  readonly debugHeld: boolean;
  /** The entity order of the transform arrays (when it changed). */
  readonly ids?: readonly string[];
  /** Every entity's interpolated transform (stride 10). */
  readonly xf?: Float64Array;
  /** Only the entities that moved: their indices and values. */
  readonly xfIdx?: Uint32Array;
  readonly xfVal?: Float64Array;
  /** Shared memory: the slot the transforms are in (and the buffer when it was (re)allocated). */
  readonly xfShared?: { readonly slot: number; readonly count: number; readonly slotFloats: number; readonly buffer?: SharedArrayBuffer };
  readonly hidden?: readonly string[];
  /** The objects scripts switched off (with their children) when that changed. */
  readonly inactive?: readonly string[];
  /** The light values scripts wrote when they changed (the whole list; [] when cleared). */
  readonly lights?: readonly (readonly [string, import('@thirdlight/runtime').LightOverride])[];
  /** The look overrides when they changed (the whole list; [] when the last one was cleared). */
  readonly looks?: readonly (readonly [string, { readonly emissive?: string; readonly emissiveIntensity?: number; readonly tint?: string }])[];
  readonly poses?: readonly (readonly [string, AnimatorPose])[];
  readonly counters?: { counters: Record<string, number>; health: { current: number; max: number } | null };
  /** Every object's health (when it changed; the HUD's `$flow.health`). */
  readonly healths?: Readonly<Record<string, { readonly current: number; readonly max: number }>>;
  /** The shell's scene list entry the run is at (when it changed). */
  readonly listed?: number;
  readonly sceneSet?: SceneSetWire;
  /** The audio intent log's commands (script sound requests). */
  readonly audio?: readonly AudioCommand[];
  readonly effects?: readonly EffectRequest[];
  /**
   * The resolved camera (virtual cameras), every frame while the game has one:
   * the interpolated view [px, py, pz, qx, qy, qz, qw, fovY, near, far, letterbox] and the
   * committed view (null: no virtual camera).
   */
  readonly cam?: { readonly pose: readonly number[]; readonly view: CameraViewInfo } | null;
  /** Block-layer chunks to re-mesh (their cells now). */
  readonly grid?: readonly import('@thirdlight/runtime').GridRenderChange[];
  /** Material parameters scripts changed (one change per object, material and parameter). */
  readonly mat?: readonly import('@thirdlight/runtime').MaterialRenderChange[];
  /** The environment preset blend, interpolated with the frame's alpha (when it changed; absent until a script used it). */
  readonly env?: import('@thirdlight/runtime').EnvironmentBlendView | null;
  /** The project UI's changes since the last frame (view-model writes, shown documents, tween/focus commands). */
  readonly ui?: UiOutput;
  /** The game modes (when they changed; null: the project has none). */
  readonly mode?: ModeView | null;
  /** The cursor a script asked for (when it changed; null: the input map decides). */
  readonly cursor?: 'free' | 'locked' | null;
  /** The pointer as of the last step (when it changed; observers). */
  readonly pointer?: PointerSample | null;
  /** The binding requests scripts made in this frame (and how many were dropped over the limit). */
  readonly rb?: { readonly requests: readonly import('@thirdlight/runtime').InputBindingRequest[]; readonly dropped: number };
  readonly diag?: RuntimeDiagnostics;
  readonly digests?: readonly string[];
  readonly tickError?: { readonly code: string; readonly message: string };
  readonly memoryBytes?: number;
  /** The debug commands (registered, applied) when they changed. */
  readonly debugCommands?: DebugCommandState;
  /** The objects riding on sockets (entity, target, node) when that changed. */
  readonly sockets?: readonly { readonly entityId: string; readonly target: string; readonly node: string }[];
  /** The timelines' view (screen fade/letterbox, plays, last events) when it changed. */
  readonly tl?: import('@thirdlight/runtime').TimelineView | null;
  /** Scene loading (the scenes loading, a transition waiting, the last swap) when it changed. */
  readonly sl?: import('@thirdlight/runtime').SceneLoadingView;
  /** The save/load/delete/settings requests scripts made (the page owns storage). */
  readonly saveReq?: readonly import('@thirdlight/runtime').SaveRequest[];
  /** The asset loads and releases scripts asked for (the page holds the assets). */
  readonly assetReq?: readonly import('@thirdlight/runtime').AssetHandleRequest[];
}

export type WorkerToMain =
  | { readonly t: 'ready'; readonly state: FrameState; readonly camera: { id: string; fovY: number; near: number; far: number } | null; readonly hasScenes: boolean }
  | { readonly t: 'failed'; readonly error: { readonly code: string; readonly message: string } }
  | { readonly t: 'frame'; readonly state: FrameState }
  | { readonly t: 'scene.request'; readonly sceneId: string }
  | { readonly t: 'relay.done'; readonly from: number; readonly to: number }
  /** A relay step's UI edges or click for the page. */
  | { readonly t: 'relay.effect'; readonly effect: RelayEffect }
  | { readonly t: 'input.reset'; readonly reason?: string }
  | { readonly t: 'query.result'; readonly id: number; readonly result: unknown }
  | { readonly t: 'cmd.error'; readonly op: string; readonly error: { code: string; message: string } }
  | { readonly t: 'log'; readonly level: 'info' | 'warn' | 'error'; readonly message: string }
  | { readonly t: 'disposed' };
