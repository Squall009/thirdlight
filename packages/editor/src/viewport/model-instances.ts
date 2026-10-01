/**
 * Viewport model realization — the editor-side consumer of the
 * shared GLB path.
 *
 * One resource-owner path is shared by placements and by asset preview:
 * `@thirdlight/three-adapter`'s visual resource store (an injected async byte
 * resolver, cancellable prepared resources with stale-completion discarding,
 * whole-GLB model instances with a preserved internal hierarchy) plus the
 * pinned `three` GLTFLoader port from the `./gltf-loader` subpath.
 *
 * The renderer never receives the authoring token and never fetches: the
 * injected resolver is the editor's authenticated byte read.
 * Reimport is handled by the store: a newer version of an asset
 * supersedes the older one without mixing versions, and a late completion of
 * the superseded load is discarded. Nothing here mutates the projection or the
 * backend — the projection is the only source of entity IDs and transforms.
 *
 * Browser-only (three.js + WebGL). All pixel/WebGL behavior is UNVERIFIED in
 * this container.
 */

import * as THREE from 'three';
import {
  buildInstanceSet,
  INSTANCE_CHUNK_METERS,
  disposeObjectTree,
  createVisualResourceStore,
  markBatchable,
  injectedResolver,
  type BuiltInstanceSet,
  type CreateInstanceOptions,
  type PreparedVisualResource,
  type AssetPreviewController,
  type AssetVersionDescriptor,
  type ModelInstance,
  type VisualClipInfo,
  type VisualResourceStore,
  type VertexColorMode,
  type MaterialLibrary,
  type MaterialOverridesLike,
} from '@thirdlight/three-adapter';
import { createGltfLoaderPort } from '@thirdlight/three-adapter/gltf-loader';
import { assetVersionKey, createResourceManager, readModelRig, rigNodeNames, type LoadedResource, type ResourceManager } from '@thirdlight/runtime';
import type { ProjectedEntity } from '../session/projection';

export type VisualDescriptor = AssetVersionDescriptor;

export interface ModelInstancesOptions {
  /** The authenticated byte read (the editor's only byte path). */
  resolve: (descriptor: VisualDescriptor) => Promise<Uint8Array>;
  /** The current immutable version facts for an assetId, or null when unknown. */
  descriptorFor: (assetId: string) => VisualDescriptor | null;
  /** Read an asset's version facts when the editor has not read them yet (then `descriptorFor` has them). */
  ensureDescriptor?: (assetId: string) => Promise<void>;
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
  /** Read an instance-set buffer by digest (absent: instance sets stay empty). */
  resolveBuffer?: (digest: string) => Promise<Float32Array>;
  /** How an asset's COLOR_0 is used (default: shader data). */
  vertexColorsFor?: (assetId: string) => VertexColorMode;
  /** Project materials, and an asset's default material mapping. */
  materialLibrary?: MaterialLibrary;
  assetMaterialsFor?: (assetId: string) => Readonly<Record<string, string>> | null;
  /** The project's instance-set chunk size (m; `instance_chunk_m`, absent: the engine default). */
  instanceChunkSize?: () => number | undefined;
  /**
   * The Scene view's resource manager: each model file is held by the
   * objects that show it and freed when none does (another scene opened).
   * Absent: a manager of its own.
   */
  resources?: ResourceManager;
  /** An instance set was (re)built with this many chunks (the Inspector shows it). */
  onSetBuilt?: (entityId: string, chunks: number) => void;
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

/** Names each view's holders apart in a shared resource manager. */
let modelInstancesSerial = 0;

/** Bounded failed-load guard: attempts per `(assetId, version)` before backing off. */
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
   * Bounded failed-load guard: at most `FAILED_LOAD_RETRY_LIMIT`
   * attempts per `(assetId, version)`; a projection update never re-issues a
   * load for a version that already exhausted its attempts (a reimport bumps
   * the version and clears the guard).
   */
  private readonly failed = new Map<string, { version: number; attempts: number }>();
  private entities: readonly ProjectedEntity[] = [];
  /** Where the parsed files are held (`model`, keyed `<assetId>@<version>`), by the objects that show them. */
  private readonly resources: ResourceManager;
  /** The file each object holds (its key), and this instance's holder names in the manager. */
  private readonly entityKeys = new Map<string, string>();
  private readonly tag: string;
  private querySerial = 0;
  /** Realized instance sets by entity id. */
  private readonly sets = new Map<string, { key: string; template: ModelInstance; built: BuiltInstanceSet; undoMaterials: (() => void) | null }>();
  private readonly buffers = new Map<string, Float32Array>();
  private readonly bufferLoads = new Set<string>();
  private preview: AssetPreviewSession | null = null;
  private previewSequence = 0;
  private disposed = false;

