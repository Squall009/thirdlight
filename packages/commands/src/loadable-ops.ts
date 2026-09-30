/**
 * `setLabels` and `setAddress`: the names scripts load assets and resources
 * by (Unity's Addressables labels and keys). Each is one command and one
 * undo however many items it names, so labelling a thousand voice lines is
 * one revision.
 *
 * An item is `{kind, id}`: `kind` is `asset` (or the asset's own kind,
 * `model`, `audio`, …, as the index lists it) or a resource kind (`prefab`,
 * `material`, `dialogue`, …). An asset's address and labels are on its
 * record; a resource's are its entry in `content.loadable` (its resource file
 * holds them), so the resource's own record is never rewritten.
 */
import { canonicalLabels, isAddress, isAssetLabel, isLoadable, liveLoadable, resourceKindDef, resourceRecordsOf, type LoadableEntry } from '@thirdlight/project-model';

import { contentOf, type OpInput } from './content-ops';
import { assetNotFound, fieldMissing, fieldType, fieldUnexpected, fieldValue, isPlainObject, noChangeContent, type CommandError } from './errors';
import { deepClone, gateResultState, type OpOutcome } from './ops';
import type { CommandAssetRecord, ContentDocument, SceneDocument } from './types';

/** An asset or a resource, by kind and id. */
export interface LoadableItemRef {
  kind: string;
  id: string;
}

/** `setLabels` args: labels added to and removed from every item named. */
export interface SetLabelsArgs {
  items: LoadableItemRef[];
  add?: string[];
  remove?: string[];
}

/** `setAddress` args: one item's address (null: none). */
export interface SetAddressArgs {
  kind: string;
  id: string;
  address: string | null;
}

/** An item's address and labels (absent: none). */
export interface LoadingValue {
  address?: string;
  labels?: string[];
}

/** One item a `setLabels`/`setAddress` changed (kind `asset` or a resource kind). */
export interface LoadingItemChange {
  kind: string;
  id: string;
  previous: LoadingValue;
  next: LoadingValue;
}

/** `setLabels` / `setAddress` change data: every item it changed, before and after. */
export type SetLoadingChange = { type: 'setLabels'; items: LoadingItemChange[] } | { type: 'setAddress'; items: LoadingItemChange[] };

/** Undo of either: the items' values before. */
export interface SetLoadingInverse {
  kind: 'setLoading';
  op: 'setLabels' | 'setAddress';
  items: { kind: string; id: string; value: LoadingValue }[];
}

/** The kind an item is stored as: `asset`, or a resource kind (null: neither). */
function storedKind(kind: string): string | null {
  if (resourceKindDef(kind) !== undefined) return kind;
  return kind === 'asset' || kind === 'model' || kind === 'texture' || kind === 'audio' || kind === 'font' ? 'asset' : null;
}

const ITEM_KINDS = 'asset (or model, texture, audio, font) or a resource kind (prefab, behavior, material, animator, graph, effect, library, ui, uitheme, dialogue, timeline, envpreset)';

function validateItem(v: unknown, path: string): { ok: true; item: LoadableItemRef } | { ok: false; error: CommandError } {
  if (!isPlainObject(v)) return { ok: false, error: fieldType(path, v, 'object { kind, id }') };
  for (const k of Object.keys(v)) if (k !== 'kind' && k !== 'id') return { ok: false, error: fieldUnexpected(`${path}/${k}`, k, 'kind, id') };
  if (typeof v['kind'] !== 'string' || storedKind(v['kind']) === null) return { ok: false, error: fieldValue(`${path}/kind`, v['kind'], ITEM_KINDS, 'kind says whether the item is an asset or which kind of resource') };
  if (typeof v['id'] !== 'string' || v['id'].length === 0) return { ok: false, error: fieldType(`${path}/id`, v['id'], 'string (an asset or resource id)') };
  return { ok: true, item: { kind: v['kind'], id: v['id'] } };
}

function validateLabelList(v: unknown, path: string): { ok: true; labels: string[] } | { ok: false; error: CommandError } {
  if (!Array.isArray(v)) return { ok: false, error: fieldType(path, v, 'array of labels') };
  for (let i = 0; i < v.length; i++) {
    if (!isAssetLabel(v[i])) return { ok: false, error: fieldValue(`${path}/${i}`, v[i], 'a letter or digit, then letters, digits, _ - . / (at most 64)', 'a label has no spaces or other punctuation') };
  }
  return { ok: true, labels: canonicalLabels(v as string[]) };
}

