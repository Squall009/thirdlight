/**
 * One record of a content list set or removed, the list kept in id order.
 *
 * The other records stay the same objects: the model trusts what an edit
 * left as it was (it is not validated or canonicalized again), and the
 * workspace writes only the records that changed, one file each.
 */
export function withListRecord<T>(list: readonly T[] | undefined, idOf: (r: T) => string, id: string, record: T | null): T[] {
  const out = (list ?? []).filter((r) => idOf(r) !== id);
  if (record === null) return out;
  let at = out.findIndex((r) => idOf(r) > id);
  if (at < 0) at = out.length;
  out.splice(at, 0, record);
  return out;
}
