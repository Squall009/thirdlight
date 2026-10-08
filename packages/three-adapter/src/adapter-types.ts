/**
 * The scene adapter's public shapes: its options, its diagnostics block and
 * the adapter surface itself (`createSceneAdapter` in adapter.ts builds it).
 */
import type * as THREE from 'three';
import type { Runtime, RuntimeSnapshot, EnvironmentBlendView, ResourceManager } from '@thirdlight/runtime';
import type { MaterialFunctionLike } from './material-graph';
import type { MaterialDefLike, MaterialLibrary, WindLike } from './material-library';
import type { LightingBakeLike } from './lightmaps';
import type { EnvironmentLayerLike, EnvironmentLike, QualityLevel } from './environment';
import type { BlockLayerView, BlockLayerViewDiagnostics } from './block-layers';
import type { TerrainViewDiagnostics } from './terrain-view';
import type { BuiltInstanceSet, InstanceSetStats } from './instancing';
import type { ViewCullDiagnostics } from './view-cull';
import type { RuntimeMaterialsDiagnostics } from './runtime-materials';
import type { RenderControlDiagnostics, RenderControlOptions, RenderSettingsLike } from './render-control';
import type { QualityDiagnostics } from './quality-control';
import type { AdapterError } from './errors';
import type { ScreenshotResult } from './capture';
import type { RenderedNodePose } from './animator-player';
import type { ModelsSettledResult, SceneAdapterModels, SceneAdapterModelsDiagnostics } from './models';
import type { GlbLoaderPort } from './visual';
import type { ShadowReason } from './lighting';
import type { ProbeGridsObservation } from './probe-grids';
import type { ProbeLighting } from './probe-lighting';
import type { CachedShadowCounts } from './cached-shadow';
import type { EffectDefLike, EffectsDiagnostics, EffectsPlayerOptions } from './effects-player';
import type { AutoBatcherDiagnostics } from './batching';
import type { SceneGraphCounts } from './render-graph';
import type { TextureStreamer, TextureStreamingObservation } from './texture-streaming';
import type { AnyRenderer, RendererFactoryDeps, RendererInfo, RendererMemoryCounts, RendererPreference, RendererPreferenceSource } from './renderer-factory';

/**
 * What the adapter reads from whatever drives the world: a running game's
 * runtime, or an editing host's authored scene (the editor's Scene view),
 * which answers the same calls without a simulation. Everything the adapter
 * reads beyond these is optional (cast where read).
 */
export type SceneRuntime = Pick<Runtime, 'getInterpolatedState'> & Partial<Pick<Runtime, 'getDiagnostics' | 'forEachInterpolated' | 'forEachMoved' | 'sceneSet' | 'hiddenEntities' | 'entityLooks' | 'readCameraView'>>;

