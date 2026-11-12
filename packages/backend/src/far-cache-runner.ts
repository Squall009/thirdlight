/**
 * Voxel far cache work off the backend's event loop: full builds, fine
 * bakes and the rebuild after each edit run on worker threads
 * (`far-cache-worker.ts`).
 * A full build gets a thread of its own, so a world of kilometres being
 * built never delays another world's edit; edits share one kept thread,
 * stopped when idle. Run from source (tests), the work runs in this thread
 * (`inProcessFarJobs`): the cache bytes are the same either way.
 */
import { Worker } from 'node:worker_threads';

import { inProcessFarJobs, type FarCacheJobs, type FarFineResult, type FarFineTask, type FarRebuildReport } from '@thirdlight/workspace';

import { threadPoolRun } from './far-cache-threads';

/** One job for the worker. */
type FarCacheJob =
  | {
      readonly kind: 'build';
      readonly worldDir: string;
      readonly fresh: string;
    }
  | {
      readonly kind: 'rebuild';
      readonly worldDir: string;
      readonly cacheDir: string;
      readonly chunks: ReadonlyArray<{
        readonly cx: number;
        readonly cy: number;
        readonly cz: number;
      }>;
    };

/** A job as posted, with the id its answer carries. */
export type FarCacheTask = FarCacheJob & { readonly id: number };

type Answer = { id: number; ok: true; report?: FarRebuildReport } | { id: number; ok: false; error: string };

/** Milliseconds the edits' worker is kept idle before it is stopped. */
const IDLE_MS = 30_000;

/** A worker thread answering jobs by id; `onIdle` when nothing waits on it any more. */
class FarWorker {
  private serial = 0;
  private readonly waiting = new Map<number, { resolve: (a: Answer) => void; reject: (e: Error) => void }>();
  private readonly worker: Worker;

  constructor(url: URL, onExit: () => void) {
    this.worker = new Worker(url);
    this.worker.on('message', (a: Answer) => {
      const p = this.waiting.get(a.id);
      this.waiting.delete(a.id);
      p?.resolve(a);
    });
    const fail = (e: Error): void => {
      for (const p of this.waiting.values()) p.reject(e);
      this.waiting.clear();
      onExit();
    };
    this.worker.on('error', fail);
    this.worker.on('exit', (code) => fail(new Error(`far cache worker stopped (exit ${code})`)));
    this.worker.unref();
  }

  get busy(): boolean {
    return this.waiting.size > 0;
  }

  async run(task: FarCacheJob): Promise<Answer & { ok: true }> {
    const id = ++this.serial;
    const a = await new Promise<Answer>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.worker.postMessage({ ...task, id });
    });
    if (!a.ok) throw new Error(a.error);
    return a;
  }

  stop(): void {
    void this.worker.terminate();
  }
}

/** The far cache jobs on worker threads at `workerUrl` (null: in this thread). */
export function createFarCacheJobs(workerUrl: URL | null): FarCacheJobs {
  if (workerUrl === null) return inProcessFarJobs();
  const builds = new Set<FarWorker>();
  let edits: FarWorker | null = null;
  let idle: ReturnType<typeof setTimeout> | null = null;
  return {
    async build(worldDir, fresh) {
      const w: FarWorker = new FarWorker(workerUrl, () => builds.delete(w));
      builds.add(w);
      try {
        await w.run({ kind: 'build', worldDir, fresh });
      } finally {
        builds.delete(w);
        w.stop();
      }
    },
    async rebuild(worldDir, cacheDir, chunks) {
      if (idle !== null) clearTimeout(idle);
      const w = (edits ??= new FarWorker(workerUrl, () => {
        if (edits === w) edits = null;
      }));
      try {
        return (
          await w.run({
            kind: 'rebuild',
            worldDir,
            cacheDir,
            chunks: chunks.map(({ cx, cy, cz }) => ({ cx, cy, cz })),
          })
        ).report!;
      } finally {
        if (!w.busy) {
          idle = setTimeout(() => {
            if (edits === w && !w.busy) {
              edits = null;
              w.stop();
            }
          }, IDLE_MS);
          idle.unref();
        }
      }
    },
    bakeFine(tasks) {
      return threadPoolRun<FarFineTask, FarFineResult>(workerUrl, 'fine', tasks);
    },
    close() {
      if (idle !== null) clearTimeout(idle);
      for (const w of builds) w.stop();
      builds.clear();
      edits?.stop();
      edits = null;
    },
  };
}
