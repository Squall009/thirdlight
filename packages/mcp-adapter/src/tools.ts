/**
 * The MCP tool surface (charter §7; decision 0001 §5). Six categories,
 * exposed as MCP tools and routed into the backend's `/api/v1` command/query/
 * play services via `BackendClient` (never a second mutation engine).
 *
 * - bounded project/entity inspection → `tl_inspect`
 * - command submission                → `tl_command`
 * - session listing                   → `tl_sessions`
 * - play start/stop                   → `tl_play_start`, `tl_play_stop`
 * - bounded diagnostics               → `tl_diagnostics`
 * - screenshot (selected browser)     → `tl_screenshot`
 *
 * Responses carry the relevant revision/session IDs, surface the backend's
 * structured errors (code + message + fields such as `currentRevision`), and
 * are bounded by the backend's own payload limits (queries paged/counts-only,
 * screenshot ≤ 1 MiB, diagnostics ≤ 16 KiB). No general eval/shell tool.
 *
 * Pure Node (no `node:` imports): arg validation is manual; the input schemas
 * are plain JSON Schema objects advertised via `tools/list`.
 */

import { BackendClient, makeRequestId } from './backend-client';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export interface McpContext {
  readonly client: BackendClient;
  readonly projectId: string;
  /** The `origin.clientId` recorded on MCP-submitted commands (commands.md §3). */
  readonly clientId: string;
}

export type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

/** The M1 command ops (commands.md §2/§4). */
const MUTATION_OPS = ['createEntity', 'setTransform', 'deleteEntity', 'undo', 'redo'] as const;
const QUERY_OPS = ['queryProject', 'queryEntity', 'queryEntities'] as const;

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The advertised tools (plain JSON Schema input schemas — no zod). */
export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: 'tl_inspect',
    description:
      'Bounded, read-only inspection of the project. target="project" returns counts and IDs only; ' +
      'target="entity" returns one entity (plus subtree only if includeSubtree=true); ' +
      'target="entities" returns a paged list (limit ≤ 1024, default 100). Never mutates.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['project', 'entity', 'entities'] },
        entityId: { type: 'string' },
        includeSubtree: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 1024 },
        offset: { type: 'integer', minimum: 0 },
      },
      required: ['target'],
      additionalProperties: false,
    },
  },
  {
    name: 'tl_command',
    description:
      'Submit one undoable editing command (createEntity, setTransform, deleteEntity, undo, redo) ' +
      'to the project, with optimistic concurrency (expectedRevision). Returns the new revision on ' +
      'success, or a structured error (e.g. revision_conflict with currentRevision) on failure. ' +
      'Read-only queries use tl_inspect, not this tool.',
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: [...MUTATION_OPS] },
        args: { type: 'object' },
        expectedRevision: { type: 'integer', minimum: 0 },
        requestId: { type: 'string', pattern: '^req-[0-9a-f]{32}$' },
      },
      required: ['op', 'expectedRevision'],
      additionalProperties: false,
    },
  },
  {
    name: 'tl_sessions',
    description: 'List the (bounded) authoring sessions for the project.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'tl_play_start',
    description:
      'Start a play session for the project from the current revision. Requires a connected editor ' +
      'browser (an active authoring session); with none, returns the structured session_unavailable ' +
      'error. Returns playSessionId + the frozen snapshotId/revision on success.',
    inputSchema: {
      type: 'object',
      properties: { demo: { type: 'boolean' } },
      additionalProperties: false,
    },
  },
  {
    name: 'tl_play_stop',
    description: 'Stop an active play session by its playSessionId.',
    inputSchema: {
      type: 'object',
      properties: { playSessionId: { type: 'string' } },
      required: ['playSessionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'tl_diagnostics',
    description:
      'Fetch bounded runtime diagnostics (≤ 16 KiB) from a play session\'s connected preview. Fails ' +
      'structurally if the play is not presented or the editor browser is not connected.',
    inputSchema: {
      type: 'object',
      properties: { playSessionId: { type: 'string' } },
      required: ['playSessionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'tl_screenshot',
    description:
      'Capture a bounded screenshot (dataUrl ≤ 1 MiB, maxWidth 256–2048) from a play session\'s ' +
      'selected connected browser preview. Fails structurally if the play is not presented or the ' +
      'editor browser is not connected.',
    inputSchema: {
      type: 'object',
      properties: {
        playSessionId: { type: 'string' },
        maxWidth: { type: 'integer', minimum: 256, maximum: 2048 },
      },
      required: ['playSessionId'],
      additionalProperties: false,
    },
  },
];

export const MCP_TOOL_NAMES: readonly string[] = TOOL_DEFINITIONS.map((t) => t.name);

/** A structured tool error (surfaced with `isError: true`). */
function toolError(message: string, extra?: Record<string, unknown>): CallToolResult {
  const text = JSON.stringify({ ok: false, error: { code: 'tool_error', message, ...(extra ?? {}) } });
  return { content: [{ type: 'text', text }], isError: true };
}

/** A structured tool success: the backend's body, JSON-encoded (bounded by the backend). */
function toolOk(body: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(body) }] };
}

/** Surface the backend's structured error body as a tool error (keeping code + fields). */
function surfaceBackendError(res: { status: number; body: unknown }): CallToolResult {
  const body = isObj(res.body) ? res.body : { ok: false, error: { code: 'invalid_request', message: 'empty backend response' } };
  return { content: [{ type: 'text', text: JSON.stringify({ ...body, __httpStatus: res.status }) }], isError: true };
}

const MUTATION_SET = new Set<string>(MUTATION_OPS);
const QUERY_SET = new Set<string>(QUERY_OPS);

