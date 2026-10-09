/**
 * Editing one copy of an instance set — the pure part.
 *
 * An instance set stores its copies in a content-addressed buffer (10
 * float32 per copy: position xyz, rotation quaternion xyzw, scale xyz, local
 * to the set's object). Editing a copy never mutates a buffer: the editor
 * builds the new list here, publishes it through the same buffer route the
 * MCP tool `tl_instance_buffer` uses, and stores its digest and count with
 * one `setComponent instances` (one undo step; the old buffer stays, so
 * undo just points back to it).
 */

import { INSTANCE_FLOATS } from '@thirdlight/runtime';

export interface CopyTransform {
  position: [number, number, number];
  rotation: [number, number, number, number];
  scale: [number, number, number];
}

export function copyCount(floats: Float32Array): number {
  return Math.floor(floats.length / INSTANCE_FLOATS);
}

/** One copy's transform (null when the index is outside the buffer). */
export function copyAt(floats: Float32Array, index: number): CopyTransform | null {
  if (!Number.isInteger(index) || index < 0 || index >= copyCount(floats)) return null;
  const o = index * INSTANCE_FLOATS;
  const f = (k: number): number => floats[o + k]!;
  return { position: [f(0), f(1), f(2)], rotation: [f(3), f(4), f(5), f(6)], scale: [f(7), f(8), f(9)] };
}

const write = (out: Float32Array, index: number, t: CopyTransform): void => {
  out.set([...t.position, ...t.rotation, ...t.scale], index * INSTANCE_FLOATS);
};

/** The buffer with copy `index` replaced. */
export function withCopy(floats: Float32Array, index: number, t: CopyTransform): Float32Array {
  const out = floats.slice(0, copyCount(floats) * INSTANCE_FLOATS);
  write(out, index, t);
  return out;
}

/** The buffer without copy `index` (null: a set keeps at least one copy — delete the object instead). */
export function withoutCopy(floats: Float32Array, index: number): Float32Array | null {
  const n = copyCount(floats);
  if (n <= 1 || index < 0 || index >= n) return null;
  const out = new Float32Array((n - 1) * INSTANCE_FLOATS);
  out.set(floats.subarray(0, index * INSTANCE_FLOATS), 0);
  out.set(floats.subarray((index + 1) * INSTANCE_FLOATS, n * INSTANCE_FLOATS), index * INSTANCE_FLOATS);
  return out;
}
