/**
 * A streamed texture's KTX2 cut into its parts (project-model
 * `ktx2-levels.ts`): the head (metadata and mip tail) and one part per larger
 * level, each a file of its own in the import cache, keyed by the KTX2's
 * digest. A game page reads a part as it reads any file: at its digest URL,
 * verified against its digest, cached by the browser for good.
 *
 * Split files rather than HTTP range requests on the whole file: every part
 * is checked by the verified reader like any other file (a range of a file
 * has no digest of its own the page could check), the browser caches each
 * one under its own immutable URL, and an export plays from any static host
 * (some static servers answer a range request with the whole file). The
 * cost is disk: the cache holds the KTX2 twice, and an export ships the
 * parts instead of the whole file (never both).
 *
 * The cache is rebuilt when missing: the parts are cut the first time a
 * build asks for them and found by their list (`parts.json`) after that.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { planKtx2Parts, readKtx2Layout, TEXTURE_STREAM_TAIL_PX, type Ktx2Part } from '@thirdlight/project-model';

import { importCacheSegments, importedArtifactPath, rebuildable, writeImported, type ImportKey } from './asset-files';
import type { BlobFile } from './blob-files';
import { readBlobBytes, type ContentConfig, type ContentContext } from './content-store';
import { sha256Hex } from './digest';
import { writeAtomic, type WriteOps } from './write';

/** The importer name and version of the cut (a change to the cut changes the version). */
export const MIP_PARTS_IMPORTER = 'ktx2-parts';
export const MIP_PARTS_VERSION = '1';

/** One part: its file and where it lies in the whole KTX2. */
export interface MipPartFile {
  readonly digest: string;
  readonly byteLength: number;
  readonly offset: number;
  readonly levels: readonly number[];
  readonly file: BlobFile;
}

interface PartsList {
  readonly sourceDigest: string;
  /** Null: the file has nothing to stream (one level, or every level in the tail, or not laid out smallest-first). */
  readonly parts: readonly { digest: string; byteLength: number; offset: number; levels: number[] }[] | null;
}

function keyOf(ktx2Digest: string): ImportKey {
  return { sourceDigest: ktx2Digest, importer: MIP_PARTS_IMPORTER, importerVersion: MIP_PARTS_VERSION, settings: { tailPx: TEXTURE_STREAM_TAIL_PX } };
}

function readList(ctx: ContentContext, key: ImportKey): PartsList | null {
  const segs = importCacheSegments(key);
  if (segs === null) return null;
  const r = readBlobBytes(join(ctx.dir, ...segs, 'parts.json'));
  if (!r.ok) return null;
  try {
    const list = JSON.parse(new TextDecoder().decode(r.bytes)) as PartsList;
    if (list.sourceDigest !== key.sourceDigest || (list.parts !== null && !Array.isArray(list.parts))) return null;
    return list;
  } catch {
    return null;
  }
}

function filesOf(ctx: ContentContext, key: ImportKey, list: PartsList): MipPartFile[] | null {
  if (list.parts === null) return null;
  const out: MipPartFile[] = [];
  for (const p of list.parts) {
    const real = importedArtifactPath(ctx, key, p.digest);
    if (real === null) return null;
    const found = ctx.stamps?.digestOf(real) ?? null;
    if (found === null || found.digest !== p.digest || found.stamp.size !== p.byteLength) return null;
    out.push({ digest: p.digest, byteLength: p.byteLength, offset: p.offset, levels: [...p.levels], file: { digest: p.digest, byteLength: p.byteLength, real } });
  }
  return out;
}

/**
 * The parts of the KTX2 at `whole` (a located, verified file), cut and
 * cached the first time. `{ parts: null }`: nothing to stream (the texture
 * ships whole). An error only when the cache cannot be written; the file's
 * bytes changing under it reads as "cannot be cut" and ships whole too.
 */
export function locateMipParts(core: { ops: WriteOps; content: ContentConfig }, ctx: ContentContext, whole: BlobFile): { ok: true; parts: MipPartFile[] | null } | { ok: false; message: string } {
  const key = keyOf(whole.digest);
  const cached = readList(ctx, key);
  if (cached !== null) {
    if (cached.parts === null) return { ok: true, parts: null };
    const files = filesOf(ctx, key, cached);
    if (files !== null) return { ok: true, parts: files };
  }
  const read = readBlobBytes(whole.real);
  if (!read.ok || read.bytes.length !== whole.byteLength || sha256Hex(read.bytes) !== whole.digest) return { ok: true, parts: null };
  const bytes = read.bytes;
  const layout = readKtx2Layout(bytes);
  const plan: Ktx2Part[] | null = layout.ok ? planKtx2Parts(layout.layout, bytes.length, TEXTURE_STREAM_TAIL_PX) : null;
  const fast = rebuildable(core);
  const list: PartsList = { sourceDigest: whole.digest, parts: plan === null ? null : [] };
  if (plan !== null) {
    for (const p of plan) {
      const w = writeImported(fast, ctx, key, bytes.subarray(p.offset, p.offset + p.length));
      if (!w.ok) return { ok: false, message: w.error.message };
      (list.parts as { digest: string; byteLength: number; offset: number; levels: number[] }[]).push({ digest: w.digest, byteLength: p.length, offset: p.offset, levels: [...p.levels] });
    }
  }
  const segs = importCacheSegments(key);
  if (segs === null) return { ok: false, message: 'the import cache key is malformed' };
  const dir = join(ctx.dir, ...segs);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o755 });
  } catch {
    return { ok: false, message: 'the import cache folder could not be made' };
  }
  const wr = writeAtomic({ dir, target: join(dir, 'parts.json'), bytes: new TextEncoder().encode(`${JSON.stringify(list)}\n`), allowedPreHashes: [], previousHash: null, ops: fast.ops });
  if (!wr.ok) return { ok: false, message: 'the parts list could not be written to the import cache' };
  if (list.parts === null) return { ok: true, parts: null };
  const files = filesOf(ctx, key, list);
  return files === null ? { ok: false, message: 'the parts just cut are not in the import cache' } : { ok: true, parts: files };
}
