/**
 * The adapter's frame (runtime.md frame ordering): the runtime is the single
 * frame driver and `draw` runs as its `onFrame`: the scene set, transforms
 * and hidden objects as the runtime has them, the view, looks, effects and
 * animation, then what each view draws for this camera, the environment, and
 * the draw itself (held while the programs it needs are compiled ahead).
 *
 * Kept apart from the adapter so the frame's order is written in one place.
 */
import * as THREE from 'three';
import type { GridRenderChange } from '@thirdlight/runtime';

import type { AdapterParts } from './adapter-parts';
import type { DecalRequestLike } from './decal-projectors';
import { adapterError, type AdapterError } from './errors';
import type { LightValueOverride } from './lights-shadows';
import type { MaterialMappingLike } from './material-swaps';
import { setEntityLook } from './node-materials';
import type { AnyRenderer } from './renderer-factory';
import type { MaterialRenderChangeLike } from './runtime-materials';

/** The hidden set while the runtime hides nothing. */
export const NO_HIDDEN: ReadonlySet<string> = new Set();

type LookLike = { readonly emissive?: string; readonly emissiveIntensity?: number; readonly tint?: string };
type FrameResult = { ok: true } | { ok: false; error: AdapterError };

/** No wind: the clouds stay where their start puts them. */
const STILL_AIR = Object.freeze({ dirX: 1, dirZ: 0, speed: 0 });
const sameLook = (a: LookLike, b: LookLike): boolean => a.emissive === b.emissive && a.emissiveIntensity === b.emissiveIntensity && a.tint === b.tint;
const meshCount = (root: THREE.Object3D): number => {
  let n = 0;
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh === true) n += 1;
  });
  return n;
};

/** What the runtime hands the frame beyond the interpolated state (each optional: a runtime may lack it). */
type FrameRuntime = {
  hiddenEntities?: () => ReadonlySet<string>;
  entityLooks?: () => ReadonlyMap<string, LookLike>;
  lightOverrides?: () => ReadonlyMap<string, LightValueOverride>;
  readCameraView?: (p: number[], r: number[]) => { fovY: number; near: number; far: number } | null;
  setCameraViewport?: (w: number, h: number) => boolean;
  takeDecalRequests?: () => DecalRequestLike[];
  takeGridChanges?: () => GridRenderChange[];
  takeMaterialChanges?: () => MaterialRenderChangeLike[];
  materialSwaps?: () => ReadonlyMap<string, MaterialMappingLike>;
  blockMaterialSwaps?: () => ReadonlyMap<string, MaterialMappingLike>;
  isPaused?: boolean;
};

export class AdapterFrame {
  /** The hidden set last derived from (the runtime hands out the same set while nothing changes). */
  private hiddenSeen: { set: ReadonlySet<string> | null; size: number; revision: number } = { set: null, size: 0, revision: -1 };
  /** The graph's revision at the last transform sync (a change: every transform is read again). */
  private syncedRevision = -1;
  /** The last frame was skipped (WebGPURenderer still initialising, or a precompile holds the present). */
  skipped = false;
  /** A frame was drawn (the renderer info holds its counts). */
  drawn = false;
  /** The MSAA samples last stamped on the canvas. */
  msaaMark = -1;
  private drawsMark = -1;
  /** The last drawn frame's counts. */
  readonly counts = { drawCalls: 0, triangles: 0 };
  /** When the first render call began (for `onFrameDrawn`). */
  private firstRenderCallAt: number | null = null;
  private readonly reportedViewport: [number, number] = [0, 0];
  private lightOverridesKey = '';
  /** The per-object look overrides shown (ctx.look), with the mesh count they were put on. */
  private readonly shownLooks = new Map<string, { look: LookLike; meshes: number }>();
  private readonly viewPos: number[] = [0, 0, 0];
  private readonly viewRot: number[] = [0, 0, 0, 1];
  private readonly tmpSize = new THREE.Vector2();
  /** The transform sync for `forEachInterpolated` (one function for the adapter's life): into the world table. */
  private readonly applyInterpolated = (id: string, position: readonly number[], rotation: readonly number[], scale: readonly number[]): void => {
    this.p.graph.world.setLocal(id, position, rotation, scale);
  };

