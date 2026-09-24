/**
 * Non-prefab M2 mutation ops — commands.md §8.5–§8.12 (packet 21).
 *
 * Each op takes the current (valid, canonical) scene/content plus the validated
 * request args and returns either the applied result (new scene/content, change
 * data, inverse spec) or a structured error. Application happens on an
 * in-memory copy (pipeline step 5): the inputs are never mutated and the
 * RESULTING state is re-validated (three-block when a manifest is available)
 * before it is returned. Nothing here reads files, stages blobs or writes the
 * workspace: `publishAsset` takes digest-addressed facts only, and behavior
 * **source** publication is refused before any stage/digest work (§8.8.2).
 */

import type {
  AssetRecord,
  BehaviorComponent,
  BehaviorRecord,
  EntityV2,
  ModelErrorV3,
  PropertyValue,
  SceneV3,
} from '@thirdlight/project-model';

import {
  assetIdDuplicate,
  assetKindMismatch,
  assetNotFound,
  assetReferenceMissing,
  behaviorDeclarationMismatch,
  behaviorIdDuplicate,
  behaviorNotFound,
  behaviorPublicationUnavailable,
  behaviorTrustUnacknowledged,
  componentMissing,
  entityNotFound,
  fieldMissing,
  fieldValue,
  gameReferenceInUse,
  idInvalid,
  limitsExceeded,
  noChangeContent,
  type CommandError,
} from './errors';
import {
  behaviorOf,
  componentsRecord,
  deepClone,
  emptyContentCatalog,
  gateResultState,
  type OpOutcome,
} from './ops';
import {
  checkDeclarationCompatibility,
  deepEqual,
  fillDeclaredValues,
  validateDeclaration,
  type ValueContext,
} from './properties';
import {
  COMPONENT_FIELD_ORDER_V3,
  REMOVABLE_COMPONENTS,
  animationVersionOf,
  assetKindOf,
  assetsOf,
  commandErrorFromModel,
  danglingGameReferences,
  gameOf,
  validateAnimationRoleRange,
  validateAnimationRolesShape,
  validateV3ComponentValue,
} from './v3';
import type {
  AcknowledgeBehaviorTrustArgs,
  AcknowledgeBehaviorTrustChange,
  CommandAssetRecord,
  CommandState,
  ContentDocument,
  ModelAnimationComponentValue,
  ModelAnimationRolesValue,
  OwnedComponent,
  PublishAssetArgs,
  PublishAssetChange,
  PublishBehaviorArgs,
  PublishBehaviorChange,
  SetBehaviorPropertiesArgs,
  SetBehaviorPropertiesChange,
  SetComponentArgs,
  SetComponentChange,
  SceneDocument,
  SetSettingsArgs,
  SetSettingsChange,
  V3OwnedComponent,
} from './types';

/** The per-op input: current state blocks + the resulting revision. */
export interface OpInput {
  scene: SceneDocument;
  content?: ContentDocument;
  manifest?: CommandState['manifest'];
  /** The revision this op's result will land at (current + 1). */
  revision: number;
  /** True when the host registered a behavior-source preparer (packet 33). */
  behaviorPreparerRegistered?: boolean;
  /** Phase 12 (c): entity ids used by the project's other scenes (never minted here). */
  reservedIds?: ReadonlySet<string>;
  /** The digest-bound prepared facts the preparer derived (never caller input). */
  preparedBehaviorSources?: ReadonlyMap<string, import('./types').PreparedBehaviorSourceFact>;
}

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** The current content block, or the canonical empty catalog. */
export function contentOf(content: ContentDocument | undefined): ContentDocument {
  return content ?? emptyContentCatalog();
}

/** Reference-resolution context for property values (commands.md §8.9). */
export function valueContext(
  scene: SceneDocument,
  content: ContentDocument,
): ValueContext {
  const entityIds = new Set<string>(scene.entities.map((e) => e.id));
  for (const d of content.prefabs) for (const e of d.entities) entityIds.add(e.localId);
  return { entityIds, assetIds: new Set(content.assets.map((a) => a.assetId)) };
}

