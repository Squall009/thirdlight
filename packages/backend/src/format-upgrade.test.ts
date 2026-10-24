/**
 * Project formats at the HTTP boundary: a format older than the oldest this
 * engine opens is refused untouched with the engine that upgrades it; the
 * current format's per-scene looks; the schemaVersion 6 upgrade; and the
 * open-time upgrades of shapes the current format dropped.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TRIM_DATA_GLTF_ATTRIBUTE } from '@thirdlight/project-model/trim-sheet';

import { writeGlb } from './glb-images';
import { api, AUTHORING_ORIGIN, exportContentOf, mkRequestId, mkSessionId, PREVIEW_ORIGIN, startBackend, type TestBackend } from './test-helpers';
import { createTestBackend } from './testing';

/** The per-scene look project (stored as schemaVersion 7), under the id it was written with. */
const SCENE_LOOKS = resolve(import.meta.dirname, '..', '..', '..', 'fixtures', 'phase27', 'scene-looks');
const SCENE_LOOKS_ID = 'legacy-v5-environment';

/**
 * A project older than schemaVersion 6 (every template and game was at 7 when
 * the upgraders for 2 to 5 were dropped): the open is refused with a message
 * naming the engine that still upgrades it, nothing is written, and the
 * project list says why it does not load.
 */
describe('a project older than schemaVersion 6 opened over HTTP', () => {
  let tb: TestBackend;
  const dir = (): string => join(tb.root, 'data', 'projects', SCENE_LOOKS_ID);

  beforeAll(async () => {
    tb = await startBackend({ tokens: [] });
    cpSync(SCENE_LOOKS, dir(), { recursive: true });
    const manifest = JSON.parse(readFileSync(join(dir(), 'project.json'), 'utf8')) as Record<string, unknown>;
    writeFileSync(join(dir(), 'project.json'), `${JSON.stringify({ ...manifest, schemaVersion: 5 }, null, 2)}\n`);
  });
  afterAll(async () => {
    await tb.teardown();
  });

  it('is refused naming the last engine that upgrades it, and its files stay untouched', async () => {
    const files = ['project.json', 'content.json', 'scenes/scene-main.json', 'scenes/scene-two.json'];
    const before = files.map((f) => readFileSync(join(dir(), f)));
    const r = await api(`${tb.authUrl}/api/v1/sessions`, { body: { projectId: SCENE_LOOKS_ID, sessionId: mkSessionId(), clientInfo: { kind: 'browser', label: 'format-refusal' } }, token: tb.adminToken });
    expect(r.status).not.toBe(200);
    const err = (r.json as { error: { code: string; reason: string; message: string; details?: Array<{ path: string; message: string }> } }).error;
    expect(err, JSON.stringify(err)).toMatchObject({ code: 'project_unavailable', reason: 'storage_version_unsupported' });
    expect(err.details?.[0]?.path).toBe('/schemaVersion');
    expect(err.details?.[0]?.message).toContain('schemaVersion 5 is too old: open the project once with Thirdlight');
    expect(err.details?.[0]?.message).toContain('git tag upgrades-project-schema-2-to-5 (commit f3d40136)');
    files.forEach((f, i) => expect(readFileSync(join(dir(), f)).equals(before[i]!), f).toBe(true));

    const list = await fetch(`${tb.authUrl}/api/v1/projects`, { headers: { authorization: `Bearer ${tb.adminToken}` } });
    const body = (await list.json()) as { projects: Array<{ projectId: string; loadable: boolean; code?: string; note?: string }> };
    const refused = body.projects.find((p) => p.projectId === SCENE_LOOKS_ID);
    expect(refused).toMatchObject({ loadable: false, code: 'storage_version_unsupported' });
    expect(refused?.note).toContain('upgrades-project-schema-2-to-5');
  });
});

/**
 * Each scene its own look (`fixtures/phase27/scene-looks`: two scenes with a
 * gradient sky, linear fog, post and wind, quality medium and a preset)
 * opened over HTTP: the content keeps the quality and the preset, the
 * queries give each scene's look, the recorded command replays from its
 * record, the file check finds nothing, and the export ships each scene with
 * its look; new scenes copy a look or start from the engine defaults.
 */