  constructor(private readonly p: AdapterParts) {}

  private get rt(): FrameRuntime {
    return this.p.opts.runtime as FrameRuntime;
  }

  /** A look override is forgotten (its entity was released). */
  forgetLook(id: string): void {
    this.shownLooks.delete(id);
  }

  /**
   * The scene set, the transforms and the world matrices as the runtime has them now, and what it hides (a frame
   * does this first; an editing host between frames, before it reads matrices).
   */
  syncWorld(): AdapterError | null {
    const { opts, graph, scenes } = this.p;
    // A runtime that hands out its interpolated transforms in reused arrays is read without a per-frame copy.
    if (opts.runtime.forEachInterpolated !== undefined) {
      scenes.sync();
      // Only the entities that moved (a runtime that tracks them); every one when entities came or went,
      // as a newly realized entity starts from its authored transform. Unchanged values change nothing.
      const moved = opts.runtime.forEachMoved?.(this.applyInterpolated);
      const all = moved === undefined || graph.revision !== this.syncedRevision;
      this.syncedRevision = graph.revision;
      if (moved === false || (all && !opts.runtime.forEachInterpolated(this.applyInterpolated))) {
        return adapterError('render_failed', 'runtime state unavailable: runtime is disposed');
      }
    } else {
      const st = opts.runtime.getInterpolatedState();
      if (!st.ok) return adapterError('render_failed', `runtime state unavailable: ${st.error.message}`);
      scenes.sync();
      for (const tr of st.state.transforms) graph.world.setLocal(tr.id, tr.position, tr.rotation, tr.scale);
    }
    // The world matrices, and every static drawable placed by its entity's.
    graph.update();
    this.syncHidden();
    return null;
  }

  /** The objects the simulation hides disappear (and come back on a restart), with their children. */
  private syncHidden(): void {
    const { graph, level, entities, lights } = this.p;
    const hiddenOwn = this.rt.hiddenEntities?.() ?? NO_HIDDEN;
    const seen = this.hiddenSeen;
    if (hiddenOwn === seen.set && hiddenOwn.size === seen.size && graph.revision === seen.revision) return;
    this.hiddenSeen = { set: hiddenOwn, size: hiddenOwn.size, revision: graph.revision };
    const before = this.p.state.hiddenIds;
    const hidden = (this.p.state.hiddenIds = graph.setHidden(hiddenOwn));
    // A hidden block layer's chunks leave the scene (they hang on no entity node).
    for (const id of entities.docLayers) level.blockView.setHidden(id, hidden.has(id));
    for (const id of level.terrains.ids()) level.terrains.setHidden(id, hidden.has(id));
    for (const id of level.splines.ids()) level.splines.setHidden(id, hidden.has(id));
    for (const id of level.architecture.ids()) level.architecture.setHidden(id, hidden.has(id));
    level.scatter.cover.setMeshesHidden(hidden);
    let lightsTouched = false;
    for (const id of before) if (!hidden.has(id) && lights.has(id)) lightsTouched = true;
    for (const id of hidden) if (!before.has(id) && lights.has(id)) lightsTouched = true;
    // A light object hidden or switched off (or back) changes which lights are on.
    if (lightsTouched) {
      this.p.selectLights();
      this.p.precompile.want();
    }
  }

  /** The view as the runtime's camera brain resolved it (the engine owns the view), interpolated like every transform. */
  private applyResolvedCamera(): void {
    const camera = this.p.state.camera;
    if (camera === null) return;
    const { viewPos, viewRot } = this;
    const lens = this.rt.readCameraView?.(viewPos, viewRot) ?? null;
    if (lens === null) return;
    camera.position.set(viewPos[0]!, viewPos[1]!, viewPos[2]!);
    camera.quaternion.set(viewRot[0]!, viewRot[1]!, viewRot[2]!, viewRot[3]!);
    camera.fov = lens.fovY;
    camera.near = lens.near;
    camera.far = lens.far;
  }

