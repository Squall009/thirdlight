/**
 * The values Duplicate and Copy/Paste send for a selection read from the
 * backend. The backend reads linked prefab copies assembled, so the values
 * would paste as plain objects that no longer follow their prefab. As in
 * Unity, a selected copy's root pastes as a new linked copy of the same
 * prefab with the same overrides (its parts are made from the prefab again,
 * with ids of their own), and an object added under one of its parts stays
 * added under that part. A part selected without its copy's root pastes as
 * an ordinary object: it no longer names the prefab part it was.
 */

/** What `queryEntity` answers for an object of a linked copy. */
export interface CopyReadInfo {
  copyId: string;
  prefabId: string;
  part: string;
  root: boolean;
  overrides: unknown[];
  partIds: Record<string, string>;
}

export interface SelectionRead {
  entity: Record<string, unknown>;
  /** Absent or null: the object is no linked copy's. */
  prefabCopy?: CopyReadInfo | null;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** The values to paste, in the reads' order (parents first). */
export function pasteValuesOf(reads: readonly SelectionRead[]): Record<string, unknown>[] {
  // The copies whose root is selected, and the part each of their part ids is.
  const partOf = new Map<string, { copyId: string; key: string }>();
  const roots = new Set<string>();
  for (const r of reads) {
    const info = r.prefabCopy ?? undefined;
    if (info === undefined || !info.root || info.copyId !== r.entity['id']) continue;
    roots.add(info.copyId);
    for (const [key, id] of Object.entries(info.partIds)) if (id !== info.copyId) partOf.set(id, { copyId: info.copyId, key });
  }
  const out: Record<string, unknown>[] = [];
  for (const r of reads) {
    const id = r.entity['id'] as string;
    if (partOf.has(id)) continue;
    const info = r.prefabCopy ?? undefined;
    if (info !== undefined && roots.has(id)) {
      // The copy as stored: its placement, header and link (the part ids are derived again for the new copy).
      const { components, ...header } = clone(r.entity) as { components: Record<string, unknown> } & Record<string, unknown>;
      const link = { prefabId: info.prefabId, ...(info.overrides.length > 0 ? { overrides: clone(info.overrides) } : {}) };
      out.push({ ...header, components: { ...(components['transform'] !== undefined ? { transform: components['transform'] } : {}), prefab: link } });
      continue;
    }
    const v = clone(r.entity);
    const under = typeof v['parentId'] === 'string' ? partOf.get(v['parentId']) : undefined;
    if (under !== undefined) {
      v['parentId'] = under.copyId;
      v['parentPart'] = under.key;
    }
    if (info !== undefined && !info.root) {
      const comps = v['components'] as Record<string, unknown>;
      delete comps['prefab'];
    }
    out.push(v);
  }
  return out;
}
