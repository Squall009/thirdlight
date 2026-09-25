/**
 * The editor M3 preview wrapper (packet 59; M4 packet 70, 70-A — delivery.md
 * (M4) §2.8 preview loading order, the C64-4 host-side `models` wiring).
 *
 * `preview-bootstrap.ts` (the M2 wrapper, byte-stable) is the M2 inline
 * composition. For a v3 play (a runtime-content manifest v2 document) the
 * preview DELEGATES here. The accepted content/snapshot split (sessions.md
 * §13.2/§17.6; the M2 wrapper's header) is preserved exactly:
 *
 * - the **snapshot (v3 scene) arrives only through the checked bridge** — the
 *   nonce-verified `tl.snapshot` message (the accepted §17.2.1 locator route
 *   set has no scene route; the manifest's `sceneDigest` is the identity the
 *   preview verifies the bridge snapshot against);
 * - the **content arrives only through the locator** — the manifest v2
 *   `buildId` (WebCrypto self-identity + the handshake's expected build) and
 *   the declared asset bytes.
 *
 * `startM3Preview` composes the SINGLE shared production host
 * (`createGameHost` — the same entry the M3 export uses, packet 58) with the
 * manifest's resolved `settings`/`game`, the Rapier physics port, the scene
 * adapter (with the §2.1 `models` block when the scene references model
 * assets), the input owner and the audio owner. There is no second bootstrap,
 * controller or run-state owner (delivery.md §3.2 normative).
 *
 * M4 (packet 70) host-side loading order (delivery.md §2.8, preview steps):
 *   1. the handshake is ACKed with the editor's nonce (D-63-5 repair — the
 *      bridge gate then carries the nonce-verified `tl.playContent.expect`
 *      + `tl.snapshot`);
 *   2. the manifest v2 is read + buildId-verified (L1 — `play_content_not_ready`,
 *      phase `manifest`);
 *   3. the bridge snapshot's scene re-hashes to `manifest.sceneDigest` and its
 *      `game` re-hashes to `manifest.gameDigest` (step 5 — deep-equal against
 *      the manifest's own hash-bound `game` block: the buildId check already
 *      binds `gameDigest`, so a deep-equal snapshot `game` re-hashes to it);
 *   4. every declared asset is read EXACTLY ONCE (relative path) and re-hashed
 *      to its manifest `sourceDigest` (L2 — phase `assets`); the wrapper
 *      posts truthful load progress (≤ 1 KiB per row);
 *   5. the single shared composition; the adapter receives the §2.1 `models`
 *      block (`assets` = the referenced model rows, `animation` from
 *      `manifest.media.animation`, `resolveBytes` = the wrapper-verified byte
 *      map) + `modelsLoader` = `createGltfLoaderPort()` imported from the
 *      `@thirdlight/three-adapter/gltf-loader` subpath (the root stays
 *      loader-free — presentation.md §41.9); the game-host never fetches;
 *   6. the preview reports `tl.ready` ONLY after the models settle (or, when
 *      the block is absent, after the mount) — with the REAL identity tuple
 *      (D-63-6 repair): the verified snapshotId, the snapshot revision, the
 *      manifest buildId, the manifest contentDigest (64-hex) and the runtime
 *      stepIndex after the settle pre-roll;
 *   7. a hard failure (L1–L5) is surfaced as `tl.error` with the phase + the
 *      accepted code (the adapter's `models_*`/`asset_*` codes are reused —
 *      delivery.md (M4) defines no new codes);
 *   8. `tl.play.stop` (or a second start) disposes the host + physics: the
 *      adapter's dispose cancels its in-flight model prepares (L9 — the late
 *      loads are discarded) and the in-flight composition is generation-
 *      fenced so a late `tl.ready`/`tl.error` can never post for a stopped
 *      play.
 *
 * Browser-only (WebGL/DOM/Web Audio/Web Crypto); the in-container half is the
 * Node-verified backend play build (tests/integration/m3-play) — the real
 * browser render walkthrough is the tests/browser suite (packet-38 baseline
 * §1: UNVERIFIED for audio/gamepad/physical display in this container).
 */
import { createPhysicsPort, type RapierPhysicsInitConfig, type RapierPhysicsPort, type RapierStaticColliderSpec } from '@thirdlight/physics-rapier';
import { modelBoundsFromAssetRows, playerCapsuleOf, playerPhysicsOf, resolveSnapshotHierarchy, type RuntimeSnapshot, type GameplaySettings } from '@thirdlight/runtime';
import { sha256HexAsync } from '@thirdlight/project-model';
import {
  bufferResolver,
  createGameHost,
  linkBehaviorModules,
  prepareSceneCatalog,
  type ManifestBehaviorRow,
  type ManifestBufferRow,
  type ManifestSceneRow,
  createGameAudioOwner,
  browserContextFactory,
  type GameHostConfig,
  type GameHost,
  type HostDomNode,
  type FlowConfigLike,
  browserSaveStorage,
} from '@thirdlight/game-host';
import { createSceneAdapter, decodeTexture, environmentHasLook, pageSearch, resolveRendererPreference } from '@thirdlight/three-adapter';
import { createGltfLoaderPort } from '@thirdlight/three-adapter/gltf-loader';
import type { EnvironmentLayerLike, EnvironmentLike, LightingBakeLike, MaterialDefLike, SceneAdapter, SceneAdapterModels, SceneAdapterOptions, WindLike } from '@thirdlight/three-adapter';
import { attachBrowserInput, DEFAULT_INPUT_CONFIG, focusGameSurface, type InputConfigLike } from '@thirdlight/input';
import { Bridge } from './bridge';
import { RelayActionSource } from './relay-input';

