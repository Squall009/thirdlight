/**
 * The scene adapter's public shapes: its options, its diagnostics block and
 * the adapter surface itself (`createSceneAdapter` in adapter.ts builds it).
 */
import type * as THREE from 'three';
import type { Runtime, RuntimeSnapshot, EnvironmentBlendView, ResourceManager } from '@thirdlight/runtime';
import type { MaterialFunctionLike } from './material-graph';
import type { MaterialDefLike, WindLike } from './material-library';
import type { LightingBakeLike } from './lightmaps';
import type { EnvironmentLayerLike, EnvironmentLike, QualityLevel } from './environment';
import type { BlockLayerViewDiagnostics } from './block-layers';
import type { RuntimeMaterialsDiagnostics } from './runtime-materials';
import type { AdapterError } from './errors';
import type { ScreenshotResult } from './capture';
import type { ModelsSettledResult, SceneAdapterModels, SceneAdapterModelsDiagnostics } from './models';
import type { GlbLoaderPort } from './visual';
import type { ShadowReason } from './lighting';
import type { EffectDefLike, EffectsDiagnostics, EffectsPlayerOptions } from './effects-player';
import type { AutoBatcherDiagnostics } from './batching';
import type { TextureStreamer, TextureStreamingObservation } from './texture-streaming';
import type { RendererFactoryDeps, RendererInfo, RendererMemoryCounts, RendererPreference, RendererPreferenceSource } from './renderer-factory';

/** The runtime instance driving this scene (frame source + camera). */
export interface SceneAdapterOptions {
  runtime: Runtime;
  /** The runtime snapshot the runtime was instantiated from (read-only scene source). */
  snapshot: RuntimeSnapshot;
  /** Renderer antialiasing (default true). */
  antialias?: boolean;
  /**
   * The page's resource manager: the models, textures, clips, environment
   * maps and effect models this adapter loads are held there and freed when
   * no one holds them (the page settles it after each frame). Absent: a
   * manager of the adapter's own.
   */
  resources?: ResourceManager;
  /**
   * The page's texture streamer (streamed KTX2 textures come from it
   * through the texture decoder): before each frame it is told what the
   * camera sees, and it loads and drops mip levels inside its budget.
   */
  textureStreamer?: TextureStreamer;
  /** The injected model surface — the
   *  resolved model-asset rows, the committed per-`modelAnimation`-entity
   *  mappings and the wrapper's verified-bytes resolver. Absent ⇒ no
   *  model realization at all (byte-stable). Requires
   *  `modelsLoader` and a v3 snapshot (fail-fast `models_config_invalid`). */
  models?: SceneAdapterModels;
  /** The injected GLB loader port (the wrapper builds it from
   *  the `@thirdlight/three-adapter/gltf-loader` subpath; the root subpath
   *  stays loader-free). Required iff `models` is present. */
  modelsLoader?: GlbLoaderPort;
  /**
   * Project materials (the manifest's), the wind, and the texture
   * decoder (bytes come from the wrapper's verified content). Absent: files
   * and boxes keep their own materials.
   */
  materials?: {
    readonly defs: readonly MaterialDefLike[];
    /** The material functions graph materials call (the manifest's). */
    readonly functions?: readonly MaterialFunctionLike[];
    readonly wind: WindLike | null;
    readonly loadTexture: (assetId: string) => Promise<THREE.Texture | null>;
  };
  /**
   * Sky, fog, fog volumes and post-processing (the manifest's
   * environment). Absent: the scene renders as before.
   */
  environment?: {
    readonly value: EnvironmentLike;
    readonly loadTexture: (assetId: string) => Promise<THREE.Texture | null>;
    /** A player's quality setting (null = the environment's). */
    readonly quality?: QualityLevel | null;
  };
  /**
   * The texture decoder for spot light cookies (bytes from the
   * wrapper's verified content). Absent: the materials' or the environment's
   * decoder, else cookies are not drawn.
   */
  lights?: {
    readonly loadTexture: (assetId: string) => Promise<THREE.Texture | null>;
  };
  /** The scenes' bakes (lightmaps; the manifest's `lighting`). */
  lighting?: {
    readonly bakes: Readonly<Record<string, LightingBakeLike>>;
    readonly loadTexture: (assetId: string) => Promise<THREE.Texture | null>;
  };
  /**
   * Which renderer backend to use and where that choice came
   * from (the page's `?renderer=` flag, the project's `render_backend`
   * setting, or the default — see `resolveRendererPreference`). Absent: the
   * default (`auto`: WebGPU where it starts, else WebGL 2).
   */
  renderer?: {
    readonly preference: RendererPreference;
    readonly source: RendererPreferenceSource;
    /** The depth buffer (the project's `depth_buffer` setting; absent: standard). */
    readonly depthBuffer?: 'standard' | 'logarithmic' | 'reversed';
    /** Tests only: stubbed renderer constructors and WebGPU probe. */
    readonly deps?: Partial<RendererFactoryDeps>;
  };
  /**
   * The game's visual effects (the manifest's `effects`). The
   * adapter plays `effect` components (play on start; their signals) and the
   * runtime's effect requests (scripts, gameplay hooks) — on the WebGPU
   * compute executor when the renderer draws on WebGPU, else on the CPU
   * executor. Absent: effects are not drawn.
   */
  /**
   * Draw repeated objects (boxes, model pieces with the same
   * geometry, material and shadow flags) instanced (default true). Off: one
   * draw per object, as before (tests compare the two).
   */
  batching?: boolean;
  /**
   * Called after each drawn frame, with the scenes that frame
   * attached (loaded scenes realized in it). The page's start and scene-load
   * timings read it; absent: nothing is called.
   */
  onFrameDrawn?: (info: FrameDrawnInfo) => void;
  effects?: {
    readonly defs: readonly EffectDefLike[];
    readonly wind?: EffectsPlayerOptions['wind'];
    readonly loadTexture: (assetId: string) => Promise<THREE.Texture | null>;
    /** A model asset's scene (mesh particles, mesh-surface shapes). */
    readonly loadModel?: (assetId: string) => Promise<THREE.Object3D | null>;
  };
}

