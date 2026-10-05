/**
 * The game page: one composition of a build's runtime content into a running
 * game, shared by the editor's Play page and an exported game's page.
 *
 * The caller reads the manifest and opens the catalog (`openRuntimeContent`),
 * and gives the scene the game starts with (Play: the snapshot the editor
 * sends; an export: `scene.json`, checked against the manifest). From there
 * both pages do the same thing:
 *
 *   1. the runtime snapshot: the authored scene with what the manifest and the
 *      catalog's facts carry (prefabs, rigs, block types, the material
 *      catalog, UI documents, dialogue, modes, timelines, bounds, durations…);
 *   2. the scene catalog (start scenes read once; the others on demand, read
 *      ahead and prepared before the simulation gets them);
 *   3. the verified asset reader: every declared file read once and checked
 *      against its catalog row; the start scenes' assets before the game
 *      composes (at most 8 at a time), the rest when asked for;
 *   4. the simulation in a worker unless the page, the project or the browser
 *      says otherwise, else in the page with its physics port;
 *   5. `createGameHost` with the scene adapter (models, materials, effects,
 *      lighting, the environment), input, audio and the project UI;
 *   6. the models settle: awaited (Play reports ready only after it, and a
 *      hard failure fails the start) or watched in the background (an export
 *      plays on without the failed model).
 *
 * What differs between Play and an export is injected: where files are read
 * from, the script, worker, physics and decoder URLs, the module specs, the
 * input exercise relay, the start options, the save namespace and whether
 * the debug console is on. Nothing here talks to a backend.
 *
 * Browser-only (DOM, WebGL/WebGPU, Web Audio, Web Crypto).
 */
import { audioSpatialOf, dependencyTables, depthBufferOf, instanceChunkSizeOf, materialTextureRefs, physicsDimensionOf, scanDependencies, sha256HexAsync, textureBudgetBytesOf, type MaterialDef, type ModelColliderTable, type SaveSchema } from '@thirdlight/project-model';
import { assetVersionKey, createResourceManager, EMBEDDED_TEXTURES_LISTED, embeddedTextureBytes, type ResourceManager, type ResourceObservation } from '@thirdlight/runtime';
import { attachBrowserInput, DEFAULT_INPUT_CONFIG, DEFAULT_INPUT_CONFIG_3D, focusGameSurface, type InputConfigLike } from '@thirdlight/input';
import type { RapierPhysicsInitConfig, RapierPhysicsPort, RapierStaticColliderSpec } from '@thirdlight/physics-rapier';
import { batchingFromUrl, createSceneAdapter, createTextureStreamer, decodeTexture, effectsOptionFrom, environmentHasLook, mergingFromUrl, pageSearch, resolveRendererPreference, setKtx2DecoderBase, shadowCacheFromUrl } from '@thirdlight/three-adapter';
import { createGltfLoaderPort } from '@thirdlight/three-adapter/gltf-loader';
import type { EffectDefLike, EnvironmentLike, FrameDrawnInfo, TextureStreamer, LightingBakeLike, MaterialDefLike, MaterialFunctionLike, SceneAdapter, SceneAdapterModels, SceneAdapterOptions, WindLike } from '@thirdlight/three-adapter';
import {
  modesForRuntime,
  audioDurationsFromAssetRows,
  uiDocumentsForRuntime,
  withDialogueUiDocument,
  materialCatalogOf,
  modelBoundsFromAssetRows,
  physics3DConfigOf,
  playerCapsuleOf,
  playerPhysicsOf,
  resolveSnapshotHierarchy,
  colliderSpecs2D,
  type GameMode,
  type GameplaySettings,
  type PhysicsPort3D,
  type RuntimeDialogueData,
  type RuntimeEventCue,
  type RuntimeSnapshot,
  type SimulationModuleSpec,
  type TimelineAsset,
  type UiDocument,
  type UiTheme,
  type PhysicsInitConfig3D,
} from '@thirdlight/runtime';
import {
  AssetReadError,
  browserContextFactory,
  browserMediaElementFactory,
  browserProjectSaveBackend,
  browserDeviceStorage,
  unavailableProjectSaveBackend,
  browserSaveStorage,
  browserWorkerAvailable,
  bufferResolver,
  createBrowserSimWorker,
  createGameAudioOwner,
  createGameHost,
  type AudioReport,
  createLocalSimAccess,
  createScenePreloader,
  createVerifiedAssetReader,
  linkBehaviorModules,
  loadPhysics3D,
  pageScenePreparation,
  prepareSceneCatalog,
  readProjectSettings,
  RelayActionSource,
  resolveThreadingMode,
  simDelayFromUrl,
  resolveTransport,
  startRemoteSimulation,
  startSceneAssets,
  threadingLogLine,
  type GameHost,
  type SceneLookLike,
  type GameHostConfig,
  type GameStartOptions,
  type HostDomNode,
  type ManifestBehaviorRow,
  type ManifestBufferRow,
  type ManifestContentFileRowLike,
  type ManifestSceneRow,
  type RelayUiEdgeName,
  type RemoteSimulation,
  type SimPipelineStats,
  type RuntimeCatalog,
  type RuntimeContent,
  type ShellConfigLike,
  type SimAccess,
  type StartTimings,
  type VerifiedAssetReader,
} from './index';
import type { Physics2DModule } from './physics-global';
import { pageAudio } from './page-audio';
import { mipPartsOf } from './asset-reader';
import { composeOverlay } from './overlay-capture';
import { statsOverlayModeOf } from './stats-overlay';

/** The runtime-content manifest as a game page reads it (the catalog's blocks already folded in by `openRuntimeContent`). */
export interface GamePageManifest {
  manifestVersion: number;
  type: string;
  projectId: string;
  revision: number;
  snapshotId: string;
  capturedAt: string;
  sceneDigest: string;
  contentDigest: string;
  settingsDigest: string;
  mediaDigest: string;
  settings: GameplaySettings;
  tags?: { bit: number; name: string }[];
  /** Project materials and the environment (bound by the buildId). */
  materials?: MaterialDefLike[];
  /** The material functions graph materials call. */
  materialFunctions?: MaterialFunctionLike[];
  /** The visual effects (particle system graphs). */
  effects?: EffectDefLike[];
  /** The project UI documents and themes (the game host draws them). */
  uiDocuments?: UiDocument[];
  uiThemes?: UiTheme[];
  /** The dialogue runner's data (conversations, speakers, settings). */
  dialogue?: RuntimeDialogueData;
  /** The game modes (the runtime switches them; the first is the start mode). */
  modes?: GameMode[];
  environment?: EnvironmentLike & { wind?: WindLike };
  /** The scenes' bakes. */
  lighting?: Record<string, LightingBakeLike>;
  /** The animator controllers. */
  animators?: unknown[];
  /** Model rigs (sockets are resolved on them). */
  rigs?: Record<string, unknown>;
  /** The models' `_COL` parts (colliders `{type: 'model'}` are made of them). */
  modelColliders?: ModelColliderTable;
  /** The prefab definitions scripts spawn. */
  prefabs?: unknown[];
  /** The block types and cell fields block layers use. */
  blockTypes?: unknown[];
  cellFields?: unknown[];
  /** The input actions. */
  input?: InputConfigLike;
  /** The named collision layers. */
  collisionLayers?: readonly string[];
  saveSchema?: SaveSchema;
  /** The timelines. */
  timelines?: TimelineAsset[];
  /** The event → cue table. */
  eventCues?: RuntimeEventCue[];
  /** The game shell (menus and HUD documents, the scene list). */
  shell?: ShellConfigLike;
  /** Every scene of a v4 project and the instance-set buffers. */
  scenes?: ManifestSceneRow[];
  buffers?: ManifestBufferRow[];
  /** The content files the document lists (materials, UI documents, dialogue and buffers above come from them). */
  contentFiles?: ManifestContentFileRowLike[];
  /** The asset rows the start needs (a v5 catalog; a v4 build lists them all). */
  assets: Array<{ assetId: string; version: number; path: string; kind: string; sourceDigest: string; sourceByteLength: number }>;
  /** The resolved media identity: cue slots and one `modelAnimation` row per entity. */
  media: { cues: Record<string, unknown>; animation: Array<{ entityId: string; assetId: string; version: number; profileDigest: string; roles: Record<string, unknown> }> };
  buildId: string;
}

