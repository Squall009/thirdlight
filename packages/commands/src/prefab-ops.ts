/**
 * Prefab mutation ops — `createPrefab`, `updatePrefab` and `instantiatePrefab`.
 *
 * `createPrefab` captures a selected scene subtree into a
 * `PrefabDefinition`; `updatePrefab` replaces a definition's contents with
 * another capture under the same id; `instantiatePrefab` materializes
 * independent copies in **one transaction** — a complete subtree, every
 * local entity/reference ID remapped exactly once, with the exact mapping
 * recorded in the durable result. Both ops run the mutation pipeline and
 * the shared pure history engine: nothing here reads files, mutates the
 * workspace, or provides a second mutation path.
 *
 * Copy semantics are explicit: definitions are
 * materialized, never inherited; there is no live link, no propagation, no
 * variants and no structural overrides: a definition update never rewrites a
 * copy. `components.prefab` is informational provenance written only here.
 */
import { ID_RE, isPrefabLink, prefabNestingCycles } from '@thirdlight/project-model';

import type {
  BehaviorComponent,
  ContentCatalog,
  DeclaredProperty,
  EntityV3,
  PrefabComponentsV2,
  PrefabDefinition,
  PrefabEntity,
  PropertyValue,
} from '@thirdlight/project-model';
import {
  MAX_ENTITY_DEPTH as MAX_SCENE_DEPTH,
  MAX_PREFAB_BYTES,
  MAX_PREFAB_DEPTH,
  MAX_PREFAB_ENTITIES,
  PREFAB_EXCLUDED_COMPONENTS,
  PREFAB_V4_COMPONENTS,
  mapComponentRefs,
  ENTITY_ID_MAX,
  canonicalPrefabs,
  effectiveEntityFlags,
  entityIdAt,
  nextFreeEntityIdOf,
} from '@thirdlight/project-model';

import {
  entityNotFound,
  fieldValue,
  idExhaustion,
  idInvalid,
  isValidName,
  limitsExceeded,
  prefabCameraCaptureForbidden,
  prefabComponentForbidden,
  prefabCycle,
  prefabExternalReferenceForbidden,
  prefabIdDuplicate,
  prefabLocalUnknown,
  prefabNestedForbidden,
  prefabNotFound,
  propertyOverrideUnknown,
  propertyPrivate,
  referenceMissing,
} from './errors';
import { contentOf, type OpInput } from './content-ops';
import { entityRefKeysByBehavior, firstExternalEntityRef, subtreeOf, type CaptureEntity } from '@thirdlight/project-model/authoring-rules';
import { checkOverrideValue, isPrivateProperty, type ValueContext } from './properties';
import { deepClone, gateResultState, type OpOutcome } from './ops';
import type { CommandError } from './errors';
import type {
  CreatePrefabArgs,
  CreatePrefabChange,
  InstantiatePrefabArgs,
  InstantiatePrefabChange,
  InstantiatePrefabEntry,
  PartialTransformArgs,
  SceneDocument,
  UpdatePrefabArgs,
  UpdatePrefabChange,
} from './types';
import { utf8Length } from '@thirdlight/shared';
const ID_EXPECTED = 'project-model ID syntax: [a-z0-9][a-z0-9_-]{0,63}';


const TRANSFORM_FIELDS = ['position', 'rotation', 'scale'] as const;

export function canonicalBytes(value: unknown): number {
  return utf8Length(JSON.stringify(value, null, 2) + '\n');
}

/** Instance ID prefix derivation: model, else box, else group. */
export function idPrefix(components: PrefabComponentsV2): 'model' | 'box' | 'group' {
  if (components.model !== undefined) return 'model';
  if (components.box !== undefined) return 'box';
  return 'group';
}

/** The smallest free `<prefix>-N` (six digits) for `prefix`, scoped to the used set. */
export function nextFreeEntityId(
  used: ReadonlySet<string>,
  prefix: string,
): string | undefined {
  return nextFreeEntityIdOf(used, prefix);
}

