/**
 * Root vitest configuration.
 *
 * Timeouts: 30 s for a test and a hook, not vitest's 5 s. The check runs the
 * suite on six workers on a shared host, and tests with real workers and files
 * on disk that take 3–4 s alone ran past 5 s under load. A test must not
 * assert wall-clock time; the limit only catches a hang.
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
 * isolation is isolated, never rerun: by its kind (ISOLATED_KINDS, read from
 * its text, so a new file of that kind is isolated too) or named
 * (ISOLATED_FILES, with the reason).
 *
 * TL_UNIT_SET picks a part of the suite: `fast` leaves out the slow unit
 * files (tests/slow-unit-files.json; `tools/gate.sh check` runs this set),
 * `slow` runs only them, unset runs everything. Agent worktrees under
 * .claude/ are never collected.
 */
import { readdirSync, readFileSync } from 'node:fs';
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
/**
 * Kinds of file that keep isolation by what they do, found in their text, so a file added or one archived (which
 * changes which files share a worker before another) cannot turn the check red: each kind once failed only because
 * of the files that ran before it in a shared worker.
 */
const ISOLATED_KINDS: readonly { readonly why: string; readonly is: (text: string) => boolean }[] = [
  {
    // three numbers its nodes from a counter the whole process shares, so the files run before change the programs' text.
    why: 'compares node programs (WGSL) with stored digests',
    is: (t) => /\b(SHADER_TYPE_WGSL|PLAIN_GRAPH_WGSL)\b/.test(t) || (/test-wgsl/.test(t) && /'[0-9a-f]{16}'/.test(t)),
  },
  {
    // Free space the files before left in Rapier's WASM heap, or their buffers not yet collected, absorb or add to a measure.
    why: 'measures memory the whole process shares',
    is: (t) => /physicsMemoryBytes3D\(|process\.memoryUsage\(/.test(t),
  },
  {
    why: 'vi.mock does not take on a module the worker already loaded for an earlier file',
    is: (t) => /\bvi\.(mock|doMock)\(/.test(t),
  },
];
/** Files elsewhere that keep isolation, each with why (their failure in a shared worker had no kind above). */
const ISOLATED_FILES: string[] = [
  // Fakes `performance`, the clock wallClock() reads; the two profiler files below failed after it in one worker.
  'packages/three-adapter/src/clipped-decals.test.ts',
  // Failed only when sharing a worker (their spans lost their order and times); cause not traced further.
  'packages/shared/src/profiler.test.ts',
  'packages/game-host/src/profile-view.test.ts',
  // Failed only when sharing a worker (no unit marked, no bounce); old probe lighting, cause not traced.
  'packages/three-adapter/src/surface-relight.test.ts',
  // Parses a document nested 4,000 deep, two frames a level: the strict JSON parser reads about 4,100 levels before the
  // stack ends while it is not yet compiled and about 8,400 once it is, so in a shared worker the answer was the
  // files before it. A process of its own starts the same way every run.
  'packages/workspace/src/corrupt-project-startup.test.ts',
];
const TEST_NAME = /\.(test|spec)\.[cm]?[jt]sx?$/;
const EXCLUDE = ['**/node_modules/**', '**/dist/**', 'archive/**', '.claude/**', ...(UNIT_SET === 'fast' ? slow : [])];
/** Every unit test file, listed, so each lands in exactly one project (an exclude glob cannot give one file back). */
const allFiles: string[] = ['packages', 'tools', 'tests'].flatMap((top) =>
  (readdirSync(join(ROOT, top), { recursive: true }) as string[])
    .map((f) => `${top}/${f}`)
    .filter((f) => TEST_NAME.test(f) && !/(^|\/)(node_modules|dist)\//.test(f)),
);
/** Files of an isolated kind (read once a run: the text of every unit file, a few milliseconds). */
const ofKind = new Set(allFiles.filter((f) => !ISOLATED_DIRS.some((d) => f.startsWith(d)) && ISOLATED_KINDS.some((k) => k.is(readFileSync(join(ROOT, f), 'utf8')))));
const isolated = (f: string): boolean => ISOLATED_DIRS.some((d) => f.startsWith(d)) || ISOLATED_FILES.includes(f) || ofKind.has(f);
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
