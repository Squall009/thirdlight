/**
 * SPIKE 22.2 (archived, not built or tested): the export page bootstrap
 * (a copy of packages/exporter/src/export-bootstrap-m3.ts at main 8818453)
 * with an optional render worker.
 *
 *   ?render=worker (the spike's default) — the canvas is transferred to
 *     js/render-worker.js (`transferControlToOffscreen`), which draws with the
 *     same scene adapter from the simulation worker's frames (a MessageChannel
 *     between the two workers; see sim-worker.ts). The page keeps input,
 *     audio, HUD, menus, the flow and saves; the host's adapter is a stub that
 *     forwards quality, level look and camera offset. `&renderPace=coalesce|raf|message`
 *     picks when the worker draws (see render-worker.ts; coalesce is the default).
 *   ?render=main — the product composition (plus the same probes).
 *
 * The render worker needs the simulation worker (it reads its frames), an
 * OffscreenCanvas with `transferControlToOffscreen` and `Worker`; otherwise the
 * page renders (render=main). The simulation's shared-memory transport was not
 * adapted (its two-slot buffer assumes one reader one frame behind): the spike
 * was measured with messages, as exports run by default.
 *
 * Probes (window.__spike): the drawn frames with the player's drawn x (main
 * mode; the worker keeps its own), key-down times (event.timeStamp as epoch),
 * and per host frame the time from the simulation posting the frame to the
 * page taking its audio requests (the audio request latency).
 */
import { sha256HexAsync } from '@thirdlight/project-model';
import { attachBrowserInput, DEFAULT_INPUT_CONFIG, focusGameSurface, type InputConfigLike } from '@thirdlight/input';
import { createPhysicsPort, type RapierPhysicsInitConfig, type RapierStaticColliderSpec } from '@thirdlight/physics-rapier';
import {
  browserContextFactory,
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
  resolveThreadingMode,
  resolveTransport,
  startRemoteSimulation,
  threadingLogLine,
  type RemoteSimulation,
} from '@thirdlight/game-host';
import { batchingFromUrl, createSceneAdapter, pageSearch, resolveRendererPreference } from '@thirdlight/three-adapter';
import type { EnvironmentLayerLike, SceneAdapter } from '@thirdlight/three-adapter';
import { modelBoundsFromAssetRows, playerCapsuleOf, playerPhysicsOf, resolveSnapshotHierarchy, type GameplaySettings, type RuntimeSnapshot } from '@thirdlight/runtime';
import { readAsset } from './artifacts';
import { adapterOptions, modelsBlock, type ExportManifestV2 } from './adapter-options';

/** Phase 22.0: the simulation worker's bundle, next to this one (relative to the page). */
const EXPORT_SIM_WORKER_PATH = './js/sim-worker.js';

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

