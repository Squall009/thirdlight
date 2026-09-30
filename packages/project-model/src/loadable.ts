/**
 * Addresses and labels: the names a script loads an asset or a resource by
 * (Unity's Addressables keys and labels).
 *
 * An asset keeps its address and labels on its catalog record (its sidecar
 * holds them). A resource (prefab, material, dialogue, …) keeps them in its
 * resource file, beside its record rather than in it: the record's own shape,
 * and every command that replaces a record, stay as they are. In the content
 * block they are the `loadable` list, one entry per resource that has any.
 *
 * Whatever has an address or a label is loadable: Play and export ship it
 * even when no scene references it, and the runtime catalog names it.
 */
import { ADDRESS_RE } from './content-limits';
import { isAssetLabel } from './content-assets';
import type { ModelErrorV2 } from './errors';
import { fieldType, fieldValue, ID_RE, isPlainObject, pointerSegment, unexpectedField, withFound } from './validate';

/** One kind of project resource: its content list, its id field, its default folder (under the asset folder). */
export interface ResourceKindDef {
  /** The name a resource file states (also its name's second extension). */
  readonly kind: string;
  /** The content block's list of these records (`environment.presets` for the one nested list). */
  readonly list: string;
  readonly idKey: string;
  readonly folder: string;
}

/** The one resource list that is not a key of the content block: the environment's presets. */
export const ENV_PRESETS_LIST = 'environment.presets';

/** Every kind of resource, in the content block's key order. */
export const RESOURCE_KIND_TABLE: readonly ResourceKindDef[] = [
  { kind: 'prefab', list: 'prefabs', idKey: 'prefabId', folder: 'prefabs' },
  { kind: 'behavior', list: 'behaviors', idKey: 'behaviorId', folder: 'behaviors' },
  { kind: 'material', list: 'materials', idKey: 'materialId', folder: 'materials' },
  { kind: 'animator', list: 'animators', idKey: 'controllerId', folder: 'animators' },
  { kind: 'graph', list: 'graphs', idKey: 'graphId', folder: 'graphs' },
  { kind: 'effect', list: 'effects', idKey: 'effectId', folder: 'effects' },
  { kind: 'library', list: 'scriptLibraries', idKey: 'libraryId', folder: 'libraries' },
  { kind: 'ui', list: 'uiDocuments', idKey: 'uiDocumentId', folder: 'ui' },
  { kind: 'uitheme', list: 'uiThemes', idKey: 'uiThemeId', folder: 'ui' },
  { kind: 'dialogue', list: 'dialogues', idKey: 'dialogueId', folder: 'dialogue' },
  { kind: 'timeline', list: 'timelines', idKey: 'timelineId', folder: 'timelines' },
  { kind: 'envpreset', list: ENV_PRESETS_LIST, idKey: 'presetId', folder: 'environment' },
];

const BY_KIND = new Map(RESOURCE_KIND_TABLE.map((k) => [k.kind, k]));

/** A resource kind by name (undefined: not a resource kind). */
export function resourceKindDef(kind: string): ResourceKindDef | undefined {
  return BY_KIND.get(kind);
}

/** A kind's records in a content block (undefined: none). */
export function resourceRecordsOf(content: unknown, k: ResourceKindDef): readonly Record<string, unknown>[] | undefined {
  const c = content as Record<string, unknown> | null;
  if (c === null || typeof c !== 'object') return undefined;
  const list = k.list === ENV_PRESETS_LIST ? (c['environment'] as { presets?: unknown } | undefined)?.presets : c[k.list];
  return Array.isArray(list) ? (list as Record<string, unknown>[]) : undefined;
}

/** A resource's address and labels (at least one is present). */
export interface LoadableEntry {
  kind: string;
  id: string;
  address?: string;
  labels?: string[];
}

/** Whether a value is one address. */
export function isAddress(v: unknown): v is string {
  return typeof v === 'string' && ADDRESS_RE.test(v);
}

/** Whether a record or entry has an address or a label. */
export function isLoadable(r: { readonly address?: unknown; readonly labels?: unknown }): boolean {
  return r.address !== undefined || (Array.isArray(r.labels) && r.labels.length > 0);
}

const keyOf = (kind: string, id: string): string => `${kind}:${id}`;

