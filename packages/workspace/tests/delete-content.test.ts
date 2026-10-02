/**
 * Phase 25.7c/e on the real filesystem (storage v4): `deleteAsset` and
 * `deletePrefab` are refused while anything references the record — an
 * object in any scene, a prefab copy, a script library's string literal —
 * and otherwise remove it in one undoable step (the bytes stay); the audio
 * catalog holds 64 sound effects; `createEntity` takes the hierarchy flags
 * and tags and `createEntities` is one revision and one undo.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openWorkspaceService, type MutationResult, type WorkspaceService } from '@thirdlight/workspace';

import { REPO_ROOT, fileBytes, makeRoot, seedV3Project, sha256Hex } from './helpers';

const CONTRACTS = join(REPO_ROOT, 'fixtures', 'm3', 'contracts');
const MEDIA = join(CONTRACTS, 'envelope', 'valid', 'demo-0003-media-v3.json');
const PROJECT_ID = 'demo-0003';
const MODEL = 'asset-model-courier';
const AUDIO = 'asset-audio-cue-start';
const COURIER_BYTES = fileBytes(join(CONTRACTS, 'source-preimages', 'courier.glb'));
const WAV_BYTES = fileBytes(join(CONTRACTS, 'source-preimages', 'cue-start.wav'));
const COURIER = sha256Hex(COURIER_BYTES);
const WAV = sha256Hex(WAV_BYTES);

function setup(tag: string): { dir: string; root: string; svc: WorkspaceService } {
  const root = makeRoot(tag);
  const dir = seedV3Project(root, PROJECT_ID, fileBytes(MEDIA));
  mkdirSync(join(dir, 'sources', 'sha256'), { recursive: true });
  writeFileSync(join(dir, 'sources', 'sha256', COURIER), COURIER_BYTES);
  writeFileSync(join(dir, 'sources', 'sha256', WAV), WAV_BYTES);
  return { dir, root, svc: openWorkspaceService({ root, now: () => Date.now() }) };
}

let n = 0;
function send(svc: WorkspaceService, op: string, args: Record<string, unknown>): MutationResult {
  n += 1;
  const q = svc.query({ op: 'queryProject', projectId: PROJECT_ID }) as { revision: number };
  return svc.runCommand({ op, projectId: PROJECT_ID, expectedRevision: q.revision, requestId: `req-${(0xd7c00 + n).toString(16).padStart(32, '0')}`, origin: { kind: 'mcp', clientId: 'delete-content' }, args }) as MutationResult;
}
function ok(svc: WorkspaceService, op: string, args: Record<string, unknown>): MutationResult & { ok: true; createdId?: string; revision: number; change: Record<string, unknown> } {
  const r = send(svc, op, args);
  expect(r.ok, JSON.stringify(r).slice(0, 600)).toBe(true);
  return r as MutationResult & { ok: true; createdId?: string; revision: number; change: Record<string, unknown> };
}
function refused(svc: WorkspaceService, op: string, args: Record<string, unknown>): { code: string; message: string; details?: { path?: string; sceneId?: string }[]; detailCount?: number } {
  const r = send(svc, op, args) as unknown as { ok: boolean; error: { code: string; message: string; details?: { path?: string; sceneId?: string }[]; detailCount?: number } };
  expect(r.ok, JSON.stringify(r).slice(0, 400)).toBe(false);
  return r.error;
}
const assetIds = (svc: WorkspaceService): string[] =>
  ((svc.query({ op: 'queryAssets', projectId: PROJECT_ID, args: { limit: 128, offset: 0 } }) as { assets: { assetId: string }[] }).assets ?? []).map((a) => a.assetId);
const prefabIds = (svc: WorkspaceService): string[] =>
  ((svc.query({ op: 'queryPrefabs', projectId: PROJECT_ID, args: { limit: 128, offset: 0 } }) as { prefabs: { prefabId: string }[] }).prefabs ?? []).map((p) => p.prefabId);
const revision = (svc: WorkspaceService): number => (svc.query({ op: 'queryProject', projectId: PROJECT_ID }) as { revision: number }).revision;

describe('deleteAsset / deletePrefab (phase 25.7c)', () => {
  it('refuses an asset while an object in any scene uses it; removes it otherwise, undo and redo, bytes kept', () => {
    const { dir, svc } = setup('delete-asset');
    expect(assetIds(svc)).toEqual([AUDIO, MODEL]);
    // The model is placed in the main scene.
    const inUse = refused(svc, 'deleteAsset', { assetId: MODEL });
    expect(inUse.code).toBe('reference_in_use');
    expect(inUse.message).toContain(`asset "${MODEL}" is still used`);
    expect(inUse.details?.some((d) => /\/components\/model\/asset\/assetId$/.test(d.path ?? ''))).toBe(true);

    // A sound played by an object in another scene.
    ok(svc, 'createScene', { sceneId: 'scene-b', name: 'B' });
    const src = ok(svc, 'createEntity', { sceneId: 'scene-b', kind: 'group', name: 'hum', components: { audioSource: { assetId: AUDIO, volume: 0.8, range: 12 } } });
    const other = refused(svc, 'deleteAsset', { assetId: AUDIO });
    expect(other.code).toBe('reference_in_use');
    expect(other.details?.[0]?.sceneId).toBe('scene-b');
    expect(other.message).toContain('scene scene-b');

    ok(svc, 'deleteEntity', { entityId: src.createdId! });
    const before = revision(svc);
    const del = ok(svc, 'deleteAsset', { assetId: AUDIO });
    expect(del.revision).toBe(before + 1);
    expect(del.change).toMatchObject({ type: 'removeAsset', assetId: AUDIO });
    expect(assetIds(svc)).toEqual([MODEL]);
    // The stored bytes stay (unreferenced blobs are kept), so undo brings the record back as it was.
    expect(existsSync(join(dir, 'sources', 'sha256', WAV))).toBe(true);
    const undone = ok(svc, 'undo', {});
    expect(undone.change).toMatchObject({ type: 'publishAsset', mode: 'create', assetId: AUDIO, previous: null });
    expect(assetIds(svc)).toEqual([AUDIO, MODEL]);
    ok(svc, 'redo', {});
    expect(assetIds(svc)).toEqual([MODEL]);
    // Persisted: content.json holds the catalog without it.
    expect((JSON.parse(readFileSync(join(dir, 'content.json'), 'utf8')) as { content: { assets: { assetId: string }[] } }).content.assets.map((a) => a.assetId)).toEqual([MODEL]);
    // Unknown ids and wrong args are refused.
    expect(refused(svc, 'deleteAsset', { assetId: AUDIO }).code).toBe('field_value');
    expect(refused(svc, 'deleteAsset', { assetId: 3 }).code).toBe('field_type');
    expect(refused(svc, 'deleteAsset', { assetId: MODEL, extra: 1 }).code).toBe('field_unexpected');
    svc.dispose();
  });

  it('refuses a prefab while a copy or a script literal names it; removes it otherwise, undo restores the definition', () => {
    const { svc } = setup('delete-prefab');
    ok(svc, 'createPrefab', { prefabId: 'crate', displayName: 'Crate', sourceEntityId: 'box-0001' });
    const copy = ok(svc, 'instantiatePrefab', { sceneId: 'scene-main', prefabId: 'crate' });
    const byCopy = refused(svc, 'deletePrefab', { prefabId: 'crate' });
    expect(byCopy.code).toBe('reference_in_use');
    expect(byCopy.details?.some((d) => /\/components\/prefab$/.test(d.path ?? ''))).toBe(true);
    ok(svc, 'deleteEntity', { entityId: (copy.change as { rootId: string }).rootId });

    // A script library that spawns it by name.
    ok(svc, 'setScriptLibrary', { libraryId: 'spawner', name: 'Spawner', files: [{ path: 'src/index.ts', text: "export const drop = (ctx: { spawn(id: string, o: unknown): unknown }) => ctx.spawn('crate', { position: [0, 0, 0] });\n" }] });
    const byScript = refused(svc, 'deletePrefab', { prefabId: 'crate' });
    expect(byScript.code).toBe('reference_in_use');
    expect(byScript.message).toContain('library spawner');
    ok(svc, 'setScriptLibrary', { libraryId: 'spawner', files: [{ path: 'src/index.ts', text: 'export const drop = 1;\n' }] });

    const del = ok(svc, 'deletePrefab', { prefabId: 'crate' });
    expect(del.change).toEqual({ type: 'removePrefab', prefabId: 'crate' });
    expect(prefabIds(svc)).toEqual([]);
    const undone = ok(svc, 'undo', {});
    expect(undone.change).toMatchObject({ type: 'createPrefab', prefabId: 'crate' });
    expect(prefabIds(svc)).toEqual(['crate']);
    ok(svc, 'redo', {});
    expect(prefabIds(svc)).toEqual([]);
    svc.dispose();
  });

  it('the catalog holds as many sound effects as the game needs (64 was a cap)', () => {
    const { svc } = setup('audio-cap');
    const env = JSON.parse(readFileSync(MEDIA, 'utf8')) as { content: { assets: { assetId: string; versions: { importRecipe: unknown; metrics: unknown }[] }[] } };
    const v = env.content.assets.find((a) => a.assetId === AUDIO)!.versions[0]!;
    const publish = (i: number) =>
      send(svc, 'publishAsset', { mode: 'create', kind: 'audio', assetId: `sfx-${i}`, displayName: `sfx ${i}`, sourceDigest: WAV, sourceByteLength: WAV_BYTES.length, importRecipe: v.importRecipe, metrics: v.metrics, importedAt: '2026-09-28T12:00:00Z' });
    // The fixture already has one audio asset: 95 more make 96.
    for (let i = 0; i < 95; i += 1) expect(publish(i).ok).toBe(true);
    svc.dispose();
  }, 60_000);
});

describe('bulk building (phase 25.7e)', () => {
  it('createEntity takes static, active, locked and tags', () => {
    const { svc } = setup('create-flags');
    ok(svc, 'setTags', { tags: [{ name: 'wall' }, { name: 'loot' }] });
    const r = ok(svc, 'createEntity', { sceneId: 'scene-main', kind: 'box', name: 'Wall', static: true, locked: true, active: false, tags: ['wall', 'loot'] });
    const e = (svc.query({ op: 'queryEntity', projectId: PROJECT_ID, args: { entityId: r.createdId } }) as { entity: Record<string, unknown> }).entity;
    expect(e).toMatchObject({ static: true, locked: true, active: false, tags: 3 });
    expect(refused(svc, 'createEntity', { sceneId: 'scene-main', kind: 'box', tags: ['nope'] }).code).toBe('field_value');
    expect(refused(svc, 'createEntity', { sceneId: 'scene-main', kind: 'box', static: 'yes' }).code).toBe('field_type');
    svc.dispose();
  });

  it('createEntities is one revision and one undo; refs name earlier items as parents', () => {
    const { svc } = setup('create-many');
    ok(svc, 'setTags', { tags: [{ name: 'tree' }] });
    const before = revision(svc);
    const entitiesBefore = (svc.query({ op: 'queryProject', projectId: PROJECT_ID }) as { entityCount?: number; counts?: { entities?: number } });
    const items: Record<string, unknown>[] = [{ kind: 'folder', name: 'Forest', ref: 'forest' }];
    for (let i = 0; i < 40; i += 1) items.push({ kind: 'box', parentId: 'forest', name: `tree ${i}`, static: true, tags: ['tree'], transform: { position: [i, 0, 0] } });
    const r = ok(svc, 'createEntities', { sceneId: 'scene-main', entities: items });
    expect(r.revision).toBe(before + 1);
    const created = (r.change as { type: string; entities: { id: string; parentId?: string; static?: boolean; tags?: number; name?: string }[] });
    expect(created.type).toBe('pasteEntities');
    expect(created.entities).toHaveLength(41);
    const folderId = created.entities[0]!.id;
    expect(r.createdId).toBe(folderId);
    expect(folderId).toMatch(/^folder-\d{6}$/);
    expect(created.entities.slice(1).every((e) => e.parentId === folderId && e.static === true && e.tags === 1)).toBe(true);
    expect(new Set(created.entities.map((e) => e.id)).size).toBe(41);
    // One undo removes all of them; one redo brings them back with the same ids.
    ok(svc, 'undo', {});
    expect(revision(svc)).toBe(before + 2);
    expect(send(svc, 'queryEntity', { entityId: folderId }).ok).not.toBe(true);
    const redone = ok(svc, 'redo', {});
    expect((redone.change as { entities: { id: string }[] }).entities.map((e) => e.id)).toEqual(created.entities.map((e) => e.id));
    // All or nothing: one bad item refuses the whole batch at its path.
    const bad = refused(svc, 'createEntities', { sceneId: 'scene-main', entities: [{ kind: 'box' }, { kind: 'box', tags: ['nope'] }] }) as { code: string; path?: string };
    expect(bad.code).toBe('field_value');
    expect((bad as { path?: string }).path).toBe('/args/entities/1/tags/0');
    expect(refused(svc, 'createEntities', { sceneId: 'scene-main', entities: [{ kind: 'box', ref: 'a' }, { kind: 'box', ref: 'a' }] }).code).toBe('field_value');
    expect(refused(svc, 'createEntities', { sceneId: 'scene-main', entities: [] }).code).toBe('field_value');
    // There is no default scene: items without a parent need the scene named.
    expect(refused(svc, 'createEntities', { entities: [{ kind: 'box' }] })).toMatchObject({ code: 'field_missing', path: '/args/sceneId' });
    void entitiesBefore;
    svc.dispose();
  });
});
