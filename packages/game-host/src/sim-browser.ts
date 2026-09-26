/**
 * Phase 22.0: the browser ends of the simulation worker channel — a dedicated
 * `Worker` on the page side, the worker's own global on the other. (Node uses
 * worker_threads with the same `SimEndpoint` shape; see the integration tests.)
 */
import { PHYSICS_3D_GLOBAL, type Physics3DModule } from './physics-3d-global';
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

/**
 * Phase 23.0: load the 3D physics backend script (`physics-3d.js`, registered
 * on the global object — see `physics-3d-global.ts`) once: inside a worker
 * with `importScripts`, on a page with a script element. Only a project whose
 * `physics_dimension` is 3 calls it, so a 2D game never fetches the 3D WASM.
 */
export async function loadPhysics3D(url: string): Promise<Physics3DModule> {
  const g = globalThis as Record<string, unknown>;
  const registered = (): Physics3DModule | undefined => g[PHYSICS_3D_GLOBAL] as Physics3DModule | undefined;
  if (registered() !== undefined) return registered()!;
  const importScripts = (globalThis as { importScripts?: (u: string) => void }).importScripts;
  if (typeof importScripts === 'function') {
    importScripts(url);
  } else {
    const doc = (globalThis as { document?: { createElement(tag: string): Record<string, unknown>; head: { appendChild(n: unknown): void } } }).document;
    if (doc === undefined) throw new Error('the 3D physics backend needs a page or a worker to load in');
    await new Promise<void>((resolve, reject) => {
      const el = doc.createElement('script');
      el['src'] = url;
      el['onload'] = () => resolve();
      el['onerror'] = () => reject(new Error(`the 3D physics backend (${url}) could not be loaded`));
      doc.head.appendChild(el);
    });
  }
  const m = registered();
  if (m === undefined) throw new Error(`the 3D physics backend (${url}) did not register itself`);
  return m;
}
