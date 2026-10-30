/**
 * The perf runner's start: `--help` / `-h` print the usage and start
 * nothing, and a run starts only under a memory cap with room for it on the
 * host (a run once started from an uncapped shell instead of printing help).
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MAX_CAP_BYTES, memoryCap, refusal } from './memory-cap.mjs';

const RUN = join(import.meta.dirname, 'run.mjs');
const GiB = 1024 ** 3;

describe('perf runner start', () => {
  it('prints its usage for --help and -h without starting a run', () => {
    for (const args of [['--help'], ['-h'], ['village', '--help']]) {
      const r = spawnSync(process.execPath, [RUN, ...args], { encoding: 'utf8', timeout: 30_000 });
      expect(r.status, args.join(' ')).toBe(0);
      expect(r.stdout).toMatch(args[0] === 'village' ? /node tools\/perf\/run\.mjs village \[options\][\s\S]*--renderers/ : /--classes[\s\S]*--no-memory-cap/);
      expect(r.stdout + r.stderr).not.toMatch(/^perf: /m);
    }
  });

  it('starts a run only under a memory cap with room for it on the host', () => {
    const io = (own, files) => ({ cgroupPath: () => own, read: (p) => files[p] ?? null });
    const scope = '/system.slice/run-1.scope';
    expect(memoryCap(io(scope, { '/sys/fs/cgroup/system.slice/memory.max': 'max', [`/sys/fs/cgroup${scope}/memory.max`]: 'max' }))).toBeNull();
    // The tightest of the process's cgroup and its ancestors.
    const cap = memoryCap(io(scope, { [`/sys/fs/cgroup${scope}/memory.max`]: String(7 * GiB), [`/sys/fs/cgroup${scope}/memory.current`]: String(GiB), '/sys/fs/cgroup/system.slice/memory.max': String(12 * GiB) }));
    expect(cap).toEqual({ cgroup: scope, max: 7 * GiB, current: GiB });
    expect(refusal(null, 14 * GiB)).toMatch(/not inside a memory-capped cgroup/);
    expect(refusal({ cgroup: scope, max: MAX_CAP_BYTES + GiB, current: 0 }, 14 * GiB)).toMatch(/above/);
    expect(refusal(cap, 14 * GiB)).toBeNull();
    // 6 GiB still to take under the cap plus 2 for the host: 7 available is not enough.
    expect(refusal(cap, 7 * GiB)).toMatch(/available/);
  });

  // Only where this test itself runs uncapped (a shell; the gate's unit is capped).
  it.skipIf(memoryCap() !== null)('refuses to start outside a cap, before it builds anything', () => {
    const r = spawnSync(process.execPath, [RUN, '--quick'], { encoding: 'utf8', timeout: 30_000 });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/perf: not started: not inside a memory-capped cgroup[\s\S]*systemd-run --scope/);
  });
});
