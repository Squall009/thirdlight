/**
 * Packet 69 — scene realization of `model` entities (the M4 delivered
 * rendering, delivery.md (M4) §2; presentation.md §41.9 row, C64-4).
 *
 * The `models` block is the adapter's injected attach surface: the
 * wrapper-read-and-digest-verified bytes (via `resolveBytes`), the resolved
 * model-asset rows and the committed per-`modelAnimation`-entity mappings.
 * This module reuses the packet-26 substrate UNCHANGED as the
 * implementation substrate (the `createVisualResourceStore` resource
 * owner, the cancellable `prepareVisualResource` loads, the
 * `ModelInstance` handles, the ownership ledger) and the packet-53
 * `AnimationRoleController`:
 *
 *   - every `model` entity gets its prepared `ModelInstance` root attached
 *     as a CHILD of the entity's existing holder Object3D (§2.3); the
 *     runtime's interpolated transform moves the holder (the adapter's
 *     transform sync), the model's internal node transforms are
 *     holder-relative;
 *   - per-instance material independence (§2.3): each attached instance
 *     owns CLONED material instances, released by the instance disposal
 *     path (the shared `PreparedVisualResource` and other instances are
 *     never touched);
 *   - one `AnimationRoleController` per `modelAnimation` entity with a
 *     prepared instance (§2.4) — independent mixers/actions, no shared
 *     clock; the view provider returns the committed `playerMotion` for
 *     the player's own animated model and the constant neutral motion for
 *     every non-player animated entity (delivery.md (M4) §2.4 /
 *     presentation.md §41.3.6 rule 7 clarification);
 *   - one host-driven update per rendered frame (§2.4): the adapter
 *     `renderFrame` advances every live controller once with the real
 *     frame delta clamped to `[0, 0.25]` (no fast-forward, no second
 *     loop);
 *   - refcounted resources (§2.5): the LAST live `ModelInstance` of an
 *     asset releases the shared `LoadedGlb` exactly once;
 *   - stale-load cancellation (§2.6): disposal cancels every in-flight
 *     prepare; a late completion after cancellation is discarded and
 *     released (never applied, never counted as a success).
 *
 * The module never fetches, never holds a token/URL, never re-validates
 * the (runtime-validated) scene, and never throws across the module edge
 * (result objects only). The two new closed-set codes (C64-4) are
 * `models_config_invalid` (fail-fast block validation) and
 * `models_asset_unresolved` (a `model` entity whose `assetId` resolves to
 * no `assets` row — the defensive residual: a plain group + one bounded
 * diagnostic, the run proceeds).
 */
import * as THREE from 'three';
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
import { buildInstanceSet, type BuiltInstanceSet } from './instancing';
import type { MaterialLibrary } from './material-library';
import {
  createAnimationRoleController,
  type AnimationRoleController,
  type AnimationRoleView,
  type AnimationRolesInput,
} from './animation';

/** The committed role mapping of one `modelAnimation` entity
 * (presentation.md §41.3.1 — the adapter-local structural copy of
 * `ModelAnimationRoles`: exactly the `idle`/`run`/`airborne` bindings the
 * controller's stage 3 / stage 5–6 re-check validates). */
export type ModelAnimationRoles = AnimationRolesInput;

/** One resolved model-asset row of the `models` block (delivery.md (M4)
 * §2.2 — the manifest `assets` row facts, additive; the wrapper has
 * already read the bytes and re-hashed them against `sourceDigest`). */
export interface SceneAdapterModelAsset {
  readonly assetId: string;
  readonly version: number;
  /** 64 lowercase hex (the manifest row's digest). */
  readonly sourceDigest: string;
  /** COLOR_0 multiplies the albedo (absent = shader data). */
  readonly vertexColors?: 'tint';
  /** Phase 9.4: the asset's default material mapping. */
  readonly materials?: Readonly<Record<string, string>>;
  /** Phase 14.6: an animation-only file whose clips play on this model asset's rig. */
  readonly clipsFor?: string;
}

/** One committed `modelAnimation` entity mapping (delivery.md (M4) §2.2). */
export interface SceneAdapterModelAnimation {
  /** An entity carrying `components.modelAnimation`. */
  readonly entityId: string;
  readonly roles: ModelAnimationRoles;
  /** The (assetId, version) the mapping is owned by. */
  readonly version: number;
}

