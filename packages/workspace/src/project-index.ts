/**
 * The project index (the role of Unreal's Asset Registry): one entry per
 * asset, resource and scene — id, kind, where its file is, name, labels, and
 * the ids it references — plus who references each id.
 *
 * It is built from the loaded project when the project opens and updated
 * from each command's result: a list or scene the command left as it was
 * (the same object: documents are immutable values) is not read again, so an
 * update costs what the command changed. Queries that ask what a project
 * holds or what uses something read the index, not the documents.
 *
 * References are the ids a record names: any string in it equal to the id of
 * an asset, resource or scene of the project (an asset record's references
 * are its default materials, its rig and a packed texture's layers). A text
 * that happens to equal an id counts too; the index answers "what may use
 * this", the model's rules decide what must resolve.
 */
import type { ContentCatalogV4, SceneV4 } from '@thirdlight/project-model';

import { recordsOfKind, RESOURCE_KINDS, type ResourceKind, type ResourceLoading } from './resource-files';
import { displayPathOf, loadingByKey, sceneRel, type ResourcePaths } from './store-v4';

/** One asset, resource or scene of the project. */
export interface IndexEntry {
  /** An asset's kind (`model`, `texture`, …), a resource's (`prefab`, `material`, …) or `scene`. */
  readonly kind: string;
  readonly id: string;
  /** Its file: in the game folder for assets, resources and scenes placed there; `scenes/<id>.json` for a scene in the project folder; null: its bytes are stored, not a file. */
  readonly path: string | null;
  readonly name: string;
  readonly labels: readonly string[];
  /** The name a script loads it by (null: none). */
  readonly address: string | null;
  /** The ids it references (ascending, unique). */
  readonly refs: readonly string[];
}

export interface ProjectIndex {
  /** By `kind:id`. */
  readonly entries: ReadonlyMap<string, IndexEntry>;
  /** Id → the keys (`kind:id`) of the entries that reference it. */
  readonly referrers: ReadonlyMap<string, ReadonlySet<string>>;
  /** Every id an entry has, with how many entries have it (two kinds may share an id). */
  readonly ids: ReadonlyMap<string, number>;
}

/** What the index is built from: the project as the session holds it. */
export interface IndexSource {
  readonly content: ContentCatalogV4;
  readonly scenes: ReadonlyMap<string, SceneV4>;
  readonly resourcePaths: ResourcePaths;
  /** Scene id → its file key (absent: the project folder's `scenes/<id>.json`). */
  readonly scenePaths?: ReadonlyMap<string, string>;
}

interface AssetLike {
  readonly assetId: string;
  readonly kind?: string;
  readonly displayName?: string;
  readonly labels?: readonly string[];
  readonly address?: string;
  readonly currentVersion: number;
  readonly versions: readonly { readonly version: number; readonly sourcePath?: string; readonly convertedFrom?: { readonly sourcePath?: string }; readonly packedFrom?: { readonly layers: readonly (readonly ({ readonly assetId?: string } | { readonly value: number })[])[] } }[];
  readonly materials?: Readonly<Record<string, string>>;
  readonly clipsFor?: string;
}

const keyOf = (kind: string, id: string): string => `${kind}:${id}`;

const NONE: readonly Record<string, unknown>[] = [];
function listOf(content: ContentCatalogV4, k: ResourceKind): readonly Record<string, unknown>[] {
  return recordsOfKind(content, k) ?? NONE;
}

/** Every id an entry may reference: assets, resources, scenes. */
function allIds(src: IndexSource): Set<string> {
  const ids = new Set<string>();
  for (const a of src.content.assets as unknown as AssetLike[]) ids.add(a.assetId);
  for (const k of RESOURCE_KINDS) for (const r of listOf(src.content, k)) ids.add(String(r[k.idKey]));
  for (const id of src.scenes.keys()) ids.add(id);
  return ids;
}

interface Known {
  has(id: string): boolean;
}

/** The ids of `known` among every string in a value. */
function stringRefs(value: unknown, known: Known, self: string, out: Set<string>): void {
  if (typeof value === 'string') {
    if (value !== self && known.has(value)) out.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) stringRefs(v, known, self, out);
    return;
  }
  if (value !== null && typeof value === 'object') for (const v of Object.values(value)) stringRefs(v, known, self, out);
}

