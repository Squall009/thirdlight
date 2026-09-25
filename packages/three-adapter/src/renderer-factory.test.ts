/**
 * Phase 17.1: the renderer factory's backend choice, async readiness and
 * loss handling, with stubbed renderers and a stubbed `navigator.gpu` (Node
 * has no WebGPU; the real backends are covered by tests/e2e/renderer.e2e.ts).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  BUILTIN_MODULES,
  createSimulationRegistry,
  instantiateRuntime,
  registerSimulationModule,
  type Runtime,
  type RuntimeSnapshot,
} from '@thirdlight/runtime';
import {
  createRenderer,
  decideBackend,
  MAX_RENDERER_RECOVERIES,
  probeWebGpu,
  rendererPreferenceFromSetting,
  rendererPreferenceFromUrl,
  resolveRendererPreference,
  type GpuAdapterLike,
  type GpuDeviceLike,
  type GpuLike,
  type NodeRendererLike,
  type NodeRendererParams,
  type RendererFactoryDeps,
  type WebGpuProbe,
} from './renderer-factory';
import { createSceneAdapter } from './index';
import { baseScene, cloneJson, snapshotOf } from './test-scene';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function device(opts: { popError?: unknown; popRejects?: string } = {}): GpuDeviceLike & { destroyed: boolean } {
  const d = {
    destroyed: false,
    lost: new Promise<{ reason?: string; message?: string }>(() => undefined),
    destroy() {
      d.destroyed = true;
    },
    pushErrorScope: () => undefined,
    popErrorScope: () => (opts.popRejects !== undefined ? Promise.reject(new Error(opts.popRejects)) : Promise.resolve(opts.popError ?? null)),
    createBuffer: () => ({ destroy: () => undefined }),
  };
  return d;
}

function gpu(adapter: GpuAdapterLike | null): GpuLike {
  return { requestAdapter: () => Promise.resolve(adapter) };
}

function adapterWith(dev: GpuDeviceLike, info: GpuAdapterLike['info'] = { vendor: 'google', architecture: 'swiftshader', isFallbackAdapter: true }): GpuAdapterLike {
  return { features: ['float32-filterable'], info, requestDevice: () => Promise.resolve(dev) };
}

describe('renderer preference (URL flag over project setting over default)', () => {
  it('reads the ?renderer= flag and the render_backend setting', () => {
    expect(rendererPreferenceFromUrl('?renderer=webgl2')).toBe('webgl2');
    expect(rendererPreferenceFromUrl('?a=1&renderer=webgpu')).toBe('webgpu');
    expect(rendererPreferenceFromUrl('?renderer=vulkan')).toBeNull();
    expect(rendererPreferenceFromUrl('')).toBeNull();
    // Phase 17.4: the archived WebGL renderer's values mean auto (old URLs, old stored settings).
    expect(rendererPreferenceFromUrl('?renderer=legacy')).toBe('auto');
    expect(rendererPreferenceFromSetting(0)).toBe('auto');
    expect(rendererPreferenceFromSetting(1)).toBe('auto');
    expect(rendererPreferenceFromSetting(2)).toBe('webgpu');
    expect(rendererPreferenceFromSetting(3)).toBe('webgl2');
    expect(rendererPreferenceFromSetting(4)).toBeNull();
    expect(rendererPreferenceFromSetting(1.5)).toBeNull();
    expect(rendererPreferenceFromSetting(undefined)).toBeNull();
  });
  it('resolves url > setting > default', () => {
    expect(resolveRendererPreference({ url: '?renderer=webgpu', setting: 3 })).toEqual({ preference: 'webgpu', source: 'url' });
    expect(resolveRendererPreference({ url: '?renderer=nope', setting: 3 })).toEqual({ preference: 'webgl2', source: 'setting' });
    expect(resolveRendererPreference({ url: '', setting: undefined })).toEqual({ preference: 'auto', source: 'default' });
    expect(resolveRendererPreference({ url: '', setting: 0 })).toEqual({ preference: 'auto', source: 'setting' });
  });
});

describe('probeWebGpu', () => {
  it('says why when navigator.gpu is missing (secure context or not)', async () => {
    expect(await probeWebGpu(undefined, false)).toEqual({ ok: false, reason: expect.stringContaining('not a secure context') });
    expect(await probeWebGpu(undefined, true)).toEqual({ ok: false, reason: expect.stringContaining('no WebGPU') });
  });
  it('refuses a null adapter, a failing device request and a device that dies at its first command', async () => {
    expect(await probeWebGpu(gpu(null), true)).toEqual({ ok: false, reason: expect.stringContaining('requestAdapter returned null') });
    const throwing: GpuAdapterLike = { requestDevice: () => Promise.reject(new Error('device refused')) };
    expect(await probeWebGpu(gpu(throwing), true)).toEqual({ ok: false, reason: expect.stringContaining('device refused') });
    expect(await probeWebGpu(gpu(adapterWith(device({ popRejects: 'Instance dropped in popErrorScope' }))), true)).toEqual({
      ok: false,
      reason: expect.stringContaining('Instance dropped in popErrorScope'),
    });
    const bad = device({ popError: { message: 'validation failed' } });
    expect(await probeWebGpu(gpu(adapterWith(bad)), true)).toEqual({ ok: false, reason: expect.stringContaining('validation failed') });
    expect(bad.destroyed).toBe(true);
  });
  it('times out a hung adapter request', async () => {
    const hung: GpuLike = { requestAdapter: () => new Promise(() => undefined) };
    expect(await probeWebGpu(hung, true, 20)).toEqual({ ok: false, reason: expect.stringContaining('timed out') });
  });
  it('accepts a working device and names the adapter', async () => {
    const r = await probeWebGpu(gpu(adapterWith(device())), true);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.adapterName).toBe('google swiftshader (fallback adapter)');
  });
});

describe('decideBackend', () => {
  const ok: WebGpuProbe = { ok: true, device: device(), adapterName: 'A' };
  const no: WebGpuProbe = { ok: false, reason: 'no adapter' };
  it('maps every preference', () => {
    expect(decideBackend('webgl2', null).backend).toBe('webgl2');
    expect(decideBackend('auto', ok)).toEqual({ backend: 'webgpu', reason: 'WebGPU on A' });
    expect(decideBackend('auto', no)).toEqual({ backend: 'webgl2', reason: 'no adapter: WebGL 2 backend' });
    expect(decideBackend('webgpu', ok).backend).toBe('webgpu');
    expect(decideBackend('webgpu', no)).toEqual({ backend: 'webgl2', reason: 'WebGPU unavailable (no adapter): WebGL 2 backend instead' });
  });
});

// ---- the handle, with stub renderers ---------------------------------------------------

interface StubNode extends NodeRendererLike {
  params: NodeRendererParams;
  clear: [number, number] | null;
  disposed: boolean;
  resolveInit(): void;
  rejectInit(e: Error): void;
}

function stubDeps(probe: WebGpuProbe | (() => Promise<WebGpuProbe>)): { deps: Partial<RendererFactoryDeps>; made: StubNode[]; probes: number } {
  const made: StubNode[] = [];
  const state = { probes: 0 };
  const deps: Partial<RendererFactoryDeps> = {
    // A navigator.gpu stand-in (the probe itself is stubbed below).
    gpu: () => ({ requestAdapter: () => Promise.resolve(null) }),
    secureContext: () => true,
    probe: () => {
      state.probes += 1;
      return typeof probe === 'function' ? probe() : Promise.resolve(probe);
    },
    createNode: (params) => {
      let res: () => void = () => undefined;
      let rej: (e: Error) => void = () => undefined;
      const initP = new Promise<unknown>((a, b) => {
        res = () => a(undefined);
        rej = b;
      });
      const r: StubNode = {
        params,
        clear: null,
        disposed: false,
        backend: { isWebGPUBackend: !params.forceWebGL },
        init: () => initP,
        setClearColor(c, a) {
          r.clear = [c, a];
        },
        onDeviceLost: () => undefined,
        dispose() {
          r.disposed = true;
        },
        resolveInit: () => res(),
        rejectInit: (e) => rej(e),
      };
      made.push(r);
      return r;
    },
  };
  return {
    deps,
    made,
    get probes() {
      return state.probes;
    },
  };
}

function eventCanvas(): { canvas: { addEventListener(t: string, l: (e: unknown) => void): void; removeEventListener(t: string, l: (e: unknown) => void): void; setAttribute(n: string, v: string): void; attrs: Record<string, string>; fire(t: string): void } } {
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  const attrs: Record<string, string> = {};
  return {
    canvas: {
      attrs,
      addEventListener(t, l) {
        const s = listeners.get(t) ?? new Set();
        s.add(l);
        listeners.set(t, s);
      },
      removeEventListener(t, l) {
        listeners.get(t)?.delete(l);
      },
      setAttribute(n, v) {
        attrs[n] = v;
      },
      fire(t) {
        for (const l of listeners.get(t) ?? []) l({});
      },
    },
  };
}

describe('createRenderer', () => {
  it('webgl2: the canvas keeps its WebGL context after dispose unless the caller frees it (three would lose it on every dispose)', async () => {
    for (const loseContextOnDispose of [false, true]) {
      let lost = 0;
      const ext = { loseContext: () => (lost += 1) };
      const gl = { getExtension: (n: string) => (n === 'WEBGL_lose_context' ? ext : null) };
      const { canvas } = eventCanvas();
      const withContext = { ...canvas, getContext: (type: string) => (type === 'webgl2' ? gl : null) };
      let made: { params: NodeRendererParams } | null = null;
      const h = createRenderer({
        canvas: withContext,
        preference: 'webgl2',
        source: 'default',
        clearColor: 0,
        clearAlpha: 1,
        loseContextOnDispose,
        deps: {
          createNode: (params) => {
            const cache = new Map<string, unknown>();
            const r = {
              params,
              backend: { isWebGPUBackend: false, extensions: { get: (n: string): unknown => (cache.has(n) ? cache.get(n) : (cache.set(n, gl.getExtension(n)), cache.get(n))) } },
              init: () => Promise.resolve(),
              setClearColor: () => undefined,
              onDeviceLost: () => undefined,
              // What three's WebGLBackend.dispose() does: lose the context through its extension cache.
              dispose: async (): Promise<void> => {
                await Promise.resolve();
                (r.backend.extensions.get('WEBGL_lose_context') as { loseContext(): void } | null)?.loseContext();
              },
            };
            made = r;
            return r;
          },
        },
      });
      expect(await h.whenReady()).toBe(true);
      // The factory asked the canvas for the context and handed it over.
      expect(made!.params.context).toBe(gl);
      h.dispose();
      await flush();
      expect(lost, `loseContextOnDispose ${loseContextOnDispose}`).toBe(loseContextOnDispose ? 1 : 0);
    }
  });

  it('webgl2: WebGPURenderer forced to WebGL 2, not ready until init resolves', async () => {
    const s = stubDeps({ ok: false, reason: 'unused' });
    const { canvas } = eventCanvas();
    const h = createRenderer({ canvas, preference: 'webgl2', source: 'url', clearColor: 0x000000, clearAlpha: 0, deps: s.deps });
    expect(s.probes).toBe(0);
    expect(s.made).toHaveLength(1);
    expect(s.made[0]!.params.forceWebGL).toBe(true);
    expect(s.made[0]!.clear).toEqual([0, 0]);
    expect(h.ready()).toBe(false);
    expect(h.info().state).toBe('initialising');
    const ready = h.whenReady();
    s.made[0]!.resolveInit();
    expect(await ready).toBe(true);
    expect(h.ready()).toBe(true);
    expect(h.info()).toMatchObject({ requested: 'webgl2', source: 'url', backend: 'webgl2', api: 'webgl2', state: 'ready' });
    expect(h.info().reason).toBe('URL flag ?renderer=webgl2: WebGPURenderer on its WebGL 2 backend');
    expect(canvas.attrs).toMatchObject({ 'data-tl-renderer': 'webgl2', 'data-tl-renderer-state': 'ready' });
    h.dispose();
    expect(s.made[0]!.disposed).toBe(true);
  });

  it('auto: WebGPU on the probed device when it works, the WebGL 2 backend (with the reason) when not', async () => {
    const dev = device();
    const yes = stubDeps({ ok: true, device: dev, adapterName: 'GPU X' });
    const h1 = createRenderer({ canvas: null, preference: 'auto', source: 'setting', clearColor: 0, clearAlpha: 1, deps: yes.deps });
    expect(h1.current()).toBeNull(); // still probing
    await flush();
    expect(yes.made[0]!.params).toMatchObject({ forceWebGL: false, device: dev });
    yes.made[0]!.resolveInit();
    await flush();
    expect(h1.info()).toMatchObject({ backend: 'webgpu', api: 'webgpu', state: 'ready', reason: 'project setting auto: WebGPU on GPU X' });

    const no = stubDeps({ ok: false, reason: 'the page is not a secure context' });
    const h2 = createRenderer({ canvas: null, preference: 'auto', source: 'default', clearColor: 0, clearAlpha: 1, deps: no.deps });
    await flush();
    expect(no.made[0]!.params.forceWebGL).toBe(true);
    no.made[0]!.resolveInit();
    await flush();
    expect(h2.info()).toMatchObject({ backend: 'webgl2', state: 'ready', reason: 'default auto: the page is not a secure context: WebGL 2 backend' });
  });

  it('webgpu: an init failure on WebGPU rebuilds on the WebGL 2 backend', async () => {
    const s = stubDeps({ ok: true, device: device(), adapterName: 'GPU X' });
    const h = createRenderer({ canvas: null, preference: 'webgpu', source: 'url', clearColor: 0, clearAlpha: 1, deps: s.deps });
    await flush();
    s.made[0]!.rejectInit(new Error('adapter vanished'));
    await flush();
    expect(s.made).toHaveLength(2);
    expect(s.made[0]!.disposed).toBe(true);
    expect(s.made[1]!.params.forceWebGL).toBe(true);
    s.made[1]!.resolveInit();
    await flush();
    expect(h.info()).toMatchObject({ backend: 'webgl2', state: 'ready' });
    expect(h.info().reason).toContain('WebGPU init failed (adapter vanished)');
    expect(h.generation()).toBe(2);
  });

  it('a lost WebGPU device is rebuilt on a new device, then given up after the limit', async () => {
    const s = stubDeps(() => Promise.resolve({ ok: true, device: device(), adapterName: 'GPU' }));
    const h = createRenderer({ canvas: null, preference: 'webgpu', source: 'default', clearColor: 0, clearAlpha: 1, deps: s.deps });
    const changes = vi.fn();
    h.onChange(changes);
    await flush();
    s.made[0]!.resolveInit();
    await flush();
    for (let i = 1; i <= MAX_RENDERER_RECOVERIES; i++) {
      const r = s.made[s.made.length - 1]!;
      r.onDeviceLost({ api: 'WebGPU', message: 'gpu reset', reason: 'unknown' });
      expect(h.ready()).toBe(false);
      expect(r.disposed).toBe(true);
      await flush();
      expect(s.probes).toBe(1 + i);
      s.made[s.made.length - 1]!.resolveInit();
      await flush();
      expect(h.ready()).toBe(true);
      expect(h.info().recoveries).toBe(i);
      expect(h.info().reason).toContain(`rebuilt after a lost device (${i}/${MAX_RENDERER_RECOVERIES})`);
    }
    s.made[s.made.length - 1]!.onDeviceLost({ api: 'WebGPU', message: 'gpu reset', reason: null });
    expect(h.info().state).toBe('failed');
    expect(h.info().reason).toContain('gave up');
    expect(await h.whenReady()).toBe(false);
    expect(changes).toHaveBeenCalled();
  });

  it('a lost WebGL 2 context waits for the browser, then rebuilds on webglcontextrestored', async () => {
    const s = stubDeps({ ok: false, reason: 'unused' });
    const { canvas } = eventCanvas();
    const h = createRenderer({ canvas, preference: 'webgl2', source: 'default', clearColor: 0, clearAlpha: 1, deps: s.deps });
    s.made[0]!.resolveInit();
    await flush();
    s.made[0]!.onDeviceLost({ api: 'WebGL', message: 'context lost', reason: null });
    expect(h.info().state).toBe('lost');
    expect(canvas.attrs['data-tl-renderer-state']).toBe('lost');
    expect(s.made).toHaveLength(1);
    canvas.fire('webglcontextrestored');
    expect(s.made).toHaveLength(2);
    s.made[1]!.resolveInit();
    await flush();
    expect(h.info()).toMatchObject({ state: 'ready', recoveries: 1 });
    h.dispose();
    canvas.fire('webglcontextrestored'); // released: no rebuild after dispose
    expect(s.made).toHaveLength(2);
  });
});

describe('scene adapter on the factory (stubbed WebGPURenderer)', () => {
  function makeRuntime(): { runtime: Runtime; snapshot: RuntimeSnapshot } {
    const registry = createSimulationRegistry();
    for (const spec of BUILTIN_MODULES) registerSimulationModule(registry, spec.id, spec);
    const snapshot = snapshotOf(cloneJson(baseScene())) as RuntimeSnapshot;
    const res = instantiateRuntime({ snapshot, registry, driver: { kind: 'manual' }, clock: () => 0 });
    if (!res.ok) throw new Error('instantiate failed');
    res.runtime.start();
    res.runtime.tick(0);
    return { runtime: res.runtime, snapshot };
  }
  // getContext gives a stand-in WebGL 2 context (the stub renderer never uses it).
  const canvas = { getContext: () => ({}), width: 64, height: 64, clientWidth: 64, clientHeight: 64 };

  it('skips frames while initialising and reports the choice; a lost device is render_context_lost; a failure render_unsupported', async () => {
    const { runtime, snapshot } = makeRuntime();
    const s = stubDeps({ ok: false, reason: 'no adapter' });
    const adapter = createSceneAdapter(canvas, { runtime, snapshot, renderer: { preference: 'auto', source: 'url', deps: s.deps } });
    expect(adapter.renderFrame()).toEqual({ ok: true });
    const shot = adapter.captureScreenshot(64);
    expect(shot.ok).toBe(false);
    if (!shot.ok) expect(shot.error.code).toBe('render_failed');
    const d = adapter.diagnostics();
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.diagnostics.renderBackend).toBeNull();
      expect(d.diagnostics.renderer).toMatchObject({ requested: 'auto', source: 'url', state: 'initialising' });
    }
    await flush();
    s.made[0]!.onDeviceLost({ api: 'WebGL', message: 'lost', reason: null });
    const lost = adapter.renderFrame();
    expect(lost.ok).toBe(false);
    if (!lost.ok) expect(lost.error.code).toBe('render_context_lost');
    adapter.dispose();
    const after = adapter.diagnostics();
    if (after.ok) expect(after.diagnostics.renderer?.requested).toBe('auto');
    runtime.dispose();

    const r2 = makeRuntime();
    const f = stubDeps({ ok: false, reason: 'x' });
    const failing = createSceneAdapter(canvas, { runtime: r2.runtime, snapshot: r2.snapshot, renderer: { preference: 'webgl2', source: 'setting', deps: f.deps } });
    failing.renderFrame();
    f.made[0]!.rejectInit(new Error('no webgl2'));
    await flush();
    const res = failing.renderFrame();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('render_unsupported');
    failing.dispose();
    r2.runtime.dispose();
  });

  it('a canvas without WebGL 2 (and no navigator.gpu) is render_unsupported on the first frame, sticky, with the reason', () => {
    const { runtime, snapshot } = makeRuntime();
    const s = stubDeps({ ok: false, reason: 'unused' });
    s.deps.gpu = () => undefined;
    const adapter = createSceneAdapter({ ...canvas, getContext: () => null }, { runtime, snapshot, renderer: { preference: 'auto', source: 'default', deps: s.deps } });
    const first = adapter.renderFrame();
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.error.code).toBe('render_unsupported');
    expect(s.probes).toBe(0); // nothing to probe without navigator.gpu
    expect(s.made).toHaveLength(0);
    const again = adapter.renderFrame();
    expect(again.ok).toBe(false);
    const d = adapter.diagnostics();
    if (d.ok) {
      expect(d.diagnostics.renderBackend).toBeNull();
      expect(d.diagnostics.renderer).toMatchObject({ requested: 'auto', state: 'failed' });
      expect(d.diagnostics.renderer?.reason).toContain('no WebGL 2 context');
      expect(d.diagnostics.renderer?.reason).toContain('navigator.gpu is missing');
    }
    adapter.dispose();
    runtime.dispose();
  });
});
