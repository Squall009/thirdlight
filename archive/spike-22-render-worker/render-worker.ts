/**
 * SPIKE 22.2 (archived, not built or tested): the exported game's renderer in
 * a dedicated worker on an OffscreenCanvas (`transferControlToOffscreen`).
 *
 * - The page sends `init` once: the OffscreenCanvas, the manifest, the resolved
 *   snapshot, the verified asset bytes, the renderer choice (WebGPU or WebGL 2 —
 *   the same `createSceneAdapter` and renderer factory as the page), its size,
 *   and port 2 of a MessageChannel whose port 1 went to the simulation worker.
 * - The simulation worker tees its per-frame state to that port (see
 *   sim-worker.ts): this worker keeps its own `FrameMirror` (the game host's
 *   page-side mirror) and hands the adapter a `Runtime`-shaped view of it, as
 *   the page's mirror does for the page adapter. Every frame is applied (the
 *   transforms may be deltas); the newest state is drawn in a zero-delay task
 *   after the frames already queued (`?renderPace=coalesce`, the default).
 *   Measured alternatives: `?renderPace=message` draws every frame as it
 *   arrives, like the page host — but the page, no longer held up by drawing,
 *   ticks the simulation every animation frame, so frames pile up behind the
 *   slow draws (11.8–41 s behind on the medium benchmark); `?renderPace=raf`
 *   draws on this worker's animation frame (up to ~1 s behind here).
 * - Presentation-only calls the page's host makes (quality, the level look,
 *   the title camera offset) and resizes arrive as messages.
 * - Input, audio, HUD, menus and the game flow stay on the page.
 *
 * Probes (for tools in this folder): `self.__spikeFrames` — per drawn frame the
 * epoch time after the draw, the player's drawn x, and the `spikeT` stamp of
 * the simulation frame drawn; with `init.perf` the phase 21 harness
 * instrumentation (tools/perf/instrument.ts) is installed in this worker.
 */
import { FrameMirror } from '../../packages/game-host/src/sim-state';
import { TRANSFORM_STRIDE } from '@thirdlight/game-host';
import { sha256HexAsync } from '@thirdlight/project-model';
import { createSceneAdapter, type SceneAdapter } from '@thirdlight/three-adapter';
import type { Runtime, RuntimeSnapshot, SceneSetView } from '@thirdlight/runtime';
import { installPerfInstrumentation } from '../../tools/perf/instrument';
import { adapterOptions, modelsBlock, type ExportManifestV2 } from './adapter-options';

interface InitMessage {
  t: 'init';
  canvas: OffscreenCanvas;
  width: number;
  height: number;
  manifest: ExportManifestV2;
  snapshot: RuntimeSnapshot;
  referenced: string[];
  bytes: [string, ArrayBuffer][];
  renderer: { preference: string; source: string };
  batching: boolean;
  baseUrl: string;
  playerId: string | null;
  port: MessagePort;
  perf: boolean;
  pace: 'raf' | 'message' | 'coalesce';
}

type PageMessage =
  | InitMessage
  | { t: 'quality'; level: string }
  | { t: 'environment'; layer: unknown }
  | { t: 'cameraOffset'; offset: [number, number, number] | null }
  | { t: 'resize'; width: number; height: number }
  | { t: 'dispose' };

const scope = self as unknown as {
  postMessage(m: unknown): void;
  addEventListener(t: 'message', l: (e: MessageEvent) => void): void;
  requestAnimationFrame(cb: (t: number) => void): number;
  __spikeFrames: { t: number; x: number | null; simT: number; seq: number }[];
  __spikeInfo: Record<string, unknown>;
};
scope.__spikeFrames = [];
scope.__spikeInfo = {};
const epochNow = (): number => performance.timeOrigin + performance.now();

const mirror = new FrameMirror();
let lastSimT = 0;
let ready = false;
let init: InitMessage | null = null;
let adapter: SceneAdapter | null = null;
let scheduled = false;
let disposed = false;
const pending: PageMessage[] = [];

