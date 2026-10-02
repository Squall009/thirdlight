/**
 * Scenes and resources in folders the user chooses, files changed in the game
 * folder while the project is open, and lost sidecars, through the real
 * service and filesystem:
 *
 * - a create names a folder (`folder`), vetted like an upload folder; a scene
 *   there is `<folder>/<id>.scene.json`, found by its id wherever it is moved;
 *   undo and redo put it back where it was;
 * - the file check follows a moved file without a revision, takes in an added
 *   or copied file (a copy gets a new id; a copied scene's objects new ids),
 *   reloads a changed resource file, drops a removed one, all as one
 *   `importResources` (one undo), and pauses on what it cannot take in;
 * - the poll no longer pauses on a game-folder file;
 * - a sidecar lost while the project is closed is put back at the open (from
 *   the record cache, else from a file named for its id).
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { openWorkspaceService } from './service';
import type { StageInspector, WorkspaceService } from './index';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const CRATE = new TextEncoder().encode('glTF a crate');
const RECIPE = { profile: 'gltf-glb', recipeVersion: 1, toolchain: { three: '0.186.0' }, extensions: [] };
const METRICS = { nodes: 1, meshes: 1, primitives: 1, materials: 1, images: 0, textures: 0, vertices: 3, triangles: 1, animations: 0, animationChannels: 0, clipDurationMs: 0, decodedGeometryBytes: 36, decodedImageBytes: 0 };
const stubInspector: StageInspector = (bytes, job) =>
  ({
    status: 'ok',
    kind: 'model',
    proposalId: job.proposalId(),
    stageId: job.stageId(),
    expiresAt: job.expiresAt(),
    sourceDigest: sha(bytes),
    sourceByteLength: bytes.length,
    importRecipe: RECIPE,
    metrics: METRICS,
    diagnostics: [],
    diagnosticCount: 0,
    suggestedDisplayName: 'asset',
    inspection: { nodeNames: [], materialNames: [], clipNames: [], sceneCount: 1, truncated: false },
  }) as unknown as ReturnType<StageInspector>;

const PID = 'demo';
let seq = 0;

function project(tag: string): { dir: string; open: () => WorkspaceService } {
  const root = join(tmpdir(), `tl-resfolders-${tag}-${process.pid}-${Date.now().toString(36)}-${roots.length}`);
  mkdirSync(root, { recursive: true });
  roots.push(root);
  const open = (): WorkspaceService => openWorkspaceService({ root, assetInspector: stubInspector });
  const s = open();
  expect(s.createProject(PID, 'Demo').ok).toBe(true);
  s.close();
  return { dir: join(root, 'projects', PID), open };
}

function revision(s: WorkspaceService): number {
  return (s.query({ op: 'queryProject', projectId: PID }) as unknown as { revision: number }).revision;
}
function run(s: WorkspaceService, op: string, args: Record<string, unknown>): { ok: boolean; error?: { code: string; message?: string }; change?: Record<string, unknown> } {
  seq += 1;
  return s.runCommand({ op, projectId: PID, expectedRevision: revision(s), requestId: `req-${(0xa000 + seq).toString(16).padStart(32, '0')}`, args }) as unknown as { ok: boolean; error?: { code: string; message?: string }; change?: Record<string, unknown> };
}
function ok(s: WorkspaceService, op: string, args: Record<string, unknown>): Record<string, unknown> {
  const r = run(s, op, args);
  expect(r.ok, JSON.stringify(r).slice(0, 600)).toBe(true);
  return r as Record<string, unknown>;
}
const json = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
const mat = (id: string, color: string): Record<string, unknown> => ({ materialId: id, name: id, shader: 'standard', params: { color }, textures: {} });
function scenesOf(s: WorkspaceService): { sceneId: string; name: string }[] {
  return (s.query({ op: 'queryProject', projectId: PID }) as unknown as { scenes: { sceneId: string; name: string }[] }).scenes;
}
function indexPath(s: WorkspaceService, kind: string, id: string): string | undefined {
  const q = s.query({ op: 'queryIndex', projectId: PID, args: { kind, id } }) as unknown as { entries: { path: string }[] };
  return q.entries[0]?.path;
}
function check(s: WorkspaceService): { prepared: boolean; report: { followed: unknown[]; adopted: { kind: string; id: string; path: string; copyOf?: string }[]; reloaded: unknown[]; removed: unknown[]; problems: { path: string; message: string }[]; paused: string | null } } {
  const r = s.checkResourceFiles(PID);
  expect(r.ok, JSON.stringify(r)).toBe(true);
  return r as never;
}
function paused(s: WorkspaceService): boolean {
  const q = s.query({ op: 'queryProject', projectId: PID }) as unknown as { workspace?: { pendingChange?: unknown } };
  return q.workspace?.pendingChange != null;
}

describe('scenes and resources in the folders the user chooses', () => {
  it('writes a scene created in a folder there, edits it there, and finds it by id after a move', () => {
    const { dir, open } = project('scene-folder');
    let s = open();
    try {
      ok(s, 'createScene', { name: 'Level 1', sceneId: 'level-1', folder: 'levels' });
      const file = join(dir, 'levels', 'level-1.scene.json');
      expect(json(file)).toMatchObject({ type: 'scene', scene: { sceneId: 'level-1' } });
      expect(existsSync(join(dir, 'scenes', 'level-1.json'))).toBe(false);
      ok(s, 'createEntity', { kind: 'box', name: 'Crate', sceneId: 'level-1' });
      expect((json(file) as { scene: { entities: { name: string }[] } }).scene.entities.map((e) => e.name)).toEqual(['Crate']);
      expect(indexPath(s, 'scene', 'level-1')).toBe('levels/level-1.scene.json');
      expect(indexPath(s, 'scene', 'scene-main')).toBe('scenes/scene-main.json');
      // A folder that is not one of the game folder is refused like an upload folder.
      for (const bad of ['.hidden', '../out', 'scenes', '']) {
        const r = run(s, 'createScene', { name: 'Bad', folder: bad });
        expect(r.ok, bad).toBe(false);
        expect(r.error?.code, bad).toBe('path_rejected');
      }
    } finally {
      s.close();
    }
    // Moved and renamed while the project is closed: the same scene.
    mkdirSync(join(dir, 'world', 'act-1'), { recursive: true });
    renameSync(join(dir, 'levels', 'level-1.scene.json'), join(dir, 'world', 'act-1', 'First level.scene.json'));
    s = open();
    try {
      expect(scenesOf(s).map((e) => e.sceneId)).toEqual(['scene-main', 'level-1']);
      expect(indexPath(s, 'scene', 'level-1')).toBe('world/act-1/First level.scene.json');
      ok(s, 'createEntity', { kind: 'box', name: 'Barrel', sceneId: 'level-1' });
      const moved = json(join(dir, 'world', 'act-1', 'First level.scene.json')) as { scene: { entities: { name: string }[] } };
      expect(moved.scene.entities.map((e) => e.name)).toEqual(['Crate', 'Barrel']);
    } finally {
      s.close();
    }
  });

  it('puts a created scene or resource back where it was on undo and redo; an edit leaves a resource where it is', () => {
    const { dir, open } = project('undo-folder');
    const s = open();
    try {
      ok(s, 'createScene', { name: 'Cave', sceneId: 'cave', folder: 'levels/under' });
      const file = join(dir, 'levels', 'under', 'cave.scene.json');
      expect(existsSync(file)).toBe(true);
      ok(s, 'undo', {});
      expect(existsSync(file)).toBe(false);
      ok(s, 'redo', {});
      expect(existsSync(file)).toBe(true);
      ok(s, 'setMaterial', { material: mat('stone', '#808080'), folder: 'art/mats' });
      expect(json(join(dir, 'art', 'mats', 'stone.material.json'))).toMatchObject({ id: 'stone' });
      ok(s, 'setMaterial', { material: mat('stone', '#111111'), folder: 'elsewhere' });
      expect(json(join(dir, 'art', 'mats', 'stone.material.json'))).toMatchObject({ data: { params: { color: '#111111' } } });
      expect(existsSync(join(dir, 'elsewhere'))).toBe(false);
      ok(s, 'deleteMaterial', { materialId: 'stone' });
      expect(existsSync(join(dir, 'art', 'mats', 'stone.material.json'))).toBe(false);
      ok(s, 'undo', {});
      expect(json(join(dir, 'art', 'mats', 'stone.material.json'))).toMatchObject({ id: 'stone' });
      // An op that creates nothing takes no folder.
      expect(run(s, 'setSettings', { settings: {}, folder: 'x' }).ok).toBe(false);
    } finally {
      s.close();
    }
  });
});

describe('files changed in the game folder while the project is open', () => {
  it('takes in an added scene file and a copy of a scene (new scene id, new object ids) in one undo', () => {
    const { dir, open } = project('adopt-scene');
    const s = open();
    try {
      ok(s, 'createScene', { name: 'Level 1', sceneId: 'level-1', folder: 'levels' });
      ok(s, 'createEntity', { kind: 'box', name: 'Crate', sceneId: 'level-1' });
      const rev = revision(s);
      const original = join(dir, 'levels', 'level-1.scene.json');
      // A scene from elsewhere (its id unused) and a copy of level-1 made in the file manager.
      const doc = json(original) as { scene: Record<string, unknown> };
      writeFileSync(join(dir, 'levels', 'Arena.scene.json'), JSON.stringify({ ...doc, projectId: 'another', scene: { ...doc.scene, sceneId: 'arena', entities: [] }, retry: { records: [] } }));
      copyFileSync(original, join(dir, 'levels', 'Level 1 copy.scene.json'));
      expect(revision(s)).toBe(rev);
      const c = check(s);
      expect(c.prepared).toBe(true);
      expect(c.report.adopted).toEqual([
        { kind: 'scene', id: 'arena', path: 'levels/Arena.scene.json' },
        { kind: 'scene', id: 'level-1-copy', path: 'levels/Level 1 copy.scene.json', copyOf: 'level-1' },
      ]);
      ok(s, 'importResources', {});
      expect(scenesOf(s)).toEqual([
        { sceneId: 'scene-main', name: 'Main', entityCount: 3 },
        { sceneId: 'level-1', name: 'Level 1', entityCount: 1 },
        { sceneId: 'arena', name: 'Arena', entityCount: 0 },
        { sceneId: 'level-1-copy', name: 'Level 1 copy', entityCount: 1 },
      ]);
      const copy = s.query({ op: 'queryEntities', projectId: PID, args: { sceneId: 'level-1-copy' } }) as unknown as { entities: { id: string; name: string }[] };
      const orig = s.query({ op: 'queryEntities', projectId: PID, args: { sceneId: 'level-1' } }) as unknown as { entities: { id: string }[] };
      expect(copy.entities.map((e) => e.name)).toEqual(['Crate']);
      expect(copy.entities[0]!.id).not.toBe(orig.entities[0]!.id);
      // The copy's file now states its new id, where it is.
      expect(json(join(dir, 'levels', 'Level 1 copy.scene.json'))).toMatchObject({ projectId: PID, scene: { sceneId: 'level-1-copy' } });
      // One undo takes both out (their files go), redo brings them back where they were.
      ok(s, 'undo', {});
      expect(scenesOf(s).map((e) => e.sceneId)).toEqual(['scene-main', 'level-1']);
      expect(existsSync(join(dir, 'levels', 'Arena.scene.json'))).toBe(false);
      ok(s, 'redo', {});
      expect(scenesOf(s).map((e) => e.sceneId)).toEqual(['scene-main', 'level-1', 'arena', 'level-1-copy']);
      expect(json(join(dir, 'levels', 'Arena.scene.json'))).toMatchObject({ scene: { sceneId: 'arena' } });
      // Nothing new: the next check prepares nothing.
      expect(check(s).prepared).toBe(false);
    } finally {
      s.close();
    }
  });

  it('follows moved files without a revision, reloads a changed resource file, drops a removed one, and pauses on one still used', () => {
    const { dir, open } = project('resources');
    const s = open();
    try {
      ok(s, 'setMaterial', { material: mat('stone', '#808080') });
      ok(s, 'setMaterial', { material: mat('grass', '#40a040') });
      ok(s, 'createScene', { name: 'Level 1', sceneId: 'level-1', folder: 'levels' });
      ok(s, 'createEntity', { sceneId: 'scene-main', kind: 'box', name: 'Wall', components: { materials: { '*': 'grass' } } });
      const rev = revision(s);
      // Moves: a material and a scene, renamed into other folders.
      mkdirSync(join(dir, 'art'), { recursive: true });
      renameSync(join(dir, 'assets', 'materials', 'stone.material.json'), join(dir, 'art', 'Stone.material.json'));
      renameSync(join(dir, 'levels', 'level-1.scene.json'), join(dir, 'art', 'L1.scene.json'));
      // The poll leaves game-folder files to the check.
      expect(s.checkExternal(PID)).toEqual({ ok: true, pending: false });
      let c = check(s);
      expect(c.report.followed).toEqual([
        { kind: 'material', id: 'stone', from: 'assets/materials/stone.material.json', to: 'art/Stone.material.json' },
        { kind: 'scene', id: 'level-1', from: 'levels/level-1.scene.json', to: 'art/L1.scene.json' },
      ]);
      expect(c.prepared).toBe(false);
      expect(revision(s)).toBe(rev);
      expect(indexPath(s, 'material', 'stone')).toBe('art/Stone.material.json');
      // A changed file is reloaded; an added one comes in.
      const stonePath = join(dir, 'art', 'Stone.material.json');
      const stone = json(stonePath) as { data: Record<string, unknown> };
      writeFileSync(stonePath, JSON.stringify({ ...stone, data: { ...stone.data, params: { color: '#000000' } } }));
      writeFileSync(join(dir, 'art', 'sand.material.json'), JSON.stringify({ tlresource: 1, kind: 'material', id: 'sand', data: mat('sand', '#c2b280') }));
      c = check(s);
      expect(c.report.reloaded).toEqual([{ kind: 'material', id: 'stone', path: 'art/Stone.material.json' }]);
      expect(c.report.adopted).toEqual([{ kind: 'material', id: 'sand', path: 'art/sand.material.json' }]);
      ok(s, 'importResources', {});
      const mats = (s.query({ op: 'queryGameConfig', projectId: PID }) as unknown as { materials: { materialId: string; params: { color: string } }[] }).materials;
      expect(mats.map((m) => `${m.materialId}:${m.params.color}`)).toEqual(['grass:#40a040', 'sand:#c2b280', 'stone:#000000']);
      // A removed file that nothing uses leaves the project.
      unlinkSync(join(dir, 'art', 'sand.material.json'));
      c = check(s);
      expect(c.report.removed).toEqual([{ kind: 'material', id: 'sand', path: 'art/sand.material.json' }]);
      ok(s, 'importResources', {});
      // An invalid new file is reported and left alone.
      writeFileSync(join(dir, 'art', 'broken.material.json'), '{ not json');
      c = check(s);
      expect(c.prepared).toBe(false);
      expect(c.report.problems.map((p) => p.path)).toEqual(['art/broken.material.json']);
      unlinkSync(join(dir, 'art', 'broken.material.json'));
      // A removed file that a scene still uses pauses the project on it; putting it back resolves it.
      unlinkSync(join(dir, 'assets', 'materials', 'grass.material.json'));
      c = check(s);
      expect(c.report.paused).toBe('assets/materials/grass.material.json');
      expect(paused(s)).toBe(true);
      const discard = s.discardExternalState(PID) as { ok: boolean };
      expect(discard.ok, JSON.stringify(discard)).toBe(true);
      expect(json(join(dir, 'assets', 'materials', 'grass.material.json'))).toMatchObject({ id: 'grass' });
      // A scene file changed outside the editor pauses the project too.
      writeFileSync(join(dir, 'art', 'L1.scene.json'), readFileSync(join(dir, 'art', 'L1.scene.json'), 'utf8').replace('"entities": []', '"entities": [ ]'));
      c = check(s);
      expect(c.report.paused).toBe('art/L1.scene.json');
    } finally {
      s.close();
    }
  });
});

describe('a sidecar lost while the project is closed', () => {
  function withCrate(tag: string): { dir: string; open: () => WorkspaceService; sidecar: string } {
    const p = project(tag);
    const s = p.open();
    try {
      s.holdAssetBytes(PID, CRATE);
      ok(s, 'publishAsset', { mode: 'create', assetId: 'crate', kind: 'model', displayName: 'Crate', sourceDigest: sha(CRATE), sourceByteLength: CRATE.length, importRecipe: RECIPE, metrics: METRICS, importedAt: '2026-09-30T10:00:00Z' });
      ok(s, 'setAssetOptions', { assetId: 'crate', vertexColors: 'tint' });
      ok(s, 'createEntity', { sceneId: 'scene-main', kind: 'model', name: 'Crate', model: { asset: { assetId: 'crate' } } });
    } finally {
      s.close();
    }
    return { ...p, sidecar: join(p.dir, 'assets', 'Crate.glb.tlasset') };
  }

  it('is put back from the record cache, settings and all', () => {
    const { open, sidecar } = withCrate('lost-cached');
    const before = readFileSync(sidecar);
    unlinkSync(sidecar);
    const s = open();
    try {
      expect(revision(s)).toBeGreaterThan(0);
      expect(readFileSync(sidecar)).toEqual(before);
      expect(s.takeOpenProblems(PID).map((p) => p.code)).toEqual(['asset_sidecar_restored']);
    } finally {
      s.close();
    }
  });

  it('is made again from the file named for its id when the cache is gone too (a new import with default settings)', () => {
    const { dir, open, sidecar } = withCrate('lost-rebuilt');
    unlinkSync(sidecar);
    rmSync(join(dir, 'cache'), { recursive: true, force: true });
    const s = open();
    try {
      expect(revision(s)).toBeGreaterThan(0);
      expect(json(sidecar)).toMatchObject({ id: 'crate', record: { assetId: 'crate', versions: [{ sourcePath: 'assets/Crate.glb' }] } });
      expect((json(sidecar) as { record: Record<string, unknown> }).record['vertexColors']).toBeUndefined();
      expect(s.takeOpenProblems(PID).map((p) => p.code)).toEqual(['asset_sidecar_rebuilt']);
    } finally {
      s.close();
    }
  });

  it('fills the record cache after an open that found it empty, so a later loss is covered too', async () => {
    const { dir, open, sidecar } = withCrate('fill-cache');
    rmSync(join(dir, 'cache'), { recursive: true, force: true });
    let s = open();
    try {
      expect(revision(s)).toBeGreaterThan(0);
      await expect.poll(() => existsSync(join(dir, 'cache', 'records', 'crate.tlasset'))).toBe(true);
    } finally {
      s.close();
    }
    const before = readFileSync(sidecar);
    unlinkSync(sidecar);
    s = open();
    try {
      expect(revision(s)).toBeGreaterThan(0);
      expect(readFileSync(sidecar)).toEqual(before);
    } finally {
      s.close();
    }
  });

  it('names the lost id when nothing can put it back', () => {
    const { dir, open, sidecar } = withCrate('lost-gone');
    unlinkSync(sidecar);
    rmSync(join(dir, 'cache'), { recursive: true, force: true });
    renameSync(join(dir, 'assets', 'Crate.glb'), join(dir, 'assets', 'Box.glb'));
    const s = open();
    try {
      const q = s.query({ op: 'queryProject', projectId: PID }) as unknown as { ok: boolean; error?: { details?: { message: string }[] } };
      expect(q.ok).toBe(false);
      expect(q.error?.details?.[0]?.message).toContain('"crate" is used but no asset or resource of the project has it');
    } finally {
      s.close();
    }
  });
});