/** Definition depth (definition root = 1). */
export function prefabDepth(entities: readonly PrefabEntity[]): number {
  const byLocal = new Map(entities.map((e) => [e.localId, e]));
  const depth = new Map<string, number>();
  const depthOf = (id: string, seen: Set<string>): number => {
    const cached = depth.get(id);
    if (cached !== undefined) return cached;
    if (seen.has(id)) return 0;
    const e = byLocal.get(id);
    if (e === undefined) return 0;
    seen.add(id);
    const d = e.parentLocalId !== undefined ? depthOf(e.parentLocalId, seen) + 1 : 1;
    depth.set(id, d);
    return d;
  };
  let max = 0;
  for (const e of entities) {
    const d = depthOf(e.localId, new Set());
    if (d > max) max = d;
  }
  return max;
}

/** Scene entity depth (root = 1). Valid scenes are acyclic with parents first. */
export function sceneEntityDepth(scene: SceneDocument, id: string): number {
  const byId = new Map(scene.entities.map((e) => [e.id, e]));
  let depth = 0;
  let cur = byId.get(id);
  while (cur !== undefined) {
    depth += 1;
    cur = cur.parentId !== undefined ? byId.get(cur.parentId) : undefined;
  }
  return depth;
}

/** Full descendant closure of `rootId` in scene DOCUMENT order (root first). */
export function subtreeInDocumentOrder(scene: SceneDocument, rootId: string): string[] | null {
  return subtreeOf(scene.entities, rootId)?.entities.map((e) => e.id) ?? null;
}

/** A scene object as the shared capture rules read it. */
function captureView(e: EntityV3): CaptureEntity {
  return { id: e.id, ...(e.parentId !== undefined ? { parentId: e.parentId } : {}), behavior: e.components.behavior ?? null };
}

function cloneTransform(t: EntityV3['components']['transform']): Record<string, number[]> {
  return {
    position: [...t.position],
    rotation: [...t.rotation],
    scale: [...t.scale],
  };
}

// ---- the capture (createPrefab, updatePrefab) --------------------------------

/** The number of a `<prefix>-N` id, or undefined for an id without one. */
function localNumber(id: string): number | undefined {
  const m = /-(\d+)$/.exec(id);
  if (m === null) return undefined;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) ? n : undefined;
}

/**
 * The least number a new part's local id may take: past every numbered id
 * the definition holds, and never below the number it recorded, so ids its
 * earlier versions held and dropped are never handed out again.
 */
export function nextLocalNumberOf(definition: PrefabDefinition): number {
  let next = definition.nextLocalNumber ?? 1;
  for (const e of definition.entities) {
    const n = localNumber(e.localId);
    if (n !== undefined && n >= next) next = n + 1;
  }
  return next;
}

/**
 * The local ids an update gives the captured objects, so a copy's
 * provenance, instantiate overrides and script references to the prefab's
 * parts keep naming the same parts: the root keeps the old root's (so the
 * root's local id never changes and always marks a copy's root), an object
 * copied from this prefab keeps the local id it was copied from, an object
 * whose scene id names a part the prefab holds is that part again (it was
 * captured by its scene id), any other object is a new part. A new part is
 * named by its scene id only when that id's number is past every id the
 * definition ever held; otherwise it gets a fresh `<prefix>-N` from that
 * number on. A dropped part's id therefore never names a different part,
 * which copies placed earlier still name.
 */
