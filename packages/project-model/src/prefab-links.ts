/**
 * Linked prefab copies: the stored shape of a copy (one object naming its
 * prefab and the overrides it keeps), how a part of a copy is addressed, the
 * scene ids its parts get, and the nesting-cycle check.
 *
 * A copy keeps only what differs from its prefab, so an edit to the prefab
 * reaches every copy except the fields a copy overrides. Parts are addressed
 * by local-id paths, never by position, because a prefab's local ids are
 * never reused: an override keeps naming the same part across prefab edits.
 *
 * Part paths, relative to the prefab a copy (or a nested copy) names:
 * - the root is `[rootLocalId]`; any other part of the prefab is `[localId]`;
 * - a part inside a nested copy at local id `L` is `[L, ...its path in the
 *   nested prefab]`, except the nested prefab's root, which is the nested
 *   copy itself, `[L]`.
 * So a variant (a prefab whose root `V` is a copy of its base) names its own
 * root `[V]` and the base's other parts `[V, localId]`, and its own added
 * parts `[localId]` never meet the base's.
 */

import { ID_MAX_LENGTH, fieldMissing, fieldType, fieldValue, idInvalid, isPlainObject, pointerSegment, unexpectedField, withFound } from './validate';
import { ID_RE_V2 } from './components';
import type { ModelErrorV2 } from './errors';

/** One difference a copy keeps from its prefab, on the part `part` names. */
export type PrefabOverride = PrefabFieldOverride | PrefabFieldRemoval | PrefabPartRemoval;

/**
 * A changed or added field: `path` is `/`-separated from the part —
 * `name`, `tags`, `components/<component>` (an added or replaced component),
 * or deeper, `components/<component>/<field>/…` (one changed field; arrays
 * are replaced whole). The copy root's transform is the copy's own and is
 * never an override.
 */
export interface PrefabFieldOverride {
  part: string;
  path: string;
  value: unknown;
}

/** A removed component or field (`path` as above). */
export interface PrefabFieldRemoval {
  part: string;
  path: string;
  remove: true;
}

/** A removed part, with every part under it. Never the root. */
export interface PrefabPartRemoval {
  part: string;
  remove: true;
}

/**
 * `components.prefab` of a linked copy: the object is the copy's root (its
 * transform, parent, name, flags and tags are the root's own) and carries no
 * other component; the prefab's parts are made from the prefab and these
 * overrides whenever the scene is built. Objects added to a copy are
 * ordinary objects parented to one of its parts (by that part's scene id).
 */
export interface PrefabLinkComponent {
  prefabId: string;
  overrides?: PrefabOverride[];
  /**
   * The scene ids a placed copy's parts keep, by part path key (absent key:
   * the derived id, `prefabPartId`). A copy made from a plain copy of an
   * older project keeps the ids its objects had, so the scripts, saves and
   * references that named them keep working. A placed copy's only: a copy
   * nested inside a prefab has no scene ids of its own.
   */
  partIds?: Record<string, string>;
}

/** The `/`-joined key of a part path. Local ids never hold a `/`. */
export const PART_PATH_SEPARATOR = '/';

export function partPathKey(path: readonly string[]): string {
  return path.join(PART_PATH_SEPARATOR);
}

export function partPathOf(key: string): string[] {
  return key.split(PART_PATH_SEPARATOR);
}

/** True when a `components.prefab` value is a link (a copy root) rather than a part's provenance. */
export function isPrefabLink(value: unknown): value is PrefabLinkComponent {
  return isPlainObject(value) && typeof value['prefabId'] === 'string' && value['localId'] === undefined;
}

const KNOWN_LINK_FIELDS = new Set(['prefabId', 'overrides', 'partIds']);
const KNOWN_OVERRIDE_FIELDS = new Set(['part', 'path', 'value', 'remove']);
/** The fields of a part an override may change besides its components. */
const PART_FIELDS = new Set(['name', 'tags', 'components']);

/** Whether a string is a part path key (local ids joined by `/`). */
export function isPartKey(key: string): boolean {
  return key.length > 0 && partPathOf(key).every((s) => ID_RE_V2.test(s));
}

function validFieldPath(path: string): boolean {
  const segs = path.split('/');
  if (segs.some((s) => s.length === 0)) return false;
  const head = segs[0] as string;
  if (!PART_FIELDS.has(head)) return false;
  if (head === 'components') return segs.length >= 2;
  return segs.length === 1;
}

/**
 * Validate a link's shape (`components.prefab` without `localId`). Whether
 * its parts exist is the prefab's matter: assembly skips an override whose
 * part or field is gone and reports it.
 */
