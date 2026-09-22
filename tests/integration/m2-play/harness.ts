/**
 * Packet 35 integration harness: a disposable data root, a REAL backend
 * process (esbuild-bundled child, real fs + real HTTP/WS), a real MCP SDK
 * client over a real stdio transport, and a real owner-editor WS client that
 * relays the play relay/bridge traffic exactly as the editor does.
 *
 * Nothing is mocked where the packet requires integration: the play build, the
 * immutable artifact store, the locator reads and the input relay all run in
 * the child against the real filesystem.
 */
import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { WebSocket } from 'ws';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const STORAGE_FIXTURE = join(REPO_ROOT, 'fixtures', 'm2', 'storage');
const ROOT_BASE = tmpdir() === '/tmp' ? '/home/dadmin' : tmpdir();

export const AUTHORING_ORIGIN = 'http://127.0.0.1:8501';
export const PREVIEW_ORIGIN = 'http://127.0.0.1:8502';
export const PLAY_PROJECT = 'demo-store-01';
export const AUTH_TOKEN = 'm2-play-authoring-token';
export const ADMIN_TOKEN = 'm2-play-admin-token';

const hex = (n: number): string => {
  let s = '';
  for (let i = 0; i < n; i += 1) s += Math.floor(Math.random() * 16).toString(16);
  return s;
};
export const mkRequestId = (): string => `req-${hex(32)}`;
export const mkSessionId = (): string => `sess-${hex(32)}`;
export const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export interface DisposableRoot {
  root: string;
  dataRoot: string;
  editorDir: string;
  previewDir: string;
  projectDir: string;
}

/** A disposable root with the static bundles and the seeded v2 project. */
export function makeRoot(tag: string): DisposableRoot {
  const root = mkdtempSync(join(ROOT_BASE, `.tl35-${tag}-${process.pid}-`));
  const dataRoot = join(root, 'data');
  const editorDir = join(root, 'editor');
  const previewDir = join(root, 'preview');
  mkdirSync(editorDir, { recursive: true });
  mkdirSync(previewDir, { recursive: true });
  mkdirSync(join(dataRoot, 'projects'), { recursive: true });
  writeFileSync(join(editorDir, 'index.html'), '<!doctype html><html><body>editor</body></html>\n');
  // The prebuilt play bundle served as `game.js` (a real bundle in production).
  writeFileSync(join(previewDir, 'preview.js'), '// thirdlight play bundle stub (integration test)\n');
  const projectDir = join(dataRoot, 'projects', PLAY_PROJECT);
  cpSync(join(STORAGE_FIXTURE, 'project'), projectDir, { recursive: true });
  mkdirSync(join(projectDir, 'sources', 'sha256'), { recursive: true });
  for (const blob of ['alpha.bin', 'beta.bin']) {
    cpSync(join(STORAGE_FIXTURE, 'blobs', blob), join(projectDir, 'sources', 'sha256', sha256Hex(readFileSync(join(STORAGE_FIXTURE, 'blobs', blob)))));
  }
  return { root, dataRoot, editorDir, previewDir, projectDir };
}

export function fixtureBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(REPO_ROOT, 'fixtures', 'm2', 'assets', name)));
}

let childBundle: string | null = null;
const BUNDLE_DIR = join(REPO_ROOT, '.tl35-bundles');

