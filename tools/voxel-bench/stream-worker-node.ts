/**
 * The streaming worker for Node (`worker_threads`): the same job handlers a
 * browser module worker runs (stream-worker-browser.ts), served on
 * `parentPort`, which speaks the same message API as a worker's `self`.
 * The decoder is fzstd, the browser's, so tests and the benchmark run the
 * code path an exported game runs.
 *
 * Two extra kinds exist for the pool's own tests and nothing else:
 * `test-sleep` (answers after `ms`, with its input) and `test-crash` (ends
 * the worker with an uncaught error).
 */
import { parentPort } from 'node:worker_threads';
import { serveJobs, streamJobHandlers, type JobEndpoint } from '@thirdlight/voxel';
import { decompress } from 'fzstd';

const handlers = {
  ...streamJobHandlers({ decompress: (b) => decompress(b) }),
  'test-sleep': async (input: unknown) => {
    const { ms, buf } = input as { ms: number; buf?: ArrayBuffer };
    await new Promise((r) => setTimeout(r, ms));
    return { output: { ms, bytes: buf?.byteLength ?? 0, buf }, transfer: buf === undefined ? [] : [buf] };
  },
  'test-crash': () => {
    setTimeout(() => {
      throw new Error('test crash');
    }, 0);
    return { output: null, transfer: [] };
  },
};

serveJobs(parentPort as unknown as JobEndpoint, handlers);
