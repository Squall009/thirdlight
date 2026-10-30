/**
 * The linked-copy commands: placing a linked copy, reverting a copy's
 * overrides, applying them to the prefab, unpacking a copy and making a
 * variant. Editing a copy's parts is the ordinary commands, stored as
 * overrides (`prefab-copy-edit.ts`).
 *
 * Every one runs the one mutation pipeline and stores one change (one undo
 * step). Applying is proven like linking: the copy that applies must
 * assemble to exactly the objects it had, so an apply never changes what the
 * applying copy looks like, only what the prefab (and so every other copy)
 * holds.
 */
import { canonicalJsonKey } from '@thirdlight/shared';
import {
  ID_RE,
  applyPartField,
  isPrefabLink,
  mapRefsInValue,
  prefabNestingCycles,
  ENTITY_ID_MAX,
  MAX_ENTITY_DEPTH as MAX_SCENE_DEPTH,
  MAX_PREFAB_BYTES,
  entityIdAt,
  type ContentCatalog,
  type DeclaredProperty,
  type EntityV3,
  type PrefabDefinition,
  type PrefabEntity,
  type PrefabLinkComponent,
  type PrefabOverride,
  type PropertyValue,
} from '@thirdlight/project-model';

import {
  entityNotFound,
  idExhaustion,
  idInvalid,
  isValidName,
  limitsExceeded,
  noChangeContent,
  prefabCopyRequired,
  prefabCycle,
  prefabIdDuplicate,
  prefabLocalUnknown,
  prefabNotFound,
  prefabOverrideUnsupported,
  propertyOverrideUnknown,
  propertyPrivate,
  referenceMissing,
  type CommandError,
} from './errors';
import { contentOf, type OpInput } from './content-ops';
import { deepClone, gateResultState, type OpOutcome } from './ops';
import { catalogAssembler, expandCopies, locateCopies, storeLinkEdit, type CopyLocator } from './prefab-copy-edit';
import {
  applyCreatePrefab,
  applyInstantiatePrefab,
  applyUpdatePrefab,
  canonicalBytes,
  displayNameError,
  idPrefix,
  nextFreeEntityId,
  nextLocalNumberOf,
  prefabDepth,
  prefabEntitiesOf,
  sceneEntityDepth,
  subtreeInDocumentOrder,
} from './prefab-ops';
import { checkOverrideValue, isPrivateProperty, type ValueContext } from './properties';
import type { CreatePrefabVariantArgs, PrefabOverrideTargetArgs, UnpackPrefabArgs } from './prefab-link-types';
import type { CreatePrefabChange, InstantiatePrefabArgs, InstantiatePrefabChange, UpdatePrefabArgs } from './types';

type Obj = Record<string, unknown>;
const ID_EXPECTED = 'project-model ID syntax: [a-z0-9][a-z0-9_-]{0,63}';
const linkOf = (e: { components: object }): PrefabLinkComponent => (e.components as { prefab: PrefabLinkComponent }).prefab;

function declarationsOf(catalog: ContentCatalog): Map<string, readonly DeclaredProperty[]> {
  return new Map(catalog.behaviors.map((b) => [b.behaviorId, b.declaration.properties]));
}

// ---- instantiatePrefab: a linked copy ------------------------------------------

/**
 * Place one linked copy: a single object naming the prefab, its placement and
 * the property values given as overrides. Its parts are the prefab's, with
 * ids derived from the copy's; one undo removes it.
 */
