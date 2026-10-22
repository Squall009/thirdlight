/**
 * The adapter's renderer: created lazily on the first frame through the one
 * renderer factory (WebGPURenderer on WebGPU or WebGL 2), set up again when a
 * new one becomes ready (a lost device), the canvas' WebGL context lifecycle,
 * and what the diagnostics report about the choice.
 *
 * Kept apart from the adapter so the renderer's lifetime is owned in one place.
 */
import { setDecalDepthMode } from './mesh-decals';
import { renderPixelRatio } from './environment';
import { adapterError, type AdapterError } from './errors';
import { createRenderer, DEFAULT_RENDERER_PREFERENCE, type AnyRenderer, type RendererHandle, type RendererInfo } from './renderer-factory';
import type { SceneAdapterOptions } from './adapter-types';

/** Structural canvas surface (duck-typed: the adapter never assumes a
 *  real HTMLCanvasElement, so Node unit tests can pass a stub). */
export interface CanvasLike {
  getContext?: (type: string, options?: unknown) => unknown;
  toDataURL?: (type?: string) => string;
  addEventListener?: (type: string, listener: (event: unknown) => void, options?: unknown) => void;
  removeEventListener?: (type: string, listener: (event: unknown) => void, options?: unknown) => void;
  clientWidth?: number;
  clientHeight?: number;
  width?: number;
  height?: number;
  setAttribute?: (name: string, value: string) => void;
}

/** What a (re)created renderer sets up in the rest of the adapter. */
export interface AdapterRendererHost {
  /** The quality level's pixel-ratio cap. */
  pixelRatioCap(): number;
  /** Before set-up: what held the previous renderer (the environment renderer) goes. */
  dropRendererState(): void;
  /** After set-up: the parts that draw with it follow (effects, lights, the precompile). */
  adopted(renderer: AnyRenderer, api: 'webgpu' | 'webgl2'): void;
}

export class AdapterRenderer {
  /** The renderer handle (the factory's); its renderer may be replaced after a loss. */
  handle: RendererHandle | null = null;
  backend: 'webgl2' | 'webgpu' | null = null;
  info: string | null = null;
  pixelRatio = 1;
  /** Creation was tried (a failure is not tried again). */
  attempted = false;
  /** The renderer choice as last seen (kept for diagnostics after dispose). */
  lastInfo: RendererInfo | null = null;
  /** The WebGL context is lost (no frame is drawn until it is restored). */
  contextLost = false;
  /** The renderer generation the parts were set up for. */
  private generation = 0;
  /** Releases of the WebGL context listeners this adapter owns. */
  private readonly releases: Array<() => void> = [];

  constructor(
    readonly canvas: CanvasLike | null,
    private readonly opts: Pick<SceneAdapterOptions, 'renderer' | 'antialias'>,
    private readonly host: AdapterRendererHost,
  ) {
    // Loss is reported as a structured `render_context_lost` (no render into a dead context); three.js
    // re-initializes its own GL state on restoration and this clears the flag. Exactly these two listeners are
    // owned, released in dispose().
    if (typeof canvas?.addEventListener === 'function') {
      const onLost = (event: unknown): void => {
        this.contextLost = true;
        const e = event as { preventDefault?: () => void } | null;
        if (typeof e?.preventDefault === 'function') e.preventDefault();
      };
      const onRestored = (): void => {
        this.contextLost = false;
      };
      canvas.addEventListener('webglcontextlost', onLost, false);
      canvas.addEventListener('webglcontextrestored', onRestored, false);
      this.releases.push(
        () => canvas.removeEventListener?.('webglcontextlost', onLost, false),
        () => canvas.removeEventListener?.('webglcontextrestored', onRestored, false),
      );
    }
  }

  canvasSize(): [number, number] {
    const c = this.canvas;
    const w = Math.max(1, Math.floor(c?.clientWidth ?? c?.width ?? 0));
    const h = Math.max(1, Math.floor(c?.clientHeight ?? c?.height ?? 0));
    return [w, h];
  }

  /** The canvas says something about the frame (an export has no other in-page diagnostics surface). */
  mark(name: string, value: string): void {
    if (typeof this.canvas?.setAttribute === 'function') this.canvas.setAttribute(name, value);
  }

