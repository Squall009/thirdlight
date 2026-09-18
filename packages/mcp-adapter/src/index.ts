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
 *   THIRDLIGHT_PROJECT_ID        e.g. demo-0001              (required)
 *   THIRDLIGHT_MCP_TOKEN         an authoring:<projectId> or admin bearer token (required)
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
  readonly projectId: string;
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
  const ctx: McpContext = {
    client,
    projectId: opts.projectId,
    clientId: opts.clientId ?? 'mcp-harness',
  };
  const server = createMcpServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`ready (project ${opts.projectId}, origin ${opts.authoringOrigin}); MCP over stdio`);
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
      projectId: required('THIRDLIGHT_PROJECT_ID'),
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