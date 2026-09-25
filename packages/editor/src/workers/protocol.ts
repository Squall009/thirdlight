/**
 * Phase 22.1: the editor worker's message protocol.
 *
 * Page → worker: `run` (a job with an id; its buffers transferred) and
 * `cancel`. Worker → page: `ready` once (the script loaded), `progress`
 * while a job runs, then exactly one `done` or `failed` per job. Jobs run one
 * at a time per worker, in order.
 */
import type { JobName } from './jobs';

export type ToWorker = { type: 'run'; id: number; job: JobName; input: unknown } | { type: 'cancel'; id: number };

export type FromWorker =
  | { type: 'ready' }
  | { type: 'progress'; id: number; done: number; total: number }
  | { type: 'done'; id: number; output: unknown }
  | { type: 'failed'; id: number; message: string };

export function isFromWorker(v: unknown): v is FromWorker {
  if (typeof v !== 'object' || v === null) return false;
  const t = (v as { type?: unknown }).type;
  return t === 'ready' || t === 'progress' || t === 'done' || t === 'failed';
}
