/**
 * Test-run hygiene — reaper for disposable test roots.
 *
 * Why residue accumulated (owner-reported 2026-09-21: ~9,900 orphan roots
 * under /home/dadmin): every disposable root is cleaned up ONLY by
 * in-process mechanisms — per-test rmSync, afterAll hooks, and the
 * `process.on('exit')` backstops in packages/workspace/tests/helpers.ts and
 * tests/integration/m2-builds/helpers.ts. None of those run when the
 * process is killed by a signal (supervisor restart, orchestrator/model
 * timeout, Ctrl+C escalating to SIGKILL), so every killed run left every
 * root it had created behind, forever, and nothing ever reaped them.
 *
 * The fix is EXTERNAL reaping, wired in via vitest.config.mts
 * (globalSetup/globalTeardown): before a run starts and after it finishes,
 * stale disposable roots are removed here, outside any worker process.
 * Roots embed pid + timestamp, so a directory is never shared between
 * runs. Both sweeps only remove roots whose mtime is older than
 * MIN_AGE_MS: a root a live suite is still writing to stays fresh and is
 * never touched. (An age-0 teardown sweep was tried first and rejected —
 * it destroyed the in-flight roots of a concurrent run when an orphaned
 * earlier run finished during it, 2026-09-21.) SIGKILLed runs are
 * therefore reaped by the next `vitest` invocation, at latest, once their
 * roots are older than MIN_AGE_MS.
 *
 * Second garbage class: orphaned test CHILD processes. Crash/ownership/
 * integration tests spawn long-lived children (the `claim`-mode holder,
 * `contend-*` gate waiters, the real backend + MCP stdio children); the
 * parent worker kills them on the normal path, but a SIGKILLed worker
 * reparents them to pid 1 where they wait forever, holding the ownership
 * records of their (deleted) roots. 21 were found on 2026-09-21, the
 * oldest 3.5 days old. They are reaped the same way: a child is touched
 * only when it is orphaned (ppid == 1) AND its command line references one
 * of the disposable bundle directories below. A live run's children are
 * attached to their live worker (ppid != 1) and are never touched.
 *
 * DISPOSABLE_PREFIXES is the COMPLETE set of disposable prefixes the suite
 * creates under ROOT_BASE (each comment names its creation site). Prefixes
 * under /tmp (tl-m3-export-, tl-br-export-, tl-m3-chrome-) are out of
 * scope: /tmp is ephemeral and those files never use ROOT_BASE.
 */
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Roots newer than this are never touched: a live suite (this run's own
 * workers, or — under the single-run protocol — any other run) keeps its
 * active roots' mtimes fresh. Killed runs' residue becomes reapable
 * MIN_AGE_MS after the kill. */
const MIN_AGE_MS = 60_000;

/** Same rule the test files themselves use: /home/dadmin when /tmp is tmpfs. */
export const ROOT_BASE: string = tmpdir() === '/tmp' ? '/home/dadmin' : tmpdir();

/** Disposable prefixes (keep in sync with the makeRoot/mkdtemp sites). */
export const DISPOSABLE_PREFIXES: readonly string[] = [
  // packages/workspace/tests/helpers.ts, tests/integration/m2-builds/helpers.ts,
  // packages/workspace/src/repair-2026-09-18-a1.test.ts / -a2.test.ts
  '.tl07-tmp-',
  // tests/crash-recovery.test.ts (roots + `.tl07-crash-bundle-` scratch)
  '.tl07-crash-',
  // tests/m2-crash.test.ts (roots + `.tl23-crash-bundle-` scratch)
  '.tl23-crash-',
  // tests/crash/m3-storage-crash.test.ts (roots + `.tl46-crash-bundle-` scratch)
  '.tl46-crash-',
  // tests/ownership-claim-2026-09-18.test.ts (roots + `.tl07e1-bundle-` scratch)
  '.tl07e1-crash-',
  '.tl07e1-bundle-',
  // tests/integration/m2-content/harness.ts
  '.tl25-',
  // tests/integration/m2-play/harness.ts
  '.tl35-',
  // tests/integration/m2-export/harness.ts
  '.tl36-serve-',
  // tests/integration/m3-content/harness.ts
  '.tl48-',
];

/** Command-line signatures of disposable test CHILD processes (bundle paths
 * they are spawned from). Home-rooted crash children + repo-rooted
 * integration backend/MCP children (keep in sync with the bundle dirs in
 * the tests/integration harness files). */
const CHILD_SIGNATURES: readonly string[] = [
  '.tl07-crash-bundle-', // tests/crash-recovery.test.ts (claim holder)
  '.tl23-crash-bundle-', // tests/m2-crash.test.ts
  '.tl46-crash-bundle-', // tests/crash/m3-storage-crash.test.ts
  '.tl07e1-bundle-', // tests/ownership-claim-2026-09-18.test.ts (contend-* waiters)
  '.tl25-bundles/', // tests/integration/m2-content/harness.ts (backend + MCP children)
  '.tl35-bundles/', // tests/integration/m2-play/harness.ts
  '.tl48-bundles/', // tests/integration/m3-content/harness.ts
];