/** The runtime instance driving this scene (frame source + camera). */
export interface SceneAdapterOptions {
  runtime: SceneRuntime;
  /**
   * The block mesh worker's script (`block-mesh-worker.ts` bundled): block
   * chunks are meshed off the frame. Absent (or it fails to load): they mesh
   * on the page.
   */
  meshWorkerUrl?: string;
  /**
   * A build's or the project's binary buffer by digest (terrain tiles; the
   * game page's verified `manifest.buffers`, the editor's content route).
   * Absent: the models' `resolveBuffer`, if any.
   */
  resolveBuffer?: (digest: string) => Promise<ArrayBuffer>;
  /**
   * The page's decoded terrain tiles, shared with collision (a game page
   * reads its start scene's tiles before the simulation starts). Absent: the
   * adapter keeps its own, read through `resolveBuffer` and packed in a
   * worker of `meshWorkerUrl`.
   */
  terrainTiles?: import('./terrain-tile-store').TerrainTileStore;
  /** Draw terrains (default true; false: none, a diagnostic comparison). */
  terrain?: boolean;
  /** The far ground's baked horizon light (default true; false: left out, a diagnostic comparison). */
  terrainHorizon?: boolean;
  /**
   * World streaming (a game page): terrains and block layers with
   * `streaming` keep only what is round the camera, within `budgetBytes`
   * (the project's `streaming_budget_mb`); `onProblem` hears when the rings
   * alone outgrow it. Absent (the editor's Scene view): everything loaded.
   */
  streaming?: { budgetBytes: number; onProblem?: (code: string, message: string) => void };
  /** Draw the scatter rules' copies (default true; false: none, a diagnostic comparison). */
  scatter?: boolean;
  /** Draw what splines make, their meshes and pieces (default true; false: none, a diagnostic comparison). */
  splines?: boolean;
  /**
   * Something the next frame would draw differently arrived on its own (a
   * model, an instance set, a cookie): a host that draws on demand draws again.
   */
  onChange?: () => void;
  /** The scene's background where no sky is drawn (absent: the clear colour, black). */
  background?: number;
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
    /** A library the host owns and keeps current (the editor's, which its panels share): used instead of one made from `defs`, never disposed here. */
    readonly library?: MaterialLibrary;
    readonly defs: readonly MaterialDefLike[];
    /** The material functions graph materials call (the manifest's). */
    readonly functions?: readonly MaterialFunctionLike[];
    readonly wind: WindLike | null;
    readonly loadTexture: (assetId: string) => Promise<THREE.Texture | null>;
    /** The texture assets a material draws with (a swapped material is loaded before it shows; absent: none waited for). */
    readonly textureRefs?: (materialId: string) => readonly string[];
  };
  /**
   * Sky, fog, fog volumes and post-processing (the manifest's
   * environment). Absent: the scene renders as before.
   */
  environment?: {
    readonly value: EnvironmentLike;
    readonly loadTexture: (assetId: string) => Promise<THREE.Texture | null>;
    /**
     * Each scene's look (sky, fog, post, wind) over `value` (the project's
     * quality and presets): the active scene's is drawn — `start` until the
     * runtime's environment view names another — and a change of active scene
     * blends the two looks by the view's share. `look` answers for the scenes
     * read so far (a scene's look arrives with its document).
     */
    readonly scenes?: { readonly start: string | null; look(sceneId: string): EnvironmentLayerLike | null };
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
    /** An asset's verified bytes, as stored (the probe tiles' files are data, not images to decode); rejects with why not. Absent: no probe grids. */
    readonly loadBytes?: (assetId: string) => Promise<Uint8Array>;
    /** A problem for the game's author (probe tiles left out by the probe memory budget, a tile that failed to load), once per kind. */
    readonly onProblem?: (code: string, message: string) => void;
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
    /** Record GPU timestamp queries for `takeGpuTime` (used where the device has them). */
    readonly trackTimestamp?: boolean;
    /** Tests only: stubbed renderer constructors and WebGPU probe. */
    readonly deps?: Partial<RendererFactoryDeps>;
    /** Told on every renderer state change (initialising, ready, lost, rebuilt, failed): a host showing it. */
    readonly onChange?: (info: RendererInfo) => void;
  };
  /**
   * The game's visual effects (the manifest's `effects`). The
   * adapter plays `effect` components (play on start; their signals) and the
   * runtime's effect requests (scripts, gameplay hooks) — on the WebGPU
   * compute executor when the renderer draws on WebGPU, else on the CPU
   * executor. Absent: effects are not drawn.
   */
  /** The project's LOD bias and hysteresis (`lod_bias`, `lod_hysteresis`; absent: the defaults). */
  lod?: { readonly bias?: number; readonly hysteresis?: number };
  /**
   * The render settings: ambient occlusion kind, render scale and dynamic
   * resolution (the project's `ambient_occlusion`, `render_scale`,
   * `dynamic_resolution`; absent: SSAO, scale 1, off) and their page
   * diagnostics (`render-control.ts`). The editor's Scene view gives only the AO kind.
   */
  render?: RenderControlOptions;
  /** A quality level pinned over a player's choice and the project's (the page's `?quality=`, a diagnostic comparison; absent: none). */
  qualityPinned?: QualityLevel | null;
  /**
   * Draw repeated objects (boxes, model pieces with the same
   * geometry, material and shadow flags) instanced (default true). Off: one
   * draw per object, as before (tests compare the two).
   */
  batching?: boolean;
  /**
   * Static batching (with `batching` on): the meshes of static objects drawn
   * alone merged per material and world cell (`static-merge.ts`). `load`
   * (default: Play, the export) builds them before the frame is drawn;
   * `background` (the editor) within a time budget per frame, the objects
   * drawn alone until it is ready; `off` merges nothing (tests compare).
   */
  merging?: 'load' | 'background' | 'off';
  /**
   * The key light's shadow as a cached static map (static casters, drawn
   * only when they change) with a dynamic map on top (`cached-shadow.ts`;
   * default true). False: every caster drawn into one map every frame (tests
   * compare the two).
   */
  shadowCache?: boolean;
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

