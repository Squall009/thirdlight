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
import {
  createModelsRealization,
  type ModelsRealization,
  type ModelsSettledResult,
  type SceneAdapterModelAsset,
  type SceneAdapterModels,
  type SceneAdapterModelsDiagnostics,
} from './models';
import type { GlbLoaderPort } from './visual';
import {
  ANIMATION_MAX_DELTA_SECONDS,
  type AnimationRoleView,
} from './animation';
import {
  decideShadows,
  deriveShadowCamera,
  planSceneLights,
  SHADOW_PROFILE,
  type AuthoredLight,
  type AuthoredSurface,
  type ShadowLevel,
  type ShadowPlan,
  type ShadowReason,
} from './lighting';

/** The runtime instance driving this scene (frame source + camera). */
export interface SceneAdapterOptions {
  runtime: Runtime;
  /** The runtime snapshot the runtime was instantiated from (read-only scene source). */
  snapshot: RuntimeSnapshot;
  /** Renderer antialiasing (default true). */
  antialias?: boolean;
  /** M4 (C64-4, delivery.md (M4) §2.2): the injected model surface — the
   *  resolved model-asset rows, the committed per-`modelAnimation`-entity
   *  mappings and the wrapper's verified-bytes resolver. Absent ⇒ the
   *  adapter behaves exactly as accepted today (byte-stable). Requires
   *  `modelsLoader` and a v3 snapshot (fail-fast `models_config_invalid`). */
  models?: SceneAdapterModels;
  /** M4 (C64-4): the injected GLB loader port (the wrapper builds it from
   *  the `@thirdlight/three-adapter/gltf-loader` subpath; the root subpath
   *  stays loader-free). Required iff `models` is present. */
  modelsLoader?: GlbLoaderPort;
}

/** Adapter diagnostics block (runtime.md §8, separate block; the M3
 * additions are presentation.md §41.1.4 — exactly two read-only fields). */
export interface SceneAdapterDiagnostics {
  /** The SELECTED render backend: `"webgl2"` | `"webgl1"`, or `null` when
   *  no backend has been selected yet (no successful render — e.g. a
   *  non-browser environment: the contract-prescribed absent value). */
  renderBackend: 'webgl2' | 'webgl1' | null;
  /** Renderer identity string, ≤ 128 chars (null until a backend exists). */
  rendererInfo: string | null;
  canvasSize: [number, number];
  pixelRatio: number;
  /** presentation.md §41.1.4 — the shadow realization result for the
   *  current scene. `on` is the planned/realized state; the first-render
   *  probe may flip it to `off` / `shadow_unsupported`. v1/v2 and scenes
   *  without a shadow-casting light are `off` / `cast_shadow_false` (the
   *  author's own choice — not an error). */
  shadows: 'on' | 'off';
  /** §41.1.4 — present iff `shadows === 'off'`; carries no path, token or
   *  device string. Recorded once per realized scene, never per frame. */
  shadowReason?: ShadowReason;
  /** M4 (C64-4, delivery.md (M4) §2.5) — the bounded model-realization
   *  counters block; ABSENT when the `models` option is absent (or after
   *  dispose). Counters only: no paths, tokens, asset IDs or byte lengths.
   */
  models?: SceneAdapterModelsDiagnostics;
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
  /** M4 (C64-4, delivery.md (M4) §2.8 step 10): present iff the `models`
   *  option was given. Resolves (never rejects) when the model prepares
   *  have settled — all ready, the first hard failure (§2.7 L2–L5), or the
   *  adapter disposed (§2.6). The wrapper posts `tl.ready` on `ok: true`
   *  and `tl.error` (phase `"assets"`) on `ok: false`. */
  modelsSettled?(): Promise<ModelsSettledResult>;
}

const DEFAULT_SCREENSHOT_MAX_WIDTH = 1024;
const RENDERER_INFO_LIMIT = 128;

/** Structural canvas surface (duck-typed: the adapter never assumes a
 *  real HTMLCanvasElement, so Node unit tests can pass a stub). */
interface CanvasLike {
  getContext?: (type: string, options?: unknown) => unknown;
  toDataURL?: (type?: string) => string;
  addEventListener?: (type: string, listener: (event: unknown) => void, options?: unknown) => void;
  removeEventListener?: (type: string, listener: (event: unknown) => void, options?: unknown) => void;
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

