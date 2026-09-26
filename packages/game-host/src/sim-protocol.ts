/**
 * Phase 22.0: the messages between the page and the simulation worker.
 *
 * The worker owns the deterministic simulation (runtime, physics, gameplay
 * blocks, animators, timers, spawns, scripts); the page owns input, audio, the
 * DOM (HUD, menus, flow) and rendering. Everything crosses as structured-clone
 * data; per-frame transforms go as a transferred `Float64Array` (a full array
 * or the changed entities only), or through a `SharedArrayBuffer` when the page
 * is cross-origin isolated. Environment-agnostic: a browser Worker and a Node
 * worker_threads Worker carry the same messages (`SimEndpoint`).
 */
import type {
  ActionFrame,
  AnimatorPose,
  DebugCommandCall,
  DebugCommandState,
  EffectRequest,
  LoadedSceneBatch,
  GameView,
  GameplaySettings,
  RunSaveState,
  RuntimeDiagnostics,
  RuntimeSnapshot,
} from '@thirdlight/runtime';
import type { ManifestBehaviorRow } from './host';

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
 * Engine limit (22.3): the physics engine's WebAssembly memory may grow to
 * this many bytes; past it the simulation stops with `physics_memory_limit`
 * instead of growing without bound (a runaway spawn loop, a leak). 512 MiB is
 * far above any 2D level (the 16 000-entity benchmark uses a few MiB).
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
  /** Phase 23.8: script variables injected at the start (ctx.save from step 0). */
  readonly variables?: Readonly<Record<string, unknown>>;
}

/** Main → worker: one frame (the page's clock and its one input sample). */
export interface SimTickMessage {
  readonly t: 'tick';
  readonly seq: number;
  readonly now: number;
  readonly frame: ActionFrame | null;
  /** A transform buffer the page has finished with (reused by the worker). */
  readonly give?: ArrayBuffer;
}

export type SimCommand =
  | { readonly op: 'gameCommand'; readonly cmd: 'start' | 'replay' }
  | { readonly op: 'startLevel'; readonly level: { scenes: readonly string[]; spawnId: string }; readonly restore?: unknown }
  | { readonly op: 'setPaused'; readonly paused: boolean }
  | { readonly op: 'requestScene'; readonly sceneOp: 'load' | 'unload'; readonly sceneId: string }
  | { readonly op: 'setViewport'; readonly width: number; readonly height: number }
  // Phase 23.8: a debug command call, queued in the worker's runtime for its next step.
  | { readonly op: 'debugCommand'; readonly call: DebugCommandCall }
  | { readonly op: 'stop' };

export type SimQuery =
  | { readonly op: 'raycast'; readonly rays: readonly { origin: { x: number; y: number }; dir: { x: number; y: number }; maxDistance: number }[] }
  | { readonly op: 'overlap'; readonly shape: unknown; readonly at: { x: number; y: number } }
  | { readonly op: 'behaviorProperties'; readonly entityId: string }
  | { readonly op: 'diagnostics' }
  | { readonly op: 'debug.request'; readonly request: unknown }
  | { readonly op: 'debug.control'; readonly command: 'debugPause' | 'debugResume' | 'debugStep' }
  | { readonly op: 'debug.observation' };

export type MainToWorker =
  | SimInitMessage
  | SimTickMessage
  | { readonly t: 'cmd'; readonly command: SimCommand }
  | { readonly t: 'scene'; readonly sceneId: string; readonly result: { ok: true; entities: SceneEntities } | { ok: false; message: string } }
  | { readonly t: 'relay'; readonly frames: readonly { stepOffset: number; moveX: number; jump: string; actions?: ActionFrame['actions'] }[] }
  | { readonly t: 'query'; readonly id: number; readonly query: SimQuery }
  | { readonly t: 'dispose' };

/** The loaded scenes as the page mirrors them (entities only for a batch the page does not have yet). */
export interface SceneSetWire {
  readonly revision: number;
  readonly status: Readonly<Record<string, string>>;
  /** Per loaded batch: `pinned` — it holds the camera, player, start spawn or a light, so an unload is refused. */
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
  readonly view?: GameView | null;
  readonly hidden?: readonly string[];
  readonly opacity?: readonly (readonly [string, number])[];
  readonly poses?: readonly (readonly [string, AnimatorPose])[];
  readonly counters?: { counters: Record<string, number>; health: { current: number; max: number } | null };
  readonly runSave?: RunSaveState;
  readonly sceneSet?: SceneSetWire;
  readonly audio?: readonly { assetId: string; volume: number; stepIndex: number }[];
  readonly effects?: readonly EffectRequest[];
  readonly diag?: RuntimeDiagnostics;
  readonly digests?: readonly string[];
  readonly tickError?: { readonly code: string; readonly message: string };
  readonly memoryBytes?: number;
  /** Phase 23.8: the debug commands (registered, applied) when they changed. */
  readonly debugCommands?: DebugCommandState;
}

export type WorkerToMain =
  | { readonly t: 'ready'; readonly state: FrameState; readonly camera: { id: string; fovY: number; near: number; far: number } | null; readonly hasScenes: boolean }
  | { readonly t: 'failed'; readonly error: { readonly code: string; readonly message: string } }
  | { readonly t: 'frame'; readonly state: FrameState }
  | { readonly t: 'scene.request'; readonly sceneId: string }
  | { readonly t: 'relay.done'; readonly from: number; readonly to: number }
  | { readonly t: 'input.reset'; readonly reason?: string }
  | { readonly t: 'query.result'; readonly id: number; readonly result: unknown }
  | { readonly t: 'cmd.error'; readonly op: string; readonly error: { code: string; message: string } }
  | { readonly t: 'log'; readonly level: 'info' | 'warn' | 'error'; readonly message: string }
  | { readonly t: 'disposed' };