  /**
   * The simulation's per-object look overrides (ctx.look): applied when one changes, and again when the object's
   * meshes change (a model that finished loading after the override was set); cleared ones give the object its
   * own look back.
   */
  private syncEntityLooks(): void {
    const looks = this.rt.entityLooks?.();
    const shown = this.shownLooks;
    if (looks === undefined || (looks.size === 0 && shown.size === 0)) return;
    const graph = this.p.graph;
    for (const id of [...shown.keys()]) {
      if (looks.has(id)) continue;
      const obj = graph.node(id);
      if (obj !== undefined) setEntityLook(obj, null);
      shown.delete(id);
      this.p.regroupEntity(id);
    }
    for (const [id, look] of looks) {
      const obj = graph.node(id);
      if (obj === undefined) continue;
      const was = shown.get(id);
      const meshes = meshCount(obj);
      if (was !== undefined && sameLook(was.look, look) && was.meshes === meshes) continue;
      setEntityLook(obj, look);
      shown.set(id, { look, meshes });
      this.p.regroupEntity(id);
    }
  }

  /**
   * The light values scripts wrote (`ctx.entity(id).set('light', …)`): colour and intensity become the light's
   * authored values (presets blend from them; a new run's empty list restores the document's), range is a point
   * or spot light's distance, the masks its light layers. Applied when the list or the light set changed.
   */
  private applyLightOverrides(): void {
    const ov = this.rt.lightOverrides?.();
    if (ov === undefined) return;
    const { lights, environment, entities } = this.p;
    const look = environment.look;
    const key = ov.size === 0 && this.lightOverridesKey === '' ? '' : `${lights.revision}|${JSON.stringify([...ov])}`;
    if (key === this.lightOverridesKey) return;
    this.lightOverridesKey = key;
    // A light a mask turned plain or layered was realized again: the lights that are on are picked again.
    if (lights.applyOverrides(ov, look.blendActive, (id) => (entities.docs.get(id)?.components as { light?: { range?: number } } | undefined)?.light?.range ?? 0)) this.p.selectLights();
    // A running blend blends from the written values.
    if (look.blendActive) look.appliedKey = '';
    if (ov.size === 0) this.lightOverridesKey = '';
  }

  /** The renderer, ready to draw (null: the frame is skipped or failed, as `out` says). */
  private liveRenderer(out: { result: FrameResult }): AnyRenderer | null {
    const { renderer } = this.p;
    if (renderer.contextLost) {
      // The context is currently lost: render nothing (three.js re-initializes its own GL state on
      // `webglcontextrestored`, which clears this flag).
      out.result = { ok: false, error: adapterError('render_context_lost', 'the WebGL context is lost; the frame was not rendered and the context will be restored by the browser') };
      return null;
    }
    const err = renderer.ensure(this.p.state.disposed);
    if (err) {
      out.result = { ok: false, error: err };
      return null;
    }
    this.skipped = false;
    const handle = renderer.handle!;
    const hInfo = handle.info();
    renderer.lastInfo = hInfo;
    if (hInfo.state === 'failed') {
      out.result = { ok: false, error: adapterError('render_unsupported', `the renderer could not start: ${hInfo.reason}`.slice(0, 256)) };
      return null;
    }
    if (hInfo.state === 'lost') {
      out.result = { ok: false, error: adapterError('render_context_lost', `the frame was not rendered: ${hInfo.reason}`.slice(0, 256)) };
      return null;
    }
    const live = handle.current();
    if (live === null || !handle.ready()) {
      // WebGPURenderer initialises asynchronously; frames are skipped (not an error) until it is ready.
      this.skipped = true;
      return null;
    }
    renderer.adopt(handle, live);
    return live;
  }

