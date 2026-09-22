/**
 * Packet 25 integration-test child: a REAL backend process (its own listeners,
 * its own workspace on the disposable data root). The parent bundles this file
 * with esbuild and spawns `node <bundle>`; the child prints one JSON line with
 * the bound ports once both listeners are ready, then stays alive until
 * SIGTERM/SIGINT (graceful close) or SIGKILL (crash/restart cases).
 */
import { createBackend } from '@thirdlight/backend/services';

const raw = process.env.TL_BACKEND_CONFIG;
if (typeof raw !== 'string' || raw.length === 0) {
  process.stderr.write('TL_BACKEND_CONFIG is required\n');
  process.exit(1);
}

let config: unknown;
try {
  config = JSON.parse(raw);
} catch {
  process.stderr.write('TL_BACKEND_CONFIG is not valid JSON\n');
  process.exit(1);
}

const created = createBackend(config);
if (!created.ok) {
  process.stderr.write(`createBackend failed: ${created.error.message} (${created.error.missing.join(', ')})\n`);
  process.exit(1);
}
const backend = created.backend;

void backend.ready
  .then(() => {
    process.stdout.write(
      `${JSON.stringify({ ready: true, portAuthoring: backend.portAuthoring, portPreview: backend.portPreview })}\n`,
    );
  })
  .catch((err: Error) => {
    process.stderr.write(`listen failed: ${err.message}\n`);
    process.exit(1);
  });

const shutdown = (): void => {
  void backend.close().then(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