/** The adapter's injected model surface (delivery.md (M4) §2.2;
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
   * Phase 12 (c): resolves an instance-set buffer (SHA-256 digest) to the
   * wrapper-verified bytes (`count × 40`). Absent: instance sets stay empty.
   */
  readonly resolveBuffer?: (digest: string) => Promise<ArrayBuffer>;
  /** Phase 15.3: the idle/run/airborne blend time (the project's `animation_crossfade_s`; absent: 0.2 s). */
  readonly crossfadeSeconds?: number;
}

/** The bounded `models` diagnostics block (delivery.md (M4) §2.5 —
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
  /** Hard-failed prepares (delivery.md (M4) §2.7 L2–L5). */
  readonly failed: number;
}

/** The settle result (delivery.md (M4) §2.8 step 10: the wrapper posts
 * `tl.ready`/`tl.error` when the prepares have settled). */
export type ModelsSettledResult =
  | {
      readonly ok: true;
      readonly assets: number;
      readonly instances: number;
      readonly animations: number;
      /** `model` entities whose `assetId` resolved to no `assets` row
       * (each carried one bounded `models_asset_unresolved` diagnostic;
       * the run proceeds — §2.3). */
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
   *  stage 5–6 re-check failed — the model renders statically, L6). */
  controller: AnimationRoleController | null;
  /** `true` once the stage 5–6 re-check failed (one bounded diagnostic;
   *  the code is recorded in `diagnosticCode`). */
  roleUnresolved: boolean;
  diagnosticCode: string | null;
  disposed: boolean;
  /** Phase 9.4: restores the file's materials. */
  undoMaterials?: (() => void) | null;
}

/** The context the adapter hands the realization (all owned by the
 * adapter; the module stores no global state). */
export interface ModelsRealizationContext {
  /** The snapshot's scene `schemaVersion` (the adapter reads it from the
   * runtime-validated snapshot — the §2.2 fail-fast check). */
  readonly schemaVersion: number;
  /** The models block (already structurally present). */
  readonly models: SceneAdapterModels;
  /** The injected loader port (the wrapper-built `createGltfLoaderPort`
   * from the `./gltf-loader` subpath — the root stays loader-free).
   *  Absent ⇒ the §2.2 fail-fast `models_config_invalid`. */
  readonly loader: GlbLoaderPort | undefined;
  /** The snapshot's `model` entities: `entityId` → `assetId`
   * (`components.model.asset.assetId`). */
  readonly modelEntities: ReadonlyMap<string, string>;
  /** The snapshot's `modelAnimation` entities: `entityId` →
   * `{ assetId, version }` (`components.modelAnimation`). */
  readonly modelAnimationEntities: ReadonlyMap<string, { readonly assetId: string; readonly version: number }>;
  /** Phase 12 (c): the snapshot's instance-set entities (`components.instances`). */
  readonly instanceEntities?: ReadonlyMap<string, InstanceSetRef>;
  /** `model` entities that show one piece of their file: `entityId` → piece name. */
  readonly modelPieces?: ReadonlyMap<string, string>;
  /** Phase 9.4: project materials, and an entity's own material mapping. */
  readonly materialLibrary?: MaterialLibrary | null;
  readonly entityMaterials?: (entityId: string) => Readonly<Record<string, string>> | null;
  /** Phase 12 (c): more entities may arrive later (a scene catalog). */
  readonly allowAbsent?: boolean;
  /** Phase 9.6: a model instance is attached to its entity (lightmaps go on here). */
  readonly onAttached?: (entityId: string, root: THREE.Object3D) => void;
  /** The entity holders (the adapter's `objects` map entries); `null` when
   * the entity has no holder (defensive: the entity is skipped). */
  readonly holderFor: (entityId: string) => THREE.Object3D | null;
  /** The committed view accessor for one entity (the adapter builds it
   * from `runtime.getGameView()`: the player's own animated model gets the
   * committed `playerMotion`, every non-player animated entity gets the
   * constant neutral motion — delivery.md (M4) §2.4). `null` when the
   * runtime has no committed view (pre-commit: the controller idles). */
  readonly viewFor: (entityId: string) => AnimationRoleView | null;
}

