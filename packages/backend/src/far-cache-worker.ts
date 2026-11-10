/**
 * The voxel far cache worker thread (built beside the backend bundle,
 * `dist/backend/far-cache-worker.mjs`): one job a message, a whole far
 * cache built into a fresh folder or an edit's ancestors built again in
 * place, answered when it is on disk. A mountain world's full build takes
 * minutes and an edit's rebuild a few hundred milliseconds; here neither
 * holds up the backend's event loop.
 *
 * A full build bakes every node's bricks too, a few times the nodes' own
 * build: its bake jobs go to threads of this same file (`bake` messages),
 * so a world of kilometres bakes in minutes rather than most of an hour.
 */
import { availableParallelism } from 'node:os';
import { parentPort, Worker } from 'node:worker_threads';

import { buildFarCacheInto, rebuildFarCache, runFarBakeFromCache, type FarBakeResult, type FarBakeRunner, type FarBakeTask } from '@thirdlight/workspace';

import type { FarCacheTask } from './far-cache-runner';

/** Threads a full build bakes bricks on: the host's cores but one (the backend's), at most four. */
const BAKE_THREADS = Math.max(1, Math.min(4, availableParallelism() - 1));

type BakeMessage = { readonly kind: 'bake'; readonly id: number; readonly task: FarBakeTask };
type BakeAnswer = { id: number; ok: true; result: FarBakeResult } | { id: number; ok: false; error: string };

/** Bake jobs on {@link BAKE_THREADS} threads of this file, answers as they land. */
function threadedBake(): FarBakeRunner {
  return (tasks) => ({
    async *[Symbol.asyncIterator]() {
      const url = new URL(import.meta.url);
      const threads = Array.from({ length: Math.min(BAKE_THREADS, Math.max(1, tasks.length)) }, () => new Worker(url));
      const done: FarBakeResult[] = [];
      let failed: Error | null = null;
      let wake: (() => void) | null = null;
      let next = 0;
      let running = 0;
      const send = (w: Worker): void => {
        if (failed !== null || next >= tasks.length) return;
        const id = next++;
        running++;
        w.postMessage({ kind: 'bake', id, task: tasks[id]! } satisfies BakeMessage);
      };
      for (const w of threads) {
        w.on('message', (a: BakeAnswer) => {
          running--;
          if (a.ok) done.push(a.result);
          else failed = new Error(a.error);
          send(w);
          wake?.();
        });
        w.on('error', (e) => {
          failed = e;
          wake?.();
        });
        send(w);
      }
      try {
        while (done.length > 0 || running > 0) {
          if (failed !== null) throw failed;
          if (done.length === 0) await new Promise<void>((ok) => (wake = ok));
          wake = null;
          while (done.length > 0) yield done.shift()!;
        }
        if (failed !== null) throw failed;
      } finally {
        await Promise.all(threads.map((w) => w.terminate()));
      }
    },
  });
}

parentPort?.on('message', (t: FarCacheTask | BakeMessage) => {
  if (t.kind === 'bake') {
    try {
      const result = runFarBakeFromCache(t.task);
      const transfer = result.entries.flatMap((e) => ('stored' in e ? [e.stored.buffer as ArrayBuffer] : []));
      parentPort!.postMessage({ id: t.id, ok: true, result } satisfies BakeAnswer, transfer);
    } catch (e) {
      parentPort!.postMessage({ id: t.id, ok: false, error: e instanceof Error ? e.message : String(e) } satisfies BakeAnswer);
    }
    return;
  }
  void (async () => {
    try {
      if (t.kind === 'build') {
        await buildFarCacheInto(t.worldDir, t.fresh, { bake: threadedBake() });
        parentPort!.postMessage({ id: t.id, ok: true });
      } else {
        parentPort!.postMessage({
          id: t.id,
          ok: true,
          report: rebuildFarCache(t.worldDir, t.cacheDir, t.chunks),
        });
      }
    } catch (e) {
      parentPort!.postMessage({
        id: t.id,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  })();
});
