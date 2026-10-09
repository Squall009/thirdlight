/**
 * Performance marks the engine leaves for its tools (the perf harness and
 * the e2e tests read them from the timeline: node builds, chunks made,
 * tiles streamed). The timeline keeps every mark until it is cleared, and a
 * shipped game makes them too, so a long session's marks would grow
 * without bound: each name keeps at most {@link PERF_MARKS_KEPT}, its older
 * ones cleared when it passes that (far more than any tool reads in one
 * window).
 */

/** Marks of one name kept on the timeline before they are cleared. */
export const PERF_MARKS_KEPT = 4096;

const made = new Map<string, number>();

/** Leave a mark named `name` (with `detail`, when given) on the page's timeline. */
export function perfMark(name: string, detail?: unknown): void {
  const perf = globalThis.performance;
  if (typeof perf?.mark !== 'function') return;
  const n = (made.get(name) ?? 0) + 1;
  if (n > PERF_MARKS_KEPT && typeof perf.clearMarks === 'function') {
    perf.clearMarks(name);
    made.set(name, 1);
  } else made.set(name, n);
  if (detail === undefined) perf.mark(name);
  else perf.mark(name, { detail });
}
