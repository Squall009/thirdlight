/**
 * The script type check off the backend's event loop: checks run on a
 * worker thread (`type-check-worker.ts`), so the compiler's cold start
 * (about 0.6 s: its standard library and the API typings) and a heavy
 * script's check never stall other projects' requests, sockets or Play
 * relays. The checking itself is bounded by `TYPE_CHECK_TIMEOUT_MS` inside
 * the worker; building the program is not, so a check that has not answered
 * within twice that ends the worker and answers as timed out. Run from
 * source (tests), it checks in this thread.
 */
import { Worker } from 'node:worker_threads';

import { TYPE_CHECK_TIMEOUT_MS } from '@thirdlight/behavior-build';
import type { ScriptTypeCheckInput, ScriptTypeCheckResult } from '@thirdlight/behavior-build';

export interface TypeCheckRunner {
  check(input: ScriptTypeCheckInput): Promise<ScriptTypeCheckResult>;
  /** A worker is running now (tests). */
  readonly workerRunning: boolean;
}

/**
 * Milliseconds an idle worker is kept: an author checking while typing keeps
 * the warm compiler (a later check of the same script takes milliseconds);
 * an idle one gives its memory back.
 */
const IDLE_MS = 60_000;

/**
 * The type checks on the worker at `workerUrl`; `inProcess` checks in this
 * thread (no worker file: run from source).
 */
export function createTypeCheckRunner(workerUrl: URL | null, inProcess: (input: ScriptTypeCheckInput) => Promise<ScriptTypeCheckResult>, options: { idleMs?: number } = {}): TypeCheckRunner {
  const idleMs = options.idleMs ?? IDLE_MS;
  let worker: Worker | null = null;
  let serial = 0;
  let idle: ReturnType<typeof setTimeout> | null = null;
  const waiting = new Map<number, { resolve: (r: ScriptTypeCheckResult) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  const settleAll = (how: (p: { resolve: (r: ScriptTypeCheckResult) => void; reject: (e: Error) => void }) => void): void => {
    for (const p of waiting.values()) {
      clearTimeout(p.timer);
      how(p);
    }
    waiting.clear();
  };
  const stop = (w: Worker): void => {
    if (worker === w) worker = null;
    void w.terminate();
  };
  const start = (url: URL): Worker => {
    const w = new Worker(url);
    w.on('message', (m: { id: number; result?: ScriptTypeCheckResult; error?: string }) => {
      const p = waiting.get(m.id);
      if (p === undefined) return;
      waiting.delete(m.id);
      clearTimeout(p.timer);
      if (m.result !== undefined) p.resolve(m.result);
      else p.reject(new Error(m.error ?? 'the type check failed'));
      if (waiting.size === 0) {
        idle = setTimeout(() => stop(w), idleMs);
        idle.unref();
      }
    });
    w.on('error', (e) => {
      settleAll((p) => p.reject(e));
      if (worker === w) worker = null;
    });
    w.on('exit', () => {
      if (worker === w) worker = null;
    });
    w.unref();
    return w;
  };

  return {
    get workerRunning() {
      return worker !== null;
    },
    check(input) {
      if (workerUrl === null) return inProcess(input);
      if (idle !== null) clearTimeout(idle);
      idle = null;
      const w = (worker ??= start(workerUrl));
      const id = ++serial;
      return new Promise<ScriptTypeCheckResult>((resolve, reject) => {
        // Building a pathological program is not bounded inside the worker: past twice the checking bound
        // the worker ends, and every check it held answers as timed out (the next one starts a new worker).
        const timer = setTimeout(() => {
          settleAll((p) => p.resolve({ diagnostics: [], timedOut: true }));
          stop(w);
        }, 2 * TYPE_CHECK_TIMEOUT_MS);
        timer.unref();
        waiting.set(id, { resolve, reject, timer });
        w.postMessage({ id, input });
      });
    },
  };
}