/** Repo-rooted integration bundle dirs (harness files in tests/integration).
 * Stale per-pid bundle files from killed runs are reaped here too; the
 * directories themselves stay (the harnesses create them). */
const BUNDLE_DIRS: readonly string[] = ['.tl25-bundles', '.tl35-bundles', '.tl48-bundles'];

/** Remove disposable roots under ROOT_BASE with mtime older than MIN_AGE_MS.
 * Best-effort: a root a live suite is writing to (fresh mtime) or a
 * filesystem error is skipped, never partially removed. Returns the number
 * of directories removed. */
export function sweepStaleRoots(maxAgeMs = MIN_AGE_MS): number {
  let names: string[];
  try {
    names = readdirSync(ROOT_BASE);
  } catch {
    return 0; // base dir unreadable — nothing to do
  }
  const now = Date.now();
  let removed = 0;
  for (const name of names) {
    if (!DISPOSABLE_PREFIXES.some((p) => name.startsWith(p))) continue;
    const p = join(ROOT_BASE, name);
    try {
      const st = statSync(p);
      if (!st.isDirectory()) continue;
      if (now - st.mtimeMs < maxAgeMs) continue;
      rmSync(p, { recursive: true, force: true });
      removed += 1;
    } catch {
      // best effort: concurrent writer, permissions, or a race with another
      // reap — leave it for the next sweep.
    }
  }
  return removed;
}

/** Remove stale per-pid bundle files (`child-<pid>.mjs` / `mcp-<pid>.mjs`)
 * from the repo's integration bundle dirs, same MIN_AGE_MS floor. Returns
 * the number of files removed. */
export function sweepStaleBundleFiles(maxAgeMs = MIN_AGE_MS): number {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const now = Date.now();
  let removed = 0;
  for (const dirName of BUNDLE_DIRS) {
    let entries: string[];
    try {
      entries = readdirSync(join(repoRoot, dirName));
    } catch {
      continue; // dir absent or unreadable
    }
    for (const name of entries) {
      if (!/^(child|mcp)-[0-9]+\.mjs$/.test(name)) continue;
      const p = join(repoRoot, dirName, name);
      try {
        const st = statSync(p);
        if (now - st.mtimeMs < maxAgeMs) continue;
        rmSync(p, { force: true });
        removed += 1;
      } catch {
        // best effort
      }
    }
  }
  return removed;
}

/** Kill orphaned (ppid == 1) test child processes whose command line
 * references a disposable bundle directory. Linux /proc only; on other
 * platforms this is a no-op. Returns the number of children killed. */
export function reapOrphanedTestChildren(): number {
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    return 0; // not Linux — nothing to do
  }
  const victims: number[] = [];
  for (const e of entries) {
    if (!/^[0-9]+$/.test(e)) continue;
    const pid = Number(e);
    if (pid === process.pid) continue;
    try {
      // /proc/<pid>/stat: `pid (comm) state ppid ...` — comm may contain
      // spaces/parens, so parse from after the LAST ')'. ppid is field 4
      // overall, i.e. index 1 after the close paren (state = index 0).
      const stat = readFileSync(`/proc/${e}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      if (ppid !== 1) continue; // attached to a live parent — never touch
      const cmdline = readFileSync(`/proc/${e}/cmdline`, 'utf8');
      if (!CHILD_SIGNATURES.some((s) => cmdline.includes(s))) continue;
      victims.push(pid);
    } catch {
      // process vanished or unreadable — skip
    }
  }
  for (const pid of victims) {
    try {
      // These are orphans of DEAD runs — SIGKILL is exactly what the tests
      // themselves use at their crash points; no grace period needed.
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  return victims.length;
}

/** vitest globalSetup — runs in the main process before any worker starts. */
export function setup(): void {
  const reaped = sweepStaleRoots();
  const bundles = sweepStaleBundleFiles();
  const killed = reapOrphanedTestChildren();
  if (reaped > 0 || bundles > 0 || killed > 0) {
    console.log(
      `[test-hygiene] reaped ${reaped} stale test root(s), ${bundles} stale bundle file(s), ${killed} orphaned test child process(es) under ${ROOT_BASE}`,
    );
  }
}

/** vitest globalTeardown — runs after every worker of THIS run has exited.
 * Same MIN_AGE_MS floor as setup: it reaps residue that went stale during a
 * long run without ever touching fresh roots. */
export function teardown(): void {
  const reaped = sweepStaleRoots();
  const bundles = sweepStaleBundleFiles();
  const killed = reapOrphanedTestChildren();
  if (reaped > 0 || bundles > 0 || killed > 0) {
    console.log(
      `[test-hygiene] removed ${reaped} stale test root(s), ${bundles} stale bundle file(s), ${killed} orphaned test child process(es) under ${ROOT_BASE}`,
    );
  }
}