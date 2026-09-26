/**
 * M3 export bundle bootstrap (packet 58; delivery.md §3, export.md §3/§5).
 *
 * Runs in the exported static page (`<script type="module">`, IIFE bundle — no
 * top-level `await`). It is the SAME single production composition as
 * preview/play (delivery.md §1/§3: `game-host` owns the registry /
 * `instantiateRuntime` / frame wiring) and links the same pinned outputs.
 * There is no backend, no bridge, no token and no credential in the page.
 *
 * Load order (all relative, all declared; delivery.md (M4) §2.8 export steps,
 * packet 70):
 *   1. `fetch("./manifest.json")` — the single manifest read; the manifest's
 *      own v2 `buildId` is re-derived and verified (WebCrypto) before anything
 *      else loads.
 *   2. `fetch("./scene.json")` — the captured v3 scene document,
 *      digest-verified against `manifest.sceneDigest`.
 *   3. one `fetch("./<declared asset path>")` per manifest asset, EXACTLY ONCE
 *      each — re-hashed to the manifest `sourceDigest` (L2; the host itself
 *      never fetches). The model-kind bytes feed the §2.1 `models` block's
 *      `resolveBytes` (the wrapper-verified map — the adapter never re-hashes).
 *   4. `createGameHost` — the single shared production module composition
 *      (runtime + input + platformer/platformer-game + physics-rapier +
 *      three-adapter scene adapter + the packet-54 audio owner). The adapter
 *      receives the `models` block (`assets` = the referenced model rows,
 *      `animation` from `manifest.media.animation`) + `modelsLoader` =
 *      `createGltfLoaderPort()` imported from the
 *      `@thirdlight/three-adapter/gltf-loader` subpath (the root stays
 *      loader-free — presentation.md §41.9).
 *   5. the model prepares run during `awaitingStart` and NEVER block the menu
 *      channel (the title screen loads regardless); a hard prepare failure is
 *      a structured on-page error — before the run starts it is a composition
 *      hard failure (the host is disposed); the late loads are discarded (L9).
 *   6. the three.js/WebGL renderer (the scene adapter); the HUD is the
 *      host-owned DOM.
 *
 * The resolved `settings` + the frozen `game` block come from the manifest
 * (delivery.md §2.4: hash-bound through the manifest's self-identity).
 *
 * Browser-only: DOM + WebGL. The real-browser walkthrough is UNVERIFIED in this
 * container (no browser/GPU/audio device — packet-38 baseline §1).
 */
import { depthBufferOf, physicsDimensionOf, sha256HexAsync } from '@thirdlight/project-model';
import { attachBrowserInput, DEFAULT_INPUT_CONFIG, focusGameSurface, type InputConfigLike } from '@thirdlight/input';
import { createPhysicsPort, type RapierPhysicsInitConfig, type RapierStaticColliderSpec } from '@thirdlight/physics-rapier';
import {
  browserContextFactory,
  bufferResolver,
  createGameAudioOwner,
  createGameHost,
  linkBehaviorModules,
  prepareSceneCatalog,
  type GameHostConfig,
  type HostDomNode,
  type ManifestBehaviorRow,
  type ManifestBufferRow,
  type ManifestSceneRow,
  type FlowConfigLike,
  browserSaveStorage,
  browserWorkerAvailable,
  createBrowserSimWorker,
  loadPhysics3D,
  resolveThreadingMode,
  resolveTransport,
  startRemoteSimulation,
  threadingLogLine,
  type RemoteSimulation,
} from '@thirdlight/game-host';
import { batchingFromUrl, createSceneAdapter, decodeTexture, effectsOptionFrom, environmentHasLook, pageSearch, resolveRendererPreference } from '@thirdlight/three-adapter';
import { createGltfLoaderPort } from '@thirdlight/three-adapter/gltf-loader';
import type { EffectDefLike, EnvironmentLayerLike, EnvironmentLike, LightingBakeLike, MaterialDefLike, MaterialFunctionLike, SceneAdapter, SceneAdapterModels, WindLike } from '@thirdlight/three-adapter';
import { modelBoundsFromAssetRows, physics3DConfigOf, playerCapsuleOf, playerPhysicsOf, resolveSnapshotHierarchy, staticColliderOf, type GameplaySettings, type PhysicsInitConfig3D, type PhysicsPort3D, type RuntimeSnapshot } from '@thirdlight/runtime';
import { assetPaths, readAsset } from 'thirdlight:export-artifacts';