export function validateSetLabelsArgs(args: Record<string, unknown>): { ok: true; args: SetLabelsArgs } | { ok: false; error: CommandError } {
  for (const k of Object.keys(args)) if (k !== 'items' && k !== 'add' && k !== 'remove') return { ok: false, error: fieldUnexpected(`/args/${k}`, k, 'items, add (optional), remove (optional)') };
  if (args['items'] === undefined) return { ok: false, error: fieldMissing('/args/items', 'items') };
  if (!Array.isArray(args['items'])) return { ok: false, error: fieldType('/args/items', args['items'], 'array of { kind, id }') };
  if (args['items'].length === 0) return { ok: false, error: fieldValue('/args/items', args['items'], 'at least one item', 'items names the assets and resources to label') };
  const items: LoadableItemRef[] = [];
  for (let i = 0; i < args['items'].length; i++) {
    const r = validateItem(args['items'][i], `/args/items/${i}`);
    if (!r.ok) return r;
    items.push(r.item);
  }
  const out: SetLabelsArgs = { items };
  for (const key of ['add', 'remove'] as const) {
    if (args[key] === undefined) continue;
    const r = validateLabelList(args[key], `/args/${key}`);
    if (!r.ok) return r;
    out[key] = r.labels;
  }
  if ((out.add ?? []).length === 0 && (out.remove ?? []).length === 0) return { ok: false, error: fieldValue('/args', args, 'add or remove with at least one label', 'setLabels adds or removes labels') };
  return { ok: true, args: out };
}

export function validateSetAddressArgs(args: Record<string, unknown>): { ok: true; args: SetAddressArgs } | { ok: false; error: CommandError } {
  for (const k of Object.keys(args)) if (k !== 'kind' && k !== 'id' && k !== 'address') return { ok: false, error: fieldUnexpected(`/args/${k}`, k, 'kind, id, address') };
  const item = validateItem({ kind: args['kind'], id: args['id'] }, '/args');
  if (!item.ok) return item;
  if (!('address' in args)) return { ok: false, error: fieldMissing('/args/address', 'address') };
  const address = args['address'];
  if (address !== null && !isAddress(address)) return { ok: false, error: fieldValue('/args/address', address, 'null or a letter or digit, then letters, digits, _ - . / (at most 128)', 'an address has no spaces or other punctuation') };
  return { ok: true, args: { kind: item.item.kind, id: item.item.id, address } };
}

const keyOf = (kind: string, id: string): string => `${kind}:${id}`;

function valueOfAsset(a: { address?: string; labels?: string[] }): LoadingValue {
  return { ...(a.address !== undefined ? { address: a.address } : {}), ...(a.labels !== undefined && a.labels.length > 0 ? { labels: [...a.labels] } : {}) };
}

/** Every item's current value, or the error for one the project does not have. */
function currentValues(content: ContentDocument, items: readonly LoadableItemRef[]): { ok: true; values: Map<string, { kind: string; id: string; value: LoadingValue }> } | { ok: false; error: CommandError } {
  const assets = new Map((content.assets as unknown as CommandAssetRecord[]).map((a) => [a.assetId, a]));
  const entries = new Map(((content as { loadable?: LoadableEntry[] }).loadable ?? []).map((e) => [keyOf(e.kind, e.id), e]));
  const out = new Map<string, { kind: string; id: string; value: LoadingValue }>();
  for (const [i, ref] of items.entries()) {
    const kind = storedKind(ref.kind)!;
    const key = keyOf(kind, ref.id);
    if (out.has(key)) continue;
    if (kind === 'asset') {
      const a = assets.get(ref.id);
      if (a === undefined) return { ok: false, error: assetNotFound(ref.id) };
      out.set(key, { kind, id: ref.id, value: valueOfAsset(a as { address?: string; labels?: string[] }) });
      continue;
    }
    const def = resourceKindDef(kind)!;
    if (!(resourceRecordsOf(content, def) ?? []).some((r) => r[def.idKey] === ref.id)) {
      return { ok: false, error: fieldValue(`/args/items/${i}/id`, ref.id, `the id of a ${kind} of this project`, `no ${kind} "${ref.id}" in this project`) };
    }
    const e = entries.get(key);
    out.set(key, { kind, id: ref.id, value: e === undefined ? {} : valueOfAsset(e) });
  }
  return { ok: true, values: out };
}

