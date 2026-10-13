/**
 * Importing many assets in a row over HTTP (the project window's import…, a
 * GLB dropped on a kit slot, a decal image): each import stages its file and
 * inspects it, which holds the bytes for the publishAsset. A project holds
 * only a few open stages, so an inspected stage must give way to the next
 * upload — a session importing more files than that within the stage's hour
 * is never refused with `open_stages`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CONTENT_OPEN_STAGES as MAX_OPEN_STAGES } from '@thirdlight/protocol';

import { api, startBackend, type TestBackend } from './test-helpers';

let tb: TestBackend;
beforeAll(async () => {
  tb = await startBackend();
});
afterAll(async () => {
  await tb.teardown();
});

const P = 'demo-0001';
const base = (): string => `${tb.authUrl}/api/v1/projects/${P}`;

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

describe('importing asset after asset (HTTP)', () => {
  it(`stages and inspects more than ${MAX_OPEN_STAGES} files in a row`, async () => {
    const glb = new Uint8Array(readFileSync(join(process.cwd(), 'fixtures', 'm2', 'assets', 'tiny-v1.glb')));
    for (let n = 1; n <= MAX_OPEN_STAGES + 2; n++) {
      const stageId = await stage(glb);
      const inspected = await api(`${base()}/content/stages/${stageId}/inspect`, { body: {}, token: tb.authToken, origin: null });
      expect(inspected.status, `import ${n}: ${JSON.stringify(inspected.json).slice(0, 300)}`).toBe(200);
    }
  });
});
