/**
 * The export bundle bootstrap.
 *
 * Runs in the exported static page (`<script type="module">`, IIFE bundle — no
 * top-level `await`). It is the SAME single production composition as
 * preview/play (delivery.md: `game-host` owns the registry /
 * `instantiateRuntime` / frame wiring) and links the same pinned outputs.
 * There is no backend, no bridge, no token and no credential in the page.
 *
 * Load order (all relative, all declared; the delivery.md export steps):
 *   1. `fetch("./manifest.json")` — the single manifest read; the manifest's
 *      own v2 `buildId` is re-derived and verified (WebCrypto) before anything
 *      else loads.
 *   2. `fetch("./scene.json")` — the captured v3 scene document,
 *      digest-verified against `manifest.sceneDigest`.
 *   3. one `fetch("./<declared asset path>")` per manifest asset, EXACTLY ONCE
 *      each — re-hashed to the manifest `sourceDigest` (L2; the host itself
 *      never fetches). The model-kind bytes feed the `models` block's
 *      `resolveBytes` (the wrapper-verified map — the adapter never re-hashes).
 *   4. `createGameHost` — the single shared production module composition
 *      (runtime + input + the manifest's module specs + physics-rapier +
 *      three-adapter scene adapter + the audio owner). The adapter
 *      receives the `models` block (`assets` = the referenced model rows,
 *      `animation` from `manifest.media.animation`) + `modelsLoader` =
 *      `createGltfLoaderPort()` imported from the
 *      `@thirdlight/three-adapter/gltf-loader` subpath (the root stays
 *      loader-free).
 *   5. the model prepares run while the game plays and NEVER block it; a hard
 *      prepare failure is a structured on-page error and the game continues
 *      without the failed model's visuals.
 *   6. the three.js/WebGL renderer (the scene adapter); the overlays (project
 *      UI, the game shell) are the host-owned DOM.
 *
 * The resolved `settings` come from the manifest (delivery.md:
 * hash-bound through the manifest's self-identity).
 *
 * Browser-only: DOM + WebGL.
 */
import { audioSpatialOf, depthBufferOf, instanceChunkSizeOf, MANIFEST_KEYS_V2, physicsDimensionOf, RUNTIME_CONTENT_MANIFEST_VERSION_4, sha256HexAsync, type SaveSchema } from '@thirdlight/project-model';
import { attachBrowserInput, DEFAULT_INPUT_CONFIG, DEFAULT_INPUT_CONFIG_3D, focusGameSurface, type InputConfigLike } from '@thirdlight/input';
import { createPhysicsPort, type RapierPhysicsInitConfig, type RapierStaticColliderSpec } from '@thirdlight/physics-rapier';
import {
  browserContextFactory,
  bufferResolver,
  expandManifestContentFiles,
  type ManifestContentFileRowLike,
  createGameAudioOwner,
  createGameHost,
  linkBehaviorModules,
  prepareSceneCatalog,
  type GameHostConfig,
  type HostDomNode,
  type ManifestBehaviorRow,
  type ManifestBufferRow,
  type ManifestSceneRow,
  browserSaveStorage,
  browserProjectSaveBackend,
  readProjectSettings,
  browserWorkerAvailable,
  createBrowserSimWorker,
  loadPhysics3D,
  resolveThreadingMode,
  resolveTransport,
  startRemoteSimulation,
  threadingLogLine,
  createVerifiedAssetReader,
  startSceneAssets,
  createScenePreloader,
  pageScenePreparation,
  type RemoteSimulation,
} from '@thirdlight/game-host';
import { batchingFromUrl, createSceneAdapter, decodeTexture, effectsOptionFrom, environmentHasLook, pageSearch, resolveRendererPreference, setKtx2DecoderBase } from '@thirdlight/three-adapter';
import { createGltfLoaderPort } from '@thirdlight/three-adapter/gltf-loader';
import type { EffectDefLike, EnvironmentLike, LightingBakeLike, MaterialDefLike, MaterialFunctionLike, SceneAdapter, SceneAdapterModels, WindLike } from '@thirdlight/three-adapter';
import { modesForRuntime, audioDurationsFromAssetRows, uiDocumentsForRuntime, withDialogueUiDocument, materialCatalogOf, modelBoundsFromAssetRows, physics3DConfigOf, playerCapsuleOf, playerPhysicsOf, resolveSnapshotHierarchy, staticColliderOf, type GameplaySettings, type PhysicsInitConfig3D, type PhysicsPort3D, type RuntimeSnapshot, type SimulationModuleSpec } from '@thirdlight/runtime';
import { assetPaths, readAsset } from 'thirdlight:export-artifacts';
// The simulation module specs this manifest names (generated per export; nothing else is linked).
import { moduleSpecs } from 'thirdlight:export-modules';

