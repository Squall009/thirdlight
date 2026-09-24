/**
 * Packet 25 integration harness: a disposable data root, a REAL backend
 * process (esbuild-bundled child, real fs + real HTTP/WS), a real MCP SDK
 * client over a real stdio transport talking to the out-of-process MCP server,
 * which routes every call into the real backend's `/api/v1` surface.
 *
 * Nothing is mocked where the packet requires integration: the content bytes,
 * the staged upload, the blob publication, the asset-byte read, the path
 * rules and the retry records all run on the real filesystem in the child.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const STORAGE_FIXTURE = join(REPO_ROOT, 'fixtures', 'm2', 'storage');
const ROOT_BASE = tmpdir() === '/tmp' ? '/home/dadmin' : tmpdir();

export const AUTHORING_ORIGIN = 'http://127.0.0.1:8501';
export const PREVIEW_ORIGIN = 'http://127.0.0.1:8502';
export const CONTENT_PROJECT = 'demo-store-01';
export const AUTH_TOKEN = 'm2-content-authoring-token';
export const ADMIN_TOKEN = 'm2-content-admin-token';

function hex(n: number): string {
  let s = '';
  const b = randomBytes(n);
  for (let i = 0; i < b.length; i += 1) s += (b[i] ?? 0).toString(16).padStart(2, '0');
  return s;
}

export const mkRequestId = (): string => `req-${hex(16)}`;
export const mkSessionId = (): string => `sess-${hex(16)}`;

export interface DisposableRoot {
  root: string;
  dataRoot: string;
  editorDir: string;
  previewDir: string;
  projectDir: string;
}

/** A disposable root with the static bundles and (optionally) the seeded v2 project. */
export function makeRoot(tag: string, seed = true): DisposableRoot {
  const root = mkdtempSync(join(ROOT_BASE, `.tl25-${tag}-${process.pid}-`));
  const dataRoot = join(root, 'data');
  const editorDir = join(root, 'editor');
  const previewDir = join(root, 'preview');
  mkdirSync(editorDir, { recursive: true });
  mkdirSync(previewDir, { recursive: true });
  mkdirSync(join(dataRoot, 'projects'), { recursive: true });
  writeFileSync(join(editorDir, 'index.html'), '<!doctype html><html><body>editor</body></html>\n');
  writeFileSync(join(previewDir, 'preview.js'), '// preview bundle stub (tests)\n');
  if (seed) {
    const projectDir = join(dataRoot, 'projects', CONTENT_PROJECT);
    cpSync(join(STORAGE_FIXTURE, 'project'), projectDir, { recursive: true });
    mkdirSync(join(projectDir, 'sources', 'sha256'), { recursive: true });
    for (const blob of ['alpha.bin', 'beta.bin']) {
      cpSync(join(STORAGE_FIXTURE, 'blobs', blob), join(projectDir, 'sources', 'sha256', sha256HexFile(join(STORAGE_FIXTURE, 'blobs', blob))));
    }
  }
  return { root, dataRoot, editorDir, previewDir, projectDir: join(dataRoot, 'projects', CONTENT_PROJECT) };
}


function sha256HexFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function fixtureBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(REPO_ROOT, 'fixtures', 'm2', 'assets', name)));
}

/** Any fixture file by repo-relative path (e.g. the storage blob fixtures). */
export function fixtureFile(rel: string): Uint8Array {
  return new Uint8Array(readFileSync(join(REPO_ROOT, 'fixtures', 'm2', rel)));
}

/** Seed a second v2 project (distinct id) from the storage fixture. */
export function seedSecondProject(root: DisposableRoot, projectId: string): void {
  const dst = join(root.dataRoot, 'projects', projectId);
  cpSync(join(STORAGE_FIXTURE, 'project'), dst, { recursive: true });
  const projPath = join(dst, 'project.json');
  const proj = JSON.parse(readFileSync(projPath, 'utf8')) as Record<string, unknown>;
  proj['id'] = projectId;
  writeFileSync(projPath, `${JSON.stringify(proj, null, 2)}\n`);
  const envPath = join(dst, 'scenes', 'main.json');
  // Project-specific asset ids so a cross-project read is observable as absent.
  const envText = readFileSync(envPath, 'utf8')
    .replaceAll('asset-00000000000000a1', 'asset-other-proj-0001')
    .replaceAll('asset-00000000000000b2', 'asset-other-proj-0002');
  const env = JSON.parse(envText) as Record<string, unknown>;
  env['projectId'] = projectId;
  writeFileSync(envPath, `${JSON.stringify(env, null, 2)}\n`);
  mkdirSync(join(dst, 'sources', 'sha256'), { recursive: true });
  for (const blob of ['alpha.bin', 'beta.bin']) {
    cpSync(join(STORAGE_FIXTURE, 'blobs', blob), join(dst, 'sources', 'sha256', sha256HexFile(join(STORAGE_FIXTURE, 'blobs', blob))));
  }
}

