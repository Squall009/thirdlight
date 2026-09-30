/**
 * The asset database on disk (Unity's `.meta`, Godot's `.import`).
 *
 * Every imported file is kept in the game folder (a project in the data root
 * uses its own folder the same way), and next to it `<file>.tlasset` holds
 * the asset's stable id, kind, import settings, labels and address, and its
 * catalog record: the project reads its assets from the sidecars, and a
 * command writes the sidecars it changes with the project files (one
 * transaction). The file is the truth: references use the id, so a file moved
 * together with its sidecar is the same asset, and a file whose bytes change
 * is imported again.
 *
 * Besides the game folder this module owns two stores, neither authoritative:
 *
 * - the import cache, `<project>/cache/imported/<source digest>/<importer
 *   and settings>/`: what an importer made from a file (a GLB converted from
 *   an FBX, a KTX2 encoded from a PNG, the inspected header of any file,
 *   thumbnails). It is git-ignored and rebuilt when missing;
 * - the held bytes, `.thirdlight/held/<digest>`: an upload waiting for the
 *   command that files it into the game folder, and the bytes a replace or a
 *   delete took out of the game folder, so undo can put them back.
 */
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, utimesSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';

import { audioLoadOf, DEFAULT_ASSET_FOLDER, isValidSourcePath, textureHasStreamableChain, textureStreamingOf } from '@thirdlight/project-model';
import type { ContentCatalogV4 } from '@thirdlight/project-model';
import type { ChangeData, CommandError } from '@thirdlight/commands';

import { sha256Hex } from './digest';
import { contentPublishFailed, contentQuotaExceeded, pathRejected } from './errors';
import { writeAtomic, type WriteOps } from './write';
import type { ContentConfig, ContentContext } from './content-store';
import { readBlobBytes, resolveProjectFile } from './content-store';
import { layoutProjectJson } from './project-json';
import { SIDECAR_SUFFIX } from './resource-files';
import { assetRecordOf } from './catalog-lookup';

// ---- layout --------------------------------------------------------------

/** The sidecar next to every asset file (resource-files.ts owns the name: sidecars are project files). */
export { SIDECAR_SUFFIX };
/**
 * The sidecar format this build writes. It carries the asset's catalog
 * record (`record`): the sidecar is the truth, and the project reads its
 * assets from the sidecars. A 3's record holds the address too (the labels
 * and address beside it repeat the record's, for a person reading the file).
 * A 2 (the address beside the record only) is read and upgraded at the open;
 * a 1 (id, kind, settings, labels, address only) is still read where a
 * sidecar names an asset.
 */
export const SIDECAR_FORMAT = 3;
/** The sidecar format before addresses were the record's (the open upgrades it). */
export const SIDECAR_FORMAT_PRE_ADDRESS = 2;
/** Where an upload lands when nothing names a folder (the model's constant, shared with the editor). */
export { DEFAULT_ASSET_FOLDER };
/** The import cache under the project folder (git-ignored). */
export const IMPORT_CACHE_SEGMENTS = ['cache', 'imported'] as const;
/** Held bytes keep for a day; later an undo that needs them reports the file as missing. */
export const HELD_RETENTION_MS = 86_400_000;

/**
 * The project's own entries in a data-root project's folder: never asset
 * files (a folder project keeps them one level down, in its project subfolder).
 */
export const PROJECT_OWN_ENTRIES: ReadonlySet<string> = new Set([
  'project.json',
  'content.json',
  'scenes',
  'sources',
  'cache',
  '.thirdlight',
  '.gitignore',
  'upgrade-report.json',
]);

/** The folder asset paths are relative to: the game folder, or a data-root project's own folder. */
export function assetRoot(ctx: Pick<ContentContext, 'gameFolder' | 'dir'>): string {
  return ctx.gameFolder ?? ctx.dir;
}

// ---- records -------------------------------------------------------------

/** The version fields this module reads. */
export interface VersionLike {
  readonly version: number;
  readonly sourceDigest: string;
  readonly sourceByteLength: number;
  readonly sourcePath?: string;
  readonly convertedFrom?: ConvertedLike;
  readonly packedFrom?: {
    readonly layers: readonly (readonly ({ readonly assetId: string; readonly digest: string; readonly channel: string } | { readonly value: number })[])[];
    readonly converter: { readonly name: string; readonly version: string };
    readonly encoding: string;
  };
  readonly metrics?: unknown;
}

export interface ConvertedLike {
  readonly format: string;
  readonly sourceDigest: string;
  readonly sourceByteLength: number;
  readonly sourcePath?: string;
  readonly converter: { readonly name: string; readonly version: string };
  readonly encoding?: string;
}

