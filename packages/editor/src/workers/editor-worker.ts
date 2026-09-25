/**
 * Phase 22.1: the editor worker entry (bundled by tools/build.mjs as
 * dist/editor/editor-worker.js, loaded next to the editor page). It runs the
 * job table (`jobs.ts`) for the page: scatter, graph diagnostics, PNG
 * encoding and the browser lightmap bake on an OffscreenCanvas.
 */
import type { ToWorker } from './protocol';
import { createWorkerHost } from './worker-host';

interface WorkerScope {
  postMessage(message: unknown, transfer: Transferable[]): void;
  addEventListener(type: 'message', listener: (ev: MessageEvent) => void): void;
}

const scope = globalThis as unknown as WorkerScope;
const host = createWorkerHost((message, transfer) => scope.postMessage(message, transfer));
scope.addEventListener('message', (ev) => host.receive(ev.data as ToWorker));
scope.postMessage({ type: 'ready' }, []);
