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
 *   THIRDLIGHT_TOKENS             comma-separated `scope:token` pairs
 *   THIRDLIGHT_EXPORT_ROOT        optional; the export root
 *   THIRDLIGHT_ENGINE_ROOT        optional; the engine installation root (required for the export route)
 *   THIRDLIGHT_BACKEND_ID         optional; `tb-` + 32 hex
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

const tokens: BackendTokenEntry[] = required('THIRDLIGHT_TOKENS')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s.length > 0)
  .map((pair) => {
    const sep = pair.indexOf(':');
    if (sep <= 0) fail(`THIRDLIGHT_TOKENS pair "${pair}" must be scope:token`);
    return { scope: pair.slice(0, sep), token: pair.slice(sep + 1) };
  });

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
  tokens,
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

const shutdown = (): void => {
  void backend.close().then(() => {
    process.stderr.write('thirdlight-backend: closed\n');
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);