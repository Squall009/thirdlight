/**
 * Gunzip with the platform's own DecompressionStream (a page, a worker, Node) (a build's
 * binary data ships gzip: block chunks, terrain tiles), refusing to inflate
 * past the size the data's header states.
 */

/** Inflate `stored` to exactly `max` bytes (`what` names the data in errors). */
export async function gunzip(stored: Uint8Array, max: number, what: string): Promise<Uint8Array> {
  const reader = new Blob([stored as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const out = new Uint8Array(max);
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (n + value.length > max) {
      await reader.cancel();
      throw new Error(`${what} inflates past its stated size`);
    }
    out.set(value, n);
    n += value.length;
  }
  if (n !== max) throw new Error(`${what} holds ${n} bytes, its header says ${max}`);
  return out;
}