export function applyInstantiateLinked(input: OpInput, args: InstantiatePrefabArgs): OpOutcome {
  const catalog = contentOf(input.content);
  const definition = catalog.prefabs.find((d) => d.prefabId === args.prefabId);
  if (definition === undefined) return { ok: false, error: prefabNotFound(args.prefabId) };
  const scene = input.scene;
  const parentId = args.parentId ?? null;
  const byId = new Map(scene.entities.map((e) => [e.id, e]));
  if (parentId !== null && !byId.has(parentId)) return { ok: false, error: referenceMissing(parentId) };
  const assembler = catalogAssembler(input.content);
  const root = definition.entities[0] as PrefabEntity;
  const transform = deepClone(root.components.transform) as unknown as Record<string, number[]>;
  for (const f of ['position', 'rotation', 'scale'] as const) {
    const v = args.transform?.[f];
    if (v !== undefined) transform[f] = [...v];
  }
  // The prefab as a copy makes it (variants and nested copies included): what overrides may name, and the id prefix.
  const trial = assembler.assembleCopy({ id: 'copy', components: { transform, prefab: { prefabId: definition.prefabId } } });
  const fatal = trial.problems.find((p) => p.code === 'prefab_missing' || p.code === 'prefab_cycle');
  if (fatal !== undefined) return { ok: false, error: prefabOverrideUnsupported(definition.prefabId, fatal.message) };
  const partOf = new Map([...trial.partIds].map(([key, id]) => [key, trial.entities.find((e) => e.id === id) as Obj]));
  const declarations = declarationsOf(catalog);
  const ctx: ValueContext = { entityIds: new Set([...partOf.keys(), ...byId.keys()]), assetIds: new Set(catalog.assets.map((a) => a.assetId)) };
  const pending: { key: string; prop: DeclaredProperty; value: PropertyValue }[] = [];
  for (const o of args.overrides ?? []) {
    const part = partOf.get(o.localId);
    if (part === undefined) return { ok: false, error: prefabLocalUnknown(args.prefabId, o.localId) };
    const behavior = (part['components'] as { behavior?: { behaviorId: string } }).behavior;
    const prop = behavior !== undefined ? declarations.get(behavior.behaviorId)?.find((p) => p.key === o.key) : undefined;
    if (prop === undefined) return { ok: false, error: propertyOverrideUnknown(behavior?.behaviorId, o.key) };
    if (isPrivateProperty(prop)) return { ok: false, error: propertyPrivate(behavior?.behaviorId, o.key) };
    const checked = checkOverrideValue(prop, o.key, o.value, ctx, args.prefabId);
    if (!checked.ok) return checked;
    pending.push({ key: o.localId, prop, value: o.value });
  }
  const depthOf = new Map<string, number>();
  for (const e of trial.entities) depthOf.set(e.id, e.parentId !== undefined && depthOf.has(e.parentId) ? (depthOf.get(e.parentId) as number) + 1 : 1);
  const resultingDepth = (parentId === null ? 0 : sceneEntityDepth(scene, parentId)) + Math.max(...depthOf.values());
  if (resultingDepth > MAX_SCENE_DEPTH) return { ok: false, error: limitsExceeded('depth', resultingDepth, MAX_SCENE_DEPTH) };
  // A copy's id gives every part's id: the first free one whose parts' ids are free too.
  const used = new Set<string>([...byId.keys(), ...(input.reservedIds ?? [])]);
  const prefix = idPrefix(trial.entities[0]!.components as never);
  for (;;) {
    const id = nextFreeEntityId(used, prefix);
    if (id === undefined) return { ok: false, error: idExhaustion(prefix) };
    used.add(id);
    const made = assembler.assembleCopy({ id, components: { transform, prefab: { prefabId: definition.prefabId } } });
    if ([...made.partIds.values()].some((pid) => pid !== id && used.has(pid))) continue;
    // A property value naming a part of the prefab names that part of this copy.
    const overrides: PrefabOverride[] = pending.map((p) => ({
      part: p.key,
      path: `components/behavior/values/${p.prop.key}`,
      value: p.prop.type === 'entityRef' && typeof p.value === 'string' && made.partIds.has(p.value) ? (made.partIds.get(p.value) as string) : p.value,
    }));
    const entity = { id, ...(parentId !== null ? { parentId } : {}), components: { transform, prefab: { prefabId: definition.prefabId, ...(overrides.length > 0 ? { overrides } : {}) } } };
    const resultScene = { ...scene, revision: scene.revision + 1, entities: [...scene.entities, entity] };
    const gate = gateResultState({ scene, content: catalog, manifest: input.manifest }, resultScene, catalog);
    if (!gate.ok) return gate;
    const index = scene.entities.length;
    const change: InstantiatePrefabChange = {
      type: 'instantiatePrefab',
      prefabId: args.prefabId,
      rootId: id,
      entries: [{ index, entity: deepClone(gate.scene.entities[index] as EntityV3) }],
      mapping: [...made.partIds].map(([localId, entityId]) => ({ localId, entityId })),
    };
    return { ok: true, op: { scene: gate.scene, change, inverse: { kind: 'delete', rootId: id } } };
  }
}