  /** The bounded, explained realization failures (never silent). */
  readonly failures = new Map<string, { code: string; message: string }>();

  constructor(scene: THREE.Scene, options: ModelInstancesOptions) {
    this.scene = scene;
    this.options = options;
    this.resources = options.resources ?? createResourceManager({ schedule: (run) => setTimeout(run, 0) });
    modelInstancesSerial += 1;
    this.tag = `view${modelInstancesSerial}`;
  }

  private static keyOf(assetId: string, version: number): string {
    return assetVersionKey(assetId, version);
  }

  /** The parsed file of an asset version, when it is loaded. */
  private ready(assetId: string, version: number): PreparedVisualResource | undefined {
    return this.resources.peek<PreparedVisualResource>('model', ModelInstances.keyOf(assetId, version));
  }

  /** Hold an asset version's parsed file for `holder` (loaded the first time); null when it failed. */
  private hold(descriptor: VisualDescriptor, holder: string): Promise<PreparedVisualResource | null> {
    return this.resources
      .acquire<PreparedVisualResource>('model', ModelInstances.keyOf(descriptor.assetId, descriptor.version), `${this.tag}/${holder}`, () => this.loadFile(descriptor))
      .catch(() => null);
  }

  private letGo(descriptorKey: string, holder: string): void {
    this.resources.release('model', descriptorKey, `${this.tag}/${holder}`);
  }

  /** An object no longer shows its file (removed, or showing another). */
  private releaseEntity(entityId: string): void {
    const key = this.entityKeys.get(entityId);
    if (key === undefined) return;
    this.entityKeys.delete(entityId);
    this.letGo(key, `entity:${entityId}`);
  }

  /** Hold the file an object shows (its current version); it attaches once loaded. */
  private holdForEntity(e: ProjectedEntity, descriptor: VisualDescriptor): void {
    const key = ModelInstances.keyOf(descriptor.assetId, descriptor.version);
    if (this.entityKeys.get(e.id) === key) return;
    this.releaseEntity(e.id);
    const failure = this.failed.get(descriptor.assetId);
    if (failure !== undefined && failure.version === descriptor.version && failure.attempts >= FAILED_LOAD_RETRY_LIMIT && !this.resources.has('model', key)) return;
    this.entityKeys.set(e.id, key);
    void this.hold(descriptor, `entity:${e.id}`).then((resource) => {
      // A failed load holds nothing: a later sync may try again (within the retry limit).
      if (resource === null && this.entityKeys.get(e.id) === key) this.entityKeys.delete(e.id);
      if (this.disposed || resource === null || this.entityKeys.get(e.id) !== key) return;
      const now = this.entityById(e.id);
      if (now === undefined) return;
      if (now.instances !== undefined) {
        this.syncSets();
        return;
      }
      const wantKey = this.keyFor(now, descriptor.version);
      if (this.live.get(e.id)?.key !== wantKey) this.attach(e.id, resource.createInstance(this.instanceOptions(now)), wantKey);
    });
  }

