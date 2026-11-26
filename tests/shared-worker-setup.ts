/**
 * Setup for the unit files that share a worker (vitest.config.mts, project
 * `shared`). What a file leaves behind would reach the next file in the worker,
 * so after each file:
 * - esbuild's service process stops. A file that compiles scripts or exports
 *   starts it; in a fresh process a file it died with the file, in a shared
 *   worker it stayed (about 650 MB each, one per worker) and helped push a run
 *   past its memory cap. esbuild starts it again by itself on its next call.
 * - timers are real again and stubbed globals and environment variables are
 *   restored, in case a file faked or stubbed them without undoing it.
 */
import { afterAll, vi } from 'vitest';

afterAll(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  const esbuild = await import('esbuild');
  await esbuild.stop();
});