/** A failed start: the load phase it failed in and the accepted code. */
export class GamePageError extends Error {
  readonly code: string;
  readonly phase: string;
  constructor(code: string, phase: string, message: string) {
    super(message);
    this.code = code;
    this.phase = phase;
  }
}

export interface GamePageOptions {
  /** The opened runtime content (its buildId already verified). */
  readonly content: RuntimeContent<GamePageManifest>;
  /** The authored start: the scene with the capture's snapshotId, projectId, revision and tags. */
  readonly snapshot: RuntimeSnapshot;
  /** Read a declared artifact by its manifest path (every read is checked against its row by the caller's reader users). */
  readonly read: (path: string) => Promise<ArrayBuffer>;
  /** The absolute URL a compiled script is imported from. */
  readonly scriptUrl: (path: string) => string;
  /** The same-origin URL of a declared artifact (a streamed audio file is played from it); absent: streams are read whole. */
  readonly assetUrl?: (path: string) => string;
  /** The simulation worker's script and the 3D physics backend's script. */
  readonly workerUrl: string;
  readonly physics3dUrl: string;
  /**
   * The 2D physics backend, for the simulation on this page (a worker loads its
   * own). Injected so the page bundle links the 2D engine only where its entry
   * chooses to: Play links it, an export loads its separate `physics-2d.js`.
   */
  readonly physics2d: () => Promise<Physics2DModule>;
  /** The block mesh worker's script (absent: block chunks mesh on the page). */
  readonly meshWorkerUrl?: string;
  /** Where three's Draco and Basis decoders are served (ends in `/`). */
  readonly decoderBase: string;
  /** The simulation module specs this page links. */
  readonly moduleSpecs: readonly SimulationModuleSpec[];
  readonly canvas: HTMLCanvasElement;
  /** The HUD root the host owns. */
  readonly container: HostDomNode;
  /** Where this game's saves live in the player's browser (Play and exported games keep separate ones). */
  readonly saveNamespace: string;
  readonly debugConsole: boolean;
  /** Measure the GPU's frame time (timestamp queries, where the device has them) — Play; an export only with the stats overlay. */
  readonly measureGpu?: boolean;
  /**
   * The input exercise's relay (Play: tools drive the game through it and
   * read the simulation through `access`); absent, the physical input only.
   */
  readonly relay?: boolean;
  /** A test or debug start: host options, script variables, the thread mode. */
  readonly start?: { readonly options?: GameStartOptions; readonly variables?: Record<string, unknown>; readonly threads?: 'worker' | 'single' };
  /** Resolve only after the models settle, and fail the start on a hard failure; else watched in the background. */
  readonly waitForModels?: boolean;
  /** A background model settle failed (the game plays on without the failed model). */
  readonly onModelsFailed?: (code: string) => void;
  /** Truthful load progress. */
  readonly onProgress?: (phase: string, loadedBytes: number, totalBytes: number) => void;
  /** A problem the game reports for its author, once per kind (Play: a Problems line; the export has no one to tell). */
  readonly onProblem?: (code: string, message: string) => void;
  /** The page's start timings. */
  readonly timings?: StartTimings;
}

export interface GamePageHandle {
  readonly host: GameHost;
  /** The simulation's async surface with the relay (null without `relay`). */
  readonly access: SimAccess | null;
  /** Where the simulation runs; `pipeline`: how the page's frames met the worker's (null on a single thread). */
  readonly threading: { readonly mode: 'worker' | 'single'; readonly reason: string; readonly transport: 'shared' | 'message' | null; readonly isolated: boolean; readonly pipeline: SimPipelineStats | null };
  readonly adapter: SceneAdapter | null;
  /** The verified identity: the snapshot's id and revision, the build and its content digest, the step after the settle. */
  readonly identity: { snapshotId: string; revision: number; buildId: string; contentDigest: string; stepIndex: number };
  readonly stepHz: number;
  /** The input bindings in effect (a player's rebinding changes them). */
  readonly inputConfig: () => InputConfigLike;
  /** The asset reads so far and their verified bytes. */
  assetReads(): { reads: number; bytes: number };
  /** Catalog files read so far (the root and blocks at the start, then dependency files and entry shards as asked). */
  catalogReads(): { files: number; bytes: number };
  /** What is loaded from assets now (resident per kind, loads, frees, script handles alive). */
  resources(): ResourceObservation;
  /** The sound: unlock state, what plays, what did not play and why (Play diagnostics' audio block). */
  audio(): AudioReport | null;
  /** A captured frame (PNG data URL) with the page's UI and overlays drawn over it, as the player sees it. */
  withOverlay(frame: { readonly dataUrl: string; readonly width: number; readonly height: number }): Promise<string>;
  dispose(): void;
}

const sha256Hex = sha256HexAsync;

/** The start scenes' bytes, read before the game composes. */
const START_HOLDER = 'start';
/** How long the start's bytes wait for the renderer to start drawing (a device that never does must not keep them). */
const START_HOLD_MAX_MS = 30_000;

/**
 * Let go of the start's bytes once the adapter's renderer has started (its
 * environment and lightmaps took their textures then) and the models settled.
 */
function releaseStartWhenDrawn(adapter: SceneAdapter | null, hasModels: boolean, reader: VerifiedAssetReader): void {
  const t0 = Date.now();
  const settled = hasModels && adapter?.modelsSettled !== undefined ? adapter.modelsSettled().then(() => undefined) : Promise.resolve();
  void settled.then(() => {
    const check = (): void => {
      if (adapter === null || adapter.rendererStarting() !== true || Date.now() - t0 > START_HOLD_MAX_MS) {
        reader.release(START_HOLDER);
        return;
      }
      setTimeout(check, 100);
    };
    check();
  });
}

/** The assetIds the scene references through a `model` component. */
function referencedModelAssetIds(snapshot: RuntimeSnapshot): Set<string> {
  const out = new Set<string>();
  for (const entity of snapshot.scene.entities) {
    const model = ((entity.components ?? {}) as unknown as Record<string, unknown>)['model'] as { asset?: { assetId?: string } } | undefined;
    if (model !== undefined && typeof model.asset?.assetId === 'string') out.add(model.asset.assetId);
  }
  return out;
}

/** The adapter's row of one model (id, version, digest; tint, material map, clips' rig). */
function modelRowOf(r: { assetId: string; version: number; sourceDigest: string }): SceneAdapterModels['assets'][number] {
  const x = r as { vertexColors?: unknown; materials?: unknown; clipsFor?: unknown; textures?: unknown };
  return { assetId: r.assetId, version: r.version, sourceDigest: r.sourceDigest, ...(x.vertexColors === 'tint' ? { vertexColors: 'tint' as const } : {}), ...(x.materials !== undefined ? { materials: x.materials as Record<string, string> } : {}), ...(typeof x.clipsFor === 'string' ? { clipsFor: x.clipsFor } : {}), ...(x.textures !== undefined ? { textures: x.textures as Record<string, string> } : {}) };
}

