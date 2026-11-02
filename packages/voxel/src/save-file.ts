/**
 * Game saves, format v2 DRAFT: only the chunks a player changed, each
 * relative to the shipped world, with a content hash of the shipped chunk it
 * was made against and the set of cells the player changed.
 *
 * - **Saved fields.** A runtime change is held in memory as whole voxel
 *   values (the overlay, voxel-overlay.ts); a save keeps only the fields
 *   the game marks saved ({@link DEFAULT_SAVED_FIELDS}: all but wetness),
 *   merged onto the base value (`savedValue`). A change of only unsaved
 *   fields leaves no entry.
 *
 * - **Edits only.** A chunk the player never changed (or changed back) has
 *   no entry; generated or shipped chunks are never copied into a save.
 * - **The changed cells, always.** Every entry says which cells the player
 *   changed: a cell delta lists them (6 bytes a cell), and the whole-chunk
 *   forms (an image, one voxel, all air) carry a changed-cell mask (a bit a
 *   cell) beside the chunk as it is now. The writer keeps the smaller of
 *   the delta and the whole form; either way a save made against an older
 *   base lands on a re-exported one cell by cell: the player's cells win,
 *   every other cell is the new base. The choice of form never changes
 *   what loading does.
 * - **Base hash.** Each entry carries the first 16 bytes of the SHA-256 of
 *   the base chunk's content in the base form: the chunk codec version 2
 *   canonical bytes of that content (all air: no bytes), whatever codec
 *   version the chunk is stored in. The base form is frozen: a later codec
 *   keeps a version 2 writer for hashing, so neither recompressing a world
 *   (another zstd build or level) nor a codec upgrade looks like a changed
 *   world. When a re-export changes a chunk the save also changed, loading
 *   reports the mismatch and the game chooses per chunk: keep the player's
 *   cells on the new base, or take the new base.
 * - **Values.** Voxel values are stored in the record value form the
 *   header names (record.ts): 2 is the u32 of material, role, shape and
 *   wetness.
 * - **Versions.** An unknown (newer) version is refused. Upgrades only add
 *   steps: each later version adds a step that lifts a decoded save of the
 *   version before it; old readers are kept.
 *
 * Bytes, version 2 (little-endian; version 1, the draft with 7-byte delta
 * cells and the 23/4/5 record, is not read): a 44-byte header ('T' 'L' 'V' 'S', u8
 * version, u8 chunk edge, u8 chunk codec version, u8 compressor (0 none,
 * 1 zstd), u8 record value form, 3 reserved zero bytes, 16-byte world id,
 * u32 entry count, u32 body length, u32 CRC-32 of the body as stored, u32
 * CRC-32 of the 40 bytes before it), then the body (compressed as one
 * stream when a compressor is named: a save is read whole). Body: per
 * entry, ascending by grid id then chunk key: u32 grid, i16 cx, i16 cy,
 * i16 cz, 16-byte base hash, u8 kind (0 delta, 1 image, 2 uniform, 3 air),
 * u32 payload length, the payload: delta bytes; or the changed-cell mask
 * (cells per chunk / 8 bytes, cell i is bit i mod 8 of byte i / 8) followed
 * by the codec bytes (image), a u32 record value (uniform) or nothing
 * (air). Equal saves give equal bytes.
 */
import { bytesToHex, crc32, hexToBytes, sha256Hex } from '@thirdlight/shared';
import { CellDelta, chunkScratch, decodeDenseChunk, denseValue, diffDense, encodeDenseChunk, writeDenseValue } from './cell-delta';
import { chunkKey, type ChunkGrid } from './coords';
import { createDenseChunk, type DenseChunk } from './dense-chunk';
import type { UpgradeStep } from './format-upgrade';
import { CHUNK_CODEC_UPGRADES, decodePaletteImage, encodePaletteImage, PALETTE_CODEC_VERSION, readPaletteHeader } from './palette-codec';
import type { ChunkImage } from './palette-image';
import { ALL_PLANES, checkRecordValue, checkValueForm, DEFAULT_SAVED_FIELDS, RECORD_VALUE_FORM, savedValue } from './record';
import { packRegionChunk, regionChunkCodecBytes, WORLD_ID_BYTES, type RegionCompressor } from './region-file';
import type { VoxelStoreCandidate } from './store';

