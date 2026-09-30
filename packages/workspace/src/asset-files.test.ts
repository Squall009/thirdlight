/**
 * The asset database on disk, through the real service and filesystem:
 * uploaded bytes are filed into the game folder at commit with a `.tlasset`
 * sidecar; a re-import over the file, a delete and a move are undoable (the
 * held bytes come back); a file moved outside the editor together with its
 * sidecar is found by id and keeps every reference; a missing sidecar is
 * written by the file check. The inspector is the injected seam (a stub).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { openWorkspaceService } from './service';
import type { StageInspector, WorkspaceService } from './index';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function temp(tag: string): string {
  const dir = join(tmpdir(), `tl-assetfiles-${tag}-${process.pid}-${Date.now().toString(36)}-${roots.length}`);
  mkdirSync(dir, { recursive: true });
  roots.push(dir);
  return dir;
}

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);
const V1 = bytesOf('glTF the first crate');
const V2 = bytesOf('glTF the crate, rebuilt with more detail');

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

let seq = 0;
function command(service: WorkspaceService, projectId: string, op: string, args: Record<string, unknown>) {
  const q = service.query({ op: 'queryEntities', projectId, args: { limit: 1, offset: 0 } }) as unknown as { revision: number };
  seq += 1;
  return service.runCommand({ op, projectId, expectedRevision: q.revision, requestId: `req-${seq.toString(16).padStart(32, '0')}`, args });
}

/** A publish of uploaded bytes: no path (the workspace files them). */
function upload(mode: 'create' | 'reimport', bytes: Uint8Array): Record<string, unknown> {
  return {
    mode,
    assetId: 'crate',
    ...(mode === 'create' ? { kind: 'model', displayName: 'Wooden Crate' } : {}),
    sourceDigest: sha(bytes),
    sourceByteLength: bytes.length,
    importRecipe: RECIPE,
    metrics: METRICS,
    importedAt: '2026-09-29T10:00:00Z',
  };
}

function record(service: WorkspaceService, projectId: string): { currentVersion: number; versions: { version: number; sourcePath?: string }[] } | undefined {
  const q = service.query({ op: 'queryAssets', projectId, args: { includeVersions: true, limit: 10, offset: 0 } }) as unknown as { assets: { assetId: string; currentVersion: number; versions: { version: number; sourcePath?: string }[] }[] };
  return q.assets.find((a) => a.assetId === 'crate');
}

function folderProject(tag: string): { service: WorkspaceService; game: string } {
  const base = temp(tag);
  const service = openWorkspaceService({ root: join(base, 'data'), assetInspector: stubInspector });
  const game = join(base, 'game');
  expect(service.createProjectInFolder(game, 'game', 'Game').ok).toBe(true);
  return { service, game };
}