// ---- naming a copy's overrides ---------------------------------------------------

interface Target {
  loc: CopyLocator;
  copyId: string;
  root: EntityV3;
  link: PrefabLinkComponent;
  rootKey: string;
  /** The part named (absent: every override of the copy). */
  key?: string;
  path?: string;
}

/** The copy (and part and field) a revert or apply names. */
function resolveTarget(input: OpInput, args: PrefabOverrideTargetArgs): { ok: true; target: Target } | { ok: false; error: CommandError } {
  const loc = locateCopies(input.scene, input.content);
  const found = loc?.find(args.entityId) ?? null;
  if (loc === null || found === null) {
    return { ok: false, error: input.scene.entities.some((e) => e.id === args.entityId) ? prefabCopyRequired(args.entityId) : entityNotFound(args.entityId) };
  }
  const root = loc.links.get(found.copyId) as EntityV3;
  const rootKey = [...loc.made(found.copyId).partIds].find(([, id]) => id === found.copyId)?.[0] as string;
  const named = args.part !== undefined || args.path !== undefined || !found.root;
  const target: Target = { loc, copyId: found.copyId, root, link: linkOf(root), rootKey };
  if (args.all !== true && named) {
    target.key = args.part ?? found.key;
    if (args.path !== undefined) target.path = args.path;
  }
  return { ok: true, target };
}

/** Whether an override is one the target names: on its part, at, under or covering its field. */
function selects(t: Target, o: PrefabOverride): boolean {
  if (t.key === undefined) return true;
  if (o.part !== t.key) return false;
  if (t.path === undefined) return true;
  if (!('path' in o)) return false;
  return o.path === t.path || o.path.startsWith(`${t.path}/`) || t.path.startsWith(`${o.path}/`);
}

/** The copy's root with these overrides (its own fields and kept ids as they are). */
function withOverrides(root: EntityV3, link: PrefabLinkComponent, overrides: readonly PrefabOverride[], partIds?: Record<string, string>): EntityV3 {
  const ids = partIds ?? link.partIds;
  const next: PrefabLinkComponent = { prefabId: link.prefabId, ...(overrides.length > 0 ? { overrides: [...overrides] } : {}), ...(ids !== undefined && Object.keys(ids).length > 0 ? { partIds: ids } : {}) };
  return { ...root, components: { ...root.components, prefab: next } } as unknown as EntityV3;
}

// ---- revertPrefabOverrides ------------------------------------------------------------

/**
 * Drop overrides from a copy: one field (`path`), one part (`part`, or a
 * part's id), or all of them. The root's own name and tags go only when
 * named (`path` "name" or "tags" on the root); objects added to the copy stay.
 */
export function applyRevertPrefabOverrides(input: OpInput, args: PrefabOverrideTargetArgs): OpOutcome {
  const r = resolveTarget(input, args);
  if (!r.ok) return r;
  const t = r.target;
  const kept = (t.link.overrides ?? []).filter((o) => !selects(t, o));
  let root = withOverrides(t.root, t.link, kept);
  if (t.key === t.rootKey && (t.path === 'name' || t.path === 'tags')) {
    const { [t.path]: _own, ...rest } = root as unknown as Obj;
    void _own;
    root = rest as unknown as EntityV3;
  }
  const entities = input.scene.entities.map((e) => (e.id === t.copyId ? root : e)) as EntityV3[];
  return storeLinkEdit(input, entities, [t.copyId]);
}

// ---- applyPrefabOverrides ------------------------------------------------------------

/** Remove a prefab entity and everything under it (direct children and parts inside nested copies under it). */
function removeDefinitionPart(def: PrefabDefinition, localId: string): void {
  const gone = new Set([localId]);
  def.entities = def.entities.filter((e) => {
    const parent = e.parentLocalId?.split('/')[0];
    if (gone.has(e.localId) || (parent !== undefined && gone.has(parent))) {
      gone.add(e.localId);
      return false;
    }
    return true;
  });
}

/** `found` paths name the same field, one under the other, or one covering the other. */
const overlaps = (a: string, b: string): boolean => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

/**
 * Write one override of a copy into its prefab: on the prefab's own part it
 * changes that part; on a part of a nested copy it becomes (or replaces) the
 * nested copy's override, by the path relative to the nested prefab. False:
 * the prefab no longer has the part or field (a stale override stays on the copy).
 */
