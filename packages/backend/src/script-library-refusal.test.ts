/**
 * A script library change over HTTP that a published script no longer
 * compiles against: the command route compiles the library's dependents
 * against the library set it would commit before the command runs, and on a
 * compile failure answers 400 naming the script, records the problem (what
 * `tl_diagnostics` reads), and leaves the project as it was. The project here
 * has already taken a library change that compiled (its dependents
 * republished, the revision moved), so "as it was" is that applied state, not
 * an untouched project.
 */
import { createHash } from 'node:crypto';

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
const base = (): string => `${tb.authUrl}/api/v1/projects/${P}`;

async function revision(): Promise<number> {
  const r = await api(`${base()}/commands`, { body: { op: 'queryProject', projectId: P, args: {} }, token: tb.authToken, origin: null });
  return Number((r.json as { revision: number }).revision);
}
async function send(op: string, args: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await api(`${base()}/commands`, {
    body: { op, projectId: P, requestId: mkRequestId(), expectedRevision: await revision(), args, origin: { kind: 'mcp', clientId: 'library-refusal-test' } },
    token: tb.authToken,
    origin: null,
  });
  return { status: r.status, json: r.json as Record<string, unknown> };
}
async function ok(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await send(op, args);
  expect(r.json.ok, `${op}: ${JSON.stringify(r.json).slice(0, 600)}`).toBe(true);
  return r.json;
}
async function trust(sourceDigest: string): Promise<void> {
  await ok('acknowledgeBehaviorTrust', { sourceDigest });
}
async function outputDigest(behaviorId: string): Promise<string> {
  const r = await api(`${base()}/commands`, { body: { op: 'queryBehaviors', projectId: P, args: { behaviorId, includeDeclaration: true } }, token: tb.authToken, origin: null });
  const row = ((r.json as { behaviors: { source: { outputDigest: string } | null }[] }).behaviors ?? [])[0];
  return String(row?.source?.outputDigest);
}
async function problems(): Promise<{ code: string; message: string }[]> {
  const r = await api(`${base()}/problems`, { method: 'GET', token: tb.authToken, origin: null });
  return (r.json as { problems: { code: string; message: string }[] }).problems;
}
/** The library as the backend compiles dependents against it (its container's text). */
const libraryText = (libraryId: string): string | undefined => {
  const input = tb.backend._test.service.scriptLibraryInputs(P).find((l) => l.libraryId === libraryId);
  return input === undefined ? undefined : new TextDecoder().decode(input.containerBytes);
};

/** A draft's digest as the backend computes it (the script editor's check route): what its trust covers. */
async function scriptLibraryDigest(draft: { libraryId: string; files: { path: string; text: string }[] }): Promise<string> {
  const r = await api(`${base()}/content/libraries/check`, { body: { libraryId: draft.libraryId, files: draft.files }, token: tb.authToken, origin: null });
  const digest = (r.json as { sourceDigest?: string }).sourceDigest;
  expect(digest, JSON.stringify(r.json).slice(0, 400)).toMatch(/^[0-9a-f]{64}$/);
  return digest!;
}

async function setLibrary(lib: { libraryId: string; name: string; files: { path: string; text: string }[] }): Promise<{ status: number; json: Record<string, unknown> }> {
  await trust(await scriptLibraryDigest(lib));
  return send('setScriptLibrary', lib);
}

const lib = (text: string) => ({ libraryId: 'calc', name: 'Calc', files: [{ path: 'src/index.ts', text }] });
const SCRIPT = [
  "import type { BehaviorContext } from '@thirdlight/runtime';",
  "import { amount } from '@lib/calc';",
  '',
  'export default {',
  '  step(_state: unknown, ctx: BehaviorContext): void {',
  "    if (ctx.phase === 'intent' && ctx.game?.counter('items') === 0) ctx.game.add('items', amount(1));",
  '  },',
  '};',
  '',
].join('\n');

async function publishScript(behaviorId: string): Promise<void> {
  await ok('publishBehavior', { behaviorId, displayName: behaviorId, mode: 'declaration-create', declaration: { properties: [] } });
  const bytes = new TextEncoder().encode(`${JSON.stringify({ graphVersion: 1, entryPath: 'src/index.ts', requiredModules: ['@thirdlight/runtime'], ownedTransforms: [], files: [{ path: 'src/index.ts', text: SCRIPT }] }, null, 2)}\n`);
  const begun = await api(`${base()}/content/stages`, { body: {}, token: tb.authToken, origin: null });
  const stageId = String((begun.json as { stageId: string }).stageId);
  const put = await fetch(`${base()}/content/stages/${stageId}/bytes`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${tb.authToken}`, 'content-type': 'application/octet-stream', 'x-thirdlight-offset': '0', 'x-thirdlight-total': String(bytes.length) },
    body: Buffer.from(bytes),
  });
  expect(put.status, await put.clone().text()).toBe(200);
  await trust(createHash('sha256').update(bytes).digest('hex'));
  const published = await api(`${base()}/content/behaviors/source`, { body: { stageId, behaviorId, displayName: behaviorId, expectedRevision: await revision(), requestId: mkRequestId() }, token: tb.authToken, origin: null });
  expect(published.status, JSON.stringify(published.json).slice(0, 600)).toBe(200);
}

describe('a script library change its dependent no longer compiles against (HTTP)', () => {
  it('after an applied change, a breaking one is answered 400 naming the script, recorded as a problem, and changes nothing', async () => {
    expect((await setLibrary(lib('export const amount = (n: number): number => n * 2;\n'))).json.ok).toBe(true);
    await publishScript('user-a');

    // A change the script still compiles against applies: the revision moves and the script is republished.
    const firstDigest = await outputDigest('user-a');
    const applied = await setLibrary(lib('export const amount = (n: number): number => n * 3;\n'));
    expect(applied.status, JSON.stringify(applied.json).slice(0, 600)).toBe(200);
    expect(applied.json.ok).toBe(true);
    const breaking = lib('export const other = 1;\n');
    // Its trust is acknowledged first (a command of its own), so what follows is the library change alone.
    await trust(await scriptLibraryDigest(breaking));
    const after = { revision: await revision(), digest: await outputDigest('user-a'), text: libraryText('calc') };
    expect(after.digest).not.toBe(firstDigest);
    expect(after.text).toContain('n * 3');
    const problemsBefore = (await problems()).length;

    // The script imports `amount`; a library without it is refused before the command runs.
    const refused = await send('setScriptLibrary', breaking);
    expect(refused.status, JSON.stringify(refused.json).slice(0, 600)).toBe(400);
    expect(refused.json.ok).toBe(false);
    const error = refused.json.error as { cls: string; behaviorId: string; message: string; diagnostics: unknown[] };
    expect(error.cls).toBe('validation');
    expect(error.behaviorId).toBe('user-a');
    expect(error.message).toContain('script user-a does not compile against the changed library @lib/calc');
    expect(error.diagnostics.length).toBeGreaterThan(0);

    const listed = await problems();
    expect(listed.length).toBe(problemsBefore + 1);
    expect(listed[listed.length - 1]!.message).toBe(error.message);

    // The project is the applied state: same revision, the library and the script's record as they were.
    expect(await revision()).toBe(after.revision);
    expect(libraryText('calc')).toBe(after.text);
    expect(await outputDigest('user-a')).toBe(after.digest);
  }, 60_000);
});
