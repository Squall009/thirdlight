/**
 * The worker pool streaming jobs run on.
 *
 * - **Workers** are module workers behind {@link PoolWorker} (a browser
 *   `Worker`, or a Node `worker_threads` Worker in tests), each serving
 *   {@link serveJobs}. The pool's size is a setting; it holds no world state.
 * - **Priority.** Jobs wait in one {@link JobQueue} (edit, near, far, then
 *   distance) and go to a worker as one frees up; a queued job can be moved
 *   (the focus moved) or cancelled.
 * - **Back-pressure.** At most `maxQueued` jobs wait; past that a submit is
 *   answered `queue_full` at once, and `room()` tells a producer how many
 *   more it may queue, so a fast flight never queues the whole ring.
 * - **Timeouts.** A job not answered within `timeoutMs` of being sent is
 *   answered `timeout`; its late reply is ignored by id. The worker stays
 *   busy until it does reply, and one silent for `hangMs` is replaced.
 * - **Cancellation.** A queued job is dropped unsent; a sent one is answered
 *   `cancelled` at once and its reply ignored.
 *
 * Buffers in a job's transfer list move to the worker when it is sent (not
 * when it is queued), and the reply's buffers move back.
 */
import { JobQueue } from './job-queue';
import { STREAM_JOB_VERSION, type JobErrorCode, type JobLane, type JobReply, type JobRequest } from './stream-job';

/** One module worker as the pool drives it. */
export interface PoolWorker {
  post(message: JobRequest, transfer: ArrayBuffer[]): void;
  /** Registers the pool's listeners (called once per worker). */
  listen(onMessage: (data: unknown) => void, onError: (error: unknown) => void): void;
  terminate(): void;
}

/** A browser `Worker` (or anything with its event API) as a {@link PoolWorker}. */
export function eventTargetWorker(w: {
  postMessage(message: unknown, transfer: Transferable[]): void;
  addEventListener(type: 'message' | 'error', listener: (ev: Event) => void): void;
  terminate(): void;
}): PoolWorker {
  return {
    post: (m, t) => w.postMessage(m, t),
    listen: (onMessage, onError) => {
      w.addEventListener('message', (ev) => onMessage((ev as MessageEvent).data));
      w.addEventListener('error', (ev) => onError(ev));
    },
    terminate: () => w.terminate(),
  };
}

export interface WorkerPoolOptions {
  /** Workers (at least 1). */
  readonly size: number;
  /** Starts worker `index` (again, when one is replaced). */
  create(index: number): PoolWorker;
  /** A sent job not answered within this is answered `timeout`. */
  readonly timeoutMs: number;
  /** A worker silent this long on a sent job is replaced (default 4 × timeoutMs). */
  readonly hangMs?: number;
  /** Jobs that may wait (back-pressure). */
  readonly maxQueued: number;
  /** Jobs sent to one worker before its first answer (default 1). */
  readonly perWorker?: number;
}

export interface PoolJob {
  readonly id: number;
  readonly kind: string;
  readonly lane: JobLane;
  readonly distance: number;
  readonly input: unknown;
  readonly transfer: ArrayBuffer[];
}

export type JobOutcome<O = unknown> =
  | { readonly status: 'done'; readonly output: O; readonly workerUs: number; readonly queueMs: number; readonly runMs: number }
  | { readonly status: 'cancelled' | 'timeout' | 'queue_full' | 'worker_lost' }
  | { readonly status: JobErrorCode; readonly message: string };

/** Samples kept per series (the newest; older ones are overwritten). */
const SAMPLES = 8192;

/** A bounded series of samples. */
export class SampleRing {
  private readonly a = new Float64Array(SAMPLES);
  private n = 0;
  add(v: number): void {
    this.a[this.n % SAMPLES] = v;
    this.n++;
  }
  get count(): number {
    return this.n;
  }
  /** The kept samples, sorted. */
  sorted(): Float64Array {
    return this.a.slice(0, Math.min(this.n, SAMPLES)).sort();
  }
  /** Quantile q (0 … 1) of the kept samples, NaN when empty. */
  quantile(q: number): number {
    const s = this.sorted();
    return s.length === 0 ? NaN : s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
  }
  clear(): void {
    this.n = 0;
  }
}

