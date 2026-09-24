/**
 * Packet 48 integration harness — a disposable data root holding the committed
 * v3 project (`fixtures/m3/storage/project-v3-demo-0003`) and a second project
 * seeded from the committed v2 project (`fixtures/m3/storage/project-v2-demo-0002`),
 * a REAL backend process (esbuild-bundled child, real fs + real HTTP/WS), and a
 * REAL `@modelcontextprotocol/sdk` client over a real stdio transport against
 * the out-of-process MCP server.
 *
 * Storage (phase 9.3 step B): the workspace opens only storage v4, upgrades a
 * v3 project in place on open and refuses v1/v2. Both seeded projects open as
 * v4: demo-0003 is v3 as committed; demo-0002's seeded copy is converted to
 * the equivalent v3 envelope (tests/storage-seed.ts). The committed fixtures
 * are never modified.
 *
 * Nothing is mocked where the packet requires integration: upload, staging,
 * inspection (model + audio + role-aware), blob publication, the §20 relays
 * and the project writes all run on the real filesystem in the child. Bytes
 * are read from the committed `fixtures/m3/media/**` files.
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

import { upgradeSeededEnvelopeToV3 } from '../../storage-seed';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const V3_FIXTURE = join(REPO_ROOT, 'fixtures', 'm3', 'storage', 'project-v3-demo-0003');
const V2_FIXTURE = join(REPO_ROOT, 'fixtures', 'm3', 'storage', 'project-v2-demo-0002');
/** `fixtures/m3/storage/project-v2-demo-0002`'s single referenced asset blob. */
export const V2_BLOB_DIGEST = 'ec535bb2ebcdecb508d7ea0372fe1562d547a9dd0fd5498d1d55c3e61ba44ecc';
const V2_BLOB_SOURCE = join(REPO_ROOT, 'fixtures', 'm3', 'contracts', 'source-preimages', 'courier.glb');
const MEDIA = join(REPO_ROOT, 'fixtures', 'm3', 'media');
const ROOT_BASE = tmpdir() === '/tmp' ? '/home/dadmin' : tmpdir();

export const AUTHORING_ORIGIN = 'http://127.0.0.1:8501';
export const PREVIEW_ORIGIN = 'http://127.0.0.1:8502';
export const V3_PROJECT = 'demo-0003';
export const V2_PROJECT = 'demo-0002';
export const V3_COPY_PROJECT = 'demo-0002-v3';
export const AUTH_TOKEN = 'm3-content-authoring-token';
export const V2_AUTH_TOKEN = 'm3-content-v2-authoring-token';
export const ADMIN_TOKEN = 'm3-content-admin-token';

function hex(n: number): string {
  let s = '';
  const b = randomBytes(n);
  for (let i = 0; i < b.length; i += 1) s += (b[i] ?? 0).toString(16).padStart(2, '0');
  return s;
}

export const mkRequestId = (): string => `req-${hex(16)}`;
export const mkSessionId = (): string => `sess-${hex(16)}`;
export const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export interface DisposableRoot {
  root: string;
  dataRoot: string;
  editorDir: string;
  previewDir: string;
  v3Dir: string;
  v2Dir: string;
}

/** A disposable root with the static bundles and both committed seed projects. */
export function makeRoot(tag: string): DisposableRoot {
  const root = mkdtempSync(join(ROOT_BASE, `.tl48-${tag}-${process.pid}-`));
  const dataRoot = join(root, 'data');
  const editorDir = join(root, 'editor');
  const previewDir = join(root, 'preview');
  mkdirSync(editorDir, { recursive: true });
  mkdirSync(previewDir, { recursive: true });
  mkdirSync(join(dataRoot, 'projects'), { recursive: true });
  writeFileSync(join(editorDir, 'index.html'), '<!doctype html><html><body>editor</body></html>\n');
  writeFileSync(join(previewDir, 'preview-m3.js'), '// play bundle stub (tests)\n');
  const v3Dir = join(dataRoot, 'projects', V3_PROJECT);
  const v2Dir = join(dataRoot, 'projects', V2_PROJECT);
  cpSync(V3_FIXTURE, v3Dir, { recursive: true });
  cpSync(V2_FIXTURE, v2Dir, { recursive: true });
  mkdirSync(join(v3Dir, 'sources', 'sha256'), { recursive: true });
  mkdirSync(join(v2Dir, 'sources', 'sha256'), { recursive: true });
  // The second project references one immutable blob (present and matching).
  cpSync(V2_BLOB_SOURCE, join(v2Dir, 'sources', 'sha256', V2_BLOB_DIGEST));
  upgradeSeededEnvelopeToV3(v2Dir);
  return { root, dataRoot, editorDir, previewDir, v3Dir, v2Dir };
}

/** A committed `fixtures/m3/media/**` file's bytes. */
export function mediaBytes(rel: string): Uint8Array {
  return new Uint8Array(readFileSync(join(MEDIA, rel)));
}

/** A committed fixture JSON (`fixtures/m3/media/**`). */
export function mediaJson<T>(rel: string): T {
  return JSON.parse(readFileSync(join(MEDIA, rel), 'utf8')) as T;
}