/** Phase 22.0: the simulation worker's bundle, next to this one (relative to the page). */
const EXPORT_SIM_WORKER_PATH = './js/sim-worker.js';
/** Phase 23.0: the 3D physics backend (`js/physics-3d.js`, only in a 3D project's export). */
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
  gameDigest: string;
  settingsDigest: string;
  mediaDigest: string;
  settings: GameplaySettings;
  game: Record<string, unknown> | null;
  tags?: { bit: number; name: string }[];
  /** Phase 9.4: project materials and the environment (bound by the buildId). */
  materials?: MaterialDefLike[];
  /** Phase 18.3: the material functions graph materials call. */
  materialFunctions?: MaterialFunctionLike[];
  /** Phase 20.2: the visual effects (particle system graphs). */
  effects?: EffectDefLike[];
  environment?: EnvironmentLike & { wind?: WindLike };
  /** Phase 9.6: the scenes' bakes. */
  lighting?: Record<string, LightingBakeLike>;
  /** Phase 9.7: the animator controllers. */
  animators?: unknown[];
  /** Phase 14.1: the prefab definitions scripts spawn. */
  prefabs?: unknown[];
  /** Phase 9.8: the input actions. */
  input?: InputConfigLike;
  /** Phase 12 (c): every scene of a v4 project and the instance-set buffers. */
  scenes?: ManifestSceneRow[];
  buffers?: ManifestBufferRow[];
  assets: ReadonlyArray<{ assetId: string; version: number; sourceDigest: string; sourceByteLength: number; kind: string; path: string }>;
  /** The resolved media identity (delivery.md §2.3): cue slots + one
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
  const keys = [
    'manifestVersion', 'type', 'projectId', 'revision', 'snapshotId', 'capturedAt', 'sceneDigest', 'contentDigest',
    'gameDigest', 'settingsDigest', 'mediaDigest', 'settings', 'game', 'tags', 'materials', 'materialFunctions', 'effects', 'environment', 'lighting', 'animators', 'prefabs', 'input', 'flow', 'scenes', 'buffers', 'assets', 'media', 'behaviors', 'modules',
    'enginePins', 'recipes', 'toolchain', 'buildOptionsDigest',
  ];
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
    // Phase 23.0: the shared rule (world XY, the entity's rotation about Z; movers kinematic; one-way platforms).
    const collider = staticColliderOf(entity.id, components);
    if (collider !== null) statics.push(collider as RapierStaticColliderSpec);
    if (components['controller'] !== undefined) {
      // Phase 14.0: the player's own capsule (its controller's, else the default).
      const capsule = playerCapsuleOf(components['controller']);
      // Phase 15.3: its skin, ground snap and autostep (else the defaults).
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
    // Phase 15.3: the project's step rate and the player's controller tuning.
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

  // The wrapper's read phase (delivery.md (M4) §2.8, L2): every declared
  // asset path is read EXACTLY ONCE (relative) and re-hashed to the manifest
  // `sourceDigest` BEFORE the runtime composes (L2 = hard failure, no
  // runtime). The model-kind bytes feed the `models` block `resolveBytes`.
  // (Phase 22.0: the reads run below, while the simulation worker starts.)
  const assetBytesByKey = new Map<string, ArrayBuffer>();
  const readAssets = async (): Promise<void> => {
    for (const row of manifest.assets ?? []) {
      const buf = await readArtifactBytes(row.path);
      const raw = new Uint8Array(buf);
      if (raw.byteLength !== row.sourceByteLength) throw new Error(`${row.assetId}: byte length ${raw.byteLength} !== manifest ${row.sourceByteLength}`);
      if ((await sha256Hex(raw)) !== row.sourceDigest) throw new Error(`${row.assetId}: digest mismatch against the manifest sourceDigest`);
      assetBytesByKey.set(`${row.assetId}@${row.version}`, buf);
    }
  };

  const settings = manifest.settings;
  // Phase 12 (c): the scene catalog (start scenes read once for their
  // members; the others load on demand through the host).
  const io = { read: readArtifactBytes, sha256Hex };
  const catalog = manifest.scenes !== undefined ? await prepareSceneCatalog(manifest.scenes, io) : null;
  // Phase 12: the scene as the game loads it (folders and inactive entities
  // resolved away) — physics, the renderer and the runtime all use this one.
  const modelBounds = modelBoundsFromAssetRows((manifest.assets ?? []) as readonly { assetId: string; kind?: string; bounds?: unknown }[]);
  const snapshot = resolveSnapshotHierarchy({
    snapshotId: manifest.snapshotId,
    projectId: manifest.projectId,
    revision: manifest.revision,
    scene,
    game: manifest.game ?? null,
    ...(manifest.tags !== undefined ? { tags: manifest.tags } : {}),
    ...(catalog !== null ? { scenes: catalog.rows } : {}),
    // Phase 9.7: the animator controllers (bound by the buildId).
    ...(manifest.animators !== undefined ? { animators: manifest.animators } : {}),
    // Phase 14.1: the prefabs scripts spawn (bound by the buildId).
    ...(manifest.prefabs !== undefined ? { prefabs: manifest.prefabs } : {}),
    // Phase 15.3: the model assets' recorded bounds (a pickup without a size collects over its model's).
    ...(modelBounds !== undefined ? { modelBounds } : {}),
  } as unknown as RuntimeSnapshot);

  // The §2.1 `models` block (or none — the loader-free M1/M2/M3 surface when
  // the scene references no model asset): `assets` = the manifest's
  // model-kind rows for the REFERENCED assetIds only; `animation` from
  // `manifest.media.animation`; `resolveBytes` = the wrapper-verified map.
  const referenced = new Set<string>();
  // Phase 12 (c): scenes loaded later may use any model of the build.
  if (manifest.scenes !== undefined) for (const a of manifest.assets ?? []) if (a.kind === 'model') referenced.add(a.assetId);
  for (const entity of (scene as { entities?: ReadonlyArray<{ components?: Record<string, unknown> }> }).entities ?? []) {
    // The v3 `model` component shape (project-model §18.1):
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
      // Phase 15.3: the project's idle/run/airborne blend time.
      ...(settings.animation_crossfade_s !== undefined ? { crossfadeSeconds: settings.animation_crossfade_s } : {}),
      resolveBytes: (assetId: string, version: number): Promise<ArrayBuffer> => {
        const buf = assetBytesByKey.get(`${assetId}@${version}`);
        if (buf === undefined) return Promise.reject(new Error(`no wrapper-verified bytes for ${assetId} v${version}`));
        return Promise.resolve(buf);
      },
      ...(manifest.buffers !== undefined ? { resolveBuffer: bufferResolver(manifest.buffers, io) } : {}),
    };
  }

  // The physics config (physics-rapier; the manifest's resolved gravity_y drives the solver).
  // Phase 23.0: a 3D project's physics is the 3D backend (its own config; the 2D one otherwise, unchanged).
  const physicsConfig: RapierPhysicsInitConfig | PhysicsInitConfig3D | null = physicsDimensionOf(settings) === 3 ? physics3DConfigOf(snapshot.scene.entities as never, settings) : physicsConfigFromSnapshot(snapshot, settings);
  if (physicsConfig === null && snapshot.game !== null) throw new Error('the game requires a player controller entity');
  // (no game block and no controller: scene mode — the scene plays as authored)

  // Phase 9.8: the project's input actions (bound by the buildId), else the defaults.
  const input = attachBrowserInput(canvas, { inputConfig: manifest.input ?? DEFAULT_INPUT_CONFIG });
  focusGameSurface(canvas);
  const behaviorRows = (manifest as unknown as { behaviors?: ManifestBehaviorRow[] }).behaviors ?? [];
  const enginePins = (manifest as unknown as { enginePins?: { id: string; version: string; apiVersion: number }[] }).enginePins ?? [];
  const moduleIds = (manifest as unknown as { modules?: Array<{ id: string }> }).modules?.map((m) => m.id) ?? [];

  // Phase 22.0: the simulation runs in a worker (js/sim-worker.js next to this
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
          },
          input: { sample: (stepIndex) => input.sample(stepIndex), reset: (reason) => input.reset?.(reason) },
          ...(catalog !== null ? { loadScene: catalog.loadScene } : {}),
          driver: 'raf',
        });
      remoteStart.catch(() => undefined); // awaited below
    }
  }
  // The wrapper's read phase (delivery.md (M4) §2.8, L2): every declared
  // asset path is read EXACTLY ONCE (relative) and re-hashed to the manifest
  // `sourceDigest` BEFORE the runtime composes (L2 = hard failure, no
  // runtime). The model-kind bytes feed the `models` block `resolveBytes`.
  try {
    await readAssets();
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
    // Phase 23.0: the 3D backend (js/physics-3d.js, shipped only in a 3D project's export).
    const backend = await loadPhysics3D(new URL(EXPORT_PHYSICS_3D_PATH, location.href).href);
    const init = await backend.createPhysicsPort3D(physicsConfig as never);
    if (!init.ok) throw new Error(`physics init failed: ${init.error.code}`);
    physics = init.port as PhysicsPort3D;
  } else if (remote === null && physicsConfig !== null) {
    const init = await createPhysicsPort(physicsConfig as RapierPhysicsInitConfig);
    if (!init.ok) throw new Error(`physics init failed: ${init.error.code}`);
    physics = init.port;
  }
  // Phase 15.3: the project's sound voice count (absent: 8).
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
  // Phase 14.4: a level with its own look needs the environment renderer (and wind) even when the project has no environment.
  const levelLooks = ((manifest as unknown as { flow?: FlowConfigLike }).flow?.levels ?? []).some((l) => l.environment !== undefined);
  const config: GameHostConfig = {
    snapshot,
    settings,
    behaviorModules,
    modules: moduleIds,
    ...(physics !== undefined ? { physics } : {}),
    ...(remote !== null ? { runtimeFactory: remote.runtimeFactory } : {}),
    adapter: (runtime) => {
      const a = createSceneAdapter(canvas, {
        runtime,
        snapshot,
        // Phase 17.1: the page's ?renderer= flag, else the project's render_backend setting.
        renderer: { ...resolveRendererPreference({ url: pageSearch(), setting: settings.render_backend }), depthBuffer: depthBufferOf(settings) },
        // Phase 21.3: repeated objects drawn instanced unless the page says ?batching=off (a diagnostic comparison).
        batching: batchingFromUrl(pageSearch()),
        ...(models !== null
          ? { models, modelsLoader: createGltfLoaderPort({ decoderBase: './decoders/' }) }
          : {}),
        // Phase 9.5: sky, fog, fog volumes, post-processing.
        ...(environmentHasLook(manifest.environment) || levelLooks
          ? {
              environment: {
                value: manifest.environment ?? {},
                loadTexture: (assetId: string) => {
                  const row = (manifest.assets ?? []).find((r) => r.kind === 'texture' && r.assetId === assetId);
                  const buf = row !== undefined ? assetBytesByKey.get(`${row.assetId}@${row.version}`) : undefined;
                  return buf !== undefined ? decodeTexture(buf) : Promise.resolve(null);
                },
              },
            }
          : {}),
        // Phase 9.6: lightmaps (atlases from the verified bytes).
        ...(manifest.lighting !== undefined
          ? {
              lighting: {
                bakes: manifest.lighting,
                loadTexture: (assetId: string) => {
                  const row = (manifest.assets ?? []).find((r) => r.kind === 'texture' && r.assetId === assetId);
                  const buf = row !== undefined ? assetBytesByKey.get(`${row.assetId}@${row.version}`) : undefined;
                  return buf !== undefined ? decodeTexture(buf) : Promise.resolve(null);
                },
              },
            }
          : {}),
        // Phase 20.2: the visual effects (textures and models from the verified bytes).
        ...(manifest.effects !== undefined && manifest.effects.length > 0
          ? {
              effects: effectsOptionFrom({
                defs: manifest.effects,
                wind: manifest.environment?.wind ?? null,
                assets: (manifest.assets ?? []) as never,
                bytes: (assetId: string, version: number) => assetBytesByKey.get(`${assetId}@${version}`),
                ...(JSON.stringify(manifest.effects).includes('"model"') ? { loader: createGltfLoaderPort({ decoderBase: './decoders/' }) } : {}),
              }),
            }
          : {}),
        // Phase 9.4: project materials and wind (textures from the verified bytes).
        ...(manifest.materials !== undefined || manifest.environment !== undefined || levelLooks
          ? {
              materials: {
                defs: manifest.materials ?? [],
                functions: manifest.materialFunctions ?? [],
                wind: manifest.environment?.wind ?? null,
                loadTexture: (assetId: string) => {
                  const row = (manifest.assets ?? []).find((r) => r.kind === 'texture' && r.assetId === assetId);
                  const buf = row !== undefined ? assetBytesByKey.get(`${row.assetId}@${row.version}`) : undefined;
                  return buf !== undefined ? decodeTexture(buf) : Promise.resolve(null);
                },
              },
            }
          : {}),
      });
      adapterRef.current = a;
      return a;
    },
    input,
    audio,
    readArtifact: readArtifactBytes,
    ...(catalog !== null ? { loadScene: catalog.loadScene } : {}),
    container,
    buildId: manifest.buildId,
    assetPaths: assetPathsById,
    // Phase 9.10: the game flow (levels, lives, menus, music) and the settings it changes.
    ...((manifest as unknown as { flow?: FlowConfigLike }).flow !== undefined ? { flow: (manifest as unknown as { flow: FlowConfigLike }).flow } : {}),
    inputConfig: structuredClone(manifest.input ?? DEFAULT_INPUT_CONFIG) as unknown as NonNullable<GameHostConfig['inputConfig']>,
    setQuality: (level) => adapterRef.current?.setQuality?.(level),
    setLevelEnvironment: (environment) => adapterRef.current?.setEnvironmentLayer?.(environment as EnvironmentLayerLike | null),
    // Phase 14.5: the title screen's background scene and camera pan.
    setCameraOffset: (offset) => adapterRef.current?.setCameraOffset?.(offset),
    // Phase 9.11: saves in this browser's localStorage (Play and exported games keep separate ones).
    ...(browserSaveStorage() !== null ? { saveStorage: browserSaveStorage()!, saveNamespace: `thirdlight:${String((snapshot as unknown as { projectId?: string }).projectId ?? 'game')}` } : {}),
    assetKinds: Object.fromEntries(((manifest.assets ?? []) as unknown as { assetId: string; kind: string }[]).map((r) => [r.assetId, r.kind])),
    // Phase 23.8: the debug console only when the project turns debug_console on (absent/0: a release game has none).
    ...((settings as unknown as Record<string, unknown>)['debug_console'] === 1 ? { debugConsole: true, focusGame: () => canvas.focus() } : {}),
  };
  const host = createGameHost(config);
  const mount = host.mount();
  if (!mount.ok) {
    void remote?.dispose();
    throw new Error(`host mount failed: ${JSON.stringify(mount.error)}`);
  }

  // The model prepares run during `awaitingStart` and never block the menu
  // channel (delivery.md (M4) §2.8): a hard failure is a structured on-page
  // error — before the run starts it is a composition hard failure (the host
  // is disposed; the in-flight/late loads are discarded — L9). If the failure
  // lands AFTER the run started (the bounded race), the error is shown and
  // the run continues without the failed model's visuals (the host stays
  // alive; the error is surfaced truthfully).
  if (models !== null && adapterRef.current !== null) {
    void adapterRef.current
      .modelsSettled?.()
      .then((settle) => {
        if (settle === undefined || settle.ok) return;
        const code = settle.code ?? 'models_config_invalid';
        const res = host.observe();
        if (res.ok && res.observation.state === 'awaitingStart') {
          host.dispose();
          hud(`export error: the model prepare hard-failed (${code}); the composition is unavailable`, true);
        } else {
          hud(`export error: the model prepare hard-failed (${code}); the run continues without the failed model`, true);
        }
      })
      .catch(() => undefined);
  }

  // The local audio unlock (the wrapper's one-shot gesture wiring).
  const unlockOnce = (): void => {
    void audio.unlock().catch(() => undefined);
  };
  window.addEventListener('pointerdown', unlockOnce, { once: true });
  window.addEventListener('keydown', unlockOnce, { once: true });

  // Phase 23.0: the game-observe path of the static export (there is no backend
  // relay here) — the host's own observation (a game's run state, or a scene's
  // step), with the player's position; read by tooling and the e2e suite.
  const playerId = snapshot.scene.entities.find((e) => ((e.components ?? {}) as unknown as Record<string, unknown>)['controller'] !== undefined)?.id;
  (window as unknown as { __thirdlightObserve?: () => unknown }).__thirdlightObserve = () => {
    const game = host.observe();
    if (game.ok) {
      const st = playerId !== undefined ? host.runtime.getInterpolatedState() : null;
      const tr = st !== null && st.ok ? st.state.transforms.find((t) => t.id === playerId) : undefined;
      return { ...game.observation, ...(tr !== undefined ? { player: { x: tr.position[0], y: tr.position[1], z: tr.position[2] } } : {}) };
    }
    const scene = host.observeScene?.();
    return scene !== undefined && scene.ok ? { state: 'scene', ...scene.observation } : null;
  };

  const refresh = (): void => {
    const res = host.observe();
    if (!res.ok) {
      hud('', false); // scene mode: no game state to report
      return;
    }
    const obs = res.observation;
    hud(`${manifest.snapshotId} \u00b7 build ${manifest.buildId.slice(0, 12)} \u00b7 ${obs.state} \u00b7 deaths=${obs.deathCount} \u00b7 goal=${obs.goalReached}`, false);
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
    if (manifest.type !== 'thirdlight-runtime-content' || manifest.manifestVersion !== 2) throw new Error('unsupported manifest document');
    const expected = await sha256Hex(new TextEncoder().encode(`${JSON.stringify(buildIdInput(manifest as unknown as Record<string, unknown>), null, 2)}\n`));
    if (expected !== manifest.buildId) throw new Error('manifest buildId does not match its own canonical bytes');
    await start(canvas, manifest);
  } catch (e) {
    hud(`export error: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`, true);
  }
}

void main();