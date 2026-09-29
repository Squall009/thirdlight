/**
 * Folders in the Assets tab: where uploads land, a folder dropped from the
 * computer, and the labels a folder import applies. Pure (no I/O).
 */
import { ASSET_LABEL_RE, DEFAULT_ASSET_FOLDER } from '@thirdlight/project-model/limits';

/** Where uploaded files go when the user names no folder. */
export const DEFAULT_UPLOAD_FOLDER = DEFAULT_ASSET_FOLDER;

/** One file of a folder the user picked (`relativePath` starts with the folder's own name). */
export interface PickedFile {
  relativePath: string;
  file: File;
}

/**
 * Where each file of a picked folder goes: `<into>/<folder name>/…`, or
 * `<folder name>-2`, … when `into` already has an entry of that name (a
 * folder is never merged into another). Hidden files and folders are left
 * out. Null when nothing is left.
 */
export function planFolderUpload(picked: readonly PickedFile[], into: string, taken: ReadonlySet<string>): { folder: string; files: { path: string; file: File }[] } | null {
  const kept = picked.filter((p) => p.relativePath.split('/').every((seg) => seg !== '' && !seg.startsWith('.')));
  if (kept.length === 0) return null;
  const top = kept[0]!.relativePath.split('/')[0]!;
  let name = top;
  for (let n = 2; taken.has(name.toLowerCase()); n += 1) name = `${top}-${n}`;
  const folder = `${into}/${name}`;
  return { folder, files: kept.map((p) => ({ path: `${folder}/${p.relativePath.split('/').slice(1).join('/')}`, file: p.file })) };
}

/** Labels typed as `voice, level-3` (commas or spaces): the valid ones, and the rest to report. */
export function parseLabels(text: string): { labels: string[]; invalid: string[] } {
  const parts = text.split(/[\s,]+/).filter((p) => p.length > 0);
  const labels = [...new Set(parts.filter((p) => ASSET_LABEL_RE.test(p)))];
  return { labels, invalid: parts.filter((p) => !ASSET_LABEL_RE.test(p)) };
}

/** What a folder import did, as the backend reports it next to the command's result. */
export interface FolderImportView {
  folder: string;
  prepared: number;
  skipped: { path: string; assetId: string }[];
  unsupported: { path: string; reason: string }[];
  rejected: { path: string; code: string; message: string }[];
}

/** One line for the Assets tab. */
export function describeFolderImport(added: number, report: FolderImportView | undefined): string {
  const parts = [`imported ${added} asset${added === 1 ? '' : 's'}`];
  if (report !== undefined && report.skipped.length > 0) parts.push(`${report.skipped.length} already imported`);
  const notImported = [...(report?.unsupported ?? []).map((u) => `${u.path.split('/').pop()} (${u.reason})`), ...(report?.rejected ?? []).map((r) => `${r.path.split('/').pop()} (${r.message})`)];
  if (notImported.length > 0) parts.push(`not imported: ${notImported.slice(0, 8).join('; ')}${notImported.length > 8 ? ` and ${notImported.length - 8} more` : ''}`);
  return parts.join(' · ');
}
