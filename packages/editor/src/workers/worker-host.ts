/**
 * Phase 22.1: the worker side of the protocol — runs `run` messages through
 * the job table one at a time and answers with `progress` / `done` /
 * `failed`. The worker entry wires it to `self`; unit tests wire it to an
 * in-process channel.
 */
import { JOBS, type JobContext, type JobName } from './jobs';
import type { FromWorker, ToWorker } from './protocol';

export type Post = (message: FromWorker, transfer: Transferable[]) => void;

export function createWorkerHost(post: Post): { receive(message: ToWorker): void } {
  const aborts = new Map<number, AbortController>();
  let chain: Promise<void> = Promise.resolve();
  const run = async (id: number, job: JobName, input: unknown): Promise<void> => {
    const abort = aborts.get(id);
    if (abort === undefined) return;
    const ctx: JobContext = { progress: (done, total) => post({ type: 'progress', id, done, total }, []), signal: abort.signal };
    try {
      const handler = JOBS[job] as ((input: unknown, ctx: JobContext) => Promise<{ output: unknown; transfer: Transferable[] }>) | undefined;
      if (handler === undefined) throw new Error(`unknown job '${String(job)}'`);
      const r = await handler(input, ctx);
      post({ type: 'done', id, output: r.output }, r.transfer);
    } catch (e) {
      post({ type: 'failed', id, message: (e instanceof Error ? e.message : String(e)).slice(0, 500) }, []);
    } finally {
      aborts.delete(id);
    }
  };
  return {
    receive(message) {
      if (message.type === 'cancel') {
        aborts.get(message.id)?.abort();
        return;
      }
      aborts.set(message.id, new AbortController());
      chain = chain.then(() => run(message.id, message.job, message.input));
    },
  };
}
