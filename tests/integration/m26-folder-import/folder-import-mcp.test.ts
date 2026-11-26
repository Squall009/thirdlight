/**
 * Folder import from an AI client over the REAL transports (the MCP server
 * bundle against the backend bundle): files uploaded one by one with
 * tl_content_upload writeTo land in a folder of the project's own folder,
 * one tl_command importAssets brings the folder in with its labels, the
 * asset query shows the labels, one undo forgets the whole import (the files
 * stay), and a publishAsset of uploaded bytes lands in the folder it names.
 * A game folder outside the data root: a file already in it is imported in
 * place (nothing copied), a rebuilt file is reported changed and the check
 * imports it again.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ADMIN_TOKEN,
  AUTH_TOKEN,
  V3_PROJECT,
  base64,
  cleanupBundles,
  http,
  createMcp,
  makeRoot,
  spawnBackend,
  stopBackend,
  type BackendProcess,
  type DisposableRoot,
  type McpHarness,
} from '../m3-content/harness';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const OPUS = new Uint8Array(readFileSync(join(REPO, 'fixtures', 'music', 'chord-opus.ogg')));
const WAV = new Uint8Array(readFileSync(join(REPO, 'fixtures', 'm3', 'media', 'wav', 'cue-jump.wav')));
const GLB_V1 = join(REPO, 'fixtures', 'm2', 'assets', 'tiny-v1.glb');
const GLB_V2 = join(REPO, 'fixtures', 'm2', 'assets', 'tiny-v2.glb');
const GLB = new Uint8Array(readFileSync(GLB_V1));
const sha = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');
const REACH_TOKEN = 'folder-import-reach-token';

let root: DisposableRoot;
let bp: BackendProcess;
let mcp: McpHarness;

async function revision(): Promise<number> {
  const res = await mcp.call('tl_inspect', { target: 'project' });
  return Number(res.body.revision);
}

beforeAll(async () => {
  root = makeRoot('folder-import');
  bp = await spawnBackend(root, [
    { token: AUTH_TOKEN, scope: `authoring:${V3_PROJECT}` },
    { token: ADMIN_TOKEN, scope: 'admin' },
    { token: REACH_TOKEN, scope: 'authoring:reach' },
  ]);
  mcp = await createMcp(bp.origin);
}, 90_000);

afterAll(async () => {
  cleanupBundles();
  await mcp?.close();
  if (bp) await stopBackend(bp);
  if (root) rmSync(root.root, { recursive: true, force: true });
}, 60_000);

describe('folder import through MCP', () => {
  it('uploads a folder file by file, imports it with labels in one command, undoes it in one step', async () => {
    for (const [path, bytes] of [['assets/voice/intro/line-001.ogg', OPUS], ['assets/voice/intro/line-002.ogg', OPUS], ['assets/voice/intro/click.wav', WAV], ['assets/voice/intro/readme.md', new TextEncoder().encode('# lines')]] as const) {
      const up = await mcp.call('tl_content_upload', { dataBase64: base64(bytes), writeTo: path });
      expect(up.isError, JSON.stringify(up.body)).toBe(false);
      expect(up.body).toMatchObject({ ok: true, path });
      expect(existsSync(join(root.v3Dir, ...path.split('/')))).toBe(true);
    }
    // Never into the project's own files, never over another file.
    expect((await mcp.call('tl_content_upload', { dataBase64: base64(GLB), writeTo: 'scenes/x.glb' })).isError).toBe(true);
    expect((await mcp.call('tl_content_upload', { dataBase64: base64(GLB), writeTo: 'assets/voice/intro/line-001.ogg' })).isError).toBe(true);

    const before = await revision();
    const imported = await mcp.call('tl_command', { op: 'importAssets', args: { folder: 'assets/voice', labels: ['voice', 'intro'] }, expectedRevision: before });
    expect(imported.isError, JSON.stringify(imported.body)).toBe(false);
    expect(imported.body).toMatchObject({ ok: true, revision: before + 1, folderImport: { prepared: 3, unsupported: [{ path: 'assets/voice/intro/readme.md' }] } });
    const added = (imported.body.change as { added: { assetId: string; displayName: string; labels: string[] }[] }).added;
    expect(added.map((a) => a.assetId).sort()).toEqual(['click', 'line-001', 'line-002']);
    for (const a of added) expect(a.labels).toEqual(['intro', 'voice']);
    const sidecar = JSON.parse(readFileSync(join(root.v3Dir, 'assets', 'voice', 'intro', 'line-001.ogg.tlasset'), 'utf8')) as { id: string; labels: string[] };
    expect(sidecar).toMatchObject({ id: 'line-001', labels: ['intro', 'voice'] });

    const listed = await mcp.call('tl_content_query', { target: 'asset', assetId: 'line-002' });
    expect(JSON.stringify(listed.body)).toContain('"labels":["intro","voice"]');

    const undo = await mcp.call('tl_command', { op: 'undo', args: {}, expectedRevision: before + 1 });
    expect(undo.isError, JSON.stringify(undo.body)).toBe(false);
    const after = await mcp.call('tl_content_query', { target: 'assets' });
    expect(JSON.stringify(after.body)).not.toContain('line-001');
    expect(existsSync(join(root.v3Dir, 'assets', 'voice', 'intro', 'line-001.ogg'))).toBe(true);
  }, 60_000);

  it('publishes uploaded bytes into the folder publishAsset names', async () => {
    const inspected = await mcp.call('tl_content_upload', { dataBase64: base64(GLB), kind: 'model', displayName: 'Crate' });
    expect(inspected.isError, JSON.stringify(inspected.body)).toBe(false);
    const p = inspected.body.proposal as { sourceDigest: string; sourceByteLength: number; importRecipe: unknown; metrics: unknown };
    const args = { mode: 'create', assetId: 'crate', kind: 'model', displayName: 'Crate', sourceDigest: p.sourceDigest, sourceByteLength: p.sourceByteLength, importRecipe: p.importRecipe, metrics: p.metrics, importedAt: '2026-09-29T00:00:00Z' };
    const refused = await mcp.call('tl_command', { op: 'publishAsset', args: { ...args, folder: '.thirdlight' }, expectedRevision: await revision() });
    expect(refused.isError).toBe(true);
    const r = await mcp.call('tl_command', { op: 'publishAsset', args: { ...args, folder: 'assets/props' }, expectedRevision: await revision() });
    expect(r.isError, JSON.stringify(r.body)).toBe(false);
    expect(readFileSync(join(root.v3Dir, 'assets', 'props', 'Crate.glb')).equals(Buffer.from(GLB))).toBe(true);
  }, 60_000);

  it('imports a file already in a game folder in place; a rebuilt file is changed, and the check imports it again', async () => {
    mkdirSync(join(root.root, 'games'), { recursive: true });
    const reach = join(root.root, 'games', 'reach');
    const made = await http(`${bp.origin}/api/v1/admin/projects`, { token: ADMIN_TOKEN, body: { projectId: 'reach', name: 'Reach', folder: reach } });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    mkdirSync(join(reach, 'assets', 'props'), { recursive: true });
    const file = join(reach, 'assets', 'props', 'crate.glb');
    copyFileSync(GLB_V1, file);
    const agent = await createMcp(bp.origin, 'reach', REACH_TOKEN, 'folder-in-place');
    try {
      const listed = await agent.call('tl_content_query', { target: 'projectFiles', dir: 'assets/props' });
      expect(listed.isError, JSON.stringify(listed.body)).toBe(false);
      expect(listed.body.entries).toEqual([{ name: 'crate.glb', path: 'assets/props/crate.glb', kind: 'model', byteLength: statSync(file).size }]);
      const escape = await agent.call('tl_content_upload', { projectPath: '../outside.glb' });
      expect(escape.isError).toBe(true);
      expect(JSON.stringify(escape.body)).toContain('path_rejected');

      const up = await agent.call('tl_content_upload', { projectPath: 'assets/props/crate.glb', kind: 'model' });
      expect(up.isError, JSON.stringify(up.body)).toBe(false);
      expect(up.body.sourcePath).toBe('assets/props/crate.glb');
      const p = up.body.proposal as { sourceDigest: string; sourceByteLength: number; importRecipe: unknown; metrics: unknown };
      const rev = Number((await agent.call('tl_inspect', { target: 'project' })).body.revision);
      const created = await agent.call('tl_command', {
        op: 'publishAsset',
        expectedRevision: rev,
        args: { mode: 'create', assetId: 'crate', kind: 'model', displayName: 'Crate', sourceDigest: p.sourceDigest, sourceByteLength: p.sourceByteLength, sourcePath: up.body.sourcePath, importRecipe: p.importRecipe, metrics: p.metrics, importedAt: '2026-09-29T00:00:00Z' },
      });
      expect(created.isError, JSON.stringify(created.body)).toBe(false);
      const ok = await agent.call('tl_content_query', { target: 'integrity' });
      expect(ok.body.entries).toEqual([{ assetId: 'crate', version: 1, sourceDigest: sha(GLB_V1), referenced: true, sourcePath: 'assets/props/crate.glb', status: 'ok' }]);
      // Referenced in place: no blob copied into the project.
      const blobs = join(reach, 'thirdlight', 'sources', 'sha256');
      expect(existsSync(blobs) ? readdirSync(blobs) : []).toEqual([]);
      expect(JSON.parse(readFileSync(`${file}.tlasset`, 'utf8'))).toMatchObject({ tlasset: 3, id: 'crate', kind: 'model', record: { kind: 'model' } });

      copyFileSync(GLB_V2, file);
      const changed = await agent.call('tl_content_query', { target: 'integrity' });
      expect((changed.body.entries as Array<{ status: string }>)[0]!.status).toBe('changed');
      // check: true is the editor's "check files".
      const checked = await agent.call('tl_content_query', { target: 'integrity', check: true });
      expect(checked.isError, JSON.stringify(checked.body)).toBe(false);
      expect(checked.body.check).toMatchObject({ reimported: [{ assetId: 'crate', file: 'assets/props/crate.glb', version: 2 }], failed: [] });
      expect((checked.body.entries as Array<{ version: number; status: string; sourceDigest: string }>).map((e) => [e.version, e.status, e.sourceDigest])).toEqual([[2, 'ok', sha(GLB_V2)]]);
    } finally {
      await agent.close();
    }
  }, 60_000);
});