function updateLocalIds(
  closure: readonly EntityV3[],
  prefabId: string,
  previous: PrefabDefinition,
): { ok: true; localOf: Map<string, string>; nextLocalNumber: number } | { ok: false; prefix: string } {
  const localOf = new Map<string, string>();
  const taken = new Set<string>();
  const claim = (id: string, local: string): void => {
    if (localOf.has(id) || taken.has(local)) return;
    localOf.set(id, local);
    taken.add(local);
  };
  const root = closure[0] as EntityV3;
  claim(root.id, (previous.entities[0] as PrefabEntity).localId);
  for (const e of closure) {
    const from = e.components.prefab;
    if (from?.prefabId === prefabId && typeof from.localId === 'string') claim(e.id, from.localId);
  }
  let next = nextLocalNumberOf(previous);
  const held = new Set(previous.entities.map((p) => p.localId));
  for (const e of closure) {
    if (localOf.has(e.id)) continue;
    const own = localNumber(e.id);
    if (!taken.has(e.id) && (held.has(e.id) || (own !== undefined && own >= next))) {
      claim(e.id, e.id);
      if (own !== undefined && own >= next) next = own + 1;
      continue;
    }
    const prefix = idPrefix(e.components as unknown as PrefabComponentsV2);
    while (next <= ENTITY_ID_MAX && taken.has(entityIdAt(prefix, next))) next += 1;
    if (next > ENTITY_ID_MAX) return { ok: false, prefix };
    claim(e.id, entityIdAt(prefix, next));
    next += 1;
  }
  return { ok: true, localOf, nextLocalNumber: next };
}

/**
 * Capture the subtree under `sourceEntityId` as prefab objects: the one
 * capture `createPrefab` and `updatePrefab` share. `previous` is the
 * definition an update replaces: objects copied from it may be captured
 * (their provenance is where they came from; a definition never holds a
 * copy, so a prefab can never contain itself) and keep their local ids.
 */
function capturePrefabEntities(
  input: OpInput,
  catalog: ContentCatalog,
  prefabId: string,
  sourceEntityId: string,
  previous?: PrefabDefinition,
): { ok: true; entities: PrefabEntity[]; depth: number; nextLocalNumber?: number } | { ok: false; error: CommandError } {
  const scene = input.scene;
  const indexById = new Map(scene.entities.map((e) => [e.id, e]));
  if (!indexById.has(sourceEntityId)) return { ok: false, error: entityNotFound(sourceEntityId) };

  // The subtree closure in scene document order (parent before child).
  const closureIds = subtreeInDocumentOrder(scene, sourceEntityId);
  if (closureIds === null) return { ok: false, error: entityNotFound(sourceEntityId) };
  const closureSet = new Set(closureIds);
  const closure = closureIds.map((id) => indexById.get(id) as EntityV3);

  // Forbidden capture contents (a v3 scene's camera, nested instance, external ref).
  const v4 = scene.schemaVersion === 4;
  for (const e of closure) {
    if (!v4 && e.components.camera !== undefined) {
      return { ok: false, error: prefabCameraCaptureForbidden(sourceEntityId, e.id) };
    }
  }
  const prefabInstanceIds = closure
    .filter((e) => e.components.prefab !== undefined && !isPrefabLink(e.components.prefab as unknown) && (previous === undefined || e.components.prefab.prefabId !== prefabId))
    .map((e) => e.id);
  if (prefabInstanceIds.length > 0) {
    return { ok: false, error: prefabNestedForbidden(sourceEntityId, prefabInstanceIds) };
  }
  if (previous !== undefined) {
    // Another copy of the same prefab below the source (its root names the
    // prefab's root part, which never changes) would be captured as more
    // parts of one copy: the prefab would come to hold itself.
    const rootLocal = (previous.entities[0] as PrefabEntity).localId;
    const otherCopies = closure
      .slice(1)
      .filter((e) => e.components.prefab?.prefabId === prefabId && e.components.prefab.localId === rootLocal)
      .map((e) => e.id);
    if (otherCopies.length > 0) return { ok: false, error: prefabNestedForbidden(sourceEntityId, otherCopies, prefabId) };
  }
  const external = firstExternalEntityRef(closure.map(captureView), entityRefKeysByBehavior(catalog.behaviors));
  if (external !== null) {
    return {
      ok: false,
      error: prefabExternalReferenceForbidden(sourceEntityId, external.localId, external.key, external.entityId),
    };
  }
  // A v3 definition carries transform/model/box/behavior only. A v4 one
  // carries what a scene object can (`PREFAB_V4_COMPONENTS`: a player, its
  // camera, lights), less what the scene itself holds; those are refused
  // rather than silently dropped.
  for (const e of closure) {
    const comps = e.components as unknown as Record<string, unknown>;
    const refused = v4 ? PREFAB_EXCLUDED_COMPONENTS.find((c) => comps[c] !== undefined) : (['collider', 'controller'] as const).find((c) => comps[c] !== undefined);
    if (refused !== undefined) return { ok: false, error: prefabComponentForbidden(prefabId, e.id, refused) };
  }

  if (closure.length > MAX_PREFAB_ENTITIES) {
    return { ok: false, error: limitsExceeded('prefab_entities', closure.length, MAX_PREFAB_ENTITIES) };
  }
  let localOf = new Map(closureIds.map((id) => [id, id]));
  let nextLocalNumber: number | undefined;
  if (previous !== undefined) {
    const named = updateLocalIds(closure, prefabId, previous);
    if (!named.ok) return { ok: false, error: idExhaustion(named.prefix) };
    localOf = named.localOf;
    nextLocalNumber = named.nextLocalNumber;
  }
  const entities = prefabEntitiesOf(scene, catalog, closure, closureSet, localOf);
  const depth = prefabDepth(entities);
  if (depth > MAX_PREFAB_DEPTH) {
    return { ok: false, error: limitsExceeded('prefab_depth', depth, MAX_PREFAB_DEPTH) };
  }
  return { ok: true, entities, depth, ...(nextLocalNumber !== undefined ? { nextLocalNumber } : {}) };
}

