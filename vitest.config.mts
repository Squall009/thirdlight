/**
 * Root vitest configuration.
 *
 * Timeouts: 30 s for a test and a hook, not vitest's 5 s. The gate runs the
 * suite on 4 workers beside browsers, and tests with real workers and files
 * on disk that take 3–4 s alone ran past 5 s there (failed once, passed
 * alone). A test must not assert wall-clock time; the limit only catches a hang.
 *
 * Global test-root hygiene: disposable test
 * roots live on ext4 under /home/dadmin (/tmp is tmpfs); in-process cleanup
 * never runs when a run is killed by a signal, so tests/test-hygiene.ts
 * reaps stale roots in globalSetup/globalTeardown instead. Every command a
 * test applies is held to the op table's declared records
 * (THIRDLIGHT_CHECK_OP_RECORDS, read by the commands package). Everything
 * else stays at vitest defaults (npm test is plain `vitest run`).
 */
export default {
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    globalSetup: './tests/test-hygiene.ts',
    globalTeardown: './tests/test-hygiene.ts',
    env: { THIRDLIGHT_CHECK_OP_RECORDS: '1' },
    exclude: ['**/node_modules/**', '**/dist/**', 'archive/**'],
  },
};