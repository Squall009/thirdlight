/**
 * A block layer's undo step: only the chunks and regions an edit changed,
 * each as it was before and after.
 *
 * A history entry that kept the layer's whole entry twice grew with the
 * layer, not the edit: on a large layer every one-cell edit held two lists of
 * all its chunks. A patch holds the changed chunks only, so an undo step
 * costs what the edit touched, and undo and redo replace those chunks in
 * whatever the layer holds now. Each is kept in its binary form
 * (block-chunk-binary.ts, uncompressed): a chunk object of a few hundred
 * columns is kilobytes of small arrays on the heap, its binary form a few
 * hundred bytes, decoded only when the step is undone or redone.
 */
import { decodeBlockChunks, encodeBlockChunks, type BlockChunk, type BlockLayerData, type BlockRegion } from '@thirdlight/project-model';

/** One chunk before and after, in binary form (null: no chunk there). */
export interface BlockChunkSwap {
  cx: number;
  cz: number;
  restore: Uint8Array | null;
  next: Uint8Array | null;
}

/** One region before and after (null: no such region). */
export interface BlockRegionSwap {
  regionId: string;
  restore: BlockRegion | null;
  next: BlockRegion | null;
}

/** The chunks and regions of one layer an edit changed. */
export interface BlockLayerPatch {
  entityId: string;
  chunks: BlockChunkSwap[];
  regions: BlockRegionSwap[];
}

const chunkKey = (c: { cx: number; cz: number }): string => `${c.cx},${c.cz}`;
const sameChunk = (a: BlockChunk | undefined, b: BlockChunk | undefined): boolean => a === b || (a !== undefined && b !== undefined && JSON.stringify(a) === JSON.stringify(b));
const sameRegion = (a: BlockRegion | undefined, b: BlockRegion | undefined): boolean => a === b || (a !== undefined && b !== undefined && JSON.stringify(a.boxes) === JSON.stringify(b.boxes));
const byChunkOrder = (p: { cx: number; cz: number }, q: { cx: number; cz: number }): number => p.cz - q.cz || p.cx - q.cx;

/**
 * The patch that takes layer entry `a` to `b` (null: no entry). `candidates`
 * (chunk keys `"cx,cz"`) limits the chunks compared to those an edit wrote;
 * absent, every chunk of both entries is compared.
 */
export function layerPatch(entityId: string, a: BlockLayerData | null, b: BlockLayerData | null, candidates?: readonly string[]): BlockLayerPatch {
  const ca = new Map((a?.chunks ?? []).map((c) => [chunkKey(c), c]));
  const cb = new Map((b?.chunks ?? []).map((c) => [chunkKey(c), c]));
  const keys = candidates ?? [...new Set([...ca.keys(), ...cb.keys()])];
  const chunks: BlockChunkSwap[] = [];
  for (const k of keys) {
    const x = ca.get(k);
    const y = cb.get(k);
    if (sameChunk(x, y)) continue;
    const [cx, cz] = k.split(',').map(Number) as [number, number];
    chunks.push({ cx, cz, restore: x !== undefined ? encodeBlockChunks([x]) : null, next: y !== undefined ? encodeBlockChunks([y]) : null });
  }
  chunks.sort(byChunkOrder);
  const ra = new Map((a?.regions ?? []).map((r) => [r.regionId, r]));
  const rb = new Map((b?.regions ?? []).map((r) => [r.regionId, r]));
  const regions: BlockRegionSwap[] = [];
  for (const id of [...new Set([...ra.keys(), ...rb.keys()])].sort()) {
    const x = ra.get(id);
    const y = rb.get(id);
    if (!sameRegion(x, y)) regions.push({ regionId: id, restore: x ?? null, next: y ?? null });
  }
  return { entityId, chunks, regions };
}

/** Whether the patch changes nothing. */
export const patchIsEmpty = (p: BlockLayerPatch): boolean => p.chunks.length === 0 && p.regions.length === 0;

/** The chunks [cx, cz] and region ids a patch changes (the same in both directions; what a change names). */
export function patchDelta(p: BlockLayerPatch): { chunks: [number, number][]; regions: string[] } {
  return { chunks: p.chunks.map((c) => [c.cx, c.cz]), regions: p.regions.map((r) => r.regionId) };
}

/** A layer entry (null: none) with a patch's `restore` (undo) or `next` (redo) side put in; null when nothing is left. */
export function patchedLayer(current: BlockLayerData | null, p: BlockLayerPatch, side: 'restore' | 'next'): BlockLayerData | null {
  const chunks = new Map((current?.chunks ?? []).map((c) => [chunkKey(c), c]));
  for (const s of p.chunks) {
    const v = s[side];
    if (v === null) chunks.delete(chunkKey(s));
    else chunks.set(chunkKey(s), decodeBlockChunks(v)[0]!);
  }
  const regions = new Map((current?.regions ?? []).map((r) => [r.regionId, r]));
  for (const s of p.regions) {
    const v = s[side];
    if (v === null) regions.delete(s.regionId);
    else regions.set(s.regionId, v);
  }
  const chunkList = [...chunks.values()].sort(byChunkOrder);
  const regionList = [...regions.values()].sort((x, y) => (x.regionId < y.regionId ? -1 : x.regionId > y.regionId ? 1 : 0));
  if (chunkList.length === 0 && regionList.length === 0) return null;
  return { entityId: p.entityId, ...(chunkList.length > 0 ? { chunks: chunkList } : {}), ...(regionList.length > 0 ? { regions: regionList } : {}) };
}
