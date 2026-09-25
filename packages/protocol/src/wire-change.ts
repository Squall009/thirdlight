/**
 * Phase 21.4: the change record as it travels in a WS `mutation.applied`.
 *
 * The HTTP result, the retry records and the undo history keep the full
 * change (before and after). The editor's projection advances from the
 * "after" side alone (sessions.md §8: "a client projection updates from this
 * alone"), so on the socket:
 *
 * - every `previous` (top level, per moved entity, the entity order, the
 *   header transform) is left out — about half of every set-style change,
 *   and the whole entity-id order a reorder repeats;
 * - a change that carries a whole keyed list (`setMaterials`, `setAnimators`)
 *   sends a delta instead: the ids in order plus only the items that differ
 *   from before (one edited material of 500 is one material on the wire).
 *   The editor rebuilds the full list from its copy (`fromWireChange`); a
 *   copy that does not fit (an id it does not know) resyncs.
 *
 * Pure: no I/O.
 */
import type { ChangeData } from '@thirdlight/commands';

/** The keyed-list changes sent as deltas, and each list's id field. */
export const WIRE_LIST_KEYS = { setMaterials: 'materialId', setAnimators: 'controllerId' } as const;
type ListChange = keyof typeof WIRE_LIST_KEYS;

/** A keyed-list delta: the ids in their new order and the items that changed or appeared. */
export interface WireListDelta {
  key: string;
  order: string[];
  upsert: Record<string, unknown>[];
}

function withoutPrevious(v: unknown): unknown {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return v;
  const { previous: _p, ...rest } = v as Record<string, unknown>;
  return rest;
}

/** The change as sent in a WS `mutation.applied` (see the module comment). */
export function toWireChange(change: ChangeData): Record<string, unknown> {
  const c = change as unknown as Record<string, unknown>;
  const type = c['type'] as string;
  if (type in WIRE_LIST_KEYS) {
    const key = WIRE_LIST_KEYS[type as ListChange];
    const prev = new Map<string, string>();
    for (const item of (c['previous'] as Record<string, unknown>[] | undefined) ?? []) prev.set(String(item[key]), JSON.stringify(item));
    const next = (c['next'] as Record<string, unknown>[] | undefined) ?? [];
    const delta: WireListDelta = {
      key,
      order: next.map((item) => String(item[key])),
      upsert: next.filter((item) => prev.get(String(item[key])) !== JSON.stringify(item)),
    };
    return { type, delta };
  }
  const out = withoutPrevious(c) as Record<string, unknown>;
  // The entity order a reorder repeats (the whole id list), a header transform, moved entities.
  if (out['order'] !== null && typeof out['order'] === 'object') out['order'] = withoutPrevious(out['order']);
  if (out['transform'] !== null && typeof out['transform'] === 'object' && type === 'updateEntity') out['transform'] = withoutPrevious(out['transform']);
  if (type === 'moveEntities' && Array.isArray(out['entities'])) out['entities'] = (out['entities'] as unknown[]).map(withoutPrevious);
  return out;
}

/**
 * The full "after" side of a wire change, given the client's current copy of
 * the keyed lists; null when the copy does not fit (the client resyncs).
 * Changes without a delta come back as they are.
 */
export function fromWireChange(wire: Record<string, unknown>, current: { setMaterials?: readonly Record<string, unknown>[]; setAnimators?: readonly Record<string, unknown>[] }): ChangeData | null {
  const type = wire['type'] as string;
  const delta = wire['delta'] as WireListDelta | undefined;
  if (!(type in WIRE_LIST_KEYS) || delta === undefined) return wire as unknown as ChangeData;
  const key = WIRE_LIST_KEYS[type as ListChange];
  if (delta.key !== key || !Array.isArray(delta.order) || !Array.isArray(delta.upsert)) return null;
  const have = new Map<string, Record<string, unknown>>();
  for (const item of current[type as ListChange] ?? []) have.set(String(item[key]), item);
  for (const item of delta.upsert) have.set(String(item[key]), item);
  const next: Record<string, unknown>[] = [];
  for (const id of delta.order) {
    const item = have.get(id);
    if (item === undefined) return null;
    next.push(item);
  }
  return { type, next } as unknown as ChangeData;
}