  /** One frame; `force`: drawn even while a precompile runs (a capture needs this frame's picture). */
  draw(force: boolean): FrameResult {
    const p = this.p;
    if (p.state.disposed) return { ok: false, error: adapterError('adapter_disposed', 'adapter is disposed') };
    const frameStart = performance.now();
    const renderStart = p.opts.onFrameDrawn !== undefined ? frameStart : 0;
    if (this.firstRenderCallAt === null) this.firstRenderCallAt = renderStart;
    const out: { result: FrameResult } = { result: { ok: true } };
    const renderer = this.liveRenderer(out);
    if (renderer === null) return out.result;
    // While a precompile runs, a skipped frame does none of the frame's work (the transform
    // sync, the batches): the compile gets the main thread, and the frame after it starts from now.
    if (!force && p.precompile.running(performance.now())) {
      this.skipped = true;
      return { ok: true };
    }
    const worldError = this.syncWorld();
    if (worldError !== null) return { ok: false, error: worldError };
    this.applyResolvedCamera();
    this.syncEntityLooks();
    this.stepPresentation();
    const camera = p.state.camera!;
    const [w, h] = this.prepareView(renderer, camera);
    // Shadows on before the draw (and before the precompile below, so the programs are built with
    // them); the first frame with the key light's shadow is its probe: if it throws, shadows go off
    // (soft degradation: the `shadows`/`shadowReason` pair is the diagnostic) and it is drawn again without.
    const probing = p.lights.beforeFrame(renderer);
    p.probes.beforeFrame(renderer as unknown as Parameters<typeof p.probes.beforeFrame>[0], camera);
    try {
      p.environment.beforeFrame(renderer, w, h, p.environmentFrame);
    } catch (e) {
      return { ok: false, error: adapterError('render_failed', `render failed: ${String(e)}`) };
    }
    // No present that would build programs in the frame — they are built ahead
    // (renderer.compileAsync) before the first present and after a scene attached; frames are
    // skipped meanwhile (the last picture stays). A capture draws regardless.
    if (!force && p.precompile.holds(() => !p.models.startIn || p.level.clipped?.holdsStart() === true, p.state.camera === null ? null : () => p.compileFrame(renderer))) {
      if (probing) p.lights.probeAgain();
      this.skipped = true;
      return { ok: true };
    }
    return this.present(renderer, camera, probing, frameStart, renderStart);
  }

  /** The effects, the materials' time and the models' animation step with the frame (presentation only). */
  private stepPresentation(): void {
    const p = this.p;
    if (p.effects.player !== null) {
      const rt = this.rt as FrameRuntime & { takeEffectRequests?: () => Parameters<typeof p.effects.frame>[0] };
      p.effects.frame(rt.takeEffectRequests?.() ?? [], (id) => p.graph.nodeFor(id), p.state.hiddenIds, rt.isPaused === true, p.state.camera, (now) => (now - p.clockStart) / 1000, p.renderer.canvas);
    }
    const library = p.materials.library;
    const seconds = ((typeof performance !== 'undefined' ? performance.now() : 0) - p.clockStart) / 1000;
    if (library !== null && library.animated()) library.tick(seconds);
    // The sky's clouds on the same clock, along the global wind (still air without materials).
    p.environment.renderer?.driftClouds(seconds, library?.globalWind() ?? STILL_AIR);
    p.models.animate(p.graph);
    // The animated hierarchies posed as the mixers left them (their bones and drawables follow).
    p.graph.poseAnimated();
  }

