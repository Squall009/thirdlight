/**
 * What a captured content view keeps from one build to the next.
 *
 * The workspace's captured project is deep-frozen and replaced piece by piece
 * (an edit makes a new record, a new scene entity list; nothing is changed in
 * place), so a frozen input seen before still means what it meant. A Play
 * after an edit then validates, serializes and hashes only what the edit
 * replaced: a scene's entities are validated once, an asset version's view row
 * and its JSON are made once, and the view's digest text is put together from
 * the parts' remembered texts.
 *
 * The texts are exactly what `JSON.stringify(value, null, 2)` writes for the
 * same value at the same depth, so the digests are unchanged.
 */
import { deepFreeze } from './catalog-files';
import type { SceneV3 } from './types-v3';

/** A scene's validated entities, by its entity list, with the other fields it had (a capture stamps `revision`; it may differ). */
const sceneEntities = new WeakMap<object, { readonly fields: readonly unknown[]; readonly entities: SceneV3['entities'] }>();

function sceneFields(doc: Record<string, unknown>): unknown[] | null {
  if (!Object.isFrozen(doc)) return null;
  const out: unknown[] = [];
  for (const [k, v] of Object.entries(doc)) {
    if (k === 'revision') continue;
    if (typeof v === 'object' && v !== null && !Object.isFrozen(v)) return null;
    out.push(k, v);
  }
  return out;
}

function sameList(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/** The entities of a scene validated before with the same fields (null: validate it). */
export function knownSceneEntities(doc: unknown): SceneV3['entities'] | null {
  const d = doc as Record<string, unknown> | null;
  const list = d?.['entities'];
  if (typeof list !== 'object' || list === null) return null;
  const known = sceneEntities.get(list);
  if (known === undefined) return null;
  const rev = d!['revision'];
  if (typeof rev !== 'number' || !Number.isSafeInteger(rev) || rev < 0) return null;
  const fields = sceneFields(d!);
  return fields !== null && sameList(fields, known.fields) ? known.entities : null;
}

/** Remember a scene's validated entities (only a frozen scene: it cannot change later). */
export function rememberSceneEntities(doc: unknown, entities: SceneV3['entities']): void {
  const d = doc as Record<string, unknown>;
  const list = d['entities'];
  const fields = sceneFields(d);
  if (fields !== null && typeof list === 'object' && list !== null) sceneEntities.set(list, { fields, entities });
}

/** One asset version's view row, by the version object, for the record it was made from (frozen: it is shared by every view that holds it). */
const rows = new WeakMap<object, { readonly record: object; readonly row: object }>();

/** The row made before for this record and version (both frozen), or `make`'s, remembered. */
export function viewRowOf<T extends object>(record: object, version: object, make: () => T): T {
  if (!Object.isFrozen(record) || !Object.isFrozen(version)) return make();
  const known = rows.get(version);
  if (known !== undefined && known.record === record) return known.row as T;
  const row = deepFreeze(make());
  rows.set(version, { record, row });
  return row;
}

/** `JSON.stringify(value, null, 2)` of a value, placed `depth` levels deep (its lines indented to match). */
function prettyAt(value: unknown, depth: number): string {
  const text = JSON.stringify(value, null, 2) ?? 'null';
  return depth === 0 ? text : text.replace(/\n/g, `\n${'  '.repeat(depth)}`);
}

/** Remembered texts of frozen values, per depth. */
const texts = new WeakMap<object, Map<number, string>>();

function textOf(value: unknown, depth: number): string {
  if (typeof value !== 'object' || value === null || !Object.isFrozen(value)) return prettyAt(value, depth);
  let byDepth = texts.get(value);
  if (byDepth === undefined) texts.set(value, (byDepth = new Map()));
  let t = byDepth.get(depth);
  if (t === undefined) {
    t = prettyAt(value, depth);
    byDepth.set(depth, t);
  }
  return t;
}

/** A list's pretty text at `depth`, from its items' remembered texts. */
function listText(list: readonly unknown[], depth: number): string {
  if (list.length === 0) return '[]';
  const pad = '  '.repeat(depth + 1);
  return `[\n${list.map((item) => `${pad}${textOf(item, depth + 1)}`).join(',\n')}\n${'  '.repeat(depth)}]`;
}

/**
 * `JSON.stringify(view, null, 2)` of a view (a plain object of arrays and
 * values), made from remembered texts: each list item and each frozen value
 * is serialized once for as long as it is the same object.
 */
export function viewText(view: Readonly<Record<string, unknown>>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(view)) {
    if (v === undefined || typeof v === 'function') continue;
    const text = Array.isArray(v) ? listText(v, 1) : textOf(v, 1);
    parts.push(`  ${JSON.stringify(k)}: ${text}`);
  }
  return parts.length === 0 ? '{}' : `{\n${parts.join(',\n')}\n}`;
}

/**
 * The last digest of a view per content block, with the parts it was made
 * from: a list's items by identity (an item that is not frozen, by its text),
 * any other value by its text (settings are resolved anew for every view).
 */
const digests = new WeakMap<object, { readonly parts: readonly unknown[]; readonly digest: string }>();

function partsOf(view: Readonly<Record<string, unknown>>): unknown[] {
  const parts: unknown[] = [];
  const add = (v: unknown): void => void parts.push(typeof v === 'object' && v !== null && !Object.isFrozen(v) ? prettyAt(v, 1) : v);
  for (const [k, v] of Object.entries(view)) {
    parts.push(k);
    if (Array.isArray(v)) {
      parts.push(v.length);
      for (const item of v) add(item);
    } else parts.push(prettyAt(v, 1));
  }
  return parts;
}

/**
 * The digest of `viewText(view) + "\n"`, remembered per content block: a
 * view made again from the same parts (a Play after an edit that changed no
 * shipped asset, prefab or behavior) is not serialized or hashed again.
 */
export function viewDigestOf(content: object, view: Readonly<Record<string, unknown>>, hash: (text: string) => string): string {
  const parts = partsOf(view);
  const known = digests.get(content);
  if (known !== undefined && sameList(known.parts, parts)) return known.digest;
  const digest = hash(`${viewText(view)}\n`);
  digests.set(content, { parts, digest });
  return digest;
}