function applyToDefinition(def: PrefabDefinition, o: PrefabOverride, catalog: ContentCatalog): boolean {
  const [first, ...rest] = o.part.split('/') as [string, ...string[]];
  const entity = def.entities.find((e) => e.localId === first);
  if (entity === undefined) return false;
  const nested = (entity.components as { prefab?: unknown }).prefab;
  const isRoot = def.entities[0] === entity;
  const own = !isPrefabLink(nested) || (rest.length === 0 && 'path' in o && (o.path === 'name' || o.path === 'tags' || o.path === 'components/transform' || o.path.startsWith('components/transform/')));
  if (!isPrefabLink(nested) && rest.length > 0) return false;
  if (!('path' in o) && rest.length === 0) {
    if (isRoot) return false;
    removeDefinitionPart(def, first);
    return true;
  }
  if (own) {
    if (!('path' in o)) return false;
    const remove = 'remove' in o && o.remove === true;
    return applyPartField(entity, o.path, remove ? undefined : deepClone((o as { value: unknown }).value), remove);
  }
  const link = nested as PrefabLinkComponent;
  const subRoot = catalog.prefabs.find((d) => d.prefabId === link.prefabId)?.entities[0]?.localId;
  if (subRoot === undefined) return false;
  const part = rest.length === 0 ? subRoot : rest.join('/');
  const moved = { ...deepClone(o), part } as PrefabOverride;
  const list = (link.overrides ?? []).filter((x) => {
    if (!('path' in moved)) return x.part !== part && !x.part.startsWith(`${part}/`);
    return !(x.part === part && 'path' in x && overlaps(x.path, moved.path) && x.path.length >= moved.path.length);
  });
  list.push(moved);
  (entity.components as { prefab: PrefabLinkComponent }).prefab = { ...link, overrides: list };
  return true;
}

/**
 * Values a copy's overrides set (object properties, component references) that name one of the copy's own
 * parts: in the prefab they name that part's local id (another copy's part
 * of the same name is its own).
 */
function localRefs(o: PrefabOverride, keyOfId: ReadonlyMap<string, string>, refKeys: ReadonlySet<string>): PrefabOverride {
  if (!('value' in o)) return o;
  const local = (v: unknown): unknown => (typeof v === 'string' && keyOfId.has(v) && !(keyOfId.get(v) as string).includes('/') ? keyOfId.get(v) : v);
  // A component reference (a camera's target) naming one of the copy's parts names it in the prefab too.
  if (!o.path.startsWith('components/behavior')) return o.path.startsWith('components/') ? { ...o, value: mapRefsInValue(o.path.slice('components/'.length), o.value, (id) => local(id) as string) } : o;
  const segs = o.path.split('/');
  if (segs.length === 4 && segs[2] === 'values') return refKeys.has(segs[3] as string) ? { ...o, value: local(o.value) } : o;
  const mapValues = (values: unknown): unknown => {
    if (values === null || typeof values !== 'object') return values;
    const out: Obj = { ...(values as Obj) };
    for (const k of Object.keys(out)) if (refKeys.has(k)) out[k] = local(out[k]);
    return out;
  };
  if (segs.length === 3 && segs[2] === 'values') return { ...o, value: mapValues(o.value) };
  if (segs.length === 2 && o.value !== null && typeof o.value === 'object') return { ...o, value: { ...(o.value as Obj), values: mapValues((o.value as Obj)['values']) } };
  return o;
}

/**
 * Write a copy's overrides into its prefab (one field, one part, or all),
 * and, for all or for an object added to the copy, the objects added to it
 * (they become parts of the prefab and keep their ids in this copy). The
 * prefab, and so every copy of it, changes; this copy looks the same.
 */