/** The `loadable` list as the content block keeps it: by kind, then id. */
export function canonicalLoadable(list: readonly LoadableEntry[]): LoadableEntry[] {
  return [...list]
    .sort((a, b) => (keyOf(a.kind, a.id) < keyOf(b.kind, b.id) ? -1 : keyOf(a.kind, a.id) > keyOf(b.kind, b.id) ? 1 : 0))
    .map((e) => ({ kind: e.kind, id: e.id, ...(e.address !== undefined ? { address: e.address } : {}), ...(e.labels !== undefined && e.labels.length > 0 ? { labels: [...e.labels] } : {}) }));
}

/** The ids each resource kind has now. */
function liveResourceIds(doc: unknown): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const k of RESOURCE_KIND_TABLE) out.set(k.kind, new Set((resourceRecordsOf(doc, k) ?? []).map((r) => String(r[k.idKey]))));
  return out;
}

/**
 * The entries of `loadable` whose resource is in the project. An entry
 * outlives its resource while the project is open (a delete leaves it, so
 * undoing the delete brings the labels back); it is never written without
 * the resource's file, so the next open has none.
 */
export function liveLoadable(doc: unknown): LoadableEntry[] {
  const list = (doc as { loadable?: LoadableEntry[] } | null)?.loadable ?? [];
  if (list.length === 0) return [];
  const live = liveResourceIds(doc);
  return list.filter((e) => live.get(e.kind)?.has(e.id) === true);
}

/**
 * `content.loadable` (v4): each entry `{kind, id, address?, labels?}` names a
 * resource kind and id, has an address or labels, and appears once; and no
 * address is used twice across the project's assets and resources.
 */
export function validateLoadable(doc: Record<string, unknown>, errors: ModelErrorV2[]): void {
  const list = doc['loadable'];
  if (list !== undefined) {
    if (!Array.isArray(list)) {
      errors.push(fieldType('/loadable', list, 'array of { kind, id, address?, labels? }'));
      return;
    }
    const seen = new Set<string>();
    list.forEach((e, i) => {
      const p = `/loadable/${i}`;
      if (!isPlainObject(e)) {
        errors.push(fieldType(p, e, 'object { kind, id, address?, labels? }'));
        return;
      }
      for (const k of Object.keys(e)) if (!['kind', 'id', 'address', 'labels'].includes(k)) errors.push(unexpectedField(`${p}/${pointerSegment(k)}`, k, 'kind, id, address, labels'));
      if (typeof e['kind'] !== 'string' || !BY_KIND.has(e['kind'])) errors.push(fieldValue(`${p}/kind`, e['kind'], RESOURCE_KIND_TABLE.map((k) => k.kind).join(', '), 'a loadable entry names a resource kind'));
      if (typeof e['id'] !== 'string' || !ID_RE.test(e['id'])) errors.push(fieldValue(`${p}/id`, e['id'], 'a resource id', 'a loadable entry names a resource id'));
      if (e['address'] !== undefined && !isAddress(e['address'])) errors.push(fieldValue(`${p}/address`, e['address'], 'a letter or digit, then letters, digits, _ - . / (at most 128)', 'an address has no spaces or other punctuation'));
      const labels = e['labels'];
      if (labels !== undefined && (!Array.isArray(labels) || labels.length === 0 || !labels.every(isAssetLabel) || labels.some((l, j) => j > 0 && !((labels[j - 1] as string) < (l as string))))) {
        errors.push(fieldValue(`${p}/labels`, labels, 'ascending unique labels (a letter or digit, then letters, digits, _ - . /; at most 64)', 'labels are a non-empty ascending list of unique labels'));
      }
      if (e['address'] === undefined && labels === undefined) errors.push(fieldValue(p, e, 'an address or labels', 'a loadable entry has an address or labels'));
      const key = keyOf(String(e['kind']), String(e['id']));
      if (seen.has(key)) errors.push(withFound({ code: 'id_duplicate', path: `${p}/id`, message: `${key} has two loadable entries`, expected: 'one entry per resource' }, key));
      seen.add(key);
    });
    if (errors.length > 0) return;
  }
  validateAddressesUnique(doc, errors);
}

