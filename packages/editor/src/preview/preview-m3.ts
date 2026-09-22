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
import { CONTROLLER_CONSTANTS } from '@thirdlight/platformer';
import { createPhysicsPort, type RapierPhysicsInitConfig, type RapierPhysicsPort, type RapierStaticColliderSpec } from '@thirdlight/physics-rapier';
import type { RuntimeSnapshot, GameplaySettings } from '@thirdlight/runtime';
import {
  createGameHost,
  linkBehaviorModules,
  type ManifestBehaviorRow,
  createGameAudioOwner,
  browserContextFactory,
  type GameHostConfig,
  type GameHost,
  type HostDomNode,
} from '@thirdlight/game-host';
import { createSceneAdapter } from '@thirdlight/three-adapter';
import { createGltfLoaderPort } from '@thirdlight/three-adapter/gltf-loader';
import type { SceneAdapter, SceneAdapterModels } from '@thirdlight/three-adapter';
import { attachBrowserInput, focusGameSurface } from '@thirdlight/input';
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

/** Lowercase hex SHA-256 of a byte string via the Web Crypto API. */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  let out = '';
  for (const b of new Uint8Array(digest)) out += b.toString(16).padStart(2, '0');
  return out;
}

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
function buildModelsBlock(manifest: PreviewManifestV2, snapshot: RuntimeSnapshot, bytes: Map<string, ArrayBuffer>): SceneAdapterModels | null {
  const referenced = referencedModelAssetIds(snapshot);
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
    assets: modelRows.map((r) => ({ assetId: r.assetId, version: r.version, sourceDigest: r.sourceDigest })),
    animation: manifest.media.animation.map((r) => ({ entityId: r.entityId, roles: r.roles as never, version: r.version })),
    resolveBytes: (assetId: string, version: number): Promise<ArrayBuffer> => {
      const buf = bytes.get(`${assetId}@${version}`);
      if (buf === undefined) return Promise.reject(new PreviewM3Error('models_asset_unresolved', 'assets', `no wrapper-verified bytes for ${assetId} v${version}`));
      return Promise.resolve(buf);
    },
  };
}

/** The scene-derived Rapier init config (statics + the player controller) with
 * the manifest's resolved `gravity_y` as the solver gravity. */
function physicsConfigFromSnapshot(snapshot: RuntimeSnapshot, settings: GameplaySettings): RapierPhysicsInitConfig | null {
  const statics: RapierStaticColliderSpec[] = [];
  let character: RapierPhysicsInitConfig['character'] | null = null;
  for (const entity of snapshot.scene.entities) {
    const components = (entity.components ?? {}) as unknown as Record<string, unknown>;
    const transform = components['transform'] as { position?: number[]; rotation?: number[]; scale?: number[] } | undefined;
    const position = transform?.position ?? [0, 0, 0];
    if (components['collider'] !== undefined) {
      const collider = components['collider'] as { shape?: unknown; rotationZ?: number };
      statics.push({
        entityId: entity.id,
        position: { x: position[0] ?? 0, y: position[1] ?? 0 },
        rotationZ: collider.rotationZ ?? 0,
        shape: collider.shape as never,
      });
    }
    if (components['controller'] !== undefined) {
      character = {
        x: position[0] ?? 0,
        y: position[1] ?? 0,
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
    solver: { hz: 120, gravityY: settings.gravity_y },
    controller: {
      offsetSkin: CONTROLLER_CONSTANTS.offsetSkin,
      groundSnap: CONTROLLER_CONSTANTS.groundSnap,
      maxSlopeClimbRad: (settings.max_slope_climb_deg * Math.PI) / 180,
      minSlopeSlideRad: (settings.min_slope_slide_deg * Math.PI) / 180,
      autostep: false,
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
    'gameDigest', 'settingsDigest', 'mediaDigest', 'settings', 'game', 'assets', 'media', 'behaviors', 'modules',
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
  const snapshot: RuntimeSnapshot = { ...cfg.snapshot, game: cfg.snapshot.game ?? null };
  const sceneDigest = await sha256Hex(new TextEncoder().encode(`${JSON.stringify(snapshot.scene, null, 2)}\n`));
  if (sceneDigest !== manifest.sceneDigest) {
    throw new PreviewM3Error('play_content_not_ready', 'manifest', 'the snapshot scene digest does not match manifest.sceneDigest');
  }
  // No game block = scene mode (the scene plays as authored).
  if (!deepEqual(snapshot.game ?? null, manifest.game ?? null)) {
    throw new PreviewM3Error('play_content_not_ready', 'manifest', 'the snapshot game does not re-hash to manifest.gameDigest');
  }

  // 3. The wrapper's read phase (L2): every declared asset read ONCE and
  //    re-hashed to its manifest sourceDigest (the adapter never receives
  //    unverified bytes).
  const assetBytes = await readDeclaredAssets(manifest, cfg.contentRoot, onProgress);

  // 4. The single shared production composition (delivery.md §3.2) with the
  //    §2.1 `models` block (or none — the loader-free M1/M2/M3 surface).
  const settings = manifest.settings;
  const models = buildModelsBlock(manifest, snapshot, assetBytes);
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

  const browserInput = attachBrowserInput(cfg.canvas, {});
  focusGameSurface(cfg.canvas);
  const relay = new RelayActionSource(browserInput);
  const input = {
    sample: (stepIndex: number) => relay.sample(stepIndex),
    sampleMenu: () => browserInput.sampleMenu(),
    markConfirmConsumed: () => browserInput.markConfirmConsumed(),
    dispose: () => browserInput.dispose(),
  };
  const audio = createGameAudioOwner({ contextFactory: browserContextFactory() ?? undefined });
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
    ...(physics !== undefined ? { physics } : {}),
    adapter: (runtime) => {
      const a = createSceneAdapter(cfg.canvas, {
        runtime,
        snapshot,
        ...(models !== null
          ? { models, modelsLoader: createGltfLoaderPort() }
          : {}),
      });
      adapterRef.current = a;
      return a;
    },
    input,
    audio,
    readArtifact: (path) => readPreviewArtifact(cfg.contentRoot, path),
    container: cfg.container as unknown as HostDomNode,
    buildId: manifest.buildId,
    assetPaths: assetPathsById,
  };
  const host = createGameHost(config);
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
  canvas.style.cssText = 'width:100vw;height:100vh;display:block;background:#0e1015;';
  document.body.style.margin = '0';
  document.body.appendChild(canvas);
  const container = document.createElement('div');
  container.id = 'tl-hud-root';
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
  const observation = (h: M3PreviewHandle): Record<string, unknown> | null => {
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
    };
  };

  bridge.on('tl.game.observe', (m) => {
    const body = m as { relayId: string };
    const o = handle === null ? null : observation(handle);
    if (o === null) bridge.sendGameResult('observe', playId, body.relayId, { ok: false, error: { code: 'game_unavailable', message: 'this play has no game session' } });
    else bridge.sendGameResult('observe', playId, body.relayId, { ok: true, result: o });
  });

  bridge.on('tl.game.control', (m) => {
    const body = m as { relayId: string; command: 'start' | 'replay' | 'mute' | 'unmute' };
    if (handle === null) {
      bridge.sendGameResult('control', playId, body.relayId, notReady);
      return;
    }
    const r = handle.host.control(body.command);
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