describe('a project whose scenes each have their own look opened over HTTP', () => {
  const REPO = resolve(import.meta.dirname, '..', '..', '..');
  const FIXTURE = SCENE_LOOKS;
  const ID = SCENE_LOOKS_ID;
  let tb: TestBackend;
  let exportRoot: string;
  const dir = (): string => join(tb.root, 'data', 'projects', ID);
  const readJson = (rel: string): Record<string, unknown> => JSON.parse(readFileSync(join(dir(), rel), 'utf8')) as Record<string, unknown>;
  const LOOK = {
    wind: { direction: [0, 1], strength: 1.5, gust: 0.5, gustFrequency: 0.4, turbulence: 0.2 },
    sky: { bottomColor: '#404040', environmentIntensity: 0.8, horizonColor: '#c0d8f0', mode: 'gradient', topColor: '#204080' },
    fog: { color: '#b0c4de', far: 140, mode: 'linear', near: 20 },
    post: { bloom: { enabled: true, strength: 0.4 }, exposure: 1.2, toneMapping: 'aces' },
  };

  beforeAll(async () => {
    exportRoot = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'tl-scene-looks-export-'));
    tb = await startBackend({ tokens: [], exportRoot, engineRoot: REPO });
    cpSync(FIXTURE, dir(), { recursive: true });
  });
  afterAll(async () => {
    await tb.teardown();
    rmSync(exportRoot, { recursive: true, force: true });
  });

  it('keeps quality and presets in the content, a look in each scene file, replays, and exports each scene with its look', async () => {
    const r = await api(`${tb.authUrl}/api/v1/sessions`, { body: { projectId: ID, sessionId: mkSessionId(), clientInfo: { kind: 'browser', label: 'scene-looks' } }, token: tb.adminToken });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    // A current project opens as it is: no upgrade, no new revision.
    expect((r.json as { revision: number }).revision).toBe(5);
    expect(readJson('project.json')['schemaVersion']).toBe(7);
    expect((readJson('content.json')['content'] as { environment: unknown }).environment).toEqual({ quality: 'medium', presets: ['dusk'] });
    for (const sceneId of ['scene-main', 'scene-two']) expect((readJson(`scenes/${sceneId}.json`)['scene'] as { environment?: unknown }).environment, sceneId).toEqual(LOOK);
    const problems = await api(`${tb.authUrl}/api/v1/projects/${ID}/problems`, { method: 'GET', token: tb.adminToken, origin: null });
    expect((problems.json as { problems: { code: string }[] }).problems.filter((p) => p.code === 'project_upgraded')).toEqual([]);

    // The queries: the project part, and each scene's look on request.
    const q = async (op: string, args?: Record<string, unknown>): Promise<Record<string, unknown>> => (await api(`${tb.authUrl}/api/v1/projects/${ID}/commands`, { body: { op, projectId: ID, ...(args !== undefined ? { args } : {}) }, token: tb.adminToken, origin: null })).json as Record<string, unknown>;
    expect((await q('queryGameConfig'))['environment']).toMatchObject({ quality: 'medium', presets: [{ presetId: 'dusk', name: 'Dusk' }] });
    const rows = (await q('queryProject', { environments: true }))['scenes'] as { sceneId: string; environment?: unknown }[];
    expect(rows.map((x) => [x.sceneId, x.environment])).toEqual([['scene-main', LOOK], ['scene-two', LOOK]]);
    expect(((await q('queryProject'))['scenes'] as Record<string, unknown>[]).some((x) => 'environment' in x)).toBe(false);

    // The last recorded command (a setEnvironment of the project-wide look it was written with), sent again, replays its recorded result.
    const replay = JSON.parse(readFileSync(join(FIXTURE, 'replay.json'), 'utf8')) as Record<string, unknown>;
    const again = await api(`${tb.authUrl}/api/v1/projects/${ID}/commands`, { body: replay, token: tb.adminToken, origin: null });
    expect(again.status, JSON.stringify(again.json)).toBe(200);
    expect(again.json).toMatchObject({ ok: true, duplicated: true, revision: 4, requestId: replay['requestId'] });

    // The file check finds nothing to do; the files stay as they were.
    const files = ['project.json', 'content.json', 'scenes/scene-main.json', 'scenes/scene-two.json'].map((f) => readFileSync(join(dir(), f)));
    const check = await api(`${tb.authUrl}/api/v1/projects/${ID}/content/files/check`, { body: {}, token: tb.adminToken, origin: null });
    expect(check.status, JSON.stringify(check.json)).toBe(200);
    expect((check.json as { check: { reimported: unknown[]; failed: unknown[]; sidecarProblems: unknown[] } }).check).toMatchObject({ reimported: [], failed: [], sidecarProblems: [] });
    ['project.json', 'content.json', 'scenes/scene-main.json', 'scenes/scene-two.json'].forEach((f, i) => expect(readFileSync(join(dir(), f)).equals(files[i]!), f).toBe(true));

    // The export: the project part in the manifest, each scene's look in its scene file.
    const exported = await api(`${tb.authUrl}/api/v1/admin/projects/${ID}/export`, { body: {}, token: tb.adminToken, origin: null });
    expect(exported.status, JSON.stringify(exported.json)).toBe(200);
    const out = join(exportRoot, String((exported.json as { outputDir: string }).outputDir));
    const manifest = exportContentOf(out) as unknown as { environment?: unknown; scenes?: unknown[] };
    expect(manifest.environment).toMatchObject({ quality: 'medium', presets: [{ presetId: 'dusk' }] });
    expect(manifest.environment).not.toHaveProperty('sky');
    for (const row of (manifest.scenes ?? []) as { sceneId: string; path: string }[]) {
      const doc = JSON.parse(readFileSync(join(out, row.path), 'utf8')) as { environment?: unknown };
      expect(doc.environment, row.sceneId).toEqual(LOOK);
    }
    expect(((manifest.scenes ?? []) as unknown[]).length).toBe(2);
  }, 120_000);

  it('a new scene copies a look or starts from the engine defaults; an undone delete gets its look back', async () => {
    const send = async (op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const rev = Number(((await api(`${tb.authUrl}/api/v1/projects/${ID}/commands`, { body: { op: 'queryProject', projectId: ID }, token: tb.adminToken, origin: null })).json as { revision: number }).revision);
      const res = await api(`${tb.authUrl}/api/v1/projects/${ID}/commands`, { body: { op, projectId: ID, requestId: mkRequestId(), expectedRevision: rev, args, origin: { kind: 'mcp', clientId: 'env-scenes' } }, token: tb.adminToken, origin: null });
      return res.json as Record<string, unknown>;
    };
    const lookOf = (sceneId: string): unknown => (readJson(`scenes/${sceneId}.json`)['scene'] as { environment?: unknown }).environment;
    expect((await send('createScene', { sceneId: 'scene-copy', name: 'Copy', environmentFrom: 'scene-two' }))['ok']).toBe(true);
    expect(lookOf('scene-copy')).toEqual(LOOK);
    expect((await send('createScene', { sceneId: 'scene-plain', name: 'Plain' }))['ok']).toBe(true);
    expect(lookOf('scene-plain')).toBeUndefined();
    // A scene's own look: only that scene's file changes.
    const mainBefore = readFileSync(join(dir(), 'scenes', 'scene-main.json'));
    const set = await send('setEnvironment', { sceneId: 'scene-copy', environment: { sky: { mode: 'color', color: '#FF8000' } } });
    expect(set, JSON.stringify(set)).toMatchObject({ ok: true, sceneId: 'scene-copy', change: { type: 'setEnvironment', sceneId: 'scene-copy' } });
    expect(lookOf('scene-copy')).toEqual({ sky: { color: '#ff8000', mode: 'color' } });
    expect(readFileSync(join(dir(), 'scenes', 'scene-main.json')).equals(mainBefore)).toBe(true);
    // Refused: a look without a sceneId, an unknown scene.
    const noScene = await send('setEnvironment', { environment: { sky: { mode: 'color', color: '#000000' } } });
    expect(noScene['ok']).toBe(false);
    expect(JSON.stringify(noScene)).toContain('sceneId');
    expect((await send('setEnvironment', { sceneId: 'nope', environment: {} }))['ok']).toBe(false);
    // Delete the copied scene, undo: it comes back with its look; redo removes it again.
    expect((await send('deleteScene', { sceneId: 'scene-copy' }))['ok']).toBe(true);
    expect(existsSync(join(dir(), 'scenes', 'scene-copy.json'))).toBe(false);
    expect((await send('undo', {}))['ok']).toBe(true);
    expect(lookOf('scene-copy')).toEqual({ sky: { color: '#ff8000', mode: 'color' } });
    expect((await send('redo', {}))['ok']).toBe(true);
    expect(existsSync(join(dir(), 'scenes', 'scene-copy.json'))).toBe(false);
    // Undo, then undo the look: the copied look again.
    expect((await send('undo', {}))['ok']).toBe(true);
    expect((await send('undo', {}))['ok']).toBe(true);
    expect(lookOf('scene-copy')).toEqual(LOOK);
  }, 60_000);
});

