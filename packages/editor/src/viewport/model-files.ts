/**
 * The editor's model files outside the Scene view's placements: a file's
 * prepared resource (its pieces, bounds, `_COL` colliders and instances for
 * thumbnails), its node names, and the asset browser's and Animator
 * window's preview instance.
 *
 * The Scene view's placements are the scene adapter's (Play's realization):
 * both read the same parsed files, held in the Scene view's resource manager
 * under the same keys, so a file is read and parsed once whoever asks.
 *
 * The renderer never receives the authoring token and never fetches: the
 * injected resolver is the editor's authenticated byte read. A newer version
 * of an asset (a reimport) is a new file; a late completion of a superseded
 * load is discarded.
 *
 * Browser-only (three.js).
 */

import * as THREE from 'three';
import {
  createVisualResourceStore,
  injectedResolver,
  type PreparedVisualResource,
  type AssetPreviewController,
  type AssetVersionDescriptor,
  type VisualClipInfo,
  type VisualResourceStore,
  textureHolds,
  type TextureHolds,
} from '@thirdlight/three-adapter';
import { createGltfLoaderPort } from '@thirdlight/three-adapter/gltf-loader';
import { assetVersionKey, createResourceManager, readModelRig, rigNodeNames, type LoadedResource, type ResourceManager } from '@thirdlight/runtime';

export type VisualDescriptor = AssetVersionDescriptor;

export interface ModelFilesOptions {
  /** The authenticated byte read (the editor's only byte path). */
  resolve: (descriptor: VisualDescriptor) => Promise<Uint8Array>;
  /** The current immutable version facts for an assetId, or null when unknown. */
  descriptorFor: (assetId: string) => VisualDescriptor | null;
  /** Read an asset's version facts when the editor has not read them yet (then `descriptorFor` has them). */
  ensureDescriptor?: (assetId: string) => Promise<void>;
  /** Called when a preview instance was attached (the view draws again). */
  onChanged?: () => void;
  /** Called when the set of load failures changes (the editor shows them in Problems). */
  onFailuresChanged?: (failures: ReadonlyMap<string, { code: string; message: string }>) => void;
  /**
   * The Scene view's resource manager (the scene adapter's placements hold
   * their files there too). Absent: a manager of its own.
   */
  resources?: ResourceManager;
  /** A texture asset, decoded (the images a model's file had extracted are drawn from these). */
  loadTexture?: (assetId: string) => Promise<THREE.Texture | null>;
  /** An asset's extracted images (image index → texture assetId), or null. */
  assetTexturesFor?: (assetId: string) => Readonly<Record<string, string>> | null;
}

/** Names each instance's holders apart in a shared resource manager. */
let modelFilesSerial = 0;

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

/** The model files the editor reads for its panels, and at most one preview instance. */
export class ModelFiles {
  private readonly options: ModelFilesOptions;
  private readonly store: VisualResourceStore = createVisualResourceStore();
  // Draco/Basis decoder files are served next to the editor page (dist/editor/decoders/).
  private readonly loader = createGltfLoaderPort({ decoderBase: './decoders/' });
  private readonly loading = new Set<string>();
  /** Where the parsed files are held (`model`, keyed `<assetId>@<version>`). */
  private readonly resources: ResourceManager;
  /** The texture assets models' extracted images are drawn from, held per file. */
  private readonly imageHolds: TextureHolds | null;
  private readonly tag: string;
  private querySerial = 0;
  private preview: AssetPreviewSession | null = null;
  private previewSequence = 0;
  private disposed = false;

  /** The bounded, explained load failures (never silent). */
  readonly failures = new Map<string, { code: string; message: string }>();

  constructor(options: ModelFilesOptions) {
    this.options = options;
    this.resources = options.resources ?? createResourceManager({ schedule: (run) => setTimeout(run, 0) });
    this.imageHolds = options.loadTexture !== undefined ? textureHolds(this.resources, options.loadTexture) : null;
    modelFilesSerial += 1;
    this.tag = `files${modelFilesSerial}`;
  }

  private static keyOf(assetId: string, version: number): string {
    return assetVersionKey(assetId, version);
  }

  /** Hold an asset version's parsed file for `holder` (loaded the first time); null when it failed. */
  private hold(descriptor: VisualDescriptor, holder: string): Promise<PreparedVisualResource | null> {
    return this.resources
      .acquire<PreparedVisualResource>('model', ModelFiles.keyOf(descriptor.assetId, descriptor.version), `${this.tag}/${holder}`, () => this.loadFile(descriptor))
      .catch(() => null);
  }

  private letGo(descriptorKey: string, holder: string): void {
    this.resources.release('model', descriptorKey, `${this.tag}/${holder}`);
  }

  /** The resource manager's load of one file: the store's cancellable load; a failure is reported and counted. */
  private loadFile(descriptor: VisualDescriptor): Promise<LoadedResource<PreparedVisualResource>> {
    const assetId = descriptor.assetId;
    this.loading.add(assetId);
    const source = injectedResolver(descriptor, () => this.options.resolve(descriptor));
    // The file's extracted images are texture assets, held while the file is.
    const map = this.options.assetTexturesFor?.(assetId) ?? null;
    const holds = this.imageHolds;
    const imageHolder = `model:${assetVersionKey(assetId, descriptor.version)}`;
    const images = map !== null && holds !== null ? { map, load: (id: string) => holds.get(id, imageHolder) } : undefined;
    const handle = this.store.load(source, { loader: this.loader, ...(images !== undefined ? { images } : {}) });
    return handle.result.then((result) => {
      this.loading.delete(assetId);
      if (!result.ok) {
        holds?.releaseHolder(imageHolder);
        if (!this.disposed) {
          this.failures.set(assetId, { code: result.error.code, message: result.error.message });
          this.options.onFailuresChanged?.(this.failures);
        }
        throw new Error(result.error.message);
      }
      if (this.failures.delete(assetId)) this.options.onFailuresChanged?.(this.failures);
      return {
        value: result.resource,
        ...result.resource.residentBytes(),
        free: (r) => {
          this.store.release(r);
          holds?.releaseHolder(imageHolder);
        },
      };
    });
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
      this.letGo(ModelFiles.keyOf(descriptor.assetId, descriptor.version), holder);
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

  /**
   * Aggregate resource ownership over every file this instance ever loaded
   * (allocations/releases/outstanding). Used by the Node tests to
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
    parent: THREE.Object3D,
  ): Promise<{ ok: true; session: AssetPreviewSession } | { ok: false; code: string; message: string }> {
    // The preview holds its file through the resource manager like every other
    // user of it (an object, a clip or piece query), so a read of the same file
    // started meanwhile joins this load instead of superseding it. A superseded
    // preview lets go of its hold once its load settles.
    const sequence = ++this.previewSequence;
    this.preview?.dispose();
    this.preview = null;
    const key = ModelFiles.keyOf(descriptor.assetId, descriptor.version);
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
    this.store.dispose();
    if (this.options.resources === undefined) this.resources.dispose();
  }
}