// KTX2 texture assets (and GLBs with KHR_texture_basisu) transcode with three's Basis files served at ./decoders/basis/.
setKtx2DecoderBase('./decoders/');

/** The simulation worker's bundle, next to this one (relative to the page). */
const EXPORT_SIM_WORKER_PATH = './js/sim-worker.js';
/** The 3D physics backend (`js/physics-3d.js`, only in a 3D project's export). */
const EXPORT_PHYSICS_3D_PATH = './js/physics-3d.js';

interface ExportManifestV2 {
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
  uiDocuments?: import('@thirdlight/runtime').UiDocument[];
  /** The timelines. */
  timelines?: import('@thirdlight/runtime').TimelineAsset[];
  /** The event → cue table. */
  eventCues?: import('@thirdlight/runtime').RuntimeEventCue[];
  /** The game shell (menus and HUD documents, the scene list). */
  shell?: import('@thirdlight/game-host').ShellConfigLike;
  uiThemes?: import('@thirdlight/runtime').UiTheme[];
  /** The dialogue runner's data (conversations, speakers, settings). */
  dialogue?: import('@thirdlight/runtime').RuntimeDialogueData;
  /** The game modes (the runtime switches them; the first is the start mode). */
  modes?: import('@thirdlight/runtime').GameMode[];
  environment?: EnvironmentLike & { wind?: WindLike };
  /** The scenes' bakes. */
  lighting?: Record<string, LightingBakeLike>;
  /** The animator controllers. */
  animators?: unknown[];
  /** Model rigs (sockets are resolved on them). */
  rigs?: Record<string, unknown>;
  /** The prefab definitions scripts spawn. */
  prefabs?: unknown[];
  /** The block types and cell fields block layers use. */
  blockTypes?: unknown[];
  cellFields?: unknown[];
  /** The input actions. */
  input?: InputConfigLike;
  /** The named collision layers. */
  collisionLayers?: readonly string[];
  /** The project save schema. */
  saveSchema?: SaveSchema;
  /** Every scene of a v4 project and the instance-set buffers. */
  scenes?: ManifestSceneRow[];
  buffers?: ManifestBufferRow[];
  /** The content files; materials, materialFunctions, uiDocuments, dialogue and buffers come from them. */
  contentFiles?: ManifestContentFileRowLike[];
  assets: ReadonlyArray<{ assetId: string; version: number; sourceDigest: string; sourceByteLength: number; kind: string; path: string }>;
  /** The resolved media identity: cue slots + one
   * `modelAnimation` row per entity (entityId/assetId/version/profileDigest/
   * roles). */
  media: { cues: Record<string, unknown>; animation: ReadonlyArray<{ entityId: string; assetId: string; version: number; profileDigest: string; roles: Record<string, unknown> }> };
  behaviors: ReadonlyArray<Record<string, unknown>>;
  modules: ReadonlyArray<Record<string, unknown>>;
  enginePins: ReadonlyArray<Record<string, unknown>>;
  recipes: Record<string, number>;
  toolchain: Record<string, unknown>;
  buildOptionsDigest: string;
  buildId: string;
}

function hud(text: string, isError: boolean): void {
  const el = document.getElementById('hud');
  if (el !== null) {
    el.textContent = text;
    el.className = isError ? 'error' : '';
  }
}

/** Lowercase hex SHA-256 (Web Crypto when the page has it, pure JS otherwise). */
const sha256Hex = sha256HexAsync;

/** The canonical v2 `buildId` preimage object (every key but `buildId`, in the
 * manifest key order — the page re-derives it to verify the single manifest
 * read before anything else loads). */
function buildIdInput(manifest: Record<string, unknown>): Record<string, unknown> {
  // The model's key order (one list; every key but buildId).
  const keys = MANIFEST_KEYS_V2.filter((k) => k !== 'buildId');
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = manifest[k];
  return out;
}

/** The scene-derived Rapier init config (statics + the player controller),
 * with the manifest's resolved `gravity_y` as the solver gravity. */
