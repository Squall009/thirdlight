/**
 * The adapter's models: the model realization (models.ts) made when the
 * `models` option is given, the animator poses the runtime committed played
 * on the models, and the one per-frame animation step with the host's frame
 * delta clamped to the accepted range.
 *
 * Kept apart from the adapter so the model path is wired in one place.
 */
import type * as THREE from 'three';
import type { ResourceManager } from '@thirdlight/runtime';

import type { SceneAdapterOptions } from './adapter-types';
import { ANIMATION_MAX_DELTA_SECONDS, type AnimationRoleView } from './animation';
import { createAnimatorPlayer, type AnimatorPlayer, type AnimatorPoseLike } from './animator-player';
import { modelRefsOf } from './entity-refs';
import type { AdapterError } from './errors';
import type { MaterialLibrary } from './material-library';
import { createModelsRealization, type ModelsRealization, type ModelsSettledResult } from './models';
import type { RenderGraph } from './render-graph';

/** What the realization reaches in the rest of the adapter. */
export interface AdapterModelsHost {
  readonly graph: RenderGraph;
  readonly materialLibrary: MaterialLibrary | null;
  readonly resources: ResourceManager;
  /** An object's material mapping as worn now (null: none), and its graph materials' values. */
  entityMaterials(entityId: string): Readonly<Record<string, string>> | null;
  entityMaterialParams(entityId: string): ReturnType<typeof import('./entity-refs').materialParamsOf>;
  /** Copies dragged in place: the shadowed lamps near them draw their maps again. */
  copiesMoved(spheres: Parameters<NonNullable<Parameters<typeof createModelsRealization>[0]['copiesMoved']>>[0]): void;
  /** Painted again in place: batches and merged cells take the new paint. */
  repainted(entityId: string): void;
  /** A model's root attached to its entity's node. */
  attached(entityId: string, root: THREE.Object3D): void;
}

export class AdapterModels {
  /** The realization (null: no `models` option, a config error, or disposed). */
  realization: ModelsRealization | null = null;
  /**
   * The start scenes' models have settled (the blocking assets of the first picture): the first present waits
   * for them, so it shows the whole world and its precompile covers the models' programs. The rest — instance
   * buffers, textures, clips, later scenes — stream in.
   */
  startIn = true;
  private configError: AdapterError | null = null;
  /** The animator poses the runtime committed, played on the models. */
  private readonly animatorPlayers = new Map<string, { instance: unknown; player: AnimatorPlayer }>();
  /** The previous frame's `performance.now()` for the clamped role-controller delta (null: a fresh anchor). */
  private lastFrameNow: number | null = null;

  /**
   * The entity nodes are made on demand (`holderFor`); the prepared ModelInstance roots attach as their
   * children. Config validation surfaces through `settled` and the structured result; the base scene keeps
   * rendering (degraded, never a throw).
   */
  constructor(private readonly opts: SceneAdapterOptions, host: AdapterModelsHost) {
    if (opts.models === undefined) return;
    // Structural reads over the (deep-frozen, runtime-validated) snapshot — never re-validated.
    const { models: modelEntities, pieces: modelPieces, animations: modelAnimationEntities, instances: instanceEntities, paints: modelPaint } = modelRefsOf(opts.snapshot.scene.entities);
    const graph = host.graph;
    const result = createModelsRealization({
      schemaVersion: opts.snapshot.scene.schemaVersion,
      models: opts.models,
      loader: opts.modelsLoader,
      modelEntities,
      modelAnimationEntities,
      instanceEntities,
      modelPaint,
      vertexPaint: opts.vertexPaint !== false,
      modelPieces,
      materialLibrary: host.materialLibrary,
      resources: host.resources,
      entityMaterials: (entityId: string) => host.entityMaterials(entityId),
      entityMaterialParams: (entityId: string) => host.entityMaterialParams(entityId),
      ...(opts.snapshot.scenes !== undefined ? { allowAbsent: true } : {}),
      holderFor: (entityId: string) => graph.nodeFor(entityId) ?? null,
      viewFor: (entityId) => this.viewFor(entityId),
      lodTuning: graph.lodTuning,
      copiesMoved: (spheres) => host.copiesMoved(spheres),
      onRepainted: (entityId: string) => host.repainted(entityId),
      onAttached: (entityId: string, root: THREE.Object3D) => host.attached(entityId, root),
    });
    if (result.ok === true) {
      const realization = result.realization;
      this.realization = realization;
      this.startIn = false;
      void realization.settled().then(() => {
        this.startIn = true;
      });
    } else {
      this.configError = result.error;
    }
  }

