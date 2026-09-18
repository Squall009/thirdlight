/**
 * Three.js scene adapter — packet 08 (runtime.md §6 frame ordering,
 * §8 adapter diagnostics, §9 environment; dependencies.md §3 surface row:
 * `createSceneAdapter(canvas, opts) → SceneAdapter { renderFrame,
 * captureScreenshot(maxWidth), diagnostics, dispose }`, `ERROR_CODES`).
 *
 * The adapter owns ALL Object3D/material/renderer lifetimes for the M1
 * scene graph: box primitives (unit-geometry scaled by `size`, simple
 * Lambert material from `material.color`), one perspective camera
 * (project-model §10.3: exactly one camera entity), and a fixed M1
 * component→Object3D table (no registration API — dependencies.md §6
 * non-goal). One renderer path, consistent with the accepted stack:
 * the three.js WebGL renderer, WebGL 2 first (decision 0001 §3;
 * runtime.md §8: the SELECTED backend is reported in diagnostics — no
 * WebGPU, no feature-equivalence promises).
 *
 * Frame ordering (normative, runtime.md §6): the RUNTIME owns the single
 * frame driver; `renderFrame` runs as the runtime's `onFrame` — after
 * the step update it reads `getInterpolatedState()`, copies the values
 * into Object3Ds, and renders. The adapter never installs its own
 * animation loop (one loop owner = the runtime).
 *
 * `createSceneAdapter` never throws: WebGL context creation is deferred
 * to the first `renderFrame`; in non-browser environments the structured
 * `render_unsupported`/`canvas_invalid` results and the
 * `renderBackend: null` diagnostics value are reported (the absent
 * backend), never a throw.
 */
import * as THREE from 'three';
import type { Runtime, RuntimeSnapshot } from '@thirdlight/runtime';
import { adapterError, type AdapterError } from './errors';
import { applyTransformToObject3D, type AdapterQuat, type AdapterVec3 } from './sync';

/** The runtime instance driving this scene (frame source + camera). */
export interface SceneAdapterOptions {
  runtime: Runtime;
  /** The runtime snapshot the runtime was instantiated from (read-only scene source). */
  snapshot: RuntimeSnapshot;
  /** Renderer antialiasing (default true). */
  antialias?: boolean;
}

/** Adapter diagnostics block (runtime.md §8, separate block). */
export interface SceneAdapterDiagnostics {
  /** The SELECTED render backend: `"webgl2"` | `"webgl1"`, or `null` when
   *  no backend has been selected yet (no successful render — e.g. a
   *  non-browser environment: the contract-prescribed absent value). */
  renderBackend: 'webgl2' | 'webgl1' | null;
  /** Renderer identity string, ≤ 128 chars (null until a backend exists). */
  rendererInfo: string | null;
  canvasSize: [number, number];
  pixelRatio: number;
}

export interface ScreenshotResult {
  /** Base64 PNG data URL (same-origin canvas). */
  dataUrl: string;
  width: number;
  height: number;
  /** Approximate decoded PNG byte size (for the ≤ 1 MiB session bound). */
  byteSize: number;
}

export interface SceneAdapter {
  /** Sync interpolated transforms into the scene graph and render one
   *  frame. Runs as the runtime's `onFrame` (step → sync → render). */
  renderFrame(): { ok: true } | { ok: false; error: AdapterError };
  /** Capture a bounded PNG (width ≤ `maxWidth`, default 1024). */
  captureScreenshot(maxWidth?: number): { ok: true; result: ScreenshotResult } | { ok: false; error: AdapterError };
  diagnostics(): { ok: true; diagnostics: SceneAdapterDiagnostics } | { ok: false; error: AdapterError };
  /** Idempotent (mirrors runtime.md §3.4): second call ⇒
   *  `{ ok: true, alreadyDisposed: true }`. */
  dispose(): { ok: true; alreadyDisposed?: true } | { ok: false; error: AdapterError };
}

const DEFAULT_SCREENSHOT_MAX_WIDTH = 1024;
const RENDERER_INFO_LIMIT = 128;

/** Structural canvas surface (duck-typed: the adapter never assumes a
 *  real HTMLCanvasElement, so Node unit tests can pass a stub). */
interface CanvasLike {
  getContext?: (type: string, options?: unknown) => unknown;
  toDataURL?: (type?: string) => string;
  clientWidth?: number;
  clientHeight?: number;
  width?: number;
  height?: number;
}

interface OwnedResources {
  geometries: THREE.BufferGeometry[];
  materials: THREE.Material[];
  renderer: THREE.WebGLRenderer | null;
}