const sameValue = (a: LoadingValue, b: LoadingValue): boolean => a.address === b.address && (a.labels ?? []).join('\u0000') === (b.labels ?? []).join('\u0000');

/**
 * The content with these items' values set: asset records replaced (only
 * those that change), resource entries replaced, added or removed (an entry
 * with neither an address nor labels goes).
 */
export function withLoadingValues(content: ContentDocument, items: readonly { kind: string; id: string; value: LoadingValue }[]): ContentDocument {
  const assetValues = new Map(items.filter((i) => i.kind === 'asset').map((i) => [i.id, i.value]));
  const resourceValues = new Map(items.filter((i) => i.kind !== 'asset').map((i) => [keyOf(i.kind, i.id), i]));
  let next: ContentDocument = content;
  if (assetValues.size > 0) {
    const assets = (content.assets as unknown as CommandAssetRecord[]).map((a) => {
      const v = assetValues.get(a.assetId);
      if (v === undefined) return a;
      const { address: _a, labels: _l, ...rest } = a as CommandAssetRecord & { address?: string; labels?: string[] };
      return { ...rest, ...(v.labels !== undefined && v.labels.length > 0 ? { labels: [...v.labels] } : {}), ...(v.address !== undefined ? { address: v.address } : {}) } as CommandAssetRecord;
    });
    next = { ...next, assets: assets as unknown as ContentDocument['assets'] };
  }
  if (resourceValues.size > 0) {
    const kept = ((content as { loadable?: LoadableEntry[] }).loadable ?? []).filter((e) => !resourceValues.has(keyOf(e.kind, e.id)));
    for (const { kind, id, value } of resourceValues.values()) {
      if (isLoadable(value)) kept.push({ kind, id, ...(value.address !== undefined ? { address: value.address } : {}), ...(value.labels !== undefined && value.labels.length > 0 ? { labels: [...value.labels] } : {}) });
    }
    kept.sort((a, b) => (keyOf(a.kind, a.id) < keyOf(b.kind, b.id) ? -1 : keyOf(a.kind, a.id) > keyOf(b.kind, b.id) ? 1 : 0));
    const { loadable: _old, ...rest } = next as ContentDocument & { loadable?: LoadableEntry[] };
    next = (kept.length > 0 ? { ...rest, loadable: kept } : rest) as ContentDocument;
  }
  return next;
}

/** Who has an address now (an asset or a resource the project has), other than `self`. */
function addressOwner(content: ContentDocument, address: string, self: string): string | null {
  for (const a of content.assets as unknown as { assetId: string; address?: string }[]) if (a.address === address && keyOf('asset', a.assetId) !== self) return `asset ${a.assetId}`;
  for (const e of liveLoadable(content)) if (e.address === address && keyOf(e.kind, e.id) !== self) return `${e.kind} ${e.id}`;
  return null;
}

function commit(input: OpInput, op: 'setLabels' | 'setAddress', changes: LoadingItemChange[]): OpOutcome {
  if (changes.length === 0) return { ok: false, error: noChangeContent() };
  const catalog = contentOf(input.content);
  const nextContent = withLoadingValues(catalog, changes.map((c) => ({ kind: c.kind, id: c.id, value: c.next })));
  const resultScene = { ...input.scene, revision: input.scene.revision + 1 };
  const gate = gateResultState({ scene: input.scene, content: catalog, manifest: input.manifest }, resultScene, nextContent);
  if (!gate.ok) return gate;
  const change: SetLoadingChange = { type: op, items: changes };
  const inverse: SetLoadingInverse = { kind: 'setLoading', op, items: changes.map((c) => ({ kind: c.kind, id: c.id, value: deepClone(c.previous) })) };
  return { ok: true, op: { scene: gate.scene, content: gate.content, change, inverse } };
}

