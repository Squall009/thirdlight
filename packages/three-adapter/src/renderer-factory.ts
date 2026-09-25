/**
 * Phase 17.1: the one renderer factory used by Play/export (the scene
 * adapter), the editor's Scene view and its previews (asset preview,
 * Animator preview, thumbnails) and the browser lightmap baker.
 *
 * Backends (the names are logged in docs/plan-phase-17.md §6), all three's
 * `WebGPURenderer` with the shading written once in TSL:
 *  - `auto` — the DEFAULT since phase 17.4: WebGPU when an adapter and a
 *    working device initialise, else the WebGL 2 backend (a plain-http LAN
 *    page has no `navigator.gpu`).
 *  - `webgl2` — `WebGPURenderer` forced onto its WebGL 2 backend.
 *  - `webgpu` — `WebGPURenderer` on WebGPU; when WebGPU cannot start here it
 *    runs on the WebGL 2 backend and the reason says why.
 *
 * Phase 17.4: the `THREE.WebGLRenderer` path (`legacy`) is archived
 * (`archive/webgl-renderer-17/`); an old `?renderer=legacy` flag or a stored
 * `render_backend` 0 means `auto`.
 *
 * The choice comes from a URL flag (`?renderer=…`), else the project setting
 * (`render_backend`), else the default. `WebGPURenderer` initialises
 * asynchronously: `ready()` is false until it has, and callers skip frames
 * until then. The chosen backend, its state and a reason are reported by
 * `info()` and mirrored on the canvas (`data-tl-renderer*` attributes).
 *
 * Loss: `WebGPURenderer` reports loss through `onDeviceLost`: on WebGL 2
 * the renderer is rebuilt once the browser restores the context; on WebGPU
 * it is rebuilt on a new device, at most `MAX_RENDERER_RECOVERIES` times,
 * then the handle reports `failed` (reload the page).
 */
import { WebGPURenderer } from 'three/webgpu';

export type RendererPreference = 'auto' | 'webgpu' | 'webgl2';
export type RendererPreferenceSource = 'default' | 'setting' | 'url';
/** What actually draws: WebGPURenderer on WebGPU or on its WebGL 2 backend. */
export type RendererBackend = 'webgpu' | 'webgl2';
export type RendererState = 'initialising' | 'ready' | 'lost' | 'failed';

export const RENDERER_PREFERENCES: readonly RendererPreference[] = ['auto', 'webgpu', 'webgl2'];
/**
 * The project setting `render_backend`: its value is the index here. 0 was
 * the archived WebGL renderer (`legacy`, phases 17.1–17.3): a project that
 * stored it gets `auto` (phase 17.4).
 */
export const RENDER_BACKEND_SETTING_VALUES: readonly RendererPreference[] = ['auto', 'auto', 'webgpu', 'webgl2'];
/**
 * Phase 17.4: `auto` — WebGPU where the browser can start it, else WebGL 2:
 * every browser with WebGL 2 draws, and the faster API is used where it exists.
 */
export const DEFAULT_RENDERER_PREFERENCE: RendererPreference = 'auto';
/** Phase 17.4: the archived WebGL renderer's flag value, still accepted in a URL as `auto`. */
const LEGACY_URL_VALUE = 'legacy';
/** The URL query parameter that forces a backend (`?renderer=webgl2`). */
export const RENDERER_URL_PARAM = 'renderer';
/** Engine limit: rebuilds after a lost WebGPU device before the handle gives up (a device that keeps dying is a driver/GPU fault). */
export const MAX_RENDERER_RECOVERIES = 3;
/** Engine limit: how long the WebGPU probe may take before `auto` takes WebGL 2 (a hung adapter request must not stall the page). */
export const WEBGPU_PROBE_TIMEOUT_MS = 5000;
/** Engine limit: the probe's patience when WebGPU was asked for explicitly (`webgpu`): a slow adapter (a busy or software GPU) should not silently turn an explicit choice into WebGL 2. */
export const WEBGPU_FORCED_PROBE_TIMEOUT_MS = 30000;

const REASON_LIMIT = 200;

/** The `?renderer=` flag of a page URL's query string (null when absent or not a backend name). */
export function rendererPreferenceFromUrl(search: string | null | undefined): RendererPreference | null {
  if (typeof search !== 'string' || search.length === 0) return null;
  let value: string | null = null;
  try {
    value = new URLSearchParams(search).get(RENDERER_URL_PARAM);
  } catch {
    return null;
  }
  if (value === LEGACY_URL_VALUE) return 'auto';
  return value !== null && (RENDERER_PREFERENCES as readonly string[]).includes(value) ? (value as RendererPreference) : null;
}

