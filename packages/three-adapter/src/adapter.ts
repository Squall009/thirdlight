/**
 * Three.js scene adapter (runtime.md frame ordering, adapter diagnostics
 * and environment; the dependencies.md surface row:
 * `createSceneAdapter(canvas, opts) → SceneAdapter { renderFrame,
 * captureScreenshot(maxWidth), diagnostics, dispose }`, `ERROR_CODES`).
 *
 * The adapter owns ALL Object3D/material/renderer lifetimes for the
 * scene graph: box primitives (unit-geometry scaled by `size`, simple
 * Lambert material from `material.color`), one perspective camera
 * (project-model: exactly one camera entity), and a fixed
 * component→Object3D table (no registration API — out of scope per
 * dependencies.md). One renderer path: three's WebGPURenderer from the renderer
 * factory — WebGPU where it starts, else its WebGL 2 backend (the SELECTED
 * backend is reported in diagnostics).
 *
 * Frame ordering (normative): the RUNTIME owns the single
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
import { releaseEmissiveLooks, setEntityLook, SHARED_MATERIAL_KEY } from './node-materials';
import { disposeObjectTree } from './dispose';
import { BATCH_KEY, createAutoBatcher, markBatchable, unitBoxGeometry, type AutoBatcher, type AutoBatcherDiagnostics } from './batching';
import { compileIntoTarget } from './environment-nodes';
import { INSTANCE_MATRIX_ATTRIBUTE } from './attribute-instancing';
import { createEnvironmentRenderer, environmentHasLook, layerEnvironment, type EnvironmentLayerLike, type EnvironmentLike, type EnvironmentRenderer, type FogVolumeLike, type QualityLevel } from './environment';
import * as THREE from 'three';
import { BlockLayerView, blockLookFromObject, type BlockLayerViewDiagnostics, type BlockModelLook } from './block-layers';
import { RuntimeMaterialView, type MaterialRenderChangeLike, type RuntimeMaterialsDiagnostics } from './runtime-materials';
import type { BlockLayerComponent, BlockLayerData, BlockType, GridRenderChange } from '@thirdlight/runtime';
import type { Runtime, RuntimeSnapshot } from '@thirdlight/runtime';
import { blendEnvironment, blendLight, blendTouchesLights, type EnvironmentBlendView, type EnvironmentLightValues } from '@thirdlight/runtime';
import { adapterError, type AdapterError } from './errors';
import { createFrameCapture, type ScreenshotResult } from './capture';
export type { ScreenshotResult } from './capture';
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
import { createResourceManager, type ResourceManager } from '@thirdlight/runtime';
import { textureHolds, type TextureHolds } from './texture-holds';
import { objectByteSize } from './resource-bytes';
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
  type ShadowRegion,
  type ShadowPlan,
  type ShadowOutcome,
  type ShadowReason,
} from './lighting';
import { selectSceneLights, type SceneLightEntry, type SceneLightKind, type SceneLightSelection } from './scene-lights';
import { createEffectsPlayer, type EffectComponentLike, type EffectDefLike, type EffectRequestLike, type EffectsDiagnostics, type EffectsPlayer, type EffectsPlayerOptions } from './effects-player';
import {
  createRenderer,
  DEFAULT_RENDERER_PREFERENCE,
  rendererMemory,
  type RendererMemoryCounts,
  type AnyRenderer,
  type RendererFactoryDeps,
  type RendererHandle,
  type RendererInfo,
  type RendererPreference,
  type RendererPreferenceSource,
} from './renderer-factory';

export { PRECOMPILE_WAIT_MS, type FrameDrawnInfo, type SceneAdapter, type SceneAdapterDiagnostics, type SceneAdapterOptions } from './adapter-types';
import { PRECOMPILE_WAIT_MS, type FrameDrawnInfo, type SceneAdapter, type SceneAdapterDiagnostics, type SceneAdapterOptions } from './adapter-types';

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
  setAttribute?: (name: string, value: string) => void;
}

interface OwnedResources {
  geometries: THREE.BufferGeometry[];
  materials: THREE.Material[];
  /** The renderer handle (the factory's); its renderer may be replaced after a loss. */
  renderer: RendererHandle | null;
}

/**
 * Whether an entity's box, model or instance set casts and
 * receives the directional light's realtime shadow — its component's
 * `castShadow` / `receiveShadow`, true when absent (solid geometry blocks the
 * light and shows the shadows falling on it; project-model's descriptors).
 */
function shadowFlagsOf(components: unknown): { cast: boolean; receive: boolean } {
  const c = components as { box?: { castShadow?: unknown; receiveShadow?: unknown }; model?: { castShadow?: unknown; receiveShadow?: unknown }; instances?: { castShadow?: unknown; receiveShadow?: unknown } };
  const part = c.box ?? c.model ?? c.instances;
  return { cast: part?.castShadow !== false, receive: part?.receiveShadow !== false };
}

/** An environment preset (project-model's, as the runtime's blend maths takes it). */
type PresetOf = Parameters<typeof blendEnvironment>[1] extends ReadonlyMap<string, infer P> ? P : never;

/** An entity's `materialParams` component (overrides of its graph materials' public parameters). */
function materialParamsOf(components: unknown): MaterialOverridesLike | null {
  const v = (components as { materialParams?: unknown } | undefined)?.materialParams;
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as MaterialOverridesLike) : null;
}

/** Set the shadow flags on every mesh under `root` (a model's meshes, an instance set's instanced meshes). */
function applyShadowFlags(root: THREE.Object3D, flags: { cast: boolean; receive: boolean }): void {
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh === true) {
      // A graph material whose output casts no shadow keeps it off (its flag is data too).
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
      instances?: { asset?: { assetId?: unknown; piece?: unknown }; buffer?: unknown; count?: unknown; chunkSize?: unknown };
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
      instances.set(e.id, { assetId: inst.asset.assetId, ...(piece !== undefined ? { piece } : {}), buffer: inst.buffer, count: inst.count as number, ...(typeof inst.chunkSize === 'number' ? { chunkSize: inst.chunkSize } : {}) });
    }
  }
  return { models, pieces, animations, instances };
}

/** What a particle material holder wears until the project material library dresses it. */
const EFFECT_MATERIAL_PLACEHOLDER = new THREE.MeshBasicMaterial();
/** The effect models' holder in the resource manager (one effect player per page). */
const EFFECTS_HOLDER = 'effects';