/**
 * The engine owns the view. Two schemaVersion 6 projects written by that
 * engine (`fixtures/phase28`), shaped like each of the two game projects': a
 * camera entity in a start scene with its own lens next to a level scene with
 * a virtual camera, and a title scene holding the camera and the player
 * (the README names the games). Opened over HTTP each becomes schemaVersion 7 in one new revision:
 * the scene camera is a fixed virtual camera at the lowest priority, its lens
 * the project's camera settings, the camera and the player keep loaded, the
 * recorded command replays and the export ships the shots and the lens.
 */
describe('a schemaVersion 6 project with a scene camera opened over HTTP', () => {
  const REPO = resolve(import.meta.dirname, '..', '..', '..');
  type Ent = { id: string; keepLoaded?: boolean; components: Record<string, unknown> };
  let tb: TestBackend;
  let exportRoot: string;
  const dir = (id: string): string => join(tb.root, 'data', 'projects', id);
  const readJson = (id: string, rel: string): Record<string, unknown> => JSON.parse(readFileSync(join(dir(id), rel), 'utf8')) as Record<string, unknown>;
  const entitiesOf = (id: string, sceneId: string): Ent[] => (readJson(id, `scenes/${sceneId}.json`)['scene'] as { entities: Ent[] }).entities;
  const fixtureEntities = (id: string, sceneId: string): Ent[] => (JSON.parse(readFileSync(join(REPO, 'fixtures', 'phase28', id, 'scenes', `${sceneId}.json`), 'utf8')) as { scene: { entities: Ent[] } }).scene.entities;
  const open = async (id: string): Promise<number> => {
    const r = await api(`${tb.authUrl}/api/v1/sessions`, { body: { projectId: id, sessionId: mkSessionId(), clientInfo: { kind: 'browser', label: 'view-upgrade' } }, token: tb.adminToken });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    return (r.json as { revision: number }).revision;
  };
  const replay = async (id: string): Promise<void> => {
    const body = JSON.parse(readFileSync(join(REPO, 'fixtures', 'phase28', id, 'replay.json'), 'utf8')) as Record<string, unknown>;
    const again = await api(`${tb.authUrl}/api/v1/projects/${id}/commands`, { body, token: tb.adminToken, origin: null });
    expect(again.status, JSON.stringify(again.json)).toBe(200);
    expect(again.json).toMatchObject({ ok: true, duplicated: true, requestId: body['requestId'] });
  };
  const upgradeNotes = async (id: string): Promise<string> => {
    const problems = await api(`${tb.authUrl}/api/v1/projects/${id}/problems`, { method: 'GET', token: tb.adminToken, origin: null });
    return (problems.json as { problems: { code: string; message: string }[] }).problems.filter((p) => p.code === 'project_upgraded').map((p) => p.message).join('\n');
  };

  beforeAll(async () => {
    exportRoot = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'tl-view-upgrade-export-'));
    tb = await startBackend({ tokens: [], exportRoot, engineRoot: REPO });
    for (const id of ['legacy-v6-start-camera', 'legacy-v6-title-player']) cpSync(join(REPO, 'fixtures', 'phase28', id), dir(id), { recursive: true });
  });
  afterAll(async () => {
    await tb.teardown();
    rmSync(exportRoot, { recursive: true, force: true });
  });

  it('a camera entity in a start scene becomes the lowest-priority shot, its lens the project\'s; the level camera is untouched; replays and exports', async () => {
    const ID = 'legacy-v6-start-camera';
    // The files were at 6: one new revision for the upgrade.
    expect(await open(ID)).toBe(7);
    expect(readJson(ID, 'project.json')['schemaVersion']).toBe(7);
    const cam = entitiesOf(ID, 'scene-main').find((e) => e.id === 'cam-main')!;
    const old = fixtureEntities(ID, 'scene-main').find((e) => e.id === 'cam-main')!;
    expect(cam.components['camera']).toBeUndefined();
    expect(cam.components['virtualCamera']).toEqual({ rig: 'fixed', priority: -1000 });
    expect(cam.components['transform']).toEqual(old.components['transform']);
    expect(cam.keepLoaded).toBe(true);
    // The lens is the project's now (every camera without its own uses it).
    expect((readJson(ID, 'content.json')['content'] as { settings: unknown }).settings).toEqual({ physics_dimension: 3, camera_fov_deg: 50, camera_near_m: 0.3, camera_far_m: 400 });
    // The level scene's own virtual camera and tile are as they were (only the revision stamp moved).
    expect(entitiesOf(ID, 'battle')).toEqual(fixtureEntities(ID, 'battle'));
    // The lights are untouched.
    expect(entitiesOf(ID, 'scene-main').filter((e) => e.id !== 'cam-main')).toEqual(fixtureEntities(ID, 'scene-main').filter((e) => e.id !== 'cam-main'));
    const notes = await upgradeNotes(ID);
    expect(notes).toContain('project schemaVersion 6 → 7');
    expect(notes).toContain('"cam-main" (scene "scene-main") became a fixed virtual camera');
    expect(notes).toContain('field of view 50°, near 0.3 m, far 400 m');
    // The last recorded command (it set the scene camera's lens) replays its recorded result.
    await replay(ID);
    // The export ships the lens settings and the shots.
    const exported = await api(`${tb.authUrl}/api/v1/admin/projects/${ID}/export`, { body: {}, token: tb.adminToken, origin: null });
    expect(exported.status, JSON.stringify(exported.json)).toBe(200);
    const out = join(exportRoot, String((exported.json as { outputDir: string }).outputDir));
    const manifest = exportContentOf(out) as unknown as { settings: Record<string, unknown>; scenes: { sceneId: string; path: string }[] };
    expect(manifest.settings).toMatchObject({ camera_fov_deg: 50, camera_near_m: 0.3, camera_far_m: 400 });
    const shipped = (sceneId: string): Ent[] => (JSON.parse(readFileSync(join(out, manifest.scenes.find((s) => s.sceneId === sceneId)!.path), 'utf8')) as { entities: Ent[] }).entities;
    expect(shipped('scene-main').find((e) => e.id === 'cam-main')?.components['virtualCamera']).toEqual({ rig: 'fixed', priority: -1000 });
    expect(shipped('battle').find((e) => e.id === 'group-000001')?.components['virtualCamera']).toEqual({ rig: 'orbitPoint', distance: 15, pitch: 45 });
    // A start with a camera live: the export warns about nothing.
    expect((exported.json as { warnings?: unknown[] }).warnings).toBeUndefined();
  }, 120_000);

  it('a title scene holding the camera and the player: both keep loaded, the default lens stays the default', async () => {
    const ID = 'legacy-v6-title-player';
    expect(await open(ID)).toBe(6);
    expect(readJson(ID, 'project.json')['schemaVersion']).toBe(7);
    const title = entitiesOf(ID, 'scene-main');
    const cam = title.find((e) => e.id === 'cam-main')!;
    expect(cam.components['virtualCamera']).toEqual({ rig: 'fixed', priority: -1000 });
    expect(cam.keepLoaded).toBe(true);
    const player = title.find((e) => e.id === 'box-000001')!;
    expect(player.components['controller']).toBeDefined();
    expect(player.keepLoaded).toBe(true);
    // Nothing else is kept: the spawn and the lights go with their scene.
    expect(title.filter((e) => e.keepLoaded === true).map((e) => e.id).sort()).toEqual(['box-000001', 'cam-main']);
    // The default lens is the engine default: no settings written.
    expect((readJson(ID, 'content.json')['content'] as { settings: unknown }).settings).toEqual({});
    expect(entitiesOf(ID, 'meadow')).toEqual(fixtureEntities(ID, 'meadow'));
    const notes = await upgradeNotes(ID);
    expect(notes).toContain('"cam-main", "box-000001" keep loaded when their scene unloads');
    expect(notes).not.toContain('camera settings');
    await replay(ID);
  }, 120_000);
});

