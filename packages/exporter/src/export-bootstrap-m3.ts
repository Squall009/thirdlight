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
import { sha256HexAsync } from '@thirdlight/project-model';
import { attachBrowserInput, DEFAULT_INPUT_CONFIG, focusGameSurface, type InputConfigLike } from '@thirdlight/input';
import { CONTROLLER_CONSTANTS } from '@thirdlight/platformer';
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
} from '@thirdlight/game-host';
import { createSceneAdapter, decodeTexture, environmentHasLook } from '@thirdlight/three-adapter';
import { createGltfLoaderPort } from '@thirdlight/three-adapter/gltf-loader';
import type { EnvironmentLayerLike, EnvironmentLike, LightingBakeLike, MaterialDefLike, SceneAdapter, SceneAdapterModels, WindLike } from '@thirdlight/three-adapter';
import { resolveSnapshotHierarchy, type GameplaySettings, type RuntimeSnapshot } from '@thirdlight/runtime';
import { assetPaths, readAsset } from 'thirdlight:export-artifacts';

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
  environment?: EnvironmentLike & { wind?: WindLike };
  /** Phase 9.6: the scenes' bakes. */
  lighting?: Record<string, LightingBakeLike>;
  /** Phase 9.7: the animator controllers. */
  animators?: unknown[];
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
    'gameDigest', 'settingsDigest', 'mediaDigest', 'settings', 'game', 'tags', 'materials', 'environment', 'lighting', 'animators', 'input', 'flow', 'scenes', 'buffers', 'assets', 'media', 'behaviors', 'modules',
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
  const assetBytesByKey = new Map<string, ArrayBuffer>();
  for (const row of manifest.assets ?? []) {
    const buf = await readArtifactBytes(row.path);
    const raw = new Uint8Array(buf);
    if (raw.byteLength !== row.sourceByteLength) throw new Error(`${row.assetId}: byte length ${raw.byteLength} !== manifest ${row.sourceByteLength}`);
    if ((await sha256Hex(raw)) !== row.sourceDigest) throw new Error(`${row.assetId}: digest mismatch against the manifest sourceDigest`);
    assetBytesByKey.set(`${row.assetId}@${row.version}`, buf);
  }

  const settings = manifest.settings;
  // Phase 12 (c): the scene catalog (start scenes read once for their
  // members; the others load on demand through the host).
  const io = { read: readArtifactBytes, sha256Hex };
  const catalog = manifest.scenes !== undefined ? await prepareSceneCatalog(manifest.scenes, io) : null;
  // Phase 12: the scene as the game loads it (folders and inactive entities
  // resolved away) — physics, the renderer and the runtime all use this one.
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
      assets: modelRows.map((r) => ({ assetId: r.assetId, version: r.version, sourceDigest: r.sourceDigest, ...((r as { vertexColors?: unknown }).vertexColors === 'tint' ? { vertexColors: 'tint' as const } : {}), ...((r as { materials?: Record<string, string> }).materials !== undefined ? { materials: (r as unknown as { materials: Record<string, string> }).materials } : {}) })),
      animation: (manifest.media?.animation ?? []).map((r) => ({ entityId: r.entityId, roles: r.roles as never, version: r.version })),
      resolveBytes: (assetId: string, version: number): Promise<ArrayBuffer> => {
        const buf = assetBytesByKey.get(`${assetId}@${version}`);
        if (buf === undefined) return Promise.reject(new Error(`no wrapper-verified bytes for ${assetId} v${version}`));
        return Promise.resolve(buf);
      },
      ...(manifest.buffers !== undefined ? { resolveBuffer: bufferResolver(manifest.buffers, io) } : {}),
    };
  }

  // The injected physics port (physics-rapier; the manifest's resolved
  // gravity_y drives the solver).
  const physicsConfig = physicsConfigFromSnapshot(snapshot, settings);
  let physics;
  if (physicsConfig !== null) {
    const init = await createPhysicsPort(physicsConfig);
    if (!init.ok) throw new Error(`physics init failed: ${init.error.code}`);
    physics = init.port;
  } else if (snapshot.game !== null) {
    throw new Error('the game requires a player controller entity');
  }
  // (no game block and no controller: scene mode — the scene plays as authored)

  // Phase 9.8: the project's input actions (bound by the buildId), else the defaults.
  const input = attachBrowserInput(canvas, { inputConfig: manifest.input ?? DEFAULT_INPUT_CONFIG });
  focusGameSurface(canvas);
  const audio = createGameAudioOwner({ contextFactory: browserContextFactory() ?? undefined });
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
  const behaviorModules = await linkBehaviorModules(
    (manifest as unknown as { behaviors?: ManifestBehaviorRow[] }).behaviors ?? [],
    (manifest as unknown as { enginePins?: { id: string; version: string; apiVersion: number }[] }).enginePins ?? [],
    (path) => import(/* @vite-ignore */ new URL(path, document.baseURI).href),
  );
  // Phase 14.4: a level with its own look needs the environment renderer (and wind) even when the project has no environment.
  const levelLooks = ((manifest as unknown as { flow?: FlowConfigLike }).flow?.levels ?? []).some((l) => l.environment !== undefined);
  const config: GameHostConfig = {
    snapshot,
    settings,
    behaviorModules,
    modules: (manifest as unknown as { modules?: Array<{ id: string }> }).modules?.map((m) => m.id) ?? [],
    ...(physics !== undefined ? { physics } : {}),
    adapter: (runtime) => {
      const a = createSceneAdapter(canvas, {
        runtime,
        snapshot,
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
        // Phase 9.4: project materials and wind (textures from the verified bytes).
        ...(manifest.materials !== undefined || manifest.environment !== undefined || levelLooks
          ? {
              materials: {
                defs: manifest.materials ?? [],
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
    // Phase 9.11: saves in this browser's localStorage (Play and exported games keep separate ones).
    ...(browserSaveStorage() !== null ? { saveStorage: browserSaveStorage()!, saveNamespace: `thirdlight:${String((snapshot as unknown as { projectId?: string }).projectId ?? 'game')}` } : {}),
    assetKinds: Object.fromEntries(((manifest.assets ?? []) as unknown as { assetId: string; kind: string }[]).map((r) => [r.assetId, r.kind])),
  };
  const host = createGameHost(config);
  const mount = host.mount();
  if (!mount.ok) throw new Error(`host mount failed: ${JSON.stringify(mount.error)}`);

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