let childBundle: string | null = null;
let mcpBundle: string | null = null;
/** Bundles live inside the repo so their external (node_modules) imports resolve. */
const BUNDLE_DIR = join(REPO_ROOT, '.tl25-bundles');

/** Bundle the real-backend child once per test process. */
export async function ensureBackendBundle(): Promise<string> {
  if (childBundle !== null) return childBundle;
  mkdirSync(BUNDLE_DIR, { recursive: true });
  const out = join(BUNDLE_DIR, `child-${process.pid}.mjs`);
  await build({
    entryPoints: [join(dirname(fileURLToPath(import.meta.url)), 'backend-child.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: out,
    external: ['ws', 'esbuild', 'playwright-core'],
    logLevel: 'silent',
  });
  childBundle = out;
  return out;
}

/** Bundle the actual stdio MCP server entry once per test process. */
export async function ensureMcpBundle(): Promise<string> {
  if (mcpBundle !== null) return mcpBundle;
  mkdirSync(BUNDLE_DIR, { recursive: true });
  const out = join(BUNDLE_DIR, `mcp-${process.pid}.mjs`);
  await build({
    entryPoints: [join(REPO_ROOT, 'packages', 'mcp-adapter', 'src', 'index.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: out,
    external: ['ws', 'esbuild', '@modelcontextprotocol/sdk', 'playwright-core'],
    logLevel: 'silent',
  });
  mcpBundle = out;
  return out;
}

/** Remove this process's generated test bundles (other workers keep theirs). */
export function cleanupBundles(): void {
  for (const file of [`child-${process.pid}.mjs`, `mcp-${process.pid}.mjs`]) {
    try {
      rmSync(join(BUNDLE_DIR, file), { force: true });
    } catch {
      // best effort
    }
  }
  childBundle = null;
  mcpBundle = null;
}

export interface BackendProcess {
  proc: ChildProcess;
  pid: number;
  origin: string;
  previewOrigin: string;
}

/** Spawn the real backend process against `root` and wait for the ready line. */
export async function spawnBackend(root: DisposableRoot, tokens: Array<{ token: string; scope: string }>): Promise<BackendProcess> {
  const bundlePath = await ensureBackendBundle();
  const config = {
    dataRoot: root.dataRoot,
    authoringOrigin: AUTHORING_ORIGIN,
    previewOrigin: PREVIEW_ORIGIN,
    authoringBind: '127.0.0.1:0',
    previewBind: '127.0.0.1:0',
    authoringOrigins: [AUTHORING_ORIGIN],
    editorStaticDir: root.editorDir,
    previewStaticDir: root.previewDir,
    tokens,
  };
  const proc = spawn(process.execPath, [bundlePath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, TL_BACKEND_CONFIG: JSON.stringify(config) },
  });
  const ready = await new Promise<{ portAuthoring: number; portPreview: number }>((resolve, reject) => {
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
          resolve(JSON.parse(line) as { portAuthoring: number; portPreview: number });
        } catch (e) {
          reject(new Error(`bad ready line: ${line}`));
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

/** Gracefully stop the backend child (SIGTERM; waits for exit). */
export function stopBackend(bp: BackendProcess): Promise<void> {
  return new Promise((resolve) => {
    if (bp.proc.exitCode !== null) {
      resolve();
      return;
    }
    bp.proc.once('exit', () => resolve());
    bp.proc.kill('SIGTERM');
    setTimeout(() => {
      if (bp.proc.exitCode === null) bp.proc.kill('SIGKILL');
    }, 5000);
  });
}

// ---- HTTP --------------------------------------------------------------------

export interface HttpResult {
  status: number;
  body: unknown;
  headers: Record<string, string>;
  bytes: Uint8Array;
}

export interface HttpOptions {
  method?: string;
  body?: unknown;
  rawBody?: Uint8Array;
  token?: string;
  origin?: string;
  headers?: Record<string, string>;
}

export async function http(url: string, opts: HttpOptions = {}): Promise<HttpResult> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`;
  if (opts.origin !== undefined) headers.origin = opts.origin;
  let body: BodyInit | undefined;
  if (opts.rawBody !== undefined) {
    headers['content-type'] = headers['content-type'] ?? 'application/octet-stream';
    body = opts.rawBody as unknown as BodyInit;
  } else if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(url, { method: opts.method ?? (body === undefined ? 'GET' : 'POST'), headers, body });
  const bytes = new Uint8Array(await res.arrayBuffer());
  let parsed: unknown = null;
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('json') && bytes.length > 0) {
    parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  }
  const outHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    outHeaders[k] = v;
  });
  return { status: res.status, body: parsed, headers: outHeaders, bytes };
}

// ---- sessions / WS -----------------------------------------------------------

export interface SessionInfo {
  sessionId: string;
  connId: string;
  wsToken: string;
  revision: number;
  body: Record<string, unknown>;
}

export async function establish(origin: string, sessionId = mkSessionId()): Promise<SessionInfo> {
  const res = await http(`${origin}/api/v1/sessions`, {
    body: { projectId: CONTENT_PROJECT, sessionId, clientInfo: { kind: 'browser', label: 'packet-25-test' } },
    token: AUTH_TOKEN,
    origin: AUTHORING_ORIGIN,
  });
  if (res.status !== 200 || typeof res.body !== 'object' || res.body === null) {
    throw new Error(`establish failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  const body = res.body as Record<string, unknown>;
  return {
    sessionId,
    connId: String(body.connId),
    wsToken: String(body.wsToken),
    revision: Number(body.revision),
    body,
  };
}

export interface WsInbox {
  events: Array<Record<string, unknown>>;
  close: () => void;
  waitFor: (predicate: (e: Record<string, unknown>) => boolean, timeoutMs?: number) => Promise<Record<string, unknown>>;
}

/** Open a real WS connection and queue every event (text frames). */
export async function openWs(origin: string, session: SessionInfo): Promise<WsInbox> {
  const url = `${origin.replace('http', 'ws')}/api/v1/ws?sessionId=${session.sessionId}&wsToken=${session.wsToken}`;
  const ws = new WebSocket(url, { headers: { Origin: AUTHORING_ORIGIN } });
  const events: Array<Record<string, unknown>> = [];
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', (e) => reject(e instanceof Error ? e : new Error(String(e))));
  });
  ws.on('message', (data: Uint8Array) => {
    try {
      events.push(JSON.parse(new TextDecoder().decode(data)) as Record<string, unknown>);
    } catch {
      // ignore non-JSON
    }
  });
  const waitFor = (predicate: (e: Record<string, unknown>) => boolean, timeoutMs = 5000): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const existing = events.find(predicate);
      if (existing !== undefined) {
        resolve(existing);
        return;
      }
      const timer = setTimeout(() => reject(new Error(`WS event not observed within ${timeoutMs}ms; saw ${JSON.stringify(events)}`)), timeoutMs);
      const check = (): void => {
        const found = events.find(predicate);
        if (found !== undefined) {
          clearTimeout(timer);
          clearInterval(interval);
          resolve(found);
        }
      };
      const interval = setInterval(check, 10);
    });
  return { events, close: () => ws.close(), waitFor };
}

// ---- MCP (actual stdio MCP process ⇄ real SDK client ⇄ real backend) --------

export interface McpHarness {
  call: (name: string, args: Record<string, unknown>) => Promise<{ body: Record<string, unknown>; isError: boolean }>;
  listTools: () => Promise<string[]>;
  close: () => Promise<void>;
}

/**
 * Start the ACTUAL stdio MCP server process (bundled entry) and connect a REAL
 * `@modelcontextprotocol/sdk` client over its stdio transport. Every tool call
 * therefore crosses a process boundary and reaches the real backend over
 * `/api/v1` — there is no in-process shortcut and no filesystem bypass.
 */
export async function createMcp(origin: string, clientId = 'packet-25-mcp'): Promise<McpHarness> {
  const bundlePath = await ensureMcpBundle();
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v;
  env['THIRDLIGHT_MCP_RUN'] = '1';
  env['THIRDLIGHT_AUTHORING_ORIGIN'] = origin;
  env['THIRDLIGHT_PROJECT_ID'] = CONTENT_PROJECT;
  env['THIRDLIGHT_MCP_TOKEN'] = AUTH_TOKEN;
  env['THIRDLIGHT_MCP_CLIENT_ID'] = clientId;
  const transport = new StdioClientTransport({ command: process.execPath, args: [bundlePath], env, stderr: 'pipe' });
  const sdk = new Client({ name: 'packet-25-integration', version: '0.1.0' });
  await sdk.connect(transport);
  const call = async (name: string, args: Record<string, unknown>): Promise<{ body: Record<string, unknown>; isError: boolean }> => {
    const res = await sdk.callTool({ name, arguments: args });
    const item = (res.content as Array<{ type?: string; text?: string }>).find((c) => c.type === 'text' && typeof c.text === 'string');
    if (item === undefined || typeof item.text !== 'string') throw new Error('no text content in tool result');
    return { body: JSON.parse(item.text) as Record<string, unknown>, isError: res.isError === true };
  };
  return {
    call,
    listTools: async () => (await sdk.listTools()).tools.map((t) => t.name),
    close: async () => {
      await sdk.close();
    },
  };
}

// ---- misc --------------------------------------------------------------------

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}