/**
 * Per-vertex local lighting is gone: a project whose scene still stores an
 * object's `localLights: "vertex"` and a light's `importance` opens with
 * them shaded per pixel, written back once, and one Problems line counting
 * them.
 */
describe('a project with per-vertex local-light settings opened over HTTP', () => {
  let tb: TestBackend;
  // A small project; its scene gets the old settings written into it.
  const ID = SCENE_LOOKS_ID;
  const sceneFile = (): string => join(tb.root, 'data', 'projects', ID, 'scenes', 'scene-main.json');

  beforeAll(async () => {
    tb = await startBackend({ tokens: [] });
    cpSync(SCENE_LOOKS, join(tb.root, 'data', 'projects', ID), { recursive: true });
  });
  afterAll(async () => {
    await tb.teardown();
  });

  it('turns them per pixel, drops the importance, writes the scene back and says so once', async () => {
    const file = JSON.parse(readFileSync(sceneFile(), 'utf8')) as { scene: { entities: { id: string; components: Record<string, Record<string, unknown>> }[] } };
    const T = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
    file.scene.entities.push(
      { id: 'vbox-000001', components: { transform: T, box: { size: [1, 1, 1], localLights: 'vertex' } } },
      { id: 'vlamp-000001', components: { transform: T, light: { type: 'point', color: '#ffffff', intensity: 5, importance: 'vertex' } } },
      { id: 'vlamp-000002', components: { transform: T, light: { type: 'point', color: '#ffffff', intensity: 5, importance: 'pixel' } } },
    );
    writeFileSync(sceneFile(), JSON.stringify(file));
    const r = await api(`${tb.authUrl}/api/v1/sessions`, { body: { projectId: ID, sessionId: mkSessionId(), clientInfo: { kind: 'browser', label: 'vertex-lights-upgrade' } }, token: tb.adminToken });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const written = JSON.parse(readFileSync(sceneFile(), 'utf8')) as typeof file;
    const byId = new Map(written.scene.entities.map((e) => [e.id, e.components]));
    expect(byId.get('vbox-000001')!['box']!['localLights']).toBe('pixel');
    expect(byId.get('vlamp-000001')!['light']).not.toHaveProperty('importance');
    expect(byId.get('vlamp-000002')!['light']).not.toHaveProperty('importance');
    const problems = await api(`${tb.authUrl}/api/v1/projects/${ID}/problems`, { method: 'GET', token: tb.adminToken, origin: null });
    const lines = (problems.json as { problems: { code: string; message: string }[] }).problems.filter((p) => p.code === 'project_upgraded' && p.message.includes('per vertex'));
    expect(lines.map((p) => p.message)).toEqual([expect.stringContaining('2 local-light settings (objects, materials, lights) shaded per vertex now shade per pixel')]);
  }, 60_000);
});

