/**
 * The MCP server executable entry (dependencies.md §3: `mcp-adapter` `.` =
 * "the MCP server (not importable by any package)" — the process entry).
 *
 * Transport: **stdio** (decision 0001 §5's listed alternative; the
 * `node: []` boundary — no `node:http` — makes streamable HTTP not
 * self-hostable by this package, so the harness spawns this process and
 * speaks MCP over stdin/stdout). The harness (a thin MCP client) configures
 * the connection via environment variables (documented in
 * docs/handoffs/11.md; no credentials are baked in):
 *
 *   THIRDLIGHT_AUTHORING_ORIGIN  e.g. http://127.0.0.1:8501  (required)
 *   THIRDLIGHT_PROJECT_ID        e.g. demo-0001  (optional: without it the project is the
 *                                folder project the harness runs in — the backend finds
 *                                the nearest thirdlight.json above the working folder)
 *   THIRDLIGHT_MCP_TOKEN         the backend's owner token (required)
 *   THIRDLIGHT_MCP_CLIENT_ID     recorded as origin.clientId on MCP commands (optional, default "mcp-harness")
 *   THIRDLIGHT_MCP_TIMEOUT_MS    per-backend-request timeout (optional, default 30000)
 *
 * `stdout` carries ONLY the MCP message stream; all logging goes to `stderr`.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { BackendClient } from './backend-client';
import { createMcpServer } from './server';
import type { McpContext } from './tools';

function log(msg: string): void {
  try {
    process.stderr.write(`[thirdlight-mcp] ${msg}\n`);
  } catch {
    // Never let logging crash the MCP process.
  }
}

function required(name: string): string {
  const v = process.env[name];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`missing required environment variable ${name}`);
  }
  return v;
}

export interface McpEntryOptions {
  readonly authoringOrigin: string;
  /** Absent ⇒ resolved from `cwd` on the first tool call. */
  readonly projectId?: string;
  /** The folder the harness runs in (default: the process's working folder). */
  readonly cwd?: string;
  readonly token: string;
  readonly clientId?: string;
  readonly timeoutMs?: number;
}

/** Build the connected stdio MCP server from options (used by `main`). */
export async function startStdioMcpServer(opts: McpEntryOptions): Promise<() => Promise<void>> {
  const client = new BackendClient({
    authoringOrigin: opts.authoringOrigin,
    token: opts.token,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
  const clientId = opts.clientId ?? 'mcp-harness';
  const cwd = opts.cwd ?? process.cwd();
  let resolved: McpContext | null = opts.projectId !== undefined ? { client, projectId: opts.projectId, clientId } : null;
  const provider = async (): Promise<{ ok: true; ctx: McpContext } | { ok: false; message: string }> => {
    if (resolved !== null) return { ok: true, ctx: resolved };
    let res;
    try {
      res = await client.resolveFolder(cwd);
    } catch (e) {
      return { ok: false, message: `the Thirdlight backend at ${opts.authoringOrigin} is not reachable (${e instanceof Error ? e.message : String(e)})` };
    }
    const body = res.body as { ok?: boolean; projectId?: string; error?: { message?: string; reason?: string; folder?: string; markerProjectId?: string } } | null;
    if (body?.ok === true && typeof body.projectId === 'string') {
      resolved = { client, projectId: body.projectId, clientId };
      log(`project ${body.projectId} (from ${cwd})`);
      return { ok: true, ctx: resolved };
    }
    const e = body?.error;
    if (e?.reason === 'not_registered') {
      return { ok: false, message: `${e.folder ?? cwd}/thirdlight.json (project "${e.markerProjectId ?? '?'}") is not registered with the backend. Open it in the editor's project picker ("Open project folder…"), or run: node tools/project.mjs register ${e.folder ?? cwd}` };
    }
    if (e?.reason === 'no_marker') {
      return { ok: false, message: `no thirdlight.json in ${cwd} or any parent folder. Run the harness inside a Thirdlight project folder, or set THIRDLIGHT_PROJECT_ID.` };
    }
    return { ok: false, message: e?.message ?? `could not resolve the project for ${cwd} (status ${res.status})` };
  };
  const server = createMcpServer(provider);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`ready (${opts.projectId !== undefined ? `project ${opts.projectId}` : `project from ${cwd}`}, origin ${opts.authoringOrigin}); MCP over stdio`);
  return async () => {
    await server.close();
  };
}

export async function main(): Promise<void> {
  let close: () => Promise<void>;
  try {
    const clientId = process.env.THIRDLIGHT_MCP_CLIENT_ID;
    const timeoutRaw = process.env.THIRDLIGHT_MCP_TIMEOUT_MS;
    const timeoutNum = Number(timeoutRaw ?? '');
    const opts: McpEntryOptions = {
      authoringOrigin: required('THIRDLIGHT_AUTHORING_ORIGIN'),
      ...(process.env.THIRDLIGHT_PROJECT_ID ? { projectId: process.env.THIRDLIGHT_PROJECT_ID } : {}),
      token: required('THIRDLIGHT_MCP_TOKEN'),
      ...(typeof clientId === 'string' && clientId.length > 0 ? { clientId } : {}),
      ...(Number.isInteger(timeoutNum) && timeoutNum > 0 ? { timeoutMs: timeoutNum } : {}),
    };
    close = await startStdioMcpServer(opts);
  } catch (err) {
    log(`startup failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  // Keep the process alive for the stdio transport until signalled.
  process.on('SIGINT', () => {
    void close().then(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    void close().then(() => process.exit(0));
  });
}

// Execute when run as the process entry (the `.` subpath). A guard so this
// module can also be imported for its exports without starting the server.
if (typeof process !== 'undefined' && process.env.THIRDLIGHT_MCP_RUN === '1') {
  void main();
}