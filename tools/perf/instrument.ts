/**
 * Phase 21.1: page instrumentation, installed with `addInitScript` in every
 * frame before any page script runs. It counts at the graphics API — so it
 * measures the legacy WebGLRenderer, WebGPURenderer on WebGL 2 and on WebGPU
 * alike, and needs no hook in the product:
 *
 * - draw calls and (approximate) triangles per rendered frame,
 * - live programs/pipelines, textures, buffers and vertex arrays,
 * - an estimate of GPU memory (buffer bytes as uploaded, texture level-0
 *   texels × 4 bytes, ×4/3 with mipmaps),
 * - rendered-frame intervals (requestAnimationFrame timestamps of the frames
 *   that drew something) while recording,
 * - when the first draw call happened (performance.now and epoch ms).
 *
 * The function is serialized into the page: it must not close over anything.
 */

export interface PerfPageState {
  draws: number;
  tris: number;
  recording: boolean;
  frames: number[];
  frameDraws: number[];
  frameTris: number[];
  firstDrawAt: number | null;
  firstDrawEpoch: number | null;
  live: { programs: number; pipelines: number; textures: number; buffers: number; vaos: number };
  bytes: { buffers: number; textures: number };
  apis: string[];
  /** Phase 21.4: WebSocket messages the page received (by `type`), and when each `mutation.applied` arrived. */
  ws: { byType: Record<string, { n: number; bytes: number; max: number }>; applied: number[]; appliedFrame: number[] };
  /** Phase 21.4: long tasks (≥ 50 ms main-thread blocks) as [start, duration]. */
  longTasks: [number, number][];
  /**
   * Phase 21.5: the same live counts per WebGL context / WebGPU device (held
   * weakly, so the instrumentation never keeps a released canvas alive). A
   * context that was lost or collected, or a destroyed device, frees its
   * resources without delete calls: `readGpuLive` leaves it out.
   */
  contexts: GpuContextRecord[];
  /** Phase 21.5: workers created and terminated by this frame's scripts. */
  workers: { created: number; terminated: number };
}

/** Phase 21.5: one WebGL context or WebGPU device and what it holds now. */
export interface GpuContextRecord {
  kind: 'webgl' | 'webgpu';
  ref: { deref(): object | undefined };
  destroyed: boolean;
  live: { programs: number; textures: number; buffers: number; vaos: number };
}

