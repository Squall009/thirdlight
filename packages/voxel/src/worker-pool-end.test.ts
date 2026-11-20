import { describe, expect, it } from 'vitest';

import { POOL_END_GRACE_MS, poolWorkersEnded, STREAM_POOL_SETTINGS, WorkerPool, type PoolWorker } from './worker-pool';

describe('a closed pool gives its workers time to end before the thread may go', () => {
  it('close terminates every worker, and poolWorkersEnded resolves only after the grace', async () => {
    let terminated = 0;
    const worker = (): PoolWorker => ({ post: () => undefined, listen: () => undefined, terminate: () => void terminated++ });
    const pool = new WorkerPool({ size: 3, create: worker, ...STREAM_POOL_SETTINGS });
    const t0 = performance.now();
    pool.close();
    expect(terminated).toBe(3);
    await poolWorkersEnded();
    // Timers may fire a millisecond early on some hosts.
    expect(performance.now() - t0).toBeGreaterThanOrEqual(POOL_END_GRACE_MS - 2);
    // Long after the last close there is nothing to wait for.
    const t1 = performance.now();
    await poolWorkersEnded();
    expect(performance.now() - t1).toBeLessThan(POOL_END_GRACE_MS);
  });
});
