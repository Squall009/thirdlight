/**
 * The KTX2 encoder's worker thread (built to
 * `dist/backend/ktx2-worker.mjs`): one message `{id, bytes, mode}` in, one
 * `{id, result}` out, in order.
 */
import { parentPort } from 'node:worker_threads';

import { encodeKtx2, packKtx2, type Ktx2Mode, type PackLayer } from './texture-encode';

let queue: Promise<void> = Promise.resolve();
// `{id, pack: {sources, layers}, mode}` packs and encodes several images into one KTX2.
parentPort?.on('message', (m: { id: number; bytes?: Uint8Array; pack?: { sources: Uint8Array[]; layers: PackLayer[] }; mode: Ktx2Mode }) => {
  queue = queue.then(async () => {
    const result = m.pack !== undefined ? await packKtx2(m.pack.sources, m.pack.layers, m.mode) : await encodeKtx2(m.bytes!, m.mode);
    if (result.ok) parentPort!.postMessage({ id: m.id, result }, [result.ktx2.buffer as ArrayBuffer]);
    else parentPort!.postMessage({ id: m.id, result });
  });
});
