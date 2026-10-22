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
import type { DecalRequestLike, ProjectedDecalLike } from './decal-projectors';
import { setDecalDepthMode } from './mesh-decals';
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
import { PrecompileGate } from './precompile-gate';
import { INSTANCE_MATRIX_ATTRIBUTE } from './attribute-instancing';
import { createEnvironmentRenderer, environmentTextureIds, renderPixelRatio, type EnvironmentLike, type EnvironmentRenderer, type FogVolumeLike, type QualityLevel } from './environment';
import { ENV_STALE, EnvironmentLook } from './environment-look';
import { createQualityControl } from './quality-control';
import { createGpuTiming } from './gpu-timing';
import { createRenderControl } from './render-control';
import * as THREE from 'three';
import { type BlockLayerViewDiagnostics } from './block-layers';
import { OCCLUSION_ORACLE_KEY, runOcclusionOracle, type OracleOptions } from './occlusion-oracle';
import { OcclusionCuller } from './occlusion';
import { TERRAIN_ENTITY_KEY, TerrainView } from './terrain-view';
import { createScenePreparations } from './scene-preparation';
import { TerrainTileStore } from './terrain-tile-store';
import type { MaterialRenderChangeLike } from './runtime-materials';
import type { MaterialMappingLike } from './material-swaps';
import { AdapterMaterials } from './adapter-materials';
import { materialParamsOf, modelRefsOf, pathPaintOf } from './entity-refs';
import { vertexPaintDiagnostics } from './vertex-paint-draw';
import { paintOnlyChange } from './vertex-paint-update';
import { PaintChannelView } from './vertex-paint-channel-view';
import { PATH_PAINT_ENTITY_KEY } from './vertex-paint-paths-view';
import { type ArchitectureComponent, type BlockLayerComponent, type BlockLayerData, type BlockType, type GridRenderChange, type SplineComponent, type TerrainComponent } from '@thirdlight/runtime';
import type { Runtime, RuntimeSnapshot } from '@thirdlight/runtime';
import type { EnvironmentBlendView } from '@thirdlight/runtime';
import { adapterError, type AdapterError } from './errors';
import { AdapterRenderer, type CanvasLike } from './adapter-renderer';
import { createFrameCapture, type ScreenshotResult } from './capture';
export type { ScreenshotResult } from './capture';
import { EntityNode, RenderGraph } from './render-graph';
import { IsolationView } from './isolation-view';
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
import {
  ANIMATION_MAX_DELTA_SECONDS,
  type AnimationRoleView,
} from './animation';
import type { AuthoredSurface } from './lighting';
import { applyEntityRenderFlags } from './entity-render-flags';
import { createAdapterLevel } from './adapter-level';
import { AdapterEntities } from './adapter-entities';
import { AdapterModels } from './adapter-models';
import { AdapterScenes } from './adapter-scenes';
import { createSceneLights, type LightValueOverride, type SceneLights } from './lights-shadows';
import { STATIC_CASTER_KEY, StaticShadowRevision } from './shadow-casters';
import type { EffectComponentLike, EffectRequestLike } from './effects-player';
import { AdapterEffects } from './adapter-effects';
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
import { type FrameDrawnInfo, type SceneAdapter, type SceneAdapterDiagnostics, type SceneAdapterOptions } from './adapter-types';

const RENDERER_INFO_LIMIT = 128;


/** An environment preset (project-model's, as the runtime's blend maths takes it). */

const NO_HIDDEN: ReadonlySet<string> = new Set();
/** An applied-blend key no blend has: the next frame applies the blend (or its end) again. */


