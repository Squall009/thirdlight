/**
 * Whether a perf run may start here: inside a memory-capped cgroup, with room
 * on the host for the cap to fill.
 *
 * A perf run starts a backend and a browser that can take gigabytes; run from
 * an agent's shell it lands in that shell's uncapped service and once pushed
 * this 16 GiB host into the OOM killer, which took every session with it. So
 * a run refuses to start unless a cgroup it is in (its own or an ancestor)
 * has a `memory.max` of at most MAX_CAP_BYTES, and the host has the room the
 * run can still take under it plus HEADROOM_BYTES available. `--no-memory-cap`
 * skips the check (a host where nothing else runs).
 */
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';

const GiB = 1024 ** 3;
/** The largest cap a run may sit under (the host's rule: runs capped at 7G). */
export const MAX_CAP_BYTES = 7 * GiB;
/** Memory left to the rest of the host while the run fills its cap. */
export const HEADROOM_BYTES = 2 * GiB;
/** The flag that skips the check. */
export const NO_MEMORY_CAP_FLAG = '--no-memory-cap';
/** How to start a run capped (printed when one is refused). */
export const CAPPED_COMMAND =
  'sudo -n systemd-run --scope --quiet -p MemoryMax=7G -p MemorySwapMax=0 -- sudo -n -u "$USER" -- env HOME="$HOME" PATH="$PATH" NODE_OPTIONS=--max-old-space-size=4096 node tools/perf/run.mjs …';

const read = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

/**
 * The tightest memory cap over this process's cgroup and its ancestors (cgroup v2):
 * `{ cgroup, max, current }` in bytes, or null when none is capped.
 */
export function memoryCap(io = { read, cgroupPath: () => (read('/proc/self/cgroup') ?? '').split('\n').find((l) => l.startsWith('0::'))?.slice(3) ?? null }) {
  const own = io.cgroupPath();
  if (own === null || own === '') return null;
  let best = null;
  for (let p = own; ; p = dirname(p)) {
    const dir = `/sys/fs/cgroup${p === '/' ? '' : p}`;
    const raw = io.read(`${dir}/memory.max`)?.trim();
    if (raw !== undefined && raw !== 'max' && Number.isFinite(Number(raw))) {
      const max = Number(raw);
      if (best === null || max < best.max) best = { cgroup: p, max, current: Number(io.read(`${dir}/memory.current`)?.trim() ?? 0) || 0 };
    }
    if (p === '/') break;
  }
  return best;
}

/** The host's MemAvailable in bytes (null: unknown). */
export function memAvailable(meminfo = read('/proc/meminfo')) {
  const m = /^MemAvailable:\s+(\d+) kB/m.exec(meminfo ?? '');
  return m === null ? null : Number(m[1]) * 1024;
}

/** Why a run may not start (null: it may). */
export function refusal(cap = memoryCap(), available = memAvailable()) {
  const gib = (b) => `${(b / GiB).toFixed(1)} GiB`;
  if (cap === null) return 'not inside a memory-capped cgroup';
  if (cap.max > MAX_CAP_BYTES) return `the cap (${gib(cap.max)} on ${cap.cgroup}) is above ${gib(MAX_CAP_BYTES)}`;
  const room = Math.max(0, cap.max - cap.current) + HEADROOM_BYTES;
  if (available !== null && available < room) return `${gib(available)} available, the run may still take ${gib(cap.max - cap.current)} under its cap and the host keeps ${gib(HEADROOM_BYTES)}`;
  return null;
}
