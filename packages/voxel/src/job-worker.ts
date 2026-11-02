/**
 * The worker side of the job pool: answers job messages with the handler
 * registered for their kind.
 *
 * It talks to an endpoint with `addEventListener('message')` and
 * `postMessage(message, transfer)`: a browser module worker's global scope
 * (`self`) and Node's `worker_threads` `parentPort` both are one, so one
 * worker module serves exported games, the editor and the Node tests, with
 * no Node built-in imported here (the Node entry imports `parentPort`
 * itself and passes it in).
 *
 * Every reply names its job id, so the pool can ignore a reply that comes
 * after the job was cancelled or timed out. A handler that throws becomes a
 * `failed` reply (a `RangeError` from a check: `refused`); the worker
 * keeps serving.
 */
import { STREAM_JOB_VERSION, type JobErrorCode, type JobReply, type JobRequest } from './stream-job';

/** What a worker posts to and listens on. */
export interface JobEndpoint {
  addEventListener(type: 'message', listener: (ev: { readonly data: unknown }) => void): void;
  postMessage(message: unknown, transfer: ArrayBuffer[]): void;
}

/** A handler's result: its output and the buffers to move with it. */
export interface JobResult {
  readonly output: unknown;
  readonly transfer: ArrayBuffer[];
}

export type JobHandler = (input: unknown) => JobResult | Promise<JobResult>;

/** Handlers by job kind. */
export type JobHandlers = Readonly<Record<string, JobHandler>>;

/** Errors that mean the job's input was refused by a check (as opposed to the handler failing). */
const REFUSALS: ReadonlySet<string> = new Set(['RangeError', 'EditRefused', 'RegionChunkError', 'SaveFileError']);

function isRequest(m: unknown): m is JobRequest {
  if (typeof m !== 'object' || m === null) return false;
  const r = m as Partial<JobRequest>;
  return typeof r.v === 'number' && typeof r.id === 'number' && typeof r.kind === 'string';
}

/** Serves jobs on `endpoint` until the worker ends; jobs run one after another in arrival order. */
export function serveJobs(endpoint: JobEndpoint, handlers: JobHandlers): void {
  let chain: Promise<void> = Promise.resolve();
  endpoint.addEventListener('message', (ev) => {
    const m = ev.data;
    chain = chain.then(() => run(endpoint, handlers, m));
  });
}

async function run(endpoint: JobEndpoint, handlers: JobHandlers, m: unknown): Promise<void> {
  const t0 = performance.now();
  if (!isRequest(m)) return;
  const fail = (code: JobErrorCode, message: string): void => {
    const reply: JobReply = { v: STREAM_JOB_VERSION, id: m.id, ok: false, code, message, workerUs: (performance.now() - t0) * 1000 };
    endpoint.postMessage(reply, []);
  };
  if (m.v !== STREAM_JOB_VERSION) return fail('version', `job message version ${m.v}, this worker speaks ${STREAM_JOB_VERSION}`);
  const handler = Object.prototype.hasOwnProperty.call(handlers, m.kind) ? handlers[m.kind] : undefined;
  if (handler === undefined) return fail('unknown_kind', `no handler for job kind ${m.kind}`);
  let result: JobResult;
  try {
    result = await handler(m.input);
  } catch (e) {
    return fail(e instanceof Error && REFUSALS.has(e.name) ? 'refused' : 'failed', e instanceof Error ? e.message : String(e));
  }
  const reply: JobReply = { v: STREAM_JOB_VERSION, id: m.id, ok: true, output: result.output, workerUs: (performance.now() - t0) * 1000 };
  endpoint.postMessage(reply, result.transfer);
}