function assetEntry(a: AssetLike, known: Known): IndexEntry {
  const refs = new Set<string>();
  for (const id of Object.values(a.materials ?? {})) if (known.has(id)) refs.add(id);
  if (a.clipsFor !== undefined && known.has(a.clipsFor)) refs.add(a.clipsFor);
  const current = a.versions.find((v) => v.version === a.currentVersion);
  for (const layer of current?.packedFrom?.layers ?? []) for (const c of layer) if ('assetId' in c && c.assetId !== undefined && known.has(c.assetId)) refs.add(c.assetId);
  const path = current?.sourcePath ?? current?.convertedFrom?.sourcePath ?? null;
  return { kind: a.kind ?? 'model', id: a.assetId, path, name: a.displayName ?? a.assetId, labels: a.labels ?? [], address: a.address ?? null, refs: [...refs].sort() };
}

function resourceEntry(k: ResourceKind, r: Record<string, unknown>, path: string | undefined, known: Known, loading: ResourceLoading | undefined): IndexEntry {
  const id = String(r[k.idKey]);
  const refs = new Set<string>();
  stringRefs(r, known, id, refs);
  const name = typeof r['name'] === 'string' ? r['name'] : typeof r['displayName'] === 'string' ? r['displayName'] : id;
  return { kind: k.kind, id, path: path ?? null, name, labels: loading?.labels ?? [], address: loading?.address ?? null, refs: [...refs].sort() };
}

function sceneEntry(scene: SceneV4, name: string, rel: string | undefined, known: Known): IndexEntry {
  const refs = new Set<string>();
  for (const e of scene.entities) stringRefs(e.components, known, scene.sceneId, refs);
  return { kind: 'scene', id: scene.sceneId, path: displayPathOf(rel ?? sceneRel(scene.sceneId)), name, labels: [], address: null, refs: [...refs].sort() };
}

function addReferrers(referrers: Map<string, Set<string>>, key: string, refs: readonly string[]): void {
  for (const id of refs) {
    let set = referrers.get(id);
    if (set === undefined) {
      set = new Set();
      referrers.set(id, set);
    }
    set.add(key);
  }
}

function dropReferrers(referrers: Map<string, Set<string>>, key: string, refs: readonly string[]): void {
  for (const id of refs) {
    const set = referrers.get(id);
    if (set === undefined) continue;
    set.delete(key);
    if (set.size === 0) referrers.delete(id);
  }
}

/** The index of a whole project (the open). */
export function buildIndex(src: IndexSource): ProjectIndex {
  const known = allIds(src);
  const entries = new Map<string, IndexEntry>();
  for (const a of src.content.assets as unknown as AssetLike[]) {
    const e = assetEntry(a, known);
    entries.set(keyOf(e.kind, e.id), e);
  }
  const loading = loadingByKey(src.content);
  for (const k of RESOURCE_KINDS) {
    const paths = src.resourcePaths.get(k.list);
    for (const r of listOf(src.content, k)) {
      const e = resourceEntry(k, r, paths?.get(String(r[k.idKey])), known, loading.get(`${k.kind}:${String(r[k.idKey])}`));
      entries.set(keyOf(e.kind, e.id), e);
    }
  }
  const names = new Map(src.content.scenes.map((s) => [s.sceneId, s.name]));
  for (const scene of src.scenes.values()) {
    const e = sceneEntry(scene, names.get(scene.sceneId) ?? scene.sceneId, src.scenePaths?.get(scene.sceneId), known);
    entries.set(keyOf(e.kind, e.id), e);
  }
  const referrers = new Map<string, Set<string>>();
  const ids = new Map<string, number>();
  for (const [key, e] of entries) {
    addReferrers(referrers, key, e.refs);
    ids.set(e.id, (ids.get(e.id) ?? 0) + 1);
  }
  return { entries, referrers, ids };
}

/**
 * Bring the index up to a command's result, in place (the session publishes
 * the result it indexes): only the lists and scenes the command replaced are
 * compared, record by record (by identity), and only the records that differ
 * are indexed again.
 */
