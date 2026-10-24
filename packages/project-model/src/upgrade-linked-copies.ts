/**
 * The schema 8 step that turns plain prefab copies into linked copies.
 *
 * Up to schema 7 a placed copy was a set of plain objects, each part carrying
 * `prefab: {prefabId, localId}`: it remembered its prefab but never followed
 * it. From 8 a copy is one object linking its prefab with the differences it
 * keeps (overrides). The step links every copy so that nothing changes how
 * the project looks or plays: assembling the linked copy gives back exactly
 * the objects the scene held (ids, order, values), so Play, export and the
 * editor see what they saw before.
 * - The copy's root keeps its id, parent, flags and transform; its parts keep
 *   their ids (`partIds`), so scripts, saves and references that name a part
 *   keep working.
 * - Every difference from the prefab as it is now becomes an override: a
 *   changed or added field or component, a removed one, a removed part.
 * - Objects added under a part stay ordinary objects hanging from the copy
 *   (`parentPart` names the part).
 * - A copy a link cannot reproduce exactly (a part moved to another parent,
 *   parts out of the prefab's order, an object between its parts) stays plain
 *   objects, as do parts outside any copy. Objects whose prefab is gone
 *   stay plain objects that no longer name it (a project naming a prefab it
 *   does not have does not load).
 * Each case is one note per prefab (the copies it concerns), which the open
 * lists in Problems so a game team can tidy them up.
 *
 * Pure: works on the raw documents before they are validated.
 */
import { assembleSceneEntities, createPrefabAssembler, type AssemblyEntity, type AssemblyPrefab } from './prefab-assembly';
import type { PrefabOverride } from './prefab-links';
import { canonicalJson, linkedRoot, partOverrides } from './prefab-relink';
import type { DeclaredProperty } from './types-v2';

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Copies named in one note before it says how many more (a Problems line is short). */
const NAMED_MAX = 4;

export interface LinkPrefabCopiesResult {
  content: unknown;
  scenes: unknown[];
  /** Whether any scene changed. */
  changed: boolean;
  /** One line per prefab and outcome (copies with overrides, copies kept plain, a prefab that is gone). */
  notes: string[];
}

const canon = canonicalJson;

/** A part's provenance (`{prefabId, localId}`), or null. */
function provenanceOf(e: Obj): { prefabId: string; localId: string } | null {
  const p = isObject(e['components']) ? (e['components'] as Obj)['prefab'] : undefined;
  return isObject(p) && typeof p['prefabId'] === 'string' && typeof p['localId'] === 'string' ? { prefabId: p['prefabId'], localId: p['localId'] } : null;
}

interface Linked {
  root: Obj;
  /** Objects added under a part (not the root): they hang from the copy, `parentPart` naming the part. */
  added: { id: string; part: string }[];
  /** The stored objects that became the copy (root and parts). */
  absorbed: Set<string>;
  overrides: number;
}

/**
 * Link one plain copy: its root object and the parts found under it. Null
 * when the linked copy would not assemble to exactly the objects stored.
 */
function linkCopy(
  root: Obj,
  def: AssemblyPrefab,
  ents: readonly Obj[],
  index: ReadonlyMap<string, number>,
  children: ReadonlyMap<string, string[]>,
  assembler: ReturnType<typeof createPrefabAssembler>,
): Linked | null {
  const prefabId = def.prefabId;
  const rootKey = def.entities[0]!.localId;
  const parentKeyOf = new Map(def.entities.slice(1).map((d) => [d.localId, d.parentLocalId ?? rootKey]));
  const rootId = root['id'] as string;
  // The parts: objects under the root (through parts) that are this prefab's parts where the prefab puts them.
  const parts = new Map<string, Obj>([[rootKey, root]]);
  const added: { id: string; part: string }[] = [];
  const walk = (id: string, key: string): void => {
    for (const cid of children.get(id) ?? []) {
      const c = ents[index.get(cid)!]!;
      const p = provenanceOf(c);
      if (p !== null && p.prefabId === prefabId && parentKeyOf.get(p.localId) === key && !parts.has(p.localId)) {
        parts.set(p.localId, c);
        walk(cid, p.localId);
      } else if (key !== rootKey) added.push({ id: cid, part: key });
    }
  };
  walk(rootId, rootKey);
  const partIds: Record<string, string> = {};
  for (const [key, e] of parts) if (key !== rootKey) partIds[key] = e['id'] as string;
  const comps = root['components'] as Obj;
  const bare = { id: rootId, components: { transform: comps['transform'], prefab: { prefabId, ...(Object.keys(partIds).length > 0 ? { partIds } : {}) } } };
  const pristine = assembler.assembleCopy(bare);
  if (pristine.problems.length > 0) return null;
  const pristineByKey = new Map<string, AssemblyEntity>();
  const keyOfId = new Map([...pristine.partIds].map(([k, id]) => [id, k]));
  for (const e of pristine.entities) pristineByKey.set(keyOfId.get(e.id)!, e);
  const overrides: PrefabOverride[] = [];
  // A missing part is removed (its parts go with it).
  for (const d of def.entities.slice(1)) {
    if (!parts.has(d.localId) && parts.has(parentKeyOf.get(d.localId)!)) overrides.push({ part: d.localId, remove: true });
  }
  for (const [key, e] of parts) partOverrides(overrides, key, pristineByKey.get(key)!, e, key === rootKey);
  const linked = linkedRoot(root, pristineByKey.get(rootKey)!, rootKey, prefabId, overrides, partIds);
  // The proof: the link assembles to exactly the objects stored, in their place.
  const made = assembler.assembleCopy(linked as AssemblyEntity);
  if (made.problems.length > 0) return null;
  const at = index.get(rootId)!;
  const stored = ents.slice(at, at + made.entities.length);
  if (stored.length !== made.entities.length || made.entities.some((m, i) => canon(m) !== canon(stored[i]))) return null;
  // Objects added under a part come after the copy (the assembled scene re-parents them in order).
  if (added.some((a) => index.get(a.id)! < at)) return null;
  return { root: linked, added, absorbed: new Set([...parts.values()].map((e) => e['id'] as string)), overrides: overrides.length };
}

