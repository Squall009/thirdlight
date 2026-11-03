/**
 * A time two threads of one page can compare: the page's time origin plus
 * its monotonic clock, in milliseconds since the epoch. A worker's
 * `performance.now()` counts from the worker's own start, so a stamp sent
 * across a postMessage is read as wall time on both sides.
 */
export function wallClock(): number {
  return performance.timeOrigin + performance.now();
}
