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
 * so a world of kilometres bakes in minutes rather than most of an hour. A
 * world's fine levels bake on threads of this file too (`fine` messages, a
 * region column each), sent by the backend's far cache jobs.
 */
import { parentPort } from 'node:worker_threads';

import { bakeFarFineColumn, buildFarCacheInto, FarWorldSource, rebuildFarWorldCache, runFarBakeFromCache, type FarBakeResult, type FarBakeRunner, type FarBakeTask, type FarFineResult, type FarFineTask } from '@thirdlight/workspace';

import type { FarCacheTask } from './far-cache-runner';
import { threadPoolRun, type ThreadAnswer, type ThreadJob } from './far-cache-threads';

/** A full build's bake jobs on threads of this file, answers as they land. */
function threadedBake(): FarBakeRunner {
  return (tasks) => threadPoolRun<FarBakeTask, FarBakeResult>(new URL(import.meta.url), 'bake', tasks);
}

/** The world a fine bake thread reads, kept while its jobs name the same folder. */
let fineWorld: FarWorldSource | null = null;

/** Posts a job's answer, its entries' bytes moved rather than copied. */
function answer(id: number, result: FarBakeResult | FarFineResult): void {
  const transfer = result.entries.flatMap((e) => ('stored' in e ? [e.stored.buffer as ArrayBuffer] : []));
  parentPort!.postMessage({ id, ok: true, result } satisfies ThreadAnswer<FarBakeResult | FarFineResult>, transfer);
}

parentPort?.on('message', (t: FarCacheTask | ThreadJob<FarBakeTask> | ThreadJob<FarFineTask>) => {
  if (t.kind === 'bake' || t.kind === 'fine') {
    try {
      if (t.kind === 'bake') answer(t.id, runFarBakeFromCache((t as ThreadJob<FarBakeTask>).task));
      else {
        const task = (t as ThreadJob<FarFineTask>).task;
        if (fineWorld?.worldDir !== task.worldDir) fineWorld = new FarWorldSource(task.worldDir);
        answer(t.id, bakeFarFineColumn(fineWorld, task));
      }
    } catch (e) {
      parentPort!.postMessage({ id: t.id, ok: false, error: e instanceof Error ? e.message : String(e) } satisfies ThreadAnswer<never>);
    }
    return;
  }
  const job = t as FarCacheTask;
  void (async () => {
    try {
      if (job.kind === 'build') {
        await buildFarCacheInto(job.worldDir, job.fresh, { bake: threadedBake() });
        parentPort!.postMessage({ id: job.id, ok: true });
      } else {
        parentPort!.postMessage({
          id: job.id,
          ok: true,
          report: rebuildFarWorldCache(job.worldDir, job.cacheDir, job.chunks),
        });
      }
    } catch (e) {
      parentPort!.postMessage({
        id: job.id,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  })();
});
