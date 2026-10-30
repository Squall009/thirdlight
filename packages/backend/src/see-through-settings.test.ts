/**
 * See-through's project settings and per-object flag through the real
 * backend: set with commands over HTTP (the one mutation path the editor and
 * MCP share), refused out of range or of the wrong type, kept (a new session
 * opens the objects' flags), and carried into Play (the content's settings, the
 * snapshot's components) — what the game page reads to draw it. A prefab
 * keeps the flag and every other stored model field, so its placed copies
 * look like the object it was made from.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SEE_THROUGH_LIMITS, SEE_THROUGH_SETTING_KEYS, seeThroughSettingsOfProject } from '@thirdlight/project-model/limits';

import { glbBytes } from '@thirdlight/shared';
import { FakeEditor } from './test-editor';
import { api, establish, mkRequestId, mkSessionId, playContentOf, startBackend, upgrade, type TestBackend } from './test-helpers';

type Any = any;
const PID = 'demo-0001';
/** A small model file the import takes: one triangle. */
const COURIER = glbBytes(JSON.stringify(
  {
    asset: { version: '2.0' },
    buffers: [{ byteLength: 36 }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36, target: 34962 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
    meshes: [{ name: 'courier', primitives: [{ attributes: { POSITION: 0 } }] }],
    nodes: [{ name: 'courier', mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  }),
  new Uint8Array(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer),
);

describe('see-through settings and the object flag (real backend)', () => {
  let tb: TestBackend;
  const revision = (): number => {
    const r = tb.backend._test.service.readCapturedV3(PID);
    if (!r.ok) throw new Error(r.error.code);
    return r.read.revision;
  };
  const command = (op: string, args: Record<string, unknown>) =>
    api(`${tb.authUrl}/api/v1/projects/${PID}/commands`, { body: { op, projectId: PID, expectedRevision: revision(), requestId: mkRequestId(), origin: { kind: 'mcp', clientId: 'see-through-test' }, args }, token: tb.adminToken, origin: null });
  const ok = async (op: string, args: Record<string, unknown>): Promise<Any> => {
    const r = await command(op, args);
    expect(r.status, JSON.stringify(r.json).slice(0, 400)).toBe(200);
    return r.json;
  };
  /** The project as a new editor session opens it (what is on disk). */
  const open = async (): Promise<Any> => {
    const r = await api(`${tb.authUrl}/api/v1/sessions`, { body: { projectId: PID, sessionId: mkSessionId(), clientInfo: { kind: 'browser', label: 'see-through' } }, token: tb.adminToken });
    expect(r.status, JSON.stringify(r.json).slice(0, 400)).toBe(200);
    return r.json;
  };
  const refused = async (op: string, args: Record<string, unknown>): Promise<string> => {
    const r = await command(op, args);
    expect(r.status, JSON.stringify(r.json).slice(0, 400)).not.toBe(200);
    return (r.json as { error: { code: string } }).error.code;
  };

  beforeAll(async () => {
    tb = await startBackend();
  }, 60_000);
  afterAll(async () => {
    await tb?.teardown();
  });

  it('sets, refuses, keeps and plays the settings and each kind\'s flag', async () => {
    const s = SEE_THROUGH_SETTING_KEYS;
    const settings = { [s.enabled]: 1, [s.radius]: 0.35, [s.softness]: 0.25, [s.maxFade]: 0.6, [s.depthMargin]: 0.5, [s.fadeTime]: 0.4, [s.padding]: 0.6 };
    // setSettings merges into the project's settings (the editor's Rendering fields and MCP send the same).
    const set = await ok('setSettings', { settings });
    expect(seeThroughSettingsOfProject(set.change.next)).toEqual({ enabled: true, radius: 0.35, softness: 0.25, maxFade: 0.6, depthMargin: 0.5, fadeTime: 0.4, padding: 0.6 });
    // Out of range or not one of the values: refused.
    expect(await refused('setSettings', { settings: { [s.maxFade]: SEE_THROUGH_LIMITS.maxFade.max + 0.01 } })).toBe('field_value');
    expect(await refused('setSettings', { settings: { [s.enabled]: 2 } })).toBe('field_value');
    expect(await refused('setSettings', { settings: { [s.padding]: SEE_THROUGH_LIMITS.padding.max + 1 } })).toBe('field_value');

    // The flag on a box (Inspector edit: setComponent), a wrong type refused, null back to the default.
    const box = (await ok('createEntity', { sceneId: 'scene-main', kind: 'box', name: 'Wall' })).createdId as string;
    const boxValue = async (): Promise<Any> => (await open()).scene.entities.find((e: Any) => e.id === box).components.box;
    await ok('setComponent', { entityId: box, component: 'box', value: { ...(await boxValue()), seeThrough: false } });
    expect(await refused('setComponent', { entityId: box, component: 'box', value: { ...(await boxValue()), seeThrough: 'no' } })).toBeTruthy();
    // Generated architecture and a block layer opt out the same way (made with the flag).
    const arch = (await ok('createEntity', { sceneId: 'scene-main', kind: 'group', name: 'Rooms', components: { architecture: { elements: [{ id: 'wall', kind: 'sweep', path: { points: [[0, 0, 0], [6, 0, 0]] }, profile: 'wall' }], profiles: { wall: { points: [[0, 0], [0, 3]], slots: ['lower_wall'] } }, seeThrough: false } } })).createdId as string;
    const layer = (await ok('createEntity', { sceneId: 'scene-main', kind: 'group', name: 'Blocks', components: { blockLayer: { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [8, 8, 8] }, seeThrough: false } } })).createdId as string;
    expect(await refused('createEntity', { sceneId: 'scene-main', kind: 'group', name: 'Bad', components: { blockLayer: { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [8, 8, 8] }, seeThrough: 0 } } })).toBeTruthy();

    // A new session opens what was written.
    const opened = await open();
    const comps = (id: string): Any => opened.scene.entities.find((e: Any) => e.id === id).components;
    expect(comps(box).box.seeThrough).toBe(false);
    expect(comps(arch).architecture.seeThrough).toBe(false);
    expect(comps(layer).blockLayer.seeThrough).toBe(false);

    // Back to the default: the flag leaves the document (absent: takes part).
    await ok('setComponent', { entityId: box, component: 'box', value: { ...(await boxValue()), seeThrough: null } });
    expect('seeThrough' in (await boxValue())).toBe(false);
    await ok('setComponent', { entityId: box, component: 'box', value: { ...(await boxValue()), seeThrough: false } });

    // Play carries the settings and the flags to the game page.
    const sid = mkSessionId();
    const est = await establish(tb, sid);
    const ws = await upgrade(tb, sid, est.wsToken);
    await ws.waitFor((m) => (m as { type?: string }).type === 'attached');
    const editor = new FakeEditor(ws);
    try {
      const r = await api(`${tb.authUrl}/api/v1/projects/${PID}/play`, { body: {}, token: tb.authToken });
      expect(r.status, JSON.stringify(r.json).slice(0, 400)).toBe(200);
      const psid = (r.json as { playSessionId: string }).playSessionId;
      const started = await editor.waitForEvent('play.started');
      const content = playContentOf(tb, psid);
      expect(seeThroughSettingsOfProject(content.settings)).toEqual({ enabled: true, radius: 0.35, softness: 0.25, maxFade: 0.6, depthMargin: 0.5, fadeTime: 0.4, padding: 0.6 });
      const played = (id: string): Any => ((started.snapshot as Any).scene.entities as Any[]).find((e) => e.id === id).components;
      expect(played(box).box.seeThrough).toBe(false);
      expect(played(arch).architecture.seeThrough).toBe(false);
      expect(played(layer).blockLayer.seeThrough).toBe(false);
    } finally {
      editor.close();
    }
  }, 120_000);
  it('a prefab keeps every stored model field: its definition, a placed copy, and an applied update', async () => {
    // A model asset, uploaded and published the way the editor imports one.
    const stage = (await api(`${tb.authUrl}/api/v1/projects/${PID}/content/stages`, { body: {}, token: tb.adminToken, origin: null })).json as { stageId: string };
    const put = await fetch(`${tb.authUrl}/api/v1/projects/${PID}/content/stages/${stage.stageId}/bytes`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${tb.adminToken}`, 'content-type': 'application/octet-stream', 'x-thirdlight-offset': '0', 'x-thirdlight-total': String(COURIER.length) },
      body: new Uint8Array(COURIER),
    });
    expect(put.status).toBe(200);
    const inspected = await api(`${tb.authUrl}/api/v1/projects/${PID}/content/stages/${stage.stageId}/inspect`, { body: {}, token: tb.adminToken, origin: null });
    expect(inspected.status, JSON.stringify(inspected.json).slice(0, 400)).toBe(200);
    const p = (inspected.json as Any).proposal;
    await ok('publishAsset', { mode: 'create', assetId: 'courier', kind: 'model', displayName: 'Courier', sourceDigest: p.sourceDigest, sourceByteLength: p.sourceByteLength, importRecipe: p.importRecipe, metrics: p.metrics, importedAt: '2026-10-01T00:00:00Z' });

    // A character that never thins, casts no shadow and sits in light layer 2.
    const model = { asset: { assetId: 'courier' }, seeThrough: false, castShadow: false, lightLayers: 2 };
    const source = (await ok('createEntity', { sceneId: 'scene-main', kind: 'model', name: 'Courier', model: { asset: { assetId: 'courier' } } })).createdId as string;
    await ok('setComponent', { entityId: source, component: 'model', value: model });
    const made = await ok('createPrefab', { prefabId: 'courier', displayName: 'Courier', sourceEntityId: source });
    expect(made.change.definition.entities[0].components.model).toEqual(model);

    const modelOf = async (id: string): Promise<Any> => (await open()).scene.entities.find((e: Any) => e.id === id).components.model;
    const copy = (await ok('instantiatePrefab', { sceneId: 'scene-main', prefabId: 'courier' })).change.rootId as string;
    expect(await modelOf(copy)).toEqual(model);

    // An applied update keeps the copy's fields too (and a field it changed).
    const updated = { ...model, receiveShadow: false, decalLayers: 1 };
    await ok('setComponent', { entityId: copy, component: 'model', value: updated });
    await ok('updatePrefab', { prefabId: 'courier', fromEntity: copy });
    const again = (await ok('instantiatePrefab', { sceneId: 'scene-main', prefabId: 'courier' })).change.rootId as string;
    expect(await modelOf(again)).toEqual(updated);
  }, 60_000);
});