/**
 * The `models` block, or null when nothing uses a model (the adapter then
 * stays loader-free). Scenes loaded later may use any model of the build: a
 * v4 manifest lists them all; a v5 catalog lists what the start needs, and the
 * adapter finds the others' rows as their scenes are read (or reads their shard).
 */
function buildModelsBlock(manifest: GamePageManifest, snapshot: RuntimeSnapshot, reader: VerifiedAssetReader, read: (path: string) => Promise<ArrayBuffer>, content: { readonly catalog: RuntimeCatalog; readonly facts: readonly Readonly<Record<string, unknown>>[] }): SceneAdapterModels | null {
  const referenced = manifest.scenes !== undefined ? new Set(manifest.assets.filter((a) => a.kind === 'model').map((a) => a.assetId)) : referencedModelAssetIds(snapshot);
  const lazy = content.catalog.version === 5 && content.facts.some((f) => f['kind'] === 'model');
  if (referenced.size === 0 && !lazy) return null;
  const modelRows = manifest.assets.filter((a) => a.kind === 'model' && referenced.has(a.assetId));
  // A scene naming a model the build does not declare is a captured-state integrity failure.
  if (modelRows.length !== referenced.size) {
    const missing = [...referenced].filter((id) => !modelRows.some((r) => r.assetId === id));
    throw new GamePageError('models_asset_unresolved', 'assets', `the scene references model asset(s) absent from the manifest: ${missing.join(', ')}`);
  }
  for (const row of manifest.media.animation) {
    if (typeof row.entityId !== 'string' || typeof row.assetId !== 'string' || typeof row.version !== 'number' || typeof row.profileDigest !== 'string' || typeof row.roles !== 'object' || row.roles === null) {
      throw new GamePageError('models_config_invalid', 'assets', 'the manifest media.animation row shape is invalid');
    }
  }
  return {
    assets: modelRows.map(modelRowOf),
    ...(lazy
      ? {
          rowOf: (assetId: string) => {
            const r = content.catalog.row(assetId);
            return r !== undefined && r.kind === 'model' ? modelRowOf(r) : undefined;
          },
          findRow: (assetId: string) => content.catalog.lookup(assetId).then((r) => (r !== undefined && r.kind === 'model' ? modelRowOf(r) : undefined)),
        }
      : {}),
    animation: manifest.media.animation.map((r) => ({ entityId: r.entityId, roles: r.roles as never, version: r.version })),
    // The project's idle/run/airborne blend time.
    ...(manifest.settings.animation_crossfade_s !== undefined ? { crossfadeSeconds: manifest.settings.animation_crossfade_s } : {}),
    // The project's instance-set chunk size.
    ...(instanceChunkSizeOf(manifest.settings) !== undefined ? { instanceChunkSize: instanceChunkSizeOf(manifest.settings) } : {}),
    // Read (once, checked) when the model is first needed — at start for the start scenes' models.
    resolveBytes: (assetId: string, version: number): Promise<ArrayBuffer> => reader.bytes(assetId, version),
    ...(manifest.buffers !== undefined ? { resolveBuffer: bufferResolver(manifest.buffers, { read, sha256Hex }) } : {}),
  };
}

/** What a script may load by name: an entry of the build's loadable index. */
interface LoadableEntryLike {
  readonly kind: string;
  readonly id: string;
  readonly address?: string;
  readonly labels?: readonly string[];
}

/**
 * The page's side of `ctx.assets.load(key)`: the key resolved (an address
 * first, then an asset or resource id, then a label: every entry carrying
 * it), what those name found (a resource's models, materials and textures by
 * the same scan as the build's dependency lists), models parsed and textures
 * decoded by the adapter, any other file's verified bytes read, and all of it
 * held for `holder` in the page's resource manager until the handle is
 * released. Rejects (holding nothing) when the key names nothing in this
 * build or a file could not be loaded.
 */
function pageAssetLoader(o: {
  readonly manifest: GamePageManifest;
  readonly catalog: RuntimeCatalog;
  readonly reader: VerifiedAssetReader;
  readonly resources: ResourceManager;
  readonly adapter: () => SceneAdapter | null;
}): (key: string, holder: string) => Promise<readonly string[]> {
  const m = o.manifest as GamePageManifest & { loadable?: readonly LoadableEntryLike[]; animators?: readonly { controllerId: string }[]; prefabs?: readonly { prefabId: string }[] };
  const resourcesById = new Map<string, unknown>();
  for (const p of m.prefabs ?? []) resourcesById.set(p.prefabId, p);
  for (const x of m.materials ?? []) resourcesById.set(x.materialId, x);
  for (const x of m.materialFunctions ?? []) resourcesById.set((x as { graphId: string }).graphId, x);
  for (const x of m.effects ?? []) resourcesById.set((x as { effectId: string }).effectId, x);
  for (const x of m.animators ?? []) resourcesById.set(x.controllerId, x);
  const loadable = async (): Promise<readonly LoadableEntryLike[]> => (o.catalog.version === 4 ? (m.loadable ?? []) : o.catalog.loadable());
  /** The ids a key names (sorted): its address, else an asset or a resource with that id, else every entry with that label. */
  const resolve = async (key: string): Promise<string[]> => {
    const entries = await loadable();
    const addressed = entries.find((e) => e.address === key);
    if (addressed !== undefined) return [addressed.id];
    if ((await o.catalog.lookup(key)) !== undefined || resourcesById.has(key)) return [key];
    return [...new Set(entries.filter((e) => e.labels?.includes(key) === true).map((e) => e.id))].sort();
  };
  return async (key, holder) => {
    const ids = await resolve(key);
    if (ids.length === 0) throw new Error(`nothing in this build is named "${key.slice(0, 64)}" (an asset id, an address or a label)`);
    // Every asset the named assets and resources need: the rows read so far know every asset a
    // project-wide resource names (the build's shared dependency list); a named asset is looked up.
    const named = await Promise.all(ids.map((id) => o.catalog.lookup(id)));
    const tables = dependencyTables({ assets: o.catalog.known(), ...(m.materials !== undefined ? { materials: m.materials as { materialId: string }[] } : {}), ...(m.materialFunctions !== undefined ? { functions: m.materialFunctions as { graphId: string }[] } : {}), ...(m.effects !== undefined ? { effects: m.effects as { effectId: string }[] } : {}), ...(m.animators !== undefined ? { animators: m.animators } : {}), ...(m.prefabs !== undefined ? { prefabs: m.prefabs } : {}) });
    const roots = ids.map((id, i) => (named[i] !== undefined ? id : resourcesById.get(id)));
    const needed = scanDependencies(tables, roots);
    const rows = (await Promise.all(needed.map((id) => o.catalog.lookup(id)))).filter((r): r is NonNullable<typeof r> => r !== undefined);
    const adapter = o.adapter();
    const canDecode = adapter?.holdAssets !== undefined;
    const models = canDecode ? rows.filter((r) => r.kind === 'model') : [];
    const textures = canDecode ? rows.filter((r) => r.kind === 'texture') : [];
    const decoded = new Set([...models, ...textures]);
    const files = rows.filter((r) => !decoded.has(r));
    const reading = `${holder}/read`;
    const hold = adapter?.holdAssets?.(models.map((r) => r.assetId), textures.map((r) => r.assetId)) ?? null;
    try {
      await Promise.all([o.reader.preload(files, undefined, reading), hold?.ready]);
      // The handle takes its own holds, then the loads' holds go: the handle is what keeps them.
      const missing: string[] = [];
      for (const r of models) {
        const k = assetVersionKey(r.assetId, r.version);
        if (!o.resources.hold('model', k, holder) && !o.resources.hold('clip', k, holder)) missing.push(r.assetId);
      }
      // A project without materials has no texture decoder: its textures are held as their verified bytes.
      const undecoded = textures.filter((r) => !o.resources.hold('texture', r.assetId, holder));
      if (undecoded.length > 0) await o.reader.preload(undecoded, undefined, reading);
      for (const r of [...files, ...undecoded]) o.resources.hold('bytes', assetVersionKey(r.assetId, r.version), holder);
      if (missing.length > 0) throw new Error(`${missing.length} of ${rows.length} files could not be loaded: ${missing.slice(0, 4).join(', ')}${missing.length > 4 ? ', …' : ''}`);
      return ids;
    } catch (e) {
      o.resources.releaseHolder(holder);
      throw e;
    } finally {
      hold?.release();
      o.reader.release(reading);
    }
  };
}