describe('asset files in the game folder', () => {
  it('files an upload into assets/ at commit, with a sidecar naming its id and kind; the record keeps the path', () => {
    const { service, game } = folderProject('upload');
    try {
      expect(service.holdAssetBytes('game', V1).ok).toBe(true);
      const r = command(service, 'game', 'publishAsset', upload('create', V1));
      expect(r.ok, JSON.stringify(r)).toBe(true);
      const file = join(game, 'assets', 'Wooden-Crate.glb');
      expect(readFileSync(file)).toEqual(Buffer.from(V1));
      const sidecar = JSON.parse(readFileSync(`${file}.tlasset`, 'utf8')) as Record<string, unknown>;
      expect(sidecar).toMatchObject({ tlasset: 3, id: 'crate', kind: 'model', labels: [], address: null });
      expect(record(service, 'game')?.versions).toMatchObject([{ version: 1, sourcePath: 'assets/Wooden-Crate.glb' }]);
      // The change carries the chosen path (so history and a retry record it too).
      expect(r.ok && JSON.stringify(r.change)).toContain('assets/Wooden-Crate.glb');
      // Nothing went to the blob store; the import cache is ignored by git.
      expect(existsSync(join(game, 'thirdlight', 'sources', 'sha256'))).toBe(false);
      expect(readFileSync(join(game, 'thirdlight', '.gitignore'), 'utf8')).toMatch(/^cache\/$/m);
    } finally {
      service.dispose();
    }
  });

  it('a re-import from an upload replaces the file; undo puts the old bytes back, redo the new ones', () => {
    const { service, game } = folderProject('replace');
    try {
      service.holdAssetBytes('game', V1);
      expect(command(service, 'game', 'publishAsset', upload('create', V1)).ok).toBe(true);
      service.holdAssetBytes('game', V2);
      const re = command(service, 'game', 'publishAsset', upload('reimport', V2));
      expect(re.ok, JSON.stringify(re)).toBe(true);
      const file = join(game, 'assets', 'Wooden-Crate.glb');
      expect(readFileSync(file)).toEqual(Buffer.from(V2));
      expect(record(service, 'game')).toMatchObject({ currentVersion: 2, versions: [{ version: 2, sourcePath: 'assets/Wooden-Crate.glb' }] });
      expect(command(service, 'game', 'undo', {}).ok).toBe(true);
      expect(readFileSync(file)).toEqual(Buffer.from(V1));
      expect(service.readBlob('game', { assetId: 'crate', version: 1 }).ok).toBe(true);
      expect(command(service, 'game', 'redo', {}).ok).toBe(true);
      expect(readFileSync(file)).toEqual(Buffer.from(V2));
    } finally {
      service.dispose();
    }
  });

  it('deleteAsset deletes the file and its sidecar; undo brings both back', () => {
    const { service, game } = folderProject('delete');
    try {
      service.holdAssetBytes('game', V1);
      expect(command(service, 'game', 'publishAsset', upload('create', V1)).ok).toBe(true);
      const file = join(game, 'assets', 'Wooden-Crate.glb');
      expect(command(service, 'game', 'deleteAsset', { assetId: 'crate' }).ok).toBe(true);
      expect(existsSync(file)).toBe(false);
      expect(existsSync(`${file}.tlasset`)).toBe(false);
      expect(command(service, 'game', 'undo', {}).ok).toBe(true);
      expect(readFileSync(file)).toEqual(Buffer.from(V1));
      expect(JSON.parse(readFileSync(`${file}.tlasset`, 'utf8'))).toMatchObject({ id: 'crate' });
    } finally {
      service.dispose();
    }
  });

  it('an undone import forgets the asset (its sidecar) but leaves the file', () => {
    const { service, game } = folderProject('undo-import');
    try {
      mkdirSync(join(game, 'art'), { recursive: true });
      writeFileSync(join(game, 'art', 'crate.glb'), V1);
      const args = { ...upload('create', V1), sourcePath: 'art/crate.glb' };
      expect(command(service, 'game', 'publishAsset', args).ok).toBe(true);
      expect(existsSync(join(game, 'art', 'crate.glb.tlasset'))).toBe(true);
      expect(command(service, 'game', 'undo', {}).ok).toBe(true);
      expect(existsSync(join(game, 'art', 'crate.glb'))).toBe(true);
      expect(existsSync(join(game, 'art', 'crate.glb.tlasset'))).toBe(false);
    } finally {
      service.dispose();
    }
  });

  it('setAssetOptions {sourcePath} moves the file with its sidecar; the id and the references stay', () => {
    const { service, game } = folderProject('move');
    try {
      service.holdAssetBytes('game', V1);
      expect(command(service, 'game', 'publishAsset', upload('create', V1)).ok).toBe(true);
      expect(command(service, 'game', 'createEntity', { kind: 'model', name: 'Crate', model: { asset: { assetId: 'crate' } } }).ok).toBe(true);
      const moved = command(service, 'game', 'setAssetOptions', { assetId: 'crate', sourcePath: 'assets/props/crate.glb' });
      expect(moved.ok, JSON.stringify(moved)).toBe(true);
      expect(existsSync(join(game, 'assets', 'Wooden-Crate.glb'))).toBe(false);
      expect(existsSync(join(game, 'assets', 'Wooden-Crate.glb.tlasset'))).toBe(false);
      expect(readFileSync(join(game, 'assets', 'props', 'crate.glb'))).toEqual(Buffer.from(V1));
      expect(JSON.parse(readFileSync(join(game, 'assets', 'props', 'crate.glb.tlasset'), 'utf8'))).toMatchObject({ id: 'crate' });
      expect(service.readBlob('game', { assetId: 'crate', version: 1 }).ok).toBe(true);
      // One undo moves it back.
      expect(command(service, 'game', 'undo', {}).ok).toBe(true);
      expect(readFileSync(join(game, 'assets', 'Wooden-Crate.glb'))).toEqual(Buffer.from(V1));
      expect(existsSync(join(game, 'assets', 'props', 'crate.glb.tlasset'))).toBe(false);
    } finally {
      service.dispose();
    }
  });

  it('a file moved outside the editor with its sidecar is found by id; a missing sidecar is written by the check', () => {
    const { service, game } = folderProject('outside');
    try {
      service.holdAssetBytes('game', V1);
      expect(command(service, 'game', 'publishAsset', upload('create', V1)).ok).toBe(true);
      const from = join(game, 'assets', 'Wooden-Crate.glb');
      mkdirSync(join(game, 'levels', 'one'), { recursive: true });
      renameSync(from, join(game, 'levels', 'one', 'box.glb'));
      renameSync(`${from}.tlasset`, join(game, 'levels', 'one', 'box.glb.tlasset'));
      const files = service.assetFiles('game');
      expect(files.ok && files.entries).toMatchObject([{ assetId: 'crate', status: 'missing', file: 'assets/Wooden-Crate.glb' }]);
      const found = service.findMovedAssets('game', ['crate']);
      expect(found.ok && found.found).toEqual({ crate: 'levels/one/box.glb' });
      expect(command(service, 'game', 'setAssetOptions', { assetId: 'crate', sourcePath: 'levels/one/box.glb' }).ok).toBe(true);
      expect(service.readBlob('game', { assetId: 'crate', version: 1 }).ok).toBe(true);
      // A sidecar deleted by hand is written again by the check.
      unlinkSync(join(game, 'levels', 'one', 'box.glb.tlasset'));
      const again = service.assetFiles('game');
      expect(again.ok && again.entries[0]).toMatchObject({ status: 'ok', file: 'levels/one/box.glb' });
      expect(JSON.parse(readFileSync(join(game, 'levels', 'one', 'box.glb.tlasset'), 'utf8'))).toMatchObject({ id: 'crate', kind: 'model' });
      // A changed file shows as changed, with the digest it has now.
      writeFileSync(join(game, 'levels', 'one', 'box.glb'), V2);
      const changed = service.assetFiles('game');
      expect(changed.ok && changed.entries[0]).toMatchObject({ status: 'changed', digest: sha(V1), foundDigest: sha(V2) });
    } finally {
      service.dispose();
    }
  });

  it('a data-root project files uploads into its own folder the same way', () => {
    const base = temp('data-root');
    const service = openWorkspaceService({ root: base, assetInspector: stubInspector });
    try {
      expect(service.createProject('demo', 'Demo').ok).toBe(true);
      service.holdAssetBytes('demo', V1);
      expect(command(service, 'demo', 'publishAsset', upload('create', V1)).ok).toBe(true);
      const file = join(base, 'projects', 'demo', 'assets', 'Wooden-Crate.glb');
      expect(readFileSync(file)).toEqual(Buffer.from(V1));
      expect(existsSync(`${file}.tlasset`)).toBe(true);
    } finally {
      service.dispose();
    }
  });
});
