/**
 * Game saves, format v1 DRAFT: only the chunks a player changed, each
 * relative to the shipped world, with a content hash of the shipped chunk it
 * was made against.
 *
 * - **Edits only.** A chunk the player never changed (or changed back) has
 *   no entry; generated or shipped chunks are never copied into a save.
 * - **Per chunk, the smaller of two forms:** the cells that differ from the
 *   base (a cell delta, 7 bytes a cell) or the chunk's whole canonical codec
 *   bytes (an image); an all-air or one-voxel chunk is a few bytes.
 * - **Base hash.** Each entry carries the first 16 bytes of the SHA-256 of
 *   the base chunk's canonical codec bytes (all air: of no bytes). It covers
 *   the content, not the region file's compressed frame, so recompressing a
 *   world (another zstd build or level) does not look like a changed world.
 *   When a re-export changes a chunk the save also changed, loading reports
 *   the mismatch and the game chooses per chunk: keep its save or take the
 *   new base.
 * - **Versions.** An unknown (newer) version is refused. Upgrades only add
 *   steps: each later version adds a step that lifts a decoded save of the
 *   version before it; old readers are kept.
 *
 * Bytes, version 1 (little-endian): a 40-byte header ('T' 'L' 'V' 'S', u8
 * version, u8 chunk edge, u8 chunk codec version, u8 compressor (0 none,
 * 1 zstd), 16-byte world id, u32 entry count, u32 body length, u32 CRC-32
 * of the body as stored, u32 CRC-32 of the 36 bytes before it), then the
 * body (compressed as one stream when a compressor is named: a save is read
 * whole). Body: per entry, ascending by grid id then chunk key: u32 grid,
 * i16 cx, i16 cy, i16 cz, 16-byte base hash, u8 kind (0 delta, 1 image,
 * 2 uniform, 3 air), u32 payload length, the payload (delta bytes, codec
 * bytes, a u32 record value, nothing). Equal saves give equal bytes.
 */
import { crc32, sha256Hex } from '@thirdlight/shared';
import { CellDelta, chunkScratch, decodeDenseChunk, diffDense, encodeDenseChunk } from './cell-delta';
import { chunkKey, type ChunkGrid } from './coords';
import type { DenseChunk } from './dense-chunk';
import { PALETTE_CODEC_VERSION, readPaletteHeader } from './palette-codec';
import { packRegionChunk, regionChunkCodecBytes, WORLD_ID_BYTES, type RegionCompressor } from './region-file';
import type { VoxelStoreCandidate } from './store';

/** The save format this build writes; reads it and every older version its steps lift. */
export const SAVE_FORMAT_VERSION = 1;

/** Bytes of a base chunk hash. */
export const BASE_HASH_BYTES = 16;

export const SAVE_HEADER_BYTES = 40;

/** Bytes of one entry's header in the body. */
export const SAVE_ENTRY_HEADER_BYTES = 31;

const MAGIC = [0x54, 0x4c, 0x56, 0x53] as const;
const COMPRESSORS: readonly RegionCompressor[] = ['none', 'zstd'];
const KINDS = ['delta', 'image', 'uniform', 'air'] as const;

/** What a save holds for one chunk: what the chunk is now. */
export type SaveContent =
  | { readonly kind: 'delta'; readonly delta: CellDelta }
  | { readonly kind: 'image'; readonly bytes: Uint8Array }
  | { readonly kind: 'uniform'; readonly value: number }
  | { readonly kind: 'air' };

export interface SaveChunk {
  readonly grid: number;
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  /** Hash of the base chunk this entry was made against ({@link baseChunkHash}). */
  readonly base: Uint8Array;
  readonly content: SaveContent;
}

export interface SaveFile {
  readonly worldId: Uint8Array;
  readonly grid: ChunkGrid;
  readonly chunks: readonly SaveChunk[];
}

/** A save the format refuses (nothing of it is applied). */
export class SaveFileError extends Error {
  override readonly name = 'SaveFileError';
}

/** Lifts a decoded save of version n to n + 1 (`SAVE_UPGRADES[n - 1]`). */
export type SaveUpgradeStep = (save: SaveFile) => SaveFile;

