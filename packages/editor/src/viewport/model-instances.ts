/**
 * Viewport model realization (packet 27) — the editor-side consumer of the
 * packet-26 shared GLB path.
 *
 * One resource-owner path is shared by placements and by asset preview:
 * `@thirdlight/three-adapter`'s visual resource store (an injected async byte
 * resolver, cancellable prepared resources with stale-completion discarding,
 * whole-GLB model instances with a preserved internal hierarchy) plus the
 * pinned `three@0.186.0` GLTFLoader port from the `./gltf-loader` subpath.
 *
 * The renderer never receives the authoring token and never fetches: the
 * injected resolver is the editor's authenticated byte read (sessions.md
 * §16.1). Reimport is handled by the store: a newer version of an asset
 * supersedes the older one without mixing versions, and a late completion of
 * the superseded load is discarded. Nothing here mutates the projection or the
 * backend — the projection is the only source of entity IDs and transforms.
 *
 * Browser-only (three.js + WebGL). All pixel/WebGL behavior is UNVERIFIED in
 * this container (packet-37 manual procedure).
 */

import * as THREE from 'three';
import {
  createVisualResourceStore,
  injectedResolver,
  type AssetPreviewController,
  type AssetVersionDescriptor,
  type ModelInstance,
  type VisualClipInfo,
  type VisualResourceHandle,
  type VisualResourceStore,
} from '@thirdlight/three-adapter';
import { createGltfLoaderPort } from '@thirdlight/three-adapter/gltf-loader';
import type { ProjectedEntity } from '../session/projection';

export type VisualDescriptor = AssetVersionDescriptor;

export interface ModelInstancesOptions {
  /** The authenticated byte read (the editor's only byte path). */
  resolve: (descriptor: VisualDescriptor) => Promise<Uint8Array>;
  /** The current immutable version facts for an assetId, or null when unknown. */
  descriptorFor: (assetId: string) => VisualDescriptor | null;
  /** Called whenever an instance is attached/detached (the viewport re-renders). */
  onChanged?: () => void;
  /**
   * The entity's scene-graph node. When given, the instance attaches under it
   * with an identity transform (the node carries the entity transform and
   * hierarchy); otherwise it attaches to the scene with the entity transform.
   */
  parentFor?: (entityId: string) => THREE.Object3D | null;
  /** Called when the set of realization failures changes (the editor shows them in Problems). */
  onFailuresChanged?: (failures: ReadonlyMap<string, { code: string; message: string }>) => void;
}

interface LiveInstance {
  instance: ModelInstance;
  holder: THREE.Object3D;
}

/** Bounded failed-load guard: attempts per `(assetId, version)` before backing off (GG-8). */
const FAILED_LOAD_RETRY_LIMIT = 2;

/** One asset preview session (a temporary instance + its local controller). */
export interface AssetPreviewSession {
  /** The previewed instance's root object. */
  root: THREE.Object3D;
  assetId: string;
  descriptor: VisualDescriptor;
  clips: readonly VisualClipInfo[];
  controller: AssetPreviewController;
  dispose(): void;
}

type CreateInstanceResult =
  | { readonly ok: true; readonly instance: ModelInstance }
  | { readonly ok: false; readonly error: { code: string; message: string } };

/**
 * Owns every model Object3D the viewport shows for placements, plus at most one
 * preview instance.
 */
export class ModelInstances {
  private readonly scene: THREE.Scene;
  private readonly options: ModelInstancesOptions;
  private readonly store: VisualResourceStore = createVisualResourceStore();
  private readonly loader = createGltfLoaderPort();
  private readonly live = new Map<string, LiveInstance>();
  private readonly loading = new Set<string>();
  /**
   * Bounded failed-load guard (GG-8): at most `FAILED_LOAD_RETRY_LIMIT`
   * attempts per `(assetId, version)`; a projection update never re-issues a
   * load for a version that already exhausted its attempts (a reimport bumps
   * the version and clears the guard).
   */
  private readonly failed = new Map<string, { version: number; attempts: number }>();
  private entities: readonly ProjectedEntity[] = [];
  private preview: AssetPreviewSession | null = null;
  private previewSequence = 0;
  private previewHandle: VisualResourceHandle | null = null;
  private disposed = false;