export interface RecordLike {
  readonly assetId: string;
  readonly kind?: string;
  readonly displayName?: string;
  readonly currentVersion: number;
  readonly versions: readonly VersionLike[];
  readonly vertexColors?: string;
  readonly materials?: Readonly<Record<string, string>>;
  readonly clipsFor?: string;
  readonly streaming?: boolean;
}

export function currentVersionOf(record: RecordLike): VersionLike | undefined {
  return record.versions.find((v) => v.version === record.currentVersion);
}

/** The game-folder file a version is imported from (a converted version's original), or null for stored bytes. */
export function fileOfVersion(v: VersionLike): string | null {
  return v.sourcePath ?? v.convertedFrom?.sourcePath ?? null;
}

/** The digest and size of that file's bytes. */
export function fileFactsOfVersion(v: VersionLike): { digest: string; byteLength: number } {
  return v.convertedFrom !== undefined
    ? { digest: v.convertedFrom.sourceDigest, byteLength: v.convertedFrom.sourceByteLength }
    : { digest: v.sourceDigest, byteLength: v.sourceByteLength };
}

/** The current file of a record (null: its bytes are stored, not a file). */
export function fileOfRecord(record: RecordLike): string | null {
  const v = currentVersionOf(record);
  return v === undefined ? null : fileOfVersion(v);
}

// ---- sidecars ------------------------------------------------------------

/** One `.tlasset` sidecar. */
export interface SidecarDoc {
  tlasset: 1 | typeof SIDECAR_FORMAT_PRE_ADDRESS | typeof SIDECAR_FORMAT;
  id: string;
  kind: string;
  /** How the file is imported (the settings digest of the import cache is taken over these). */
  importSettings: Record<string, unknown>;
  /** Labels a script may load the asset by (the record's). */
  labels: string[];
  /** The name scripts may load the asset by; null: none. */
  address: string | null;
  /** The asset's catalog record (format 2): what the project holds of it. */
  record?: Record<string, unknown>;
}

export function sidecarPath(file: string): string {
  return `${file}${SIDECAR_SUFFIX}`;
}

/** The file a sidecar path stands next to (null: not a sidecar). */
export function fileOfSidecar(path: string): string | null {
  return path.endsWith(SIDECAR_SUFFIX) && path.length > SIDECAR_SUFFIX.length ? path.slice(0, -SIDECAR_SUFFIX.length) : null;
}

/**
 * The import settings of a record's current version, as the sidecar states
 * them: a conversion (FBX to GLB, PNG/JPEG to KTX2 with its encoding), a
 * packed texture's sources (by id and file), and the model options.
 */
export function importSettingsOf(record: RecordLike): Record<string, unknown> {
  const v = currentVersionOf(record);
  const out: Record<string, unknown> = {};
  if (v?.convertedFrom !== undefined) {
    const c = v.convertedFrom;
    if (c.encoding !== undefined) out['ktx2'] = c.encoding;
    else out['convert'] = { from: c.format, to: 'glb' };
    out['converter'] = `${c.converter.name}@${c.converter.version}`;
  }
  if (v?.packedFrom !== undefined) {
    const p = v.packedFrom;
    out['packed'] = {
      encoding: p.encoding,
      converter: `${p.converter.name}@${p.converter.version}`,
      layers: p.layers.map((layer) =>
        layer.map((c) => ('value' in c ? { value: c.value } : { id: c.assetId, channel: c.channel })),
      ),
    };
  }
  if (record.vertexColors !== undefined) out['vertexColors'] = record.vertexColors;
  if (record.materials !== undefined) out['materials'] = { ...record.materials };
  if (record.clipsFor !== undefined) out['clipsFor'] = record.clipsFor;
  // An audio file's load settings as the game uses them (the record stores only a changed one).
  if (record.kind === 'audio') Object.assign(out, audioLoadOf(record));
  // A texture with a mip chain to stream says whether it streams (the record stores only a chosen value).
  if (record.kind === 'texture' && textureHasStreamableChain(v?.metrics)) out['streaming'] = textureStreamingOf(record);
  return out;
}

/** A record's sidecar. */
export function sidecarOf(record: RecordLike): SidecarDoc {
  return {
    tlasset: SIDECAR_FORMAT,
    id: record.assetId,
    kind: record.kind ?? 'model',
    importSettings: importSettingsOf(record),
    labels: [...((record as { labels?: string[] }).labels ?? [])],
    address: (record as { address?: string }).address ?? null,
    record: record as unknown as Record<string, unknown>,
  };
}

/** A sidecar's bytes (the project-file layout: a diff shows one line per changed item). */
export function sidecarBytes(doc: SidecarDoc): Uint8Array {
  return new TextEncoder().encode(`${layoutProjectJson(doc)}\n`);
}