export interface PoolStats {
  submitted: number;
  done: number;
  failed: number;
  queueFull: number;
  cancelledQueued: number;
  cancelledSent: number;
  timeouts: number;
  /** Replies that came for a job no longer live (cancelled, timed out). */
  lateReplies: number;
  replaced: number;
  /** Milliseconds from submit to send, send to answer; worker microseconds per job. */
  readonly queueMs: SampleRing;
  readonly runMs: SampleRing;
  readonly workerUs: SampleRing;
}

interface Pending {
  readonly job: PoolJob;
  readonly resolve: (o: JobOutcome) => void;
  readonly queuedAt: number;
  sentAt: number;
  worker: number;
  /** Answered already (timed out or cancelled): a reply now is ignored. */
  settled: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  hang: ReturnType<typeof setTimeout> | null;
}

interface Slot {
  worker: PoolWorker;
  /** Jobs sent and not yet replied to (including settled ones still running). */
  readonly sent: Set<number>;
  generation: number;
}

export class WorkerPool {
  private readonly opts: Required<WorkerPoolOptions>;
  private readonly queue = new JobQueue<Pending>();
  private readonly live = new Map<number, Pending>();
  private readonly slots: Slot[] = [];
  private closed = false;
  readonly stats: PoolStats = {
    submitted: 0,
    done: 0,
    failed: 0,
    queueFull: 0,
    cancelledQueued: 0,
    cancelledSent: 0,
    timeouts: 0,
    lateReplies: 0,
    replaced: 0,
    queueMs: new SampleRing(),
    runMs: new SampleRing(),
    workerUs: new SampleRing(),
  };

  constructor(opts: WorkerPoolOptions) {
    if (!Number.isInteger(opts.size) || opts.size < 1) throw new RangeError(`pool size ${opts.size}`);
    if (!(opts.timeoutMs > 0) || !Number.isInteger(opts.maxQueued) || opts.maxQueued < 1) throw new RangeError('pool timeout and queue bound must be positive');
    this.opts = { hangMs: opts.timeoutMs * 4, perWorker: 1, ...opts };
    for (let i = 0; i < opts.size; i++) this.slots.push(this.start(i, 0));
  }

  private start(index: number, generation: number): Slot {
    const worker = this.opts.create(index);
    const slot: Slot = { worker, sent: new Set(), generation };
    worker.listen(
      (data) => {
        if (this.slots[index] === slot) this.reply(index, data);
      },
      () => {
        if (this.slots[index] === slot) this.replace(index);
      },
    );
    return slot;
  }

  /** Jobs waiting. */
  get queued(): number {
    return this.queue.size;
  }

  /** Jobs sent and not yet answered (timed-out jobs still running not counted). */
  get inFlight(): number {
    let n = 0;
    for (const s of this.slots) for (const id of s.sent) if (this.live.get(id)?.settled === false) n++;
    return n;
  }

  /** How many more jobs may be queued now. */
  room(): number {
    return Math.max(0, this.opts.maxQueued - this.queue.size);
  }

  /** Whether a job is queued or sent and not yet answered. */
  isLive(id: number): boolean {
    const p = this.live.get(id);
    return p !== undefined && !p.settled;
  }

  /** Queues a job; the promise is its outcome (never rejected). */
  submit<O = unknown>(job: PoolJob): Promise<JobOutcome<O>> {
    if (this.closed) return Promise.resolve({ status: 'worker_lost' });
    if (this.live.has(job.id)) throw new RangeError(`job ${job.id} is already live`);
    if (this.queue.size >= this.opts.maxQueued) {
      this.stats.queueFull++;
      return Promise.resolve({ status: 'queue_full' });
    }
    this.stats.submitted++;
    return new Promise<JobOutcome<O>>((resolve) => {
      const p: Pending = { job, resolve: resolve as (o: JobOutcome) => void, queuedAt: performance.now(), sentAt: 0, worker: -1, settled: false, timer: null, hang: null };
      this.live.set(job.id, p);
      this.queue.push(job.id, job.lane, job.distance, p);
      this.pump();
    });
  }

  /** Moves a queued job to a new lane and distance; false when it is not queued. */
  reprioritize(id: number, lane: JobLane, distance: number): boolean {
    return this.queue.update(id, lane, distance);
  }

