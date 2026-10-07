/**
 * The page side of the block mesh workers (`block-mesh-worker.ts`): a small
 * pool of dedicated workers started on first use. Every worker gets every
 * change of the cells, types and models (each meshes any chunk); a chunk's
 * requests always go to the same worker, so a newer request for it reaches
 * the worker that holds the older one and supersedes it there.
 *
 * A worker that cannot start or fails takes the pool down: the block view
 * then meshes on the page, as it does without a worker script.
 */
import type { MeshEndpoint, MeshWorkerReply, MeshWorkerRequest } from './block-mesh-worker';

/** A worker as the pool uses it. */
export interface MeshWorkerPort extends MeshEndpoint {
  /** Called once if the worker cannot load or run (its script missing, an exception). */
  onError(handler: (message: string) => void): void;
  terminate(): void;
}

/** Makes one mesh worker (null: none can be made here). */
export type MeshWorkerFactory = () => MeshWorkerPort | null;

/**
 * At most this many mesh workers: the simulation worker, the page and the GPU
 * process want cores too, and each worker keeps its own copy of the cells.
 */
export const MESH_WORKERS_MAX = 2;

/** How many mesh workers to start on a machine with `cores` logical cores (the page and the simulation keep two). */
export const meshWorkerCount = (cores: number | undefined): number => Math.max(1, Math.min(MESH_WORKERS_MAX, (cores ?? 2) - 2));

interface WorkerLike {
  postMessage(message: unknown, transfer?: unknown[]): void;
  addEventListener(type: string, listener: (event: { data?: unknown; message?: string; preventDefault?: () => void }) => void): void;
  terminate(): void;
}

/** A dedicated browser worker running the view's worker script at `url` (null: no workers on this page); `name` shows in the browser's tools. */
export function createBrowserMeshWorker(url: string, name = 'thirdlight-block-mesher'): MeshWorkerPort | null {
  const Ctor = (globalThis as { Worker?: new (url: string, options?: { name?: string }) => WorkerLike }).Worker;
  if (typeof Ctor !== 'function') return null;
  let w: WorkerLike;
  try {
    w = new Ctor(url, { name });
  } catch {
    return null;
  }
  return {
    post: (message, transfer) => w.postMessage(message, transfer === undefined ? undefined : [...transfer]),
    listen: (onMessage) => w.addEventListener('message', (e) => onMessage(e.data)),
    onError: (handler) => {
      w.addEventListener('error', (e) => {
        e.preventDefault?.();
        handler(typeof e.message === 'string' && e.message.length > 0 ? e.message : 'the mesh worker script could not be loaded');
      });
      w.addEventListener('messageerror', () => handler('a mesh worker message could not be read'));
    },
    terminate: () => w.terminate(),
  };
}

export class MeshWorkerPool {
  private readonly workers: MeshWorkerPort[] = [];
  private failed = false;

  private constructor(private readonly onReply: (reply: MeshWorkerReply) => void, private readonly onFail: (message: string) => void) {}

  /** Start `count` workers (null: none could be made). */
  static start(create: MeshWorkerFactory, count: number, onReply: (reply: MeshWorkerReply) => void, onFail: (message: string) => void): MeshWorkerPool | null {
    const pool = new MeshWorkerPool(onReply, onFail);
    for (let i = 0; i < count; i++) {
      const w = create();
      if (w === null) break;
      w.listen((m) => {
        if (!pool.failed) pool.onReply(m as MeshWorkerReply);
      });
      w.onError((message) => pool.fail(message));
      pool.workers.push(w);
    }
    if (pool.workers.length === 0) return null;
    return pool;
  }

  get size(): number {
    return this.failed ? 0 : this.workers.length;
  }

  /** To every worker (cells, types, models). */
  broadcast(message: MeshWorkerRequest): void {
    if (this.failed) return;
    for (const w of this.workers) w.post(message);
  }

  /** To the worker that meshes this chunk. */
  send(message: Extract<MeshWorkerRequest, { t: 'mesh' | 'cancel' }>): void {
    if (this.failed) return;
    this.workers[workerOf(message.entityId, message.cx, message.cz, this.workers.length)]!.post(message);
  }

  dispose(): void {
    for (const w of this.workers) w.terminate();
    this.workers.length = 0;
    this.failed = true;
  }

  private fail(message: string): void {
    if (this.failed) return;
    this.dispose();
    this.onFail(message);
  }
}

/** A chunk's worker: the same one for every request of that chunk. */
function workerOf(entityId: string, cx: number, cz: number, count: number): number {
  let h = Math.imul(cx | 0, 0x9e3779b1) ^ Math.imul(cz | 0, 0x85ebca77);
  for (let i = 0; i < entityId.length; i++) h = Math.imul(h ^ entityId.charCodeAt(i), 0x01000193);
  return (h >>> 0) % count;
}