/** The project's `render_backend` setting as a backend (null when absent or out of range). */
export function rendererPreferenceFromSetting(value: unknown): RendererPreference | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  return RENDER_BACKEND_SETTING_VALUES[value] ?? null;
}

/** URL flag over project setting over the default. */
export function resolveRendererPreference(o: { url?: string | null; setting?: unknown }): { preference: RendererPreference; source: RendererPreferenceSource } {
  const fromUrl = rendererPreferenceFromUrl(o.url);
  if (fromUrl !== null) return { preference: fromUrl, source: 'url' };
  const fromSetting = rendererPreferenceFromSetting(o.setting);
  if (fromSetting !== null) return { preference: fromSetting, source: 'setting' };
  return { preference: DEFAULT_RENDERER_PREFERENCE, source: 'default' };
}

/** The page's own query string (empty outside a browser). */
export function pageSearch(): string {
  const loc = (globalThis as { location?: { search?: unknown } }).location;
  return typeof loc?.search === 'string' ? loc.search : '';
}

// ---- WebGPU probe (structural: no WebGPU typings needed) ------------------------

export interface GpuDeviceLike {
  readonly lost: Promise<{ reason?: string | null; message?: string }>;
  destroy?(): void;
  pushErrorScope?(filter: string): void;
  popErrorScope?(): Promise<unknown>;
  createBuffer?(descriptor: { size: number; usage: number }): { destroy?(): void };
}
export interface GpuAdapterLike {
  readonly features?: Iterable<string>;
  readonly info?: { vendor?: string; architecture?: string; description?: string; isFallbackAdapter?: boolean };
  requestDevice(descriptor?: { requiredFeatures?: string[] }): Promise<GpuDeviceLike>;
}
export interface GpuLike {
  requestAdapter(options?: Record<string, unknown>): Promise<GpuAdapterLike | null>;
}

export type WebGpuProbe = { ok: true; device: GpuDeviceLike; adapterName: string } | { ok: false; reason: string };

const clip = (s: string): string => (s.length > REASON_LIMIT ? `${s.slice(0, REASON_LIMIT - 1)}…` : s);
const messageOf = (e: unknown): string => clip(e instanceof Error ? e.message : String(e));

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/** `navigator.gpu` exists (the page is a secure context in a browser with WebGPU). */
function hasWebGpuApi(gpu: GpuLike | undefined): gpu is GpuLike {
  return gpu !== undefined && gpu !== null && typeof gpu.requestAdapter === 'function';
}

function noWebGpuReason(secureContext: boolean): string {
  return secureContext ? 'this browser has no WebGPU (navigator.gpu is missing)' : 'the page is not a secure context (https or localhost), so navigator.gpu is missing';
}

/**
 * Can WebGPU draw here? An adapter, a device, and one validated command (a
 * device that dies at first use — Dawn without a working Vulkan here — is
 * refused, see §6 of the phase plan). Never rejects.
 */
export async function probeWebGpu(gpu: GpuLike | undefined, secureContext: boolean, timeoutMs: number = WEBGPU_PROBE_TIMEOUT_MS): Promise<WebGpuProbe> {
  if (!hasWebGpuApi(gpu)) return { ok: false, reason: noWebGpuReason(secureContext) };
  try {
    const adapter = await withTimeout(gpu.requestAdapter({ powerPreference: 'high-performance', featureLevel: 'compatibility' }), timeoutMs, 'requestAdapter');
    if (adapter === null) return { ok: false, reason: 'no WebGPU adapter (requestAdapter returned null)' };
    const features = adapter.features !== undefined ? [...adapter.features] : [];
    const device = await withTimeout(adapter.requestDevice({ requiredFeatures: features }), timeoutMs, 'requestDevice');
    if (typeof device.pushErrorScope === 'function' && typeof device.popErrorScope === 'function' && typeof device.createBuffer === 'function') {
      device.pushErrorScope('validation');
      // 8 = GPUBufferUsage.COPY_DST: the smallest valid buffer.
      const buffer = device.createBuffer({ size: 16, usage: 8 });
      const err = await withTimeout(device.popErrorScope(), timeoutMs, 'the first GPU command');
      buffer.destroy?.();
      if (err !== null && err !== undefined) {
        device.destroy?.();
        return { ok: false, reason: clip(`the WebGPU device fails its first command: ${String((err as { message?: unknown }).message ?? err)}`) };
      }
    }
    const i = adapter.info ?? {};
    const name = [i.vendor, i.architecture, i.description].filter((s) => typeof s === 'string' && s.length > 0).join(' ') || 'unnamed adapter';
    return { ok: true, device, adapterName: clip(`${name}${i.isFallbackAdapter === true ? ' (fallback adapter)' : ''}`) };
  } catch (e) {
    return { ok: false, reason: clip(`WebGPU did not start: ${messageOf(e)}`) };
  }
}