function physicsConfigFromSnapshot(snapshot: RuntimeSnapshot, settings: GameplaySettings): RapierPhysicsInitConfig | null {
  const statics: RapierStaticColliderSpec[] = [];
  let character: RapierPhysicsInitConfig['character'] | null = null;
  let tuning = playerPhysicsOf(undefined);
  for (const entity of snapshot.scene.entities) {
    const components = (entity.components ?? {}) as unknown as Record<string, unknown>;
    const transform = components['transform'] as { position?: number[]; rotation?: number[]; scale?: number[] } | undefined;
    const position = transform?.position ?? [0, 0, 0];
    // The shared rule (world XY, the entity's rotation about Z; movers kinematic; one-way platforms).
    const collider = staticColliderOf(entity.id, components);
    if (collider !== null) statics.push(collider as RapierStaticColliderSpec);
    if (components['controller'] !== undefined) {
      // The player's own capsule (its controller's, else the default).
      const capsule = playerCapsuleOf(components['controller']);
      // Its skin, ground snap and autostep (else the defaults).
      tuning = playerPhysicsOf(components['controller']);
      character = {
        x: position[0] ?? 0,
        y: position[1] ?? 0,
        radius: capsule.radius,
        halfHeight: capsule.halfHeight,
        offset: { x: capsule.offset.x, y: capsule.offset.y },
        parentId: (entity as { parentId?: string | null }).parentId ?? null,
        rotation: (transform?.rotation ?? [0, 0, 0, 1]) as [number, number, number, number],
        scale: (transform?.scale ?? [1, 1, 1]) as [number, number, number],
      };
    }
  }
  if (character === null) return null;
  return {
    character,
    statics,
    // The project's step rate and the player's controller tuning.
    solver: { hz: settings.fixed_step_hz ?? 120, gravityY: settings.gravity_y },
    controller: {
      offsetSkin: tuning.offsetSkin,
      groundSnap: tuning.groundSnap,
      maxSlopeClimbRad: (settings.max_slope_climb_deg * Math.PI) / 180,
      minSlopeSlideRad: (settings.min_slope_slide_deg * Math.PI) / 180,
      autostep: tuning.autostep,
      ...(tuning.autostep ? { autostepHeight: tuning.autostepHeight } : {}),
    },
  };
}

/** The exported page's artifact reader (manifest-declared relative paths only;
 * the host itself never fetches — the audio owner resolves cues through this). */
function readArtifactBytes(path: string): Promise<ArrayBuffer> {
  const read = readAsset(path, undefined);
  if (read === null) {
    return Promise.reject(new Error(`no relative reader for the declared asset path: ${path}`));
  }
  return read.then((res) => {
    if (!res.ok) return Promise.reject(new Error(`artifact read failed for ${path} (HTTP ${String(res.status)})`));
    return res.arrayBuffer();
  });
}

