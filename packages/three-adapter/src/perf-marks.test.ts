import { describe, expect, it } from 'vitest';

import { PERF_MARKS_KEPT, perfMark } from './perf-marks';

describe('perf marks', () => {
  it('keep each name bounded on the timeline, the newest with their detail', () => {
    const name = 'tl:test:bounded';
    for (let i = 0; i < PERF_MARKS_KEPT * 2 + 10; i++) perfMark(name, { i });
    const marks = performance.getEntriesByName(name, 'mark') as PerformanceMark[];
    expect(marks.length).toBeGreaterThan(0);
    expect(marks.length).toBeLessThanOrEqual(PERF_MARKS_KEPT);
    expect(marks.at(-1)!.detail).toEqual({ i: PERF_MARKS_KEPT * 2 + 9 });
    performance.clearMarks(name);
  });
});