export function applyApplyPrefabOverrides(input: OpInput, args: PrefabOverrideTargetArgs, displayName?: string): OpOutcome {
  const catalog = contentOf(input.content);
  const scene = input.scene;
  // An object added to a copy (not one of its parts), named alone, applies as a new part of that copy's prefab —
  // a linked copy added to a copy too (its own overrides apply to its own prefab with `all`, `part` or `path`).
  const stored = scene.entities.find((e) => e.id === args.entityId) as EntityV3 | undefined;
  const addedTo = stored?.parentId;
  const addedLink = addedTo !== undefined ? scene.entities.find((e) => e.id === addedTo) : undefined;
  const applyingAdded = addedLink !== undefined && isPrefabLink((addedLink.components as { prefab?: unknown }).prefab) && args.part === undefined && args.path === undefined && args.all !== true;
  const r = resolveTarget(input, applyingAdded ? { entityId: addedTo as string } : args);
  if (!r.ok) return r;
  const t = r.target;
  const original = catalog.prefabs.find((d) => d.prefabId === t.link.prefabId);
  if (original === undefined) return { ok: false, error: prefabNotFound(t.link.prefabId) };
  const def = deepClone(original);
  const made = t.loc.made(t.copyId);
  const keyOfId = new Map([...made.partIds].map(([k, id]) => [id, k]));
  const refKeys = new Set(catalog.behaviors.flatMap((b) => b.declaration.properties.filter((p) => p.type === 'entityRef').map((p) => p.key)));
  // Objects added to the copy that become parts: with `all`, every object hanging from the copy; or the one named.
  const tops = applyingAdded ? [stored as EntityV3] : t.key === undefined ? (scene.entities.filter((e) => e.parentId === t.copyId) as EntityV3[]) : [];
  const partIds: Record<string, string> = { ...(t.link.partIds ?? {}) };
  const absorbed = new Set<string>();
  /** Added copies that become nested copies, and their parts' ids. */
  const absorbedLinks = new Set<string>();
  const absorbedParts = new Set<string>();
  // New parts take local ids past every one the prefab ever gave (a dropped part's id is never another's).
  let next = nextLocalNumberOf(original);
  const taken = new Set(def.entities.map((d) => d.localId));
  const placed: { top: EntityV3; closure: EntityV3[]; closureIds: string[] }[] = [];
  for (const top of tops) {
    const closureIds = subtreeInDocumentOrder(scene, top.id) ?? [top.id];
    const closure = closureIds.map((id) => scene.entities.find((e) => e.id === id) as EntityV3);
    for (const e of closure) {
      const prefix = idPrefix(e.components as never);
      while (next <= ENTITY_ID_MAX && taken.has(entityIdAt(prefix, next))) next += 1;
      if (next > ENTITY_ID_MAX) return { ok: false, error: idExhaustion(prefix) };
      const local = entityIdAt(prefix, next);
      taken.add(local);
      keyOfId.set(e.id, local);
      next += 1;
    }
    placed.push({ top, closure, closureIds });
  }
  // A value naming a part of this copy, or an object that becomes one, names its local id in the prefab.
  const localOf = new Map([...keyOfId].filter(([, k]) => !k.includes('/')));
  for (const { top, closure, closureIds } of placed) {
    const part = (top as unknown as { parentPart?: unknown }).parentPart;
    const parentKey = typeof part === 'string' && made.partIds.has(part) ? part : t.rootKey;
    def.entities.push(...prefabEntitiesOf(scene, catalog, closure, new Set(closureIds), localOf, parentKey));
    // This copy keeps the objects' ids (a nested copy's parts, too).
    for (const e of closure) {
      absorbed.add(e.id);
      const local = keyOfId.get(e.id) as string;
      partIds[local] = e.id;
      if (isPrefabLink((e.components as { prefab?: unknown }).prefab)) {
        absorbedLinks.add(e.id);
        for (const [k, id] of t.loc.made(e.id).partIds) {
          if (id === e.id) continue;
          partIds[`${local}/${k}`] = id;
          absorbedParts.add(id);
        }
      }
    }
  }
  const remaining: PrefabOverride[] = [];
  let applied = 0;
  for (const o of t.link.overrides ?? []) {
    if (applyingAdded || !selects(t, o) || !applyToDefinition(def, localRefs(o, keyOfId, refKeys), catalog)) remaining.push(o);
    else applied += 1;
  }
  if (applied === 0 && absorbed.size === 0 && (displayName === undefined || displayName === original.displayName)) return { ok: false, error: noChangeContent() };
  def.nextLocalNumber = Math.max(next, def.nextLocalNumber ?? 1);
  def.entityCount = def.entities.length;
  def.depth = prefabDepth(def.entities);
  def.updatedRevision = input.revision;
  if (displayName !== undefined) def.displayName = displayName;
  const bytes = canonicalBytes(def);
  if (bytes > MAX_PREFAB_BYTES) return { ok: false, error: limitsExceeded('prefab_bytes', bytes, MAX_PREFAB_BYTES) };
  const nextContent: ContentCatalog = { ...catalog, prefabs: catalog.prefabs.map((d) => (d.prefabId === def.prefabId ? def : d)) };
  const cycle = prefabNestingCycles(nextContent.prefabs).get(def.prefabId);
  if (cycle !== undefined) return { ok: false, error: prefabCycle(def.prefabId, cycle) };
  // Kept ids of parts that are gone mean nothing any more.
  const root = withOverrides(t.root, t.link, remaining, partIds);
  const entities = scene.entities.filter((e) => !absorbed.has(e.id)).map((e) => (e.id === t.copyId ? root : e)) as EntityV3[];
  // The proof: the applying copy is made of exactly the objects it was (the added ones now parts).
  const after = catalogAssembler(nextContent).assembleCopy(root as never);
  const before = new Map(expandCopies(scene, t.loc, new Set([t.copyId, ...absorbedLinks])).map((e) => [e.id, e]));
  const wanted = new Set([...made.entities.map((e) => e.id), ...absorbed, ...absorbedParts]);
  const differs = after.entities.find((e) => {
    if (!wanted.has(e.id)) return true;
    const was = before.get(e.id);
    // An added object that became a part now says which part it is, and holds its behavior's declared defaults.
    return absorbed.has(e.id) && !absorbedLinks.has(e.id) ? canonicalJsonKey(asAdded(e, was)) !== canonicalJsonKey(was) : canonicalJsonKey(e) !== canonicalJsonKey(was);
  });
  if (differs !== undefined || after.entities.length !== wanted.size) {
    return { ok: false, error: prefabOverrideUnsupported(differs?.id ?? t.copyId, `applying would change the copy "${t.copyId}" itself${differs !== undefined ? ` ("${differs.id}")` : ''}: apply its overrides one at a time, or edit the prefab`) };
  }
  return storeLinkEdit(input, entities, [t.copyId], nextContent, [{ prefabId: def.prefabId, previous: deepClone(original), next: def }]);
}

