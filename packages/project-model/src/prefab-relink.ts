/**
 * The overrides a linked copy keeps, worked out from what its objects are:
 * the differences between each part as it stands and the part as its prefab
 * makes it. The schema 8 upgrade links plain copies this way, and the
 * commands edit a copy's parts the same way: the copy is assembled into plain
 * objects, the edit runs on them as on any object, and the copy is linked
 * again from the result. One diff, so a copy is only ever stored as overrides
 * that assemble back to exactly what was edited.
 */
import { canonicalJsonKey } from '@thirdlight/shared';
import type { AssemblyEntity, PrefabAssembler } from './prefab-assembly';
import type { PrefabLinkComponent, PrefabOverride } from './prefab-links';

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A field name a part path can hold (paths are `/`-separated). */
const pathSafe = (k: string): boolean => k.length > 0 && !k.includes('/');

/** The overrides that turn `was` (the prefab's) into `now` (the copy's) at `path`. */
function diffInto(out: PrefabOverride[], part: string, path: string, was: unknown, now: unknown): void {
  if (canonicalJsonKey(was) === canonicalJsonKey(now)) return;
  if (isObject(was) && isObject(now) && Object.keys({ ...was, ...now }).every(pathSafe)) {
    for (const k of Object.keys({ ...was, ...now })) {
      if (now[k] === undefined) out.push({ part, path: `${path}/${k}`, remove: true });
      else if (was[k] === undefined) out.push({ part, path: `${path}/${k}`, value: now[k] });
      else diffInto(out, part, `${path}/${k}`, was[k], now[k]);
    }
    return;
  }
  out.push({ part, path, value: now });
}

/** A part's own fields as overrides: its name, tags and components (the root's transform is the copy's own; its name and tags are the caller's). */
export function partOverrides(out: PrefabOverride[], key: string, pristine: AssemblyEntity, now: Obj, isRoot: boolean): void {
  if (!isRoot) {
    for (const f of ['name', 'tags'] as const) {
      if (now[f] === undefined && pristine[f] !== undefined) out.push({ part: key, path: f, remove: true });
      else if (now[f] !== undefined && canonicalJsonKey(now[f]) !== canonicalJsonKey(pristine[f])) out.push({ part: key, path: f, value: now[f] });
    }
  }
  const was = pristine.components as Obj;
  const comps = isObject(now['components']) ? (now['components'] as Obj) : {};
  for (const c of Object.keys({ ...was, ...comps })) {
    if (isRoot && c === 'transform') continue;
    if (comps[c] === undefined) out.push({ part: key, path: `components/${c}`, remove: true });
    else if (was[c] === undefined) out.push({ part: key, path: `components/${c}`, value: comps[c] });
    else diffInto(out, key, `components/${c}`, was[c], comps[c]);
  }
}

/**
 * The copy's root object as stored: its own fields (id, parent, flags) and
 * placement from `root`, its name and tags where they differ from the
 * prefab's (absent where the prefab has one: an override), and the link.
 */
export function linkedRoot(root: Obj, pristineRoot: AssemblyEntity, rootKey: string, prefabId: string, overrides: PrefabOverride[], partIds: Record<string, string> | undefined): Obj {
  const own: Obj = {};
  for (const [k, v] of Object.entries(root)) if (k !== 'components' && k !== 'name' && k !== 'tags') own[k] = v;
  for (const f of ['name', 'tags'] as const) {
    if (root[f] === undefined && pristineRoot[f] !== undefined) overrides.push({ part: rootKey, path: f, remove: true });
    else if (root[f] !== undefined && canonicalJsonKey(root[f]) !== canonicalJsonKey(pristineRoot[f])) own[f] = root[f];
  }
  const link: PrefabLinkComponent = { prefabId, ...(overrides.length > 0 ? { overrides } : {}), ...(partIds !== undefined && Object.keys(partIds).length > 0 ? { partIds } : {}) };
  return { ...own, components: { transform: (root['components'] as Obj)['transform'], prefab: link } };
}

