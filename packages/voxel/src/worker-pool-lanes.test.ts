import { describe, expect, it } from 'vitest';

import type { JobLane, JobRequest } from './stream-job';
import { LANE_QUEUE_SHARES, WorkerPool, type PoolWorker } from './worker-pool';

/** One worker that answers only when told, so the queue holds what was submitted. */
function heldWorker(): { create: () => PoolWorker; answer: () => number | null; sent: number[] } {
  const sent: number[] = [];
  let reply: ((d: unknown) => void) | null = null;
  let waiting: number | null = null;
  return {
    sent,
    create: () => ({
      post: (m: JobRequest) => {
        sent.push(m.id);
        waiting = m.id;
      },
      listen: (onMessage) => {
        reply = onMessage;
      },
      terminate: () => undefined,
    }),
    answer: () => {
      const id = waiting;
      if (id === null) return null;
      waiting = null;
      reply!({ v: 1, id, ok: true, output: null, workerUs: 1 });
      return id;
    },
  };
}

describe('the pool queue keeps room for the lanes before the far one', () => {
  it('lets the far lane, with the mip lane, fill three quarters; near work still queues, goes first, and nothing queued starves', async () => {
    const w = heldWorker();
    const pool = new WorkerPool({ size: 1, create: w.create, timeoutMs: 60_000, maxQueued: 16 });
    let id = 0;
    const done: Array<{ id: number; lane: JobLane }> = [];
    const submit = (lane: JobLane, distance: number): void => {
      const job = ++id;
      void pool.submit({ id: job, kind: 'derive', lane, distance, input: null, transfer: [] }).then((o) => {
        if (o.status === 'done') done.push({ id: job, lane });
      });
    };
    // The one worker takes the first job; the rest wait. Mip-lane producers queue a few, far-lane ones while they have room.
    submit('mip', 0);
    for (let i = 0; i < 4; i++) submit('mip', id);
    expect(pool.room('mip')).toBe(16 * LANE_QUEUE_SHARES.mip - 4);
    expect(pool.room('far')).toBe(16 * LANE_QUEUE_SHARES.far - 4);
    while (pool.room('far') > 0) submit('far', id);
    expect(pool.queuedIn('far')).toBe(8);
    expect([pool.room('far'), pool.room('near'), pool.room()]).toEqual([0, 4, 4]);
    // The near field's work still has room, and is sent before every coarser job already waiting.
    for (let i = 0; i < 4; i++) submit('near', 100 + i);
    expect(pool.room('near')).toBe(0);
    const nearIds = [id - 3, id - 2, id - 1, id];
    for (let k = 0; k < 4; k++) {
      w.answer();
      await Promise.resolve();
    }
    expect(w.sent.slice(1, 5)).toEqual(nearIds);
    // A queued far job moved into the near ring counts in its new lane.
    const far = id - 4;
    expect(pool.reprioritize(far, 'near', 0)).toBe(true);
    expect(pool.queuedIn('far')).toBe(7);
    // Drained: every job queued was answered, the coarse ones too.
    while (w.answer() !== null) await Promise.resolve();
    expect(done.length).toBe(id);
    expect(done.filter((d) => d.lane === 'mip').length).toBe(5);
    expect([pool.queuedIn('mip'), pool.queuedIn('far'), pool.queuedIn('near'), pool.queued]).toEqual([0, 0, 0, 0]);
    pool.close();
  });
});