export async function ensureBackendBundle(): Promise<string> {
  if (childBundle !== null) return childBundle;
  mkdirSync(BUNDLE_DIR, { recursive: true });
  const out = join(BUNDLE_DIR, `child-${process.pid}.mjs`);
  await build({
    entryPoints: [join(REPO_ROOT, 'tests', 'integration', 'm2-content', 'backend-child.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: out,
    external: ['ws', 'esbuild'],
    logLevel: 'silent',
  });
  childBundle = out;
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
}

export interface BackendProcess {
  proc: ChildProcess;
  pid: number;
  origin: string;
  previewOrigin: string;
}

export async function spawnBackend(root: DisposableRoot): Promise<BackendProcess> {
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
    tokens: [
      { token: AUTH_TOKEN, scope: `authoring:${PLAY_PROJECT}` },
      { token: ADMIN_TOKEN, scope: 'admin' },
    ],
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

export interface HttpResult {
  status: number;
  body: unknown;
  headers: Record<string, string>;
  bytes: Uint8Array;
}

export async function http(
  url: string,
  opts: { method?: string; body?: unknown; token?: string; origin?: string; headers?: Record<string, string> } = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`;
  if (opts.origin !== undefined) headers.origin = opts.origin;
  let body: BodyInit | undefined;
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(url, { method: opts.method ?? (body === undefined ? 'GET' : 'POST'), headers, body });
  const bytes = new Uint8Array(await res.arrayBuffer());
  const outHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    outHeaders[k] = v;
  });
  let parsed: unknown = null;
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('json') && bytes.length > 0) parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  return { status: res.status, body: parsed, headers: outHeaders, bytes };
}

export interface SessionInfo {
  sessionId: string;
  connId: string;
  wsToken: string;
  revision: number;
}

export async function establish(origin: string, sessionId = mkSessionId()): Promise<SessionInfo> {
  const res = await http(`${origin}/api/v1/sessions`, {
    body: { projectId: PLAY_PROJECT, sessionId, clientInfo: { kind: 'browser', label: 'packet-35-test' } },
    token: AUTH_TOKEN,
    origin: AUTHORING_ORIGIN,
  });
  if (res.status !== 200 || typeof res.body !== 'object' || res.body === null) {
    throw new Error(`establish failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  const body = res.body as Record<string, unknown>;
  return { sessionId, connId: String(body.connId), wsToken: String(body.wsToken), revision: Number(body.revision) };
}

/**
 * The owner-editor stub: a real WS client that presents the preview, answers
 * stop/relay requests, and plays the editor's relay role for the input bridge
 * (it answers `input.request` with a bounded `input.result`, exactly as the
 * editor does after the preview's `tl.input.result`).
 */
export class FakeEditor {
  readonly events: Array<Record<string, unknown>> = [];
  readonly inputRequests: Array<Record<string, unknown>> = [];
  readonly stopRequests: Array<Record<string, unknown>> = [];
  inputReply: { ok: boolean; appliedFromStep?: number; appliedToStep?: number; error?: { code: string } } | null = { ok: true };
  presentOnStart = true;
  ackStops = true;
  /** When true the stub never answers `input.request` (timeout cases). */
  silentInput = false;

  private readonly ws: WebSocket;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (data: Uint8Array) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(new TextDecoder().decode(data)) as Record<string, unknown>;
      } catch {
        return;
      }
      this.events.push(msg);
      this.handle(msg);
    });
  }

  static async open(origin: string, session: SessionInfo): Promise<FakeEditor> {
    const url = `${origin.replace('http', 'ws')}/api/v1/ws?sessionId=${session.sessionId}&wsToken=${session.wsToken}`;
    const ws = new WebSocket(url, { headers: { Origin: AUTHORING_ORIGIN } });
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', (e) => reject(e instanceof Error ? e : new Error(String(e))));
    });
    return new FakeEditor(ws);
  }

  private handle(msg: Record<string, unknown>): void {
    const type = msg.type;
    if (type === 'play.started' && this.presentOnStart) {
      const playSessionId = msg.playSessionId as string;
      this.ws.send(JSON.stringify({ type: 'play.preview.ready', playSessionId }));
    } else if (type === 'play.stop.request' && this.ackStops) {
      this.ws.send(JSON.stringify({ type: 'play.stopped.ack', playSessionId: msg.playSessionId }));
    } else if (type === 'input.request') {
      this.inputRequests.push(msg);
      if (this.silentInput) return;
      const reply = this.inputReply ?? { ok: true };
      const frames = msg.frames as Array<{ stepOffset: number }>;
      this.ws.send(
        JSON.stringify({
          type: 'input.result',
          requestId: msg.requestId,
          ok: reply.ok,
          appliedFromStep: reply.ok ? 100 + (frames[0]?.stepOffset ?? 0) : undefined,
          appliedToStep: reply.ok ? 100 + (frames[frames.length - 1]?.stepOffset ?? 0) : undefined,
          ...(reply.ok ? {} : { error: reply.error ?? { code: 'input_relay_conflict' } }),
        }),
      );
    }
  }

  send(frame: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(frame));
  }

  async waitFor(predicate: (e: Record<string, unknown>) => boolean, timeoutMs = 8000): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.events.find(predicate);
      if (found !== undefined) return found;
      if (Date.now() > deadline) throw new Error(`event not observed within ${timeoutMs}ms; saw ${JSON.stringify(this.events)}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  close(): void {
    this.ws.close();
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---- the real stdio MCP SDK path ---------------------------------------------

let mcpBundle: string | null = null;

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
    external: ['ws', 'esbuild', '@modelcontextprotocol/sdk'],
    logLevel: 'silent',
  });
  mcpBundle = out;
  return out;
}

export interface McpHarness {
  call: (name: string, args: Record<string, unknown>) => Promise<{ body: Record<string, unknown>; isError: boolean }>;
  listTools: () => Promise<string[]>;
  close: () => Promise<void>;
}

/**
 * Start the ACTUAL stdio MCP server process and connect a REAL
 * `@modelcontextprotocol/sdk` client over its stdio transport. Every tool call
 * therefore crosses a process boundary and reaches the real backend over
 * `/api/v1` — there is no in-process shortcut.
 */
export async function createMcp(origin: string, clientId = 'packet-35-mcp'): Promise<McpHarness> {
  const bundlePath = await ensureMcpBundle();
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v;
  env['THIRDLIGHT_MCP_RUN'] = '1';
  env['THIRDLIGHT_AUTHORING_ORIGIN'] = origin;
  env['THIRDLIGHT_PROJECT_ID'] = PLAY_PROJECT;
  env['THIRDLIGHT_MCP_TOKEN'] = AUTH_TOKEN;
  env['THIRDLIGHT_MCP_CLIENT_ID'] = clientId;
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const transport = new StdioClientTransport({ command: process.execPath, args: [bundlePath], env, stderr: 'pipe' });
  const sdk = new Client({ name: 'packet-35-integration', version: '0.1.0' });
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
