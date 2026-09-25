/**
 * Phase 22.1: the page side of the editor worker.
 *
 * `run(job, make, { inline })` runs a job of the job table (`jobs.ts`) in a
 * worker and resolves with its output; the caller always gives the inline
 * version too, which runs instead when workers are off (`?workers=off`),
 * unavailable (no `Worker` or `OffscreenCanvas`), the worker script does not
 * load, or the worker dies. `make` builds the message only when it is sent
 * (its buffers are transferred, so it copies what it needs — the caller's
 * own data is never detached and the inline version can still use it).
 *
 * Two lanes of the same script: `cpu` (kept: scatter, diagnostics, PNG
 * encoding) and `gpu` (one worker per job, ended after it: the lightmap
 * bake, whose renderer and scene are released at once and which must not
 * hold up the small jobs).
 */
import type { FromWorker, ToWorker } from './protocol';
import { isFromWorker } from './protocol';
import type { JobName, JobTypes } from './jobs';

export interface WorkerLike {
  postMessage(message: ToWorker, transfer: Transferable[]): void;
  addEventListener(type: 'message', listener: (ev: MessageEvent) => void): void;
  addEventListener(type: 'error', listener: (ev: Event) => void): void;
  terminate(): void;
}

export type Lane = 'cpu' | 'gpu';

export interface RunOptions<T> {
  /** The same job on the page (identical result); runs when no worker can. */
  inline: () => T | Promise<T>;
  lane?: Lane;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

/** Waiting longer than this for a worker to load means it will not: the jobs run inline. */
const READY_TIMEOUT_MS = 30_000;

class WorkerGone extends Error {}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  onProgress: ((done: number, total: number) => void) | undefined;
}

class LaneWorker {
  readonly ready: Promise<boolean>;
  private readonly pending = new Map<number, Pending>();
  private gone = false;
  private worker: WorkerLike | null = null;

  constructor(create: () => WorkerLike) {
    this.ready = new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(ok);
      };
      const timer = setTimeout(() => {
        settle(false);
        this.kill();
      }, READY_TIMEOUT_MS);
      try {
        const w = create();
        this.worker = w;
        w.addEventListener('message', (ev: MessageEvent) => {
          const m = ev.data as unknown;
          if (!isFromWorker(m)) return;
          if (m.type === 'ready') settle(true);
          else this.dispatch(m);
        });
        w.addEventListener('error', () => {
          settle(false);
          this.kill();
        });
      } catch {
        settle(false);
        this.gone = true;
      }
    });
  }

  get alive(): boolean {
    return !this.gone;
  }

  private dispatch(m: Exclude<FromWorker, { type: 'ready' }>): void {
    const p = this.pending.get(m.id);
    if (p === undefined) return;
    if (m.type === 'progress') {
      p.onProgress?.(m.done, m.total);
      return;
    }
    this.pending.delete(m.id);
    if (m.type === 'done') p.resolve(m.output);
    else p.reject(new Error(m.message));
  }

  /** The worker is gone: every waiting job learns it (and runs inline). */
  kill(): void {
    this.gone = true;
    try {
      this.worker?.terminate();
    } catch {
      /* already gone */
    }
    this.worker = null;
    for (const p of this.pending.values()) p.reject(new WorkerGone('the editor worker stopped'));
    this.pending.clear();
  }

  send(id: number, job: JobName, input: unknown, transfer: Transferable[], onProgress: Pending['onProgress'], signal: AbortSignal | undefined): Promise<unknown> {
    const w = this.worker;
    if (w === null || this.gone) return Promise.reject(new WorkerGone('the editor worker stopped'));
    return new Promise((resolve, reject) => {
      const onAbort = (): void => w.postMessage({ type: 'cancel', id }, []);
      const cleanup = (): void => signal?.removeEventListener('abort', onAbort);
      this.pending.set(id, {
        resolve: (v) => {
          cleanup();
          resolve(v);
        },
        reject: (e) => {
          cleanup();
          reject(e);
        },
        onProgress,
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      w.postMessage({ type: 'run', id, job, input }, transfer);
      if (signal?.aborted === true) onAbort();
    });
  }
}

export interface EditorWorkersOptions {
  /** False: every job runs inline (`?workers=off`, or no Worker/OffscreenCanvas). */
  enabled: boolean;
  create: () => WorkerLike;
}

export class EditorWorkers {
  private cpu: LaneWorker | null = null;
  private nextId = 1;
  /** A worker never became ready (no script, blocked, too slow): every later job runs inline without waiting again. */
  private unavailable = false;
  /** How the last job of each kind ran (the e2e and the status line read it). */
  readonly lastMode = new Map<JobName, 'worker' | 'inline'>();

  constructor(private readonly options: EditorWorkersOptions) {}

  get enabled(): boolean {
    return this.options.enabled;
  }

  private lane(which: Lane): LaneWorker {
    if (which === 'gpu') return new LaneWorker(this.options.create);
    if (this.cpu === null || !this.cpu.alive) this.cpu = new LaneWorker(this.options.create);
    return this.cpu;
  }

  async run<K extends JobName>(job: K, make: () => { input: JobTypes[K]['input']; transfer?: Transferable[] }, o: RunOptions<JobTypes[K]['output']>): Promise<JobTypes[K]['output']> {
    const inline = async (): Promise<JobTypes[K]['output']> => {
      this.lastMode.set(job, 'inline');
      return o.inline();
    };
    if (!this.options.enabled || this.unavailable) return inline();
    const lane = this.lane(o.lane ?? 'cpu');
    try {
      if (!(await lane.ready)) {
        this.unavailable = true;
        return await inline();
      }
      const { input, transfer } = make();
      const out = (await lane.send(this.nextId++, job, input, transfer ?? [], o.onProgress, o.signal)) as JobTypes[K]['output'];
      this.lastMode.set(job, 'worker');
      return out;
    } catch (e) {
      if (e instanceof WorkerGone) return inline();
      throw e;
    } finally {
      if ((o.lane ?? 'cpu') === 'gpu') lane.kill();
    }
  }

  dispose(): void {
    this.cpu?.kill();
    this.cpu = null;
  }
}

/** Workers are on unless the page says `?workers=off` (then every job runs on the page, as before 22.1). */
export function workersRequested(search: string): boolean {
  return new URLSearchParams(search).get('workers') !== 'off';
}

let shared: EditorWorkers | null = null;

/** The page's editor workers (created on first use; the worker script sits next to the editor page). */
export function editorWorkers(): EditorWorkers {
  if (shared !== null) return shared;
  const g = globalThis as { Worker?: new (url: string | URL, o?: { name?: string }) => WorkerLike; OffscreenCanvas?: unknown; location?: { search: string }; document?: { baseURI: string } };
  const available = typeof g.Worker === 'function' && typeof g.OffscreenCanvas === 'function' && g.document !== undefined;
  const enabled = available && workersRequested(g.location?.search ?? '');
  shared = new EditorWorkers({
    enabled,
    create: () => new g.Worker!(new URL('editor-worker.js', g.document!.baseURI), { name: 'thirdlight-editor' }),
  });
  return shared;
}