/** A part made from an added object, compared as that object: no part provenance, only the behavior values it stored. */
function asAdded(part: { components: object }, was: EntityV3 | undefined): Obj {
  const { prefab: _p, ...components } = part.components as Obj;
  void _p;
  const behavior = components['behavior'] as { behaviorId: string; values: Obj } | undefined;
  const stored = (was?.components as { behavior?: { values?: Obj } } | undefined)?.behavior?.values;
  if (behavior !== undefined && stored !== undefined) {
    const values: Obj = {};
    for (const k of Object.keys(behavior.values)) if (k in stored) values[k] = behavior.values[k];
    components['behavior'] = { ...behavior, values };
  }
  return { ...(part as Obj), components };
}

/**
 * `updatePrefab` from a linked copy of that prefab: apply every override
 * and added object of the copy (null: `fromEntity` is no such copy, and the
 * prefab's contents are replaced by the capture as before).
 */
export function applyUpdatePrefabFromCopy(input: OpInput, args: UpdatePrefabArgs): OpOutcome | null {
  if (args.fromEntity === undefined) return null;
  const from = input.scene.entities.find((e) => e.id === args.fromEntity);
  const link = (from?.components as { prefab?: unknown } | undefined)?.prefab;
  if (!isPrefabLink(link) || link.prefabId !== args.prefabId) return null;
  if (args.displayName !== undefined && !isValidName(args.displayName)) return { ok: false, error: displayNameError(args.displayName) };
  return applyApplyPrefabOverrides(input, { entityId: args.fromEntity, all: true }, args.displayName);
}

// ---- unpackPrefab ------------------------------------------------------------

/**
 * A copy becomes the plain objects it is made of, ids kept: no longer linked
 * to its prefab (nested copies included), so a prefab edit no longer reaches it.
 */
