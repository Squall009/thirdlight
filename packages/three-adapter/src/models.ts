/**
 * Scene realization of `model` entities (the delivered rendering,
 * delivery.md; presentation.md).
 *
 * The `models` block is the adapter's injected attach surface: the
 * wrapper-read-and-digest-verified bytes (via `resolveBytes`), the resolved
 * model-asset rows and the committed per-`modelAnimation`-entity mappings.
 * This module builds on the shared GLB realization path (`visual.ts`: the
 * `createVisualResourceStore` resource owner, the cancellable
 * `prepareVisualResource` loads, the `ModelInstance` handles, the ownership
 * ledger) and the `AnimationRoleController`:
 *
 *   - every `model` entity gets its prepared `ModelInstance` root attached
 *     as a CHILD of the entity's existing holder Object3D; the
 *     runtime's interpolated transform moves the holder (the adapter's
 *     transform sync), the model's internal node transforms are
 *     holder-relative;
 *   - per-instance material independence: each attached instance
 *     draws with CLONED material instances, released by the instance
 *     disposal path (the shared `PreparedVisualResource` is never touched).
 *     The placements of a realization share one clone per
 *     resource material (counted; marked shared, so a per-instance look —
 *     a look override — copies it first), so equal pieces can
 *     be drawn instanced;
 *   - one `AnimationRoleController` per `modelAnimation` entity with a
 *     prepared instance — independent mixers/actions, no shared
 *     clock; the view provider returns the committed `playerMotion` for
 *     the player's own animated model and the constant neutral motion for
 *     every non-player animated entity (delivery.md /
 *     presentation.md rule 7);
 *   - one host-driven update per rendered frame: the adapter
 *     `renderFrame` advances every live controller once with the real
 *     frame delta clamped to `[0, 0.25]` (no fast-forward, no second
 *     loop);
 *   - refcounted resources: a parsed file is held in the resource manager
 *     by the entities that show it (and the scenes being prepared), freed
 *     when the last holder went and the step's scene changes settled; the
 *     LAST live `ModelInstance` of a freed file releases the shared
 *     `LoadedGlb` exactly once;
 *   - stale-load cancellation: disposal cancels every in-flight
 *     prepare; a late completion after cancellation is discarded and
 *     released (never applied, never counted as a success).
 *
 * The module never fetches, never holds a token/URL, never re-validates
 * the (runtime-validated) scene, and never throws across the module edge
 * (result objects only). Its two closed-set codes are
 * `models_config_invalid` (fail-fast block validation) and
 * `models_asset_unresolved` (a `model` entity whose `assetId` resolves to
 * no `assets` row — the defensive residual: a plain group + one bounded
 * diagnostic, the run proceeds).
 */
import * as THREE from 'three';
import { assetVersionKey, createResourceManager, instanceDensityOf, type InstanceDensity, type LoadedResource, type ModelLodSettings, type ResourceManager } from '@thirdlight/runtime';
import {
  adapterError,
  type AdapterError,
} from './errors';
import {
  trackRoleController,
  untrackRoleController,
  type AssetVersionDescriptor,
  type CreateInstanceOptions,
  type GlbLoaderPort,
  type ModelInstance,
  type PreparedVisualResource,
  type VisualResourceHandle,
  type VisualResourceStore,
  createVisualResourceStore,
} from './visual';
import { buildInstanceSet, INSTANCE_CHUNK_METERS, type BuiltInstanceSet, type InstanceSetStats } from './instancing';
import type { LodTuning } from './lod-switch';
import type { MaterialLibrary, MaterialOverridesLike } from './material-library';
import { releaseEmissiveLooks, SHARED_MATERIAL_KEY } from './node-materials';
import { textureHolds } from './texture-holds';
import {
  createAnimationRoleController,
  type AnimationRoleController,
  type AnimationRoleView,
  type AnimationRolesInput,
} from './animation';

/** The committed role mapping of one `modelAnimation` entity
 * (presentation.md — the adapter-local structural copy of
 * `ModelAnimationRoles`: exactly the `idle`/`run`/`airborne` bindings the
 * controller's stage 3 / stage 5–6 re-check validates). */
export type ModelAnimationRoles = AnimationRolesInput;

/** One resolved model-asset row of the `models` block (delivery.md
 * The manifest `assets` row facts, additive; the wrapper has
 * already read the bytes and re-hashed them against `sourceDigest`). */
export interface SceneAdapterModelAsset {
  readonly assetId: string;
  readonly version: number;
  /** 64 lowercase hex (the manifest row's digest). */
  readonly sourceDigest: string;
  /** COLOR_0 multiplies the albedo (absent = shader data). */
  readonly vertexColors?: 'tint';
  /** The asset's default material mapping. */
  readonly materials?: Readonly<Record<string, string>>;
  /** An animation-only file whose clips play on this model asset's rig. */
  readonly clipsFor?: string;
  /** The file's images extracted into texture assets (image index → texture assetId). */
  readonly textures?: Readonly<Record<string, string>>;
  /** The model's LOD group settings (switch points, cull size; absent: the defaults). */
  readonly lod?: ModelLodSettings;
}

/** One committed `modelAnimation` entity mapping. */
export interface SceneAdapterModelAnimation {
  /** An entity carrying `components.modelAnimation`. */
  readonly entityId: string;
  readonly roles: ModelAnimationRoles;
  /** The (assetId, version) the mapping is owned by. */
  readonly version: number;
}

/** The adapter's injected model surface (delivery.md;
 * `SceneAdapterOptions.models`). */
