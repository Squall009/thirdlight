/**
 * The adapter's surface (`SceneAdapter`): what pages, the editor and tools
 * call, each a short delegation to the part that owns it, and the one
 * dispose that releases every part in the order their lifetimes need.
 */
import * as THREE from 'three';
import type { EnvironmentBlendView } from '@thirdlight/runtime';

import { adapterDiagnostics } from './adapter-diagnostics';
import type { AdapterFrame } from './adapter-frame';
import type { AdapterParts } from './adapter-parts';
import type { SceneAdapter } from './adapter-types';
import { createFrameCapture } from './capture';
import type { QualityLevel } from './environment';
import { ENV_STALE } from './environment-look';
import type { LightingBakeLike, LightmapSet } from './lightmaps';
import { EntityNode } from './render-graph';
import type { ScenePreparations } from './scene-preparation';
import { TERRAIN_ENTITY_KEY } from './terrain-view';
import { PaintChannelView } from './vertex-paint-channel-view';
import { PATH_PAINT_ENTITY_KEY } from './vertex-paint-paths-view';

/** What only the surface needs from the root. */
export interface AdapterSurfaceExtras {
  /** Lightmaps of new bakes (null: none). */
  lightmapSetOf(bakes: Readonly<Record<string, LightingBakeLike>> | null): LightmapSet | null;
  readonly unitBox: THREE.BufferGeometry;
  readonly preparations: ScenePreparations;
  /** The adapter's own resource manager (null: the page's, which the page releases). */
  readonly ownResources: { dispose(): void } | null;
}

