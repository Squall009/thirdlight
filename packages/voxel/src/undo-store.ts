/**
 * Undo records at rest and the undo memory budget.
 *
 * An undo record (edit-apply.ts) is the before-state of the chunks one
 * command changed. History keeps a record per command; the records are held
 * in memory up to a byte budget, and past it the oldest are written to disk
 * (any {@link UndoSpill}: files in the backend, IndexedDB in a browser) and
 * read back when undone. There is no count of steps: a thousand dabs and
 * three huge fills cost what their chunks cost.
 *
 * Record bytes, version 1 (little-endian):
 *   'T' 'L' 'V' 'U', u8 version, u8 chunk edge, u8 chunk codec version,
 *   u8 reserved (0), u32 chunk count, then per chunk: u32 grid, i16 cx,
 *   i16 cy, i16 cz, u8 kind (0 cell delta, 1 image, 2 absent), u32 length,
 *   the payload; then the CRC-32 of everything before it.
 */
import { crc32 } from '@thirdlight/shared';
import { CellDelta } from './cell-delta';
import type { ChunkGrid } from './coords';
import { UNDO_CHUNK_HEADER_BYTES, undoRecordBytes, type ChunkUndo } from './edit-apply';
import { PALETTE_CODEC_VERSION, readPaletteHeader } from './palette-codec';

/** The undo record format this build writes and reads. */
export const UNDO_RECORD_VERSION = 1;

/**
 * Default bytes of undo records an editor keeps in memory before spilling
 * the oldest to disk (a memory budget, not a step count).
 */
export const UNDO_MEMORY_BUDGET_BYTES = 64 * 1024 * 1024;

const MAGIC = [0x54, 0x4c, 0x56, 0x55] as const;
const HEADER = 12;

/** The record's bytes (see the file comment). */
export function encodeUndoRecord(grid: ChunkGrid, record: readonly ChunkUndo[]): Uint8Array {
  const payloads = record.map((u) => (u.before.kind === 'delta' ? u.before.delta.encode() : u.before.bytes));
  let n = HEADER + 4;
  for (const p of payloads) n += UNDO_CHUNK_HEADER_BYTES + (p?.length ?? 0);
  const out = new Uint8Array(n);
  const view = new DataView(out.buffer);
  MAGIC.forEach((b, i) => (out[i] = b));
  out[4] = UNDO_RECORD_VERSION;
  out[5] = grid.edge;
  out[6] = PALETTE_CODEC_VERSION;
  view.setUint32(8, record.length, true);
  let at = HEADER;
  record.forEach((u, k) => {
    const p = payloads[k] ?? null;
    view.setUint32(at, u.grid, true);
    view.setInt16(at + 4, u.cx, true);
    view.setInt16(at + 6, u.cy, true);
    view.setInt16(at + 8, u.cz, true);
    out[at + 10] = u.before.kind === 'delta' ? 0 : p === null ? 2 : 1;
    view.setUint32(at + 11, p?.length ?? 0, true);
    at += UNDO_CHUNK_HEADER_BYTES;
    if (p !== null) {
      out.set(p, at);
      at += p.length;
    }
  });
  view.setUint32(at, crc32(out.subarray(0, at)), true);
  return out;
}

/** Reads {@link encodeUndoRecord}'s bytes; throws on damage, another edge or an unknown version. */
export function decodeUndoRecord(grid: ChunkGrid, bytes: Uint8Array): ChunkUndo[] {
  if (bytes.length < HEADER + 4 || !MAGIC.every((b, i) => bytes[i] === b)) throw new RangeError('undo record: bad magic');
  if (bytes[4] !== UNDO_RECORD_VERSION) throw new RangeError(`undo record: unknown version ${bytes[4]}`);
  if (bytes[5] !== grid.edge || bytes[6] !== PALETTE_CODEC_VERSION || bytes[7] !== 0) throw new RangeError('undo record: another chunk edge or codec');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 4;
  if (crc32(bytes.subarray(0, end)) !== view.getUint32(end, true)) throw new RangeError('undo record: checksum mismatch');
  const count = view.getUint32(8, true);
  const out: ChunkUndo[] = [];
  let at = HEADER;
  for (let k = 0; k < count; k++) {
    if (at + UNDO_CHUNK_HEADER_BYTES > end) throw new RangeError('undo record: truncated');
    const g = view.getUint32(at, true);
    const cx = view.getInt16(at + 4, true);
    const cy = view.getInt16(at + 6, true);
    const cz = view.getInt16(at + 8, true);
    const kind = bytes[at + 10];
    const len = view.getUint32(at + 11, true);
    at += UNDO_CHUNK_HEADER_BYTES;
    if (at + len > end) throw new RangeError('undo record: truncated');
    const p = bytes.slice(at, at + len);
    at += len;
    if (kind === 0) out.push({ grid: g, cx, cy, cz, before: { kind: 'delta', delta: CellDelta.decode(grid, p) } });
    else if (kind === 1) {
      readPaletteHeader(grid, p);
      out.push({ grid: g, cx, cy, cz, before: { kind: 'image', bytes: p } });
    } else if (kind === 2 && len === 0) out.push({ grid: g, cx, cy, cz, before: { kind: 'image', bytes: null } });
    else throw new RangeError(`undo record: chunk kind ${kind}`);
  }
  if (at !== end) throw new RangeError('undo record: trailing bytes');
  return out;
}

