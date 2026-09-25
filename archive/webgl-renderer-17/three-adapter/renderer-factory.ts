/**
 * Phase 17.1: the one renderer factory used by Play/export (the scene
 * adapter), the editor's Scene view and its previews (asset preview,
 * Animator preview, thumbnails).
 *
 * Backends (the names are logged in docs/plan-phase-17.md §6):
 *  - `legacy` — today's `THREE.WebGLRenderer` (WebGL 2 first). The DEFAULT
 *    until phase 17.4 switches over, so nothing changes for a project that
 *    does not ask for another backend.
 *  - `webgl2` — three's `WebGPURenderer` forced onto its WebGL 2 backend.
 *  - `webgpu` — `WebGPURenderer` on WebGPU; when WebGPU cannot start here it
 *    runs on the WebGL 2 backend and the reason says why.
 *  - `auto` — WebGPU when an adapter and a working device initialise, else
 *    the WebGL 2 backend (a plain-http LAN page has no `navigator.gpu`).
 *
 * The choice comes from a URL flag (`?renderer=…`), else the project setting
 * (`render_backend`), else the default. `WebGPURenderer` initialises
 * asynchronously: `ready()` is false until it has, and callers skip frames
 * until then. The chosen backend, its state and a reason are reported by
 * `info()` and mirrored on the canvas (`data-tl-renderer*` attributes).
 *
 * Loss: the legacy renderer keeps today's contract (the scene adapter's
 * `webglcontextlost`/`webglcontextrestored` listeners; three restores its GL
 * state). `WebGPURenderer` reports loss through `onDeviceLost`: on WebGL 2
 * the renderer is rebuilt once the browser restores the context; on WebGPU
 * it is rebuilt on a new device, at most `MAX_RENDERER_RECOVERIES` times,
 * then the handle reports `failed` (reload the page).
 */
import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';

export type RendererPreference = 'legacy' | 'auto' | 'webgpu' | 'webgl2';
export type RendererPreferenceSource = 'default' | 'setting' | 'url';
/** What actually draws: today's WebGL renderer, or WebGPURenderer on WebGPU / WebGL 2. */
export type RendererBackend = 'legacy' | 'webgpu' | 'webgl2';
export type RendererState = 'initialising' | 'ready' | 'lost' | 'failed';

export const RENDERER_PREFERENCES: readonly RendererPreference[] = ['legacy', 'auto', 'webgpu', 'webgl2'];
/** The project setting `render_backend`: its value is the index here (0 = legacy, the default). */
export const RENDER_BACKEND_SETTING_VALUES: readonly RendererPreference[] = ['legacy', 'auto', 'webgpu', 'webgl2'];
/** Legacy until phase 17.4 switches every view to `auto`. */
export const DEFAULT_RENDERER_PREFERENCE: RendererPreference = 'legacy';
/** The URL query parameter that forces a backend (`?renderer=webgl2`). */
export const RENDERER_URL_PARAM = 'renderer';
/** Engine limit: rebuilds after a lost WebGPU device before the handle gives up (a device that keeps dying is a driver/GPU fault). */
export const MAX_RENDERER_RECOVERIES = 3;
/** Engine limit: how long the WebGPU probe may take before `auto` takes WebGL 2 (a hung adapter request must not stall the page). */
export const WEBGPU_PROBE_TIMEOUT_MS = 5000;

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

/**
 * Can WebGPU draw here? An adapter, a device, and one validated command (a
 * device that dies at first use — Dawn without a working Vulkan here — is
 * refused, see §6 of the phase plan). Never rejects.
 */
