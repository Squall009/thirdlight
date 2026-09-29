/**
 * Phase 25.19: the KTX2 encoder's worker thread (built to
 * `dist/backend/ktx2-worker.mjs`): one message `{id, bytes, mode}` in, one
 * `{id, result}` out, in order.
 */
import { parentPort } from 'node:worker_threads';

import { encodeKtx2, type Ktx2Mode } from './texture-encode';

let queue: Promise<void> = Promise.resolve();
parentPort?.on('message', (m: { id: number; bytes: Uint8Array; mode: Ktx2Mode }) => {
  queue = queue.then(async () => {
    const result = await encodeKtx2(m.bytes, m.mode);
    if (result.ok) parentPort!.postMessage({ id: m.id, result }, [result.ktx2.buffer as ArrayBuffer]);
    else parentPort!.postMessage({ id: m.id, result });
  });
});