  /**
   * No game session drives the roles (the idle/run/airborne profile of an older project): every animated entity
   * gets the constant neutral motion at the runtime's step, so the accepted pure selector yields `idle` — no
   * blending, no run/airborne. The selector reads no runtime internals.
   */
  private viewFor(entityId: string): AnimationRoleView | null {
    void entityId;
    let stepIndex = 0;
    try {
      const d = this.opts.runtime.getDiagnostics?.();
      if (d?.ok === true && Number.isFinite(d.diagnostics.stepIndex)) stepIndex = Math.trunc(d.diagnostics.stepIndex);
    } catch {
      return null;
    }
    return { stepIndex, playerMotion: { speed: 0, grounded: true } };
  }

  /**
   * One host-driven update per rendered frame, after the transform sync and before the render: every live role
   * controller advanced once with the real frame delta clamped to [0, ANIMATION_MAX_DELTA_SECONDS] (the first
   * frame after mount or a suspend/resume is a fresh anchor: no fast-forward), then the animator poses. The
   * controllers install no rAF, no timer, no mixer listener — there is no second loop.
   */
  animate(graph: RenderGraph): void {
    const realization = this.realization;
    if (realization === null) return;
    let delta = 0;
    const perf = globalThis.performance;
    if (perf !== undefined && typeof perf.now === 'function') {
      const now = perf.now();
      if (this.lastFrameNow !== null && Number.isFinite(now) && Number.isFinite(this.lastFrameNow) && now >= this.lastFrameNow) {
        delta = (now - this.lastFrameNow) / 1000;
      }
      this.lastFrameNow = now;
    }
    if (!Number.isFinite(delta) || delta < 0) delta = 0;
    if (delta > ANIMATION_MAX_DELTA_SECONDS) delta = ANIMATION_MAX_DELTA_SECONDS;
    realization.update(delta);
    this.applyAnimatorPoses(realization, graph);
  }

  private applyAnimatorPoses(realization: ModelsRealization, graph: RenderGraph): void {
    const poses = (this.opts.runtime as { animatorPoses?: () => ReadonlyMap<string, AnimatorPoseLike> }).animatorPoses?.();
    if (poses === undefined) return;
    for (const [id, rec] of [...this.animatorPlayers]) {
      const now = realization.instanceOf(id);
      if (!poses.has(id) || now === null || now.instance !== rec.instance) {
        rec.player.dispose();
        this.animatorPlayers.delete(id);
      }
    }
    for (const [id, pose] of poses) {
      let rec = this.animatorPlayers.get(id);
      if (rec === undefined) {
        const found = realization.instanceOf(id);
        if (found === null) continue;
        const rig = found.assetId;
        // Clips of an animation-only asset marked "clips for" this model's asset.
        rec = { instance: found.instance, player: createAnimatorPlayer(found.instance.root, found.instance.animationClips(), rig, { clipsOf: (clipAssetId) => realization.clipsOf(clipAssetId, rig, id) }) };
        this.animatorPlayers.set(id, rec);
      }
      // Poses for an object taken in as static (its animator came later): posed from now on, not baked.
      graph.ensureAnimated(id);
      rec.player.apply(pose);
    }
  }

  /** The poses an animator gave a model's named nodes (null: it has no animator player). */
  nodePoses(entityId: string, names: Parameters<AnimatorPlayer['nodePoses']>[0]): ReturnType<AnimatorPlayer['nodePoses']> | null {
    return this.animatorPlayers.get(entityId)?.player.nodePoses(names) ?? null;
  }

  /**
   * The settle surface: a config-invalid block resolves the structured failure; a realized block resolves when
   * every prepare has settled. Never rejects.
   */
  settled(): Promise<ModelsSettledResult> {
    if (this.realization !== null) return this.realization.settled();
    if (this.configError !== null) return Promise.resolve({ ok: false as const, code: this.configError.code, message: this.configError.message });
    // `models` present but no realization or config error (disposed before the realization attached).
    return Promise.resolve({ ok: false as const, code: 'adapter_disposed', message: 'the adapter carries no live model realization' });
  }

  disposePlayers(): void {
    for (const rec of this.animatorPlayers.values()) rec.player.dispose();
    this.animatorPlayers.clear();
  }

  /**
   * Cancel every in-flight prepare, dispose the attached instances (cloned materials + controllers + instances)
   * and the store (a late completion is discarded and released, never applied).
   */
  dispose(): void {
    if (this.realization === null) return;
    try {
      this.realization.dispose();
    } catch {
      /* best effort */
    }
    this.realization = null;
    this.lastFrameNow = null;
  }
}