  /** The renderer, created on the first call (null: there is one; else why there is none). */
  ensure(disposed: boolean): AdapterError | null {
    if (disposed) return adapterError('adapter_disposed', 'adapter is disposed');
    if (this.handle) return null;
    if (this.attempted) return adapterError('render_unsupported', 'renderer creation previously failed (no canvas renderer in this environment)');
    const canvas = this.canvas;
    if (typeof canvas?.getContext !== 'function') {
      this.attempted = true;
      return adapterError('canvas_invalid', 'canvas argument is missing or does not expose getContext()');
    }
    this.attempted = true;
    const opts = this.opts;
    try {
      const handle = createRenderer({
        canvas,
        preference: opts.renderer?.preference ?? DEFAULT_RENDERER_PREFERENCE,
        source: opts.renderer?.source ?? 'default',
        antialias: opts.antialias ?? true,
        powerPreference: 'high-performance',
        // Opaque black where nothing is drawn (what WebGLRenderer always cleared to).
        clearColor: 0x000000,
        clearAlpha: 1,
        // The game canvas is not drawn to again after dispose: free its WebGL context.
        loseContextOnDispose: true,
        ...(opts.renderer?.depthBuffer !== undefined ? { depthBuffer: opts.renderer.depthBuffer } : {}),
        ...(opts.renderer?.trackTimestamp === true ? { trackTimestamp: true } : {}),
        ...(opts.renderer?.deps !== undefined ? { deps: opts.renderer.deps } : {}),
      });
      this.handle = handle;
      const onChange = opts.renderer?.onChange;
      if (onChange !== undefined) handle.onChange(() => onChange(handle.info()));
      this.pixelRatio = renderPixelRatio(globalThis.window?.devicePixelRatio, this.host.pixelRatioCap());
      // Set up when it is ready (adopt): WebGPURenderer initialises asynchronously.
      return null;
    } catch {
      this.handle = null;
      this.backend = null;
      this.info = null;
      return adapterError('render_unsupported', 'renderer creation failed (non-browser environment or no WebGPU/WebGL 2)');
    }
  }

  /** A (re)created WebGPURenderer became ready: set it up, and what held the previous renderer is rebuilt. */
  adopt(handle: RendererHandle, r: AnyRenderer): void {
    if (handle.generation() === this.generation) return;
    this.generation = handle.generation();
    this.host.dropRendererState();
    r.setPixelRatio(this.pixelRatio);
    const inf = handle.info();
    this.backend = inf.api;
    const api = inf.api === 'webgpu' ? 'webgpu' : 'webgl2';
    this.info = `WebGPURenderer (${inf.api === 'webgpu' ? 'WebGPU' : 'WebGL 2'})`;
    this.host.adopted(r, api);
    // The depth buffer the renderer draws with (reversed Z falls back to standard without support).
    const depth = r as { reversedDepthBuffer?: boolean; logarithmicDepthBuffer?: boolean };
    const depthMode = depth.reversedDepthBuffer === true ? 'reversed' : depth.logarithmicDepthBuffer === true ? 'logarithmic' : 'standard';
    this.mark('data-tl-depth', depthMode);
    // Mesh decals take their fixed depth offset only with a standard depth buffer.
    setDecalDepthMode(depthMode);
  }

  /** The quality level's pixel-ratio cap changed. */
  setPixelRatioCap(cap: number): void {
    this.pixelRatio = renderPixelRatio(globalThis.window?.devicePixelRatio, cap);
    this.handle?.current()?.setPixelRatio(this.pixelRatio);
  }

  /** The live renderer (null: none yet, or disposed). */
  current(): AnyRenderer | null {
    return this.handle?.current() ?? null;
  }

  /** A renderer is still being made (the next frames may be skipped). */
  starting(): boolean {
    const h = this.handle;
    // No renderer yet: the next frame creates one, unless that was tried and failed.
    if (h === null) return !this.attempted && typeof this.canvas?.getContext === 'function';
    const state = h.info().state;
    return state !== 'failed' && state !== 'lost' && (h.current() === null || !h.ready());
  }

  /** The context listeners go; the renderer is disposed (its WebGL 2 backend drops its context). */
  dispose(): void {
    for (const release of this.releases) {
      try { release(); } catch { /* best effort */ }
    }
    this.releases.length = 0;
    this.contextLost = false;
  }

  disposeRenderer(): void {
    if (this.handle) {
      this.lastInfo = this.handle.info();
      try { this.handle.dispose(); } catch { /* best effort */ }
    }
    this.handle = null;
  }
}
