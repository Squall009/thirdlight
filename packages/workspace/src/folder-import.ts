/**
 * Folder import: every supported file of a folder in the game folder comes
 * in as an asset named after its file (`assets/audio/voice/<line>.ogg` → an
 * asset named `<line>`), in one `importAssets` command.
 *
 * This module reads the folder (`scanAssetFolder`) and, at the command,
 * chooses each new asset's id (`mintImportItems`); the backend inspects the
 * files in between. The rules, as Unity's asset database has them:
 *
 * - the asset's name is the file's name without its extension; two files of
 *   the same name in different folders are two assets of the same name (their
 *   paths tell them apart);
 * - the id is the name made id-safe (lowercase letters, digits, `-`, `_`),
 *   then `-2`, `-3`, … while another asset has it; a file whose sidecar names
 *   an id no asset has keeps that id (a folder copied from another project
 *   keeps its references), and a sidecar whose id is taken by another file is
 *   a copy: it gets a new id;
 * - a file the catalog already imports is skipped (its sidecar names an asset
 *   that is here, or a record names its path): importing a folder again brings
 *   only its new files;
 * - hidden files and folders, sidecars, resource files and symlinks are not imported; a file
 *   of a type no importer takes is reported, never fatal.
 */
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { ID_RE, isAssetLabel, isValidSourcePath, type ContentCatalogV4 } from '@thirdlight/project-model';
import type { CommandError, PreparedAssetImportItem } from '@thirdlight/commands';

import { PROJECT_OWN_ENTRIES, SIDECAR_SUFFIX, assetRoot, checkAssetFolder, fileOfRecord, gameFileExists, parseSidecar, readGameFile, sidecarPath, takenPaths, writeGameFile, type RecordLike } from './asset-files';
import { IMPORTABLE, resolveProjectFile, type ContentConfig, type ContentContext } from './content-store';
import { sha256Hex } from './digest';
import { resourceKindOfName } from './resource-files';
import { pathRejected } from './errors';
import type { WriteOps } from './write';

export type ImportKind = 'model' | 'audio' | 'texture' | 'music' | 'font';

/** One importable file of a folder. */
export interface FolderImportFile {
  path: string;
  kind: ImportKind;
  byteLength: number;
  /** The id and labels its sidecar names (a folder copied from another project). */
  sidecar: { id: string; labels: string[] } | null;
}

export interface FolderImportScan {
  folder: string;
  files: FolderImportFile[];
  /** Files no importer takes (why), reported to the user. */
  unsupported: { path: string; reason: string }[];
  /** Files the catalog already imports (their asset). */
  known: { path: string; assetId: string }[];
}

/** Folders deep enough for any real layout; deeper is a symlink-free cycle guard. */
const MAX_FOLDER_DEPTH = 32;

/** The kind an importer takes a file as, by its extension (null: none). */
export function importKindOf(name: string): ImportKind | null {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? (IMPORTABLE[name.slice(dot).toLowerCase()] ?? null) : null;
}

/** Every file of a folder of the game folder, recursively (a folder's files by name, then its subfolders). */
export function scanAssetFolder(ctx: ContentContext, folder: string): { ok: true; scan: FolderImportScan } | { ok: false; error: CommandError } {
  const vetted = checkAssetFolder(ctx, folder);
  if (!vetted.ok) return vetted;
  const dir = resolveProjectFile(ctx, folder, 'dir');
  if (!dir.ok) return { ok: false, error: dir.error };
  const records = (ctx.content?.assets ?? []) as unknown as RecordLike[];
  const byFile = new Map<string, string>();
  for (const r of records) {
    const f = fileOfRecord(r);
    if (f !== null) byFile.set(f.toLowerCase(), r.assetId);
  }
  const ids = new Set(records.map((r) => r.assetId));
  const scan: FolderImportScan = { folder, files: [], unsupported: [], known: [] };
  const root = assetRoot(ctx);
  const walk = (rel: string, depth: number): void => {
    let names: string[];
    try {
      names = readdirSync(join(root, ...rel.split('/'))).sort();
    } catch {
      scan.unsupported.push({ path: rel, reason: 'the folder could not be read' });
      return;
    }
    // A folder's own files first, then its subfolders: the shallower file of a name gets the plain id.
    const subfolders: string[] = [];
    for (const name of names) {
      if (name.startsWith('.')) continue;
      const path = `${rel}/${name}`;
      if (rel === '' && ctx.gameFolder == null && PROJECT_OWN_ENTRIES.has(name)) continue;
      let st;
      try {
        st = lstatSync(join(root, ...path.split('/')));
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        scan.unsupported.push({ path, reason: 'a symlink (not followed)' });
        continue;
      }
      if (st.isDirectory()) {
        if (join(root, ...path.split('/')) === ctx.dir) continue;
        if (depth >= MAX_FOLDER_DEPTH) scan.unsupported.push({ path, reason: `deeper than ${MAX_FOLDER_DEPTH} folders` });
        else subfolders.push(path);
        continue;
      }
      // Sidecars and the project's resource files (prefabs, materials, …) are not assets.
      if (!st.isFile() || name.endsWith(SIDECAR_SUFFIX) || resourceKindOfName(name) !== null) continue;
      if (!isValidSourcePath(path)) {
        scan.unsupported.push({ path, reason: 'the name cannot be an asset path' });
        continue;
      }
      const kind = importKindOf(name);
      if (kind === null) {
        const dot = name.lastIndexOf('.');
        scan.unsupported.push({ path, reason: dot > 0 ? `no importer takes ${name.slice(dot).toLowerCase()} files` : 'a file without an extension' });
        continue;
      }
      const knownId = byFile.get(path.toLowerCase());
      const sidecarBytes = readGameFile(ctx, sidecarPath(path));
      const sidecar = sidecarBytes === null ? null : parseSidecar(sidecarBytes);
      if (knownId !== undefined) {
        scan.known.push({ path, assetId: knownId });
        continue;
      }
      // Its sidecar names an asset of this project: a file moved here (the file check re-points it) or a copy of it.
      if (sidecar !== null && ids.has(sidecar.id)) {
        const other = records.find((r) => r.assetId === sidecar.id);
        const otherFile = other === undefined ? null : fileOfRecord(other);
        if (otherFile === null || !gameFileExists(ctx, otherFile)) {
          scan.known.push({ path, assetId: sidecar.id });
          continue;
        }
      }
      scan.files.push({ path, kind, byteLength: st.size, sidecar: sidecar === null ? null : { id: sidecar.id, labels: sidecar.labels } });
    }
    for (const sub of subfolders) walk(sub, depth + 1);
  };
  walk(folder, 0);
  return { ok: true, scan };
}