/** Parse a sidecar; null when it is not one this build reads. */
export function parseSidecar(bytes: Uint8Array): SidecarDoc | null {
  let v: unknown;
  try {
    v = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const d = v as Record<string, unknown>;
  if ((d['tlasset'] !== 1 && d['tlasset'] !== SIDECAR_FORMAT_PRE_ADDRESS && d['tlasset'] !== SIDECAR_FORMAT) || typeof d['id'] !== 'string' || typeof d['kind'] !== 'string') return null;
  const labels = Array.isArray(d['labels']) ? d['labels'].filter((x): x is string => typeof x === 'string') : [];
  const settings = typeof d['importSettings'] === 'object' && d['importSettings'] !== null && !Array.isArray(d['importSettings']) ? (d['importSettings'] as Record<string, unknown>) : {};
  const record = d['tlasset'] !== 1 && typeof d['record'] === 'object' && d['record'] !== null && !Array.isArray(d['record']) ? (d['record'] as Record<string, unknown>) : undefined;
  return { tlasset: d['tlasset'], id: d['id'], kind: d['kind'], importSettings: settings, labels, address: typeof d['address'] === 'string' ? d['address'] : null, ...(record !== undefined ? { record } : {}) };
}

// ---- game-folder files ---------------------------------------------------

type Core = { ops: WriteOps; content: ContentConfig };

/**
 * Writes of data made again when missing or stale (the import cache's
 * headers): still write-then-rename, but not flushed to disk one by one, so
 * importing a thousand files does not wait on a thousand flushes. A crash can
 * lose such a write, never tear the project's own files.
 */
export function rebuildable(core: Core): Core {
  return { ...core, ops: { ...core.ops, fsyncFile: () => undefined, fsyncDir: () => undefined } };
}

function within(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/**
 * Make the folders of a game-folder path (every existing one a real folder
 * inside the game folder, never the project's own files) and return the
 * absolute target, or why it cannot be written.
 */
function prepareTarget(ctx: ContentContext, rel: string, create = true): { ok: true; abs: string; dir: string } | { ok: false; error: CommandError } {
  if (!isValidSourcePath(rel)) return { ok: false, error: pathRejected(rel, 'an asset path is relative to the game folder, with forward slashes') };
  const segs = rel.split('/');
  if (segs.includes('.git')) return { ok: false, error: pathRejected(rel, '.git/ is not an asset folder') };
  // Hidden folders hold tools' state (.thirdlight, .git, editor settings), never assets.
  if (segs.slice(0, -1).some((seg) => seg.startsWith('.'))) return { ok: false, error: pathRejected(rel, 'a hidden folder is not an asset folder') };
  const root = assetRoot(ctx);
  if (ctx.gameFolder == null ? PROJECT_OWN_ENTRIES.has(segs[0]!) : join(root, segs[0]!) === ctx.dir) {
    return { ok: false, error: pathRejected(rel, `${segs[0]!} holds the project's own files, not assets`) };
  }
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return { ok: false, error: pathRejected(rel, 'the game folder is unavailable') };
  }
  let realProject: string | null = null;
  if (ctx.gameFolder != null) {
    try {
      realProject = realpathSync(ctx.dir);
    } catch {
      realProject = null;
    }
  }
  let cur = root;
  for (const seg of segs.slice(0, -1)) {
    cur = join(cur, seg);
    try {
      const st = lstatSync(cur);
      if (st.isSymbolicLink()) {
        const real = realpathSync(cur);
        if (!within(realRoot, real) || (realProject !== null && within(realProject, real))) return { ok: false, error: pathRejected(rel, `${rel} leads out of the game folder`) };
        if (!statSync(real).isDirectory()) return { ok: false, error: pathRejected(rel, `${seg} is not a folder`) };
      } else if (!st.isDirectory()) {
        return { ok: false, error: pathRejected(rel, `${seg} is not a folder`) };
      }
    } catch {
      if (!create) continue;
      try {
        mkdirSync(cur, { mode: 0o755 });
      } catch {
        return { ok: false, error: contentPublishFailed('write') };
      }
    }
  }
  const abs = join(root, ...segs);
  try {
    if (lstatSync(abs).isSymbolicLink()) return { ok: false, error: pathRejected(rel, `${rel} is a symlink; the editor does not write through it`) };
  } catch {
    // absent: fine
  }
  return { ok: true, abs, dir: dirname(abs) };
}

/**
 * Whether files may be written into a folder of the game folder: a relative
 * path inside it (no `..`, no symlink leading out), not a hidden folder and
 * not the project's own files. The folder need not exist yet.
 */
export function checkAssetFolder(ctx: ContentContext, folder: string): { ok: true } | { ok: false; error: CommandError } {
  if (folder === '') return { ok: false, error: pathRejected(folder, 'name a folder inside the game folder, e.g. assets') };
  const t = prepareTarget(ctx, `${folder}/file`, false);
  if (!t.ok) return { ok: false, error: { ...t.error, message: t.error.message.split(`${folder}/file`).join(folder) } as CommandError };
  return { ok: true };
}

/** Write one game-folder file (write then rename). */
export function writeGameFile(core: Core, ctx: ContentContext, rel: string, bytes: Uint8Array): { ok: true } | { ok: false; error: CommandError } {
  const t = prepareTarget(ctx, rel);
  if (!t.ok) return t;
  const free = core.content.freeSpaceBytes(t.dir);
  if (free - bytes.length < core.content.deviceSpaceReserveBytes) {
    return { ok: false, error: contentQuotaExceeded('device_space', free, core.content.deviceSpaceReserveBytes, bytes.length) };
  }
  const wr = writeAtomic({ dir: t.dir, target: t.abs, bytes, allowedPreHashes: [], previousHash: null, ops: core.ops });
  if (wr.ok) return { ok: true };
  return { ok: false, error: contentPublishFailed('write', wr.failed?.onDiskState, wr.failed?.errno) };
}

/** The bytes of a game-folder file, or null when it is absent or cannot be read. */
export function readGameFile(ctx: ContentContext, rel: string): Uint8Array | null {
  const r = resolveProjectFile(ctx, rel);
  if (!r.ok) return null;
  const b = readBlobBytes(r.real);
  return b.ok ? b.bytes : null;
}

/** Whether a regular file is at a game-folder path. */
export function gameFileExists(ctx: ContentContext, rel: string): boolean {
  const r = resolveProjectFile(ctx, rel);
  return r.ok;
}

/** Remove a game-folder file (never the project's own files; a missing file is fine). */
export function removeGameFile(ctx: ContentContext, rel: string): void {
  const r = resolveProjectFile(ctx, rel);
  if (!r.ok) return;
  try {
    unlinkSync(join(assetRoot(ctx), ...rel.split('/')));
  } catch {
    // best effort: a file that cannot be removed stays (the refresh reports it)
  }
}

/** Move a game-folder file to another path in it (its folders are made). */
export function moveGameFile(ctx: ContentContext, from: string, to: string): boolean {
  const src = resolveProjectFile(ctx, from);
  if (!src.ok) return false;
  const t = prepareTarget(ctx, to);
  if (!t.ok) return false;
  try {
    lstatSync(t.abs);
    return false;
  } catch {
    // the target is free
  }
  try {
    renameSync(join(assetRoot(ctx), ...from.split('/')), t.abs);
    return true;
  } catch {
    return false;
  }
}

// ---- held bytes -----------------------------------------------------------

function heldDir(ctx: ContentContext): string {
  return join(ctx.thirdlightDir, 'held');
}

const DIGEST_RE = /^[0-9a-f]{64}$/;

/** Keep bytes by their digest until a command files them (or an undo puts them back). */
export function holdBytes(core: Core, ctx: ContentContext, bytes: Uint8Array): { ok: true; digest: string } | { ok: false; error: CommandError } {
  const digest = sha256Hex(bytes);
  const dir = heldDir(ctx);
  const target = join(dir, digest);
  const existing = readBlobBytes(target);
  if (existing.ok && sha256Hex(existing.bytes) === digest) {
    touch(target);
    return { ok: true, digest };
  }
  try {
    mkdirSync(dir, { recursive: true, mode: 0o755 });
  } catch {
    return { ok: false, error: contentPublishFailed('write') };
  }
  const free = core.content.freeSpaceBytes(dir);
  if (free - bytes.length < core.content.deviceSpaceReserveBytes) {
    return { ok: false, error: contentQuotaExceeded('device_space', free, core.content.deviceSpaceReserveBytes, bytes.length) };
  }
  const wr = writeAtomic({ dir, target, bytes, allowedPreHashes: [], previousHash: null, ops: core.ops });
  if (!wr.ok) return { ok: false, error: contentPublishFailed('write', wr.failed?.onDiskState, wr.failed?.errno) };
  return { ok: true, digest };
}

/** Held bytes with this digest (verified), or null. */
export function readHeld(ctx: ContentContext, digest: string): Uint8Array | null {
  if (!DIGEST_RE.test(digest)) return null;
  const r = readBlobBytes(join(heldDir(ctx), digest));
  if (!r.ok || sha256Hex(r.bytes) !== digest) return null;
  return r.bytes;
}

/** Renew held bytes' time: bytes an undo may still need are kept for the whole retention. */
function touch(path: string): void {
  try {
    const now = new Date();
    utimesSync(path, now, now);
  } catch {
    // best effort
  }
}

/** Drop held bytes older than the retention (at open). */
export function cleanupHeld(thirdlightDir: string, nowMs: number): number {
  const dir = join(thirdlightDir, 'held');
  let removed = 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    const p = join(dir, name);
    try {
      if (nowMs - statSync(p).mtimeMs > HELD_RETENTION_MS || !DIGEST_RE.test(name)) {
        rmSync(p, { force: true });
        removed += 1;
      }
    } catch {
      // best effort
    }
  }
  return removed;
}

