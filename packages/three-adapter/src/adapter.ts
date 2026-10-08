/**
 * Three.js scene adapter (runtime.md frame ordering, adapter diagnostics
 * and environment; the dependencies.md surface row:
 * `createSceneAdapter(canvas, opts) → SceneAdapter { renderFrame,
 * captureScreenshot(maxWidth), diagnostics, dispose }`, `ERROR_CODES`).
 *
 * The adapter owns ALL Object3D/material/renderer lifetimes for the
 * scene graph: box primitives (unit-geometry scaled by `size`, simple
 * Lambert material from `material.color`), the view's perspective camera
 * (posed by the runtime's camera brain: the engine owns the view), and a fixed
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
import { createMaterialLibrary, type MaterialDefLike, type MaterialLibrary, type WindLike } from './material-library';
import { createAnimatorPlayer, type AnimatorPlayer, type AnimatorPoseLike } from './animator-player';
import { addBoxLightmapUv, createLightmapSet, type LightingBakeLike, type LightmapSet } from './lightmaps';
import { createProbeLightingHost } from './probe-grids';
import { releaseEmissiveLooks, setEntityLook, SHARED_MATERIAL_KEY } from './node-materials';
import { disposeObjectTree } from './dispose';
import { bothMemberships, ViewCuller } from './view-cull';
import { LOD_TUNING_KEY } from './lod-switch';
import { BATCH_KEY, createAutoBatcher, markBatchable, unitBoxGeometry, type AutoBatcher, type AutoBatcherDiagnostics } from './batching';
import { markStatic, STATIC_KEY } from './static-merge';
import { compileIntoTarget, type Precompile } from './environment-nodes';
import { INSTANCE_MATRIX_ATTRIBUTE } from './attribute-instancing';
import { createEnvironmentRenderer, environmentTextureIds, renderPixelRatio, type EnvironmentLike, type EnvironmentRenderer, type FogVolumeLike, type QualityLevel } from './environment';
import { ENV_STALE, EnvironmentLook } from './environment-look';
import { createQualityControl } from './quality-control';
import { createGpuTiming } from './gpu-timing';
import { createRenderControl } from './render-control';
import * as THREE from 'three';
import { syncCellUv } from './block-cell-uv';
import { type BlockLayerViewDiagnostics } from './block-layers';
import { createLevelViews } from './level-views';
import { PageWorldStream, STREAMING_KEY } from './world-stream';
import { createCutawayFollower } from './block-cutaway-follow';
import { createBrowserMeshWorker } from './block-mesh-pool';
import { TERRAIN_ENTITY_KEY, TerrainView } from './terrain-view';
import { createScatterHost } from './scatter-host';
import { SplineView } from './spline-view';
import { TerrainTileStore } from './terrain-tile-store';
import { RuntimeMaterialView, type MaterialRenderChangeLike, type RuntimeMaterialsDiagnostics } from './runtime-materials';
import { MaterialSwapView, type MaterialMappingLike } from './material-swaps';
import { materialParamsOf, modelRefsOf } from './entity-refs';
import type { BlockLayerComponent, BlockLayerData, BlockType, GridRenderChange, SplineComponent, TerrainComponent } from '@thirdlight/runtime';
import type { Runtime, RuntimeSnapshot } from '@thirdlight/runtime';
import type { EnvironmentBlendView } from '@thirdlight/runtime';
import { adapterError, type AdapterError } from './errors';
import { createFrameCapture, type ScreenshotResult } from './capture';
export type { ScreenshotResult } from './capture';
import { EntityNode, RenderGraph } from './render-graph';
import {
  createModelsRealization,
  type ModelsRealization,
  type ModelsSettledResult,
  type SceneAdapterModelAsset,
  type SceneAdapterModels,
  type SceneAdapterModelsDiagnostics,
} from './models';
import type { GlbLoaderPort } from './visual';
import { createResourceManager, type ResourceManager } from '@thirdlight/runtime';
import { textureHolds, type TextureHolds } from './texture-holds';
import { objectResidentBytes } from './resource-bytes';
import {
  ANIMATION_MAX_DELTA_SECONDS,
  type AnimationRoleView,
} from './animation';
import type { AuthoredSurface } from './lighting';
import { applyEntityRenderFlags } from './entity-render-flags';
import { createSceneLights, type LightValueOverride, type SceneLights } from './lights-shadows';
import { STATIC_CASTER_KEY, StaticShadowRevision } from './shadow-casters';
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

export { PRECOMPILE_STALL_MS, PRECOMPILE_WAIT_MS, type FrameDrawnInfo, type SceneAdapter, type SceneAdapterDiagnostics, type SceneAdapterOptions } from './adapter-types';
import { PRECOMPILE_STALL_MS, PRECOMPILE_WAIT_MS, type FrameDrawnInfo, type SceneAdapter, type SceneAdapterDiagnostics, type SceneAdapterOptions } from './adapter-types';

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

/** An environment preset (project-model's, as the runtime's blend maths takes it). */