export function createSceneAdapter(canvas: unknown, opts: SceneAdapterOptions): SceneAdapter {
  const scene = new THREE.Scene();
  /**
   * What this adapter loads from assets is held in the page's resource
   * manager (the page settles it after each frame); without one, the
   * adapter's own, settled after each change.
   */
  const resources: ResourceManager = opts.resources ?? createResourceManager({ schedule: (run) => queueMicrotask(run) });
  // Project materials (shared by boxes, models and instance sets), node materials.
  /** The lightmap set once it exists (the library may report a change while it is still being set up). */
  let lightmapsLive: LightmapSet | null = null;
  const materialLibrary: MaterialLibrary | null =
    opts.materials !== undefined
      ? createMaterialLibrary({
          loadTexture: opts.materials.loadTexture,
          resources,
          // A project material changed in place (a texture arrived): lightmapped
          // copies made before are clones and follow it (else they keep the texture-less look).
          onChange: () => lightmapsLive?.refresh(),
        })
      : null;
  if (materialLibrary !== null && opts.materials !== undefined) {
    materialLibrary.setMaterials(opts.materials.defs, opts.materials.functions ?? []);
    materialLibrary.setWind(opts.materials.wind);
  }
  const materialUndo = new Map<string, () => void>();
  /** The values scripts set per object (the simulation's material changes). */
  let runtimeMaterials: RuntimeMaterialView | null = null;
  /** Lightmaps of the baked static objects; the lights a bake holds are not realtime. */
  const lightmaps: LightmapSet | null =
    opts.lighting !== undefined && Object.keys(opts.lighting.bakes).length > 0
      ? createLightmapSet(opts.lighting.bakes, textureHolds(resources, opts.lighting.loadTexture), (ids) =>
          ids.some((id) => {
            const t = (entityDocs.get(id)?.components as { light?: { type?: string } } | undefined)?.light?.type;
            return t === 'ambient' || t === 'hemisphere';
          }),
        )
      : null;
  lightmapsLive = lightmaps;
  /** Entities the runtime hides (`ctx.game.setVisible`, a collected collectible). */
  const hiddenIds = new Set<string>();
  /** The animator poses the runtime committed, played on the models. */
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
        // Clips of an animation-only asset marked "clips for" this model's asset.
        rec = { instance: found.instance, player: createAnimatorPlayer(found.instance.root, found.instance.animationClips(), rig, { clipsOf: (clipAssetId) => r.clipsOf(clipAssetId, rig, id) }) };
        animatorPlayers.set(id, rec);
      }
      rec.player.apply(pose);
    }
  };
  /** A light that stays out of realtime rendering: held by a bake (ambient/hemisphere always stay). */
  const bakedAway = (id: string | undefined, l: { type: string; mode?: string }): boolean =>
    l.mode === 'baked' && l.type !== 'ambient' && l.type !== 'hemisphere' && id !== undefined && lightmaps?.isBakedLight(id) === true;
  /** The environment renderer (created with the renderer). */
  let environmentRenderer: EnvironmentRenderer | null = null;
  /** The environment's textures (held while it exists). */
  let environmentHolds: TextureHolds | null = null;
  /** The size last handed to the environment renderer (it rebuilds its post stack on a change). */
  let environmentSize: [number, number] | null = null;
  let playerQuality: QualityLevel | null = opts.environment?.quality ?? null;
  /** A look laid over the project environment (null: none). */
  let environmentLayer: EnvironmentLayerLike | null = null;
  /**
   * The lights environment presets may change (scene-level
   * directional/ambient lights and the entities' point/spot/hemisphere lights)
   * with their authored values, and what was last applied.
   */
  const envLights = new Map<string, { light: THREE.Light; id: string; tags: number; type: string; authored: EnvironmentLightValues }>();
  let envLightsRevision = 0;
  let envAppliedKey = '';
  let envLightsTouched = false;
  /** The editor's preview of a blend (null: the running game's). */
  let envPreview: EnvironmentBlendView | null = null;
  let envBlendActive = false;
  const envPresets = new Map<string, PresetOf>();
  for (const p of (opts.environment?.value.presets ?? []) as unknown as readonly PresetOf[]) envPresets.set(p.presetId, p);
  const envTagBits = new Map<string, number>();
  for (const t of (opts.snapshot as { tags?: readonly { bit: number; name: string }[] }).tags ?? []) envTagBits.set(t.name.toLowerCase(), t.bit);
  /** What the renderer draws: the project environment with the layered look over it (null when nothing is drawn, as without an environment). */
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
  /** point/spot lights casting shadows (the shadow map is enabled for them). */
  let localShadowLights = 0;
  /** Every realized light by entity, switched on and off by `selectLights` (scene-lights.ts). */
  const switchable = new Map<string, { kind: SceneLightKind; light: THREE.Light }>();
  /** The spot cookies drawn (a copy of the decoded texture each, the light's own: disposed with the light, which holds the decoded one). */
  const cookies = new Map<THREE.SpotLight, THREE.Texture>();
  const cookieLoader = opts.lights?.loadTexture ?? opts.materials?.loadTexture ?? opts.environment?.loadTexture ?? null;
  const cookieHolds = cookieLoader === null ? null : textureHolds(resources, cookieLoader);
  const attachCookie = (s: THREE.SpotLight, assetId: string): void => {
    if (cookieHolds === null) return;
    void cookieHolds.get(assetId, s.uuid).then(
      (decoded) => {
        if (decoded === null) return;
        // Released meanwhile (its scene unloaded, the adapter disposed): not drawn.
        if (disposed || ![...switchable.values()].some((r) => r.light === s)) {
          cookieHolds.releaseHolder(s.uuid);
          return;
        }
        const tex = decoded.clone();
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.needsUpdate = true;
        s.map = tex;
        cookies.set(s, tex);
        // A cookie changes the light's shading: its programs are built before the next present.
        precompileWanted ??= 'scene';
      },
      () => undefined,
    );
  };
  /** v4: a point, spot or hemisphere light for an entity (null otherwise, or when a bake holds it). */
  const localLightOf = (e: { id?: string; components: unknown }): THREE.Light | null => {
    const l = (e.components as { light?: { type: string; color: string; intensity: number; range?: number; decay?: number; angle?: number; penumbra?: number; direction?: readonly number[]; groundColor?: string; castShadow?: boolean; mode?: string; cookie?: string } }).light;
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
      // Three puts a new SpotLight at (0, 1, 0) (Object3D.DEFAULT_UP); at its entity's origin it shines along `direction`.
      s.position.set(0, 0, 0);
      const d = l.direction ?? [0, -1, 0];
      s.target.position.set(d[0] ?? 0, d[1] ?? -1, d[2] ?? 0);
      s.castShadow = l.castShadow === true;
      if (s.castShadow) s.shadow.mapSize.set(1024, 1024);
      // A cookie (three's SpotLight.map; the node lighting projects it through the cone on both backends).
      if (typeof l.cookie === 'string') attachCookie(s, l.cookie);
      return s;
    }
    return null;
  };
  const clockStart = typeof performance !== 'undefined' ? performance.now() : 0;
  const objects = new Map<string, THREE.Object3D>();
  /** Which entity an object is (a release stops at other entities' objects parented below). */
  const ownerOf = new WeakMap<THREE.Object3D, string>();
  /** One object's own meshes (its child objects' are theirs). */
  const ownMeshes = (entityId: string): THREE.Object3D[] => {
    const root = objects.get(entityId);
    const out: THREE.Object3D[] = [];
    const visit = (o: THREE.Object3D): void => {
      if (o !== root && ownerOf.get(o) !== undefined) return;
      if ((o as THREE.Mesh).isMesh === true) out.push(o);
      for (const c of o.children) visit(c);
    };
    if (root !== undefined) visit(root);
    return out;
  };
  if (materialLibrary !== null) runtimeMaterials = new RuntimeMaterialView(materialLibrary, ownMeshes);
  // --- Visual effects --------------------------------------------
  /** A project material for particles shaded with one (the library's compiled material, taken from a holder mesh). */
  const effectMaterials = new Map<string, THREE.Mesh>();
  /** The effects' textures and models are held for the effect player's life. */
  const effectTextures = opts.effects !== undefined ? textureHolds(resources, opts.effects.loadTexture) : null;
  const effectModelLoad = opts.effects?.loadModel;
  const effects: EffectsPlayer | null =
    opts.effects !== undefined
      ? createEffectsPlayer({
          scene,
          defs: opts.effects.defs,
          wind: opts.effects.wind ?? opts.materials?.wind ?? null,
          loadTexture: (assetId) => effectTextures!.get(assetId, 'effects'),
          ...(effectModelLoad !== undefined
            ? {
                loadModel: (assetId: string) =>
                  resources
                    .acquire<THREE.Object3D>('effect-model', assetId, EFFECTS_HOLDER, async () => {
                      const root = await effectModelLoad(assetId);
                      if (root === null) throw new Error(`effect model ${assetId} is not available`);
                      return { value: root, bytes: objectByteSize(root), free: (r) => disposeObjectTree(r) };
                    })
                    .catch(() => null),
              }
            : {}),
          projectMaterial: (id: string) => {
            if (materialLibrary === null || id === '') return null;
            let holder = effectMaterials.get(id);
            if (holder === undefined) {
              holder = new THREE.Mesh(new THREE.BufferGeometry(), EFFECT_MATERIAL_PLACEHOLDER);
              materialLibrary.apply(holder, { '*': id });
              effectMaterials.set(id, holder);
            }
            // Still the placeholder: no such project material (the particles fall back to their built-in shading).
            return holder.material === EFFECT_MATERIAL_PLACEHOLDER ? null : (holder.material as THREE.Material);
          },
        })
      : null;
  /** Entities carrying an `effect` component (hidden ones stop spawning). */
  const effectEntities = new Set<string>();
  let effectsLastNow: number | null = null;
  let effectsMark = '';
  /** The MSAA samples last stamped on the canvas. */
  let msaaMark = -1;
  let drawsMark = -1;
  /** The last drawn frame's counts. */
  const lastFrameCounts = { drawCalls: 0, triangles: 0 };
  /** The transform sync for `forEachInterpolated` (one function for the adapter's life). */
  const applyInterpolated = (id: string, position: readonly number[], rotation: readonly number[], scale: readonly number[]): void => {
    const obj = objects.get(id);
    if (obj) applyTransformToObject3D(obj, position as AdapterVec3, rotation as AdapterQuat, scale as AdapterVec3);
  };
  const owned: OwnedResources = { geometries: [], materials: [], renderer: null };
  const reportedViewport: [number, number] = [0, 0];
  let camera: THREE.PerspectiveCamera | null = null;

  // --- v3 detection, the
  // --- authored lights and the shadow decision ----------------------------
  // The snapshot is deep-frozen and runtime-validated; the adapter reads it
  // structurally and never re-validates (the runtime already did).
  const sceneDoc = opts.snapshot.scene;
  const isV3 = sceneDoc.schemaVersion === 3 || sceneDoc.schemaVersion === 4;
  // The shadow region is a square that follows the camera
  // (planned here around its start), half its side the light's
  // `shadowExtent` (24 m by default).
  const followShadow = isV3;
  const startCamera = sceneDoc.entities.find((e) => e.components.camera !== undefined)?.components.transform.position ?? [0, 0, 0];
  /**
   * The directional lights of the loaded scenes, each with its
   * own shadow settings and planned outcome (probeOk: true — the capability
   * probe runs at the first render with shadows; the webgl2 requirement is
   * enforced at renderer creation). One is on: the key light.
   */
  type KeyRec = {
    readonly id: string;
    readonly light: THREE.DirectionalLight;
    readonly authored: AuthoredLight;
    readonly settings: { mapSize: number; bias: number; normalBias: number; extent: number };
    readonly plan: ShadowPlan;
    readonly outcome: ShadowOutcome;
    /** The direction an environment preset gives (null: the authored one). */
    directionNow: [number, number, number] | null;
  };
  const directionals = new Map<string, KeyRec>();
  let keyRec: KeyRec | null = null;
  /** The first frame with shadows failed (soft degradation): no light casts a shadow from then on. */
  let shadowsUnsupported = false;
  /** The current shadow realization state (the key light's); recorded when the key light changes (never per frame) — the bounded shadow diagnostic. */
  let shadowState: { shadows: 'on' | 'off'; reason?: ShadowReason } = { shadows: 'off', reason: 'cast_shadow_false' };
  let shadowProbeDone = false;
  const keyDirectionOf = (r: KeyRec | null): readonly [number, number, number] | undefined => r?.directionNow ?? r?.authored.direction;
  /** A directional light for a v3/v4 light entity: at the derived position round the camera's start square (rule 2). */
  const directionalLightOf = (id: string, l: AuthoredLight): KeyRec => {
    const settings = directionalShadowSettings(l);
    const region: ShadowRegion = { minX: startCamera[0] - settings.extent, maxX: startCamera[0] + settings.extent, minY: startCamera[1] - settings.extent, maxY: startCamera[1] + settings.extent };
    const direction = l.direction ?? [0, -1, 0];
    const outcome = decideShadows({ webgl2: true, castShadow: l.castShadow === true, probeOk: true, region, direction });
    // `outcome` always resolves `ok: true` here (webgl2: true).
    const plan: ShadowPlan = outcome.ok ? outcome.plan : deriveShadowCamera(region, direction);
    const [planned] = planSceneLights([l], region, outcome);
    const light = new THREE.DirectionalLight(new THREE.Color(l.color), l.intensity);
    if (planned !== undefined && planned.kind === 'directional') {
      light.position.set(planned.position[0], planned.position[1], planned.position[2]);
      light.target.position.set(planned.target[0], planned.target[1], planned.target[2]);
    }
    if (outcome.ok && outcome.shadows === 'on' && !shadowsUnsupported) {
      // The shadow-camera parameters are set now; the shadow map is
      // allocated only by the first-render probe (rule 5).
      light.castShadow = true;
      // The light's shadow map settings (data; DIRECTIONAL_SHADOW_DEFAULTS when absent).
      light.shadow.mapSize.set(settings.mapSize, settings.mapSize);
      light.shadow.bias = settings.bias;
      light.shadow.normalBias = settings.normalBias;
      light.shadow.camera.left = plan.camera.left;
      light.shadow.camera.right = plan.camera.right;
      light.shadow.camera.top = plan.camera.top;
      light.shadow.camera.bottom = plan.camera.bottom;
      light.shadow.camera.near = plan.camera.near;
      light.shadow.camera.far = plan.camera.far;
      light.shadow.camera.updateProjectionMatrix();
    }
    return { id, light, authored: l, settings, plan, outcome, directionNow: null };
  };
  /** The shadow state follows the key light (a scene with a shadow-casting sun turns shadows on; the probe runs for it). */
  const applyKeyShadow = (): void => {
    const o = keyRec?.outcome;
    if (keyRec === null || o === undefined || !o.ok) shadowState = { shadows: 'off', reason: 'cast_shadow_false' };
    else if (shadowsUnsupported && keyRec.authored.castShadow === true) shadowState = { shadows: 'off', reason: 'shadow_unsupported' };
    else shadowState = o.shadows === 'on' ? { shadows: 'on' } : { shadows: 'off', reason: o.shadowReason ?? 'cast_shadow_false' };
  };

  // --- scene graph construction (fixed component table; read-only over the
  // --- (deep-frozen, normalized) snapshot) ---------------------------------
  /** Each entity's own GPU resources (released when its scene unloads). */
  const entityResources = new Map<string, { geometries: THREE.BufferGeometry[]; materials: THREE.Material[]; shared?: THREE.Material }>();
  /** The unit box every box is drawn through when batched. */
  const unitBox = unitBoxGeometry(addBoxLightmapUv);
  /** Box materials by value (shared by every box with the same values; counted). */
  const boxMaterials = new Map<string, { material: THREE.Material; refs: number }>();
  const boxMaterialKeys = new Map<THREE.Material, string>();
  const sharedBoxMaterial = (surface: AuthoredSurface | undefined, color: string): THREE.Material => {
    const key = surface ? JSON.stringify(['s', surface.color, surface.roughness, surface.metalness, surface.emissive, surface.emissiveIntensity]) : JSON.stringify(['l', color]);
    let rec = boxMaterials.get(key);
    if (rec === undefined) {
      const material: THREE.Material = surface
        ? new THREE.MeshStandardMaterial({
            color: new THREE.Color(surface.color),
            roughness: surface.roughness,
            metalness: surface.metalness,
            emissive: new THREE.Color(surface.emissive),
            emissiveIntensity: surface.emissiveIntensity,
          })
        : new THREE.MeshLambertMaterial({ color: new THREE.Color(color) });
      material.userData[SHARED_MATERIAL_KEY] = true;
      rec = { material, refs: 0 };
      boxMaterials.set(key, rec);
      boxMaterialKeys.set(material, key);
    }
    rec.refs += 1;
    return rec.material;
  };
  const releaseBoxMaterial = (material: THREE.Material): void => {
    const key = boxMaterialKeys.get(material);
    const rec = key === undefined ? undefined : boxMaterials.get(key);
    if (rec === undefined || key === undefined) return;
    rec.refs -= 1;
    if (rec.refs > 0) return;
    boxMaterials.delete(key);
    boxMaterialKeys.delete(material);
    material.dispose();
  };
  /** Repeated objects drawn instanced (absent when the option turns it off). */
  const batcher: AutoBatcher | null = opts.batching === false ? null : createAutoBatcher(scene);
  // Its update walks the graph for the world matrices right before every render: the renderer's own pass is left out.
  if (batcher !== null) scene.matrixWorldAutoUpdate = false;
  /** The documents of every realized entity (the loaded scenes). */
  const entityDocs = new Map<string, (typeof opts.snapshot.scene.entities)[number]>();
  // Block layers — merged chunk meshes per block look (the same view as the editor's Scene view).
  const blockPrefabs = (opts.snapshot as { prefabs?: readonly { prefabId: string; entities: readonly { parentLocalId?: string; components: Record<string, unknown> }[] }[] }).prefabs ?? [];
  const blockLooks = new Map<string, BlockModelLook | null>();
  const blockView = new BlockLayerView({
    modelLook: (assetId, piece, onReady) => {
      const key = `${assetId}|${piece ?? ''}`;
      if (blockLooks.has(key)) return blockLooks.get(key) ?? null;
      const inst = realization?.blockInstance?.(assetId, piece, onReady) ?? null;
      if (inst === null) return null;
      const look = blockLookFromObject(inst.root);
      blockLooks.set(key, look);
      return look;
    },
    prefabModel: (prefabId) => {
      const root = blockPrefabs.find((p) => p.prefabId === prefabId)?.entities.find((e) => e.parentLocalId === undefined);
      const m = root?.components['model'] as { asset?: { assetId?: string }; piece?: string } | undefined;
      return typeof m?.asset?.assetId === 'string' ? { assetId: m.asset.assetId, ...(typeof m.piece === 'string' ? { piece: m.piece } : {}) } : null;
    },
    applyMaterials: (mesh, type, assetId) => {
      if (materialLibrary === null) return;
      const base = opts.models?.assets.find((a) => a.assetId === assetId)?.materials;
      const mapping = { ...(base ?? {}), ...(type.materials ?? {}) };
      if (Object.keys(mapping).length > 0) materialLibrary.apply(mesh, mapping, null);
    },
    // Baked block-layer chunks: lightmap UVs, and the chunk's lightmap when its layout is the baked one.
    lightmapped: (id) => lightmaps?.hasChunks(id) === true,
    chunkBuilt: (id, cx, cz, group, layout) => lightmaps?.applyChunk(id, cx, cz, layout, group),
    chunkDropped: (id, cx, cz) => lightmaps?.releaseChunk(id, cx, cz),
  });
  blockView.setTypes(((opts.snapshot as { blockTypes?: readonly BlockType[] }).blockTypes ?? []) as BlockType[]);
  scene.add(blockView.root);
  const realizeEntity = (e: (typeof opts.snapshot.scene.entities)[number]): void => {
    const t = e.components.transform;
    let obj: THREE.Object3D;
    const own: { geometries: THREE.BufferGeometry[]; materials: THREE.Material[]; shared?: THREE.Material } = { geometries: [], materials: [] };
    const box = e.components.box;
    const cam = e.components.camera;
    if (box) {
      // Box primitive: unit-axis geometry sized by `size`; the
      // transform's `scale` multiplies on top per frame.
      const geometry = new THREE.BoxGeometry(box.size[0], box.size[1], box.size[2]);
      addBoxLightmapUv(geometry);
      const surface = (e.components as { surface?: AuthoredSurface }).surface;
      // An entity carrying `surface` gets ONE
      // material instance created per entity placement — owned by that
      // entity's mesh instance (value-level independence; the per-placement
      // instance is by construction). No preset lookup: the values are
      // taken literally from the `surface` component. No `surface` ⇒ the
      // plain Lambert path.
      // Boxes with equal values share one material (a per-object
      // look — `ctx.look`, a lightmap — copies it first), so
      // they can be drawn together.
      const material = sharedBoxMaterial(surface, box.material.color);
      own.geometries.push(geometry);
      own.shared = material;
      obj = new THREE.Mesh(geometry, material);
      // Drawn through the one unit box scaled by the size when batched.
      obj.userData[BATCH_KEY] = { geometry: unitBox, scale: [box.size[0], box.size[1], box.size[2]] };
      // Boxes cast and receive the key light's shadow (data: box.castShadow / receiveShadow).
      applyShadowFlags(obj, shadowFlagsOf(e.components));
    } else if (cam) {
      // The single scene camera (project-model). Aspect is a
      // viewport property — updated per frame from the canvas size.
      camera = new THREE.PerspectiveCamera(cam.fovY, 1, cam.near, cam.far);
      obj = camera;
    } else {
      obj = new THREE.Group();
      const local = localLightOf(e);
      if (local !== null) {
        // Environment presets may set its colour, intensity, direction and ground colour.
        const l = (e.components as { light: { type: string; color: string; intensity: number; direction?: readonly number[]; groundColor?: string } }).light;
        const d = l.direction ?? (l.type === 'spot' ? [0, -1, 0] : undefined);
        envLights.set(`entity:${e.id}`, {
          light: local,
          id: e.id,
          tags: (e as { tags?: number }).tags ?? 0,
          type: l.type,
          authored: { color: l.color, intensity: l.intensity, ...(d !== undefined ? { direction: [d[0] ?? 0, d[1] ?? -1, d[2] ?? 0] as [number, number, number] } : {}), ...(l.type === 'hemisphere' ? { groundColor: l.groundColor ?? '#444444' } : {}) },
        });
        envLightsRevision += 1;
        // A hemisphere light's sky is up (+Y) whatever its entity's transform (as the Scene view and the bake take it): it hangs off the scene.
        if (l.type === 'hemisphere') scene.add(local);
        else obj.add(local);
        if (local instanceof THREE.SpotLight) obj.add(local.target);
        if ((local as THREE.PointLight).castShadow === true) localShadowLights += 1;
        switchable.set(e.id, { kind: l.type as SceneLightKind, light: local });
      } else if (isV3) {
        // A directional or ambient light of any loaded scene. Its entity's transform is
        // irrelevant (rule 3): it hangs off the scene; `selectLights` switches it on or off.
        const l = (e.components as { light?: AuthoredLight }).light;
        if (l !== undefined && (l.type === 'directional' || l.type === 'ambient') && !bakedAway(e.id, l as { type: string; mode?: string })) {
          const tags = (e as { tags?: number }).tags ?? 0;
          if (l.type === 'ambient') {
            // Rule 1: no shadow, no position dependence; the intensity is used exactly as authored.
            const ambient = new THREE.AmbientLight(new THREE.Color(l.color), l.intensity);
            scene.add(ambient);
            switchable.set(e.id, { kind: 'ambient', light: ambient });
            // Environment presets may set its colour and intensity.
            envLights.set(`entity:${e.id}`, { light: ambient, id: e.id, tags, type: 'ambient', authored: { color: l.color, intensity: l.intensity } });
          } else {
            const rec = directionalLightOf(e.id, l);
            scene.add(rec.light);
            scene.add(rec.light.target);
            directionals.set(e.id, rec);
            switchable.set(e.id, { kind: 'directional', light: rec.light });
            // Environment presets may set its colour, intensity and direction.
            const kd = l.direction ?? [0, -1, 0];
            envLights.set(`entity:${e.id}`, { light: rec.light, id: e.id, tags, type: 'directional', authored: { color: l.color, intensity: l.intensity, direction: [kd[0], kd[1], kd[2]] } });
          }
          envLightsRevision += 1;
        }
      }
    }
    objects.set(e.id, obj);
    ownerOf.set(obj, e.id);
    // A block layer (its cells ride on the resolved component).
    const layer = (e.components as { blockLayer?: BlockLayerComponent & { data?: BlockLayerData } }).blockLayer;
    if (layer !== undefined) blockView.setLayer(e.id, layer, t.position, layer.data ?? null);
    if ((e.components as { fogVolume?: unknown }).fogVolume !== undefined) fogVolumeIds.add(e.id);
    const boxMaterials = (e.components as { materials?: Record<string, string> }).materials;
    // With the object's values for its graph materials' public parameters.
    if (box && materialLibrary !== null && boxMaterials !== undefined) materialUndo.set(e.id, materialLibrary.apply(obj, boxMaterials, materialParamsOf(e.components)));
    if (box) lightmaps?.apply(e.id, obj);
    entityDocs.set(e.id, e);
    if (own.geometries.length > 0) entityResources.set(e.id, own);
    const parent = e.parentId ? objects.get(e.parentId) : undefined;
    (parent ?? scene).add(obj);
    applyTransformToObject3D(obj, t.position, t.rotation, t.scale);
    // An effect component plays from the object (on start unless it waits for a signal or a script).
    const fx = (e.components as { effect?: EffectComponentLike }).effect;
    if (effects !== null && fx !== undefined) {
      effectEntities.add(e.id);
      effects.attach(e.id, obj, fx, fx.playOnStart !== false);
    }
  };
  const releaseEntity = (id: string): void => {
    blockView.removeLayer(id);
    runtimeMaterials?.release(id);
    if (effects !== null) {
      effects.detach(id);
      effectEntities.delete(id);
    }
    const obj = objects.get(id);
    // Per-object looks first (a look override's own copies), then the shared paths undo.
    if (obj !== undefined) releaseEmissiveLooks(obj);
    lightmaps?.release(id);
    fogVolumeIds.delete(id);
    if (envLights.delete(`entity:${id}`)) envLightsRevision += 1;
    // Its light (a directional or ambient light hangs off the scene; a cookie is the adapter's).
    const lit = switchable.get(id);
    if (lit !== undefined) {
      switchable.delete(id);
      const cookie = cookies.get(lit.light as THREE.SpotLight);
      if (cookie !== undefined) {
        cookies.delete(lit.light as THREE.SpotLight);
        (lit.light as THREE.SpotLight).map = null;
        cookie.dispose();
      }
      cookieHolds?.releaseHolder(lit.light.uuid);
      if (lit.kind === 'directional' || lit.kind === 'ambient' || lit.kind === 'hemisphere') {
        lit.light.removeFromParent();
        if (lit.kind === 'directional') (lit.light as THREE.DirectionalLight).target.removeFromParent();
        lit.light.dispose();
        directionals.delete(id);
        if (keyRec?.id === id) keyRec = null;
      }
    }
    materialUndo.get(id)?.();
    materialUndo.delete(id);
    obj?.removeFromParent();
    if (obj !== undefined) {
      obj.traverse((o) => {
        if ((o instanceof THREE.PointLight || o instanceof THREE.SpotLight) && o.castShadow) localShadowLights = Math.max(0, localShadowLights - 1);
      });
      // Its render objects (a material that outlives it — a project material, a shared box
      // material — would keep them), a light's shadow map; other entities' objects below it are theirs.
      disposeObjectTree(obj, { skip: (o) => o !== obj && ownerOf.get(o) !== undefined });
    }
    objects.delete(id);
    if (obj !== undefined) ownerOf.delete(obj);
    entityDocs.delete(id);
    const own = entityResources.get(id);
    if (own !== undefined) {
      for (const g of own.geometries) g.dispose();
      for (const m of own.materials) m.dispose();
      if (own.shared !== undefined) releaseBoxMaterial(own.shared);
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
  // Realized lights. v1/v2 scenes: the accepted fixed pair. v3/v4 scenes:
  // the light entities' own lights (realizeEntity), switched on and off per
  // loaded scene (`selectLights` below).
  if (!isV3) {
    // Simple lighting for the Lambert material (no shadow pipeline for
    // v1/v2 scenes): one directional + one ambient.
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
    dirLight.position.set(0.5, 1, 0.8);
    const ambient = new THREE.AmbientLight(0xffffff, 0.55);
    scene.add(dirLight);
    scene.add(ambient);
  }

  // --- The model realization ------------
  // The holders (the `objects` map entries) exist now; the prepared
  // ModelInstance roots attach as their children. The realization is
  // created lazily when `models` is present (absent ⇒ no model path at
  // all, byte-stable). Fail-fast config
  // validation surfaces through `modelsSettled` + the structured
  // result; the base scene keeps rendering (degraded, never a throw).
  let realization: ModelsRealization | null = null;
  /**
   * The start scenes' models have settled (the blocking assets
   * of the first picture): the first present waits for them, so it shows the
   * whole world and its precompile covers the models' programs. The rest —
   * instance buffers, textures, clips, later scenes — stream in.
   */
  let startModelsIn = true;
  let startHeldSince: number | null = null;
  let modelsConfigError: AdapterError | null = null;
  if (opts.models !== undefined) {
    // Structural reads over the (deep-frozen, runtime-validated) snapshot —
    // the adapter never re-validates (the runtime already did).
    const { models: modelEntities, pieces: modelPieces, animations: modelAnimationEntities, instances: instanceEntities } = modelRefsOf(opts.snapshot.scene.entities);
    // No game session drives the roles (the idle/run/airborne
    // profile of an older project): every animated entity gets the constant
    // neutral motion at the runtime's step, so the accepted pure selector
    // yields `idle` — no blending, no run/airborne. The selector reads no
    // runtime internals (rule 1).
    const viewFor = (entityId: string): AnimationRoleView | null => {
      void entityId;
      let stepIndex = 0;
      try {
        const d = opts.runtime.getDiagnostics();
        if (d.ok && Number.isFinite(d.diagnostics.stepIndex)) stepIndex = Math.trunc(d.diagnostics.stepIndex);
      } catch {
        return null;
      }
      return { stepIndex, playerMotion: { speed: 0, grounded: true } };
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
      resources,
      entityMaterials: (entityId: string) => (entityDocs.get(entityId)?.components as { materials?: Record<string, string> } | undefined)?.materials ?? null,
      entityMaterialParams: (entityId: string) => materialParamsOf(entityDocs.get(entityId)?.components),
      ...(opts.snapshot.scenes !== undefined ? { allowAbsent: true } : {}),
      holderFor: (entityId: string) => objects.get(entityId) ?? null,
      viewFor,
      onAttached: (entityId: string, root: THREE.Object3D) => {
        // Models and instance sets cast and receive the key light's shadow (their data).
        applyShadowFlags(root, shadowFlagsOf(entityDocs.get(entityId)?.components));
        // Values a script set before the model arrived.
        runtimeMaterials?.reapply(entityId);
        // A model's meshes may be drawn together with other placements' (instance sets already are).
        markBatchable(root);
        lightmaps?.apply(entityId, root);
      },
    });
    if (result.ok === true) {
      realization = result.realization;
      startModelsIn = false;
      void realization.settled().then(() => {
        startModelsIn = true;
      });
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
  /** The last frame was skipped (WebGPURenderer still initialising). */
  let lastFrameSkipped = false;
  /** A frame was drawn (the renderer info holds its counts). */
  let lastFrameDrawn = false;
  /** The renderer choice as last seen (kept for diagnostics after dispose). */
  let lastRendererInfo: RendererInfo | null = null;
  let contextLost = false;
  let disposed = false;
  /** The previous frame's `performance.now()` for the clamped
   *  role-controller delta (the adapter derives `deltaSeconds` from the
   *  host clock, guarded). The first frame uses 0 (a fresh anchor
   *  after mount/suspend/resume: no fast-forward). */
  let lastFrameNow: number | null = null;
  /** Releases of the WebGL context listeners this adapter owns. */
  const contextListenerReleases: Array<() => void> = [];

  // Observe the WebGL context lifecycle of the canvas this adapter
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

  /** The renderer generation the environment renderer and shadow probe were set up for. */
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
      // The one renderer factory (WebGPURenderer on WebGPU or WebGL 2).
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
        ...(opts.renderer?.depthBuffer !== undefined ? { depthBuffer: opts.renderer.depthBuffer } : {}),
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
   * A (re)created WebGPURenderer became ready — set it up, and
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
    // The effect executors follow the renderer (compute on WebGPU, the CPU on WebGL 2).
    effects?.setRenderer(r as unknown as import('three/webgpu').WebGPURenderer, inf.api === 'webgpu' ? 'webgpu' : 'webgl2');
    rendererInfo = `WebGPURenderer (${inf.api === 'webgpu' ? 'WebGPU' : 'WebGL 2'})`;
    if (shadowState.shadows === 'on') shadowProbeDone = false;
    // A new renderer (a lost device) builds its programs ahead of its first present too.
    precompileRun = null;
    precompileWanted = 'start';
    // The depth buffer the renderer draws with (reversed Z falls back to standard without support).
    const depth = r as { reversedDepthBuffer?: boolean; logarithmicDepthBuffer?: boolean };
    if (typeof canvasLike?.setAttribute === 'function') canvasLike.setAttribute('data-tl-depth', depth.reversedDepthBuffer === true ? 'reversed' : depth.logarithmicDepthBuffer === true ? 'logarithmic' : 'standard');
  }

  // The simulation's per-object look overrides (ctx.look): applied
  // when one changes, and again when the object's meshes change (a model that
  // finished loading after the override was set); cleared ones give the
  // object its own look back.
  type LookLike = { readonly emissive?: string; readonly emissiveIntensity?: number; readonly tint?: string };
  const shownLooks = new Map<string, { look: LookLike; meshes: number }>();
  const meshCount = (root: THREE.Object3D): number => {
    let n = 0;
    root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh === true) n += 1;
    });
    return n;
  };
  const sameLook = (a: LookLike, b: LookLike): boolean => a.emissive === b.emissive && a.emissiveIntensity === b.emissiveIntensity && a.tint === b.tint;
  const syncEntityLooks = (): void => {
    const looks = (opts.runtime as { entityLooks?: () => ReadonlyMap<string, LookLike> }).entityLooks?.();
    if (looks === undefined || (looks.size === 0 && shownLooks.size === 0)) return;
    for (const id of [...shownLooks.keys()]) {
      if (looks.has(id)) continue;
      const obj = objects.get(id);
      if (obj !== undefined) setEntityLook(obj, null);
      shownLooks.delete(id);
    }
    for (const [id, look] of looks) {
      const obj = objects.get(id);
      if (obj === undefined) continue;
      const shown = shownLooks.get(id);
      const meshes = meshCount(obj);
      if (shown !== undefined && sameLook(shown.look, look) && shown.meshes === meshes) continue;
      setEntityLook(obj, look);
      shownLooks.set(id, { look, meshes });
    }
  };

  // --- Follow the runtime's scene set --------------------------------------
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
  /** The lights that are on (updated when the scene set changes). */
  let lightSelection: SceneLightSelection | null = null;
  /**
   * Switch the loaded scenes' lights: the most recently loaded
   * scene's directional, ambient and hemisphere light (each kind on its own),
   * point and spot lights within the budget (scene-lights.ts). The key light
   * decides the shadow state.
   */
  function selectLights(): void {
    if (!isV3) return;
    const rank = new Map<string, number>();
    let i = 0;
    for (const ids of realizedScenes.values()) {
      for (const id of ids) rank.set(id, i);
      i += 1;
    }
    const entries: SceneLightEntry[] = [];
    let order = 0;
    // A light whose object is hidden or switched off is off and counts for nothing (the previous scene's
    // light of its kind comes back; a point or spot light frees its place in the budget).
    for (const [id, r] of switchable) {
      if (hiddenIds.has(id)) {
        order++;
        continue;
      }
      entries.push({ id, kind: r.kind, rank: rank.get(id) ?? -1, order: order++ });
    }
    lightSelection = selectSceneLights(entries);
    for (const [id, r] of switchable) r.light.visible = lightSelection.active.has(id);
    const next = lightSelection.directional !== null ? (directionals.get(lightSelection.directional) ?? null) : null;
    if (next !== keyRec || keyRec === null) {
      keyRec = next;
      applyKeyShadow();
    }
  }
  selectLights();
  /** The scenes realized since the last drawn frame (for `onFrameDrawn`). */
  const frameRealized: string[] = [];
  /** Scenes prepared ahead of their load (released once realized). */
  const sceneHolds = new Map<string, { release(): void }>();
  /** The scene set revision the last presented frame drew. */
  let presentedRevision = -1;
  function syncSceneSet(): void {
    const set = opts.runtime.sceneSet?.();
    if (set === undefined || set.revision === realizedRevision) return;
    realizedRevision = set.revision;
    const live = new Set(set.batches.map((b) => b.sceneId));
    let removed = false;
    for (const [sceneId, ids] of [...realizedScenes]) {
      if (live.has(sceneId)) continue;
      for (const id of ids) lightmaps?.release(id);
      realization?.removeEntities(ids);
      for (const id of ids) shownLooks.delete(id);
      // Children before parents (reverse document order).
      for (const id of [...ids].reverse()) releaseEntity(id);
      realizedScenes.delete(sceneId);
      removed = true;
    }
    let added = false;
    for (const b of set.batches) {
      if (realizedScenes.has(b.sceneId)) continue;
      const entities = b.entities as unknown as (typeof opts.snapshot.scene.entities)[number][];
      for (const e of entities) realizeEntity(e);
      realizedScenes.set(b.sceneId, new Set(entities.map((e) => e.id)));
      realization?.addEntities(modelRefsOf(entities));
      // Its entities hold what the preparation held.
      sceneHolds.get(b.sceneId)?.release();
      sceneHolds.delete(b.sceneId);
      frameRealized.push(b.sceneId);
      // The attached scene's programs are built before it is presented.
      precompileWanted ??= 'scene';
      added = true;
    }
    // The lights follow the scene set (a light switched on or off changes the shading programs too).
    if (added || removed) selectLights();
    if (removed && !added && isV3) precompileWanted ??= 'scene';
    syncSpawned((set as { spawned?: readonly unknown[] }).spawned ?? []);
  }

  // --- Spawned prefab copies (ctx.spawn / ctx.destroy) ------------
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
        shownLooks.delete(id);
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

  /**
   * Draw the environment blend — the look (sky, fog, post) on the
   * environment renderer, the lights' colours/intensities/directions, the
   * lightmap multiplier. Only when the blend or the light set changed; back to
   * the authored look when the blend ends (a new run).
   */
  function applyEnvironmentBlend(): void {
    const view = envPreview ?? ((opts.runtime as { readEnvironmentBlend?: () => EnvironmentBlendView | null }).readEnvironmentBlend?.() ?? null);
    const layerKey = JSON.stringify(environmentLayer);
    const key = view === null ? '' : `${JSON.stringify(view.weights)}|${JSON.stringify(view.overrides)}|${envLightsRevision}|${layerKey}`;
    if (key === envAppliedKey) return;
    envAppliedKey = key;
    if (view === null) {
      if (!envBlendActive) return;
      envBlendActive = false;
      environmentRenderer?.setBlend(null);
      restoreLights();
      lightmaps?.setLook(1, '#ffffff');
      return;
    }
    envBlendActive = true;
    const base = layerEnvironment(opts.environment?.value ?? null, environmentLayer) ?? {};
    const look = blendEnvironment(base as never, envPresets, view);
    environmentRenderer?.setBlend(look as never);
    lightmaps?.setLook(look.lightmap.intensity, look.lightmap.tint);
    if (!blendTouchesLights(base as never, envPresets, view)) {
      restoreLights();
      return;
    }
    envLightsTouched = true;
    for (const rec of envLights.values()) {
      const v = blendLight(rec.authored, rec, envTagBits, base as never, envPresets, view);
      setLightValues(rec, v);
    }
  }
  /**
   * The light values scripts wrote (`ctx.entity(id).set('light',
   * …)`): colour and intensity become the light's authored values (presets
   * blend from them; a new run's empty list restores the document's), range
   * is a point or spot light's distance. Applied when the list or the light
   * set changed.
   */
  let lightOverridesKey = '';
  const lightOriginals = new WeakMap<object, EnvironmentLightValues>();
  function applyLightOverrides(): void {
    const ov = (opts.runtime as { lightOverrides?: () => ReadonlyMap<string, { color?: string; intensity?: number; range?: number }> }).lightOverrides?.();
    if (ov === undefined) return;
    const key = ov.size === 0 && lightOverridesKey === '' ? '' : `${envLightsRevision}|${JSON.stringify([...ov])}`;
    if (key === lightOverridesKey) return;
    lightOverridesKey = key;
    for (const rec of envLights.values()) {
      let original = lightOriginals.get(rec);
      if (original === undefined) lightOriginals.set(rec, (original = rec.authored));
      const o = ov.get(rec.id);
      rec.authored = o === undefined ? original : { ...original, ...(o.color !== undefined ? { color: o.color } : {}), ...(o.intensity !== undefined ? { intensity: o.intensity } : {}) };
      if (!envBlendActive) setLightValues(rec, rec.authored);
    }
    for (const [id, r] of switchable) {
      const l = r.light as THREE.PointLight | THREE.SpotLight;
      if ((l as THREE.PointLight).isPointLight !== true && (l as THREE.SpotLight).isSpotLight !== true) continue;
      const authored = (entityDocs.get(id)?.components as { light?: { range?: number } } | undefined)?.light?.range ?? 0;
      l.distance = ov.get(id)?.range ?? authored;
    }
    // A running blend blends from the written values.
    if (envBlendActive) envAppliedKey = '';
    if (ov.size === 0) lightOverridesKey = '';
  }
  function setLightValues(rec: { light: THREE.Light; id: string; type: string }, v: EnvironmentLightValues): void {
    rec.light.color.set(v.color);
    rec.light.intensity = v.intensity;
    if (v.groundColor !== undefined && (rec.light as THREE.HemisphereLight).isHemisphereLight === true) (rec.light as THREE.HemisphereLight).groundColor.set(v.groundColor);
    const d = v.direction;
    if (d === undefined) return;
    if (rec.type === 'directional') {
      // The shadow square follows the camera (v3/v4): the direction is applied there each frame.
      const key = directionals.get(rec.id);
      if (key !== undefined) key.directionNow = [d[0], d[1], d[2]];
    } else if ((rec.light as THREE.SpotLight).isSpotLight === true) (rec.light as THREE.SpotLight).target.position.set(d[0], d[1], d[2]);
  }
  function restoreLights(): void {
    if (!envLightsTouched) return;
    envLightsTouched = false;
    for (const rec of envLights.values()) setLightValues(rec, rec.authored);
    for (const key of directionals.values()) key.directionNow = null;
  }

  /** v4: the shadow square follows the camera, snapped to whole shadow texels (no shimmer). */
  function followCameraShadow(): void {
    if (camera === null || keyRec === null) return;
    const texel = (2 * keyRec.plan.halfExtent) / keyRec.settings.mapSize;
    const cx = Math.round(camera.position.x / texel) * texel;
    const cy = Math.round(camera.position.y / texel) * texel;
    const dir = keyDirectionOf(keyRec) ?? [0, -1, 0];
    const n = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    for (const light of [keyRec.light]) {
      light.target.position.set(cx, cy, 0);
      light.position.set(cx - (dir[0] / n) * SHADOW_PROFILE.distance, cy - (dir[1] / n) * SHADOW_PROFILE.distance, -(dir[2] / n) * SHADOW_PROFILE.distance);
      light.target.updateMatrixWorld();
    }
  }

  /**
   * The camera brain's resolved view (virtual cameras) replaces the
   * camera entity's pose and lens after the transform sync; without virtual
   * cameras the runtime returns null and the camera entity is drawn as before
   * (its lens restored if a view had changed it). Presentation only: the pose
   * is the simulation's, interpolated by the runtime.
   */
  const viewPos: number[] = [0, 0, 0];
  const viewRot: number[] = [0, 0, 0, 1];
  const viewMatrix = new THREE.Matrix4();
  const viewParentInverse = new THREE.Matrix4();
  const viewScale = new THREE.Vector3();
  let authoredLens: { fov: number; near: number; far: number } | null = null;
  function applyResolvedCamera(): void {
    if (camera === null) return;
    const lens = (opts.runtime as { readCameraView?: (p: number[], r: number[]) => { fovY: number; near: number; far: number } | null }).readCameraView?.(viewPos, viewRot) ?? null;
    if (lens === null) {
      if (authoredLens !== null) {
        camera.fov = authoredLens.fov;
        camera.near = authoredLens.near;
        camera.far = authoredLens.far;
        authoredLens = null;
      }
      return;
    }
    authoredLens ??= { fov: camera.fov, near: camera.near, far: camera.far };
    const parent = camera.parent;
    if (parent !== null && parent !== scene) {
      // The view is in world space: into the camera entity's parent space.
      parent.updateMatrixWorld();
      viewMatrix.compose(new THREE.Vector3(viewPos[0], viewPos[1], viewPos[2]), new THREE.Quaternion(viewRot[0], viewRot[1], viewRot[2], viewRot[3]), new THREE.Vector3(1, 1, 1));
      viewMatrix.premultiply(viewParentInverse.copy(parent.matrixWorld).invert());
      viewMatrix.decompose(camera.position, camera.quaternion, viewScale);
    } else {
      camera.position.set(viewPos[0]!, viewPos[1]!, viewPos[2]!);
      camera.quaternion.set(viewRot[0]!, viewRot[1]!, viewRot[2]!, viewRot[3]!);
    }
    camera.fov = lens.fovY;
    camera.near = lens.near;
    camera.far = lens.far;
  }

  /** When the first render call began (for `onFrameDrawn`). */
  let firstRenderCallAt: number | null = null;

  // --- Pipelines precompiled ahead of a present -----------------
  /** Wanted before the next present: the first one, and after a scene attached (or a new renderer). */
  let precompileWanted: 'start' | 'scene' | null = 'start';
  /** The precompile running (frames are skipped until it settles, at most PRECOMPILE_WAIT_MS). */
  let precompileRun: { readonly startedAt: number; readonly reason: 'start' | 'scene' } | null = null;
  /** The last precompile that settled, reported with the next drawn frame. */
  let precompileSettled: { readonly startedAt: number; readonly ms: number; readonly reason: 'start' | 'scene' } | null = null;
  const precompileStats = { runs: 0, failed: 0, gaveUp: 0, lastMs: 0 };
  /**
   * Whether this frame waits for a precompile (and starts one when it is
   * wanted): the scene as the frame would draw it, compiled with
   * `compileAsync` — the environment renderer's scene pass, or the canvas.
   */
  /** A precompile runs (and is still waited for). */
  function precompileRunning(now: number): boolean {
    if (precompileRun === null) return false;
    if (now - precompileRun.startedAt < PRECOMPILE_WAIT_MS) return true;
    // Too long (a device that never answers): draw; the frame builds what is left.
    precompileRun = null;
    precompileStats.gaveUp += 1;
    return false;
  }
  function precompileHolds(renderer: AnyRenderer): boolean {
    const now = performance.now();
    if (precompileRunning(now)) return true;
    if (precompileWanted === null || camera === null) return false;
    // The first present waits for the start scenes' models (at most PRECOMPILE_WAIT_MS).
    if (precompileWanted === 'start' && !startModelsIn) {
      startHeldSince ??= now;
      if (now - startHeldSince < PRECOMPILE_WAIT_MS) return true;
    }
    const reason = precompileWanted;
    precompileWanted = null;
    let job: Promise<void>;
    try {
      const r = renderer as unknown as import('three/webgpu').WebGPURenderer;
      job = environmentRenderer !== null ? environmentRenderer.compileAsync(camera) : compileIntoTarget(r, scene, camera, r.getRenderTarget(), r.getMRT());
    } catch {
      precompileStats.failed += 1;
      return false;
    }
    const run = { startedAt: now, reason };
    precompileRun = run;
    const settle = (failed: boolean): void => {
      if (precompileRun !== run) return;
      precompileRun = null;
      if (disposed) return;
      const ms = performance.now() - run.startedAt;
      precompileStats.runs += 1;
      if (failed) precompileStats.failed += 1;
      precompileStats.lastMs = Math.round(ms);
      precompileSettled = { startedAt: run.startedAt, ms, reason };
    };
    job.then(() => settle(false), () => settle(true));
    return true;
  }

  function renderFrame(): { ok: true } | { ok: false; error: AdapterError } {
    return drawFrame(false);
  }

  /** One frame; `force`: drawn even while a precompile runs (a capture needs this frame's picture). */
  function drawFrame(force: boolean): { ok: true } | { ok: false; error: AdapterError } {
    if (disposed) return { ok: false, error: adapterError('adapter_disposed', 'adapter is disposed') };
    const renderStart = opts.onFrameDrawn !== undefined ? performance.now() : 0;
    if (firstRenderCallAt === null) firstRenderCallAt = renderStart;
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
      // WebGPURenderer initialises asynchronously; frames are
      // skipped (not an error) until it is ready.
      lastFrameSkipped = true;
      return { ok: true };
    }
    adoptRenderer(handle, live);
    // While a precompile runs, a skipped frame does none of the frame's work (the transform
    // sync, the batches): the compile gets the main thread, and the frame after it starts from now.
    if (!force && precompileRunning(performance.now())) {
      lastFrameSkipped = true;
      return { ok: true };
    }
    // The runtime is the single frame driver: this runs after the step
    // update (runtime.md frame ordering: step → onFrame → render).
    // A runtime that hands out its interpolated transforms in
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
      // Object3Ds (no other transform math).
      for (const tr of st.state.transforms) {
        const obj = objects.get(tr.id);
        if (obj) applyTransformToObject3D(obj, tr.position as AdapterVec3, tr.rotation as AdapterQuat, tr.scale as AdapterVec3);
      }
    }
    applyResolvedCamera();
    syncEntityLooks();
    // The objects the simulation hides disappear (and come back on a restart).
    const hiddenNow = (opts.runtime as { hiddenEntities?: () => ReadonlySet<string> }).hiddenEntities?.();
    if (hiddenNow !== undefined) {
      let lightsTouched = false;
      for (const id of hiddenIds) {
        if (hiddenNow.has(id)) continue;
        const obj = objects.get(id);
        if (obj !== undefined) obj.visible = true;
        hiddenIds.delete(id);
        if (switchable.has(id)) lightsTouched = true;
      }
      for (const id of hiddenNow) {
        if (hiddenIds.has(id)) continue;
        const obj = objects.get(id);
        if (obj !== undefined) obj.visible = false;
        hiddenIds.add(id);
        if (switchable.has(id)) lightsTouched = true;
      }
      // A light object hidden or switched off (or back) changes which lights are on.
      if (lightsTouched) {
        selectLights();
        precompileWanted ??= 'scene';
      }
    }
    // The effect requests of the steps since the last frame (presentation only), then the effects step.
    if (effects !== null) {
      for (const req of (opts.runtime as { takeEffectRequests?: () => EffectRequestLike[] }).takeEffectRequests?.() ?? []) effects.request(req, (id) => objects.get(id));
      for (const id of effectEntities) effects.setAttachedActive(id, !hiddenIds.has(id));
      const perf = globalThis.performance;
      const now = perf !== undefined ? perf.now() : 0;
      const paused = (opts.runtime as { isPaused?: boolean }).isPaused === true;
      const frameSeconds = effectsLastNow === null || paused ? 0 : Math.max(0, (now - effectsLastNow) / 1000);
      effectsLastNow = now;
      if (camera !== null) effects.update(frameSeconds, camera, (now - clockStart) / 1000);
      // The canvas reports the executor and what plays (an export has no other in-page diagnostics surface).
      const d = effects.diagnostics();
      const mark = `${d.executor ?? 'none'}|${d.playing}|${d.particles}`;
      if (mark !== effectsMark && typeof canvasLike?.setAttribute === 'function') {
        effectsMark = mark;
        canvasLike.setAttribute('data-tl-effects', d.executor ?? 'none');
        canvasLike.setAttribute('data-tl-effects-playing', String(d.playing));
        canvasLike.setAttribute('data-tl-effects-particles', String(d.particles));
      }
    }
    if (localShadowLights > 0 && !live.shadowMap.enabled) {
      live.shadowMap.enabled = true;
      live.shadowMap.type = THREE.PCFShadowMap;
    }
    if (materialLibrary !== null && materialLibrary.animated()) {
      materialLibrary.tick(((typeof performance !== 'undefined' ? performance.now() : 0) - clockStart) / 1000);
    }
    // One host-driven update per
    // rendered frame, in this order — (1) the transform sync above,
    // (2) every live role controller advanced once with the
    // real frame delta CLAMPED to the accepted [0, 0.25] range (first
    // frame after mount or after a suspend/resume: a fresh anchor — the
    // host's frame-time reset makes a resume a fresh anchor; the clamp is
    // the adapter-side bound, no fast-forward), (3) `renderer.render`
    // (below). The controllers install no rAF, no timer, no mixer
    // listener — there is no second loop.
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
      // The accepted clamp (presentation.md rule 2:
      // 0 ≤ deltaSeconds ≤ 0.25).
      if (!Number.isFinite(delta) || delta < 0) delta = 0;
      if (delta > ANIMATION_MAX_DELTA_SECONDS) delta = ANIMATION_MAX_DELTA_SECONDS;
      realization.update(delta);
      applyAnimatorPoses();
    }
    const renderer = live;
    if (followShadow) followCameraShadow();
    // The follow shadow and the size first — the shadow probe below is a
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
    // The viewport the view is drawn in (screen↔world projection in scripts uses its aspect).
    if (w !== reportedViewport[0] || h !== reportedViewport[1]) {
      reportedViewport[0] = w;
      reportedViewport[1] = h;
      (opts.runtime as { setCameraViewport?: (w: number, h: number) => boolean }).setCameraViewport?.(w, h);
    }
    // The block chunks the simulation changed, re-meshed before the draw.
    const gridChanges = (opts.runtime as { takeGridChanges?: () => GridRenderChange[] }).takeGridChanges?.() ?? [];
    if (gridChanges.length > 0) blockView.applyRuntimeChanges(gridChanges);
    blockView.update();
    // The light values scripts wrote, then the environment preset blend
    // (the running game's, or the editor's preview) before the draw.
    applyLightOverrides();
    applyEnvironmentBlend();
    // Material parameters scripts changed, on the objects before the draw (and before regrouping).
    const materialChanges = (opts.runtime as { takeMaterialChanges?: () => MaterialRenderChangeLike[] }).takeMaterialChanges?.() ?? [];
    if (materialChanges.length > 0) runtimeMaterials?.apply(materialChanges);
    // Regroup the repeated objects and copy their matrices (after every transform and look change).
    batcher?.update(camera!);
    const disableShadows = (): void => {
      try {
        renderer.shadowMap.enabled = false;
      } catch {
        /* best effort */
      }
      for (const r of directionals.values()) r.light.castShadow = false;
      shadowsUnsupported = true;
      shadowState = { shadows: 'off', reason: 'shadow_unsupported' };
    };
    // Shadow capability probe: the first frame of a scene with shadows is the probe — shadows go
    // on before it (and before the precompile below, so the programs are built with them); if that
    // frame throws, they go off (soft degradation: the `shadows`/`shadowReason` pair is the
    // diagnostic) and it is drawn again without. A scene with no shadow-casting light never
    // enables `shadowMap`.
    let probing = false;
    if (shadowState.shadows === 'on' && isV3 && !shadowProbeDone) {
      shadowProbeDone = true;
      probing = true;
      try {
        renderer.shadowMap.enabled = true;
        // three's `THREE.PCFShadowMap` (the frozen profile row).
        renderer.shadowMap.type = THREE.PCFShadowMap;
      } catch {
        probing = false;
        disableShadows();
      }
    }
    try {
      // A player's quality level also applies without a project environment (the low
      // level draws without MSAA), so the environment renderer draws then too.
      if ((opts.environment !== undefined || playerQuality !== null) && environmentRenderer === null) {
        // The sky, its faces and the grading LUT are held for the environment's life.
        const envTextures = textureHolds(resources, opts.environment?.loadTexture ?? (async () => null), 'environment');
        environmentRenderer = createEnvironmentRenderer(renderer, scene, { loadTexture: (id) => envTextures.get(id, 'environment') });
        environmentHolds = envTextures;
        environmentRenderer.set(effectiveEnvironment());
        if (playerQuality !== null) environmentRenderer.setQuality(playerQuality);
        // A blend already running goes onto the new environment renderer.
        envAppliedKey = '';
        envBlendActive = false;
        applyEnvironmentBlend();
      }
      if (environmentRenderer !== null) {
        const keyDir = keyDirectionOf(keyRec);
        environmentRenderer.setKeyLightDirection(keyDir !== undefined ? [keyDir[0], keyDir[1], keyDir[2]] : null);
        environmentRenderer.setFogVolumes(fogVolumesNow());
        if (environmentSize === null || environmentSize[0] !== w || environmentSize[1] !== h) {
          environmentSize = [w, h];
          environmentRenderer.resize(w, h);
        }
      }
    } catch (e) {
      return { ok: false, error: adapterError('render_failed', `render failed: ${String(e)}`) };
    }
    // No present that would build programs in the frame — they are built ahead
    // (renderer.compileAsync) before the first present and after a scene attached; frames are
    // skipped meanwhile (the last picture stays). A capture draws regardless.
    if (!force && precompileHolds(renderer)) {
      if (probing) shadowProbeDone = false;
      lastFrameSkipped = true;
      return { ok: true };
    }
    const frameInfo = (renderer as { info?: { render?: { drawCalls: number; triangles: number } } }).info?.render ?? { drawCalls: 0, triangles: 0 };
    const drawsBefore = frameInfo.drawCalls;
    const trianglesBefore = frameInfo.triangles;
    const draw = (): void => {
      if (environmentRenderer !== null) environmentRenderer.render(camera!);
      else renderer.render(scene, camera!);
    };
    try {
      try {
        draw();
      } catch (e) {
        if (!probing) throw e;
        disableShadows();
        draw();
      }
      // The MSAA samples the frame was drawn with (the export has no other in-page diagnostics surface).
      const samples = environmentRenderer !== null ? environmentRenderer.samples() : renderer.samples;
      if (samples !== msaaMark && typeof canvasLike?.setAttribute === 'function') {
        msaaMark = samples;
        canvasLike.setAttribute('data-tl-msaa', String(samples));
      }
      // This frame's draw calls (the export's only diagnostics surface; the play diagnostics carry them too).
      lastFrameCounts.drawCalls = Math.max(0, frameInfo.drawCalls - drawsBefore);
      lastFrameCounts.triangles = Math.max(0, frameInfo.triangles - trianglesBefore);
      if (lastFrameCounts.drawCalls !== drawsMark && typeof canvasLike?.setAttribute === 'function') {
        drawsMark = lastFrameCounts.drawCalls;
        canvasLike.setAttribute('data-tl-draws', String(drawsMark));
      }
    } catch (e) {
      return { ok: false, error: adapterError('render_failed', `render failed: ${String(e)}`) };
    }
    lastFrameDrawn = true;
    presentedRevision = realizedRevision;
    if (opts.onFrameDrawn !== undefined) {
      const realized = frameRealized.splice(0);
      try {
        const pre = precompileSettled;
        precompileSettled = null;
        opts.onFrameDrawn({ realizedScenes: realized, renderMs: performance.now() - renderStart, firstCallAt: firstRenderCallAt ?? renderStart, ...(pre !== null ? { precompile: { startedAt: pre.startedAt, ms: pre.ms } } : {}), draws: lastFrameCounts.drawCalls, sceneRevision: realizedRevision });
      } catch {
        /* a timing hook never breaks a frame */
      }
    }
    return { ok: true };
  }

  const { captureScreenshot, captureThumbnail } = createFrameCapture({ canvas: canvasLike, drawFrame: () => drawFrame(true), skipped: () => lastFrameSkipped });

  function diagnostics(): { ok: true; diagnostics: SceneAdapterDiagnostics } | { ok: false; error: AdapterError } {
    // Works after dispose too (reports the last known backend or null) —
    // the session layer composes this block for the play relay
    // (the runtime.md adapter block).
    const d: SceneAdapterDiagnostics = {
      renderBackend,
      rendererInfo,
      canvasSize: canvasSize(),
      pixelRatio,
      shadows: shadowState.shadows,
    };
    if (precompileRun !== null || precompileStats.runs + precompileStats.failed + precompileStats.gaveUp > 0) d.precompile = { ...precompileStats, running: precompileRun !== null };
    const choice = owned.renderer !== null && !disposed ? owned.renderer.info() : lastRendererInfo;
    if (choice !== null) d.renderer = choice;
    // `shadowReason` is present iff `shadows === 'off'`.
    if (shadowState.shadows === 'off' && shadowState.reason !== undefined) {
      d.shadowReason = shadowState.reason;
    }
    // The lights that are on.
    if (lightSelection !== null && !disposed) {
      d.lights = { directional: lightSelection.directional, ambient: lightSelection.ambient, hemisphere: lightSelection.hemisphere, local: lightSelection.localTotal, localOn: lightSelection.localOn, cookies: cookies.size };
    }
    // The `models` counters block — present iff the `models`
    // option was given and the adapter is not disposed (absent when
    // `models` is absent; after dispose the realization is gone).
    if (realization !== null && !disposed) {
      d.models = realization.counters();
    }
    const liveRenderer = owned.renderer !== null && !disposed ? owned.renderer.current() : null;
    if (liveRenderer !== null) d.gpu = rendererMemory(liveRenderer);
    if (effects !== null && !disposed) d.effects = effects.diagnostics();
    if (!disposed && lastFrameDrawn) {
      const ros = (liveRenderer as unknown as { _objects?: { _renderObjects?: Iterable<{ object?: THREE.Object3D; geometry?: THREE.BufferGeometry; _nodeBuilderState?: unknown }> } } | null)?._objects?._renderObjects;
      if (ros !== undefined) {
        const meshes = new Set<unknown>();
        const states = new Set<unknown>();
        for (const ro of ros) {
          if (ro.geometry?.getAttribute?.(`${INSTANCE_MATRIX_ATTRIBUTE}0`) === undefined) continue;
          meshes.add(ro.object);
          if (ro._nodeBuilderState != null) states.add(ro._nodeBuilderState);
        }
        d.instanced = { meshes: meshes.size, programs: states.size };
      }
    }
    if (batcher !== null && !disposed && lastFrameDrawn) {
      d.batching = batcher.diagnostics();
      // Distinct node programs of the batch meshes' render objects (three 0.186 internals, guarded).
      const ros = (liveRenderer as unknown as { _objects?: { _renderObjects?: Iterable<{ object?: THREE.Object3D; _nodeBuilderState?: unknown }> } } | null)?._objects?._renderObjects;
      if (ros !== undefined) {
        const states = new Set<unknown>();
        for (const ro of ros) if (ro.object?.userData['tlBatch'] === true && ro._nodeBuilderState != null) states.add(ro._nodeBuilderState);
        d.batching = { ...d.batching, programs: states.size };
      }
    }
    if (!disposed && blockView.layerIds().length > 0) d.blocks = blockView.diagnostics();
    if (!disposed && materialLibrary !== null && runtimeMaterials !== null) d.materials = { graphMaterials: materialLibrary.graphMaterialCount(), ...runtimeMaterials.diagnostics() };
    if (environmentRenderer !== null && !disposed) d.environment = { iblRebakes: environmentRenderer.diagnostics().iblRebakes };
    if (liveRenderer !== null && lastFrameDrawn) d.frame = { drawCalls: lastFrameCounts.drawCalls, triangles: lastFrameCounts.triangles };
    return {
      ok: true,
      diagnostics: d,
    };
  }

  function dispose(): { ok: true; alreadyDisposed?: true } | { ok: false; error: AdapterError } {
    if (disposed) return { ok: true, alreadyDisposed: true };
    disposed = true;
    for (const rec of animatorPlayers.values()) rec.player.dispose();
    effects?.dispose();
    effectTextures?.releaseHolder('effects');
    resources.releaseHolder(EFFECTS_HOLDER);
    for (const h of effectMaterials.values()) h.geometry.dispose();
    effectMaterials.clear();
    animatorPlayers.clear();
    lightmaps?.dispose();
    runtimeMaterials?.dispose();
    sceneHolds.clear();
    materialLibrary?.dispose();
    environmentRenderer?.dispose();
    environmentHolds?.releaseHolder('environment');
    for (const light of cookies.keys()) cookieHolds?.releaseHolder(light.uuid);
    // Tear down the model realization
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
    // A manager of the adapter's own goes with it (the page's is the page's).
    if (opts.resources === undefined) resources.dispose();
    // Release ALL owned Object3D/material/renderer lifetimes (repeatable
    // disposal, as in runtime.md: no leaked loop, no stale GPU state).
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
    batcher?.dispose();
    blockView.dispose();
    for (const rec of boxMaterials.values()) rec.material.dispose();
    boxMaterials.clear();
    boxMaterialKeys.clear();
    unitBox.dispose();
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

  const projectScratch = new THREE.Vector3();
  const projectScratch2 = new THREE.Vector3();
  const api: SceneAdapter = {
    renderFrame,
    captureScreenshot,
    captureThumbnail,
    rendererStarting(): boolean {
      if (disposed) return false;
      const h = owned.renderer;
      // No renderer yet: the next frame creates one, unless that was tried and failed.
      if (h === null) return !contextAttempted && typeof canvasLike?.getContext === 'function';
      const state = h.info().state;
      return state !== 'failed' && state !== 'lost' && (h.current() === null || !h.ready());
    },
    diagnostics,
    dispose,
    setQuality(level: QualityLevel): void {
      playerQuality = level;
      environmentRenderer?.setQuality(level);
    },
    projectToScreen(target, out): boolean {
      if (disposed || camera === null) return false;
      const p = projectScratch;
      if (typeof target.entityId === 'string') {
        const obj = objects.get(target.entityId);
        if (obj === undefined) return false;
        obj.getWorldPosition(p);
      } else if (target.point !== undefined && target.point.length === 3) p.set(target.point[0]!, target.point[1]!, target.point[2]!);
      else return false;
      if (target.offset !== undefined && target.offset.length === 3) p.set(p.x + target.offset[0]!, p.y + target.offset[1]!, p.z + target.offset[2]!);
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return false;
      camera.updateMatrixWorld();
      // In front: the point's depth in camera space is negative (cameras look down −Z).
      const front = projectScratch2.copy(p).applyMatrix4(camera.matrixWorldInverse).z < 0;
      p.project(camera);
      out[0] = (p.x + 1) / 2;
      out[1] = (1 - p.y) / 2;
      out[2] = front ? 1 : 0;
      return true;
    },
    previewEnvironmentBlend(view: EnvironmentBlendView | null): void {
      envPreview = view;
    },
    prepareScene(sceneId, entities, textures) {
      sceneHolds.get(sceneId)?.release();
      sceneHolds.delete(sceneId);
      if (disposed) return { ready: Promise.resolve(), release: () => undefined };
      const refs = modelRefsOf(entities);
      const assets = new Set([...refs.models.values(), ...[...refs.instances.values()].map((r) => r.assetId)]);
      const held = realization?.hold?.(assets, [...refs.instances.values()].map((r) => r.buffer)) ?? null;
      const decoded = textures !== undefined && textures.length > 0 && materialLibrary?.preloadTextures !== undefined ? materialLibrary.preloadTextures(textures) : null;
      let released = false;
      const handle = {
        release: (): void => {
          if (released) return;
          released = true;
          held?.release();
          decoded?.release();
          if (sceneHolds.get(sceneId) === handle) sceneHolds.delete(sceneId);
        },
      };
      sceneHolds.set(sceneId, handle);
      return { ready: Promise.all([held?.ready ?? Promise.resolve(), decoded?.ready.catch(() => undefined)]).then(() => undefined), release: handle.release };
    },
    presentedSceneRevision(): number {
      return presentedRevision;
    },
    setEnvironmentLayer(layer: EnvironmentLayerLike | null): void {
      if (JSON.stringify(layer) === JSON.stringify(environmentLayer)) return;
      environmentLayer = layer;
      environmentRenderer?.set(effectiveEnvironment());
      if (materialLibrary !== null) materialLibrary.setWind(((layer?.wind as WindLike | undefined) ?? opts.materials?.wind ?? null) as WindLike | null);
    },
  };
  // The settle surface — present iff the `models` option was
  // given. A config-invalid block resolves the structured failure (the
  // wrapper posts `tl.error`); a realized block resolves when every
  // prepare has settled. Never rejects.
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