// ---- the import cache ------------------------------------------------------

/** What an importer made from a file is keyed by the file's digest, the importer and its version, and the settings. */
export interface ImportKey {
  readonly sourceDigest: string;
  readonly importer: string;
  readonly importerVersion: string;
  readonly settings: Readonly<Record<string, unknown>>;
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (typeof v === 'object' && v !== null) {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/** The settings digest of a key (the importer and its version included). */
export function settingsDigest(key: ImportKey): string {
  return createHash('sha256').update(canonical({ importer: key.importer, version: key.importerVersion, settings: key.settings })).digest('hex');
}

const IMPORTER_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** The cache folder of one key (relative parts under the project folder), or null for a malformed key. */
export function importCacheSegments(key: ImportKey): string[] | null {
  if (!DIGEST_RE.test(key.sourceDigest) || !IMPORTER_RE.test(key.importer) || !IMPORTER_RE.test(key.importerVersion)) return null;
  return [...IMPORT_CACHE_SEGMENTS, key.sourceDigest, `${key.importer}-${key.importerVersion}-${settingsDigest(key).slice(0, 16)}`];
}

/** The import key of a converted version (its original, the converter and the encoding). */
export function importKeyOfConverted(c: ConvertedLike): ImportKey {
  return {
    sourceDigest: c.sourceDigest,
    importer: c.converter.name,
    importerVersion: c.converter.version,
    settings: c.encoding !== undefined ? { ktx2: c.encoding } : { to: 'glb' },
  };
}

/** The file name of an imported artifact (the digest of what the importer made). */
function artifactName(digest: string): string {
  return `${digest}.bin`;
}

/** Store what an importer made (write-once by digest; an existing entry is kept). */
export function writeImported(core: Core, ctx: ContentContext, key: ImportKey, bytes: Uint8Array): { ok: true; digest: string } | { ok: false; error: CommandError } {
  const segs = importCacheSegments(key);
  if (segs === null) return { ok: false, error: pathRejected('', 'the import cache key is malformed') };
  const digest = sha256Hex(bytes);
  const dir = join(ctx.dir, ...segs);
  const target = join(dir, artifactName(digest));
  const existing = readBlobBytes(target);
  if (existing.ok && sha256Hex(existing.bytes) === digest) return { ok: true, digest };
  try {
    mkdirSync(dir, { recursive: true, mode: 0o755 });
  } catch {
    return { ok: false, error: contentPublishFailed('write') };
  }
  const wr = writeAtomic({ dir, target, bytes, allowedPreHashes: [], previousHash: null, ops: core.ops });
  if (!wr.ok) return { ok: false, error: contentPublishFailed('write', wr.failed?.onDiskState, wr.failed?.errno) };
  return { ok: true, digest };
}

/** What an importer made, verified against the recorded digest; null when the cache does not hold it. */
export function readImported(ctx: ContentContext, key: ImportKey, digest: string): Uint8Array | null {
  const segs = importCacheSegments(key);
  if (segs === null || !DIGEST_RE.test(digest)) return null;
  const r = readBlobBytes(join(ctx.dir, ...segs, artifactName(digest)));
  if (!r.ok || sha256Hex(r.bytes) !== digest) return null;
  return r.bytes;
}

/** Where the cache keeps an artifact (null: a malformed key or digest, or the cache does not hold it). */
export function importedArtifactPath(ctx: ContentContext, key: ImportKey, digest: string): string | null {
  const segs = importCacheSegments(key);
  if (segs === null || !DIGEST_RE.test(digest)) return null;
  const path = join(ctx.dir, ...segs, artifactName(digest));
  try {
    const st = lstatSync(path);
    return st.isFile() ? realpathSync(path) : null;
  } catch {
    return null;
  }
}

/** Whether the cache holds an artifact (by size and name; a read verifies the bytes). */
export function hasImported(ctx: ContentContext, key: ImportKey, digest: string, byteLength: number): boolean {
  const segs = importCacheSegments(key);
  if (segs === null || !DIGEST_RE.test(digest)) return false;
  try {
    const st = statSync(join(ctx.dir, ...segs, artifactName(digest)));
    return st.isFile() && st.size === byteLength;
  } catch {
    return false;
  }
}

/** The inspected facts of a file (what a publish records), cached by the file's digest and the inspection asked. */
export interface ImportHeader {
  readonly kind: string;
  readonly sourceDigest: string;
  readonly sourceByteLength: number;
  readonly importRecipe: unknown;
  readonly metrics: unknown;
}

export function headerKey(sourceDigest: string, kind: string, toolchain: string): ImportKey {
  return { sourceDigest, importer: 'asset-pipeline', importerVersion: toolchain, settings: { kind } };
}

export function writeHeader(core: Core, ctx: ContentContext, key: ImportKey, header: ImportHeader): void {
  const segs = importCacheSegments(key);
  if (segs === null) return;
  const dir = join(ctx.dir, ...segs);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    writeAtomic({ dir, target: join(dir, 'header.json'), bytes: new TextEncoder().encode(`${JSON.stringify(header)}\n`), allowedPreHashes: [], previousHash: null, ops: rebuildable(core).ops });
  } catch {
    // a cache: a failed write is only a later re-inspection
  }
}

export function readHeader(ctx: ContentContext, key: ImportKey): ImportHeader | null {
  const segs = importCacheSegments(key);
  if (segs === null) return null;
  const r = readBlobBytes(join(ctx.dir, ...segs, 'header.json'));
  if (!r.ok) return null;
  try {
    const h = JSON.parse(new TextDecoder().decode(r.bytes)) as ImportHeader;
    if (h.sourceDigest !== key.sourceDigest || typeof h.kind !== 'string' || typeof h.sourceByteLength !== 'number') return null;
    return h;
  } catch {
    return null;
  }
}

// ---- file names -------------------------------------------------------------

/** A file name stem from an asset's name (letters, digits, `-`, `_`, `.`, spaces as `-`). */
export function fileStem(name: string, fallback: string): string {
  const s = name
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 96);
  return s.length > 0 ? s : fallback;
}

