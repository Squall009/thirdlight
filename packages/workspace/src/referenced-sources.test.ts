/**
 * Phase 10 option B: asset versions that reference a file in the game folder
 * in place (`sourcePath` + `sourceDigest`) instead of a copied blob.
 *
 * Real service, real filesystem: a folder project is created in a temp game
 * folder outside the data root; files are written, changed, deleted and
 * symlinked on disk. The GLB inspector is the injected seam (workspace holds
 * only its type); a stub stands in for it here — the real inspector runs in
 * the backend integration and e2e tests.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { openWorkspaceService } from './service';
import type { StageInspector, WorkspaceService } from './index';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function makeTemp(tag: string): string {
  const dir = join('/home/dadmin', `.tl-refsrc-${tag}-${process.pid}-${Date.now().toString(36)}-${roots.length}`);
  mkdirSync(dir, { recursive: true });
  roots.push(dir);
  return dir;
}

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

const RECIPE = { profile: 'gltf-glb', recipeVersion: 1, toolchain: { three: '0.186.0' }, extensions: [] };
const METRICS = {
  nodes: 1,
  meshes: 1,
  primitives: 1,
  materials: 1,
  images: 0,
  textures: 0,
  vertices: 3,
  triangles: 1,
  animations: 0,
  animationChannels: 0,
  clipDurationMs: 0,
  decodedGeometryBytes: 36,
  decodedImageBytes: 0,
};

/** Accepts any bytes starting with "glTF"; reports their real digest/length. */
const stubInspector: StageInspector = (bytes, job) => {
  const ok = bytes.length >= 4 && new TextDecoder().decode(bytes.subarray(0, 4)) === 'glTF';
  return {
    status: ok ? 'ok' : 'rejected',
    kind: 'model',
    proposalId: job.proposalId(),
    stageId: job.stageId(),
    expiresAt: job.expiresAt(),
    sourceDigest: sha(bytes),
    sourceByteLength: bytes.length,
    importRecipe: RECIPE,
    metrics: METRICS,
    diagnostics: ok ? [] : [{ code: 'glb_header_invalid', severity: 'error', message: 'not a GLB' }],
    diagnosticCount: ok ? 0 : 1,
    suggestedDisplayName: job.suggestedDisplayName ?? 'asset',
    inspection: { nodeNames: [], materialNames: [], clipNames: [], sceneCount: 1, truncated: false },
  } as unknown as ReturnType<StageInspector>;
};

let seq = 0;
function command(service: WorkspaceService, projectId: string, op: string, args: Record<string, unknown>) {
  const q = service.query({ op: 'queryEntities', projectId, args: { limit: 1, offset: 0 } }) as unknown as { revision: number };
  seq += 1;
  return service.runCommand({
    op,
    projectId,
    expectedRevision: q.revision,
    requestId: `req-${seq.toString(16).padStart(32, '0')}`,
    args,
  });
}

function publishArgs(mode: 'create' | 'reimport', bytes: Uint8Array, sourcePath: string): Record<string, unknown> {
  return {
    mode,
    assetId: 'crate',
    ...(mode === 'create' ? { kind: 'model', displayName: 'Crate' } : {}),
    sourceDigest: sha(bytes),
    sourceByteLength: bytes.length,
    sourcePath,
    importRecipe: RECIPE,
    metrics: METRICS,
    importedAt: '2026-09-23T10:00:00Z',
  };
}

interface Fixture {
  service: WorkspaceService;
  game: string;
  outside: string;
  close: () => void;
}

function folderProject(tag: string): Fixture {
  const base = makeTemp(tag);
  const root = join(base, 'data');
  const game = join(base, 'game');
  const outside = join(base, 'outside');
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
  const service = openWorkspaceService({ root, assetInspector: stubInspector });
  const created = service.createProjectInFolder(game, 'game', 'Game');
  expect(created.ok, JSON.stringify(created)).toBe(true);
  mkdirSync(join(game, 'assets', 'props'), { recursive: true });
  return { service, game, outside, close: () => service.dispose() };
}

const V1 = bytesOf('glTF version one bytes');
const V2 = bytesOf('glTF version two bytes, rebuilt');