/** The live realization state (owned and disposed by the adapter). */
export interface ModelsRealization {
  /** Advance every live role controller by `deltaSeconds` (already
   * clamped to `[0, 0.25]` by the caller). Returns `true` on success. */
  update(deltaSeconds: number): boolean;
  /** The §2.5 counters block (the `diagnostics` `models` field). */
  counters(): SceneAdapterModelsDiagnostics;
  /** Resolves when every prepare has settled (all ready, or the first hard
   *  failure, or the adapter disposed). Never rejects. */
  settled(): Promise<ModelsSettledResult>;
  /**
   * Phase 12 (c): realize the model / instance-set entities of a loaded
   * scene (their holders exist). Assets load on first use.
   */
  addEntities(entities: {
    readonly models: ReadonlyMap<string, string>;
    readonly pieces?: ReadonlyMap<string, string>;
    readonly animations: ReadonlyMap<string, { readonly assetId: string; readonly version: number }>;
    readonly instances: ReadonlyMap<string, InstanceSetRef>;
  }): void;
  /**
   * Phase 12 (c): release the models of unloaded entities; an asset no
   * entity uses any more is disposed (its GPU data freed).
   */
  removeEntities(entityIds: ReadonlySet<string>): void;
  /** Phase 9.7: the entity's attached model instance (its asset id and root), or null. */
  instanceOf(entityId: string): { assetId: string; instance: ModelInstance } | null;
  /**
   * Phase 14.6: the clips of `clipAssetId` for a model of `rigAssetId`: its
   * own clips, or an animation-only asset's marked "clips for" that rig
   * (loaded on first ask; null until it is ready, or when the asset is
   * neither).
   */
  clipsOf(clipAssetId: string, rigAssetId: string): readonly THREE.AnimationClip[] | null;
  /** Dispose: cancel in-flight prepares, dispose the attached instances
   * (cloned materials + controllers + instances) and the store.
   *  Idempotent. */
  dispose(): void;
}

/** Phase 12 (c): one instance-set entity (`components.instances`). */
export interface InstanceSetRef {
  readonly assetId: string;
  /** One piece of the model file (absent: the whole file). */
  readonly piece?: string;
  /** SHA-256 of the transform buffer. */
  readonly buffer: string;
  readonly count: number;
}



// ---- block validation (fail-fast; delivery.md (M4) §2.2) ------------------