/**
 * The built-in grime is gone: a project whose material files still store a
 * trim material's grime params and a layered graph reading the Layer weights
 * node's grime output opens with both taken out (the graph's grime mix folded
 * away, its parameters dropped), the files written back once, and one
 * Problems line naming the materials whose grime was set.
 */
describe('a project with built-in grime opened over HTTP', () => {
  let tb: TestBackend;
  const ID = SCENE_LOOKS_ID;
  const materialFile = (id: string): string => join(tb.root, 'data', 'projects', ID, 'assets', 'materials', `${id}.material.json`);
  const write = (data: Record<string, unknown>): void => writeFileSync(materialFile(String(data['materialId'])), JSON.stringify({ tlresource: 1, kind: 'material', id: data['materialId'], data }));
  const edge = (id: string, from: string, fromPort: string, to: string, toPort: string): Record<string, unknown> => ({ id, from: { node: from, port: fromPort }, to: { node: to, port: toPort } });

  beforeAll(async () => {
    tb = await startBackend({ tokens: [] });
    cpSync(SCENE_LOOKS, join(tb.root, 'data', 'projects', ID), { recursive: true });
    mkdirSync(join(tb.root, 'data', 'projects', ID, 'assets', 'materials'), { recursive: true });
  });
  afterAll(async () => {
    await tb.teardown();
  });

  it('drops the grime params and graph nodes, writes the materials back and names them once', async () => {
    const trim = { size: [256, 256], texelDensity: 128, padding: 4, rows: [{ slot: 'floor', top: 4, bottom: 124 }] };
    write({ materialId: 'mat-sheet', name: 'Sheet', shader: 'trim', params: { grime: 0.8, grimeColor: '#302010', roughness: 0.6 }, textures: {}, trim });
    write({ materialId: 'mat-clean', name: 'Clean', shader: 'trim', params: { roughness: 0.6 }, textures: {}, trim });
    // A layered graph as stored before: the colour mixed toward grimeColor by the Layer weights node's grime × grime.
    write({
      materialId: 'mat-walls',
      name: 'Walls',
      shader: 'standard',
      params: {},
      textures: {},
      parameters: [{ key: 'tint', type: 'color', default: '#808080' }, { key: 'grime', type: 'float', default: 1 }, { key: 'grimeColor', type: 'color', default: '#3b3328' }],
      graph: {
        nodes: [
          { id: 'output', type: 'pbr', position: [0, 0] },
          { id: 'layerWeights', type: 'layerWeights', position: [0, 0] },
          { id: 'tint', type: 'parameter', position: [0, 0], data: { key: 'tint' } },
          { id: 'grime', type: 'parameter', position: [0, 0], data: { key: 'grime' } },
          { id: 'grimeColor', type: 'parameter', position: [0, 0], data: { key: 'grimeColor' } },
          { id: 'grimeScaled', type: 'multiply', position: [0, 0] },
          { id: 'grimeColourMix', type: 'lerp', position: [0, 0] },
        ],
        edges: [
          edge('e1', 'layerWeights', 'grime', 'grimeScaled', 'a'),
          edge('e2', 'grime', 'value', 'grimeScaled', 'b'),
          edge('e3', 'tint', 'value', 'grimeColourMix', 'a'),
          edge('e4', 'grimeColor', 'value', 'grimeColourMix', 'b'),
          edge('e5', 'grimeScaled', 'out', 'grimeColourMix', 't'),
          edge('e6', 'grimeColourMix', 'out', 'output', 'baseColor'),
          edge('e7', 'layerWeights', 'wetness', 'output', 'roughness'),
        ],
      },
    });
    const clean = readFileSync(materialFile('mat-clean'), 'utf8');
    const r = await api(`${tb.authUrl}/api/v1/sessions`, { body: { projectId: ID, sessionId: mkSessionId(), clientInfo: { kind: 'browser', label: 'grime-upgrade' } }, token: tb.adminToken });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const read = (id: string): Record<string, unknown> => (JSON.parse(readFileSync(materialFile(id), 'utf8')) as { data: Record<string, unknown> }).data;
    expect(read('mat-sheet')['params']).toEqual({ roughness: 0.6 });
    // A material without grime keeps what it stored.
    expect(read('mat-clean')).toEqual((JSON.parse(clean) as { data: unknown }).data);
    const walls = read('mat-walls') as { parameters: { key: string }[]; graph: { nodes: { id: string }[]; edges: { from: { node: string; port: string }; to: { node: string; port: string } }[] } };
    expect(walls.parameters.map((p) => p.key)).toEqual(['tint']);
    expect(walls.graph.nodes.map((n) => n.id).sort()).toEqual(['layerWeights', 'output', 'tint']);
    expect(walls.graph.edges.map((e) => `${e.from.node}.${e.from.port}>${e.to.node}.${e.to.port}`).sort()).toEqual(['layerWeights.wetness>output.roughness', 'tint.value>output.baseColor']);
    const problems = await api(`${tb.authUrl}/api/v1/projects/${ID}/problems`, { method: 'GET', token: tb.adminToken, origin: null });
    const lines = (problems.json as { problems: { code: string; message: string }[] }).problems.filter((p) => p.code === 'project_upgraded' && p.message.includes('grime'));
    expect(lines.map((p) => p.message)).toEqual([expect.stringContaining('built-in grime was removed (dirt is a layer of a layered surface, painted like any other): 2 materials had grime set and draw without it now — "Sheet" (mat-sheet), "Walls" (mat-walls)')]);
    // The materials as the backend holds them: valid, and the trim material refuses grime now.
    const q = await api(`${tb.authUrl}/api/v1/projects/${ID}/commands`, { body: { op: 'queryProject', projectId: ID, args: {} }, token: tb.adminToken, origin: null });
    const set = await api(`${tb.authUrl}/api/v1/projects/${ID}/commands`, {
      body: { op: 'setMaterial', projectId: ID, requestId: mkRequestId(), expectedRevision: Number((q.json as { revision: number }).revision), args: { material: { materialId: 'mat-sheet', name: 'Sheet', shader: 'trim', params: { grime: 1 }, textures: {}, trim } }, origin: { kind: 'mcp', clientId: 'grime-upgrade' } },
      token: tb.adminToken,
      origin: null,
    });
    const text = JSON.stringify(set.json);
    expect(text, text).toContain('shader \\"trim\\" has no parameter \\"grime\\"');
  }, 60_000);
});

