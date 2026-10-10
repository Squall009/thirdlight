/**
 * Non-prefab content mutation ops.
 *
 * Each op takes the current (valid, canonical) scene/content plus the validated
 * request args and returns either the applied result (new scene/content, change
 * data, inverse spec) or a structured error. Application happens on an
 * in-memory copy (pipeline step 5): the inputs are never mutated and the
 * RESULTING state is re-validated (three-block when a manifest is available)
 * before it is returned. Nothing here reads files, stages blobs or writes the
 * workspace: `publishAsset` takes digest-addressed facts only, and behavior
 * **source** publication is refused before any stage/digest work.
 */
import { ID_RE } from '@thirdlight/project-model';

import {
  BEHAVIOR_ENTRY_PATH,
  BEHAVIOR_GRAPH_KIND,
  NAME_MAX,
  behaviorGraphContext,
  canonicalGraphData,
  validateGraphData,
  type AssetRecord,
  type BehaviorComponent,
  type BehaviorRecord,
  type EntityV3,
  type GraphData,
  type ModelErrorV2,
  type ModelErrorV3,
  type PropertyValue,
  type SceneV3,
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
  COMPONENT_FIELD_ORDER,
  COMPONENT_FIELD_ORDER_V3,
  REMOVABLE_COMPONENTS,
  animationVersionOf,
  assetKindOf,
  assetsOf,
  commandErrorFromModel,
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
  /** True when the host registered a behavior-source preparer. */
  behaviorPreparerRegistered?: boolean;
  /** Entity ids used by the project's other scenes (never minted here). */
  reservedIds?: ReadonlySet<string>;
  /** The digest-bound prepared facts the preparer derived (never caller input). */
  preparedBehaviorSources?: ReadonlyMap<string, import('./types').PreparedBehaviorSourceFact>;
  /** The host's staged library edit sets (never caller input). */
  scriptLibraryStages?: ReadonlyMap<string, import('./types').ScriptLibraryStageFact>;
}

/** The current content block, or the canonical empty catalog. */
export function contentOf(content: ContentDocument | undefined): ContentDocument {
  return content ?? emptyContentCatalog();
}

/** Reference-resolution context for property values. */
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

// ---- publishAsset ---------------------------------------------------------

/** One version record from publish facts, published at `revision`. */
function assetVersionRecord(args: PublishAssetArgs, version: number, revision: number): CommandAssetRecord['versions'][number] {
  return {
    version,
    sourceDigest: args.sourceDigest,
    sourceByteLength: args.sourceByteLength,
    ...(args.sourcePath !== undefined ? { sourcePath: args.sourcePath } : {}),
    ...(args.convertedFrom !== undefined ? { convertedFrom: deepClone(args.convertedFrom) } : {}),
    ...(args.packedFrom !== undefined ? { packedFrom: deepClone(args.packedFrom) } : {}),
    importRecipe: deepClone(args.importRecipe),
    metrics: deepClone(args.metrics),
    importedAt: args.importedAt,
    publishedRevision: revision,
  } as unknown as CommandAssetRecord['versions'][number];
}

/** The record a create makes: one version, the name defaulting to the id. */
export function createdAssetRecord(args: PublishAssetArgs, revision: number): CommandAssetRecord {
  return {
    assetId: args.assetId,
    kind: args.kind ?? 'model',
    displayName: args.displayName ?? args.assetId,
    currentVersion: 1,
    versions: [assetVersionRecord(args, 1, revision)],
    ...extractedFieldsOf(args, null),
  };
}

/**
 * A model's extracted-image fields after a publish: the setting as the args
 * say (a reimport without it keeps the record's), and the map of the
 * published version only (a version whose images stay inside has none).
 */
function extractedFieldsOf(args: PublishAssetArgs, existing: CommandAssetRecord | null): { extractTextures?: true; textures?: Record<string, string> } {
  const kept = existing?.extractTextures === true;
  const on = args.extractTextures ?? (args.mode === 'reimport' && kept);
  return {
    ...(on ? { extractTextures: true as const } : {}),
    ...(args.textures !== undefined && Object.keys(args.textures).length > 0 ? { textures: { ...args.textures } } : {}),
  };
}