export function createSceneAdapter(canvas: unknown, opts: SceneAdapterOptions): SceneAdapter {
  const scene = new THREE.Scene();
  /**
   * What this adapter loads from assets is held in the page's resource
   * manager (the page settles it after each frame); without one, the
   * adapter's own, settled after each change.
   */
  const resources: ResourceManager = opts.resources ?? createResourceManager({ schedule: (run) => queueMicrotask(run) });
  if (opts.background !== undefined) scene.background = new THREE.Color(opts.background);
  // Project materials (shared by boxes, models and instance sets), node materials, decals.
  /** The lightmap set once it exists (the library may report a change while it is still being set up). */
  let lightmapsLive: LightmapSet | null = null;
  const materials = new AdapterMaterials(scene, resources, opts, () => lightmapsLive);
  const materialLibrary = materials.library;
  const { decalPages, projectors } = materials;
  const effectiveMaterials = materials.effective;
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
  const tmpSize = new THREE.Vector2();
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
  // The perf harness measures how much of the view's drawn work no pixel shows (occlusion-oracle.ts).
  scene.userData[OCCLUSION_ORACLE_KEY] = (renderer: Parameters<typeof runOcclusionOracle>[0], camera: THREE.Camera, options?: OracleOptions) => runOcclusionOracle(renderer, scene, camera, options);
  /** One object's own meshes (its child objects have nodes of their own). */
  const ownMeshes = (entityId: string): THREE.Object3D[] => {
    const out: THREE.Object3D[] = [];
    graph.node(entityId)?.traverse((o) => void ((o as THREE.Mesh).isMesh === true && out.push(o)));
    return out;
  };
  materials.trackRuntime(ownMeshes);
  // --- Visual effects --------------------------------------------
  const effects = new AdapterEffects(scene, resources, opts, materialLibrary);
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
      precompile.want();
      opts.onChange?.();
    },
    tagBits: envTagBits,
    localShadows: { roomSeen: (k) => archHost.rooms.roomSeen(k), movers: () => archHost.rooms.movers() },
  });

  // --- scene graph construction (fixed component table; read-only over the
  // --- (deep-frozen, normalized) snapshot) ---------------------------------
  /** The unit box every box is drawn through when batched. */
  const unitBox = unitBoxGeometry(addBoxLightmapUv);
  /** Repeated objects drawn instanced (absent when the option turns it off). */
  /** What batches, instance-set chunks and merged cells draw is culled inside against the frame's camera. */
  const viewCull = new ViewCuller();
  const batcher: AutoBatcher | null = opts.batching === false ? null : createAutoBatcher(scene, { merging: opts.merging ?? 'load', viewCull, park: (o, on) => graph.park(o, on), ...(staticShadows !== null ? { staticChanged: (where) => (where === null ? staticShadows.bump() : staticShadows.touched(where)) } : {}) });
  // A scene dump (the perf harness's plain page) reads the parked drawables with the scene.
  scene.userData['tlParked'] = graph.parkedObjects();
  // The world matrices are brought up to date right before every render (the batcher's update, else here, so the
  // view culls with them): the renderer's own pass is left out.
  scene.matrixWorldAutoUpdate = false;
  /** An entity's look, material or flags changed outside its realization: its meshes are grouped again. */
  const regroupEntity = (id: string): void => {
    const node = batcher === null ? undefined : graph.node(id);
    if (node !== undefined) batcher!.touch(node);
  };
  // An editor's edit mode drawing only the objects it edits.
  const isolation = new IsolationView({ scene, entityOf: (o) => api.entityOf?.(o) ?? null, node: (id) => graph.node(id), regroup: (o) => batcher?.touch(o), shadowsChanged: () => staticShadows?.bump() });
  // Redefined project materials: block chunks' UVs follow, then the meshes wearing them are grouped again.
  materials.listenReassigned(batcher === null ? null : (root) => batcher.touch(root));
  /** The documents of every realized entity (the loaded scenes). */
  const entityDocs = new Map<string, (typeof opts.snapshot.scene.entities)[number]>();
  // Streaming, scatter, splines, architecture and its rooms, clipped decals, block layers, terrains, see-through.
  const level = createAdapterLevel({
    opts, scene, resources, canvas, graph, materialLibrary, effectiveMaterials, components: (id) => entityDocs.get(id)?.components,
    realization: () => models.realization, lightmaps: () => lightmaps, staticShadows, batcher, viewCull, renderer: () => canvasRenderer.current(), lights,
    precompile: () => precompile, startModelsIn: () => models.startIn,
  });
  const { stream, scatter, splines, archHost, architecture, clipped, blockView, terrains, ownTiles, cutaways, seeThrough } = level;
  const authoredBlockTypes = level.blockTypes;
  // What each loaded entity's components make, realized from its document (adapter-entities.ts).
  const entities = new AdapterEntities(entityDocs, {
    graph, lights, blockView, terrains, splines, architecture, clipped, effects, materials,
    lightmaps: () => lightmaps, realization: () => models.realization, unitBox, vertexPaint: opts.vertexPaint !== false, terrain: opts.terrain !== false,
  });
  {
    // The start scenes' entities, each with its scene (the snapshot's own scene when the runtime has no scene set).
    const sceneOf = new Map<string, string>();
    for (const b of opts.runtime.sceneSet?.()?.batches ?? []) for (const e of b.entities) sceneOf.set((e as { id: string }).id, b.sceneId);
    const own = (opts.snapshot.scene as { sceneId?: string }).sceneId ?? null;
    for (const e of opts.snapshot.scene.entities) entities.realize(e, sceneOf.get(e.id) ?? own);
  }
  // The view's camera, posed every frame from the camera brain (`applyResolvedCamera`). Aspect is a viewport
  // property, updated per frame from the canvas size.
  camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(startView[0], startView[1], startView[2]);
  // The model realization (models.ts), when `models` is given; the base scene keeps rendering without it.
  const models = new AdapterModels(opts, {
    graph, materialLibrary, resources,
    entityMaterials: (entityId) => effectiveMaterials(entityId, (entityDocs.get(entityId)?.components as { materials?: Record<string, string> } | undefined)?.materials) ?? null,
    entityMaterialParams: (entityId) => materialParamsOf(entityDocs.get(entityId)?.components),
    // A copy dragged in place: the shadowed lamps near it draw their maps again.
    copiesMoved: (spheres) => archHost.rooms.noteMoved(spheres),
    // Painted again in place (stored paint, a brush's preview): batches and merged cells take the new paint.
    repainted: (entityId) => {
      regroupEntity(entityId);
      opts.onChange?.();
    },
    attached: (entityId, root) => {
      // Models and instance sets cast and receive the key light's shadow (their data), in their light layers.
      applyEntityRenderFlags(root, entityDocs.get(entityId)?.components);
      // Values a script set before the model arrived.
      materials.runtime?.reapply(entityId);
      // A model's meshes may be drawn together with other placements' (instance sets already are), or merged when static.
      markBatchable(root);
      const scope = entities.staticScopes.get(entityId);
      if (scope !== undefined) {
        markStatic(root, scope);
        // Marked after its meshes came into the scene: the static shadow map takes them now.
        staticShadows?.bump();
      }
      lightmaps?.apply(entityId, root);
      opts.onChange?.();
    },
  });

  materials.createSwaps({
    components: (id) => entityDocs.get(id)?.components,
    disposed: () => disposed,
    assetMaterials: (assetId) => (assetId === undefined ? undefined : opts.models?.assets.find((a) => a.assetId === assetId)?.materials),
    blockTypes: () => authoredBlockTypes,
    restyleView: (entityId, c) => {
      // A spline's, an architecture's or a terrain's object: its view's meshes wear it (no entity node of their own).
      if ((c as { spline?: unknown }).spline !== undefined) splines.restyle(entityId);
      else if ((c as { architecture?: unknown }).architecture !== undefined) architecture.restyle(entityId);
      else if ((c as { terrain?: unknown }).terrain !== undefined) terrains.restyle(entityId, effectiveMaterials(entityId, (c as { materials?: Record<string, string> }).materials) ?? null, materialParamsOf(c));
      else return false;
      return true;
    },
    node: (id) => graph.node(id),
    lightmaps: () => lightmaps,
    reapplyModel: (id) => models.realization?.reapplyMaterials(id) ?? null,
    regroup: regroupEntity,
    setBlockTypes: (types) => blockView.setTypes(types),
  }, opts.materials?.textureRefs);

  // --- renderer state (lazy: created on the first successful render) ---
  // Made on the first frame (WebGPURenderer initialises asynchronously; set up once ready), with the canvas'
  // WebGL context lifecycle (adapter-renderer.ts).
  const canvasRenderer = new AdapterRenderer(canvas as CanvasLike | null, opts, {
    pixelRatioCap: () => qualityControl.pixelRatioCap(),
    dropRendererState: () => {
      environmentRenderer?.dispose();
      environmentRenderer = null;
      environmentSize = null;
    },
    adopted: (r, api) => {
      // The effect executors follow the renderer (compute on WebGPU, the CPU on WebGL 2).
      effects.player?.setRenderer(r, api);
      lights.rendererReplaced();
      // A new renderer (a lost device) builds its programs ahead of its first present too.
      precompile.restart();
    },
  });
  const canvasLike = canvasRenderer.canvas;
  /** The last frame was skipped (WebGPURenderer still initialising). */
  let lastFrameSkipped = false;
  /** A frame was drawn (the renderer info holds its counts). */
  let lastFrameDrawn = false;
  // Occlusion culling (occlusion.ts): the project's or quality level's setting, the renderer's path, the page's pin.
  const occlusion = new OcclusionCuller({ scene, setting: () => renderControl.occlusionCulling(), renderer: () => canvasRenderer.backend, pinned: opts.occlusion ?? null, showPyramid: opts.occlusionPyramid ?? null, view: viewCull.view, gpu: () => (canvasRenderer.backend === 'webgpu' ? canvasRenderer.current() : null), webgl: () => (canvasRenderer.backend === 'webgl2' ? canvasRenderer.current() : null), computeMs: () => gpuTiming.computeMs(), canvas: canvasLike, changed: () => opts.onChange?.(), keep: { scene, entityOf: (o) => api.entityOf?.(o) ?? null, node: (id) => graph.node(id), drawOf: (m) => batcher?.drawOf(m) ?? null }, fades: (o, c) => seeThrough.bitsFor(o, c) !== 0 });
  let disposed = false;
  /** The paint tool's channel view (made the first time it is shown). */
  let channelView: PaintChannelView | null = null;

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
  /** Scenes prepared ahead of their load (released once realized). */
  const preparations = createScenePreparations({ disposed: () => disposed, realization: () => models.realization, materialLibrary, architecture });
  // The scene set followed: scenes realized as they load and released as they unload, spawned copies (adapter-scenes.ts).
  const scenes = new AdapterScenes({
    runtime: opts.runtime, entities, realization: () => models.realization, lightmaps: () => lightmaps, forgetLook: (id) => shownLooks.delete(id), preparations,
    requestPrecompile: () => precompile.want(), selectLights, followProbes: (ids) => probes.follow(ids), v3: isV3, vertexPaint: opts.vertexPaint !== false,
    ownScene: (opts.snapshot.scene as { sceneId?: string }).sceneId,
  });
  /**
   * Switch the loaded scenes' lights: the most recently loaded
   * scene's directional, ambient and hemisphere light (each kind on its own),
   * point and spot lights within the budget (scene-lights.ts). The key light
   * decides the shadow state.
   */
  function selectLights(): void {
    lights.select(scenes.rankOf, hiddenIds);
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
        canvasRenderer.setPixelRatioCap(cap);
        // The post stack follows the new drawing-buffer size.
        environmentSize = null;
      },
      environment: () => environmentRenderer,
      changed: () => opts.onChange?.(),
    },
    { project: envLook.value, ...(opts.lod !== undefined ? { lod: opts.lod } : {}), pinned: opts.qualityPinned ?? null },
  );
  scenes.followProbes();

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

  // --- Pipelines precompiled ahead of a present (precompile-gate.ts) -----------------
  const precompile = new PrecompileGate(() => disposed);

  /** The scene as the frame would draw it, compiled: the environment renderer's scene pass, or the canvas. */
  const compileFrame = (renderer: AnyRenderer): Precompile => {
    const r = renderer as unknown as import('three/webgpu').WebGPURenderer;
    return environmentRenderer !== null ? environmentRenderer.compileAsync(camera!) : compileIntoTarget(r, scene, camera!, r.getRenderTarget(), r.getMRT());
  };

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
      scenes.sync();
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
      scenes.sync();
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
      for (const id of entities.docLayers) blockView.setHidden(id, hiddenIds.has(id));
      for (const id of terrains.ids()) terrains.setHidden(id, hiddenIds.has(id));
      for (const id of splines.ids()) splines.setHidden(id, hiddenIds.has(id));
      for (const id of architecture.ids()) architecture.setHidden(id, hiddenIds.has(id));
      let lightsTouched = false;
      for (const id of before) if (!hiddenIds.has(id) && lights.has(id)) lightsTouched = true;
      for (const id of hiddenIds) if (!before.has(id) && lights.has(id)) lightsTouched = true;
      // A light object hidden or switched off (or back) changes which lights are on.
      if (lightsTouched) {
        selectLights();
        precompile.want();
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
    if (canvasRenderer.contextLost) {
      // The context is currently lost: render nothing (three.js re-initializes
      // its own GL state on `webglcontextrestored`, which clears this flag).
      return {
        ok: false,
        error: adapterError('render_context_lost', 'the WebGL context is lost; the frame was not rendered and the context will be restored by the browser'),
      };
    }
    const err = canvasRenderer.ensure(disposed);
    if (err) return { ok: false, error: err };
    lastFrameSkipped = false;
    const handle = canvasRenderer.handle!;
    const hInfo = handle.info();
    canvasRenderer.lastInfo = hInfo;
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
    canvasRenderer.adopt(handle, live);
    // While a precompile runs, a skipped frame does none of the frame's work (the transform
    // sync, the batches): the compile gets the main thread, and the frame after it starts from now.
    if (!force && precompile.running(performance.now())) {
      lastFrameSkipped = true;
      return { ok: true };
    }
    const worldError = syncWorld();
    if (worldError !== null) return { ok: false, error: worldError };
    applyResolvedCamera();
    syncEntityLooks();
    // The effect requests of the steps since the last frame (presentation only), then the effects step.
    if (effects.player !== null) {
      const rt = opts.runtime as { takeEffectRequests?: () => EffectRequestLike[]; isPaused?: boolean };
      effects.frame(rt.takeEffectRequests?.() ?? [], (id) => graph.nodeFor(id), hiddenIds, rt.isPaused === true, camera, (now) => (now - clockStart) / 1000, canvasLike);
    }
    if (materialLibrary !== null && materialLibrary.animated()) {
      materialLibrary.tick(((typeof performance !== 'undefined' ? performance.now() : 0) - clockStart) / 1000);
    }
    // The models' role controllers and animator poses, once per rendered frame (adapter-models.ts).
    models.animate(graph);
    // The animated hierarchies posed as the mixers left them (their bones and drawables follow).
    graph.poseAnimated();
    const renderer = live;
    if (followShadow) lights.followCamera(camera!);
    // The follow shadow and the size first — the shadow probe below is a
    // real frame (it compiles the scene's pipelines), drawn as the game will draw it.
    const [w, h] = canvasRenderer.canvasSize();
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
    // The decal pages that arrived go to the GPU now; the canvas says so (an export has no other in-page diagnostics surface).
    if (decalPages?.upload(renderer as unknown as { initTexture?(t: THREE.Texture): void }) === true && typeof canvasLike?.setAttribute === 'function') {
      const o = decalPages.observe();
      canvasLike.setAttribute('data-tl-decal-pages', `${o.pages}|${o.layers}|${o.bytes}|${o.onGpu}`);
    }
    // The projected decals' table and index follow their decals (moved, added, spawned by scripts, their images arrived).
    projectors?.beforeFrame(renderer as never, (opts.runtime as { takeDecalRequests?: () => DecalRequestLike[] }).takeDecalRequests?.() ?? [], (id) => graph.node(id) ?? null, (opts.runtime as { isPaused?: boolean }).isPaused === true);
    // The viewport the view is drawn in (screen↔world projection in scripts uses its aspect).
    if (w !== reportedViewport[0] || h !== reportedViewport[1]) {
      reportedViewport[0] = w;
      reportedViewport[1] = h;
      (opts.runtime as { setCameraViewport?: (w: number, h: number) => boolean }).setCameraViewport?.(w, h);
    }
    // The block chunks the simulation changed, re-meshed before the draw.
    const gridChanges = archHost.takeSwaps((opts.runtime as { takeGridChanges?: () => GridRenderChange[] }).takeGridChanges?.() ?? []);
    if (gridChanges.length > 0) {
      blockView.applyRuntimeChanges(gridChanges);
      terrains.applyRuntimeChanges(gridChanges);
    }
    if (stream !== null) stream.beginFrame(viewCull.view.eye);
    blockView.update(viewCull.view.eye);
    // Splines released and not realized again go now (one realized again kept drawing until its new data is in).
    splines.update();
    architecture.update(viewCull.view.eye);
    // Clipped decals follow their surfaces (chunks made, objects realized) and themselves.
    clipped?.beforeFrame();
    // (The near shadows follow the last frame's eye: the view is culled for this one further down.)
    scatter.stored.update(viewCull.view);
    if (cutaways.wanted()) cutaways.follow();
    // The light values scripts wrote, then the environment preset blend
    // (the running game's, or the editor's preview) before the draw.
    applyLightOverrides();
    applyEnvironmentBlend();
    // Material swaps whose materials have loaded go on before the draw (and before regrouping).
    if (materials.swaps !== null) {
      const rt = opts.runtime as { materialSwaps?: () => ReadonlyMap<string, MaterialMappingLike>; blockMaterialSwaps?: () => ReadonlyMap<string, MaterialMappingLike> };
      materials.swaps.update(rt.materialSwaps?.(), rt.blockMaterialSwaps?.());
    }
    // Material parameters scripts changed, on the objects before the draw (and before regrouping).
    const materialChanges = (opts.runtime as { takeMaterialChanges?: () => MaterialRenderChangeLike[] }).takeMaterialChanges?.() ?? [];
    if (materialChanges.length > 0) {
      materials.runtime?.apply(materialChanges);
      for (const c of materialChanges) regroupEntity(c.entityId);
    }
    // The level of detail each LOD draws attached (the batcher and the draw see only that one).
    graph.lodTuning.beginFrame();
    graph.updateLods(camera!);
    // Regroup the repeated objects and copy their matrices (after every transform and look change).
    isolation.beforeBatch();
    seeThrough.beforeBatch(camera!);
    if (batcher !== null) batcher.update(camera!);
    else {
      scene.updateMatrixWorld();
      if (camera!.parent === null && camera!.matrixWorldAutoUpdate) camera!.updateMatrixWorld();
    }
    // Then what each batch, chunk and merged cell has in view leads its draw, and what the rooms' portals show.
    viewCull.update(camera!);
    archHost.rooms.update(camera!);
    isolation.sweep();
    lights.budgetShadows(camera!);
    // The terrains' nodes for this view (only when it or their tiles changed), and tiles that arrived uploaded.
    terrains.update(viewCull.view, renderer as never);
    // Ground cover around the view's eye, and the eye every pass reads distance from (foliage's wind distance).
    scatter.cover.update(viewCull.view);
    materialLibrary?.setViewEye(viewCull.view.eye[0]!, viewCull.view.eye[1]!, viewCull.view.eye[2]!);
    // Then what is hidden behind what is in front of it (what the frustum, the rooms and isolation left drawn, the
    // terrains' nodes and the cover chosen for this view).
    occlusion.update();
    seeThrough.update(renderer, camera!);
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
      if ((wanted || qualityControl.needsEnvironment() || renderControl.needsEnvironment() || occlusion.needsEnvironment()) && environmentRenderer === null) {
        // The sky, its faces and the grading LUT are held for the environment's life. They are the same
        // decoded textures materials draw with (the environment builds its cube, equirect copy and LUT
        // from their images and never changes them), so a texture used by both is decoded once.
        const envTextures = textureHolds(resources, opts.environment?.loadTexture ?? (async () => null));
        // A sky image that arrives later is drawn by the next frame (a host drawing on demand is told).
        environmentRenderer = createEnvironmentRenderer(renderer, scene, { loadTexture: (id) => envTextures.get(id, 'environment'), scenePasses: () => occlusion.scenePasses(), ...(opts.onChange !== undefined ? { onChange: opts.onChange } : {}) });
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
        environmentRenderer.setFogVolumes(entities.fogVolumesNow());
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
    if (!force && precompile.holds(() => !models.startIn || clipped?.holdsStart() === true, camera === null ? null : () => compileFrame(renderer))) {
      if (probing) lights.probeAgain();
      lastFrameSkipped = true;
      return { ok: true };
    }
    clipped?.presented();
    const frameInfo = (renderer as { info?: { render?: { drawCalls: number; triangles: number } } }).info?.render ?? { drawCalls: 0, triangles: 0 };
    const drawsBefore = frameInfo.drawCalls;
    const trianglesBefore = frameInfo.triangles;
    // A capture during a precompile draws with the renderer's own target and outputs (the compile holds the pass's).
    const job = precompile.job();
    const draw = (): void => {
      const render = (): void => {
        if (environmentRenderer !== null) environmentRenderer.render(camera!);
        else renderer.render(scene, camera!);
      };
      if (job !== null) job.aside(render);
      else {
        render();
        // The occlusion queries (WebGL 2) are drawn against the finished frame's depth.
        occlusion.afterDraw();
      }
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
    scenes.presentedRevision = scenes.realizedRevision;
    if (opts.onFrameDrawn !== undefined) {
      const realized = scenes.frameRealized.splice(0);
      try {
        const pre = precompile.takeSettled();
        opts.onFrameDrawn({ realizedScenes: realized, renderMs: performance.now() - renderStart, firstCallAt: firstRenderCallAt ?? renderStart, ...(pre !== null ? { precompile: { startedAt: pre.startedAt, ms: pre.ms } } : {}), draws: lastFrameCounts.drawCalls, sceneRevision: scenes.realizedRevision });
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
      renderBackend: canvasRenderer.backend,
      rendererInfo: canvasRenderer.info,
      canvasSize: canvasRenderer.canvasSize(),
      pixelRatio: canvasRenderer.pixelRatio,
      shadows: lit.shadows,
    };
    const pre = precompile.diagnostics();
    if (pre !== null) d.precompile = pre;
    const choice = canvasRenderer.handle !== null && !disposed ? canvasRenderer.handle.info() : canvasRenderer.lastInfo;
    if (choice !== null) d.renderer = choice;
    // `shadowReason` is present iff `shadows === 'off'`; the lights that are on.
    if (lit.shadowReason !== undefined) d.shadowReason = lit.shadowReason;
    if (lit.shadowMaps !== undefined && !disposed) d.shadowMaps = lit.shadowMaps;
    if (lit.lights !== undefined && !disposed) d.lights = lit.lights;
    // The `models` counters block — present iff the `models`
    // option was given and the adapter is not disposed (absent when
    // `models` is absent; after dispose the realization is gone).
    if (models.realization !== null && !disposed) {
      d.models = models.realization.counters();
    }
    const liveRenderer = canvasRenderer.handle !== null && !disposed ? canvasRenderer.handle.current() : null;
    if (liveRenderer !== null) d.gpu = rendererMemory(liveRenderer);
    const fx = disposed ? null : effects.diagnostics();
    if (fx !== null) d.effects = fx;
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
      d.lod = { bias: t.bias, hysteresis: t.hysteresis, switches: t.switches, copySwitches: t.copySwitches, instances: models.realization?.instanceStats() ?? { copies: 0, inView: 0, byLevel: [], culled: 0, thinned: 0 } };
    }
    if (!disposed) level.diagnostics(d);
    if (!disposed) d.occlusion = occlusion.diagnostics();
    if (!disposed) scatter.diagnostics(d);
    const { runtime: runtimeMaterials, swaps } = materials;
    if (!disposed && materialLibrary !== null && runtimeMaterials !== null) d.materials = { graphMaterials: materialLibrary.graphMaterialCount(), ...(swaps !== null && (swaps.applied > 0 || swaps.pending() > 0) ? { swapsApplied: swaps.applied, swapsPending: swaps.pending() } : {}), ...runtimeMaterials.diagnostics() };
    const envDiagnostics = environmentRenderer !== null && !disposed ? environmentRenderer.diagnostics() : null;
    if (envDiagnostics !== null) d.environment = envDiagnostics;
    if (!disposed && lastFrameDrawn) d.render = { ...renderControl.diagnostics(), internal: envDiagnostics?.render.internal ?? null };
    if (!disposed) d.quality = { ...qualityControl.diagnostics(), ...(lit.shadowMapSize !== undefined ? { keyShadowMapSize: lit.shadowMapSize } : {}) };
    const probeState = disposed ? null : probes.observe();
    if (probeState !== null) d.probes = probeState;
    if (opts.textureStreamer !== undefined && !disposed) d.textures = opts.textureStreamer.observe();
    const decalState = decalPages !== null && !disposed ? decalPages.observe() : null;
    if (decalState !== null && decalState.decals > 0) d.decals = decalState;
    const projected = projectors !== null && !disposed ? projectors.observe() : null;
    if (projected !== null && projected.decals > 0) d.projectedDecals = projected;
    const clips = clipped !== null && !disposed ? clipped.diagnostics() : null;
    if (clips !== null && clips.decals > 0) d.clippedDecals = clips;
    const painted = disposed ? null : vertexPaintDiagnostics(scene);
    if (painted !== null) d.vertexPaint = painted;
    if (seeThrough.diagnostics().armed) d.seeThrough = seeThrough.diagnostics();
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
    channelView?.dispose();
    isolation.dispose();
    models.disposePlayers();
    effects.dispose();
    lightmaps?.dispose();
    clipped?.dispose();
    probes.dispose();
    preparations.clear();
    materials.dispose();
    environmentRenderer?.dispose();
    environmentHolds?.releaseHolder('environment');
    lights.dispose();
    seeThrough.dispose();
    // The model realization first of what holds assets: every in-flight prepare cancelled, a late completion released.
    models.dispose();
    // A manager of the adapter's own goes with it (the page's is the page's).
    if (opts.resources === undefined) resources.dispose();
    // Release ALL owned Object3D/material/renderer lifetimes (repeatable
    // disposal, as in runtime.md: no leaked loop, no stale GPU state).
    canvasRenderer.dispose();
    entities.dispose();
    batcher?.dispose();
    viewCull.dispose();
    occlusion.dispose();
    blockView.dispose();
    terrains.dispose();
    splines.dispose();
    archHost.dispose();
    scatter.dispose();
    ownTiles?.dispose();
    entities.disposeBoxMaterials();
    unitBox.dispose();
    entityDocs.clear();
    // The handle disposes the renderer (WebGPURenderer's WebGL 2 backend drops its context).
    canvasRenderer.disposeRenderer();
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
    rendererStarting: (): boolean => !disposed && canvasRenderer.starting(),
    diagnostics,
    dispose,
    renderedNodes: (entityId, names) => (disposed ? null : models.nodePoses(entityId, names)),
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
      return preparations.prepare(sceneId, entities, textures);
    },
    holdAssets(models, textures) {
      return preparations.hold(models, textures);
    },
    presentedSceneRevision(): number {
      return scenes.presentedRevision;
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
      scenes.releaseAll();
      lightmaps?.dispose();
      lightmaps = lightmapSetOf(bakes);
      lightmapsLive = lightmaps;
      probes.setBakes(bakes);
      for (const id of blockView.layerIds()) blockView.setLightmapUv(id, lightmaps?.hasChunks(id) === true);
      blockView.remeshAll();
    },
    setArchitectureStyles(graphs): void {
      if (!disposed) architecture.setStyles(graphs);
    },
    previewArchitecture(preview): number {
      return disposed ? 0 : architecture.preview(preview);
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
    architectureBake: () => ({ meshes: (id) => architecture.meshes(id), rooms: (inset) => archHost.rooms.roomBoxes(inset) }),
    entityObject: (entityId, create) => (disposed ? null : ((create === true ? graph.nodeFor(entityId) : graph.node(entityId)) ?? null)),
    entityOf(object): string | null {
      for (let o: THREE.Object3D | null = object; o !== null; o = o.parent) if (o instanceof EntityNode) return o.entityId;
      else if (typeof o.userData[TERRAIN_ENTITY_KEY] === 'string') return o.userData[TERRAIN_ENTITY_KEY] as string;
      return null;
    },
    occlusion: () => occlusion,
    setIsolation(ids): void {
      if (!disposed && isolation.set(ids)) opts.onChange?.();
    },
    isolationDiagnostics: () => isolation.diagnostics(),
    threeScene: () => scene,
    probeLighting: () => probes.light(),
    pickables: () => graph.pickables(),
    clippedDecalMesh: (entityId) => clipped?.meshOf(entityId) ?? null,
    clippedDecalWaits: (entityId, wait) => clipped?.waitForSurfaces(entityId, wait),
    paintPreview(entityId, target) {
      if (disposed || opts.vertexPaint === false) return null;
      if ('path' in target) return target.path === 'spline' ? splines.paintPreview(entityId, target.side) : architecture.paintPreview(entityId, target.path, target.side);
      return models.realization?.paintPreview(entityId, target.copy) ?? null;
    },
    paintOwnerOf(object): string | null {
      for (let o: THREE.Object3D | null = object; o !== null; o = o.parent) if (typeof o.userData[PATH_PAINT_ENTITY_KEY] === 'string') return o.userData[PATH_PAINT_ENTITY_KEY] as string;
      return api.entityOf?.(object) ?? null;
    },
    paintChannelView: (channel) => (channelView ??= new PaintChannelView(scene)).set(channel),
    attachOverlay: (entityId, object): void => entities.attachOverlay(entityId, object),
    detachOverlay: (entityId, object): void => entities.detachOverlay(entityId, object),
    instanceSet: (entityId) => models.realization?.instanceSet(entityId) ?? null,
    instanceBuffer: (digest) => models.realization?.instanceBuffer(digest),
    modelFailures: () => models.realization?.failures() ?? new Map(),
    blockLayers: () => blockView,
    seeThrough: () => seeThrough,
    terrainDiagnostics: () => (terrains.ids().length > 0 ? terrains.diagnostics() : null),
    terrains: () => terrains,
    scatter: () => scatter.stored,
    cover: () => scatter.cover,
    currentRenderer: () => (disposed ? null : canvasRenderer.current()),
    frameSkipped: () => lastFrameSkipped || precompile.active(),
    lastFrame: () => ({ drawCalls: lastFrameCounts.drawCalls, triangles: lastFrameCounts.triangles, samples: msaaMark, batching: batcher !== null && lastFrameDrawn ? batcher.diagnostics() : null }),
  };
  // The settle surface — present iff the `models` option was
  // given. A config-invalid block resolves the structured failure (the
  // wrapper posts `tl.error`); a realized block resolves when every
  // prepare has settled. Never rejects.
  if (opts.models !== undefined) api.modelsSettled = () => models.settled();
  return api;
}