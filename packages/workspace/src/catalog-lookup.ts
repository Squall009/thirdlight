/**
 * An asset record by id without walking the catalog. The records' list is an
 * immutable value (a command that changes an asset replaces the list), so a
 * map from id to position is made once per list and reused by every lookup
 * until the list is replaced: a Play or an export build of thousands of assets
 * looks each one up in constant time.
 *
 * The position is checked on every lookup (the record there must carry the
 * id), so a list changed in place still answers correctly: the map is made
 * again.
 */
interface Keyed {
  readonly assetId: string;
}

const positions = new WeakMap<readonly Keyed[], { length: number; at: Map<string, number> }>();

function positionsOf(list: readonly Keyed[]): Map<string, number> {
  const at = new Map<string, number>();
  for (let i = 0; i < list.length; i += 1) at.set(list[i]!.assetId, i);
  positions.set(list, { length: list.length, at });
  return at;
}

/** The record with this id in `list` (undefined: none). */
export function assetRecordOf<T extends Keyed>(list: readonly T[], assetId: unknown): T | undefined {
  if (typeof assetId !== 'string') return undefined;
  const known = positions.get(list);
  const at = known !== undefined && known.length === list.length ? known.at : positionsOf(list);
  const i = at.get(assetId);
  if (i === undefined) return undefined;
  if (list[i]?.assetId === assetId) return list[i];
  // The list changed in place since the map was made: make it again.
  const j = positionsOf(list).get(assetId);
  return j !== undefined ? list[j] : undefined;
}