/**
 * The scene-derived Rapier init config (statics + the player controllers:
 * the first as the port's character, the others as its further characters)
 * with the resolved `gravity_y`.
 */
function physicsConfigFromSnapshot(snapshot: RuntimeSnapshot, settings: GameplaySettings): RapierPhysicsInitConfig | null {
  const statics: RapierStaticColliderSpec[] = [];
  const players: { id: string; character: RapierPhysicsInitConfig['character']; controller: RapierPhysicsInitConfig['controller'] }[] = [];
  // The shared rule (each where it is in the world, turned about Z with it; movers kinematic; one-way platforms).
  statics.push(...(colliderSpecs2D(snapshot.scene.entities as never, snapshot.modelColliders !== undefined ? { modelColliders: snapshot.modelColliders } : undefined) as RapierStaticColliderSpec[]));
  for (const entity of snapshot.scene.entities) {
    const components = (entity.components ?? {}) as unknown as Record<string, unknown>;
    const transform = components['transform'] as { position?: number[]; rotation?: number[]; scale?: number[] } | undefined;
    const position = transform?.position ?? [0, 0, 0];
    if (components['controller'] === undefined) continue;
    // Each player's own capsule, skin, ground snap and autostep (else the defaults).
    const capsule = playerCapsuleOf(components['controller']);
    const tuning = playerPhysicsOf(components['controller']);
    players.push({
      id: entity.id,
      character: {
        x: position[0] ?? 0,
        y: position[1] ?? 0,
        radius: capsule.radius,
        halfHeight: capsule.halfHeight,
        offset: { x: capsule.offset.x, y: capsule.offset.y },
        parentId: (entity as { parentId?: string | null }).parentId ?? null,
        rotation: (transform?.rotation ?? [0, 0, 0, 1]) as [number, number, number, number],
        scale: (transform?.scale ?? [1, 1, 1]) as [number, number, number],
      },
      controller: {
        offsetSkin: tuning.offsetSkin,
        groundSnap: tuning.groundSnap,
        maxSlopeClimbRad: (settings.max_slope_climb_deg * Math.PI) / 180,
        minSlopeSlideRad: (settings.min_slope_slide_deg * Math.PI) / 180,
        autostep: tuning.autostep,
        ...(tuning.autostep ? { autostepHeight: tuning.autostepHeight } : {}),
      },
    });
  }
  const first = players[0];
  if (first === undefined) return null;
  return {
    character: first.character,
    ...(players.length > 1 ? { characters: players.slice(1).map((p) => ({ ...p.character, id: p.id, controller: p.controller })) } : {}),
    statics,
    solver: { hz: settings.fixed_step_hz ?? 120, gravityY: settings.gravity_y },
    controller: first.controller,
  };
}

/**
 * A texture asset, decoded from the verified bytes: read (once, checked) when
 * a material, a model's extracted image, a bake, the sky or a spot cookie first
 * needs it (its row from the catalog); a streamed texture reads its head (the
 * mip tail) and streams larger levels as it is drawn.
 */
function pageTextureLoader(reader: VerifiedAssetReader, catalog: RuntimeCatalog, streamer: TextureStreamer): NonNullable<SceneAdapterOptions['materials']>['loadTexture'] {
  return (assetId) =>
    catalog.lookup(assetId).then(
      (row) => {
        if (row === undefined || row.kind !== 'texture') return null;
        const parts = mipPartsOf(row);
        if (parts !== null) return streamer.open(row.assetId, { parts, read: (index) => reader.part(row, index) }).catch(() => null);
        return reader.bytes(row.assetId, row.version).then((buf) => decodeTexture(buf), () => null);
      },
      () => null,
    );
}

/** Each shipped material's texture assets (what a material swap loads before it shows). */
function materialTexturesOf(manifest: GamePageManifest): (materialId: string) => readonly string[] {
  const byId = new Map((manifest.materials ?? []).map((m) => [m.materialId, m]));
  const memo = new Map<string, readonly string[]>();
  return (materialId) => {
    let refs = memo.get(materialId);
    if (refs === undefined) {
      const def = byId.get(materialId);
      refs = def === undefined ? [] : materialTextureRefs(def as unknown as MaterialDef);
      memo.set(materialId, refs);
    }
    return refs;
  };
}

/** The adapter's materials, environment, lighting and light options (textures from the verified bytes). */
function materialsOptionOf(manifest: GamePageManifest, env: GamePageManifest['environment'], scenes: { start: string | null; look(sceneId: string): SceneLookLike | null } | null, loadTexture: NonNullable<SceneAdapterOptions['materials']>['loadTexture'], streamer: TextureStreamer): { materials?: SceneAdapterOptions['materials']; environment?: SceneAdapterOptions['environment']; lighting?: SceneAdapterOptions['lighting']; lights: NonNullable<SceneAdapterOptions['lights']> } {
  // A sky, a cookie or a lightmap is not a mesh's surface whose size on screen says what it needs: a streamed texture they draw is kept at full size.
  const loadWhole: typeof loadTexture = (assetId) =>
    loadTexture(assetId).then((t) => {
      if (t !== null) streamer.pin(t);
      return t;
    });
  const lights = { loadTexture: loadWhole };
  if (manifest.materials === undefined && env === undefined && manifest.lighting === undefined && scenes === null) return { lights };
  return {
    lights,
    // The scenes' looks: the active scene's is drawn (the adapter draws nothing until there is a look, presets or a blend).
    ...(scenes !== null
      ? { environment: { value: manifest.environment ?? {}, loadTexture: loadWhole, scenes: scenes as NonNullable<NonNullable<SceneAdapterOptions['environment']>['scenes']> } }
      : // Environment presets need the environment renderer too (scripts blend the look).
        environmentHasLook(env) || (env?.presets?.length ?? 0) > 0
        ? { environment: { value: env ?? {}, loadTexture: loadWhole } }
        : {}),
    ...(manifest.lighting !== undefined ? { lighting: { bakes: manifest.lighting, loadTexture: loadWhole } } : {}),
    materials: { defs: manifest.materials ?? [], functions: manifest.materialFunctions ?? [], wind: env?.wind ?? null, loadTexture, textureRefs: materialTexturesOf(manifest) },
  };
}

