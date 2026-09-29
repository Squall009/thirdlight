/**
 * The engine this backend runs from: package version, git commit and the
 * lockfile digest (the pin a folder project records in `thirdlight.json`).
 * Read from files only (the backend has no child_process edge).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface EngineIdentity {
  version: string;
  commit: string;
  lockfileDigest: string;
}

function gitCommit(root: string): string {
  try {
    const head = readFileSync(join(root, '.git', 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref: ')) return /^[0-9a-f]{40}$/.test(head) ? head : 'unknown';
    const ref = head.slice(5);
    const loose = join(root, '.git', ref);
    if (existsSync(loose)) return readFileSync(loose, 'utf8').trim();
    const packed = readFileSync(join(root, '.git', 'packed-refs'), 'utf8');
    const line = packed.split('\n').find((l) => l.endsWith(` ${ref}`));
    return line ? line.slice(0, 40) : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** The identity of the engine at `root`, or null when it cannot be read. */
export function engineIdentity(root: string): EngineIdentity | null {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: unknown };
    const lock = readFileSync(join(root, 'package-lock.json'));
    return {
      version: String(pkg.version),
      commit: gitCommit(root),
      lockfileDigest: createHash('sha256').update(lock).digest('hex'),
    };
  } catch {
    return null;
  }
}

/**
 * How a project's pinned engine compares with this one. Version and lockfile
 * decide compatibility; a different commit alone is normal between upgrades.
 */
export function comparePin(pin: Partial<EngineIdentity> | undefined, engine: EngineIdentity | null): { matches: boolean; differences: string[] } {
  if (pin === undefined || engine === null) return { matches: true, differences: [] };
  const differences: string[] = [];
  if (pin.version !== undefined && pin.version !== engine.version) differences.push(`engine version: pinned ${pin.version}, running ${engine.version}`);
  if (pin.lockfileDigest !== undefined && pin.lockfileDigest !== engine.lockfileDigest) differences.push('dependency lockfile differs from the pinned one');
  return { matches: differences.length === 0, differences };
}

/** The build stamp `tools/build.mjs` writes into dist/ (`build-info.json`). */
export interface BuildStamp {
  builtAt: string;
  commit: string;
  dirty: boolean | null;
  version: string;
}

/** The build stamp in `distDir`, or null (no stamp: a dist/ built without one, or none). */
export function readBuildStamp(distDir: string): BuildStamp | null {
  try {
    const raw = JSON.parse(readFileSync(join(distDir, 'build-info.json'), 'utf8')) as Record<string, unknown>;
    if (typeof raw['builtAt'] !== 'string' || !Number.isFinite(Date.parse(raw['builtAt']))) return null;
    return {
      builtAt: raw['builtAt'],
      commit: typeof raw['commit'] === 'string' ? raw['commit'] : 'unknown',
      dirty: typeof raw['dirty'] === 'boolean' ? raw['dirty'] : null,
      version: typeof raw['version'] === 'string' ? raw['version'] : 'unknown',
    };
  } catch {
    return null;
  }
}

/** The bundles a backend serves or runs (their newest modification time stands in for a missing stamp). */
const DIST_BUNDLES = ['backend/backend.mjs', 'editor/main.js', 'preview/preview-m3.js', 'preview/sim-worker.js', 'mcp-adapter/mcp.mjs'];

function newestBundleMs(distDir: string): number | null {
  let newest: number | null = null;
  for (const rel of DIST_BUNDLES) {
    try {
      const t = statSync(join(distDir, rel)).mtimeMs;
      if (newest === null || t > newest) newest = t;
    } catch {
      // absent bundle
    }
  }
  return newest;
}

/** What `GET /api/v1/engine` answers. */
export interface EngineInfo {
  version: string | null;
  /** The commit the running process was started from (read at start). */
  commit: string | null;
  lockfileDigest: string | null;
  /** The build the running process started with (dist/build-info.json at start). */
  build: BuildStamp | null;
  /** When this backend process started. */
  startedAt: string;
  /** dist/ now: its stamp, and whether it was built after this process started (a restart runs the newer build). */
  dist: { dir: string; build: BuildStamp | null; newerThanProcess: boolean; reason: string };
  /** The checkout's commit now, when it differs from the one the process started from. */
  checkoutCommit?: string;
}

/**
 * The engine this backend runs — identity and build at start,
 * and whether dist/ is newer than the process (rebuilt since it started: the
 * browser pages already load the new bundles, the backend still runs the old
 * one until restarted).
 */
export function makeEngineInfo(opts: { engineRoot: string | undefined; distDir: string; startedAtMs: number }): () => EngineInfo {
  const atStart = opts.engineRoot !== undefined ? engineIdentity(opts.engineRoot) : null;
  const buildAtStart = readBuildStamp(opts.distDir);
  const startedAt = new Date(opts.startedAtMs).toISOString();
  return () => {
    const now = readBuildStamp(opts.distDir);
    let newer = false;
    let reason: string;
    if (now !== null) {
      newer = Date.parse(now.builtAt) > opts.startedAtMs;
      reason = newer ? `dist/ was built at ${now.builtAt}, after this backend started (${startedAt}): restart it to run that build` : `dist/ was built at ${now.builtAt}, before this backend started`;
    } else {
      const t = newestBundleMs(opts.distDir);
      newer = t !== null && t > opts.startedAtMs;
      reason = t === null ? 'no dist/ bundles found' : `dist/ has no build stamp; its newest bundle was written ${new Date(t).toISOString()}${newer ? ', after this backend started' : ''}`;
    }
    const current = opts.engineRoot !== undefined ? engineIdentity(opts.engineRoot) : null;
    return {
      version: atStart?.version ?? null,
      commit: atStart?.commit ?? null,
      lockfileDigest: atStart?.lockfileDigest ?? null,
      build: buildAtStart,
      startedAt,
      dist: { dir: opts.distDir, build: now, newerThanProcess: newer, reason },
      ...(current !== null && atStart !== null && current.commit !== atStart.commit ? { checkoutCommit: current.commit } : {}),
    };
  };
}
