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
  buildInstanceSet,
  createVisualResourceStore,
  injectedResolver,
  type BuiltInstanceSet,
  type CreateInstanceOptions,
  type PreparedVisualResource,
  type AssetPreviewController,
  type AssetVersionDescriptor,
  type ModelInstance,
  type VisualClipInfo,
  type VisualResourceHandle,
  type VisualResourceStore,
  type VertexColorMode,
  type MaterialLibrary,
  type MaterialOverridesLike,
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
  /** Phase 12 (c): read an instance-set buffer by digest (absent: instance sets stay empty). */
  resolveBuffer?: (digest: string) => Promise<Float32Array>;
  /** How an asset's COLOR_0 is used (default: shader data). */
  vertexColorsFor?: (assetId: string) => VertexColorMode;
  /** Phase 9.4: project materials, and an asset's default material mapping. */
  materialLibrary?: MaterialLibrary;
  assetMaterialsFor?: (assetId: string) => Readonly<Record<string, string>> | null;
}

interface LiveInstance {
  instance: ModelInstance;
  holder: THREE.Object3D;
  /** What the instance was built from (`assetId@version:piece:vertexColors`). */
  key: string;
  /** The material mapping in use (JSON) and how to undo it. */
  materialsKey: string;
  undoMaterials: (() => void) | null;
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
  /** The instance's loaded clips (the Animator window's live preview poses them). */
  animationClips: readonly THREE.AnimationClip[];
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
  // Draco/Basis decoder files are served next to the editor page (dist/editor/decoders/).
  private readonly loader = createGltfLoaderPort({ decoderBase: './decoders/' });
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
  /** Phase 12 (c): prepared resources by assetId (instance sets draw from them). */
  private readonly resources = new Map<string, { version: number; resource: PreparedVisualResource }>();
  /** Phase 12 (c): realized instance sets by entity id. */
  private readonly sets = new Map<string, { key: string; template: ModelInstance; built: BuiltInstanceSet; undoMaterials: (() => void) | null }>();
  private readonly buffers = new Map<string, Float32Array>();
  private readonly bufferLoads = new Set<string>();
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
      const assetId = e.assetId ?? e.instances?.assetId;
      if (!assetId) continue;
      if (e.instances !== undefined) this.ensureBuffer(e.instances.buffer);
      else wanted.add(e.id);
      const descriptor = this.options.descriptorFor(assetId);
      if (descriptor === null) continue; // no immutable version facts yet
      const current = this.store.current(assetId);
      const live = this.live.get(e.id);
      const upToDate = current !== null && current.descriptor.version === descriptor.version;
      const failure = this.failed.get(assetId);
      const exhausted =
        failure !== undefined &&
        failure.version === descriptor.version &&
        failure.attempts >= FAILED_LOAD_RETRY_LIMIT;
      if (!upToDate && !this.loading.has(assetId) && !exhausted) {
        this.loadAsset(assetId, descriptor);
      }
      // A changed piece or vertex-colour mode rebuilds the instance from the loaded resource.
      const res = this.resources.get(assetId);
      const wantKey = res !== undefined ? this.keyFor(e, res.version) : '';
      if (e.instances === undefined && res !== undefined && res.version === descriptor.version && live?.key !== wantKey && this.failedKeys.get(e.id) !== wantKey) {
        this.attach(e.id, res.resource.createInstance(this.instanceOptions(e)), this.keyFor(e, res.version));
      }
      if (live && this.options.parentFor === undefined) this.applyTransform(live.holder, e);
      const liveNow = this.live.get(e.id);
      if (liveNow !== undefined) this.syncMaterials(liveNow, e);
    }
    for (const [entityId, live] of [...this.live]) {
      if (wanted.has(entityId)) continue;
      this.detach(entityId);
    }
    this.syncSets();
  }

  /** The object's material mapping: the asset's default overlaid by the object's own. */
  private mappingFor(e: ProjectedEntity): Record<string, string> | null {
    const assetId = e.assetId ?? e.instances?.assetId;
    const base = assetId !== undefined ? this.options.assetMaterialsFor?.(assetId) ?? null : null;
    if (base === null && e.materials === undefined) return null;
    return { ...(base ?? {}), ...(e.materials ?? {}) };
  }

  private syncMaterials(live: LiveInstance, e: ProjectedEntity): void {
    const lib = this.options.materialLibrary;
    const mapping = this.mappingFor(e);
    // Phase 18.3: with the object's values for its graph materials' public parameters.
    const overrides = materialOverridesOf(e);
    const key = mapping === null ? '' : JSON.stringify([mapping, overrides]);
    if (live.materialsKey === key) return;
    live.undoMaterials?.();
    live.undoMaterials = lib !== undefined && mapping !== null ? lib.apply(live.holder, mapping, overrides) : null;
    live.materialsKey = key;
  }

  private instanceOptions(e: ProjectedEntity): CreateInstanceOptions {
    const assetId = e.assetId ?? e.instances?.assetId ?? '';
    const piece = e.instances?.piece ?? e.piece;
    return { ...(piece !== undefined ? { piece } : {}), vertexColors: this.options.vertexColorsFor?.(assetId) ?? 'data' };
  }

  private keyFor(e: ProjectedEntity, version: number): string {
    const o = this.instanceOptions(e);
    return `${e.assetId ?? e.instances?.assetId ?? ''}@${version}:${o.piece ?? ''}:${o.vertexColors ?? 'data'}`;
  }

  /**
   * The loaded resource of an asset's current version (loading it if needed):
   * its pieces, bounds and `_COL` colliders, and instances for thumbnails.
   */
  async prepared(assetId: string): Promise<PreparedVisualResource | null> {
    const descriptor = this.options.descriptorFor(assetId);
    if (descriptor === null || this.disposed) return null;
    const have = this.resources.get(assetId);
    if (have !== undefined && have.version === descriptor.version) return have.resource;
    if (!this.loading.has(assetId)) this.loadAsset(assetId, descriptor);
    return new Promise((resolve) => {
      const list = this.waiters.get(assetId) ?? [];
      list.push(resolve);
      this.waiters.set(assetId, list);
    });
  }

  private readonly waiters = new Map<string, ((r: PreparedVisualResource | null) => void)[]>();
  /** The instance key an entity last failed to build with (not retried until it changes). */
  private readonly failedKeys = new Map<string, string>();

  private settleWaiters(assetId: string, resource: PreparedVisualResource | null): void {
    const list = this.waiters.get(assetId);
    if (list === undefined) return;
    this.waiters.delete(assetId);
    for (const w of list) w(resource);
  }

  /** Phase 12 (c): fetch an instance buffer once (then draw the sets that use it). */
  private ensureBuffer(digest: string): void {
    const resolve = this.options.resolveBuffer;
    if (resolve === undefined || this.buffers.has(digest) || this.bufferLoads.has(digest)) return;
    this.bufferLoads.add(digest);
    void resolve(digest).then(
      (floats) => {
        this.bufferLoads.delete(digest);
        if (this.disposed) return;
        this.buffers.set(digest, floats);
        this.syncSets();
      },
      (e: unknown) => {
        this.bufferLoads.delete(digest);
        this.failures.set(digest, { code: 'instance_buffer_unavailable', message: e instanceof Error ? e.message : String(e) });
        this.options.onFailuresChanged?.(this.failures);
      },
    );
  }

  /** Phase 12 (c): one set of instanced meshes per instance-set entity whose model and buffer are here. */
  private syncSets(): void {
    const wanted = new Set<string>();
    for (const e of this.entities) {
      const ref = e.instances;
      if (ref === undefined) continue;
      wanted.add(e.id);
      const res = this.resources.get(ref.assetId);
      const floats = this.buffers.get(ref.buffer);
      const mapping = this.mappingFor(e);
      const key = `${this.keyFor(e, res?.version ?? 0)}:${ref.buffer}:${ref.count}:${mapping === null ? '' : JSON.stringify([mapping, materialOverridesOf(e)])}`;
      const current = this.sets.get(e.id);
      if (current !== undefined && current.key === key) continue;
      if (res === undefined || floats === undefined) continue;
      this.detachSet(e.id);
      const created = res.resource.createInstance(this.instanceOptions(e));
      if (!created.ok) continue;
      const built = buildInstanceSet(created.instance, floats, ref.count, `instances:${e.id}`);
      (built.group as { entityId?: string }).entityId = e.id;
      for (const m of built.meshes) (m as { entityId?: string }).entityId = e.id;
      const parent = this.options.parentFor?.(e.id) ?? null;
      (parent ?? this.scene).add(built.group);
      if (parent === null) this.applyTransform(built.group, e);
      const lib = this.options.materialLibrary;
      const undoMaterials = lib !== undefined && mapping !== null ? lib.apply(built.group, mapping, materialOverridesOf(e)) : null;
      this.sets.set(e.id, { key, template: created.instance, built, undoMaterials });
      this.options.onChanged?.();
    }
    for (const id of [...this.sets.keys()]) if (!wanted.has(id)) this.detachSet(id);
    for (const digest of [...this.buffers.keys()]) {
      if (!this.entities.some((e) => e.instances?.buffer === digest)) this.buffers.delete(digest);
    }
  }

  /** Phase 15.2: the drawn copies of an instance set (picking one copy). */
  instanceSetMeshes(entityId: string): readonly THREE.InstancedMesh[] {
    return this.sets.get(entityId)?.built.meshes ?? [];
  }

  /** Phase 15.2: a loaded instance buffer (the copies' transforms), if here. */
  instanceBuffer(digest: string): Float32Array | undefined {
    return this.buffers.get(digest);
  }

  /** Phase 15.2: preview one copy at a transform while it is dragged (the stored buffer is untouched). */
  previewCopy(entityId: string, index: number, transform: readonly number[]): void {
    this.sets.get(entityId)?.built.setCopy(index, transform);
    this.options.onChanged?.();
  }

  private detachSet(entityId: string): void {
    const set = this.sets.get(entityId);
    if (set === undefined) return;
    set.undoMaterials?.();
    set.built.dispose();
    set.template.dispose();
    this.sets.delete(entityId);
    this.options.onChanged?.();
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
        this.settleWaiters(assetId, null);
        return;
      }
      if (this.failures.delete(assetId)) this.options.onFailuresChanged?.(this.failures);
      this.failed.delete(assetId);
      this.resources.set(assetId, { version: descriptor.version, resource: result.resource });
      for (const e of this.entities) {
        if (e.assetId !== assetId) continue;
        this.attach(e.id, result.resource.createInstance(this.instanceOptions(e)), this.keyFor(e, descriptor.version));
      }
      this.syncSets();
      this.settleWaiters(assetId, result.resource);
    });
  }

  private attach(entityId: string, created: CreateInstanceResult, key: string): void {
    if (!created.ok) {
      this.detach(entityId);
      this.failedKeys.set(entityId, key);
      this.failures.set(entityId, { code: created.error.code, message: created.error.message });
      this.options.onFailuresChanged?.(this.failures);
      return;
    }
    this.failedKeys.delete(entityId);
    if (this.failures.delete(entityId)) this.options.onFailuresChanged?.(this.failures);
    this.detach(entityId);
    const holder = created.instance.root;
    holder.name = entityId;
    (holder as { entityId?: string }).entityId = entityId;
    const parent = this.options.parentFor?.(entityId) ?? null;
    (parent ?? this.scene).add(holder);
    const live: LiveInstance = { instance: created.instance, holder, key, materialsKey: '', undoMaterials: null };
    this.live.set(entityId, live);
    const ent = this.entities.find((x) => x.id === entityId);
    if (ent !== undefined) this.syncMaterials(live, ent);
    const e = this.entities.find((x) => x.id === entityId);
    if (e && parent === null) this.applyTransform(holder, e);
    this.options.onChanged?.();
  }

  private detach(entityId: string): void {
    const live = this.live.get(entityId);
    if (!live) return;
    live.undoMaterials?.();
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
        animationClips: created.instance.animationClips(),
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
    for (const id of [...this.waiters.keys()]) this.settleWaiters(id, null);
    this.clearPreview();
    for (const entityId of [...this.live.keys()]) this.detach(entityId);
    for (const entityId of [...this.sets.keys()]) this.detachSet(entityId);
    this.store.dispose();
  }
}

/** Phase 18.3: an entity's `materialParams` component (overrides of its graph materials' public parameters). */
export function materialOverridesOf(e: { components: Readonly<Record<string, unknown>> }): MaterialOverridesLike | null {
  const v = e.components['materialParams'];
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as MaterialOverridesLike) : null;
}