  /** The resource manager's load of one file: the store's cancellable load; a failure is reported and counted. */
  private loadFile(descriptor: VisualDescriptor): Promise<LoadedResource<PreparedVisualResource>> {
    const assetId = descriptor.assetId;
    this.loading.add(assetId);
    const source = injectedResolver(descriptor, () => this.options.resolve(descriptor));
    const handle = this.store.load(source, { loader: this.loader });
    return handle.result.then((result) => {
      this.loading.delete(assetId);
      if (!result.ok) {
        if (!this.disposed) {
          this.failures.set(assetId, { code: result.error.code, message: result.error.message });
          this.options.onFailuresChanged?.(this.failures);
          const prior = this.failed.get(assetId);
          const attempts = prior !== undefined && prior.version === descriptor.version ? prior.attempts + 1 : 1;
          this.failed.set(assetId, { version: descriptor.version, attempts });
        }
        throw new Error(result.error.message);
      }
      if (this.failures.delete(assetId)) this.options.onFailuresChanged?.(this.failures);
      this.failed.delete(assetId);
      return { value: result.resource, ...result.resource.residentBytes(), free: (r) => this.store.release(r) };
    });
  }

  /**
   * Reconcile the scene with the projection's model entities: create, update or
   * remove one instance per `assetId` reference. Entity IDs and transforms are
   * the projection's; a reimport changes only the resolved version.
   */
  sync(entities: readonly ProjectedEntity[], delta?: { readonly changed: ReadonlySet<string>; readonly removed: ReadonlySet<string> }): void {
    if (this.disposed) return;
    this.entities = entities;
    this.byId = null;
    const wanted = new Set<string>();
    // With a delta only the changed entities are looked at (the rest kept their objects).
    const list: readonly ProjectedEntity[] = delta === undefined ? entities : [...delta.changed].map((id) => this.entityById(id)).filter((e): e is ProjectedEntity => e !== undefined);
    for (const e of list) {
      const assetId = e.assetId ?? e.instances?.assetId;
      if (!assetId || e.instances !== undefined) {
        if (delta !== undefined && this.live.has(e.id)) this.detach(e.id);
      }
      if (!assetId) continue;
      if (e.instances !== undefined) this.ensureBuffer(e.instances.buffer);
      else wanted.add(e.id);
      const descriptor = this.options.descriptorFor(assetId);
      if (descriptor === null) continue; // no immutable version facts yet
      const live = this.live.get(e.id);
      // The object holds its file (loading it once; a reimport's new version replaces the hold).
      this.holdForEntity(e, descriptor);
      // A changed piece or vertex-colour mode rebuilds the instance from the loaded resource.
      const res = this.ready(assetId, descriptor.version);
      const wantKey = this.keyFor(e, descriptor.version);
      if (e.instances === undefined && res !== undefined && live?.key !== wantKey && this.failedKeys.get(e.id) !== wantKey) {
        this.attach(e.id, res.createInstance(this.instanceOptions(e)), wantKey);
      }
      if (live && this.options.parentFor === undefined) this.applyTransform(live.holder, e);
      const liveNow = this.live.get(e.id);
      if (liveNow !== undefined) this.syncMaterials(liveNow, e);
    }
    if (delta === undefined) {
      for (const entityId of [...this.live.keys()]) {
        if (wanted.has(entityId)) continue;
        this.detach(entityId);
      }
    } else for (const id of delta.removed) this.detach(id);
    this.syncSets();
    // Objects gone (or showing no file now) let go of theirs; freed once no object holds it.
    for (const id of [...this.entityKeys.keys()]) {
      const e = this.entityById(id);
      if (e === undefined || (e.assetId ?? e.instances?.assetId) === undefined) this.releaseEntity(id);
    }
  }

  /** The projected entity by id (a map made once per entity list). */
  private byId: Map<string, ProjectedEntity> | null = null;
  private entityById(id: string): ProjectedEntity | undefined {
    if (this.byId === null) this.byId = new Map(this.entities.map((e) => [e.id, e]));
    return this.byId.get(id);
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
    // With the object's values for its graph materials' public parameters.
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
    // Only an asset not read yet waits (a load started later than another of the same file would supersede it).
    if (this.options.descriptorFor(assetId) === null) await this.options.ensureDescriptor?.(assetId);
    const descriptor = this.options.descriptorFor(assetId);
    if (descriptor === null || this.disposed) return null;
    // Held only while it is handed over: the caller uses it now (a thumbnail, its pieces); no
    // object showing it, it is freed after this task.
    this.querySerial += 1;
    const holder = `query:${this.querySerial}`;
    try {
      return await this.hold(descriptor, holder);
    } finally {
      this.letGo(ModelInstances.keyOf(descriptor.assetId, descriptor.version), holder);
    }
  }