/** The file extension for bytes of a kind and format. */
export function extensionFor(kind: string, metrics: unknown, convertedFormat?: string): string {
  if (convertedFormat !== undefined) return convertedFormat === 'jpeg' ? 'jpg' : convertedFormat;
  const format = typeof metrics === 'object' && metrics !== null ? (metrics as { format?: unknown }).format : undefined;
  if (kind === 'model') return 'glb';
  if (kind === 'audio') return format === 'ogg-vorbis' ? 'ogg' : format === 'ogg-opus' ? 'opus' : typeof format === 'string' ? format : 'wav';
  if (kind === 'texture') return format === 'jpeg' ? 'jpg' : typeof format === 'string' ? format : 'png';
  if (kind === 'font') return typeof format === 'string' ? format : 'ttf';
  return 'bin';
}

/**
 * A free path `<folder>/<stem>.<ext>` (then `<stem>-2.<ext>`, …): no file is
 * there and no other asset names it (compared without case, so the project
 * moves between case-sensitive and case-insensitive disks).
 */
export function allocateAssetPath(ctx: ContentContext, taken: ReadonlySet<string>, folder: string, stem: string, ext: string): string {
  for (let n = 1; ; n += 1) {
    const rel = `${folder}/${n === 1 ? stem : `${stem}-${n}`}.${ext}`;
    if (taken.has(rel.toLowerCase())) continue;
    let present = false;
    try {
      lstatSync(join(assetRoot(ctx), ...rel.split('/')));
      present = true;
    } catch {
      present = false;
    }
    if (!present) return rel;
  }
}

