/**
 * Bake jobs on threads of the far cache worker script: a few threads, a job
 * a message, answers yielded as they land (any order), the threads stopped
 * when the caller stops reading. A bake of a world of kilometres is hours of
 * one thread; spread over these it is a quarter of that, and the backend's
 * own thread stays free.
 */
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';

/** Threads a bake runs on: the host's cores but one (the backend's), at most four. */
export const FAR_BAKE_THREADS = Math.max(1, Math.min(4, availableParallelism() - 1));

/** A job as posted to a thread: its kind (what the worker runs), its id and its task. */
export interface ThreadJob<T> {
  readonly kind: string;
  readonly id: number;
  readonly task: T;
}

/** A thread's answer to a job. */
export type ThreadAnswer<R> = { id: number; ok: true; result: R } | { id: number; ok: false; error: string };

/** Runs `tasks` as `kind` jobs on up to {@link FAR_BAKE_THREADS} threads of the script at `url`. */
export function threadPoolRun<T, R>(url: URL, kind: string, tasks: readonly T[]): AsyncIterable<R> {
  return {
    async *[Symbol.asyncIterator]() {
      const threads = Array.from({ length: Math.min(FAR_BAKE_THREADS, Math.max(1, tasks.length)) }, () => new Worker(url));
      const done: R[] = [];
      let failed: Error | null = null;
      let wake: (() => void) | null = null;
      let next = 0;
      let running = 0;
      const send = (w: Worker): void => {
        if (failed !== null || next >= tasks.length) return;
        const id = next++;
        running++;
        w.postMessage({ kind, id, task: tasks[id]! } satisfies ThreadJob<T>);
      };
      for (const w of threads) {
        w.on('message', (a: ThreadAnswer<R>) => {
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
  };
}
