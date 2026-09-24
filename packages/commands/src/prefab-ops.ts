/**
 * Prefab M2 mutation ops — commands.md §8.6 (`createPrefab`) and §8.7
 * (`instantiatePrefab`), packet 22.
 *
 * `createPrefab` captures a selected scene subtree into an immutable
 * `PrefabDefinition` (project-model §20.2); `instantiatePrefab` materializes
 * independent copies in **one transaction** — a complete subtree, every
 * local entity/reference ID remapped exactly once, with the exact mapping
 * recorded in the durable result. Both ops run the accepted §6.1 pipeline and
 * the shared pure history engine: nothing here reads files, mutates the
 * workspace, or provides a second mutation path.
 *
 * Copy semantics are explicit (project-model §20.1): definitions are
 * materialized, never inherited; there is no live link, no propagation, no
 * variants and no structural overrides. `components.prefab` is informational
 * provenance written only here.
 */

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
  entityNotFound,
  fieldValue,
  idExhaustion,
  idInvalid,
  isValidName,
  limitsExceeded,
  prefabCameraCaptureForbidden,
  prefabComponentForbidden,
  prefabExternalReferenceForbidden,
  prefabIdDuplicate,
  prefabLocalUnknown,
  prefabNestedForbidden,
  prefabNotFound,
  propertyOverrideUnknown,
  referenceMissing,
} from './errors';
import { contentOf, type OpInput } from './content-ops';
import { checkOverrideValue, type ValueContext } from './properties';
import { deepClone, gateResultState, type OpOutcome } from './ops';
import type {
  CreatePrefabArgs,
  CreatePrefabChange,
  InstantiatePrefabArgs,
  InstantiatePrefabChange,
  InstantiatePrefabEntry,
  PartialTransformArgs,
  SceneDocument,
} from './types';

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ID_EXPECTED = 'project-model ID syntax: [a-z0-9][a-z0-9_-]{0,63}';

/** §20.3 definition/instantiation limits (project-model). */
const MAX_PREFAB_ENTITIES = 256;
const MAX_PREFAB_DEPTH = 16;
const MAX_PREFAB_BYTES = 131_072;
const MAX_PREFABS = 128;
const MAX_SCENE_ENTITIES = 1024;
/** Phase 12 (c): a v4 scene holds up to 16384 entities (as createEntity / pasteEntities). */
const MAX_SCENE_ENTITIES_V4 = 16_384;
const MAX_SCENE_DEPTH = 32;
const ID_MAX = 9999;

const TRANSFORM_FIELDS = ['position', 'rotation', 'scale'] as const;

function utf8Length(text: string): number {
  let n = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) as number;
    n += c <= 0x7f ? 1 : c <= 0x7ff ? 2 : c <= 0xffff ? 3 : 4;
  }
  return n;
}

function canonicalBytes(value: unknown): number {
  return utf8Length(JSON.stringify(value, null, 2) + '\n');
}

/** §8.7.2 prefix derivation: model, else box, else group. */
function idPrefix(components: PrefabComponentsV2): 'model' | 'box' | 'group' {
  if (components.model !== undefined) return 'model';
  if (components.box !== undefined) return 'box';
  return 'group';
}

/** §8.7.2: the smallest free `NNNN` for `prefix`, scoped to the used set. */
export function nextFreeEntityId(
  used: ReadonlySet<string>,
  prefix: string,
): string | undefined {
  for (let n = 1; n <= ID_MAX; n++) {
    const id = `${prefix}-${String(n).padStart(4, '0')}`;
    if (!used.has(id)) return id;
  }
  return undefined;
}

