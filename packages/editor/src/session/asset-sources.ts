/**
 * Files referenced in place in the game folder: turn the backend's integrity
 * report into the rows the Problems panel shows.
 *
 * - the current version's file changed ⇒ one row offering re-import;
 * - the current version's file is missing ⇒ one row (nothing to re-import);
 * - older versions whose file no longer matches ⇒ one row saying they can no
 *   longer be read (they stay in the history; nothing crashes);
 * - a model converted from an FBX whose FBX changed ⇒ one row offering
 *   re-import (the stored conversion keeps working until then); a missing FBX
 *   is only noted.
 *
 * Pure: no DOM, no I/O.
 */
import type { IntegrityEntryView } from './client';

export interface SourceIssue {
  /** Stable React key. */
  key: string;
  assetId: string;
  displayName: string;
  sourcePath: string;
  kind: 'changed' | 'missing' | 'old-versions' | 'fbx-changed' | 'fbx-missing';
  /** The version(s) the row is about. */
  versions: number[];
  /** Whether "Re-import" applies (the current version's file changed). */
  canReimport: boolean;
  message: string;
}

export function sourceIssuesFrom(
  entries: readonly IntegrityEntryView[],
  names: ReadonlyMap<string, string>,
): SourceIssue[] {
  const out: SourceIssue[] = [];
  // Converted models: only the current version's original matters (older
  // versions are stored GLBs and stay readable whatever the FBX does now).
  for (const e of entries) {
    const conv = e.convertedFrom;
    if (!e.referenced || conv?.sourcePath === undefined || conv.status === 'ok') continue;
    const name = names.get(e.assetId) ?? e.assetId;
    const changed = conv.status === 'changed';
    out.push({
      key: `${e.assetId}:fbx`,
      assetId: e.assetId,
      displayName: name,
      sourcePath: conv.sourcePath,
      kind: changed ? 'fbx-changed' : 'fbx-missing',
      versions: [e.version],
      canReimport: changed,
      message: changed
        ? `${name}: ${conv.sourcePath} has changed since v${e.version} was converted. Re-import to convert it again; until then Play and export use the previous conversion.`
        : `${name}: ${conv.sourcePath} is missing from the game folder. The imported model still works; it cannot be re-imported until the FBX is back.`,
    });
  }
  const byAsset = new Map<string, IntegrityEntryView[]>();
  for (const e of entries) {
    if (e.sourcePath === undefined) continue;
    const list = byAsset.get(e.assetId) ?? [];
    list.push(e);
    byAsset.set(e.assetId, list);
  }
  for (const [assetId, list] of [...byAsset.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const name = names.get(assetId) ?? assetId;
    const current = list.find((e) => e.referenced);
    if (current !== undefined && current.status !== 'ok') {
      const path = current.sourcePath!;
      const changed = current.status === 'changed';
      out.push({
        key: `${assetId}:current`,
        assetId,
        displayName: name,
        sourcePath: path,
        kind: changed ? 'changed' : 'missing',
        versions: [current.version],
        canReimport: changed,
        message: changed
          ? `${name}: ${path} has changed since v${current.version} was imported. Play and export refuse it until you re-import.`
          : current.status === 'missing'
            ? `${name}: ${path} is missing from the game folder. Play and export refuse it until the file is back.`
            : `${name}: ${path} cannot be read (${current.status}).`,
      });
    }
    const stale = list.filter((e) => !e.referenced && e.status !== 'ok').map((e) => e.version).sort((a, b) => a - b);
    if (stale.length > 0) {
      const paths = [...new Set(list.filter((e) => stale.includes(e.version)).map((e) => e.sourcePath!))];
      out.push({
        key: `${assetId}:old`,
        assetId,
        displayName: name,
        sourcePath: paths.join(', '),
        kind: 'old-versions',
        versions: stale,
        canReimport: false,
        message: `${name}: older version${stale.length === 1 ? '' : 's'} ${stale.map((v) => `v${v}`).join(', ')} can no longer be read: ${paths.join(', ')} no longer holds the bytes ${stale.length === 1 ? 'it was' : 'they were'} imported from.`,
      });
    }
  }
  return out;
}