export function applyPublishAsset(input: OpInput, args: PublishAssetArgs): OpOutcome {
  const catalog = contentOf(input.content);
  const existing = catalog.assets.find((a) => a.assetId === args.assetId) ?? null;
  const existingKind = existing === null ? null : assetKindOf(existing);

  // The kind binding is immutable. On create the kind is
  // required (args); on reimport a supplied kind must equal the record's.
  if (args.mode === 'create') {
    if (existing !== null) return { ok: false, error: assetIdDuplicate(args.assetId) };
    // The kind is required on create (the discriminator is
    // immutable at create).
    if (args.kind === undefined) {
      return { ok: false, error: fieldMissing('/args/kind', 'kind') };
    }
  } else {
    if (existing === null) return { ok: false, error: assetNotFound(args.assetId) };
    if (args.kind !== undefined && args.kind !== existingKind) {
      return { ok: false, error: assetKindMismatch(args.assetId, existingKind ?? 'model', args.kind) };
    }
  }
  // The file is the asset, so a reimport replaces the version rather than
  // appending one (the file's history is the game repository's). A legacy
  // `modelAnimation` binding in this scene that still names an older version
  // keeps that version, so the binding stays valid until it is moved.
  const movedEntity = args.animation?.entityId;
  const boundVersions = new Set<number>();
  for (const e of input.scene.entities) {
    if (e.id === movedEntity) continue;
    const anim = (e.components as { modelAnimation?: { assetId?: unknown; version?: unknown } }).modelAnimation;
    if (anim !== undefined && anim.assetId === args.assetId && typeof anim.version === 'number') boundVersions.add(anim.version);
  }
  const keptVersions = existing === null ? [] : existing.versions.filter((v) => boundVersions.has(v.version));

  // An atomic animated reimport moves the version-local role mapping
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
    // Role-binding stages 1–4 against the NEW version's clip count.
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

  const version = existing !== null ? existing.currentVersion + 1 : 1;
  const versionRecord = assetVersionRecord(args, version, input.revision);
  const record: CommandAssetRecord =
    existing !== null
      ? (() => {
          const { extractTextures: _setting, textures: _images, ...rest } = deepClone(existing) as CommandAssetRecord;
          return {
            ...rest,
            displayName: args.displayName ?? existing.displayName,
            currentVersion: version,
            versions: [...deepClone(keptVersions), versionRecord],
            ...extractedFieldsOf(args, existing as CommandAssetRecord),
          };
        })()
      : createdAssetRecord(args, input.revision);
  const assets = [
    ...catalog.assets.filter((a) => a.assetId !== args.assetId),
    record,
  ].sort(byId) as unknown as CommandAssetRecord[];
  const nextContent: ContentDocument = { ...catalog, assets: assets as unknown as ContentDocument['assets'] };

  // The resulting scene carries the new revision (the durability write:
  // the envelope's embedded scene is written at revision+1, and
  // `publishedRevision <= scene.revision` must hold); an animated reimport
  // additionally moves the entity's FULL `modelAnimation` component in the
  // same transaction: `version` advances to the newly appended version and
  // `roles` is replaced with the submitted mapping. The binding is owned by
  // that (assetId, version): the submitted mapping is only valid
  // against the NEW version's clip list, so recording it under the old
  // version would make capture resolve the entity to the previous bytes
  // (the recorded version wins over currentVersion) — a silent no-op success. Moving both together in one revision keeps the
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

// ---- publishBehavior --------------------------------------------------------

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
  // behaviorId syntax and existence apply to every mode.
  if (!ID_RE.test(args.behaviorId)) {
    return {
      ok: false,
      error: idInvalid('/args/behaviorId', args.behaviorId, 'project-model ID syntax: [a-z0-9][a-z0-9_-]{0,63}'),
    };
  }
  const catalog = contentOf(input.content);
  const existing = catalog.behaviors.find((b) => b.behaviorId === args.behaviorId) ?? null;
  // Source mode publishes ONLY from a prepared
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
  if (args.displayName.length < 1 || args.displayName.length > NAME_MAX || !isControlFree(args.displayName)) {
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
  // A declaration derived from the code is edited in the code.
  if (existing !== null && args.mode === 'declaration-update' && existing.source?.declaredInCode === true) {
    return {
      ok: false,
      error: {
        ...behaviorDeclarationMismatch(args.behaviorId, 'declared_in_code'),
        message: 'this behavior declares its properties in its source (export const properties): edit and publish the source instead; nothing was written',
      },
    };
  }
  // A visual script's properties are its graph's variables (the
  // declaration is derived from them when the graph is published); a rename
  // (same declaration) is still an update.
  if (existing !== null && args.mode === 'declaration-update' && existing.graph !== undefined && !deepEqual(existing.declaration, dv.declaration)) {
    return {
      ok: false,
      error: {
        ...behaviorDeclarationMismatch(args.behaviorId, 'declared_in_graph'),
        message: "this behavior is a visual script: its properties are its graph's variables (declare them with Variable nodes and publish the graph); nothing was written",
      },
    };
  }
  let graph: GraphData | undefined;
  if (args.graph !== undefined) {
    const errors: ModelErrorV2[] = [];
    validateGraphData(BEHAVIOR_GRAPH_KIND, args.graph, '', errors, behaviorGraphContext(args.graph));
    if (errors.length > 0) {
      const e = errors[0]!;
      return { ok: false, error: { code: e.code, cls: 'validation', path: `/args/graph${e.path ?? ''}`, message: e.message, ...(e.found !== undefined ? { found: e.found } : {}) } as unknown as CommandError };
    }
    graph = canonicalGraphData(args.graph);
  } else if (existing?.graph !== undefined) graph = deepClone(existing.graph);
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
    // An update keeps the published script (its compiled code
    // does not embed the declaration: the host feeds the record's values), so
    // tuning a declaration does not detach the source.
    source: existing !== null && args.mode === 'declaration-update' && existing.source !== null ? deepClone(existing.source) : null,
    publishedRevision: input.revision,
    // A visual script keeps its graph (or starts with the one sent);
    // And its functions (a declaration-update sent with no graph keeps them).
    ...(graph !== undefined ? { graph } : {}),
    ...(graph !== undefined && args.graph === undefined && existing?.functions !== undefined ? { functions: deepClone(existing.functions) } : {}),
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
 * `publishBehavior{mode:"source"}`: the record is built ONLY from the prepared digest-bound fact set the
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
      error: behaviorNotFound(args.behaviorId, 'source publication requires an existing behavior record: create it first with publishBehavior {behaviorId, displayName, mode: "declaration-create", declaration: {properties: []}}'),
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
  // Every script library version the output links is acknowledged too
  // (the resulting-state check refuses a pin that is not the library's current digest).
  for (const pin of prepared.libraries ?? []) {
    if (!catalog.behaviorTrust.entries.some((e) => e.sourceDigest === pin.sourceDigest)) return { ok: false, error: behaviorTrustUnacknowledged(pin.sourceDigest) };
  }
  if (args.displayName.length < 1 || args.displayName.length > NAME_MAX || !isControlFree(args.displayName)) {
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
      entryPath: BEHAVIOR_ENTRY_PATH,
      fileCount: prepared.fileCount,
      manifestDigest: prepared.manifestDigest,
      outputDigest: prepared.outputDigest,
      outputByteLength: prepared.outputByteLength,
      requiredModules: [...prepared.requiredModules],
      // The owners travel with the record (Play and the export read them).
      ...(prepared.ownedTransforms.length > 0 ? { ownedTransforms: [...prepared.ownedTransforms] } : {}),
      // The declaration comes from the code (editors show it read-only).
      ...(prepared.declaredInCode === true ? { declaredInCode: true as const } : {}),
      // Generated from the behavior's visual-script graph.
      ...(prepared.sourceKind === 'graph' ? { kind: 'graph' as const } : {}),
      // The script library versions it links.
      ...(prepared.libraries !== undefined && prepared.libraries.length > 0 ? { libraries: prepared.libraries.map((p) => ({ ...p })) } : {}),
      publishedRevision: input.revision,
    },
    publishedRevision: input.revision,
    // Publishing a source keeps the visual script's graph and its
    // functions.
    ...(existing.graph !== undefined ? { graph: deepClone(existing.graph) } : {}),
    ...(existing.graph !== undefined && existing.functions !== undefined ? { functions: deepClone(existing.functions) } : {}),
  };
  return finishBehaviorPublication(input, catalog, record, existing);
}

