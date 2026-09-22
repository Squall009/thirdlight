/**
 * Root vitest configuration.
 *
 * The suite's only non-default: global test-root hygiene. Disposable test
 * roots live on ext4 under /home/dadmin (/tmp is tmpfs); in-process cleanup
 * never runs when a run is killed by a signal, so tests/test-hygiene.ts
 * reaps stale roots in globalSetup/globalTeardown instead. Everything else
 * stays at vitest defaults (npm test is plain `vitest run`).
 */
export default {
  test: {
    globalSetup: './tests/test-hygiene.ts',
    globalTeardown: './tests/test-hygiene.ts',
    exclude: ['**/node_modules/**', '**/dist/**', 'archive/**'],
  },
};