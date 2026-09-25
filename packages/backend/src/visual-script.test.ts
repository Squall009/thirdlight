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
    const all = container.files.map((f) => f.text).join('\n');
    expect(container.files.find((f) => f.path === 'src/index.ts')!.text.startsWith('// Thirdlight visual script v1')).toBe(true);
    expect(all).toContain('const a0 = "coins";');
    expect(all).toContain('c.game?.add(a0, a1);');

    // A behavior without a graph cannot be published as one.
    await command('publishBehavior', { behaviorId: 'plain', displayName: 'Plain', mode: 'declaration-create', declaration: { properties: [{ key: 'a', label: 'A', type: 'number', default: 0 }] } });
    const plain = await source({ check: true, graph: true, behaviorId: 'plain' });
    expect(plain.status).toBe(400);
  });
});

describe('phase 19.1: a script with a function and a shared function (HTTP)', () => {
  it('the check compiles the script with its functions and the shared function; changing the shared function changes the digest', async () => {
    const fn = (factor: number) => ({
      nodes: [
        { id: 'start', type: 'fn.entry', position: [0, 0] },
        { id: 'x', type: 'fn.input', position: [0, 100], data: { name: 'x', type: 'number' } },
        { id: 'times', type: 'math.multiply', position: [200, 100], data: { b: factor } },
        { id: 'y', type: 'fn.output', position: [400, 100], data: { name: 'y', type: 'number' } },
      ],
      edges: [
        { id: 'w1', from: { node: 'x', port: 'value' }, to: { node: 'times', port: 'a' } },
        { id: 'w2', from: { node: 'times', port: 'result' }, to: { node: 'y', port: 'value' } },
      ],
    });
    expect((await command('setGraph', { graph: { graphId: 'triple', kind: 'behavior-library', name: 'Triple', graph: fn(3) } })).ok).toBe(true);
    // No variable at all: a script may declare no property.
    const created = await command('publishBehavior', { behaviorId: 'caller', displayName: 'Caller', mode: 'declaration-create', declaration: { properties: [] }, graph: { nodes: [{ id: 'start', type: 'event.start', position: [0, 0] }], edges: [] } });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    const made = await command('graphEdit', { owner: { kind: 'behavior', id: 'caller#double' }, ops: [{ op: 'addNodes', nodes: fn(2).nodes }, { op: 'connect', edges: fn(2).edges }] });
    expect(made.ok, JSON.stringify(made)).toBe(true);
    const wired = await command('graphEdit', {
      owner: { kind: 'behavior', id: 'caller' },
      ops: [
        {
          op: 'addNodes',
          nodes: [
            { id: 'call', type: 'fn.call', position: [200, 0], data: { function: 'double' } },
            { id: 'lib', type: 'fn.library', position: [400, 0], data: { function: 'triple' } },
            { id: 'add', type: 'api.game.add', position: [600, 0], data: { name: 'score' } },
          ],
        },
        {
          op: 'connect',
          edges: [
            { id: 'c1', from: { node: 'start', port: 'then' }, to: { node: 'call', port: 'in' } },
            { id: 'c2', from: { node: 'call', port: 'then' }, to: { node: 'lib', port: 'in' } },
            { id: 'c3', from: { node: 'call', port: 'y' }, to: { node: 'lib', port: 'x' } },
            { id: 'c4', from: { node: 'lib', port: 'then' }, to: { node: 'add', port: 'in' } },
            { id: 'c5', from: { node: 'lib', port: 'y' }, to: { node: 'add', port: 'amount' } },
          ],
        },
      ],
    });
    expect(wired.ok, JSON.stringify(wired)).toBe(true);
    expect(((await behavior('caller'))['functions'] as { functionId: string }[]).map((f) => f.functionId)).toEqual(['double']);
    const first = await source({ check: true, graph: true, behaviorId: 'caller' });
    expect(first.json).toMatchObject({ ok: true, compiled: true, declaration: { properties: [] } });
    // The shared function's code is part of the source: changing it changes the digest.
    expect((await command('graphEdit', { owner: { kind: 'graph', id: 'triple' }, ops: [{ op: 'setNodeData', id: 'times', data: { b: 4 } }] })).ok).toBe(true);
    const second = await source({ check: true, graph: true, behaviorId: 'caller' });
    expect(second.json).toMatchObject({ ok: true, compiled: true });
    expect(second.json['sourceDigest']).not.toBe(first.json['sourceDigest']);
    // Phase 19.2: publishing keeps the script's functions (the stored graph still generates the published source).
    const digest = String(second.json['sourceDigest']);
    expect((await command('acknowledgeBehaviorTrust', { sourceDigest: digest })).ok).toBe(true);
    const published = await source({ graph: true, behaviorId: 'caller', displayName: 'Caller', expectedRevision: await revision(), requestId: mkRequestId() });
    expect(published.status, JSON.stringify(published.json)).toBe(200);
    const after = await behavior('caller');
    expect((after['functions'] as { functionId: string }[]).map((f) => f.functionId)).toEqual(['double']);
    expect((after['source'] as { sourceDigest: string }).sourceDigest).toBe(digest);
    expect((await source({ check: true, graph: true, behaviorId: 'caller' })).json['sourceDigest']).toBe(digest);
  });
});