// ---- the Runtime-shaped view the adapter reads (the page mirror's read side) ----
const position = [0, 0, 0];
const rotation = [0, 0, 0, 1];
const scale = [1, 1, 1];
const readAt = (i: number): void => {
  const o = i * TRANSFORM_STRIDE;
  const x = mirror.xf;
  position[0] = x[o]!; position[1] = x[o + 1]!; position[2] = x[o + 2]!;
  rotation[0] = x[o + 3]!; rotation[1] = x[o + 4]!; rotation[2] = x[o + 5]!; rotation[3] = x[o + 6]!;
  scale[0] = x[o + 7]!; scale[1] = x[o + 8]!; scale[2] = x[o + 9]!;
};
const emptySet = Object.freeze({ revision: 0, batches: Object.freeze([]), status: Object.freeze({}), spawned: Object.freeze([]) }) as unknown as SceneSetView;
const view = {
  forEachInterpolated(visit: (id: string, p: number[], r: number[], s: number[]) => void): boolean {
    if (disposed) return false;
    const n = Math.min(mirror.ids.length, Math.floor(mirror.xf.length / TRANSFORM_STRIDE));
    for (let i = 0; i < n; i += 1) {
      readAt(i);
      visit(mirror.ids[i]!, position, rotation, scale);
    }
    return true;
  },
  readInterpolated(id: string, p: number[], r: number[], s: number[]): boolean {
    const i = mirror.index.get(id);
    if (i === undefined || (i + 1) * TRANSFORM_STRIDE > mirror.xf.length) return false;
    readAt(i);
    for (let k = 0; k < 3; k += 1) p[k] = position[k]!;
    for (let k = 0; k < 4; k += 1) r[k] = rotation[k]!;
    for (let k = 0; k < 3; k += 1) s[k] = scale[k]!;
    return true;
  },
  getInterpolatedState() {
    const transforms = [];
    for (let i = 0; i < mirror.ids.length; i += 1) {
      readAt(i);
      transforms.push({ id: mirror.ids[i]!, position: [...position], rotation: [...rotation], scale: [...scale] });
    }
    return { ok: true, state: { stepIndex: mirror.stepIndex, simTime: mirror.simTime, alpha: mirror.alpha, transforms } };
  },
  hiddenEntities: () => mirror.hidden,
  entityOpacity: () => mirror.opacity,
  animatorPoses: () => mirror.poses,
  takeEffectRequests: () => {
    const out = mirror.effects;
    mirror.effects = [];
    return out;
  },
  get isPaused() {
    return mirror.paused;
  },
  get interpolationAlpha() {
    return mirror.alpha;
  },
  getGameView: () => (mirror.view !== null ? { ok: true, view: mirror.view } : { ok: false, error: { code: 'game_session_unavailable', message: 'no game session' } }),
  peekGameView: () => mirror.view,
  sceneSet: () => mirror.sceneSet ?? emptySet,
  getDiagnostics: () => ({ ok: true, diagnostics: { state: mirror.state, stepIndex: mirror.stepIndex, simTime: mirror.simTime, frameCount: mirror.frameCount, errors: [], errorCount: 0 } }),
};
const runtime = view as unknown as Runtime;

const probe = [0, 0, 0];
const probeR = [0, 0, 0, 1];
const probeS = [1, 1, 1];
const draw = (): void => {
  scheduled = false;
  if (disposed || adapter === null) return;
  const res = adapter.renderFrame();
  if (!res.ok && scope.__spikeInfo['renderError'] === undefined) scope.__spikeInfo['renderError'] = JSON.stringify(res.error).slice(0, 300);
  const pid = init?.playerId ?? null;
  const x = pid !== null && view.readInterpolated(pid, probe, probeR, probeS) ? probe[0]! : null;
  const frames = scope.__spikeFrames;
  frames.push({ t: epochNow(), x, simT: lastSimT, seq: mirror.seq });
  if (frames.length > 4000) frames.splice(0, 2000);
};
const schedule = (): void => {
  if (scheduled || disposed || adapter === null) return;
  scheduled = true;
  // pace 'message': draw as the frame arrives (like the page host does); 'raf': on this worker's animation
  // frame; 'coalesce': in a zero-delay task, which runs after the frames already queued (the scheduler
  // takes the oldest task first), so a slow draw only ever draws the newest state.
  if (init?.pace === 'raf') scope.requestAnimationFrame(draw);
  else if (init?.pace === 'message') draw();
  else setTimeout(draw, 0);
};