const objects = (n: number): string => (n === 1 ? '1 object stays' : `${n} objects stay`);

/** "a (scene "s"), b (scene "s") and 3 more" */
function named(list: readonly string[]): string {
  return list.slice(0, NAMED_MAX).join(', ') + (list.length > NAMED_MAX ? ` and ${list.length - NAMED_MAX} more` : '');
}

/**
 * Link every plain prefab copy of the project's scenes (see the module
 * comment). Returns the documents unchanged (the same objects) when no scene
 * holds a copy.
 */
export function linkPrefabCopies(contentIn: unknown, scenesIn: readonly unknown[]): LinkPrefabCopiesResult {
  const content = isObject(contentIn) ? contentIn : {};
  const defs = new Map<string, AssemblyPrefab>();
  for (const p of Array.isArray(content['prefabs']) ? (content['prefabs'] as unknown[]) : []) {
    if (isObject(p) && typeof p['prefabId'] === 'string' && Array.isArray(p['entities']) && p['entities'].length > 0) defs.set(p['prefabId'], p as unknown as AssemblyPrefab);
  }
  const declarations = new Map<string, readonly DeclaredProperty[]>();
  for (const b of Array.isArray(content['behaviors']) ? (content['behaviors'] as unknown[]) : []) {
    if (isObject(b) && typeof b['behaviorId'] === 'string' && isObject(b['declaration']) && Array.isArray(b['declaration']['properties'])) declarations.set(b['behaviorId'], b['declaration']['properties'] as DeclaredProperty[]);
  }
  const assembler = createPrefabAssembler([...defs.values()], { declarations });
  /** Per prefab: copies linked with overrides, copies kept plain, objects of a prefab that is gone. */
  const withOverrides = new Map<string, string[]>();
  const keptPlain = new Map<string, string[]>();
  const gone = new Map<string, string[]>();
  const push = (m: Map<string, string[]>, k: string, v: string): void => {
    const l = m.get(k);
    if (l === undefined) m.set(k, [v]);
    else l.push(v);
  };
  let changed = false;
  const scenes = scenesIn.map((sceneIn) => {
    if (!isObject(sceneIn) || !Array.isArray(sceneIn['entities'])) return sceneIn;
    const raw = (sceneIn['entities'] as unknown[]).filter(isObject);
    if (raw.length !== (sceneIn['entities'] as unknown[]).length || !raw.some((e) => provenanceOf(e) !== null)) return sceneIn;
    const sceneId = String(sceneIn['sceneId']);
    const where = (id: string): string => `"${id}" (scene "${sceneId}")`;
    // An object naming a prefab that is gone drops the name (a project naming one does not load); it stays as it is otherwise.
    let stripped = false;
    const ents = raw.map((e) => {
      const p = provenanceOf(e);
      if (p === null || defs.has(p.prefabId)) return e;
      push(gone, p.prefabId, where(String(e['id'])));
      stripped = true;
      const { prefab: _gone, ...components } = e['components'] as Obj;
      void _gone;
      return { ...e, components };
    });
    const plain = stripped ? { ...sceneIn, entities: ents } : sceneIn;
    if (stripped) changed = true;
    const index = new Map(ents.map((e, i) => [String(e['id']), i]));
    const children = new Map<string, string[]>();
    for (const e of ents) {
      if (typeof e['parentId'] !== 'string') continue;
      const l = children.get(e['parentId']);
      if (l === undefined) children.set(e['parentId'], [String(e['id'])]);
      else l.push(String(e['id']));
    }
    const replaced = new Map<string, Obj>();
    const dropped = new Set<string>();
    const parentPart = new Map<string, { copyId: string; part: string }>();
    const linkedRoots: string[] = [];
    for (const e of ents) {
      const p = provenanceOf(e);
      if (p === null) continue;
      const def = defs.get(p.prefabId)!;
      if (p.localId !== def.entities[0]!.localId) continue;
      const l = linkCopy(e, def, ents, index, children, assembler);
      if (l === null) {
        push(keptPlain, p.prefabId, where(String(e['id'])));
        continue;
      }
      // A part of another copy is never a root of this prefab (the root's local id is no part's), so copies never overlap.
      replaced.set(String(e['id']), l.root);
      for (const id of l.absorbed) if (id !== e['id']) dropped.add(id);
      for (const a of l.added) parentPart.set(a.id, { copyId: String(e['id']), part: a.part });
      linkedRoots.push(String(e['id']));
      if (l.overrides > 0) push(withOverrides, p.prefabId, where(String(e['id'])));
    }
    // Parts no copy took (moved away from their place in a copy) stay plain objects; a plain copy's parts are named by its root.
    const rootAbove = (e: Obj, prefabId: string, rootLocalId: string): string | null => {
      let id = e['parentId'];
      for (let guard = 0; typeof id === 'string' && guard < ents.length; guard += 1) {
        const a = ents[index.get(id) ?? -1];
        if (a === undefined) return null;
        const ap = provenanceOf(a);
        if (ap !== null && ap.prefabId === prefabId && ap.localId === rootLocalId) return id;
        id = a['parentId'];
      }
      return null;
    };
    for (const e of ents) {
      const p = provenanceOf(e);
      const def = p === null ? undefined : defs.get(p.prefabId);
      if (p === null || def === undefined || dropped.has(String(e['id'])) || replaced.has(String(e['id']))) continue;
      const rootLocalId = def.entities[0]!.localId;
      if (p.localId === rootLocalId) continue;
      const above = rootAbove(e, p.prefabId, rootLocalId);
      if (above === null || replaced.has(above)) push(keptPlain, p.prefabId, where(String(e['id'])));
    }
    if (replaced.size === 0) return plain;
    const entities: Obj[] = [];
    for (const e of ents) {
      const id = String(e['id']);
      if (dropped.has(id)) continue;
      let out = replaced.get(id) ?? e;
      const part = parentPart.get(id);
      if (part !== undefined) out = { ...out, parentId: part.copyId, parentPart: part.part };
      entities.push(out);
    }
    // The whole scene, assembled, must be what was stored; otherwise the scene keeps its plain copies.
    const made = assembleSceneEntities(entities as unknown as AssemblyEntity[], assembler);
    if (made.problems.length > 0 || made.entities.length !== ents.length || made.entities.some((m, i) => canon(m) !== canon(ents[i]))) {
      for (const id of linkedRoots) {
        const p = provenanceOf(ents[index.get(id)!]!)!;
        push(keptPlain, p.prefabId, where(id));
        const l = withOverrides.get(p.prefabId);
        if (l !== undefined) withOverrides.set(p.prefabId, l.filter((x) => x !== where(id)));
      }
      return plain;
    }
    changed = true;
    return { ...sceneIn, entities };
  });
  const notes: string[] = [];
  const prefabs = [...new Set([...withOverrides.keys(), ...keptPlain.keys(), ...gone.keys()])].sort();
  for (const id of prefabs) {
    const o = withOverrides.get(id) ?? [];
    if (o.length > 0) notes.push(`Prefab "${id}": ${o.length} cop${o.length === 1 ? 'y keeps its' : 'ies keep their'} differences from the prefab as overrides — ${named(o)}`);
    const k = keptPlain.get(id) ?? [];
    if (k.length > 0) notes.push(`Prefab "${id}": ${objects(k.length)} plain (not linked: re-arranged parts a link cannot keep, or parts outside a copy) — ${named(k)}`);
    const g = gone.get(id) ?? [];
    if (g.length > 0) notes.push(`Prefab "${id}" is gone: ${objects(g.length)} plain, no longer naming it — ${named(g)}`);
  }
  return { content: contentIn, scenes: changed ? scenes : [...scenesIn], changed, notes };
}
