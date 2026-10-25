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
 *
 * This is the composition root: each subsystem has its own module
 * (adapter-*.ts) and is made here in the order the scene depends on.
 */
import * as THREE from 'three';
import { createResourceManager, type ResourceManager } from '@thirdlight/runtime';

import { AdapterEffects } from './adapter-effects';
import { AdapterEntities, type EntityDoc } from './adapter-entities';
import { AdapterEnvironment } from './adapter-environment';
import { AdapterFrame, NO_HIDDEN } from './adapter-frame';
import { createAdapterLevel } from './adapter-level';
import { AdapterMaterials } from './adapter-materials';
import { AdapterModels } from './adapter-models';
import type { AdapterParts, AdapterState } from './adapter-parts';
import { AdapterRenderer, type CanvasLike } from './adapter-renderer';
import { AdapterScenes } from './adapter-scenes';
import { createAdapterSurface } from './adapter-surface';
import { createAutoBatcher, markBatchable, unitBoxGeometry } from './batching';
import { compileIntoTarget, type Precompile } from './environment-nodes';
import { materialParamsOf } from './entity-refs';
import { applyEntityRenderFlags } from './entity-render-flags';
import { createGpuTiming } from './gpu-timing';
import { IsolationView } from './isolation-view';
import { addBoxLightmapUv, createLightmapSet, type LightingBakeLike, type LightmapSet } from './lightmaps';
import { createSceneLights } from './lights-shadows';
import { LOD_TUNING_KEY } from './lod-switch';
import { OcclusionCuller } from './occlusion';
import { OCCLUSION_ORACLE_KEY, runOcclusionOracle, type OracleOptions } from './occlusion-oracle';
import { PrecompileGate } from './precompile-gate';
import { createProbeLightingHost } from './probe-grids';
import { createQualityControl } from './quality-control';
import { createRenderControl } from './render-control';
import { RenderGraph } from './render-graph';
import type { AnyRenderer } from './renderer-factory';
import { createScenePreparations } from './scene-preparation';
import { StaticShadowRevision } from './shadow-casters';
import { markStatic } from './static-merge';
import { textureHolds } from './texture-holds';
import { ViewCuller } from './view-cull';
import type { SceneAdapter, SceneAdapterOptions } from './adapter-types';

export type { ScreenshotResult } from './capture';
export { PRECOMPILE_STALL_MS, PRECOMPILE_WAIT_MS, type FrameDrawnInfo, type SceneAdapter, type SceneAdapterDiagnostics, type SceneAdapterOptions } from './adapter-types';

