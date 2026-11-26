/**
 * The instance-buffer route (what the editor's scatter and MCP's
 * tl_instance_buffer publish through), over HTTP against a real backend in
 * Node: a buffer is stored by its digest, 40 bytes a copy, and read back
 * whole; a count that is not whole copies and a non-finite value are refused;
 * an instance set naming a buffer the project does not hold is refused, the
 * published one taken.
 */
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { api, startBackend, type TestBackend } from '../../../packages/backend/src/test-helpers';
import { mustCommand, sendCommand, type CommandRoute } from '../../support/commands';

const PID = 'inst';
const REPO = resolve(import.meta.dirname, '..', '..', '..');

describe('instance buffers over HTTP', () => {
  let tb: TestBackend;
  let route: CommandRoute;
  beforeAll(async () => {
    tb = await startBackend({ engineRoot: REPO });
    const made = await api(`${tb.authUrl}/api/v1/admin/projects`, { body: { projectId: PID, name: 'Instances', template: 'starter' }, token: tb.adminToken, origin: null });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    route = { projectId: PID, command: async (body) => (await api(`${tb.authUrl}/api/v1/projects/${PID}/commands`, { body, token: tb.adminToken, origin: null })).json as Record<string, unknown> };
  }, 60_000);
  afterAll(async () => {
    await tb.teardown();
  });
  const publish = (transforms: unknown[]) => api(`${tb.authUrl}/api/v1/projects/${PID}/content/buffers`, { body: { transforms }, token: tb.adminToken, origin: null });

  it('stores a buffer by its digest and reads it back; refuses partial copies, non-finite values and an unknown buffer on a set', async () => {
    const transforms: number[] = [];
    for (let i = 0; i < 25; i += 1) transforms.push(2 + i * 0.5, 0, -2 - (i % 3), 0, 0, 0, 1, 0.3, 0.3, 0.3);
    const published = await publish(transforms);
    expect(published.status, JSON.stringify(published.json)).toBe(200);
    const { digest, count } = published.json as { digest: string; count: number };
    expect(count).toBe(25);
    const read = await fetch(`${tb.authUrl}/api/v1/projects/${PID}/content/buffers/${digest}`, { headers: { authorization: `Bearer ${tb.adminToken}` } });
    expect(read.status).toBe(200);
    const bytes = Buffer.from(await read.arrayBuffer());
    expect(bytes.length).toBe(25 * 40);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(digest);
    expect(Array.from(new Float32Array(bytes.buffer, bytes.byteOffset, 10))).toEqual(transforms.slice(0, 10).map((v) => Math.fround(v)));

    expect((await publish([1, 2, 3])).status).toBe(400);
    expect((await publish([0, 0, 0, 0, 0, 0, 1, 1, 1, 'x'])).status).toBe(400);

    const assets = (await route.command({ op: 'queryAssets', projectId: PID, args: { limit: 50, offset: 0 } }))['assets'] as { assetId: string; kind: string }[];
    const model = assets.find((a) => a.kind === 'model')!.assetId;
    const id = String((await mustCommand(route, 'createEntity', { sceneId: 'scene-main', kind: 'group', name: 'Row' }))['createdId']);
    const ghost = await sendCommand(route, 'setComponent', { entityId: id, component: 'instances', value: { asset: { assetId: model }, buffer: 'a'.repeat(64), count: 25 } });
    expect(ghost['ok']).not.toBe(true);
    await mustCommand(route, 'setComponent', { entityId: id, component: 'instances', value: { asset: { assetId: model }, buffer: digest, count: 25 } });
  }, 60_000);
});
