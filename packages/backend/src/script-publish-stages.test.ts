/**
 * Publishing a TypeScript script many times in a row over HTTP: each
 * publication stages its source, and a project holds only a few open stages.
 * A committed publication's stage gives way to the next upload, so a session
 * that publishes often (the editor's Publish, an agent iterating) is never
 * refused with `open_stages`; a retry of the last request still finds its
 * stage and answers as a duplicate, and so does a retry of the first one,
 * whose stage gave way to the later uploads.
 */
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CONTENT_OPEN_STAGES as MAX_OPEN_STAGES } from '@thirdlight/protocol';

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
async function command(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await api(`${base()}/commands`, {
    body: { op, projectId: P, requestId: mkRequestId(), expectedRevision: await revision(), args, origin: { kind: 'mcp', clientId: 'publish-stages-test' } },
    token: tb.authToken,
    origin: null,
  });
  return r.json as Record<string, unknown>;
}
async function stage(bytes: Uint8Array): Promise<string> {
  const begun = await api(`${base()}/content/stages`, { body: {}, token: tb.authToken, origin: null });
  expect(begun.status, JSON.stringify(begun.json)).toBe(200);
  const stageId = String((begun.json as { stageId: string }).stageId);
  const put = await fetch(`${base()}/content/stages/${stageId}/bytes`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${tb.authToken}`, 'content-type': 'application/octet-stream', 'x-thirdlight-offset': '0', 'x-thirdlight-total': String(bytes.length) },
    body: Buffer.from(bytes),
  });
  expect(put.status, await put.clone().text()).toBe(200);
  return stageId;
}
/** Whether a stage's folder is still on disk (anywhere under the backend's root). */
function stageOnDisk(stageId: string, dir = tb.root): boolean {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    if (e.name === stageId && dir.endsWith('staging')) return true;
    if (stageOnDisk(stageId, join(dir, e.name))) return true;
  }
  return false;
}
function container(n: number): Uint8Array {
  const source = `export default { instantiate() { return { n: ${n} }; }, step() {} };\n`;
  return new TextEncoder().encode(`${JSON.stringify({ graphVersion: 1, entryPath: 'src/index.ts', requiredModules: ['@thirdlight/runtime'], ownedTransforms: [], files: [{ path: 'src/index.ts', text: source }] }, null, 2)}\n`);
}

describe('publishing a script again and again (HTTP)', () => {
  it(`publishes more than ${MAX_OPEN_STAGES} times in a row, each from a new stage; a lost-answer retry still works`, async () => {
    const created = await command('publishBehavior', { behaviorId: 'often', displayName: 'Often', mode: 'declaration-create', declaration: { properties: [] } });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    let first: { body: Record<string, unknown>; revision: number } | null = null;
    let last: { body: Record<string, unknown>; revision: number } | null = null;
    for (let n = 1; n <= MAX_OPEN_STAGES + 2; n++) {
      const bytes = container(n);
      const stageId = await stage(bytes);
      expect((await command('acknowledgeBehaviorTrust', { sourceDigest: createHash('sha256').update(bytes).digest('hex') })).ok).toBe(true);
      const body = { stageId, behaviorId: 'often', displayName: 'Often', expectedRevision: await revision(), requestId: mkRequestId() };
      const published = await api(`${base()}/content/behaviors/source`, { body, token: tb.authToken, origin: null });
      expect(published.status, `publication ${n}: ${JSON.stringify(published.json)}`).toBe(200);
      last = { body, revision: Number((published.json as { revision: number }).revision) };
      first ??= last;
    }
    // The last request sent again (its answer was lost): the same revision.
    const retried = await api(`${base()}/content/behaviors/source`, { body: last!.body, token: tb.authToken, origin: null });
    expect(retried.status, JSON.stringify(retried.json)).toBe(200);
    expect((retried.json as { revision: number }).revision).toBe(last!.revision);
    // The first request sent again after its stage gave way to the later uploads: still its answer, nothing published twice.
    expect(stageOnDisk(String(first!.body.stageId))).toBe(false);
    const before = await revision();
    const again = await api(`${base()}/content/behaviors/source`, { body: first!.body, token: tb.authToken, origin: null });
    expect(again.status, JSON.stringify(again.json)).toBe(200);
    expect((again.json as { revision: number }).revision).toBe(first!.revision);
    expect(await revision()).toBe(before);
  });
});
