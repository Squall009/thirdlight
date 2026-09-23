#!/usr/bin/env node
/**
 * One-command start for a personal Thirdlight deployment (process-level, no
 * containers): builds `dist/` if it is missing, creates the data root and the
 * owner token on first run, starts the backend and prints the editor URL.
 *
 *   node tools/start.mjs [--data-root DIR] [--host HOST] [--port N]
 *                        [--preview-port N] [--origin URL] [--preview-origin URL]
 *                        [--build]
 *
 * Defaults: data root `~/thirdlight` (projects under `projects/`, exports
 * under `exports/`, the token in `owner-token`), host 127.0.0.1, ports
 * 8501/8502. Open the editor at the printed URL: the browser must use
 * exactly that origin (the backend allows only exact origins, and the play
 * preview embeds it). To reach it from another machine on the LAN, pass
 * `--host <this machine's name or IP>`. Behind a reverse proxy, pass the two
 * public origins the browser uses (`--origin https://editor.example`,
 * `--preview-origin https://play.example`): the proxy forwards the first to
 * the editor port (with WebSocket upgrades) and the second to the preview
 * port. They must be two different origins — the play preview is isolated
 * from the editor by origin.
 *
 * Plain Node, no dependencies. Ctrl+C (SIGINT) or SIGTERM stops the backend
 * gracefully (projects are released for the next start).
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ENGINE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function usage(message) {
  if (message) process.stderr.write(`start: ${message}\n`);
  process.stderr.write('usage: node tools/start.mjs [--data-root DIR] [--host HOST] [--port N] [--preview-port N] [--origin URL] [--preview-origin URL] [--build]\n');
  process.exit(2);
}

export function parseArgs(argv) {
  const opts = { dataRoot: join(homedir(), 'thirdlight'), host: '127.0.0.1', port: 8501, previewPort: 8502, origin: null, previewOrigin: null, build: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined) usage(`${a} needs a value`);
      i += 1;
      return v;
    };
    if (a === '--data-root') opts.dataRoot = resolve(next());
    else if (a === '--host') opts.host = next();
    else if (a === '--port') opts.port = Number(next());
    else if (a === '--preview-port') opts.previewPort = Number(next());
    else if (a === '--origin') opts.origin = next().replace(/\/$/, '');
    else if (a === '--preview-origin') opts.previewOrigin = next().replace(/\/$/, '');
    else if (a === '--build') opts.build = true;
    else if (a === '--help' || a === '-h') usage();
    else usage(`unknown argument ${a}`);
  }
  for (const [k, v] of [['--port', opts.port], ['--preview-port', opts.previewPort]]) {
    if (!Number.isInteger(v) || v < 1 || v > 65535) usage(`${k} must be a port number`);
  }
  if (opts.port === opts.previewPort) usage('--port and --preview-port must differ');
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(opts.host)) usage('--host must be a host name or IP address');
  const ORIGIN = /^https?:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d+)?$/i;
  for (const [k, v] of [['--origin', opts.origin], ['--preview-origin', opts.previewOrigin]]) {
    if (v !== null && !ORIGIN.test(v)) usage(`${k} must be an origin like https://editor.example or http://host:port (no path)`);
  }
  if ((opts.origin === null) !== (opts.previewOrigin === null)) usage('--origin and --preview-origin go together (the preview must be reachable on its own origin)');
  if (opts.origin !== null && opts.origin.toLowerCase() === opts.previewOrigin.toLowerCase()) usage('--origin and --preview-origin must differ: the play preview is isolated from the editor by origin');
  return opts;
}

/** The owner token: created once (0600), reused on every start. */
export function ownerToken(dataRoot) {
  const file = join(dataRoot, 'owner-token');
  if (existsSync(file)) {
    const t = readFileSync(file, 'utf8').trim();
    if (t.length >= 16 && !/\s/.test(t)) return { token: t, created: false, file };
    throw new Error(`${file} does not hold a usable token (16+ characters, no whitespace); fix or delete it`);
  }
  const token = randomBytes(24).toString('base64url');
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return { token, created: true, file };
}