function byId<T extends { assetId?: string; behaviorId?: string }>(a: T, b: T): number {
  const ka = (a.assetId ?? a.behaviorId ?? '') as string;
  const kb = (b.assetId ?? b.behaviorId ?? '') as string;
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

// ---- publishAsset (§8.5) ---------------------------------------------------------

export function applyPublishAsset(input: OpInput, args: PublishAssetArgs): OpOutcome {
  const catalog = contentOf(input.content);
  const existing = catalog.assets.find((a) => a.assetId === args.assetId) ?? null;
  const existingKind = existing === null ? null : assetKindOf(existing);

  // §3.1.1/§23.3.7: the kind binding is immutable. On create the kind is
  // required (args); on reimport a supplied kind must equal the record's.
  if (args.mode === 'create') {
    if (existing !== null) return { ok: false, error: assetIdDuplicate(args.assetId) };
    // §3.1.1: on a v3 state the kind is required (the discriminator is
    // immutable at create); a v2 state defaults to `model` (accepted M2
    // fixtures create model records without it — handoff 45 CC-45-4).
    if (args.kind === undefined && ((input.scene as { schemaVersion?: unknown }).schemaVersion === 3 || (input.scene as { schemaVersion?: unknown }).schemaVersion === 4)) {
      return { ok: false, error: fieldMissing('/args/kind', 'kind') };
    }
    const kind = args.kind ?? 'model';
    const limit = kind === 'audio' ? 16 : kind === 'texture' ? 256 : 128;
    const count = catalog.assets.filter((a) => assetKindOf(a) === kind).length;
    if (count + 1 > limit) {
      return {
        ok: false,
        error: limitsExceeded(kind === 'audio' ? 'audio_assets' : kind === 'texture' ? 'texture_assets' : 'assets', count + 1, limit),
      };
    }
  } else {
    if (existing === null) return { ok: false, error: assetNotFound(args.assetId) };
    if (args.kind !== undefined && args.kind !== existingKind) {
      return { ok: false, error: assetKindMismatch(args.assetId, existingKind ?? 'model', args.kind) };
    }
    const versionLimit = existingKind === 'audio' || existingKind === 'texture' ? 8 : 32;
    if (existing.versions.length + 1 > versionLimit) {
      return {
        ok: false,
        error: limitsExceeded(
          existingKind === 'audio' ? 'audio_versions' : existingKind === 'texture' ? 'texture_versions' : 'asset_versions',
          existing.versions.length + 1,
          versionLimit,
        ),
      };
    }
  }
  const totalVersions =
    catalog.assets.reduce((n, a) => n + a.versions.length, 0) + 1;
  if (totalVersions > 1024) {
    return { ok: false, error: limitsExceeded('version_records', totalVersions, 1024) };
  }

  // §8.5.1: an atomic animated reimport moves the version-local role mapping
  // with the bytes; the presence rule is checked before any value work.
  const animatedEntities = input.scene.entities.filter((e) => {
    const anim = (e.components as { modelAnimation?: { assetId?: unknown } }).modelAnimation;
    return anim !== undefined && anim.assetId === args.assetId;
  });
  const animation = args.animation;
  if (args.mode === 'reimport' && animatedEntities.length > 0 && animation === undefined) {
    return { ok: false, error: fieldMissing('/args/animation', 'animation') };
  }
  if (animation !== undefined) {
    const index = input.scene.entities.findIndex((e) => e.id === animation.entityId);
    if (index < 0) return { ok: false, error: entityNotFound(animation.entityId) };
    const entity = input.scene.entities[index] as unknown as { components: Record<string, unknown> };
    const component = entity.components['modelAnimation'] as
      | { assetId?: unknown; version?: unknown; roles?: unknown }
      | undefined;
    if (component === undefined) {
      return { ok: false, error: componentMissing(animation.entityId, 'modelAnimation') };
    }
    if (component.assetId !== args.assetId) {
      return {
        ok: false,
        error: {
          code: 'component_conflict',
          cls: 'validation',
          path: `/args/animation/entityId`,
          reason: 'animation_asset',
          message: 'the entity modelAnimation assetId does not equal the published assetId',
          expected: args.assetId,
        },
      };
    }
    // §41.3.2 stages 1–4 against the NEW version's clip count.
    const shapeErrors: ModelErrorV3[] = [];
    validateAnimationRolesShape({ roles: animation.roles }, '/args/animation', shapeErrors);
    if (shapeErrors.length > 0) {
      return { ok: false, error: commandErrorFromModel(shapeErrors[0] as ModelErrorV3) };
    }
    const clips = (args.metrics as { animations?: unknown }).animations;
    if (typeof clips === 'number') {
      const roleError = validateAnimationRoleRange(animation.roles, clips, '/args/animation/roles');
      if (roleError !== null) return { ok: false, error: roleError };
    }
  }

  const version = existing !== null ? existing.versions.length + 1 : 1;
  const versionRecord = {
    version,
    sourceDigest: args.sourceDigest,
    sourceByteLength: args.sourceByteLength,
    ...(args.sourcePath !== undefined ? { sourcePath: args.sourcePath } : {}),
    ...(args.convertedFrom !== undefined ? { convertedFrom: deepClone(args.convertedFrom) } : {}),
    importRecipe: deepClone(args.importRecipe),
    metrics: deepClone(args.metrics),
    importedAt: args.importedAt,
    publishedRevision: input.revision,
  };
  const record: CommandAssetRecord =
    existing !== null
      ? {
          ...deepClone(existing),
          displayName: args.displayName ?? existing.displayName,
          currentVersion: version,
          versions: [...deepClone(existing.versions), versionRecord],
        }
      : {
          assetId: args.assetId,
          kind: args.kind ?? 'model',
          displayName: args.displayName ?? args.assetId,
          currentVersion: 1,
          versions: [versionRecord],
        };
  const assets = [
    ...catalog.assets.filter((a) => a.assetId !== args.assetId),
    record,
  ].sort(byId) as unknown as CommandAssetRecord[];
  const nextContent: ContentDocument = { ...catalog, assets: assets as unknown as ContentDocument['assets'] };

  // The resulting scene carries the new revision (commands.md §6.1 step 7:
  // the envelope's embedded scene is written at revision+1, and
  // `publishedRevision <= scene.revision` must hold); an animated reimport
  // additionally moves the entity's FULL `modelAnimation` component in the
  // same transaction: `version` advances to the newly appended version and
  // `roles` is replaced with the submitted mapping. The binding is owned by
  // that (assetId, version) (project-model §23.3.6, presentation.md
  // §41.3.1/§41.3.4 — CC-L-1, Gate L): the submitted mapping is only valid
  // against the NEW version's clip list, so recording it under the old
  // version would make capture resolve the entity to the previous bytes
  // (project-model §19.2: the recorded version wins over currentVersion) —
  // a silent no-op success. Moving both together in one revision keeps the
  // component a valid binding (1 ≤ version ≤ currentVersion).
  let nextEntities: unknown[] | undefined;
  let animationPrevious: ModelAnimationComponentValue | undefined;
  let animationNext: ModelAnimationComponentValue | undefined;
  if (animation !== undefined) {
    const index = input.scene.entities.findIndex((e) => e.id === animation.entityId);
    const cloned = deepClone(input.scene.entities[index]);
    const components: Record<string, unknown> = {
      ...(cloned as unknown as { components: Record<string, unknown> }).components,
    };
    const component = components['modelAnimation'] as {
      assetId: string;
      version: number;
      roles: ModelAnimationRolesValue;
    };
    animationPrevious = deepClone({
      assetId: component.assetId,
      version: component.version,
      roles: component.roles,
    }) as ModelAnimationComponentValue;
    animationNext = {
      assetId: args.assetId,
      version,
      roles: deepClone(animation.roles) as ModelAnimationRolesValue,
    };
    components['modelAnimation'] = { ...component, ...animationNext };
    (cloned as unknown as { components: Record<string, unknown> }).components = components;
    nextEntities = [...input.scene.entities];
    nextEntities[index] = cloned;
  }
  const resultScene = {
    ...input.scene,
    revision: input.scene.revision + 1,
    ...(nextEntities === undefined ? {} : { entities: nextEntities }),
  };
  const gate = gateResultState(
    { scene: input.scene, content: catalog, manifest: input.manifest },
    resultScene,
    nextContent,
  );
  if (!gate.ok) return gate;
  const next = deepClone(
    (gate.content?.assets.find((a) => a.assetId === args.assetId) ?? record) as unknown as CommandAssetRecord,
  );
  const previous = existing !== null ? deepClone(existing) : null;
  const animationChange =
    animation !== undefined && animationPrevious !== undefined && animationNext !== undefined
      ? { entityId: animation.entityId, previous: animationPrevious, next: animationNext }
      : null;
  const change: PublishAssetChange = {
    type: 'publishAsset',
    mode: args.mode,
    assetId: args.assetId,
    previous,
    next,
    ...(animationChange === null ? {} : { animation: animationChange }),
  };
  return {
    ok: true,
    op: { scene: gate.scene, content: gate.content, change, inverse: { kind: 'publishAsset', assetId: args.assetId, restore: previous } },
  };
}

// ---- publishBehavior (§8.8) --------------------------------------------------------

/** Every stored use of one behavior in the scene and in prefab definitions. */
function collectBehaviorUses(
  scene: SceneDocument,
  content: ContentDocument,
  behaviorId: string,
): { entityId: string; values: Record<string, PropertyValue> }[] {
  const out: { entityId: string; values: Record<string, PropertyValue> }[] = [];
  for (const e of scene.entities) {
    const b = behaviorOf(e);
    if (b !== undefined && b.behaviorId === behaviorId) out.push({ entityId: e.id, values: b.values });
  }
  for (const d of content.prefabs) {
    for (const e of d.entities) {
      const b = e.components.behavior;
      if (b !== undefined && b.behaviorId === behaviorId) out.push({ entityId: e.localId, values: b.values });
    }
  }
  return out;
}

export function applyPublishBehavior(input: OpInput, args: PublishBehaviorArgs): OpOutcome {
  // §8.8.3 step 3: behaviorId syntax and existence apply to every mode.
  if (!ID_RE.test(args.behaviorId)) {
    return {
      ok: false,
      error: idInvalid('/args/behaviorId', args.behaviorId, 'project-model ID syntax: [a-z0-9][a-z0-9_-]{0,63}'),
    };
  }
  const catalog = contentOf(input.content);
  const existing = catalog.behaviors.find((b) => b.behaviorId === args.behaviorId) ?? null;
  // §8.8.4 (C19-D2/§22.4.1): source mode publishes ONLY from a prepared
  // digest-bound fact set the host derived (never a caller-supplied record
  // field), and only after the trust acknowledgment.
  if (args.mode === 'source') {
    return applyPublishBehaviorSource(input, args, catalog, existing);
  }
  if (args.mode === 'declaration-create') {
    if (existing !== null) return { ok: false, error: behaviorIdDuplicate(args.behaviorId) };
  } else if (existing === null) {
    return {
      ok: false,
      error: behaviorNotFound(args.behaviorId, 'no behavior record with this id exists'),
    };
  }
  // step 4: displayName shape, then declaration bounds.
  if (args.displayName.length < 1 || args.displayName.length > 128 || !isControlFree(args.displayName)) {
    return {
      ok: false,
      error: fieldValue(
        '/args/displayName',
        args.displayName,
        'string, 1-128 chars, no control characters',
        'displayName must be 1-128 characters without control characters',
      ),
    };
  }
  const dv = validateDeclaration(args.declaration);
  if (!dv.ok) return { ok: false, error: dv.error };
  if (existing === null && catalog.behaviors.length + 1 > 64) {
    return { ok: false, error: limitsExceeded('behaviors', catalog.behaviors.length + 1, 64) };
  }
  // step 6: declaration-update compatibility against every existing use.
  if (existing !== null && args.mode === 'declaration-update') {
    const uses = collectBehaviorUses(input.scene, catalog, args.behaviorId);
    const c = checkDeclarationCompatibility(
      args.behaviorId,
      existing.declaration,
      dv.declaration,
      uses,
      valueContext(input.scene, catalog),
    );
    if (!c.ok) return { ok: false, error: c.error };
  }
  const record: BehaviorRecord = {
    behaviorId: args.behaviorId,
    displayName: args.displayName,
    declaration: dv.declaration,
    source: null,
    publishedRevision: input.revision,
  };
  return finishBehaviorPublication(input, catalog, record, existing);
}

/**
 * The shared publication tail: sort into `content.behaviors`, re-validate the
 * resulting three-block state and build the change/inverse pair.
 */
function finishBehaviorPublication(
  input: OpInput,
  catalog: ContentDocument,
  record: BehaviorRecord,
  existing: BehaviorRecord | null,
): OpOutcome {
  const behaviorId = record.behaviorId;
  const behaviors = [...catalog.behaviors.filter((b) => b.behaviorId !== behaviorId), record].sort(
    (a, b) => (a.behaviorId < b.behaviorId ? -1 : a.behaviorId > b.behaviorId ? 1 : 0),
  );
  const nextContent: ContentDocument = { ...catalog, behaviors };

  const resultScene = { ...input.scene, revision: input.scene.revision + 1 };
  const gate = gateResultState(
    { scene: input.scene, content: catalog, manifest: input.manifest },
    resultScene,
    nextContent,
  );
  if (!gate.ok) return gate;
  const next = deepClone(
    (gate.content?.behaviors.find((b) => b.behaviorId === behaviorId) ?? record) as BehaviorRecord,
  );
  const previous = existing !== null ? deepClone(existing) : null;
  const change: PublishBehaviorChange = { type: 'publishBehavior', behaviorId, previous, next };
  return {
    ok: true,
    op: {
      scene: gate.scene,
      content: gate.content,
      change,
      inverse: { kind: 'publishBehavior', behaviorId, restore: previous },
    },
  };
}

/**
 * `publishBehavior{mode:"source"}` (project-model.md §22.4.1, commands.md
 * §8.8.4): the record is built ONLY from the prepared digest-bound fact set the
 * host derived; the request supplies `{ sourceDigest, sourceByteLength }` and
 * the declaration it wants to bind. The command never compiles, never resolves
 * a stage and never copies a caller-supplied record field.
 *
 * Order: preparer registration (preparer_unavailable) → prepared artifact
 * (preparation_missing) → behaviorId existence (`behavior_not_found`) →
 * byte-length/manifest binding (`behavior_declaration_mismatch` `digest`) →
 * behaviorId/declaration binding (`declaration`) → trust acknowledgment
 * (`behavior_trust_unacknowledged`).
 */
function applyPublishBehaviorSource(
  input: OpInput,
  args: PublishBehaviorArgs,
  catalog: ContentDocument,
  existing: BehaviorRecord | null,
): OpOutcome {
  if (input.behaviorPreparerRegistered !== true) {
    return { ok: false, error: behaviorPublicationUnavailable(args.behaviorId, args.mode, 'preparer_unavailable') };
  }
  const src = args.source;
  if (src === undefined) {
    return { ok: false, error: behaviorPublicationUnavailable(args.behaviorId, args.mode, 'preparation_missing') };
  }
  const prepared = input.preparedBehaviorSources?.get(src.sourceDigest);
  if (prepared === undefined) {
    return { ok: false, error: behaviorPublicationUnavailable(args.behaviorId, args.mode, 'preparation_missing') };
  }
  if (existing === null) {
    return {
      ok: false,
      error: behaviorNotFound(args.behaviorId, 'source publication requires an existing behavior record'),
    };
  }
  if (prepared.sourceByteLength !== src.sourceByteLength) {
    return { ok: false, error: behaviorDeclarationMismatch(args.behaviorId, 'digest') };
  }
  if (prepared.behaviorId !== args.behaviorId) {
    return { ok: false, error: behaviorDeclarationMismatch(args.behaviorId, 'declaration') };
  }
  const dv = validateDeclaration(args.declaration);
  if (!dv.ok) return { ok: false, error: dv.error };
  if (!deepEqual(prepared.declaration, dv.declaration)) {
    return { ok: false, error: behaviorDeclarationMismatch(args.behaviorId, 'declaration') };
  }
  const acknowledged = catalog.behaviorTrust.entries.some((e) => e.sourceDigest === src.sourceDigest);
  if (!acknowledged) return { ok: false, error: behaviorTrustUnacknowledged(src.sourceDigest) };
  if (args.displayName.length < 1 || args.displayName.length > 128 || !isControlFree(args.displayName)) {
    return {
      ok: false,
      error: fieldValue(
        '/args/displayName',
        args.displayName,
        'string, 1-128 chars, no control characters',
        'displayName must be 1-128 characters without control characters',
      ),
    };
  }
  const record: BehaviorRecord = {
    behaviorId: args.behaviorId,
    displayName: args.displayName,
    declaration: dv.declaration,
    source: {
      sourceDigest: prepared.sourceDigest,
      sourceByteLength: prepared.sourceByteLength,
      entryPath: 'src/index.ts',
      fileCount: prepared.fileCount,
      manifestDigest: prepared.manifestDigest,
      outputDigest: prepared.outputDigest,
      outputByteLength: prepared.outputByteLength,
      requiredModules: [...prepared.requiredModules],
      publishedRevision: input.revision,
    },
    publishedRevision: input.revision,
  };
  return finishBehaviorPublication(input, catalog, record, existing);
}

// ---- setBehaviorProperties (§8.9) --------------------------------------------------

function declarationOrderChangedKeys(
  declarationKeys: readonly string[],
  next: Record<string, unknown>,
  baseline: Record<string, unknown>,
): string[] {
  return declarationKeys.filter(
    (k) =>
      Object.prototype.hasOwnProperty.call(next, k) &&
      !deepEqual(next[k], baseline[k]),
  );
}

export function applySetBehaviorProperties(
  input: OpInput,
  args: SetBehaviorPropertiesArgs,
): OpOutcome {
  const catalog = contentOf(input.content);
  const index = input.scene.entities.findIndex((e) => e.id === args.entityId);
  if (index < 0) return { ok: false, error: entityNotFound(args.entityId) };
  const entity = input.scene.entities[index] as EntityV2;
  if ((entity.components as { camera?: unknown }).camera !== undefined) {
    return {
      ok: false,
      error: fieldValue(
        '/args/entityId',
        args.entityId,
        'an entity that is not the camera',
        'the camera entity may not carry a behavior component',
      ),
    };
  }
  const entityBehavior = behaviorOf(entity);
  const previous = entityBehavior !== undefined ? deepClone(entityBehavior) : null;

  let next: BehaviorComponent | null = null;
  let changedKeys: string[] = [];
  if (args.behaviorId !== null) {
    const record = catalog.behaviors.find((b) => b.behaviorId === args.behaviorId);
    if (record === undefined) return { ok: false, error: behaviorNotFound(args.behaviorId) };
    const filled = fillDeclaredValues(
      record.declaration,
      (args.values ?? {}) as Record<string, unknown>,
      valueContext(input.scene, catalog),
      args.behaviorId,
      previous !== null ? (previous.values as Record<string, import('@thirdlight/project-model').PropertyValue>) : undefined,
    );
    if (!filled.ok) return { ok: false, error: filled.error };
    next = { behaviorId: args.behaviorId, values: filled.values };
    const baseline: Record<string, unknown> = {};
    for (const p of record.declaration.properties) {
      const prevValue =
        previous !== null && Object.prototype.hasOwnProperty.call(previous.values, p.key)
          ? previous.values[p.key]
          : p.default;
      baseline[p.key] = prevValue;
    }
    changedKeys = declarationOrderChangedKeys(
      record.declaration.properties.map((p) => p.key),
      next.values as Record<string, unknown>,
      baseline,
    );
  } else if (previous !== null) {
    // Removal: keys in the previous declaration's order when it resolves.
    const prevDecl = catalog.behaviors.find((b) => b.behaviorId === previous.behaviorId);
    changedKeys =
      prevDecl !== undefined
        ? prevDecl.declaration.properties.map((p) => p.key).filter((k) => k in previous.values)
        : Object.keys(previous.values);
  }

  const cloned = deepClone(entity);
  const components: Record<string, unknown> = { ...componentsRecord(cloned) };
  if (next === null) delete components['behavior'];
  else components['behavior'] = next;
  const newEntity = { ...cloned, components };
  const nextEntities = [...input.scene.entities];
  nextEntities[index] = newEntity as unknown as EntityV2;
  const resultScene = { ...input.scene, revision: input.scene.revision + 1, entities: nextEntities };

  const gate = gateResultState(
    { scene: input.scene, content: catalog, manifest: input.manifest },
    resultScene,
    catalog,
  );
  if (!gate.ok) return gate;
  const change: SetBehaviorPropertiesChange = {
    type: 'setBehaviorProperties',
    id: args.entityId,
    previous,
    next,
    changedKeys,
  };
  return {
    ok: true,
    op: {
      scene: gate.scene,
      content: gate.content,
      change,
      inverse: { kind: 'setBehaviorProperties', id: args.entityId, restore: previous },
    },
  };
}

// ---- setComponent (§8.10) ----------------------------------------------------------

const COMPONENT_FIELD_ORDER: Record<OwnedComponent, readonly string[]> = {
  box: ['size', 'material'],
  camera: ['type', 'fovY', 'near', 'far'],
  model: ['asset'],
  collider: ['shape'],
  controller: [],
  ...COMPONENT_FIELD_ORDER_V3,
};

/** Whether the component supports `add`/`remove` (commands.md §8.10). */
function componentIsRemovable(component: OwnedComponent): boolean {
  return REMOVABLE_COMPONENTS.includes(component);
}

function isV3Component(component: string): component is V3OwnedComponent {
  return COMPONENT_FIELD_ORDER_V3[component as V3OwnedComponent] !== undefined;
}

/** The entity value with `component` set to `value`; `null` removes the key. */
function withComponent(entity: EntityV2, component: string, value: unknown): EntityV2 {
  const cloned = deepClone(entity);
  const components = { ...componentsRecord(cloned) };
  if (value === null) delete components[component];
  else components[component] = deepClone(value);
  return { ...cloned, components } as unknown as EntityV2;
}

export function applySetComponent(input: OpInput, args: SetComponentArgs): OpOutcome {
  const catalog = contentOf(input.content);
  const index = input.scene.entities.findIndex((e) => e.id === args.entityId);
  if (index < 0) return { ok: false, error: entityNotFound(args.entityId) };
  const entity = input.scene.entities[index] as EntityV2;
  const components = componentsRecord(entity);
  const currentComponent = components[args.component];
  const removable = componentIsRemovable(args.component);
  if (currentComponent === undefined && !removable) {
    return { ok: false, error: componentMissing(args.entityId, args.component) };
  }

  // Removal (`value: null`) is available for the M2 physics pair and every
  // v3 add-capable component; the validator rejects `null` for
  // box/camera/model.
  if (args.value === null) {
    // §23.6 rule 2 (authoring §A4.2): a component removal that would dangle a
    // `content.game`/checkpoint reference is refused before application.
    const isV3Scene = (input.scene as { schemaVersion?: unknown }).schemaVersion === 3 || (input.scene as { schemaVersion?: unknown }).schemaVersion === 4;
    if (isV3Scene && isV3Component(args.component)) {
      // §23.6 rule 2: only the removal that owns the reference dangles it —
      // `playerSpawn` ⇒ game.spawnId/checkpoint safeSpawnId, `controller` ⇒
      // game.playerId, `cameraFollow` ⇒ game.cameraId. The other v3
      // components own no game reference.
      const refs = danglingGameReferences(
        input.scene as SceneV3,
        gameOf(catalog),
        new Set([args.entityId]),
      ).filter((p) => {
        if (args.component === 'controller') return p === '/game/playerId';
        if (args.component === 'playerSpawn') {
          return p === '/game/spawnId' || p.endsWith('/components/gameZone/safeSpawnId');
        }
        if (args.component === 'cameraFollow') return p === '/game/cameraId';
        return false;
      });
      if (refs.length > 0) {
        return { ok: false, error: gameReferenceInUse([args.entityId], refs) };
      }
    }
    const previous = deepClone(currentComponent);
    const newEntity = withComponent(entity, args.component, null);
    const nextEntities = [...input.scene.entities];
    nextEntities[index] = newEntity;
    const resultScene = { ...input.scene, revision: input.scene.revision + 1, entities: nextEntities };
    const gate = gateResultState(
      { scene: input.scene, content: catalog, manifest: input.manifest },
      resultScene,
      catalog,
    );
    if (!gate.ok) return gate;
    const change: SetComponentChange = {
      type: 'setComponent',
      id: args.entityId,
      component: args.component,
      previous,
      next: null,
      changedFields: [...COMPONENT_FIELD_ORDER[args.component], ...(args.component === 'collider' && (previous as { oneWay?: unknown } | null)?.oneWay !== undefined ? ['oneWay'] : [])],
    };
    return {
      ok: true,
      op: {
        scene: gate.scene,
        content: gate.content,
        change,
        inverse: { kind: 'setComponent', id: args.entityId, component: args.component, restore: previous },
      },
    };
  }

  if (args.component === 'model') {
    const asset = args.value['asset'] as { assetId: string };
    if (!catalog.assets.some((a) => a.assetId === asset.assetId)) {
      return { ok: false, error: assetReferenceMissing(asset.assetId) };
    }
  }
  const previous = currentComponent === undefined ? null : deepClone(currentComponent);
  const candidate: Record<string, unknown> = currentComponent === undefined
    ? {}
    : (deepClone(currentComponent) as Record<string, unknown>);
  const changedFields: string[] = [];
  if (args.component === 'materials') {
    // Phase 9.4: a material mapping is replaced whole (its keys are material names).
    for (const k of Object.keys(candidate)) delete candidate[k];
    Object.assign(candidate, deepClone(args.value));
    const before = (currentComponent ?? {}) as Record<string, unknown>;
    for (const k of [...new Set([...Object.keys(before), ...Object.keys(args.value)])].sort()) {
      if (before[k] !== (args.value as Record<string, unknown>)[k]) changedFields.push(k);
    }
  }
  // Phase 9.9 (v4): a collider's `oneWay` flag (not in the M2 field order).
  const fieldOrder = args.component === 'collider' ? [...COMPONENT_FIELD_ORDER.collider, 'oneWay'] : COMPONENT_FIELD_ORDER[args.component];
  for (const f of fieldOrder) {
    if (Object.prototype.hasOwnProperty.call(args.value, f)) {
      // Phase 12 (c): `null` removes an optional field (e.g. v4 camera bounds);
      // the model validation below refuses removing a required one.
      if (args.value[f] === null && (isV3Component(args.component) || (args.component === 'collider' && f === 'oneWay'))) delete candidate[f];
      else candidate[f] = deepClone(args.value[f]);
      changedFields.push(f);
    }
  }
  // §23.3/§41.3.2: the six v3 components are validated before application —
  // the model owns field values, the command layer owns the role stages 2–4.
  if (isV3Component(args.component)) {
    const errors = validateV3ComponentValue(args.component, candidate, '/args/value', input.scene.schemaVersion === 4 ? 4 : 3);
    if (errors.length > 0) return { ok: false, error: commandErrorFromModel(errors[0] as ModelErrorV3) };
    if (args.component === 'modelAnimation') {
      const version = animationVersionOf(assetsOf(catalog), candidate['assetId'], candidate['version']);
      const clips = (version?.metrics as { animations?: unknown } | undefined)?.animations;
      if (typeof clips === 'number') {
        const roleError = validateAnimationRoleRange(candidate['roles'], clips, '/args/value/roles');
        if (roleError !== null) return { ok: false, error: roleError };
      }
    }
  }
  const newEntity = withComponent(entity, args.component, candidate);
  const nextEntities = [...input.scene.entities];
  nextEntities[index] = newEntity;
  const resultScene = { ...input.scene, revision: input.scene.revision + 1, entities: nextEntities };

  const gate = gateResultState(
    { scene: input.scene, content: catalog, manifest: input.manifest },
    resultScene,
    catalog,
  );
  if (!gate.ok) return gate;
  const canonicalEntity = gate.scene.entities[index] as EntityV2;
  const next = deepClone(componentsRecord(canonicalEntity)[args.component]);
  const change: SetComponentChange = {
    type: 'setComponent',
    id: args.entityId,
    component: args.component,
    previous,
    next,
    changedFields,
  };
  return {
    ok: true,
    op: {
      scene: gate.scene,
      content: gate.content,
      change,
      inverse: { kind: 'setComponent', id: args.entityId, component: args.component, restore: previous },
    },
  };
}

// ---- setSettings (§8.11) -----------------------------------------------------------

export function applySetSettings(input: OpInput, args: SetSettingsArgs): OpOutcome {
  const catalog = contentOf(input.content);
  const previous = deepClone(catalog.settings);
  const next: Record<string, number | boolean | string> = { ...deepClone(catalog.settings) };
  for (const [k, v] of Object.entries(args.settings)) next[k] = v;
  // §20.9 cross-key check against the RESULTING map.
  const climb = next['max_slope_climb_deg'];
  const slide = next['min_slope_slide_deg'];
  if (
    typeof climb === 'number' &&
    typeof slide === 'number' &&
    slide > climb
  ) {
    return {
      ok: false,
      error: {
        code: 'field_value',
        cls: 'validation',
        path: '/args/settings/min_slope_slide_deg',
        key: 'min_slope_slide_deg',
        found: slide,
        expected: `<= max_slope_climb_deg (${climb})`,
        message: 'min_slope_slide_deg must not exceed max_slope_climb_deg',
      },
    };
  }
  const changedKeys = Object.keys(next)
    .filter((k) => !deepEqual(next[k], previous[k]))
    .sort();
  const nextContent: ContentDocument = { ...catalog, settings: next };
  const resultScene = { ...input.scene, revision: input.scene.revision + 1 };
  const gate = gateResultState(
    { scene: input.scene, content: catalog, manifest: input.manifest },
    resultScene,
    nextContent,
  );
  if (!gate.ok) return gate;
  const canonicalNext = deepClone((gate.content?.settings ?? next) as Record<string, number | boolean | string>);
  const change: SetSettingsChange = { type: 'setSettings', previous, next: canonicalNext, changedKeys };
  return {
    ok: true,
    op: {
      scene: gate.scene,
      content: gate.content,
      change,
      inverse: { kind: 'setSettings', restore: previous },
    },
  };
}

// ---- acknowledgeBehaviorTrust (§8.12) -----------------------------------------------

export function applyAcknowledgeBehaviorTrust(
  input: OpInput,
  args: AcknowledgeBehaviorTrustArgs,
): OpOutcome {
  const catalog = contentOf(input.content);
  const previous = deepClone(catalog.behaviorTrust.entries);
  if (previous.some((e) => e.sourceDigest === args.sourceDigest)) {
    return { ok: false, error: noChangeContent() };
  }
  if (previous.length + 1 > 64) {
    return { ok: false, error: limitsExceeded('trust_entries', previous.length + 1, 64) };
  }
  const next = [...previous, { sourceDigest: args.sourceDigest, acknowledgedRevision: input.revision }].sort(
    (a, b) => (a.sourceDigest < b.sourceDigest ? -1 : a.sourceDigest > b.sourceDigest ? 1 : 0),
  );
  const nextContent: ContentDocument = { ...catalog, behaviorTrust: { entries: next } };
  const resultScene = { ...input.scene, revision: input.scene.revision + 1 };
  const gate = gateResultState(
    { scene: input.scene, content: catalog, manifest: input.manifest },
    resultScene,
    nextContent,
  );
  if (!gate.ok) return gate;
  const canonicalNext = deepClone(
    (gate.content?.behaviorTrust.entries ?? next) as readonly { sourceDigest: string; acknowledgedRevision: number }[],
  );
  const change: AcknowledgeBehaviorTrustChange = {
    type: 'acknowledgeBehaviorTrust',
    sourceDigest: args.sourceDigest,
    previous,
    next: canonicalNext,
  };
  return {
    ok: true,
    op: {
      scene: gate.scene,
      content: gate.content,
      change,
      inverse: { kind: 'acknowledgeBehaviorTrust', sourceDigest: args.sourceDigest, restore: previous },
    },
  };
}

function isControlFree(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return false;
  }
  return true;
}