/** The runtime snapshot: the authored start with what the verified manifest and the catalog's facts carry. */
function runtimeSnapshotOf(authored: RuntimeSnapshot, content: RuntimeContent<GamePageManifest>, sceneRows: RuntimeSnapshot['scenes'] | null): { snapshot: RuntimeSnapshot; modeRows: ReturnType<typeof modesForRuntime>; uiDocs: ReturnType<typeof withDialogueUiDocument> } {
  const manifest = content.manifest;
  const facts = content.facts;
  const modelBounds = modelBoundsFromAssetRows(facts as readonly { assetId: string; kind?: string; bounds?: unknown }[]);
  const audioDurations = audioDurationsFromAssetRows(facts as readonly { assetId: string; kind?: string; durationMs?: unknown }[]);
  const materialCatalog = materialCatalogOf(manifest.materials as Parameters<typeof materialCatalogOf>[0], facts as Parameters<typeof materialCatalogOf>[1]);
  // The engine's dialogue document joins the project's when the game has conversations.
  const uiDocs = withDialogueUiDocument(manifest.uiDocuments, manifest.dialogue ?? null);
  const uiRows = uiDocumentsForRuntime(uiDocs);
  const modeRows = modesForRuntime(manifest.modes, manifest.input ?? (physicsDimensionOf(manifest.settings) === 3 ? DEFAULT_INPUT_CONFIG_3D : DEFAULT_INPUT_CONFIG));
  const presetIds = (manifest.environment?.presets ?? []).map((p) => p.presetId);
  const snapshot = resolveSnapshotHierarchy({
    ...authored,
    ...(manifest.animators !== undefined ? { animators: manifest.animators } : {}),
    // The prefabs scripts spawn.
    ...(manifest.prefabs !== undefined ? { prefabs: manifest.prefabs } : {}),
    ...(manifest.blockTypes !== undefined ? { blockTypes: manifest.blockTypes } : {}),
    ...(manifest.cellFields !== undefined ? { cellFields: manifest.cellFields } : {}),
    // A pickup without a size collects over its model's recorded bounds.
    ...(modelBounds !== undefined ? { modelBounds } : {}),
    // The model rigs sockets are resolved on.
    ...(manifest.rigs !== undefined ? { rigs: manifest.rigs } : {}),
    // The models' collision parts colliders `{type: 'model'}` are made of.
    ...(manifest.modelColliders !== undefined ? { modelColliders: manifest.modelColliders } : {}),
    // The graph materials' parameters scripts set per object (ctx.materials).
    ...(materialCatalog !== undefined ? { materialCatalog } : {}),
    // The materials a swap may name (every material the game ships).
    ...(manifest.materials !== undefined ? { materialIds: manifest.materials.map((m) => m.materialId) } : {}),
    ...(manifest.saveSchema !== undefined ? { saveSchema: manifest.saveSchema } : {}),
    ...(uiRows !== undefined ? { uiDocuments: uiRows } : {}),
    ...(manifest.dialogue !== undefined ? { dialogue: manifest.dialogue } : {}),
    ...(manifest.timelines !== undefined && manifest.timelines.length > 0 ? { timelines: manifest.timelines } : {}),
    ...(manifest.eventCues !== undefined && manifest.eventCues.length > 0 ? { eventCues: manifest.eventCues } : {}),
    // The shell's scene list (the `scene` UI event walks it).
    ...(manifest.shell?.scenes !== undefined ? { sceneList: manifest.shell.scenes } : {}),
    // Script sounds' finished events are computed from the recorded durations.
    ...(audioDurations !== undefined ? { audioDurations } : {}),
    ...(modeRows !== undefined ? { modes: modeRows } : {}),
    // The environment preset ids scripts switch and blend to (ctx.environment).
    ...(presetIds.length > 0 ? { environmentPresets: presetIds } : {}),
    ...(sceneRows !== null ? { scenes: sceneRows } : {}),
  } as unknown as RuntimeSnapshot);
  return { snapshot, modeRows, uiDocs };
}

/**
 * Start a game from opened runtime content. A failed read, verification,
 * mount or (with `waitForModels`) model prepare throws a `GamePageError`
 * (or the underlying error) after releasing everything it attached.
 */