/** Which backend a preference gets, given the probe (pure; the probe is null for `webgl2`). */
export function decideBackend(preference: RendererPreference, probe: WebGpuProbe | null): { backend: RendererBackend; reason: string } {
  if (preference === 'webgl2') return { backend: 'webgl2', reason: 'WebGPURenderer on its WebGL 2 backend' };
  if (probe !== null && probe.ok) return { backend: 'webgpu', reason: `WebGPU on ${probe.adapterName}` };
  const why = probe === null ? 'WebGPU was not probed' : probe.reason;
  return { backend: 'webgl2', reason: preference === 'webgpu' ? `WebGPU unavailable (${why}): WebGL 2 backend instead` : `${why}: WebGL 2 backend` };
}

const SOURCE_TEXT: Record<RendererPreferenceSource, string> = {
  default: 'default',
  setting: 'project setting',
  url: `URL flag ?${RENDERER_URL_PARAM}=`,
};

// ---- the handle ---------------------------------------------------------------------

/** The renderer every view draws with (phase 17.4: only WebGPURenderer). */
export type AnyRenderer = WebGPURenderer;

/** True for three's WebGPURenderer (either backend). */
export function isNodeRenderer(r: unknown): r is WebGPURenderer {
  return (r as { isWebGPURenderer?: unknown } | null)?.isWebGPURenderer === true;
}

export interface RendererInfo {
  requested: RendererPreference;
  source: RendererPreferenceSource;
  /** What draws (null while `auto`/`webgpu` are still probing). */
  backend: RendererBackend | null;
  /** The graphics API underneath: `webgpu` or `webgl2`. */
  api: 'webgpu' | 'webgl2' | null;
  state: RendererState;
  /** Why this backend (and any loss/recovery), ≤ 200 characters plus the source. */
  reason: string;
  /** Rebuilds after a loss so far. */
  recoveries: number;
}

export interface RendererHandle {
  /** The live renderer (null while probing, after a failure or after dispose). */
  current(): AnyRenderer | null;
  /** The renderer can draw now (created, initialised, not lost). */
  ready(): boolean;
  /** Bumps whenever a new renderer object replaces the old one (rebuild what holds the old one). */
  generation(): number;
  info(): RendererInfo;
  /** Resolves true once ready, false when the handle failed or was disposed. */
  whenReady(): Promise<boolean>;
  /** Called on every state change (ready, lost, rebuilt, failed). */
  onChange(listener: () => void): () => void;
  dispose(): void;
}

/** The canvas surface the factory needs (a real canvas satisfies it). */
export interface RendererCanvasLike {
  getContext?: (type: string, attributes?: unknown) => unknown;
  addEventListener?: (type: string, listener: (event: unknown) => void, options?: unknown) => void;
  removeEventListener?: (type: string, listener: (event: unknown) => void, options?: unknown) => void;
  setAttribute?: (name: string, value: string) => void;
}

/** What `WebGPURenderer` needs from its construction parameters (a stub may satisfy it in tests). */
export interface NodeRendererParams {
  canvas: unknown;
  antialias: boolean;
  alpha: boolean;
  powerPreference: 'high-performance' | 'low-power';
  forceWebGL: boolean;
  device?: GpuDeviceLike;
  /** Phase 17.4: the WebGL 2 context the factory made for the WebGL 2 backend (same attributes as three's own). */
  context?: unknown;
  /** Phase 20.3: GPU timestamp queries (where the device offers them). */
  trackTimestamp?: boolean;
}

/** The parts of a WebGPURenderer the handle drives. */
export interface NodeRendererLike {
  init(): Promise<unknown>;
  setClearColor(color: number, alpha: number): void;
  onDeviceLost: (info: { api: string; message: string; reason: string | null }) => void;
  readonly backend: { isWebGPUBackend?: boolean; extensions?: { get(name: string): unknown } };
  dispose(): unknown;
}

