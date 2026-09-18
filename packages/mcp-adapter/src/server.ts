/**
 * The MCP server (decision 0001 §5: "the backend exposes an MCP server" — the
 * server side is this packet's deliverable). Built on the supported
 * `@modelcontextprotocol/sdk` (pinned 1.30.0) low-level `Server`, using the
 * protocol's `tools/list` + `tools/call` primitives.
 *
 * `createMcpServer(ctx)` returns an UNCONNECTED `Server`. The caller wires a
 * transport:
 *   - production: `StdioServerTransport` (the `. ` executable entry, index.ts);
 *   - tests: an `InMemoryTransport` linked pair (a real MCP client connects).
 *
 * Using the low-level `Server` (rather than `McpServer` + `registerTool`)
 * keeps the input schemas plain JSON Schema objects and avoids a direct `zod`
 * dependency (zod is not a §7 pin; it is only a transitive dep of the SDK).
 * The SDK's own protocol schemas (`ListToolsRequestSchema`,
 * `CallToolRequestSchema`) are imported from the SDK and used unchanged.
 *
 * Pure Node (no `node:` imports) — this module does no I/O itself.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { TOOL_DEFINITIONS, handleToolCall, type McpContext } from './tools';

export interface McpServerInfo {
  readonly name: string;
  readonly version: string;
}

/**
 * Build the Thirdlight MCP server with the charter §7 tool surface. The
 * server auto-handles `initialize` (the SDK `Server` base registers the
 * `InitializeRequestSchema` handler); we register `tools/list` + `tools/call`.
 */
export function createMcpServer(ctx: McpContext, info?: McpServerInfo): Server {
  const serverInfo = info ?? { name: 'thirdlight-mcp', version: '0.1.0' };
  const server = new Server(serverInfo, {
    capabilities: { tools: { listChanged: false } },
  });

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: TOOL_DEFINITIONS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, (req) => {
    const name = req.params?.name;
    const args = req.params?.arguments;
    return handleToolCall(ctx, name, args);
  });

  return server;
}

export { TOOL_DEFINITIONS, MCP_TOOL_NAMES } from './tools';
export type { McpContext, CallToolResult, ToolDefinition } from './tools';