/**
 * The longest a present waits for its precompile (ms). A
 * device that never answers must not hold the picture: past it the frame is
 * drawn and builds what is left itself.
 */
export const PRECOMPILE_WAIT_MS = 20_000;

/** What `onFrameDrawn` reports for a drawn frame. */
export interface FrameDrawnInfo {
  /** The scenes this frame attached (loaded scenes realized in it). */
  readonly realizedScenes: readonly string[];
  /** How long this frame's render call took (sync, update, draw; ms). */
  readonly renderMs: number;
  /** When the first render call of this adapter began (ms, `performance.now()`); frames before the renderer was ready were skipped. */
  readonly firstCallAt: number;
  /** The precompile this frame waited for (the first present, a scene attached): when it began (`performance.now()`) and how long it ran (ms). */
  readonly precompile?: { readonly startedAt: number; readonly ms: number };
  /** The frame's draw calls, and the scene set revision it drew (the runtime's; -1 without scenes). */
  readonly draws?: number;
  readonly sceneRevision?: number;
}

/** Adapter diagnostics block (runtime.md, separate block; the shadow
 * fields are presentation.md's — exactly two read-only fields). */
export interface SceneAdapterDiagnostics {
  /** The SELECTED graphics API: `"webgpu"` or `"webgl2"` (WebGPURenderer's
   *  backends; `"webgl1"` stays in the type for the contract but is never
   *  produced), or `null` when no backend has been selected
   *  yet (no successful render — e.g. a non-browser environment, or
   *  WebGPURenderer still initialising: the contract-prescribed absent value). */
  renderBackend: 'webgl2' | 'webgl1' | 'webgpu' | null;
  /** The renderer choice — requested backend and its source, the
   *  backend that draws, its state and why (absent until a renderer was
   *  asked for, i.e. before the first render). */
  renderer?: RendererInfo;
  /** Renderer identity string, ≤ 128 chars (null until a backend exists). */
  rendererInfo: string | null;
  canvasSize: [number, number];
  pixelRatio: number;
  /** The shadow realization result for the
   *  current scene. `on` is the planned/realized state; the first-render
   *  probe may flip it to `off` / `shadow_unsupported`. v1/v2 and scenes
   *  without a shadow-casting light are `off` / `cast_shadow_false` (the
   *  author's own choice — not an error). */
  shadows: 'on' | 'off';
  /** Present iff `shadows === 'off'`; carries no path, token or
   *  device string. Recorded once per realized scene, never per frame. */
  shadowReason?: ShadowReason;
  /**
   * v3/v4 scenes: the lights that are on — the directional,
   * ambient and hemisphere light's entity (the most recently loaded scene's
   * of each kind; null: none), the point and spot lights of the loaded
   * scenes and how many of them are on (the budget), and the spot cookies
   * drawn.
   */
  lights?: { directional: string | null; ambient: string | null; hemisphere: string | null; local: number; localOn: number; cookies: number };
  /** The bounded model-realization
   *  counters block; ABSENT when the `models` option is absent (or after
   *  dispose). Counters only: no paths, tokens, asset IDs or byte lengths.
   */
  models?: SceneAdapterModelsDiagnostics;
  /** The renderer's live GPU resources (three's `renderer.info`); ABSENT
   *  until a renderer exists. Flat counts while a scene runs — growth means
   *  something is allocated per frame and never freed. */
  gpu?: RendererMemoryCounts;
  /** The effect player — the executor (webgpu | cpu) and its caps, what plays; ABSENT without the `effects` option. */
  effects?: EffectsDiagnostics;
  /**
   * The automatic instancing of the last frame (groups, objects drawn through them, objects drawn alone); ABSENT when off or before the first drawn frame.
   * `programs` — the node programs the batches are drawn with (every pass; groups of one material and vertex layout share one).
   */
  batching?: AutoBatcherDiagnostics & { programs?: number };
  /**
   * Every mesh drawn through instance-matrix columns (automatic
   * batches and instance-set chunks) and the node programs they are drawn
   * with (every pass); ABSENT before the first drawn frame.
   */
  instanced?: { meshes: number; programs: number };
  /** The block layers drawn (layers, chunk meshes, triangles). */
  blocks?: BlockLayerViewDiagnostics;
  /**
   * Graph materials — the compiled ones alive (objects with
   * different parameter values share one) and the objects carrying values
   * scripts set, with their data textures; ABSENT without project materials.
   */
  materials?: { graphMaterials: number } & RuntimeMaterialsDiagnostics;
  /** Texture streaming: resident texture bytes against the budget and each streamed texture's levels; ABSENT without a streamer. */
  textures?: TextureStreamingObservation;
  /** Draw calls and triangles of the last frame (three's renderer info); ABSENT until a frame was drawn. */
  frame?: { drawCalls: number; triangles: number };
  /** The environment renderer — image-based lighting re-bakes of a sky changed in place (a blend, a moved sun light) so far — only when it moved past a threshold; ABSENT without one. */
  environment?: { iblRebakes: number };
  /**
   * The precompiles (`renderer.compileAsync` before the first
   * present and after each scene attach): settled, failed (the frame then
   * built its programs itself), given up after PRECOMPILE_WAIT_MS, the last
   * one's time (ms), and whether one runs now; ABSENT before the first.
   */
  precompile?: { runs: number; failed: number; gaveUp: number; lastMs: number; running: boolean };
}

