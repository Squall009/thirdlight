/**
 * The engine and material-problem routes over HTTP:
 *
 * - `GET /api/v1/engine`: the engine the backend runs (version, commit and
 *   lockfile as it started, the dist/ build stamp at start and now, when the
 *   process started) and whether dist/ was built after the process started;
 * - graph materials' problems: the backend runs `materialGraphProblems` when
 *   it loads a project and after each change — a material set with a broken
 *   graph is listed by `GET …/content/materials` (the MCP
 *   `tl_content_query target="materials"`) and `GET …/problems`
 *   (`tl_diagnostics`: `materialProblems`, and one `material_graph_problems`
 *   entry when its problems appear); fixed, it has none; a project already
 *   broken on disk is checked when the backend loads it.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { api, mkRequestId, startBackend, type TestBackend } from './test-helpers';
import { createTestBackend } from './testing';

const REPO = resolve(import.meta.dirname, '..', '..', '..');
const P = 'demo-0001';
let tb: TestBackend;
let closed = false;
beforeAll(async () => {
  tb = await startBackend({ engineRoot: REPO });
});
afterAll(async () => {
  if (!closed) await tb.teardown();
  else rmSync(tb.root, { recursive: true, force: true });
});

const get = async (path: string, token = tb.authToken): Promise<{ status: number; json: Record<string, unknown> }> => {
  const r = await api(`${tb.authUrl}${path}`, { method: 'GET', token, origin: null });
  return { status: r.status, json: r.json as Record<string, unknown> };
};
async function revision(): Promise<number> {
  const r = await api(`${tb.authUrl}/api/v1/projects/${P}/commands`, { body: { op: 'queryProject', projectId: P, args: {} }, token: tb.authToken, origin: null });
  return Number((r.json as { revision: number }).revision);
}
async function command(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await api(`${tb.authUrl}/api/v1/projects/${P}/commands`, {
    body: { op, projectId: P, requestId: mkRequestId(), expectedRevision: await revision(), args, origin: { kind: 'mcp', clientId: 'engine-materials-test' } },
    token: tb.authToken,
    origin: null,
  });
  return r.json as Record<string, unknown>;
}

interface Row {
  materialId: string;
  name: string;
  graph: boolean;
  problems: { nodeId?: string; severity: string; message: string }[];
}
const materials = async (q = ''): Promise<{ total: number; withProblems: number; materials: Row[] }> => (await get(`/api/v1/projects/${P}/content/materials${q}`)).json as never;
/** The check runs just after a change (coalesced): wait for it. */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 80));
}

const plain = { materialId: 'mat-plain', name: 'Plain', shader: 'standard', params: {}, textures: {} };
/** A graph whose base colour samples a texture node with no texture chosen (the compiler warns); fixed: a constant colour. */
const broken = (fixed: boolean) => ({
  materialId: 'mat-graph',
  name: 'Graph',
  shader: 'standard',
  params: {},
  textures: {},
  graph: fixed
    ? { nodes: [{ id: 'out', type: 'pbr', position: [400, 0] }], edges: [] }
    : {
        nodes: [
          { id: 'out', type: 'pbr', position: [400, 0] },
          { id: 's', type: 'sampleTexture', position: [0, 0] },
        ],
        edges: [{ id: 'e1', from: { node: 's', port: 'rgb' }, to: { node: 'out', port: 'baseColor' } }],
      },
});

describe('GET /api/v1/engine (phase 25.18)', () => {
  it('answers the engine the backend runs, and whether dist/ was built after the process started', async () => {
    expect((await get('/api/v1/engine', 'nope')).status).toBe(401);
    const distDir = tb.root; // the test backend's editor bundle dir is <root>/editor
    writeFileSync(join(distDir, 'build-info.json'), JSON.stringify({ builtAt: '2000-01-01T00:00:00.000Z', commit: 'a'.repeat(40), dirty: false, version: '0.1.0' }));
    let r = await get('/api/v1/engine');
    expect(r.status).toBe(200);
    const e = r.json.engine as Record<string, unknown> & { dist: { build: { builtAt: string } | null; newerThanProcess: boolean; reason: string } };
    expect(e.version).toBe((JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { version: string }).version);
    expect(String(e.commit)).toMatch(/^([0-9a-f]{40}|unknown)$/);
    expect(String(e.lockfileDigest)).toMatch(/^[0-9a-f]{64}$/);
    expect(Date.parse(String(e.startedAt))).toBeLessThanOrEqual(Date.now());
    expect(e.dist.build?.builtAt).toBe('2000-01-01T00:00:00.000Z');
    expect(e.dist.newerThanProcess).toBe(false);
    // dist/ rebuilt now, after the process started: newer (the stamp the process started with stays as it was).
    writeFileSync(join(distDir, 'build-info.json'), JSON.stringify({ builtAt: new Date().toISOString(), commit: 'b'.repeat(40), dirty: true, version: '0.1.0' }));
    r = await get('/api/v1/engine');
    const later = r.json.engine as typeof e;
    expect(later.dist.newerThanProcess).toBe(true);
    expect(later.dist.reason).toContain('restart');
    expect(later.build).toBeNull();
  });
});