/** §20.2 definition depth (definition root = 1). */
function prefabDepth(entities: readonly PrefabEntity[]): number {
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
function sceneEntityDepth(scene: SceneDocument, id: string): number {
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
function subtreeInDocumentOrder(scene: SceneDocument, rootId: string): string[] | null {
  const byId = new Map(scene.entities.map((e) => [e.id, e]));
  if (!byId.has(rootId)) return null;
  const children = new Map<string, string[]>();
  for (const e of scene.entities) {
    if (e.parentId !== undefined) {
      const list = children.get(e.parentId) ?? [];
      list.push(e.id);
      children.set(e.parentId, list);
    }
  }
  const set = new Set<string>();
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (set.has(id)) continue;
    set.add(id);
    const kids = children.get(id);
    if (kids !== undefined) for (const k of kids) stack.push(k);
  }
  // Document order (== parent-before-child for a valid scene, §11.1).
  return scene.entities.filter((e) => set.has(e.id)).map((e) => e.id);
}

/** §8.6.3: the first external `entityRef` value in the closure, or null. */
function findExternalReference(
  closure: readonly EntityV3[],
  closureSet: ReadonlySet<string>,
  catalog: ContentCatalog,
): { localId: string; key: string; entityId: string } | null {
  const refKeys = new Map<string, string[]>();
  for (const b of catalog.behaviors) {
    refKeys.set(
      b.behaviorId,
      b.declaration.properties.filter((p) => p.type === 'entityRef').map((p) => p.key),
    );
  }
  for (const e of closure) {
    const behavior = e.components.behavior;
    if (behavior === undefined) continue;
    const keys = refKeys.get(behavior.behaviorId);
    if (keys === undefined) continue;
    for (const key of keys) {
      const v = behavior.values[key];
      if (typeof v === 'string' && !closureSet.has(v)) {
        return { localId: e.id, key, entityId: v };
      }
    }
  }
  return null;
}

function cloneTransform(t: EntityV3['components']['transform']): Record<string, number[]> {
  return {
    position: [...t.position],
    rotation: [...t.rotation],
    scale: [...t.scale],
  };
}

// ---- createPrefab (§8.6) ----------------------------------------------------------

export function applyCreatePrefab(input: OpInput, args: CreatePrefabArgs): OpOutcome {
  const catalog = contentOf(input.content);
  const scene = input.scene;

  // §8.6.2 step 2: prefabId syntax and uniqueness.
  if (!ID_RE.test(args.prefabId)) {
    return { ok: false, error: idInvalid('/args/prefabId', args.prefabId, ID_EXPECTED) };
  }
  if (catalog.prefabs.some((d) => d.prefabId === args.prefabId)) {
    return { ok: false, error: prefabIdDuplicate(args.prefabId) };
  }
  // step 3: displayName shape.
  if (!isValidName(args.displayName)) {
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
  // step 4: sourceEntityId resolves.
  const indexById = new Map(scene.entities.map((e) => [e.id, e]));
  const source = indexById.get(args.sourceEntityId) as EntityV3 | undefined;
  if (source === undefined) return { ok: false, error: entityNotFound(args.sourceEntityId) };

  // step 5: subtree closure in scene document order (parent before child).
  const closureIds = subtreeInDocumentOrder(scene, args.sourceEntityId);
  if (closureIds === null) return { ok: false, error: entityNotFound(args.sourceEntityId) };
  const closureSet = new Set(closureIds);
  const closure = closureIds.map((id) => indexById.get(id) as EntityV3);

  // step 6: forbidden capture contents (camera, nested instance, external ref).
  for (const e of closure) {
    if (e.components.camera !== undefined) {
      return {
        ok: false,
        error: prefabCameraCaptureForbidden(args.sourceEntityId, e.id),
      };
    }
  }
  const prefabInstanceIds = closure.filter((e) => e.components.prefab !== undefined).map((e) => e.id);
  if (prefabInstanceIds.length > 0) {
    return { ok: false, error: prefabNestedForbidden(args.sourceEntityId, prefabInstanceIds) };
  }
  const external = findExternalReference(closure, closureSet, catalog);
  if (external !== null) {
    return {
      ok: false,
      error: prefabExternalReferenceForbidden(
        args.sourceEntityId,
        external.localId,
        external.key,
        external.entityId,
      ),
    };
  }
  // A definition entity may carry transform/model/box/behavior only (§20.2):
  // collider/controller are not part of the definition vocabulary in M2 and
  // are rejected rather than silently dropped.
  for (const e of closure) {
    for (const component of ['collider', 'controller'] as const) {
      if ((e.components as unknown as Record<string, unknown>)[component] !== undefined) {
        return {
          ok: false,
          error: prefabComponentForbidden(args.prefabId, e.id, component),
        };
      }
    }
  }

  // step 7: bounds.
  if (closure.length > MAX_PREFAB_ENTITIES) {
    return {
      ok: false,
      error: limitsExceeded('prefab_entities', closure.length, MAX_PREFAB_ENTITIES),
    };
  }
  const entities: PrefabEntity[] = closure.map((e) => {
    const components: PrefabComponentsV2 = {
      transform: cloneTransform(e.components.transform) as unknown as PrefabComponentsV2['transform'],
    };
    if (e.components.model !== undefined) components.model = deepClone(e.components.model);
    if (e.components.box !== undefined) components.box = deepClone(e.components.box);
    if (e.components.behavior !== undefined) components.behavior = deepClone(e.components.behavior);
    const parentLocalId =
      e.parentId !== undefined && closureSet.has(e.parentId) ? e.parentId : undefined;
    return {
      localId: e.id,
      ...(e.name !== undefined ? { name: e.name } : {}),
      ...(parentLocalId !== undefined ? { parentLocalId } : {}),
      components,
    };
  });
  const depth = prefabDepth(entities);
  if (depth > MAX_PREFAB_DEPTH) {
    return { ok: false, error: limitsExceeded('prefab_depth', depth, MAX_PREFAB_DEPTH) };
  }
  // step 8: the definition value.
  const definition: PrefabDefinition = {
    prefabId: args.prefabId,
    displayName: args.displayName,
    createdRevision: input.revision,
    entityCount: entities.length,
    depth,
    entities,
  };
  const bytes = canonicalBytes(definition);
  if (bytes > MAX_PREFAB_BYTES) {
    return { ok: false, error: limitsExceeded('prefab_bytes', bytes, MAX_PREFAB_BYTES) };
  }
  if (catalog.prefabs.length + 1 > MAX_PREFABS) {
    return {
      ok: false,
      error: limitsExceeded('prefabs', catalog.prefabs.length + 1, MAX_PREFABS),
    };
  }

  // step 9: resulting-state validation (three-block when a manifest is
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

// ---- instantiatePrefab (§8.7) ------------------------------------------------------

const pairKey = (localId: string, key: string): string => `${localId}\u0000${key}`;

/**
 * Materialize one definition entity: definition document order, root-parent
 * and internal-reference remap, root-only transform, declared overrides and
 * the informational provenance component (§8.7.2–§8.7.4).
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
  const recorded = de.components.behavior;
  if (recorded !== undefined) {
    const declaration = declarations.get(recorded.behaviorId);
    const keys =
      declaration !== undefined ? declaration.map((p) => p.key) : Object.keys(recorded.values);
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
        // §20.5: a definition entityRef names a localId; remap it once.
        if (prop?.type === 'entityRef' && mapping.has(value)) value = mapping.get(value) as string;
      }
      values[key] = value;
    }
    components['behavior'] = { behaviorId: recorded.behaviorId, values };
  }
  // §8.7.4 step 4: informational provenance, written only here.
  components['prefab'] = { prefabId: definition.prefabId, localId: de.localId };

  const newId = mapping.get(de.localId) as string;
  const parent =
    index === 0 ? parentId : mapping.get(de.parentLocalId as string) ?? null;
  return {
    id: newId,
    ...(de.name !== undefined ? { name: de.name } : {}),
    ...(parent !== null ? { parentId: parent } : {}),
    components,
  };
}

export function applyInstantiatePrefab(input: OpInput, args: InstantiatePrefabArgs): OpOutcome {
  const catalog = contentOf(input.content);
  const scene = input.scene;

  // §8.7.5 step 2: the definition resolves.
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
    const checked = checkOverrideValue(prop, override.key, override.value, ctx, args.prefabId);
    if (!checked.ok) return checked;
    overrides.set(pairKey(override.localId, override.key), override.value);
  }

  // step 6: atomic preconditions — nothing is created if any fails.
  const totalEntities = scene.entities.length + definition.entities.length;
  const maxEntities = scene.schemaVersion === 4 ? MAX_SCENE_ENTITIES_V4 : MAX_SCENE_ENTITIES;
  if (totalEntities > maxEntities) {
    return { ok: false, error: limitsExceeded('entities', totalEntities, maxEntities) };
  }
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
      // Content is unchanged (provenance lives in the scene).
      change,
      // §8.7.6/§9.1: one undo removes the whole subtree; redo re-inserts the
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
