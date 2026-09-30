/**
 * The editor preview wrapper for a play backed by runtime content: the
 * preview loading order and the host-side `models` wiring.
 *
 * `preview-bootstrap.ts` (byte-stable) is the inline composition. For a v3
 * play (a runtime-content manifest v2 document) the preview DELEGATES here.
 * The content/snapshot split (see `preview-bootstrap.ts`'s header) is
 * preserved exactly:
 *
 * - the **snapshot (v3 scene) arrives only through the checked bridge** — the
 *   nonce-verified `tl.snapshot` message (the locator route set has no scene
 *   route; the manifest's `sceneDigest` is the identity the
 *   preview verifies the bridge snapshot against);
 * - the **content arrives only through the locator** — the manifest v2
 *   `buildId` (WebCrypto self-identity + the handshake's expected build) and
 *   the declared asset bytes.
 *
 * `startM3Preview` composes the SINGLE shared production host
 * (`createGameHost` — the same entry the export uses) with the
 * manifest's resolved `settings`, the Rapier physics port, the scene
 * adapter (with the `models` block when the scene references model
 * assets), the input owner and the audio owner. There is no second bootstrap,
 * controller or run-state owner.
 *
 * Host-side loading order (preview steps):
 *   1. the handshake is ACKed with the editor's nonce (the
 *      bridge gate then carries the nonce-verified `tl.playContent.expect`
 *      + `tl.snapshot`);
 *   2. the manifest v2 is read + buildId-verified (L1 — `play_content_not_ready`,
 *      phase `manifest`);
 *   3. the bridge snapshot names the manifest's snapshot (its
 *      id, project and revision; the scene is not serialized and hashed a
 *      second time — the backend built both from one capture);
 *   4. the start scenes' assets are read (at most 8 at a time)
 *      and re-hashed to their manifest `sourceDigest` (L2 — phase `assets`);
 *      every other asset is read, once and checked the same way, when it is
 *      asked for (a scene loaded later, a material's texture, a sound); the
 *      wrapper posts truthful load progress (≤ 1 KiB per row);
 *   5. the single shared composition; the adapter receives the `models`
 *      block (`assets` = the referenced model rows, `animation` from
 *      `manifest.media.animation`, `resolveBytes` = the wrapper-verified byte
 *      map) + `modelsLoader` = `createGltfLoaderPort()` imported from the
 *      `@thirdlight/three-adapter/gltf-loader` subpath (the root stays
 *      loader-free); the game-host never fetches;
 *   6. the preview reports `tl.ready` ONLY after the models settle (or, when
 *      the block is absent, after the mount) — with the REAL identity tuple:
 *      the verified snapshotId, the snapshot revision, the
 *      manifest buildId, the manifest contentDigest (64-hex) and the runtime
 *      stepIndex after the settle pre-roll;
 *   7. a hard failure (L1–L5) is surfaced as `tl.error` with the phase + the
 *      accepted code (the adapter's `models_*`/`asset_*` codes are reused —
 *      delivery.md defines no new codes);
 *   8. `tl.play.stop` (or a second start) disposes the host + physics: the
 *      adapter's dispose cancels its in-flight model prepares (L9 — the late
 *      loads are discarded) and the in-flight composition is generation-
 *      fenced so a late `tl.ready`/`tl.error` can never post for a stopped
 *      play.
 *
 * Browser-only (WebGL/DOM/Web Audio/Web Crypto); the in-container half is the
 * Node-verified backend play build (tests/integration/m3-play) — the real
 * browser render walkthrough is the tests/browser suite (audio, gamepad and
 * physical display stay UNVERIFIED in this container).
 */
import { createPhysicsPort, type RapierPhysicsInitConfig, type RapierPhysicsPort, type RapierStaticColliderSpec } from '@thirdlight/physics-rapier';
import { PREVIEW_MODULE_SPECS } from './module-specs';
import { modesForRuntime, audioDurationsFromAssetRows, uiDocumentsForRuntime, withDialogueUiDocument, materialCatalogOf, modelBoundsFromAssetRows, physics3DConfigOf, playerCapsuleOf, playerPhysicsOf, resolveSnapshotHierarchy, staticColliderOf, type ActionFrame, type PhysicsInitConfig3D, type PhysicsPort3D, type RuntimeSnapshot, type GameplaySettings } from '@thirdlight/runtime';
import { audioSpatialOf, depthBufferOf, instanceChunkSizeOf, physicsDimensionOf, sha256HexAsync, type SaveSchema } from '@thirdlight/project-model';
import {
  bufferResolver,
  createGameHost,
  linkBehaviorModules,
  prepareSceneCatalog,
  openRuntimeContent,
  type ManifestContentFileRowLike,
  type RuntimeCatalog,
  type ManifestBehaviorRow,
  type ManifestBufferRow,
  type ManifestSceneRow,
  createGameAudioOwner,
  browserContextFactory,
  type GameHostConfig,
  type GameHost,
  type GameStartOptions,
  type HostDomNode,
  browserSaveStorage,
  browserProjectSaveBackend,
  readProjectSettings,
  browserWorkerAvailable,
  createBrowserSimWorker,
  createLocalSimAccess,
  loadPhysics3D,
  resolveThreadingMode,
  resolveTransport,
  RelayActionSource,
  startRemoteSimulation,
  threadingLogLine,
  createStartTimings,
  createVerifiedAssetReader,
  startSceneAssets,
  AssetReadError,
  createScenePreloader,
  pageScenePreparation,
  type VerifiedAssetReader,
  type RemoteSimulation,
  type RelayUiEdgeName,
  type SimAccess,
  type StartTimings,
} from '@thirdlight/game-host';
import { batchingFromUrl, createSceneAdapter, decodeTexture, effectsOptionFrom, environmentHasLook, pageSearch, resolveRendererPreference, setKtx2DecoderBase } from '@thirdlight/three-adapter';
import { createGltfLoaderPort } from '@thirdlight/three-adapter/gltf-loader';
import type { EffectDefLike, EnvironmentLike, FrameDrawnInfo, LightingBakeLike, MaterialDefLike, MaterialFunctionLike, SceneAdapter, SceneAdapterModels, SceneAdapterOptions, WindLike } from '@thirdlight/three-adapter';
import { attachBrowserInput, DEFAULT_INPUT_CONFIG, DEFAULT_INPUT_CONFIG_3D, focusGameSurface, type InputConfigLike } from '@thirdlight/input';
import { Bridge } from './bridge';
import { answerScreenshot } from './screenshot-answer';
import { resolveRelayFrames, type IncomingRelayFrame } from './relay-frames';

// KTX2 texture assets (and GLBs with KHR_texture_basisu) transcode with three's Basis files served at /decoders/basis/.
setKtx2DecoderBase('/decoders/');

/**
 * The simulation worker's script on the preview origin (a static
 * file next to the decoders, built from `./sim-worker.ts`). In
 * the play build (`buildRoot`, a digest-keyed URL the browser caches) when
 * the page names one.
 */
const PREVIEW_SIM_WORKER_FILE = 'sim-worker.js';

/**
 * The 3D physics backend's script on the preview origin (built
 * from `./physics-3d.ts`), loaded only by a project whose physics_dimension
 * is 3 — in the page (single thread) or by the worker (next to its script).
 */
const PREVIEW_PHYSICS_3D_FILE = 'physics-3d.js';

/** The runtime-content manifest v2 document (the fields the preview reads). */
export interface PreviewManifestV2 {
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
  saveSchema?: SaveSchema;
  /** The timelines. */
  timelines?: import('@thirdlight/runtime').TimelineAsset[];
  /** The event → cue table. */
  eventCues?: import('@thirdlight/runtime').RuntimeEventCue[];
  /** The game shell (menus and HUD documents, the scene list). */
  shell?: import('@thirdlight/game-host').ShellConfigLike;
  /** Every scene of a v4 project and the instance-set buffers. */
  scenes?: ManifestSceneRow[];
  buffers?: ManifestBufferRow[];
  /**
   * The content files the document lists; materials,
   * materialFunctions, uiDocuments, dialogue and buffers above come from
   * them (`openRuntimeContent`), never from the document itself (v4).
   */
  contentFiles?: ManifestContentFileRowLike[];
  assets: Array<{ assetId: string; version: number; path: string; kind: string; sourceDigest: string; sourceByteLength: number }>;
  /** The resolved media identity: cue slots + one
   * `modelAnimation` row per entity (entityId/assetId/version/profileDigest/
   * roles). */
  media: { cues: Record<string, unknown>; animation: Array<{ entityId: string; assetId: string; version: number; profileDigest: string; roles: Record<string, unknown> }> };
  buildId: string;
}

/** The wrapper's bounded structured error (the load phase + accepted code). */
export class PreviewM3Error extends Error {
  readonly code: string;
  readonly phase: string;
  constructor(code: string, phase: string, message: string) {
    super(message);
    this.code = code;
    this.phase = phase;
  }
}

