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
  type GlbLoaderPort,
  type ModelInstance,
  type PreparedVisualResource,
  type VisualResourceHandle,
  type VisualResourceStore,
  createVisualResourceStore,
} from './visual';
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
  /** Dispose: cancel in-flight prepares, dispose the attached instances
   * (cloned materials + controllers + instances) and the store.
   *  Idempotent. */
  dispose(): void;
}

// ---- block validation (fail-fast; delivery.md (M4) §2.2) ------------------

/** Validate the `models` block against the snapshot. `null` = valid. */
export function validateModelsBlock(ctx: {
  readonly schemaVersion: number;
  readonly models: SceneAdapterModels;
  readonly hasLoader: boolean;
  readonly modelEntities: ReadonlyMap<string, string>;
  readonly modelAnimationEntities: ReadonlyMap<string, { readonly assetId: string; readonly version: number }>;
}): AdapterError | null {
  if (ctx.schemaVersion !== 3) {
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
  });
  if (configError !== null) return { ok: false, error: configError };
  const loader = ctx.loader as GlbLoaderPort;

  const store: VisualResourceStore = createVisualResourceStore();
  const attached = new Map<string, AttachedModel>(); // entityId → attached model
  const liveControllers = new Set<AnimationRoleController>();
  const pendingHandles = new Map<string, VisualResourceHandle>(); // assetId → handle (the dispose cancel path)
  // The settle gate: an explicit pending count, decremented INSIDE each
  // handle's completion callback BEFORE `settleIfComplete` — never the
  // handle's `state()`: between a promise's resolution and this module's
  // `.then` callback (a microtask gap) the state is already non-pending
  // but the attach (instances + controllers) has not run yet, so a
  // state-based gate would settle early (before all attaches). The count
  // reaches zero only when every completion callback has attached.
  // (Assigned once `rows` is known, below.)
  let pendingCount = 0;
  const failedCodes = new Map<string, string>(); // assetId → first hard code
  let unresolvedCount = 0;
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
      assets: ctx.models.assets.length,
      instances: liveInstanceCount(),
      animations: liveControllers.size,
      unresolved: unresolvedCount,
    });
  }
  function liveInstanceCount(): number {
    let n = 0;
    for (const a of attached.values()) if (!a.disposed) n += 1;
    return n;
  }

  // --- per-asset prepare (§2.2/§2.6) ----------------------------------------
  // One row per assetId (validated above): one load per (assetId, version)
  // through the shared store (assetId-keyed supersession — a same-pair
  // retry marks the older load stale; §2.6 third bullet). The descriptor's
  // `sourceByteLength` is the wrapper-verified bytes' real length
  // (resolveBytes is synchronous in effect after the wrapper's read phase;
  // the bytes are already re-hashed against `sourceDigest` by the wrapper —
  // delivery.md (M4) §2.1: the adapter never re-validates).
  const rowsByAsset = new Map<string, SceneAdapterModelAsset>();
  for (const row of ctx.models.assets) rowsByAsset.set(row.assetId, row);

  function attachForAsset(assetId: string, resource: PreparedVisualResource): void {
    if (disposed) return;
    const row = rowsByAsset.get(assetId);
    if (row === undefined) return;
    for (const [entityId, entityAssetId] of ctx.modelEntities) {
      if (entityAssetId !== assetId || attached.has(entityId)) continue;
      const holder = ctx.holderFor(entityId);
      if (holder === null) continue; // defensive: no holder — skip (bounded)
      const created = resource.createInstance();
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
      // The committed mapping's stage 5–6 re-check (§41.3.6 rule 7; L6):
      // a mismatching mapping is the hard `animation_role_unresolved` —
      // the model renders statically at its committed transform, one
      // bounded diagnostic, the run proceeds.
      const anim = ctx.modelAnimationEntities.get(entityId);
      if (anim !== undefined && anim.assetId === assetId) {
        const entry = ctx.models.animation.find((a) => a.entityId === entityId);
        if (entry !== undefined) {
          // The committed view accessor (the player vs non-player rule is
          // implemented by the adapter's `viewFor`). Pre-commit (no
          // committed view yet): the constant neutral motion — the
          // accepted pure selector then yields `idle` (no blending, no
          // run/airborne; delivery.md (M4) §2.4).
          const controllerRes = createAnimationRoleController(instance, () =>
            ctx.viewFor(entityId) ?? { stepIndex: 0, playerMotion: { speed: 0, grounded: true } },
          );
          if (controllerRes.ok === true) {
            const setRes = controllerRes.controller.setRoles(entry.roles, entry.version);
            if (setRes.ok === true) {
              rec.controller = controllerRes.controller;
              liveControllers.add(controllerRes.controller);
            } else {
              // L6: the model stays attached, static; the (action-less)
              // controller is released — the selector for this model does
              // not run.
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
  }

  function disposeAttached(rec: AttachedModel): void {
    if (rec.disposed) return;
    rec.disposed = true;
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
    // The instance disposal releases the tracked role controllers too
    // (idempotent — already disposed above) and returns the instance
    // reference to the resource (the refcount rule: the LAST instance
    // releases the shared LoadedGlb exactly once).
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

  const rows = [...rowsByAsset.values()];
  pendingCount = rows.length;
  for (const row of rows) {
    // Two-phase prepare: the wrapper-verified bytes first (synchronous in
    // effect — no second fetch, §2.2), then the cancellable store load. A
    // dispose between the two discards the late bytes (nothing prepared).
    void ctx.models.resolveBytes(row.assetId, row.version).then(
      (bytes) => {
        if (disposed || bytes.byteLength === 0) {
          // Discarded (no leak: local buffer). The count still reaches zero
          // so the settle resolves (a 0-byte verified stream is not a GLB;
          // the wrapper's digest pin makes this unreachable in effect).
          if (pendingHandles.delete(row.assetId)) pendingCount -= 1;
          if (!disposed) settleIfComplete();
          return;
        }
        const descriptor: AssetVersionDescriptor = {
          assetId: row.assetId,
          version: row.version,
          sourceDigest: row.sourceDigest,
          sourceByteLength: bytes.byteLength,
        };
        const handle = store.load(
          {
            kind: 'bytes',
            descriptor,
            bytes: new Uint8Array(bytes),
          },
          { loader },
        );
        pendingHandles.set(row.assetId, handle);
        void handle.result.then((res) => {
          pendingHandles.delete(row.assetId);
          // The attach (below) completes before settleIfComplete sees zero:
          // the decrement is first, the settle check last.
          pendingCount -= 1;
          if (disposed) {
            // Late completion after disposal: discarded and released (the
            // store/substrate already released a failed/superseded load's
            // resources; a success is retired here — never applied).
            if (res.ok === true) res.resource.dispose();
            return;
          }
          if (res.ok === false) {
            const code = res.error.code;
            // Cancellation/stale are not errors (§2.7 L9) — terminal,
            // counted, but they do not fail the settle when no other
            // prepare hard-failed. A same-pair retry is a NEW load (a new
            // handle); the store's supersession already marked this one.
            if (code !== 'asset_load_cancelled' && code !== 'asset_load_stale') {
              if (!failedCodes.has(row.assetId)) failedCodes.set(row.assetId, code);
            }
          } else {
            attachForAsset(row.assetId, res.resource);
          }
          settleIfComplete();
        });
      },
      (e: unknown) => {
        if (disposed) return;
        // The wrapper's resolver rejected for a manifest-declared row:
        // a hard assets-phase failure (L2 class) — the bytes never reach
        // the loader.
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

  // --- the `model` entities that resolve to no assets row (§2.3 residual) ---
  for (const [entityId, assetId] of ctx.modelEntities) {
    if (rowsByAsset.has(assetId)) continue;
    unresolvedCount += 1; // one bounded `models_asset_unresolved` diagnostic each
  }

  const realization: ModelsRealization = {
    update(deltaSeconds: number): boolean {
      if (disposed) return false;
      for (const controller of [...liveControllers]) {
        const r = controller.update(deltaSeconds);
        if (r.ok === false) {
          // Defensive: a live controller with a valid delta does not fail;
          // if it does, detach it (it will be released by its instance's
          // disposal path too — idempotent).
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
        assets: rows.length,
        instances: liveInstanceCount(),
        pending,
        animations: liveControllers.size,
        failed: failedCodes.size,
      };
    },

    settled(): Promise<ModelsSettledResult> {
      return settledPromise;
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
      for (const rec of [...attached.values()]) disposeAttached(rec);
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

  // A settle is possible with zero rows (an empty assets list): settle now
  // (all zero prepares are trivially complete).
  if (rows.length === 0) settleIfComplete();

  return { ok: true, realization };
}