  /** The canvas size, then everything each view draws for this camera, culled; the drawing size is returned. */
  private prepareView(renderer: AnyRenderer, camera: THREE.PerspectiveCamera): [number, number] {
    const p = this.p;
    const { graph, level, viewCull } = p;
    if (p.followShadow) p.lights.followCamera(camera);
    // The follow shadow and the size first — the shadow probe is a real frame (it compiles the scene's
    // pipelines), drawn as the game will draw it.
    const [w, h] = p.renderer.canvasSize();
    // Resize only on a change: setSize rewrites the canvas' drawing buffer,
    // and the environment renderer rebuilds its whole post stack on resize.
    const current = renderer.getSize(this.tmpSize);
    if (current.x !== w || current.y !== h || p.renderer.canvas?.width !== Math.floor(w * renderer.getPixelRatio())) renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    // What the camera sees decides which texture mips stream in or out (presentation only).
    p.opts.textureStreamer?.update(p.scene, camera, h * renderer.getPixelRatio(), false, graph.parkedObjects());
    this.decalsBeforeFrame(renderer);
    // The viewport the view is drawn in (screen↔world projection in scripts uses its aspect).
    if (w !== this.reportedViewport[0] || h !== this.reportedViewport[1]) {
      this.reportedViewport[0] = w;
      this.reportedViewport[1] = h;
      this.rt.setCameraViewport?.(w, h);
    }
    // The block chunks the simulation changed, re-meshed before the draw.
    const gridChanges = level.archHost.takeSwaps(this.rt.takeGridChanges?.() ?? []);
    if (gridChanges.length > 0) {
      level.blockView.applyRuntimeChanges(gridChanges);
      level.terrains.applyRuntimeChanges(gridChanges);
    }
    if (level.stream !== null) level.stream.beginFrame(viewCull.view.eye);
    level.blockView.update(viewCull.view.eye);
    // Splines released and not realized again go now (one realized again kept drawing until its new data is in).
    level.splines.update();
    level.architecture.update(viewCull.view.eye);
    // Clipped decals follow their surfaces (chunks made, objects realized) and themselves.
    level.clipped?.beforeFrame();
    // (The near shadows follow the last frame's eye: the view is culled for this one further down.)
    level.scatter.stored.update(viewCull.view);
    if (level.cutaways.wanted()) level.cutaways.follow();
    // The light values scripts wrote, then the environment preset blend
    // (the running game's, or the editor's preview) before the draw.
    this.applyLightOverrides();
    p.environment.applyBlend();
    this.materialsBeforeFrame();
    this.cullView(renderer, camera);
    return [w, h];
  }

  /** The decal pages that arrived go to the GPU; the projected decals' table and index follow their decals. */
  private decalsBeforeFrame(renderer: AnyRenderer): void {
    const p = this.p;
    const pages = p.materials.decalPages;
    // The canvas says so (an export has no other in-page diagnostics surface).
    if (pages?.upload(renderer as unknown as { initTexture?(t: THREE.Texture): void }) === true && typeof p.renderer.canvas?.setAttribute === 'function') {
      const o = pages.observe();
      p.renderer.canvas.setAttribute('data-tl-decal-pages', `${o.pages}|${o.layers}|${o.bytes}|${o.onGpu}`);
    }
    // Moved, added, spawned by scripts, their images arrived.
    p.materials.projectors?.beforeFrame(renderer as never, this.rt.takeDecalRequests?.() ?? [], (id) => p.graph.node(id) ?? null, this.rt.isPaused === true);
  }

  /** Material swaps whose materials have loaded, then the parameters scripts changed (before regrouping). */
  private materialsBeforeFrame(): void {
    const { materials } = this.p;
    if (materials.swaps !== null) materials.swaps.update(this.rt.materialSwaps?.(), this.rt.blockMaterialSwaps?.());
    const materialChanges = this.rt.takeMaterialChanges?.() ?? [];
    if (materialChanges.length > 0) {
      materials.runtime?.apply(materialChanges);
      for (const c of materialChanges) this.p.regroupEntity(c.entityId);
    }
  }

  /** LODs, batches, the view cull, rooms, isolation, shadow budgets, terrain nodes, cover, occlusion, see-through. */
  private cullView(renderer: AnyRenderer, camera: THREE.PerspectiveCamera): void {
    const p = this.p;
    const { graph, level, viewCull, batcher } = p;
    // The level of detail each LOD draws attached (the batcher and the draw see only that one).
    graph.lodTuning.beginFrame();
    graph.updateLods(camera);
    // Regroup the repeated objects and copy their matrices (after every transform and look change).
    p.isolation.beforeBatch();
    level.seeThrough.beforeBatch(camera);
    if (batcher !== null) batcher.update(camera);
    else {
      p.scene.updateMatrixWorld();
      if (camera.parent === null && camera.matrixWorldAutoUpdate) camera.updateMatrixWorld();
    }
    // Then what each batch, chunk and merged cell has in view leads its draw, and what the rooms' portals show.
    viewCull.update(camera);
    level.archHost.rooms.update(camera);
    p.isolation.sweep();
    p.lights.budgetShadows(camera);
    // The terrains' nodes for this view (only when it or their tiles changed), and tiles that arrived uploaded.
    level.terrains.update(viewCull.view, renderer as never);
    // Ground cover around the view's eye, and the eye every pass reads distance from (foliage's wind distance).
    level.scatter.cover.update(viewCull.view);
    // The wind zones where their objects stand now (the wind map round the eye is filled again only when they or the eye's square change).
    p.materials.library?.setWindZones(p.entities.windZonesNow());
    p.materials.library?.setViewEye(viewCull.view.eye[0]!, viewCull.view.eye[1]!, viewCull.view.eye[2]!);
    // Then what is hidden behind what is in front of it (what the frustum, the rooms and isolation left drawn, the
    // terrains' nodes and the cover chosen for this view).
    p.occlusion.update();
    level.seeThrough.update(renderer, camera);
    // The subjects' push on foliage (after see-through has followed the scripts' subject list).
    level.foliageBend.update(camera);
    // Merged cells still building in the background, or a moved static object waiting to rejoin its cell: a host drawing on demand draws again.
    if (batcher?.pending() === true) p.opts.onChange?.();
  }