/**
 * Trim data left in its old places moves at the open, the way a real project
 * held it: a kit model authored with trim data in COLOR_0 (R occlusion,
 * B wetness) on its trim-sheet surface, painted with the old trim meaning
 * (G grime, B wetness) there and with layers on its other surface. Built by
 * one backend through the commands, opened by a new one; a third open finds
 * the upgrade recorded and leaves paint made since (layers 3–4 on G and B) as
 * it is.
 */
describe('a project with trim data in COLOR_0 and old trim paint opened over HTTP', () => {
  const PID = 'demo-0001';
  /** Two surfaces of four vertices each: `sheet` (mapped to a trim material) and `stone`, both with COLOR_0. */
  const kitPiece = (): Uint8Array => {
    const quad = (z: number): number[] => [-1, 0, z, 1, 0, z, 1, 2, z, -1, 2, z];
    const positions = new Float32Array([...quad(0), ...quad(-0.5)]);
    // COLOR_0 as authored for a trim sheet: R occlusion 0.5, G grime 1, B wetness 0.25.
    const colours = new Float32Array(Array.from({ length: 8 }, () => [0.5, 1, 0.25, 1]).flat());
    const index = new Uint16Array([0, 1, 2, 0, 2, 3]);
    const bin = new Uint8Array(positions.byteLength + colours.byteLength + index.byteLength * 2);
    bin.set(new Uint8Array(positions.buffer), 0);
    bin.set(new Uint8Array(colours.buffer), positions.byteLength);
    bin.set(new Uint8Array(index.buffer), positions.byteLength + colours.byteLength);
    bin.set(new Uint8Array(index.buffer), positions.byteLength + colours.byteLength + index.byteLength);
    const P = positions.byteLength, C = colours.byteLength, I = index.byteLength;
    return writeGlb(
      {
        asset: { version: '2.0' },
        buffers: [{ byteLength: bin.byteLength }],
        bufferViews: [
          { buffer: 0, byteOffset: 0, byteLength: P / 2 },
          { buffer: 0, byteOffset: P / 2, byteLength: P / 2 },
          { buffer: 0, byteOffset: P, byteLength: C },
          { buffer: 0, byteOffset: P + C, byteLength: I },
        ],
        accessors: [
          { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [-1, 0, 0], max: [1, 2, 0] },
          { bufferView: 1, componentType: 5126, count: 4, type: 'VEC3', min: [-1, 0, -0.5], max: [1, 2, -0.5] },
          { bufferView: 2, componentType: 5126, count: 8, type: 'VEC4' },
          { bufferView: 3, componentType: 5123, count: 6, type: 'SCALAR' },
        ],
        materials: [{ name: 'sheet' }, { name: 'stone' }],
        meshes: [{ name: 'piece', primitives: [{ attributes: { POSITION: 0, COLOR_0: 2 }, indices: 3, material: 0 }, { attributes: { POSITION: 1, COLOR_0: 2 }, indices: 3, material: 1 }] }],
        nodes: [{ name: 'piece', mesh: 0 }],
        scenes: [{ nodes: [0] }],
        scene: 0,
      },
      bin,
    );
  };
  // The second primitive's COLOR_0 reads the same accessor from the start: its vertices are the first four colours.

  it('reads the model\'s COLOR_0 as trim data and moves the trim paint\'s wetness from B to A; the other surface\'s paint stays', async () => {
    const tb = await startBackend({ tokens: [] });
    let closed = false;
    try {
      type Backend = typeof tb.backend;
      const commands = (backend: Backend, url: string) => async (op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
        const read = backend._test.service.readCapturedV3(PID);
        if (!read.ok) throw new Error(read.error.code);
        const r = await api(`${url}/api/v1/projects/${PID}/commands`, { body: { op, projectId: PID, expectedRevision: read.read.revision, requestId: mkRequestId(), origin: { kind: 'mcp', clientId: 'trim-data-upgrade' }, args }, token: tb.adminToken, origin: null });
        expect(r.status, JSON.stringify(r.json).slice(0, 400)).toBe(200);
        return r.json as Record<string, unknown>;
      };
      const ok = commands(tb.backend, tb.authUrl);
      const glb = kitPiece();
      const stage = (await api(`${tb.authUrl}/api/v1/projects/${PID}/content/stages`, { body: {}, token: tb.adminToken, origin: null })).json as { stageId: string };
      const put = await fetch(`${tb.authUrl}/api/v1/projects/${PID}/content/stages/${stage.stageId}/bytes`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${tb.adminToken}`, 'content-type': 'application/octet-stream', 'x-thirdlight-offset': '0', 'x-thirdlight-total': String(glb.length) },
        body: new Uint8Array(glb),
      });
      expect(put.status).toBe(200);
      const inspected = await api(`${tb.authUrl}/api/v1/projects/${PID}/content/stages/${stage.stageId}/inspect`, { body: {}, token: tb.adminToken, origin: null });
      expect(inspected.status, JSON.stringify(inspected.json).slice(0, 400)).toBe(200);
      const p = (inspected.json as { proposal: Record<string, unknown> }).proposal;
      await ok('publishAsset', { mode: 'create', assetId: 'kit-piece', kind: 'model', displayName: 'Kit piece', sourceDigest: p['sourceDigest'], sourceByteLength: p['sourceByteLength'], importRecipe: p['importRecipe'], metrics: p['metrics'], importedAt: '2026-10-01T00:00:00Z' });
      const trim = { size: [256, 256], texelDensity: 128, padding: 4, rows: [{ slot: 'floor', top: 4, bottom: 124 }] };
      await ok('setMaterial', { material: { materialId: 'mat-sheet', name: 'Sheet', shader: 'trim', params: {}, textures: {}, trim } });
      await ok('setMaterial', { material: { materialId: 'mat-stone', name: 'Stone', shader: 'standard', params: {}, textures: {} } });
      await ok('setAssetOptions', { assetId: 'kit-piece', materials: { sheet: 'mat-sheet', stone: 'mat-stone' } });
      const id = String((await ok('createEntity', { sceneId: 'scene-main', kind: 'model', name: 'Wall piece', model: { asset: { assetId: 'kit-piece' } } }))['createdId']);
      // Paint as the old trim tiles did: G (grime) at half, B (wetness) full; on both surfaces (one stroke reaches every mesh).
      await ok('paintVertices', { entityId: id, dabs: [[0, 1, 0]], brush: { radius: 4, strength: 1, channel: 2 } });
      await ok('paintVertices', { entityId: id, dabs: [[0, 1, 0]], brush: { radius: 4, strength: 0.5, channel: 1 } });
      const paintOf = (backend: Backend = tb.backend): { mesh: string; paint: string }[] => {
        const r = backend._test.service.readCapturedV3(PID);
        if (!r.ok) throw new Error(r.error.code);
        const e = (r.read.scene as { entities: { id: string; components: Record<string, unknown> }[] }).entities.find((x) => x.id === id)!;
        return (e.components['vertexPaint'] as { meshes: { mesh: string; paint: string }[] }).meshes;
      };
      const before = paintOf();
      expect(before.map((m) => m.mesh)).toEqual(['piece#0', 'piece#1']);
      const blob = (digest: string): number[] => [...readFileSync(join(tb.root, 'data', 'projects', PID, 'sources', 'sha256', digest))];
      const old = blob(before[0]!.paint);
      for (let v = 0; v < 4; v++) expect(old[v * 4 + 1]! > 0 && old[v * 4 + 2]! > 0 && old[v * 4 + 3] === 0, String(old.slice(v * 4, v * 4 + 4))).toBe(true);

      // The project as an engine from before the upgrade left it: nothing recorded (this engine recorded it with the first trim material).
      await tb.backend.close();
      closed = true;
      const manifestFile = join(tb.root, 'data', 'projects', PID, 'project.json');
      const manifest = (): Record<string, unknown> => JSON.parse(readFileSync(manifestFile, 'utf8')) as Record<string, unknown>;
      expect(manifest()['upgrades']).toEqual(['trim-data']);
      const { upgrades: _recorded, ...older } = manifest();
      writeFileSync(manifestFile, `${JSON.stringify(older, null, 2)}\n`);
      // The same data root, a new backend: its first read of the project opens (and upgrades) it.
      const reopen = async (): Promise<{ backend: Backend; url: string; teardown: () => Promise<void> }> => {
        const b = await createTestBackend({ authoringOrigin: AUTHORING_ORIGIN, previewOrigin: PREVIEW_ORIGIN, authoringOrigins: [AUTHORING_ORIGIN], tokens: [{ token: tb.adminToken, scope: 'admin' }], dataRoot: join(tb.root, 'data') });
        const url = `http://127.0.0.1:${b.backend.portAuthoring}`;
        const s = await api(`${url}/api/v1/sessions`, { body: { projectId: PID, sessionId: mkSessionId(), clientInfo: { kind: 'browser', label: 'trim-data-upgrade' } }, token: tb.adminToken });
        expect(s.status, JSON.stringify(s.json).slice(0, 400)).toBe(200);
        return { backend: b.backend, url, teardown: () => b.teardown() };
      };
      const second = await reopen();
      let secondOpen = true;
      try {
        const url = second.url;
        const r = second.backend._test.service.readCapturedV3(PID);
        if (!r.ok) throw new Error(r.error.code);
        const asset = (r.read.content as { assets: { assetId: string; vertexColors?: string }[] }).assets.find((a) => a.assetId === 'kit-piece')!;
        expect(asset.vertexColors).toBe('trim');
        const e = (r.read.scene as { entities: { id: string; components: Record<string, unknown> }[] }).entities.find((x) => x.id === id)!;
        const after = (e.components['vertexPaint'] as { meshes: { mesh: string; paint: string }[] }).meshes;
        // The trim surface: wetness on A, nothing on G or B. The stone surface keeps its layers as painted.
        expect(after[0]!.paint).not.toBe(before[0]!.paint);
        const sheet = blob(after[0]!.paint);
        for (let v = 0; v < 4; v++) expect(sheet.slice(v * 4, v * 4 + 4)).toEqual([old[v * 4]!, 0, 0, old[v * 4 + 2]!]);
        expect(after[1]!.paint).toBe(before[1]!.paint);
        // The model file is the game's and stays as it was (the renderer moves its COLOR_0 as it loads).
        const file = readdirSync(join(tb.root, 'data', 'projects', PID), { recursive: true }).map(String).find((f) => f.endsWith('.glb'));
        if (file !== undefined) expect(readFileSync(join(tb.root, 'data', 'projects', PID, file)).includes(Buffer.from(TRIM_DATA_GLTF_ATTRIBUTE))).toBe(false);
        const problems = await api(`${url}/api/v1/projects/${PID}/problems`, { method: 'GET', token: tb.adminToken, origin: null });
        const lines = (problems.json as { problems: { code: string; message: string }[] }).problems.filter((x) => x.code === 'project_upgraded').map((x) => x.message);
        expect(lines).toEqual(expect.arrayContaining([
          expect.stringContaining('1 model mapped to a trim material read its COLOR_0 as trim data now'),
          expect.stringContaining('1 painted trim surface had its wetness moved from B to A'),
        ]));
        // Recorded with the moved data.
        expect(manifest()['upgrades']).toEqual(['trim-data']);

        // Paint made after the upgrade, layers 3 and 4 (G and B) on both surfaces, the trim one included (a mapping can change).
        const paint = commands(second.backend, url);
        await paint('paintVertices', { entityId: id, dabs: [[0, 1, 0]], brush: { radius: 4, strength: 0.75, channel: 1 } });
        await paint('paintVertices', { entityId: id, dabs: [[0, 1, 0]], brush: { radius: 4, strength: 0.5, channel: 2 } });
        const painted = paintOf(second.backend);
        const layers = blob(painted[0]!.paint);
        for (let v = 0; v < 4; v++) expect(layers[v * 4 + 1]! > 0 && layers[v * 4 + 2]! > 0, String(layers.slice(v * 4, v * 4 + 4))).toBe(true);
        await second.teardown();
        secondOpen = false;

        // The next open (and the one after it) leaves that paint and every record as they are.
        for (let i = 0; i < 2; i++) {
          const next = await reopen();
          try {
            expect(paintOf(next.backend)).toEqual(painted);
            expect(blob(paintOf(next.backend)[0]!.paint)).toEqual(layers);
            const again = await api(`${next.url}/api/v1/projects/${PID}/problems`, { method: 'GET', token: tb.adminToken, origin: null });
            expect((again.json as { problems: { code: string; message: string }[] }).problems.filter((x) => x.code === 'project_upgraded' && /trim/.test(x.message))).toEqual([]);
          } finally {
            await next.teardown();
          }
        }
      } finally {
        if (secondOpen) await second.teardown();
      }
    } finally {
      if (closed) rmSync(tb.root, { recursive: true, force: true });
      else await tb.teardown();
    }
  }, 120_000);
});
