/**
 * Phase 22.0: the browser ends of the simulation worker channel — a dedicated
 * `Worker` on the page side, the worker's own global on the other. (Node uses
 * worker_threads with the same `SimEndpoint` shape; see the integration tests.)
 */
import type { SimEndpoint, SimWorkerHandle } from './sim-protocol';

interface WorkerLike {
  postMessage(message: unknown, transfer?: unknown[]): void;
  addEventListener(type: string, listener: (event: { data?: unknown; message?: string; preventDefault?: () => void }) => void): void;
  terminate(): void;
}

/** Can this page start a dedicated worker at all? */
export function browserWorkerAvailable(): boolean {
  return typeof (globalThis as { Worker?: unknown }).Worker === 'function';
}

/** Start the simulation worker from its script URL (null: the browser refused). */
export function createBrowserSimWorker(url: string): SimWorkerHandle | null {
  const Ctor = (globalThis as { Worker?: new (url: string, options?: { name?: string }) => WorkerLike }).Worker;
  if (typeof Ctor !== 'function') return null;
  let w: WorkerLike;
  try {
    w = new Ctor(url, { name: 'thirdlight-simulation' });
  } catch {
    return null;
  }
  return {
    post: (message, transfer) => w.postMessage(message, transfer === undefined ? undefined : [...transfer]),
    listen: (onMessage) => w.addEventListener('message', (e) => onMessage(e.data)),
    terminate: () => w.terminate(),
    onError: (handler) => {
      w.addEventListener('error', (e) => {
        e.preventDefault?.();
        handler(typeof e.message === 'string' && e.message.length > 0 ? e.message : 'the worker script could not be loaded');
      });
      w.addEventListener('messageerror', () => handler('a message could not be read'));
    },
  };
}

/** Inside a dedicated worker: its global as the endpoint. */
export function workerGlobalEndpoint(): SimEndpoint {
  const self = globalThis as unknown as { postMessage(m: unknown, t?: unknown[]): void; addEventListener(type: string, l: (e: { data: unknown }) => void): void };
  return {
    post: (message, transfer) => self.postMessage(message, transfer === undefined ? undefined : [...transfer]),
    listen: (onMessage) => self.addEventListener('message', (e) => onMessage(e.data)),
  };
}
