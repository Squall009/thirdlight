/**
 * End-to-end MCP test (packet 11): a REAL `@modelcontextprotocol/sdk` Client
 * talks MCP to the Thirdlight MCP server over an in-memory transport, and the
 * server routes every call into a REAL backend (createTestBackend) over its
 * `/api/v1` surface. This is a genuine MCP client↔server↔backend round-trip —
 * not a unit test of the tool functions in isolation.
 *
 * Proves (charter §7 / m1-acceptance §2.2 packet-11 rows):
 *   - the MCP protocol handshake + tools/list expose the tool surface;
 *   - command submission creates a box and changes its transform (revision
 *     advances), and the change is observable by inspection (query);
 *   - a STALE mutation fails with the structured revision_conflict (carrying
 *     currentRevision) — never silently applied;
 *   - no-browser VISUAL requests fail as specified (play start with no
 *     connected browser ⇒ session_unavailable; screenshot with no play ⇒
 *     play_not_found);
 *   - session listing returns a structured result.
 *
 * The positive play/screenshot path (a connected preview rendering + a real
 * pixel capture) requires a browser and is UNVERIFIED here (no browser in this
 * container — carried to Gate C), consistent with packets 08/09/10.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestBackend, type Backend } from '@thirdlight/backend/services';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { BackendClient } from './backend-client';
import { createMcpServer } from './server';
import { MCP_TOOL_NAMES, type McpContext } from './tools';

const PROJECT = 'demo-0001';
const TOKEN = 'mcp-e2e-authoring-token';
let backend: Backend;
let client: Client;
let ctx: McpContext;
let closeTransports: Array<() => Promise<void>> = [];

/** Parse the JSON text of a tool result's first text content item. */
function text(result: unknown): Record<string, unknown> {
  const r = result as { content: Array<{ type?: string; text?: string }> };
  const item = r.content.find((c) => c.type === 'text' && typeof c.text === 'string');
  if (!item || typeof item.text !== 'string') throw new Error('no text content in tool result');
  return JSON.parse(item.text) as Record<string, unknown>;
}

beforeAll(async () => {
  const tb = await createTestBackend({
    authoringOrigin: 'http://127.0.0.1:8501',
    previewOrigin: 'http://127.0.0.1:8502',
    authoringOrigins: ['http://127.0.0.1:8501'],
    tokens: [{ token: TOKEN, scope: `authoring:${PROJECT}` }],
  });
  backend = tb.backend;
  // A fresh project starts at revision 0 with the §15 default scene.
  backend._test.service.createProject(PROJECT, 'Demo');

  const origin = `http://127.0.0.1:${backend.portAuthoring}`;
  ctx = { client: new BackendClient({ authoringOrigin: origin, token: TOKEN }), projectId: PROJECT, clientId: 'mcp-e2e-test' };

  const server = createMcpServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  closeTransports = [
    async () => { await clientTransport.close(); },
    async () => { await serverTransport.close(); },
    async () => { await server.close(); },
  ];
  await server.connect(serverTransport);
  client = new Client({ name: 'thirdlight-mcp-e2e-client', version: '0.1.0' });
  await client.connect(clientTransport);
}, 60000);

afterAll(async () => {
  for (const c of closeTransports) await c();
  closeTransports = [];
  if (backend) await backend.close();
}, 60000);

