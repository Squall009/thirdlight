/**
 * A chunk as it crosses between threads: its in-memory arrays, handed over
 * as transferable buffers, so a worker can do the per-cell work (zstd,
 * palette decode, brick building, applying a save or an edit) and the main
 * thread only adopts the arrays, with no per-cell pass of its own.
 *
 * The wire is the store's memory form, not a file format: both ends run
 * the same package build, so it carries no version of its own (the job
 * message does, see stream-job.ts). It is checked on adoption so a damaged
 * or mismatched message is refused rather than read out of range.
 */
import type { ChunkGrid } from './coords';
import type { RecordChunkWire } from './palette-chunk';

/** One chunk's content: all air (absent), one record value everywhere, or stored cells. */
export type ChunkPayload =
  | { readonly form: 'air' }
  | { readonly form: 'uniform'; readonly value: number }
  | { readonly form: 'stored'; readonly edge: number; readonly wire: RecordChunkWire };

/** The buffers of a payload, for a postMessage transfer list. */
export function payloadTransfer(p: ChunkPayload, out: ArrayBuffer[] = []): ArrayBuffer[] {
  if (p.form !== 'stored') return out;
  const w = p.wire;
  const add = (a: { buffer: ArrayBufferLike } | null): void => {
    if (a === null) return;
    const b = a.buffer;
    if (b instanceof ArrayBuffer && !out.includes(b)) out.push(b);
  };
  add(w.plane.values);
  add(w.plane.meta);
  if (w.plane.layout.kind === 'bricks') {
    add(w.plane.layout.brick);
    add(w.plane.layout.mixed);
    add(w.plane.layout.pool);
    add(w.plane.layout.free);
  } else add(w.plane.layout.words);
  add(w.density);
  return out;
}

/** Bytes a payload's arrays hold (what crossing threads moves). */
export function payloadBytes(p: ChunkPayload): number {
  if (p.form !== 'stored') return 0;
  const w = p.wire;
  const l = w.plane.layout;
  const layout = l.kind === 'bricks' ? l.brick.byteLength + l.mixed.byteLength + l.pool.byteLength + l.free.byteLength : l.words.byteLength;
  return w.plane.values.byteLength + w.plane.meta.byteLength + layout + (w.density?.byteLength ?? 0);
}

/** Throws unless a payload names a chunk of `grid`'s edge (the arrays are checked when adopted). */
export function checkPayloadEdge(grid: ChunkGrid, p: ChunkPayload): void {
  if (p.form === 'stored' && p.edge !== grid.edge) throw new RangeError(`chunk payload of edge ${p.edge}, store edge ${grid.edge}`);
}
