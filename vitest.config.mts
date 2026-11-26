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
 *
 * Two projects, by isolation. Half of the suite's time was each file
 * evaluating the same package graph again in a fresh process (project-model
 * alone about 0.45 s a file). The `shared` project runs files without
 * isolation, so a worker evaluates that graph once; it holds the packages
 * whose tests are in-memory and leave no process state behind. The
 * `isolated` project keeps a fresh process a file for everything that starts
 * backends or child processes, writes roots and signal handlers, or builds
 * bench worlds: run unisolated, those workers kept every file's worlds and
 * servers and the run reached 12 GB in 85 s. A file that fails only without
 * isolation moves to ISOLATED_FILES (named, with the reason), never to a
 * rerun.
 *
 * TL_UNIT_SET picks a part of the suite: `fast` leaves out the slow unit
 * files (tests/slow-unit-files.json; `tools/gate.sh check` runs this set),
 * `slow` runs only them, unset runs everything. Agent worktrees under
 * .claude/ are never collected.
 */
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { slowUnitFiles } from './tools/check-slow-units.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const UNIT_SET = process.env['TL_UNIT_SET'] ?? 'all';
if (!['all', 'fast', 'slow'].includes(UNIT_SET)) throw new Error(`TL_UNIT_SET=${UNIT_SET}: use fast, slow or leave it unset`);
const slow: string[] = UNIT_SET === 'all' ? [] : slowUnitFiles();

/** Folders whose files keep a fresh process each. */
// The bench builds real-scale worlds: sharing its workers bought no time (146 s against 147 s) and kept their
// memory, taking the run to its 12 GB cap.
const ISOLATED_DIRS = ['tests/crash/', 'tools/voxel-bench/'];
/** Files elsewhere that keep isolation, each with why. */
const ISOLATED_FILES: string[] = [
  // vi.mock of a module the worker has already loaded for an earlier file does not take.
  'tests/authoring-rules.test.ts',
  'packages/three-adapter/src/environment-nodes.test.ts',
  // Fakes `performance`, the clock wallClock() reads; the two profiler files below failed after it in one worker.
  'packages/three-adapter/src/clipped-decals.test.ts',
  // Failed only when sharing a worker (their spans lost their order and times); cause not traced further.
  'packages/shared/src/profiler.test.ts',
  'packages/game-host/src/profile-view.test.ts',
  // Failed only when sharing a worker (no unit marked, no bounce, a room's probes dark); old probe lighting, cause
  // not traced.
  'packages/three-adapter/src/surface-relight.test.ts',
  'packages/three-adapter/src/surface-probes.test.ts',
  // Compare shader programs with stored digests: three numbers its nodes from a counter the whole process shares, so
  // the files run before them change the programs' text.
  'packages/three-adapter/src/mesh-decals.test.ts',
  'packages/three-adapter/src/projected-decals.test.ts',
  'packages/three-adapter/src/see-through.test.ts',
  // Its stale-result test needs the pool's derive replies to come after the second edit's; in a shared worker they
  // came first once (no stale result). The order is not fixed by the test.
  'tools/voxel-bench/stream.test.ts',
];
const TEST_NAME = /\.(test|spec)\.[cm]?[jt]sx?$/;
const EXCLUDE = ['**/node_modules/**', '**/dist/**', 'archive/**', '.claude/**', ...(UNIT_SET === 'fast' ? slow : [])];
const isolated = (f: string): boolean => ISOLATED_DIRS.some((d) => f.startsWith(d)) || ISOLATED_FILES.includes(f);
/** Every unit test file, listed, so each lands in exactly one project (an exclude glob cannot give one file back). */
const allFiles: string[] = ['packages', 'tools', 'tests'].flatMap((top) =>
  (readdirSync(join(ROOT, top), { recursive: true }) as string[])
    .map((f) => `${top}/${f}`)
    .filter((f) => TEST_NAME.test(f) && !/(^|\/)(node_modules|dist)\//.test(f)),
);
const inSet = (f: string): boolean => (UNIT_SET === 'slow' ? slow.includes(f) : UNIT_SET === 'fast' ? !slow.includes(f) : true);

const common = {
  testTimeout: 30_000,
  hookTimeout: 30_000,
  globalSetup: './tests/test-hygiene.ts',
  globalTeardown: './tests/test-hygiene.ts',
  env: { THIRDLIGHT_CHECK_OP_RECORDS: '1' },
};

export default {
  test: {
    ...common,
    exclude: EXCLUDE,
    projects: [
      { test: { ...common, name: 'shared', isolate: false, setupFiles: ['./tests/shared-worker-setup.ts'], include: allFiles.filter((f) => !isolated(f) && inSet(f)), exclude: EXCLUDE } },
      { test: { ...common, name: 'isolated', include: allFiles.filter((f) => isolated(f) && inSet(f)), exclude: EXCLUDE } },
    ],
  },
};