export function ensureBuilt(force) {
  const backend = join(ENGINE_ROOT, 'dist', 'backend', 'backend.mjs');
  const editor = join(ENGINE_ROOT, 'dist', 'editor', 'index.html');
  if (!force && existsSync(backend) && existsSync(editor)) return;
  process.stderr.write(`start: building dist/ (${force ? '--build' : 'not built yet'})\n`);
  const r = spawnSync('npm', ['run', 'build'], { cwd: ENGINE_ROOT, stdio: 'inherit', env: { ...process.env, NODE_ENV: 'development' } });
  if (r.status !== 0) {
    process.stderr.write('start: the build failed. If typescript/esbuild are missing, install dev dependencies first:\n  NODE_ENV=development npm ci --include=dev\n');
    process.exit(1);
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  ensureBuilt(opts.build);
  mkdirSync(join(opts.dataRoot, 'projects'), { recursive: true });
  mkdirSync(join(opts.dataRoot, 'exports'), { recursive: true });
  const tok = ownerToken(opts.dataRoot);
  if (tok.created) process.stderr.write(`start: created the owner token at ${tok.file}\n`);

  const loopback = opts.host === '127.0.0.1' || opts.host === 'localhost';
  const bindHost = loopback ? '127.0.0.1' : '0.0.0.0';
  // The origins the BROWSER uses: the public ones behind a reverse proxy, else host:port.
  const authoringOrigin = opts.origin ?? `http://${opts.host}:${opts.port}`;
  const previewOrigin = opts.previewOrigin ?? `http://${opts.host}:${opts.previewPort}`;
  const origins = new Set([authoringOrigin, `http://${opts.host}:${opts.port}`, `http://127.0.0.1:${opts.port}`, `http://localhost:${opts.port}`]);
  const env = {
    ...process.env,
    THIRDLIGHT_DATA_ROOT: opts.dataRoot,
    THIRDLIGHT_AUTHORING_ORIGIN: authoringOrigin,
    THIRDLIGHT_PREVIEW_ORIGIN: previewOrigin,
    THIRDLIGHT_AUTHORING_BIND: `${bindHost}:${opts.port}`,
    THIRDLIGHT_PREVIEW_BIND: `${bindHost}:${opts.previewPort}`,
    THIRDLIGHT_AUTHORING_ORIGINS: [...origins].join(','),
    THIRDLIGHT_EDITOR_DIR: join(ENGINE_ROOT, 'dist', 'editor'),
    THIRDLIGHT_PREVIEW_DIR: join(ENGINE_ROOT, 'dist', 'preview'),
    THIRDLIGHT_OWNER_TOKEN: tok.token,
    THIRDLIGHT_EXPORT_ROOT: join(opts.dataRoot, 'exports'),
    THIRDLIGHT_ENGINE_ROOT: ENGINE_ROOT,
  };
  delete env.THIRDLIGHT_TOKENS;

  const child = spawn(process.execPath, [join(ENGINE_ROOT, 'dist', 'backend', 'backend.mjs')], { env, stdio: ['ignore', 'inherit', 'pipe'] });
  let announced = false;
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    process.stderr.write(text);
    if (!announced && text.includes('listening')) {
      announced = true;
      // The token goes into the URL only on a terminal; logs (systemd's journal) never get it.
      const editor = process.stderr.isTTY ? `${authoringOrigin}/#token=${tok.token}` : `${authoringOrigin}/   (the page asks once for the token in ${tok.file})`;
      process.stderr.write(
        `\nThirdlight is running.\n` +
        `  editor:   ${editor}\n` +
        `  projects: ${join(opts.dataRoot, 'projects')}\n` +
        `  token:    ${tok.file}\n` +
        `  MCP:      THIRDLIGHT_AUTHORING_ORIGIN=${authoringOrigin} THIRDLIGHT_MCP_TOKEN=<the token> node ${join(ENGINE_ROOT, 'dist', 'mcp-adapter', 'mcp.mjs')}   (run in a project folder, or set THIRDLIGHT_PROJECT_ID)\n` +
        `Press Ctrl+C to stop.\n`,
      );
    }
  });
  const forward = (signal) => () => {
    if (child.exitCode === null) child.kill(signal);
  };
  process.on('SIGINT', forward('SIGINT'));
  process.on('SIGTERM', forward('SIGTERM'));
  child.on('exit', (code, signal) => {
    process.exit(code ?? (signal ? 0 : 1));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