  // --- M3 (presentation.md §§41.1/41.2, packet 52): v3 detection, the
  // --- authored lights and the shadow decision ----------------------------
  // The snapshot is deep-frozen and runtime-validated; the adapter reads it
  // structurally and never re-validates (the runtime already did).
  const sceneDoc = opts.snapshot.scene;
  const isV3 = sceneDoc.schemaVersion === 3;
  const gameBlock = opts.snapshot.game;
  /** The §41.1.3 input bounds; required on every runtime-validated v3
   *  snapshot (`game.level`). The null fallback below is defensive only. */
  const level: ShadowLevel | null =
    isV3 && gameBlock !== null && gameBlock !== undefined ? gameBlock.level : null;
  const authoredLights: AuthoredLight[] = [];
  if (isV3) {
    for (const e of sceneDoc.entities) {
      const l = (e.components as { light?: AuthoredLight }).light;
      if (l) authoredLights.push(l);
    }
  }
  const keyLight = isV3 ? (authoredLights.find((l) => l.type === 'directional') ?? null) : null;
  /** The planned shadow outcome (probeOk: true — the capability probe runs
   *  at the first render; the webgl2 requirement is enforced at renderer
   *  creation, where a WebGL-1 context for a v3 scene is a hard
   *  `render_unsupported`). */
  const planned = decideShadows({
    webgl2: true,
    castShadow: keyLight?.castShadow === true,
    probeOk: true,
    level: level ?? { minX: 0, maxX: 0, minY: 0, maxY: 0 },
    direction: keyLight?.direction ?? [0, -1, 0],
  });
  // `planned` always resolves `ok: true` here (webgl2: true) — the hard
  // outcome is unreachable on this planning path.
  const keyPlan: ShadowPlan = planned.ok ? planned.plan : deriveShadowCamera(
    level ?? { minX: 0, maxX: 0, minY: 0, maxY: 0 },
    keyLight?.direction ?? [0, -1, 0],
  );
  /** The current shadow realization state; recorded once per realized
   *  scene (never per frame) — the bounded §41.1.4 diagnostic. */
  let shadowState: { shadows: 'on' | 'off'; reason?: ShadowReason } =
    planned.ok && planned.shadows === 'on'
      ? { shadows: 'on' }
      : { shadows: 'off', reason: planned.ok ? planned.shadowReason : 'cast_shadow_false' };
  let shadowProbeDone = false;

