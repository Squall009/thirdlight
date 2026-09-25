/**
 * Phase 22.1: a value computed by an editor-worker job from React state.
 *
 * The inputs are captured when the dependencies change; the job runs in the
 * worker (or inline, `editorWorkers()`), and its output becomes the value.
 * While a job runs, later inputs wait and only the newest runs next (a burst
 * of edits costs one job per result, never a queue of stale ones); a result
 * whose inputs were overtaken is dropped.
 */
import { useEffect, useRef, useState, type DependencyList } from 'react';

import { editorWorkers } from './editor-workers';
import type { JobTypes } from './jobs';

type ValueJob = 'graphIssues' | 'materialIssues';

interface JobState<I> {
  seq: number;
  running: boolean;
  next: { seq: number; input: I } | null;
  alive: boolean;
}

export function useWorkerJob<K extends ValueJob>(
  job: K,
  makeInput: () => JobTypes[K]['input'],
  inline: (input: JobTypes[K]['input']) => JobTypes[K]['output'],
  initial: Readonly<JobTypes[K]['output']>,
  deps: DependencyList,
): Readonly<JobTypes[K]['output']> {
  const [value, setValue] = useState<Readonly<JobTypes[K]['output']>>(initial);
  const state = useRef<JobState<JobTypes[K]['input']>>({ seq: 0, running: false, next: null, alive: true });
  useEffect(() => {
    const s = state.current;
    s.alive = true;
    return () => {
      s.alive = false;
    };
  }, []);
  useEffect(() => {
    const s = state.current;
    s.seq += 1;
    s.next = { seq: s.seq, input: makeInput() };
    const pump = async (): Promise<void> => {
      if (s.running) return;
      s.running = true;
      try {
        while (s.next !== null) {
          const { seq, input } = s.next;
          s.next = null;
          try {
            const out = await editorWorkers().run(job, () => ({ input }), { inline: () => inline(input) });
            if (s.alive && seq === s.seq) setValue(out);
          } catch (e) {
            console.warn(`[thirdlight] ${job} failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      } finally {
        s.running = false;
      }
    };
    void pump();
    // The caller's dependency list decides when the inputs changed.
  }, deps);
  return value;
}
