/**
 * How an agent learns the engine over MCP, end to end: a real MCP client
 * against the MCP server, routed into a real backend over HTTP that reads
 * the checked-in manual.
 *
 * - the server's instructions point at tl_docs and the getting-started page;
 * - tl_docs answers the contents, a page, a section, a reference topic and a
 *   search, every answer bounded and a long page in parts;
 * - tl_inspect target="engine" names the build and the manual it serves;
 * - tl_docs and the engine answer from a folder that holds no project (an
 *   agent reads the manual before it picks one); project tools refuse there;
 * - tl_script_publish publishes TypeScript through the editor's source route
 *   (compile and type check, the trust refusal, acknowledgment, publication;
 *   a type error refuses the check but not a publish);
 * - the descriptions on the wire stay short.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Backend } from '@thirdlight/backend/services';
import { createTestBackend } from '@thirdlight/backend/testing';

import { BackendClient } from './backend-client';
import { folderContextProvider } from './index';
import { createMcpServer } from './server';

/** The engine checkout (no Node path module in this package: a URL resolves it). */
const REPO = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '');
const PROJECT = 'onboard-0001';
const TOKEN = 'mcp-onboarding-token';
let backend: Backend;
let teardown: () => Promise<void>;
let client: Client;
const closers: Array<() => Promise<void>> = [];

type Result = { isError?: boolean; content: Array<{ type: string; text: string }> };
const call = async (name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; body: Record<string, unknown>; text?: string }> => {
  const res = (await client.callTool({ name, arguments: args })) as Result;
  return { isError: res.isError === true, body: JSON.parse(res.content[0]!.text) as Record<string, unknown>, ...(res.content[1] !== undefined ? { text: res.content[1].text } : {}) };
};
const revision = async (): Promise<number> => (await call('tl_inspect', { target: 'project' })).body.revision as number;

beforeAll(async () => {
  const tb = await createTestBackend({
    authoringOrigin: 'http://127.0.0.1:8501',
    previewOrigin: 'http://127.0.0.1:8502',
    authoringOrigins: ['http://127.0.0.1:8501'],
    tokens: [{ token: TOKEN, scope: `authoring:${PROJECT}` }],
    engineRoot: REPO,
  });
  backend = tb.backend;
  teardown = tb.teardown;
  backend._test.service.createProject(PROJECT, 'Onboarding');
  const ctx = { client: new BackendClient({ authoringOrigin: `http://127.0.0.1:${backend.portAuthoring}`, token: TOKEN }), projectId: PROJECT, clientId: 'mcp-onboarding' };
  const server = createMcpServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: 'thirdlight-onboarding', version: '0.0.0' });
  await client.connect(clientTransport);
  closers.push(() => clientTransport.close(), () => server.close());
}, 60_000);

afterAll(async () => {
  for (const c of closers) await c();
  if (teardown !== undefined) await teardown();
}, 60_000);

