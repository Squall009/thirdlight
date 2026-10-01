/**
 * Ports for a backend started by a test or a benchmark, and the retry that
 * makes parallel starts safe.
 *
 * The backend cannot bind port 0 and report what it got: its authoring and
 * preview origins (CORS, the editor page's CSP, the preview frame's URL) are
 * fixed in its environment before it starts. So the caller picks the ports,
 * and between the pick and the backend's bind something else can take one:
 *
 * - A port probed with `listen(0)` comes from the kernel's ephemeral range,
 *   the same range every outgoing connection (the browser's, fetch's, the
 *   other backends') takes its local port from. Under parallel workers a
 *   client socket took such a port before the backend bound it
 *   (EADDRINUSE). Ports are picked below that range instead, where the
 *   kernel never hands out client ports.
 * - Two probes closed one after the other can return the same port; both are
 *   held open until both are known.
 * - Two parallel pickers can still land on the same free port: a launch that
 *   fails with EADDRINUSE is retried on fresh ports.
 */
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';

export interface BackendPorts {
  authoring: number;
  preview: number;
}

/** How often a launch that lost its port to another process is tried again on fresh ports. */
export const PORT_ATTEMPTS = 6;

/** The lowest port picked (above the registered services commonly run on a host). */
const PICK_FLOOR = 20_000;

/** The kernel's ephemeral (client) range; Linux's default when it cannot be read. */
function ephemeralRange(): [number, number] {
  try {
    const [lo, hi] = readFileSync('/proc/sys/net/ipv4/ip_local_port_range', 'utf8').trim().split(/\s+/).map(Number);
    if (lo !== undefined && hi !== undefined && Number.isInteger(lo) && Number.isInteger(hi) && lo > 1024) return [lo, hi];
  } catch {
    // not Linux: the default range below
  }
  return [32_768, 60_999];
}

function hold(port: number): Promise<Server | null> {
  return new Promise((ok) => {
    const s = createServer();
    s.once('error', () => ok(null));
    s.listen(port, '127.0.0.1', () => ok(s));
  });
}

const close = (s: Server): Promise<void> => new Promise((ok) => s.close(() => ok()));

/**
 * Two distinct ports free right now. `reserved` (the default) picks them
 * below the ephemeral range; `ephemeral` asks the kernel (`listen(0)`), as
 * the helpers did before (the stress run compares the two).
 */
export async function pickPorts(picker: 'reserved' | 'ephemeral' = 'reserved'): Promise<BackendPorts> {
  const held: Server[] = [];
  try {
    if (picker === 'ephemeral') {
      for (let i = 0; i < 2; i++) {
        const s = await hold(0);
        if (s === null) throw new Error('no free port');
        held.push(s);
      }
    } else {
      const [lo] = ephemeralRange();
      const floor = Math.min(PICK_FLOOR, lo - 2_000);
      for (let tries = 0; held.length < 2; tries++) {
        if (tries > 1_000) throw new Error(`no free port between ${floor} and ${lo}`);
        const s = await hold(floor + Math.floor(Math.random() * (lo - floor)));
        if (s !== null) held.push(s);
      }
    }
    const [a, b] = held.map((s) => (s.address() as { port: number }).port) as [number, number];
    return { authoring: a, preview: b };
  } finally {
    await Promise.all(held.map(close));
  }
}

/** A launch failed because a port was taken between the pick and the bind. */
export const lostPort = (e: unknown): boolean => e instanceof Error && e.message.includes('EADDRINUSE');

/**
 * Start something on two fresh ports; when it reports EADDRINUSE, pick again
 * and retry (at most `attempts` launches). Any other failure is thrown as is.
 */
export async function launchOnFreePorts<T>(launch: (ports: BackendPorts) => Promise<T>, opts: { attempts?: number; picker?: 'reserved' | 'ephemeral'; onRetry?: (e: Error) => void } = {}): Promise<{ value: T; ports: BackendPorts }> {
  const attempts = opts.attempts ?? PORT_ATTEMPTS;
  for (let i = 1; ; i++) {
    const ports = await pickPorts(opts.picker);
    try {
      return { value: await launch(ports), ports };
    } catch (e) {
      if (!lostPort(e) || i >= attempts) throw e;
      opts.onRetry?.(e as Error);
    }
  }
}
