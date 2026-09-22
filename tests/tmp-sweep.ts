/**
 * Sweep stale temp residue from the system temp dir (see tests/test-hygiene.ts
 * for why: on this host /tmp is RAM). Shared by the Vitest and Playwright
 * global setups; no `import.meta`, so both loaders can import it.
 */
import { readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** /tmp residue is only swept when this old: long enough that no live run
 * (another session's suite, a long e2e run) can still be using it. */
const TMP_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/** A Vitest per-run module-copy dir: `<tmpdir>/<nanoid(21)>` holding only `ssr/`. */
function isVitestTmpDir(path: string, name: string): boolean {
  if (!/^[A-Za-z0-9_-]{21}$/.test(name)) return false;
  try {
    const inside = readdirSync(path);
    return inside.length === 1 && inside[0] === 'ssr';
  } catch {
    return false;
  }
}

/** Newest mtime of a directory and its direct children (a live run keeps adding files). */
function newestMtime(path: string): number {
  let newest = statSync(path).mtimeMs;
  for (const name of readdirSync(path)) {
    try {
      newest = Math.max(newest, statSync(join(path, name)).mtimeMs);
    } catch {
      // vanished
    }
  }
  return newest;
}

/** Remove stale Vitest module-copy dirs and Thirdlight `tl*` dirs from the
 * system temp dir. Returns the number of directories removed. */
export function sweepStaleTmp(maxAgeMs = TMP_MAX_AGE_MS): number {
  const base = tmpdir();
  let names: string[];
  try {
    names = readdirSync(base);
  } catch {
    return 0;
  }
  const now = Date.now();
  let removed = 0;
  for (const name of names) {
    const p = join(base, name);
    const ours = /^tl(-|\d)/.test(name) || isVitestTmpDir(p, name);
    if (!ours) continue;
    try {
      if (!statSync(p).isDirectory()) continue;
      if (now - newestMtime(p) < maxAgeMs) continue;
      rmSync(p, { recursive: true, force: true });
      removed += 1;
    } catch {
      // best effort — leave it for the next sweep
    }
  }
  return removed;
}