export interface SceneAdapterModels {
  /** The resolved model assets for this snapshot (manifest `assets` rows,
   *  kind "model", ascending assetId then version — the manifest order). */
  readonly assets: readonly SceneAdapterModelAsset[];
  /** One entry per `modelAnimation` entity (manifest `media.animation`,
   *  ascending entityId). Empty ⇒ no selectors. */
  readonly animation: readonly SceneAdapterModelAnimation[];
  /** Resolves one (assetId, version) to the wrapper-verified bytes.
   *  Must resolve only manifest-declared rows; anything else rejects.
   *  Synchronous in effect after the wrapper's read phase (no second
   *  fetch); the Promise shape matches AssetByteSource. */
  readonly resolveBytes: (assetId: string, version: number) => Promise<ArrayBuffer>;
  /**
   * Resolves an instance-set buffer (SHA-256 digest) to the
   * wrapper-verified bytes (`count × 40`). Absent: instance sets stay empty.
   */
  readonly resolveBuffer?: (digest: string) => Promise<ArrayBuffer>;
  /** The idle/run/airborne blend time (the project's `animation_crossfade_s`; absent: 0.2 s). */
  readonly crossfadeSeconds?: number;
  /** The project's instance-set chunk size (m, `instance_chunk_m`; absent: INSTANCE_CHUNK_METERS). */
  readonly instanceChunkSize?: number;
  /**
   * A model row `assets` does not hold, from rows the page has read since
   * (a build whose catalog is read as scenes load): undefined when not read.
   */
  readonly rowOf?: (assetId: string) => SceneAdapterModelAsset | undefined;
  /** The same, reading what it takes to find the row (undefined: not a model of this build). */
  readonly findRow?: (assetId: string) => Promise<SceneAdapterModelAsset | undefined>;
  /**
   * Rows can change while the scene is drawn (an editing host: a reimport
   * publishes a new version): `rowOf` is asked first every time, so an entity
   * realized again after a reimport shows the new version.
   */
  readonly liveRows?: boolean;
  /** An instance set was built with this many chunks (the editor's Inspector shows it). */
  readonly onInstanceSetBuilt?: (entityId: string, chunks: number) => void;
  /**
   * A texture asset's decoded texture (streamed when it streams), for the
   * images a model's file had extracted. Absent: those draw their stand-ins.
   */
  readonly loadTexture?: (assetId: string) => Promise<THREE.Texture | null>;
}

/** The bounded `models` diagnostics block (delivery.md —
 * counters only: no paths, tokens, asset IDs or byte lengths). */
export interface SceneAdapterModelsDiagnostics {
  /** Prepared resources (ready + pending + failed). */
  readonly assets: number;
  /** Live `ModelInstance`s (attached, not disposed). */
  readonly instances: number;
  /** In-flight prepares. */
  readonly pending: number;
  /** Live role controllers. */
  readonly animations: number;
  /** Hard-failed prepares (delivery.md). */
  readonly failed: number;
}

/** The settle result (delivery.md: the wrapper posts
 * `tl.ready`/`tl.error` when the prepares have settled). */
export type ModelsSettledResult =
  | {
      readonly ok: true;
      readonly assets: number;
      readonly instances: number;
      readonly animations: number;
      /** `model` entities whose `assetId` resolved to no `assets` row
       * (each carried one bounded `models_asset_unresolved` diagnostic;
       * the run proceeds). */
      readonly unresolved: number;
    }
  | {
      readonly ok: false;
      /** The first hard-failure code (the closed adapter set; the wrapper
       * maps it to the `"assets"` phase + `tl.error`). */
      readonly code: string;
      readonly message: string;
    };

/** One attached model instance and everything the adapter added around it
 * (the cloned materials + the role controller). */
interface AttachedModel {
  readonly entityId: string;
  readonly instance: ModelInstance;
  /** The cloned per-instance materials (released by `disposeAttached`). */
  readonly clonedMaterials: THREE.Material[];
  /** The live role controller, or `null` (absent `modelAnimation`, or the
   *  stage 5–6 re-check failed — the model renders statically). */
  controller: AnimationRoleController | null;
  /** `true` once the stage 5–6 re-check failed (one bounded diagnostic;
   *  the code is recorded in `diagnosticCode`). */
  roleUnresolved: boolean;
  diagnosticCode: string | null;
  disposed: boolean;
  /** Restores the file's materials. */
  undoMaterials?: (() => void) | null;
}

/** The context the adapter hands the realization (all owned by the
 * adapter; the module stores no global state). */
export interface ModelsRealizationContext {
  /** The snapshot's scene `schemaVersion` (the adapter reads it from the
   * runtime-validated snapshot — the fail-fast check). */
  readonly schemaVersion: number;
  /** The models block (already structurally present). */
  readonly models: SceneAdapterModels;
  /** The injected loader port (the wrapper-built `createGltfLoaderPort`
   * from the `./gltf-loader` subpath — the root stays loader-free).
   *  Absent ⇒ the fail-fast `models_config_invalid`. */
  readonly loader: GlbLoaderPort | undefined;
  /** The snapshot's `model` entities: `entityId` → `assetId`
   * (`components.model.asset.assetId`). */
  readonly modelEntities: ReadonlyMap<string, string>;
  /** The snapshot's `modelAnimation` entities: `entityId` →
   * `{ assetId, version }` (`components.modelAnimation`). */
  readonly modelAnimationEntities: ReadonlyMap<string, { readonly assetId: string; readonly version: number }>;
  /** The snapshot's instance-set entities (`components.instances`). */
  readonly instanceEntities?: ReadonlyMap<string, InstanceSetRef>;
  /** `model` entities that show one piece of their file: `entityId` → piece name. */
  readonly modelPieces?: ReadonlyMap<string, string>;
  /** Project materials, and an entity's own material mapping. */
  readonly materialLibrary?: MaterialLibrary | null;
  readonly entityMaterials?: (entityId: string) => Readonly<Record<string, string>> | null;
  /** An entity's values for its graph materials' public parameters (`materialParams`). */
  readonly entityMaterialParams?: (entityId: string) => MaterialOverridesLike | null;
  /** More entities may arrive later (a scene catalog). */
  readonly allowAbsent?: boolean;
  /** Where the parsed files are held (the page's resource manager); absent: a manager of the realization's own. */
  readonly resources?: ResourceManager;
  /** A model instance (or an instance set) is attached to its entity (lightmaps and shadow flags go on here). */
  readonly onAttached?: (entityId: string, root: THREE.Object3D) => void;
  /** The entity holders (the adapter's `objects` map entries); `null` when
   * the entity has no holder (defensive: the entity is skipped). */
  readonly holderFor: (entityId: string) => THREE.Object3D | null;
  /** The committed view accessor for one entity (the adapter builds it
   * from `runtime.getGameView()`: the player's own animated model gets the
   * committed `playerMotion`, every non-player animated entity gets the
   * constant neutral motion — delivery.md). `null` when the
   * runtime has no committed view (pre-commit: the controller idles). */
  readonly viewFor: (entityId: string) => AnimationRoleView | null;
  /** The project's LOD bias and hysteresis, read by every instance set's per-copy picks (absent: the defaults). */
  readonly lodTuning?: LodTuning;
}