/** The upgrade steps, oldest first; only ever appended to. Version 1 has none. */
export const SAVE_UPGRADES: readonly SaveUpgradeStep[] = Object.freeze([]);

function hexBytes(hex: string, n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** The base hash of a chunk's canonical codec bytes (null: the chunk is all air). */
export function baseChunkHash(codecBytes: Uint8Array | null): Uint8Array {
  return hexBytes(sha256Hex(codecBytes ?? new Uint8Array(0)), BASE_HASH_BYTES);
}

export function sameHash(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * A chunk's save content against its base (null: it equals the base, so the
 * save holds nothing for it): the smaller of its delta and its image.
 */
export function saveContentOf(grid: ChunkGrid, base: DenseChunk, now: DenseChunk): SaveContent | null {
  const delta = diffDense(grid, base, now);
  if (delta.count === 0) return null;
  const image = encodeDenseChunk(grid, now);
  if (image === null) return { kind: 'air' };
  const e = packRegionChunk(grid, 0, 0, 0, image, 'none', (b) => b);
  if ('uniform' in e) return { kind: 'uniform', value: e.uniform };
  if (delta.byteLength < image.length) {
    const d = new CellDelta(delta.count);
    d.cells.set(delta.cells.subarray(0, delta.count));
    d.values.set(delta.values.subarray(0, delta.count));
    d.shapes.set(delta.shapes.subarray(0, delta.count));
    d.count = delta.count;
    return { kind: 'delta', delta: d };
  }
  return { kind: 'image', bytes: image };
}

/** Bytes an entry's payload takes in the body. */
function payloadOf(c: SaveContent): Uint8Array {
  switch (c.kind) {
    case 'delta':
      return c.delta.encode();
    case 'image':
      return c.bytes;
    case 'uniform': {
      const b = new Uint8Array(4);
      new DataView(b.buffer).setUint32(0, c.value, true);
      return b;
    }
    case 'air':
      return new Uint8Array(0);
  }
}

function entryOrder(grid: ChunkGrid, a: SaveChunk, b: SaveChunk): number {
  return a.grid - b.grid || chunkKey(grid, a.cx, a.cy, a.cz) - chunkKey(grid, b.cx, b.cy, b.cz);
}

/** The save's bytes (entries in any order; a chunk given twice is refused). */
export function writeSave(save: SaveFile, compressor: RegionCompressor, compress: (b: Uint8Array) => Uint8Array): Uint8Array {
  if (save.worldId.length !== WORLD_ID_BYTES) throw new RangeError(`a world id is ${WORLD_ID_BYTES} bytes`);
  const list = [...save.chunks].sort((a, b) => entryOrder(save.grid, a, b));
  const payloads = list.map((c) => payloadOf(c.content));
  let n = 0;
  for (const p of payloads) n += SAVE_ENTRY_HEADER_BYTES + p.length;
  const body = new Uint8Array(n);
  const view = new DataView(body.buffer);
  let at = 0;
  list.forEach((c, k) => {
    if (k > 0 && entryOrder(save.grid, list[k - 1]!, c) === 0) throw new RangeError(`chunk (${c.cx}, ${c.cy}, ${c.cz}) of grid ${c.grid} given twice`);
    if (c.base.length !== BASE_HASH_BYTES) throw new RangeError(`a base hash is ${BASE_HASH_BYTES} bytes`);
    const p = payloads[k]!;
    view.setUint32(at, c.grid, true);
    view.setInt16(at + 4, c.cx, true);
    view.setInt16(at + 6, c.cy, true);
    view.setInt16(at + 8, c.cz, true);
    body.set(c.base, at + 10);
    body[at + 26] = KINDS.indexOf(c.content.kind);
    view.setUint32(at + 27, p.length, true);
    body.set(p, at + SAVE_ENTRY_HEADER_BYTES);
    at += SAVE_ENTRY_HEADER_BYTES + p.length;
  });
  const stored = compressor === 'none' ? body : compress(body);
  const out = new Uint8Array(SAVE_HEADER_BYTES + stored.length);
  const hv = new DataView(out.buffer);
  MAGIC.forEach((b, i) => (out[i] = b));
  out[4] = SAVE_FORMAT_VERSION;
  out[5] = save.grid.edge;
  out[6] = PALETTE_CODEC_VERSION;
  out[7] = COMPRESSORS.indexOf(compressor);
  out.set(save.worldId, 8);
  hv.setUint32(24, list.length, true);
  hv.setUint32(28, stored.length, true);
  hv.setUint32(32, crc32(stored), true);
  hv.setUint32(36, crc32(out.subarray(0, 36)), true);
  out.set(stored, SAVE_HEADER_BYTES);
  return out;
}

/** The version a save's bytes declare (header checked), without reading the body. */
export function readSaveVersion(bytes: Uint8Array): number {
  if (bytes.length < SAVE_HEADER_BYTES || !MAGIC.every((b, i) => bytes[i] === b)) throw new SaveFileError('save: not a voxel save');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (crc32(bytes.subarray(0, 36)) !== view.getUint32(36, true)) throw new SaveFileError('save: header checksum mismatch');
  return bytes[4]!;
}

/** Version 1's body reader. */
function readBodyV1(grid: ChunkGrid, body: Uint8Array, count: number): SaveChunk[] {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const out: SaveChunk[] = [];
  let at = 0;
  for (let k = 0; k < count; k++) {
    if (at + SAVE_ENTRY_HEADER_BYTES > body.length) throw new SaveFileError('save: truncated');
    const g = view.getUint32(at, true);
    const cx = view.getInt16(at + 4, true);
    const cy = view.getInt16(at + 6, true);
    const cz = view.getInt16(at + 8, true);
    const base = body.slice(at + 10, at + 26);
    const kind = KINDS[body[at + 26]!];
    const len = view.getUint32(at + 27, true);
    at += SAVE_ENTRY_HEADER_BYTES;
    if (at + len > body.length) throw new SaveFileError('save: truncated');
    const p = body.slice(at, at + len);
    at += len;
    let content: SaveContent;
    try {
      if (kind === 'delta') content = { kind, delta: CellDelta.decode(grid, p) };
      else if (kind === 'image') {
        const h = readPaletteHeader(grid, p);
        if (h.body === 'uniform') throw new RangeError('a uniform chunk saved as an image');
        content = { kind, bytes: p };
      } else if (kind === 'uniform' && len === 4) {
        const value = new DataView(p.buffer).getUint32(0, true);
        if (value === 0) throw new RangeError('an air chunk saved as uniform');
        content = { kind, value };
      } else if (kind === 'air' && len === 0) content = { kind };
      else throw new RangeError(`entry kind ${kind ?? 'unknown'} with ${len} payload bytes`);
    } catch (e) {
      throw new SaveFileError(`save: chunk (${cx}, ${cy}, ${cz}): ${e instanceof Error ? e.message : String(e)}`);
    }
    const c: SaveChunk = { grid: g, cx, cy, cz, base, content };
    if (out.length > 0 && entryOrder(grid, out[out.length - 1]!, c) >= 0) throw new SaveFileError('save: entries out of order or repeated');
    out.push(c);
  }
  if (at !== body.length) throw new SaveFileError('save: trailing bytes');
  return out;
}

/**
 * Reads a save of `grid`'s chunk edge: checks it, refuses a version newer
 * than this build (or `steps`) knows, and lifts an older one through the
 * upgrade steps. Throws {@link SaveFileError}; nothing partial comes back.
 */
export function readSave(bytes: Uint8Array, grid: ChunkGrid, decompress: (b: Uint8Array) => Uint8Array, steps: readonly SaveUpgradeStep[] = SAVE_UPGRADES): SaveFile {
  const version = readSaveVersion(bytes);
  const current = 1 + steps.length;
  if (version < 1 || version > current) throw new SaveFileError(`save: unknown version ${version} (this build reads 1 to ${current})`);
  if (bytes[5] !== grid.edge) throw new SaveFileError(`save: chunk edge ${bytes[5]}, expected ${grid.edge}`);
  if (bytes[6] !== PALETTE_CODEC_VERSION) throw new SaveFileError(`save: chunk codec version ${bytes[6]}`);
  const compressor = COMPRESSORS[bytes[7]!];
  if (compressor === undefined) throw new SaveFileError(`save: unknown compressor ${bytes[7]}`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(24, true);
  const stored = bytes.subarray(SAVE_HEADER_BYTES);
  if (stored.length !== view.getUint32(28, true)) throw new SaveFileError('save: body length differs from its header');
  if (crc32(stored) !== view.getUint32(32, true)) throw new SaveFileError('save: body checksum mismatch');
  let body: Uint8Array;
  try {
    body = compressor === 'none' ? stored : decompress(stored);
  } catch (e) {
    throw new SaveFileError(`save: body does not decompress: ${e instanceof Error ? e.message : String(e)}`);
  }
  let save: SaveFile = { worldId: bytes.slice(8, 24), grid, chunks: readBodyV1(grid, body, count) };
  for (let v = version; v < current; v++) save = steps[v - 1]!(save);
  return save;
}

/** A save entry whose base chunk is no longer the one it was made against. */
export interface BaseMismatch {
  readonly chunk: SaveChunk;
  /** Hash of the base chunk now. */
  readonly baseNow: Uint8Array;
}

/** What the game chose for a mismatched chunk: its saved chunk, or the new base (the entry is dropped). */
export type MismatchChoice = 'save' | 'base';

/** How a save went onto the loaded world. */
export interface SaveApplied {
  /** Entries applied (their chunks now hold the saved content). */
  readonly applied: number;
  /** Mismatched entries applied anyway because the game chose its save. */
  readonly keptOverNewBase: number;
  /** Mismatched entries dropped because the game chose the new base. */
  readonly tookBase: readonly SaveChunk[];
  readonly mismatches: readonly BaseMismatch[];
}

/**
 * Writes a save's chunks into the stores, which must hold the base world
 * for those chunks. `baseHash` gives the current base chunk's hash; an
 * entry whose hash differs is a mismatch, and `decide` (the game's choice)
 * says whether its save content is applied (a delta then lands on the new
 * base: the player's cells win, the rest is the new base) or dropped.
 */
export function applySave(
  save: SaveFile,
  store: (gridId: number) => VoxelStoreCandidate | undefined,
  baseHash: (c: SaveChunk) => Uint8Array,
  decide: (m: BaseMismatch) => MismatchChoice,
): SaveApplied {
  const mismatches: BaseMismatch[] = [];
  const tookBase: SaveChunk[] = [];
  let applied = 0;
  let kept = 0;
  for (const c of save.chunks) if (store(c.grid) === undefined) throw new SaveFileError(`save: grid ${c.grid} is not loaded`);
  for (const c of save.chunks) {
    const now = baseHash(c);
    if (!sameHash(now, c.base)) {
      const m: BaseMismatch = { chunk: c, baseNow: now };
      mismatches.push(m);
      if (decide(m) === 'base') {
        tookBase.push(c);
        continue;
      }
      kept++;
    }
    applySaveChunk(store(c.grid)!, c);
    applied++;
  }
  return { applied, keptOverNewBase: kept, tookBase, mismatches };
}

/** Writes one entry's content into its chunk. */
export function applySaveChunk(store: VoxelStoreCandidate, c: SaveChunk): void {
  const s = c.content;
  switch (s.kind) {
    case 'delta':
      s.delta.applyToStore(store, c.cx, c.cy, c.cz);
      break;
    case 'image':
      store.decodeChunk(c.cx, c.cy, c.cz, s.bytes);
      break;
    case 'uniform':
      store.decodeChunk(c.cx, c.cy, c.cz, regionChunkCodecBytes(store.grid, { cx: c.cx, cy: c.cy, cz: c.cz, kind: 'uniform', value: s.value }, (b) => b)!);
      break;
    case 'air':
      store.dropChunk(c.cx, c.cy, c.cz);
      break;
  }
}

/**
 * A save entry for one chunk from its base codec bytes (null: air) and its
 * cells now; null when they are equal (the save then holds nothing for it).
 */
export function saveChunkOf(grid: ChunkGrid, gridId: number, cx: number, cy: number, cz: number, baseBytes: Uint8Array | null, now: DenseChunk): SaveChunk | null {
  const base = decodeDenseChunk(grid, baseBytes, chunkScratch(grid).cells);
  const content = saveContentOf(grid, base, now);
  return content === null ? null : { grid: gridId, cx, cy, cz, base: baseChunkHash(baseBytes), content };
}