/** Dispatch one `tools/call` to the backend services. Never throws. */
export async function handleToolCall(
  ctx: McpContext,
  name: string,
  args: unknown,
): Promise<CallToolResult> {
  const a = isObj(args) ? args : {};
  try {
    switch (name) {
      case 'tl_inspect':
        return await inspect(ctx, a);
      case 'tl_command':
        return await command(ctx, a);
      case 'tl_sessions':
        return await sessions(ctx);
      case 'tl_play_start':
        return await playStart(ctx, a);
      case 'tl_play_stop':
        return await playStop(ctx, a);
      case 'tl_diagnostics':
        return await diagnostics(ctx, a);
      case 'tl_screenshot':
        return await screenshot(ctx, a);
      default:
        return toolError(`unknown tool "${String(name).slice(0, 64)}"`);
    }
  } catch (err) {
    // Network/abort failures and unexpected throws become a structured error.
    const msg = err instanceof Error ? err.message : String(err);
    const aborted = msg.includes('abort');
    return toolError(aborted ? 'request to the backend timed out or was aborted' : `internal tool error: ${msg.slice(0, 128)}`);
  }
}

async function inspect(ctx: McpContext, a: Record<string, unknown>): Promise<CallToolResult> {
  const target = a.target;
  if (target !== 'project' && target !== 'entity' && target !== 'entities') {
    return toolError('target must be "project", "entity", or "entities"');
  }
  let op: string;
  let argsOut: Record<string, unknown>;
  if (target === 'project') {
    op = 'queryProject';
    argsOut = {};
  } else if (target === 'entity') {
    op = 'queryEntity';
    if (typeof a.entityId !== 'string' || a.entityId.length === 0) return toolError('entityId is required for target="entity"');
    argsOut = { entityId: a.entityId };
    if (a.includeSubtree !== undefined) {
      if (typeof a.includeSubtree !== 'boolean') return toolError('includeSubtree must be a boolean');
      argsOut.includeSubtree = a.includeSubtree;
    }
  } else {
    op = 'queryEntities';
    argsOut = {};
    if (a.limit !== undefined) {
      if (!isInt(a.limit) || a.limit < 1 || a.limit > 1024) return toolError('limit must be an integer 1–1024');
      argsOut.limit = a.limit;
    }
    if (a.offset !== undefined) {
      if (!isInt(a.offset) || a.offset < 0) return toolError('offset must be an integer ≥ 0');
      argsOut.offset = a.offset;
    }
  }
  const res = await ctx.client.command(ctx.projectId, { op, args: argsOut });
  return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
}

async function command(ctx: McpContext, a: Record<string, unknown>): Promise<CallToolResult> {
  const op = a.op;
  if (typeof op !== 'string' || !MUTATION_SET.has(op)) {
    return toolError(`op must be one of ${MUTATION_OPS.join(', ')}`);
  }
  if (!isInt(a.expectedRevision) || a.expectedRevision < 0) {
    return toolError('expectedRevision is required (an integer ≥ 0) for command submission');
  }
  const requestId = typeof a.requestId === 'string' ? a.requestId : makeRequestId();
  const envelope: Record<string, unknown> = {
    op,
    projectId: ctx.projectId,
    expectedRevision: a.expectedRevision,
    requestId,
    origin: { kind: 'mcp', clientId: ctx.clientId },
  };
  if (a.args !== undefined) {
    if (!isObj(a.args)) return toolError('args must be an object');
    envelope.args = a.args;
  } else if (op !== 'undo' && op !== 'redo') {
    // createEntity/setTransform/deleteEntity require args; undo/redo take none.
    return toolError(`args is required for ${op}`);
  }
  const res = await ctx.client.command(ctx.projectId, envelope);
  return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
}

async function sessions(ctx: McpContext): Promise<CallToolResult> {
  const res = await ctx.client.listSessions(ctx.projectId);
  return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
}

async function playStart(ctx: McpContext, a: Record<string, unknown>): Promise<CallToolResult> {
  // sessions.md §10.1: the play-start body is `{ options: { demo } }` (demo
  // boolean, default true) — `demo` nests under `options`, not at the top level.
  const body: Record<string, unknown> = {};
  if (a.demo !== undefined) {
    if (typeof a.demo !== 'boolean') return toolError('demo must be a boolean');
    body.options = { demo: a.demo };
  }
  const res = await ctx.client.startPlay(ctx.projectId, body);
  return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
}

async function playStop(ctx: McpContext, a: Record<string, unknown>): Promise<CallToolResult> {
  if (typeof a.playSessionId !== 'string' || a.playSessionId.length === 0) return toolError('playSessionId is required');
  const res = await ctx.client.stopPlay(ctx.projectId, a.playSessionId);
  return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
}

async function diagnostics(ctx: McpContext, a: Record<string, unknown>): Promise<CallToolResult> {
  if (typeof a.playSessionId !== 'string' || a.playSessionId.length === 0) return toolError('playSessionId is required');
  const res = await ctx.client.diagnostics(ctx.projectId, a.playSessionId);
  return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
}

async function screenshot(ctx: McpContext, a: Record<string, unknown>): Promise<CallToolResult> {
  if (typeof a.playSessionId !== 'string' || a.playSessionId.length === 0) return toolError('playSessionId is required');
  let maxWidth: number | undefined;
  if (a.maxWidth !== undefined) {
    if (!isInt(a.maxWidth) || a.maxWidth < 256 || a.maxWidth > 2048) return toolError('maxWidth must be an integer 256–2048');
    maxWidth = a.maxWidth;
  }
  const res = await ctx.client.screenshot(ctx.projectId, a.playSessionId, maxWidth);
  return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
}