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
 * non-goal). One renderer path: three's WebGPURenderer from the renderer
 * factory — WebGPU where it starts, else its WebGL 2 backend (phase 17.4;
 * runtime.md §8: the SELECTED backend is reported in diagnostics).
 *
 * Frame ordering (normative, runtime.md §6): the RUNTIME owns the single
 * frame driver; `renderFrame` runs as the runtime's `onFrame` — after
 * the step update it reads `getInterpolatedState()`, copies the values
 * into Object3Ds, and renders. The adapter never installs its own
 * animation loop (one loop owner = the runtime).
 *
 * `createSceneAdapter` never throws: renderer creation is deferred
 * to the first `renderFrame`; in non-browser environments the structured
 * `render_unsupported`/`canvas_invalid` results and the
 * `renderBackend: null` diagnostics value are reported (the absent
 * backend), never a throw.
 */
import type { MaterialFunctionLike } from './material-graph';
import { createMaterialLibrary, MATERIAL_NO_SHADOW_KEY, type MaterialDefLike, type MaterialLibrary, type MaterialOverridesLike, type WindLike } from './material-library';
import { createAnimatorPlayer, type AnimatorPlayer, type AnimatorPoseLike } from './animator-player';
import { addBoxLightmapUv, createLightmapSet, type LightingBakeLike, type LightmapSet } from './lightmaps';
import { setEmissiveLook } from './node-materials';
import { createEnvironmentRenderer, environmentHasLook, layerEnvironment, type EnvironmentLayerLike, type EnvironmentLike, type EnvironmentRenderer, type FogVolumeLike, type QualityLevel } from './environment';
import * as THREE from 'three';
import type { Runtime, RuntimeSnapshot } from '@thirdlight/runtime';
import { adapterError, type AdapterError } from './errors';
import { applyTransformToObject3D, type AdapterQuat, type AdapterVec3 } from './sync';
import {
  createModelsRealization,
  type InstanceSetRef,
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
  directionalShadowSettings,
  planSceneLights,
  SHADOW_PROFILE,
  type AuthoredLight,
  type AuthoredSurface,
  type ShadowLevel,
  type ShadowPlan,
  type ShadowReason,
} from './lighting';
import { createFadeTracker } from './fade';
import {
  createRenderer,
  DEFAULT_RENDERER_PREFERENCE,
  rendererMemory,
  type AnyRenderer,
  type RendererFactoryDeps,
  type RendererHandle,
  type RendererInfo,
  type RendererPreference,
  type RendererPreferenceSource,
} from './renderer-factory';

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
  /**
   * Phase 9.4: project materials (the manifest's), the wind, and the texture
   * decoder (bytes come from the wrapper's verified content). Absent: files
   * and boxes keep their own materials.
   */
  materials?: {
    readonly defs: readonly MaterialDefLike[];
    /** Phase 18.3: the material functions graph materials call (the manifest's). */
    readonly functions?: readonly MaterialFunctionLike[];
    readonly wind: WindLike | null;
    readonly loadTexture: (assetId: string) => Promise<THREE.Texture | null>;
  };
  /**
   * Phase 9.5: sky, fog, fog volumes and post-processing (the manifest's
   * environment). Absent: the scene renders as before.
   */
  environment?: {
    readonly value: EnvironmentLike;
    readonly loadTexture: (assetId: string) => Promise<THREE.Texture | null>;
    /** A player's quality setting (null = the environment's). */
    readonly quality?: QualityLevel | null;
  };
  /** Phase 9.6: the scenes' bakes (lightmaps; the manifest's `lighting`). */
  lighting?: {
    readonly bakes: Readonly<Record<string, LightingBakeLike>>;
    readonly loadTexture: (assetId: string) => Promise<THREE.Texture | null>;
  };
  /**
   * Phase 17.1: which renderer backend to use and where that choice came
   * from (the page's `?renderer=` flag, the project's `render_backend`
   * setting, or the default — see `resolveRendererPreference`). Absent: the
   * default (`auto`: WebGPU where it starts, else WebGL 2).
   */
  renderer?: {
    readonly preference: RendererPreference;
    readonly source: RendererPreferenceSource;
    /** Tests only: stubbed renderer constructors and WebGPU probe. */
    readonly deps?: Partial<RendererFactoryDeps>;
  };
}

/** Adapter diagnostics block (runtime.md §8, separate block; the M3
 * additions are presentation.md §41.1.4 — exactly two read-only fields). */