/** The live realization state (owned and disposed by the adapter). */
export interface ModelsRealization {
  /** Advance every live role controller by `deltaSeconds` (already
   * clamped to `[0, 0.25]` by the caller). Returns `true` on success. */
  update(deltaSeconds: number): boolean;
  /** The counters block (the `diagnostics` `models` field). */
  counters(): SceneAdapterModelsDiagnostics;
  /** Resolves when every prepare has settled (all ready, or the first hard
   *  failure, or the adapter disposed). Never rejects. */
  settled(): Promise<ModelsSettledResult>;
  /**
   * Realize the model / instance-set entities of a loaded
   * scene (their holders exist). Assets load on first use.
   */
  addEntities(entities: {
    readonly models: ReadonlyMap<string, string>;
    readonly pieces?: ReadonlyMap<string, string>;
    readonly animations: ReadonlyMap<string, { readonly assetId: string; readonly version: number }>;
    readonly instances: ReadonlyMap<string, InstanceSetRef>;
  }): void;
  /**
   * Release the models of unloaded entities; an asset no
   * entity uses any more is disposed (its GPU data freed).
   */
  removeEntities(entityIds: ReadonlySet<string>): void;
  /**
   * Prepare model assets and instance-set buffers ahead of the
   * entities that will use them (a scene about to load): they are read,
   * parsed and kept until `release` (entities attached meanwhile keep them
   * on). `ready` resolves once each has loaded or failed; never rejects.
   */
  hold?(assetIds: Iterable<string>, bufferDigests: Iterable<string>): { readonly ready: Promise<void>; release(): void };
  /** The entity's attached model instance (its asset id and root), or null. */
  instanceOf(entityId: string): { assetId: string; instance: ModelInstance } | null;
  /**
   * Put an attached model's (or instance set's) materials on again from its
   * mapping now (a material swap); returns its root, or null when nothing is
   * attached for it.
   */
  reapplyMaterials(entityId: string): THREE.Object3D | null;
  /**
   * A model instance a block look is built from (one per asset and
   * piece, kept while the realization exists) — null while the asset loads
   * (`onReady` runs once when it is ready) or when it is not a model row.
   */
  blockInstance?(assetId: string, piece: string | undefined, onReady: () => void): ModelInstance | null;
  /**
   * The clips of `clipAssetId` for a model of `rigAssetId`: its
   * own clips, or an animation-only asset's marked "clips for" that rig
   * (loaded on first ask; null until it is ready, or when the asset is
   * neither).
   */
  clipsOf(clipAssetId: string, rigAssetId: string, entityId?: string): readonly THREE.AnimationClip[] | null;
  /** An entity's built instance set (its chunks map a picked instance back to a copy), or null. */
  instanceSet(entityId: string): BuiltInstanceSet | null;
  /** Every built instance set's copies by what they draw now, summed (diagnostics). */
  instanceStats(): InstanceSetStats;
  /** A decoded instance buffer (the copies' transforms), when loaded. */
  instanceBuffer(digest: string): Float32Array | undefined;
  /** The model files that failed to load or build, with why (by asset id). */
  failures(): ReadonlyMap<string, { readonly code: string; readonly message: string }>;
  /** Dispose: cancel in-flight prepares, dispose the attached instances
   * (cloned materials + controllers + instances) and the store.
   *  Idempotent. */
  dispose(): void;
}

/** One instance-set entity (`components.instances`). */
export interface InstanceSetRef {
  readonly assetId: string;
  /** One piece of the model file (absent: the whole file). */
  readonly piece?: string;
  /** SHA-256 of the transform buffer. */
  readonly buffer: string;
  readonly count: number;
  /** The set's own chunk size (m); absent: the project's (`SceneAdapterModels.instanceChunkSize`). */
  readonly chunkSize?: number;
  /** The set's density falloff (its component's, the defaults filled in). */
  readonly density?: InstanceDensity;
}



// ---- block validation (fail-fast) ------------------

/** Validate the `models` block against the snapshot. `null` = valid. */
export function validateModelsBlock(ctx: {
  readonly schemaVersion: number;
  readonly models: SceneAdapterModels;
  readonly hasLoader: boolean;
  readonly modelEntities: ReadonlyMap<string, string>;
  readonly modelAnimationEntities: ReadonlyMap<string, { readonly assetId: string; readonly version: number }>;
  /** Entries may name entities of scenes that are not loaded yet (checked when they load). */
  readonly allowAbsent?: boolean;
}): AdapterError | null {
  if (ctx.schemaVersion !== 3 && ctx.schemaVersion !== 4) {
    return adapterError(
      'models_config_invalid',
      `the models block requires a schemaVersion 3 scene (found ${String(ctx.schemaVersion)}; a models block needs one)`,
    );
  }
  if (!ctx.hasLoader) {
    return adapterError(
      'models_config_invalid',
      'the models block requires an injected loader port (options.modelsLoader; the wrapper builds it from the ./gltf-loader subpath)',
    );
  }
  const m = ctx.models;
  if (typeof m !== 'object' || m === null) {
    return adapterError('models_config_invalid', 'the models block is missing');
  }
  if (typeof m.resolveBytes !== 'function') {
    return adapterError('models_config_invalid', 'the models block carries no resolveBytes function');
  }
  if (!Array.isArray(m.assets)) {
    return adapterError('models_config_invalid', 'the models block carries no assets list');
  }
  if (!Array.isArray(m.animation)) {
    return adapterError('models_config_invalid', 'the models block carries no animation list');
  }
  const seen = new Map<string, SceneAdapterModelAsset>();
  for (const row of m.assets) {
    if (typeof row !== 'object' || row === null) {
      return adapterError('models_config_invalid', 'a models assets row is not an object');
    }
    if (typeof row.assetId !== 'string' || row.assetId.length === 0 || row.assetId.length > 128) {
      return adapterError('models_config_invalid', 'a models assets row carries no valid assetId');
    }
    if (!Number.isInteger(row.version) || row.version < 1 || row.version > 32) {
      return adapterError('models_config_invalid', `models assets row ${row.assetId} carries no valid version`);
    }
    if (typeof row.sourceDigest !== 'string' || !/^[0-9a-f]{64}$/.test(row.sourceDigest)) {
      return adapterError('models_config_invalid', `models assets row ${row.assetId} carries no valid sourceDigest`);
    }
    const previous = seen.get(row.assetId);
    if (previous !== undefined) {
      // The capture dedupes to one row per assetId (the first recorded
      // explicit version wins, CC-44-6); two DIFFERENT versions for one
      // assetId cannot come from a manifest and would break the
      // assetId-keyed store's supersession — fail closed (defensive
      // residual). An exact duplicate row is harmless.
      if (previous.version !== row.version || previous.sourceDigest !== row.sourceDigest) {
        return adapterError(
          'models_config_invalid',
          `the models assets list carries two different versions for assetId ${row.assetId} (a manifest-derived block carries one row per assetId)`,
        );
      }
      continue;
    }
    seen.set(row.assetId, row);
  }
  for (const entry of m.animation) {
    if (typeof entry !== 'object' || entry === null) {
      return adapterError('models_config_invalid', 'a models animation entry is not an object');
    }
    if (typeof entry.entityId !== 'string' || entry.entityId.length === 0) {
      return adapterError('models_config_invalid', 'a models animation entry carries no entityId');
    }
    const entity = ctx.modelAnimationEntities.get(entry.entityId);
    if (entity === undefined && ctx.allowAbsent === true) continue;
    if (entity === undefined) {
      return adapterError(
        'models_config_invalid',
        `the models animation entry names entity ${entry.entityId} without a modelAnimation component (defensive residual; the manifest is closure-validated)`,
      );
    }
    if (!Number.isInteger(entry.version) || entry.version !== entity.version) {
      return adapterError(
        'models_config_invalid',
        `the models animation entry for ${entry.entityId} names version ${String(entry.version)} but the entity's modelAnimation binding is version ${entity.version}`,
      );
    }
    if (seen.get(entity.assetId) === undefined) {
      return adapterError(
        'models_config_invalid',
        `the models animation entry for ${entry.entityId} references assetId ${entity.assetId} with no resolved assets row (defensive residual)`,
      );
    }
  }
  return null;
}