  /** The bounded, explained realization failures (never silent). */
  readonly failures = new Map<string, { code: string; message: string }>();

  constructor(scene: THREE.Scene, options: ModelInstancesOptions) {
    this.scene = scene;
    this.options = options;
  }

  /**
   * Reconcile the scene with the projection's model entities: create, update or
   * remove one instance per `assetId` reference. Entity IDs and transforms are
   * the projection's; a reimport changes only the resolved version.
   */
  sync(entities: readonly ProjectedEntity[]): void {
    if (this.disposed) return;
    this.entities = entities;
    const wanted = new Set<string>();
    for (const e of entities) {
      if (!e.assetId) continue;
      wanted.add(e.id);
      const descriptor = this.options.descriptorFor(e.assetId);
      if (descriptor === null) continue; // no immutable version facts yet
      const current = this.store.current(e.assetId);
      const live = this.live.get(e.id);
      const upToDate = current !== null && current.descriptor.version === descriptor.version;
      const failure = this.failed.get(e.assetId);
      const exhausted =
        failure !== undefined &&
        failure.version === descriptor.version &&
        failure.attempts >= FAILED_LOAD_RETRY_LIMIT;
      if (!upToDate && !this.loading.has(e.assetId) && !exhausted) {
        this.loadAsset(e.assetId, descriptor);
      }
      if (live && this.options.parentFor === undefined) this.applyTransform(live.holder, e);
    }
    for (const [entityId, live] of [...this.live]) {
      if (wanted.has(entityId)) continue;
      this.detach(entityId);
    }
  }

  private loadAsset(assetId: string, descriptor: VisualDescriptor): void {
    this.loading.add(assetId);
    const source = injectedResolver(descriptor, () => this.options.resolve(descriptor));
    const handle = this.store.load(source, { loader: this.loader });
    void handle.result.then((result) => {
      this.loading.delete(assetId);
      if (this.disposed) return;
      if (!result.ok) {
        this.failures.set(assetId, { code: result.error.code, message: result.error.message });
        this.options.onFailuresChanged?.(this.failures);
        const prior = this.failed.get(assetId);
        const attempts = prior !== undefined && prior.version === descriptor.version ? prior.attempts + 1 : 1;
        this.failed.set(assetId, { version: descriptor.version, attempts });
        return;
      }
      if (this.failures.delete(assetId)) this.options.onFailuresChanged?.(this.failures);
      this.failed.delete(assetId);
      for (const e of this.entities) {
        if (e.assetId !== assetId) continue;
        this.attach(e.id, result.resource.createInstance());
      }
    });
  }

  private attach(entityId: string, created: CreateInstanceResult): void {
    if (!created.ok) {
      this.failures.set(entityId, { code: created.error.code, message: created.error.message });
      this.options.onFailuresChanged?.(this.failures);
      return;
    }
    this.detach(entityId);
    const holder = created.instance.root;
    holder.name = entityId;
    (holder as { entityId?: string }).entityId = entityId;
    const parent = this.options.parentFor?.(entityId) ?? null;
    (parent ?? this.scene).add(holder);
    this.live.set(entityId, { instance: created.instance, holder });
    const e = this.entities.find((x) => x.id === entityId);
    if (e && parent === null) this.applyTransform(holder, e);
    this.options.onChanged?.();
  }

  private detach(entityId: string): void {
    const live = this.live.get(entityId);
    if (!live) return;
    live.instance.dispose();
    live.holder.parent?.remove(live.holder);
    this.live.delete(entityId);
    this.options.onChanged?.();
  }