/** The part of `WEBGL_lose_context` the handle uses. */
interface LoseContextLike {
  loseContext(): void;
}

export interface RendererFactoryDeps {
  /** `navigator.gpu` (undefined without WebGPU). */
  gpu(): GpuLike | undefined;
  secureContext(): boolean;
  createNode(params: NodeRendererParams): NodeRendererLike;
  probe(gpu: GpuLike | undefined, secureContext: boolean, timeoutMs?: number): Promise<WebGpuProbe>;
}

export interface CreateRendererOptions {
  canvas: unknown;
  preference: RendererPreference;
  source: RendererPreferenceSource;
  antialias?: boolean;
  /** A transparent canvas where nothing is drawn (default false). */
  alpha?: boolean;
  powerPreference?: 'high-performance' | 'low-power';
  /** The explicit clear colour and alpha (WebGPURenderer's canvas is transparent otherwise). */
  clearColor: number;
  clearAlpha: number;
  /**
   * WebGL 2 backend: drop the canvas's WebGL context when the handle is
   * disposed (the canvas is not drawn to again: Play's and the export's game
   * canvas, thumbnails, the baker). Default false: the canvas keeps a live
   * context for a later renderer (a preview restarted on the same canvas) —
   * three's WebGLBackend would otherwise lose it on every dispose.
   */
  loseContextOnDispose?: boolean;
  /**
   * Phase 20.3: record GPU timestamp queries for `resolveTimestampsAsync`
   * (the Effect tab's GPU time). Only where the device offers them (WebGPU's
   * `timestamp-query` feature, WebGL 2's `EXT_disjoint_timer_query_webgl2`);
   * default false (queries cost a little on every pass).
   */
  trackTimestamp?: boolean;
  /** Tests inject stubs; the browser uses three and `navigator.gpu`. */
  deps?: Partial<RendererFactoryDeps>;
}

const BROWSER_DEPS: RendererFactoryDeps = {
  gpu: () => (globalThis as { navigator?: { gpu?: GpuLike } }).navigator?.gpu,
  secureContext: () => (globalThis as { isSecureContext?: boolean }).isSecureContext === true,
  createNode: (p) =>
    new WebGPURenderer({
      canvas: p.canvas as HTMLCanvasElement,
      antialias: p.antialias,
      alpha: p.alpha,
      powerPreference: p.powerPreference,
      forceWebGL: p.forceWebGL,
      ...(p.trackTimestamp === true ? { trackTimestamp: true } : {}),
      // The probed device (WebGPUBackend takes it instead of requesting its own).
      ...(p.device !== undefined ? { device: p.device } : {}),
      // The factory's WebGL 2 context (WebGLBackend takes it instead of asking the canvas).
      ...(p.context !== undefined ? { context: p.context } : {}),
    } as unknown as ConstructorParameters<typeof WebGPURenderer>[0]) as unknown as NodeRendererLike,
  probe: (gpu, secure, timeoutMs) => probeWebGpu(gpu, secure, timeoutMs),
};

/**
 * Create the renderer for a canvas. Never throws: failures surface as
 * `state: 'failed'` with the reason.
 */