export type RelinkResult =
  | {
      ok: true;
      /** The copy's root as it is stored now (the link with its overrides). */
      root: Obj;
      /** The scene id of each part the copy now has, by part key. */
      partIds: ReadonlyMap<string, string>;
    }
  | {
      ok: false;
      /** `moved`: a part left its place under its parent part; `unrepresentable`: a difference a link cannot keep (a part's flags). */
      reason: 'moved' | 'unrepresentable' | 'prefab';
      entityId: string;
      message: string;
    };

/**
 * Link a copy again from its parts as they now are. `stored` is the copy's
 * root as it was stored (its prefab and kept part ids); `now` finds each
 * object by id as the edit left it (a part that is gone was removed). The
 * result is proven: the new link assembles to exactly those objects.
 */
export function relinkCopy(assembler: PrefabAssembler, stored: AssemblyEntity, now: (id: string) => Obj | undefined): RelinkResult {
  const link = (stored.components as { prefab: PrefabLinkComponent }).prefab;
  const root = now(stored.id);
  if (root === undefined) return { ok: false, reason: 'unrepresentable', entityId: stored.id, message: "a copy's root cannot be removed as an override" };
  const bare = { id: stored.id, components: { transform: (root['components'] as Obj)['transform'], prefab: { prefabId: link.prefabId, ...(link.partIds !== undefined ? { partIds: link.partIds } : {}) } } };
  const pristine = assembler.assembleCopy(bare);
  if (pristine.problems.some((p) => p.code === 'prefab_missing' || p.code === 'prefab_cycle')) {
    return { ok: false, reason: 'prefab', entityId: stored.id, message: pristine.problems[0]!.message };
  }
  const keyOfId = new Map([...pristine.partIds].map(([k, id]) => [id, k]));
  const rootKey = keyOfId.get(stored.id)!;
  const overrides: PrefabOverride[] = [];
  const present = new Set<string>();
  for (const p of pristine.entities) {
    const key = keyOfId.get(p.id)!;
    const parentPresent = p.parentId === undefined || key === rootKey || present.has(p.parentId);
    const e = now(p.id);
    if (e === undefined) {
      // A removed part takes the parts under it: only the topmost is named.
      if (parentPresent) overrides.push({ part: key, remove: true });
      continue;
    }
    if (key !== rootKey && (!parentPresent || e['parentId'] !== p.parentId)) {
      return { ok: false, reason: 'moved', entityId: p.id, message: `the part "${p.id}" left its place in the copy: a copy's parts keep the places the prefab gives them (edit the prefab, or unpack the copy)` };
    }
    present.add(p.id);
    partOverrides(overrides, key, p, e, key === rootKey);
  }
  // The overrides the copy had keep their order (a list a person reads); new ones follow. Their paths never overlap.
  const keyOf = (o: PrefabOverride): string => `${o.part}\u0000${'path' in o ? o.path : ''}`;
  const had = new Map((link.overrides ?? []).map((o, i) => [keyOf(o), i]));
  const order = (o: PrefabOverride): number => had.get(keyOf(o)) ?? had.size;
  overrides.sort((x, y) => order(x) - order(y));
  const pristineRoot = pristine.entities[0]!;
  const next = linkedRoot(root, pristineRoot, rootKey, link.prefabId, overrides, link.partIds);
  const made = assembler.assembleCopy(next as AssemblyEntity);
  for (const m of made.entities) {
    const e = now(m.id);
    if (e === undefined || canonicalJsonKey(m) !== canonicalJsonKey(e)) {
      return { ok: false, reason: 'unrepresentable', entityId: m.id, message: `the change to "${m.id}" is not one a copy can keep as an override (a part's own flags, or a field the prefab's parts do not hold): edit the prefab, or unpack the copy` };
    }
  }
  return { ok: true, root: next, partIds: made.partIds };
}
