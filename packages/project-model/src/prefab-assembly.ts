/**
 * Assembly of linked prefab copies into ordinary objects: the backend runs it
 * when it builds a scene (Play, export, the editor's view), so the runtime
 * keeps seeing plain objects and pays nothing for linking.
 *
 * A prefab is flattened once (nested copies and variants expanded, their own
 * overrides applied) and the flat form is reused by every copy of it; a copy
 * then costs a clone of its parts, its overrides and its part ids.
 */

import type { DeclaredProperty, PropertyValue } from './types-v2';
import {
  isPrefabLink,
  prefabPartId,
  PART_PATH_SEPARATOR,
  type PrefabLinkComponent,
  type PrefabOverride,
} from './prefab-links';

/** Whether a declared property is private (absent visibility = public): never stored on an object, never overridden. */
export function isPrivateProperty(p: { visibility?: string }): boolean {
  return p.visibility === 'private';
}

/** A prefab as assembly reads it (a stored definition is one). */
export interface AssemblyPrefab {
  prefabId: string;
  entities: readonly AssemblyPrefabEntity[];
}

export interface AssemblyPrefabEntity {
  localId: string;
  name?: string;
  /** An earlier entity's local id, or a part inside an earlier nested copy (`L/localId`). */
  parentLocalId?: string;
  tags?: number;
  components: object;
}

/** A scene object as assembly reads and writes it. */
export interface AssemblyEntity {
  id: string;
  name?: string;
  parentId?: string;
  tags?: number;
  components: object;
  [flag: string]: unknown;
}

export type PrefabAssemblyProblemCode =
  /** The copy (or a copy nested in its prefab) names a prefab that does not exist: it is left an empty object. */
  | 'prefab_missing'
  /** The prefab contains itself through nested copies: the copy is left an empty object. */
  | 'prefab_cycle'
  /** An override names a part or field the prefab no longer has: it is skipped. */
  | 'override_stale'
  /** A part's derived id is already another object's: the scene holds both. */
  | 'part_id_taken';

/** Something assembly could not do as stored; the build lists it in Problems. */
export interface PrefabAssemblyProblem {
  code: PrefabAssemblyProblemCode;
  /** The copy (scene object) it concerns. */
  entityId: string;
  prefabId: string;
  message: string;
  /** The part and field of a stale override. */
  part?: string;
  path?: string;
}

/** One part of a flattened prefab: its path key relative to the prefab, and its contents. */
interface FlatPart {
  key: string;
  /** The parent part's key; absent on the root. */
  parentKey?: string;
  name?: string;
  tags?: number;
  components: Record<string, unknown>;
  /** Behavior value keys whose values name a part of the prefab (by key), remapped to scene ids per copy. */
  refs?: string[];
}

interface FlatPrefab {
  rootKey: string;
  parts: FlatPart[];
  /** Problems met while flattening (stale nested overrides, missing nested prefabs), reported for every copy. */
  problems: { code: PrefabAssemblyProblemCode; prefabId: string; message: string; part?: string; path?: string }[];
}

class AssemblyRefusal extends Error {
  constructor(readonly code: 'prefab_missing' | 'prefab_cycle', readonly prefabId: string, message: string) {
    super(message);
  }
}

function clone<T>(v: T): T {
  if (Array.isArray(v)) return v.map(clone) as T;
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v)) out[k] = clone((v as Record<string, unknown>)[k]);
    return out as T;
  }
  return v;
}