/** Where undo records past the memory budget go (and come back from). */
export interface UndoSpill {
  write(id: number, bytes: Uint8Array): Promise<void>;
  read(id: number): Promise<Uint8Array>;
  remove(id: number): Promise<void>;
}

/**
 * Undo records by id, in memory up to a byte budget; past it the oldest go
 * to the spill. A history entry holds the id, not the record, so the
 * command history stays small whatever the strokes touched.
 *
 * Calls run one at a time in call order (each waits for the one before):
 * a spill write in flight must never let a second put spill the same
 * record, nor a take miss a record that is between memory and disk.
 */
export class UndoStore {
  private readonly held = new Map<number, { record: ChunkUndo[]; bytes: number }>();
  private readonly spilled = new Map<number, number>();
  private nextId = 1;
  private heldBytes = 0;
  private spilledTotal = 0;
  private spillWrites = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly grid: ChunkGrid,
    readonly spill: UndoSpill,
    readonly budgetBytes: number = UNDO_MEMORY_BUDGET_BYTES,
  ) {
    if (!(budgetBytes >= 0)) throw new RangeError('an undo budget is ≥ 0 bytes');
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Keeps a record; returns its id. Spills the oldest records while memory is over budget. */
  put(record: readonly ChunkUndo[]): Promise<number> {
    const id = this.nextId++;
    return this.serial(async () => {
      const bytes = undoRecordBytes(record);
      this.held.set(id, { record: [...record], bytes });
      this.heldBytes += bytes;
      // Oldest first: Map iteration is insertion order, and ids only grow.
      while (this.heldBytes > this.budgetBytes) {
        const oldest = this.held.entries().next().value;
        if (oldest === undefined) break;
        const [old, h] = oldest;
        const encoded = encodeUndoRecord(this.grid, h.record);
        await this.spill.write(old, encoded);
        this.held.delete(old);
        this.heldBytes -= h.bytes;
        this.spilled.set(old, encoded.length);
        this.spilledTotal += encoded.length;
        this.spillWrites++;
      }
      return id;
    });
  }

  /** The record (from memory or the spill), forgetting it. */
  take(id: number): Promise<ChunkUndo[]> {
    return this.serial(async () => {
      const h = this.held.get(id);
      if (h !== undefined) {
        this.held.delete(id);
        this.heldBytes -= h.bytes;
        return h.record;
      }
      const n = this.spilled.get(id);
      if (n === undefined) throw new RangeError(`undo record ${id} is not held`);
      const record = decodeUndoRecord(this.grid, await this.spill.read(id));
      await this.spill.remove(id);
      this.spilled.delete(id);
      this.spilledTotal -= n;
      return record;
    });
  }

  /** Forgets a record (a dropped redo tail or history entry). */
  drop(id: number): Promise<void> {
    return this.serial(async () => {
      const h = this.held.get(id);
      if (h !== undefined) {
        this.held.delete(id);
        this.heldBytes -= h.bytes;
        return;
      }
      const n = this.spilled.get(id);
      if (n === undefined) return;
      await this.spill.remove(id);
      this.spilled.delete(id);
      this.spilledTotal -= n;
    });
  }

  get memoryBytes(): number {
    return this.heldBytes;
  }

  get spilledBytes(): number {
    return this.spilledTotal;
  }

  get spilledRecords(): number {
    return this.spilled.size;
  }

  /** Records written to the spill so far. */
  get spillCount(): number {
    return this.spillWrites;
  }
}
