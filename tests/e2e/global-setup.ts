/**
 * Playwright globalSetup: sweep stale temp residue (killed runs' e2e backends,
 * exports, Vitest module copies) before the browser tests start.
 */
import { sweepStaleTmp } from '../tmp-sweep';

export default function globalSetup(): void {
  const removed = sweepStaleTmp();
  if (removed > 0) console.log(`[test-hygiene] reaped ${removed} stale temp dir(s)`);
}