export function createSceneAdapter(canvas: unknown, opts: SceneAdapterOptions): SceneAdapter {
  const scene = new THREE.Scene();
  /**
   * What this adapter loads from assets is held in the page's resource
   * manager (the page settles it after each frame); without one, the
   * adapter's own, settled after each change.
   */
  const resources: ResourceManager = opts.resources ?? createResourceManager({ schedule: (run) => queueMicrotask(run) });
  if (opts.background !== undefined) scene.background = new THREE.Color(opts.background);
  const state: AdapterState = { disposed: false, lightmaps: null, camera: null, hiddenIds: NO_HIDDEN };
  // Project materials (shared by boxes, models and instance sets), node materials, decals.
  const materials = new AdapterMaterials(scene, resources, opts, () => state.lightmaps);
  const materialLibrary = materials.library;
  /** The documents of every realized entity (the loaded scenes). */
  const entityDocs = new Map<string, EntityDoc>();
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
  state.lightmaps = lightmapSetOf(opts.lighting?.bakes ?? null);
  /** The loaded scenes' baked probe tiles (they follow the realized scenes) and the probe light every material samples. */
  const probes = createProbeLightingHost(scene, resources, opts.lighting?.loadBytes, { onChange: () => opts.onChange?.(), ...(opts.lighting?.onProblem !== undefined ? { onProblem: opts.lighting.onProblem } : {}) });
  probes.setBakes(opts.lighting?.bakes ?? null);
  /** The look drawn and the environment renderer (made with the renderer). */
  const environment = new AdapterEnvironment(scene, resources, opts, { lights: () => lights, lightmaps: () => state.lightmaps, materials: materialLibrary });
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
  // The values scripts set go on one object's own meshes (its child objects have nodes of their own).
  materials.trackRuntime((entityId) => {
    const out: THREE.Object3D[] = [];
    graph.node(entityId)?.traverse((o) => void ((o as THREE.Mesh).isMesh === true && out.push(o)));
    return out;
  });
  const effects = new AdapterEffects(scene, resources, opts, materialLibrary);
  const gpuTiming = createGpuTiming();
  // AO kind, render scale and dynamic resolution, applied to the environment renderer.
  const renderControl = createRenderControl(opts.render);
  // The snapshot is deep-frozen and runtime-validated; the adapter reads it structurally and never re-validates.
  const isV3 = opts.snapshot.scene.schemaVersion === 3 || opts.snapshot.scene.schemaVersion === 4;
  // Where the view starts (the runtime's camera brain resolved it before the first frame; the shots move it from there).
  const startView: [number, number, number] = [0, 0, 0];
  (opts.runtime as { readCameraView?: (p: number[], r: number[]) => unknown }).readCameraView?.(startView, [0, 0, 0, 1]);
  /** What the cached static shadow map shows changed (null: every caster drawn into one map every frame). */
  const staticShadows = opts.shadowCache === false ? null : new StaticShadowRevision();
  const staticChanged = staticShadows === null ? null : (where: Parameters<StaticShadowRevision['touched']>[0] | null) => (where === null ? staticShadows.bump() : staticShadows.touched(where));
  graph.onStaticChange(staticChanged);
  /** The loaded scenes' lights and the key light's shadow (lights-shadows.ts): a point or spot light hangs on its entity's node; the others off the scene. */
  const lights = createSceneLights({
    scene, v3: isV3, staticShadows, startView, resources,
    loadCookie: opts.lights?.loadTexture ?? opts.materials?.loadTexture ?? opts.environment?.loadTexture ?? null,
    bakedLight: (id) => state.lightmaps?.isBakedLight(id) === true,
    place: (id, light) => graph.nodeFor(id)?.add(light),
    shadingChanged: () => {
      precompile.want();
      opts.onChange?.();
    },
    tagBits: environment.look.tagBits,
    localShadows: { roomSeen: (k) => level.archHost.rooms.roomSeen(k), movers: () => level.archHost.rooms.movers() },
  });
  /** The unit box every box is drawn through when batched. */
  const unitBox = unitBoxGeometry(addBoxLightmapUv);
  /** What batches, instance-set chunks and merged cells draw is culled inside against the frame's camera. */
  const viewCull = new ViewCuller();
  /** Repeated objects drawn instanced (absent when the option turns it off). */
  const batcher = opts.batching === false ? null : createAutoBatcher(scene, { merging: opts.merging ?? 'load', viewCull, park: (o, on) => graph.park(o, on), ...(staticChanged !== null ? { staticChanged } : {}) });
  // A scene dump (the perf harness's plain page) reads the parked drawables with the scene.
  scene.userData['tlParked'] = graph.parkedObjects();
  // The world matrices are brought up to date right before every render (the batcher's update, else the frame,
  // so the view culls with them): the renderer's own pass is left out.
  scene.matrixWorldAutoUpdate = false;
  const regroupEntity = (id: string): void => {
    const node = batcher === null ? undefined : graph.node(id);
    if (node !== undefined) batcher!.touch(node);
  };
  // An editor's edit mode drawing only the objects it edits.
  const isolation = new IsolationView({ scene, entityOf: (o) => surface.entityOf?.(o) ?? null, node: (id) => graph.node(id), regroup: (o) => batcher?.touch(o), shadowsChanged: () => staticShadows?.bump() });
  // Redefined project materials: block chunks' UVs follow, then the meshes wearing them are grouped again.
  materials.listenReassigned(batcher === null ? null : (root) => batcher.touch(root));
  const level = createAdapterLevel({
    opts, scene, resources, canvas, graph, materialLibrary, effectiveMaterials: materials.effective, components: (id) => entityDocs.get(id)?.components,
    realization: () => models.realization, lightmaps: () => state.lightmaps, staticShadows, batcher, viewCull, renderer: () => renderer.current(), lights,
    precompile: () => precompile, startModelsIn: () => models.startIn,
  });
  const entities = new AdapterEntities(entityDocs, {
    graph, lights, blockView: level.blockView, terrains: level.terrains, splines: level.splines, architecture: level.architecture, cover: level.scatter.sink !== undefined ? level.scatter.cover : null, clipped: level.clipped, effects, materials,
    lightmaps: () => state.lightmaps, realization: () => models.realization, unitBox, vertexPaint: opts.vertexPaint !== false, terrain: opts.terrain !== false,
  });
  {
    // The start scenes' entities, each with its scene (the snapshot's own scene when the runtime has no scene set).
    const sceneOf = new Map<string, string>();
    for (const b of opts.runtime.sceneSet?.()?.batches ?? []) for (const e of b.entities) sceneOf.set((e as { id: string }).id, b.sceneId);
    const own = (opts.snapshot.scene as { sceneId?: string }).sceneId ?? null;
    for (const e of opts.snapshot.scene.entities) entities.realize(e, sceneOf.get(e.id) ?? own);
  }
  // The view's camera, posed every frame from the camera brain. Aspect is a viewport property, updated per frame.
  state.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  state.camera.position.set(startView[0], startView[1], startView[2]);
  const models = new AdapterModels(opts, {
    graph, materialLibrary, resources,
    entityMaterials: (entityId) => materials.effective(entityId, (entityDocs.get(entityId)?.components as { materials?: Record<string, string> } | undefined)?.materials) ?? null,
    entityMaterialParams: (entityId) => materialParamsOf(entityDocs.get(entityId)?.components),
    // A copy dragged in place: the shadowed lamps near it draw their maps again.
    copiesMoved: (spheres) => level.archHost.rooms.noteMoved(spheres),
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
      state.lightmaps?.apply(entityId, root);
      opts.onChange?.();
    },
  });
  materials.createSwaps({
    components: (id) => entityDocs.get(id)?.components,
    disposed: () => state.disposed,
    assetMaterials: (assetId) => (assetId === undefined ? undefined : opts.models?.assets.find((a) => a.assetId === assetId)?.materials),
    blockTypes: () => level.blockTypes,
    restyleView: (entityId, c) => {
      // A spline's, an architecture's or a terrain's object: its view's meshes wear it (no entity node of their own).
      if ((c as { spline?: unknown }).spline !== undefined) level.splines.restyle(entityId);
      else if ((c as { architecture?: unknown }).architecture !== undefined) level.architecture.restyle(entityId);
      else if ((c as { terrain?: unknown }).terrain !== undefined) level.terrains.restyle(entityId, materials.effective(entityId, (c as { materials?: Record<string, string> }).materials) ?? null, materialParamsOf(c));
      else return false;
      return true;
    },
    node: (id) => graph.node(id),
    lightmaps: () => state.lightmaps,
    reapplyModel: (id) => models.realization?.reapplyMaterials(id) ?? null,
    regroup: regroupEntity,
    setBlockTypes: (types) => level.blockView.setTypes(types),
  }, opts.materials?.textureRefs);
  // The renderer, made on the first frame (WebGPURenderer initialises asynchronously; set up once ready).
  const renderer: AdapterRenderer = new AdapterRenderer(canvas as CanvasLike | null, opts, {
    pixelRatioCap: () => qualityControl.pixelRatioCap(),
    dropRendererState: () => environment.drop(),
    adopted: (r, api) => {
      // The effect executors follow the renderer (compute on WebGPU, the CPU on WebGL 2).
      effects.player?.setRenderer(r, api);
      lights.rendererReplaced();
      // A new renderer (a lost device) builds its programs ahead of its first present too.
      precompile.restart();
    },
  });
  // Occlusion culling (occlusion.ts): the project's or quality level's setting, the renderer's path, the page's pin.
  const occlusion = new OcclusionCuller({ scene, setting: () => renderControl.occlusionCulling(), renderer: () => renderer.backend, pinned: opts.occlusion ?? null, showPyramid: opts.occlusionPyramid ?? null, view: viewCull.view, gpu: () => (renderer.backend === 'webgpu' ? renderer.current() : null), computeMs: () => gpuTiming.computeMs(), canvas: renderer.canvas, changed: () => opts.onChange?.(), keep: { scene, entityOf: (o) => surface.entityOf?.(o) ?? null, node: (id) => graph.node(id), drawOf: (m) => batcher?.drawOf(m) ?? null }, fades: (o, c) => level.seeThrough.bitsFor(o, c) !== 0, ...(opts.occlusionProblem !== undefined ? { onProblem: opts.occlusionProblem } : {}) });
  /** Scenes prepared ahead of their load (released once realized). */
  const preparations = createScenePreparations({ disposed: () => state.disposed, realization: () => models.realization, materialLibrary, architecture: level.architecture, blocks: level.blockView.prepared });
  const scenes: AdapterScenes = new AdapterScenes({
    runtime: opts.runtime, entities, realization: () => models.realization, lightmaps: () => state.lightmaps, forgetLook: (id) => frame.forgetLook(id), preparations,
    requestPrecompile: () => precompile.want(), selectLights, followProbes: (ids) => probes.follow(ids), v3: isV3, vertexPaint: opts.vertexPaint !== false,
    ownScene: (opts.snapshot.scene as { sceneId?: string }).sceneId,
  });
  /** The loaded scenes' lights switched (the most recently loaded scene's directional, ambient and hemisphere light, local ones within the budget). */
  function selectLights(): void {
    lights.select(scenes.rankOf, state.hiddenIds);
  }
  selectLights();
  /** The quality level drawn and its renderer settings (quality-control.ts). */
  const qualityControl = createQualityControl(
    {
      renderControl, lodTuning: graph.lodTuning,
      setLightLimits: (limits) => lights.setLimits(limits),
      reselectLights: selectLights,
      setPixelRatioCap: (cap) => {
        renderer.setPixelRatioCap(cap);
        // The post stack follows the new drawing-buffer size.
        environment.resized();
      },
      environment: () => environment.renderer,
      changed: () => opts.onChange?.(),
    },
    { project: environment.look.value, ...(opts.lod !== undefined ? { lod: opts.lod } : {}), pinned: opts.qualityPinned ?? null },
  );
  scenes.followProbes();
  // Pipelines precompiled ahead of a present (precompile-gate.ts).
  const precompile = new PrecompileGate(() => state.disposed);
  const parts: AdapterParts = {
    opts, scene, state, graph, materials, effects, entities, scenes, models, renderer, environment, lights, probes, level, batcher, viewCull, isolation, occlusion, precompile, qualityControl, renderControl, gpuTiming,
    clockStart, followShadow: isV3, selectLights, regroupEntity,
    environmentFrame: {
      needed: () => qualityControl.needsEnvironment() || renderControl.needsEnvironment() || occlusion.needsEnvironment(),
      scenePasses: () => occlusion.scenePasses(),
      created: (env) => qualityControl.applyEnvironment(env),
      apply: (env) => renderControl.apply(env),
      keyDirection: () => lights.keyDirection(),
      fogVolumes: () => entities.fogVolumesNow(),
    },
    // The scene as the frame would draw it, compiled: the environment renderer's scene pass, or the canvas.
    compileFrame: (r: AnyRenderer): Precompile => (environment.renderer !== null ? environment.renderer.compileAsync(state.camera!) : compileIntoTarget(r, scene, state.camera!, r.getRenderTarget(), r.getMRT())),
  };
  const frame: AdapterFrame = new AdapterFrame(parts);
  const surface: SceneAdapter = createAdapterSurface(parts, frame, { lightmapSetOf, unitBox, preparations, ownResources: opts.resources === undefined ? resources : null });
  return surface;
}
