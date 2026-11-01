/**
 * tools/staging.sh's refusals, run as the real script: production's ports and data root, and a port that is
 * already taken. Each one stops before anything is created or started, so the test needs no memory and starts
 * no backend; the start itself (systemd unit, editor page, test project, stop) is proven by hand on the host.
 */
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { createServer } from 'node:net';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const SCRIPT = new URL('./staging.sh', import.meta.url).pathname;

function staging(env, cmd = 'start') {
  const r = spawnSync('bash', [SCRIPT, cmd], { env: { ...process.env, ...env }, encoding: 'utf8' });
  return { status: r.status, err: r.stderr };
}

describe('tools/staging.sh', () => {
  it("refuses the production service's ports", () => {
    for (const port of ['8501', '8502']) {
      const r = staging({ TL_STAGING_PORT: port });
      expect(r.status).toBe(1);
      expect(r.err).toMatch(/is the production service's; refused/);
    }
  });

  it("refuses the production data root, a folder inside it and one that contains it", () => {
    for (const root of [join(homedir(), 'thirdlight'), join(homedir(), 'thirdlight', 'projects', 'x'), homedir()]) {
      const r = staging({ TL_STAGING_ROOT: root });
      expect(r.status).toBe(1);
      expect(r.err).toMatch(/production data root .*; refused/);
    }
  });

  it('refuses a port that is taken', async () => {
    const server = createServer();
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    try {
      const port = String(server.address().port);
      const r = staging({ TL_STAGING_PORT: port, TL_STAGING_PREVIEW_PORT: String(Number(port) === 65535 ? 65534 : Number(port) + 1) });
      expect(r.status).toBe(1);
      expect(r.err).toMatch(new RegExp(`port ${port} is taken`));
    } finally {
      await new Promise((ok) => server.close(ok));
    }
  });
});