describe('graph materials\' problems on the backend (phase 25.18)', () => {
  it('a material set with a broken graph is listed with its node problem; fixed, it has none; problems and the log say so', async () => {
    const first = await command('setMaterial', { material: plain });
    expect(first.ok, JSON.stringify(first).slice(0, 600)).toBe(true);
    await settle();
    let m = await materials();
    expect(m.materials.find((r) => r.materialId === 'mat-plain')).toMatchObject({ graph: false, problems: [] });
    expect(m.withProblems).toBe(0);

    const set = await command('setMaterial', { material: broken(false) });
    expect(set.ok, JSON.stringify(set).slice(0, 400)).toBe(true);
    await settle();
    m = await materials();
    const row = m.materials.find((r) => r.materialId === 'mat-graph')!;
    expect(row.graph).toBe(true);
    expect(row.problems.some((p) => p.nodeId === 's' && p.message.includes('no texture')), JSON.stringify(row)).toBe(true);
    expect(m.withProblems).toBe(1);
    expect((await materials('?problems=1')).materials.map((r) => r.materialId)).toEqual(['mat-graph']);
    expect((await materials('?materialId=mat-plain')).materials.map((r) => r.materialId)).toEqual(['mat-plain']);
    let problems = (await get(`/api/v1/projects/${P}/problems`)).json as { problems: { code: string; message: string }[]; materialProblems: Row[] };
    expect(problems.materialProblems.map((r) => r.materialId)).toEqual(['mat-graph']);
    const logged = problems.problems.filter((p) => p.code === 'material_graph_problems');
    expect(logged).toHaveLength(1);
    expect(logged[0]!.message).toContain('Material "Graph" (mat-graph)');

    // Another unrelated change: the same problems are not logged again.
    expect((await command('setMaterial', { material: { ...plain, name: 'Plain 2' } })).ok).toBe(true);
    await settle();
    problems = (await get(`/api/v1/projects/${P}/problems`)).json as typeof problems;
    expect(problems.problems.filter((p) => p.code === 'material_graph_problems')).toHaveLength(1);

    // Fixed: no problems.
    expect((await command('setMaterial', { material: broken(true) })).ok).toBe(true);
    await settle();
    m = await materials();
    expect(m.materials.find((r) => r.materialId === 'mat-graph')!.problems).toEqual([]);
    problems = (await get(`/api/v1/projects/${P}/problems`)).json as typeof problems;
    expect(problems.materialProblems).toEqual([]);
  });

  it('a project loaded by a new backend is checked at its load', async () => {
    expect((await command('setMaterial', { material: broken(false) })).ok).toBe(true);
    await settle();
    // The same data root, a new backend process (the first one closed): its first read of the project checks it.
    await tb.backend.close();
    closed = true;
    const second = await createTestBackend({ authoringOrigin: 'http://127.0.0.1:8501', previewOrigin: 'http://127.0.0.1:8502', authoringOrigins: ['http://127.0.0.1:8501'], tokens: [{ token: tb.authToken, scope: `authoring:${P}` }], dataRoot: join(tb.root, 'data') });
    try {
      const url = `http://127.0.0.1:${second.backend.portAuthoring}/api/v1/projects/${P}/problems`;
      const r = (await api(url, { method: 'GET', token: tb.authToken, origin: null })).json as { problems: { code: string }[]; materialProblems: Row[] };
      expect(r.materialProblems.map((x) => x.materialId)).toEqual(['mat-graph']);
      expect(r.problems.filter((x) => x.code === 'material_graph_problems')).toHaveLength(1);
    } finally {
      await second.teardown();
    }
  });
});
