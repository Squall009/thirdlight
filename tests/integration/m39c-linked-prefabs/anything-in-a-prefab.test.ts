/**
 * Anything a scene object can carry goes in a prefab, through the real
 * backend over HTTP and into the real runtime.
 *
 * A player prefab (a character with its controller and a follow camera on
 * it) is made by the commands from scene objects and placed twice; the
 * second copy reads its own actions (an override). The Play build holds two
 * players, each copy's camera following its own character. Run in the
 * production game host with Rapier and a recorded input, each player walks
 * from its own actions only. Two copies of a camera prefab and the players'
 * cameras leave one camera live in the view. The scene's counted limits
 * hold for its copies' parts: a second copy of a prefab with a hemisphere
 * light is refused as a second hemisphere light in the scene is.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { testTempBase } from '@thirdlight/backend/testing';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { physics3DConfigOf } from '@thirdlight/runtime';

import { FakeEditor } from '../../../packages/backend/src/test-editor';
import { api, connectWs, mkRequestId, mkSessionId, startBackend, type TestBackend } from '../../../packages/backend/src/test-helpers';
import { FakeNode, behaviorModule, startHarness } from '../m22-worker/harness';
import { MODULES_3D, SETTINGS, type Any } from '../3d/character-kit';

const REPO = resolve(import.meta.dirname, '..', '..', '..');
const PID = 'demo-0001';
const DT = 1 / 120;

describe('anything in a prefab', () => {
  let tb: TestBackend;
  let exportRoot: string;
  const revision = (): number => {
    const r = tb.backend._test.service.readCapturedV3(PID);
    if (!r.ok) throw new Error(r.error.code);
    return r.read.revision;
  };
  const post = async (op: string, args: Record<string, unknown>): Promise<Any> =>
    api(`${tb.authUrl}/api/v1/projects/${PID}/commands`, { body: { op, projectId: PID, expectedRevision: revision(), requestId: mkRequestId(), origin: { kind: 'mcp', clientId: 'anything-in-a-prefab' }, args }, token: tb.adminToken, origin: null });
  const command = async (op: string, args: Record<string, unknown>): Promise<Any> => {
    const r = await post(op, args);
    expect(r.status, `${op} ${JSON.stringify(r.json).slice(0, 600)}`).toBe(200);
    return r.json;
  };
  const create = async (name: string, components: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<string> => {
    const id = (await command('createEntity', { kind: 'group', name, sceneId: 'scene-main', ...extra })).createdId as string;
    for (const [component, value] of Object.entries(components)) await command('setComponent', { entityId: id, component, value });
    return id;
  };
  /** A prefab made from scene objects by the commands (the objects deleted after). */
  const prefabFrom = async (prefabId: string, root: string): Promise<void> => {
    await command('createPrefab', { prefabId, displayName: prefabId, sourceEntityId: root });
    await command('deleteEntity', { entityId: root });
  };
  const place = async (prefabId: string, position: number[]): Promise<string> => (await command('instantiatePrefab', { sceneId: 'scene-main', prefabId, transform: { position } })).change.rootId as string;

  beforeAll(async () => {
    exportRoot = mkdtempSync(join(testTempBase(), 'tl-anything-prefab-'));
    tb = await startBackend({ exportRoot, engineRoot: REPO });
  }, 120_000);
  afterAll(async () => {
    await tb?.teardown();
    rmSync(exportRoot, { recursive: true, force: true });
  });

  it('a player prefab placed twice is two players, each walking from its own actions; one camera is live', async () => {
    const hero = await create('Hero', { controller: {} }, { transform: { position: [0, 0.91, 0] } });
    await create('Hero camera', { virtualCamera: { rig: 'follow', target: hero, distance: 6, priority: 10 } }, { parentId: hero, transform: { position: [0, 2, 6] } });
    await prefabFrom('hero', hero);
    const shot = await create('Shot', { virtualCamera: { rig: 'fixed', priority: 5 } }, { transform: { position: [0, 8, 12] } });
    await prefabFrom('shot', shot);

    const a = await place('hero', [-2, 0.91, 0]);
    const b = await place('hero', [2, 0.91, 0]);
    // The second player reads its own actions: an override on its copy.
    await command('setComponent', { entityId: b, component: 'controller', value: { moveAction: 'move_p2', jumpAction: 'jump_p2' } });
    const shots = [await place('shot', [0, 8, 12]), await place('shot', [4, 8, 12])];

    // Play, from an editor session.
    const sessionId = mkSessionId();
    const est = await api(`${tb.authUrl}/api/v1/sessions`, { body: { projectId: PID, sessionId, clientInfo: { kind: 'browser', label: 'anything-in-a-prefab' } }, token: tb.authToken });
    expect(est.status, JSON.stringify(est.json).slice(0, 400)).toBe(200);
    const ws = await connectWs(`${tb.authUrl.replace(/^http/, 'ws')}/api/v1/ws?${new URLSearchParams({ sessionId, wsToken: (est.json as Any).wsToken }).toString()}`, { Origin: 'http://127.0.0.1:8501' });
    await ws.waitFor((m) => (m as Any).type === 'attached', 30_000);
    const editor = new FakeEditor(ws);
    const p = await api(`${tb.authUrl}/api/v1/projects/${PID}/play`, { body: {}, token: tb.authToken });
    expect(p.status, JSON.stringify(p.json).slice(0, 600)).toBe(200);
    const playSessionId = (p.json as Any).playSessionId as string;
    const set = tb.backend._test.playContent.forPlay(playSessionId)!;
    const scene = JSON.parse(new TextDecoder().decode((set.artifacts.get('scenes/scene-main.json') as { bytes: Uint8Array }).bytes));
    await editor.waitUntil(() => tb.backend._test.plays.get(playSessionId)?.state === 'presented', 30_000);
    await api(`${tb.authUrl}/api/v1/projects/${PID}/play/${playSessionId}/stop`, { body: {}, token: tb.authToken });
    await editor.waitForEvent('play.stopped');
    ws.close();
    const entities = scene.entities as Any[];
    const byId = new Map(entities.map((e) => [e.id, e]));
    // Two players, each with its own camera following it.
    expect(byId.get(a).components.controller).toEqual({});
    expect(byId.get(b).components.controller).toMatchObject({ moveAction: 'move_p2', jumpAction: 'jump_p2' });
    const cameraOf = (root: string): Any => entities.find((e) => e.parentId === root && e.components.virtualCamera !== undefined);
    expect(cameraOf(a).components.virtualCamera.target).toBe(a);
    expect(cameraOf(b).components.virtualCamera.target).toBe(b);
    for (const id of shots) expect(byId.get(id).components.virtualCamera).toMatchObject({ rig: 'fixed', priority: 5 });

    // The players, their cameras and the shots as the Play build holds them, on a floor, in the production game host.
    const floor = { id: 'floor-0001', components: { transform: { position: [0, -0.5, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, collider: { shape: { type: 'box', hx: 30, hy: 0.5, hz: 30 } } } };
    const copies = [a, b, ...shots];
    const game = [...entities.filter((e) => copies.includes(e.id) || copies.includes(e.parentId)), floor];
    const axis = (x: number): Any => ({ v: x, x, y: 0, p: 'none' });
    // Player A walks right on `move` (steps 20–119), player B left on `move_p2` (steps 200–299).
    const replay = Array.from({ length: 500 }, (_, s) => ({ stepIndex: s, actions: { ...(s >= 20 && s < 120 ? { move: axis(1) } : {}), ...(s >= 200 && s < 300 ? { move_p2: axis(-1) } : {}) } }));
    const h = await startHarness('single', {
      snapshot: { snapshotId: 'hero@r1', projectId: 'hero', revision: 1, scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities: game }, scenes: [{ sceneId: 'scene-main', start: true, entityIds: game.map((e) => e.id) }] },
      settings: SETTINGS,
      physics: physics3DConfigOf(game, SETTINGS),
      modules: MODULES_3D,
      replay,
      digestSteps: true,
      host: { buildId: 'b', container: new FakeNode() },
    });
    try {
      const x = (id: string): number => h.rt.controllers.result(id)!.position.x;
      let now = 10;
      const until = async (step: number): Promise<void> => {
        while (h.digests.length < step) {
          now += DT;
          await h.tick(now);
        }
      };
      await until(5);
      const [a0, b0] = [x(a), x(b)];
      await until(170);
      // A walked on its own action; B stood.
      expect(x(a) - a0).toBeGreaterThan(1);
      expect(Math.abs(x(b) - b0)).toBeLessThan(0.01);
      const a1 = x(a);
      await until(370);
      expect(x(b) - b0).toBeLessThan(-1);
      expect(Math.abs(x(a) - a1)).toBeLessThan(0.01);
      // One view, one live camera: the highest priority (a player's camera), never a shot.
      const obs = h.host.observe();
      expect(obs.ok).toBe(true);
      const live = (obs as Any).observation.camera.live as string;
      expect([cameraOf(a).id, cameraOf(b).id]).toContain(live);
    } finally {
      await h.dispose();
    }
  }, 120_000);

  it('the scene\'s counted limits hold for its copies\' parts', async () => {
    const sky = await create('Sky', { light: { type: 'hemisphere', color: '#ffffff', groundColor: '#334455', intensity: 0.5 } });
    await prefabFrom('sky', sky);
    await place('sky', [0, 10, 0]);
    const r = await post('instantiatePrefab', { sceneId: 'scene-main', prefabId: 'sky' });
    expect(r.status).not.toBe(200);
    expect(JSON.stringify(r.json)).toContain('hemisphere');
  }, 60_000);

  it('a spawned player that is destroyed leaves the game: its controller and its physics character go, the next player is the first', async () => {
    // Two players spawned from a player prefab; the first is destroyed (as a game respawning its player would).
    const director = `let first = null;
export default {
  step(s, ctx) {
    if (ctx.phase !== 'intent') return;
    if (ctx.stepIndex === 30) first = ctx.spawn('runner', { position: [-2, 0.91, 0] });
    if (ctx.stepIndex === 35) ctx.spawn('runner', { position: [2, 0.91, 0] });
    if (ctx.stepIndex === 70) ctx.destroy(first);
  },
};
`;
    const T = (p: number[]): Any => ({ position: p, rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
    const runner = { prefabId: 'runner', displayName: 'Runner', createdRevision: 1, entityCount: 1, depth: 1, entities: [{ localId: 'runner', name: 'Runner', components: { transform: T([0, 0.91, 0]), controller: {} } }] };
    const game = [
      { id: 'floor-0001', components: { transform: T([0, -0.5, 0]), collider: { shape: { type: 'box', hx: 30, hy: 0.5, hz: 30 } } } },
      { id: 'director-0001', components: { transform: T([0, -5, 0]), behavior: { behaviorId: 'director', values: {} } } },
    ];
    const axis = (x: number): Any => ({ v: x, x, y: 0, p: 'none' });
    const replay = Array.from({ length: 300 }, (_, s) => ({ stepIndex: s, actions: s >= 100 ? { move: axis(1) } : {} }));
    const h = await startHarness('single', {
      snapshot: { snapshotId: 'runner@r1', projectId: 'runner', revision: 1, scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities: game }, scenes: [{ sceneId: 'scene-main', start: true, entityIds: game.map((e) => e.id) }], prefabs: [runner] },
      settings: SETTINGS,
      physics: physics3DConfigOf(game, SETTINGS),
      modules: MODULES_3D,
      behaviors: [behaviorModule('director', director)],
      replay,
      digestSteps: true,
      host: { buildId: 'b', container: new FakeNode() },
    });
    try {
      const rt = h.rt as Any;
      const colliders = (): number => rt.sim.physics3d.diagnostics().worldColliderCount as number;
      let now = 10;
      const until = async (step: number): Promise<void> => {
        while (h.digests.length < step) {
          now += DT;
          await h.tick(now);
        }
      };
      await until(3);
      const empty = colliders();
      expect(rt.controllers.ids).toEqual([]);
      await until(55);
      const [a, b] = rt.controllers.ids as string[];
      expect(rt.controllers.ids).toHaveLength(2);
      expect(rt.controllers.first).toBe(a);
      expect(colliders()).toBe(empty + 2);
      await until(95);
      expect(rt.controllers.ids).toEqual([b]);
      expect(rt.controllers.first).toBe(b);
      expect(rt.controllers.result(a)).toBeUndefined();
      expect(colliders()).toBe(empty + 1);
      // The remaining player is the one an unnamed call and the input move.
      const x0 = rt.controllers.result(b).position.x as number;
      await until(260);
      expect(rt.controllers.result(b).position.x - x0).toBeGreaterThan(1);
      // No failure (the scene has no camera, which is only a warning).
      expect(((rt.getDiagnostics() as Any).diagnostics?.errors ?? []).filter((e: Any) => e.reason !== 'warn')).toEqual([]);
    } finally {
      await h.dispose();
    }
  }, 60_000);
});
