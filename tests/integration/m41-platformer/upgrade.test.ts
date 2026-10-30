/**
 * A 2D project opened over HTTP by this engine: the one-time upgrade to the
 * one 3D physics backend.
 *
 * The project is shaped like a side-scrolling platformer's (Sprout's settings,
 * its own 1D move input, scenes of 2D boxes and convex polygons, a one-way
 * shelf, a lift, checkpoint triggers and a stand switch, a player with the 2D
 * controller's windows), built through the commands and written as a
 * schemaVersion 7 engine left it (no physics setting: the 2D plane). It opens
 * as 8: each scene has a default plane (Z at 0), the colliders their 3D
 * forms, the controller the arcade profile; Problems lists what was converted
 * grouped by kind, naming the objects and the field to check, and a line
 * shrinks as an edit saves an item. The exported game's scenes, loaded the way
 * the game page loads them, play the platformer parity cases on the 3D port
 * within the parity tolerances. Opening again changes nothing; a schema 8
 * project written before the step gets it once.
 */
import { readFileSync, readdirSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { testTempBase } from '@thirdlight/backend/testing';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { sceneEntitiesFromDocument } from '@thirdlight/runtime';

import { api, exportContentOf, mkRequestId, mkSessionId, startBackend, type TestBackend } from '../../../packages/backend/src/test-helpers';
import { BASE_CONTROLLER, CASES, PARITY, pathGap, readTrace, recordRun, SETTINGS, type PlatformerCase } from './cases';

type Any = any;

const REPO = resolve(import.meta.dirname, '..', '..', '..');
const PID = 'demo-0001';
/** The parity cases the upgraded project's scenes hold (one scene each). */
const PLAYED = ['jump-apex', 'slopes', 'one-way', 'movers'] as const;
/** Sprout-shaped input: its own actions, a 1D move. */
const INPUT = {
  actions: [
    { name: 'move', type: 'axis1d', map: 'gameplay', bindings: [{ kind: 'keys1d', negative: 'KeyA', positive: 'KeyD' }] },
    { name: 'jump', type: 'button', map: 'gameplay', bindings: [{ kind: 'key', code: 'Space' }] },
  ],
};

const caseOf = (id: string): PlatformerCase => CASES.find((c) => c.id === id)!;
const sceneIdOf = (caseId: string): string => (caseId === 'jump-apex' ? 'scene-main' : `scene-${caseId}`);

describe('a 2D project opened over HTTP: one 3D backend, scenes with a default plane', () => {
  let tb: TestBackend;
  let exportRoot: string;
  const dir = (): string => join(tb.root, 'data', 'projects', PID);
  const readJson = (path: string): Any => JSON.parse(readFileSync(path, 'utf8'));
  const revision = (): number => {
    const r = tb.backend._test.service.readCapturedV3(PID);
    if (!r.ok) throw new Error(r.error.code);
    return r.read.revision;
  };
  const command = async (op: string, args: Record<string, unknown>): Promise<Any> => {
    const r = await api(`${tb.authUrl}/api/v1/projects/${PID}/commands`, { body: { op, projectId: PID, expectedRevision: revision(), requestId: mkRequestId(), origin: { kind: 'mcp', clientId: 'planes-upgrade' }, args }, token: tb.adminToken, origin: null });
    expect(r.status, `${op}: ${JSON.stringify(r.json).slice(0, 600)}`).toBe(200);
    // Its files are on the disk (they are written after the answer).
    await tb.backend._test.service.flushed();
    return r.json;
  };
  const open = async (): Promise<number> => {
    revision();
    const r = await api(`${tb.authUrl}/api/v1/sessions`, { body: { projectId: PID, sessionId: mkSessionId(), clientInfo: { kind: 'browser', label: 'planes-upgrade' } }, token: tb.authToken });
    expect(r.status, JSON.stringify(r.json).slice(0, 400)).toBe(200);
    return (r.json as Any).revision as number;
  };
  const problems = async (code: string): Promise<string[]> => ((await api(`${tb.authUrl}/api/v1/projects/${PID}/problems`, { method: 'GET', token: tb.adminToken, origin: null })).json as Any).problems.filter((p: Any) => p.code === code).map((p: Any) => p.message as string);
  const sceneFile = (sceneId: string): string => join(dir(), 'scenes', `${sceneId}.json`);
  const projectFiles = (): Map<string, string> => {
    const out = new Map<string, string>();
    for (const rel of ['project.json', 'content.json', ...readdirSync(join(dir(), 'scenes')).map((f) => `scenes/${f}`)]) out.set(rel, readFileSync(join(dir(), rel), 'utf8'));
    return out;
  };
  /** The project's documents on the disk (the files without the retry records an open sets aside). */
  const documents = (): Map<string, unknown> => {
    const out = new Map<string, unknown>();
    for (const [rel, text] of projectFiles()) {
      const { retry: _r, ...doc } = JSON.parse(text) as Any;
      out.set(rel, doc);
    }
    return out;
  };
  /** Write the files as a schemaVersion 7 engine left them: no recorded upgrades. */
  const asSchema7 = (): void => {
    expect(tb.backend._test.service.releaseWorkspace(PID).ok).toBe(true);
    const { upgrades: _u, ...manifest } = readJson(join(dir(), 'project.json'));
    writeFileSync(join(dir(), 'project.json'), `${JSON.stringify({ ...manifest, schemaVersion: 7 }, null, 2)}\n`);
  };
  /** Ids of the objects made per scene (name → id). */
  const ids = new Map<string, Map<string, string>>();

  beforeAll(async () => {
    exportRoot = mkdtempSync(join(testTempBase(), 'tl-planes-upgrade-export-'));
    tb = await startBackend({ exportRoot, engineRoot: REPO });
    await command('setSettings', { settings: { ...SETTINGS, camera_fov_deg: 50 } });
    await command('setInput', { input: INPUT });
    for (const id of PLAYED) {
      const c = caseOf(id);
      const sceneId = sceneIdOf(id);
      if (sceneId !== 'scene-main') await command('createScene', { name: id, sceneId });
      const made = new Map<string, string>();
      for (const e of c.level) {
        const t = e.components.transform;
        const { transform: _t, ...components } = e.components;
        made.set(e.id, (await command('createEntity', { kind: 'group', name: e.id, sceneId, transform: { position: t.position }, components })).createdId as string);
      }
      made.set('player', (await command('createEntity', { kind: 'group', name: 'Player', sceneId, transform: { position: [c.start[0], c.start[1], 0] }, components: { controller: { ...BASE_CONTROLLER, ...(c.controller ?? {}) } } })).createdId as string);
      ids.set(id, made);
    }
    // A checkpoint and a stand switch (Sprout's shapes).
    await command('createEntity', { kind: 'group', name: 'Checkpoint', sceneId: 'scene-main', transform: { position: [6, 1.2, 0] }, components: { trigger: { size: [1.2, 2.4], signal: 'checkpoint' } } });
    await command('createEntity', { kind: 'group', name: 'Switch', sceneId: 'scene-main', transform: { position: [8, 0.4, 0] }, components: { switch: { mode: 'stand', signal: 'gate', size: [1, 0.8], once: true } } });
    asSchema7();
  }, 120_000);
  afterAll(async () => {
    await tb?.teardown();
    rmSync(exportRoot, { recursive: true, force: true });
  });

  it('opens as 8: scenes on the Z plane, colliders in their 3D forms, the controller on the arcade profile', async () => {
    await open();
    const manifest = readJson(join(dir(), 'project.json'));
    expect(manifest.schemaVersion).toBe(8);
    expect(manifest.upgrades).toContain('planes');
    expect(readJson(join(dir(), 'content.json')).content.settings).not.toHaveProperty('physics_dimension');
    for (const id of PLAYED) {
      const scene = readJson(sceneFile(sceneIdOf(id))).scene;
      expect(scene.defaultPlane, id).toEqual({ axis: 'z', origin: 0 });
      const byId = new Map((scene.entities as Any[]).map((e) => [e.id, e]));
      const made = ids.get(id)!;
      expect(byId.get(made.get('player'))!.components.controller).toMatchObject({ profile: 'arcade', coyoteTime: 0.08 });
      // No plane of its own: it takes the scene's.
      expect(byId.get(made.get('player'))!.components.controller).not.toHaveProperty('plane');
      expect(byId.get(made.get('floor-0001'))!.components.collider.shape).toEqual({ type: 'box', hx: 40, hy: 0.5, hz: 0.5 });
    }
    const slopes = readJson(sceneFile('scene-slopes')).scene;
    const ramp = (slopes.entities as Any[]).find((e) => e.id === ids.get('slopes')!.get('ramp-0001'));
    expect(ramp.components.collider.shape.type).toBe('convex');
    expect(ramp.components.collider.shape.points).toHaveLength(6);
  });

  it('lists what it converted in Problems, one line per kind, naming the objects and the field to check', async () => {
    const lines = await problems('migrated_from_2d');
    const line = (needle: string): string => {
      const found = lines.filter((l) => l.includes(needle));
      expect(found, `${needle} in ${JSON.stringify(lines)}`).toHaveLength(1);
      return found[0]!;
    };
    expect(line('got a default plane')).toMatch(/^4 scenes .*`defaultPlane`: scene-main, scene-slopes/);
    // Floors (4), the slopes' top, the shelf, the lift: 7 boxes.
    expect(line('2D box colliders')).toMatch(/: 7 objects — check `collider\.shape\.hz`/);
    expect(line('became convex prisms')).toMatch(/: 2 objects — check `collider\.shape\.points`/);
    expect(line('one-way platforms')).toContain(`${ids.get('one-way')!.get('shelf-0001')} (scene-one-way)`);
    expect(line('arcade movement profile')).toMatch(/: 4 objects — check `controller\.profile`/);
    expect(line('[w, h] triggers')).toMatch(/: 1 object — check `trigger\.size`/);
    expect(line('[w, h] switches')).toMatch(/: 1 object — check `switch\.size`/);
    expect(line('box triggers test the player\'s capsule')).toMatch(/: 1 object — /);
    // The open's own note says what happened to the project once.
    const notes = await problems('project_upgraded');
    expect(notes.some((n) => n.startsWith('a 2D project (physics_dimension retired) moved to the one 3D physics backend: 4 scenes'))).toBe(true);
  });

  it("the exported game's scenes play the parity cases on the 3D port, arcade and on the plane, within the parity tolerances", async () => {
    const r = await api(`${tb.authUrl}/api/v1/admin/projects/${PID}/export`, { body: {}, token: tb.adminToken, origin: null });
    expect(r.status, JSON.stringify(r.json).slice(0, 400)).toBe(200);
    const out = join(exportRoot, String((r.json as Any).outputDir));
    const content = exportContentOf(out);
    for (const id of PLAYED) {
      const row = (content.scenes as Any[]).find((s) => s.sceneId === sceneIdOf(id));
      expect(row.plane, id).toEqual({ axis: 'z', origin: 0 });
      // The scene as the game page loads one: its bodies take the scene's plane.
      const loaded = sceneEntitiesFromDocument(readJson(join(out, row.path)), row.sceneId);
      if (!loaded.ok) throw new Error(loaded.message);
      const player = loaded.entities.find((e: Any) => e.id === ids.get(id)!.get('player'))!;
      expect((player.components as Any).controller).toMatchObject({ profile: 'arcade', plane: { axis: 'z', origin: 0 } });
      const run = await recordRun(caseOf(id), loaded.entities as Any[], { onPlane: true, playerId: player.id });
      // (A scene of the level alone has no camera: the view's warning about it is not the physics'.)
      expect(run.errors.filter((e: Any) => e.moduleId !== 'thirdlight.runtime:camera'), id).toEqual([]);
      const ref = readTrace(id).rows;
      let worst = 0;
      for (let i = 0; i < ref.length; i += 1) worst = Math.max(worst, pathGap(run.rows[i]!, ref, i));
      expect(worst, `${id}: worst step from the 2D path (m)`).toBeLessThanOrEqual(PARITY.path);
      // Held on the plane throughout.
      expect(Math.max(...run.depth.map(Math.abs)), id).toBeLessThanOrEqual(1e-6);
    }
  }, 120_000);

  it('an edit that saves a converted item takes it off its line', async () => {
    const floor = ids.get('one-way')!.get('floor-0001')!;
    await command('setComponent', { entityId: floor, component: 'collider', value: { shape: { type: 'box', hx: 40, hy: 0.5, hz: 1 } } });
    const lines = await problems('migrated_from_2d');
    // The shorter line replaces the old one: Problems never lists both.
    expect(lines.filter((l) => l.startsWith('2D box colliders'))).toEqual([expect.stringMatching(/: 6 objects/)]);
    const marks = readJson(sceneFile('scene-one-way')).scene.migratedFrom2D;
    expect(marks.objects[floor]).toBeUndefined();
    expect(marks.objects[ids.get('one-way')!.get('shelf-0001')!]).toEqual(['collider:box', 'collider:one-way']);
    // The scene's plane note goes when its plane is set.
    await command('setScenePlane', { sceneId: 'scene-one-way', plane: { axis: 'z', origin: 0 } });
    expect(readJson(sceneFile('scene-one-way')).scene.migratedFrom2D.plane).toBeUndefined();
    // The scene list the editor reads carries each scene's plane (its Scene settings and gizmo lock).
    const rows = ((await api(`${tb.authUrl}/api/v1/projects/${PID}/commands`, { body: { op: 'queryProject', projectId: PID, args: {} }, token: tb.adminToken, origin: null })).json as Any).scenes as Any[];
    expect(rows.find((r) => r.sceneId === 'scene-one-way').plane).toEqual({ axis: 'z', origin: 0 });
    expect(rows.every((r) => r.plane !== undefined)).toBe(true);
    const after = await problems('migrated_from_2d');
    expect(after.filter((l) => l.includes('got a default plane'))).toEqual([expect.stringMatching(/^3 scenes/)]);
  });

  it('opening it again changes nothing (no upgrade runs twice)', async () => {
    const before = documents();
    expect(tb.backend._test.service.releaseWorkspace(PID).ok).toBe(true);
    await open();
    expect(documents()).toEqual(before);
    expect((await problems('project_upgraded')).filter((n) => n.startsWith('a 2D project'))).toHaveLength(1);
  });

  it('a schema 8 project written before the step gets it once', async () => {
    // As an 8 engine before the step wrote it: no recorded upgrade, the scenes without their plane and notes.
    expect(tb.backend._test.service.releaseWorkspace(PID).ok).toBe(true);
    const { upgrades: _u, ...manifest } = readJson(join(dir(), 'project.json'));
    writeFileSync(join(dir(), 'project.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    for (const f of readdirSync(join(dir(), 'scenes'))) {
      const doc = readJson(join(dir(), 'scenes', f));
      const { defaultPlane: _p, migratedFrom2D: _m, ...scene } = doc.scene;
      writeFileSync(join(dir(), 'scenes', f), `${JSON.stringify({ ...doc, scene }, null, 2)}\n`);
    }
    await open();
    expect(readJson(join(dir(), 'project.json'))).toMatchObject({ schemaVersion: 8, upgrades: ['light-counts', 'planes'] });
    expect(readJson(sceneFile('scene-slopes')).scene.defaultPlane).toEqual({ axis: 'z', origin: 0 });
    // Already 3D: shapes and the profile stay as they are, only the scenes' planes are new (and noted).
    expect(readJson(sceneFile('scene-slopes')).scene.migratedFrom2D).toEqual({ plane: true });
    const once = documents();
    expect(tb.backend._test.service.releaseWorkspace(PID).ok).toBe(true);
    await open();
    expect(documents()).toEqual(once);
  });
});
