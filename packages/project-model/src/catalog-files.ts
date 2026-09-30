/**
 * The catalog's files as bytes, made once for as long as what they hold is
 * the same.
 *
 * A catalog file is `JSON.stringify(value) + "\n"`. A list is split into
 * parts by its items' JSON lengths, and each item's JSON is made once: its
 * length decides the part, its text is joined into the part's file (the same
 * bytes as serializing the whole part). The captured project is deep-frozen
 * and replaced piece by piece, so a frozen item keeps its text, and a part
 * whose items are the same objects as a part made before is that file again:
 * a build after an edit serializes and hashes only the parts the edit touched.
 */

/**
 * Where a block file is cut into parts: a part ends once its items pass this
 * size (an item larger than this is a part of its own), so a large block is
 * read as several files in parallel and a change rewrites one part. The
 * per-file cap is `MANIFEST_CONTENT_FILE_MAX_BYTES`.
 */
export const CATALOG_PART_BYTES = 1_048_576;

/**
 * The entries per shard on average: a shard ends after an entry whose id
 * hashes to 0 modulo this (or at `CATALOG_PART_BYTES`), so one lookup reads
 * about this many entries.
 */
export const CATALOG_SHARD_ENTRIES = 256;

/** Freeze a value and everything in it (a remembered value must not change). */
export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/** Texts of frozen values (they cannot change while they are remembered). */
const texts = new WeakMap<object, string>();

/** A value's compact JSON (`null` where `JSON.stringify` leaves a value out of an array), once per frozen object. */
export function compact(value: unknown): string {
  if (typeof value !== 'object' || value === null || !Object.isFrozen(value)) return JSON.stringify(value) ?? 'null';
  let t = texts.get(value);
  if (t === undefined) {
    t = JSON.stringify(value) ?? 'null';
    texts.set(value, t);
  }
  return t;
}

/** One file of a block: its value, its items (a list's part; null otherwise) and its compact JSON. */
export interface Part {
  readonly value: unknown;
  readonly items: readonly unknown[] | null;
  readonly text: () => string;
}

/** Split a list into parts near `CATALOG_PART_BYTES` (every part non-empty); a part's size counts each item's JSON plus 8. */
export function listParts(list: readonly unknown[]): Part[] {
  const parts: Part[] = [];
  let part: unknown[] = [];
  let itemTexts: string[] = [];
  let size = 0;
  const end = (): void => {
    const done = itemTexts;
    parts.push({ value: part, items: part, text: () => `[${done.join(',')}]` });
    part = [];
    itemTexts = [];
    size = 0;
  };
  for (const item of list) {
    const text = compact(item);
    const n = text.length + 8;
    if (part.length > 0 && size + n > CATALOG_PART_BYTES) end();
    part.push(item);
    itemTexts.push(text);
    size += n;
  }
  if (part.length > 0) end();
  return parts;
}

/** Split a map into parts near `CATALOG_PART_BYTES`, keys in order (a key with no value is left out, as `JSON.stringify` does). */
export function mapParts(map: Readonly<Record<string, unknown>>): Part[] {
  const parts: Part[] = [];
  let part: Record<string, unknown> = {};
  let itemTexts: string[] = [];
  let size = 0;
  let count = 0;
  const end = (): void => {
    const done = itemTexts;
    parts.push({ value: part, items: null, text: () => `{${done.join(',')}}` });
    part = {};
    itemTexts = [];
    size = 0;
    count = 0;
  };
  for (const key of Object.keys(map)) {
    const text = JSON.stringify(map[key]);
    if (text === undefined) continue;
    const n = text.length + 8 + key.length;
    if (count > 0 && size + n > CATALOG_PART_BYTES) end();
    part[key] = map[key];
    itemTexts.push(`${JSON.stringify(key)}:${text}`);
    size += n;
    count += 1;
  }
  if (count > 0) end();
  return parts;
}

/** FNV-1a (32-bit) of a string: the shard boundary hash (stable across runtimes). */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Entries into shards: a shard ends after an entry whose id hashes to 0
 * modulo `CATALOG_SHARD_ENTRIES`, or once it reaches `CATALOG_PART_BYTES`;
 * the versions of one id stay in one shard.
 */
export function shardEntries<E extends { readonly assetId: string }>(entries: readonly E[]): E[][] {
  const shards: E[][] = [];
  let shard: E[] = [];
  let size = 0;
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i]!;
    shard.push(e);
    size += compact(e).length + 8;
    const next = entries[i + 1];
    if (next !== undefined && next.assetId === e.assetId) continue;
    if (fnv1a(e.assetId) % CATALOG_SHARD_ENTRIES === 0 || size >= CATALOG_PART_BYTES) {
      shards.push(shard);
      shard = [];
      size = 0;
    }
  }
  if (shard.length > 0) shards.push(shard);
  return shards;
}

/** A list's compact JSON from its items' texts. */
export function listText(items: readonly unknown[]): string {
  return `[${items.map(compact).join(',')}]`;
}

/** One made file: its bytes and digest. */
export interface MadeFile {
  readonly bytes: Uint8Array;
  readonly digest: string;
}

/** Files made from lists of frozen items, by their first item and the file's place in the catalog (a shard, a scene's file, a block's part). */
const listFiles = new WeakMap<object, Map<string, { readonly items: readonly unknown[]; readonly file: MadeFile }>>();

function sameItems(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * The file of a list at a place in the catalog (`slot`), made again only
 * when its items are not the same objects as the last file made there (every
 * item must be a frozen object for the file to be remembered).
 */
export function listFile(items: readonly unknown[], slot: string, text: () => string, hash: (bytes: Uint8Array) => string): MadeFile {
  const first = items[0];
  const memo = typeof first === 'object' && first !== null && items.every((i) => typeof i === 'object' && i !== null && Object.isFrozen(i));
  let bySlot: Map<string, { readonly items: readonly unknown[]; readonly file: MadeFile }> | undefined;
  if (memo) {
    bySlot = listFiles.get(first);
    const known = bySlot?.get(slot);
    if (known !== undefined && sameItems(known.items, items)) return known.file;
  }
  const bytes = new TextEncoder().encode(`${text()}\n`);
  const file = { bytes, digest: hash(bytes) };
  if (memo) {
    if (bySlot === undefined) listFiles.set(first as object, (bySlot = new Map()));
    bySlot.set(slot, { items: [...items], file });
  }
  return file;
}