describe('MCP onboarding (real client, real backend)', () => {
  it('sends instructions that start at the getting-started page and tl_docs; descriptions stay short', async () => {
    const instructions = client.getInstructions() ?? '';
    expect(instructions).toContain('getting-started/first-project');
    expect(instructions).toContain('tl_docs');
    expect(instructions.length).toBeLessThan(1_200);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['tl_docs', 'tl_script_publish']));
    const total = tools.reduce((n, t) => n + (t.description ?? '').length, 0);
    expect(total).toBeLessThan(9_000);
  });

  it('answers the contents, a page, a section, a reference topic and a search from the manual', async () => {
    const contents = await call('tl_docs');
    expect(contents.body, JSON.stringify(contents.body)).toMatchObject({ ok: true, kind: 'contents', part: 1 });
    expect(contents.text).toContain('# Thirdlight manual');
    expect(contents.text).toContain('`op.…`');

    const page = await call('tl_docs', { topic: 'getting-started/first-project' });
    expect(page.body).toMatchObject({ ok: true, kind: 'page' });
    expect(page.text?.startsWith('# ')).toBe(true);

    const section = await call('tl_docs', { topic: 'op.editBlocks' });
    expect(section.body).toMatchObject({ ok: true, kind: 'section', title: 'editBlocks' });
    expect(section.text).toContain('## editBlocks');
    expect(section.text).not.toContain('## editTerrain');

    const area = await call('tl_docs', { topic: 'tool.tl_command.block-layers' });
    expect(area.text).toContain('setBlockType');

    const search = await call('tl_docs', { query: 'component light' });
    expect((search.body.matches as { topic: string }[]).some((m) => m.topic === 'component.light')).toBe(true);

    const unknown = await call('tl_docs', { topic: 'op.noSuchOp' });
    expect(unknown.isError).toBe(true);
    expect(JSON.stringify(unknown.body)).toContain('docs_topic_not_found');
  });

  it('reads the manual and the engine before a project is picked; project tools say why they cannot', async () => {
    // The checked-in docs folder holds no thirdlight.json, and neither do its parents.
    const auth = new BackendClient({ authoringOrigin: `http://127.0.0.1:${backend.portAuthoring}`, token: TOKEN });
    const server = createMcpServer(folderContextProvider(auth, { origin: 'test', cwd: `${REPO}/docs`, clientId: 'mcp-no-project' }));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const bare = new Client({ name: 'thirdlight-no-project', version: '0.0.0' });
    await bare.connect(ct);
    closers.push(() => ct.close(), () => server.close());
    const first = (await bare.callTool({ name: 'tl_docs', arguments: { topic: 'getting-started/first-project' } })) as Result;
    expect(first.isError, first.content[0]!.text).not.toBe(true);
    expect(first.content[1]!.text.startsWith('# ')).toBe(true);
    const engine = (await bare.callTool({ name: 'tl_inspect', arguments: { target: 'engine' } })) as Result;
    expect(engine.content[0]!.text).toContain('"manual"');
    const project = (await bare.callTool({ name: 'tl_inspect', arguments: { target: 'project' } })) as Result;
    expect(project.isError).toBe(true);
    expect(project.content[0]!.text).toContain('project_not_resolved');
    expect(project.content[0]!.text).toContain('no thirdlight.json');
  });

  it('bounds a long page: one part per call, the next named', async () => {
    const first = await call('tl_docs', { topic: 'reference/mcp-tools-1' });
    expect(first.body.parts as number, JSON.stringify(first.body)).toBeGreaterThan(1);
    expect(first.text!.length).toBeLessThanOrEqual(20_000);
    expect(first.body.next).toEqual({ topic: 'reference/mcp-tools-1', part: 2 });
    const second = await call('tl_docs', first.body.next as Record<string, unknown>);
    expect(second.body.part).toBe(2);
    expect(second.text).not.toBe(first.text);
  });

  it('names the engine build and the manual it serves', async () => {
    const res = await call('tl_inspect', { target: 'engine' });
    const engine = res.body.engine as { version: string | null; commit: string | null; manual: { dir: string; pages: number; topics: number } };
    expect(typeof engine.version).toBe('string');
    expect(engine.manual.dir).toBe(`${REPO}/docs`);
    expect(engine.manual.pages).toBeGreaterThan(50);
    expect(engine.manual.topics).toBeGreaterThan(1000);
  });

  it('publishes a TypeScript script: check, trust refusal, acknowledgment, publication', async () => {
    const created = await call('tl_command', { op: 'publishBehavior', expectedRevision: await revision(), args: { behaviorId: 'scorer', displayName: 'Scorer', mode: 'declaration-create', declaration: { properties: [] } } });
    expect(created.isError, JSON.stringify(created.body)).toBe(false);
    const files = [
      {
        path: 'src/index.ts',
        text:
          "import type { BehaviorContext } from '@thirdlight/runtime';\nimport table from './table.json';\n\n" +
          'export const properties = { every: property.number(1, { min: 0.1 }) };\n\n' +
          "export default {\n  step(_state: unknown, ctx: BehaviorContext): void {\n    ctx.game.add('total', (table as { points: number }).points);\n  },\n};\n",
      },
      { path: 'src/table.json', text: '{ "points": 5 }\n' },
    ];
    const broken = await call('tl_script_publish', { behaviorId: 'scorer', check: true, files: [{ path: 'src/index.ts', text: 'export default { step(: number) {} };\n' }] });
    expect(broken.body).toMatchObject({ ok: true, compiled: false });

    // A wrong option name builds (esbuild strips types); the check's type check refuses it, at its position.
    const typo = [{ path: 'src/index.ts', text: "export default {\n  step(state, ctx) {\n    ctx.camera.activate('cam', { blendTime: 0.5 });\n  },\n};\n" }];
    const mistyped = await call('tl_script_publish', { behaviorId: 'scorer', check: true, files: typo });
    expect(mistyped.body, JSON.stringify(mistyped.body)).toMatchObject({ ok: true, compiled: false, code: 'behavior_type_error', diagnostics: [{ code: 'behavior_type_error', path: 'src/index.ts', line: 3, column: 34 }] });
    expect(JSON.stringify(mistyped.body)).toMatch(/'blendTime' does not exist in type 'CameraBlendOptions'.*has: [^)]*time/);

    const checked = await call('tl_script_publish', { behaviorId: 'scorer', check: true, files });
    expect(checked.body, JSON.stringify(checked.body)).toMatchObject({ ok: true, compiled: true, typeChecked: true, declaredInCode: true });
    const digest = String(checked.body.sourceDigest);

    const refused = await call('tl_script_publish', { behaviorId: 'scorer', displayName: 'Scorer', files, expectedRevision: await revision() });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.body)).toContain('behavior_trust_unacknowledged');
    expect(JSON.stringify(refused.body)).toContain(digest);

    expect((await call('tl_command', { op: 'acknowledgeBehaviorTrust', expectedRevision: await revision(), args: { sourceDigest: digest } })).isError).toBe(false);
    const before = await revision();
    const published = await call('tl_script_publish', { behaviorId: 'scorer', displayName: 'Scorer', files, expectedRevision: before });
    expect(published.body, JSON.stringify(published.body)).toMatchObject({ ok: true, behaviorId: 'scorer', sourceDigest: digest, revision: before + 1, declaredInCode: true });
    const listed = await call('tl_content_query', { target: 'behaviors', behaviorId: 'scorer', includeDeclaration: true });
    const row = (listed.body.behaviors as { source?: { sourceDigest?: string }; declaration?: { properties: { key: string }[] } }[])[0];
    expect(row?.source?.sourceDigest).toBe(digest);
    expect(row?.declaration?.properties.map((p) => p.key)).toEqual(['every']);

    // A publish does not type-check: the mistyped source publishes (once acknowledged), so a project with type errors still opens and plays.
    const typoRefused = await call('tl_script_publish', { behaviorId: 'scorer', displayName: 'Scorer', files: typo, expectedRevision: before + 1 });
    const typoDigest = String((JSON.stringify(typoRefused.body).match(/[0-9a-f]{64}/) ?? [''])[0]);
    expect((await call('tl_command', { op: 'acknowledgeBehaviorTrust', expectedRevision: before + 1, args: { sourceDigest: typoDigest } })).isError).toBe(false);
    const typoPublished = await call('tl_script_publish', { behaviorId: 'scorer', displayName: 'Scorer', files: typo, expectedRevision: before + 2 });
    expect(typoPublished.body, JSON.stringify(typoPublished.body)).toMatchObject({ ok: true, behaviorId: 'scorer', revision: before + 3 });

    // A request that names neither a source nor a graph is refused before the backend.
    expect((await call('tl_script_publish', { behaviorId: 'scorer', displayName: 'Scorer', expectedRevision: before + 3 })).isError).toBe(true);
  });
});
