/**
 * Rule scatter's copies sets prepared off the page's main thread: a group's
 * copies of one rule (tens of thousands in a dense forest) put in compact
 * blocks and written as the texels the GPU reads (`copies-prepare.ts`). The
 * page only makes the set's textures and draws from the answer's arrays,
 * which are handed over, not copied.
 *
 * It runs in the view's worker script beside the block mesher, terrain
 * packer and ground cover generator, on a worker of its own; the page makes
 * the same arithmetic itself when no worker can run.
 *
 * This module imports no three.js: the worker bundle stays small.
 */
import { prepareCopies, preparedCopyBuffers, type CopyChunking, type PreparedCopies } from './copies-prepare';

/** Page → worker: one set's copies (handed over). */
export interface ScatterPrepareRequest {
  readonly t: 'scatterPrepare';
  readonly job: number;
  readonly floats: Float32Array;
  readonly count: number;
  readonly chunking: CopyChunking;
}

/** Worker → page. The copies come back with the arithmetic (the page keeps them: a copy's place is read from them when it is shown again). */
export type ScatterPrepareReply =
  | { readonly t: 'scatterPrepared'; readonly job: number; readonly ok: true; readonly prepared: PreparedCopies; readonly floats: Float32Array; readonly ms: number }
  | { readonly t: 'scatterPrepared'; readonly job: number; readonly ok: false; readonly message: string };

/** The endpoint a worker talks through (its global scope, or a port in tests). */
export interface ScatterEndpoint {
  post(message: unknown, transfer?: readonly ArrayBuffer[]): void;
  listen(onMessage: (message: unknown) => void): void;
}

/** Answer one request (also what the page runs when no worker can). */
export function answerScatterPrepare(req: ScatterPrepareRequest): ScatterPrepareReply {
  const t0 = performance.now();
  try {
    const prepared = prepareCopies(req.floats, req.count, req.chunking);
    return { t: 'scatterPrepared', job: req.job, ok: true, prepared, floats: req.floats, ms: performance.now() - t0 };
  } catch (e) {
    return { t: 'scatterPrepared', job: req.job, ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

/** Run the scatter preparer on an endpoint (beside the view worker's other parts on the same one: each ignores the others' messages). */
export function runScatterWorker(endpoint: ScatterEndpoint): void {
  endpoint.listen((raw) => {
    const m = raw as Partial<ScatterPrepareRequest> | null;
    if (m?.t !== 'scatterPrepare') return;
    const reply = answerScatterPrepare(m as ScatterPrepareRequest);
    endpoint.post(reply, reply.ok ? [...preparedCopyBuffers(reply.prepared), reply.floats.buffer as ArrayBuffer] : undefined);
  });
}