// ---- SPIKE probes ----------------------------------------------------------------
const epochNow = (): number => performance.timeOrigin + performance.now();
const spike = {
  mode: 'main' as 'main' | 'worker',
  lastSimT: 0,
  frames: [] as { t: number; x: number | null; simT: number }[],
  audio: [] as number[],
  keys: [] as { code: string; t: number }[],
};
(window as unknown as { __spike: typeof spike }).__spike = spike;
function pushRing<T>(arr: T[], v: T): void {
  arr.push(v);
  if (arr.length > 4000) arr.splice(0, 2000);
}
// The key's own time stamp (when the browser received it), so a busy main thread counts against it.
window.addEventListener('keydown', (e) => {
  if (!e.repeat) pushRing(spike.keys, { code: e.code, t: performance.timeOrigin + e.timeStamp });
}, { capture: true });

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
  if (referenced.size > 0) {
    const modelRows = (manifest.assets ?? []).filter((a) => a.kind === 'model' && referenced.has(a.assetId));
    if (modelRows.length !== referenced.size) {
      const missing = [...referenced].filter((id) => !modelRows.some((r) => r.assetId === id));
      throw new Error(`the scene references model asset(s) absent from the manifest: ${missing.join(', ')}`);
    }
  }
  // SPIKE: the adapter's inputs, the same for the page and the render worker.
  const rendererChoice = resolveRendererPreference({ url: pageSearch(), setting: settings.render_backend });
  const adapterInputs = {
    manifest,
    snapshot,
    referenced: [...referenced],
    bytes: assetBytesByKey,
    renderer: rendererChoice,
    batching: batchingFromUrl(pageSearch()),
    decoderBase: './decoders/',
    io,
  };

  // The physics config (physics-rapier; the manifest's resolved gravity_y drives the solver).
  const physicsConfig = physicsConfigFromSnapshot(snapshot, settings);
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
  // SPIKE: where the game is drawn.
  const renderParam = new URLSearchParams(pageSearch()).get('render');
  const offscreenOk = typeof (canvas as { transferControlToOffscreen?: unknown }).transferControlToOffscreen === 'function' && typeof Worker === 'function';
  const renderWanted = renderParam !== 'main' && offscreenOk;
  let simToRender: MessageChannel | null = null;
  if (threadMode === 'worker') {
    const rawWorker = createBrowserSimWorker(new URL(EXPORT_SIM_WORKER_PATH, document.baseURI).href);
    // SPIKE: note when each frame left the simulation (the audio latency probe), and hand the
    // simulation worker its end of the channel to the render worker before `init`.
    const worker: typeof rawWorker = rawWorker === null ? null : {
      ...rawWorker,
      listen: (onMessage) => rawWorker.listen((m) => {
        const st = (m as { t?: string; state?: { spikeT?: number } }).state;
        if (st?.spikeT !== undefined) spike.lastSimT = st.spikeT;
        onMessage(m);
      }),
    };
    if (worker !== null && renderWanted) {
      simToRender = new MessageChannel();
      worker.post({ t: 'spike.renderPort', port: simToRender.port1 }, [simToRender.port1]);
    }
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
  const renderMode: 'worker' | 'main' = renderWanted && remote !== null && simToRender !== null ? 'worker' : 'main';
  const renderReason = renderMode === 'worker' ? 'render worker on an OffscreenCanvas (the spike default)' : renderParam === 'main' ? '?render=main' : !offscreenOk ? 'no OffscreenCanvas/Worker: the page renders' : 'the simulation runs in the page: the page renders';
  console.info(`[thirdlight] spike 22.2 render: ${renderMode} (${renderReason})`);
  (window as unknown as { __thirdlightThreading?: unknown }).__thirdlightThreading = { mode: threadMode, reason: threadReason, transport: remote?.transport ?? null, isolated, render: renderMode, renderReason };
  spike.mode = renderMode;

  // SPIKE: the audio request latency probe — per host frame, the simulation's post -> the page taking its audio requests.
  if (remote !== null) {
    const rt = remote.runtime as { takeAudioRequests?: () => unknown[] };
    const take = rt.takeAudioRequests;
    if (take !== undefined) {
      rt.takeAudioRequests = () => {
        if (spike.lastSimT > 0) pushRing(spike.audio, epochNow() - spike.lastSimT);
        return take.call(rt);
      };
    }
  }

  // SPIKE: the render worker (the canvas goes to it; input keeps listening on the page's element).
  let renderWorker: Worker | null = null;
  if (renderMode === 'worker') {
    renderWorker = new Worker(new URL('./js/render-worker.js', document.baseURI).href, { name: 'thirdlight-render' });
    renderWorker.addEventListener('error', (e) => console.error(`[thirdlight] render worker error: ${e.message}`));
    renderWorker.addEventListener('message', (e) => {
      const m = e.data as { t?: string; settle?: { ok: boolean; code?: string } };
      if (m.t === 'modelsSettled' && m.settle !== undefined && !m.settle.ok) hud(`export error: the model prepare hard-failed (${m.settle.code ?? 'models_config_invalid'}) in the render worker`, true);
    });
    const offscreen = (canvas as unknown as { transferControlToOffscreen(): OffscreenCanvas }).transferControlToOffscreen();
    const bytes = [...assetBytesByKey.entries()];
    renderWorker.postMessage(
      {
        t: 'init',
        canvas: offscreen,
        width: canvas.clientWidth,
        height: canvas.clientHeight,
        manifest,
        snapshot,
        referenced: [...referenced],
        bytes,
        renderer: rendererChoice,
        batching: adapterInputs.batching,
        baseUrl: document.baseURI,
        playerId: (snapshot.game as { playerId?: string } | null)?.playerId ?? null,
        port: simToRender!.port2,
        perf: (window as unknown as { __tlPerf?: unknown }).__tlPerf !== undefined,
        pace: ((v) => (v === 'raf' || v === 'message' ? v : 'coalesce'))(new URLSearchParams(pageSearch()).get('renderPace')),
      },
      // The page has no use for the model/texture bytes once they are verified: move them.
      [offscreen, simToRender!.port2, ...new Set(bytes.map(([, b]) => b))],
    );
    const rw = renderWorker;
    new ResizeObserver(() => rw.postMessage({ t: 'resize', width: canvas.clientWidth, height: canvas.clientHeight })).observe(canvas);
  } else {
    // Nothing will read the render channel.
    simToRender?.port2.close();
  }

  // The injected physics port in single-thread mode (in worker mode the worker has its own).
  let physics;
  if (remote === null && physicsConfig !== null) {
    const init = await createPhysicsPort(physicsConfig);
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
  const config: GameHostConfig = {
    snapshot,
    settings,
    behaviorModules,
    modules: moduleIds,
    ...(physics !== undefined ? { physics } : {}),
    ...(remote !== null ? { runtimeFactory: remote.runtimeFactory } : {}),
    adapter: (runtime) => {
      if (renderWorker !== null) {
        const rw = renderWorker;
        // SPIKE: the host's adapter is a stub; the render worker draws from the simulation's frames.
        return {
          renderFrame: () => ({ ok: true as const }),
          dispose: () => {
            rw.postMessage({ t: 'dispose' });
            setTimeout(() => rw.terminate(), 500);
            return { ok: true };
          },
        };
      }
      const a = createSceneAdapter(canvas, adapterOptions(adapterInputs, runtime, modelsBlock(adapterInputs)));
      // SPIKE: the drawn-frame probe (the same record the render worker keeps).
      const playerId = (snapshot.game as { playerId?: string } | null)?.playerId ?? null;
      const p = [0, 0, 0];
      const r = [0, 0, 0, 1];
      const sc = [1, 1, 1];
      const render = a.renderFrame.bind(a);
      a.renderFrame = () => {
        const res = render();
        const x = playerId !== null && runtime.readInterpolated?.(playerId, p, r, sc) === true ? p[0]! : null;
        pushRing(spike.frames, { t: epochNow(), x, simT: spike.lastSimT });
        return res;
      };
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
    setQuality: (level) => (renderWorker !== null ? renderWorker.postMessage({ t: 'quality', level }) : adapterRef.current?.setQuality?.(level)),
    setLevelEnvironment: (environment) => (renderWorker !== null ? renderWorker.postMessage({ t: 'environment', layer: environment }) : adapterRef.current?.setEnvironmentLayer?.(environment as EnvironmentLayerLike | null)),
    // Phase 14.5: the title screen's background scene and camera pan.
    setCameraOffset: (offset) => (renderWorker !== null ? renderWorker.postMessage({ t: 'cameraOffset', offset }) : adapterRef.current?.setCameraOffset?.(offset)),
    // Phase 9.11: saves in this browser's localStorage (Play and exported games keep separate ones).
    ...(browserSaveStorage() !== null ? { saveStorage: browserSaveStorage()!, saveNamespace: `thirdlight:${String((snapshot as unknown as { projectId?: string }).projectId ?? 'game')}` } : {}),
    assetKinds: Object.fromEntries(((manifest.assets ?? []) as unknown as { assetId: string; kind: string }[]).map((r) => [r.assetId, r.kind])),
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
  if (referenced.size > 0 && adapterRef.current !== null) {
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