export function applyUnpackPrefab(input: OpInput, args: UnpackPrefabArgs): OpOutcome {
  const loc = locateCopies(input.scene, input.content);
  const found = loc?.find(args.entityId) ?? null;
  if (loc === null || found === null) {
    return { ok: false, error: input.scene.entities.some((e) => e.id === args.entityId) ? prefabCopyRequired(args.entityId) : entityNotFound(args.entityId) };
  }
  const parts = new Set(loc.made(found.copyId).partIds.values());
  const entities = expandCopies(input.scene, loc, new Set([found.copyId])).map((e) => {
    if (!parts.has(e.id)) return e;
    const { prefab: _p, ...components } = e.components as unknown as Obj;
    void _p;
    return { ...e, components } as unknown as EntityV3;
  });
  return storeLinkEdit(input, entities, [found.copyId]);
}

// ---- createPrefabVariant -------------------------------------------------------

/**
 * A new prefab made of one linked copy of the base: it follows the base, and
 * what it changes are its own overrides (edited through its copies, applied).
 */
export function applyCreatePrefabVariant(input: OpInput, args: CreatePrefabVariantArgs): OpOutcome {
  const catalog = contentOf(input.content);
  if (!ID_RE.test(args.prefabId)) return { ok: false, error: idInvalid('/args/prefabId', args.prefabId, ID_EXPECTED) };
  if (catalog.prefabs.some((d) => d.prefabId === args.prefabId)) return { ok: false, error: prefabIdDuplicate(args.prefabId) };
  if (!isValidName(args.displayName)) return { ok: false, error: displayNameError(args.displayName) };
  const base = catalog.prefabs.find((d) => d.prefabId === args.basePrefabId);
  if (base === undefined) return { ok: false, error: prefabNotFound(args.basePrefabId) };
  const root = base.entities[0] as PrefabEntity;
  const definition: PrefabDefinition = {
    prefabId: args.prefabId,
    displayName: args.displayName,
    createdRevision: input.revision,
    entityCount: 1,
    depth: 1,
    entities: [{ localId: root.localId, components: { transform: deepClone(root.components.transform), prefab: { prefabId: base.prefabId } } as unknown as PrefabEntity['components'] }],
  };
  const nextContent: ContentCatalog = { ...catalog, prefabs: [...catalog.prefabs, definition] };
  const gate = gateResultState({ scene: input.scene, content: catalog, manifest: input.manifest }, { ...input.scene, revision: input.scene.revision + 1 }, nextContent);
  if (!gate.ok) return gate;
  const canonical = (gate.content?.prefabs.find((d) => d.prefabId === args.prefabId) ?? definition) as PrefabDefinition;
  const change: CreatePrefabChange = { type: 'createPrefab', prefabId: args.prefabId, definition: deepClone(canonical) };
  return { ok: true, op: { scene: gate.scene, content: gate.content, change, inverse: { kind: 'removePrefab', prefabId: args.prefabId } } };
}

// ---- dispatch ------------------------------------------------------------------

type PrefabOpArgs =
  | { op: 'createPrefab'; args: import('./types').CreatePrefabArgs }
  | { op: 'updatePrefab'; args: UpdatePrefabArgs }
  | { op: 'instantiatePrefab'; args: InstantiatePrefabArgs }
  | { op: 'revertPrefabOverrides' | 'applyPrefabOverrides'; args: PrefabOverrideTargetArgs }
  | { op: 'unpackPrefab'; args: UnpackPrefabArgs }
  | { op: 'createPrefabVariant'; args: CreatePrefabVariantArgs };

/** The prefab commands, each to its op (a v4 scene places linked copies; an older one plain copies). */
export function applyPrefabOp(input: OpInput, v: PrefabOpArgs): OpOutcome {
  switch (v.op) {
    case 'createPrefab':
      return applyCreatePrefab(input, v.args);
    case 'updatePrefab':
      // From a linked copy of the prefab: apply all its overrides (what updating from a copy means now).
      return applyUpdatePrefabFromCopy(input, v.args) ?? applyUpdatePrefab(input, v.args);
    case 'instantiatePrefab':
      return input.scene.schemaVersion === 4 ? applyInstantiateLinked(input, v.args) : applyInstantiatePrefab(input, v.args);
    case 'revertPrefabOverrides':
      return applyRevertPrefabOverrides(input, v.args);
    case 'applyPrefabOverrides':
      return applyApplyPrefabOverrides(input, v.args);
    case 'unpackPrefab':
      return applyUnpackPrefab(input, v.args);
    case 'createPrefabVariant':
      return applyCreatePrefabVariant(input, v.args);
  }
}
