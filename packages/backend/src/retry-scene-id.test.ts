/**
 * Phase 14.8: a retried command replays the live acknowledgement, `sceneId`
 * included, across a backend restart (the v4 retry record, record version 2,
 * stores the acked scene). Real HTTP against a real backend; the second
 * backend is a new process-level instance on the same data root.
 */
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { createBackend, type Backend } from './backend';
import { AUTHORING_ORIGIN, PREVIEW_ORIGIN, api, mkRequestId } from './test-helpers';
import { createTestBackend } from './testing';

const PID = 'retry-scenes';
const AUTH = 'auth-retry-scene-id';
const TOKENS = [{ token: AUTH, scope: `authoring:${PID}` }];

describe('retry after a backend restart names the edited scene', () => {
  let root = '';
  let teardown: (() => Promise<void>) | null = null;
  let second: Backend | null = null;
  afterAll(async () => {
    if (second !== null) await second.close();
    if (teardown !== null) await teardown();
  });

  it('a replayed create in a second scene carries that sceneId; a replayed scene-index change carries none', async () => {
    const t = await createTestBackend({
      authoringOrigin: AUTHORING_ORIGIN,
      previewOrigin: PREVIEW_ORIGIN,
      authoringOrigins: [AUTHORING_ORIGIN],
      tokens: TOKENS,
    });
    root = t.root;
    teardown = t.teardown;
    t.backend._test.service.createProject(PID, 'Retry scenes');
    const url = (b: Backend): string => `http://127.0.0.1:${b.portAuthoring}/api/v1/projects/${PID}/commands`;
    const origin = { kind: 'mcp', clientId: 'harness' };
    const send = (b: Backend, body: unknown) => api(url(b), { body, token: AUTH, origin: null });

    const sceneReq = { op: 'createScene', projectId: PID, requestId: mkRequestId(), expectedRevision: 0, args: { sceneId: 'level-two', name: 'Level two' }, origin };
    const sceneAck = (await send(t.backend, sceneReq)).json as Record<string, unknown>;
    expect(sceneAck.ok).toBe(true);
    expect('sceneId' in sceneAck).toBe(false);

    const createReq = { op: 'createEntity', projectId: PID, requestId: mkRequestId(), expectedRevision: 1, args: { kind: 'box', parentId: null, name: 'Crate', sceneId: 'level-two' }, origin };
    const createAck = (await send(t.backend, createReq)).json as Record<string, unknown>;
    expect(createAck.ok).toBe(true);
    expect(createAck.sceneId).toBe('level-two');

    // Restart: a new backend on the same data root (the graceful close keeps the records).
    await t.backend.close();
    const created = createBackend({
      authoringOrigin: AUTHORING_ORIGIN,
      previewOrigin: PREVIEW_ORIGIN,
      authoringOrigins: [AUTHORING_ORIGIN],
      tokens: TOKENS,
      dataRoot: join(root, 'data'),
      editorStaticDir: join(root, 'editor'),
      previewStaticDir: join(root, 'preview'),
      authoringBind: '127.0.0.1:0',
      previewBind: '127.0.0.1:0',
    });
    if (!created.ok) throw new Error(`createBackend failed: ${created.error.message}`);
    second = created.backend;
    await second.ready;
    // The first backend is closed; teardown only needs to remove the root now.
    teardown = async () => {
      rmSync(root, { recursive: true, force: true });
    };

    const replay = (await send(second, createReq)).json as Record<string, unknown>;
    expect(replay).toEqual({ ...createAck, duplicated: true });
    expect(replay.sceneId).toBe('level-two');

    const sceneReplay = (await send(second, sceneReq)).json as Record<string, unknown>;
    expect(sceneReplay).toEqual({ ...sceneAck, duplicated: true });
    expect('sceneId' in sceneReplay).toBe(false);
  }, 30000);
});
