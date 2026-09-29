/**
 * Asset files in the game folder: turn the backend's file check (what it did)
 * and integrity report (what is still wrong) into the rows the Problems panel
 * shows. The file is the asset, so the check already imported every changed
 * file it could and followed every file moved with its sidecar; what remains
 * is for the user:
 *
 * - a changed file the check could not import again (an FBX without Blender,
 *   an animated model whose roles must be chosen, bytes the importer refuses)
 *   ⇒ one row with the reason, offering re-import;
 * - a missing file (not found by its sidecar either) ⇒ one row;
 * - imported data that could not be made again (a converted model or KTX2
 *   whose import cache entry is gone) ⇒ one row;
 * - older versions a legacy animation binding keeps whose file no longer
 *   matches ⇒ one row saying they can no longer be read.
 *
 * Pure: no DOM, no I/O.
 */
import type { FileCheckView, IntegrityEntryView } from './client';

export interface SourceIssue {
  /** Stable React key. */
  key: string;
  assetId: string;
  displayName: string;
  sourcePath: string;
  kind: 'changed' | 'missing' | 'old-versions' | 'imported-missing';
  /** The version(s) the row is about. */
  versions: number[];
  /** Whether "Re-import" applies (the current version's file changed). */
  canReimport: boolean;
  message: string;
}

export function sourceIssuesFrom(
  entries: readonly IntegrityEntryView[],
  names: ReadonlyMap<string, string>,
  check?: FileCheckView,
): SourceIssue[] {
  const out: SourceIssue[] = [];
  const failed = new Map((check?.failed ?? []).map((f) => [f.assetId, f]));
  const byAsset = new Map<string, IntegrityEntryView[]>();
  for (const e of entries) {
    const list = byAsset.get(e.assetId) ?? [];
    list.push(e);
    byAsset.set(e.assetId, list);
  }
  for (const [assetId, list] of [...byAsset.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const name = names.get(assetId) ?? assetId;
    const current = list.find((e) => e.referenced);
    const why = failed.get(assetId);
    if (current !== undefined) {
      // The asset's file: its own path, or a converted asset's original.
      const conv = current.convertedFrom;
      const path = current.sourcePath ?? conv?.sourcePath;
      const fileStatus = current.sourcePath !== undefined ? current.status : conv?.status;
      if (path !== undefined && fileStatus !== undefined && fileStatus !== 'ok') {
        const changed = fileStatus === 'changed';
        out.push({
          key: `${assetId}:current`,
          assetId,
          displayName: name,
          sourcePath: path,
          kind: changed ? 'changed' : 'missing',
          versions: [current.version],
          canReimport: changed,
          message: changed
            ? `${name}: ${path} has changed and could not be imported again${why !== undefined ? `: ${why.message}` : ''}. Play and export refuse it until it is.`
            : fileStatus === 'missing'
              ? `${name}: ${path} is missing from the game folder. Put it back, or move it together with its .tlasset file and check files again.`
              : `${name}: ${path} cannot be read (${fileStatus}).`,
        });
      } else if (conv !== undefined && current.status !== 'ok') {
        out.push({
          key: `${assetId}:imported`,
          assetId,
          displayName: name,
          sourcePath: path ?? '',
          kind: 'imported-missing',
          versions: [current.version],
          canReimport: false,
          message: `${name}: the data imported from ${path ?? 'its file'} is not in the import cache and could not be made again${why !== undefined ? `: ${why.message}` : ''}.`,
        });
      }
    }
    const stale = list.filter((e) => !e.referenced && e.sourcePath !== undefined && e.status !== 'ok').map((e) => e.version).sort((a, b) => a - b);
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