export function applySetLabels(input: OpInput, args: SetLabelsArgs): OpOutcome {
  const catalog = contentOf(input.content);
  const current = currentValues(catalog, args.items);
  if (!current.ok) return current;
  const add = args.add ?? [];
  const remove = new Set(args.remove ?? []);
  const changes: LoadingItemChange[] = [];
  for (const { kind, id, value } of current.values.values()) {
    const labels = canonicalLabels([...(value.labels ?? []), ...add]).filter((l) => !remove.has(l));
    const next: LoadingValue = { ...(value.address !== undefined ? { address: value.address } : {}), ...(labels.length > 0 ? { labels } : {}) };
    if (!sameValue(value, next)) changes.push({ kind, id, previous: value, next });
  }
  return commit(input, 'setLabels', changes);
}

export function applySetAddress(input: OpInput, args: SetAddressArgs): OpOutcome {
  const catalog = contentOf(input.content);
  const current = currentValues(catalog, [{ kind: args.kind, id: args.id }]);
  if (!current.ok) return current;
  const { kind, id, value } = [...current.values.values()][0]!;
  if (args.address !== null) {
    const owner = addressOwner(catalog, args.address, keyOf(kind, id));
    if (owner !== null) return { ok: false, error: fieldValue('/args/address', args.address, 'an address no other asset or resource has', `an address is unique project-wide: "${args.address}" is already the address of ${owner}`) };
  }
  const next: LoadingValue = { ...(args.address !== null ? { address: args.address } : {}), ...(value.labels !== undefined ? { labels: [...value.labels] } : {}) };
  return commit(input, 'setAddress', sameValue(value, next) ? [] : [{ kind, id, previous: value, next }]);
}

/** Undo: the items' earlier values (the change states them in the direction applied). */
export function undoSetLoading(scene: SceneDocument, content: ContentDocument, inverse: SetLoadingInverse): { scene: SceneDocument; content: ContentDocument; change: SetLoadingChange } {
  const now = currentOf(content, inverse.items);
  return {
    scene: { ...scene, revision: scene.revision + 1 },
    content: withLoadingValues(content, inverse.items),
    change: { type: inverse.op, items: inverse.items.map((i) => ({ kind: i.kind, id: i.id, previous: now.get(keyOf(i.kind, i.id)) ?? {}, next: deepClone(i.value) })) },
  };
}

/** Redo: the values the command set. */
export function redoSetLoading(scene: SceneDocument, content: ContentDocument, forward: SetLoadingChange): { scene: SceneDocument; content: ContentDocument; change: SetLoadingChange } {
  const values = forward.items.map((i) => ({ kind: i.kind, id: i.id, value: i.next }));
  const now = currentOf(content, values);
  return {
    scene: { ...scene, revision: scene.revision + 1 },
    content: withLoadingValues(content, values),
    change: { type: forward.type, items: forward.items.map((i) => ({ kind: i.kind, id: i.id, previous: now.get(keyOf(i.kind, i.id)) ?? {}, next: deepClone(i.next) })) },
  };
}

function currentOf(content: ContentDocument, items: readonly { kind: string; id: string }[]): Map<string, LoadingValue> {
  const wanted = new Set(items.map((i) => keyOf(i.kind, i.id)));
  const out = new Map<string, LoadingValue>();
  for (const a of content.assets as unknown as { assetId: string; address?: string; labels?: string[] }[]) if (wanted.has(keyOf('asset', a.assetId))) out.set(keyOf('asset', a.assetId), valueOfAsset(a));
  for (const e of (content as { loadable?: LoadableEntry[] }).loadable ?? []) if (wanted.has(keyOf(e.kind, e.id))) out.set(keyOf(e.kind, e.id), valueOfAsset(e));
  return out;
}

/** Whether every item is still in the project (an asset deleted since makes the history not apply). */
export function loadingItemsExist(content: ContentDocument, items: readonly { kind: string; id: string }[]): boolean {
  const assets = new Set(content.assets.map((a) => a.assetId));
  for (const i of items) {
    if (i.kind === 'asset') {
      if (!assets.has(i.id)) return false;
      continue;
    }
    const def = resourceKindDef(i.kind);
    if (def === undefined || !(resourceRecordsOf(content, def) ?? []).some((r) => r[def.idKey] === i.id)) return false;
  }
  return true;
}