export function updateIndex(index: ProjectIndex, before: IndexSource, after: IndexSource): void {
  const entries = index.entries as Map<string, IndexEntry>;
  const referrers = index.referrers as Map<string, Set<string>>;
  const ids = index.ids as Map<string, number>;
  // First what changed (so a record may reference one added by the same command), then the entries.
  const puts: (() => IndexEntry)[] = [];
  const removes: string[] = [];
  const known: Known = { has: (id) => ids.has(id) };
  const addId = (id: string): void => void ids.set(id, (ids.get(id) ?? 0) + 1);
  const dropId = (id: string): void => {
    const n = (ids.get(id) ?? 1) - 1;
    if (n <= 0) ids.delete(id);
    else ids.set(id, n);
  };
  const stage = (kind: string, id: string, make: () => IndexEntry): void => {
    if (!entries.has(keyOf(kind, id))) addId(id);
    puts.push(make);
  };
  // Assets.
  if (before.content.assets !== after.content.assets) {
    const prev = new Map((before.content.assets as unknown as AssetLike[]).map((a) => [a.assetId, a]));
    const kept = new Set<string>();
    for (const a of after.content.assets as unknown as AssetLike[]) {
      kept.add(a.assetId);
      const p = prev.get(a.assetId);
      if (p === a) continue;
      if (p !== undefined && (p.kind ?? 'model') !== (a.kind ?? 'model')) removes.push(keyOf(p.kind ?? 'model', p.assetId));
      stage(a.kind ?? 'model', a.assetId, () => assetEntry(a, known));
    }
    for (const [id, a] of prev) if (!kept.has(id)) removes.push(keyOf(a.kind ?? 'model', id));
  }
  // Resources (and those whose address or labels changed).
  const loadingBefore = (before.content as { loadable?: unknown }).loadable;
  const loading = loadingByKey(after.content);
  const renamed = new Set<string>();
  if (loadingBefore !== (after.content as { loadable?: unknown }).loadable) {
    const was = loadingByKey(before.content);
    for (const key of new Set([...was.keys(), ...loading.keys()])) if (JSON.stringify(was.get(key)) !== JSON.stringify(loading.get(key))) renamed.add(key);
  }
  const renamedKinds = new Set([...renamed].map((key) => key.slice(0, key.indexOf(':'))));
  for (const k of RESOURCE_KINDS) {
    const a = listOf(before.content, k);
    const b = listOf(after.content, k);
    const paths = after.resourcePaths.get(k.list);
    const pathsChanged = before.resourcePaths.get(k.list) !== paths;
    const renamedHere = renamedKinds.has(k.kind);
    if (a === b && !pathsChanged && !renamedHere) continue;
    // A command replaces a few records of a list and keeps the others in place: records at the same
    // position are compared first, the lists are matched by id only when they are not aligned.
    let prev: Map<string, Record<string, unknown>> | null = null;
    const before_ = (i: number, id: string): Record<string, unknown> | undefined => {
      const at = a[i];
      if (at !== undefined && String(at[k.idKey]) === id) return at;
      return (prev ??= new Map(a.map((r) => [String(r[k.idKey]), r]))).get(id);
    };
    let aligned = a.length === b.length;
    for (let i = 0; i < b.length; i += 1) {
      const r = b[i]!;
      if (aligned && a[i] === r && !pathsChanged && !renamedHere) continue;
      const id = String(r[k.idKey]);
      if (aligned && String(a[i]?.[k.idKey]) !== id) aligned = false;
      if (before_(i, id) === r && entries.get(keyOf(k.kind, id))?.path === (paths?.get(id) ?? null) && !renamed.has(keyOf(k.kind, id))) continue;
      stage(k.kind, id, () => resourceEntry(k, r, paths?.get(id), known, loading.get(keyOf(k.kind, id))));
    }
    if (!aligned) {
      const kept = new Set(b.map((r) => String(r[k.idKey])));
      for (const r of a) if (!kept.has(String(r[k.idKey]))) removes.push(keyOf(k.kind, String(r[k.idKey])));
    }
  }
  // Scenes.
  const names = new Map(after.content.scenes.map((sc) => [sc.sceneId, sc.name]));
  const namesBefore = before.content.scenes === after.content.scenes ? names : new Map(before.content.scenes.map((sc) => [sc.sceneId, sc.name]));
  for (const [id, scene] of after.scenes) {
    if (before.scenes.get(id) === scene && namesBefore.get(id) === names.get(id) && before.scenePaths?.get(id) === after.scenePaths?.get(id)) continue;
    stage('scene', id, () => sceneEntry(scene, names.get(id) ?? id, after.scenePaths?.get(id), known));
  }
  for (const id of before.scenes.keys()) if (!after.scenes.has(id)) removes.push(keyOf('scene', id));
  for (const key of removes) {
    const old = entries.get(key);
    if (old === undefined) continue;
    orderedKeys.delete(index);
    dropReferrers(referrers, key, old.refs);
    entries.delete(key);
    dropId(old.id);
  }
  let changed = removes.length > 0;
  for (const make of puts) {
    const e = make();
    const key = keyOf(e.kind, e.id);
    const old = entries.get(key);
    // A record edited without changing what the index says of it (a material's values, a scene's objects) keeps its entry.
    if (old !== undefined && sameEntry(old, e)) continue;
    changed = true;
    if (old !== undefined) dropReferrers(referrers, key, old.refs);
    else orderedKeys.delete(index);
    entries.set(key, e);
    addReferrers(referrers, key, e.refs);
  }
  if (changed) generations.set(index, (generations.get(index) ?? 0) + 1);
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function sameEntry(a: IndexEntry, b: IndexEntry): boolean {
  return a.kind === b.kind && a.id === b.id && a.path === b.path && a.name === b.name && a.address === b.address && sameList(a.labels, b.labels) && sameList(a.refs, b.refs);
}

/** Goes up whenever an update changed an entry: what a query answered before still holds while it stays. */
export function indexGeneration(index: ProjectIndex): number {
  return generations.get(index) ?? 0;
}

/** Goes up whenever an update changed an entry (orders by name or path are made again, query answers are not reused). */
const generations = new WeakMap<ProjectIndex, number>();

/** How the index can be ordered besides `kind:id`. */
export type IndexOrder = 'name' | 'kind' | 'path';

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const orders = new WeakMap<ProjectIndex, Map<IndexOrder, { generation: number; keys: readonly string[] }>>();

/**
 * The index's keys in an order (Unity's project window sorts by name, type or
 * path; ties in `kind:id` order), made once per change of the index and kept.
 */
export function orderedBy(index: ProjectIndex, order: IndexOrder): readonly string[] {
  const generation = generations.get(index) ?? 0;
  let byOrder = orders.get(index);
  if (byOrder === undefined) {
    byOrder = new Map();
    orders.set(index, byOrder);
  }
  const have = byOrder.get(order);
  if (have !== undefined && have.generation === generation && have.keys.length === index.entries.size) return have.keys;
  const base = sortedKeys(index);
  const rank = new Map(base.map((k, i) => [k, i]));
  const field = (k: string): string => {
    const e = index.entries.get(k)!;
    return order === 'path' ? (e.path ?? '') : e.name;
  };
  const kindOf = (k: string): string => index.entries.get(k)!.kind;
  // By kind: then by name within a kind.
  const keys = [...base].sort((a, b) => (order === 'kind' ? collator.compare(kindOf(a), kindOf(b)) : 0) || collator.compare(field(a), field(b)) || rank.get(a)! - rank.get(b)!);
  byOrder.set(order, { generation, keys });
  return keys;
}

/** Each index's keys in ascending order, made when first asked for after the key set changed (queries page from it). */
const orderedKeys = new WeakMap<ProjectIndex, readonly string[]>();

/** The index's `kind:id` keys, ascending. */
export function sortedKeys(index: ProjectIndex): readonly string[] {
  let keys = orderedKeys.get(index);
  if (keys === undefined || keys.length !== index.entries.size) {
    keys = [...index.entries.keys()].sort();
    orderedKeys.set(index, keys);
  }
  return keys;
}

/** The entries that reference an id (by `kind:id`, ascending). */
export function referencesTo(index: ProjectIndex, id: string): IndexEntry[] {
  const keys = [...(index.referrers.get(id) ?? [])].sort();
  return keys.map((k) => index.entries.get(k)).filter((e): e is IndexEntry => e !== undefined);
}