export interface M3PreviewConfig {
  /** The locator-relative artifact root (e.g. `/play-content/<contentId>/`). */
  readonly contentRoot: string;
  /**
   * The project's cache root (`/play-content/<cacheId>/`): the
   * declared artifacts by digest, at URLs that stay the same from Play to
   * Play (the browser's cache hits; the bytes are still checked against the
   * manifest here). Absent: everything from `contentRoot`.
   */
  readonly cacheRoot?: string | null;
  /** The play build's root (the worker and physics scripts); absent: the preview origin's root. */
  readonly buildRoot?: string | null;
  /** The verified manifest buildId (from the play handshake). */
  readonly expectedBuildId: string;
  /** The bridge-delivered runtime snapshot (the v3 scene). */
  readonly snapshot: RuntimeSnapshot;
  /** The preview-owned canvas the scene adapter renders into. */
  readonly canvas: HTMLCanvasElement;
  /** The HUD root element the host owns (removed on dispose). */
  readonly container: HTMLElement;
  /** Truthful load progress (the bridge's `tl.load.progress`, ≤ 1 KiB). */
  readonly onProgress?: (phase: string, loadedBytes: number, totalBytes: number) => void;
  /** The page's start timings (stages, frames, scene loads); absent: none recorded. */
  readonly timings?: StartTimings;
}

export interface M3PreviewHandle {
  readonly host: GameHost;
  /**
   * The simulation's async surface (script values, the debugger,
   * diagnostics, the exclusive input exercise) — the page's runtime in
   * single-thread mode, the worker otherwise.
   */
  readonly access: SimAccess;
  /** Where the simulation runs, and why. */
  readonly threading: { readonly mode: 'worker' | 'single'; readonly reason: string; readonly transport: 'shared' | 'message' | null; readonly isolated: boolean };
  /** The render adapter (screenshots, diagnostics), when one was created. */
  readonly adapter: SceneAdapter | null;
  /** The verified ready identity: the verified snapshotId + snapshot
   * revision, the manifest buildId + contentDigest (64-hex, bound by the
   * buildId check) and the runtime stepIndex after the settle pre-roll. */
  readonly identity: { snapshotId: string; revision: number; buildId: string; contentDigest: string; stepIndex: number };
  /** Fixed steps per second (the debugger's "recently active" window is half a second of them). */
  readonly stepHz: number;
  /** The input bindings in effect (the input exercise's virtual gamepad). */
  readonly inputConfig: () => InputConfigLike;
  /** The asset reads so far (at start and on demand) and their verified bytes. */
  assetReads(): { reads: number; bytes: number };
  dispose(): void;
}

/** Lowercase hex SHA-256 (Web Crypto when the page has it, pure JS otherwise). */
const sha256Hex = sha256HexAsync;

/** The locator-relative artifact reader (manifest-declared paths only). */
function readPreviewArtifact(contentRoot: string, path: string): Promise<ArrayBuffer> {
  return readArtifactUrl(`${contentRoot}${path}`, path);
}

function readArtifactUrl(url: string, path: string): Promise<ArrayBuffer> {
  return fetch(url, { credentials: 'omit' }).then((res) => {
    if (!res.ok) return Promise.reject(new Error(`artifact read failed for ${path} (HTTP ${String(res.status)})`));
    return res.arrayBuffer();
  });
}

/**
 * Where a declared artifact of this build is read. Assets,
 * instance buffers, scene files and compiled scripts are named by their
 * digest in the manifest, so they are read from the project's cache root by
 * digest (the same URL every Play); anything else from the play's own root.
 */
export function artifactUrls(manifest: { scenes?: readonly { path: string; digest: string }[] }, contentRoot: string, cacheRoot: string | null | undefined): (path: string) => string {
  if (cacheRoot === null || cacheRoot === undefined) return (path) => `${contentRoot}${path}`;
  const scenes = new Map((manifest.scenes ?? []).map((r) => [r.path, r.digest] as const));
  return (path) => {
    if (/^content\/sha256\/[0-9a-f]{64}$/.test(path) || /^behaviors\/[0-9a-f]{64}\.js$/.test(path)) return `${cacheRoot}${path}`;
    const scene = scenes.get(path);
    if (scene !== undefined && /^[0-9a-f]{64}$/.test(scene)) return `${cacheRoot}content/sha256/${scene}`;
    return `${contentRoot}${path}`;
  };
}

/** Deep structural equality (key-order independent): the snapshot's tags against the manifest's. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const ka = Object.keys(a as Record<string, unknown>).sort();
  const kb = Object.keys(b as Record<string, unknown>).sort();
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i += 1) {
    const key = ka[i];
    if (key === undefined || key !== kb[i]) return false;
    if (!deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false;
  }
  return true;
}

/** The assetIds the snapshot scene references through a `model` component
 * (the v3 shape: `components.model.asset.assetId`). */
function referencedModelAssetIds(snapshot: RuntimeSnapshot): Set<string> {
  const out = new Set<string>();
  for (const entity of snapshot.scene.entities) {
    const components = (entity.components ?? {}) as unknown as Record<string, unknown>;
    const model = components['model'] as { asset?: { assetId?: string } } | undefined;
    if (model !== undefined && typeof model.asset?.assetId === 'string') out.add(model.asset.assetId);
  }
  return out;
}

/**
 * The `models` block (or null when the scene references no model asset —
 * the adapter then stays byte-stable loader-free). `assets` = the manifest's model-kind
 * rows for the REFERENCED assetIds only (the asset set is the referenced set);
 * `animation` = the manifest's `media.animation` rows (the resolved media
 * identity, hash-bound through `mediaDigest`); `resolveBytes` = the
 * wrapper-verified byte map (the adapter never re-hashes).
 */
function buildModelsBlock(manifest: PreviewManifestV2, snapshot: RuntimeSnapshot, reader: VerifiedAssetReader, read: (path: string) => Promise<ArrayBuffer>, content: { readonly catalog: RuntimeCatalog; readonly facts: readonly Readonly<Record<string, unknown>>[] }): SceneAdapterModels | null {
  // Scenes loaded later may use any model of the build: a v4 manifest lists
  // them all; a v5 catalog lists what the start needs, and the adapter finds
  // the others' rows as their scenes are read (or reads their shard).
  const referenced = manifest.scenes !== undefined
    ? new Set(manifest.assets.filter((a) => a.kind === 'model').map((a) => a.assetId))
    : referencedModelAssetIds(snapshot);
  const lazy = content.catalog.version === 5 && content.facts.some((f) => f['kind'] === 'model');
  if (referenced.size === 0 && !lazy) return null;
  const modelRows = manifest.assets.filter((a) => a.kind === 'model' && referenced.has(a.assetId));
  // The scene references a model asset the manifest does not declare: a
  // captured-state integrity failure (L2, phase `assets`).
  if (modelRows.length !== referenced.size) {
    const missing = [...referenced].filter((id) => !modelRows.some((r) => r.assetId === id));
    throw new PreviewM3Error('models_asset_unresolved', 'assets', `the scene references model asset(s) absent from the manifest: ${missing.join(', ')}`);
  }
  for (const row of manifest.media.animation) {
    if (typeof row.entityId !== 'string' || typeof row.assetId !== 'string' || typeof row.version !== 'number' || typeof row.profileDigest !== 'string' || typeof row.roles !== 'object' || row.roles === null) {
      throw new PreviewM3Error('models_config_invalid', 'assets', 'the manifest media.animation row shape is invalid');
    }
  }
  return {
    assets: modelRows.map(modelRowOf),
    // A model row read after the start (its scene's dependency file, or its shard).
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
    ...(manifest.buffers !== undefined
      ? { resolveBuffer: bufferResolver(manifest.buffers, { read, sha256Hex }) }
      : {}),
  };
}

/** The adapter's row of one model (id, version, digest; tint, material map, clips' rig). */
function modelRowOf(r: { assetId: string; version: number; sourceDigest: string }): SceneAdapterModels['assets'][number] {
  const x = r as { vertexColors?: unknown; materials?: unknown; clipsFor?: unknown };
  return { assetId: r.assetId, version: r.version, sourceDigest: r.sourceDigest, ...(x.vertexColors === 'tint' ? { vertexColors: 'tint' as const } : {}), ...(x.materials !== undefined ? { materials: x.materials as Record<string, string> } : {}), ...(typeof x.clipsFor === 'string' ? { clipsFor: x.clipsFor } : {}) };
}

/** The scene-derived Rapier init config (statics + the player controller) with
 * the manifest's resolved `gravity_y` as the solver gravity. */
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

/**
 * Start the M3 preview for one verified capture: read + verify the manifest v2
 * from the locator (WebCrypto `buildId`), check that the bridge-delivered
 * snapshot names the manifest's capture, read + verify the start scenes'
 * assets (the rest on demand, each once), then compose + mount
 * the single shared host and AWAIT
 * the models settle. A failed read/verify/mount/prepare
 * throws a bounded `PreviewM3Error` (the caller surfaces it to the bridge as a
 * structured play error with the load phase + accepted code).
 */