let childBundle: string | null = null;
let mcpBundle: string | null = null;
const BUNDLE_DIR = join(REPO_ROOT, '.tl48-bundles');

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
  stderr: () => string;
}

export async function spawnBackend(
  root: DisposableRoot,
  tokens: Array<{ token: string; scope: string }>,
): Promise<BackendProcess> {
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
  let err = '';
  proc.stderr?.on('data', (d: Uint8Array) => {
    err += new TextDecoder().decode(d);
  });
  const ready = await new Promise<{ portAuthoring: number; portPreview: number }>((resolve, reject) => {
    let out = '';
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
    stderr: () => err,
  };
}

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

export async function establish(origin: string, projectId = V3_PROJECT, token = AUTH_TOKEN, sessionId = mkSessionId()): Promise<SessionInfo> {
  const res = await http(`${origin}/api/v1/sessions`, {
    body: { projectId, sessionId, clientInfo: { kind: 'browser', label: 'packet-48-test' } },
    token,
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
  send: (payload: unknown) => void;
  close: () => void;
  waitFor: (predicate: (e: Record<string, unknown>) => boolean, timeoutMs?: number) => Promise<Record<string, unknown>>;
}

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
  const waitFor = (
    predicate: (e: Record<string, unknown>) => boolean,
    timeoutMs = 5000,
  ): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const existing = events.find(predicate);
      if (existing !== undefined) {
        resolve(existing);
        return;
      }
      const timer = setTimeout(
        () => reject(new Error(`WS event not observed within ${timeoutMs}ms; saw ${JSON.stringify(events)}`)),
        timeoutMs,
      );
      const interval = setInterval(() => {
        const found = events.find(predicate);
        if (found !== undefined) {
          clearTimeout(timer);
          clearInterval(interval);
          resolve(found);
        }
      }, 10);
    });
  return {
    events,
    send: (payload: unknown) => ws.send(JSON.stringify(payload)),
    close: () => ws.close(),
    waitFor,
  };
}

// ---- MCP (actual stdio MCP process ⇄ real SDK client ⇄ real backend) --------

export interface McpHarness {
  call: (name: string, args: Record<string, unknown>) => Promise<{ body: Record<string, unknown>; isError: boolean }>;
  listTools: () => Promise<string[]>;
  close: () => Promise<void>;
}

export async function createMcp(origin: string, projectId = V3_PROJECT, token = AUTH_TOKEN, clientId = 'packet-48-mcp'): Promise<McpHarness> {
  const bundlePath = await ensureMcpBundle();
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v;
  env['THIRDLIGHT_MCP_RUN'] = '1';
  env['THIRDLIGHT_AUTHORING_ORIGIN'] = origin;
  env['THIRDLIGHT_PROJECT_ID'] = projectId;
  env['THIRDLIGHT_MCP_TOKEN'] = token;
  env['THIRDLIGHT_MCP_CLIENT_ID'] = clientId;
  const transport = new StdioClientTransport({ command: process.execPath, args: [bundlePath], env, stderr: 'pipe' });
  const sdk = new Client({ name: 'packet-48-integration', version: '0.1.0' });
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

/**
 * The full real content route (stage → upload frames → inspect → discard) over
 * plain HTTP. Used where a test sweeps many sources and must not accumulate
 * open stages (the §13.9 8-open-stage bound). The response is the inspect
 * route's exact result (a bounded proposal or the structured error).
 */
export async function inspectViaHttp(
  origin: string,
  projectId: string,
  token: string,
  bytes: Uint8Array,
  body: Record<string, unknown> = {},
): Promise<HttpResult> {
  const created = await http(`${origin}/api/v1/projects/${projectId}/content/stages`, {
    body: {},
    token,
    origin: AUTHORING_ORIGIN,
  });
  const stageId = (created.body as { stageId?: string }).stageId;
  if (typeof stageId !== 'string') return created;
  let last: HttpResult = created;
  for (let offset = 0; offset < bytes.length; offset += 1_048_576) {
    const frame = bytes.subarray(offset, Math.min(offset + 1_048_576, bytes.length));
    last = await http(`${origin}/api/v1/projects/${projectId}/content/stages/${stageId}/bytes`, {
      method: 'PUT',
      rawBody: frame,
      token,
      origin: AUTHORING_ORIGIN,
      headers: { 'x-thirdlight-offset': String(offset), 'x-thirdlight-total': String(bytes.length) },
    });
  }
  if (last.status !== 200) return last;
  const inspected = await http(`${origin}/api/v1/projects/${projectId}/content/stages/${stageId}/inspect`, {
    body,
    token,
    origin: AUTHORING_ORIGIN,
  });
  await http(`${origin}/api/v1/projects/${projectId}/content/stages/${stageId}`, {
    method: 'DELETE',
    token,
    origin: AUTHORING_ORIGIN,
  });
  return inspected;
}

export function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/** A `publishAsset` args object built from an accepted inspection proposal. */
export function publishArgs(
  mode: 'create' | 'reimport',
  assetId: string,
  proposal: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    mode,
    assetId,
    sourceDigest: String(proposal.sourceDigest),
    sourceByteLength: Number(proposal.sourceByteLength),
    importRecipe: proposal.importRecipe,
    metrics: proposal.metrics,
    importedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    ...extra,
  };
}