export function createAdapterSurface(p: AdapterParts, frame: AdapterFrame, x: AdapterSurfaceExtras): SceneAdapter {
  const { opts, graph, state, level, models, materials } = p;
  /** The paint tool's channel view (made the first time it is shown). */
  let channelView: PaintChannelView | null = null;
  const projectScratch = new THREE.Vector3();
  const projectWorld: number[] = [0, 0, 0];
  const projectScratch2 = new THREE.Vector3();
  const { captureScreenshot, captureThumbnail } = createFrameCapture({ canvas: p.renderer.canvas, drawFrame: () => frame.draw(true), skipped: () => frame.skipped });

  function dispose(): { ok: true; alreadyDisposed?: true } {
    if (state.disposed) return { ok: true, alreadyDisposed: true };
    state.disposed = true;
    channelView?.dispose();
    p.isolation.dispose();
    models.disposePlayers();
    p.effects.dispose();
    state.lightmaps?.dispose();
    level.clipped?.dispose();
    p.probes.dispose();
    x.preparations.clear();
    materials.dispose();
    p.environment.dispose();
    p.lights.dispose();
    level.seeThrough.dispose();
    // The model realization first of what holds assets: every in-flight prepare cancelled, a late completion released.
    models.dispose();
    // A manager of the adapter's own goes with it (the page's is the page's).
    x.ownResources?.dispose();
    // Release ALL owned Object3D/material/renderer lifetimes (repeatable disposal, as in runtime.md: no leaked
    // loop, no stale GPU state).
    // The cache's GPU work before its device goes with the renderer.
    p.surfaceLight?.dispose();
    p.renderer.dispose();
    p.entities.dispose();
    p.batcher?.dispose();
    p.viewCull.dispose();
    p.occlusion.dispose();
    level.blockView.dispose();
    level.terrains.dispose();
    level.splines.dispose();
    level.archHost.dispose();
    level.scatter.dispose();
    level.ownTiles?.dispose();
    p.entities.disposeBoxMaterials();
    x.unitBox.dispose();
    p.entities.docs.clear();
    // The handle disposes the renderer (WebGPURenderer's WebGL 2 backend drops its context).
    p.renderer.disposeRenderer();
    graph.dispose();
    p.scene.clear();
    state.camera = null;
    return { ok: true };
  }

  const api: SceneAdapter = {
    renderFrame: () => frame.draw(false),
    captureScreenshot,
    captureThumbnail,
    rendererStarting: (): boolean => !state.disposed && p.renderer.starting(),
    diagnostics: () => ({ ok: true, diagnostics: adapterDiagnostics(p, frame) }),
    dispose,
    renderedNodes: (entityId, names) => (state.disposed ? null : models.nodePoses(entityId, names)),
    setLodTuning(tuning: { readonly bias?: number; readonly hysteresis?: number }): void {
      p.qualityControl.setProjectLod(tuning);
    },
    setRenderSettings(settings, layer) {
      p.renderControl.set(settings, layer);
      opts.onChange?.();
    },
    setQuality: (level: QualityLevel): boolean => p.qualityControl.choose(level),
    qualityLevel: (): QualityLevel => p.qualityControl.level().id,
    takeGpuTime: () => p.gpuTiming.take(),
    projectToScreen(target, out): boolean {
      const camera = state.camera;
      if (state.disposed || camera === null) return false;
      const v = projectScratch;
      if (typeof target.entityId === 'string') {
        if (!graph.world.position(target.entityId, projectWorld)) return false;
        v.set(projectWorld[0]!, projectWorld[1]!, projectWorld[2]!);
      } else if (target.point !== undefined && target.point.length === 3) v.set(target.point[0]!, target.point[1]!, target.point[2]!);
      else return false;
      if (target.offset !== undefined && target.offset.length === 3) v.set(v.x + target.offset[0]!, v.y + target.offset[1]!, v.z + target.offset[2]!);
      if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z)) return false;
      camera.updateMatrixWorld();
      // In front: the point's depth in camera space is negative (cameras look down −Z).
      const front = projectScratch2.copy(v).applyMatrix4(camera.matrixWorldInverse).z < 0;
      v.project(camera);
      out[0] = (v.x + 1) / 2;
      out[1] = (1 - v.y) / 2;
      out[2] = front ? 1 : 0;
      return true;
    },
    previewEnvironmentBlend(view: EnvironmentBlendView | null, tagBits?: ReadonlyMap<string, number>): void {
      const look = p.environment.look;
      look.preview = view;
      // The editor previews with the project's tags as they are now (presets name lights by tag).
      if (tagBits !== undefined) {
        look.tagBits.clear();
        for (const [name, bit] of tagBits) look.tagBits.set(name.toLowerCase(), bit);
        look.appliedKey = ENV_STALE;
      }
    },
    prepareScene: (sceneId, entities, textures) => x.preparations.prepare(sceneId, entities, textures),
    holdAssets: (modelIds, textures) => x.preparations.hold(modelIds, textures),
    presentedSceneRevision: (): number => p.scenes.presentedRevision,
    setEnvironment(value): void {
      if (!state.disposed) p.environment.setValue(value, (v) => p.qualityControl.setProject(v));
    },
    setBakes(bakes): void {
      if (state.disposed) return;
      // Every scene is realized again with the new bakes (the lights they hold leave realtime, the objects take
      // their lightmaps), and every block chunk is re-meshed to take its own.
      p.scenes.releaseAll();
      state.lightmaps?.dispose();
      state.lightmaps = x.lightmapSetOf(bakes);
      p.probes.setBakes(bakes);
      for (const id of level.blockView.layerIds()) level.blockView.setLightmapUv(id, state.lightmaps?.hasChunks(id) === true);
      level.blockView.remeshAll();
    },
    setArchitectureStyles(graphs): void {
      if (!state.disposed) level.architecture.setStyles(graphs);
    },
    previewArchitecture: (preview): number => (state.disposed ? 0 : level.architecture.preview(preview)),
    materialsChanged(): void {
      state.lightmaps?.refresh();
    },
    sync(): void {
      if (!state.disposed) frame.syncWorld();
    },
    worldMatrix(entityId, out): boolean {
      const i = graph.world.indexOf(entityId);
      if (i === undefined || state.disposed) return false;
      out.fromArray(graph.world.world, i * 16);
      return true;
    },
    architectureBake: () => ({ meshes: (id) => level.architecture.meshes(id), rooms: (inset) => level.archHost.rooms.roomBoxes(inset) }),
    entityObject: (entityId, create) => (state.disposed ? null : ((create === true ? graph.nodeFor(entityId) : graph.node(entityId)) ?? null)),
    entityOf(object): string | null {
      for (let o: THREE.Object3D | null = object; o !== null; o = o.parent) if (o instanceof EntityNode) return o.entityId;
      else if (typeof o.userData[TERRAIN_ENTITY_KEY] === 'string') return o.userData[TERRAIN_ENTITY_KEY] as string;
      return null;
    },
    occlusion: () => p.occlusion,
    setIsolation(ids): void {
      if (!state.disposed && p.isolation.set(ids)) opts.onChange?.();
    },
    isolationDiagnostics: () => p.isolation.diagnostics(),
    threeScene: () => p.scene,
    probeLighting: () => p.probes.light(),
    pickables: () => graph.pickables(),
    clippedDecalMesh: (entityId) => level.clipped?.meshOf(entityId) ?? null,
    clippedDecalWaits: (entityId, wait) => level.clipped?.waitForSurfaces(entityId, wait),
    paintPreview(entityId, target) {
      if (state.disposed || opts.vertexPaint === false) return null;
      if ('path' in target) return target.path === 'spline' ? level.splines.paintPreview(entityId, target.side) : level.architecture.paintPreview(entityId, target.path, target.side);
      return models.realization?.paintPreview(entityId, target.copy) ?? null;
    },
    paintOwnerOf(object): string | null {
      for (let o: THREE.Object3D | null = object; o !== null; o = o.parent) if (typeof o.userData[PATH_PAINT_ENTITY_KEY] === 'string') return o.userData[PATH_PAINT_ENTITY_KEY] as string;
      return api.entityOf?.(object) ?? null;
    },
    paintChannelView: (channel) => (channelView ??= new PaintChannelView(p.scene)).set(channel),
    attachOverlay: (entityId, object): void => p.entities.attachOverlay(entityId, object),
    detachOverlay: (entityId, object): void => p.entities.detachOverlay(entityId, object),
    instanceSet: (entityId) => models.realization?.instanceSet(entityId) ?? null,
    instanceBuffer: (digest) => models.realization?.instanceBuffer(digest),
    modelFailures: () => models.realization?.failures() ?? new Map(),
    blockLayers: () => level.blockView,
    seeThrough: () => level.seeThrough,
    terrainDiagnostics: () => (level.terrains.ids().length > 0 ? level.terrains.diagnostics() : null),
    terrains: () => level.terrains,
    scatter: () => level.scatter.stored,
    cover: () => level.scatter.cover,
    currentRenderer: () => (state.disposed ? null : p.renderer.current()),
    frameSkipped: () => frame.skipped || p.precompile.active(),
    lastFrame: () => ({ drawCalls: frame.counts.drawCalls, triangles: frame.counts.triangles, samples: frame.msaaMark, batching: p.batcher !== null && frame.drawn ? p.batcher.diagnostics() : null }),
  };
  // The settle surface — present iff the `models` option was given; never rejects.
  if (opts.models !== undefined) api.modelsSettled = () => models.settled();
  return api;
}