/** A file's facts as the backend prepared them for the command (the id is chosen at the command). */
export interface PreparedImportFile {
  path: string;
  /** The id its sidecar names, kept when no asset has it. */
  idHint: string | null;
  /** The labels its sidecar names. */
  labels: string[];
  item: Omit<PreparedAssetImportItem, 'assetId' | 'labels'>;
}

/** The asset's name: the file's name without its extension. */
export function assetNameOfFile(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  // A display name holds no control characters.
  return stem.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 128) || name.slice(0, 128);
}

/** The name made id-safe: lowercase letters, digits, `-` and `_`, starting with a letter or digit. */
export function idStemOf(name: string): string {
  const s = name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 56);
  return s.length > 0 ? s : 'asset';
}

/** The first free id from a stem (`<stem>`, `<stem>-2`, …). */
export function freeAssetId(stem: string, taken: ReadonlySet<string>): string {
  for (let n = 1; ; n += 1) {
    const id = n === 1 ? stem : `${stem}-${n}`;
    if (!taken.has(id)) return id;
  }
}

/** Choose each file's id against the catalog as it is now (the command's state). */
export function mintImportItems(content: ContentCatalogV4 | null, files: readonly PreparedImportFile[]): PreparedAssetImportItem[] {
  const taken = new Set((content?.assets ?? []).map((a) => a.assetId));
  const known = takenPaths(content);
  const out: PreparedAssetImportItem[] = [];
  for (const f of files) {
    // Imported meanwhile (another client, a second request): not again.
    if (known.has(f.path.toLowerCase())) continue;
    const hint = f.idHint !== null && ID_RE.test(f.idHint) && !taken.has(f.idHint) ? f.idHint : null;
    const assetId = hint ?? freeAssetId(idStemOf(f.item.displayName ?? assetNameOfFile(f.path)), taken);
    taken.add(assetId);
    // A sidecar's label that is not one (edited by hand) is left out rather than refusing the import.
    const labels = f.labels.filter(isAssetLabel);
    out.push({ ...f.item, assetId, ...(labels.length > 0 ? { labels } : {}) });
  }
  return out;
}

/**
 * Write one uploaded file into the game folder at `rel` (its folders are
 * made). Never over another file: the same bytes already there are fine, other
 * bytes are refused (the uploader chooses another folder or name).
 */
export function writeUploadedFile(core: { ops: WriteOps; content: ContentConfig }, ctx: ContentContext, rel: string, bytes: Uint8Array): { ok: true; written: boolean } | { ok: false; error: CommandError } {
  const slash = rel.lastIndexOf('/');
  if (slash <= 0) return { ok: false, error: pathRejected(rel, 'an uploaded file goes into a folder of the game folder, e.g. assets/crate.glb') };
  const vetted = checkAssetFolder(ctx, rel.slice(0, slash));
  if (!vetted.ok) return vetted;
  const there = readGameFile(ctx, rel);
  if (there !== null) {
    if (sha256Hex(there) === sha256Hex(bytes)) return { ok: true, written: false };
    return { ok: false, error: pathRejected(rel, `${rel} already holds another file; upload into another folder`) };
  }
  if (gameFileExists(ctx, rel)) return { ok: false, error: pathRejected(rel, `${rel} cannot be replaced`) };
  const w = writeGameFile(core, ctx, rel, bytes);
  return w.ok ? { ok: true, written: true } : w;
}
