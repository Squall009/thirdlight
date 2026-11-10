/**
 * The far world's worker (`worker_threads`): writes one region column of
 * the mountain test world (far-world.ts), or builds one region column's far
 * tree nodes from a world folder's region files (the workspace's
 * `farColumnNodes`), and answers with what it did. Columns are independent,
 * so a pool of these writes and builds a large world side by side.
 */
import { parentPort } from 'node:worker_threads';
import { farColumnNodes, FarWorldSource, runFarBakeFromCache, type FarBakeTask } from '@thirdlight/workspace';
import { writeFarWorldColumn, type FarWorldOptions } from './far-world';

export type FarWorkerTask =
  | { readonly id: number; readonly kind: 'world'; readonly gridDir: string; readonly rx: number; readonly rz: number; readonly opts: FarWorldOptions }
  | { readonly id: number; readonly kind: 'far'; readonly worldDir: string; readonly rx: number; readonly rz: number; readonly minLevel: number }
  | { readonly id: number; readonly kind: 'bake'; readonly task: FarBakeTask };

let source: FarWorldSource | null = null;

parentPort!.on('message', (t: FarWorkerTask) => {
  try {
    if (t.kind === 'world') {
      parentPort!.postMessage({ id: t.id, ok: true, result: writeFarWorldColumn(t.gridDir, t.rx, t.rz, t.opts) });
      return;
    }
    if (t.kind === 'bake') {
      const t0 = performance.now();
      const result = runFarBakeFromCache(t.task);
      parentPort!.postMessage({ id: t.id, ok: true, result, ms: performance.now() - t0 }, result.entries.flatMap((e) => ('stored' in e ? [e.stored.buffer as ArrayBuffer] : [])));
      return;
    }
    if (source === null || source.worldDir !== t.worldDir) source = new FarWorldSource(t.worldDir);
    const t0 = performance.now();
    const result = farColumnNodes(source, t.rx, t.rz, t.minLevel);
    const transfer: ArrayBuffer[] = [];
    for (const [, entries] of result.levels) for (const e of entries) if ('stored' in e) transfer.push(e.stored.buffer as ArrayBuffer);
    parentPort!.postMessage({ id: t.id, ok: true, result, ms: performance.now() - t0 }, transfer);
  } catch (e) {
    parentPort!.postMessage({ id: t.id, ok: false, error: e instanceof Error ? (e.stack ?? e.message) : String(e) });
  }
});