export interface SceneAdapterDiagnostics {
  /** The SELECTED graphics API: `"webgpu"` or `"webgl2"` (WebGPURenderer's
   *  backends; `"webgl1"` was the archived WebGL renderer's WebGL 1 fallback
   *  and is no longer produced), or `null` when no backend has been selected
   *  yet (no successful render — e.g. a non-browser environment, or
   *  WebGPURenderer still initialising: the contract-prescribed absent value). */
  renderBackend: 'webgl2' | 'webgl1' | 'webgpu' | null;
  /** Phase 17.1: the renderer choice — requested backend and its source, the
   *  backend that draws, its state and why (absent until a renderer was
   *  asked for, i.e. before the first render). */
  renderer?: RendererInfo;
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
  /** The renderer's live GPU resources (three's `renderer.info`); ABSENT
   *  until a renderer exists. Flat counts while a scene runs — growth means
   *  something is allocated per frame and never freed. */
  gpu?: { geometries: number; textures: number; programs: number };
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
  /** Phase 9.10: a player's quality setting (low/medium/high) over the environment's. */
  setQuality?(level: QualityLevel): void;
  /**
   * Phase 14.4: the playing level's look (sky, fog, post, wind) laid over the
   * project environment; null = the project environment. Needs the
   * `environment` option for sky/fog/post (the wrapper passes it whenever a
   * level has a look) and the `materials` option for wind.
   */
  setEnvironmentLayer?(layer: EnvironmentLayerLike | null): void;
  /**
   * Phase 14.5: draw the camera moved by an offset (m) from where the game
   * puts it — the title screen's background scene and pan; null = none.
   * Presentation only (the simulation's camera does not move).
   */
  setCameraOffset?(offset: readonly [number, number, number] | null): void;
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
  /** Phase 17.1: the renderer handle (the factory's); its renderer may be replaced after a loss. */
  renderer: RendererHandle | null;
}

/**
 * Phase 17.4: whether an entity's box, model or instance set casts and
 * receives the directional light's realtime shadow — its component's
 * `castShadow` / `receiveShadow`, true when absent (solid geometry blocks the
 * light and shows the shadows falling on it; project-model's descriptors).
 */
function shadowFlagsOf(components: unknown): { cast: boolean; receive: boolean } {
  const c = components as { box?: { castShadow?: unknown; receiveShadow?: unknown }; model?: { castShadow?: unknown; receiveShadow?: unknown }; instances?: { castShadow?: unknown; receiveShadow?: unknown } };
  const part = c.box ?? c.model ?? c.instances;
  return { cast: part?.castShadow !== false, receive: part?.receiveShadow !== false };
}

/** Phase 18.3: an entity's `materialParams` component (overrides of its graph materials' public parameters). */
function materialParamsOf(components: unknown): MaterialOverridesLike | null {
  const v = (components as { materialParams?: unknown } | undefined)?.materialParams;
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as MaterialOverridesLike) : null;
}

/** Set the shadow flags on every mesh under `root` (a model's meshes, an instance set's instanced meshes). */
function applyShadowFlags(root: THREE.Object3D, flags: { cast: boolean; receive: boolean }): void {
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh === true) {
      // Phase 18.3: a graph material whose output casts no shadow keeps it off (its flag is data too).
      if (o.userData[MATERIAL_NO_SHADOW_KEY] !== undefined) o.userData[MATERIAL_NO_SHADOW_KEY] = flags.cast;
      else o.castShadow = flags.cast;
      o.receiveShadow = flags.receive;
    }
  });
}

/** The model, animation and instance-set references of some entities (structural reads). */
function modelRefsOf(entities: readonly { id: string; components: unknown }[]): {
  models: Map<string, string>;
  pieces: Map<string, string>;
  animations: Map<string, { readonly assetId: string; readonly version: number }>;
  instances: Map<string, InstanceSetRef>;
} {
  const models = new Map<string, string>();
  const pieces = new Map<string, string>();
  const animations = new Map<string, { readonly assetId: string; readonly version: number }>();
  const instances = new Map<string, InstanceSetRef>();
  for (const e of entities) {
    const comps = e.components as {
      model?: { asset?: { assetId?: unknown }; piece?: unknown };
      modelAnimation?: { assetId?: unknown; version?: unknown };
      instances?: { asset?: { assetId?: unknown; piece?: unknown }; buffer?: unknown; count?: unknown };
    };
    if (comps.model !== undefined && typeof comps.model.asset?.assetId === 'string') {
      models.set(e.id, comps.model.asset.assetId);
      if (typeof comps.model.piece === 'string') pieces.set(e.id, comps.model.piece);
    }
    if (comps.modelAnimation !== undefined && typeof comps.modelAnimation.assetId === 'string' && Number.isInteger(comps.modelAnimation.version)) {
      animations.set(e.id, { assetId: comps.modelAnimation.assetId, version: comps.modelAnimation.version as number });
    }
    const inst = comps.instances;
    if (inst !== undefined && typeof inst.asset?.assetId === 'string' && typeof inst.buffer === 'string' && Number.isInteger(inst.count)) {
      const piece = typeof inst.asset.piece === 'string' ? inst.asset.piece : undefined;
      instances.set(e.id, { assetId: inst.asset.assetId, ...(piece !== undefined ? { piece } : {}), buffer: inst.buffer, count: inst.count as number });
    }
  }
  return { models, pieces, animations, instances };
}

