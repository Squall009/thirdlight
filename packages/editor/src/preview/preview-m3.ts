/**
 * The Play page: a play backed by runtime content, started with the shared
 * game page (`game-host/game-page`, the same composition an exported game
 * runs) and driven by the editor over the bridge.
 *
 * The content/snapshot split:
 *
 * - the **snapshot (v3 scene) arrives only through the checked bridge** — the
 *   nonce-verified `tl.snapshot` message; it must name the manifest's capture
 *   (snapshotId, project, revision) and carry its tags;
 * - the **content arrives only through the locator** — the manifest (its
 *   `buildId` re-derived and equal to the handshake's expected build), the
 *   catalog and the declared files, each checked against its row.
 *
 * What Play gives the game page that an export does not: the locator and
 * cache roots it reads from, the play build's worker and physics scripts, the
 * input exercise relay (tools drive and read the game through it), the test
 * or debug start block, the debug console, and a start that resolves only
 * after the models settle (so `tl.ready` is truthful). A failed start is a
 * bounded `PreviewM3Error` with its load phase and code, sent as `tl.error`;
 * `tl.play.stop` (or a second start) disposes the composition, and a late
 * result of a stopped play is discarded (generation fencing).
 *
 * Browser-only (WebGL/WebGPU, DOM, Web Audio, Web Crypto).
 */
import { PREVIEW_MODULE_SPECS } from './module-specs';
import type { RuntimeSnapshot } from '@thirdlight/runtime';
import { sha256HexAsync } from '@thirdlight/project-model';
import {
  openRuntimeContent,
  type GameHost,
  type GameStartOptions,
  type HostDomNode,
  type SimAccess,
  type StartTimings,
  createStartTimings,
} from '@thirdlight/game-host';
import { GamePageError, startGamePage, type GamePageHandle, type GamePageManifest } from '@thirdlight/game-host/game-page';
import type { SceneAdapter } from '@thirdlight/three-adapter';
import type { InputConfigLike } from '@thirdlight/input';
import { Bridge } from './bridge';
import { answerScreenshot } from './screenshot-answer';
import { resolveRelayFrames, type IncomingRelayFrame } from './relay-frames';

/** Three's Draco and Basis decoders on the preview origin. */
const PREVIEW_DECODER_BASE = '/decoders/';

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

/** The runtime-content manifest (the fields a game page reads). */
export type PreviewManifestV2 = GamePageManifest;

/** The wrapper's bounded structured error (the load phase + accepted code); the game page throws the same class. */
export const PreviewM3Error = GamePageError;
export type PreviewM3Error = GamePageError;

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

export interface M3PreviewHandle extends GamePageHandle {
  /**
   * The simulation's async surface (script values, the debugger,
   * diagnostics, the exclusive input exercise) — the page's runtime in
   * single-thread mode, the worker otherwise.
   */
  readonly access: SimAccess;
  readonly host: GameHost;
  readonly adapter: SceneAdapter | null;
  readonly inputConfig: () => InputConfigLike;
}

/** Lowercase hex SHA-256 (Web Crypto when the page has it, pure JS otherwise). */
const sha256Hex = sha256HexAsync;

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

/**
 * Start Play for one verified capture: read the manifest from the locator
 * (its buildId re-derived and equal to the handshake's), check that the
 * bridge-delivered snapshot names the manifest's capture, then start the
 * shared game page with Play's options (the locator and cache roots, the
 * input exercise relay, the start block, the debug console) and wait for the
 * models to settle. A failed start throws a bounded `PreviewM3Error` (the
 * caller surfaces it to the bridge with the load phase and accepted code).
 */
export async function startM3Preview(cfg: M3PreviewConfig): Promise<M3PreviewHandle> {
  const onProgress = cfg.onProgress ?? (() => undefined);
  const timings = cfg.timings;

  // The manifest (buildId-verified; must also equal the handshake's expected build).
  timings?.begin('manifest');
  const manifestRes = await readArtifactUrl(`${cfg.contentRoot}manifest.json`, 'manifest.json');
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

  // A test/debug start (resolved by the backend) is not part of the runtime snapshot.
  const { start: startBlock, ...bridged } = cfg.snapshot as RuntimeSnapshot & { start?: PlayStartBlock };
  const authored: RuntimeSnapshot = bridged;
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
  const startOptions = startBlock !== undefined ? hostStartOf(startBlock) : undefined;
  const handle = await startGamePage({
    content,
    snapshot: authored,
    read: readDeclared,
    // The worker and the page import each compiled script from the locator (absolute same-origin URLs).
    scriptUrl: (path) => new URL(urlOf(path), location.href).href,
    workerUrl: new URL(`${cfg.buildRoot ?? '/'}${PREVIEW_SIM_WORKER_FILE}`, location.href).href,
    physics3dUrl: new URL(`${cfg.buildRoot ?? '/'}${PREVIEW_PHYSICS_3D_FILE}`, location.href).href,
    decoderBase: PREVIEW_DECODER_BASE,
    moduleSpecs: PREVIEW_MODULE_SPECS,
    canvas: cfg.canvas,
    container: cfg.container as unknown as HostDomNode,
    // This project's saves in Play (an export uses its own namespace).
    saveNamespace: `thirdlight-play:${String(manifest.projectId ?? 'game')}`,
    // Play always has the debug console (the backquote key).
    debugConsole: true,
    // Tools drive and read the game through the input exercise relay.
    relay: true,
    ...(startBlock !== undefined ? { start: { ...(startOptions !== undefined ? { options: startOptions } : {}), ...(startBlock.variables !== undefined ? { variables: startBlock.variables } : {}), ...(startBlock.threads !== undefined ? { threads: startBlock.threads } : {}) } } : {}),
    // Ready only after the models settle; a hard failure fails the start.
    waitForModels: true,
    onProgress,
    ...(timings !== undefined ? { timings } : {}),
  });
  if (handle.access === null) {
    handle.dispose();
    throw new PreviewM3Error('play_content_not_ready', 'manifest', 'the play has no simulation access');
  }
  return handle as M3PreviewHandle;
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
          // The catalog files read so far (what the page has learnt about assets it was not given at the start).
          catalogReads: h.catalogReads(),
          // What is loaded from assets now: resident count and bytes per kind, loads, frees, script handles alive.
          resources: h.resources(),
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
      // What is loaded from assets (resident per kind, loads, frees, script handles alive).
      ...(o.resources !== undefined ? { resources: structuredClone(o.resources) } : {}),
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