export async function startGamePage(o: GamePageOptions): Promise<GamePageHandle> {
  const { content, timings } = o;
  const manifest = content.manifest;
  const onProgress = o.onProgress ?? (() => undefined);
  const settings = manifest.settings;
  // KTX2 textures (and GLBs with KHR_texture_basisu) transcode with three's Basis files there.
  setKtx2DecoderBase(o.decoderBase);
  const io = { read: o.read, sha256Hex };

  // The scene catalog: start scenes read once for their members, the others on demand.
  timings?.begin('startScenes');
  // Each scene's look as its document is read (the active scene's draws: the first start scene's at first).
  const sceneLooks = new Map<string, SceneLookLike | null>();
  const catalog0 = manifest.scenes !== undefined ? await prepareSceneCatalog(manifest.scenes, io, content.catalog, (sceneId, look) => sceneLooks.set(sceneId, look)) : null;
  const firstStart = manifest.scenes?.find((r) => r.start)?.sceneId;
  const startLook = firstStart !== undefined ? (sceneLooks.get(firstStart) ?? null) : null;
  // The environment the page starts with: the project's quality and presets with the start scene's look (its textures are read with the start's).
  const environment = startLook === null ? manifest.environment : ({ ...(manifest.environment ?? {}), ...startLook } as GamePageManifest['environment']);
  timings?.end('startScenes');
  // Scene loads go through the preloader (read, then prepared on the render side before the
  // simulation gets them; the scenes a game is likely to load next are read ahead). Each is timed.
  const scenes =
    catalog0 === null
      ? null
      : createScenePreloader({
          read: catalog0.loadScene,
          ...(timings !== undefined
            ? {
                hooks: {
                  requested: (sceneId: string, preloaded: boolean) => timings.sceneRequested(sceneId, preloaded),
                  read: (sceneId: string, n: number) => timings.sceneRead(sceneId, n),
                  prepared: (sceneId: string, n: number) => timings.scenePrepared(sceneId, n),
                  failed: (sceneId: string, message: string) => timings.sceneFailed(sceneId, message),
                },
              }
            : {}),
        });
  const catalog = catalog0 === null || scenes === null ? null : { rows: catalog0.rows, loadScene: scenes.load };
  // The scene as the game loads it (folders and inactive entities resolved away): physics, the renderer and the runtime all use this one.
  const { snapshot, modeRows, uiDocs } = runtimeSnapshotOf(o.snapshot, content, catalog?.rows ?? null);

  // Everything this page loads from assets is held in one resource manager (the host settles it after
  // each frame): the reader's bytes, the adapter's models and textures, the decoded sounds, the UI's images.
  const resources = createResourceManager();
  // Every declared asset is read through this reader, checked against its catalog row.
  const assetReader = createVerifiedAssetReader(manifest.assets, io, { catalog: content.catalog, resources });
  // Streamed textures load the mips their size on screen needs, inside the project's texture budget
  // (the manager's texture entries follow their resident size). The images model files carry inside
  // them are textures on the GPU like any other: the budget counts them, so they press on the streamed ones.
  const textureStreamer = createTextureStreamer({
    budgetBytes: textureBudgetBytesOf(settings as unknown as Readonly<Record<string, unknown>>),
    textureBytes: () => {
      const o = resources.observe();
      return (o.resident.texture?.bytes ?? 0) + embeddedTextureBytes(o);
    },
    onResize: (id, texture, bytes) => resources.resize('texture', id, texture, bytes),
  });
  // A 3D project's physics is the 3D backend; a plain scene (no player controller) plays without physics.
  const physicsConfig: RapierPhysicsInitConfig | PhysicsInitConfig3D | null = physicsDimensionOf(settings) === 3 ? physics3DConfigOf(snapshot.scene.entities as never, settings, { layers: manifest.collisionLayers ?? [], ...(snapshot.modelColliders !== undefined ? { modelColliders: snapshot.modelColliders } : {}) }) : physicsConfigFromSnapshot(snapshot, settings);
  // The bindings in effect (a player's rebinding changes them): the project's actions, else the defaults.
  let inputConfigNow: InputConfigLike = manifest.input ?? (physicsDimensionOf(settings) === 3 ? DEFAULT_INPUT_CONFIG_3D : DEFAULT_INPUT_CONFIG);
  const browserInput = attachBrowserInput(o.canvas, { inputConfig: inputConfigNow });
  // What this composition attaches to the page is released with it and on every failure path
  // (a new start composes again on the same canvas).
  const releases: (() => void)[] = [() => resources.dispose(), () => textureStreamer.dispose(), () => browserInput.dispose(), focusGameSurface(o.canvas), ...(scenes !== null ? [() => scenes.dispose()] : [])];
  const releaseAll = (): void => {
    for (const r of releases.splice(0).reverse()) {
      try {
        r();
      } catch {
        /* released as far as possible */
      }
    }
  };
  let remoteStart: Promise<RemoteSimulation> | null = null;
  try {
    const behaviorRows = (manifest as unknown as { behaviors?: ManifestBehaviorRow[] }).behaviors ?? [];
    const enginePins = (manifest as unknown as { enginePins?: { id: string; version: string; apiVersion: number }[] }).enginePins ?? [];
    const moduleIds = (manifest as unknown as { modules?: Array<{ id: string }> }).modules?.map((m) => m.id) ?? [];
    const startVariables = o.start?.variables;

    // The simulation runs in a worker unless the page (?threads=off), the project (sim_thread)
    // or the browser says otherwise; a test start may ask for a mode (the URL flag still wins).
    const threading = resolveThreadingMode({ url: pageSearch(), setting: settings.sim_thread, workerAvailable: browserWorkerAvailable(), ...(o.start?.threads !== undefined ? { start: o.start.threads } : {}) });
    let threadMode = threading.mode;
    let threadReason = threading.reason;
    const isolated = (globalThis as { crossOriginIsolated?: unknown }).crossOriginIsolated === true;
    if (threadMode === 'worker') {
      const worker = createBrowserSimWorker(o.workerUrl);
      if (worker === null) {
        threadMode = 'single';
        threadReason = 'the browser refused to start the worker: single thread';
      } else {
        // The worker composes the simulation while the page reads the assets (below).
        timings?.begin('worker');
        remoteStart = startRemoteSimulation({
          worker,
          init: {
            snapshot,
            settings,
            physics: physicsConfig,
            modules: moduleIds,
            behaviors: { rows: behaviorRows, enginePins, urls: Object.fromEntries(behaviorRows.map((r) => [r.path, o.scriptUrl(r.path)])) },
            shared: resolveTransport(globalThis as never) === 'shared',
            // Injected script variables (ctx.save from step 0) and the game mode the run starts in.
            ...(startVariables !== undefined ? { variables: startVariables } : {}),
            ...(o.start?.options?.mode !== undefined && modeRows !== undefined ? { startMode: o.start.options.mode } : {}),
            // The stored project settings document (the runtime starts with it).
            ...(snapshot.saveSchema !== undefined ? { projectSettings: readProjectSettings(snapshot.saveSchema, browserSaveStorage() ?? undefined, o.saveNamespace) } : {}),
          },
          input: { sample: (stepIndex) => browserInput.sample(stepIndex), reset: (reason) => browserInput.reset?.(reason) },
          ...(catalog !== null ? { loadScene: catalog.loadScene } : {}),
          driver: 'raf',
          // A slowed simulation for debugging and tests (?simDelayMs=).
          ...(simDelayFromUrl(pageSearch()) > 0 ? { workerDelayMs: simDelayFromUrl(pageSearch()) } : {}),
        });
        remoteStart.then(
          () => {
            timings?.end('worker');
            onProgress('behaviors', 0, 0);
          },
          () => timings?.end('worker', 'failed'),
        );
      }
    }

    // The start scenes' assets, read at most 8 at a time and re-hashed to their rows before the
    // game composes (the adapter never receives unverified bytes); the others when they are asked for.
    try {
      const startRows = startSceneAssets({
        assets: manifest.assets,
        entities: snapshot.scene.entities,
        ...(manifest.scenes !== undefined ? { startSceneIds: manifest.scenes.filter((r) => r.start).map((r) => r.sceneId) } : {}),
        ...(manifest.materials !== undefined ? { materials: manifest.materials } : {}),
        ...(manifest.materialFunctions !== undefined ? { materialFunctions: manifest.materialFunctions } : {}),
        ...(manifest.effects !== undefined ? { effects: manifest.effects } : {}),
        ...(environment !== undefined ? { environment } : {}),
        ...(manifest.lighting !== undefined ? { lighting: manifest.lighting } : {}),
      });
      timings?.begin('assets');
      // Held until the start scenes' models, textures and sounds took what they need (below).
      await assetReader.preload(startRows, (loaded, total) => onProgress('assets', loaded, total), START_HOLDER);
      timings?.end('assets', `${startRows.length} of ${manifest.assets.length}`);
      timings?.count('startAssetReads', startRows.length);
      timings?.count('startAssetBytes', startRows.reduce((n, r) => n + r.sourceByteLength, 0));
    } catch (e) {
      void remoteStart?.then((r) => r.dispose(), () => undefined);
      remoteStart = null;
      throw e instanceof AssetReadError ? new GamePageError('asset_source_invalid', 'assets', e.message) : e;
    }
    const models = buildModelsBlock(manifest, snapshot, assetReader, o.read, content);

    let remote: RemoteSimulation | null = null;
    if (remoteStart !== null) {
      try {
        remote = await remoteStart;
      } catch (e) {
        threadMode = 'single';
        threadReason = `the worker could not start (${e instanceof Error ? e.message : String(e)}): single thread`;
      }
    }
    console.info(threadingLogLine(threadMode, threadReason, remote?.transport ?? null, isolated));
    if (remote !== null) {
      const r = remote;
      // Until the host owns it (its runtime is the mirror, disposed with the host): released on failure.
      releases.push(() => void r.dispose());
    }

    // The physics port in single-thread mode (in worker mode the worker has its own).
    let physics: RapierPhysicsPort | PhysicsPort3D | undefined;
    if (remote === null && physicsConfig !== null) timings?.begin('physics');
    if (remote === null && physicsConfig !== null && 'dimension' in physicsConfig) {
      // The 3D backend (a separate script, loaded only for a 3D project).
      const backend = await loadPhysics3D(o.physics3dUrl);
      const init = await backend.createPhysicsPort3D(physicsConfig as never);
      if (!init.ok) throw new GamePageError('play_content_not_ready', 'manifest', `physics init failed: ${init.error.code}`);
      const p = init.port as PhysicsPort3D;
      physics = p;
      releases.push(() => p.dispose());
    } else if (remote === null && physicsConfig !== null) {
      const backend = await o.physics2d();
      const init = await backend.createPhysicsPort(physicsConfig as never);
      if (!init.ok) throw new GamePageError('play_content_not_ready', 'manifest', `physics init failed: ${init.error.code}`);
      const p = init.port as RapierPhysicsPort;
      physics = p;
      releases.push(() => p.dispose());
    }
    if (physics !== undefined) timings?.end('physics');

    // The input exercise's relay: frames replace the physical input step by step; its UI edges
    // and clicks are applied at the next host frames (the menu channel is read every frame).
    const relay = o.relay === true ? new RelayActionSource(browserInput) : null;
    const relayEdges: RelayUiEdgeName[] = [];
    const relayClicks: string[] = [];
    const hostRef: { current: GameHost | null } = { current: null };
    const accessRef: { current: SimAccess | null } = { current: null };
    const NO_EDGES = { up: false, down: false, left: false, right: false, submit: false, cancel: false, pause: false };
    const input: GameHostConfig['input'] =
      relay === null
        ? browserInput
        : {
            sample: (stepIndex: number) => relay.sample(stepIndex),
            sampleMenu: () => {
              for (const key of relayClicks.splice(0)) hostRef.current?.clickUi?.(key);
              // A frame of a paused game takes one step's place in a running exercise (its menu can be driven and resumed).
              if (accessRef.current?.inputTestActive === true && hostRef.current?.playState?.() === 'paused') accessRef.current.relayIdle();
              return browserInput.sampleMenu();
            },
            markConfirmConsumed: () => browserInput.markConfirmConsumed(),
            dispose: () => browserInput.dispose(),
            sampleUi: () => {
              const physical = browserInput.sampleUi();
              const edge = relayEdges.shift();
              return edge === undefined ? physical : { ...NO_EDGES, [edge]: true };
            },
            captureKey: (cb: (code: string | null) => void) => browserInput.captureKey(cb),
            capturePadButton: (cb: (button: number | null) => void) => browserInput.capturePadButton(cb),
            configure: (c: InputConfigLike) => {
              inputConfigNow = c;
              browserInput.configure(c);
            },
            setUiHitTest: (hit: ((x: number, y: number) => boolean) | null) => browserInput.setUiHitTest(hit),
            setActiveMaps: (maps: readonly string[] | null) => browserInput.setActiveMaps(maps),
            applyCursor: (mode: 'free' | 'locked') => browserInput.applyCursor(mode),
            cursorState: () => browserInput.cursorState(),
            captureInput: (c: Parameters<typeof browserInput.captureInput>[0], cb: Parameters<typeof browserInput.captureInput>[1]) => browserInput.captureInput(c, cb),
            activeDevice: () => browserInput.activeDevice(),
            activeDeviceInfo: () => browserInput.activeDeviceInfo(),
            setFrameInput: (f: Parameters<typeof browserInput.setFrameInput>[0]) => browserInput.setFrameInput(f),
          };
    // The project's sound voice count (absent: 8).
    // Each audio file is read by its load type when something needs it (see audio-loading.ts).
    const audioFiles = pageAudio({ catalog: content.catalog, bytes: (assetId, version) => assetReader.bytes(assetId, version), ...(o.assetUrl !== undefined ? { assetUrl: o.assetUrl } : {}) });
    const mediaElements = browserMediaElementFactory();
    const audio = createGameAudioOwner({
      contextFactory: browserContextFactory() ?? undefined,
      resources,
      source: (assetId) => audioFiles.source(assetId),
      ...(mediaElements !== null ? { createMediaElement: mediaElements } : {}),
      ...(settings.audio_voices !== undefined ? { maxVoices: settings.audio_voices } : {}),
      ...(o.onProblem !== undefined ? { onProblem: o.onProblem } : {}),
    });
    releases.push(() => void audio.dispose());
    const assetPathsById: Record<string, string> = {};
    for (const asset of manifest.assets) assetPathsById[asset.assetId] = asset.path;

    // The adapter instance the factory creates (host-called inside `mount()`).
    const adapterRef: { current: SceneAdapter | null } = { current: null };
    // The project's compiled behaviors; in worker mode the worker links them.
    if (remote === null && behaviorRows.length > 0) timings?.begin('behaviors');
    const behaviorModules = remote !== null ? [] : await linkBehaviorModules(behaviorRows, enginePins, (path) => import(/* @vite-ignore */ o.scriptUrl(path)));
    if (remote === null && behaviorRows.length > 0) timings?.end('behaviors');
    const loader = (): ReturnType<typeof createGltfLoaderPort> => createGltfLoaderPort({ decoderBase: o.decoderBase });
    const pageTextures = pageTextureLoader(assetReader, content.catalog, textureStreamer);
    const config: GameHostConfig = {
      snapshot,
      settings,
      behaviorModules,
      modules: moduleIds,
      moduleSpecs: o.moduleSpecs,
      ...(physics !== undefined ? { physics } : {}),
      ...(remote !== null ? { runtimeFactory: remote.runtimeFactory } : {}),
      adapter: (runtime) => {
        const a = createSceneAdapter(o.canvas, {
          runtime,
          snapshot,
          ...(o.meshWorkerUrl !== undefined ? { meshWorkerUrl: o.meshWorkerUrl } : {}),
          resources,
          // The page's ?renderer= flag, else the project's render_backend setting.
          renderer: { ...resolveRendererPreference({ url: pageSearch(), setting: settings.render_backend }), depthBuffer: depthBufferOf(settings), trackTimestamp: o.measureGpu === true || statsOverlayModeOf(settings) !== 'off' },
          // Repeated objects drawn instanced unless the page says ?batching=off (a diagnostic comparison).
          batching: batchingFromUrl(pageSearch()),
          // Static objects merged at load unless the page says ?merging=off (a diagnostic comparison).
          merging: mergingFromUrl(pageSearch()) ? 'load' : 'off',
          // The sun's static casters cached in their own shadow map unless the page says ?shadowcache=off (a diagnostic comparison).
          shadowCache: shadowCacheFromUrl(pageSearch()),
          // The first frame, slow frames and scene attaches for the start timings.
          ...(timings !== undefined ? { onFrameDrawn: (f: FrameDrawnInfo) => timings.frame(f) } : {}),
          // A model's extracted images draw from their texture assets, streamed like a material's.
          ...(models !== null ? { models: { ...models, loadTexture: pageTextures }, modelsLoader: loader() } : {}),
          ...materialsOptionOf(manifest, environment, catalog0 !== null ? { start: firstStart ?? null, look: (sceneId) => sceneLooks.get(sceneId) ?? null } : null, pageTextures, textureStreamer),
          textureStreamer,
          // The visual effects (textures and models from the verified bytes).
          ...(manifest.effects !== undefined && manifest.effects.length > 0
            ? {
                effects: effectsOptionFrom({
                  defs: manifest.effects,
                  wind: environment?.wind ?? null,
                  assets: manifest.assets,
                  bytes: (assetId: string, version: number) => assetReader.bytes(assetId, version).catch(() => undefined),
                  ...(JSON.stringify(manifest.effects).includes('"model"') ? { loader: loader() } : {}),
                }),
              }
            : {}),
        });
        adapterRef.current = a;
        return a;
      },
      input,
      audio,
      // A declared asset (a sound, a glyph, a UI image) through the checked reader; other paths as they are.
      readArtifact: (path) => assetReader.bytesAt(path) ?? o.read(path),
      ...(catalog !== null ? { loadScene: catalog.loadScene } : {}),
      ...(scenes !== null ? { scenes } : {}),
      container: o.container,
      buildId: manifest.buildId,
      resources,
      // Scripts' loads by id, address or label (`ctx.assets`).
      textureStreaming: () => ({ ...textureStreamer.observe(), embedded: resources.embeddedTextures(EMBEDDED_TEXTURES_LISTED) }),
      loadAssets: pageAssetLoader({ manifest, catalog: content.catalog, reader: assetReader, resources, adapter: () => adapterRef.current }),
      assetPaths: assetPathsById,
      ...(manifest.shell !== undefined ? { shell: manifest.shell } : {}),
      inputConfig: structuredClone(manifest.input ?? (physicsDimensionOf(settings) === 3 ? DEFAULT_INPUT_CONFIG_3D : DEFAULT_INPUT_CONFIG)) as unknown as NonNullable<GameHostConfig['inputConfig']>,
      setQuality: (level) => adapterRef.current?.setQuality?.(level),
      // The player's settings in this browser's localStorage, and project save slots in its IndexedDB.
      ...(browserSaveStorage() !== null ? { saveStorage: browserSaveStorage()!, saveNamespace: o.saveNamespace } : {}),
      // Without IndexedDB every save is refused as storage_unavailable (the game can say so) rather than kept for the page's life.
      projectSaveBackend: browserProjectSaveBackend() ?? unavailableProjectSaveBackend('this browser gives the page no IndexedDB'),
      ...(browserDeviceStorage() !== undefined ? { deviceStorage: browserDeviceStorage()! } : {}),
      assetKinds: Object.fromEntries(manifest.assets.map((r) => [r.assetId, r.kind])),
      // An asset the rows above do not name (a portrait, say): its catalog shard, read when it is asked for.
      lookupAsset: (assetId) => content.catalog.lookup(assetId).then((r) => (r === undefined ? undefined : { path: r.path, kind: r.kind })),
      // The audio files each scene and the project-wide blocks name, read ahead by their preload setting.
      sceneAudio: (sceneId) => audioFiles.sceneAudio(sceneId),
      projectAudio: () => audioFiles.projectAudio(),
      // How audio sources are heard (the audio_spatial setting; 3D: panned).
      audioSpatial: audioSpatialOf(settings),
      ...(o.debugConsole ? { debugConsole: true, focusGame: () => o.canvas.focus() } : {}),
      ...(o.onProblem !== undefined ? { onProblem: o.onProblem } : {}),
      ...(startVariables !== undefined ? { variables: startVariables } : {}),
      ...(o.start?.options !== undefined ? { start: o.start.options } : {}),
      // The project UI documents and themes (the host draws them).
      ...(uiDocs !== undefined && uiDocs.length > 0 ? { ui: { documents: uiDocs, ...(manifest.uiThemes !== undefined ? { themes: manifest.uiThemes } : {}) } } : {}),
    };
    const host = createGameHost(config);
    // The first key or click in the game unlocks sound (music and cues).
    const unlockOnce = (): void => {
      void audio.unlock().catch(() => undefined);
    };
    globalThis.addEventListener?.('pointerdown', unlockOnce, { once: true });
    globalThis.addEventListener?.('keydown', unlockOnce, { once: true });
    releases.push(() => {
      globalThis.removeEventListener?.('pointerdown', unlockOnce);
      globalThis.removeEventListener?.('keydown', unlockOnce);
    });
    releases.push(() => host.dispose());
    timings?.begin('mount');
    const mount = host.mount();
    timings?.end('mount');
    onProgress('runtime', 0, 0);
    if (!mount.ok) throw new GamePageError('play_content_not_ready', 'manifest', `host mount failed: ${JSON.stringify(mount.error)}`);
    // A scene is prepared (assets read, models parsed, textures decoded) before the simulation gets it.
    scenes?.setPrepare(
      pageScenePreparation({
        adapter: () => adapterRef.current,
        reader: assetReader,
        catalog: content.catalog,
        resources,
        sources: {
          assets: manifest.assets,
          ...(manifest.materials !== undefined ? { materials: manifest.materials } : {}),
          ...(manifest.materialFunctions !== undefined ? { materialFunctions: manifest.materialFunctions } : {}),
          ...(manifest.effects !== undefined ? { effects: manifest.effects } : {}),
          ...(manifest.lighting !== undefined ? { lighting: manifest.lighting } : {}),
        },
      }),
    );
    // A project save slot's picture (a data URL) for the page — a game's load screen, tests.
    (globalThis as { __thirdlightSaveThumbnail?: (slot: number) => Promise<string | null> }).__thirdlightSaveThumbnail = (slot: number) => host.projectSaves?.thumbnail(slot) ?? Promise.resolve(null);

    // The models settle.
    const adapterNow = adapterRef.current as SceneAdapter | null;
    if (models !== null && adapterNow !== null && o.waitForModels === true) {
      timings?.begin('models');
      // Every model prepared is progress (a project with many large models keeps its start alive).
      let prepared = -1;
      const watch = setInterval(() => {
        const m = adapterNow.diagnostics();
        const c = m.ok ? m.diagnostics.models : undefined;
        if (c === undefined) return;
        const done = c.assets - c.pending;
        if (done !== prepared) {
          prepared = done;
          onProgress('runtime', 0, 0);
        }
      }, 250);
      const settle = await adapterNow.modelsSettled?.().finally(() => clearInterval(watch));
      timings?.end('models');
      if (settle === undefined || settle.ok === false) {
        const code = settle?.code ?? 'models_config_invalid';
        throw new GamePageError(code, 'assets', `the model prepare hard-failed (${code}): ${settle?.message ?? 'no settle result'}`);
      }
    } else if (models !== null && adapterNow !== null) {
      // The prepares run while the game plays and never block it.
      void adapterNow
        .modelsSettled?.()
        .then((settle) => {
          if (settle !== undefined && !settle.ok) o.onModelsFailed?.(settle.code ?? 'models_config_invalid');
        })
        .catch(() => undefined);
    }

    // The start's bytes are let go once the renderer draws and the models settled: what the
    // start scenes use has taken its own holds by then (a decoder that did not is read again).
    releaseStartWhenDrawn(adapterNow, models !== null, assetReader);
    const obs = host.observe();
    const identity = {
      snapshotId: String((snapshot as unknown as { snapshotId?: string }).snapshotId ?? ''),
      revision: Number((snapshot as unknown as { revision?: number }).revision ?? 0),
      buildId: manifest.buildId,
      contentDigest: manifest.contentDigest,
      stepIndex: obs.ok ? obs.observation.stepIndex : 0,
    };
    const stepHz = settings.fixed_step_hz ?? 120;
    let access: SimAccess | null = null;
    if (relay !== null) {
      access = remote !== null ? remote.access : createLocalSimAccess({ runtime: host.runtime, relay, ...(physics !== undefined ? { physics: physics as never } : {}), stepHz });
      hostRef.current = host;
      accessRef.current = access;
      // The input exercise's page side: the UI hit targets and where its UI edges and clicks go.
      access.setRelayPage({
        targets: () => host.uiHitTargets?.() ?? [],
        effect: (e) => {
          if (e.kind === 'click') relayClicks.push(e.key);
          else for (const edge of e.edges) if (relayEdges.length < 64) relayEdges.push(edge);
        },
      });
    }
    return {
      host,
      access,
      inputConfig: () => inputConfigNow,
      threading: {
        mode: threadMode,
        reason: threadReason,
        transport: remote?.transport ?? null,
        isolated,
        get pipeline() {
          return remote?.pipeline() ?? null;
        },
      },
      adapter: adapterRef.current,
      identity,
      stepHz,
      assetReads: () => assetReader.stats(),
      catalogReads: () => content.catalog.stats(),
      resources: () => {
        // The host's view adds the scripts' handles (open, and those a run ended without releasing).
        const o = host.observe();
        return o.ok && o.observation.resources !== undefined ? o.observation.resources : resources.observe();
      },
      audio: () => audio.report?.() ?? null,
      withOverlay: (frame) => composeOverlay({ container: o.container as unknown as HTMLElement, canvas: o.canvas, frame, fontCss: () => host.uiFontRules?.() ?? Promise.resolve('') }),
      // The host disposes its runtime (in worker mode the mirror, which ends the worker);
      // then the physics port, the audio owner, the input and the page listeners; the resources last.
      dispose: () => releaseAll(),
    };
  } catch (e) {
    releaseAll();
    void remoteStart?.then((r) => r.dispose(), () => undefined);
    throw e;
  }
}