/**
 * Scene objects as prefab objects, under the local ids `localOf` gives
 * them: references inside the set name local ids; a linked copy among them
 * becomes a nested copy (its overrides kept, its scene ids not); an object
 * hanging from a copy's part hangs from that part of the nested copy. The
 * first object's parent is `rootParent` (absent: it is the prefab's root).
 */
export function prefabEntitiesOf(
  scene: SceneDocument,
  catalog: ContentCatalog,
  closure: readonly EntityV3[],
  closureSet: ReadonlySet<string>,
  localOf: ReadonlyMap<string, string>,
  rootParent?: string,
): PrefabEntity[] {
  const refKeys = entityRefKeysByBehavior(catalog.behaviors);
  // Each object keeps the tags it has in the scene (folder tags included: a copy has no folder to inherit them from).
  const flags = effectiveEntityFlags(scene.entities);
  const v4 = scene.schemaVersion === 4;
  const rootKeyOf = (prefabId: string): string | undefined => catalog.prefabs.find((d) => d.prefabId === prefabId)?.entities[0]?.localId;
  const byId = new Map(closure.map((e) => [e.id, e]));
  return closure.map((e, i) => {
    const tags = flags.get(e.id)?.tags ?? 0;
    const link = (e.components as { prefab?: unknown }).prefab;
    let components: PrefabComponentsV2;
    if (isPrefabLink(link)) {
      // A nested copy keeps what it overrides; the scene ids its parts had are the scene's, not the prefab's.
      const nested = { prefabId: link.prefabId, ...(link.overrides !== undefined && link.overrides.length > 0 ? { overrides: deepClone(link.overrides) } : {}) };
      components = { transform: cloneTransform(e.components.transform), prefab: nested } as unknown as PrefabComponentsV2;
    } else {
      components = { transform: cloneTransform(e.components.transform) as unknown as PrefabComponentsV2['transform'] };
      if (e.components.model !== undefined) components.model = deepClone(e.components.model);
      if (e.components.box !== undefined) components.box = deepClone(e.components.box);
      if (e.components.behavior !== undefined) {
        const behavior = deepClone(e.components.behavior);
        // References inside the subtree name local ids.
        for (const key of refKeys.get(behavior.behaviorId) ?? []) {
          const v = behavior.values[key];
          if (typeof v === 'string' && localOf.has(v)) behavior.values[key] = localOf.get(v) as string;
        }
        components.behavior = behavior;
      }
      if (v4) {
        const source = e.components as unknown as Record<string, unknown>;
        for (const name of PREFAB_V4_COMPONENTS) {
          if (source[name] !== undefined) (components as unknown as Record<string, unknown>)[name] = deepClone(source[name]);
        }
        // A camera's target (any object reference) inside the set names its local id.
        mapComponentRefs(components as unknown as Record<string, unknown>, (id) => (closureSet.has(id) ? localOf.get(id) : undefined));
      }
    }
    let parentLocalId = e.parentId !== undefined && closureSet.has(e.parentId) ? localOf.get(e.parentId) : undefined;
    const part = (e as unknown as { parentPart?: unknown }).parentPart;
    const parent = e.parentId !== undefined ? byId.get(e.parentId) : undefined;
    const parentLink = (parent?.components as { prefab?: unknown } | undefined)?.prefab;
    if (parentLocalId !== undefined && typeof part === 'string' && isPrefabLink(parentLink) && part !== rootKeyOf(parentLink.prefabId)) parentLocalId = `${parentLocalId}/${part}`;
    if (i === 0 && rootParent !== undefined) parentLocalId = rootParent;
    return {
      localId: localOf.get(e.id) as string,
      ...(e.name !== undefined ? { name: e.name } : {}),
      ...(parentLocalId !== undefined ? { parentLocalId } : {}),
      ...(tags !== 0 ? { tags } : {}),
      components,
    };
  });
}