  /**
   * The node names of an asset's current version, read from its
   * GLB exactly as the game reads the rig sockets are resolved on (so the
   * Inspector offers the names the game finds). Null when it cannot be read.
   */
  async nodeNames(assetId: string): Promise<string[] | null> {
    if (this.options.descriptorFor(assetId) === null) await this.options.ensureDescriptor?.(assetId);
    const descriptor = this.options.descriptorFor(assetId);
    if (descriptor === null || this.disposed) return null;
    try {
      const bytes = await this.options.resolve(descriptor);
      const r = readModelRig(bytes, assetId, 0);
      return r.ok ? rigNodeNames(r.rig) : null;
    } catch {
      return null;
    }
  }

  /** The instance key an entity last failed to build with (not retried until it changes). */
  private readonly failedKeys = new Map<string, string>();

  /** Fetch an instance buffer once (then draw the sets that use it). */
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

  /** One set of instanced meshes per instance-set entity whose model and buffer are here. */
  private syncSets(): void {
    const wanted = new Set<string>();
    for (const e of this.entities) {
      const ref = e.instances;
      if (ref === undefined) continue;
      wanted.add(e.id);
      const version = this.options.descriptorFor(ref.assetId)?.version;
      const res = version === undefined ? undefined : this.ready(ref.assetId, version);
      const floats = this.buffers.get(ref.buffer);
      const mapping = this.mappingFor(e);
      const chunkSize = ref.chunkSize ?? this.options.instanceChunkSize?.() ?? INSTANCE_CHUNK_METERS;
      const key = `${this.keyFor(e, res !== undefined ? version! : 0)}:${ref.buffer}:${ref.count}:${chunkSize}:${mapping === null ? '' : JSON.stringify([mapping, materialOverridesOf(e)])}`;
      const current = this.sets.get(e.id);
      if (current !== undefined && current.key === key) continue;
      if (res === undefined || floats === undefined) continue;
      this.detachSet(e.id);
      const created = res.createInstance(this.instanceOptions(e));
      if (!created.ok) continue;
      const built = buildInstanceSet(created.instance, floats, ref.count, `instances:${e.id}`, { chunkSize });
      (built.group as { entityId?: string }).entityId = e.id;
      for (const m of built.meshes) (m as { entityId?: string }).entityId = e.id;
      const parent = this.options.parentFor?.(e.id) ?? null;
      (parent ?? this.scene).add(built.group);
      if (parent === null) this.applyTransform(built.group, e);
      const lib = this.options.materialLibrary;
      const undoMaterials = lib !== undefined && mapping !== null ? lib.apply(built.group, mapping, materialOverridesOf(e)) : null;
      this.sets.set(e.id, { key, template: created.instance, built, undoMaterials });
      this.options.onSetBuilt?.(e.id, built.chunks);
      this.options.onChanged?.();
    }
    for (const id of [...this.sets.keys()]) if (!wanted.has(id)) this.detachSet(id);
    for (const digest of [...this.buffers.keys()]) {
      if (!this.entities.some((e) => e.instances?.buffer === digest)) this.buffers.delete(digest);
    }
  }

  /** Rebuild the sets whose chunk size changed (the project's `instance_chunk_m` was edited). */
  refreshSets(): void {
    if (!this.disposed) this.syncSets();
  }

  /** The drawn copies of an instance set (picking one copy). */
  instanceSetMeshes(entityId: string): readonly THREE.Mesh[] {
    return this.sets.get(entityId)?.built.meshes ?? [];
  }

  /** The built instance set (its chunks map a picked instance back to a copy). */
  instanceSet(entityId: string): BuiltInstanceSet | null {
    return this.sets.get(entityId)?.built ?? null;
  }

  /** A loaded instance buffer (the copies' transforms), if here. */
  instanceBuffer(digest: string): Float32Array | undefined {
    return this.buffers.get(digest);
  }