/** No address names two things (an asset and a resource, or two of either). */
function validateAddressesUnique(doc: Record<string, unknown>, errors: ModelErrorV2[]): void {
  const owners = new Map<string, string>();
  const claim = (address: string, owner: string, path: string): void => {
    const first = owners.get(address);
    if (first === undefined) {
      owners.set(address, owner);
      return;
    }
    errors.push(withFound({ code: 'id_duplicate', path, reason: 'address_taken', message: `an address is unique project-wide: "${address}" is the address of ${first} and ${owner}`.slice(0, 256), expected: 'an address no other asset or resource has' }, address));
  };
  const assets = Array.isArray(doc['assets']) ? (doc['assets'] as unknown[]) : [];
  assets.forEach((a, i) => {
    if (isPlainObject(a) && typeof a['address'] === 'string') claim(a['address'], `asset ${String(a['assetId'])}`, `/assets/${i}/address`);
  });
  const list = Array.isArray(doc['loadable']) ? (doc['loadable'] as LoadableEntry[]) : [];
  if (!list.some((e) => e.address !== undefined)) return;
  const live = liveResourceIds(doc);
  list.forEach((e, i) => {
    if (e.address !== undefined && live.get(e.kind)?.has(e.id) === true) claim(e.address, `${e.kind} ${e.id}`, `/loadable/${i}/address`);
  });
}

/** The ids of the assets that have an address or a label. */
export function loadableAssetIds(content: unknown): string[] {
  const assets = (content as { assets?: readonly { assetId: string; address?: string; labels?: readonly string[] }[] } | null)?.assets ?? [];
  return assets.filter((a) => isLoadable(a)).map((a) => a.assetId);
}

/** The ids of one resource kind's loadable resources (only those the project has). */
export function loadableResourceIds(content: unknown, kind: string): Set<string> {
  return new Set(liveLoadable(content).filter((e) => e.kind === kind).map((e) => e.id));
}

/** One row of the runtime's catalog of loadable things: an asset (its kind) or a resource. */
export interface LoadableRow {
  kind: string;
  id: string;
  address?: string;
  labels?: string[];
}

/**
 * Every loadable asset and resource, as the runtime catalog lists them (by
 * kind, then id): an asset's row has its asset kind (`model`, `audio`, …), a
 * resource's its resource kind. `shipped` keeps only what the build holds.
 */
export function loadableRows(content: unknown, shipped?: { assets: ReadonlySet<string> }): LoadableRow[] {
  const rows: LoadableRow[] = [];
  const assets = (content as { assets?: readonly { assetId: string; kind?: string; address?: string; labels?: readonly string[] }[] } | null)?.assets ?? [];
  for (const a of assets) {
    if (!isLoadable(a) || (shipped !== undefined && !shipped.assets.has(a.assetId))) continue;
    rows.push({ kind: a.kind ?? 'model', id: a.assetId, ...(a.address !== undefined ? { address: a.address } : {}), ...(a.labels !== undefined && a.labels.length > 0 ? { labels: [...a.labels] } : {}) });
  }
  for (const e of liveLoadable(content)) rows.push({ kind: e.kind, id: e.id, ...(e.address !== undefined ? { address: e.address } : {}), ...(e.labels !== undefined ? { labels: [...e.labels] } : {}) });
  return rows.sort((a, b) => (keyOf(a.kind, a.id) < keyOf(b.kind, b.id) ? -1 : keyOf(a.kind, a.id) > keyOf(b.kind, b.id) ? 1 : 0));
}

/** The manifest's `loadable` rows are well formed (kind, id, and an address or labels). */
export function loadableRowsProblem(v: unknown): string | null {
  if (!Array.isArray(v)) return 'loadable is a list';
  for (const [i, r] of v.entries()) {
    if (!isPlainObject(r)) return `loadable[${i}] is not an object`;
    for (const k of Object.keys(r)) if (!['kind', 'id', 'address', 'labels'].includes(k)) return `loadable[${i}] has an unknown key "${k}"`;
    if (typeof r['kind'] !== 'string' || typeof r['id'] !== 'string' || !ID_RE.test(r['id'])) return `loadable[${i}] needs a kind and an id`;
    if (r['address'] !== undefined && !isAddress(r['address'])) return `loadable[${i}].address is not an address`;
    if (r['labels'] !== undefined && (!Array.isArray(r['labels']) || !r['labels'].every(isAssetLabel))) return `loadable[${i}].labels are not labels`;
    if (r['address'] === undefined && r['labels'] === undefined) return `loadable[${i}] has neither an address nor labels`;
  }
  return null;
}