/**
 * The longest a present waits for a precompile that has stopped moving (ms
 * since an object last finished building). A pipeline that fails to build
 * leaves three's compileAsync unsettled; the picture must not wait out
 * PRECOMPILE_WAIT_MS for it.
 */
export const PRECOMPILE_STALL_MS = 3_000;

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
   * The key light's cached shadow: static and dynamic map draws in the last frame and in total (an idle scene
   * draws the static map 0 times a frame); ABSENT when the shadow is not cached or off.
   */
  shadowMaps?: CachedShadowCounts;
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
  /** Draws culled inside against the view (batches, instance-set chunks, merged cells) and those put in order again last frame; ABSENT before the first drawn frame. */
  viewCull?: ViewCullDiagnostics;
  /**
   * Levels of detail: the project's bias and hysteresis, the placed models' LODs and the instance-set copies that
   * changed level in the last frame, and the copies by what they draw (`instances`: the view's copies, those at
   * each level, culled past their size, thinned by distance); ABSENT before the first drawn frame.
   */
  lod?: { bias: number; hysteresis: number; switches: number; copySwitches: number; instances: InstanceSetStats };
  /** The render settings and dynamic resolution's state; `internal`: the scene pass's size in pixels (null: drawn without a post pipeline). */
  render?: RenderControlDiagnostics & { internal: [number, number] | null };
  /** The quality level drawn and its renderer settings; `keyShadowMapSize`: the key light's shadow map as drawn (absent: none). ABSENT after dispose. */
  quality?: QualityDiagnostics & { keyShadowMapSize?: number };
  /** The block layers drawn (layers, chunk meshes, triangles). */
  blocks?: BlockLayerViewDiagnostics;
  /** The terrains drawn (tiles, texture bytes, nodes selected and in view per level, draws, main-thread ms). */
  terrain?: TerrainViewDiagnostics;
  /** World streaming (a game page): the budget, what is resident per kind, in the rings, kept past them and let go for the budget. */
  streaming?: import('./world-stream').PageStreamDiagnostics;
  /** The splines' made meshes and pieces (present while an object carries a spline). */
  splines?: import('./spline-view').SplineViewDiagnostics;
  /** Rule scatter's stored copies drawn (block layers' and terrains'). */
  scatter?: import('./scatter-view').ScatterViewDiagnostics;
  /** Ground cover made near the camera. */
  cover?: import('./cover-view').CoverViewDiagnostics;
  /**
   * Graph materials — the compiled ones alive (objects with
   * different parameter values share one) and the objects carrying values
   * scripts set, with their data textures; ABSENT without project materials.
   */
  /** `swapsApplied` / `swapsPending`: material swaps put on and waiting for their materials (only once a game made one). */
  materials?: { graphMaterials: number; swapsApplied?: number; swapsPending?: number } & RuntimeMaterialsDiagnostics;
  /** Texture streaming: resident texture bytes against the budget and each streamed texture's levels; ABSENT without a streamer. */
  textures?: TextureStreamingObservation;
  /** Draw calls and triangles of the last frame (three's renderer info); ABSENT until a frame was drawn. */
  frame?: { drawCalls: number; triangles: number };
  /**
   * The three.js scene's Object3Ds by kind (only drawables, lights and their targets belong there; `containers`
   * counts the rest) and the entity nodes kept outside it; ABSENT after dispose.
   */
  sceneGraph?: SceneGraphCounts;
  /**
   * The environment renderer — its post passes drawn (in order; `post` false: none), the quality level, the
   * MSAA samples, why it fell back to the direct path (null: it did not), and the image-based lighting re-bakes
   * of a sky changed in place (a blend, a moved sun light) so far — only when it moved past a threshold; ABSENT without one.
   */
  environment?: { iblRebakes: number; post: boolean; passes: string[]; quality: QualityLevel; samples: number; fallback: string | null };
  /** The loaded scenes' baked probe tiles: listed, loaded, their probes and GPU bytes, failed loads; ABSENT without any. */
  probes?: ProbeGridsObservation;
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
  /**
   * Named nodes (bones) of an animated object's model as drawn: world
   * position and rotation after the clips and the look-at turn (null: the
   * object has no animated model drawn). For observation and tests.
   */
  renderedNodes(entityId: string, names?: readonly string[]): Record<string, RenderedNodePose> | null;
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
  /** A player's or the game-control API's quality level over the project's; false when the project has no such level. */
  setQuality?(level: QualityLevel): boolean;
  /** The project's LOD bias and hysteresis (`lod_bias`, `lod_hysteresis`); unset parts keep their value. */
  setLodTuning?(tuning: { readonly bias?: number; readonly hysteresis?: number }): void;
  /** Render settings (AO kind, render scale, dynamic resolution: a player's or the project's); unset parts keep their value. */
  setRenderSettings?(settings: RenderSettingsLike, layer?: 'project' | 'player'): void;
  /** The quality level drawn (the page's, else the chosen one, else the project's; the highest without any). */
  qualityLevel?(): QualityLevel;
  /** The GPU time (ms) and frames measured since the last call; null where nothing is measured (no timestamp queries). */
  takeGpuTime?(): { ms: number; frames: number; worst: number } | null;
  /**
   * Show an environment preset blend instead of the running
   * game's (an editor preview; null: the game's again).
   */
  previewEnvironmentBlend?(view: EnvironmentBlendView | null, tagBits?: ReadonlyMap<string, number>): void;
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

  // ---- An editing host (the editor's Scene view draws through this adapter) ----
  /** Replace the project environment (sky, fog, fog volumes, post, presets, quality; null: none). */
  setEnvironment?(value: EnvironmentLike | null): void;
  /** Replace the bakes (lightmaps, and the lights they hold leave realtime): the scenes are realized again. Needs the `lighting` option. */
  setBakes?(bakes: Readonly<Record<string, LightingBakeLike>> | null): void;
  /** The host's material library changed a material in place: the lightmapped copies follow it. */
  materialsChanged?(): void;
  /** Bring the scene set, transforms, world matrices and hidden objects up to date now, without drawing. */
  sync?(): void;
  /** An entity's world matrix as last composed (false: not realized). */
  worldMatrix?(entityId: string, out: THREE.Matrix4): boolean;
  /** What an entity shows (its node: box, light, model, instance set, overlays), or null when it shows nothing (`create`: made then, for something to follow it). */
  entityObject?(entityId: string, create?: boolean): THREE.Object3D | null;
  /** The entity a drawn object belongs to (up its logical parents to the entity's node), or null. */
  entityOf?(object: THREE.Object3D): string | null;
  /** The three.js scene drawn: the listed drawables, the lights, and what a host adds (its overlay group). */
  threeScene?(): THREE.Scene;
  /** What a ray picks among: the scene's drawables, those drawn through batches included (they are out of the scene's children). */
  pickables?(): THREE.Object3D[];
  /** Hang an object on an entity: it moves and hides with it, and stays on when the entity is realized again. */
  attachOverlay?(entityId: string, object: THREE.Object3D): void;
  detachOverlay?(entityId: string, object: THREE.Object3D): void;
  /** An entity's built instance set (picking one copy, previewing a moved copy), or null. */
  instanceSet?(entityId: string): BuiltInstanceSet | null;
  /** A loaded instance buffer (the copies' transforms), when here. */
  instanceBuffer?(digest: string): Float32Array | undefined;
  /** The model files that failed to load or build, with why (by asset id). */
  modelFailures?(): ReadonlyMap<string, { readonly code: string; readonly message: string }>;
  /** The block layers drawn (a host drives layers of its own through it: the editor's block tools). */
  blockLayers?(): BlockLayerView;
  /** The terrains drawn (null: none): tiles, texture bytes, the nodes selected per level, draws. */
  terrainDiagnostics?(): TerrainViewDiagnostics | null;
  /** The terrains drawn: their fields (picking) and stroke previews (the editor's terrain tools). */
  terrains?(): import('./terrain-view').TerrainView;
  /** The scatter rules' drawn copies (tests read their meshes). */
  scatter?(): import('./scatter-view').ScatterView;
  /** The ground cover near the camera (tests read it). */
  cover?(): import('./cover-view').CoverView;
  /** The renderer drawing now (null before it is ready). */
  currentRenderer?(): AnyRenderer | null;
  /** The probe light the materials sample (its packed tiles; the editor's probe debug view draws them), or null without probes. */
  probeLighting?(): ProbeLighting | null;
  /** The last frame was not drawn (the renderer starting, a precompile running): a host drawing on demand asks again. */
  frameSkipped?(): boolean;
  /** The last drawn frame's draw calls, triangles, MSAA samples and batches, without the whole diagnostics walk. */
  lastFrame?(): { drawCalls: number; triangles: number; samples: number; batching: AutoBatcherDiagnostics | null };
}