const onSimMessage = (e: MessageEvent): void => {
  const m = e.data as { t?: string; state?: Parameters<FrameMirror['apply']>[0] & { spikeT?: number } };
  if ((m.t !== 'frame' && m.t !== 'ready') || m.state === undefined) return;
  mirror.apply(m.state);
  // Nothing to hand back (the simulation's buffer pool is fed by the page) and no audio here.
  mirror.spare = null;
  mirror.audio.length = 0;
  lastSimT = m.state.spikeT ?? 0;
  if (m.t === 'ready') ready = true;
  if (adapter === null) compose();
  schedule();
};

const compose = (): void => {
  if (adapter !== null || init === null || !ready || disposed) return;
  const i = init;
  const canvas = i.canvas as unknown as { clientWidth?: number; clientHeight?: number };
  // The adapter sizes the drawing buffer from clientWidth/Height (else width/height): the page's CSS size.
  Object.defineProperty(canvas, 'clientWidth', { configurable: true, writable: true, value: i.width });
  Object.defineProperty(canvas, 'clientHeight', { configurable: true, writable: true, value: i.height });
  const bytes = new Map(i.bytes);
  const inputs = {
    manifest: i.manifest,
    snapshot: i.snapshot,
    referenced: i.referenced,
    bytes,
    renderer: i.renderer,
    batching: i.batching,
    decoderBase: new URL('./decoders/', i.baseUrl).href,
    io: {
      read: async (path: string): Promise<ArrayBuffer> => {
        const r = await fetch(new URL(path, i.baseUrl).href, { credentials: 'omit' });
        if (!r.ok) throw new Error(`artifact read failed for ${path} (HTTP ${String(r.status)})`);
        return r.arrayBuffer();
      },
      sha256Hex: sha256HexAsync,
    },
  };
  const models = modelsBlock(inputs);
  adapter = createSceneAdapter(i.canvas as never, adapterOptions(inputs, runtime, models));
  scope.__spikeInfo['composedAt'] = epochNow();
  if (models !== null) {
    void adapter.modelsSettled?.().then((settle) => scope.postMessage({ t: 'modelsSettled', settle: settle === undefined ? { ok: true } : settle }));
  }
  for (const m of pending.splice(0)) onPage(m);
};

const onPage = (m: PageMessage): void => {
  if (m.t === 'init') return;
  if (adapter === null && m.t !== 'dispose' && m.t !== 'resize') {
    pending.push(m);
    return;
  }
  switch (m.t) {
    case 'quality':
      adapter!.setQuality?.(m.level as never);
      return;
    case 'environment':
      adapter!.setEnvironmentLayer?.(m.layer as never);
      return;
    case 'cameraOffset':
      adapter!.setCameraOffset?.(m.offset);
      return;
    case 'resize': {
      if (init === null) return;
      init.width = m.width;
      init.height = m.height;
      const c = init.canvas as unknown as { clientWidth: number; clientHeight: number };
      if (adapter !== null) {
        c.clientWidth = m.width;
        c.clientHeight = m.height;
        schedule();
      }
      return;
    }
    case 'dispose':
      disposed = true;
      adapter?.dispose();
      adapter = null;
      init?.port.close();
      scope.postMessage({ t: 'disposed' });
      return;
  }
};

scope.addEventListener('message', (e) => {
  const m = e.data as PageMessage;
  if (m?.t === 'init') {
    init = m;
    if (m.perf) {
      // The phase 21 instrumentation, with this worker's global standing in for `window`.
      new Function('window', 'requestAnimationFrame', `(${installPerfInstrumentation.toString()})()`)(self, scope.requestAnimationFrame.bind(self));
    }
    m.port.onmessage = onSimMessage;
    compose();
    return;
  }
  onPage(m);
});