function clonePart(p: FlatPart): FlatPart {
  return {
    key: p.key,
    ...(p.parentKey !== undefined ? { parentKey: p.parentKey } : {}),
    ...(p.name !== undefined ? { name: p.name } : {}),
    ...(p.tags !== undefined ? { tags: p.tags } : {}),
    components: clone(p.components),
    ...(p.refs !== undefined ? { refs: [...p.refs] } : {}),
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Apply one override to a part. Returns false when the field it names cannot
 * be reached (the prefab changed under it): the override is stale.
 */
function applyFieldOverride(part: FlatPart, path: string, value: unknown, remove: boolean): boolean {
  const segs = path.split('/');
  const head = segs[0];
  if (head === 'name' || head === 'tags') {
    if (remove) delete part[head];
    else if (head === 'name') part.name = value as string;
    else part.tags = value as number;
    return true;
  }
  let at: Record<string, unknown> = part.components;
  for (let i = 1; i < segs.length - 1; i++) {
    const seg = segs[i] as string;
    let next = at[seg];
    if (next === undefined && !remove) {
      next = {};
      at[seg] = next;
    }
    if (!isRecord(next)) return false;
    at = next;
  }
  const leaf = segs[segs.length - 1] as string;
  if (remove) {
    if (!(leaf in at)) return false;
    delete at[leaf];
  } else at[leaf] = clone(value);
  // A behavior value an override sets is literal: it no longer names a part of the prefab.
  if (segs[1] === 'behavior' && part.refs !== undefined) {
    const key = segs[3];
    part.refs = segs.length <= 3 ? [] : part.refs.filter((k) => k !== key);
  }
  return true;
}

/**
 * Set or remove one field of a part-shaped object (a prefab entity, or a
 * scene object as a part): what an override does, for applying an override
 * to a prefab. False when the field cannot be reached.
 */
export function applyPartField(part: { name?: string; tags?: number; components: object }, path: string, value: unknown, remove: boolean): boolean {
  return applyFieldOverride(part as unknown as FlatPart, path, value, remove);
}

/** Apply a copy's (or a nested copy's) overrides to its parts; `keyOf` maps an override's part to a key of `parts`. */
function applyOverrides(parts: FlatPart[], overrides: readonly PrefabOverride[], keyOf: (part: string) => string, rootKey: string, stale: (o: PrefabOverride, why: string) => void): FlatPart[] {
  if (overrides.length === 0) return parts;
  const byKey = new Map(parts.map((p) => [p.key, p]));
  const removed = new Set<string>();
  for (const o of overrides) {
    const key = keyOf(o.part);
    const part = byKey.get(key);
    if (part === undefined) {
      stale(o, 'the prefab has no such part');
      continue;
    }
    if (!('path' in o)) {
      if (key === rootKey) stale(o, "a copy's root cannot be removed");
      else removed.add(key);
      continue;
    }
    if (key === rootKey && (o.path === 'components/transform' || o.path.startsWith('components/transform/'))) {
      stale(o, "the root's transform is the copy's own");
      continue;
    }
    const remove = 'remove' in o && o.remove === true;
    if (!applyFieldOverride(part, o.path, remove ? undefined : (o as { value: unknown }).value, remove)) stale(o, 'the prefab has no such field');
  }
  if (removed.size === 0) return parts;
  // A removed part takes every part under it (parents come before children).
  const gone = new Set<string>();
  return parts.filter((p) => {
    if (removed.has(p.key) || (p.parentKey !== undefined && gone.has(p.parentKey))) {
      gone.add(p.key);
      return false;
    }
    return true;
  });
}

export interface PrefabAssemblerOptions {
  /**
   * The behaviors' declared properties: a copy's behavior gets every public
   * declared value (the stored one, else the default), and an `entityRef`
   * naming a part of the prefab becomes that part's scene id — as a placed
   * copy always had. Absent: values are copied as stored.
   */
  declarations?: ReadonlyMap<string, readonly DeclaredProperty[]>;
}

export interface PrefabAssembler {
  /**
   * The objects one linked copy is made of: its root (the copy's id) first,
   * then its parts in prefab order; and the scene id of each part, by path key.
   */
  assembleCopy(copy: AssemblyEntity): { entities: AssemblyEntity[]; problems: PrefabAssemblyProblem[]; partIds: ReadonlyMap<string, string> };
  /** Forget the flattened form of these prefabs (and of every prefab nesting them), after they changed. */
  invalidate(prefabIds: Iterable<string>): void;
}

/** An assembler over one catalog's prefabs. Flattened prefabs are kept until invalidated. */
export function createPrefabAssembler(prefabs: readonly AssemblyPrefab[], options: PrefabAssemblerOptions = {}): PrefabAssembler {
  const byId = new Map(prefabs.map((p) => [p.prefabId, p]));
  const flat = new Map<string, FlatPrefab | AssemblyRefusal>();
  const declarations = options.declarations;

  const behaviorOf = (components: Record<string, unknown>, localIds: ReadonlySet<string>): string[] | undefined => {
    const behavior = components['behavior'];
    if (!isRecord(behavior) || declarations === undefined) return undefined;
    const declared = declarations.get(behavior['behaviorId'] as string);
    if (declared === undefined) return undefined;
    const stored = isRecord(behavior['values']) ? behavior['values'] : {};
    const values: Record<string, PropertyValue> = {};
    const refs: string[] = [];
    for (const p of declared) {
      if (isPrivateProperty(p)) continue;
      const v = (Object.prototype.hasOwnProperty.call(stored, p.key) ? stored[p.key] : p.default) as PropertyValue;
      values[p.key] = clone(v);
      if (p.type === 'entityRef' && typeof v === 'string' && localIds.has(v)) refs.push(p.key);
    }
    behavior['values'] = values;
    return refs.length > 0 ? refs : undefined;
  };

  const flatten = (prefabId: string, stack: readonly string[]): FlatPrefab => {
    const cached = flat.get(prefabId);
    if (cached instanceof AssemblyRefusal) throw cached;
    if (cached !== undefined) return cached;
    if (stack.includes(prefabId)) throw new AssemblyRefusal('prefab_cycle', prefabId, `the prefab contains itself through nested copies (${[...stack.slice(stack.indexOf(prefabId)), prefabId].join(' → ')})`);
    const def = byId.get(prefabId);
    if (def === undefined || def.entities.length === 0) throw new AssemblyRefusal('prefab_missing', prefabId, `prefab "${prefabId}" does not exist`);
    const inner = [...stack, prefabId];
    const rootKey = def.entities[0]!.localId;
    const localIds = new Set(def.entities.map((e) => e.localId));
    const parts: FlatPart[] = [];
    const problems: FlatPrefab['problems'] = [];
    def.entities.forEach((e, i) => {
      const key = e.localId;
      const parentKey = i === 0 ? undefined : (e.parentLocalId ?? rootKey);
      const comps = e.components as Record<string, unknown>;
      const link = comps['prefab'];
      if (isPrefabLink(link)) {
        let sub: FlatPrefab;
        try {
          sub = flatten(link.prefabId, inner);
        } catch (err) {
          if (!(err instanceof AssemblyRefusal) || err.code === 'prefab_cycle') throw err;
          // A nested prefab that is gone leaves its copy an empty object, as a missing top-level one does.
          problems.push({ code: 'prefab_missing', prefabId: link.prefabId, part: key, message: err.message });
          parts.push({ key, ...(parentKey !== undefined ? { parentKey } : {}), ...(e.name !== undefined ? { name: e.name } : {}), ...(e.tags !== undefined ? { tags: e.tags } : {}), components: { transform: clone(comps['transform']) } });
          return;
        }
        const map = (k: string): string => (k === sub.rootKey ? key : `${key}${PART_PATH_SEPARATOR}${k}`);
        const nested = sub.parts.map((sp) => {
          const p = clonePart(sp);
          p.key = map(sp.key);
          if (sp.parentKey === undefined) {
            if (parentKey !== undefined) p.parentKey = parentKey;
            // The nested copy's own placement, name and tags are its root's.
            p.components['transform'] = clone(comps['transform']);
            if (e.name !== undefined) p.name = e.name;
            if (e.tags !== undefined) p.tags = e.tags;
          } else p.parentKey = map(sp.parentKey);
          if (p.refs !== undefined) {
            const values = (p.components['behavior'] as { values: Record<string, unknown> }).values;
            for (const r of p.refs) values[r] = map(values[r] as string);
          }
          return p;
        });
        for (const sp of sub.problems) problems.push({ ...sp, ...(sp.part !== undefined ? { part: map(sp.part) } : {}) });
        const applied = applyOverrides(nested, link.overrides ?? [], map, key, (o, why) => problems.push({ code: 'override_stale', prefabId, part: map(o.part), ...('path' in o ? { path: o.path } : {}), message: `a nested copy's override is skipped: ${why}` }));
        parts.push(...applied);
        return;
      }
      const components = clone(comps);
      // Each part says which prefab part it is (the editor and scripts read it).
      components['prefab'] = { prefabId, localId: e.localId };
      const refs = behaviorOf(components, localIds);
      parts.push({ key, ...(parentKey !== undefined ? { parentKey } : {}), ...(e.name !== undefined ? { name: e.name } : {}), ...(e.tags !== undefined && e.tags !== 0 ? { tags: e.tags } : {}), components, ...(refs !== undefined ? { refs } : {}) });
    });
    const result: FlatPrefab = { rootKey, parts, problems };
    flat.set(prefabId, result);
    return result;
  };

  const assembleCopy = (copy: AssemblyEntity): { entities: AssemblyEntity[]; problems: PrefabAssemblyProblem[]; partIds: ReadonlyMap<string, string> } => {
    const comps = copy.components as Record<string, unknown>;
    const link = comps['prefab'] as PrefabLinkComponent;
    const problems: PrefabAssemblyProblem[] = [];
    let prefab: FlatPrefab;
    try {
      prefab = flatten(link.prefabId, []);
    } catch (err) {
      if (!(err instanceof AssemblyRefusal)) throw err;
      if (!flat.has(err.prefabId) && err.code === 'prefab_cycle') flat.set(err.prefabId, err);
      problems.push({ code: err.code, entityId: copy.id, prefabId: link.prefabId, message: err.message });
      // Left an empty object where the copy stands: what it holds and its children still have a parent.
      const { components: _ignored, ...own } = copy;
      void _ignored;
      return { entities: [{ ...own, components: { transform: clone(comps['transform']) } }], problems, partIds: new Map() };
    }
    for (const p of prefab.problems) problems.push({ ...p, entityId: copy.id });
    const parts = applyOverrides(
      prefab.parts.map(clonePart),
      link.overrides ?? [],
      (k) => k,
      prefab.rootKey,
      (o, why) => problems.push({ code: 'override_stale', entityId: copy.id, prefabId: link.prefabId, part: o.part, ...('path' in o ? { path: o.path } : {}), message: `an override is skipped: ${why}` }),
    );
    const kept = link.partIds;
    const idOf = (key: string): string => (key === prefab.rootKey ? copy.id : kept !== undefined && Object.prototype.hasOwnProperty.call(kept, key) ? (kept[key] as string) : prefabPartId(copy.id, key));
    const partIds = new Map(parts.map((p) => [p.key, idOf(p.key)]));
    const entities: AssemblyEntity[] = parts.map((p) => {
      if (p.refs !== undefined) {
        const values = (p.components['behavior'] as { values: Record<string, unknown> }).values;
        for (const r of p.refs) values[r] = idOf(values[r] as string);
      }
      if (p.key === prefab.rootKey) {
        // The root is the copy: its id, parent, flags, name and tags are the copy's own (name and tags default to the prefab's).
        const { components: _ignored, ...own } = copy;
        void _ignored;
        return {
          ...own,
          ...(copy.name === undefined && p.name !== undefined ? { name: p.name } : {}),
          ...(copy.tags === undefined && p.tags !== undefined ? { tags: p.tags } : {}),
          components: { ...p.components, transform: clone(comps['transform']) },
        };
      }
      return {
        id: idOf(p.key),
        ...(p.name !== undefined ? { name: p.name } : {}),
        parentId: idOf(p.parentKey as string),
        ...(p.tags !== undefined ? { tags: p.tags } : {}),
        components: p.components,
      };
    });
    return { entities, problems, partIds };
  };

  const invalidate = (prefabIds: Iterable<string>): void => {
    const changed = new Set(prefabIds);
    // A prefab that nests a changed one (through any chain) is stale too.
    let grew = true;
    while (grew) {
      grew = false;
      for (const p of byId.values()) {
        if (changed.has(p.prefabId)) continue;
        if (p.entities.some((e) => {
          const l = (e.components as { prefab?: unknown }).prefab;
          return isPrefabLink(l) && changed.has(l.prefabId);
        })) {
          changed.add(p.prefabId);
          grew = true;
        }
      }
    }
    for (const id of changed) flat.delete(id);
  };

  return { assembleCopy, invalidate };
}

/**
 * A scene's objects with every linked copy assembled in its place (parts
 * right after their root, so parents stay before children); every other
 * object is passed through as it is.
 */
export function assembleSceneEntities(entities: readonly AssemblyEntity[], assembler: PrefabAssembler): { entities: AssemblyEntity[]; problems: PrefabAssemblyProblem[] } {
  const out: AssemblyEntity[] = [];
  const problems: PrefabAssemblyProblem[] = [];
  /** Each assembled copy's part ids, for the objects added under its parts (they come after it). */
  const copies = new Map<string, ReadonlyMap<string, string>>();
  for (const stored of entities) {
    let e = stored;
    const part = stored['parentPart'];
    if (typeof part === 'string') {
      // An object (or a copy) added under a copy's part: parented to that part's id (to the copy's root when the part is gone).
      const { parentPart: _part, ...plain } = stored;
      void _part;
      const partId = stored.parentId !== undefined ? copies.get(stored.parentId)?.get(part) : undefined;
      if (partId === undefined && stored.parentId !== undefined) {
        const link = (entities.find((x) => x.id === stored.parentId)?.components as { prefab?: PrefabLinkComponent } | undefined)?.prefab;
        problems.push({ code: 'override_stale', entityId: stored.id, prefabId: link?.prefabId ?? '', part, message: `the object's part "${part}" is gone from the copy: it hangs from the copy's root` });
      }
      e = partId !== undefined ? { ...plain, parentId: partId } : plain;
    }
    if (isPrefabLink((e.components as { prefab?: unknown }).prefab)) {
      const made = assembler.assembleCopy(e);
      copies.set(e.id, made.partIds);
      for (const m of made.entities) out.push(m);
      for (const p of made.problems) problems.push(p);
      continue;
    }
    out.push(e);
  }
  if (copies.size > 0) {
    const seen = new Set<string>();
    for (const e of out) {
      if (seen.has(e.id)) {
        const prefab = (e.components as { prefab?: { prefabId?: string } }).prefab;
        problems.push({ code: 'part_id_taken', entityId: e.id, prefabId: prefab?.prefabId ?? '', message: `the id "${e.id}" is held by two objects (a copy's part and another object)` });
      }
      seen.add(e.id);
    }
  }
  return { entities: out, problems };
}


/**
 * A prefab as the runtime spawns it: its nested copies and variants expanded
 * into plain parts, so `ctx.spawn` copies a flat list as it always has. The
 * root keeps its local id; every other part's local id is the id a copy whose
 * id is the root's local id gives that part (derived from its path), and
 * entity references inside the prefab name those ids. Each part's `prefab`
 * provenance is left for the spawn to write.
 */
export function flatPrefabEntities(assembler: PrefabAssembler, prefab: AssemblyPrefab): { entities: AssemblyPrefabEntity[]; problems: PrefabAssemblyProblem[] } {
  const root = prefab.entities[0];
  if (root === undefined) return { entities: [], problems: [] };
  const transform = (root.components as { transform?: unknown }).transform;
  const made = assembler.assembleCopy({ id: root.localId, components: { transform: clone(transform), prefab: { prefabId: prefab.prefabId } } });
  const entities = made.entities.map((e, i): AssemblyPrefabEntity => {
    const { prefab: _provenance, ...components } = e.components as Record<string, unknown>;
    void _provenance;
    return {
      localId: e.id,
      ...(e.name !== undefined ? { name: e.name } : {}),
      ...(i > 0 && e.parentId !== undefined ? { parentLocalId: e.parentId } : {}),
      ...(e.tags !== undefined ? { tags: e.tags } : {}),
      components,
    };
  });
  return { entities, problems: made.problems };
}
