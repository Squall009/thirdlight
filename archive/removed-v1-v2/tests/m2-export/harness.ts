/**
 * Packet 36 integration harness: a disposable data root + export root, a REAL
 * backend child process (real fs + real HTTP + real WS) with the export engine
 * root configured, and the real content/behavior publication flows.
 *
 * The play-side pieces (backend child bundle, HTTP helper, WS editor stub,
 * storage fixture seeding) are reused from the packet-35 harness; this harness
 * adds the export root + engine root the export route requires and the
 * in-process static server used by the non-root serving evidence.
 */
import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

import {
  ADMIN_TOKEN,
  AUTHORING_ORIGIN,
  AUTH_TOKEN,
  FakeEditor,
  PLAY_PROJECT,
  REPO_ROOT,
  cleanupBundles,
  ensureBackendBundle,
  establish,
  fixtureBytes,
  http,
  makeRoot,
  mkRequestId,
  sha256Hex,
  sleep,
  stopBackend,
  type BackendProcess,
  type DisposableRoot,
  type SessionInfo,
} from '../m2-play/harness';

export {
  ADMIN_TOKEN,
  AUTHORING_ORIGIN,
  AUTH_TOKEN,
  FakeEditor,
  PLAY_PROJECT,
  REPO_ROOT,
  cleanupBundles,
  establish,
  fixtureBytes,
  http,
  makeRoot,
  mkRequestId,
  sha256Hex,
  sleep,
  stopBackend,
  type BackendProcess,
  type DisposableRoot,
  type SessionInfo,
};

import { mkdirSync, mkdtempSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';

const ROOT_BASE = tmpdir() === '/tmp' ? '/home/dadmin' : tmpdir();

export interface ExportRoot extends DisposableRoot {
  exportRoot: string;
}

/** A disposable root with the static bundles, the seeded v2 project AND an export root. */
export function makeExportRoot(tag: string): ExportRoot {
  const base = makeRoot(tag);
  const exportRoot = join(base.root, 'exports');
  mkdirSync(exportRoot, { recursive: true });
  return { ...base, exportRoot };
}

/** Spawn the real backend child with `exportRoot` + `engineRoot` configured. */
export async function spawnBackendWithExport(root: ExportRoot): Promise<BackendProcess> {
  const bundlePath = await ensureBackendBundle();
  const config = {
    dataRoot: root.dataRoot,
    authoringOrigin: AUTHORING_ORIGIN,
    previewOrigin: 'http://127.0.0.1:8502',
    authoringBind: '127.0.0.1:0',
    previewBind: '127.0.0.1:0',
    authoringOrigins: [AUTHORING_ORIGIN],
    editorStaticDir: root.editorDir,
    previewStaticDir: root.previewDir,
    exportRoot: root.exportRoot,
    engineRoot: REPO_ROOT,
    tokens: [
      { token: AUTH_TOKEN, scope: `authoring:${PLAY_PROJECT}` },
      { token: ADMIN_TOKEN, scope: 'admin' },
    ],
  };
  const proc: ChildProcess = spawn(process.execPath, [bundlePath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, TL_BACKEND_CONFIG: JSON.stringify(config) },
  });
  const ready = await new Promise<{ portAuthoring: number; portPreview: number }>((resolvePromise, reject) => {
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`backend child did not become ready (stdout=${out} stderr=${err})`));
    }, 30_000);
    proc.stdout?.on('data', (d: Uint8Array) => {
      out += new TextDecoder().decode(d);
      const line = out.split('\n').find((l) => l.includes('"ready"'));
      if (line !== undefined) {
        clearTimeout(timer);
        try {
          resolvePromise(JSON.parse(line) as { portAuthoring: number; portPreview: number });
        } catch (e) {
          reject(new Error(`bad ready line: ${line} ${String(e)}`));
        }
      }
    });
    proc.stderr?.on('data', (d: Uint8Array) => {
      err += new TextDecoder().decode(d);
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`backend child exited early (code=${String(code)} stderr=${err})`));
    });
  });
  return {
    proc,
    pid: proc.pid ?? 0,
    origin: `http://127.0.0.1:${ready.portAuthoring}`,
    previewOrigin: `http://127.0.0.1:${ready.portPreview}`,
  };
}

// ---- the independent static server (non-root subpath) -------------------------

/**
 * The artifact-path MIME rule (the documented deployment requirement): the
 * digest-addressed artifact paths carry NO file extension, so `.glb`/`.wasm`
 * MIME records are matched by path class, then by extension:
 *
 *   `content/sha256/<64 hex>`              → `model/gltf-binary`
 *   `behaviors/<64 hex>.js`                → `text/javascript; charset=utf-8`
 *   `*.wasm` (a separately emitted module) → `application/wasm`
 */
export function mimeFor(relPath: string): string {
  if (/^content\/sha256\/[0-9a-f]{64}$/.test(relPath)) return 'model/gltf-binary';
  if (/^behaviors\/[0-9a-f]{64}\.js$/.test(relPath)) return 'text/javascript; charset=utf-8';
  return MIME[extname(relPath).toLowerCase()] ?? 'application/octet-stream';
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.css': 'text/css; charset=utf-8',
};

export interface StaticServer {
  origin: string;
  /** The exact base path the tree is served under (non-root). */
  basePath: string;
  requests: string[];
  externalRequests: number;
  close: () => Promise<void>;
}

/**
 * An independent plain static HTTP server (the deployment shape: `python3 -m
 * http.server`, nginx static) serving ONE export tree under a NON-ROOT base
 * path with the correct MIME records for `.glb`/`.wasm`. It records every
 * requested path so the absence of external requests can be asserted.
 */
export async function startStaticServer(rootDir: string, basePath: string): Promise<StaticServer> {
  const requests: string[] = [];
  let external = 0;
  const server: Server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (!url.startsWith(basePath)) {
      external += 1;
      res.writeHead(404).end('not found');
      return;
    }
    requests.push(url);
    // Traversal containment (the deployment rule: never escape the tree).
    const rel = decodeURIComponent(url.slice(basePath.length).split('?')[0] ?? '');
    const target = resolve(rootDir, normalize(rel));
    if (!target.startsWith(resolve(rootDir))) {
      res.writeHead(400).end('rejected');
      return;
    }
    if (!existsSync(target) || !statSync(target).isFile()) {
      res.writeHead(404).end('not found');
      return;
    }
    const body = readFileSync(target);
    res.writeHead(200, {
      'content-type': mimeFor(rel),
      'content-length': String(body.length),
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    });
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    origin: `http://127.0.0.1:${port}`,
    basePath,
    requests,
    get externalRequests() {
      return external;
    },
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r());
      }),
  } as StaticServer;
}

/** A temp directory for the serving probe (a synthetic `.wasm` MIME case). */
export function makeServingProbeDir(): string {
  return mkdtempSync(join(ROOT_BASE, `.tl36-serve-${process.pid}-`));
}

/** Every file of a tree, relative to it, sorted (the byte-tree diff input). */
export function subtreeFiles(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(rel === '' ? dir : join(dir, rel))) {
    const r = rel === '' ? entry : `${rel}/${entry}`;
    if (statSync(join(dir, r)).isDirectory()) out.push(...subtreeFiles(dir, r));
    else out.push(r);
  }
  return out.sort();
}