  /** The draw, its counts on the canvas, and what follows a drawn frame. */
  private present(renderer: AnyRenderer, camera: THREE.PerspectiveCamera, probing: boolean, frameStart: number, renderStart: number): FrameResult {
    const p = this.p;
    const env = () => p.environment.renderer;
    p.level.clipped?.presented();
    const frameInfo = (renderer as { info?: { render?: { drawCalls: number; triangles: number } } }).info?.render ?? { drawCalls: 0, triangles: 0 };
    const drawsBefore = frameInfo.drawCalls;
    const trianglesBefore = frameInfo.triangles;
    // A capture during a precompile draws with the renderer's own target and outputs (the compile holds the pass's).
    const job = p.precompile.job();
    const draw = (): void => {
      const render = (): void => {
        const e = env();
        if (e !== null) e.render(camera);
        else renderer.render(p.scene, camera);
      };
      if (job !== null) job.aside(render);
      else render();
    };
    try {
      try {
        draw();
      } catch (e) {
        if (!probing) throw e;
        p.lights.disableShadows(renderer);
        draw();
      }
      this.markFrame(renderer, frameInfo.drawCalls - drawsBefore, frameInfo.triangles - trianglesBefore);
    } catch (e) {
      return { ok: false, error: adapterError('render_failed', `render failed: ${String(e)}`) };
    }
    this.drawn = true;
    p.probes.frameDrawn();
    p.gpuTiming.afterFrame(renderer);
    const drawnAt = performance.now();
    p.renderControl.frameDrawn(env(), drawnAt, drawnAt - frameStart, p.gpuTiming);
    const scenes = p.scenes;
    scenes.presentedRevision = scenes.realizedRevision;
    if (p.opts.onFrameDrawn !== undefined) {
      const realized = scenes.frameRealized.splice(0);
      try {
        const pre = p.precompile.takeSettled();
        p.opts.onFrameDrawn({ realizedScenes: realized, renderMs: performance.now() - renderStart, firstCallAt: this.firstRenderCallAt ?? renderStart, ...(pre !== null ? { precompile: { startedAt: pre.startedAt, ms: pre.ms } } : {}), draws: this.counts.drawCalls, sceneRevision: scenes.realizedRevision, blocksMeshing: p.level.blockView.meshing() });
      } catch {
        /* a timing hook never breaks a frame */
      }
    }
    return { ok: true };
  }

  /** The MSAA samples and this frame's draw calls on the canvas (the export's only diagnostics surface). */
  private markFrame(renderer: AnyRenderer, draws: number, triangles: number): void {
    const p = this.p;
    const env = p.environment.renderer;
    const samples = env !== null ? env.samples() : renderer.samples;
    const canvas = p.renderer.canvas;
    if (samples !== this.msaaMark && typeof canvas?.setAttribute === 'function') {
      this.msaaMark = samples;
      canvas.setAttribute('data-tl-msaa', String(samples));
    }
    this.counts.drawCalls = Math.max(0, draws);
    this.counts.triangles = Math.max(0, triangles);
    if (this.counts.drawCalls !== this.drawsMark && typeof canvas?.setAttribute === 'function') {
      this.drawsMark = this.counts.drawCalls;
      canvas.setAttribute('data-tl-draws', String(this.drawsMark));
    }
  }
}
