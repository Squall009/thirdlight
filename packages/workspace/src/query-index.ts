/**
 * `queryIndex` — pages of the project index (project-index.ts) for the
 * editor's lists, pickers and search and for MCP: every asset, resource and
 * scene with its file, name, labels, address and the ids it references.
 *
 * Filters: `kind` or `kinds`, `id` or `ids` (a page of ids: a caller fetching
 * what it needs by id), `label`, `address`, `loadable` (an address or a
 * label, or neither), `referencing` (the entries that name an id) and `text`
 * (a case-insensitive part of the name, id or file). `refs: false` leaves the
 * reference lists out (a list or picker needs none), `records: true` adds a
 * resource's record (`record`; assets and scenes have their own queries).
 * Entries come in `kind:id` order, paged.
 */
import type { QueryResult } from './types';

import { fieldTypeError, fieldUnexpected, fieldValueType, isSafeInt, pointerSegment } from './errors';
import { buildIndex, sortedKeys, type IndexEntry, type ProjectIndex } from './project-index';
import { recordsOfKind, RESOURCE_KINDS } from './resource-files';
import type { ProjectSession } from './session';
import type { V4State } from './store-v4';

/** The most index entries one `queryIndex` page returns (and the most ids one asks for). */
export const MAX_INDEX_PAGE = 1024;

const ARGS = ['kind', 'kinds', 'id', 'ids', 'label', 'address', 'loadable', 'referencing', 'text', 'refs', 'records', 'limit', 'offset'];

function failure(projectId: string, error: import('@thirdlight/commands').CommandError): QueryResult {
  return { ok: false, op: 'queryIndex', projectId, error } as unknown as QueryResult;
}

/** What `text` is matched against, lower-cased once per entry (entries are replaced, never changed). */
const haystacks = new WeakMap<IndexEntry, string>();
function haystackOf(e: IndexEntry): string {
  let h = haystacks.get(e);
  if (h === undefined) {
    h = `${e.name}\u0000${e.id}\u0000${e.path ?? ''}`.toLowerCase();
    haystacks.set(e, h);
  }
  return h;
}

/** A resource list by id, made once per list (lists are replaced by the command that changes them). */
const byIdOfList = new WeakMap<readonly Record<string, unknown>[], Map<string, Record<string, unknown>>>();
function resourceRecord(state: V4State, kind: string, id: string): Record<string, unknown> | undefined {
  const k = RESOURCE_KINDS.find((x) => x.kind === kind);
  if (k === undefined) return undefined;
  const list = recordsOfKind(state.content, k);
  if (list === undefined) return undefined;
  let m = byIdOfList.get(list);
  if (m === undefined) {
    m = new Map(list.map((r) => [String(r[k.idKey]), r] as const));
    byIdOfList.set(list, m);
  }
  return m.get(id);
}

const isStringList = (v: unknown, max: number): v is string[] => Array.isArray(v) && v.length >= 1 && v.length <= max && v.every((x) => typeof x === 'string');

export function serveQueryIndex(s: ProjectSession, state: V4State, projectId: string, a: Record<string, unknown>): QueryResult {
  for (const k of Object.keys(a)) if (!ARGS.includes(k)) return failure(projectId, fieldUnexpected(`/args/${pointerSegment(k)}`, k, ARGS.join(', ')));
  for (const k of ['kind', 'id', 'label', 'address', 'referencing', 'text'] as const) if (a[k] !== undefined && typeof a[k] !== 'string') return failure(projectId, fieldTypeError(`/args/${k}`, a[k], 'string'));
  for (const k of ['loadable', 'refs', 'records'] as const) if (a[k] !== undefined && typeof a[k] !== 'boolean') return failure(projectId, fieldTypeError(`/args/${k}`, a[k], 'boolean'));
  for (const k of ['kinds', 'ids'] as const) {
    if (a[k] !== undefined && !isStringList(a[k], MAX_INDEX_PAGE)) return failure(projectId, fieldValueType(`/args/${k}`, a[k], `1-${MAX_INDEX_PAGE} strings`, `${k} lists 1 to ${MAX_INDEX_PAGE} strings`));
  }
  const limit = a['limit'] ?? 256;
  const offset = a['offset'] ?? 0;
  if (!isSafeInt(limit) || (limit as number) < 1 || (limit as number) > MAX_INDEX_PAGE) return failure(projectId, fieldValueType('/args/limit', limit, `integer 1-${MAX_INDEX_PAGE}`, 'limit pages the index'));
  if (!isSafeInt(offset) || (offset as number) < 0) return failure(projectId, fieldValueType('/args/offset', offset, 'integer >= 0', 'offset pages the index'));
  const index: ProjectIndex = s.index ?? buildIndex(state);
  const kinds = a['kinds'] !== undefined ? new Set(a['kinds'] as string[]) : a['kind'] !== undefined ? new Set([a['kind'] as string]) : null;
  const ids = a['ids'] !== undefined ? new Set(a['ids'] as string[]) : a['id'] !== undefined ? new Set([a['id'] as string]) : null;
  // The keys to look at: a page of ids with their kinds named is looked up; otherwise the keys in order,
  // made once per change of the index's key set (a page is read from them, not sorted per query).
  let keys: readonly string[];
  if (typeof a['referencing'] === 'string') keys = [...(index.referrers.get(a['referencing']) ?? [])].sort();
  else if (ids !== null && kinds !== null) keys = [...kinds].flatMap((k) => [...ids].map((id) => `${k}:${id}`)).filter((key) => index.entries.has(key)).sort();
  else keys = sortedKeys(index);
  const text = typeof a['text'] === 'string' && a['text'].trim() !== '' ? a['text'].trim().toLowerCase() : null;
  const withRefs = a['refs'] !== false;
  const withRecords = a['records'] === true;
  const from = offset as number;
  const to = from + (limit as number);
  let total = 0;
  const page: Record<string, unknown>[] = [];
  for (const key of keys) {
    const e = index.entries.get(key);
    if (e === undefined) continue;
    if (kinds !== null && !kinds.has(e.kind)) continue;
    if (ids !== null && !ids.has(e.id)) continue;
    if (a['label'] !== undefined && !e.labels.includes(a['label'] as string)) continue;
    if (a['address'] !== undefined && e.address !== a['address']) continue;
    // Loadable: an address or a label (what a script may load by name).
    if (a['loadable'] !== undefined && (e.address !== null || e.labels.length > 0) !== a['loadable']) continue;
    if (text !== null && !haystackOf(e).includes(text)) continue;
    if (total >= from && total < to) {
      const record = withRecords ? resourceRecord(state, e.kind, e.id) : undefined;
      page.push({
        kind: e.kind,
        id: e.id,
        path: e.path,
        name: e.name,
        labels: [...e.labels],
        ...(e.address !== null ? { address: e.address } : {}),
        ...(withRefs ? { refs: [...e.refs] } : {}),
        ...(record !== undefined ? { record: JSON.parse(JSON.stringify(record)) as unknown } : {}),
      });
    }
    total += 1;
  }
  return { ok: true, projectId, revision: state.revision, total, entries: page } as unknown as QueryResult;
}