/** The runtime-content manifest v2 document (the fields the preview reads). */
export interface PreviewManifestV2 {
  manifestVersion: 2;
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
  assets: Array<{ assetId: string; version: number; path: string; kind: string; sourceDigest: string; sourceByteLength: number }>;
  /** The resolved media identity (delivery.md §2.3): cue slots + one
   * `modelAnimation` row per entity (entityId/assetId/version/profileDigest/
   * roles). */
  media: { cues: Record<string, unknown>; animation: Array<{ entityId: string; assetId: string; version: number; profileDigest: string; roles: Record<string, unknown> }> };
  buildId: string;
}

/** The wrapper's bounded structured error (the §2.7 phase + accepted code). */
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
  /** The verified manifest buildId (from the play handshake). */
  readonly expectedBuildId: string;
  /** The bridge-delivered runtime snapshot (the v3 scene — §17.6). */
  readonly snapshot: RuntimeSnapshot;
  /** The preview-owned canvas the scene adapter renders into. */
  readonly canvas: HTMLCanvasElement;
  /** The HUD root element the host owns (removed on dispose). */
  readonly container: HTMLElement;
  /** Truthful load progress (the bridge's `tl.load.progress`, ≤ 1 KiB). */
  readonly onProgress?: (phase: string, loadedBytes: number, totalBytes: number) => void;
}

export interface M3PreviewHandle {
  readonly host: GameHost;
  /** The exclusive-test input source (bounded input-exercise relays). */
  readonly relay: RelayActionSource;
  /** The render adapter (screenshots, diagnostics), when one was created. */
  readonly adapter: SceneAdapter | null;
  /** The player entity id (for position observations), when a game is played. */
  readonly playerId: string | null;
  /** The verified ready identity (D-63-6): the verified snapshotId + snapshot
   * revision, the manifest buildId + contentDigest (64-hex, bound by the
   * buildId check) and the runtime stepIndex after the settle pre-roll. */
  readonly identity: { snapshotId: string; revision: number; buildId: string; contentDigest: string; stepIndex: number };
  dispose(): void;
}

/** Lowercase hex SHA-256 (Web Crypto when the page has it, pure JS otherwise). */
const sha256Hex = sha256HexAsync;

/** The locator-relative artifact reader (manifest-declared paths only). */
function readPreviewArtifact(contentRoot: string, path: string): Promise<ArrayBuffer> {
  return fetch(`${contentRoot}${path}`, { credentials: 'omit' }).then((res) => {
    if (!res.ok) return Promise.reject(new Error(`artifact read failed for ${path} (HTTP ${String(res.status)})`));
    return res.arrayBuffer();
  });
}

/** Deep structural equality (key-order independent) for the §2.8 step-5 game
 * re-hash against the manifest's hash-bound `game` block. */
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

/** The wrapper's read phase (delivery.md §2.8 step 4, L2): every declared
 * asset path is fetched EXACTLY ONCE (relative to the artifact root) and its
 * bytes re-hashed to the manifest `sourceDigest`. A read failure or a digest
 * mismatch is a L2 hard failure — the adapter never receives unverified
 * bytes. */
async function readDeclaredAssets(
  manifest: PreviewManifestV2,
  contentRoot: string,
  onProgress: (phase: string, loadedBytes: number, totalBytes: number) => void,
): Promise<Map<string, ArrayBuffer>> {
  const bytesByKey = new Map<string, ArrayBuffer>();
  const totalBytes = manifest.assets.reduce((s, a) => s + (a.sourceByteLength ?? 0), 0);
  let loadedBytes = 0;
  for (const row of manifest.assets) {
    const res = await readPreviewArtifact(contentRoot, row.path);
    const raw = new Uint8Array(res);
    if (raw.byteLength !== row.sourceByteLength) {
      throw new PreviewM3Error('asset_source_invalid', 'assets', `${row.assetId}: byte length ${raw.byteLength} !== manifest ${row.sourceByteLength}`);
    }
    const digest = await sha256Hex(raw);
    if (digest !== row.sourceDigest) {
      throw new PreviewM3Error('asset_source_invalid', 'assets', `${row.assetId}: digest ${digest} !== manifest ${row.sourceDigest}`);
    }
    bytesByKey.set(`${row.assetId}@${row.version}`, res);
    loadedBytes += row.sourceByteLength ?? 0;
    onProgress('assets', loadedBytes, totalBytes);
  }
  return bytesByKey;
}