  /** Preview one copy at a transform while it is dragged (the stored buffer is untouched). */
  previewCopy(entityId: string, index: number, transform: readonly number[]): void {
    this.sets.get(entityId)?.built.setCopy(index, transform);
    this.options.onChanged?.();
  }

  private detachSet(entityId: string): void {
    const set = this.sets.get(entityId);
    if (set === undefined) return;
    // The chunks first (a material released with its last user would take their render objects).
    set.built.dispose();
    set.undoMaterials?.();
    set.template.dispose();
    this.sets.delete(entityId);
    this.options.onChanged?.();
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
    // Placements of the same piece and material are drawn instanced (the Scene view's batcher).
    markBatchable(holder);
    const parent = this.options.parentFor?.(entityId) ?? null;
    (parent ?? this.scene).add(holder);
    const live: LiveInstance = { instance: created.instance, holder, key, materialsKey: '', undoMaterials: null };
    this.live.set(entityId, live);
    const e = this.entityById(entityId);
    if (e !== undefined) this.syncMaterials(live, e);
    if (e && parent === null) this.applyTransform(holder, e);
    this.options.onChanged?.();
  }

  private detach(entityId: string): void {
    const live = this.live.get(entityId);
    if (!live) return;
    live.undoMaterials?.();
    live.instance.dispose();
    live.holder.parent?.remove(live.holder);
    // The holder's own render objects (the instance released its nodes).
    disposeObjectTree(live.holder);
    this.live.delete(entityId);
    this.failedKeys.delete(entityId);
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
    // The preview holds its file through the resource manager like every other
    // user of it (an object, a clip or piece query), so a read of the same file
    // started meanwhile joins this load instead of superseding it. A superseded
    // preview lets go of its hold once its load settles.
    const sequence = ++this.previewSequence;
    this.preview?.dispose();
    this.preview = null;
    const key = ModelInstances.keyOf(descriptor.assetId, descriptor.version);
    const holder = `preview:${sequence}`;
    return this.hold(descriptor, holder).then((resource) => {
      if (sequence !== this.previewSequence || this.disposed) {
        this.letGo(key, holder);
        return {
          ok: false as const,
          code: 'asset_load_stale',
          message: 'the preview was superseded by a newer request; the stale result was discarded and released',
        };
      }
      if (resource === null) {
        const failure = this.failures.get(descriptor.assetId);
        return { ok: false as const, code: failure?.code ?? 'asset_load_failed', message: failure?.message ?? 'the model could not be read' };
      }
      const created = resource.createInstance();
      if (!created.ok) {
        this.letGo(key, holder);
        return { ok: false as const, code: created.error.code, message: created.error.message };
      }
      const controller = created.instance.createPreviewController();
      if (!controller.ok) {
        created.instance.dispose();
        this.letGo(key, holder);
        return { ok: false as const, code: controller.error.code, message: controller.error.message };
      }
      const root = created.instance.root;
      parent.add(root);
      const session: AssetPreviewSession = {
        root,
        assetId: descriptor.assetId,
        descriptor,
        clips: resource.clips,
        animationClips: created.instance.animationClips(),
        controller: controller.controller,
        dispose: () => {
          controller.controller.dispose();
          created.instance.dispose();
          root.parent?.remove(root);
          this.letGo(key, holder);
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
    this.preview?.dispose();
    this.preview = null;
  }

  dispose(): void {
    this.disposed = true;
    this.clearPreview();
    for (const entityId of [...this.live.keys()]) this.detach(entityId);
    for (const entityId of [...this.sets.keys()]) this.detachSet(entityId);
    for (const entityId of [...this.entityKeys.keys()]) this.releaseEntity(entityId);
    this.store.dispose();
    if (this.options.resources === undefined) this.resources.dispose();
  }
}

/** An entity's `materialParams` component (overrides of its graph materials' public parameters). */
export function materialOverridesOf(e: { components: Readonly<Record<string, unknown>> }): MaterialOverridesLike | null {
  const v = e.components['materialParams'];
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as MaterialOverridesLike) : null;
}