/** Start the exported game for one verified manifest. */
async function start(canvas: HTMLCanvasElement, manifest: ExportManifestV2): Promise<void> {
  // The captured v3 scene (digest-verified against manifest.sceneDigest).
  const sceneRes = await fetch('./scene.json', { credentials: 'omit' });
  if (!sceneRes.ok) throw new Error(`scene read failed (HTTP ${String(sceneRes.status)})`);
  const sceneBytes = new Uint8Array(await sceneRes.arrayBuffer());
  if ((await sha256Hex(sceneBytes)) !== manifest.sceneDigest) throw new Error('the scene document digest does not match manifest.sceneDigest');
  const scene = JSON.parse(new TextDecoder().decode(sceneBytes));

  // The wrapper's read phase (L2): every declared asset is read
  // at most once through this reader and re-hashed to the manifest `sourceDigest` before anyone gets its
  // bytes; the start scenes' assets are read BEFORE the runtime composes (L2 = hard failure, no runtime),
  // at most 8 at a time, the others when they are asked for (a scene loaded later, a texture, a sound).
  // (the start reads run below, while the simulation worker starts.)
  const assetReader = createVerifiedAssetReader(manifest.assets ?? [], { read: readArtifactBytes, sha256Hex });
  const textureLoader = (assetId: string): Promise<Awaited<ReturnType<typeof decodeTexture>> | null> => {
    const row = (manifest.assets ?? []).find((r) => r.kind === 'texture' && r.assetId === assetId);
    return row !== undefined ? assetReader.bytes(row.assetId, row.version).then((buf) => decodeTexture(buf), () => null) : Promise.resolve(null);
  };

  const settings = manifest.settings;
  // The scene catalog (start scenes read once for their
  // members; the others load on demand through the host).
  const io = { read: readArtifactBytes, sha256Hex };
  const catalog0 = manifest.scenes !== undefined ? await prepareSceneCatalog(manifest.scenes, io) : null;
  // Scene loads are prepared (assets read, models parsed) before the simulation gets them; likely next scenes are read ahead.
  const scenes = catalog0 === null ? null : createScenePreloader({ read: catalog0.loadScene });
  const catalog = catalog0 === null || scenes === null ? null : { rows: catalog0.rows, loadScene: scenes.load };
  // The scene as the game loads it (folders and inactive entities
  // resolved away) — physics, the renderer and the runtime all use this one.
  const modelBounds = modelBoundsFromAssetRows((manifest.assets ?? []) as readonly { assetId: string; kind?: string; bounds?: unknown }[]);
  const audioDurations = audioDurationsFromAssetRows((manifest.assets ?? []) as readonly { assetId: string; kind?: string; durationMs?: unknown }[]);
  const materialCatalog = materialCatalogOf(manifest.materials as Parameters<typeof materialCatalogOf>[0], manifest.assets as Parameters<typeof materialCatalogOf>[1]);
  const uiDocs = withDialogueUiDocument(manifest.uiDocuments, manifest.dialogue ?? null);
  const snapshot = resolveSnapshotHierarchy({
    snapshotId: manifest.snapshotId,
    projectId: manifest.projectId,
    revision: manifest.revision,
    scene,
    ...(manifest.tags !== undefined ? { tags: manifest.tags } : {}),
    ...(catalog !== null ? { scenes: catalog.rows } : {}),
    // The animator controllers (bound by the buildId).
    ...(manifest.animators !== undefined ? { animators: manifest.animators } : {}),
    // The prefabs scripts spawn (bound by the buildId).
    ...(manifest.prefabs !== undefined ? { prefabs: manifest.prefabs } : {}),
    // The model assets' recorded bounds (a pickup without a size collects over its model's).
    ...(modelBounds !== undefined ? { modelBounds } : {}),
    // The audio assets' recorded durations (script sounds' finished events).
    ...(audioDurations !== undefined ? { audioDurations } : {}),
    // The model rigs sockets are resolved on (bound by the buildId).
    ...(manifest.rigs !== undefined ? { rigs: manifest.rigs } : {}),
    // The block types and cell fields of the block layers (bound by the buildId).
    ...(manifest.blockTypes !== undefined ? { blockTypes: manifest.blockTypes } : {}),
    ...(manifest.cellFields !== undefined ? { cellFields: manifest.cellFields } : {}),
    // The graph materials' parameters scripts set per object (ctx.materials).
    ...(materialCatalog !== undefined ? { materialCatalog } : {}),
    // The project save schema (ctx.saves).
    ...(manifest.saveSchema !== undefined ? { saveSchema: manifest.saveSchema } : {}),
    // The environment preset ids scripts switch and blend to (ctx.environment).
    ...((manifest.environment?.presets?.length ?? 0) > 0 ? { environmentPresets: manifest.environment!.presets!.map((p) => p.presetId) } : {}),
    // The UI documents scripts show and hide (the host draws them from the manifest).
    // Plus the engine's dialogue document when the game has conversations.
    ...(uiDocumentsForRuntime(uiDocs) !== undefined ? { uiDocuments: uiDocumentsForRuntime(uiDocs) } : {}),
    // The dialogue runner's data (conversations, speakers, settings; bound by the buildId).
    ...(manifest.dialogue !== undefined ? { dialogue: manifest.dialogue } : {}),
    // The game modes and each action's input map (bound by the buildId).
    ...(manifest.modes !== undefined && manifest.modes.length > 0 ? { modes: modesForRuntime(manifest.modes, manifest.input ?? (physicsDimensionOf(settings) === 3 ? DEFAULT_INPUT_CONFIG_3D : DEFAULT_INPUT_CONFIG)) } : {}),
    // The timelines (ctx.timeline, play-on-start / play-on-signal).
    ...(manifest.timelines !== undefined && manifest.timelines.length > 0 ? { timelines: manifest.timelines } : {}),
    // The event → cue table.
    ...(manifest.eventCues !== undefined && manifest.eventCues.length > 0 ? { eventCues: manifest.eventCues } : {}),
    // The game shell's scene list.
    ...(manifest.shell?.scenes !== undefined ? { sceneList: manifest.shell.scenes } : {}),
  } as unknown as RuntimeSnapshot);
  // This game's saves in the player's browser (Play uses its own namespace).
  const saveNamespace = `thirdlight:${String((snapshot as unknown as { projectId?: string }).projectId ?? 'game')}`;

  // The `models` block (or none — the loader-free surface when the scene
  // references no model asset): `assets` = the manifest's
  // model-kind rows for the REFERENCED assetIds only; `animation` from
  // `manifest.media.animation`; `resolveBytes` = the wrapper-verified map.
  const referenced = new Set<string>();
  // Scenes loaded later may use any model of the build.
  if (manifest.scenes !== undefined) for (const a of manifest.assets ?? []) if (a.kind === 'model') referenced.add(a.assetId);
  for (const entity of (scene as { entities?: ReadonlyArray<{ components?: Record<string, unknown> }> }).entities ?? []) {
    // The v3 `model` component shape:
    // `components.model.asset.assetId`.
    const model = (entity.components ?? {})['model'] as { asset?: { assetId?: string } } | undefined;
    if (model !== undefined && typeof model.asset?.assetId === 'string') referenced.add(model.asset.assetId);
  }
  let models: SceneAdapterModels | null = null;
  if (referenced.size > 0) {
    const modelRows = (manifest.assets ?? []).filter((a) => a.kind === 'model' && referenced.has(a.assetId));
    if (modelRows.length !== referenced.size) {
      const missing = [...referenced].filter((id) => !modelRows.some((r) => r.assetId === id));
      throw new Error(`the scene references model asset(s) absent from the manifest: ${missing.join(', ')}`);
    }
    models = {
      assets: modelRows.map((r) => ({ assetId: r.assetId, version: r.version, sourceDigest: r.sourceDigest, ...((r as { vertexColors?: unknown }).vertexColors === 'tint' ? { vertexColors: 'tint' as const } : {}), ...((r as { materials?: Record<string, string> }).materials !== undefined ? { materials: (r as unknown as { materials: Record<string, string> }).materials } : {}), ...(typeof (r as { clipsFor?: unknown }).clipsFor === 'string' ? { clipsFor: (r as unknown as { clipsFor: string }).clipsFor } : {}) })),
      animation: (manifest.media?.animation ?? []).map((r) => ({ entityId: r.entityId, roles: r.roles as never, version: r.version })),
      // The project's idle/run/airborne blend time.
      ...(settings.animation_crossfade_s !== undefined ? { crossfadeSeconds: settings.animation_crossfade_s } : {}),
      // The project's instance-set chunk size.
      ...(instanceChunkSizeOf(settings) !== undefined ? { instanceChunkSize: instanceChunkSizeOf(settings) } : {}),
      resolveBytes: (assetId: string, version: number): Promise<ArrayBuffer> => assetReader.bytes(assetId, version),
      ...(manifest.buffers !== undefined ? { resolveBuffer: bufferResolver(manifest.buffers, io) } : {}),
    };
  }

  // The physics config (physics-rapier; the manifest's resolved gravity_y drives the solver).
  // A 3D project's physics is the 3D backend (its own config; the 2D one otherwise, unchanged).
  const physicsConfig: RapierPhysicsInitConfig | PhysicsInitConfig3D | null = physicsDimensionOf(settings) === 3 ? physics3DConfigOf(snapshot.scene.entities as never, settings, { layers: manifest.collisionLayers ?? [] }) : physicsConfigFromSnapshot(snapshot, settings);
  // (no controller: no physics world; a module that needs one says so when the host composes)

  // The project's input actions (bound by the buildId), else the defaults.
  const input = attachBrowserInput(canvas, { inputConfig: manifest.input ?? (physicsDimensionOf(settings) === 3 ? DEFAULT_INPUT_CONFIG_3D : DEFAULT_INPUT_CONFIG) });
  focusGameSurface(canvas);
  const behaviorRows = (manifest as unknown as { behaviors?: ManifestBehaviorRow[] }).behaviors ?? [];
  const enginePins = (manifest as unknown as { enginePins?: { id: string; version: string; apiVersion: number }[] }).enginePins ?? [];
  const moduleIds = (manifest as unknown as { modules?: Array<{ id: string }> }).modules?.map((m) => m.id) ?? [];

  // The simulation runs in a worker (js/sim-worker.js next to this
  // bundle) unless the page (?threads=off), the project (sim_thread) or the
  // browser says otherwise; its transforms use shared memory only when the
  // host serves the page cross-origin isolated (COOP + COEP), else messages.
  const threading = resolveThreadingMode({ url: pageSearch(), setting: settings.sim_thread, workerAvailable: browserWorkerAvailable() });
  let threadMode = threading.mode;
  let threadReason = threading.reason;
  const isolated = (globalThis as { crossOriginIsolated?: unknown }).crossOriginIsolated === true;
  let remoteStart: Promise<RemoteSimulation> | null = null;
  if (threadMode === 'worker') {
    const worker = createBrowserSimWorker(new URL(EXPORT_SIM_WORKER_PATH, document.baseURI).href);
    if (worker === null) {
      threadMode = 'single';
      threadReason = 'the browser refused to start the worker: single thread';
    } else {
      // The worker composes the simulation while the page reads the assets (below).
      remoteStart = startRemoteSimulation({
          worker,
          init: {
            snapshot,
            settings,
            physics: physicsConfig,
            modules: moduleIds,
            behaviors: { rows: behaviorRows, enginePins, urls: Object.fromEntries(behaviorRows.map((r) => [r.path, new URL(r.path, document.baseURI).href])) },
            shared: resolveTransport(globalThis as never) === 'shared',
            // The stored project settings document (the runtime starts with it).
            ...(snapshot.saveSchema !== undefined ? { projectSettings: readProjectSettings(snapshot.saveSchema, browserSaveStorage() ?? undefined, saveNamespace) } : {}),
          },
          input: { sample: (stepIndex) => input.sample(stepIndex), reset: (reason) => input.reset?.(reason) },
          ...(catalog !== null ? { loadScene: catalog.loadScene } : {}),
          driver: 'raf',
        });
      remoteStart.catch(() => undefined); // awaited below
    }
  }
  // The wrapper's read phase (L2): every declared
  // asset path is read EXACTLY ONCE (relative) and re-hashed to the manifest
  // `sourceDigest` BEFORE the runtime composes (L2 = hard failure, no
  // runtime). The model-kind bytes feed the `models` block `resolveBytes`.
  try {
    await assetReader.preload(
      startSceneAssets({
        assets: manifest.assets ?? [],
        entities: snapshot.scene.entities,
        ...(manifest.scenes !== undefined ? { startSceneIds: manifest.scenes.filter((r) => r.start).map((r) => r.sceneId) } : {}),
        ...(manifest.materials !== undefined ? { materials: manifest.materials } : {}),
        ...(manifest.materialFunctions !== undefined ? { materialFunctions: manifest.materialFunctions } : {}),
        ...(manifest.effects !== undefined ? { effects: manifest.effects } : {}),
        ...(manifest.environment !== undefined ? { environment: manifest.environment } : {}),
        ...(manifest.lighting !== undefined ? { lighting: manifest.lighting } : {}),
      }),
    );
  } catch (e) {
    void remoteStart?.then((r) => r.dispose(), () => undefined);
    throw e;
  }
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
  (window as unknown as { __thirdlightThreading?: unknown }).__thirdlightThreading = { mode: threadMode, reason: threadReason, transport: remote?.transport ?? null, isolated };

  // The injected physics port in single-thread mode (in worker mode the worker has its own).
  let physics;
  if (remote === null && physicsConfig !== null && 'dimension' in physicsConfig) {
    // The 3D backend (js/physics-3d.js, shipped only in a 3D project's export).
    const backend = await loadPhysics3D(new URL(EXPORT_PHYSICS_3D_PATH, location.href).href);
    const init = await backend.createPhysicsPort3D(physicsConfig as never);
    if (!init.ok) throw new Error(`physics init failed: ${init.error.code}`);
    physics = init.port as PhysicsPort3D;
  } else if (remote === null && physicsConfig !== null) {
    const init = await createPhysicsPort(physicsConfig as RapierPhysicsInitConfig);
    if (!init.ok) throw new Error(`physics init failed: ${init.error.code}`);
    physics = init.port;
  }
  // The project's sound voice count (absent: 8).
  const audio = createGameAudioOwner({ contextFactory: browserContextFactory() ?? undefined, ...(settings.audio_voices !== undefined ? { maxVoices: settings.audio_voices } : {}) });
  const assetPathsById: Record<string, string> = {};
  for (const asset of manifest.assets ?? []) assetPathsById[asset.assetId] = asset.path;

  const container = (document.getElementById('hud-root') ?? document.body) as unknown as HostDomNode;

  // The adapter instance the factory creates (the settle surface). The
  // `models` block + the loader port (the subpath import — the graph row) are
  // passed only when the scene references a model asset. A holder object: the
  // factory (host-called inside `mount()`) assigns `current`, which the
  // settle watch below reads after the mount.
  const adapterRef: { current: SceneAdapter | null } = { current: null };
  // The project's compiled behaviors ship as behaviors/<digest>.js next to index.html.
  // In worker mode the worker links them.
  const behaviorModules = remote !== null ? [] : await linkBehaviorModules(behaviorRows, enginePins, (path) => import(/* @vite-ignore */ new URL(path, document.baseURI).href));
  const config: GameHostConfig = {
    snapshot,
    settings,
    behaviorModules,
    modules: moduleIds,
    moduleSpecs: moduleSpecs as readonly SimulationModuleSpec[],
    ...(physics !== undefined ? { physics } : {}),
    ...(remote !== null ? { runtimeFactory: remote.runtimeFactory } : {}),
    adapter: (runtime) => {
      const a = createSceneAdapter(canvas, {
        runtime,
        snapshot,
        // The page's ?renderer= flag, else the project's render_backend setting.
        renderer: { ...resolveRendererPreference({ url: pageSearch(), setting: settings.render_backend }), depthBuffer: depthBufferOf(settings) },
        // Repeated objects drawn instanced unless the page says ?batching=off (a diagnostic comparison).
        batching: batchingFromUrl(pageSearch()),
        ...(models !== null
          ? { models, modelsLoader: createGltfLoaderPort({ decoderBase: './decoders/' }) }
          : {}),
        // Sky, fog, fog volumes, post-processing.
        // Environment presets need the environment renderer too (scripts blend the look).
        ...(environmentHasLook(manifest.environment) || (manifest.environment?.presets?.length ?? 0) > 0
          ? {
              environment: {
                value: manifest.environment ?? {},
                loadTexture: textureLoader,
              },
            }
          : {}),
        // Spot light cookies (textures from the verified bytes).
        lights: { loadTexture: textureLoader },
        // Lightmaps (atlases from the verified bytes).
        ...(manifest.lighting !== undefined
          ? {
              lighting: {
                bakes: manifest.lighting,
                loadTexture: textureLoader,
              },
            }
          : {}),
        // The visual effects (textures and models from the verified bytes).
        ...(manifest.effects !== undefined && manifest.effects.length > 0
          ? {
              effects: effectsOptionFrom({
                defs: manifest.effects,
                wind: manifest.environment?.wind ?? null,
                assets: (manifest.assets ?? []) as never,
                bytes: (assetId: string, version: number) => assetReader.bytes(assetId, version).catch(() => undefined),
                ...(JSON.stringify(manifest.effects).includes('"model"') ? { loader: createGltfLoaderPort({ decoderBase: './decoders/' }) } : {}),
              }),
            }
          : {}),
        // Project materials and wind (textures from the verified bytes).
        ...(manifest.materials !== undefined || manifest.environment !== undefined
          ? {
              materials: {
                defs: manifest.materials ?? [],
                functions: manifest.materialFunctions ?? [],
                wind: manifest.environment?.wind ?? null,
                loadTexture: textureLoader,
              },
            }
          : {}),
      });
      adapterRef.current = a;
      return a;
    },
    input,
    audio,
    // A declared asset (a sound, a glyph, a UI image) through the checked reader.
    readArtifact: (path: string) => assetReader.bytesAt(path) ?? readArtifactBytes(path),
    ...(catalog !== null ? { loadScene: catalog.loadScene } : {}),
    ...(scenes !== null ? { scenes } : {}),
    container,
    buildId: manifest.buildId,
    assetPaths: assetPathsById,
    // The game shell (menus and HUD as UI documents, the scene list).
    ...(manifest.shell !== undefined ? { shell: manifest.shell } : {}),
    inputConfig: structuredClone(manifest.input ?? (physicsDimensionOf(settings) === 3 ? DEFAULT_INPUT_CONFIG_3D : DEFAULT_INPUT_CONFIG)) as unknown as NonNullable<GameHostConfig['inputConfig']>,
    setQuality: (level) => adapterRef.current?.setQuality?.(level),
    // The player's settings in this browser's localStorage (Play and exported games keep separate ones).
    ...(browserSaveStorage() !== null ? { saveStorage: browserSaveStorage()!, saveNamespace } : {}),
    // Project save slots in the player's IndexedDB (no backend: the export runs standalone).
    ...(browserProjectSaveBackend() !== null ? { projectSaveBackend: browserProjectSaveBackend()! } : {}),
    assetKinds: Object.fromEntries(((manifest.assets ?? []) as unknown as { assetId: string; kind: string }[]).map((r) => [r.assetId, r.kind])),
    // How audio sources are heard (the audio_spatial setting; 3D: panned).
    audioSpatial: audioSpatialOf(settings),
    // The debug console only when the project turns debug_console on (absent/0: a release game has none).
    ...((settings as unknown as Record<string, unknown>)['debug_console'] === 1 ? { debugConsole: true, focusGame: () => canvas.focus() } : {}),
    // The project UI documents and themes (the host draws them).
    ...(uiDocs !== undefined && uiDocs.length > 0 ? { ui: { documents: uiDocs, ...(manifest.uiThemes !== undefined ? { themes: manifest.uiThemes } : {}) } } : {}),
  };
  const host = createGameHost(config);
  const mount = host.mount();
  if (!mount.ok) {
    void remote?.dispose();
    scenes?.dispose();
    throw new Error(`host mount failed: ${JSON.stringify(mount.error)}`);
  }
  scenes?.setPrepare(
    pageScenePreparation({
      adapter: () => adapterRef.current,
      reader: assetReader,
      sources: {
        assets: manifest.assets ?? [],
        ...(manifest.materials !== undefined ? { materials: manifest.materials } : {}),
        ...(manifest.materialFunctions !== undefined ? { materialFunctions: manifest.materialFunctions } : {}),
        ...(manifest.effects !== undefined ? { effects: manifest.effects } : {}),
        ...(manifest.lighting !== undefined ? { lighting: manifest.lighting } : {}),
      },
    }),
  );

  // The model prepares run while the game plays and never block it: a hard
  // failure is a structured on-page error and
  // the game continues without the failed model's visuals (the host stays
  // alive; the error is surfaced truthfully).
  if (models !== null && adapterRef.current !== null) {
    void adapterRef.current
      .modelsSettled?.()
      .then((settle) => {
        if (settle === undefined || settle.ok) return;
        const code = settle.code ?? 'models_config_invalid';
        hud(`export error: the model prepare hard-failed (${code}); the game continues without the failed model`, true);
      })
      .catch(() => undefined);
  }

  // The local audio unlock (the wrapper's one-shot gesture wiring).
  const unlockOnce = (): void => {
    void audio.unlock().catch(() => undefined);
  };
  window.addEventListener('pointerdown', unlockOnce, { once: true });
  window.addEventListener('keydown', unlockOnce, { once: true });

  // The game-observe path of the static export (there is no backend
  // relay here) — the host's own observation (its step, play state and the
  // character's position); read by tooling and the e2e suite.
  // A project save slot's picture (a data URL) for the page — a game's load screen, tests.
  (window as unknown as { __thirdlightSaveThumbnail?: (slot: number) => Promise<string | null> }).__thirdlightSaveThumbnail = (slot: number) => host.projectSaves?.thumbnail(slot) ?? Promise.resolve(null);
  (window as unknown as { __thirdlightObserve?: () => unknown }).__thirdlightObserve = () => {
    const res = host.observe();
    return res.ok ? res.observation : null;
  };

  const refresh = (): void => {
    const res = host.observe();
    if (!res.ok) {
      hud('', false); // disposed: nothing to report
      return;
    }
    const obs = res.observation;
    // The debug line names the build and the play state only (no game rules).
    hud(`${manifest.snapshotId} \u00b7 build ${manifest.buildId.slice(0, 12)} \u00b7 ${obs.state}`, false);
  };
  refresh();
  window.addEventListener('pagehide', () => host.dispose(), { once: true });
}