export function createSceneAdapter(canvas: unknown, opts: SceneAdapterOptions): SceneAdapter {
  const scene = new THREE.Scene();
  const objects = new Map<string, THREE.Object3D>();
  const owned: OwnedResources = { geometries: [], materials: [], renderer: null };
  let camera: THREE.PerspectiveCamera | null = null;

  // --- scene graph construction (fixed M1 table; read-only over the
  // --- (deep-frozen, normalized) snapshot) -------------------------------
  for (const e of opts.snapshot.scene.entities) {
    const t = e.components.transform;
    let obj: THREE.Object3D;
    const box = e.components.box;
    const cam = e.components.camera;
    if (box) {
      // Box primitive: unit-axis geometry sized by `size`; the
      // transform's `scale` multiplies on top per frame (§6).
      const geometry = new THREE.BoxGeometry(box.size[0], box.size[1], box.size[2]);
      const material = new THREE.MeshLambertMaterial({ color: new THREE.Color(box.material.color) });
      owned.geometries.push(geometry);
      owned.materials.push(material);
      obj = new THREE.Mesh(geometry, material);
    } else if (cam) {
      // The single M1 camera (project-model §10.3). Aspect is a
      // viewport property — updated per frame from the canvas size.
      camera = new THREE.PerspectiveCamera(cam.fovY, 1, cam.near, cam.far);
      obj = camera;
    } else {
      obj = new THREE.Group();
    }
    objects.set(e.id, obj);
    const parent = e.parentId ? objects.get(e.parentId) : undefined;
    (parent ?? scene).add(obj);
    applyTransformToObject3D(obj, t.position, t.rotation, t.scale);
  }
  if (!camera) {
    // Unreachable for a runtime-validated snapshot (validateScene
    // guarantees exactly one camera) — fail closed anyway.
    camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    scene.add(camera);
  }
  // Simple M1 lighting for the Lambert material (charter first-release
  // item; no shadow pipeline in M1): one directional + one ambient.
  const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
  dirLight.position.set(0.5, 1, 0.8);
  const ambient = new THREE.AmbientLight(0xffffff, 0.55);
  scene.add(dirLight);
  scene.add(ambient);

  // --- renderer state (lazy: created on the first successful render) ---
  const canvasLike = canvas as CanvasLike | null;
  let renderBackend: 'webgl2' | 'webgl1' | null = null;
  let rendererInfo: string | null = null;
  let pixelRatio = 1;
  let contextAttempted = false;
  let disposed = false;

  function canvasSize(): [number, number] {
    const w = Math.max(1, Math.floor(canvasLike?.clientWidth ?? canvasLike?.width ?? 0));
    const h = Math.max(1, Math.floor(canvasLike?.clientHeight ?? canvasLike?.height ?? 0));
    return [w, h];
  }

  function ensureRenderer(): AdapterError | null {
    if (disposed) return adapterError('adapter_disposed', 'adapter is disposed');
    if (owned.renderer) return null;
    if (contextAttempted) {
      return adapterError('render_unsupported', 'WebGL context creation previously failed (no WebGL in this environment)');
    }
    if (typeof canvasLike?.getContext !== 'function') {
      contextAttempted = true;
      return adapterError('canvas_invalid', 'canvas argument is missing or does not expose getContext()');
    }
    contextAttempted = true;
    try {
      // One renderer path (three.js WebGL renderer; WebGL 2 first).
      const renderer = new THREE.WebGLRenderer({
        canvas: canvasLike as unknown as HTMLCanvasElement,
        antialias: opts.antialias ?? true,
        powerPreference: 'high-performance',
      });
      owned.renderer = renderer;
      const win = globalThis.window;
      const dpr = win && typeof win.devicePixelRatio === 'number' && win.devicePixelRatio > 0 ? win.devicePixelRatio : 1;
      pixelRatio = dpr;
      renderer.setPixelRatio(pixelRatio);
      renderBackend = renderer.capabilities.isWebGL2 ? 'webgl2' : 'webgl1';
      // `debug.rendererName` exists on the three.js runtime but not on the
      // pinned @types/three 0.186.0 WebGLDebug type — narrow access.
      const dbg = renderer.debug as { rendererName?: string };
      const name = typeof dbg.rendererName === 'string' ? dbg.rendererName : '';
      rendererInfo =
        name.length > 0 ? name.slice(0, RENDERER_INFO_LIMIT) : renderBackend === 'webgl2' ? 'WebGL 2.0 (OpenGL ES 3.0)' : 'WebGL 1.0 (OpenGL ES 2.0)';
      return null;
    } catch {
      owned.renderer = null;
      renderBackend = null;
      rendererInfo = null;
      return adapterError('render_unsupported', 'WebGL context creation failed (non-browser environment or WebGL unsupported)');
    }
  }

  function renderFrame(): { ok: true } | { ok: false; error: AdapterError } {
    const err = ensureRenderer();
    if (err) return { ok: false, error: err };
    // The runtime is the single frame driver: this runs after the step
    // update (runtime.md §6 frame ordering: step → onFrame → render).
    const st = opts.runtime.getInterpolatedState();
    if (!st.ok) {
      return {
        ok: false,
        error: adapterError('render_failed', `runtime state unavailable: ${st.error.message}`),
      };
    }
    // Transform synchronization: copy the interpolated values into the
    // Object3Ds (no other transform math — §6).
    for (const tr of st.state.transforms) {
      const obj = objects.get(tr.id);
      if (obj) applyTransformToObject3D(obj, tr.position as AdapterVec3, tr.rotation as AdapterQuat, tr.scale as AdapterVec3);
    }
    const renderer = owned.renderer;
    if (!renderer) return { ok: false, error: adapterError('render_failed', 'renderer unavailable') };
    const [w, h] = canvasSize();
    renderer.setSize(w, h, false);
    camera!.aspect = w / h;
    camera!.updateProjectionMatrix();
    try {
      renderer.render(scene, camera!);
    } catch (e) {
      return { ok: false, error: adapterError('render_failed', `render failed: ${String(e)}`) };
    }
    return { ok: true };
  }

  function captureScreenshot(maxWidth: number = DEFAULT_SCREENSHOT_MAX_WIDTH):
    | { ok: true; result: ScreenshotResult }
    | { ok: false; error: AdapterError } {
    // Argument validation FIRST (before any render attempt — no side
    // effects on a bad argument; observable in Node-side tests where the
    // render itself would be `render_unsupported`). The session layer
    // passes integers per sessions.md §11.5 (default 1024, max 2048);
    // this is the adapter's defensive bound on its own argument.
    if (typeof maxWidth !== 'number' || !Number.isInteger(maxWidth) || maxWidth < 1) {
      return {
        ok: false,
        error: adapterError('screenshot_failed', 'captureScreenshot: maxWidth must be a positive integer (width bound)'),
      };
    }
    const frame = renderFrame();
    if (!frame.ok) return { ok: false, error: frame.error };
    if (typeof canvasLike?.toDataURL !== 'function') {
      return { ok: false, error: adapterError('screenshot_failed', 'canvas does not expose toDataURL()') };
    }
    let dataUrl: string;
    let w: number;
    let h: number;
    try {
      // Synchronous capture: the buffer is valid right after render()
      // within the same task (no preserveDrawingBuffer needed).
      dataUrl = canvasLike.toDataURL('image/png');
      w = Math.max(1, Math.floor(canvasLike.width ?? 0));
      h = Math.max(1, Math.floor(canvasLike.height ?? 0));
      if (w > maxWidth && typeof document !== 'undefined' && typeof document.createElement === 'function') {
        // Downscale to ≤ maxWidth (session bound: sessions.md §11.5).
        const off = document.createElement('canvas');
        const scale = maxWidth / w;
        off.width = maxWidth;
        off.height = Math.max(1, Math.round(h * scale));
        const ctx2d = off.getContext('2d');
        if (ctx2d) {
          ctx2d.drawImage(canvasLike as unknown as CanvasImageSource, 0, 0, off.width, off.height);
          dataUrl = off.toDataURL('image/png');
          w = off.width;
          h = off.height;
        }
      }
    } catch {
      return { ok: false, error: adapterError('screenshot_failed', 'PNG capture failed') };
    }
    const prefix = 'data:image/png;base64,';
    const b64 = dataUrl.startsWith(prefix) ? dataUrl.slice(prefix.length) : dataUrl;
    const byteSize = Math.floor((b64.length / 4) * 3);
    return { ok: true, result: { dataUrl, width: w, height: h, byteSize } };
  }

  function diagnostics(): { ok: true; diagnostics: SceneAdapterDiagnostics } | { ok: false; error: AdapterError } {
    // Works after dispose too (reports the last known backend or null) —
    // the session layer composes this block for the play relay
    // (sessions.md §12; runtime.md §8 adapter block).
    return {
      ok: true,
      diagnostics: { renderBackend, rendererInfo, canvasSize: canvasSize(), pixelRatio },
    };
  }

  function dispose(): { ok: true; alreadyDisposed?: true } | { ok: false; error: AdapterError } {
    if (disposed) return { ok: true, alreadyDisposed: true };
    disposed = true;
    // Release ALL owned Object3D/material/renderer lifetimes (runtime.md
    // §3.4-style repeatable disposal; m1-acceptance step 8: "no leaked
    // loop, no stale GPU state").
    for (const g of owned.geometries) {
      try { g.dispose(); } catch { /* best effort */ }
    }
    for (const m of owned.materials) {
      try { m.dispose(); } catch { /* best effort */ }
    }
    if (owned.renderer) {
      try { owned.renderer.dispose(); } catch { /* best effort */ }
      try { owned.renderer.forceContextLoss(); } catch { /* best effort */ }
    }
    owned.geometries = [];
    owned.materials = [];
    owned.renderer = null;
    scene.clear();
    objects.clear();
    camera = null;
    return { ok: true };
  }

  return { renderFrame, captureScreenshot, diagnostics, dispose };
}