/** The assetIds the snapshot scene references through a `model` component
 * (the v3 shape: `components.model.asset.assetId` — project-model §18.1). */
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
 * The §2.1 `models` block (or null when the scene references no model asset —
 * the adapter then stays byte-stable loader-free, exactly the M1/M2/M3
 * surface). `assets` = the manifest's model-kind rows for the REFERENCED
 * assetIds only (the asset set is the referenced set — delivery.md §2.3);
 * `animation` = the manifest's `media.animation` rows (the resolved media
 * identity, hash-bound through `mediaDigest`); `resolveBytes` = the
 * wrapper-verified byte map (the adapter never re-hashes).
 */
function buildModelsBlock(manifest: PreviewManifestV2, snapshot: RuntimeSnapshot, bytes: Map<string, ArrayBuffer>, contentRoot: string): SceneAdapterModels | null {
  // Phase 12 (c): scenes loaded later may use any model of the build (the
  // manifest's asset list is the closure over every scene).
  const referenced = manifest.scenes !== undefined
    ? new Set(manifest.assets.filter((a) => a.kind === 'model').map((a) => a.assetId))
    : referencedModelAssetIds(snapshot);
  if (referenced.size === 0) return null;
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
    assets: modelRows.map((r) => ({ assetId: r.assetId, version: r.version, sourceDigest: r.sourceDigest, ...((r as { vertexColors?: unknown }).vertexColors === 'tint' ? { vertexColors: 'tint' as const } : {}), ...((r as { materials?: Record<string, string> }).materials !== undefined ? { materials: (r as unknown as { materials: Record<string, string> }).materials } : {}), ...(typeof (r as { clipsFor?: unknown }).clipsFor === 'string' ? { clipsFor: (r as unknown as { clipsFor: string }).clipsFor } : {}) })),
    animation: manifest.media.animation.map((r) => ({ entityId: r.entityId, roles: r.roles as never, version: r.version })),
    // Phase 15.3: the project's idle/run/airborne blend time.
    ...(manifest.settings.animation_crossfade_s !== undefined ? { crossfadeSeconds: manifest.settings.animation_crossfade_s } : {}),
    resolveBytes: (assetId: string, version: number): Promise<ArrayBuffer> => {
      const buf = bytes.get(`${assetId}@${version}`);
      if (buf === undefined) return Promise.reject(new PreviewM3Error('models_asset_unresolved', 'assets', `no wrapper-verified bytes for ${assetId} v${version}`));
      return Promise.resolve(buf);
    },
    ...(manifest.buffers !== undefined
      ? { resolveBuffer: bufferResolver(manifest.buffers, { read: (path) => readPreviewArtifact(contentRoot, path), sha256Hex }) }
      : {}),
  };
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
    if (components['collider'] !== undefined) {
      const collider = components['collider'] as { shape?: unknown; rotationZ?: number; oneWay?: boolean };
      statics.push({
        entityId: entity.id,
        position: { x: position[0] ?? 0, y: position[1] ?? 0 },
        rotationZ: collider.rotationZ ?? 0,
        shape: collider.shape as never,
        // Phase 9.9: movers are kinematic; one-way platforms.
        ...(components['mover'] !== undefined ? { kinematic: true } : {}),
        ...(collider.oneWay === true ? { oneWay: true } : {}),
      });
    }
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

/**
 * Start the M3 preview for one verified capture: read + verify the manifest v2
 * from the locator (WebCrypto `buildId`), verify the bridge-delivered snapshot
 * against `manifest.sceneDigest`/`manifest.gameDigest`, read + verify every
 * declared asset ONCE, then compose + mount the single shared host and AWAIT
 * the models settle (delivery.md §2.8). A failed read/verify/mount/prepare
 * throws a bounded `PreviewM3Error` (the caller surfaces it to the bridge as a
 * structured play error with the §2.7 phase + accepted code).
 */