const NO_HIDDEN: ReadonlySet<string> = new Set();
/** An applied-blend key no blend has: the next frame applies the blend (or its end) again. */

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
  if (opts.background !== undefined) scene.background = new THREE.Color(opts.background);
  // Project materials (shared by boxes, models and instance sets), node materials.
  /** The lightmap set once it exists (the library may report a change while it is still being set up). */
  let lightmapsLive: LightmapSet | null = null;
  /** A library the host keeps (the editor's) is used as it is: the host sets its materials and wind and disposes it. */
  const ownLibrary = opts.materials !== undefined && opts.materials.library === undefined;
  const materialLibrary: MaterialLibrary | null =
    opts.materials?.library ??
    (opts.materials !== undefined
      ? createMaterialLibrary({
          loadTexture: opts.materials.loadTexture,
          resources,
          // A project material changed in place (a texture arrived): lightmapped
          // copies made before are clones and follow it (else they keep the texture-less look).
          onChange: () => lightmapsLive?.refresh(),
        })
      : null);
  if (materialLibrary !== null && opts.materials !== undefined && ownLibrary) {
    materialLibrary.setMaterials(opts.materials.defs, opts.materials.functions ?? []);
    materialLibrary.setWind(opts.materials.wind);
  }
  const materialUndo = new Map<string, () => void>();
  /** The material swaps the running game made, put on once their materials have loaded (created with the scene below). */
  let materialSwaps: MaterialSwapView | null = null;
  /** An object's own mapping with the swap it wears over it (undefined: none of either). */
  const effectiveMaterials = (entityId: string, own: Readonly<Record<string, string>> | undefined): Readonly<Record<string, string>> | undefined => {
    const swap = materialSwaps?.swapOf(entityId) ?? null;
    return swap === null ? own : { ...(own ?? {}), ...swap };
  };
  /** The values scripts set per object (the simulation's material changes). */
  let runtimeMaterials: RuntimeMaterialView | null = null;
  /** Lightmaps of the baked static objects; the lights a bake holds are not realtime (an editing host replaces the bakes). */
  const lightmapSetOf = (bakes: Readonly<Record<string, LightingBakeLike>> | null): LightmapSet | null =>
    opts.lighting !== undefined && bakes !== null && Object.keys(bakes).length > 0
      ? createLightmapSet(bakes, textureHolds(resources, opts.lighting.loadTexture), (ids) =>
          ids.some((id) => {
            const t = (entityDocs.get(id)?.components as { light?: { type?: string } } | undefined)?.light?.type;
            return t === 'ambient' || t === 'hemisphere';
          }),
          // Its meshes wear lightmapped copies now: they leave their groups.
          (root) => batcher?.touch(root),
        )
      : null;
  let lightmaps: LightmapSet | null = lightmapSetOf(opts.lighting?.bakes ?? null);
  lightmapsLive = lightmaps;
  /** The loaded scenes' baked probe tiles (they follow the realized scenes) and the probe light every material samples. */
  const probes = createProbeLightingHost(scene, resources, opts.lighting?.loadBytes, { onChange: () => opts.onChange?.(), ...(opts.lighting?.onProblem !== undefined ? { onProblem: opts.lighting.onProblem } : {}) });
  probes.setBakes(opts.lighting?.bakes ?? null);
  /** Entities the runtime hides (`ctx.game.setVisible`, a collected collectible), with their children. */
  let hiddenIds: ReadonlySet<string> = NO_HIDDEN;
  /** The hidden set last derived from (the runtime hands out the same set while nothing changes). */
  let hiddenSeen: { set: ReadonlySet<string> | null; size: number; revision: number } = { set: null, size: 0, revision: -1 };
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
      // Poses for an object taken in as static (its animator came later): posed from now on, not baked.
      graph.ensureAnimated(id);
      rec.player.apply(pose);
    }
  };
  /** The environment renderer (created with the renderer). */
  let environmentRenderer: EnvironmentRenderer | null = null;
  /** The environment's textures (held while it exists). */
  let environmentHolds: TextureHolds | null = null;
  /** The size last handed to the environment renderer (it rebuilds its post stack on a change). */
  let environmentSize: [number, number] | null = null;
  /** The scenes' looks (absent: the environment's value is the whole look). */
  const sceneLooks = opts.environment?.scenes ?? null;
  /** The look drawn: the project environment (an editing host replaces it, `setEnvironment`), the active scene's look, a blend. */
  const envLook = new EnvironmentLook(
    {
      sceneLooks,
      readBlend: () => (opts.runtime as { readEnvironmentBlend?: () => EnvironmentBlendView | null }).readEnvironmentBlend?.() ?? null,
      renderer: () => environmentRenderer,
      lights: () => lights,
      lightmaps: () => lightmaps,
      materials: materialLibrary,
      defaultWind: opts.materials?.wind ?? null,
    },
    opts.environment?.value ?? null,
    (opts.snapshot as { tags?: readonly { bit: number; name: string }[] }).tags ?? [],
  );
  const envTagBits = envLook.tagBits;
  const effectiveEnvironment = (): EnvironmentLike | null => envLook.effective();
  const applyEnvironmentBlend = (): void => envLook.apply();
  const fogVolumeIds = new Set<string>();
  const tmpWorld: number[] = [0, 0, 0];
  const tmpSize = new THREE.Vector2();
  /** The fog volumes of the loaded scenes, in world space (entities may move). */
  const fogVolumesNow = (): FogVolumeLike[] => {
    const out: FogVolumeLike[] = [];
    for (const id of fogVolumeIds) {
      const doc = entityDocs.get(id) as { components: { fogVolume?: { size: [number, number, number]; density: number; color: string; falloff?: number; heightFalloff?: number } } } | undefined;
      const fv = doc?.components.fogVolume;
      if (fv === undefined || graph.isHidden(id) || !graph.world.position(id, tmpWorld)) continue;
      out.push({ center: [tmpWorld[0]!, tmpWorld[1]!, tmpWorld[2]!], size: fv.size, density: fv.density, color: fv.color, ...(fv.falloff !== undefined ? { falloff: fv.falloff } : {}), ...(fv.heightFalloff !== undefined ? { heightFalloff: fv.heightFalloff } : {}) });
    }
    return out;
  };
  const clockStart = typeof performance !== 'undefined' ? performance.now() : 0;
  /**
   * The entities' world matrices, and the scene as a flat list of drawables
   * (render-graph.ts): an entity that shows something has a node outside the
   * scene that holds what it shows; one that shows nothing has no Object3D.
   */
  const graph = new RenderGraph(scene, (entityId) => {
    const c = entityDocs.get(entityId)?.components as { animator?: unknown; modelAnimation?: unknown } | undefined;
    return c?.animator !== undefined || c?.modelAnimation !== undefined;
  });
  if (opts.lod !== undefined) graph.lodTuning.set(opts.lod);
  // Tools reading the scene (the perf harness) find the frame's LOD switches with it.
  scene.userData[LOD_TUNING_KEY] = graph.lodTuning;
  /** One object's own meshes (its child objects have nodes of their own). */
  const ownMeshes = (entityId: string): THREE.Object3D[] => {
    const out: THREE.Object3D[] = [];
    graph.node(entityId)?.traverse((o) => void ((o as THREE.Mesh).isMesh === true && out.push(o)));
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
                      return { value: root, ...objectResidentBytes(root), free: (r) => disposeObjectTree(r) };
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
  const gpuTiming = createGpuTiming();
  // AO kind, render scale and dynamic resolution, applied to the environment renderer.
  const renderControl = createRenderControl(opts.render);
  /** The transform sync for `forEachInterpolated` (one function for the adapter's life): into the world table. */
  const applyInterpolated = (id: string, position: readonly number[], rotation: readonly number[], scale: readonly number[]): void => {
    graph.world.setLocal(id, position, rotation, scale);
  };
  /** The graph's revision at the last transform sync (a change: every transform is read again). */
  let syncedRevision = -1;
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
  // Where the view starts (the runtime's camera brain resolved it before the first frame; the shots move it from there).
  const startView: [number, number, number] = [0, 0, 0];
  (opts.runtime as { readCameraView?: (p: number[], r: number[]) => unknown }).readCameraView?.(startView, [0, 0, 0, 1]);
  /**
   * The loaded scenes' lights and the key light's shadow (lights-shadows.ts):
   * a point or spot light hangs on its entity's node; the others off the scene.
   */
  /** What the cached static shadow map shows changed (null: every caster drawn into one map every frame). */
  const staticShadows = opts.shadowCache === false ? null : new StaticShadowRevision();
  graph.onStaticChange(staticShadows === null ? null : (where) => (where === null ? staticShadows.bump() : staticShadows.touched(where)));
  const lights: SceneLights = createSceneLights({
    scene,
    v3: isV3,
    staticShadows,
    startView,
    resources,
    loadCookie: opts.lights?.loadTexture ?? opts.materials?.loadTexture ?? opts.environment?.loadTexture ?? null,
    bakedLight: (id) => lightmaps?.isBakedLight(id) === true,
    place: (id, light) => graph.nodeFor(id)?.add(light),
    shadingChanged: () => {
      precompileWanted ??= 'scene';
      opts.onChange?.();
    },
    tagBits: envTagBits,
  });

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
  /** What batches, instance-set chunks and merged cells draw is culled inside against the frame's camera. */
  const viewCull = new ViewCuller();
  const batcher: AutoBatcher | null = opts.batching === false ? null : createAutoBatcher(scene, { merging: opts.merging ?? 'load', viewCull, park: (o, on) => graph.park(o, on), ...(staticShadows !== null ? { staticChanged: (where) => (where === null ? staticShadows.bump() : staticShadows.touched(where)) } : {}) });
  // A scene dump (the perf harness's plain page) reads the parked drawables with the scene.
  scene.userData['tlParked'] = graph.parkedObjects();
  // The world matrices are brought up to date right before every render (the batcher's update, else here, so the
  // view culls with them): the renderer's own pass is left out.
  scene.matrixWorldAutoUpdate = false;
  // They hear what enters and leaves the scene and what moved from the render graph (neither walks the scene).
  graph.setMembership(bothMemberships(batcher, viewCull));
  /** An entity's look, material or flags changed outside its realization: its meshes are grouped again. */
  const regroupEntity = (id: string): void => {
    const node = batcher === null ? undefined : graph.node(id);
    if (node !== undefined) batcher!.touch(node);
  };
  // A block chunk's UVs follow the unit its (re)defined material reads (cells or metres), before it is grouped again.
  const stopCellUv = materialLibrary?.onReassigned?.((root) => void ((root as THREE.Mesh).isMesh === true && syncCellUv(root as THREE.Mesh)));
  // Project materials redefined (an editing host): the meshes wearing them are grouped again.
  const stopReassigned = batcher === null ? undefined : materialLibrary?.onReassigned?.((root) => batcher.touch(root));
  /** The documents of every realized entity (the loaded scenes). */
  const entityDocs = new Map<string, (typeof opts.snapshot.scene.entities)[number]>();
  // Block layers — merged chunk meshes per block look (the same view as the editor's Scene view).
  const blockPrefabs = (opts.snapshot as { prefabs?: readonly { prefabId: string; entities: readonly { parentLocalId?: string; components: Record<string, unknown> }[] }[] }).prefabs ?? [];
  const assetMaterialsOf = (assetId: string): Readonly<Record<string, string>> | undefined => (opts.models?.assets.find((a) => a.assetId === assetId) ?? opts.models?.rowOf?.(assetId))?.materials;
  // World streaming (a game page): what streamed terrains, layers and scatter hold round the camera, within the budget.
  const stream = opts.streaming !== undefined ? new PageWorldStream({ budgetBytes: opts.streaming.budgetBytes, resources, ...(opts.streaming.onProblem !== undefined ? { onProblem: opts.streaming.onProblem } : {}) }) : null;
  if (stream !== null) scene.userData[STREAMING_KEY] = stream;
  // Rule scatter on block layers and terrains: stored copies and ground cover (scatter-host.ts).
  const scatter = createScatterHost({
    stream,
    template: (assetId, piece, onReady) => realization?.blockInstance?.(assetId, piece, onReady) ?? null,
    dress: (root, assetId) => {
      const mapping = assetMaterialsOf(assetId);
      return materialLibrary !== null && mapping !== undefined && Object.keys(mapping).length > 0 ? materialLibrary.apply(root, mapping, null) : null;
    },
    read: opts.resolveBuffer ?? opts.models?.resolveBuffer ?? null,
    place: (root, shown) => (shown ? graph.listStatic(root) : graph.unlistStatic(root)),
    shapeChanged: () => staticShadows?.bump(),
    tile: (digest) => (opts.terrainTiles ?? ownTiles)?.tile(digest),
    ...(opts.meshWorkerUrl !== undefined ? { worker: () => createBrowserMeshWorker(opts.meshWorkerUrl!, 'thirdlight-cover'), scatterWorker: () => createBrowserMeshWorker(opts.meshWorkerUrl!, 'thirdlight-scatter') } : {}),
    tuning: graph.lodTuning, renderer: () => owned.renderer?.current() ?? null,
    changed: () => opts.onChange?.(),
    drawn: opts.scatter !== false,
  });
  // Splines: what they make (meshes, pieces' copies), and terrain ground cover kept clear of their scatter bands.
  const splines = new SplineView({
    cover: (list) => scatter.sink?.setSplines?.(list),
    read: opts.resolveBuffer ?? opts.models?.resolveBuffer ?? null,
    template: (assetId, piece, onReady) => realization?.blockInstance?.(assetId, piece, onReady) ?? null,
    dress: (root, assetId) => {
      const mapping = assetMaterialsOf(assetId);
      return materialLibrary !== null && mapping !== undefined && Object.keys(mapping).length > 0 ? materialLibrary.apply(root, mapping, null) : null;
    },
    materials: (root, id) => {
      const c = entityDocs.get(id)?.components as { materials?: Record<string, string> } | undefined;
      const mapping = effectiveMaterials(id, c?.materials);
      return materialLibrary !== null && mapping !== undefined ? materialLibrary.apply(root, mapping, materialParamsOf(c)) : null;
    },
    place: (root, shown) => (shown ? graph.listStatic(root) : graph.unlistStatic(root)),
    shapeChanged: () => staticShadows?.bump(),
    tuning: graph.lodTuning,
    changed: () => opts.onChange?.(),
    drawn: opts.splines !== false,
  });
  // Block layers and terrains (level-views.ts), streamed round the camera on a game page.
  const { blockView, terrains, ownTiles } = createLevelViews({
    blockInstance: (assetId, piece, onReady) => realization?.blockInstance?.(assetId, piece, onReady) ?? null,
    prefabs: blockPrefabs, assetMaterials: assetMaterialsOf, materials: materialLibrary, lightmaps: () => lightmaps,
    precompile: (probe) => cutaways.probe(probe),
    staticShadows, listStatic: (o) => graph.listStatic(o), unlistStatic: (o) => graph.unlistStatic(o), lodBias: () => graph.lodTuning.bias,
    scatter: scatter.sink, stream, meshWorkerUrl: opts.meshWorkerUrl, tiles: opts.terrainTiles, read: opts.resolveBuffer ?? opts.models?.resolveBuffer ?? null, onChange: () => opts.onChange?.(),
    // The key light shines along its direction: toward it is the other way.
    sun: () => (([x, y, z]) => [-x, -y, -z] as const)(lights.keyDirection() ?? [0, 0, 0]),
    horizon: opts.terrainHorizon !== false,
  });
  /** The block layers realized from their documents (a host may drive layers of its own through `blockLayers()`). */
  const docLayers = new Set<string>();
  // Cut-aways follow their subject; their fade copies are compiled ahead.
  const cutaways = createCutawayFollower({
    view: blockView,
    scene,
    runtime: opts.runtime,
    position: (id, out) => graph.world.position(id, out),
    precompileIdle: () => precompileWanted === null && precompileRun === null,
    requestPrecompile: () => void (precompileWanted ??= 'scene'),
    ...(opts.onChange !== undefined ? { onChange: () => opts.onChange!() } : {}),
  });
  /** What a host hangs on entities (the editor's icons and outlines): it rides on the entity's node. */
  const overlays = new Map<string, Set<THREE.Object3D>>();
  const authoredBlockTypes = ((opts.snapshot as { blockTypes?: readonly BlockType[] }).blockTypes ?? []) as BlockType[];
  blockView.setTypes(authoredBlockTypes);
  /**
   * The static scope of each realized entity that never moves: its scene (static batching merges per scene, so
   * an unload drops only that scene's merged cells). None for an object kept loaded across scenes or spawned.
   */
  const staticScopes = new Map<string, string>();
  const realizeEntity = (e: (typeof opts.snapshot.scene.entities)[number], sceneId: string | null = null): void => {
    const t = e.components.transform;
    graph.addEntity(e.id, e.parentId ?? null);
    const flags = e as { static?: boolean; keepLoaded?: boolean };
    const scope = sceneId !== null && flags.static === true && flags.keepLoaded !== true ? sceneId : null;
    if (scope !== null) staticScopes.set(e.id, scope);
    graph.world.setLocal(e.id, t.position, t.rotation, t.scale);
    entityDocs.set(e.id, e);
    // Only an entity that shows something (or anchors an effect) gets a node, when it does; the rest is the table row.
    let boxMesh: THREE.Mesh | null = null;
    const own: { geometries: THREE.BufferGeometry[]; materials: THREE.Material[]; shared?: THREE.Material } = { geometries: [], materials: [] };
    const box = e.components.box;
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
      boxMesh = new THREE.Mesh(geometry, material);
      // Drawn through the one unit box scaled by the size when batched.
      boxMesh.userData[BATCH_KEY] = { geometry: unitBox, scale: [box.size[0], box.size[1], box.size[2]] };
      if (scope !== null) boxMesh.userData[STATIC_KEY] = scope;
      // Boxes cast and receive the key light's shadow (data: box.castShadow / receiveShadow), in their light layers.
      applyEntityRenderFlags(boxMesh, e.components);
      graph.nodeFor(e.id)!.add(boxMesh);
    } else lights.realize(e);
    // A block layer (its cells ride on the resolved component).
    const layer = (e.components as { blockLayer?: BlockLayerComponent & { data?: BlockLayerData } }).blockLayer;
    if (layer !== undefined) {
      docLayers.add(e.id);
      blockView.setLayer(e.id, layer, t.position, layer.data ?? null);
    }
    const terrain = (e.components as { terrain?: TerrainComponent }).terrain;
    const spline = (e.components as { spline?: SplineComponent }).spline;
    if (spline !== undefined) splines.set(e.id, spline, t.position);
    if (terrain !== undefined && opts.terrain !== false) terrains.setTerrain(e.id, terrain, t.position, { components: e.components, materials: effectiveMaterials(e.id, (e.components as { materials?: Record<string, string> }).materials) ?? null, overrides: materialParamsOf(e.components) });
    if ((e.components as { fogVolume?: unknown }).fogVolume !== undefined) fogVolumeIds.add(e.id);
    const node = graph.node(e.id);
    const boxMaterials = effectiveMaterials(e.id, (e.components as { materials?: Record<string, string> }).materials);
    // With the object's values for its graph materials' public parameters.
    if (boxMesh !== null && node !== undefined && materialLibrary !== null && boxMaterials !== undefined) materialUndo.set(e.id, materialLibrary.apply(node, boxMaterials, materialParamsOf(e.components)));
    if (boxMesh !== null && node !== undefined) lightmaps?.apply(e.id, node);
    if (own.geometries.length > 0) entityResources.set(e.id, own);
    // An effect component plays from the object (on start unless it waits for a signal or a script).
    const fx = (e.components as { effect?: EffectComponentLike }).effect;
    if (effects !== null && fx !== undefined) {
      effectEntities.add(e.id);
      effects.attach(e.id, graph.nodeFor(e.id)!, fx, fx.playOnStart !== false);
    }
    // What a host hangs on it (back after the entity was realized again), last: the material, look and lightmap paths above never see it.
    const hung = overlays.get(e.id);
    if (hung !== undefined) {
      const holder = graph.nodeFor(e.id)!;
      for (const o of hung) holder.add(o);
    }
  };
  const releaseEntity = (id: string): void => {
    if (docLayers.delete(id)) blockView.removeLayer(id);
    terrains.removeTerrain(id);
    splines.remove(id);
    runtimeMaterials?.release(id);
    if (effects !== null) {
      effects.detach(id);
      effectEntities.delete(id);
    }
    const obj = graph.node(id);
    // Per-object looks first (a look override's own copies), then the shared paths undo.
    if (obj !== undefined) releaseEmissiveLooks(obj);
    lightmaps?.release(id);
    fogVolumeIds.delete(id);
    // Its light (a directional or ambient light hangs off the scene; one on the node goes with it).
    lights.release(id);
    // What a host hangs on it leaves the node first (the host keeps it; it comes back when the entity does).
    const hung = overlays.get(id);
    if (hung !== undefined && obj !== undefined) for (const o of hung) obj.remove(o);
    materialUndo.get(id)?.();
    materialUndo.delete(id);
    materialSwaps?.removed(id);
    // Its drawables leave the scene first (the node's tree is all its own: children have nodes of their own).
    graph.removeEntity(id);
    if (obj !== undefined) {
      // Its render objects (a material that outlives it — a project material, a shared box
      // material — would keep them) and a light's shadow map.
      disposeObjectTree(obj);
    }
    entityDocs.delete(id);
    staticScopes.delete(id);
    const own = entityResources.get(id);
    if (own !== undefined) {
      for (const g of own.geometries) g.dispose();
      for (const m of own.materials) m.dispose();
      if (own.shared !== undefined) releaseBoxMaterial(own.shared);
      entityResources.delete(id);
    }
  };
  {
    // The start scenes' entities, each with its scene (the snapshot's own scene when the runtime has no scene set).
    const sceneOf = new Map<string, string>();
    for (const b of opts.runtime.sceneSet?.()?.batches ?? []) for (const e of b.entities) sceneOf.set((e as { id: string }).id, b.sceneId);
    const own = (opts.snapshot.scene as { sceneId?: string }).sceneId ?? null;
    for (const e of opts.snapshot.scene.entities) realizeEntity(e, sceneOf.get(e.id) ?? own);
  }
  // The view's camera, posed every frame from the camera brain (`applyResolvedCamera`). Aspect is a viewport
  // property, updated per frame from the canvas size.
  camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(startView[0], startView[1], startView[2]);
  // --- The model realization ------------
  // The entity nodes are made on demand (`holderFor`); the prepared
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
        const d = opts.runtime.getDiagnostics?.();
        if (d?.ok === true && Number.isFinite(d.diagnostics.stepIndex)) stepIndex = Math.trunc(d.diagnostics.stepIndex);
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
      entityMaterials: (entityId: string) => effectiveMaterials(entityId, (entityDocs.get(entityId)?.components as { materials?: Record<string, string> } | undefined)?.materials) ?? null,
      entityMaterialParams: (entityId: string) => materialParamsOf(entityDocs.get(entityId)?.components),
      ...(opts.snapshot.scenes !== undefined ? { allowAbsent: true } : {}),
      holderFor: (entityId: string) => graph.nodeFor(entityId) ?? null,
      viewFor,
      lodTuning: graph.lodTuning,
      onAttached: (entityId: string, root: THREE.Object3D) => {
        // Models and instance sets cast and receive the key light's shadow (their data), in their light layers.
        applyEntityRenderFlags(root, entityDocs.get(entityId)?.components);
        // Values a script set before the model arrived.
        runtimeMaterials?.reapply(entityId);
        // A model's meshes may be drawn together with other placements' (instance sets already are), or merged when static.
        markBatchable(root);
        const scope = staticScopes.get(entityId);
        if (scope !== undefined) {
          markStatic(root, scope);
          // Marked after its meshes came into the scene: the static shadow map takes them now.
          staticShadows?.bump();
        }
        lightmaps?.apply(entityId, root);
        opts.onChange?.();
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

  if (materialLibrary !== null) {
    const textureRefs = opts.materials?.textureRefs;
    const assetMaterials = (assetId: string | undefined): Readonly<Record<string, string>> | undefined => (assetId === undefined ? undefined : opts.models?.assets.find((a) => a.assetId === assetId)?.materials);
    materialSwaps = new MaterialSwapView({
      entityMapping: (entityId, swap) => {
        const c = entityDocs.get(entityId)?.components as { materials?: Record<string, string>; model?: { asset?: { assetId?: string } }; instances?: { asset?: { assetId?: string } } } | undefined;
        if (c === undefined) return null;
        const mapping = { ...(assetMaterials(c.model?.asset?.assetId ?? c.instances?.asset?.assetId) ?? {}), ...(c.materials ?? {}), ...(swap ?? {}) };
        return Object.keys(mapping).length === 0 ? null : mapping;
      },
      blockMapping: (blockId, swap) => {
        const own = authoredBlockTypes.find((t) => t.blockId === blockId)?.materials;
        const mapping = { ...(own ?? {}), ...(swap ?? {}) };
        return Object.keys(mapping).length === 0 ? null : mapping;
      },
      textureRefs: (materialId) => textureRefs?.(materialId) ?? [],
      ...(materialLibrary.preloadTextures !== undefined ? { preload: (ids: readonly string[]) => materialLibrary.preloadTextures!(ids) } : {}),
      applyEntity: (entityId) => {
        const e = entityDocs.get(entityId);
        // A spline's mesh wears it (drawn by the spline view, no entity node of its own).
        if (e !== undefined && !disposed && (e.components as { spline?: unknown }).spline !== undefined) return splines.restyle(entityId);
        // A terrain's pages wear it (no entity node of its own).
        if (e !== undefined && !disposed && (e.components as { terrain?: unknown }).terrain !== undefined) return terrains.restyle(entityId, effectiveMaterials(entityId, (e.components as { materials?: Record<string, string> }).materials) ?? null, materialParamsOf(e.components));
        const obj = graph.node(entityId);
        if (e === undefined || obj === undefined || disposed) return;
        // The lightmapped copies are of the materials worn before: taken off, then made again over the new ones.
        lightmaps?.release(entityId);
        let root: THREE.Object3D | null = null;
        if ((e.components as { box?: unknown }).box !== undefined) {
          const mapping = effectiveMaterials(entityId, (e.components as { materials?: Record<string, string> }).materials);
          materialUndo.set(entityId, materialLibrary.apply(obj, mapping ?? null, materialParamsOf(e.components)));
          root = obj;
        } else root = realization?.reapplyMaterials(entityId) ?? null;
        if (root !== null) lightmaps?.apply(entityId, root);
        // Values a script set on its graph materials go on the new ones.
        runtimeMaterials?.reapply(entityId);
        regroupEntity(entityId);
      },
      applyBlockTypes: () => {
        const swaps = materialSwaps?.appliedBlocks() ?? new Map<string, MaterialMappingLike>();
        blockView.setTypes(authoredBlockTypes.map((t) => {
          const swap = swaps.get(t.blockId);
          return swap === undefined ? t : { ...t, materials: { ...(t.materials ?? {}), ...swap } };
        }));
      },
    });
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
        ...(opts.renderer?.trackTimestamp === true ? { trackTimestamp: true } : {}),
        ...(opts.renderer?.deps !== undefined ? { deps: opts.renderer.deps } : {}),
      });
      owned.renderer = handle;
      const onChange = opts.renderer?.onChange;
      if (onChange !== undefined) handle.onChange(() => onChange(handle.info()));
      pixelRatio = renderPixelRatio(globalThis.window?.devicePixelRatio, qualityControl.pixelRatioCap());
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
    lights.rendererReplaced();
    // A new renderer (a lost device) builds its programs ahead of its first present too.
    precompileRun?.job.release();
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
      const obj = graph.node(id);
      if (obj !== undefined) setEntityLook(obj, null);
      shownLooks.delete(id);
      regroupEntity(id);
    }
    for (const [id, look] of looks) {
      const obj = graph.node(id);
      if (obj === undefined) continue;
      const shown = shownLooks.get(id);
      const meshes = meshCount(obj);
      if (shown !== undefined && sameLook(shown.look, look) && shown.meshes === meshes) continue;
      setEntityLook(obj, look);
      shownLooks.set(id, { look, meshes });
      regroupEntity(id);
    }
  };

  // --- Follow the runtime's scene set --------------------------------------
  /** Scenes realized so far (the start scenes came with the snapshot): their entities, and the list they came in. */
  const realizedScenes = new Map<string, { ids: Set<string>; list: readonly unknown[] }>();
  let realizedRevision = -1;
  {
    const set = opts.runtime.sceneSet?.();
    if (set !== undefined) {
      // A batch counts as realized when the snapshot brought its entities (the others are realized at the first sync).
      for (const b of set.batches) if (b.entities.every((e) => entityDocs.has(e.id))) realizedScenes.set(b.sceneId, { ids: new Set(b.entities.map((e) => e.id)), list: b.entities });
      // Batches the snapshot did not bring are realized at the first sync.
      if (realizedScenes.size === set.batches.length) realizedRevision = set.revision;
    }
  }
  /** The load rank of an entity's scene (higher: loaded later; -1: in none). */
  const sceneRankOf = (id: string): number => {
    let i = 0;
    for (const rec of realizedScenes.values()) {
      if (rec.ids.has(id)) return i;
      i += 1;
    }
    return -1;
  };
  /**
   * Switch the loaded scenes' lights: the most recently loaded
   * scene's directional, ambient and hemisphere light (each kind on its own),
   * point and spot lights within the budget (scene-lights.ts). The key light
   * decides the shadow state.
   */
  function selectLights(): void {
    lights.select(sceneRankOf, hiddenIds);
  }
  selectLights();
  /** The quality level drawn and its renderer settings (quality-control.ts). */
  const qualityControl = createQualityControl(
    {
      renderControl,
      lodTuning: graph.lodTuning,
      setLightLimits: (limits) => lights.setLimits(limits),
      reselectLights: selectLights,
      setPixelRatioCap: (cap) => {
        pixelRatio = renderPixelRatio(globalThis.window?.devicePixelRatio, cap);
        owned.renderer?.current()?.setPixelRatio(pixelRatio);
        // The post stack follows the new drawing-buffer size.
        environmentSize = null;
      },
      environment: () => environmentRenderer,
      changed: () => opts.onChange?.(),
    },
    { project: envLook.value, ...(opts.lod !== undefined ? { lod: opts.lod } : {}), pinned: opts.qualityPinned ?? null },
  );
  /** The probe tiles follow the realized scenes (a host without a scene set draws its snapshot's scene). */
  function followProbeScenes(): void {
    const own = (opts.snapshot.scene as { sceneId?: string }).sceneId;
    probes.follow(realizedScenes.size > 0 ? realizedScenes.keys() : own !== undefined ? [own] : []);
  }
  followProbeScenes();
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
    // Objects that stay when their scene goes (kept loaded) move to the scene-less list as they are drawn.
    const staying = new Map<string, unknown>();
    for (const e of (set as { spawned?: readonly unknown[] }).spawned ?? []) staying.set((e as { id: string }).id, e);
    let removed = false;
    let scenesRemoved = false;
    for (const [sceneId, rec] of [...realizedScenes]) {
      if (live.has(sceneId)) continue;
      const ids = new Set([...rec.ids].filter((id) => {
        if (!staying.has(id) || realizedSpawned.has(id)) return true;
        realizedSpawned.set(id, staying.get(id));
        return false;
      }));
      for (const id of ids) lightmaps?.release(id);
      realization?.removeEntities(ids);
      for (const id of ids) shownLooks.delete(id);
      // Children before parents (reverse document order).
      for (const id of [...ids].reverse()) releaseEntity(id);
      realizedScenes.delete(sceneId);
      removed = true;
      scenesRemoved = true;
    }
    // A realized scene whose list was replaced in place (an editing host's scene): only the entities
    // whose document changed are realized again, and the ones gone released (all releases first: an
    // entity may move to another scene's list).
    const edited: { sceneId: string; rec: { ids: Set<string>; list: readonly unknown[] }; entities: readonly (typeof opts.snapshot.scene.entities)[number][] }[] = [];
    for (const b of set.batches) {
      const rec = realizedScenes.get(b.sceneId);
      if (rec === undefined || rec.list === b.entities) continue;
      const entities = b.entities as unknown as (typeof opts.snapshot.scene.entities)[number][];
      const next = new Map(entities.map((e) => [e.id, e]));
      const gone = new Set<string>();
      for (const id of rec.ids) if (next.get(id) !== entityDocs.get(id)) gone.add(id);
      if (gone.size > 0) {
        for (const id of gone) lightmaps?.release(id);
        realization?.removeEntities(gone);
        for (const id of gone) shownLooks.delete(id);
        // Children before parents (reverse document order).
        for (const e of [...(rec.list as readonly { id: string }[])].reverse()) if (gone.has(e.id)) releaseEntity(e.id);
        for (const id of gone) rec.ids.delete(id);
        removed = true;
      }
      rec.list = b.entities;
      edited.push({ sceneId: b.sceneId, rec, entities });
    }
    let added = false;
    for (const { sceneId, rec, entities } of edited) {
      const fresh = entities.filter((e) => !rec.ids.has(e.id));
      if (fresh.length === 0) continue;
      for (const e of fresh) {
        realizeEntity(e, sceneId);
        rec.ids.add(e.id);
      }
      realization?.addEntities(modelRefsOf(fresh));
      added = true;
    }
    for (const b of set.batches) {
      if (realizedScenes.has(b.sceneId)) continue;
      const entities = b.entities as unknown as (typeof opts.snapshot.scene.entities)[number][];
      for (const e of entities) realizeEntity(e, b.sceneId);
      realizedScenes.set(b.sceneId, { ids: new Set(entities.map((e) => e.id)), list: b.entities });
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
    if (added || removed) followProbeScenes();
    if (scenesRemoved && !added && isV3) precompileWanted ??= 'scene';
    syncSpawned((set as { spawned?: readonly unknown[] }).spawned ?? []);
  }

  /** Release every realized scene; the next sync realizes the scene set again (new bakes). */
  function releaseScenes(): void {
    for (const [sceneId, rec] of [...realizedScenes]) {
      for (const id of rec.ids) lightmaps?.release(id);
      realization?.removeEntities(rec.ids);
      for (const id of rec.ids) shownLooks.delete(id);
      // Children before parents (reverse document order).
      for (const e of [...(rec.list as readonly { id: string }[])].reverse()) if (rec.ids.has(e.id)) releaseEntity(e.id);
      realizedScenes.delete(sceneId);
    }
    realizedRevision = -1;
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
   * The light values scripts wrote (`ctx.entity(id).set('light',
   * …)`): colour and intensity become the light's authored values (presets
   * blend from them; a new run's empty list restores the document's), range
   * is a point or spot light's distance, the masks its light layers. Applied
   * when the list or the light set changed.
   */
  let lightOverridesKey = '';
  function applyLightOverrides(): void {
    const ov = (opts.runtime as { lightOverrides?: () => ReadonlyMap<string, LightValueOverride> }).lightOverrides?.();
    if (ov === undefined) return;
    const key = ov.size === 0 && lightOverridesKey === '' ? '' : `${lights.revision}|${JSON.stringify([...ov])}`;
    if (key === lightOverridesKey) return;
    lightOverridesKey = key;
    // A light a mask turned plain or layered was realized again: the lights that are on are picked again.
    if (lights.applyOverrides(ov, envLook.blendActive, (id) => (entityDocs.get(id)?.components as { light?: { range?: number } } | undefined)?.light?.range ?? 0)) selectLights();
    // A running blend blends from the written values.
    if (envLook.blendActive) envLook.appliedKey = '';
    if (ov.size === 0) lightOverridesKey = '';
  }

  /**
   * The view as the runtime's camera brain resolved it (the engine owns the
   * view): its pose and lens, interpolated by the runtime like every
   * transform. Presentation only.
   */
  const viewPos: number[] = [0, 0, 0];
  const viewRot: number[] = [0, 0, 0, 1];
  function applyResolvedCamera(): void {
    if (camera === null) return;
    const lens = (opts.runtime as { readCameraView?: (p: number[], r: number[]) => { fovY: number; near: number; far: number } | null }).readCameraView?.(viewPos, viewRot) ?? null;
    if (lens === null) return;
    camera.position.set(viewPos[0]!, viewPos[1]!, viewPos[2]!);
    camera.quaternion.set(viewRot[0]!, viewRot[1]!, viewRot[2]!, viewRot[3]!);
    camera.fov = lens.fovY;
    camera.near = lens.near;
    camera.far = lens.far;
  }

  /** When the first render call began (for `onFrameDrawn`). */
  let firstRenderCallAt: number | null = null;

  // --- Pipelines precompiled ahead of a present -----------------
  /** Wanted before the next present: the first one, and after a scene attached (or a new renderer). */
  let precompileWanted: 'start' | 'scene' | null = 'start';
  /** The precompile running (frames are skipped until it settles, stops moving for PRECOMPILE_STALL_MS, or PRECOMPILE_WAIT_MS passed). */
  let precompileRun: { readonly startedAt: number; readonly reason: 'start' | 'scene'; readonly job: Precompile } | null = null;
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
    if (now - precompileRun.startedAt < PRECOMPILE_WAIT_MS && now - precompileRun.job.lastProgressAt() < PRECOMPILE_STALL_MS) return true;
    // Too long, or stopped moving (a device that never answers, a pipeline that failed): draw; the frame builds what is left.
    precompileRun.job.release();
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
    let job: Precompile;
    try {
      const r = renderer as unknown as import('three/webgpu').WebGPURenderer;
      job = environmentRenderer !== null ? environmentRenderer.compileAsync(camera) : compileIntoTarget(r, scene, camera, r.getRenderTarget(), r.getMRT());
    } catch {
      precompileStats.failed += 1;
      return false;
    }
    const run = { startedAt: now, reason, job };
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
    job.done.then(() => settle(false), () => settle(true));
    return true;
  }

  /**
   * The scene set, the transforms and the world matrices as the runtime has
   * them now, and what it hides (a frame does this first; an editing host
   * between frames, before it reads matrices).
   */
  function syncWorld(): AdapterError | null {
    // The runtime is the single frame driver: this runs after the step
    // update (runtime.md frame ordering: step → onFrame → render).
    // A runtime that hands out its interpolated transforms in
    // reused arrays is read without a per-frame copy of every transform.
    if (opts.runtime.forEachInterpolated !== undefined) {
      syncSceneSet();
      // Only the entities that moved (a runtime that tracks them); every one when entities came or went,
      // as a newly realized entity starts from its authored transform. Unchanged values change nothing.
      const moved = opts.runtime.forEachMoved?.(applyInterpolated);
      const all = moved === undefined || graph.revision !== syncedRevision;
      syncedRevision = graph.revision;
      if (moved === false || (all && !opts.runtime.forEachInterpolated(applyInterpolated))) {
        return adapterError('render_failed', 'runtime state unavailable: runtime is disposed');
      }
    } else {
      const st = opts.runtime.getInterpolatedState();
      if (!st.ok) {
        return adapterError('render_failed', `runtime state unavailable: ${st.error.message}`);
      }
      syncSceneSet();
      // Transform synchronization: the interpolated values into the world table.
      for (const tr of st.state.transforms) graph.world.setLocal(tr.id, tr.position, tr.rotation, tr.scale);
    }
    // The world matrices, and every static drawable placed by its entity's.
    graph.update();
    // The objects the simulation hides disappear (and come back on a restart).
    const hiddenNow = (opts.runtime as { hiddenEntities?: () => ReadonlySet<string> }).hiddenEntities?.();
    // Hidden with its children: derived again when the set or the entities change.
    const hiddenOwn = hiddenNow ?? NO_HIDDEN;
    if (hiddenOwn !== hiddenSeen.set || hiddenOwn.size !== hiddenSeen.size || graph.revision !== hiddenSeen.revision) {
      hiddenSeen = { set: hiddenOwn, size: hiddenOwn.size, revision: graph.revision };
      const before = hiddenIds;
      hiddenIds = graph.setHidden(hiddenOwn);
      // A hidden block layer's chunks leave the scene (they hang on no entity node).
      for (const id of docLayers) blockView.setHidden(id, hiddenIds.has(id));
      for (const id of terrains.ids()) terrains.setHidden(id, hiddenIds.has(id));
      for (const id of splines.ids()) splines.setHidden(id, hiddenIds.has(id));
      let lightsTouched = false;
      for (const id of before) if (!hiddenIds.has(id) && lights.has(id)) lightsTouched = true;
      for (const id of hiddenIds) if (!before.has(id) && lights.has(id)) lightsTouched = true;
      // A light object hidden or switched off (or back) changes which lights are on.
      if (lightsTouched) {
        selectLights();
        precompileWanted ??= 'scene';
      }
    }
    return null;
  }

  function renderFrame(): { ok: true } | { ok: false; error: AdapterError } {
    return drawFrame(false);
  }

  /** One frame; `force`: drawn even while a precompile runs (a capture needs this frame's picture). */
  function drawFrame(force: boolean): { ok: true } | { ok: false; error: AdapterError } {
    if (disposed) return { ok: false, error: adapterError('adapter_disposed', 'adapter is disposed') };
    const frameStart = performance.now();
    const renderStart = opts.onFrameDrawn !== undefined ? frameStart : 0;
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
    const worldError = syncWorld();
    if (worldError !== null) return { ok: false, error: worldError };
    applyResolvedCamera();
    syncEntityLooks();
    // The effect requests of the steps since the last frame (presentation only), then the effects step.
    if (effects !== null) {
      for (const req of (opts.runtime as { takeEffectRequests?: () => EffectRequestLike[] }).takeEffectRequests?.() ?? []) effects.request(req, (id) => graph.nodeFor(id));
      for (const id of effectEntities) effects.setAttachedActive(id, !hiddenIds.has(id));
      const perf = globalThis.performance;
      const now = perf !== undefined ? perf.now() : 0;
      const paused = (opts.runtime as { isPaused?: boolean }).isPaused === true;
      const frameSeconds = effectsLastNow === null || paused ? 0 : Math.max(0, (now - effectsLastNow) / 1000);
      effectsLastNow = now;
      if (camera !== null) effects.update(frameSeconds, camera, (now - clockStart) / 1000);
      // The canvas reports the executor and what plays (an export has no other in-page diagnostics surface).
      const d = effects.diagnostics();
      const mark = `${d.executor ?? 'none'}|${d.playing}|${d.particles}|${d.lights}`;
      if (mark !== effectsMark && typeof canvasLike?.setAttribute === 'function') {
        effectsMark = mark;
        canvasLike.setAttribute('data-tl-effects', d.executor ?? 'none');
        canvasLike.setAttribute('data-tl-effects-playing', String(d.playing));
        canvasLike.setAttribute('data-tl-effects-particles', String(d.particles));
        canvasLike.setAttribute('data-tl-effects-lights', String(d.lights));
      }
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
    // The animated hierarchies posed as the mixers left them (their bones and drawables follow).
    graph.poseAnimated();
    const renderer = live;
    if (followShadow) lights.followCamera(camera!);
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
    // What the camera sees decides which texture mips stream in or out (presentation only).
    opts.textureStreamer?.update(scene, camera!, h * renderer.getPixelRatio(), false, graph.parkedObjects());
    // The viewport the view is drawn in (screen↔world projection in scripts uses its aspect).
    if (w !== reportedViewport[0] || h !== reportedViewport[1]) {
      reportedViewport[0] = w;
      reportedViewport[1] = h;
      (opts.runtime as { setCameraViewport?: (w: number, h: number) => boolean }).setCameraViewport?.(w, h);
    }
    // The block chunks the simulation changed, re-meshed before the draw.
    const gridChanges = (opts.runtime as { takeGridChanges?: () => GridRenderChange[] }).takeGridChanges?.() ?? [];
    if (gridChanges.length > 0) blockView.applyRuntimeChanges(gridChanges);
    if (stream !== null) stream.beginFrame(viewCull.view.eye);
    blockView.update(viewCull.view.eye);
    // Splines released and not realized again go now (one realized again kept drawing until its new data is in).
    splines.update();
    // (The near shadows follow the last frame's eye: the view is culled for this one further down.)
    scatter.stored.update(viewCull.view);
    if (cutaways.wanted()) cutaways.follow();
    // The light values scripts wrote, then the environment preset blend
    // (the running game's, or the editor's preview) before the draw.
    applyLightOverrides();
    applyEnvironmentBlend();
    // Material swaps whose materials have loaded go on before the draw (and before regrouping).
    if (materialSwaps !== null) {
      const rt = opts.runtime as { materialSwaps?: () => ReadonlyMap<string, MaterialMappingLike>; blockMaterialSwaps?: () => ReadonlyMap<string, MaterialMappingLike> };
      materialSwaps.update(rt.materialSwaps?.(), rt.blockMaterialSwaps?.());
    }
    // Material parameters scripts changed, on the objects before the draw (and before regrouping).
    const materialChanges = (opts.runtime as { takeMaterialChanges?: () => MaterialRenderChangeLike[] }).takeMaterialChanges?.() ?? [];
    if (materialChanges.length > 0) {
      runtimeMaterials?.apply(materialChanges);
      for (const c of materialChanges) regroupEntity(c.entityId);
    }
    // The level of detail each LOD draws attached (the batcher and the draw see only that one).
    graph.lodTuning.beginFrame();
    graph.updateLods(camera!);
    // Regroup the repeated objects and copy their matrices (after every transform and look change).
    if (batcher !== null) batcher.update(camera!);
    else {
      scene.updateMatrixWorld();
      if (camera!.parent === null && camera!.matrixWorldAutoUpdate) camera!.updateMatrixWorld();
    }
    // Then what each batch, chunk and merged cell has in view leads its draw.
    viewCull.update(camera!);
    // The terrains' nodes for this view (only when it or their tiles changed), and tiles that arrived uploaded.
    terrains.update(viewCull.view, renderer as never);
    // Ground cover around the view's eye, and the eye every pass reads distance from (foliage's wind distance).
    scatter.cover.update(viewCull.view);
    materialLibrary?.setViewEye(viewCull.view.eye[0]!, viewCull.view.eye[1]!, viewCull.view.eye[2]!);
    // Merged cells still building in the background, or a moved static object waiting to rejoin its cell: a host drawing on demand draws again.
    if (batcher?.pending() === true) opts.onChange?.();
    // Shadows on before the draw (and before the precompile below, so the programs are built with
    // them); the first frame with the key light's shadow is its probe: if it throws, shadows go off
    // (soft degradation: the `shadows`/`shadowReason` pair is the diagnostic) and it is drawn again without.
    const probing = lights.beforeFrame(renderer);
    probes.beforeFrame(renderer as unknown as Parameters<typeof probes.beforeFrame>[0], camera!);
    try {
      // A quality level also applies without a project environment (a level without MSAA
      // draws through a plain pass), so the environment renderer draws then too.
      // With the scenes' looks given, only once there is something to draw (a look, presets, a blend):
      // a game whose scenes set no look renders as one without an environment.
      const wanted = opts.environment !== undefined && (sceneLooks === null || effectiveEnvironment() !== null || envLook.presets.size > 0 || envLook.blendActive);
      if ((wanted || qualityControl.needsEnvironment() || renderControl.needsEnvironment()) && environmentRenderer === null) {
        // The sky, its faces and the grading LUT are held for the environment's life. They are the same
        // decoded textures materials draw with (the environment builds its cube, equirect copy and LUT
        // from their images and never changes them), so a texture used by both is decoded once.
        const envTextures = textureHolds(resources, opts.environment?.loadTexture ?? (async () => null));
        // A sky image that arrives later is drawn by the next frame (a host drawing on demand is told).
        environmentRenderer = createEnvironmentRenderer(renderer, scene, { loadTexture: (id) => envTextures.get(id, 'environment'), ...(opts.onChange !== undefined ? { onChange: opts.onChange } : {}) });
        environmentHolds = envTextures;
        environmentRenderer.set(effectiveEnvironment());
        qualityControl.applyEnvironment(environmentRenderer);
        // A blend already running goes onto the new environment renderer.
        envLook.appliedKey = '';
        envLook.blendActive = false;
        applyEnvironmentBlend();
      }
      if (environmentRenderer !== null) {
        renderControl.apply(environmentRenderer);
        const keyDir = lights.keyDirection();
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
      if (probing) lights.probeAgain();
      lastFrameSkipped = true;
      return { ok: true };
    }
    const frameInfo = (renderer as { info?: { render?: { drawCalls: number; triangles: number } } }).info?.render ?? { drawCalls: 0, triangles: 0 };
    const drawsBefore = frameInfo.drawCalls;
    const trianglesBefore = frameInfo.triangles;
    // A capture during a precompile draws with the renderer's own target and outputs (the compile holds the pass's).
    const job = precompileRun?.job ?? null;
    const draw = (): void => {
      const render = (): void => {
        if (environmentRenderer !== null) environmentRenderer.render(camera!);
        else renderer.render(scene, camera!);
      };
      if (job !== null) job.aside(render);
      else render();
    };
    try {
      try {
        draw();
      } catch (e) {
        if (!probing) throw e;
        lights.disableShadows(renderer);
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
    probes.frameDrawn();
    gpuTiming.afterFrame(renderer);
    const drawnAt = performance.now();
    renderControl.frameDrawn(environmentRenderer, drawnAt, drawnAt - frameStart, gpuTiming);
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
    const lit = lights.diagnostics();
    const d: SceneAdapterDiagnostics = {
      renderBackend,
      rendererInfo,
      canvasSize: canvasSize(),
      pixelRatio,
      shadows: lit.shadows,
    };
    if (precompileRun !== null || precompileStats.runs + precompileStats.failed + precompileStats.gaveUp > 0) d.precompile = { ...precompileStats, running: precompileRun !== null };
    const choice = owned.renderer !== null && !disposed ? owned.renderer.info() : lastRendererInfo;
    if (choice !== null) d.renderer = choice;
    // `shadowReason` is present iff `shadows === 'off'`; the lights that are on.
    if (lit.shadowReason !== undefined) d.shadowReason = lit.shadowReason;
    if (lit.shadowMaps !== undefined && !disposed) d.shadowMaps = lit.shadowMaps;
    if (lit.lights !== undefined && !disposed) d.lights = lit.lights;
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
    if (!disposed && lastFrameDrawn) d.viewCull = viewCull.diagnostics();
    if (!disposed && lastFrameDrawn) {
      const t = graph.lodTuning;
      d.lod = { bias: t.bias, hysteresis: t.hysteresis, switches: t.switches, copySwitches: t.copySwitches, instances: realization?.instanceStats() ?? { copies: 0, inView: 0, byLevel: [], culled: 0, thinned: 0 } };
    }
    if (!disposed && blockView.layerIds().length > 0) d.blocks = blockView.diagnostics();
    if (!disposed && terrains.ids().length > 0) d.terrain = terrains.diagnostics();
    if (!disposed && stream !== null) d.streaming = stream.diagnostics();
    if (!disposed && splines.ids().length > 0) d.splines = splines.diagnostics();
    if (!disposed) scatter.diagnostics(d);
    if (!disposed && materialLibrary !== null && runtimeMaterials !== null) d.materials = { graphMaterials: materialLibrary.graphMaterialCount(), ...(materialSwaps !== null && (materialSwaps.applied > 0 || materialSwaps.pending() > 0) ? { swapsApplied: materialSwaps.applied, swapsPending: materialSwaps.pending() } : {}), ...runtimeMaterials.diagnostics() };
    const envDiagnostics = environmentRenderer !== null && !disposed ? environmentRenderer.diagnostics() : null;
    if (envDiagnostics !== null) d.environment = envDiagnostics;
    if (!disposed && lastFrameDrawn) d.render = { ...renderControl.diagnostics(), internal: envDiagnostics?.render.internal ?? null };
    if (!disposed) d.quality = { ...qualityControl.diagnostics(), ...(lit.shadowMapSize !== undefined ? { keyShadowMapSize: lit.shadowMapSize } : {}) };
    const probeState = disposed ? null : probes.observe();
    if (probeState !== null) d.probes = probeState;
    if (opts.textureStreamer !== undefined && !disposed) d.textures = opts.textureStreamer.observe();
    if (liveRenderer !== null && lastFrameDrawn) d.frame = { drawCalls: lastFrameCounts.drawCalls, triangles: lastFrameCounts.triangles };
    if (!disposed) d.sceneGraph = graph.counts();
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
    probes.dispose();
    runtimeMaterials?.dispose();
    materialSwaps?.dispose();
    sceneHolds.clear();
    if (ownLibrary) materialLibrary?.dispose();
    environmentRenderer?.dispose();
    environmentHolds?.releaseHolder('environment');
    lights.dispose();
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
    stopReassigned?.();
    stopCellUv?.();
    batcher?.dispose();
    viewCull.dispose();
    blockView.dispose();
    terrains.dispose();
    splines.dispose();
    scatter.dispose();
    ownTiles?.dispose();
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
    graph.dispose();
    scene.clear();
    camera = null;
    return { ok: true };
  }

  const projectScratch = new THREE.Vector3();
  const projectWorld: number[] = [0, 0, 0];
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
    renderedNodes: (entityId, names) => (disposed ? null : (animatorPlayers.get(entityId)?.player.nodePoses(names) ?? null)),
    setLodTuning(tuning: { readonly bias?: number; readonly hysteresis?: number }): void {
      qualityControl.setProjectLod(tuning);
    },
    setRenderSettings(settings, layer) {
      renderControl.set(settings, layer);
      opts.onChange?.();
    },
    setQuality: (level: QualityLevel): boolean => qualityControl.choose(level),
    qualityLevel: (): QualityLevel => qualityControl.level().id,
    takeGpuTime: () => gpuTiming.take(),
    projectToScreen(target, out): boolean {
      if (disposed || camera === null) return false;
      const p = projectScratch;
      if (typeof target.entityId === 'string') {
        if (!graph.world.position(target.entityId, projectWorld)) return false;
        p.set(projectWorld[0]!, projectWorld[1]!, projectWorld[2]!);
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
    previewEnvironmentBlend(view: EnvironmentBlendView | null, tagBits?: ReadonlyMap<string, number>): void {
      envLook.preview = view;
      // The editor previews with the project's tags as they are now (presets name lights by tag).
      if (tagBits !== undefined) {
        envTagBits.clear();
        for (const [name, bit] of tagBits) envTagBits.set(name.toLowerCase(), bit);
        envLook.appliedKey = ENV_STALE;
      }
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
    holdAssets(models, textures) {
      if (disposed) return { ready: Promise.resolve(), release: () => undefined };
      const held = models.length > 0 ? (realization?.hold?.(new Set(models), []) ?? null) : null;
      const decoded = textures.length > 0 && materialLibrary?.preloadTextures !== undefined ? materialLibrary.preloadTextures(textures) : null;
      let released = false;
      return {
        ready: Promise.all([held?.ready ?? Promise.resolve(), decoded?.ready.catch(() => undefined)]).then(() => undefined),
        release: (): void => {
          if (released) return;
          released = true;
          held?.release();
          decoded?.release();
        },
      };
    },
    presentedSceneRevision(): number {
      return presentedRevision;
    },
    setEnvironment(value: EnvironmentLike | null): void {
      if (disposed) return;
      const texturesBefore = JSON.stringify(environmentTextureIds(envLook.value));
      envLook.setValue(value);
      qualityControl.setProject(value);
      if (JSON.stringify(environmentTextureIds(value)) !== texturesBefore && environmentRenderer !== null) {
        // Other textures: a new environment renderer holds them, and the ones only the old one named are let go.
        environmentRenderer.dispose();
        environmentRenderer = null;
        environmentSize = null;
        environmentHolds?.releaseHolder('environment');
        environmentHolds = null;
      } else environmentRenderer?.set(effectiveEnvironment());
    },
    setBakes(bakes): void {
      if (disposed) return;
      // Every scene is realized again with the new bakes (the lights they hold leave realtime, the objects take
      // their lightmaps), and every block chunk is re-meshed to take its own.
      releaseScenes();
      lightmaps?.dispose();
      lightmaps = lightmapSetOf(bakes);
      lightmapsLive = lightmaps;
      probes.setBakes(bakes);
      for (const id of blockView.layerIds()) blockView.setLightmapUv(id, lightmaps?.hasChunks(id) === true);
      blockView.remeshAll();
    },
    materialsChanged(): void {
      lightmaps?.refresh();
    },
    sync(): void {
      if (!disposed) syncWorld();
    },
    worldMatrix(entityId, out): boolean {
      const i = graph.world.indexOf(entityId);
      if (i === undefined || disposed) return false;
      out.fromArray(graph.world.world, i * 16);
      return true;
    },
    entityObject: (entityId, create) => (disposed ? null : ((create === true ? graph.nodeFor(entityId) : graph.node(entityId)) ?? null)),
    entityOf(object): string | null {
      for (let o: THREE.Object3D | null = object; o !== null; o = o.parent) if (o instanceof EntityNode) return o.entityId;
      else if (typeof o.userData[TERRAIN_ENTITY_KEY] === 'string') return o.userData[TERRAIN_ENTITY_KEY] as string;
      return null;
    },
    threeScene: () => scene,
    probeLighting: () => probes.light(),
    pickables: () => graph.pickables(),
    attachOverlay(entityId, object): void {
      let hung = overlays.get(entityId);
      if (hung === undefined) overlays.set(entityId, (hung = new Set()));
      hung.add(object);
      if (object.parent !== null) object.removeFromParent();
      graph.nodeFor(entityId)?.add(object);
    },
    detachOverlay(entityId, object): void {
      const hung = overlays.get(entityId);
      if (hung === undefined || !hung.delete(object)) return;
      if (hung.size === 0) overlays.delete(entityId);
      object.removeFromParent();
    },
    instanceSet: (entityId) => realization?.instanceSet(entityId) ?? null,
    instanceBuffer: (digest) => realization?.instanceBuffer(digest),
    modelFailures: () => realization?.failures() ?? new Map(),
    blockLayers: () => blockView,
    terrainDiagnostics: () => (terrains.ids().length > 0 ? terrains.diagnostics() : null),
    terrains: () => terrains,
    scatter: () => scatter.stored,
    cover: () => scatter.cover,
    currentRenderer: () => (disposed ? null : (owned.renderer?.current() ?? null)),
    frameSkipped: () => lastFrameSkipped || precompileRun !== null,
    lastFrame: () => ({ drawCalls: lastFrameCounts.drawCalls, triangles: lastFrameCounts.triangles, samples: msaaMark, batching: batcher !== null && lastFrameDrawn ? batcher.diagnostics() : null }),
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