export function createRenderer(o: CreateRendererOptions): RendererHandle {
  const deps: RendererFactoryDeps = { ...BROWSER_DEPS, ...o.deps };
  const canvas = o.canvas as RendererCanvasLike | null;
  const antialias = o.antialias ?? true;
  const alpha = o.alpha ?? false;
  const powerPreference = o.powerPreference ?? 'high-performance';
  const listeners = new Set<() => void>();
  let renderer: AnyRenderer | null = null;
  let generation = 0;
  let disposed = false;
  let info: RendererInfo = { requested: o.preference, source: o.source, backend: null, api: null, state: 'initialising', reason: 'choosing a backend', recoveries: 0 };
  let readyWaiters: Array<(ok: boolean) => void> = [];
  const releases: Array<() => void> = [];
  const prefix = o.source === 'url' ? `${SOURCE_TEXT.url}${o.preference}` : o.source === 'setting' ? `${SOURCE_TEXT.setting} ${o.preference}` : `${SOURCE_TEXT.default} ${o.preference}`;

  const publish = (next: Partial<RendererInfo>): void => {
    info = { ...info, ...next, ...(next.reason !== undefined ? { reason: `${prefix}: ${clip(next.reason)}` } : {}) };
    try {
      canvas?.setAttribute?.('data-tl-renderer', info.backend ?? 'pending');
      canvas?.setAttribute?.('data-tl-renderer-state', info.state);
      canvas?.setAttribute?.('data-tl-renderer-reason', info.reason);
    } catch {
      /* attributes are diagnostics only */
    }
    if (info.state === 'ready' || info.state === 'failed') {
      const waiters = readyWaiters;
      readyWaiters = [];
      for (const w of waiters) w(info.state === 'ready');
    }
    for (const l of [...listeners]) {
      try {
        l();
      } catch {
        /* a listener's failure never breaks the renderer */
      }
    }
  };

  // ---- WebGPURenderer: probe (auto/webgpu), build, init; rebuild after a loss ----------
  let initialised = false;
  let lost = false;
  let node: NodeRendererLike | null = null;

  /** The WebGL 2 context's lose extension (taken while the context lives; the handle decides when to use it). */
  let loseExt: LoseContextLike | null = null;

  const dropRenderer = (final = false): void => {
    const old = node;
    node = null;
    renderer = null;
    initialised = false;
    if (old === null) return;
    // three's WebGLBackend.dispose() loses the context itself (via its extension cache):
    // the canvas could never take another renderer. The handle keeps that decision.
    const ext = old.backend.extensions;
    if (ext !== undefined && typeof ext.get === 'function') {
      const get = ext.get.bind(ext);
      ext.get = (name: string): unknown => (name === 'WEBGL_lose_context' ? null : get(name));
    }
    const lose = final && o.loseContextOnDispose === true ? loseExt : null;
    let done: unknown;
    try {
      done = old.dispose();
    } catch {
      /* best effort: the old renderer may sit on a lost device */
    }
    if (lose !== null) {
      void Promise.resolve(done)
        .catch(() => undefined)
        .then(() => {
          try {
            lose.loseContext();
          } catch {
            /* best effort */
          }
        });
    }
  };

  const build = (device: GpuDeviceLike | null, reason: string): void => {
    if (disposed) return;
    dropRenderer();
    // The WebGL 2 backend: the context is asked for here, synchronously, with the
    // attributes three's WebGLBackend uses, so a canvas without WebGL 2 fails at once
    // (the scene adapter's `render_unsupported` contract) instead of in init().
    let context: unknown;
    if (device === null && typeof canvas?.getContext === 'function') {
      try {
        context = canvas.getContext('webgl2', { antialias, alpha: true, depth: true, stencil: false, powerPreference }) ?? null;
      } catch {
        context = null;
      }
      if (context === null) {
        publish({ backend: null, api: null, state: 'failed', reason: `${reason}, but this canvas has no WebGL 2 context` });
        return;
      }
      try {
        loseExt = ((context as { getExtension?: (n: string) => unknown }).getExtension?.('WEBGL_lose_context') as LoseContextLike | null | undefined) ?? null;
      } catch {
        loseExt = null;
      }
    }
    let r: NodeRendererLike;
    try {
      r = deps.createNode({ canvas: o.canvas, antialias, alpha, powerPreference, forceWebGL: device === null, ...(device !== null ? { device } : {}), ...(context !== undefined ? { context } : {}), ...(o.trackTimestamp === true ? { trackTimestamp: true } : {}) });
      r.setClearColor(o.clearColor, o.clearAlpha);
    } catch (e) {
      publish({ backend: null, api: null, state: 'failed', reason: `the renderer could not be created: ${messageOf(e)}` });
      return;
    }
    node = r;
    renderer = r as unknown as AnyRenderer;
    generation += 1;
    lost = false;
    r.onDeviceLost = (lossInfo) => onLost(r, lossInfo);
    publish({ backend: device !== null ? 'webgpu' : 'webgl2', api: null, state: 'initialising', reason: `${reason} (initialising)` });
    r.init().then(
      () => {
        if (disposed || node !== r) return;
        initialised = true;
        const onGpu = r.backend.isWebGPUBackend === true;
        publish({
          backend: onGpu ? 'webgpu' : 'webgl2',
          api: onGpu ? 'webgpu' : 'webgl2',
          state: 'ready',
          reason: device !== null && !onGpu ? `${reason}, but WebGPU did not start: WebGL 2 backend` : reason,
        });
      },
      (e: unknown) => {
        if (disposed || node !== r) return;
        if (device !== null) {
          // WebGPU would not start after all: the WebGL 2 backend.
          build(null, `WebGPU init failed (${messageOf(e)}): WebGL 2 backend`);
          return;
        }
        dropRenderer();
        publish({ backend: null, api: null, state: 'failed', reason: `the WebGL 2 backend did not start: ${messageOf(e)}` });
      },
    );
  };

  const start = (reasonSuffix: string): void => {
    if (o.preference === 'webgl2') {
      build(null, `${decideBackend('webgl2', null).reason}${reasonSuffix}`);
      return;
    }
    const gpu = deps.gpu();
    if (!hasWebGpuApi(gpu)) {
      // No navigator.gpu (a plain-http page, an older browser): nothing to probe, WebGL 2 at once.
      build(null, `${decideBackend(o.preference, { ok: false, reason: noWebGpuReason(deps.secureContext()) }).reason}${reasonSuffix}`);
      return;
    }
    publish({ backend: null, api: null, state: 'initialising', reason: `probing WebGPU${reasonSuffix}` });
    void deps.probe(gpu, deps.secureContext(), o.preference === 'webgpu' ? WEBGPU_FORCED_PROBE_TIMEOUT_MS : WEBGPU_PROBE_TIMEOUT_MS).then((probe) => {
      if (disposed) {
        if (probe.ok) probe.device.destroy?.();
        return;
      }
      const d = decideBackend(o.preference, probe);
      build(d.backend === 'webgpu' && probe.ok ? probe.device : null, `${d.reason}${reasonSuffix}`);
    });
  };

  const onLost = (r: NodeRendererLike, lossInfo: { api: string; message: string; reason: string | null }): void => {
    if (disposed || node !== r || lost) return;
    lost = true;
    initialised = false;
    const what = `${lossInfo.api} ${lossInfo.api === 'WebGL' ? 'context' : 'device'} lost (${clip(lossInfo.message)}${lossInfo.reason !== null ? `, ${lossInfo.reason}` : ''})`;
    if (lossInfo.api === 'WebGL') {
      // The browser restores a lost WebGL context on the same canvas; the
      // WebGL 2 backend does not rebuild itself, so a new renderer is made then.
      publish({ state: 'lost', reason: `${what}: waiting for the browser to restore it` });
      return;
    }
    if (info.recoveries >= MAX_RENDERER_RECOVERIES) {
      dropRenderer();
      publish({ backend: null, api: null, state: 'failed', reason: `${what}: gave up after ${MAX_RENDERER_RECOVERIES} rebuilds (reload the page)` });
      return;
    }
    const n = info.recoveries + 1;
    dropRenderer();
    publish({ state: 'lost', recoveries: n, reason: `${what}: rebuilding (${n}/${MAX_RENDERER_RECOVERIES})` });
    start(`; rebuilt after a lost device (${n}/${MAX_RENDERER_RECOVERIES})`);
  };

  if (typeof canvas?.addEventListener === 'function') {
    const onRestored = (): void => {
      if (disposed || !lost || info.backend !== 'webgl2') return;
      const n = info.recoveries + 1;
      publish({ recoveries: n });
      build(null, `${decideBackend('webgl2', null).reason}; rebuilt after a restored WebGL context (${n})`);
    };
    canvas.addEventListener('webglcontextrestored', onRestored, false);
    releases.push(() => canvas.removeEventListener?.('webglcontextrestored', onRestored, false));
  }

  start('');

  return {
    current: () => renderer,
    ready: () => renderer !== null && initialised && !lost && !disposed,
    generation: () => generation,
    info: () => ({ ...info }),
    whenReady: () => {
      if (disposed) return Promise.resolve(false);
      if (info.state === 'ready' && initialised) return Promise.resolve(true);
      if (info.state === 'failed') return Promise.resolve(false);
      return new Promise<boolean>((resolve) => readyWaiters.push(resolve));
    },
    onChange: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      for (const release of releases) release();
      releases.length = 0;
      dropRenderer(true);
      const waiters = readyWaiters;
      readyWaiters = [];
      for (const w of waiters) w(false);
    },
  };
}

/**
 * The renderer's live GPU resources. `programs` counts the render pipelines
 * WebGPURenderer holds (its `info.memory` has no program count; the archived
 * WebGL renderer reported `info.programs`).
 */
export function rendererMemory(r: AnyRenderer): { geometries: number; textures: number; programs: number } {
  const i = r.info as unknown as { memory?: { geometries?: number; textures?: number; programs?: number } };
  return { geometries: i.memory?.geometries ?? 0, textures: i.memory?.textures ?? 0, programs: i.memory?.programs ?? 0 };
}