export function validatePrefabLink(c: unknown, path: string, errors: ModelErrorV2[], where: 'scene' | 'prefab' = 'scene'): void {
  if (!isPlainObject(c)) {
    errors.push(fieldType(path, c, 'object'));
    return;
  }
  const prefabId = c['prefabId'];
  if (prefabId === undefined) errors.push(fieldMissing(`${path}/prefabId`, 'prefabId'));
  else if (typeof prefabId !== 'string') errors.push(fieldType(`${path}/prefabId`, prefabId, 'string'));
  else if (!ID_RE_V2.test(prefabId)) errors.push(idInvalid(`${path}/prefabId`, prefabId));
  for (const k of Object.keys(c)) {
    if (!KNOWN_LINK_FIELDS.has(k)) errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, 'prefabId, overrides, partIds'));
  }
  validatePartIds(c['partIds'], `${path}/partIds`, errors, where);
  const overrides = c['overrides'];
  if (overrides === undefined) return;
  if (!Array.isArray(overrides)) {
    errors.push(fieldType(`${path}/overrides`, overrides, 'array'));
    return;
  }
  const seen = new Set<string>();
  overrides.forEach((o, i) => {
    const at = `${path}/overrides/${i}`;
    if (!isPlainObject(o)) {
      errors.push(fieldType(at, o, 'object'));
      return;
    }
    for (const k of Object.keys(o)) {
      if (!KNOWN_OVERRIDE_FIELDS.has(k)) errors.push(unexpectedField(`${at}/${pointerSegment(k)}`, k, 'part, path, value, remove'));
    }
    const part = o['part'];
    if (typeof part !== 'string') errors.push(part === undefined ? fieldMissing(`${at}/part`, 'part') : fieldType(`${at}/part`, part, 'string'));
    else if (!isPartKey(part)) errors.push(fieldValue(`${at}/part`, part, 'local ids joined by /', 'part is the local-id path of a part of the prefab'));
    const field = o['path'];
    const remove = o['remove'];
    if (remove !== undefined && remove !== true) errors.push(fieldValue(`${at}/remove`, remove, 'true or absent', 'remove is true or absent'));
    if (field !== undefined) {
      if (typeof field !== 'string') errors.push(fieldType(`${at}/path`, field, 'string'));
      else if (!validFieldPath(field)) errors.push(fieldValue(`${at}/path`, field, 'name, tags or components/<component>[/<field>…]', 'path names a field of the part'));
    }
    const hasValue = Object.prototype.hasOwnProperty.call(o, 'value');
    if (field === undefined && remove !== true) errors.push(fieldMissing(`${at}/path`, 'path'));
    if (field !== undefined && remove !== true && !hasValue) errors.push(fieldMissing(`${at}/value`, 'value'));
    if (remove === true && hasValue) errors.push(fieldValue(`${at}/value`, o['value'], 'absent on a removal', 'a removal carries no value'));
    if (field === 'name' && remove !== true && typeof o['value'] !== 'string') errors.push(fieldType(`${at}/value`, o['value'], 'string'));
    if (field === 'tags' && remove !== true && (typeof o['value'] !== 'number' || !Number.isInteger(o['value']) || (o['value'] as number) < 0 || (o['value'] as number) > 0xffffffff)) {
      errors.push(fieldValue(`${at}/value`, o['value'], 'integer 0 to 4294967295', 'tags is the 32-bit tag mask'));
    }
    if (typeof part === 'string') {
      const key = `${part}\u0000${typeof field === 'string' ? field : ''}`;
      if (seen.has(key)) errors.push(withFound({ code: 'id_duplicate', path: at, message: 'a copy keeps one override per part and field', expected: 'one override per (part, path)' }, key.replace('\u0000', ' ')));
      seen.add(key);
    }
  });
}

/** A placed copy's kept part ids: part keys to distinct scene ids (never the root's: that is the copy's own id). */
function validatePartIds(ids: unknown, path: string, errors: ModelErrorV2[], where: 'scene' | 'prefab'): void {
  if (ids === undefined) return;
  if (where === 'prefab') {
    errors.push(fieldValue(path, ids, 'absent in a prefab', "kept part ids are a placed copy's: a copy nested in a prefab has no scene ids of its own"));
    return;
  }
  if (!isPlainObject(ids)) {
    errors.push(fieldType(path, ids, 'object'));
    return;
  }
  const seen = new Set<string>();
  for (const [key, id] of Object.entries(ids)) {
    const at = `${path}/${pointerSegment(key)}`;
    if (!isPartKey(key)) errors.push(fieldValue(at, key, 'local ids joined by /', 'a key is the local-id path of a part of the prefab'));
    if (typeof id !== 'string') errors.push(fieldType(at, id, 'string'));
    else if (!ID_RE_V2.test(id)) errors.push(idInvalid(at, id));
    else if (seen.has(id)) errors.push(withFound({ code: 'id_duplicate', path: at, message: 'each part of a copy keeps its own id', expected: 'distinct ids' }, id));
    else seen.add(id);
  }
}

/**
 * The scene ids linked copies keep for their parts (`partIds`), which no
 * stored object holds: a new object's id must never be one of them.
 */