export function displayNameError(displayName: string): CommandError {
  return fieldValue(
    '/args/displayName',
    displayName,
    'string, 1-128 chars, no control characters',
    'displayName must be 1-128 characters without control characters',
  );
}

// ---- createPrefab ----------------------------------------------------------

export function applyCreatePrefab(input: OpInput, args: CreatePrefabArgs): OpOutcome {
  const catalog = contentOf(input.content);
  const scene = input.scene;

  // prefabId syntax and uniqueness.
  if (!ID_RE.test(args.prefabId)) {
    return { ok: false, error: idInvalid('/args/prefabId', args.prefabId, ID_EXPECTED) };
  }
  if (catalog.prefabs.some((d) => d.prefabId === args.prefabId)) {
    return { ok: false, error: prefabIdDuplicate(args.prefabId) };
  }
  if (!isValidName(args.displayName)) return { ok: false, error: displayNameError(args.displayName) };
  const captured = capturePrefabEntities(input, catalog, args.prefabId, args.sourceEntityId);
  if (!captured.ok) return captured;
  const definition: PrefabDefinition = {
    prefabId: args.prefabId,
    displayName: args.displayName,
    createdRevision: input.revision,
    entityCount: captured.entities.length,
    depth: captured.depth,
    entities: captured.entities,
  };
  const bytes = canonicalBytes(definition);
  if (bytes > MAX_PREFAB_BYTES) {
    return { ok: false, error: limitsExceeded('prefab_bytes', bytes, MAX_PREFAB_BYTES) };
  }

  // Resulting-state validation (three-block when a manifest is
  // available) + the uniform no-change check over scene AND content.
  const nextContent: ContentCatalog = { ...catalog, prefabs: [...catalog.prefabs, definition] };
  const gate = gateResultState(
    { scene, content: catalog, manifest: input.manifest },
    { ...scene, revision: scene.revision + 1 },
    nextContent,
  );
  if (!gate.ok) return gate;

  const canonical = (gate.content?.prefabs.find((d) => d.prefabId === args.prefabId) ??
    definition) as PrefabDefinition;
  const change: CreatePrefabChange = {
    type: 'createPrefab',
    prefabId: args.prefabId,
    definition: deepClone(canonical),
  };
  return {
    ok: true,
    op: {
      scene: gate.scene,
      content: gate.content,
      change,
      inverse: { kind: 'removePrefab', prefabId: args.prefabId },
    },
  };
}