describe('assets referenced in place in the game folder', () => {
  it('imports a file without copying it, reads it back verified, and lists the folder', () => {
    const f = folderProject('import');
    try {
      writeFileSync(join(f.game, 'assets', 'props', 'crate.glb'), V1);
      writeFileSync(join(f.game, 'assets', 'props', 'notes.txt'), 'not an asset');

      const listed = f.service.listProjectFiles('game', 'assets/props');
      expect(listed.ok && listed.entries).toEqual([{ name: 'crate.glb', path: 'assets/props/crate.glb', kind: 'model', byteLength: V1.length }]);
      const top = f.service.listProjectFiles('game', '');
      expect(top.ok && top.entries.map((e) => e.path)).toEqual(['assets']); // thirdlight/ and the marker are not offered

      const inspected = f.service.inspectProjectFile('game', 'assets/props/crate.glb');
      expect(inspected.ok, JSON.stringify(inspected)).toBe(true);
      if (!inspected.ok) return;
      expect(inspected.sourcePath).toBe('assets/props/crate.glb');
      expect(inspected.proposal.sourceDigest).toBe(sha(V1));

      const res = command(f.service, 'game', 'publishAsset', publishArgs('create', V1, 'assets/props/crate.glb'));
      expect(res.ok, JSON.stringify(res)).toBe(true);

      const read = f.service.readBlob('game', { assetId: 'crate', version: 1 });
      expect(read.ok && read.digest).toBe(sha(V1));
      expect(read.ok && Buffer.from(read.bytes).equals(Buffer.from(V1))).toBe(true);
      // Nothing was copied into the project.
      const blobs = join(f.game, 'thirdlight', 'sources', 'sha256');
      expect(existsSync(blobs) ? readdirSync(blobs) : []).toEqual([]);

      const integrity = f.service.contentIntegrity('game');
      expect(integrity.ok && integrity.entries).toEqual([
        { assetId: 'crate', version: 1, sourceDigest: sha(V1), referenced: true, sourcePath: 'assets/props/crate.glb', status: 'ok' },
      ]);
      const q = f.service.query({ op: 'queryAssets', projectId: 'game', args: { includeVersions: true, limit: 10, offset: 0 } }) as unknown as {
        assets: Array<{ sourcePath?: string; versions: Array<{ sourcePath?: string }> }>;
      };
      expect(q.assets[0]!.sourcePath).toBe('assets/props/crate.glb');
      expect(q.assets[0]!.versions[0]!.sourcePath).toBe('assets/props/crate.glb');
    } finally {
      f.close();
    }
  });

  it('a changed file is reported and refused; re-import records a new version; the old version becomes unreadable; undo works', () => {
    const f = folderProject('change');
    try {
      const file = join(f.game, 'assets', 'props', 'crate.glb');
      writeFileSync(file, V1);
      expect(command(f.service, 'game', 'publishAsset', publishArgs('create', V1, 'assets/props/crate.glb')).ok).toBe(true);

      // A rebuild changes the bytes.
      writeFileSync(file, V2);
      const read = f.service.readBlob('game', { assetId: 'crate', version: 1 });
      expect(read.ok).toBe(false);
      if (read.ok) return;
      expect(read.error.code).toBe('asset_source_changed');
      expect(read.error).toMatchObject({ assetId: 'crate', assetVersion: 1, path: 'assets/props/crate.glb', sourceDigest: sha(V1), found: sha(V2) });
      expect(read.error.message).toContain('assets/props/crate.glb has changed since it was imported');
      const changed = f.service.contentIntegrity('game');
      expect(changed.ok && changed.entries[0]!.status).toBe('changed');
      expect(changed.ok && changed.summary.changed).toBe(1);

      // Re-import: the same path, a new version with the new digest.
      const inspected = f.service.inspectProjectFile('game', 'assets/props/crate.glb');
      expect(inspected.ok && inspected.proposal.sourceDigest).toBe(sha(V2));
      const re = command(f.service, 'game', 'publishAsset', publishArgs('reimport', V2, 'assets/props/crate.glb'));
      expect(re.ok, JSON.stringify(re)).toBe(true);
      const v2 = f.service.readBlob('game', { assetId: 'crate', version: 2 });
      expect(v2.ok && v2.digest).toBe(sha(V2));
      // The old version stays in the history but can no longer be read.
      const v1 = f.service.readBlob('game', { assetId: 'crate', version: 1 });
      expect(!v1.ok && v1.error.code).toBe('asset_source_changed');
      const after = f.service.contentIntegrity('game');
      expect(after.ok && after.entries.map((e) => [e.version, e.referenced, e.status])).toEqual([
        [1, false, 'changed'],
        [2, true, 'ok'],
      ]);

      // Re-import is an ordinary command: undo restores version 1 as current.
      const undo = command(f.service, 'game', 'undo', {});
      expect(undo.ok, JSON.stringify(undo)).toBe(true);
      const undone = f.service.contentIntegrity('game');
      expect(undone.ok && undone.entries.map((e) => [e.version, e.referenced, e.status])).toEqual([[1, true, 'changed']]);

      // The original bytes come back (git checkout): version 1 is readable again.
      writeFileSync(file, V1);
      expect(f.service.readBlob('game', { assetId: 'crate', version: 1 }).ok).toBe(true);
    } finally {
      f.close();
    }
  });

  it('a missing file is asset_source_missing, not a crash', () => {
    const f = folderProject('missing');
    try {
      const file = join(f.game, 'assets', 'props', 'crate.glb');
      writeFileSync(file, V1);
      expect(command(f.service, 'game', 'publishAsset', publishArgs('create', V1, 'assets/props/crate.glb')).ok).toBe(true);
      unlinkSync(file);
      const read = f.service.readBlob('game', { assetId: 'crate', version: 1 });
      expect(!read.ok && read.error).toMatchObject({ code: 'asset_source_missing', path: 'assets/props/crate.glb', assetId: 'crate', assetVersion: 1 });
      const integrity = f.service.contentIntegrity('game');
      expect(integrity.ok && integrity.entries[0]!.status).toBe('missing');
    } finally {
      f.close();
    }
  });

  it('the commit re-verifies the file: other bytes than the proposal are refused', () => {
    const f = folderProject('commit');
    try {
      writeFileSync(join(f.game, 'assets', 'props', 'crate.glb'), V2);
      const res = command(f.service, 'game', 'publishAsset', publishArgs('create', V1, 'assets/props/crate.glb'));
      expect(!res.ok && res.error.code).toBe('asset_source_changed');
      const none = command(f.service, 'game', 'publishAsset', publishArgs('create', V1, 'assets/props/absent.glb'));
      expect(!none.ok && none.error.code).toBe('asset_source_missing');
    } finally {
      f.close();
    }
  });

  it('refuses paths that leave the game folder: "..", absolute, symlinks out, the project files, .git', () => {
    const f = folderProject('escape');
    try {
      const secret = join(f.outside, 'secret.glb');
      writeFileSync(secret, V1);
      symlinkSync(secret, join(f.game, 'assets', 'link-out.glb'));
      symlinkSync(f.outside, join(f.game, 'assets', 'dir-out'));
      mkdirSync(join(f.game, '.git'), { recursive: true });
      writeFileSync(join(f.game, '.git', 'x.glb'), V1);
      writeFileSync(join(f.game, 'thirdlight', 'inside.glb'), V1);
      symlinkSync(join(f.game, 'thirdlight', 'inside.glb'), join(f.game, 'assets', 'link-project.glb'));

      for (const bad of ['../outside/secret.glb', 'assets/../../outside/secret.glb', secret, '/etc/hostname', 'assets\\props\\crate.glb', './assets/x.glb', 'C:/x.glb']) {
        const r = f.service.inspectProjectFile('game', bad);
        expect(!r.ok && r.error.code, bad).toBe('path_rejected');
        const c = command(f.service, 'game', 'publishAsset', publishArgs('create', V1, bad));
        expect(!c.ok && c.error.code, bad).toBe('field_value');
      }
      for (const bad of ['assets/link-out.glb', 'assets/dir-out/secret.glb', '.git/x.glb', 'thirdlight/inside.glb', 'assets/link-project.glb']) {
        const r = f.service.inspectProjectFile('game', bad);
        expect(!r.ok && r.error.code, bad).toBe('path_rejected');
        // Syntactically fine, so the command gets as far as the commit check.
        const c = command(f.service, 'game', 'publishAsset', publishArgs('create', V1, bad));
        expect(!c.ok && c.error.code, bad).toBe('path_rejected');
      }
      expect(f.service.listProjectFiles('game', 'assets/dir-out').ok).toBe(false);
      const listed = f.service.listProjectFiles('game', 'assets');
      expect(listed.ok && listed.entries.map((e) => e.path)).toEqual(['assets/props']);
      // No error message carries a host path.
      const r = f.service.inspectProjectFile('game', 'assets/link-out.glb');
      expect(!r.ok && JSON.stringify(r.error)).not.toContain(f.outside);
    } finally {
      f.close();
    }
  });

  it('a symlink that stays inside the game folder is fine', () => {
    const f = folderProject('inner-link');
    try {
      writeFileSync(join(f.game, 'assets', 'props', 'crate.glb'), V1);
      symlinkSync(join(f.game, 'assets', 'props', 'crate.glb'), join(f.game, 'assets', 'alias.glb'));
      const r = f.service.inspectProjectFile('game', 'assets/alias.glb');
      expect(r.ok && r.proposal.sourceDigest).toBe(sha(V1));
    } finally {
      f.close();
    }
  });

  it('a project in the data root cannot reference files in place', () => {
    const base = makeTemp('in-tree');
    const service = openWorkspaceService({ root: base, assetInspector: stubInspector });
    try {
      expect(service.createProject('demo', 'Demo').ok).toBe(true);
      expect(service.listProjectFiles('demo', '').ok).toBe(false);
      const r = service.inspectProjectFile('demo', 'assets/crate.glb');
      expect(!r.ok && r.error.code).toBe('path_rejected');
      expect(!r.ok && r.error.message).toContain('not in a game folder');
      const c = command(service, 'demo', 'publishAsset', publishArgs('create', V1, 'assets/crate.glb'));
      expect(!c.ok && c.error.code).toBe('path_rejected');
    } finally {
      service.dispose();
    }
  });

  it('a converted version (FBX): the original is checked at commit and reported by integrity; the stored GLB stays readable', () => {
    const f = folderProject('converted');
    try {
      const fbx = bytesOf('Kaydara FBX Binary  \u0000 pretend fbx v1');
      writeFileSync(join(f.game, 'assets', 'props', 'crate.fbx'), fbx);
      // The converted GLB is a stored blob (as the backend publishes it).
      expect(f.service.publishBlob('game', { digest: sha(V1), byteLength: V1.length, source: { kind: 'bytes', bytes: V1 } }).ok).toBe(true);
      const args = (original: Uint8Array): Record<string, unknown> => {
        const a = publishArgs('create', V1, 'unused');
        delete a['sourcePath'];
        a['convertedFrom'] = { format: 'fbx', sourceDigest: sha(original), sourceByteLength: original.length, sourcePath: 'assets/props/crate.fbx', converter: { name: 'blender', version: '5.2.2' } };
        return a;
      };
      // A convertedFrom that does not match the file on disk is refused.
      const stale = command(f.service, 'game', 'publishAsset', args(bytesOf('Kaydara FBX Binary  other')));
      expect(!stale.ok && stale.error.code).toBe('asset_source_changed');
      expect(command(f.service, 'game', 'publishAsset', args(fbx)).ok).toBe(true);
      const ok = f.service.contentIntegrity('game');
      expect(ok.ok && ok.entries[0]).toMatchObject({ status: 'ok', convertedFrom: { format: 'fbx', sourcePath: 'assets/props/crate.fbx', status: 'ok' } });
      // The FBX is rebuilt: reported as changed, the GLB still reads.
      writeFileSync(join(f.game, 'assets', 'props', 'crate.fbx'), bytesOf('Kaydara FBX Binary  \u0000 pretend fbx v2'));
      const changed = f.service.contentIntegrity('game');
      expect(changed.ok && changed.entries[0]).toMatchObject({ status: 'ok', convertedFrom: { status: 'changed' } });
      expect(f.service.readBlob('game', { assetId: 'crate', version: 1 }).ok).toBe(true);
      // Both sourcePath and convertedFrom on one version: refused by the command.
      const both = publishArgs('reimport', V1, 'assets/props/crate.glb');
      both['convertedFrom'] = args(fbx)['convertedFrom'];
      const r = command(f.service, 'game', 'publishAsset', both);
      expect(!r.ok && r.error.code).toBe('field_unexpected');
    } finally {
      f.close();
    }
  });

  it('survives a reopen: the version still resolves through the registry', () => {
    const f = folderProject('reopen');
    const root = join(f.game, '..', 'data');
    try {
      writeFileSync(join(f.game, 'assets', 'props', 'crate.glb'), V1);
      expect(command(f.service, 'game', 'publishAsset', publishArgs('create', V1, 'assets/props/crate.glb')).ok).toBe(true);
    } finally {
      f.service.close();
    }
    const again = openWorkspaceService({ root, assetInspector: stubInspector });
    try {
      const read = again.readBlob('game', { assetId: 'crate', version: 1 });
      expect(read.ok && read.digest).toBe(sha(V1));
    } finally {
      again.dispose();
    }
  });
});