/** The save format this build writes; reads it and every older version its steps lift. */
export const SAVE_FORMAT_VERSION = 2;

/** Bytes of a base chunk hash. */
export const BASE_HASH_BYTES = 16;

/**
 * The chunk codec version whose canonical bytes are the base form a base
 * hash covers. Frozen: it never moves with the codec.
 */
export const BASE_FORM_CODEC_VERSION = 2;

export const SAVE_HEADER_BYTES = 44;

/** Bytes of one entry's header in the body. */
export const SAVE_ENTRY_HEADER_BYTES = 31;

const MAGIC = [0x54, 0x4c, 0x56, 0x53] as const;
const COMPRESSORS: readonly RegionCompressor[] = ['none', 'zstd'];
const KINDS = ['delta', 'image', 'uniform', 'air'] as const;

/** The kinds of save content, in the order the kind byte numbers them. */
export type SaveContentKind = (typeof KINDS)[number];

/**
 * What a save holds for one chunk: the cells the player changed, with their
 * values now (a delta), or the whole chunk now with a mask of the cells the
 * player changed.
 */
export type SaveContent =
  | { readonly kind: 'delta'; readonly delta: CellDelta }
  | { readonly kind: 'image'; readonly bytes: Uint8Array; readonly mask: Uint8Array }
  | { readonly kind: 'uniform'; readonly value: number; readonly mask: Uint8Array }
  | { readonly kind: 'air'; readonly mask: Uint8Array };

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

/** The oldest save version this build reads (version 1 was a draft that was never approved). */
export const SAVE_FIRST_VERSION = 2;

/** Lifts a decoded save of version n to n + 1 (`SAVE_UPGRADES[n - SAVE_FIRST_VERSION]`). */
export type SaveUpgradeStep = (save: SaveFile) => SaveFile;

/** The upgrade steps, oldest first; only ever appended to. Version 2 has none. */
export const SAVE_UPGRADES: readonly SaveUpgradeStep[] = Object.freeze([]);

const hashOf = (bytes: Uint8Array): Uint8Array => hexToBytes(sha256Hex(bytes)).slice(0, BASE_HASH_BYTES);

/**
 * A chunk's bytes in the base form: the codec version 2 canonical bytes of
 * its content. While the codec is version 2 its writer is that form; a
 * later codec keeps a copy of the version 2 writer here.
 */
function encodeBaseForm(img: ChunkImage): Uint8Array {
  return encodePaletteImage(img);
}

/** The base hash of a chunk's content (null: all air), whatever bytes it came from. */
export function baseContentHash(img: ChunkImage | null): Uint8Array {
  return hashOf(img === null ? new Uint8Array(0) : encodeBaseForm(img));
}

/**
 * The base hash of a chunk from its codec bytes of any version this build
 * reads (null: all air). Bytes already in the base form are hashed as they
 * are (a world decoder accepts only canonical bytes, so they are the one
 * byte string of their content); any other version is decoded and written
 * in the base form first.
 */
export function baseChunkHash(grid: ChunkGrid, codecBytes: Uint8Array | null, upgrades: readonly UpgradeStep<Uint8Array>[] = CHUNK_CODEC_UPGRADES): Uint8Array {
  if (codecBytes === null) return baseContentHash(null);
  if (codecBytes.length > 2 && codecBytes[2] === BASE_FORM_CODEC_VERSION) return hashOf(codecBytes);
  const img = chunkScratch(grid).image;
  decodePaletteImage(codecBytes, img, upgrades);
  return baseContentHash(img);
}