// ---- updatePrefab ----------------------------------------------------------

/**
 * Replace a prefab's contents with the subtree under `fromEntity`, keeping
 * its id (scripts that spawn it by name spawn the new contents) and its
 * name unless one is given; without `fromEntity` the contents stay (a rename). Copies already placed or spawned are
 * independent and keep what they have. One undo puts the old contents back.
 */
export function applyUpdatePrefab(input: OpInput, args: UpdatePrefabArgs): OpOutcome {
  const catalog = contentOf(input.content);
  const scene = input.scene;
  const previous = catalog.prefabs.find((d) => d.prefabId === args.prefabId);
  if (previous === undefined) return { ok: false, error: prefabNotFound(args.prefabId) };
  if (args.displayName !== undefined && !isValidName(args.displayName)) return { ok: false, error: displayNameError(args.displayName) };
  const captured = args.fromEntity === undefined
    ? { ok: true as const, entities: previous.entities, depth: previous.depth, nextLocalNumber: undefined }
    : capturePrefabEntities(input, catalog, args.prefabId, args.fromEntity, previous);
  if (!captured.ok) return captured;
  const replaced: PrefabDefinition = {
    prefabId: args.prefabId,
    displayName: args.displayName ?? previous.displayName,
    createdRevision: previous.createdRevision,
    entityCount: captured.entities.length,
    depth: captured.depth,
    entities: captured.entities,
  };
  // The same contents again are no change (the revision and the part
  // counter alone would make one).
  const { updatedRevision: _was, nextLocalNumber: _counted, ...unrevised } = previous;
  const same = JSON.stringify(canonicalPrefabs([replaced])) === JSON.stringify(canonicalPrefabs([unrevised]));
  const nextLocalNumber = captured.nextLocalNumber ?? nextLocalNumberOf(previous);
  const definition: PrefabDefinition = same ? previous : { ...replaced, updatedRevision: input.revision, nextLocalNumber };
  const bytes = canonicalBytes(definition);
  if (bytes > MAX_PREFAB_BYTES) {
    return { ok: false, error: limitsExceeded('prefab_bytes', bytes, MAX_PREFAB_BYTES) };
  }
  const nextContent: ContentCatalog = {
    ...catalog,
    prefabs: catalog.prefabs.map((d) => (d.prefabId === args.prefabId ? definition : d)),
  };
  // A captured copy of a prefab that holds this one (or of this one) would make it contain itself.
  const cycle = prefabNestingCycles(nextContent.prefabs).get(args.prefabId);
  if (cycle !== undefined) return { ok: false, error: prefabCycle(args.prefabId, cycle) };
  const gate = gateResultState(
    { scene, content: catalog, manifest: input.manifest },
    { ...scene, revision: scene.revision + 1 },
    nextContent,
  );
  if (!gate.ok) return gate;
  const canonical = (gate.content?.prefabs.find((d) => d.prefabId === args.prefabId) ??
    definition) as PrefabDefinition;
  const change: UpdatePrefabChange = {
    type: 'updatePrefab',
    prefabId: args.prefabId,
    previous: deepClone(previous),
    next: deepClone(canonical),
  };
  return {
    ok: true,
    op: {
      scene: gate.scene,
      content: gate.content,
      change,
      // The undo puts the old contents back but keeps the part counter: copies
      // placed meanwhile name the new parts, whose ids stay spent.
      inverse: { kind: 'updatePrefab', prefabId: args.prefabId, restore: canonicalPrefabs([{ ...previous, nextLocalNumber }])[0] as PrefabDefinition },
    },
  };
}

// ---- instantiatePrefab ------------------------------------------------------

const pairKey = (localId: string, key: string): string => `${localId}\u0000${key}`;

