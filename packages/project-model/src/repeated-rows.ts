/**
 * Diagnostics rows that say the same thing more than once.
 *
 * A script that throws the same error on every copy of an object, or logs
 * the same line every step, fills a bounded list with copies of one row and
 * pushes everything else out. The runtime's error ring and the Play answers'
 * bound both fold such copies into one row with a count, so a short list
 * still shows every distinct problem. The runtime and the protocol both
 * read this one shape (the runtime cannot import the protocol).
 *
 * Two rows are copies when everything but the step and the object is the
 * same (code, message, script, reason, source position, …). The folded row
 * keeps the newest row's step in `stepIndex`, the first one's in
 * `firstStep`, `count` copies in all, and the first few distinct objects
 * in `entityIds`.
 */

import { isPlainObject } from '@thirdlight/shared';

/** The diagnostics entry code of a script's `ctx.log` line (every other code is an error). */
export const BEHAVIOR_LOG_CODE = 'behavior_log';

/** The objects a folded row names (the count says how many copies there were). */
export const REPEATED_ROW_ENTITY_IDS_MAX = 4;

/** The fields a folded row adds to its rows' own. */
export interface RepeatedRowFields {
  /** How many copies the row stands for (absent: one). */
  count?: number;
  /** The first copy's step (`stepIndex` is the newest copy's). */
  firstStep?: number;
  /** The distinct objects of the copies, first seen first (at most `REPEATED_ROW_ENTITY_IDS_MAX`). */
  entityIds?: string[];
}

/** The fields that may differ between copies of one row. */
const VARYING = new Set(['stepIndex', 'entityId', 'entityIds', 'count', 'firstStep']);

/** The identity of a row's copies (null: not a row, never folded). Key order does not matter. */
export function repeatedRowKey(row: unknown): string | null {
  if (!isPlainObject(row)) return null;
  const keys = Object.keys(row).filter((k) => !VARYING.has(k)).sort();
  return JSON.stringify(keys.map((k) => [k, row[k]]));
}

/** A play-log row that is an error (an engine or script error, or a script's `ctx.log` at error level) rather than a log line. */
export function isErrorRow(row: unknown): boolean {
  return !isPlainObject(row) || row['code'] !== BEHAVIOR_LOG_CODE || row['reason'] === 'error';
}

function entityIdsOf(row: Record<string, unknown>): string[] {
  if (Array.isArray(row['entityIds'])) return (row['entityIds'] as unknown[]).filter((x): x is string => typeof x === 'string');
  return typeof row['entityId'] === 'string' ? [row['entityId']] : [];
}

/** One row for an older row and a newer copy of it (neither is changed). */
export function mergeRepeatedRow<T extends object>(older: T, newer: T): T & RepeatedRowFields {
  const a = older as Record<string, unknown>;
  const b = newer as Record<string, unknown>;
  const out: Record<string, unknown> = { ...b };
  out['count'] = (typeof a['count'] === 'number' ? a['count'] : 1) + (typeof b['count'] === 'number' ? b['count'] : 1);
  const first = typeof a['firstStep'] === 'number' ? a['firstStep'] : a['stepIndex'];
  if (typeof first === 'number') out['firstStep'] = first;
  else delete out['firstStep'];
  if (b['stepIndex'] === undefined && a['stepIndex'] !== undefined) out['stepIndex'] = a['stepIndex'];
  const ids = [...new Set([...entityIdsOf(a), ...entityIdsOf(b)])].slice(0, REPEATED_ROW_ENTITY_IDS_MAX);
  if (typeof a['entityId'] === 'string') out['entityId'] = a['entityId'];
  if (ids.length > 1) out['entityIds'] = ids;
  else delete out['entityIds'];
  return out as T & RepeatedRowFields;
}

/**
 * The list with every set of copies folded into one row, which sits where
 * the newest copy was (a list kept oldest first stays so). Lists without
 * copies come back as they are (the same array).
 */
export function mergeRepeatedRows<T>(list: readonly T[]): readonly T[] {
  const lastAt = new Map<string, number>();
  const keys = list.map((row, i) => {
    const k = repeatedRowKey(row);
    if (k !== null) lastAt.set(k, i);
    return k;
  });
  if (lastAt.size === keys.filter((k) => k !== null).length) return list;
  const folded = new Map<string, T>();
  const out: T[] = [];
  list.forEach((row, i) => {
    const k = keys[i];
    if (k === null || k === undefined) {
      out.push(row);
      return;
    }
    const sofar = folded.get(k);
    const merged = sofar === undefined ? row : (mergeRepeatedRow(sofar as object, row as object) as T);
    folded.set(k, merged);
    if (lastAt.get(k) === i) out.push(merged);
  });
  return out;
}