describe('MCP end-to-end (real client + real backend)', () => {
  it('tools/list exposes the charter §7 tool surface', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const expected of MCP_TOOL_NAMES) expect(names).toContain(expected);
    // Each advertised tool carries a JSON Schema input schema.
    for (const t of tools) expect(t.inputSchema).toBeTruthy();
  });

  it('inspect(project) is read-only and reports the starting revision', async () => {
    const res = await client.callTool({ name: 'tl_inspect', arguments: { target: 'project' } });
    const body = text(res);
    expect(body.ok).toBe(true);
    expect(body.revision).toBe(0); // fresh project
    expect(res.isError).toBeUndefined();
  });

  it('command submission creates a box (revision advances)', async () => {
    const res = await client.callTool({
      name: 'tl_command',
      arguments: {
        op: 'createEntity',
        expectedRevision: 0,
        args: { kind: 'box', name: 'Demo Box', box: { size: [1, 1, 1], material: { color: '#ff0000' } } },
      },
    });
    const body = text(res);
    expect(body.ok).toBe(true);
    expect(body.revision).toBe(1);
    expect(body.createdId).toBeTruthy();
    expect(res.isError).toBeUndefined();
  });

  it('command submission changes the box transform (revision advances)', async () => {
    // The box created in the previous step is the only box; read it back.
    const list = text(await client.callTool({ name: 'tl_inspect', arguments: { target: 'entities' } }));
    expect(list.ok).toBe(true);
    const entities = list.entities as Array<Record<string, unknown>>;
    const box = entities.find((e) => String(e.id).startsWith('box-'));
    expect(box).toBeTruthy();
    const boxId = String((box as Record<string, unknown>).id);

    const res = await client.callTool({
      name: 'tl_command',
      arguments: { op: 'setTransform', expectedRevision: 1, args: { entityId: boxId, transform: { position: [3, 4, 5] } } },
    });
    const body = text(res);
    expect(body.ok).toBe(true);
    expect(body.revision).toBe(2);
    expect(res.isError).toBeUndefined();

    // Observe the result by inspection (the state is the source of truth).
    const observed = text(await client.callTool({ name: 'tl_inspect', arguments: { target: 'entity', entityId: boxId } }));
    expect(observed.ok).toBe(true);
    const entity = observed.entity as { components: { transform: { position: number[] } } };
    expect(entity.components.transform.position).toEqual([3, 4, 5]);
  });

  it('a STALE mutation fails with revision_conflict (carrying currentRevision)', async () => {
    const list = text(await client.callTool({ name: 'tl_inspect', arguments: { target: 'entities' } }));
    const entities = list.entities as Array<Record<string, unknown>>;
    const box = entities.find((e) => String(e.id).startsWith('box-'));
    const boxId = String((box as Record<string, unknown>).id);
    // expectedRevision 1 is stale (current is 2) ⇒ conflict, NOT applied.
    const res = await client.callTool({
      name: 'tl_command',
      arguments: { op: 'setTransform', expectedRevision: 1, args: { entityId: boxId, transform: { position: [9, 9, 9] } } },
    });
    expect(res.isError).toBe(true);
    const body = text(res);
    expect(body.ok).toBe(false);
    const err = body.error as { code: string; currentRevision?: number };
    expect(err.code).toBe('revision_conflict');
    expect(err.currentRevision).toBe(2);
    // The stale change was NOT applied.
    const after = text(await client.callTool({ name: 'tl_inspect', arguments: { target: 'entity', entityId: boxId } }));
    const entity = after.entity as { components: { transform: { position: number[] } } };
    expect(entity.components.transform.position).toEqual([3, 4, 5]);
  });

  it('no-browser play start fails with the structured session_unavailable error', async () => {
    const res = await client.callTool({ name: 'tl_play_start', arguments: { demo: true } });
    expect(res.isError).toBe(true);
    const body = text(res);
    expect(body.ok).toBe(false);
    const err = body.error as { code: string };
    expect(err.code).toBe('session_unavailable');
    expect(body.__httpStatus).toBe(503);
  });

  it('no-browser screenshot fails with the structured play_not_found error', async () => {
    const res = await client.callTool({ name: 'tl_screenshot', arguments: { playSessionId: `play-${'0'.repeat(32)}` } });
    expect(res.isError).toBe(true);
    const body = text(res);
    expect(body.ok).toBe(false);
    const err = body.error as { code: string };
    expect(err.code).toBe('play_not_found');
    expect(body.__httpStatus).toBe(404);
  });

  it('session listing returns a structured result', async () => {
    const res = await client.callTool({ name: 'tl_sessions', arguments: {} });
    expect(res.isError).toBeUndefined();
    const body = text(res);
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.sessions)).toBe(true);
  });
});