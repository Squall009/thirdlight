/**
 * The terrain erosion worker thread (built beside the backend bundle, `dist/backend/erosion-worker.mjs`):
 * one message `{id, grid, settings}` in, the eroded heights out, in order.
 * A large rectangle takes seconds to erode; here it never holds up the
 * backend's event loop (other commands, queries, the editor's socket).
 */
import { parentPort } from 'node:worker_threads';

import { erodeGrid, type ErosionGrid, type ErosionSettings } from '@thirdlight/workspace';

parentPort?.on('message', (m: { id: number; grid: ErosionGrid; settings: ErosionSettings }) => {
  const heights = m.grid.heights;
  erodeGrid({ ...m.grid, heights }, m.settings);
  parentPort!.postMessage({ id: m.id, heights }, [heights.buffer as ArrayBuffer]);
});
