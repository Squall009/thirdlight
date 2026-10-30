/**
 * Nested prefabs and variants in the running game, built by the real
 * backend's commands and shipped by its Play build.
 *
 * A post prefab (a box with a red cap) is nested in a gate prefab whose copy
 * of it overrides the cap green; a "blue gate" variant of the gate overrides
 * the nested cap again (an override inside a variant's nested copy). A
 * scorch prefab carries its decal on a child, and a variant of it is linked
 * to it. The door block type is live, its look the blue gate variant (the
 * look check reads the assembled prefab: the variant's root is a nested
 * copy). In the production game host: `ctx.spawn` of the variant makes the
 * whole assembled gate with the blue cap; a live door cell spawns the same;
 * `ctx.decals.spawn` of the scorch variant leaves the scorch's decal.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { testTempBase } from '@thirdlight/backend/testing';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BlockGrid, applyBlockEdits, readRuntimeContentSync } from '@thirdlight/project-model';
import { physics3DConfigOf } from '@thirdlight/runtime';

import { FakeEditor } from '../../../packages/backend/src/test-editor';
import { api, connectWs, mkRequestId, mkSessionId, startBackend, type TestBackend } from '../../../packages/backend/src/test-helpers';
import { behaviorModule, startHarness } from '../m22-worker/harness';
import { SETTINGS, type Any } from '../3d/character-kit';

const REPO = resolve(import.meta.dirname, '..', '..', '..');
const PID = 'demo-0001';
const DT = 1 / 120;
const T = (position: number[]) => ({ position, rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
const SPAWNER = `export default {
  step(s, ctx) {
    if (ctx.phase !== 'intent' || ctx.stepIndex !== 3) return;
    ctx.save.set('gate', ctx.spawn('blue-gate', { position: [0, 4, 0] }));
    ctx.save.set('mark', ctx.decals.spawn('scorch-big', { position: [1, 0, 0] }));
  },
};
`;

describe('nested prefabs and variants in the running game', () => {
  let tb: TestBackend;
  let exportRoot: string;
  const revision = (): number => {
    const r = tb.backend._test.service.readCapturedV3(PID);
    if (!r.ok) throw new Error(r.error.code);
    return r.read.revision;
  };
  const command = async (op: string, args: Record<string, unknown>): Promise<Any> => {
    const r = await api(`${tb.authUrl}/api/v1/projects/${PID}/commands`, { body: { op, projectId: PID, expectedRevision: revision(), requestId: mkRequestId(), origin: { kind: 'mcp', clientId: 'prefab-runtime' }, args }, token: tb.adminToken, origin: null });
    expect(r.status, `${op} ${JSON.stringify(r.json).slice(0, 600)}`).toBe(200);
    return r.json;
  };
  const view = async (): Promise<Any[]> => ((await api(`${tb.authUrl}/api/v1/projects/${PID}/commands`, { body: { op: 'queryEntities', projectId: PID, args: { limit: 16_384 } }, token: tb.adminToken, origin: null })).json as Any).entities;
  const capOf = async (copy: string): Promise<string> => {
    const all = await view();
    const ids = new Set([copy]);
    for (const e of all) if (ids.has(e.parentId)) ids.add(e.id);
    return all.find((e) => ids.has(e.id) && e.name === 'Cap').id;
  };

  beforeAll(async () => {
    exportRoot = mkdtempSync(join(testTempBase(), 'tl-prefab-runtime-'));
    tb = await startBackend({ exportRoot, engineRoot: REPO });
  }, 120_000);
  afterAll(async () => {
    await tb?.teardown();
    rmSync(exportRoot, { recursive: true, force: true });
  });

  it('ctx.spawn of a variant, a live block and ctx.decals.spawn use the assembled prefab', async () => {
    await command('setMaterial', { material: { materialId: 'mat-scorch', name: 'Scorch', shader: 'decal', params: {}, textures: {} } });
    // The post: a box with a red cap.
    const post = (await command('createEntity', { kind: 'box', name: 'Post', sceneId: 'scene-main' })).createdId as string;
    await command('createEntity', { kind: 'box', name: 'Cap', parentId: post, transform: { position: [0, 0.6, 0] }, box: { size: [0.3, 0.2, 0.3], material: { color: '#cc0000' } } });
    await command('createPrefab', { prefabId: 'post', displayName: 'Post', sourceEntityId: post });
    await command('deleteEntity', { entityId: post });
    // The gate nests a post copy whose cap is green.
    const gate = (await command('createEntity', { kind: 'box', name: 'Gate', sceneId: 'scene-main' })).createdId as string;
    const nested = (await command('instantiatePrefab', { prefabId: 'post', parentId: gate, transform: { position: [1, 0, 0] } })).change.rootId as string;
    await command('setComponent', { entityId: await capOf(nested), component: 'box', value: { material: { color: '#00cc00' } } });
    await command('createPrefab', { prefabId: 'gate', displayName: 'Gate', sourceEntityId: gate });
    await command('deleteEntity', { entityId: gate });
    // The blue gate variant overrides the nested cap again (applied from a copy of the variant).
    await command('createPrefabVariant', { basePrefabId: 'gate', prefabId: 'blue-gate', displayName: 'Blue gate' });
    const copy = (await command('instantiatePrefab', { sceneId: 'scene-main', prefabId: 'blue-gate' })).change.rootId as string;
    await command('setComponent', { entityId: await capOf(copy), component: 'box', value: { material: { color: '#0000cc' } } });
    await command('applyPrefabOverrides', { entityId: copy, all: true });
    await command('deleteEntity', { entityId: copy });
    // The scorch decal and a variant linked to it.
    const scorch = (await command('createEntity', { kind: 'group', name: 'Scorch', sceneId: 'scene-main' })).createdId as string;
    const mark = (await command('createEntity', { kind: 'group', name: 'Mark', parentId: scorch })).createdId as string;
    await command('setComponent', { entityId: mark, component: 'decal', value: { size: [0.5, 0.5, 0.2], material: 'mat-scorch' } });
    await command('createPrefab', { prefabId: 'scorch', displayName: 'Scorch', sourceEntityId: scorch });
    await command('deleteEntity', { entityId: scorch });
    await command('createPrefabVariant', { basePrefabId: 'scorch', prefabId: 'scorch-big', displayName: 'Big scorch' });
    // A live block whose look is the variant: its root is a nested copy, checked assembled.
    await command('setBlockType', { block: { blockId: 'door', name: 'Door', variants: [{ prefab: 'blue-gate' }], shape: 'none', live: true } });

    // The Play build ships the prefabs flattened.
    const sessionId = mkSessionId();
    const est = await api(`${tb.authUrl}/api/v1/sessions`, { body: { projectId: PID, sessionId, clientInfo: { kind: 'browser', label: 'prefab-runtime' } }, token: tb.authToken });
    expect(est.status, JSON.stringify(est.json).slice(0, 400)).toBe(200);
    const ws = await connectWs(`${tb.authUrl.replace(/^http/, 'ws')}/api/v1/ws?${new URLSearchParams({ sessionId, wsToken: (est.json as Any).wsToken }).toString()}`, { Origin: 'http://127.0.0.1:8501' });
    await ws.waitFor((m) => (m as Any).type === 'attached', 30_000);
    const editor = new FakeEditor(ws);
    const p = await api(`${tb.authUrl}/api/v1/projects/${PID}/play`, { body: {}, token: tb.authToken });
    expect(p.status, JSON.stringify(p.json).slice(0, 600)).toBe(200);
    const playSessionId = (p.json as Any).playSessionId as string;
    const set = tb.backend._test.playContent.forPlay(playSessionId)!;
    const content = readRuntimeContentSync(JSON.parse(new TextDecoder().decode(set.manifestBytes)), (path) => (set.artifacts.get(path) as { bytes?: Uint8Array } | undefined)?.bytes ?? null) as Any;
    await editor.waitUntil(() => tb.backend._test.plays.get(playSessionId)?.state === 'presented', 30_000);
    await api(`${tb.authUrl}/api/v1/projects/${PID}/play/${playSessionId}/stop`, { body: {}, token: tb.authToken });
    await editor.waitForEvent('play.stopped');
    ws.close();
    const shipped = (content.prefabs as Any[]).filter((x) => ['blue-gate', 'scorch-big'].includes(x.prefabId));
    expect(shipped).toHaveLength(2);
    const door = (content.blockTypes as Any[]).find((t) => t.blockId === 'door');

    // A layer with one door cell, the spawner, in the production game host.
    const LAYER = { cellSize: [1, 0.5, 1], bounds: { min: [0, 0, 0], max: [8, 4, 8] } };
    const g = new BlockGrid(LAYER as Any);
    applyBlockEdits(g, [{ kind: 'fill', box: [2, 0, 2, 3, 1, 3], cell: { block: 'door' } }] as Any, { types: new Map([['door', door]]), stamps: new Map() });
    const data = g.toData('ground-0001', null, g.takeDirty().chunks)!;
    const entities: Any[] = [
      { id: 'ground-0001', components: { transform: T([0, 0, 0]), blockLayer: LAYER } },
      { id: 'spawner-0001', components: { transform: T([0, -5, 0]), behavior: { behaviorId: 'spawner', values: {} } } },
    ];
    const h = await startHarness('single', {
      snapshot: { snapshotId: 'gates@r1', projectId: 'gates', revision: 1, scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities, blocks: [data] }, scenes: [{ sceneId: 'scene-main', start: true, entityIds: entities.map((e) => e.id) }], blockTypes: [door], prefabs: shipped },
      settings: SETTINGS,
      physics: physics3DConfigOf(entities, SETTINGS),
      storage: true,
      behaviors: [behaviorModule('spawner', SPAWNER)],
    });
    try {
      for (let i = 1; i <= 8; i += 1) await h.tick(10 + i * DT);
      const spawned = h.rt.sceneSet().spawned as Any[];
      const caps = spawned.filter((e) => e.name === 'Cap');
      // The spawned gate and the live door: each the whole assembled variant, its nested cap blue.
      expect(caps).toHaveLength(2);
      for (const c of caps) expect(c.components.box.material.color).toBe('#0000cc');
      const values = await h.storage();
      const root = spawned.find((e) => e.id === values['gate']);
      expect(root).toMatchObject({ name: 'Gate', components: { transform: { position: [0, 4, 0] } } });
      expect(spawned.filter((e) => e.name === 'Post').map((e) => e.parentId)).toContain(root.id);
      expect(spawned.some((e) => e.id.startsWith('ground-0001-') && e.name === 'Gate')).toBe(true);
      // The scorch variant's decal (on its base's child) was left: a prefab without one gives handle 0.
      expect(values['mark']).toBeGreaterThan(0);
    } finally {
      await h.dispose();
    }
  }, 120_000);
});
