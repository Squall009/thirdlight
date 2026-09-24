/**
 * The executable bootstrap — the owner-deployment process entry
 * (dependencies.md §3: the default subpath "may be executed; no package
 * imports it"). Reads the deployment configuration from the environment
 * (sessions.md §13.7 shape), starts the backend, and records the outcome
 * on stderr (the bounded startup log is the authoritative record).
 *
 * Environment variables (all required except where noted):
 *   THIRDLIGHT_DATA_ROOT       the workspace data root
 *   THIRDLIGHT_AUTHORING_ORIGIN   e.g. http://127.0.0.1:8501
 *   THIRDLIGHT_PREVIEW_ORIGIN     e.g. http://127.0.0.1:8502
 *   THIRDLIGHT_AUTHORING_BIND     e.g. 0.0.0.0:8501
 *   THIRDLIGHT_PREVIEW_BIND       e.g. 0.0.0.0:8502
 *   THIRDLIGHT_AUTHORING_ORIGINS  comma-separated exact Origin allowlist
 *   THIRDLIGHT_EDITOR_DIR         the editor static bundle dir
 *   THIRDLIGHT_PREVIEW_DIR        the preview static bundle dir
 *   THIRDLIGHT_OWNER_TOKEN        the one bearer token (16–256 chars, no
 *                                 whitespace); it covers every project and
 *                                 the admin routes — this is a personal,
 *                                 single-owner deployment
 *   THIRDLIGHT_EXPORT_ROOT        optional; the export root
 *   THIRDLIGHT_ENGINE_ROOT        optional; the engine installation root (required for the export route)
 *   THIRDLIGHT_BLENDER            optional; the Blender executable for FBX imports (default: blender on PATH)
 *   THIRDLIGHT_TRUSTED_NETWORKS   optional; IPv4 ranges (a,b,…) whose requests need no token
 *   THIRDLIGHT_TRUSTED_PROXIES    optional; reverse proxies whose X-Forwarded-For names the client
 *   THIRDLIGHT_BACKEND_ID         optional; `tb-` + 32 hex
 *   THIRDLIGHT_HEADLESS           optional; `off` = never open a headless editor for MCP play
 *   THIRDLIGHT_BROWSER_LIBS       optional; an extracted library tree for Chromium (hosts without browser libraries)
 *   THIRDLIGHT_HEADLESS_IDLE_SECONDS optional; close an idle headless editor after this long (default 300)
 *   THIRDLIGHT_BAKE_HOST          optional; the final light bake's host: user@host (ssh/scp) or local
 *   THIRDLIGHT_BAKE_BLENDER       optional; Blender on the bake host (default: blender)
 *   THIRDLIGHT_BAKE_TIMEOUT_MINUTES optional; stop a bake after this long (default 60)
 */
import { parseBackendConfig, type BackendTokenEntry } from './config';
import { createBackend } from './backend';

const env = process.env;

function fail(message: string): never {
  process.stderr.write(`thirdlight-backend: ${message}\n`);
  throw new Error(message);
}

function required(name: string): string {
  const v = env[name];
  if (typeof v !== 'string' || v.length === 0) fail(`environment variable ${name} is required`);
  return v;
}

const ownerToken = required('THIRDLIGHT_OWNER_TOKEN');
if (ownerToken.length < 16 || ownerToken.length > 256 || /\s/.test(ownerToken)) {
  fail('THIRDLIGHT_OWNER_TOKEN must be 16–256 characters with no whitespace');
}
if (env.THIRDLIGHT_TOKENS !== undefined) {
  fail('THIRDLIGHT_TOKENS is no longer read; set the single THIRDLIGHT_OWNER_TOKEN');
}
const tokens: BackendTokenEntry[] = [{ token: ownerToken, scope: 'admin' }];

const config = parseBackendConfig({
  dataRoot: required('THIRDLIGHT_DATA_ROOT'),
  backendId: env.THIRDLIGHT_BACKEND_ID,
  authoringOrigin: required('THIRDLIGHT_AUTHORING_ORIGIN'),
  previewOrigin: required('THIRDLIGHT_PREVIEW_ORIGIN'),
  authoringBind: required('THIRDLIGHT_AUTHORING_BIND'),
  previewBind: required('THIRDLIGHT_PREVIEW_BIND'),
  authoringOrigins: required('THIRDLIGHT_AUTHORING_ORIGINS').split(',').map((s) => s.trim()).filter((s) => s.length > 0),
  editorStaticDir: required('THIRDLIGHT_EDITOR_DIR'),
  previewStaticDir: required('THIRDLIGHT_PREVIEW_DIR'),
  exportRoot: env.THIRDLIGHT_EXPORT_ROOT,
  engineRoot: env.THIRDLIGHT_ENGINE_ROOT,
  blenderPath: env.THIRDLIGHT_BLENDER,
  ...(env.THIRDLIGHT_BAKE_HOST !== undefined && env.THIRDLIGHT_BAKE_HOST !== ''
    ? { bake: { host: env.THIRDLIGHT_BAKE_HOST, blender: env.THIRDLIGHT_BAKE_BLENDER ?? 'blender', timeoutMs: Math.max(1, Number(env.THIRDLIGHT_BAKE_TIMEOUT_MINUTES ?? 60) || 60) * 60_000 } }
    : {}),
  trustedNetworks: env.THIRDLIGHT_TRUSTED_NETWORKS,
  trustedProxies: env.THIRDLIGHT_TRUSTED_PROXIES,
  tokens,
  headless: {
    enabled: env.THIRDLIGHT_HEADLESS !== 'off',
    ...(env.THIRDLIGHT_BROWSER_LIBS !== undefined && env.THIRDLIGHT_BROWSER_LIBS !== '' ? { libs: env.THIRDLIGHT_BROWSER_LIBS } : {}),
    idleMs: Math.max(30, Number(env.THIRDLIGHT_HEADLESS_IDLE_SECONDS ?? 300) || 300) * 1000,
  },
});
if (!config.ok) {
  fail(`backend config invalid: ${config.error.message}`);
}

const created = createBackend(config.config);
if (!created.ok) {
  fail(`startup failed: ${created.error.message} (missing: ${created.error.missing.join(', ')})`);
}
const backend = created.backend;
void backend.ready
  .then(() => {
    process.stderr.write(
      `thirdlight-backend: listening (authoring port ${backend.portAuthoring}, preview port ${backend.portPreview})\n`,
    );
  })
  .catch((err: Error) => {
    fail(`listen failed: ${err.message}`);
  });

let stopping = false;
const shutdown = (): void => {
  if (stopping) return;
  stopping = true;
  // Close the listeners and release the projects, then leave: an operator
  // process must not linger on a stray handle after it has said "closed".
  setTimeout(() => {
    process.stderr.write('thirdlight-backend: close timed out; exiting\n');
    process.exit(1);
  }, 10_000);
  void backend.close().then(() => {
    process.stderr.write('thirdlight-backend: closed\n');
    process.exit(0);
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);