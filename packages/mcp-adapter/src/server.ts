/**
 * The MCP server (decision 0001: "the backend exposes an MCP server"). Built on the supported
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
 * dependency (zod is not a pinned dependency; it is only a transitive dep of the SDK).
 * The SDK's own protocol schemas (`ListToolsRequestSchema`,
 * `CallToolRequestSchema`) are imported from the SDK and used unchanged.
 *
 * Pure Node (no `node:` imports) — this module does no I/O itself.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { TOOL_DEFINITIONS, handleToolCall, type McpContext } from './tools';

/**
 * The server instructions (the protocol's `instructions`, which a client
 * shows its model once per session): where to start and how to learn the
 * engine from the running build rather than from memory or the engine's
 * source.
 */
export const MCP_INSTRUCTIONS =
  'Thirdlight is a browser game editor and engine; these tools work on the game project of the folder you run in. ' +
  'Start with tl_docs {topic: "getting-started/first-project"} and the contents (tl_docs with no topic). ' +
  'Before you use an op, a component or a script call, look it up: tl_docs {topic: "op.<op>"}, "component.<name>", "ctx.<member>" ' +
  '(the reference comes from the running build; tl_inspect target="engine" names that build). ' +
  'There is one way to change a project: tl_command (and tl_script_publish for script code), the same commands the editor sends; ' +
  'do not edit the project\'s files by hand while the backend has it open. Read with tl_inspect and tl_content_query; ' +
  'test with tl_play_start, tl_input_exercise, tl_game_observe, tl_screenshot and tl_playtest.';

export interface McpServerInfo {
  readonly name: string;
  readonly version: string;
}

/** Resolves the project context lazily (the project is worked out from the harness's folder). */
export type McpContextProvider = () => Promise<{ ok: true; ctx: McpContext } | { ok: false; message: string }>;

/**
 * Build the Thirdlight MCP server with the charter's tool surface. The
 * server auto-handles `initialize` (the SDK `Server` base registers the
 * `InitializeRequestSchema` handler); we register `tools/list` + `tools/call`.
 */
export function createMcpServer(ctx: McpContext | McpContextProvider, info?: McpServerInfo): Server {
  const serverInfo = info ?? { name: 'thirdlight-mcp', version: '0.1.0' };
  const server = new Server(serverInfo, {
    capabilities: { tools: { listChanged: false } },
    instructions: MCP_INSTRUCTIONS,
  });

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: TOOL_DEFINITIONS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params?.name;
    const args = req.params?.arguments;
    if (typeof ctx !== 'function') return handleToolCall(ctx, name, args);
    const resolved = await ctx();
    if (!resolved.ok) {
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, error: { code: 'project_not_resolved', message: resolved.message } }) }] };
    }
    return handleToolCall(resolved.ctx, name, args);
  });

  return server;
}

export { TOOL_DEFINITIONS, MCP_TOOL_NAMES } from './tools';
export type { McpContext, CallToolResult, ToolDefinition } from './tools';