export function keptPartIds(entities: readonly { components: object }[]): string[] {
  const out: string[] = [];
  for (const e of entities) {
    const link = (e.components as { prefab?: unknown }).prefab;
    if (isPrefabLink(link) && link.partIds !== undefined) for (const id of Object.values(link.partIds)) out.push(id);
  }
  return out;
}

/** The hash part of a derived part id (base 36, fixed width). */
const PART_HASH_LENGTH = 11;

/** A 53-bit string hash (cyrb53): spread well, fast, the same everywhere. */
function hash53(text: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * The scene id of a copy's part: derived from the copy's id and the part's
 * path alone, so it stays the same across prefab edits (scripts, saves and
 * entityRefs that name a part keep working) and is the same on every build.
 * The copy's id leads it (a part sorts and reads next to its copy).
 */
export function prefabPartId(copyId: string, partKey: string): string {
  const hash = hash53(`${copyId}\u0000${partKey}`).toString(36).padStart(PART_HASH_LENGTH, '0');
  return `${copyId.slice(0, ID_MAX_LENGTH - PART_HASH_LENGTH - 1)}-${hash}`;
}

/** What every prefab stage's root id starts with (see `prefabStageId`). */
export const PREFAB_STAGE_ID_PREFIX = 'prefab-stage_';

/**
 * The id of a prefab's stage: the copy a prefab is opened as for editing on
 * its own (no scene holds it; an edit of its parts changes the prefab). The
 * prefab's id is hashed, not spelled out, so the root stays short enough that
 * every part id starts with it followed by `-` (no `-` inside it), which is
 * how a part id finds its stage. A stored object would need this exact id
 * to be mistaken for one.
 */
export function prefabStageId(prefabId: string): string {
  return `${PREFAB_STAGE_ID_PREFIX}${hash53(`stage\u0000${prefabId}`).toString(36).padStart(PART_HASH_LENGTH, '0')}`;
}

/** The stage root an id is or belongs to (null: not a stage's id). */
export function prefabStageRootOf(id: string): string | null {
  if (!id.startsWith(PREFAB_STAGE_ID_PREFIX)) return null;
  const dash = id.indexOf('-', PREFAB_STAGE_ID_PREFIX.length);
  return dash < 0 ? id : id.slice(0, dash);
}

/** The prefabs a definition nests (its entities that are links), in order. */
export function nestedPrefabIds(definition: { entities: readonly { components: object }[] }): string[] {
  const out: string[] = [];
  for (const e of definition.entities) {
    const link = (e.components as { prefab?: unknown }).prefab;
    if (isPrefabLink(link)) out.push(link.prefabId);
  }
  return out;
}

/**
 * The prefabs that contain themselves through a chain of nested copies, each
 * with one chain that shows it (`[a, b, a]`). A prefab a cycle only reaches
 * is not listed: it is refused where it nests the cyclic one.
 */
export function prefabNestingCycles(definitions: readonly { prefabId: string; entities: readonly { components: object }[] }[]): Map<string, string[]> {
  const nests = new Map(definitions.map((d) => [d.prefabId, nestedPrefabIds(d)]));
  const cycles = new Map<string, string[]>();
  const state = new Map<string, 'open' | 'done'>();
  const stack: string[] = [];
  const visit = (id: string): void => {
    state.set(id, 'open');
    stack.push(id);
    for (const next of nests.get(id) ?? []) {
      const s = state.get(next);
      if (s === 'open') {
        const chain = [...stack.slice(stack.indexOf(next)), next];
        for (const member of chain.slice(0, -1)) if (!cycles.has(member)) cycles.set(member, chain);
      } else if (s === undefined && nests.has(next)) visit(next);
    }
    stack.pop();
    state.set(id, 'done');
  };
  for (const d of definitions) if (!state.has(d.prefabId)) visit(d.prefabId);
  return cycles;
}

/** The catalog-level check: every prefab on a nesting cycle is refused, naming the chain. */
export function validatePrefabNesting(definitions: readonly unknown[], path: string, errors: ModelErrorV2[]): void {
  const defs = definitions.filter((d): d is { prefabId: string; entities: { components: object }[] } => isPlainObject(d) && typeof d['prefabId'] === 'string' && Array.isArray(d['entities']) && (d['entities'] as unknown[]).every((e) => isPlainObject(e) && isPlainObject(e['components'])));
  const cycles = prefabNestingCycles(defs);
  definitions.forEach((d, i) => {
    const id = isPlainObject(d) ? d['prefabId'] : undefined;
    const chain = typeof id === 'string' ? cycles.get(id) : undefined;
    if (chain !== undefined) errors.push(withFound({ code: 'prefab_cycle', path: `${path}/${i}`, message: `the prefab contains itself through nested copies (${chain.join(' → ')})`, expected: 'nesting without cycles' }, chain));
  });
}