export interface SceneAdapter {
  /** Sync interpolated transforms into the scene graph and render one
   *  frame. Runs as the runtime's `onFrame` (step → sync → render). */
  renderFrame(): { ok: true } | { ok: false; error: AdapterError };
  /** Capture a bounded PNG (width ≤ `maxWidth`, default 1024). */
  captureScreenshot(maxWidth?: number): { ok: true; result: ScreenshotResult } | { ok: false; error: AdapterError };
  /** A downscaled picture of a freshly drawn frame (a save slot's thumbnail); null when nothing is drawn. */
  captureThumbnail(width: number, height: number, type: 'image/jpeg' | 'image/webp', quality: number): { dataUrl: string; width: number; height: number } | null;
  /** The renderer is still starting (it initialises asynchronously): a capture now draws nothing. False once it can draw or has failed. */
  rendererStarting(): boolean;
  diagnostics(): { ok: true; diagnostics: SceneAdapterDiagnostics } | { ok: false; error: AdapterError };
  /** Idempotent (mirrors the runtime's dispose): second call ⇒
   *  `{ ok: true, alreadyDisposed: true }`. */
  dispose(): { ok: true; alreadyDisposed?: true } | { ok: false; error: AdapterError };
  /** Present iff the `models`
   *  option was given. Resolves (never rejects) when the model prepares
   *  have settled — all ready, the first hard failure, or the
   *  adapter disposed. The wrapper posts `tl.ready` on `ok: true`
   *  and `tl.error` (phase `"assets"`) on `ok: false`. */
  modelsSettled?(): Promise<ModelsSettledResult>;
  /** A player's quality setting (low/medium/high) over the environment's. */
  setQuality?(level: QualityLevel): void;
  /**
   * A look (sky, fog, post, wind) laid over the project
   * environment; null = the project environment. Needs the `environment`
   * option for sky/fog/post and the `materials` option for wind.
   */
  setEnvironmentLayer?(layer: EnvironmentLayerLike | null): void;
  /**
   * Show an environment preset blend instead of the running
   * game's (an editor preview; null: the game's again).
   */
  previewEnvironmentBlend?(view: EnvironmentBlendView | null): void;
  /**
   * Project an entity's world position (or a world point), plus
   * a world offset, through the camera of the last rendered frame: `out` =
   * [x 0 (left)–1 (right), y 0 (top)–1 (bottom), 1 in front of the camera /
   * 0 behind]. False without a camera or for an unknown entity. The game
   * host places world-anchored UI widgets with it.
   */
  projectToScreen?(target: { readonly entityId?: string; readonly point?: readonly number[]; readonly offset?: readonly number[] }, out: number[]): boolean;
  /**
   * Prepare a scene before it loads — its model files read
   * and parsed, instance buffers decoded and the textures `textures` names
   * decoded — and keep them until the scene is realized (or `release`), so
   * the frame that attaches it draws it whole. `ready` never rejects.
   */
  prepareScene?(sceneId: string, entities: readonly { readonly id: string; readonly components: unknown }[], textures?: readonly string[]): { readonly ready: Promise<void>; release(): void };
  /**
   * Parse these model files and decode these textures into the page's
   * resource manager and hold them until `release` (a script's asset
   * handle takes its own holds on them first). `ready` never rejects: a
   * file that failed is simply not resident. Textures are decoded only when
   * the project has materials (the material library decodes them).
   */
  holdAssets?(models: readonly string[], textures: readonly string[]): { readonly ready: Promise<void>; release(): void };
  /** The runtime's scene set revision the last presented frame drew (-1: none drawn yet). */
  presentedSceneRevision?(): number;
}