export async function probeWebGpu(gpu: GpuLike | undefined, secureContext: boolean, timeoutMs: number = WEBGPU_PROBE_TIMEOUT_MS): Promise<WebGpuProbe> {
  if (gpu === undefined || gpu === null || typeof gpu.requestAdapter !== 'function') {
    return { ok: false, reason: secureContext ? 'this browser has no WebGPU (navigator.gpu is missing)' : 'the page is not a secure context (https or localhost), so navigator.gpu is missing' };
  }
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

/** Which backend a preference gets, given the probe (pure; the probe is null for `legacy`/`webgl2`). */
export function decideBackend(preference: RendererPreference, probe: WebGpuProbe | null): { backend: RendererBackend; reason: string } {
  if (preference === 'legacy') return { backend: 'legacy', reason: 'the WebGL renderer (the default until the WebGPU switch-over)' };
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

export type AnyRenderer = THREE.WebGLRenderer | WebGPURenderer;

/** True for three's WebGPURenderer (either backend). */
export function isNodeRenderer(r: unknown): r is WebGPURenderer {
  return (r as { isWebGPURenderer?: unknown } | null)?.isWebGPURenderer === true;
}

export interface RendererInfo {
  requested: RendererPreference;
  source: RendererPreferenceSource;
  /** What draws (null while `auto`/`webgpu` are still probing). */
  backend: RendererBackend | null;
  /** The graphics API underneath: `webgpu`, `webgl2` or (legacy only) `webgl1`. */
  api: 'webgpu' | 'webgl2' | 'webgl1' | null;
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
}

/** The parts of a WebGPURenderer the handle drives. */
export interface NodeRendererLike {
  init(): Promise<unknown>;
  setClearColor(color: number, alpha: number): void;
  onDeviceLost: (info: { api: string; message: string; reason: string | null }) => void;
  readonly backend: { isWebGPUBackend?: boolean };
  dispose(): void;
}

export interface RendererFactoryDeps {
  /** `navigator.gpu` (undefined without WebGPU). */
  gpu(): GpuLike | undefined;
  secureContext(): boolean;
  createLegacy(params: { canvas: unknown; antialias: boolean; alpha: boolean; preserveDrawingBuffer: boolean; powerPreference: 'high-performance' | 'low-power' }): THREE.WebGLRenderer;
  createNode(params: NodeRendererParams): NodeRendererLike;
  probe(gpu: GpuLike | undefined, secureContext: boolean): Promise<WebGpuProbe>;
}

export interface CreateRendererOptions {
  canvas: unknown;
  preference: RendererPreference;
  source: RendererPreferenceSource;
  antialias?: boolean;
  /** A transparent canvas where nothing is drawn (default false). */
  alpha?: boolean;
  /** Legacy only: keep the drawing buffer for a later `toBlob` (thumbnails). */
  preserveDrawingBuffer?: boolean;
  powerPreference?: 'high-performance' | 'low-power';
  /** The explicit clear colour and alpha (WebGPURenderer's canvas is transparent otherwise). */
  clearColor: number;
  clearAlpha: number;
  /** Legacy: also drop the WebGL context on dispose (the adapter and thumbnails own their canvases). */
  loseContextOnDispose?: boolean;
  /** Tests inject stubs; the browser uses three and `navigator.gpu`. */
  deps?: Partial<RendererFactoryDeps>;
}

const BROWSER_DEPS: RendererFactoryDeps = {
  gpu: () => (globalThis as { navigator?: { gpu?: GpuLike } }).navigator?.gpu,
  secureContext: () => (globalThis as { isSecureContext?: boolean }).isSecureContext === true,
  createLegacy: (p) => new THREE.WebGLRenderer({ canvas: p.canvas as HTMLCanvasElement, antialias: p.antialias, alpha: p.alpha, preserveDrawingBuffer: p.preserveDrawingBuffer, powerPreference: p.powerPreference }),
  createNode: (p) =>
    new WebGPURenderer({
      canvas: p.canvas as HTMLCanvasElement,
      antialias: p.antialias,
      alpha: p.alpha,
      powerPreference: p.powerPreference,
      forceWebGL: p.forceWebGL,
      // The probed device (WebGPUBackend takes it instead of requesting its own).
      ...(p.device !== undefined ? { device: p.device } : {}),
    } as unknown as ConstructorParameters<typeof WebGPURenderer>[0]) as unknown as NodeRendererLike,
  probe: (gpu, secure) => probeWebGpu(gpu, secure),
};

/**
 * Create the renderer for a canvas. `legacy` is created synchronously and
 * throws like `new THREE.WebGLRenderer` does (no WebGL here); the other
 * backends never throw here — their failures surface as `state: 'failed'`.
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

  // ---- legacy: today's WebGLRenderer, synchronously -------------------------------
  if (o.preference === 'legacy') {
    const r = deps.createLegacy({ canvas: o.canvas, antialias, alpha, preserveDrawingBuffer: o.preserveDrawingBuffer === true, powerPreference });
    r.setClearColor(o.clearColor, o.clearAlpha);
    renderer = r;
    generation = 1;
    const d = decideBackend('legacy', null);
    publish({ backend: 'legacy', api: r.capabilities?.isWebGL2 === false ? 'webgl1' : 'webgl2', state: 'ready', reason: d.reason });
    return {
      current: () => renderer,
      ready: () => renderer !== null && !disposed,
      generation: () => generation,
      info: () => ({ ...info }),
      whenReady: () => Promise.resolve(renderer !== null && !disposed),
      onChange: (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        listeners.clear();
        try {
          r.dispose();
        } catch {
          /* best effort */
        }
        if (o.loseContextOnDispose === true) {
          try {
            r.forceContextLoss();
          } catch {
            /* best effort */
          }
        }
        renderer = null;
      },
    };
  }

  // ---- WebGPURenderer: probe (auto/webgpu), build, init; rebuild after a loss ----------
  let initialised = false;
  let lost = false;
  let node: NodeRendererLike | null = null;

  const dropRenderer = (): void => {
    const old = node;
    node = null;
    renderer = null;
    initialised = false;
    if (old !== null) {
      try {
        old.dispose();
      } catch {
        /* best effort: the old renderer may sit on a lost device */
      }
    }
  };

  const build = (device: GpuDeviceLike | null, reason: string): void => {
    if (disposed) return;
    dropRenderer();
    let r: NodeRendererLike;
    try {
      r = deps.createNode({ canvas: o.canvas, antialias, alpha, powerPreference, forceWebGL: device === null, ...(device !== null ? { device } : {}) });
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
    publish({ backend: null, api: null, state: 'initialising', reason: `probing WebGPU${reasonSuffix}` });
    void deps.probe(deps.gpu(), deps.secureContext()).then((probe) => {
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
      dropRenderer();
      const waiters = readyWaiters;
      readyWaiters = [];
      for (const w of waiters) w(false);
    },
  };
}

/** The GPU resource counts both renderers report (`programs` exists only on the legacy one). */
export function rendererMemory(r: AnyRenderer): { geometries: number; textures: number; programs: number } {
  const i = r.info as unknown as { memory?: { geometries?: number; textures?: number }; programs?: unknown[] | null };
  return { geometries: i.memory?.geometries ?? 0, textures: i.memory?.textures ?? 0, programs: Array.isArray(i.programs) ? i.programs.length : 0 };
}
