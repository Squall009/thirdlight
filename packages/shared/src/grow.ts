/**
 * Growing a buffer by copy: one growth policy and one copy for every typed
 * array and GPU buffer that grows to fit (instance pools, light lists, point
 * atlases, tracer words). Doubling keeps the copies' total cost linear in
 * the final size; a buffer never shrinks here (a store that gives memory back
 * does so on its own terms).
 */

/** Any typed array a buffer grows as. */
export type GrowableArray =
  | Uint8Array<ArrayBuffer>
  | Uint16Array<ArrayBuffer>
  | Uint32Array<ArrayBuffer>
  | Int32Array<ArrayBuffer>
  | Float32Array<ArrayBuffer>
  | Float64Array<ArrayBuffer>;

/**
 * The capacity a buffer of `have` grows to so `need` fits: `have` (at least
 * `least`) doubled until it holds `need`. `have` itself when it already fits.
 */
export function grownCapacity(have: number, need: number, least = 1): number {
  if (need <= have) return have;
  let size = Math.max(1, least, Math.floor(have));
  while (size < need) size *= 2;
  return size;
}

/** A typed array of `from`'s kind and `length` elements, `from`'s values at its start (`from` itself when it is that long). */
export function grownArray<T extends GrowableArray>(from: T, length: number): T {
  if (length === from.length) return from;
  if (length < from.length) throw new Error(`grownArray: ${length} is shorter than the ${from.length} held`);
  const next = new (from.constructor as new (n: number) => T)(length);
  (next as unknown as { set(values: ArrayLike<number>): void }).set(from);
  return next;
}