// ---- setBehaviorProperties --------------------------------------------------

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
  const entity = input.scene.entities[index] as EntityV3;
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
  nextEntities[index] = newEntity as unknown as EntityV3;
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

// ---- setComponent ----------------------------------------------------------


/** Whether the component supports `add`/`remove`. */
function componentIsRemovable(component: OwnedComponent): boolean {
  return REMOVABLE_COMPONENTS.includes(component);
}

function isV3Component(component: string): component is V3OwnedComponent {
  return COMPONENT_FIELD_ORDER_V3[component as V3OwnedComponent] !== undefined;
}

/** The entity value with `component` set to `value`; `null` removes the key. */
function withComponent(entity: EntityV3, component: string, value: unknown): EntityV3 {
  const cloned = deepClone(entity);
  const components = { ...componentsRecord(cloned) };
  if (value === null) delete components[component];
  else components[component] = deepClone(value);
  return { ...cloned, components } as unknown as EntityV3;
}

export function applySetComponent(input: OpInput, args: SetComponentArgs): OpOutcome {
  const catalog = contentOf(input.content);
  const index = input.scene.entities.findIndex((e) => e.id === args.entityId);
  if (index < 0) return { ok: false, error: entityNotFound(args.entityId) };
  const entity = input.scene.entities[index] as EntityV3;
  const components = componentsRecord(entity);
  const currentComponent = components[args.component];
  const removable = componentIsRemovable(args.component);
  if (currentComponent === undefined && !removable) {
    return { ok: false, error: componentMissing(args.entityId, args.component) };
  }

  // Removal (`value: null`) is available for every owned component (phase
  // box/camera/model too; the resulting scene is validated as always).
  if (args.value === null) {
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
      // Optional fields count only when the removed value had them (a collider's flag and layers, every controller and spawn field).
      changedFields: COMPONENT_FIELD_ORDER[args.component].filter((f) => (args.component !== 'controller' && args.component !== 'playerSpawn' && !(args.component === 'collider' && f !== 'shape')) || (previous as Record<string, unknown> | null)?.[f] !== undefined),
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

  if (args.component === 'model' && args.value['asset'] !== undefined) {
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
  if (args.component === 'materials' || args.component === 'materialParams') {
    // A material mapping is replaced whole (its keys are material names); so are the parameter overrides (keys are materialIds).
    for (const k of Object.keys(candidate)) delete candidate[k];
    Object.assign(candidate, deepClone(args.value));
    const before = (currentComponent ?? {}) as Record<string, unknown>;
    for (const k of [...new Set([...Object.keys(before), ...Object.keys(args.value)])].sort()) {
      if (before[k] !== (args.value as Record<string, unknown>)[k]) changedFields.push(k);
    }
  }
  const fieldOrder = COMPONENT_FIELD_ORDER[args.component];
  for (const f of fieldOrder) {
    if (Object.prototype.hasOwnProperty.call(args.value, f)) {
      // `null` removes an optional field (e.g. v4 camera bounds);
      // the model validation below refuses removing a required one.
      if (args.value[f] === null && (isV3Component(args.component) || (args.component === 'collider' && (f === 'oneWay' || f === 'layers')) || args.component === 'controller' || (args.component === 'model' && f === 'piece') || ((args.component === 'box' || args.component === 'model') && (f === 'castShadow' || f === 'receiveShadow' || f === 'lightLayers' || f === 'localLights' || f === 'decalLayers')))) delete candidate[f];
      else candidate[f] = deepClone(args.value[f]);
      changedFields.push(f);
    }
  }
  // The six v3 components are validated before application —
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
  const canonicalEntity = gate.scene.entities[index] as EntityV3;
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

// ---- setSettings -----------------------------------------------------------

export function applySetSettings(input: OpInput, args: SetSettingsArgs): OpOutcome {
  const catalog = contentOf(input.content);
  const previous = deepClone(catalog.settings);
  const next: Record<string, number | boolean | string> = { ...deepClone(catalog.settings) };
  for (const [k, v] of Object.entries(args.settings)) next[k] = v;
  // Cross-key check against the RESULTING map.
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

// ---- acknowledgeBehaviorTrust -----------------------------------------------

export function applyAcknowledgeBehaviorTrust(
  input: OpInput,
  args: AcknowledgeBehaviorTrustArgs,
): OpOutcome {
  const catalog = contentOf(input.content);
  const previous = deepClone(catalog.behaviorTrust.entries);
  if (previous.some((e) => e.sourceDigest === args.sourceDigest)) {
    return { ok: false, error: noChangeContent() };
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