export async function startM3Preview(cfg: M3PreviewConfig): Promise<M3PreviewHandle> {
  const onProgress = cfg.onProgress ?? (() => undefined);

  // 1. The manifest v2 (buildId-verified via WebCrypto; must also equal the
  //    handshake's expected build). L1 — phase `manifest`.
  const manifestRes = await readPreviewArtifact(cfg.contentRoot, 'manifest.json');
  const manifest = JSON.parse(new TextDecoder().decode(manifestRes)) as PreviewManifestV2;
  if (manifest.manifestVersion !== 2 || manifest.type !== 'thirdlight-runtime-content') {
    throw new PreviewM3Error('play_content_not_ready', 'manifest', 'unsupported manifest document (expected runtime-content v2)');
  }
  const buildIdKeys = [
    'manifestVersion', 'type', 'projectId', 'revision', 'snapshotId', 'capturedAt', 'sceneDigest', 'contentDigest',
    'gameDigest', 'settingsDigest', 'mediaDigest', 'settings', 'game', 'tags', 'materials', 'environment', 'lighting', 'animators', 'prefabs', 'input', 'flow', 'scenes', 'buffers', 'assets', 'media', 'behaviors', 'modules',
    'enginePins', 'recipes', 'toolchain', 'buildOptionsDigest',
  ];
  const preimage: Record<string, unknown> = {};
  for (const k of buildIdKeys) if (k in manifest) preimage[k] = (manifest as unknown as Record<string, unknown>)[k];
  const recomputed = await sha256Hex(new TextEncoder().encode(`${JSON.stringify(preimage, null, 2)}\n`));
  if (recomputed !== manifest.buildId) throw new PreviewM3Error('play_content_not_ready', 'manifest', 'the manifest buildId does not match the verified capture');
  if (manifest.buildId !== cfg.expectedBuildId) throw new PreviewM3Error('play_content_not_ready', 'manifest', 'the manifest buildId does not match the expected build');

  // 2. The bridge-delivered snapshot: verify its scene re-hashes to
  //    manifest.sceneDigest (§17.6) and its `game` re-hashes to
  //    manifest.gameDigest (delivery.md §2.8 step 5 — deep-equal against the
  //    manifest's own hash-bound `game` block: the buildId check already binds
  //    `gameDigest`, so a deep-equal snapshot `game` re-hashes to it).
  // The runtime wants an explicit `game` (null = scene mode).
  const authored: RuntimeSnapshot = { ...cfg.snapshot, game: cfg.snapshot.game ?? null };
  const sceneDigest = await sha256Hex(new TextEncoder().encode(`${JSON.stringify(authored.scene, null, 2)}\n`));
  if (sceneDigest !== manifest.sceneDigest) {
    throw new PreviewM3Error('play_content_not_ready', 'manifest', 'the snapshot scene digest does not match manifest.sceneDigest');
  }
  // No game block = scene mode (the scene plays as authored).
  if (!deepEqual(authored.game ?? null, manifest.game ?? null)) {
    throw new PreviewM3Error('play_content_not_ready', 'manifest', 'the snapshot game does not re-hash to manifest.gameDigest');
  }
  // Phase 12 (b): the tag registry is the manifest's (bound by the buildId).
  if (!deepEqual(authored.tags ?? [], manifest.tags ?? [])) {
    throw new PreviewM3Error('play_content_not_ready', 'manifest', 'the snapshot tags do not match the manifest tags');
  }
  // Phase 12 (c): the scene catalog (start scenes read once for their
  // members; the others load on demand through the host).
  const catalog = manifest.scenes !== undefined
    ? await prepareSceneCatalog(manifest.scenes, { read: (path) => readPreviewArtifact(cfg.contentRoot, path), sha256Hex })
    : null;
  // Phase 12: the scene as the game loads it (folders and inactive entities
  // resolved away) — physics, the renderer and the runtime all use this one.
  // Phase 9.7: the animator controllers come from the verified manifest.
  const withAnimators0 = manifest.animators !== undefined ? ({ ...authored, animators: manifest.animators } as RuntimeSnapshot) : authored;
  // Phase 14.1: the prefabs scripts spawn (from the verified manifest).
  const withAnimators = manifest.prefabs !== undefined ? ({ ...withAnimators0, prefabs: manifest.prefabs } as RuntimeSnapshot) : withAnimators0;
  // Phase 15.3: the model assets' recorded bounds (a pickup without a size collects over its model's).
  const modelBounds = modelBoundsFromAssetRows(manifest.assets as readonly { assetId: string; kind?: string; bounds?: unknown }[]);
  const withBounds = modelBounds !== undefined ? ({ ...withAnimators, modelBounds } as RuntimeSnapshot) : withAnimators;
  const snapshot = resolveSnapshotHierarchy(catalog !== null ? { ...withBounds, scenes: catalog.rows } : withBounds);

  // 3. The wrapper's read phase (L2): every declared asset read ONCE and
  //    re-hashed to its manifest sourceDigest (the adapter never receives
  //    unverified bytes).
  const assetBytes = await readDeclaredAssets(manifest, cfg.contentRoot, onProgress);

  // 4. The single shared production composition (delivery.md §3.2) with the
  //    §2.1 `models` block (or none — the loader-free M1/M2/M3 surface).
  const settings = manifest.settings;
  const models = buildModelsBlock(manifest, snapshot, assetBytes, cfg.contentRoot);
  // Physics runs only for a game (a player controller); a plain scene plays
  // without it.
  const physicsConfig = physicsConfigFromSnapshot(snapshot, settings);
  if (physicsConfig === null && (snapshot.game ?? null) !== null) {
    throw new PreviewM3Error('play_content_not_ready', 'manifest', 'the game requires a player controller entity');
  }
  let physics: RapierPhysicsPort | undefined;
  if (physicsConfig !== null) {
    const init = await createPhysicsPort(physicsConfig);
    if (!init.ok) throw new PreviewM3Error('play_content_not_ready', 'manifest', `physics init failed: ${init.error.code}`);
    physics = init.port;
  }

  // Phase 9.8: the project's input actions (bound by the buildId), else the defaults.
  const browserInput = attachBrowserInput(cfg.canvas, { inputConfig: manifest.input ?? DEFAULT_INPUT_CONFIG });
  focusGameSurface(cfg.canvas);
  const relay = new RelayActionSource(browserInput);
  const input = {
    sample: (stepIndex: number) => relay.sample(stepIndex),
    sampleMenu: () => browserInput.sampleMenu(),
    markConfirmConsumed: () => browserInput.markConfirmConsumed(),
    dispose: () => browserInput.dispose(),
    // Phase 9.10: the game flow's menus and rebinding.
    sampleUi: () => browserInput.sampleUi(),
    captureKey: (cb: (code: string | null) => void) => browserInput.captureKey(cb),
    // Phase 14.5: pad rebinding in the settings.
    capturePadButton: (cb: (button: number | null) => void) => browserInput.capturePadButton(cb),
    configure: (c: InputConfigLike) => browserInput.configure(c),
  };
  // Phase 15.3: the project's sound voice count (absent: 8).
  const audio = createGameAudioOwner({ contextFactory: browserContextFactory() ?? undefined, ...(settings.audio_voices !== undefined ? { maxVoices: settings.audio_voices } : {}) });
  const assetPathsById: Record<string, string> = {};
  for (const asset of manifest.assets) assetPathsById[asset.assetId] = asset.path;

  // The adapter instance the factory creates (the settle + dispose surfaces).
  // A holder object: the factory (host-called inside `mount()`) assigns
  // `current`, which the settle gate below reads after the mount.
  const adapterRef: { current: SceneAdapter | null } = { current: null };
  // The project's compiled behaviors (same-origin modules under the locator).
  const behaviorModules = await linkBehaviorModules(
    (manifest as unknown as { behaviors?: ManifestBehaviorRow[] }).behaviors ?? [],
    (manifest as unknown as { enginePins?: { id: string; version: string; apiVersion: number }[] }).enginePins ?? [],
    (path) => import(/* @vite-ignore */ `${cfg.contentRoot}${path}`),
  );
  const config: GameHostConfig = {
    snapshot,
    settings,
    behaviorModules,
    modules: (manifest as unknown as { modules?: Array<{ id: string }> }).modules?.map((m) => m.id) ?? [],
    ...(physics !== undefined ? { physics } : {}),
    adapter: (runtime) => {
      const a = createSceneAdapter(cfg.canvas, {
        runtime,
        snapshot,
        // Phase 17.1: the play page's ?renderer= flag (the editor passes its own on), else the project's render_backend setting.
        renderer: resolveRendererPreference({ url: pageSearch(), setting: settings.render_backend }),
        ...(models !== null
          ? { models, modelsLoader: createGltfLoaderPort({ decoderBase: '/decoders/' }) }
          : {}),
        ...materialsOptionOf(manifest, assetBytes),
      });
      adapterRef.current = a;
      return a;
    },
    input,
    audio,
    readArtifact: (path) => readPreviewArtifact(cfg.contentRoot, path),
    ...(catalog !== null ? { loadScene: catalog.loadScene } : {}),
    container: cfg.container as unknown as HostDomNode,
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
    ...(browserSaveStorage() !== null ? { saveStorage: browserSaveStorage()!, saveNamespace: `thirdlight-play:${String((snapshot as unknown as { projectId?: string }).projectId ?? 'game')}` } : {}),
    assetKinds: Object.fromEntries(((manifest.assets ?? []) as unknown as { assetId: string; kind: string }[]).map((r) => [r.assetId, r.kind])),
  };
  const host = createGameHost(config);
  // Play has no page gesture wiring of its own: the first key or click in the
  // game frame unlocks sound (music and cues).
  const unlockOnce = (): void => {
    void audio.unlock().catch(() => undefined);
  };
  globalThis.addEventListener?.('pointerdown', unlockOnce, { once: true });
  globalThis.addEventListener?.('keydown', unlockOnce, { once: true });
  const mount = host.mount();
  if (!mount.ok) throw new PreviewM3Error('play_content_not_ready', 'manifest', `host mount failed: ${JSON.stringify(mount.error)}`);

  // 5. The models settle (delivery.md §2.8 step 10): the preview reports
  //    ready ONLY after the prepares settle. A hard failure (L3–L5) is a
  //    `PreviewM3Error` carrying the adapter's accepted code — the host +
  //    physics are disposed so the in-flight/late loads are discarded (L9).
  if (models !== null && adapterRef.current !== null) {
    const settle = await adapterRef.current.modelsSettled?.();
    if (settle === undefined || settle.ok === false) {
      host.dispose();
      physics?.dispose();
      const code = settle?.code ?? 'models_config_invalid';
      throw new PreviewM3Error(code, 'assets', `the model prepare hard-failed (${code}): ${settle?.message ?? 'no settle result'}`);
    }
  }

  // The real ready identity (D-63-6): the verified snapshotId + snapshot
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

  const game = snapshot.game as { playerId?: unknown } | null | undefined;
  return {
    host,
    relay,
    adapter: adapterRef.current,
    playerId: typeof game?.playerId === 'string' ? game.playerId : null,
    identity,
    dispose: () => {
      host.dispose();
      physics?.dispose();
    },
  };
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
 * byte-stable M2 `preview-bootstrap.ts` (delivery.md §3.2; the M2 preview
 * bundle stays unchanged — the M3 wrapper is not inlined into the M2 entry).
 *
 * Browser-only; the in-container-verified half is the Node play build.
 */
export function bootstrapPreviewM3(): void {
  const cfg = (window as { __thirdlightPreview?: PreviewM3PageConfig }).__thirdlightPreview;
  const contentRoot = (window as { __thirdlightContentRoot?: string }).__thirdlightContentRoot ?? '/play-content/';
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

  // Generation fencing (delivery.md §2.6): every `tl.play.stop` / second
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
  // and ACKS with the editor's nonce (D-63-5 repair: the accepted §13.4
  // sequence is handshake → ack → playContent.expect → snapshot; the editor
  // sends the snapshot only after the ack).
  bridge.on('tl.handshake', (m, event) => {
    trustedSource = event.source;
    const bid = (m as Record<string, unknown>).buildId;
    if (typeof bid === 'string') expectedBuildId = bid;
    const nonce = (m as Record<string, unknown>).nonce;
    if (typeof nonce === 'string') bridge.ackHandshake(playId, nonce);
  });

  // The nonce-verified snapshot (the v3 scene — §17.6) drives the composition.
  bridge.on('tl.snapshot', (m) => {
    const snapshot = (m as { snapshot?: RuntimeSnapshot }).snapshot;
    if (snapshot === undefined) return;
    const gen = ++generation;
    // A re-snapshot for the same play disposes the previous composition first
    // (the single active composition — delivery.md §3.2).
    disposePlay();
    void startM3Preview({
      contentRoot,
      expectedBuildId,
      snapshot,
      canvas,
      container,
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
        // settled (delivery.md §2.8 step 10). The real identity tuple
        // (D-63-6): verified snapshotId, snapshot revision, manifest buildId,
        // manifest contentDigest (64-hex), runtime stepIndex after the settle
        // pre-roll.
        const id = h.identity;
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

  bridge.on('tl.input.request', (m) => {
    const body = m as { requestId: string; frames: ReadonlyArray<{ stepOffset: number; moveX: number; jump: string }> };
    if (handle === null) {
      bridge.sendInputResult(playId, body.requestId, notReady);
      return;
    }
    const d = handle.host.runtime.getDiagnostics();
    const firstStep = (d.ok ? d.diagnostics.stepIndex : 0) + 1;
    const accepted = handle.relay.beginTest(body.frames, firstStep, (from, to) => {
      bridge.sendInputResult(playId, body.requestId, { ok: true, appliedFromStep: from, appliedToStep: to });
    });
    if (!accepted) bridge.sendInputResult(playId, body.requestId, { ok: false, error: { code: 'input_relay_conflict', message: 'a relay is already active' } });
  });

  bridge.on('tl.screenshot.request', (m) => {
    const body = m as { relayId: string; maxWidth?: number };
    const shot = handle?.adapter?.captureScreenshot(body.maxWidth ?? 1024);
    if (shot === undefined) bridge.sendScreenshotResult(playId, body.relayId, notReady);
    else if (!shot.ok) bridge.sendScreenshotResult(playId, body.relayId, { ok: false, error: { code: shot.error.code, message: shot.error.message } });
    else bridge.sendScreenshotResult(playId, body.relayId, { ok: true, dataUrl: shot.result.dataUrl, width: shot.result.width, height: shot.result.height });
  });

  bridge.on('tl.diagnostics.request', (m) => {
    const body = m as { relayId: string };
    if (handle === null) {
      bridge.sendDiagnosticsResult(playId, body.relayId, notReady);
      return;
    }
    const rd = handle.host.runtime.getDiagnostics();
    const ad = handle.adapter?.diagnostics();
    bridge.sendDiagnosticsResult(playId, body.relayId, {
      ok: true,
      diagnostics: {
        runtime: rd.ok ? rd.diagnostics : { error: rd.error.code },
        renderer: ad === undefined ? null : ad.ok ? ad.diagnostics : { error: ad.error.code },
        buildId: handle.identity.buildId,
        frameDrops: bridge.drops,
      },
    });
  });

  /** The §20 wire observation (+ the player position), or null without a game. */
  const observation = (h: M3PreviewHandle, entityId?: string): Record<string, unknown> | null => {
    const gv = h.host.runtime.getGameView();
    const obs = h.host.observe();
    if (!gv.ok || !obs.ok) return null;
    const v = gv.view;
    const st = h.host.runtime.getInterpolatedState();
    const tr = st.ok && h.playerId !== null ? st.state.transforms.find((t) => t.id === h.playerId) : undefined;
    return {
      ok: true,
      playSessionId: playId,
      snapshotId: v.snapshotId,
      buildId: h.identity.buildId,
      runId: v.runId,
      revision: h.identity.revision,
      observedAt: new Date().toISOString(),
      stepIndex: v.stepIndex,
      simTime: v.simTime,
      state: v.state,
      checkpointId: v.checkpointId,
      checkpointActive: v.checkpointActive,
      goalReached: v.goalReached,
      failed: obs.observation.failed,
      deathCount: v.deathCount,
      eventCount: v.eventCount,
      eventDropped: v.eventDropped,
      inputMode: h.relay.testActive ? 'test' : 'physical',
      sound: obs.observation.sound,
      events: v.events.slice(-32).map((e) => ({ id: e.id, kind: e.kind, stepIndex: e.stepIndex, boundary: e.boundary, deathCount: e.deathCount })),
      ...(tr !== undefined ? { player: { x: tr.position[0], y: tr.position[1] } } : {}),
      // Phase 12 (c): the loaded scenes and the ones on their way.
      ...(obs.observation.scenes !== undefined ? { scenes: { loaded: [...obs.observation.scenes.loaded], loading: [...obs.observation.scenes.loading] } } : {}),
      // Phase 9.7: each animator's current state (entity id → state name).
      ...animatorStates(h.host.runtime),
      // Phase 9.9: the run's counters and the player's health.
      ...gameCounters(h.host.runtime),
      // Phase 14.1: the live spawned entities (ctx.spawn): how many, the first 64 ids.
      ...spawnedObservation(h.host.runtime),
      // Phase 9.10: the game flow (screen, level, lives, music, volumes).
      ...(obs.observation.flow !== undefined ? { flow: structuredClone(obs.observation.flow) } : {}),
      ...(obs.observation.loops !== undefined ? { loops: { ...obs.observation.loops } } : {}),
      // Phase 14.5: the title background and the camera's offset behind the title menu.
      ...(obs.observation.titleView !== undefined ? { titleView: { scene: obs.observation.titleView.scene, cameraOffset: [...obs.observation.titleView.cameraOffset] } } : {}),
      // Phase 17.1: the renderer backend that draws this play, and why.
      ...rendererObservation(h),
      // Phase 15.4: the requested entity's script property values (public and private), read-only.
      ...(entityId !== undefined ? { behaviors: behaviorValues(h.host.runtime, entityId) } : {}),
    };
  };

  bridge.on('tl.game.observe', (m) => {
    const body = m as { relayId: string; entityId?: string };
    const o = handle === null ? null : observation(handle, body.entityId);
    if (o === null) bridge.sendGameResult('observe', playId, body.relayId, { ok: false, error: { code: 'game_unavailable', message: 'this play has no game session' } });
    else bridge.sendGameResult('observe', playId, body.relayId, { ok: true, result: o });
  });

  bridge.on('tl.game.control', (m) => {
    const body = m as { relayId: string; command: 'start' | 'replay' | 'mute' | 'unmute' | 'loadScene' | 'unloadScene' | 'clearSave'; sceneId?: string };
    if (handle === null) {
      bridge.sendGameResult('control', playId, body.relayId, notReady);
      return;
    }
    // Phase 12 (c): a scene request goes to the runtime like a script's ctx.scenes.
    let r: ReturnType<GameHost['control']>;
    if (body.command === 'loadScene' || body.command === 'unloadScene') {
      const s = handle.host.scene(body.command === 'loadScene' ? 'load' : 'unload', String(body.sceneId ?? ''));
      const view = handle.host.runtime.getGameView();
      r = s.ok ? { ok: true, state: view.ok ? view.view.state : 'awaitingStart', acceptedAtStep: view.ok ? view.view.stepIndex : 0 } : s;
    } else {
      r = handle.host.control(body.command);
    }
    const gv = handle.host.runtime.getGameView();
    if (!r.ok || !gv.ok) {
      const error = r.ok ? { code: 'game_unavailable', message: 'this play has no game session' } : { code: r.error.code, message: r.error.message };
      bridge.sendGameResult('control', playId, body.relayId, { ok: false, error });
      return;
    }
    bridge.sendGameResult('control', playId, body.relayId, {
      ok: true,
      result: {
        ok: true,
        playSessionId: playId,
        snapshotId: gv.view.snapshotId,
        buildId: handle.identity.buildId,
        runId: gv.view.runId,
        command: body.command,
        state: r.state,
        acceptedAtStep: r.acceptedAtStep,
        inputMode: handle.relay.testActive ? 'test' : 'physical',
      },
    });
  });

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
// `game.js` for a v3 play is this bundle — the same role as the M2
// `preview.js`/`preview-bootstrap.ts`).
bootstrapPreviewM3();

/** Phase 9.9: counters (at most 32) and health, for tl_game_observe. */
function gameCounters(runtime: unknown): { counters?: Record<string, number>; health?: { current: number; max: number } } {
  const g = (runtime as { gameCounters?: () => { counters: Record<string, number>; health: { current: number; max: number } | null } }).gameCounters?.();
  if (g === undefined) return {};
  const entries = Object.entries(g.counters).slice(0, 32);
  return { ...(entries.length > 0 ? { counters: Object.fromEntries(entries) } : {}), ...(g.health !== null ? { health: g.health } : {}) };
}

/**
 * Phase 15.4: the property values the running scripts on `entityId` read
 * (public and private; at most 8 scripts, strings clipped to 64 characters so
 * the observation stays inside its 16 KiB bound). Read from the running
 * runtime — the editor never runs game code.
 */
function behaviorValues(runtime: unknown, entityId: string): { entityId: string; scripts: unknown[] } {
  type View = { behaviorId: string; properties: { key: string; label: string; type: string; visibility: string; value: unknown }[] };
  const views = (runtime as { behaviorProperties?: (id: string) => View[] }).behaviorProperties?.(entityId) ?? [];
  const clip = (v: unknown): unknown => (typeof v === 'string' && v.length > 64 ? `${v.slice(0, 63)}…` : Array.isArray(v) ? [...v] : v);
  return {
    entityId,
    scripts: views.slice(0, 8).map((v) => ({
      behaviorId: v.behaviorId,
      properties: v.properties.slice(0, 32).map((p) => ({ key: p.key, label: p.label, type: p.type, visibility: p.visibility, value: clip(p.value) })),
    })),
  };
}

/** Phase 9.7: the current state of every animator (at most 64), for tl_game_observe. */
/** Phase 14.1: the spawned-entity block of an observation (absent without a scene set). */
/** Phase 17.1: the adapter's renderer choice (requested backend and source, what draws, state, reason). */
function rendererObservation(h: M3PreviewHandle): { renderer?: Record<string, unknown> } {
  const d = h.adapter?.diagnostics();
  const r = d !== undefined && d.ok ? d.diagnostics.renderer : undefined;
  return r !== undefined ? { renderer: { ...r } } : {};
}

function spawnedObservation(runtime: unknown): { spawned?: { count: number; ids: string[] } } {
  const set = (runtime as { sceneSet?: () => { spawned?: readonly { id: string }[] } }).sceneSet?.();
  if (set?.spawned === undefined) return {};
  return { spawned: { count: set.spawned.length, ids: set.spawned.slice(0, 64).map((e) => e.id) } };
}

function animatorStates(runtime: unknown): { animators?: Record<string, string> } {
  const poses = (runtime as { animatorPoses?: () => ReadonlyMap<string, { state: string; layers?: readonly { name: string; state: string }[] }> }).animatorPoses?.();
  if (poses === undefined || poses.size === 0) return {};
  // Phase 14.6: override layers follow the base state ("Run | Upper body: Attack").
  const text = (p: { state: string; layers?: readonly { name: string; state: string }[] }): string => [p.state, ...(p.layers ?? []).map((l) => `${l.name}: ${l.state}`)].join(' | ').slice(0, 256);
  return { animators: Object.fromEntries([...poses].slice(0, 64).map(([id, p]) => [id, text(p)])) };
}

/** Phase 9.4: the adapter's materials option from the verified manifest (textures from the verified bytes). */
function materialsOptionOf(manifest: PreviewManifestV2, bytes: Map<string, ArrayBuffer>): { materials?: SceneAdapterOptions['materials']; environment?: SceneAdapterOptions['environment']; lighting?: SceneAdapterOptions['lighting'] } {
  // Phase 14.4: a level with its own look needs the environment renderer (and wind) even when the project has no environment.
  const levelLooks = ((manifest as unknown as { flow?: FlowConfigLike }).flow?.levels ?? []).some((l) => l.environment !== undefined);
  if (manifest.materials === undefined && manifest.environment === undefined && manifest.lighting === undefined && !levelLooks) return {};
  const loadTexture: NonNullable<SceneAdapterOptions['materials']>['loadTexture'] = (assetId) => {
    const row = manifest.assets.find((a) => a.kind === 'texture' && a.assetId === assetId);
    const buf = row !== undefined ? bytes.get(`${row.assetId}@${row.version}`) : undefined;
    return buf !== undefined ? decodeTexture(buf) : Promise.resolve(null);
  };
  const env = manifest.environment;
  return {
    ...(environmentHasLook(env) || levelLooks ? { environment: { value: env ?? {}, loadTexture } } : {}),
    ...(manifest.lighting !== undefined ? { lighting: { bakes: manifest.lighting, loadTexture } } : {}),
    materials: {
      defs: manifest.materials ?? [],
      wind: manifest.environment?.wind ?? null,
      loadTexture,
    },
  };
}