/** Validate the `models` block against the snapshot. `null` = valid. */
export function validateModelsBlock(ctx: {
  readonly schemaVersion: number;
  readonly models: SceneAdapterModels;
  readonly hasLoader: boolean;
  readonly modelEntities: ReadonlyMap<string, string>;
  readonly modelAnimationEntities: ReadonlyMap<string, { readonly assetId: string; readonly version: number }>;
  /** Phase 12 (c): entries may name entities of scenes that are not loaded yet (checked when they load). */
  readonly allowAbsent?: boolean;
}): AdapterError | null {
  if (ctx.schemaVersion !== 3 && ctx.schemaVersion !== 4) {
    return adapterError(
      'models_config_invalid',
      `the models block requires a schemaVersion 3 scene (found ${String(ctx.schemaVersion)}; delivery.md (M4) §2.2)`,
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

// ---- per-instance material cloning (§2.3) ---------------------------------

/**
 * Give one attached instance its own material instances: every mesh
 * material (single or array) is cloned so a per-instance material change
 * (the checkpoint appearance, §41.5.3) never reaches the shared
 * `PreparedVisualResource` or another instance. The clones share the
 * resource's textures (released with the resource, once); the CLONES are
 * owned by the attached instance and released by its disposal path.
 */
function cloneInstanceMaterials(instance: ModelInstance): THREE.Material[] {
  const clones: THREE.Material[] = [];
  const walk = (node: THREE.Object3D): void => {
    const mesh = node as THREE.Mesh;
    if (mesh.isMesh === true) {
      const material = mesh.material;
      if (Array.isArray(material)) {
        mesh.material = material.map((m) => {
          const c = m.clone();
          clones.push(c);
          return c;
        });
      } else if (material instanceof THREE.Material) {
        const c = material.clone();
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

export function createModelsRealization(ctx: ModelsRealizationContext): {
  readonly ok: true;
  readonly realization: ModelsRealization;
} | { readonly ok: false; readonly error: AdapterError } {
  // Fail-fast block validation (§2.2) — before any bytes are read.
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
  // Phase 12 (c): the entity maps grow and shrink with scene loads.
  const modelEntities = new Map(ctx.modelEntities);
  const modelAnimationEntities = new Map(ctx.modelAnimationEntities);
  const instanceEntities = new Map(ctx.instanceEntities ?? []);
  const modelPieces = new Map(ctx.modelPieces ?? []);
  /** The instance options for an entity: its piece and the asset's vertex-colour mode. */
  /** Phase 9.4: an entity's material mapping (the asset's default under its own). */
  const mappingFor = (entityId: string, assetId: string): Record<string, string> | null => {
    const base = rowsByAsset.get(assetId)?.materials;
    const own = ctx.entityMaterials?.(entityId) ?? null;
    if (base === undefined && own === null) return null;
    return { ...(base ?? {}), ...(own ?? {}) };
  };
  const applyMaterials = (entityId: string, assetId: string, root: THREE.Object3D): (() => void) | null => {
    const lib = ctx.materialLibrary;
    const mapping = mappingFor(entityId, assetId);
    return lib !== undefined && lib !== null && mapping !== null ? lib.apply(root, mapping) : null;
  };
  const instanceOptions = (assetId: string, piece: string | undefined): CreateInstanceOptions => ({
    ...(piece !== undefined ? { piece } : {}),
    vertexColors: rowsByAsset.get(assetId)?.vertexColors === 'tint' ? 'tint' : 'data',
  });
  const attached = new Map<string, AttachedModel>(); // entityId → attached model
  const attachedSets = new Map<string, AttachedInstanceSet>(); // entityId → instanced meshes
  const liveControllers = new Set<AnimationRoleController>();
  const pendingHandles = new Map<string, VisualResourceHandle>(); // assetId → handle (the dispose cancel path)
  /** Prepared resources by assetId (kept while an entity uses the asset). */
  const resources = new Map<string, PreparedVisualResource>();
  /** Assets being prepared (bytes resolving or the store load running). */
  const loading = new Set<string>();
  /** Instance-set buffers by digest (decoded once, dropped when unused). */
  const buffers = new Map<string, Float32Array>();
  const bufferLoads = new Set<string>();
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
        message: `the prepare for asset ${assetId} hard-failed (${code}); delivery.md (M4) §2.7 L2–L5 — the host mount fails before the play is presented`,
      });
      return;
    }
    settle({
      ok: true,
      assets: resources.size,
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
  // `sourceDigest` by the wrapper (delivery.md (M4) §2.1).
  const rowsByAsset = new Map<string, SceneAdapterModelAsset>();
  for (const row of ctx.models.assets) rowsByAsset.set(row.assetId, row);

  /** Phase 14.6: animation-only assets asked for by an animator (kept while the realization lives). */
  const clipAssets = new Set<string>();
  /** Whether any live entity still uses the asset. */
  function assetInUse(assetId: string): boolean {
    if (clipAssets.has(assetId)) return true;
    for (const a of modelEntities.values()) if (a === assetId) return true;
    for (const r of instanceEntities.values()) if (r.assetId === assetId) return true;
    return false;
  }

  /** Retire an asset no entity uses: its shared GPU data is freed with the last instance. */
  function releaseAssetIfUnused(assetId: string): void {
    if (assetInUse(assetId)) return;
    const resource = resources.get(assetId);
    if (resource === undefined) return;
    resources.delete(assetId);
    try {
      resource.dispose();
    } catch {
      /* best effort */
    }
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
        if (!failedCodes.has(assetId)) failedCodes.set(assetId, created.error.code);
        continue;
      }
      const instance = created.instance;
      const cloned = cloneInstanceMaterials(instance);
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
      // The committed mapping's stage 5–6 re-check (§41.3.6 rule 7; L6):
      // a mismatching mapping is the hard `animation_role_unresolved` —
      // the model renders statically at its committed transform, one
      // bounded diagnostic, the run proceeds.
      const anim = modelAnimationEntities.get(entityId);
      if (anim !== undefined && anim.assetId === assetId) {
        const entry = ctx.models.animation.find((a) => a.entityId === entityId);
        if (entry !== undefined && entry.version === anim.version) {
          // Pre-commit (no committed view yet): the constant neutral motion —
          // the accepted pure selector then yields `idle` (delivery.md (M4) §2.4).
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
              // L6: the model stays attached, static; the (action-less)
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
   * Phase 12 (c): one instance set = one instanced mesh per mesh of the
   * model (sharing its geometry and materials), placed by the buffer's
   * transforms times the mesh's own offset inside the model.
   */
  function attachInstanceSet(entityId: string, ref: InstanceSetRef): void {
    if (disposed || attachedSets.has(entityId)) return;
    const resource = resources.get(ref.assetId);
    const floats = buffers.get(ref.buffer);
    const holder = ctx.holderFor(entityId);
    if (resource === undefined || floats === undefined || holder === null) return;
    const created = resource.createInstance(instanceOptions(ref.assetId, ref.piece));
    if (created.ok === false) return;
    const template = created.instance;
    const built = buildInstanceSet(template, floats, ref.count, `instances:${entityId}`);
    holder.add(built.group);
    attachedSets.set(entityId, { entityId, template, built, undoMaterials: applyMaterials(entityId, ref.assetId, built.group) });
  }

  function disposeInstanceSet(set: AttachedInstanceSet): void {
    set.undoMaterials?.();
    set.built.dispose(); // the instance matrices (geometry/materials belong to the resource)
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
        const inUse = [...instanceEntities.values()].some((r) => r.buffer === digest);
        if (!inUse) return;
        buffers.set(digest, new Float32Array(bytes.slice(0)));
        for (const [entityId, ref] of instanceEntities) if (ref.buffer === digest) attachInstanceSet(entityId, ref);
      },
      () => {
        bufferLoads.delete(digest);
      },
    );
  }

  function disposeAttached(rec: AttachedModel): void {
    if (rec.disposed) return;
    rec.disposed = true;
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
        material.dispose();
      } catch {
        /* best effort */
      }
    }
    rec.clonedMaterials.length = 0;
    // The instance disposal releases the tracked role controllers too and
    // returns the instance reference to the resource (the refcount rule:
    // the LAST instance of a retired resource releases the LoadedGlb once).
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

  /** Prepare an asset (once) and attach every entity waiting for it. */
  function ensureAsset(assetId: string): void {
    const ready = resources.get(assetId);
    if (ready !== undefined) {
      attachForAsset(assetId, ready);
      return;
    }
    const row = rowsByAsset.get(assetId);
    if (row === undefined || loading.has(assetId)) return;
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
    // Two-phase prepare: the wrapper-verified bytes first (no second fetch,
    // §2.2), then the cancellable store load. A dispose between the two
    // discards the late bytes (nothing prepared).
    void ctx.models.resolveBytes(row.assetId, row.version).then(
      (bytes) => {
        if (disposed || bytes.byteLength === 0) {
          done();
          if (!disposed) settleIfComplete();
          return;
        }
        const descriptor: AssetVersionDescriptor = {
          assetId: row.assetId,
          version: row.version,
          sourceDigest: row.sourceDigest,
          sourceByteLength: bytes.byteLength,
        };
        const handle = store.load({ kind: 'bytes', descriptor, bytes: new Uint8Array(bytes) }, { loader });
        pendingHandles.set(row.assetId, handle);
        void handle.result.then((res) => {
          pendingHandles.delete(row.assetId);
          done();
          if (disposed) {
            // Late completion after disposal: discarded and released.
            if (res.ok === true) res.resource.dispose();
            return;
          }
          if (res.ok === false) {
            const code = res.error.code;
            // Cancellation/stale are not errors (§2.7 L9).
            if (code !== 'asset_load_cancelled' && code !== 'asset_load_stale') {
              if (!failedCodes.has(row.assetId)) failedCodes.set(row.assetId, code);
            }
          } else if (!assetInUse(row.assetId)) {
            // Every entity that wanted it was unloaded meanwhile.
            res.resource.dispose();
          } else {
            resources.set(row.assetId, res.resource);
            attachForAsset(row.assetId, res.resource);
          }
          settleIfComplete();
        });
      },
      (e: unknown) => {
        done();
        if (disposed) return;
        // The wrapper's resolver rejected for a manifest-declared row:
        // a hard assets-phase failure (L2 class).
        const message = e instanceof Error ? e.message : String(e);
        failedCodes.set(row.assetId, 'asset_missing');
        pendingHandles.delete(row.assetId);
        settle({
          ok: false,
          code: 'asset_missing',
          message: `the models resolveBytes rejected for ${row.assetId} v${row.version}: ${message.slice(0, 200)}`,
        });
      },
    );
  }

  // The start scenes' assets (these gate the settle).
  for (const assetId of new Set([...modelEntities.values(), ...[...instanceEntities.values()].map((r) => r.assetId)])) ensureAsset(assetId);
  for (const ref of instanceEntities.values()) ensureBuffer(ref.buffer);
  initial = false;

  const realization: ModelsRealization = {
    instanceOf(entityId: string) {
      const rec = attached.get(entityId);
      if (rec === undefined || rec.disposed) return null;
      const assetId = modelEntities.get(entityId);
      return assetId === undefined ? null : { assetId, instance: rec.instance };
    },
    clipsOf(clipAssetId: string, rigAssetId: string) {
      if (disposed) return null;
      if (clipAssetId === rigAssetId) {
        const own = resources.get(rigAssetId);
        return own === undefined ? null : own.animationClips();
      }
      if (rowsByAsset.get(clipAssetId)?.clipsFor !== rigAssetId) return null;
      const ready = resources.get(clipAssetId);
      if (ready !== undefined) return ready.animationClips();
      if (!clipAssets.has(clipAssetId)) {
        clipAssets.add(clipAssetId);
        // Not a settle gate: the animator plays the base pose until it arrives.
        const wasInitial = initial;
        initial = false;
        ensureAsset(clipAssetId);
        initial = wasInitial;
      }
      return null;
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
        assets: resources.size + loading.size,
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
      const assets = new Set([...entities.models.values(), ...[...entities.instances.values()].map((r) => r.assetId)]);
      for (const assetId of assets) ensureAsset(assetId);
      for (const ref of entities.instances.values()) ensureBuffer(ref.buffer);
    },

    removeEntities(entityIds): void {
      if (disposed) return;
      const touched = new Set<string>();
      for (const id of entityIds) {
        const rec = attached.get(id);
        if (rec !== undefined) disposeAttached(rec);
        const set = attachedSets.get(id);
        if (set !== undefined) disposeInstanceSet(set);
        const assetId = modelEntities.get(id) ?? instanceEntities.get(id)?.assetId;
        if (assetId !== undefined) touched.add(assetId);
        modelEntities.delete(id);
        modelAnimationEntities.delete(id);
        instanceEntities.delete(id);
      }
      for (const assetId of touched) releaseAssetIfUnused(assetId);
      for (const digest of [...buffers.keys()]) {
        if (![...instanceEntities.values()].some((r) => r.buffer === digest)) buffers.delete(digest);
      }
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      // §2.6: cancel every in-flight prepare before releasing; a late
      // completion is discarded and released (never applied).
      try {
        store.dispose();
      } catch {
        /* best effort */
      }
      for (const set of [...attachedSets.values()]) disposeInstanceSet(set);
      for (const rec of [...attached.values()]) disposeAttached(rec);
      for (const resource of resources.values()) {
        try {
          resource.dispose();
        } catch {
          /* best effort */
        }
      }
      resources.clear();
      buffers.clear();
      liveControllers.clear();
      if (!settled) {
        settle({
          ok: false,
          code: 'adapter_disposed',
          message: 'the adapter was disposed before the model prepares settled (§2.6: the run is torn down; no late completion is applied)',
        });
      }
    },
  };

  // Nothing to prepare at creation: settle now.
  if (initialAssets.size === 0) settleIfComplete();

  return { ok: true, realization };
}

/** Phase 12 (c): one realized instance set. */
interface AttachedInstanceSet {
  readonly entityId: string;
  /** The model instance the meshes' geometry/materials come from (holds the resource reference). */
  readonly template: ModelInstance;
  readonly built: BuiltInstanceSet;
  undoMaterials?: (() => void) | null;
}