/**
 * Materialize one definition entity: definition document order, root-parent
 * and internal-reference remap, root-only transform, declared overrides and
 * the informational provenance component.
 */
function buildInstanceEntity(
  de: PrefabEntity,
  index: number,
  mapping: ReadonlyMap<string, string>,
  definition: PrefabDefinition,
  parentId: string | null,
  transform: PartialTransformArgs | undefined,
  overrides: ReadonlyMap<string, PropertyValue>,
  declarations: ReadonlyMap<string, readonly DeclaredProperty[]>,
): Record<string, unknown> {
  const components: Record<string, unknown> = {};
  const t = cloneTransform(de.components.transform);
  if (index === 0 && transform !== undefined) {
    for (const f of TRANSFORM_FIELDS) {
      const v = transform[f];
      if (v !== undefined) t[f] = [...v];
    }
  }
  components['transform'] = t;
  if (de.components.model !== undefined) components['model'] = deepClone(de.components.model);
  if (de.components.box !== undefined) components['box'] = deepClone(de.components.box);
  // The v4 gameplay components travel with the copy.
  const source = de.components as unknown as Record<string, unknown>;
  for (const name of PREFAB_V4_COMPONENTS) if (source[name] !== undefined) components[name] = deepClone(source[name]);
  mapComponentRefs(components, (id) => mapping.get(id));
  const recorded = de.components.behavior;
  if (recorded !== undefined) {
    const declaration = declarations.get(recorded.behaviorId);
    // Private properties are never stored on the copy.
    const keys =
      declaration !== undefined ? declaration.filter((p) => !isPrivateProperty(p)).map((p) => p.key) : Object.keys(recorded.values);
    const byKey = new Map((declaration ?? []).map((p) => [p.key, p]));
    const values: Record<string, PropertyValue> = {};
    for (const key of keys) {
      let value: PropertyValue = Object.prototype.hasOwnProperty.call(recorded.values, key)
        ? (recorded.values[key] as PropertyValue)
        : ((byKey.get(key)?.default ?? null) as PropertyValue);
      const override = overrides.get(pairKey(de.localId, key));
      if (override !== undefined) value = override;
      if (typeof value === 'string') {
        const prop = byKey.get(key);
        // A definition entityRef names a localId; remap it once.
        if (prop?.type === 'entityRef' && mapping.has(value)) value = mapping.get(value) as string;
      }
      values[key] = value;
    }
    components['behavior'] = { behaviorId: recorded.behaviorId, values };
  }
  // Informational provenance, written only here.
  components['prefab'] = { prefabId: definition.prefabId, localId: de.localId };

  const newId = mapping.get(de.localId) as string;
  const parent =
    index === 0 ? parentId : mapping.get(de.parentLocalId as string) ?? null;
  return {
    id: newId,
    ...(de.name !== undefined ? { name: de.name } : {}),
    ...(parent !== null ? { parentId: parent } : {}),
    ...(de.tags !== undefined ? { tags: de.tags } : {}),
    components,
  };
}