export function installPerfInstrumentation(): void {
  const w = window as unknown as { __tlPerf?: PerfPageState };
  if (w.__tlPerf !== undefined) return;
  const P: PerfPageState = {
    draws: 0,
    tris: 0,
    recording: false,
    frames: [],
    frameDraws: [],
    frameTris: [],
    firstDrawAt: null,
    firstDrawEpoch: null,
    live: { programs: 0, pipelines: 0, textures: 0, buffers: 0, vaos: 0 },
    bytes: { buffers: 0, textures: 0 },
    apis: [],
    ws: { byType: {}, applied: [], appliedFrame: [] },
    longTasks: [],
    contexts: [],
    workers: { created: 0, terminated: 0 },
  };
  w.__tlPerf = P;
  // Phase 21.5: per-context bookkeeping (WeakRef: a context is never kept alive by this map).
  const ctxOf = new WeakMap<object, GpuContextRecord>();
  const WR = (globalThis as unknown as { WeakRef?: new (o: object) => { deref(): object | undefined } }).WeakRef;
  const ctxRecord = (owner: unknown, kind: 'webgl' | 'webgpu'): GpuContextRecord | null => {
    if (owner === null || typeof owner !== 'object' || WR === undefined) return null;
    let r = ctxOf.get(owner);
    if (r === undefined) {
      r = { kind, ref: new WR(owner), destroyed: false, live: { programs: 0, textures: 0, buffers: 0, vaos: 0 } };
      ctxOf.set(owner, r);
      P.contexts.push(r);
    }
    return r;
  };
  const ctxAdd = (owner: unknown, kind: 'webgl' | 'webgpu', key: 'programs' | 'textures' | 'buffers' | 'vaos', d: number): void => {
    const r = ctxRecord(owner, kind);
    if (r !== null) r.live[key] += d;
  };
  // Phase 21.5: workers (created / terminated) — a leak test checks none is left behind.
  const OrigWorker = (globalThis as unknown as { Worker?: typeof Worker }).Worker;
  if (typeof OrigWorker === 'function') {
    const WrappedWorker = function (url: string | URL, options?: WorkerOptions): Worker {
      const wk = new OrigWorker(url, options);
      P.workers.created += 1;
      return wk;
    } as unknown as typeof Worker;
    WrappedWorker.prototype = OrigWorker.prototype;
    (globalThis as unknown as { Worker: typeof Worker }).Worker = WrappedWorker;
    const term = OrigWorker.prototype.terminate;
    OrigWorker.prototype.terminate = function (this: Worker) {
      P.workers.terminated += 1;
      return term.call(this);
    };
  }
  // Phase 21.4: WebSocket message sizes by type, and for each `mutation.applied` the delay until the
  // second animation frame after it (the page's own work for the change — projection, React, the
  // Scene view sync — delays that frame). The wrapper adds one listener before the page's own.
  const OrigWS = window.WebSocket;
  if (typeof OrigWS === 'function') {
    const onMessage = (ev: MessageEvent): void => {
      const at = performance.now();
      const data = typeof ev.data === 'string' ? ev.data : '';
      const bytes = typeof ev.data === 'string' ? new TextEncoder().encode(ev.data).length : ((ev.data as { byteLength?: number; size?: number }).byteLength ?? (ev.data as { size?: number }).size ?? 0);
      const type = /^\{"type":"([^"]{1,64})"/.exec(data)?.[1] ?? 'other';
      const row = (P.ws.byType[type] ??= { n: 0, bytes: 0, max: 0 });
      row.n += 1;
      row.bytes += bytes;
      row.max = Math.max(row.max, bytes);
      if (type === 'mutation.applied') {
        P.ws.applied.push(at);
        requestAnimationFrame(() => requestAnimationFrame(() => P.ws.appliedFrame.push(performance.now() - at)));
      }
    };
    const Wrapped = function (url: string | URL, protocols?: string | string[]): WebSocket {
      const ws = protocols === undefined ? new OrigWS(url) : new OrigWS(url, protocols);
      ws.addEventListener('message', onMessage);
      return ws;
    } as unknown as typeof WebSocket;
    Wrapped.prototype = OrigWS.prototype;
    for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'] as const) Object.defineProperty(Wrapped, k, { value: OrigWS[k] });
    (window as unknown as { WebSocket: typeof WebSocket }).WebSocket = Wrapped;
  }
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) P.longTasks.push([e.startTime, e.duration]);
    }).observe({ type: 'longtask', buffered: true });
  } catch {
    /* long tasks are not observable here */
  }
  const noteApi = (name: string): void => {
    if (!P.apis.includes(name)) P.apis.push(name);
  };
  const draw = (tris: number): void => {
    P.draws += 1;
    P.tris += tris;
    if (P.firstDrawAt === null) {
      P.firstDrawAt = performance.now();
      P.firstDrawEpoch = Date.now();
    }
  };
  type Fn = (...a: unknown[]) => unknown;
  const wrap = (proto: object | undefined, name: string, before: (self: unknown, a: unknown[]) => void, after?: (self: unknown, a: unknown[], r: unknown) => void): void => {
    if (proto === undefined) return;
    const p = proto as Record<string, Fn>;
    const orig = p[name];
    if (typeof orig !== 'function') return;
    p[name] = function (this: unknown, ...a: unknown[]) {
      before(this, a);
      const r = orig.apply(this, a);
      if (after !== undefined) after(this, a, r);
      return r;
    };
  };
  const TRIANGLES = 4;
  const triCount = (mode: unknown, count: unknown, instances: unknown = 1): number => (mode === TRIANGLES ? Math.floor(Number(count) / 3) * Number(instances) : 0);

  // ---- WebGL / WebGL 2 ------------------------------------------------------------
  const bufferBytes = new WeakMap<object, number>();
  const textureBytes = new WeakMap<object, Map<number, number>>();
  const bound = new WeakMap<object, { buffers: Map<number, object | null>; textures: Map<number, object | null>; unit: number; units: Map<number, Map<number, object | null>> }>();
  const state = (gl: object) => {
    let s = bound.get(gl);
    if (s === undefined) {
      s = { buffers: new Map(), textures: new Map(), unit: 0, units: new Map() };
      bound.set(gl, s);
    }
    return s;
  };
  const CUBE_X = 0x8515;
  const CUBE = 0x8513;
  const setTexBytes = (gl: object, target: number, level: number, bytes: number): void => {
    if (level !== 0) return;
    const face = target >= CUBE_X && target < CUBE_X + 6 ? target - CUBE_X : 0;
    const bindTarget = target >= CUBE_X && target < CUBE_X + 6 ? CUBE : target;
    const s = state(gl);
    const tex = s.units.get(s.unit)?.get(bindTarget) ?? null;
    if (tex === null) return;
    let faces = textureBytes.get(tex);
    if (faces === undefined) {
      faces = new Map();
      textureBytes.set(tex, faces);
    }
    P.bytes.textures -= faces.get(face) ?? 0;
    faces.set(face, bytes);
    P.bytes.textures += bytes;
  };
  // A second delete of the same object is a no-op in WebGL (three deletes a shared interleaved buffer once per attribute).
  const deletedGl = new WeakSet<object>();
  const firstDelete = (o: unknown): boolean => {
    if (o === null || typeof o !== 'object' || deletedGl.has(o)) return false;
    deletedGl.add(o);
    return true;
  };
  const glProtos: object[] = [];
  if (typeof WebGL2RenderingContext !== 'undefined') glProtos.push(WebGL2RenderingContext.prototype);
  if (typeof WebGLRenderingContext !== 'undefined') glProtos.push(WebGLRenderingContext.prototype);
  for (const proto of glProtos) {
    const api = proto === (typeof WebGL2RenderingContext !== 'undefined' ? WebGL2RenderingContext.prototype : null) ? 'webgl2' : 'webgl';
    wrap(proto, 'drawArrays', (_g, a) => { noteApi(api); draw(triCount(a[0], a[2])); });
    wrap(proto, 'drawElements', (_g, a) => { noteApi(api); draw(triCount(a[0], a[1])); });
    wrap(proto, 'drawArraysInstanced', (_g, a) => { noteApi(api); draw(triCount(a[0], a[2], a[3])); });
    wrap(proto, 'drawElementsInstanced', (_g, a) => { noteApi(api); draw(triCount(a[0], a[1], a[4])); });
    wrap(proto, 'drawRangeElements', (_g, a) => { noteApi(api); draw(triCount(a[0], a[3])); });
    wrap(proto, 'createProgram', (gl) => { P.live.programs += 1; ctxAdd(gl, 'webgl', 'programs', 1); });
    wrap(proto, 'deleteProgram', (gl, a) => { if (firstDelete(a[0])) { P.live.programs -= 1; ctxAdd(gl, 'webgl', 'programs', -1); } });
    wrap(proto, 'createTexture', (gl) => { P.live.textures += 1; ctxAdd(gl, 'webgl', 'textures', 1); });
    wrap(proto, 'deleteTexture', (gl, a) => {
      if (!firstDelete(a[0])) return;
      P.live.textures -= 1;
      ctxAdd(gl, 'webgl', 'textures', -1);
      const faces = textureBytes.get(a[0] as object);
      if (faces !== undefined) for (const b of faces.values()) P.bytes.textures -= b;
      textureBytes.delete(a[0] as object);
    });
    wrap(proto, 'createBuffer', (gl) => { P.live.buffers += 1; ctxAdd(gl, 'webgl', 'buffers', 1); });
    wrap(proto, 'deleteBuffer', (gl, a) => {
      if (!firstDelete(a[0])) return;
      P.live.buffers -= 1;
      ctxAdd(gl, 'webgl', 'buffers', -1);
      P.bytes.buffers -= bufferBytes.get(a[0] as object) ?? 0;
      bufferBytes.delete(a[0] as object);
    });
    wrap(proto, 'createVertexArray', (gl) => { P.live.vaos += 1; ctxAdd(gl, 'webgl', 'vaos', 1); });
    wrap(proto, 'deleteVertexArray', (gl, a) => { if (firstDelete(a[0])) { P.live.vaos -= 1; ctxAdd(gl, 'webgl', 'vaos', -1); } });
    wrap(proto, 'bindBuffer', (g, a) => { state(g as object).buffers.set(a[0] as number, (a[1] as object | null) ?? null); });
    wrap(proto, 'bufferData', (g, a) => {
      const buf = state(g as object).buffers.get(a[0] as number) ?? null;
      if (buf === null) return;
      const src = a[1];
      const bytes = typeof src === 'number' ? src : src !== null && typeof src === 'object' && 'byteLength' in (src as object) ? Number((src as { byteLength: number }).byteLength) : 0;
      P.bytes.buffers += bytes - (bufferBytes.get(buf) ?? 0);
      bufferBytes.set(buf, bytes);
    });
    wrap(proto, 'activeTexture', (g, a) => { state(g as object).unit = Number(a[0]); });
    wrap(proto, 'bindTexture', (g, a) => {
      const s = state(g as object);
      let unit = s.units.get(s.unit);
      if (unit === undefined) {
        unit = new Map();
        s.units.set(s.unit, unit);
      }
      unit.set(a[0] as number, (a[1] as object | null) ?? null);
    });
    wrap(proto, 'texStorage2D', (g, a) => setTexBytes(g as object, a[0] as number, 0, Number(a[3]) * Number(a[4]) * 4 * (Number(a[1]) > 1 ? 4 / 3 : 1)));
    wrap(proto, 'texStorage3D', (g, a) => setTexBytes(g as object, a[0] as number, 0, Number(a[3]) * Number(a[4]) * Number(a[5]) * 4 * (Number(a[1]) > 1 ? 4 / 3 : 1)));
    wrap(proto, 'texImage2D', (g, a) => {
      // (target, level, internalformat, width, height, border, format, type, source) or (target, level, internalformat, format, type, source).
      let wdt = 0;
      let hgt = 0;
      if (a.length >= 8) {
        wdt = Number(a[3]);
        hgt = Number(a[4]);
      } else {
        const src = a[5] as { width?: number; height?: number; videoWidth?: number; videoHeight?: number } | undefined;
        wdt = Number(src?.videoWidth ?? src?.width ?? 0);
        hgt = Number(src?.videoHeight ?? src?.height ?? 0);
      }
      setTexBytes(g as object, a[0] as number, Number(a[1]), wdt * hgt * 4);
    });
    wrap(proto, 'texImage3D', (g, a) => setTexBytes(g as object, a[0] as number, Number(a[1]), Number(a[3]) * Number(a[4]) * Number(a[5]) * 4));
  }

  // ---- WebGPU ---------------------------------------------------------------------
  const g = globalThis as unknown as Record<string, { prototype: object } | undefined>;
  const gpuBytes = new WeakMap<object, { kind: 'buffers' | 'textures'; bytes: number; device: unknown }>();
  const track = (obj: unknown, kind: 'buffers' | 'textures', bytes: number, device: unknown): void => {
    if (obj === null || typeof obj !== 'object') return;
    P.live[kind] += 1;
    P.bytes[kind] += bytes;
    gpuBytes.set(obj, { kind, bytes, device });
    ctxAdd(device, 'webgpu', kind, 1);
  };
  const untrack = (obj: unknown): void => {
    const t = obj !== null && typeof obj === 'object' ? gpuBytes.get(obj) : undefined;
    if (t === undefined) return;
    P.live[t.kind] -= 1;
    P.bytes[t.kind] -= t.bytes;
    gpuBytes.delete(obj as object);
    ctxAdd(t.device, 'webgpu', t.kind, -1);
  };
  const device = g['GPUDevice']?.prototype;
  if (device !== undefined) {
    wrap(device, 'createBuffer', () => undefined, (d, a, r) => track(r, 'buffers', Number((a[0] as { size?: number } | undefined)?.size ?? 0), d));
    wrap(device, 'destroy', (d) => {
      const r = ctxRecord(d, 'webgpu');
      if (r !== null) r.destroyed = true;
    });
    wrap(device, 'createTexture', () => undefined, (d, a, r) => {
      const desc = (a[0] ?? {}) as { size?: number[] | { width?: number; height?: number; depthOrArrayLayers?: number }; mipLevelCount?: number };
      const size = desc.size;
      const [wd, ht, dp] = Array.isArray(size) ? [size[0] ?? 1, size[1] ?? 1, size[2] ?? 1] : [size?.width ?? 1, size?.height ?? 1, size?.depthOrArrayLayers ?? 1];
      track(r, 'textures', wd * ht * dp * 4 * ((desc.mipLevelCount ?? 1) > 1 ? 4 / 3 : 1), d);
    });
    wrap(device, 'createRenderPipeline', () => { P.live.pipelines += 1; });
    wrap(device, 'createComputePipeline', () => { P.live.pipelines += 1; });
    wrap(device, 'createRenderPipelineAsync', () => { P.live.pipelines += 1; });
    wrap(device, 'createComputePipelineAsync', () => { P.live.pipelines += 1; });
  }
  wrap(g['GPUBuffer']?.prototype, 'destroy', (b) => untrack(b));
  wrap(g['GPUTexture']?.prototype, 'destroy', (t) => untrack(t));
  for (const enc of ['GPURenderPassEncoder', 'GPURenderBundleEncoder']) {
    const proto = g[enc]?.prototype;
    wrap(proto, 'draw', (_e, a) => { noteApi('webgpu'); draw(Math.floor(Number(a[0]) / 3) * Number(a[1] ?? 1)); });
    wrap(proto, 'drawIndexed', (_e, a) => { noteApi('webgpu'); draw(Math.floor(Number(a[0]) / 3) * Number(a[1] ?? 1)); });
    wrap(proto, 'drawIndirect', () => { noteApi('webgpu'); draw(0); });
    wrap(proto, 'drawIndexedIndirect', () => { noteApi('webgpu'); draw(0); });
  }

  // ---- rendered frames --------------------------------------------------------------
  let lastT: number | null = null;
  let lastDraws = 0;
  let lastTris = 0;
  const tick = (t: number): void => {
    if (P.draws !== lastDraws) {
      if (P.recording) {
        if (lastT !== null) P.frames.push(t - lastT);
        P.frameDraws.push(P.draws - lastDraws);
        P.frameTris.push(P.tris - lastTris);
      }
      lastT = t;
      lastDraws = P.draws;
      lastTris = P.tris;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** In the page: start a recording window (drops earlier frames). */
export function startRecording(): void {
  const P = (window as unknown as { __tlPerf?: PerfPageState }).__tlPerf;
  if (P === undefined) return;
  P.frames = [];
  P.frameDraws = [];
  P.frameTris = [];
  P.recording = true;
}

export interface PageSample {
  frames: number[];
  frameDraws: number[];
  frameTris: number[];
  live: PerfPageState['live'];
  bytes: PerfPageState['bytes'];
  apis: string[];
  firstDrawAt: number | null;
  firstDrawEpoch: number | null;
  heap: { usedMiB: number; totalMiB: number; source: string } | null;
  uasm: string;
  renderer: { requested?: string; backend?: string; state?: string; reason?: string } | null;
  nav: { domContentLoaded: number; load: number } | null;
}

/** In the page: stop recording and read everything (garbage-collected heap where `gc` is exposed). */
export async function readSample(stop: boolean): Promise<PageSample> {
  const P = (window as unknown as { __tlPerf?: PerfPageState }).__tlPerf;
  if (P === undefined) throw new Error('perf instrumentation missing');
  if (stop) P.recording = false;
  const gc = (globalThis as unknown as { gc?: () => void }).gc;
  if (typeof gc === 'function') gc();
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory;
  const heap = mem !== undefined ? { usedMiB: mem.usedJSHeapSize / 1048576, totalMiB: mem.totalJSHeapSize / 1048576, source: typeof gc === 'function' ? 'performance.memory after gc()' : 'performance.memory' } : null;
  // measureUserAgentSpecificMemory needs a cross-origin-isolated page.
  const uasm = typeof (performance as unknown as { measureUserAgentSpecificMemory?: unknown }).measureUserAgentSpecificMemory !== 'function'
    ? 'unavailable: not supported'
    : (globalThis as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated !== true
      ? 'unavailable: the page is not cross-origin isolated'
      : 'available';
  const canvas = [...document.querySelectorAll('canvas[data-tl-renderer]')].sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0] as HTMLCanvasElement | undefined;
  const renderer = canvas !== undefined
    ? { requested: canvas.dataset['tlRendererRequested'], backend: canvas.dataset['tlRenderer'], state: canvas.dataset['tlRendererState'], reason: canvas.dataset['tlRendererReason'] }
    : null;
  const navEntry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  return {
    frames: P.frames.slice(),
    frameDraws: P.frameDraws.slice(),
    frameTris: P.frameTris.slice(),
    live: { ...P.live },
    bytes: { ...P.bytes },
    apis: P.apis.slice(),
    firstDrawAt: P.firstDrawAt,
    firstDrawEpoch: P.firstDrawEpoch,
    heap,
    uasm,
    renderer,
    nav: navEntry !== undefined ? { domContentLoaded: navEntry.domContentLoadedEventEnd, load: navEntry.loadEventEnd } : null,
  };
}

export interface GpuLive {
  /** WebGL contexts that are neither lost nor collected (after a gc). */
  webglContexts: number;
  /** WebGPU devices that are neither destroyed nor collected. */
  webgpuDevices: number;
  programs: number;
  textures: number;
  buffers: number;
  vaos: number;
  workers: { created: number; terminated: number };
}

/**
 * Phase 21.5, in the page: what the live contexts hold now (contexts that are
 * lost, destroyed or collected freed their resources and are left out).
 * Call after a garbage collection for the collected ones to drop out.
 */
export function readGpuLive(): GpuLive {
  const P = (window as unknown as { __tlPerf?: PerfPageState }).__tlPerf;
  const out: GpuLive = { webglContexts: 0, webgpuDevices: 0, programs: 0, textures: 0, buffers: 0, vaos: 0, workers: { created: 0, terminated: 0 } };
  if (P === undefined) return out;
  out.workers = { ...P.workers };
  P.contexts = P.contexts.filter((r) => r.ref.deref() !== undefined);
  for (const r of P.contexts) {
    const owner = r.ref.deref() as { isContextLost?: () => boolean } | undefined;
    if (owner === undefined || r.destroyed) continue;
    if (r.kind === 'webgl' && typeof owner.isContextLost === 'function' && owner.isContextLost()) continue;
    if (r.kind === 'webgl') out.webglContexts += 1;
    else out.webgpuDevices += 1;
    out.programs += r.live.programs;
    out.textures += r.live.textures;
    out.buffers += r.live.buffers;
    out.vaos += r.live.vaos;
  }
  return out;
}