export function sameHash(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Bytes of a changed-cell mask of `grid`'s chunks: a bit a cell. */
export function changedMaskBytes(grid: ChunkGrid): number {
  return grid.cellsPerChunk >>> 3;
}

function maskOf(grid: ChunkGrid, d: CellDelta): Uint8Array {
  const m = new Uint8Array(changedMaskBytes(grid));
  for (let k = 0; k < d.count; k++) {
    const i = d.cells[k]!;
    m[i >>> 3]! |= 1 << (i & 7);
  }
  return m;
}

function trimmed(d: CellDelta): CellDelta {
  const t = new CellDelta(d.count);
  t.cells.set(d.cells.subarray(0, d.count));
  t.values.set(d.values.subarray(0, d.count));
  t.count = d.count;
  return t;
}

/**
 * A chunk's save content against its base (null: it equals the base, so the
 * save holds nothing for it): its changed cells as a delta, or the whole
 * chunk now with their mask, whichever payload is smaller (the delta on a
 * tie).
 */
export function saveContentOf(grid: ChunkGrid, base: DenseChunk, now: DenseChunk): SaveContent | null {
  const delta = diffDense(grid, base, now);
  if (delta.count === 0) return null;
  const maskBytes = changedMaskBytes(grid);
  const image = encodeDenseChunk(grid, now);
  let wholeBytes = maskBytes;
  let uniform: number | null = null;
  if (image !== null) {
    const e = packRegionChunk(grid, 0, 0, 0, image, 'none', (b) => b);
    if ('uniform' in e) {
      uniform = e.uniform;
      wholeBytes += 4;
    } else wholeBytes += image.length;
  }
  if (delta.byteLength <= wholeBytes) return { kind: 'delta', delta: trimmed(delta) };
  const mask = maskOf(grid, delta);
  if (image === null) return { kind: 'air', mask };
  if (uniform !== null) return { kind: 'uniform', value: uniform, mask };
  return { kind: 'image', bytes: image.slice(), mask };
}

/** An entry's payload bytes in the body (and on the worker wire). */
export function savePayloadOf(c: SaveContent): Uint8Array {
  switch (c.kind) {
    case 'delta':
      return c.delta.encode();
    case 'image': {
      const b = new Uint8Array(c.mask.length + c.bytes.length);
      b.set(c.mask);
      b.set(c.bytes, c.mask.length);
      return b;
    }
    case 'uniform': {
      const b = new Uint8Array(c.mask.length + 4);
      b.set(c.mask);
      new DataView(b.buffer).setUint32(c.mask.length, c.value, true);
      return b;
    }
    case 'air':
      return c.mask.slice();
  }
}

/** Throws unless `p` starts with a changed-cell mask of `grid` naming at least one cell. */
function readMask(grid: ChunkGrid, p: Uint8Array): Uint8Array {
  const n = changedMaskBytes(grid);
  if (p.length < n) throw new RangeError(`a changed-cell mask is ${n} bytes, the payload ${p.length}`);
  const m = p.slice(0, n);
  if (m.every((b) => b === 0)) throw new RangeError('a whole-chunk entry that names no changed cell');
  return m;
}

/**
 * Save content from its kind and payload bytes ({@link savePayloadOf}),
 * checked: a delta's cells and values, a mask naming at least one cell, an
 * image that is a world chunk and not one voxel, a uniform value the format
 * holds. Throws a RangeError naming what is wrong.
 */
export function saveContentFromPayload(grid: ChunkGrid, kind: SaveContentKind | undefined, p: Uint8Array): SaveContent {
  if (kind === 'delta') return { kind, delta: CellDelta.decode(grid, p) };
  if (kind === undefined) throw new RangeError('entry of an unknown kind');
  const mask = readMask(grid, p);
  const rest = p.subarray(mask.length);
  if (kind === 'image') {
    const bytes = rest.slice();
    if (readPaletteHeader(grid, bytes).body === 'uniform') throw new RangeError('a uniform chunk saved as an image');
    return { kind, bytes, mask };
  }
  if (kind === 'uniform' && rest.length === 4) {
    const value = new DataView(rest.buffer, rest.byteOffset, 4).getUint32(0, true);
    if (value === 0) throw new RangeError('an air chunk saved as uniform');
    checkRecordValue(value, 'save uniform entry');
    return { kind, value, mask };
  }
  if (kind === 'air' && rest.length === 0) return { kind, mask };
  throw new RangeError(`entry kind ${kind} with ${p.length} payload bytes`);
}

function entryOrder(grid: ChunkGrid, a: SaveChunk, b: SaveChunk): number {
  return a.grid - b.grid || chunkKey(grid, a.cx, a.cy, a.cz) - chunkKey(grid, b.cx, b.cy, b.cz);
}

/** The save's bytes (entries in any order; a chunk given twice is refused). */
export function writeSave(save: SaveFile, compressor: RegionCompressor, compress: (b: Uint8Array) => Uint8Array): Uint8Array {
  if (save.worldId.length !== WORLD_ID_BYTES) throw new RangeError(`a world id is ${WORLD_ID_BYTES} bytes`);
  const list = [...save.chunks].sort((a, b) => entryOrder(save.grid, a, b));
  const payloads = list.map((c) => savePayloadOf(c.content));
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
  out[8] = RECORD_VALUE_FORM;
  out.set(save.worldId, 12);
  hv.setUint32(28, list.length, true);
  hv.setUint32(32, stored.length, true);
  hv.setUint32(36, crc32(stored), true);
  hv.setUint32(40, crc32(out.subarray(0, 40)), true);
  out.set(stored, SAVE_HEADER_BYTES);
  return out;
}

/** The version a save's bytes declare (header checked), without reading the body. */
export function readSaveVersion(bytes: Uint8Array): number {
  if (bytes.length < SAVE_HEADER_BYTES || !MAGIC.every((b, i) => bytes[i] === b)) throw new SaveFileError('save: not a voxel save');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (crc32(bytes.subarray(0, 40)) !== view.getUint32(40, true)) throw new SaveFileError('save: header checksum mismatch');
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
      content = saveContentFromPayload(grid, kind, p);
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

/** Throws unless a save was made for the world `worldId` names: another world's save is never applied. */
function checkWorld(save: Pick<SaveFile, 'worldId'>, worldId: Uint8Array): void {
  if (!sameHash(save.worldId, worldId)) throw new SaveFileError(`save: made for world ${bytesToHex(save.worldId)}, this world is ${bytesToHex(worldId)}`);
}

/**
 * Reads a save of the world `worldId` at `grid`'s chunk edge: checks it,
 * refuses another world's save, a version newer than this build (or
 * `steps`) knows, and lifts an older one through the upgrade steps. Throws
 * {@link SaveFileError}; nothing partial comes back.
 */
export function readSave(bytes: Uint8Array, grid: ChunkGrid, worldId: Uint8Array, decompress: (b: Uint8Array) => Uint8Array, steps: readonly SaveUpgradeStep[] = SAVE_UPGRADES): SaveFile {
  const version = readSaveVersion(bytes);
  const current = SAVE_FIRST_VERSION + steps.length;
  if (version < SAVE_FIRST_VERSION || version > current) throw new SaveFileError(`save: unknown version ${version} (this build reads ${SAVE_FIRST_VERSION} to ${current})`);
  checkWorld({ worldId: bytes.subarray(12, 28) }, worldId);
  if (bytes[5] !== grid.edge) throw new SaveFileError(`save: chunk edge ${bytes[5]}, expected ${grid.edge}`);
  // Chunk images of an older codec version are lifted when they are decoded; a newer one is refused.
  if (bytes[6]! < 1 || bytes[6]! > PALETTE_CODEC_VERSION) throw new SaveFileError(`save: chunk codec version ${bytes[6]} (this build reads 1 to ${PALETTE_CODEC_VERSION})`);
  const compressor = COMPRESSORS[bytes[7]!];
  if (compressor === undefined) throw new SaveFileError(`save: unknown compressor ${bytes[7]}`);
  try {
    checkValueForm('save', bytes[8]!);
  } catch (e) {
    throw new SaveFileError((e as Error).message);
  }
  if (bytes[9] !== 0 || bytes[10] !== 0 || bytes[11] !== 0) throw new SaveFileError('save: reserved bytes set');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(28, true);
  const stored = bytes.subarray(SAVE_HEADER_BYTES);
  if (stored.length !== view.getUint32(32, true)) throw new SaveFileError('save: body length differs from its header');
  if (crc32(stored) !== view.getUint32(36, true)) throw new SaveFileError('save: body checksum mismatch');
  let body: Uint8Array;
  try {
    body = compressor === 'none' ? stored : decompress(stored);
  } catch (e) {
    throw new SaveFileError(`save: body does not decompress: ${e instanceof Error ? e.message : String(e)}`);
  }
  let save: SaveFile = { worldId: bytes.slice(12, 28), grid, chunks: readBodyV1(grid, body, count) };
  for (let v = version; v < current; v++) save = steps[v - SAVE_FIRST_VERSION]!(save);
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
 * `worldId` names for those chunks (another world's save is refused before
 * anything is written). `baseHash` gives the current base chunk's hash; an
 * entry whose hash differs is a mismatch, and `decide` (the game's choice)
 * says whether the player's cells land on the new base (every other cell
 * stays the new base) or the entry is dropped.
 */
export function applySave(
  save: SaveFile,
  worldId: Uint8Array,
  store: (gridId: number) => VoxelStoreCandidate | undefined,
  baseHash: (c: SaveChunk) => Uint8Array,
  decide: (m: BaseMismatch) => MismatchChoice,
): SaveApplied {
  checkWorld(save, worldId);
  const mismatches: BaseMismatch[] = [];
  const tookBase: SaveChunk[] = [];
  let applied = 0;
  let kept = 0;
  for (const c of save.chunks) if (store(c.grid) === undefined) throw new SaveFileError(`save: grid ${c.grid} is not loaded`);
  for (const c of save.chunks) {
    const now = baseHash(c);
    const same = sameHash(now, c.base);
    if (!same) {
      const m: BaseMismatch = { chunk: c, baseNow: now };
      mismatches.push(m);
      if (decide(m) === 'base') {
        tookBase.push(c);
        continue;
      }
      kept++;
    }
    applySaveChunk(store(c.grid)!, c, same);
    applied++;
  }
  return { applied, keptOverNewBase: kept, tookBase, mismatches };
}

/** The cells the player changed, with their values now, from a whole-chunk entry's mask and content. */
export function playerCells(grid: ChunkGrid, s: Exclude<SaveContent, { kind: 'delta' }>): CellDelta {
  const d = new CellDelta();
  const cells = s.kind === 'image' ? decodeDenseChunk(grid, s.bytes, chunkScratch(grid).cells) : null;
  const uniformValue = s.kind === 'uniform' ? s.value : 0;
  for (let b = 0; b < s.mask.length; b++) {
    const bits = s.mask[b]!;
    if (bits === 0) continue;
    for (let j = 0; j < 8; j++) {
      if ((bits & (1 << j)) === 0) continue;
      const i = (b << 3) | j;
      d.push(i, cells === null ? uniformValue : denseValue(cells, i));
    }
  }
  return d;
}

/**
 * Writes one entry into its chunk. On the base it was made against
 * (`sameBase`) a whole-chunk entry is written whole; on another base only
 * the player's cells are written, as a delta always is, so every cell the
 * player did not change stays the new base's.
 */
export function applySaveChunk(store: VoxelStoreCandidate, c: SaveChunk, sameBase: boolean): void {
  const s = c.content;
  if (s.kind === 'delta') {
    s.delta.applyToStore(store, c.cx, c.cy, c.cz);
    return;
  }
  if (!sameBase) {
    playerCells(store.grid, s).applyToStore(store, c.cx, c.cy, c.cz);
    return;
  }
  switch (s.kind) {
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

const persistedScratch = new Map<number, DenseChunk>();

/**
 * The cells a save keeps of `now` over `base`: each cell's value with the
 * fields in `saved` from `now` and the rest from `base` (`savedValue`).
 * `now` itself when every field is saved.
 */
export function persistedCells(grid: ChunkGrid, base: DenseChunk, now: DenseChunk, saved: number): DenseChunk {
  if ((saved & ALL_PLANES) === ALL_PLANES) return now;
  let out = persistedScratch.get(grid.edge);
  if (out === undefined) persistedScratch.set(grid.edge, (out = createDenseChunk(grid)));
  for (let i = 0; i < grid.cellsPerChunk; i++) writeDenseValue(out, i, savedValue(denseValue(base, i), denseValue(now, i), saved));
  return out;
}

/**
 * A save entry for one chunk from its base codec bytes (null: air) and its
 * cells now, keeping the fields in `saved` (a PLANE_BIT mask; default all
 * but wetness); null when what it keeps equals the base (the save then
 * holds nothing for it).
 */
export function saveChunkOf(grid: ChunkGrid, gridId: number, cx: number, cy: number, cz: number, baseBytes: Uint8Array | null, now: DenseChunk, saved: number = DEFAULT_SAVED_FIELDS): SaveChunk | null {
  const hash = baseChunkHash(grid, baseBytes);
  const base = decodeDenseChunk(grid, baseBytes, chunkScratch(grid).cells);
  const content = saveContentOf(grid, base, persistedCells(grid, base, now, saved));
  return content === null ? null : { grid: gridId, cx, cy, cz, base: hash, content };
}