export function applyInstantiatePrefab(input: OpInput, args: InstantiatePrefabArgs): OpOutcome {
  const catalog = contentOf(input.content);
  const scene = input.scene;

  // The definition resolves.
  const definition = catalog.prefabs.find((d) => d.prefabId === args.prefabId);
  if (definition === undefined) return { ok: false, error: prefabNotFound(args.prefabId) };

  // step 3: parentId resolves.
  const parentId = args.parentId ?? null;
  const byId = new Map(scene.entities.map((e) => [e.id, e]));
  if (parentId !== null && !byId.has(parentId)) {
    return { ok: false, error: referenceMissing(parentId) };
  }

  // step 5: overrides resolve and type-check against the definition's
  // recorded behavior components and the current declarations.
  const localIds = new Set(definition.entities.map((e) => e.localId));
  const declarations = new Map<string, readonly DeclaredProperty[]>(
    catalog.behaviors.map((b) => [b.behaviorId, b.declaration.properties]),
  );
  const ctx: ValueContext = {
    entityIds: new Set([...localIds, ...byId.keys()]),
    assetIds: new Set(catalog.assets.map((a) => a.assetId)),
  };
  const overrides = new Map<string, PropertyValue>();
  for (const override of args.overrides ?? []) {
    const de = definition.entities.find((e) => e.localId === override.localId);
    if (de === undefined) {
      return { ok: false, error: prefabLocalUnknown(args.prefabId, override.localId) };
    }
    const behavior: BehaviorComponent | undefined = de.components.behavior;
    const declaration = behavior !== undefined ? declarations.get(behavior.behaviorId) : undefined;
    const prop = declaration?.find((p) => p.key === override.key);
    if (prop === undefined) {
      return { ok: false, error: propertyOverrideUnknown(behavior?.behaviorId, override.key) };
    }
    // A private property is not overridable per copy.
    if (isPrivateProperty(prop)) return { ok: false, error: propertyPrivate(behavior?.behaviorId, override.key) };
    const checked = checkOverrideValue(prop, override.key, override.value, ctx, args.prefabId);
    if (!checked.ok) return checked;
    overrides.set(pairKey(override.localId, override.key), override.value);
  }

  // step 6: atomic preconditions — nothing is created if any fails.
  const parentDepth = parentId === null ? 0 : sceneEntityDepth(scene, parentId);
  const resultingDepth = parentDepth + definition.depth;
  if (resultingDepth > MAX_SCENE_DEPTH) {
    return { ok: false, error: limitsExceeded('depth', resultingDepth, MAX_SCENE_DEPTH) };
  }
  const used = new Set<string>([...byId.keys(), ...(input.reservedIds ?? [])]);
  const mapping = new Map<string, string>();
  for (const de of definition.entities) {
    const prefix = idPrefix(de.components);
    const id = nextFreeEntityId(used, prefix);
    if (id === undefined) return { ok: false, error: idExhaustion(prefix) };
    used.add(id);
    mapping.set(de.localId, id);
  }

  // step 7: one transaction — all entries appended at the end, one family at
  // a time, in definition document order (preserves parent-before-child).
  const built: { index: number; entity: Record<string, unknown> }[] = definition.entities.map(
    (de, i) => ({
      index: scene.entities.length + i,
      entity: buildInstanceEntity(
        de,
        i,
        mapping,
        definition,
        parentId,
        args.transform,
        overrides,
        declarations,
      ),
    }),
  );
  const resultScene = {
    ...scene,
    revision: scene.revision + 1,
    entities: [...scene.entities, ...built.map((b) => b.entity)],
  };
  const gate = gateResultState({ scene, content: catalog, manifest: input.manifest }, resultScene, catalog);
  if (!gate.ok) return gate;

  const canonicalEntries: InstantiatePrefabEntry[] = built.map((b) => ({
    index: b.index,
    entity: deepClone(gate.scene.entities[b.index] as EntityV3),
  }));
  const mappingList = definition.entities.map((de) => ({
    localId: de.localId,
    entityId: mapping.get(de.localId) as string,
  }));
  const rootId = mapping.get(definition.entities[0]!.localId) as string;
  const change: InstantiatePrefabChange = {
    type: 'instantiatePrefab',
    prefabId: args.prefabId,
    rootId,
    entries: canonicalEntries,
    mapping: mappingList,
  };
  return {
    ok: true,
    op: {
      scene: gate.scene,
      // Content is unchanged (provenance is in the scene).
      change,
      // One undo removes the whole subtree; redo re-inserts the
      // recorded entries with their recorded IDs (no re-allocation).
      inverse: { kind: 'delete', rootId },
    },
  };
}

/** Exported for tests/diagnostics: the canonical bytes of a definition value. */
export function prefabDefinitionBytes(definition: PrefabDefinition): number {
  return canonicalBytes(definition);
}

export { prefabDepth as prefabDefinitionDepth };