  /** Cancels a job: a queued one is dropped unsent, a sent one answered now (its reply is ignored). */
  cancel(id: number): boolean {
    const p = this.live.get(id);
    if (p === undefined || p.settled) return false;
    if (this.queue.remove(id) !== undefined) {
      this.live.delete(id);
      this.stats.cancelledQueued++;
    } else {
      this.stats.cancelledSent++;
    }
    this.settle(p, { status: 'cancelled' });
    return true;
  }

  private settle(p: Pending, o: JobOutcome): void {
    if (p.settled) return;
    p.settled = true;
    if (p.timer !== null) clearTimeout(p.timer);
    p.timer = null;
    p.resolve(o);
  }

  /** Sends queued jobs to workers with room. */
  private pump(): void {
    while (this.queue.size > 0) {
      let best = -1;
      for (let i = 0; i < this.slots.length; i++) {
        const n = this.slots[i]!.sent.size;
        if (n < this.opts.perWorker && (best < 0 || n < this.slots[best]!.sent.size)) best = i;
      }
      if (best < 0) return;
      const next = this.queue.pop()!;
      this.send(best, next.value);
    }
  }

  private send(index: number, p: Pending): void {
    const slot = this.slots[index]!;
    p.worker = index;
    p.sentAt = performance.now();
    this.stats.queueMs.add(p.sentAt - p.queuedAt);
    slot.sent.add(p.job.id);
    const req: JobRequest = { v: STREAM_JOB_VERSION, id: p.job.id, kind: p.job.kind, input: p.job.input };
    p.timer = setTimeout(() => {
      p.timer = null;
      if (p.settled) return;
      this.stats.timeouts++;
      this.settle(p, { status: 'timeout' });
    }, this.opts.timeoutMs);
    p.hang = setTimeout(() => {
      p.hang = null;
      if (this.slots[index] === slot && slot.sent.has(p.job.id)) this.replace(index);
    }, this.opts.hangMs);
    try {
      slot.worker.post(req, p.job.transfer);
    } catch (e) {
      this.finish(slot, p);
      this.stats.failed++;
      this.settle(p, { status: 'failed', message: e instanceof Error ? e.message : String(e) });
    }
  }

  /** Forgets a sent job on its worker. */
  private finish(slot: Slot, p: Pending): void {
    slot.sent.delete(p.job.id);
    this.live.delete(p.job.id);
    if (p.hang !== null) clearTimeout(p.hang);
    p.hang = null;
  }

  private reply(index: number, data: unknown): void {
    const r = data as Partial<JobReply>;
    if (typeof r !== 'object' || r === null || typeof r.id !== 'number') return;
    const slot = this.slots[index]!;
    const p = this.live.get(r.id);
    if (p === undefined || !slot.sent.has(r.id)) {
      this.stats.lateReplies++;
      return;
    }
    this.finish(slot, p);
    if (p.settled) this.stats.lateReplies++;
    else if (r.ok === true) {
      const now = performance.now();
      this.stats.done++;
      this.stats.runMs.add(now - p.sentAt);
      this.stats.workerUs.add(r.workerUs ?? 0);
      this.settle(p, { status: 'done', output: r.output, workerUs: r.workerUs ?? 0, queueMs: p.sentAt - p.queuedAt, runMs: now - p.sentAt });
    } else {
      this.stats.failed++;
      const e = r as { code?: JobErrorCode; message?: string };
      this.settle(p, { status: e.code ?? 'failed', message: e.message ?? '' });
    }
    this.pump();
  }

  /** Replaces a worker that crashed or hung; its unanswered jobs are answered `worker_lost`. */
  private replace(index: number): void {
    const slot = this.slots[index]!;
    this.stats.replaced++;
    try {
      slot.worker.terminate();
    } catch {
      // A worker that is already gone cannot be terminated again; it is replaced either way.
    }
    for (const id of [...slot.sent]) {
      const p = this.live.get(id);
      if (p === undefined) continue;
      this.finish(slot, p);
      this.settle(p, { status: 'worker_lost' });
    }
    if (this.closed) return;
    this.slots[index] = this.start(index, slot.generation + 1);
    this.pump();
  }

  /** Answers every job `cancelled` and ends the workers. */
  close(): void {
    this.closed = true;
    for (const p of [...this.live.values()]) {
      this.queue.remove(p.job.id);
      if (p.hang !== null) clearTimeout(p.hang);
      this.settle(p, { status: 'cancelled' });
    }
    this.live.clear();
    for (const s of this.slots) s.worker.terminate();
  }
}