/** Every game-folder path the catalog's assets name (lowercase), and their sidecars'. */
export function takenPaths(content: ContentCatalogV4 | null): Set<string> {
  const out = new Set<string>();
  for (const a of (content?.assets ?? []) as unknown as RecordLike[]) {
    for (const v of a.versions) {
      const f = fileOfVersion(v);
      if (f !== null) out.add(f.toLowerCase());
    }
  }
  return out;
}

// ---- keeping the game folder in step with the catalog ------------------------

/** One asset record a change replaced (null: none before / none after); `removed`: a delete, which takes the file too. */
export interface AssetRecordChange {
  previous: RecordLike | null;
  next: RecordLike | null;
  removed: boolean;
}

/** The asset records a change replaced (empty when the change is not about assets). */
export function assetChangesOf(change: ChangeData): AssetRecordChange[] {
  const c = change as unknown as { type: string; previous?: RecordLike | null; next?: RecordLike | null; added?: RecordLike[]; removed?: RecordLike[] };
  if (c.type === 'publishAsset' || c.type === 'setAssetOptions') return [{ previous: c.previous ?? null, next: c.next ?? null, removed: false }];
  if (c.type === 'removeAsset') return [{ previous: c.previous ?? null, next: null, removed: true }];
  // A folder import (and its undo, which only forgets the assets: their files stay).
  if (c.type === 'importAssets') {
    return [...(c.removed ?? []).map((r) => ({ previous: r, next: null, removed: false })), ...(c.added ?? []).map((r) => ({ previous: null, next: r, removed: false }))];
  }
  return [];
}

