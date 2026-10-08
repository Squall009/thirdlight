/**
 * Rule scatter's instance sets made off the page's main thread: a group's
 * copies of one rule (tens of thousands in a dense forest) split into
 * chunks, every copy's matrix per mesh of its model, the bounds and what
 * the per-copy levels read (`instance-prepare.ts`). The page only makes the
 * draws from the answer's arrays, which are handed over, not copied.
 *
 * It runs in the view's worker script beside the block mesher, terrain
 * packer and ground cover generator, on a worker of its own; the page makes
 * the same arithmetic itself when no worker can run.
 *
 * This module imports no three.js: the worker bundle stays small.
 */
import { prepareInstanceSet, preparedBuffers, type PreparedInstanceSet, type PrepareOptions, type PrepareParts } from './instance-prepare';

/** Page → worker: one set's copies (handed over) and its model's meshes. */
export interface ScatterPrepareRequest {
  readonly t: 'scatterPrepare';
  readonly job: number;
  readonly floats: Float32Array;
  readonly count: number;
  readonly parts: PrepareParts;
  readonly options: PrepareOptions;
}

/** Worker → page. The copies come back with the arithmetic (the page keeps them for the set's near shadows). */
export type ScatterPrepareReply =
  | { readonly t: 'scatterPrepared'; readonly job: number; readonly ok: true; readonly prepared: PreparedInstanceSet; readonly floats: Float32Array; readonly ms: number }
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
    const prepared = prepareInstanceSet(req.floats, req.count, req.parts, req.options);
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
    endpoint.post(reply, reply.ok ? [...preparedBuffers(reply.prepared), reply.floats.buffer as ArrayBuffer] : undefined);
  });
}
