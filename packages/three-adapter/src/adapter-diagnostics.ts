/**
 * The adapter's diagnostics block (the runtime.md adapter block the session
 * layer composes for the play relay): the renderer's choice, shadows and
 * lights, and each part's counters. Works after dispose too (the last known
 * backend, or null).
 */
import type * as THREE from 'three';

import type { AdapterFrame } from './adapter-frame';
import type { AdapterParts } from './adapter-parts';
import type { SceneAdapterDiagnostics } from './adapter-types';
import { INSTANCE_MATRIX_ATTRIBUTE } from './attribute-instancing';
import { rendererMemory } from './renderer-factory';
import { vertexPaintDiagnostics } from './vertex-paint-draw';

type RenderObjects = Iterable<{ object?: THREE.Object3D; geometry?: THREE.BufferGeometry; _nodeBuilderState?: unknown }>;

/** The renderer's render objects (three 0.186 internals, guarded). */
const renderObjectsOf = (renderer: unknown): RenderObjects | undefined => (renderer as { _objects?: { _renderObjects?: RenderObjects } } | null)?._objects?._renderObjects;

export function adapterDiagnostics(p: AdapterParts, frame: AdapterFrame): SceneAdapterDiagnostics {
  const disposed = p.state.disposed;
  const lit = p.lights.diagnostics();
  const d: SceneAdapterDiagnostics = {
    renderBackend: p.renderer.backend,
    rendererInfo: p.renderer.info,
    canvasSize: p.renderer.canvasSize(),
    pixelRatio: p.renderer.pixelRatio,
    shadows: lit.shadows,
  };
  const pre = p.precompile.diagnostics();
  if (pre !== null) d.precompile = pre;
  const handle = p.renderer.handle;
  const choice = handle !== null && !disposed ? handle.info() : p.renderer.lastInfo;
  if (choice !== null) d.renderer = choice;
  // `shadowReason` is present iff `shadows === 'off'`; the lights that are on.
  if (lit.shadowReason !== undefined) d.shadowReason = lit.shadowReason;
  if (lit.shadowMaps !== undefined && !disposed) d.shadowMaps = lit.shadowMaps;
  if (lit.lights !== undefined && !disposed) d.lights = lit.lights;
  // The `models` counters block — present iff the `models` option was given and the adapter is not disposed.
  const realization = p.models.realization;
  if (realization !== null && !disposed) d.models = realization.counters();
  const liveRenderer = handle !== null && !disposed ? handle.current() : null;
  if (liveRenderer !== null) d.gpu = rendererMemory(liveRenderer);
  const fx = disposed ? null : p.effects.diagnostics();
  if (fx !== null) d.effects = fx;
  if (!disposed && frame.drawn) drawnDiagnostics(p, d, liveRenderer);
  if (!disposed) {
    p.level.diagnostics(d);
    d.occlusion = p.occlusion.diagnostics();
    p.level.scatter.diagnostics(d);
  }
  const { library, runtime, swaps } = p.materials;
  if (!disposed && library !== null && runtime !== null) d.materials = { graphMaterials: library.graphMaterialCount(), ...(swaps !== null && (swaps.applied > 0 || swaps.pending() > 0) ? { swapsApplied: swaps.applied, swapsPending: swaps.pending() } : {}), ...runtime.diagnostics() };
  const env = p.environment.renderer;
  const envDiagnostics = env !== null && !disposed ? env.diagnostics() : null;
  if (envDiagnostics !== null) d.environment = envDiagnostics;
  if (!disposed && frame.drawn) d.render = { ...p.renderControl.diagnostics(), internal: envDiagnostics?.render.internal ?? null };
  if (!disposed) d.quality = { ...p.qualityControl.diagnostics(), ...(lit.shadowMapSize !== undefined ? { keyShadowMapSize: lit.shadowMapSize } : {}) };
  const probeState = disposed ? null : p.probes.observe();
  if (probeState !== null) d.probes = probeState;
  if (p.opts.textureStreamer !== undefined && !disposed) d.textures = p.opts.textureStreamer.observe();
  decalDiagnostics(p, d);
  const painted = disposed ? null : vertexPaintDiagnostics(p.scene);
  if (painted !== null) d.vertexPaint = painted;
  if (p.level.seeThrough.diagnostics().armed) d.seeThrough = p.level.seeThrough.diagnostics();
  const bent = p.level.foliageBend.subjects();
  if (bent.length > 0) d.foliageBend = { subjects: bent };
  if (liveRenderer !== null && frame.drawn) d.frame = { drawCalls: frame.counts.drawCalls, triangles: frame.counts.triangles };
  if (!disposed) d.sceneGraph = p.graph.counts();
  return d;
}

/** What a drawn frame tells: instanced and batched programs, the view cull, LOD switches. */
function drawnDiagnostics(p: AdapterParts, d: SceneAdapterDiagnostics, liveRenderer: unknown): void {
  const ros = renderObjectsOf(liveRenderer);
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
  if (p.batcher !== null) {
    d.batching = p.batcher.diagnostics();
    // Distinct node programs of the batch meshes' render objects.
    if (ros !== undefined) {
      const states = new Set<unknown>();
      for (const ro of ros) if (ro.object?.userData['tlBatch'] === true && ro._nodeBuilderState != null) states.add(ro._nodeBuilderState);
      d.batching = { ...d.batching, programs: states.size };
    }
  }
  d.viewCull = p.viewCull.diagnostics();
  const t = p.graph.lodTuning;
  d.lod = { bias: t.bias, hysteresis: t.hysteresis, switches: t.switches, copySwitches: t.copySwitches, instances: p.models.realization?.instanceStats() ?? { copies: 0, inView: 0, byLevel: [], culled: 0, thinned: 0 } };
}

/** The decal pages, projected and clipped decals (each only when there are decals). */
function decalDiagnostics(p: AdapterParts, d: SceneAdapterDiagnostics): void {
  if (p.state.disposed) return;
  const decalState = p.materials.decalPages?.observe() ?? null;
  if (decalState !== null && decalState.decals > 0) d.decals = decalState;
  const projected = p.materials.projectors?.observe() ?? null;
  if (projected !== null && projected.decals > 0) d.projectedDecals = projected;
  const clips = p.level.clipped?.diagnostics() ?? null;
  if (clips !== null && clips.decals > 0) d.clippedDecals = clips;
}