function sidecarAt(ctx: ContentContext, file: string): SidecarDoc | null {
  const b = readGameFile(ctx, sidecarPath(file));
  return b === null ? null : parseSidecar(b);
}

/**
 * After a committed command: bring the game folder in step with what the
 * change did to an asset record.
 *
 * - a delete (`removeAsset`, also its redo) takes the file out (its bytes are
 *   held, so an undo puts it back) unless another asset still names it;
 * - an undone import only forgets the asset: the file stays;
 * - a record naming another path (a move, or a re-import from another file):
 *   a file still at the old path moves;
 * - the file must have the recorded bytes: if it does not and the held bytes
 *   do (an undone replace or delete), they are written back.
 *
 * The sidecars are not written here: they hold the records, and the
 * command's own transaction writes and removes them with the project files.
 *
 * Returns the problems found (never fatal: the command is committed; the
 * next file check repairs sidecars).
 */
export function syncAssetFiles(core: Core, ctx: ContentContext, change: ChangeData, contentAfter: ContentCatalogV4 | null): string[] {
  const changes = assetChangesOf(change);
  if (changes.length === 0) return [];
  const problems: string[] = [];
  const named = takenPaths(contentAfter);
  for (const c of changes) syncOne(core, ctx, c, named, problems);
  return problems;
}

function syncOne(core: Core, ctx: ContentContext, c: AssetRecordChange, named: ReadonlySet<string>, problems: string[]): string[] {
  const prevFile = c.previous === null ? null : fileOfRecord(c.previous);
  const nextFile = c.next === null ? null : fileOfRecord(c.next);
  const stillNamed = (file: string): boolean => named.has(file.toLowerCase());
  if (c.next === null) {
    if (c.previous === null || prevFile === null) return problems;
    if (c.removed && !stillNamed(prevFile)) {
      const bytes = readGameFile(ctx, prevFile);
      if (bytes !== null) {
        const held = holdBytes(core, ctx, bytes);
        if (held.ok) removeGameFile(ctx, prevFile);
        else problems.push(`${prevFile} was kept: its bytes could not be held for undo (${held.error.message})`);
      }
    }
    return problems;
  }
  if (nextFile === null) return problems;
  if (prevFile !== null && prevFile !== nextFile && c.previous !== null) {
    if (gameFileExists(ctx, prevFile) && !gameFileExists(ctx, nextFile) && !stillNamed(prevFile)) {
      if (!moveGameFile(ctx, prevFile, nextFile)) problems.push(`${prevFile} could not be moved to ${nextFile}`);
    }
  }
  const v = currentVersionOf(c.next);
  if (v !== undefined) {
    const want = fileFactsOfVersion(v);
    const have = readGameFile(ctx, nextFile);
    if (have === null || sha256Hex(have) !== want.digest) {
      const held = readHeld(ctx, want.digest);
      if (held !== null) {
        if (have !== null) holdBytes(core, ctx, have);
        const w = writeGameFile(core, ctx, nextFile, held);
        if (!w.ok) problems.push(`${nextFile} could not be restored: ${w.error.message}`);
      }
    }
  }
  return problems;
}

// ---- finding sidecars ---------------------------------------------------------

/** Folders never searched for sidecars (process state, version control, dependencies). */
const SKIP_DIRS = new Set(['.git', '.thirdlight', 'node_modules']);

/**
 * Every sidecar in the game folder, by asset id (a file moved outside the
 * editor is found by its sidecar). Only sidecars whose file is there count.
 * The project's own files are not searched.
 */