async function main(): Promise<void> {
  const canvas = document.getElementById('game');
  if (canvas === null || !(canvas instanceof HTMLCanvasElement)) {
    hud('export error: the page has no canvas#game', true);
    return;
  }
  try {
    // The single manifest read (the v2 buildId is verified before anything
    // else loads).
    const res = await fetch('./manifest.json', { credentials: 'omit' });
    if (!res.ok) throw new Error(`manifest read failed (HTTP ${String(res.status)})`);
    const manifest = JSON.parse(await res.text()) as ExportManifestV2;
    if (manifest.type !== 'thirdlight-runtime-content' || manifest.manifestVersion !== RUNTIME_CONTENT_MANIFEST_VERSION_4) throw new Error('unsupported manifest document');
    const expected = await sha256Hex(new TextEncoder().encode(`${JSON.stringify(buildIdInput(manifest as unknown as Record<string, unknown>), null, 2)}\n`));
    if (expected !== manifest.buildId) throw new Error('manifest buildId does not match its own canonical bytes');
    // The content files, each checked against its (buildId-bound) row, back under their keys.
    await start(canvas, await expandManifestContentFiles(manifest, { read: readArtifactBytes, sha256Hex }));
  } catch (e) {
    hud(`export error: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`, true);
  }
}

void main();