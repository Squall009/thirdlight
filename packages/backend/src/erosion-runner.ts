/**
 * Terrain erosion off the backend's event loop: an `editTerrain` erode's
 * grid is eroded on a worker thread (`erosion-worker.ts`) before the command
 * runs, and the command takes the result (matched by its input's digest).
 * Run from source (tests), it erodes in this thread; either way the result
 * is the same to the bit (`erodeGrid` is deterministic).
 */
import { Worker } from 'node:worker_threads';

import { erodeGrid, type ErosionGrid, type ErosionSettings } from '@thirdlight/workspace';
import type { WorkspaceService } from '@thirdlight/workspace';

export interface ErosionRunner {
  /** Erode an erode command's grid ahead of it (nothing when its args do not make one; the command then says why). */
  prepare(service: WorkspaceService, projectId: string, args: Record<string, unknown>): Promise<void>;
}

/** Milliseconds an idle worker is kept before it is stopped. */
const IDLE_MS = 30_000;

export function createErosionRunner(workerUrl: URL | null): ErosionRunner {
  let worker: Worker | null = null;
  let serial = 0;
  let idle: ReturnType<typeof setTimeout> | null = null;
  const waiting = new Map<number, { resolve: (h: Float64Array) => void; reject: (e: Error) => void }>();
  const start = (url: URL): Worker => {
    const w = new Worker(url);
    w.on('message', (m: { id: number; heights: Float64Array }) => {
      const p = waiting.get(m.id);
      waiting.delete(m.id);
      p?.resolve(m.heights);
    });
    w.on('error', (e) => {
      for (const p of waiting.values()) p.reject(e);
      waiting.clear();
      worker = null;
    });
    w.unref();
    return w;
  };
  const erode = (grid: ErosionGrid, settings: ErosionSettings): Promise<Float64Array> => {
    if (workerUrl === null) {
      const heights = grid.heights.slice();
      erodeGrid({ ...grid, heights }, settings);
      return Promise.resolve(heights);
    }
    if (idle !== null) clearTimeout(idle);
    worker ??= start(workerUrl);
    const id = ++serial;
    const heights = grid.heights.slice();
    return new Promise<Float64Array>((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      worker!.postMessage({ id, grid: { ...grid, heights }, settings }, [heights.buffer as ArrayBuffer]);
    }).finally(() => {
      if (waiting.size > 0) return;
      idle = setTimeout(() => {
        void worker?.terminate();
        worker = null;
      }, IDLE_MS);
      idle.unref();
    });
  };
  return {
    async prepare(service, projectId, args) {
      const work = service.erosionWork(projectId, args);
      if (work === null) return;
      try {
        service.prepareErosion(projectId, work.key, await erode(work.grid, work.settings));
      } catch {
        // A worker that failed leaves the command to erode in process.
      }
    },
  };
}