  // --- scene graph construction (fixed M1 table; read-only over the
  // --- (deep-frozen, normalized) snapshot) ---------------------------------
  for (const e of opts.snapshot.scene.entities) {
    const t = e.components.transform;
    let obj: THREE.Object3D;
    const box = e.components.box;
    const cam = e.components.camera;
    if (box) {
      // Box primitive: unit-axis geometry sized by `size`; the
      // transform's `scale` multiplies on top per frame (§6).
      const geometry = new THREE.BoxGeometry(box.size[0], box.size[1], box.size[2]);
      // §41.2.3 (packet 52): an entity carrying `surface` gets ONE
      // material instance created per entity placement — owned by that
      // entity's mesh instance (value-level independence; the per-placement
      // instance is by construction). No preset lookup: the values are
      // taken literally from the `surface` component. No `surface` ⇒ the
      // M1 Lambert path, unchanged.
      const surface = (e.components as { surface?: AuthoredSurface }).surface;
      const material: THREE.Material = surface
        ? new THREE.MeshStandardMaterial({
            color: new THREE.Color(surface.color),
            roughness: surface.roughness,
            metalness: surface.metalness,
            emissive: new THREE.Color(surface.emissive),
            emissiveIntensity: surface.emissiveIntensity,
          })
        : new THREE.MeshLambertMaterial({ color: new THREE.Color(box.material.color) });
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
  // Realized lights. M1 path (v1/v2): the accepted fixed pair, unchanged
  // (presentation.md §41.10). M3 path (v3): the authored lights — exactly
  // one directional node and one ambient node per realized scene
  // (§41.1.2 rule 4; the model caps both at 1). The light entities' own
  // `transform` is irrelevant (rule 3): only the component value is read.
  const keyLights: THREE.DirectionalLight[] = [];
  if (!isV3) {
    // Simple M1 lighting for the Lambert material (charter first-release
    // item; no shadow pipeline in M1): one directional + one ambient.
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
    dirLight.position.set(0.5, 1, 0.8);
    const ambient = new THREE.AmbientLight(0xffffff, 0.55);
    scene.add(dirLight);
    scene.add(ambient);
  } else {
    for (const plannedLight of planSceneLights(authoredLights, level, planned)) {
      if (plannedLight.kind === 'ambient') {
        // §41.1.2 rule 1: no shadow, no position dependence; the
        // intensity is used exactly as authored.
        scene.add(new THREE.AmbientLight(new THREE.Color(plannedLight.color), plannedLight.intensity));
      } else {
        // §41.1.2 rule 2: the derived position `target − n ·
        // SHADOW_DISTANCE` and the derived target (the shadow centre) —
        // always derived, shadow state or not.
        const light = new THREE.DirectionalLight(new THREE.Color(plannedLight.color), plannedLight.intensity);
        light.position.set(plannedLight.position[0], plannedLight.position[1], plannedLight.position[2]);
        light.target.position.set(plannedLight.target[0], plannedLight.target[1], plannedLight.target[2]);
        if (plannedLight.castShadow) {
          // The shadow-camera parameters are set now; the shadow map is
          // allocated only by the first-render probe (§41.1.4 rule 5).
          light.castShadow = true;
          light.shadow.mapSize.set(SHADOW_PROFILE.mapSize, SHADOW_PROFILE.mapSize);
          light.shadow.camera.left = keyPlan.camera.left;
          light.shadow.camera.right = keyPlan.camera.right;
          light.shadow.camera.top = keyPlan.camera.top;
          light.shadow.camera.bottom = keyPlan.camera.bottom;
          light.shadow.camera.near = keyPlan.camera.near;
          light.shadow.camera.far = keyPlan.camera.far;
          light.shadow.camera.updateProjectionMatrix();
        }
        scene.add(light);
        scene.add(light.target);
        keyLights.push(light);
      }
    }
  }

  // --- M4 (C64-4, delivery.md (M4) §2): the model realization ------------
  // The holders (the `objects` map entries) exist now; the prepared
  // ModelInstance roots attach as their children. The realization is
  // created lazily when `models` is present (absent ⇒ byte-stable M1/M2/
  // M3 behavior — the accepted path is untouched). Fail-fast config
  // validation (§2.2) surfaces through `modelsSettled` + the structured
  // result; the base scene keeps rendering (degraded, never a throw).
  let realization: ModelsRealization | null = null;
  let modelsConfigError: AdapterError | null = null;
  if (opts.models !== undefined) {
    // Structural reads over the (deep-frozen, runtime-validated) snapshot —
    // the adapter never re-validates (the runtime already did).
    const modelEntities = new Map<string, string>();
    const modelAnimationEntities = new Map<string, { readonly assetId: string; readonly version: number }>();
    for (const e of opts.snapshot.scene.entities) {
      const comps = e.components as { model?: { asset?: { assetId?: unknown } }; modelAnimation?: { assetId?: unknown; version?: unknown } };
      if (comps.model !== undefined && typeof comps.model.asset?.assetId === 'string') {
        modelEntities.set(e.id, comps.model.asset.assetId);
      }
      if (comps.modelAnimation !== undefined && typeof comps.modelAnimation.assetId === 'string') {
        const version = comps.modelAnimation.version;
        if (Number.isInteger(version)) modelAnimationEntities.set(e.id, { assetId: comps.modelAnimation.assetId, version: version as number });
      }
    }
    const playerId = isV3 && opts.snapshot.game !== null && opts.snapshot.game !== undefined
      ? (opts.snapshot.game as { playerId?: unknown }).playerId
      : undefined;
    const hasPlayer = typeof playerId === 'string';
    const neutralMotion = { speed: 0, grounded: true } as const;
    // The committed view accessor (delivery.md (M4) §2.4 / presentation.md
    // §41.3.6 rule 7 clarification): the player's own animated model gets
    // the committed `playerMotion` (full idle/run/airborne selection);
    // every NON-player animated entity gets the constant neutral motion
    // (the accepted pure selector then yields `idle` — no blending, no
    // run/airborne). `null` pre-commit (no committed view yet): the
    // controller idles. The selector reads the committed view only (rule 1).
    const viewFor = (entityId: string): AnimationRoleView | null => {
      const getGameView = (opts.runtime as { getGameView?: () => { ok: true; view: { stepIndex?: unknown; playerMotion?: { speed?: unknown; grounded?: unknown } } } }).getGameView;
      if (typeof getGameView !== 'function') return null;
      let view: { ok: true; view: { stepIndex?: unknown; playerMotion?: { speed?: unknown; grounded?: unknown } } };
      try {
        view = getGameView.call(opts.runtime);
      } catch {
        return null;
      }
      if (view === null || typeof view !== 'object' || view.ok !== true || typeof view.view !== 'object') return null;
      const stepIndex = typeof view.view.stepIndex === 'number' && Number.isFinite(view.view.stepIndex) ? Math.trunc(view.view.stepIndex) : 0;
      if (hasPlayer && playerId === entityId) {
        const pm = view.view.playerMotion;
        return {
          stepIndex,
          playerMotion: {
            speed: typeof pm?.speed === 'number' && Number.isFinite(pm.speed) ? pm.speed : 0,
            grounded: pm?.grounded !== false,
          },
        };
      }
      return { stepIndex, playerMotion: { speed: neutralMotion.speed, grounded: neutralMotion.grounded } };
    };
    const result = createModelsRealization({
      schemaVersion: sceneDoc.schemaVersion,
      models: opts.models,
      loader: opts.modelsLoader,
      modelEntities,
      modelAnimationEntities,
      holderFor: (entityId: string) => objects.get(entityId) ?? null,
      viewFor,
    });
    if (result.ok === true) {
      realization = result.realization;
    } else {
      modelsConfigError = result.error;
    }
  }

  // --- renderer state (lazy: created on the first successful render) ---
  const canvasLike = canvas as CanvasLike | null;
  let renderBackend: 'webgl2' | 'webgl1' | null = null;
  let rendererInfo: string | null = null;
  let pixelRatio = 1;
  let contextAttempted = false;
  let contextLost = false;
  let disposed = false;
  /** M4 (C64-4): the previous frame's `performance.now()` for the clamped
   *  role-controller delta (the adapter derives `deltaSeconds` from the
   *  host clock, guarded — §2.4). The first frame uses 0 (a fresh anchor
   *  after mount/suspend/resume: no fast-forward). */
  let lastFrameNow: number | null = null;
  /** Releases of the WebGL context listeners this adapter owns (packet 26). */
  const contextListenerReleases: Array<() => void> = [];

  // Packet 26: observe the WebGL context lifecycle of the canvas this adapter
  // renders into. Loss is reported as a structured `render_context_lost` (no
  // render into a dead context); three.js re-initializes its own GL state on
  // restoration and this adapter clears the flag. The adapter owns exactly
  // these two listeners and releases them in dispose().
  if (typeof canvasLike?.addEventListener === 'function') {
    const onLost = (event: unknown): void => {
      contextLost = true;
      const e = event as { preventDefault?: () => void } | null;
      if (typeof e?.preventDefault === 'function') e.preventDefault();
    };
    const onRestored = (): void => {
      contextLost = false;
    };
    canvasLike.addEventListener('webglcontextlost', onLost, false);
    canvasLike.addEventListener('webglcontextrestored', onRestored, false);
    contextListenerReleases.push(
      () => canvasLike.removeEventListener?.('webglcontextlost', onLost, false),
      () => canvasLike.removeEventListener?.('webglcontextrestored', onRestored, false),
    );
  }

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
      // §41.1.4 (hard, packet 52): the M3 target is WebGL 2 (baseline.md
      // §1). A WebGL-1 context for a v3 scene is the unplayable
      // `render_unsupported` case; the accepted M1/M2 webgl1 fallback is
      // unchanged for v1/v2 scenes.
      if (renderBackend === 'webgl1' && isV3) {
        try {
          owned.renderer.dispose();
        } catch {
          /* best effort */
        }
        try {
          owned.renderer.forceContextLoss();
        } catch {
          /* best effort */
        }
        owned.renderer = null;
        renderBackend = null;
        rendererInfo = null;
        return adapterError(
          'render_unsupported',
          'M3 (v3) scenes require WebGL 2; the selected context is WebGL 1 (presentation.md §41.1.4)',
        );
      }
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

  // The active checkpoint shows its authored activation look
  // (`gameZone.activation`: emissive color + intensity); the look reverts
  // when the checkpoint is no longer active (e.g. a replay).
  let shownCheckpoint: string | null = null;
  const activationOf = (id: string): { emissive: string; emissiveIntensity: number } | null => {
    const e = opts.snapshot.scene.entities.find((x) => x.id === id);
    const act = (e?.components as { gameZone?: { activation?: { emissive?: unknown; emissiveIntensity?: unknown } } } | undefined)?.gameZone?.activation;
    if (act === undefined || typeof act.emissive !== 'string') return null;
    return { emissive: act.emissive, emissiveIntensity: typeof act.emissiveIntensity === 'number' ? act.emissiveIntensity : 1 };
  };
  const setActivation = (id: string, look: { emissive: string; emissiveIntensity: number } | null): void => {
    objects.get(id)?.traverse((o) => {
      const mat = (o as THREE.Mesh).material as (THREE.Material & { emissive?: THREE.Color; emissiveIntensity?: number }) | undefined;
      if (mat === undefined || Array.isArray(mat) || mat.emissive === undefined) return;
      if (mat.userData.baseEmissive === undefined) {
        mat.userData.baseEmissive = mat.emissive.getHex();
        mat.userData.baseEmissiveIntensity = mat.emissiveIntensity ?? 1;
      }
      if (look === null) {
        mat.emissive.setHex(mat.userData.baseEmissive as number);
        mat.emissiveIntensity = mat.userData.baseEmissiveIntensity as number;
      } else {
        mat.emissive.set(look.emissive);
        mat.emissiveIntensity = look.emissiveIntensity;
      }
    });
  };
  const syncCheckpointLook = (): void => {
    const getGameView = (opts.runtime as { getGameView?: () => { ok: boolean; view?: { checkpointId?: string | null } } }).getGameView;
    if (typeof getGameView !== 'function') return;
    let active: string | null = null;
    try {
      const gv = getGameView.call(opts.runtime);
      active = gv.ok ? (gv.view?.checkpointId ?? null) : null;
    } catch {
      return;
    }
    if (active === shownCheckpoint) return;
    if (shownCheckpoint !== null) setActivation(shownCheckpoint, null);
    if (active !== null) {
      const look = activationOf(active);
      if (look !== null) setActivation(active, look);
    }
    shownCheckpoint = active;
  };

  function renderFrame(): { ok: true } | { ok: false; error: AdapterError } {
    if (disposed) return { ok: false, error: adapterError('adapter_disposed', 'adapter is disposed') };
    if (contextLost) {
      // The context is currently lost: render nothing (three.js re-initializes
      // its own GL state on `webglcontextrestored`, which clears this flag).
      return {
        ok: false,
        error: adapterError('render_context_lost', 'the WebGL context is lost; the frame was not rendered and the context will be restored by the browser'),
      };
    }
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
    syncCheckpointLook();
    // M4 (C64-4, delivery.md (M4) §2.4): one host-driven update per
    // rendered frame, in this order — (1) the transform sync above
    // (unchanged), (2) every live role controller advanced once with the
    // real frame delta CLAMPED to the accepted [0, 0.25] range (first
    // frame after mount or after a suspend/resume: a fresh anchor — the
    // host's frame-time reset makes a resume a fresh anchor; the clamp is
    // the adapter-side bound, no fast-forward), (3) `renderer.render`
    // (below). The controllers install no rAF, no timer, no mixer
    // listener — there is no second loop (C13 ruled out by construction).
    if (realization !== null) {
      let delta = 0;
      const perf = globalThis.performance;
      if (perf !== undefined && typeof perf.now === 'function') {
        const now = perf.now();
        if (lastFrameNow !== null && Number.isFinite(now) && Number.isFinite(lastFrameNow) && now >= lastFrameNow) {
          delta = (now - lastFrameNow) / 1000;
        }
        lastFrameNow = now;
      }
      // The accepted clamp (presentation.md §41.7.1 / rule 2:
      // 0 ≤ deltaSeconds ≤ 0.25).
      if (!Number.isFinite(delta) || delta < 0) delta = 0;
      if (delta > ANIMATION_MAX_DELTA_SECONDS) delta = ANIMATION_MAX_DELTA_SECONDS;
      realization.update(delta);
    }
    const renderer = owned.renderer;
    if (!renderer) return { ok: false, error: adapterError('render_failed', 'renderer unavailable') };
    // §41.1.4 shadow capability probe (packet 52): once per realized
    // scene, before the first successful v3 frame. The probe render is the
    // allocation check (`maxTextureSize ≥ SHADOW_MAP_SIZE` + the actual
    // render). A failure degrades SOFT — shadows off, rendering continues
    // with the key light only, and the bounded diagnostic is the
    // `shadows`/`shadowReason` pair itself (recorded once, never per
    // frame; no path, token or device string). A scene with no
    // shadow-casting light never enables `shadowMap` (rule 5: no shadow
    // map is allocated).
    if (shadowState.shadows === 'on' && isV3 && !shadowProbeDone) {
      shadowProbeDone = true;
      let probeOk = renderer.capabilities.maxTextureSize >= SHADOW_PROFILE.mapSize;
      if (probeOk) {
        try {
          renderer.shadowMap.enabled = true;
          // §41.1.2: three's `THREE.PCFShadowMap` (the frozen profile row).
          renderer.shadowMap.type = THREE.PCFShadowMap;
          renderer.render(scene, camera!);
        } catch {
          probeOk = false;
        }
      }
      if (!probeOk) {
        try {
          renderer.shadowMap.enabled = false;
        } catch {
          /* best effort */
        }
        for (const l of keyLights) l.castShadow = false;
        shadowState = { shadows: 'off', reason: 'shadow_unsupported' };
      }
    }
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
    const d: SceneAdapterDiagnostics = {
      renderBackend,
      rendererInfo,
      canvasSize: canvasSize(),
      pixelRatio,
      shadows: shadowState.shadows,
    };
    // §41.1.4: `shadowReason` is present iff `shadows === 'off'`.
    if (shadowState.shadows === 'off' && shadowState.reason !== undefined) {
      d.shadowReason = shadowState.reason;
    }
    // M4 (C64-4): the `models` counters block — present iff the `models`
    // option was given and the adapter is not disposed (absent when
    // `models` is absent; after dispose the realization is gone).
    if (realization !== null && !disposed) {
      d.models = realization.counters();
    }
    return {
      ok: true,
      diagnostics: d,
    };
  }

  function dispose(): { ok: true; alreadyDisposed?: true } | { ok: false; error: AdapterError } {
    if (disposed) return { ok: true, alreadyDisposed: true };
    disposed = true;
    // M4 (C64-4, delivery.md (M4) §2.6): tear down the model realization
    // FIRST — cancel every in-flight prepare, dispose the attached
    // instances (cloned materials + controllers + instances) and the
    // store (a late completion is discarded and released, never applied).
    if (realization !== null) {
      try {
        realization.dispose();
      } catch {
        /* best effort */
      }
      realization = null;
      lastFrameNow = null;
    }
    // Release ALL owned Object3D/material/renderer lifetimes (runtime.md
    // §3.4-style repeatable disposal; m1-acceptance step 8: "no leaked
    // loop, no stale GPU state").
    for (const release of contextListenerReleases) {
      try { release(); } catch { /* best effort */ }
    }
    contextListenerReleases.length = 0;
    contextLost = false;
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

  const api: SceneAdapter = { renderFrame, captureScreenshot, diagnostics, dispose };
  // M4 (C64-4): the settle surface — present iff the `models` option was
  // given. A config-invalid block resolves the structured failure (the
  // wrapper posts `tl.error`); a realized block resolves when every
  // prepare has settled (§2.8 step 10). Never rejects.
  if (opts.models !== undefined) {
    api.modelsSettled = (): Promise<ModelsSettledResult> => {
      if (realization !== null) return realization.settled();
      if (modelsConfigError !== null) {
        return Promise.resolve({ ok: false as const, code: modelsConfigError.code, message: modelsConfigError.message });
      }
      // Defensive: `models` present but no realization/config error (e.g.
      // disposed before the realization attached) — structured, honest.
      return Promise.resolve({ ok: false as const, code: 'adapter_disposed', message: 'the adapter carries no live model realization' });
    };
  }
  return api;
}