export async function startM3Preview(cfg: M3PreviewConfig): Promise<M3PreviewHandle> {
  const onProgress = cfg.onProgress ?? (() => undefined);
  const timings = cfg.timings;

  // 1. The manifest v2 (buildId-verified via WebCrypto; must also equal the
  //    handshake's expected build). L1 — phase `manifest`.
  timings?.begin('manifest');
  const manifestRes = await readPreviewArtifact(cfg.contentRoot, 'manifest.json');
  const manifestDoc = JSON.parse(new TextDecoder().decode(manifestRes)) as { buildId?: unknown };
  // The declared artifacts by digest from the project's cache root (still checked against their rows).
  let urlOf = artifactUrls({}, cfg.contentRoot, cfg.cacheRoot);
  const readDeclared = (path: string): Promise<ArrayBuffer> => readArtifactUrl(urlOf(path), path);
  // The manifest (its buildId re-derived), the catalog's blocks and what the start scenes need,
  // each file checked against its buildId-bound row; the rest of the catalog is read as the game needs it.
  const content = await openRuntimeContent<PreviewManifestV2>(manifestDoc, { read: readDeclared, sha256Hex }).catch((e: unknown) => {
    throw new PreviewM3Error('play_content_not_ready', 'manifest', `the manifest or a catalog file failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 180)}`);
  });
  if (content.manifest.buildId !== cfg.expectedBuildId) throw new PreviewM3Error('play_content_not_ready', 'manifest', 'the manifest buildId does not match the expected build');
  const manifest = content.manifest;
  urlOf = artifactUrls(manifest, cfg.contentRoot, cfg.cacheRoot);
  const catalogRead = content.catalog.stats();
  timings?.end('manifest', `${manifestRes.byteLength} B${catalogRead.files > 0 ? ` + ${String(catalogRead.files)} catalog files ${String(catalogRead.bytes)} B` : ''}`);
  // Each stage done is progress (the backend's present timeout counts from the last).
  onProgress('manifest', manifestRes.byteLength + catalogRead.bytes, manifestRes.byteLength + catalogRead.bytes);

  // 2. The bridge-delivered snapshot: verify its scene re-hashes to
  //    manifest.sceneDigest.
  // A test/debug start (resolved by the backend) is not part of the runtime snapshot.
  const { start: startBlock, ...bridged } = cfg.snapshot as RuntimeSnapshot & { start?: PlayStartBlock };
  const authored: RuntimeSnapshot = bridged;
  const startOptions = startBlock !== undefined ? hostStartOf(startBlock) : undefined;
  const startVariables = startBlock?.variables;
  // The snapshot and the manifest come from one backend capture (the play.started message
  // that carries the snapshot names this build); the snapshot must name the manifest's capture. The scene
  // is not serialized and hashed again here (the backend checked its bytes against sceneDigest).
  const named = authored as unknown as { snapshotId?: unknown; projectId?: unknown; revision?: unknown };
  if (named.snapshotId !== manifest.snapshotId || named.projectId !== manifest.projectId || named.revision !== manifest.revision) {
    throw new PreviewM3Error('play_content_not_ready', 'manifest', 'the snapshot does not name the manifest\'s capture (snapshotId, project, revision)');
  }
  // The tag registry is the manifest's (bound by the buildId).
  if (!deepEqual(authored.tags ?? [], manifest.tags ?? [])) {
    throw new PreviewM3Error('play_content_not_ready', 'manifest', 'the snapshot tags do not match the manifest tags');
  }
  // The scene catalog (start scenes read once for their
  // members; the others load on demand through the host).
  timings?.begin('startScenes');
  const catalog0 = manifest.scenes !== undefined
    ? await prepareSceneCatalog(manifest.scenes, { read: readDeclared, sha256Hex }, content.catalog)
    : null;
  timings?.end('startScenes');
  // Scene loads go through the preloader (read, then prepared on the render side before the
  // simulation gets them; the scenes a game is likely to load next are read ahead). Each is timed.
  const scenes = catalog0 === null
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
  // The scene as the game loads it (folders and inactive entities
  // resolved away) — physics, the renderer and the runtime all use this one.
  // The animator controllers come from the verified manifest.
  const withAnimators0 = manifest.animators !== undefined ? ({ ...authored, animators: manifest.animators } as RuntimeSnapshot) : authored;
  // The prefabs scripts spawn (from the verified manifest).
  const withPrefabs = manifest.prefabs !== undefined ? ({ ...withAnimators0, prefabs: manifest.prefabs } as RuntimeSnapshot) : withAnimators0;
  // The block types and cell fields of the block layers (from the verified manifest).
  const withAnimators = { ...withPrefabs, ...(manifest.blockTypes !== undefined ? { blockTypes: manifest.blockTypes } : {}), ...(manifest.cellFields !== undefined ? { cellFields: manifest.cellFields } : {}) } as RuntimeSnapshot;
  // The model assets' recorded bounds (a collectible without a size collects over its model's).
  const modelBounds = modelBoundsFromAssetRows(content.facts as readonly { assetId: string; kind?: string; bounds?: unknown }[]);
  const withBounds0 = modelBounds !== undefined ? ({ ...withAnimators, modelBounds } as RuntimeSnapshot) : withAnimators;
  // The model rigs sockets are resolved on (from the verified manifest).
  const withBoundsR = manifest.rigs !== undefined ? ({ ...withBounds0, rigs: manifest.rigs } as RuntimeSnapshot) : withBounds0;
  // The graph materials' parameters scripts set per object (ctx.materials; from the verified manifest).
  const materialCatalog = materialCatalogOf(manifest.materials as Parameters<typeof materialCatalogOf>[0], content.facts as Parameters<typeof materialCatalogOf>[1]);
  const withBoundsM = materialCatalog !== undefined ? ({ ...withBoundsR, materialCatalog } as RuntimeSnapshot) : withBoundsR;
  // The project save schema (ctx.saves; from the verified manifest).
  const withBoundsS = manifest.saveSchema !== undefined ? ({ ...withBoundsM, saveSchema: manifest.saveSchema } as RuntimeSnapshot) : withBoundsM;
  // The UI documents scripts show and hide (id, layer, modal; the host draws them from the manifest).
  // Plus the engine's dialogue document when the project has conversations (and the runner's data).
  const uiDocs = withDialogueUiDocument(manifest.uiDocuments, manifest.dialogue ?? null);
  const uiRows = uiDocumentsForRuntime(uiDocs);
  const withBoundsU0 = uiRows !== undefined ? ({ ...withBoundsS, uiDocuments: uiRows } as RuntimeSnapshot) : withBoundsS;
  const withBoundsU1 = manifest.dialogue !== undefined ? ({ ...withBoundsU0, dialogue: manifest.dialogue } as RuntimeSnapshot) : withBoundsU0;
  // The timelines (ctx.timeline, play-on-start / play-on-signal).
  const withBoundsU2 = manifest.timelines !== undefined && manifest.timelines.length > 0 ? ({ ...withBoundsU1, timelines: manifest.timelines } as RuntimeSnapshot) : withBoundsU1;
  // The event → cue table (the runtime plays its sounds through the audio intent log).
  const withBoundsU3 = manifest.eventCues !== undefined && manifest.eventCues.length > 0 ? ({ ...withBoundsU2, eventCues: manifest.eventCues } as RuntimeSnapshot) : withBoundsU2;
  // The game shell's scene list (the `scene` UI event walks it).
  const withBoundsU = manifest.shell?.scenes !== undefined ? ({ ...withBoundsU3, sceneList: manifest.shell.scenes } as RuntimeSnapshot) : withBoundsU3;
  // The audio assets' recorded durations (script sounds' finished events are computed from them).
  const audioDurations = audioDurationsFromAssetRows(content.facts as readonly { assetId: string; kind?: string; durationMs?: unknown }[]);
  const withBoundsA = audioDurations !== undefined ? ({ ...withBoundsU, audioDurations } as RuntimeSnapshot) : withBoundsU;
  // The game modes and each action's input map (the masking of inactive maps; from the verified manifest).
  const modeRows = modesForRuntime(manifest.modes, manifest.input ?? (physicsDimensionOf(manifest.settings) === 3 ? DEFAULT_INPUT_CONFIG_3D : DEFAULT_INPUT_CONFIG));
  const withBoundsM2 = modeRows !== undefined ? ({ ...withBoundsA, modes: modeRows } as RuntimeSnapshot) : withBoundsA;
  // The environment preset ids scripts switch and blend to (ctx.environment; from the verified manifest).
  const presetIds = (manifest.environment?.presets ?? []).map((p) => p.presetId);
  const withBounds = presetIds.length > 0 ? ({ ...withBoundsM2, environmentPresets: presetIds } as RuntimeSnapshot) : withBoundsM2;
  const snapshot = resolveSnapshotHierarchy(catalog !== null ? { ...withBounds, scenes: catalog.rows } : withBounds);

  const settings = manifest.settings;
  // Every declared asset is read through this reader, once, checked against its catalog row.
  const assetReader = createVerifiedAssetReader(manifest.assets, { read: readDeclared, sha256Hex }, { catalog: content.catalog });
  // This project's saves in Play (an export uses its own namespace).
  const playSaveNamespace = `thirdlight-play:${String((snapshot as unknown as { projectId?: string }).projectId ?? 'game')}`;
  // Physics runs only for a game (a player controller); a plain scene plays
  // without it.
  // A 3D project's physics is the 3D backend (its own config; the 2D one otherwise, unchanged).
  const physicsConfig: RapierPhysicsInitConfig | PhysicsInitConfig3D | null = physicsDimensionOf(settings) === 3 ? physics3DConfigOf(snapshot.scene.entities as never, settings, { layers: manifest.collisionLayers ?? [] }) : physicsConfigFromSnapshot(snapshot, settings);
  // (no controller: no physics world; a module that needs one says so when the host composes)
  // The project's input actions (bound by the buildId), else the defaults.
  // The bindings in effect (a player's rebinding changes them) — the input exercise's virtual gamepad reads through them.
  let inputConfigNow: InputConfigLike = manifest.input ?? (physicsDimensionOf(settings) === 3 ? DEFAULT_INPUT_CONFIG_3D : DEFAULT_INPUT_CONFIG);
  const browserInput = attachBrowserInput(cfg.canvas, { inputConfig: inputConfigNow });
  // What this composition attaches to the page is released with it
  // (the input listeners, the focus listener, the audio owner and its context,
  // the unlock listeners) — a new snapshot composes again on the same canvas —
  // and on every failure path below.
  const releases: (() => void)[] = [() => browserInput.dispose(), focusGameSurface(cfg.canvas), ...(scenes !== null ? [() => scenes.dispose()] : [])];
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

    // The simulation runs in a worker unless the page (?threads=off),
    // the project (sim_thread) or the browser says otherwise.
    // A play-test start may ask for a mode (over the setting; the URL flag still wins).
    const threading = resolveThreadingMode({ url: pageSearch(), setting: settings.sim_thread, workerAvailable: browserWorkerAvailable(), ...(startBlock?.threads !== undefined ? { start: startBlock.threads } : {}) });
    let threadMode = threading.mode;
    let threadReason = threading.reason;
    const isolated = (globalThis as { crossOriginIsolated?: unknown }).crossOriginIsolated === true;
    if (threadMode === 'worker') {
      const worker = createBrowserSimWorker(new URL(`${cfg.buildRoot ?? '/'}${PREVIEW_SIM_WORKER_FILE}`, location.href).href);
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
              // The worker imports each compiled script from the locator (absolute same-origin URLs).
              behaviors: { rows: behaviorRows, enginePins, urls: Object.fromEntries(behaviorRows.map((r) => [r.path, new URL(urlOf(r.path), location.href).href])) },
              shared: resolveTransport(globalThis as never) === 'shared',
              // Injected script variables (ctx.save from step 0).
              ...(startVariables !== undefined ? { variables: startVariables } : {}),
              // The game mode the run starts in (a start option).
              ...(startOptions?.mode !== undefined && modeRows !== undefined ? { startMode: startOptions.mode } : {}),
              // The stored project settings document (the runtime starts with it).
              ...(snapshot.saveSchema !== undefined ? { projectSettings: readProjectSettings(snapshot.saveSchema, browserSaveStorage() ?? undefined, playSaveNamespace) } : {}),
            },
            input: { sample: (stepIndex) => browserInput.sample(stepIndex), reset: (reason) => browserInput.reset?.(reason) },
            ...(catalog !== null ? { loadScene: catalog.loadScene } : {}),
            driver: 'raf',
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

    // 3. The wrapper's read phase (L2): the start scenes' assets, read at most 8 at a time
    //    and re-hashed to their manifest sourceDigest (the adapter never receives unverified bytes); the
    //    other assets go through the same reader when they are asked for.
    try {
      const startRows = startSceneAssets({
        assets: manifest.assets,
        entities: snapshot.scene.entities,
        ...(manifest.scenes !== undefined ? { startSceneIds: manifest.scenes.filter((r) => r.start).map((r) => r.sceneId) } : {}),
        ...(manifest.materials !== undefined ? { materials: manifest.materials } : {}),
        ...(manifest.materialFunctions !== undefined ? { materialFunctions: manifest.materialFunctions } : {}),
        ...(manifest.effects !== undefined ? { effects: manifest.effects } : {}),
        ...(manifest.environment !== undefined ? { environment: manifest.environment } : {}),
        ...(manifest.lighting !== undefined ? { lighting: manifest.lighting } : {}),
      });
      timings?.begin('assets');
      await assetReader.preload(startRows, (loaded, total) => onProgress('assets', loaded, total));
      timings?.end('assets', `${startRows.length} of ${manifest.assets.length}`);
      timings?.count('startAssetReads', startRows.length);
      timings?.count('startAssetBytes', startRows.reduce((n, r) => n + r.sourceByteLength, 0));
    } catch (e) {
      void remoteStart?.then((r) => r.dispose(), () => undefined);
      remoteStart = null;
      throw e instanceof AssetReadError ? new PreviewM3Error('asset_source_invalid', 'assets', e.message) : e;
    }
    // 4. The single shared production composition with the
    //    `models` block (or none — the adapter stays loader-free).
    const models = buildModelsBlock(manifest, snapshot, assetReader, readDeclared, content);

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
    let physics: RapierPhysicsPort | PhysicsPort3D | undefined;
    if (remote === null && physicsConfig !== null) timings?.begin('physics');
    if (remote === null && physicsConfig !== null && 'dimension' in physicsConfig) {
      // The 3D backend (a separate script, loaded only for a 3D project).
      const backend = await loadPhysics3D(new URL(`${cfg.buildRoot ?? '/'}${PREVIEW_PHYSICS_3D_FILE}`, location.href).href);
      const init = await backend.createPhysicsPort3D(physicsConfig as never);
      if (!init.ok) throw new PreviewM3Error('play_content_not_ready', 'manifest', `physics init failed: ${init.error.code}`);
      const p = init.port as PhysicsPort3D;
      physics = p;
      releases.push(() => p.dispose());
    } else if (remote === null && physicsConfig !== null) {
      const init = await createPhysicsPort(physicsConfig as RapierPhysicsInitConfig);
      if (!init.ok) throw new PreviewM3Error('play_content_not_ready', 'manifest', `physics init failed: ${init.error.code}`);
      physics = init.port;
      const p = init.port;
      releases.push(() => p.dispose());
    }
    if (physics !== undefined) timings?.end('physics');
    const relay = new RelayActionSource(browserInput);
    // The input exercise's UI edges and clicks, applied at the next host frames (the menu channel is read every frame).
    const relayEdges: RelayUiEdgeName[] = [];
    const relayClicks: string[] = [];
    const hostRef: { current: GameHost | null } = { current: null };
    const accessRef: { current: SimAccess | null } = { current: null };
    const NO_EDGES = { up: false, down: false, left: false, right: false, submit: false, cancel: false, pause: false };
    const input = {
      sample: (stepIndex: number) => relay.sample(stepIndex),
      sampleMenu: () => {
        for (const key of relayClicks.splice(0)) hostRef.current?.clickUi?.(key);
        // A frame of a paused game takes one step's place in a running exercise (its menu can be driven and resumed).
        if (accessRef.current?.inputTestActive === true && hostRef.current?.playState?.() === 'paused') accessRef.current.relayIdle();
        return browserInput.sampleMenu();
      },
      markConfirmConsumed: () => browserInput.markConfirmConsumed(),
      dispose: () => browserInput.dispose(),
      // Menu navigation and key rebinding (the shell's and UI documents' screens).
      sampleUi: () => {
        const physical = browserInput.sampleUi();
        const edge = relayEdges.shift();
        return edge === undefined ? physical : { ...NO_EDGES, [edge]: true };
      },
      captureKey: (cb: (code: string | null) => void) => browserInput.captureKey(cb),
      // Pad rebinding in the settings.
      capturePadButton: (cb: (button: number | null) => void) => browserInput.capturePadButton(cb),
      configure: (c: InputConfigLike) => {
        inputConfigNow = c;
        browserInput.configure(c);
      },
      // The UI hit test (the pointer over the UI: overUi, presses left to the UI).
      setUiHitTest: (hit: ((x: number, y: number) => boolean) | null) => browserInput.setUiHitTest(hit),
      // A focused UI document's action map.
      setActiveMaps: (maps: readonly string[] | null) => browserInput.setActiveMaps(maps),
      // The cursor (free/locked, hidden while a gamepad drives).
      applyCursor: (mode: 'free' | 'locked') => browserInput.applyCursor(mode),
      cursorState: () => browserInput.cursorState(),
      // Listen-for-input rebinding, the device used last and the frame's input entry.
      captureInput: (o: Parameters<typeof browserInput.captureInput>[0], cb: Parameters<typeof browserInput.captureInput>[1]) => browserInput.captureInput(o, cb),
      activeDevice: () => browserInput.activeDevice(),
      activeDeviceInfo: () => browserInput.activeDeviceInfo(),
      setFrameInput: (f: Parameters<typeof browserInput.setFrameInput>[0]) => browserInput.setFrameInput(f),
    };
    // The project's sound voice count (absent: 8).
    const audio = createGameAudioOwner({ contextFactory: browserContextFactory() ?? undefined, ...(settings.audio_voices !== undefined ? { maxVoices: settings.audio_voices } : {}) });
    releases.push(() => void audio.dispose());
    const assetPathsById: Record<string, string> = {};
    for (const asset of manifest.assets) assetPathsById[asset.assetId] = asset.path;

    // The adapter instance the factory creates (the settle + dispose surfaces).
    // A holder object: the factory (host-called inside `mount()`) assigns
    // `current`, which the settle gate below reads after the mount.
    const adapterRef: { current: SceneAdapter | null } = { current: null };
    // The project's compiled behaviors (same-origin modules under the locator); in worker mode the worker links them.
    if (remote === null && behaviorRows.length > 0) timings?.begin('behaviors');
    const behaviorModules = remote !== null ? [] : await linkBehaviorModules(behaviorRows, enginePins, (path) => import(/* @vite-ignore */ urlOf(path)));
    if (remote === null && behaviorRows.length > 0) timings?.end('behaviors');
    const config: GameHostConfig = {
      snapshot,
      settings,
      behaviorModules,
      modules: moduleIds,
      moduleSpecs: PREVIEW_MODULE_SPECS,
      ...(physics !== undefined ? { physics } : {}),
      ...(remote !== null ? { runtimeFactory: remote.runtimeFactory } : {}),
      adapter: (runtime) => {
        const a = createSceneAdapter(cfg.canvas, {
          runtime,
          snapshot,
          // The play page's ?renderer= flag (the editor passes its own on), else the project's render_backend setting.
          renderer: { ...resolveRendererPreference({ url: pageSearch(), setting: settings.render_backend }), depthBuffer: depthBufferOf(settings) },
          // Repeated objects drawn instanced unless the page says ?batching=off (a diagnostic comparison).
          batching: batchingFromUrl(pageSearch()),
          // The first frame, slow frames and scene attaches for the start timings.
          ...(timings !== undefined ? { onFrameDrawn: (f: FrameDrawnInfo) => timings.frame(f) } : {}),
          ...(models !== null
            ? { models, modelsLoader: createGltfLoaderPort({ decoderBase: '/decoders/' }) }
            : {}),
          ...materialsOptionOf(manifest, assetReader, content.catalog),
          // The visual effects (textures and models from the verified bytes).
          ...(manifest.effects !== undefined && manifest.effects.length > 0
            ? {
                effects: effectsOptionFrom({
                  defs: manifest.effects,
                  wind: manifest.environment?.wind ?? null,
                  assets: manifest.assets,
                  bytes: (assetId: string, version: number) => assetReader.bytes(assetId, version).catch(() => undefined),
                  ...(JSON.stringify(manifest.effects).includes('"model"') ? { loader: createGltfLoaderPort({ decoderBase: '/decoders/' }) } : {}),
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
      readArtifact: (path) => assetReader.bytesAt(path) ?? readDeclared(path),
      ...(catalog !== null ? { loadScene: catalog.loadScene } : {}),
      ...(scenes !== null ? { scenes } : {}),
      container: cfg.container as unknown as HostDomNode,
      buildId: manifest.buildId,
      assetPaths: assetPathsById,
      // The game shell (menus and HUD as UI documents, the scene list).
      ...(manifest.shell !== undefined ? { shell: manifest.shell } : {}),
      inputConfig: structuredClone(manifest.input ?? (physicsDimensionOf(settings) === 3 ? DEFAULT_INPUT_CONFIG_3D : DEFAULT_INPUT_CONFIG)) as unknown as NonNullable<GameHostConfig['inputConfig']>,
      setQuality: (level) => adapterRef.current?.setQuality?.(level),
      // Saves in this browser's localStorage (Play and exported games keep separate ones).
      ...(browserSaveStorage() !== null ? { saveStorage: browserSaveStorage()!, saveNamespace: playSaveNamespace } : {}),
      // Project save slots in this browser's IndexedDB (Play and exported games keep separate ones).
      ...(browserProjectSaveBackend() !== null ? { projectSaveBackend: browserProjectSaveBackend()! } : {}),
      assetKinds: Object.fromEntries(((manifest.assets ?? []) as unknown as { assetId: string; kind: string }[]).map((r) => [r.assetId, r.kind])),
      audioLoad: Object.fromEntries(((manifest.assets ?? []) as unknown as { assetId: string; kind: string; loadType?: string; preload?: boolean }[]).filter((r) => r.kind === 'audio' && r.loadType !== undefined).map((r) => [r.assetId, { loadType: r.loadType, preload: r.preload !== false }])),
      // An asset the rows above do not name: its catalog shard, read when a sound asks for it.
      lookupAsset: (assetId) => content.catalog.lookup(assetId).then((r) => (r === undefined ? undefined : { path: r.path, kind: r.kind, ...(typeof r['loadType'] === 'string' ? { loadType: r['loadType'] } : {}), ...(typeof r['preload'] === 'boolean' ? { preload: r['preload'] } : {}) })),
      // How audio sources are heard (the audio_spatial setting; 3D: panned).
      audioSpatial: audioSpatialOf(settings),
      // Play always has the debug console (the backquote key); a start from "Play from…" / tl_play_start.
      debugConsole: true,
      focusGame: () => cfg.canvas.focus(),
      ...(startVariables !== undefined ? { variables: startVariables } : {}),
      ...(startOptions !== undefined ? { start: startOptions } : {}),
      // The project UI documents and themes (the host draws them).
      ...(uiDocs !== undefined && uiDocs.length > 0 ? { ui: { documents: uiDocs, ...(manifest.uiThemes !== undefined ? { themes: manifest.uiThemes } : {}) } } : {}),
    };
    const host = createGameHost(config);
    // Play has no page gesture wiring of its own: the first key or click in the
    // game frame unlocks sound (music and cues).
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
    if (!mount.ok) {
      throw new PreviewM3Error('play_content_not_ready', 'manifest', `host mount failed: ${JSON.stringify(mount.error)}`);
    }
    // A scene is prepared (assets read, models parsed, textures decoded) before the simulation gets it.
    scenes?.setPrepare(
      pageScenePreparation({
        adapter: () => adapterRef.current,
        reader: assetReader,
        catalog: content.catalog,
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

    // 5. The models settle: the preview reports
    //    ready ONLY after the prepares settle. A hard failure (L3–L5) is a
    //    `PreviewM3Error` carrying the adapter's accepted code — the host +
    //    physics are disposed so the in-flight/late loads are discarded (L9).
    if (models !== null && adapterRef.current !== null) {
      timings?.begin('models');
      // Every model prepared is progress (a project with many large models keeps its start alive).
      const adapterNow = adapterRef.current;
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
      const settle = await adapterRef.current.modelsSettled?.().finally(() => clearInterval(watch));
      timings?.end('models');
      if (settle === undefined || settle.ok === false) {
        const code = settle?.code ?? 'models_config_invalid';
        throw new PreviewM3Error(code, 'assets', `the model prepare hard-failed (${code}): ${settle?.message ?? 'no settle result'}`);
      }
    }

    // The real ready identity: the verified snapshotId + snapshot
    // revision, the manifest buildId + contentDigest (64-hex, bound by the
    // buildId check), and the runtime stepIndex after the settle pre-roll.
    const obs = host.observe();
    const identity = {
      snapshotId: String((snapshot as unknown as { snapshotId?: string }).snapshotId ?? ''),
      revision: Number((snapshot as unknown as { revision?: number }).revision ?? 0),
      buildId: manifest.buildId,
      contentDigest: manifest.contentDigest,
      stepIndex: obs.ok ? obs.observation.stepIndex : 0,
    };

    const stepHz = settings.fixed_step_hz ?? 120;
    const access = remote !== null ? remote.access : createLocalSimAccess({ runtime: host.runtime, relay, ...(physics !== undefined ? { physics: physics as never } : {}), stepHz });
    // The input exercise's page side — the UI hit targets and where its UI edges and clicks go.
    hostRef.current = host;
    accessRef.current = access;
    access.setRelayPage({
      targets: () => host.uiHitTargets?.() ?? [],
      effect: (e) => {
        if (e.kind === 'click') relayClicks.push(e.key);
        else for (const edge of e.edges) if (relayEdges.length < 64) relayEdges.push(edge);
      },
    });
    return {
      host,
      access,
      inputConfig: () => inputConfigNow,
      threading: { mode: threadMode, reason: threadReason, transport: remote?.transport ?? null, isolated },
      adapter: adapterRef.current,
      identity,
      stepHz,
      assetReads: () => assetReader.stats(),
      dispose: () => {
        // The host disposes its runtime — in worker mode the mirror, which ends the worker (the physics world is freed there);
        // then the physics port, the audio owner, the input and the page listeners.
        releaseAll();
      },
    };
  } catch (e) {
    releaseAll();
    void remoteStart?.then((r) => r.dispose(), () => undefined);
    throw e;
  }
}

/** The injected preview page config (the backend's play HTML — config, not secrets). */
interface PreviewM3PageConfig {
  v: number;
  authoringOrigin: string;
  playSessionId: string | null;
  contentId: string | null;
  manifestPath: string;
}

/**
 * The v3 preview page entry (the locator's `game.js` for a v3 play — the same
 * role as the M2 `preview.js`/`preview-bootstrap.ts`): read the page config,
 * create the canvas + HUD container + the relay bridge, ack the handshake, and
 * on the nonce-verified `tl.snapshot` compose + mount the single shared host.
 * Truthful `ready` is reported ONLY after the models settle (or, when the
 * `models` block is absent, after the mount) — not when the title screen
 * loads and not when gameplay starts. This is a SEPARATE entry from the
 * byte-stable `preview-bootstrap.ts` (its preview bundle stays unchanged —
 * this wrapper is not inlined into that entry).
 *
 * Browser-only; the in-container-verified half is the Node play build.
 */
export function bootstrapPreviewM3(): void {
  // The page's start timings, from its time origin (the bundle's download and evaluation first).
  const timings = createStartTimings();
  recordBundleTimings(timings);
  const cfg = (window as { __thirdlightPreview?: PreviewM3PageConfig }).__thirdlightPreview;
  const contentRoot = (window as { __thirdlightContentRoot?: string }).__thirdlightContentRoot ?? '/play-content/';
  // The stable roots the backend names (the project's cache root, the play build).
  const cacheRoot = (window as { __thirdlightCacheRoot?: string }).__thirdlightCacheRoot ?? null;
  const buildRoot = (window as { __thirdlightBuildRoot?: string }).__thirdlightBuildRoot ?? null;
  if (!cfg || cfg.v !== 2 || cfg.playSessionId === null) {
    const el = document.createElement('div');
    el.textContent = 'no M3 play session';
    document.body.appendChild(el);
    return;
  }
  const playId = cfg.playSessionId;
  const canvas = document.createElement('canvas');
  // The game fills the page exactly: fixed canvas, no scrolling, HUD on top.
  canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;display:block;background:#0e1015;';
  document.documentElement.style.cssText = 'margin:0;height:100%;overflow:hidden;';
  document.body.style.cssText = 'margin:0;height:100%;overflow:hidden;';
  document.body.appendChild(canvas);
  const container = document.createElement('div');
  container.id = 'tl-hud-root';
  container.style.cssText = 'position:fixed;top:8px;left:8px;font:12px/1.4 system-ui,sans-serif;color:#9aa4b2;';
  document.body.appendChild(container);

  let trustedSource: unknown = null;
  const bridge = new Bridge({
    direction: 'preview',
    expectedOrigin: cfg.authoringOrigin,
    targetOrigin: cfg.authoringOrigin,
    post: (data, target) => window.parent.postMessage(data, target),
    isTrustedSource: (s) => s === trustedSource || s === window.parent || s === window.opener,
  });

  // Generation fencing: every `tl.play.stop` / second
  // start bumps the generation; a late composition result (a slow asset read,
  // a cancelled model prepare) can never post `tl.ready`/`tl.error` for a
  // stopped play, and the handle it created is disposed (the adapter's
  // dispose cancels its in-flight model loads — L9).
  let generation = 0;
  let handle: M3PreviewHandle | null = null;
  let expectedBuildId = '';
  const disposePlay = (): void => {
    if (handle !== null) {
      handle.dispose();
      handle = null;
    }
  };

  // The handshake records the expected build (the bridge records the nonce,
  // which it enforces on the tl.snapshot gate) + the trusted peer source —
  // and ACKS with the editor's nonce (the
  // sequence is handshake → ack → playContent.expect → snapshot; the editor
  // sends the snapshot only after the ack).
  bridge.on('tl.handshake', (m, event) => {
    timings.end('handshake');
    trustedSource = event.source;
    const bid = (m as Record<string, unknown>).buildId;
    if (typeof bid === 'string') expectedBuildId = bid;
    const nonce = (m as Record<string, unknown>).nonce;
    if (typeof nonce === 'string') bridge.ackHandshake(playId, nonce);
  });

  // The nonce-verified snapshot (the v3 scene) drives the composition.
  bridge.on('tl.snapshot', (m) => {
    const snapshot = (m as { snapshot?: RuntimeSnapshot }).snapshot;
    if (snapshot === undefined) return;
    timings.end('snapshot');
    const gen = ++generation;
    // A re-snapshot for the same play disposes the previous composition first
    // (the single active composition).
    disposePlay();
    void startM3Preview({
      contentRoot,
      cacheRoot,
      buildRoot,
      expectedBuildId,
      snapshot,
      canvas,
      container,
      timings,
      onProgress: (phase, loadedBytes, totalBytes) => {
        if (gen === generation) bridge.sendLoadProgress(playId, phase, loadedBytes, totalBytes);
      },
    })
      .then((h) => {
        if (gen !== generation) {
          // Stopped (or superseded) mid-composition: discard everything the
          // late composition created, including the settled model prepares.
          h.dispose();
          return;
        }
        handle = h;
        // Truthful ready: the composition is mounted AND the models have
        // settled. The real identity tuple:
        // verified snapshotId, snapshot revision, manifest buildId,
        // manifest contentDigest (64-hex), runtime stepIndex after the settle
        // pre-roll.
        const id = h.identity;
        timings.end('ready');
        bridge.sendReady(playId, id.snapshotId, id.revision, id.buildId, id.contentDigest, id.stepIndex);
      })
      .catch((e) => {
        if (gen !== generation) return; // stopped mid-composition: silent discard
        const err = e instanceof PreviewM3Error ? e : null;
        bridge.sendError(playId, err?.code ?? 'play_content_not_ready', err?.message ?? (e instanceof Error ? e.message : 'the M3 preview failed to start'), err?.phase ?? 'manifest');
      });
  });

  // ---- relays from the editor (MCP / backend tools) ----------------------------
  const notReady = { ok: false as const, error: { code: 'not_ready', message: 'the play is not ready' } };

  // One visual-script debugger per running play, where the
  // simulation runs (in the page or in the worker; the editor runs no game code).
  bridge.on('tl.debug.request', (m) => {
    const body = m as { relayId: string; behaviorId: string; entityId?: string; breakpoints: string[]; command?: 'pause' | 'resume' | 'step' };
    const h = handle;
    if (h === null) {
      bridge.sendDebugResult(playId, body.relayId, notReady);
      return;
    }
    void h.access.debugRequest({ behaviorId: body.behaviorId, breakpoints: body.breakpoints, ...(body.entityId !== undefined ? { entityId: body.entityId } : {}), ...(body.command !== undefined ? { command: body.command } : {}) }).then((result) => {
      bridge.sendDebugResult(playId, body.relayId, result === null ? notReady : { ok: true, result: result as never });
    });
  });

  bridge.on('tl.input.request', (m) => {
    const body = m as { requestId: string; frames: readonly IncomingRelayFrame[]; restart?: boolean; hold?: boolean };
    if (handle === null) {
      bridge.sendInputResult(playId, body.requestId, notReady);
      return;
    }
    // A virtual gamepad is read through the bindings here (the page has them), step by step.
    const frames = resolveRelayFrames(body.frames, handle.inputConfig(), handle.stepHz);
    const accepted = handle.access.beginInputTest(
      frames,
      (from, to) => {
        bridge.sendInputResult(playId, body.requestId, { ok: true, appliedFromStep: from, appliedToStep: to });
      },
      // Restart the game first (the replay); the frames begin at the new run's first step.
      // Hold the game right after the last step (lockstep tools: the next exercise begins at the next step).
      { restart: body.restart === true, hold: body.hold === true },
    );
    if (!accepted) bridge.sendInputResult(playId, body.requestId, { ok: false, error: { code: 'input_relay_conflict', message: 'a relay is already active' } });
  });

  bridge.on('tl.screenshot.request', (m) => {
    const body = m as { relayId: string; maxWidth?: number };
    if (handle === null) {
      bridge.sendScreenshotResult(playId, body.relayId, notReady);
      return;
    }
    // Always answers (a throw or an over-bound PNG becomes an answer, not a relay timeout).
    const adapter = handle.adapter;
    bridge.sendScreenshotResult(playId, body.relayId, answerScreenshot(adapter === null ? null : (w) => adapter.captureScreenshot(w), body.maxWidth ?? 1024));
  });

  bridge.on('tl.diagnostics.request', (m) => {
    const body = m as { relayId: string };
    const h = handle;
    if (h === null) {
      bridge.sendDiagnosticsResult(playId, body.relayId, notReady);
      return;
    }
    void h.access.diagnostics().then((rd) => {
      const ad = h.adapter?.diagnostics();
      bridge.sendDiagnosticsResult(playId, body.relayId, {
        ok: true,
        diagnostics: {
          runtime: rd.ok ? rd.diagnostics : { error: rd.error.code },
          renderer: ad === undefined ? null : ad.ok ? ad.diagnostics : { error: ad.error.code },
          buildId: h.identity.buildId,
          frameDrops: bridge.drops,
          // Where the simulation runs.
          simulation: { ...h.threading },
          // The current game mode (the Play toolbar shows it).
          ...modeDiagnostics(h),
          // Where this play's start went (stages, first frame, slow frames, scene loads).
          startTimings: timings.report(),
          // Every asset read so far (the start scenes' and those read on demand since).
          assetReads: h.assetReads(),
        },
      });
    });
  });

  /** The game-observation wire payload (+ the player position), or null without a game. */
  const observation = async (h: M3PreviewHandle, entityId?: string): Promise<Record<string, unknown> | null> => {
    // The parts only the simulation can answer (asked of the worker in worker mode).
    const behaviors = entityId !== undefined ? await behaviorValues(h.access, entityId) : null;
    const debug = await h.access.debugObservation();
    // The run digest now and after the last input exercise (asked of the worker in worker mode).
    const digests = await h.access.runDigests();
    // Every game plays as a scene (the step, the play state, sound, the character…).
    const sc = h.host.observe();
    if (!sc.ok) return null;
    const o = sc.observation;
    return {
      ok: true,
      playSessionId: playId,
      snapshotId: o.snapshotId,
      buildId: h.identity.buildId,
      runId: `${o.snapshotId}#0`,
      revision: h.identity.revision,
      observedAt: new Date().toISOString(),
      stepIndex: o.stepIndex,
      simTime: o.simTime,
      state: o.state,
      inputMode: h.access.inputTestActive ? 'test' : 'physical',
      ...(digests !== null ? { run: { stepIndex: digests.now.stepIndex, runStep: digests.now.runStep, digest: digests.now.digest, ...(digests.input !== null ? { lastInput: { ...digests.input } } : {}) } } : {}),
      sound: o.sound,
      simulation: { mode: h.threading.mode, transport: h.threading.transport, isolated: h.threading.isolated },
      ...(o.player !== undefined ? { player: { x: o.player.x, y: o.player.y, z: o.player.z } } : {}),
      ...(o.scenes !== undefined ? { scenes: { loaded: [...o.scenes.loaded], loading: [...o.scenes.loading] } } : {}),
      // The audio sources' live loops (entity id → gain).
    ...(o.loops !== undefined ? { loops: { ...o.loops } } : {}),
    ...(o.camera !== undefined ? { camera: structuredClone(o.camera) } : {}),
      // The environment preset blend (once a script changed it).
      ...(o.environment !== undefined ? { environment: structuredClone(o.environment) } : {}),
      // The Web Audio graph (live voices with gain/pan/rate, music, buses, listener).
      ...(o.audio !== undefined ? { audio: structuredClone(o.audio) } : {}),
      // The objects riding on sockets and their world positions.
      ...(o.sockets !== undefined ? { sockets: structuredClone(o.sockets) } : {}),
      // The timelines (screen fade/letterbox, plays, the last events).
      ...(o.timeline !== undefined ? { timeline: structuredClone(o.timeline) } : {}),
      // The pointer the simulation read, the cursor, the objects scripts hid.
      ...(o.pointer !== undefined ? { pointer: { ...o.pointer } } : {}),
      ...(o.cursor !== undefined ? { cursor: { ...o.cursor } } : {}),
      ...(o.hidden !== undefined ? { hidden: [...o.hidden] } : {}),
      // The player's bindings (device, profile, listening, changed actions, glyphs).
      ...(o.inputBindings !== undefined ? { inputBindings: structuredClone(o.inputBindings) } : {}),
      // The named counters (collectibles and scripts add to them; at most 32) and every object's health (the host observes both).
      ...(o.counters !== undefined ? { counters: { ...o.counters } } : {}),
      ...(o.health !== undefined ? { health: structuredClone(o.health) } : {}),
      // The animator states and the spawned objects.
      ...animatorStates(h.host.runtime),
      ...spawnedObservation(h.host.runtime),
      ...rendererObservation(h),
      ...effectsObservation(h),
      ...(behaviors !== null ? { behaviors } : {}),
      ...(debug !== null && debug !== undefined ? { debug } : {}),
      ...debugCommandsObservation(h),
      ...savesObservationOf(h.host),
      ...uiObservation(h, o.ui),
      // The conversation (line, reveal, choices, backlog, modes).
      ...(o.dialogue !== undefined ? { dialogue: structuredClone(o.dialogue) } : {}),
      // The game modes, the engine pause and its panel.
      ...(o.mode !== undefined ? { mode: structuredClone(o.mode), paused: o.paused === true } : {}),
      ...(o.pausePanel !== undefined ? { pausePanel: { ...o.pausePanel } } : {}),
      // The game shell (its screen, the listed scene, the HUD shown) and the engine pause it holds.
      ...(o.shell !== undefined ? { shell: structuredClone(o.shell), paused: o.paused === true } : {}),
    };
  };

  bridge.on('tl.game.observe', (m) => {
    const body = m as { relayId: string; entityId?: string };
    const h = handle;
    void (h === null ? Promise.resolve(null) : observation(h, body.entityId)).then((o) => {
      if (o === null) bridge.sendGameResult('observe', playId, body.relayId, { ok: false, error: { code: 'game_unavailable', message: 'this play has nothing to observe yet' } });
      else bridge.sendGameResult('observe', playId, body.relayId, { ok: true, result: o });
    });
  });

  bridge.on('tl.game.control', (m) => {
    const body = m as ControlBody;
    const h = handle;
    if (h === null) {
      bridge.sendGameResult('control', playId, body.relayId, notReady);
      return;
    }
    void control(h, body);
  });

  const control = async (handle: M3PreviewHandle, body: ControlBody): Promise<void> => {
    // The step and play state of the answer.
    const acceptedNow = (): { ok: true; state: 'running' | 'paused' | 'stopped'; acceptedAtStep: number } => {
      const o = handle.host.observe();
      return o.ok ? { ok: true, state: o.observation.state, acceptedAtStep: o.observation.stepIndex } : { ok: true, state: 'running', acceptedAtStep: 0 };
    };
    // A scene request goes to the runtime like a script's ctx.scenes.
    let r: ReturnType<GameHost['control']>;
    if (body.command === 'debugCommand') {
      // A project debug command, queued into the next step's input (recorded with it).
      r = handle.host.debugCommand?.(String(body.name ?? ''), body.args ?? {}) ?? { ok: false, error: { code: 'game_command_invalid', message: 'this game has no debug commands' } };
    } else if (body.command === 'debugPause' || body.command === 'debugResume' || body.command === 'debugStep') {
      // The debugger's hold / release / single step (Play only; an export has no relay).
      await handle.access.debugControl(body.command);
      r = acceptedNow();
    } else if (body.command === 'loadScene' || body.command === 'unloadScene') {
      const s = handle.host.scene(body.command === 'loadScene' ? 'load' : 'unload', String(body.sceneId ?? ''));
      r = s.ok ? acceptedNow() : s;
    } else {
      r = handle.host.control(body.command);
    }
    if (!r.ok) {
      bridge.sendGameResult('control', playId, body.relayId, { ok: false, error: { code: r.error.code, message: r.error.message } });
      return;
    }
    // Every play answers alike (run 0 of its snapshot).
    const snap = handle.identity.snapshotId;
    bridge.sendGameResult('control', playId, body.relayId, {
      ok: true,
      result: {
        ok: true,
        playSessionId: playId,
        snapshotId: snap,
        buildId: handle.identity.buildId,
        runId: `${snap}#0`,
        command: body.command,
        state: r.state,
        acceptedAtStep: r.acceptedAtStep,
        inputMode: handle.access.inputTestActive ? 'test' : 'physical',
      },
    });
  };

  bridge.on('tl.play.stop', () => {
    generation += 1; // fence any in-flight composition
    disposePlay();
    bridge.sendStopped(playId);
  });
  bridge.on('tl.ping', () => bridge.sendPong());

  window.addEventListener('message', (ev: MessageEvent) => {
    bridge.handleMessage({ origin: ev.origin, source: ev.source, data: ev.data });
  });
}

// The v3 play bundle entry: bootstrap immediately on load (the locator's
// `game.js` for a v3 play is this bundle — the same role as
// `preview.js`/`preview-bootstrap.ts`).
bootstrapPreviewM3();

/**
 * The game bundle's own part of the start, from the browser's
 * resource timing: its download (`bundleFetch`, with its size) and its parse
 * and evaluation up to this bootstrap (`bundleEval`).
 */
function recordBundleTimings(timings: StartTimings): void {
  const now = performance.now();
  const entry = (performance.getEntriesByType?.('resource') ?? []).find((e) => /\/game\.js(\?|$)/.test(e.name)) as PerformanceResourceTiming | undefined;
  if (entry === undefined) {
    timings.record('bundle', 0, now);
    return;
  }
  timings.record('bundleFetch', entry.startTime, entry.responseEnd, `${entry.transferSize} B over the wire, ${entry.decodedBodySize} B`);
  timings.record('bundleEval', entry.responseEnd, now);
}

/** The resolved start block the backend puts on the bridged snapshot. */
interface PlayStartBlock {
  sceneId?: string;
  scenes?: string[];
  spawnId?: string;
  variables?: Record<string, unknown>;
  projectSave?: Record<string, unknown>;
  projectSaveSlot?: number;
  mode?: string;
  /** Where this play's simulation runs (over the project setting). */
  threads?: 'worker' | 'single';
}

/** The host's start options from the resolved block (variables go to the runtime separately). */
function hostStartOf(b: PlayStartBlock): GameStartOptions | undefined {
  const o: { -readonly [K in keyof GameStartOptions]: GameStartOptions[K] } = {};
  if (b.scenes !== undefined) o.scenes = b.scenes;
  if (b.spawnId !== undefined) o.spawnId = b.spawnId;
  if (b.mode !== undefined) o.mode = b.mode;
  // A project save document or slot.
  if (b.projectSave !== undefined) o.projectSave = b.projectSave as unknown as NonNullable<GameStartOptions['projectSave']>;
  if (b.projectSaveSlot !== undefined) o.projectSaveSlot = b.projectSaveSlot;
  return Object.keys(o).length > 0 ? o : undefined;
}

/** `mode` {current, name} for the Play toolbar (a project with modes). */
function modeDiagnostics(h: M3PreviewHandle): { mode?: { current: string; name: string } } {
  const mv = h.host.runtime.modeView?.() ?? null;
  return mv === null ? {} : { mode: { current: mv.current, name: mv.name } };
}

/** A relayed game control request (`debugCommand` with its name and arguments). */
interface ControlBody {
  relayId: string;
  command: 'replay' | 'mute' | 'unmute' | 'loadScene' | 'unloadScene' | 'clearSave' | 'debugPause' | 'debugResume' | 'debugStep' | 'debugCommand';
  sceneId?: string;
  name?: string;
  args?: Record<string, number | string | boolean>;
}

/**
 * `ui` {shown, screen, focus, actionMap, values} — values is the
 * scripts' view model when its JSON fits 4 KiB (else `valueKeys`, its top
 * level keys), so an observation stays inside its bound.
 */
function uiObservation(h: M3PreviewHandle, ui: unknown): { ui?: Record<string, unknown> } {
  if (ui === undefined || ui === null) return {};
  const model = h.host.runtime.uiView?.().model ?? {};
  const text = JSON.stringify(model);
  // The shown widgets' rectangles (fractions of the view; `hit`: a press there goes to the UI), within 4 KiB.
  let elements = h.host.uiElements?.(48) ?? [];
  while (elements.length > 0 && JSON.stringify(elements).length > 4096) elements = elements.slice(0, Math.floor(elements.length * 0.75));
  return { ui: { ...(structuredClone(ui) as Record<string, unknown>), ...(text.length <= 4096 ? { values: JSON.parse(text) as unknown } : { valueKeys: Object.keys(model).slice(0, 64) }), elements } };
}

/**
 * `debugCommands` {registered [{name, description, args}], applied
 * [{stepIndex, name, args}] (the last 16)} and `start` (what the start options
 * did), for tl_game_observe — bounded (32 commands, 16 calls).
 */
function debugCommandsObservation(h: M3PreviewHandle): { debugCommands?: Record<string, unknown>; start?: Record<string, unknown> } {
  const st = h.host.runtime.debugCommandState?.();
  const outcome = h.host.startOutcome ?? null;
  let debugCommands: Record<string, unknown> | undefined;
  if (st !== undefined && (st.registered.length > 0 || st.applied.length > 0)) {
    const applied = st.applied.slice(-16).map((a) => ({ stepIndex: a.stepIndex, name: a.name, args: { ...a.args } }));
    const registered = st.registered.slice(0, 32).map((c) => ({ name: c.name, description: c.description, args: c.args.map((a) => ({ ...a })) }));
    debugCommands = { registered, applied };
    // The observation's 16 KiB bound: long descriptions go first, then the oldest calls.
    if (JSON.stringify(debugCommands).length > 6000) debugCommands = { registered: registered.map((c) => ({ ...c, description: c.description.slice(0, 24) })), applied: applied.slice(-8), truncated: true };
  }
  return {
    ...(debugCommands !== undefined ? { debugCommands } : {}),
    ...(outcome !== null ? { start: outcome.ok ? { ok: true, applied: [...outcome.applied] } : { ok: false, reason: outcome.reason } } : {}),
  };
}

/**
 * The property values the running scripts on `entityId` read
 * (public and private; at most 8 scripts, strings clipped to 64 characters so
 * the observation stays inside its 16 KiB bound). Read from the running
 * runtime — the editor never runs game code.
 */
async function behaviorValues(access: SimAccess, entityId: string): Promise<{ entityId: string; scripts: unknown[] }> {
  type View = { behaviorId: string; properties: { key: string; label: string; type: string; visibility: string; value: unknown }[] };
  const views = (await access.behaviorProperties(entityId)) as View[];
  const clip = (v: unknown): unknown => (typeof v === 'string' && v.length > 64 ? `${v.slice(0, 63)}…` : Array.isArray(v) ? [...v] : v);
  return {
    entityId,
    scripts: views.slice(0, 8).map((v) => ({
      behaviorId: v.behaviorId,
      properties: v.properties.slice(0, 32).map((p) => ({ key: p.key, label: p.label, type: p.type, visibility: p.visibility, value: clip(p.value) })),
    })),
  };
}

/** The current state of every animator (at most 64), for tl_game_observe. */
/** The spawned-entity block of an observation (absent without a scene set). */
/** The adapter's renderer choice (requested backend and source, what draws, state, reason). */
function rendererObservation(h: M3PreviewHandle): { renderer?: Record<string, unknown> } {
  const d = h.adapter?.diagnostics();
  const r = d !== undefined && d.ok ? d.diagnostics.renderer : undefined;
  return r !== undefined ? { renderer: { ...r } } : {};
}

/** The effect player — its executor (webgpu | cpu) and caps, what plays (compact: no per-effect list). */
function effectsObservation(h: M3PreviewHandle): { effects?: Record<string, unknown> } {
  const d = h.adapter?.diagnostics();
  const e = d !== undefined && d.ok ? d.diagnostics.effects : undefined;
  return e !== undefined ? { effects: { executor: e.executor, caps: e.caps, playing: e.playing, particles: e.particles, refused: e.refused, lights: e.lights } } : {};
}

function spawnedObservation(runtime: unknown): { spawned?: { count: number; ids: string[] } } {
  const set = (runtime as { sceneSet?: () => { spawned?: readonly { id: string }[] } }).sceneSet?.();
  if (set?.spawned === undefined) return {};
  return { spawned: { count: set.spawned.length, ids: set.spawned.slice(0, 64).map((e) => e.id) } };
}

function animatorStates(runtime: unknown): { animators?: Record<string, string> } {
  const poses = (runtime as { animatorPoses?: () => ReadonlyMap<string, { state: string; layers?: readonly { name: string; state: string }[] }> }).animatorPoses?.();
  if (poses === undefined || poses.size === 0) return {};
  // Override layers follow the base state ("Run | Upper body: Attack").
  const text = (p: { state: string; layers?: readonly { name: string; state: string }[] }): string => [p.state, ...(p.layers ?? []).map((l) => `${l.name}: ${l.state}`)].join(' | ').slice(0, 256);
  return { animators: Object.fromEntries([...poses].slice(0, 64).map(([id, p]) => [id, text(p)])) };
}

/** The adapter's materials option from the verified manifest (textures from the verified bytes). */
function materialsOptionOf(manifest: PreviewManifestV2, reader: VerifiedAssetReader, catalog: RuntimeCatalog): { materials?: SceneAdapterOptions['materials']; environment?: SceneAdapterOptions['environment']; lighting?: SceneAdapterOptions['lighting']; lights: NonNullable<SceneAdapterOptions['lights']> } {
  // Read (once, checked) when a material, a bake, the sky or a spot cookie first needs it (its row from the catalog).
  const loadTexture: NonNullable<SceneAdapterOptions['materials']>['loadTexture'] = (assetId) =>
    catalog.lookup(assetId).then(
      (row) => (row !== undefined && row.kind === 'texture' ? reader.bytes(row.assetId, row.version).then((buf) => decodeTexture(buf), () => null) : null),
      () => null,
    );
  // Spot light cookies (textures of any scene's lights).
  const lights = { loadTexture };
  if (manifest.materials === undefined && manifest.environment === undefined && manifest.lighting === undefined) return { lights };
  const env = manifest.environment;
  return {
    lights,
    // Environment presets need the environment renderer too (scripts blend the look).
    ...(environmentHasLook(env) || (env?.presets?.length ?? 0) > 0 ? { environment: { value: env ?? {}, loadTexture } } : {}),
    ...(manifest.lighting !== undefined ? { lighting: { bakes: manifest.lighting, loadTexture } } : {}),
    materials: {
      defs: manifest.materials ?? [],
      functions: manifest.materialFunctions ?? [],
      wind: manifest.environment?.wind ?? null,
      loadTexture,
    },
  };
}

/**
 * `saves` {slotCount, storage, slots (the first 32 used: title,
 * chapter, location, play time, when, version, bytes, picture facts), settings}
 * for tl_game_observe (a project with a save schema).
 */
function savesObservationOf(host: { observe(): unknown }): { saves?: unknown } {
  const o = host.observe() as { ok: boolean; observation?: { saves?: unknown } };
  const saves = o.ok ? o.observation?.saves : undefined;
  return saves !== undefined ? { saves: structuredClone(saves) } : {};
}