export function createSceneAdapter(canvas: unknown, opts: SceneAdapterOptions): SceneAdapter {
  const scene = new THREE.Scene();
  // Phase 9.4: project materials (shared by boxes, models and instance sets), node materials (phase 17.4).
  /** The lightmap set once it exists (the library may report a change while it is still being set up). */
  let lightmapsLive: LightmapSet | null = null;
  const materialLibrary: MaterialLibrary | null =
    opts.materials !== undefined
      ? createMaterialLibrary({
          loadTexture: opts.materials.loadTexture,
          // Phase 17.3: a project material changed in place (a texture arrived): lightmapped
          // copies made before are clones and follow it (else they keep the texture-less look).
          onChange: () => lightmapsLive?.refresh(),
        })
      : null;
  if (materialLibrary !== null && opts.materials !== undefined) {
    materialLibrary.setMaterials(opts.materials.defs, opts.materials.functions ?? []);
    materialLibrary.setWind(opts.materials.wind);
  }
  const materialUndo = new Map<string, () => void>();
  /** Phase 9.6: lightmaps of the baked static objects; the lights a bake holds are not realtime. */
  const lightmaps: LightmapSet | null =
    opts.lighting !== undefined && Object.keys(opts.lighting.bakes).length > 0
      ? createLightmapSet(opts.lighting.bakes, opts.lighting.loadTexture, (ids) =>
          ids.some((id) => {
            const t = (entityDocs.get(id)?.components as { light?: { type?: string } } | undefined)?.light?.type;
            return t === 'ambient' || t === 'hemisphere';
          }),
        )
      : null;
  lightmapsLive = lightmaps;
  /** Phase 9.9: entities the runtime hides (collected, defeated). */
  const hiddenIds = new Set<string>();
  /** Phase 15.3: entities fading out (a defeated enemy with `defeat: "fade"`), drawn at the runtime's opacity. */
  const fades = createFadeTracker();
  /** Phase 9.7: the animator poses the runtime committed, played on the models. */
  const animatorPlayers = new Map<string, { instance: unknown; player: AnimatorPlayer }>();
  const applyAnimatorPoses = (): void => {
    const poses = (opts.runtime as { animatorPoses?: () => ReadonlyMap<string, AnimatorPoseLike> }).animatorPoses?.();
    if (poses === undefined || realization === null) return;
    for (const [id, rec] of [...animatorPlayers]) {
      const now = realization.instanceOf(id);
      if (!poses.has(id) || now === null || now.instance !== rec.instance) {
        rec.player.dispose();
        animatorPlayers.delete(id);
      }
    }
    for (const [id, pose] of poses) {
      let rec = animatorPlayers.get(id);
      if (rec === undefined) {
        const found = realization.instanceOf(id);
        if (found === null) continue;
        const rig = found.assetId;
        const r = realization;
        // Phase 14.6: clips of an animation-only asset marked "clips for" this model's asset.
        rec = { instance: found.instance, player: createAnimatorPlayer(found.instance.root, found.instance.animationClips(), rig, { clipsOf: (clipAssetId) => r.clipsOf(clipAssetId, rig) }) };
        animatorPlayers.set(id, rec);
      }
      rec.player.apply(pose);
    }
  };
  /** A light that stays out of realtime rendering: held by a bake (ambient/hemisphere always stay). */
  const bakedAway = (id: string | undefined, l: { type: string; mode?: string }): boolean =>
    l.mode === 'baked' && l.type !== 'ambient' && l.type !== 'hemisphere' && id !== undefined && lightmaps?.isBakedLight(id) === true;
  /** Phase 9.5: the environment renderer (created with the renderer). */
  let environmentRenderer: EnvironmentRenderer | null = null;
  /** The size last handed to the environment renderer (it rebuilds its post stack on a change). */
  let environmentSize: [number, number] | null = null;
  let playerQuality: QualityLevel | null = opts.environment?.quality ?? null;
  // Phase 14.5: the camera offset (title background/pan), and what was last
  // added so a camera the sync did not move this frame is not moved twice.
  let cameraOffset: [number, number, number] | null = null;
  let appliedOffset: { offset: [number, number, number]; at: [number, number, number] } | null = null;
  /** Phase 14.4: the playing level's look (null: the project environment). */
  let environmentLayer: EnvironmentLayerLike | null = null;
  /** What the renderer draws: the project environment with the level's look over it (null when nothing is drawn, as without an environment). */
  const effectiveEnvironment = (): EnvironmentLike | null => {
    const v = layerEnvironment(opts.environment?.value ?? null, environmentLayer);
    return environmentHasLook(v) ? v : null;
  };
  const fogVolumeIds = new Set<string>();
  const tmpWorld = new THREE.Vector3();
  const tmpSize = new THREE.Vector2();
  /** The fog volumes of the loaded scenes, in world space (entities may move). */
  const fogVolumesNow = (): FogVolumeLike[] => {
    const out: FogVolumeLike[] = [];
    for (const id of fogVolumeIds) {
      const obj = objects.get(id);
      const doc = entityDocs.get(id) as { components: { fogVolume?: { size: [number, number, number]; density: number; color: string; falloff?: number; heightFalloff?: number } } } | undefined;
      const fv = doc?.components.fogVolume;
      if (obj === undefined || fv === undefined || !obj.visible) continue;
      obj.getWorldPosition(tmpWorld);
      out.push({ center: [tmpWorld.x, tmpWorld.y, tmpWorld.z], size: fv.size, density: fv.density, color: fv.color, ...(fv.falloff !== undefined ? { falloff: fv.falloff } : {}), ...(fv.heightFalloff !== undefined ? { heightFalloff: fv.heightFalloff } : {}) });
    }
    return out;
  };
  /** Phase 9.5: point/spot lights casting shadows (the shadow map is enabled for them). */
  let localShadowLights = 0;
  /** Phase 9.5 (v4): a point, spot or hemisphere light for an entity (null otherwise, or when a bake holds it). */
  const localLightOf = (e: { id?: string; components: unknown }): THREE.Light | null => {
    const l = (e.components as { light?: { type: string; color: string; intensity: number; range?: number; decay?: number; angle?: number; penumbra?: number; direction?: readonly number[]; groundColor?: string; castShadow?: boolean; mode?: string } }).light;
    if (l === undefined || bakedAway(e.id, l)) return null;
    const colour = new THREE.Color(l.color);
    if (l.type === 'hemisphere') return new THREE.HemisphereLight(colour, new THREE.Color(l.groundColor ?? '#444444'), l.intensity);
    if (l.type === 'point') {
      const p = new THREE.PointLight(colour, l.intensity, l.range ?? 0, l.decay ?? 2);
      p.castShadow = l.castShadow === true;
      if (p.castShadow) p.shadow.mapSize.set(512, 512);
      return p;
    }
    if (l.type === 'spot') {
      const s = new THREE.SpotLight(colour, l.intensity, l.range ?? 0, THREE.MathUtils.degToRad(l.angle ?? 30), l.penumbra ?? 0.2, l.decay ?? 2);
      const d = l.direction ?? [0, -1, 0];
      s.target.position.set(d[0] ?? 0, d[1] ?? -1, d[2] ?? 0);
      s.castShadow = l.castShadow === true;
      if (s.castShadow) s.shadow.mapSize.set(1024, 1024);
      return s;
    }
    return null;
  };
  const clockStart = typeof performance !== 'undefined' ? performance.now() : 0;
  const objects = new Map<string, THREE.Object3D>();
  /** Phase 21.2: the transform sync for `forEachInterpolated` (one function for the adapter's life). */
  const applyInterpolated = (id: string, position: readonly number[], rotation: readonly number[], scale: readonly number[]): void => {
    const obj = objects.get(id);
    if (obj) applyTransformToObject3D(obj, position as AdapterVec3, rotation as AdapterQuat, scale as AdapterVec3);
  };
  const owned: OwnedResources = { geometries: [], materials: [], renderer: null };
  let camera: THREE.PerspectiveCamera | null = null;

  // --- M3 (presentation.md §§41.1/41.2, packet 52): v3 detection, the
  // --- authored lights and the shadow decision ----------------------------
  // The snapshot is deep-frozen and runtime-validated; the adapter reads it
  // structurally and never re-validates (the runtime already did).
  const sceneDoc = opts.snapshot.scene;
  const isV3 = sceneDoc.schemaVersion === 3 || sceneDoc.schemaVersion === 4;
  const gameBlock = opts.snapshot.game;
  /** The §41.1.3 input bounds; required on every runtime-validated v3
   *  snapshot (`game.level`). The null fallback below is defensive only. */
  const authoredLevel: ShadowLevel | null =
    isV3 && gameBlock !== null && gameBlock !== undefined ? (gameBlock.level ?? null) : null;
  const authoredLights: AuthoredLight[] = [];
  if (isV3) {
    for (const e of sceneDoc.entities) {
      const l = (e.components as { light?: AuthoredLight }).light;
      // Phase 9.5: point/spot/hemisphere lights are built per entity (realizeEntity).
      if (l && (l.type === 'directional' || l.type === 'ambient') && !bakedAway(e.id, l as { type: string; mode?: string })) authoredLights.push(l);
    }
  }
  const keyLight = isV3 ? (authoredLights.find((l) => l.type === 'directional') ?? null) : null;
  /** Phase 17.4: the key light's shadow map settings (its data over the defaults). */
  const keyShadow = directionalShadowSettings(keyLight);
  // Phase 12 (c): a v4 game has no level bounds; the shadow region is a
  // square that follows the camera (planned here around its start), half its
  // side the light's `shadowExtent` (phase 17.4; 24 m by default).
  const followShadow = isV3 && authoredLevel === null;
  const startCamera = sceneDoc.entities.find((e) => e.components.camera !== undefined)?.components.transform.position ?? [0, 0, 0];
  const followHalf = keyShadow.extent;
  const level: ShadowLevel | null = followShadow
    ? { minX: startCamera[0] - followHalf, maxX: startCamera[0] + followHalf, minY: startCamera[1] - followHalf, maxY: startCamera[1] + followHalf }
    : authoredLevel;
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
  /** Phase 12 (c): each entity's own GPU resources (released when its scene unloads). */
  const entityResources = new Map<string, { geometries: THREE.BufferGeometry[]; materials: THREE.Material[] }>();
  /** Phase 12 (c): the documents of every realized entity (the loaded scenes). */
  const entityDocs = new Map<string, (typeof opts.snapshot.scene.entities)[number]>();
  const realizeEntity = (e: (typeof opts.snapshot.scene.entities)[number]): void => {
    const t = e.components.transform;
    let obj: THREE.Object3D;
    const own: { geometries: THREE.BufferGeometry[]; materials: THREE.Material[] } = { geometries: [], materials: [] };
    const box = e.components.box;
    const cam = e.components.camera;
    if (box) {
      // Box primitive: unit-axis geometry sized by `size`; the
      // transform's `scale` multiplies on top per frame (§6).
      const geometry = new THREE.BoxGeometry(box.size[0], box.size[1], box.size[2]);
      addBoxLightmapUv(geometry);
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
      own.geometries.push(geometry);
      own.materials.push(material);
      obj = new THREE.Mesh(geometry, material);
      // Phase 17.4: boxes cast and receive the key light's shadow (data: box.castShadow / receiveShadow).
      applyShadowFlags(obj, shadowFlagsOf(e.components));
    } else if (cam) {
      // The single M1 camera (project-model §10.3). Aspect is a
      // viewport property — updated per frame from the canvas size.
      camera = new THREE.PerspectiveCamera(cam.fovY, 1, cam.near, cam.far);
      obj = camera;
    } else {
      obj = new THREE.Group();
      const local = localLightOf(e);
      if (local !== null) {
        obj.add(local);
        if (local instanceof THREE.SpotLight) obj.add(local.target);
        if ((local as THREE.PointLight).castShadow === true) localShadowLights += 1;
      }
    }
    objects.set(e.id, obj);
    if ((e.components as { fogVolume?: unknown }).fogVolume !== undefined) fogVolumeIds.add(e.id);
    const boxMaterials = (e.components as { materials?: Record<string, string> }).materials;
    // Phase 18.3: with the object's values for its graph materials' public parameters.
    if (box && materialLibrary !== null && boxMaterials !== undefined) materialUndo.set(e.id, materialLibrary.apply(obj, boxMaterials, materialParamsOf(e.components)));
    if (box) lightmaps?.apply(e.id, obj);
    entityDocs.set(e.id, e);
    if (own.geometries.length > 0) entityResources.set(e.id, own);
    const parent = e.parentId ? objects.get(e.parentId) : undefined;
    (parent ?? scene).add(obj);
    applyTransformToObject3D(obj, t.position, t.rotation, t.scale);
  };
  const releaseEntity = (id: string): void => {
    lightmaps?.release(id);
    fogVolumeIds.delete(id);
    materialUndo.get(id)?.();
    materialUndo.delete(id);
    const obj = objects.get(id);
    obj?.removeFromParent();
    objects.delete(id);
    entityDocs.delete(id);
    const own = entityResources.get(id);
    if (own !== undefined) {
      for (const g of own.geometries) g.dispose();
      for (const m of own.materials) m.dispose();
      entityResources.delete(id);
    }
  };
  for (const e of opts.snapshot.scene.entities) realizeEntity(e);
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
          // Phase 17.4: the light's shadow map settings (data; DIRECTIONAL_SHADOW_DEFAULTS when absent).
          light.shadow.mapSize.set(keyShadow.mapSize, keyShadow.mapSize);
          light.shadow.bias = keyShadow.bias;
          light.shadow.normalBias = keyShadow.normalBias;
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
    const { models: modelEntities, pieces: modelPieces, animations: modelAnimationEntities, instances: instanceEntities } = modelRefsOf(opts.snapshot.scene.entities);
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
      instanceEntities,
      modelPieces,
      materialLibrary,
      entityMaterials: (entityId: string) => (entityDocs.get(entityId)?.components as { materials?: Record<string, string> } | undefined)?.materials ?? null,
      entityMaterialParams: (entityId: string) => materialParamsOf(entityDocs.get(entityId)?.components),
      ...(opts.snapshot.scenes !== undefined ? { allowAbsent: true } : {}),
      holderFor: (entityId: string) => objects.get(entityId) ?? null,
      viewFor,
      onAttached: (entityId: string, root: THREE.Object3D) => {
        // Phase 17.4: models and instance sets cast and receive the key light's shadow (their data).
        applyShadowFlags(root, shadowFlagsOf(entityDocs.get(entityId)?.components));
        lightmaps?.apply(entityId, root);
      },
    });
    if (result.ok === true) {
      realization = result.realization;
    } else {
      modelsConfigError = result.error;
    }
  }

  // --- renderer state (lazy: created on the first successful render) ---
  const canvasLike = canvas as CanvasLike | null;
  let renderBackend: 'webgl2' | 'webgpu' | null = null;
  let rendererInfo: string | null = null;
  let pixelRatio = 1;
  let contextAttempted = false;
  /** Phase 17.1: the last frame was skipped (WebGPURenderer still initialising). */
  let lastFrameSkipped = false;
  /** Phase 17.1: the renderer choice as last seen (kept for diagnostics after dispose). */
  let lastRendererInfo: RendererInfo | null = null;
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

  /** Phase 17.1: the renderer generation the environment renderer and shadow probe were set up for. */
  let rendererGeneration = 0;

  function ensureRenderer(): AdapterError | null {
    if (disposed) return adapterError('adapter_disposed', 'adapter is disposed');
    if (owned.renderer) return null;
    if (contextAttempted) {
      return adapterError('render_unsupported', 'renderer creation previously failed (no canvas renderer in this environment)');
    }
    if (typeof canvasLike?.getContext !== 'function') {
      contextAttempted = true;
      return adapterError('canvas_invalid', 'canvas argument is missing or does not expose getContext()');
    }
    contextAttempted = true;
    const preference = opts.renderer?.preference ?? DEFAULT_RENDERER_PREFERENCE;
    try {
      // Phase 17.1: the one renderer factory (WebGPURenderer on WebGPU or WebGL 2).
      const handle = createRenderer({
        canvas: canvasLike,
        preference,
        source: opts.renderer?.source ?? 'default',
        antialias: opts.antialias ?? true,
        powerPreference: 'high-performance',
        // Opaque black where nothing is drawn (what WebGLRenderer always cleared to).
        clearColor: 0x000000,
        clearAlpha: 1,
        // The game canvas is not drawn to again after dispose: free its WebGL context.
        loseContextOnDispose: true,
        ...(opts.renderer?.deps !== undefined ? { deps: opts.renderer.deps } : {}),
      });
      owned.renderer = handle;
      const win = globalThis.window;
      const dpr = win && typeof win.devicePixelRatio === 'number' && win.devicePixelRatio > 0 ? win.devicePixelRatio : 1;
      pixelRatio = dpr;
      // Set up when it is ready (adoptRenderer): WebGPURenderer initialises asynchronously.
      return null;
    } catch {
      owned.renderer = null;
      renderBackend = null;
      rendererInfo = null;
      return adapterError('render_unsupported', 'renderer creation failed (non-browser environment or no WebGPU/WebGL 2)');
    }
  }

  /**
   * Phase 17.1: a (re)created WebGPURenderer became ready — set it up, and
   * rebuild what held the previous renderer (the environment renderer; the
   * shadow probe runs again).
   */
  function adoptRenderer(handle: RendererHandle, r: AnyRenderer): void {
    if (handle.generation() === rendererGeneration) return;
    rendererGeneration = handle.generation();
    environmentRenderer?.dispose();
    environmentRenderer = null;
    environmentSize = null;
    r.setPixelRatio(pixelRatio);
    const inf = handle.info();
    renderBackend = inf.api;
    rendererInfo = `WebGPURenderer (${inf.api === 'webgpu' ? 'WebGPU' : 'WebGL 2'})`;
    if (shadowState.shadows === 'on') shadowProbeDone = false;
  }

  // The active checkpoint shows its authored activation look
  // (`gameZone.activation`: emissive color + intensity); the look reverts
  // when the checkpoint is no longer active (e.g. a replay).
  let shownCheckpoint: string | null = null;
  const activationOf = (id: string): { emissive: string; emissiveIntensity: number } | null => {
    const e = entityDocs.get(id);
    const act = (e?.components as { gameZone?: { activation?: { emissive?: unknown; emissiveIntensity?: unknown } } } | undefined)?.gameZone?.activation;
    if (act === undefined || typeof act.emissive !== 'string') return null;
    return { emissive: act.emissive, emissiveIntensity: typeof act.emissiveIntensity === 'number' ? act.emissiveIntensity : 1 };
  };
  const setActivation = (id: string, look: { emissive: string; emissiveIntensity: number } | null): void => {
    // A project material is shared: the glow gets each mesh its own copy first (phase 9.4 rule).
    const obj = objects.get(id);
    if (obj !== undefined) setEmissiveLook(obj, look);
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

  // --- Phase 12 (c): follow the runtime's scene set ------------------------
  /** Scenes realized so far (the start scenes came with the snapshot). */
  const realizedScenes = new Map<string, ReadonlySet<string>>();
  let realizedRevision = -1;
  {
    const set = opts.runtime.sceneSet?.();
    if (set !== undefined) {
      for (const b of set.batches) realizedScenes.set(b.sceneId, new Set(b.entities.map((e) => e.id)));
      realizedRevision = set.revision;
    }
  }
  function syncSceneSet(): void {
    const set = opts.runtime.sceneSet?.();
    if (set === undefined || set.revision === realizedRevision) return;
    realizedRevision = set.revision;
    const live = new Set(set.batches.map((b) => b.sceneId));
    for (const [sceneId, ids] of [...realizedScenes]) {
      if (live.has(sceneId)) continue;
      for (const id of ids) lightmaps?.release(id);
      realization?.removeEntities(ids);
      if (shownCheckpoint !== null && ids.has(shownCheckpoint)) shownCheckpoint = null;
      // Children before parents (reverse document order).
      for (const id of [...ids].reverse()) releaseEntity(id);
      realizedScenes.delete(sceneId);
    }
    for (const b of set.batches) {
      if (realizedScenes.has(b.sceneId)) continue;
      const entities = b.entities as unknown as (typeof opts.snapshot.scene.entities)[number][];
      for (const e of entities) realizeEntity(e);
      realizedScenes.set(b.sceneId, new Set(entities.map((e) => e.id)));
      realization?.addEntities(modelRefsOf(entities));
    }
    syncSpawned((set as { spawned?: readonly unknown[] }).spawned ?? []);
  }

  // --- Phase 14.1: spawned prefab copies (ctx.spawn / ctx.destroy) ------------
  /** The realized spawned entities: id → the runtime's (frozen) entity object. */
  const realizedSpawned = new Map<string, unknown>();
  function syncSpawned(spawned: readonly unknown[]): void {
    const live = new Map<string, unknown>();
    for (const e of spawned) live.set((e as { id: string }).id, e);
    // Gone, or the same id spawned again in a new run (a new object): release, children first.
    const gone = [...realizedSpawned].filter(([id, e]) => live.get(id) !== e).map(([id]) => id);
    if (gone.length > 0) {
      const ids = new Set(gone);
      realization?.removeEntities(ids);
      for (const id of gone.reverse()) {
        releaseEntity(id);
        realizedSpawned.delete(id);
        hiddenIds.delete(id);
        if (shownCheckpoint === id) shownCheckpoint = null;
      }
    }
    const added = spawned.filter((e) => !realizedSpawned.has((e as { id: string }).id)) as unknown as (typeof opts.snapshot.scene.entities)[number][];
    if (added.length === 0) return;
    for (const e of added) {
      realizeEntity(e);
      realizedSpawned.set(e.id, e);
    }
    realization?.addEntities(modelRefsOf(added));
  }

  /** v4: the shadow square follows the camera, snapped to whole shadow texels (no shimmer). */
  function followCameraShadow(): void {
    if (camera === null || keyLights.length === 0) return;
    const texel = (2 * keyPlan.halfExtent) / keyShadow.mapSize;
    const cx = Math.round(camera.position.x / texel) * texel;
    const cy = Math.round(camera.position.y / texel) * texel;
    const dir = keyLight?.direction ?? [0, -1, 0];
    const n = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    for (const light of keyLights) {
      light.target.position.set(cx, cy, 0);
      light.position.set(cx - (dir[0] / n) * SHADOW_PROFILE.distance, cy - (dir[1] / n) * SHADOW_PROFILE.distance, -(dir[2] / n) * SHADOW_PROFILE.distance);
      light.target.updateMatrixWorld();
    }
  }

  /** Phase 14.5: after the transform sync, move the drawn camera by the offset. */
  function applyCameraOffset(): void {
    if (camera === null) return;
    const p = camera.position;
    if (appliedOffset !== null && p.x === appliedOffset.at[0] && p.y === appliedOffset.at[1] && p.z === appliedOffset.at[2]) {
      // Not synced this frame: take the last offset back off first.
      p.set(p.x - appliedOffset.offset[0], p.y - appliedOffset.offset[1], p.z - appliedOffset.offset[2]);
    }
    appliedOffset = null;
    if (cameraOffset === null) return;
    p.set(p.x + cameraOffset[0], p.y + cameraOffset[1], p.z + cameraOffset[2]);
    appliedOffset = { offset: [...cameraOffset], at: [p.x, p.y, p.z] };
  }

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
    lastFrameSkipped = false;
    const handle = owned.renderer!;
    const hInfo = handle.info();
    lastRendererInfo = hInfo;
    if (hInfo.state === 'failed') {
      return { ok: false, error: adapterError('render_unsupported', `the renderer could not start: ${hInfo.reason}`.slice(0, 256)) };
    }
    if (hInfo.state === 'lost') {
      return { ok: false, error: adapterError('render_context_lost', `the frame was not rendered: ${hInfo.reason}`.slice(0, 256)) };
    }
    const live = handle.current();
    if (live === null || !handle.ready()) {
      // Phase 17.1: WebGPURenderer initialises asynchronously; frames are
      // skipped (not an error) until it is ready.
      lastFrameSkipped = true;
      return { ok: true };
    }
    adoptRenderer(handle, live);
    // The runtime is the single frame driver: this runs after the step
    // update (runtime.md §6 frame ordering: step → onFrame → render).
    // Phase 21.2: a runtime that hands out its interpolated transforms in
    // reused arrays is read without a per-frame copy of every transform.
    if (opts.runtime.forEachInterpolated !== undefined) {
      syncSceneSet();
      if (!opts.runtime.forEachInterpolated(applyInterpolated)) {
        return { ok: false, error: adapterError('render_failed', 'runtime state unavailable: runtime is disposed') };
      }
    } else {
      const st = opts.runtime.getInterpolatedState();
      if (!st.ok) {
        return {
          ok: false,
          error: adapterError('render_failed', `runtime state unavailable: ${st.error.message}`),
        };
      }
      syncSceneSet();
      // Transform synchronization: copy the interpolated values into the
      // Object3Ds (no other transform math — §6).
      for (const tr of st.state.transforms) {
        const obj = objects.get(tr.id);
        if (obj) applyTransformToObject3D(obj, tr.position as AdapterVec3, tr.rotation as AdapterQuat, tr.scale as AdapterVec3);
      }
    }
    applyCameraOffset();
    syncCheckpointLook();
    // Phase 9.9: collected pickups and defeated enemies disappear (and come back on a replay).
    const hiddenNow = (opts.runtime as { hiddenEntities?: () => ReadonlySet<string> }).hiddenEntities?.();
    if (hiddenNow !== undefined) {
      for (const id of hiddenIds) {
        if (hiddenNow.has(id)) continue;
        const obj = objects.get(id);
        if (obj !== undefined) obj.visible = true;
        hiddenIds.delete(id);
      }
      for (const id of hiddenNow) {
        if (hiddenIds.has(id)) continue;
        const obj = objects.get(id);
        if (obj !== undefined) obj.visible = false;
        hiddenIds.add(id);
      }
    }
    fades.apply(objects, (opts.runtime as { entityOpacity?: () => ReadonlyMap<string, number> }).entityOpacity?.());
    if (localShadowLights > 0 && !live.shadowMap.enabled) {
      live.shadowMap.enabled = true;
      live.shadowMap.type = THREE.PCFShadowMap;
    }
    if (materialLibrary !== null && materialLibrary.animated()) {
      materialLibrary.tick(((typeof performance !== 'undefined' ? performance.now() : 0) - clockStart) / 1000);
    }
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
      applyAnimatorPoses();
    }
    const renderer = live;
    if (followShadow) followCameraShadow();
    // Phase 17.4: the follow shadow and the size first — the shadow probe below is a
    // real frame (it compiles the scene's pipelines), drawn as the game will draw it.
    const [w, h] = canvasSize();
    // Resize only on a change: setSize rewrites the canvas' drawing buffer,
    // and the environment renderer rebuilds its whole post stack on resize.
    const current = renderer.getSize(tmpSize);
    if (current.x !== w || current.y !== h || canvasLike?.width !== Math.floor(w * renderer.getPixelRatio())) {
      renderer.setSize(w, h, false);
    }
    camera!.aspect = w / h;
    camera!.updateProjectionMatrix();
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
      // WebGPURenderer has no `capabilities`: WebGPU guarantees 8192² textures and WebGL 2
      // 2048²; a larger map than the device takes fails the probe render below (soft degradation).
      let probeOk = true;
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
    try {
      if (opts.environment !== undefined) {
        if (environmentRenderer === null) {
          environmentRenderer = createEnvironmentRenderer(renderer, scene, { loadTexture: opts.environment.loadTexture });
          environmentRenderer.set(effectiveEnvironment());
          if (playerQuality !== null) environmentRenderer.setQuality(playerQuality);
        }
        const key = keyLight;
        environmentRenderer.setKeyLightDirection(key?.direction !== undefined ? [key.direction[0], key.direction[1], key.direction[2]] : null);
        environmentRenderer.setFogVolumes(fogVolumesNow());
        if (environmentSize === null || environmentSize[0] !== w || environmentSize[1] !== h) {
          environmentSize = [w, h];
          environmentRenderer.resize(w, h);
        }
        environmentRenderer.render(camera!);
      } else {
        renderer.render(scene, camera!);
      }
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
    if (lastFrameSkipped) return { ok: false, error: adapterError('render_failed', 'the renderer is still initialising; nothing is drawn yet') };
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
    const choice = owned.renderer !== null && !disposed ? owned.renderer.info() : lastRendererInfo;
    if (choice !== null) d.renderer = choice;
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
    const liveRenderer = owned.renderer !== null && !disposed ? owned.renderer.current() : null;
    if (liveRenderer !== null) d.gpu = rendererMemory(liveRenderer);
    return {
      ok: true,
      diagnostics: d,
    };
  }

  function dispose(): { ok: true; alreadyDisposed?: true } | { ok: false; error: AdapterError } {
    if (disposed) return { ok: true, alreadyDisposed: true };
    disposed = true;
    for (const rec of animatorPlayers.values()) rec.player.dispose();
    fades.dispose();
    animatorPlayers.clear();
    lightmaps?.dispose();
    materialLibrary?.dispose();
    environmentRenderer?.dispose();
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
    for (const own of entityResources.values()) {
      for (const g of own.geometries) {
        try { g.dispose(); } catch { /* best effort */ }
      }
      for (const m of own.materials) {
        try { m.dispose(); } catch { /* best effort */ }
      }
    }
    entityResources.clear();
    entityDocs.clear();
    for (const g of owned.geometries) {
      try { g.dispose(); } catch { /* best effort */ }
    }
    for (const m of owned.materials) {
      try { m.dispose(); } catch { /* best effort */ }
    }
    if (owned.renderer) {
      lastRendererInfo = owned.renderer.info();
      // The handle disposes the renderer (WebGPURenderer's WebGL 2 backend drops its context).
      try { owned.renderer.dispose(); } catch { /* best effort */ }
    }
    owned.geometries = [];
    owned.materials = [];
    owned.renderer = null;
    scene.clear();
    objects.clear();
    camera = null;
    return { ok: true };
  }

  const api: SceneAdapter = {
    renderFrame,
    captureScreenshot,
    diagnostics,
    dispose,
    setQuality(level: QualityLevel): void {
      playerQuality = level;
      environmentRenderer?.setQuality(level);
    },
    setCameraOffset(offset: readonly [number, number, number] | null): void {
      cameraOffset = offset !== null && offset.every((v) => Number.isFinite(v)) ? [offset[0], offset[1], offset[2]] : null;
    },
    setEnvironmentLayer(layer: EnvironmentLayerLike | null): void {
      if (JSON.stringify(layer) === JSON.stringify(environmentLayer)) return;
      environmentLayer = layer;
      environmentRenderer?.set(effectiveEnvironment());
      if (materialLibrary !== null) materialLibrary.setWind(((layer?.wind as WindLike | undefined) ?? opts.materials?.wind ?? null) as WindLike | null);
    },
  };
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