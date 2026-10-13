import { describe, expect, it } from 'vitest';

import { FetchGate } from './fetch-gate';

/** A task that finishes when told to, recording when it started. */
function held(started: string[], name: string): { task: () => Promise<string>; finish: () => void } {
  let finish: () => void = () => undefined;
  const done = new Promise<void>((r) => (finish = r));
  return {
    task: async () => {
      started.push(name);
      await done;
      return name;
    },
    finish: () => finish(),
  };
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('FetchGate', () => {
  it('runs at most max tasks at once, the rest in the order they came', async () => {
    const gate = new FetchGate(2);
    const started: string[] = [];
    const tasks = ['a', 'b', 'c', 'd'].map((n) => held(started, n));
    const results = tasks.map((t) => gate.run(t.task));
    await tick();
    expect(started).toEqual(['a', 'b']);
    expect(gate.load).toEqual({ running: 2, waiting: 2 });
    tasks[1]!.finish();
    await tick();
    expect(started).toEqual(['a', 'b', 'c']);
    tasks[0]!.finish();
    await tick();
    expect(started).toEqual(['a', 'b', 'c', 'd']);
    tasks[2]!.finish();
    tasks[3]!.finish();
    expect(await Promise.all(results)).toEqual(['a', 'b', 'c', 'd']);
    expect(gate.load).toEqual({ running: 0, waiting: 0 });
  });

  it('a failed task gives its place to the next', async () => {
    const gate = new FetchGate(1);
    const failed = gate.run(() => Promise.reject(new Error('no')));
    const next = gate.run(() => Promise.resolve('ok'));
    await expect(failed).rejects.toThrow('no');
    expect(await next).toBe('ok');
    expect(gate.load).toEqual({ running: 0, waiting: 0 });
  });
});
