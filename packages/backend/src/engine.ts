/**
 * The engine this backend runs from: package version, git commit and the
 * lockfile digest (the pin a folder project records in `thirdlight.json`).
 * Read from files only (the backend has no child_process edge).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
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