// ---- per-instance material cloning ---------------------------------

/**
 * Give one attached instance its own material instances: every mesh
 * material (single or array) is cloned so a per-instance material change
 * (a look override) never reaches the shared
 * `PreparedVisualResource` or another instance. The clones share the
 * resource's textures (released with the resource, once); the CLONES are
 * owned by the attached instance and released by its disposal path.
 */
function cloneInstanceMaterials(instance: ModelInstance, cloneOf: (m: THREE.Material) => THREE.Material): THREE.Material[] {
  const clones: THREE.Material[] = [];
  const walk = (node: THREE.Object3D): void => {
    const mesh = node as THREE.Mesh;
    if (mesh.isMesh === true) {
      const material = mesh.material;
      if (Array.isArray(material)) {
        mesh.material = material.map((m) => {
          const c = cloneOf(m);
          clones.push(c);
          return c;
        });
      } else if (material instanceof THREE.Material) {
        const c = cloneOf(material);
        clones.push(c);
        mesh.material = c;
      }
    }
    for (const child of node.children) walk(child);
  };
  walk(instance.glbRoot);
  return clones;
}

// ---- the realization -------------------------------------------------------

/** Names each realization's holders apart (several may share one resource manager). */
let realizationSerial = 0;

/** A model file that could not be prepared, with the adapter's code for it. */
class ModelFileError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function createModelsRealization(ctx: ModelsRealizationContext): {
  readonly ok: true;
  readonly realization: ModelsRealization;
} | { readonly ok: false; readonly error: AdapterError } {
  // Fail-fast block validation — before any bytes are read.
  const configError = validateModelsBlock({
    schemaVersion: ctx.schemaVersion,
    models: ctx.models,
    hasLoader: ctx.loader !== undefined,
    modelEntities: ctx.modelEntities,
    modelAnimationEntities: ctx.modelAnimationEntities,
    ...(ctx.allowAbsent === true ? { allowAbsent: true } : {}),
  });
  if (configError !== null) return { ok: false, error: configError };
  const loader = ctx.loader as GlbLoaderPort;

  const store: VisualResourceStore = createVisualResourceStore();
  /** One clone per resource material, shared by the placements (counted). */
  const sharedClones = new Map<THREE.Material, { clone: THREE.Material; refs: number }>();
  const cloneSources = new Map<THREE.Material, THREE.Material>();
  const cloneOf = (m: THREE.Material): THREE.Material => {
    let rec = sharedClones.get(m);
    if (rec === undefined) {
      const clone = m.clone();
      clone.userData[SHARED_MATERIAL_KEY] = true;
      rec = { clone, refs: 0 };
      sharedClones.set(m, rec);
      cloneSources.set(clone, m);
    }
    rec.refs += 1;
    return rec.clone;
  };
  const releaseClone = (clone: THREE.Material): void => {
    const source = cloneSources.get(clone);
    const rec = source === undefined ? undefined : sharedClones.get(source);
    if (rec === undefined || source === undefined) {
      clone.dispose();
      return;
    }
    rec.refs -= 1;
    if (rec.refs > 0) return;
    sharedClones.delete(source);
    cloneSources.delete(clone);
    clone.dispose();
  };
  // The entity maps grow and shrink with scene loads.
  const modelEntities = new Map(ctx.modelEntities);
  const modelAnimationEntities = new Map(ctx.modelAnimationEntities);
  const instanceEntities = new Map(ctx.instanceEntities ?? []);
  const modelPieces = new Map(ctx.modelPieces ?? []);
  /** The instance options for an entity: its piece and the asset's vertex-colour mode. */
  /** An entity's material mapping (the asset's default under its own). */
  const mappingFor = (entityId: string, assetId: string): Record<string, string> | null => {
    const base = rowsByAsset.get(assetId)?.materials;
    const own = ctx.entityMaterials?.(entityId) ?? null;
    if (base === undefined && own === null) return null;
    return { ...(base ?? {}), ...(own ?? {}) };
  };
  const applyMaterials = (entityId: string, assetId: string, root: THREE.Object3D): (() => void) | null => {
    const lib = ctx.materialLibrary;
    const mapping = mappingFor(entityId, assetId);
    return lib !== undefined && lib !== null && mapping !== null ? lib.apply(root, mapping, ctx.entityMaterialParams?.(entityId) ?? null) : null;
  };
  const instanceOptions = (assetId: string, piece: string | undefined): CreateInstanceOptions => ({
    ...(piece !== undefined ? { piece } : {}),
    vertexColors: rowsByAsset.get(assetId)?.vertexColors === 'tint' ? 'tint' : 'data',
    ...(rowsByAsset.get(assetId)?.lod !== undefined ? { lod: rowsByAsset.get(assetId)!.lod! } : {}),
  });
  const attached = new Map<string, AttachedModel>(); // entityId → attached model
  const attachedSets = new Map<string, AttachedInstanceSet>(); // entityId → instanced meshes
  const liveControllers = new Set<AnimationRoleController>();
  const pendingHandles = new Map<string, VisualResourceHandle>(); // assetId → handle (the dispose cancel path)
  /**
   * The parsed files live in the resource manager, held by the entities
   * that show them (`entity:<id>`), the scenes being prepared (`hold:<n>`),
   * the block looks (`blocks`) and the animators that play an animation-only
   * file's clips (by entity); the manager frees one when its last holder
   * went and the step's scene changes settled.
   */
  const resources: ResourceManager = ctx.resources ?? createResourceManager({ schedule: (run) => queueMicrotask(run) });
  realizationSerial += 1;
  const tag = `models${realizationSerial}`;
  const entityHolder = (entityId: string): string => `${tag}/entity:${entityId}`;
  const blocksHolder = `${tag}/blocks`;
  /** Every holder name this realization used (released at dispose). */
  const ownHolders = new Set<string>();
  /** Assets this realization asked for (their manager entries may be gone since). */
  const known = new Set<string>();
  /** Assets being prepared for this realization (bytes resolving or the store load running). */
  const loading = new Set<string>();
  /** Model assets block looks use (kept loaded), their instances and the looks waiting for them. */
  const blockInstances = new Map<string, ModelInstance>();
  const blockWaiters = new Map<string, (() => void)[]>();
  /** Instance-set buffers by digest (decoded once, dropped when unused). */
  const buffers = new Map<string, Float32Array>();
  const bufferLoads = new Set<string>();
  /** Assets and buffers held ahead of their entities, and the holds waiting for them. */
  const holds = new Set<{ readonly assets: ReadonlySet<string>; readonly buffers: ReadonlySet<string> }>();
  const holdWaiters = new Set<() => boolean>();
  let holdSerial = 0;
  const notifyHolds = (): void => {
    for (const check of [...holdWaiters]) if (check()) holdWaiters.delete(check);
  };
  const bufferInUse = (digest: string): boolean => {
    for (const r of instanceEntities.values()) if (r.buffer === digest) return true;
    for (const h of holds) if (h.buffers.has(digest)) return true;
    return false;
  };
  // The settle gate: the prepares started at creation (the start scenes).
  // An explicit pending count, decremented INSIDE each completion callback
  // BEFORE `settleIfComplete` — never the handle's `state()`: between a
  // promise's resolution and the `.then` callback (a microtask gap) the
  // state is already non-pending but the attach has not run yet. Later
  // loads (a scene loaded during play) do not gate the settle.
  let pendingCount = 0;
  let initial = true;
  const initialAssets = new Set<string>();
  const failedCodes = new Map<string, string>(); // assetId → first hard code
  const failedMessages = new Map<string, string>(); // assetId → why (for the editor's Problems)
  let disposed = false;

  // --- settle promise -------------------------------------------------------
  let settleResolve: ((r: ModelsSettledResult) => void) | null = null;
  const settledPromise = new Promise<ModelsSettledResult>((resolve) => {
    settleResolve = resolve;
  });
  let settled = false;
  function settle(result: ModelsSettledResult): void {
    if (settled) return;
    settled = true;
    if (settleResolve !== null) settleResolve(result);
  }
  function unresolvedCount(): number {
    let n = 0;
    for (const assetId of modelEntities.values()) if (!rowsByAsset.has(assetId)) n += 1;
    return n;
  }
  /** Assets this realization holds that are loaded or loading. */
  function heldAssetCount(): number {
    let n = 0;
    for (const assetId of [...known]) {
      const row = rowsByAsset.get(assetId);
      if (row !== undefined && resources.has(kindOf(row), keyOf(row))) n += 1;
      else known.delete(assetId);
    }
    return n;
  }
  function settleIfComplete(): void {
    if (settled || disposed) return;
    if (pendingCount > 0) return; // a completion has not attached yet
    if (failedCodes.size > 0) {
      const first = failedCodes.entries().next().value;
      if (first === undefined) return;
      const [assetId, code] = first;
      settle({
        ok: false,
        code,
        message: `the prepare for asset ${assetId} hard-failed (${code}) — the host mount fails before the play is presented`,
      });
      return;
    }
    settle({
      ok: true,
      assets: heldAssetCount(),
      instances: liveInstanceCount(),
      animations: liveControllers.size,
      unresolved: unresolvedCount(),
    });
  }
  function liveInstanceCount(): number {
    let n = 0;
    for (const a of attached.values()) if (!a.disposed) n += 1;
    return n;
  }

  // One row per assetId (validated above): one load per (assetId, version)
  // through the shared store. The bytes are already re-hashed against
  // `sourceDigest` by the wrapper.
  const givenRows = new Map<string, SceneAdapterModelAsset>();
  for (const row of ctx.models.assets) givenRows.set(row.assetId, row);
  /** A model's row: given at creation, else one the page has read since (kept once found). */
  const rowsByAsset = {
    get(assetId: string): SceneAdapterModelAsset | undefined {
      if (ctx.models.liveRows === true) {
        const live = ctx.models.rowOf?.(assetId);
        if (live !== undefined) return live;
      }
      const hit = givenRows.get(assetId);
      if (hit !== undefined) return hit;
      const found = ctx.models.rowOf?.(assetId);
      if (found !== undefined) givenRows.set(assetId, found);
      return found;
    },
    has(assetId: string): boolean {
      return rowsByAsset.get(assetId) !== undefined;
    },
  };
  /** Rows being found (`findRow`), each asked once at a time. */
  const finding = new Set<string>();
  /** An animation-only file is held as clips; any other as a model. */
  const kindOf = (row: SceneAdapterModelAsset): 'model' | 'clip' => (row.clipsFor !== undefined ? 'clip' : 'model');
  const keyOf = (row: SceneAdapterModelAsset): string => assetVersionKey(row.assetId, row.version);
  /** The parsed file of an asset, when it is loaded. */
  const readyResource = (assetId: string): PreparedVisualResource | undefined => {
    const row = rowsByAsset.get(assetId);
    return row === undefined ? undefined : resources.peek<PreparedVisualResource>(kindOf(row), keyOf(row));
  };

  /** The texture assets models' extracted images are drawn from, held per file. */
  const imageHolds = ctx.models.loadTexture !== undefined ? textureHolds(resources, ctx.models.loadTexture) : null;

  /** The resource manager's load of one file: its verified bytes, then the cancellable store load. */
  const loadFile = (row: SceneAdapterModelAsset) => async (): Promise<LoadedResource<PreparedVisualResource>> => {
    let bytes: ArrayBuffer;
    try {
      bytes = await ctx.models.resolveBytes(row.assetId, row.version);
    } catch (e) {
      throw new ModelFileError('asset_missing', `the models resolveBytes rejected for ${row.assetId} v${row.version}: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
    }
    if (disposed) throw new ModelFileError('asset_load_cancelled', 'the realization was disposed');
    if (bytes.byteLength === 0) throw new ModelFileError('asset_load_cancelled', 'no bytes');
    const descriptor: AssetVersionDescriptor = { assetId: row.assetId, version: row.version, sourceDigest: row.sourceDigest, sourceByteLength: bytes.byteLength };
    // The file's extracted images are texture assets, held while the file is.
    const imageHolder = `model:${keyOf(row)}`;
    const images = row.textures !== undefined && imageHolds !== null ? { map: row.textures, load: (id: string) => imageHolds.get(id, imageHolder) } : undefined;
    const handle = store.load({ kind: 'bytes', descriptor, bytes: new Uint8Array(bytes) }, { loader, ...(images !== undefined ? { images } : {}) });
    pendingHandles.set(row.assetId, handle);
    const res = await handle.result;
    if (pendingHandles.get(row.assetId) === handle) pendingHandles.delete(row.assetId);
    if (res.ok === false) {
      imageHolds?.releaseHolder(imageHolder);
      throw new ModelFileError(res.error.code, res.error.message);
    }
    return {
      value: res.resource,
      ...res.resource.residentBytes(),
      free: (r) => {
        store.release(r);
        imageHolds?.releaseHolder(imageHolder);
      },
    };
  };

  /**
   * Hold an asset for `holder` (loading it the first time) and attach the
   * entities waiting for it once it is ready. `wanted` says whether the holder
   * still wants it when its row had to be found first.
   */
  function holdAsset(assetId: string, holder: string, wanted: () => boolean): void {
    if (disposed) return;
    const row = rowsByAsset.get(assetId);
    if (row === undefined) {
      // A model no row read so far names (a spawned copy's, say): found, then held.
      const find = ctx.models.findRow;
      if (find === undefined || finding.has(assetId)) return;
      finding.add(assetId);
      void find(assetId).then(
        (found) => {
          finding.delete(assetId);
          if (found === undefined || disposed) return;
          givenRows.set(assetId, found);
          // Everyone who asked while it was being found.
          for (const [id, a] of modelEntities) if (a === assetId) holdAsset(assetId, entityHolder(id), () => modelEntities.get(id) === assetId);
          for (const [id, r] of instanceEntities) if (r.assetId === assetId) holdAsset(assetId, entityHolder(id), () => instanceEntities.get(id)?.assetId === assetId);
          if (wanted()) holdAsset(assetId, holder, wanted);
        },
        () => finding.delete(assetId),
      );
      return;
    }
    if (!wanted()) return;
    const kind = kindOf(row);
    const key = keyOf(row);
    ownHolders.add(holder);
    known.add(assetId);
    const p = resources.acquire(kind, key, holder, loadFile(row));
    const ready = resources.peek<PreparedVisualResource>(kind, key);
    if (ready !== undefined) {
      attachForAsset(assetId, ready);
      return;
    }
    if (loading.has(assetId)) return;
    loading.add(assetId);
    const gates = initial;
    if (gates) {
      pendingCount += 1;
      initialAssets.add(assetId);
    }
    const done = (): void => {
      loading.delete(assetId);
      if (gates) pendingCount -= 1;
    };
    p.then(
      (resource) => {
        done();
        if (disposed) return;
        // Rows that change (an editing host's reimport): a version that loads clears the failure of one before.
        if (ctx.models.liveRows === true) {
          failedCodes.delete(assetId);
          failedMessages.delete(assetId);
        }
        attachForAsset(assetId, resource);
        // Block looks waiting for this model.
        const waiting = blockWaiters.get(assetId);
        blockWaiters.delete(assetId);
        for (const cb of waiting ?? []) cb();
        settleIfComplete();
        notifyHolds();
      },
      (e: unknown) => {
        done();
        if (disposed) return;
        const code = e instanceof ModelFileError ? e.code : 'asset_corrupt';
        // Cancellation/stale are not errors.
        if (code !== 'asset_load_cancelled' && code !== 'asset_load_stale' && !failedCodes.has(assetId)) {
          failedCodes.set(assetId, code);
          failedMessages.set(assetId, e instanceof Error ? e.message : String(e));
        }
        notifyHolds();
        // The wrapper's resolver rejected for a declared row: a hard assets-phase failure.
        if (code === 'asset_missing') settle({ ok: false, code, message: e instanceof Error ? e.message : String(e) });
        else settleIfComplete();
      },
    );
  }

  function attachForAsset(assetId: string, resource: PreparedVisualResource): void {
    if (disposed) return;
    const row = rowsByAsset.get(assetId);
    if (row === undefined) return;
    for (const [entityId, entityAssetId] of modelEntities) {
      if (entityAssetId !== assetId || attached.has(entityId)) continue;
      const holder = ctx.holderFor(entityId);
      if (holder === null) continue; // defensive: no holder — skip (bounded)
      const created = resource.createInstance(instanceOptions(assetId, modelPieces.get(entityId)));
      if (created.ok === false) {
        // Defensive residual (the loader already validated the hierarchy):
        // count as a hard failure of this entity's realization, keep going.
        if (!failedCodes.has(assetId)) {
          failedCodes.set(assetId, created.error.code);
          failedMessages.set(assetId, created.error.message);
        }
        continue;
      }
      const instance = created.instance;
      const cloned = cloneInstanceMaterials(instance, cloneOf);
      holder.add(instance.root);
      const rec: AttachedModel = {
        entityId,
        instance,
        clonedMaterials: cloned,
        controller: null,
        roleUnresolved: false,
        diagnosticCode: null,
        disposed: false,
      };
      attached.set(entityId, rec);
      rec.undoMaterials = applyMaterials(entityId, assetId, instance.root);
      ctx.onAttached?.(entityId, instance.root);
      // The committed mapping's stage 5–6 re-check (rule 7):
      // a mismatching mapping is the hard `animation_role_unresolved` —
      // the model renders statically at its committed transform, one
      // bounded diagnostic, the run proceeds.
      const anim = modelAnimationEntities.get(entityId);
      if (anim !== undefined && anim.assetId === assetId) {
        const entry = ctx.models.animation.find((a) => a.entityId === entityId);
        if (entry !== undefined && entry.version === anim.version) {
          // Pre-commit (no committed view yet): the constant neutral motion —
          // the accepted pure selector then yields `idle`.
          const controllerRes = createAnimationRoleController(
            instance,
            () => ctx.viewFor(entityId) ?? { stepIndex: 0, playerMotion: { speed: 0, grounded: true } },
            ctx.models.crossfadeSeconds,
          );
          if (controllerRes.ok === true) {
            const setRes = controllerRes.controller.setRoles(entry.roles, entry.version);
            if (setRes.ok === true) {
              rec.controller = controllerRes.controller;
              liveControllers.add(controllerRes.controller);
            } else {
              // Mismatch: the model stays attached, static; the (action-less)
              // controller is released.
              rec.roleUnresolved = true;
              rec.diagnosticCode = setRes.error.code;
              try {
                controllerRes.controller.dispose();
              } catch {
                /* best effort */
              }
            }
          } else {
            rec.roleUnresolved = true;
            rec.diagnosticCode = controllerRes.error.code;
          }
        }
      }
    }
    for (const [entityId, ref] of instanceEntities) {
      if (ref.assetId === assetId) attachInstanceSet(entityId, ref);
    }
  }

  /**
   * One instance set = one instanced mesh per mesh of the
   * model (sharing its geometry and materials), placed by the buffer's
   * transforms times the mesh's own offset inside the model.
   */
  function attachInstanceSet(entityId: string, ref: InstanceSetRef): void {
    if (disposed || attachedSets.has(entityId)) return;
    const resource = readyResource(ref.assetId);
    const floats = buffers.get(ref.buffer);
    const holder = ctx.holderFor(entityId);
    if (resource === undefined || floats === undefined || holder === null) return;
    const created = resource.createInstance(instanceOptions(ref.assetId, ref.piece));
    if (created.ok === false) return;
    const template = created.instance;
    const built = buildInstanceSet(template, floats, ref.count, `instances:${entityId}`, {
      chunkSize: ref.chunkSize ?? ctx.models.instanceChunkSize ?? INSTANCE_CHUNK_METERS,
      density: ref.density ?? instanceDensityOf(undefined),
      ...(ctx.lodTuning !== undefined ? { tuning: ctx.lodTuning } : {}),
    });
    holder.add(built.group);
    attachedSets.set(entityId, { entityId, template, built, undoMaterials: applyMaterials(entityId, ref.assetId, built.group) });
    ctx.onAttached?.(entityId, built.group);
    ctx.models.onInstanceSetBuilt?.(entityId, built.chunks);
  }

  function disposeInstanceSet(set: AttachedInstanceSet): void {
    // The chunks go before their materials may (a material released with its last user takes the
    // chunks' render objects, and with them the way to their instance buffers).
    set.built.dispose(); // the instance matrices (geometry/materials belong to the resource)
    set.undoMaterials?.();
    try {
      set.template.dispose();
    } catch {
      /* best effort */
    }
    attachedSets.delete(set.entityId);
  }

  function ensureBuffer(digest: string): void {
    if (buffers.has(digest) || bufferLoads.has(digest)) return;
    const resolve = ctx.models.resolveBuffer;
    if (resolve === undefined) return;
    bufferLoads.add(digest);
    void resolve(digest).then(
      (bytes) => {
        bufferLoads.delete(digest);
        if (disposed) return;
        if (bufferInUse(digest)) {
          buffers.set(digest, new Float32Array(bytes.slice(0)));
          for (const [entityId, ref] of instanceEntities) if (ref.buffer === digest) attachInstanceSet(entityId, ref);
        }
        notifyHolds();
      },
      () => {
        bufferLoads.delete(digest);
        notifyHolds();
      },
    );
  }

  function disposeAttached(rec: AttachedModel): void {
    if (rec.disposed) return;
    rec.disposed = true;
    // A glow's own material copies go first (the material undo below restores the shared ones).
    releaseEmissiveLooks(rec.instance.root);
    rec.undoMaterials?.();
    if (rec.controller !== null) {
      try {
        rec.controller.dispose();
      } catch {
        /* best effort */
      }
      liveControllers.delete(rec.controller);
      rec.controller = null;
    }
    for (const material of rec.clonedMaterials) {
      try {
        releaseClone(material);
      } catch {
        /* best effort */
      }
    }
    rec.clonedMaterials.length = 0;
    // The instance disposal returns the instance reference to the resource
    // (the refcount rule: the LAST instance of a retired resource releases
    // the LoadedGlb once).
    try {
      rec.instance.dispose();
    } catch {
      /* best effort */
    }
    try {
      rec.instance.root.removeFromParent();
    } catch {
      /* best effort */
    }
    attached.delete(rec.entityId);
  }

  /** Hold the files of these entities (each entity holds its own). */
  function holdEntities(models: Iterable<[string, string]>, sets: Iterable<[string, InstanceSetRef]>): void {
    for (const [id, assetId] of models) holdAsset(assetId, entityHolder(id), () => modelEntities.get(id) === assetId);
    for (const [id, ref] of sets) holdAsset(ref.assetId, entityHolder(id), () => instanceEntities.get(id)?.assetId === ref.assetId);
  }

  // The start scenes' assets (these gate the settle).
  holdEntities(modelEntities, instanceEntities);
  for (const ref of instanceEntities.values()) ensureBuffer(ref.buffer);
  initial = false;

  const realization: ModelsRealization = {
    blockInstance(assetId: string, piece: string | undefined, onReady: () => void): ModelInstance | null {
      if (disposed) return null;
      if (!rowsByAsset.has(assetId)) {
        // A model no row read so far names: found, then the look is asked for again.
        const find = ctx.models.findRow;
        if (find !== undefined && !finding.has(assetId)) {
          finding.add(assetId);
          void find(assetId).then(
            (found) => {
              finding.delete(assetId);
              if (found === undefined || disposed) return;
              givenRows.set(assetId, found);
              onReady();
            },
            () => finding.delete(assetId),
          );
        }
        return null;
      }
      const key = `${assetId}|${piece ?? ''}`;
      const hit = blockInstances.get(key);
      if (hit !== undefined) return hit;
      const resource = readyResource(assetId);
      if (resource === undefined) {
        let list = blockWaiters.get(assetId);
        if (list === undefined) blockWaiters.set(assetId, (list = []));
        list.push(onReady);
        holdAsset(assetId, blocksHolder, () => true);
        return null;
      }
      holdAsset(assetId, blocksHolder, () => true);
      const made = resource.createInstance(instanceOptions(assetId, piece));
      if (!made.ok) return null;
      blockInstances.set(key, made.instance);
      return made.instance;
    },
    reapplyMaterials(entityId: string) {
      const rec = attached.get(entityId);
      if (rec !== undefined && !rec.disposed) {
        const assetId = modelEntities.get(entityId);
        if (assetId === undefined) return null;
        // A new apply of the same root replaces the old one (what stays the same keeps its built material).
        rec.undoMaterials = applyMaterials(entityId, assetId, rec.instance.root);
        return rec.instance.root;
      }
      const set = attachedSets.get(entityId);
      const ref = instanceEntities.get(entityId);
      if (set === undefined || ref === undefined) return null;
      set.undoMaterials = applyMaterials(entityId, ref.assetId, set.built.group);
      return set.built.group;
    },
    instanceOf(entityId: string) {
      const rec = attached.get(entityId);
      if (rec === undefined || rec.disposed) return null;
      const assetId = modelEntities.get(entityId);
      return assetId === undefined ? null : { assetId, instance: rec.instance };
    },
    clipsOf(clipAssetId: string, rigAssetId: string, entityId?: string) {
      if (disposed) return null;
      if (clipAssetId === rigAssetId) {
        const own = readyResource(rigAssetId);
        return own === undefined ? null : own.animationClips();
      }
      if (rowsByAsset.get(clipAssetId)?.clipsFor !== rigAssetId) return null;
      // Held by the animator's entity (released with it), else for the realization's life.
      const holder = entityId !== undefined ? entityHolder(entityId) : `${tag}/clips`;
      const wanted = entityId !== undefined ? () => modelEntities.has(entityId) : () => true;
      // Not a settle gate: the animator plays the base pose until it arrives.
      const wasInitial = initial;
      initial = false;
      holdAsset(clipAssetId, holder, wanted);
      initial = wasInitial;
      return readyResource(clipAssetId)?.animationClips() ?? null;
    },
    instanceSet: (entityId) => attachedSets.get(entityId)?.built ?? null,
    instanceStats: () => {
      let copies = 0;
      let inView = 0;
      let culled = 0;
      let thinned = 0;
      const byLevel: number[] = [];
      for (const set of attachedSets.values()) {
        const st = set.built.stats();
        copies += st.copies;
        inView += st.inView;
        culled += st.culled;
        thinned += st.thinned;
        st.byLevel.forEach((v, l) => (byLevel[l] = (byLevel[l] ?? 0) + v));
      }
      return { copies, inView, byLevel, culled, thinned };
    },
    instanceBuffer: (digest) => buffers.get(digest),
    failures(): ReadonlyMap<string, { readonly code: string; readonly message: string }> {
      const out = new Map<string, { code: string; message: string }>();
      for (const [assetId, code] of failedCodes) out.set(assetId, { code, message: failedMessages.get(assetId) ?? code });
      return out;
    },
    update(deltaSeconds: number): boolean {
      if (disposed) return false;
      for (const controller of [...liveControllers]) {
        const r = controller.update(deltaSeconds);
        if (r.ok === false) {
          // Defensive: detach a failing controller (its instance's disposal
          // path releases it too — idempotent).
          liveControllers.delete(controller);
          const rec = [...attached.values()].find((a) => a.controller === controller);
          if (rec !== undefined) rec.controller = null;
        }
      }
      return true;
    },

    counters(): SceneAdapterModelsDiagnostics {
      let pending = 0;
      for (const handle of pendingHandles.values()) {
        if (handle.state() === 'pending') pending += 1;
      }
      return {
        assets: heldAssetCount(),
        instances: liveInstanceCount(),
        pending,
        animations: liveControllers.size,
        failed: failedCodes.size,
      };
    },

    settled(): Promise<ModelsSettledResult> {
      return settledPromise;
    },

    addEntities(entities): void {
      if (disposed) return;
      for (const [id, assetId] of entities.models) modelEntities.set(id, assetId);
      for (const [id, piece] of entities.pieces ?? []) modelPieces.set(id, piece);
      for (const [id, anim] of entities.animations) modelAnimationEntities.set(id, anim);
      for (const [id, ref] of entities.instances) instanceEntities.set(id, ref);
      holdEntities(entities.models, entities.instances);
      for (const ref of entities.instances.values()) ensureBuffer(ref.buffer);
    },

    removeEntities(entityIds): void {
      if (disposed) return;
      for (const id of entityIds) {
        const rec = attached.get(id);
        if (rec !== undefined) disposeAttached(rec);
        const set = attachedSets.get(id);
        if (set !== undefined) disposeInstanceSet(set);
        modelEntities.delete(id);
        modelAnimationEntities.delete(id);
        instanceEntities.delete(id);
        modelPieces.delete(id);
        // Its file (and an animation-only file its animator played) is let go; freed once no one holds it.
        const holder = entityHolder(id);
        resources.releaseHolder(holder);
        ownHolders.delete(holder);
      }
      for (const digest of [...buffers.keys()]) {
        if (!bufferInUse(digest)) buffers.delete(digest);
      }
    },

    hold(assetIds, bufferDigests) {
      const h = { assets: new Set([...assetIds].filter((a) => rowsByAsset.has(a))), buffers: new Set(bufferDigests) };
      if (disposed) return { ready: Promise.resolve(), release: () => undefined };
      holdSerial += 1;
      const holder = `${tag}/hold:${holdSerial}`;
      let released = false;
      holds.add(h);
      for (const assetId of h.assets) holdAsset(assetId, holder, () => !released);
      for (const digest of h.buffers) ensureBuffer(digest);
      const complete = (): boolean => {
        if (disposed) return true;
        for (const a of h.assets) if (loading.has(a)) return false;
        for (const d of h.buffers) if (bufferLoads.has(d)) return false;
        return true;
      };
      const ready = new Promise<void>((resolve) => {
        const check = (): boolean => {
          if (!complete()) return false;
          resolve();
          return true;
        };
        if (!check()) holdWaiters.add(check);
      });
      return {
        ready,
        release: () => {
          if (released || disposed) return;
          released = true;
          holds.delete(h);
          resources.releaseHolder(holder);
          ownHolders.delete(holder);
          for (const digest of h.buffers) if (!bufferInUse(digest)) buffers.delete(digest);
        },
      };
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      // Cancel every in-flight prepare before releasing; a late
      // completion is discarded and released (never applied).
      for (const set of [...attachedSets.values()]) disposeInstanceSet(set);
      for (const rec of [...attached.values()]) disposeAttached(rec);
      for (const inst of blockInstances.values()) inst.dispose();
      blockInstances.clear();
      blockWaiters.clear();
      for (const holder of ownHolders) resources.releaseHolder(holder);
      ownHolders.clear();
      // What this realization's store parsed goes with it (a manager entry freed later finds it retired).
      try {
        store.dispose();
      } catch {
        /* best effort */
      }
      if (ctx.resources === undefined) resources.dispose();
      buffers.clear();
      liveControllers.clear();
      holds.clear();
      notifyHolds();
      if (!settled) {
        settle({
          ok: false,
          code: 'adapter_disposed',
          message: 'the adapter was disposed before the model prepares settled (the run is torn down; no late completion is applied)',
        });
      }
    },
  };

  // Nothing to prepare at creation: settle now.
  if (initialAssets.size === 0) settleIfComplete();

  return { ok: true, realization };
}

/** One realized instance set. */
interface AttachedInstanceSet {
  readonly entityId: string;
  /** The model instance the meshes' geometry/materials come from (holds the resource reference). */
  readonly template: ModelInstance;
  readonly built: BuiltInstanceSet;
  undoMaterials?: (() => void) | null;
}