export function findSidecars(ctx: ContentContext, wanted?: ReadonlySet<string>): Map<string, string> {
  const root = assetRoot(ctx);
  const out = new Map<string, string>();
  let projectReal: string | null = null;
  try {
    projectReal = ctx.gameFolder != null ? realpathSync(ctx.dir) : null;
  } catch {
    projectReal = null;
  }
  const walk = (abs: string, rel: string, depth: number): void => {
    if (depth > 32) return;
    let names: string[];
    try {
      names = readdirSync(abs);
    } catch {
      return;
    }
    for (const name of names) {
      if (SKIP_DIRS.has(name)) continue;
      const childRel = rel === '' ? name : `${rel}/${name}`;
      if (rel === '' && ctx.gameFolder == null && PROJECT_OWN_ENTRIES.has(name)) continue;
      const childAbs = join(abs, name);
      let st;
      try {
        st = lstatSync(childAbs);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (projectReal !== null && childAbs === ctx.dir) continue;
        walk(childAbs, childRel, depth + 1);
        continue;
      }
      if (!st.isFile() || !name.endsWith(SIDECAR_SUFFIX)) continue;
      const file = fileOfSidecar(childRel);
      if (file === null || !isValidSourcePath(file)) continue;
      const doc = sidecarAt(ctx, file);
      if (doc === null || (wanted !== undefined && !wanted.has(doc.id))) continue;
      if (!gameFileExists(ctx, file)) continue;
      if (!out.has(doc.id)) out.set(doc.id, file);
    }
  };
  walk(root, '', 0);
  return out;
}

// ---- filing uploaded bytes into the game folder -------------------------------

/** Where a publish's bytes go and how to take them back if the command fails after they were written. */
export interface Placement {
  /** The command's args with the path the workspace chose. */
  readonly args: Record<string, unknown>;
  /** Write the file (after the command's own checks passed); an error refuses the command. */
  write(): CommandError | null;
  /** Undo `write` (the command failed later): the previous bytes back, or the new file removed. */
  rollback(): void;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * A `publishAsset` of bytes uploaded to the backend names no file: they are
 * held by digest (`holdBytes`) and filed into the game folder here, at
 * `<folder>/<name>.<ext>` (the folder the user dropped them in, `assets` when
 * none is named; `checkAssetFolder` vets it first), or over the asset's own
 * file when a re-import names no folder and has the same kind of file. The chosen path goes into the command's args, so
 * the change, the history and the retry record all carry it. A converted
 * version (FBX, or a PNG/JPEG encoded to KTX2) files its original; a packed
 * texture files its KTX2. Null: nothing to file (a file already in the game
 * folder, or args the command itself refuses).
 */
export function planPlacement(core: Core, ctx: ContentContext, args: Record<string, unknown>, content: ContentCatalogV4 | null, readLegacyBlob: (digest: string) => Uint8Array | null, folder?: string): Placement | null {
  const conv = isRecord(args['convertedFrom']) ? (args['convertedFrom'] as unknown as ConvertedLike) : undefined;
  if (conv !== undefined ? conv.sourcePath !== undefined : args['sourcePath'] !== undefined) return null;
  const fileDigest = conv !== undefined ? conv.sourceDigest : args['sourceDigest'];
  if (typeof fileDigest !== 'string' || !DIGEST_RE.test(fileDigest) || typeof args['assetId'] !== 'string') return null;
  const bytes = readHeld(ctx, fileDigest) ?? readLegacyBlob(fileDigest);
  if (bytes === null) return null;
  const assetId = args['assetId'];
  const existing = assetRecordOf((content?.assets ?? []) as unknown as RecordLike[], assetId) ?? null;
  const kind = typeof args['kind'] === 'string' ? args['kind'] : (existing?.kind ?? 'model');
  const ext = extensionFor(kind, args['metrics'], conv?.format);
  const existingFile = existing !== null ? fileOfRecord(existing) : null;
  const name = typeof args['displayName'] === 'string' ? args['displayName'] : (existing?.displayName ?? assetId);
  const rel =
    folder === undefined && args['mode'] === 'reimport' && existingFile !== null && existingFile.toLowerCase().endsWith(`.${ext}`)
      ? existingFile
      : allocateAssetPath(ctx, takenPaths(content), folder ?? DEFAULT_ASSET_FOLDER, fileStem(name, assetId), ext);
  const placed = conv !== undefined ? { ...args, convertedFrom: { ...conv, sourcePath: rel } } : { ...args, sourcePath: rel };
  let previous: Uint8Array | null = null;
  let wrote = false;
  return {
    args: placed,
    write() {
      previous = readGameFile(ctx, rel);
      if (previous !== null && sha256Hex(previous) === fileDigest) return null;
      if (previous !== null) {
        const held = holdBytes(core, ctx, previous);
        if (!held.ok) return held.error;
      }
      const w = writeGameFile(core, ctx, rel, bytes);
      if (!w.ok) return w.error;
      wrote = true;
      return null;
    },
    rollback() {
      if (!wrote) return;
      if (previous !== null) writeGameFile(core, ctx, rel, previous);
      else removeGameFile(ctx, rel);
    },
  };
}