  private applyTransform(holder: THREE.Object3D, e: ProjectedEntity): void {
    holder.position.set(e.position[0] ?? 0, e.position[1] ?? 0, e.position[2] ?? 0);
    holder.quaternion.set(e.rotation[0] ?? 0, e.rotation[1] ?? 0, e.rotation[2] ?? 0, e.rotation[3] ?? 1);
    holder.scale.set(e.scale[0] ?? 1, e.scale[1] ?? 1, e.scale[2] ?? 1);
  }

  /** The live Object3D for an entity (for the gizmo / picking), or null. */
  instanceFor(entityId: string): THREE.Object3D | null {
    return this.live.get(entityId)?.holder ?? null;
  }

  /**
   * Aggregate resource ownership over every resource this viewport ever
   * realized (allocations/releases/outstanding). Used by the Node tests to
   * prove a superseded preview's late result is released, never leaked.
   */
  ownership(): ReturnType<VisualResourceStore['ownership']> {
    return this.store.ownership();
  }

  /**
   * Realize one asset for local preview (play/pause/scrub). Only one preview
   * session exists at a time; starting another disposes the previous one.
   */
  previewAsset(
    descriptor: VisualDescriptor,
    /** Where the preview instance attaches (the preview stage's scene). */
    parent: THREE.Object3D = this.scene,
  ): Promise<{ ok: true; session: AssetPreviewSession } | { ok: false; code: string; message: string }> {
    // A superseded preview's late completion must be discarded AND disposed
    // (GG-4): the sequence token below makes the stale branch release anything
    // the late load produced instead of overwriting the live preview.
    const sequence = ++this.previewSequence;
    this.previewHandle?.cancel();
    this.previewHandle = null;
    this.preview?.dispose();
    this.preview = null;
    const source = injectedResolver(descriptor, () => this.options.resolve(descriptor));
    const handle = this.store.load(source, { loader: this.loader });
    this.previewHandle = handle;
    return handle.result.then((result) => {
      if (sequence !== this.previewSequence) {
        if (result.ok) result.resource.dispose();
        return {
          ok: false as const,
          code: 'asset_load_stale',
          message: 'the preview was superseded by a newer request; the stale result was discarded and disposed',
        };
      }
      this.previewHandle = null;
      if (!result.ok) return { ok: false as const, code: result.error.code, message: result.error.message };
      const created = result.resource.createInstance();
      if (!created.ok) return { ok: false as const, code: created.error.code, message: created.error.message };
      const controller = created.instance.createPreviewController();
      if (!controller.ok) {
        created.instance.dispose();
        return { ok: false as const, code: controller.error.code, message: controller.error.message };
      }
      const holder = created.instance.root;
      parent.add(holder);
      const session: AssetPreviewSession = {
        root: holder,
        assetId: descriptor.assetId,
        descriptor,
        clips: result.resource.clips,
        controller: controller.controller,
        dispose: () => {
          controller.controller.dispose();
          created.instance.dispose();
          holder.parent?.remove(holder);
        },
      };
      this.preview = session;
      this.options.onChanged?.();
      return { ok: true as const, session };
    });
  }

  /** Advance the preview clock (the host owns the frame loop). */
  updatePreview(deltaSeconds: number): void {
    this.preview?.controller.update(deltaSeconds);
  }

  /** The active preview session, if any. */
  previewSession(): AssetPreviewSession | null {
    return this.preview;
  }

  /** Hide the preview instance without touching placements. */
  clearPreview(): void {
    this.previewSequence += 1;
    this.previewHandle?.cancel();
    this.previewHandle = null;
    this.preview?.dispose();
    this.preview = null;
  }

  dispose(): void {
    this.disposed = true;
    this.clearPreview();
    for (const entityId of [...this.live.keys()]) this.detach(entityId);
    this.store.dispose();
  }
}
