/**
 * Phase 19.0: publishing a visual script over HTTP — the behavior source
 * route with `graph: true` generates the source from the stored graph and
 * runs the same preparation and publication as a TypeScript source: a check
 * reports the digest (and node-attributed problems), the trust acknowledgment
 * is per exact digest, and the published record is `source.kind: "graph"`
 * with the declaration derived from the graph's variables.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { api, mkRequestId, startBackend, type TestBackend } from './test-helpers';

let tb: TestBackend;
beforeAll(async () => {
  tb = await startBackend();
});
afterAll(async () => {
  await tb.teardown();
});

const P = 'demo-0001';
async function revision(): Promise<number> {
  const r = await api(`${tb.authUrl}/api/v1/projects/${P}/commands`, { body: { op: 'queryProject', projectId: P, args: {} }, token: tb.authToken, origin: null });
  return Number((r.json as { revision: number }).revision);
}
async function command(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await api(`${tb.authUrl}/api/v1/projects/${P}/commands`, {
    body: { op, projectId: P, requestId: mkRequestId(), expectedRevision: await revision(), args, origin: { kind: 'mcp', clientId: 'visual-script-test' } },
    token: tb.authToken,
    origin: null,
  });
  return r.json as Record<string, unknown>;
}
async function source(body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await api(`${tb.authUrl}/api/v1/projects/${P}/content/behaviors/source`, { body, token: tb.authToken, origin: null });
  return { status: r.status, json: r.json as Record<string, unknown> };
}
async function behavior(id: string): Promise<Record<string, unknown>> {
  const r = await api(`${tb.authUrl}/api/v1/projects/${P}/commands`, { body: { op: 'queryBehaviors', projectId: P, args: { behaviorId: id, includeDeclaration: true } }, token: tb.authToken, origin: null });
  return ((r.json as { behaviors: Record<string, unknown>[] }).behaviors ?? [])[0]!;
}

const GRAPH = {
  nodes: [
    { id: 'start', type: 'event.start', position: [0, 0] },
    { id: 'amount', type: 'var.number', position: [0, -200], data: { name: 'amount', default: 3 } },
    { id: 'secret', type: 'var.boolean', position: [0, -100], data: { name: 'secret', visibility: 'private' } },
    { id: 'add', type: 'api.game.add', position: [240, 0] },
  ],
  edges: [{ id: 'w1', from: { node: 'start', port: 'then' }, to: { node: 'add', port: 'in' } }],
};

describe('publishing a visual script (HTTP)', () => {
  it('check → problems on nodes → fix → digest → trust → publish; the record is a graph source', async () => {
    const created = await command('publishBehavior', { behaviorId: 'counter', displayName: 'Counter', mode: 'declaration-create', declaration: { properties: [{ key: 'amount', label: 'Amount', type: 'number', default: 0 }] }, graph: GRAPH });
    expect(created.ok, JSON.stringify(created)).toBe(true);

    // The counter name is empty: a compile problem on the node, nothing written.
    const bad = await source({ check: true, graph: true, behaviorId: 'counter' });
    expect(bad.status).toBe(200);
    expect(bad.json).toMatchObject({ ok: true, compiled: false, code: 'behavior_source_invalid' });
    expect(bad.json['diagnostics']).toEqual([expect.objectContaining({ nodeId: 'add', message: expect.stringContaining('counter') })]);
    const refused = await source({ graph: true, behaviorId: 'counter', displayName: 'Counter', expectedRevision: await revision(), requestId: mkRequestId() });
    expect(refused.status).toBe(400);
    expect((refused.json['error'] as { diagnostics: { nodeId?: string }[] }).diagnostics[0]?.nodeId).toBe('add');

    // Fix it with a graph edit (the same command the editor and MCP send).
    const edit = await command('graphEdit', { owner: { kind: 'behavior', id: 'counter' }, ops: [{ op: 'setNodeData', id: 'add', data: { name: 'coins' } }] });
    expect(edit.ok, JSON.stringify(edit)).toBe(true);
    const checked = await source({ check: true, graph: true, behaviorId: 'counter' });
    expect(checked.json).toMatchObject({ ok: true, compiled: true, sourceKind: 'graph', declaredInCode: true });
    const digest = String(checked.json['sourceDigest']);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    // The same graph gives the same digest (what the acknowledgment covers).
    expect((await source({ check: true, graph: true, behaviorId: 'counter' })).json['sourceDigest']).toBe(digest);

    // Publishing before the acknowledgment is refused with that digest.
    const early = await source({ graph: true, behaviorId: 'counter', displayName: 'Counter', expectedRevision: await revision(), requestId: mkRequestId() });
    expect(early.status).toBeGreaterThanOrEqual(400);
    expect(early.json['error']).toMatchObject({ code: 'behavior_trust_unacknowledged', sourceDigest: digest });
    expect((await command('acknowledgeBehaviorTrust', { sourceDigest: digest })).ok).toBe(true);
    const published = await source({ graph: true, behaviorId: 'counter', displayName: 'Counter', expectedRevision: await revision(), requestId: mkRequestId() });
    expect(published.status, JSON.stringify(published.json)).toBe(200);
    expect(published.json).toMatchObject({ ok: true, sourceDigest: digest, sourceKind: 'graph', declaredInCode: true });

    const record = await behavior('counter');
    expect((record['source'] as Record<string, unknown>)['kind']).toBe('graph');
    expect((record['source'] as Record<string, unknown>)['declaredInCode']).toBe(true);
    expect((record['source'] as Record<string, unknown>)['sourceDigest']).toBe(digest);
    expect(record['declaration']).toEqual({
      properties: [
        { key: 'amount', label: 'Amount', type: 'number', default: 3 },
        { key: 'secret', label: 'Secret', type: 'boolean', default: false, visibility: 'private' },
      ],
    });
    // The graph stays with the record (edit → publish again).
    expect((record['graph'] as { nodes: unknown[] }).nodes).toHaveLength(4);
    // The stored source is the generated TypeScript.
    const stored = await api(`${tb.authUrl}/api/v1/projects/${P}/content/behaviors/counter/source`, { method: 'GET', token: tb.authToken, origin: null });
    const container = JSON.parse((stored.json as { source: string }).source) as { files: { path: string; text: string }[] };
    expect(container.files[0]!.text).toContain('const a0 = "coins";');
    expect(container.files[0]!.text).toContain('c.game?.add(a0, a1);');

    // A behavior without a graph cannot be published as one.
    await command('publishBehavior', { behaviorId: 'plain', displayName: 'Plain', mode: 'declaration-create', declaration: { properties: [{ key: 'a', label: 'A', type: 'number', default: 0 }] } });
    const plain = await source({ check: true, graph: true, behaviorId: 'plain' });
    expect(plain.status).toBe(400);
  });
});
