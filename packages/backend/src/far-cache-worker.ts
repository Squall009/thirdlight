/**
 * The voxel far cache worker thread (built beside the backend bundle,
 * `dist/backend/far-cache-worker.mjs`): one job a message, a whole far
 * cache built into a fresh folder or an edit's ancestors built again in
 * place, answered when it is on disk. A mountain world's full build takes
 * minutes and an edit's rebuild a few hundred milliseconds; here neither
 * holds up the backend's event loop.
 */
import { parentPort } from 'node:worker_threads';

import { buildFarCacheInto, rebuildFarCache } from '@thirdlight/workspace';

import type { FarCacheTask } from './far-cache-runner';

parentPort?.on('message', (t: FarCacheTask) => {
  void (async () => {
    try {
      if (t.kind === 'build') {
        await buildFarCacheInto(t.worldDir, t.fresh);
        parentPort!.postMessage({ id: t.id, ok: true });
      } else {
        parentPort!.postMessage({
          id: t.id,
          ok: true,
          report: rebuildFarCache(t.worldDir, t.cacheDir, t.chunks),
        });
      }
    } catch (e) {
      parentPort!.postMessage({
        id: t.id,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  })();
});
