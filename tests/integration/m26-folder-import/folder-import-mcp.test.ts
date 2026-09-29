/**
 * Folder import from an AI client over the REAL transports (the MCP server
 * bundle against the backend bundle): files uploaded one by one with
 * tl_content_upload writeTo land in a folder of the project's own folder,
 * one tl_command importAssets brings the folder in with its labels, the
 * asset query shows the labels, one undo forgets the whole import (the files
 * stay), and a publishAsset of uploaded bytes lands in the folder it names.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ADMIN_TOKEN,
  AUTH_TOKEN,
  V3_PROJECT,
  base64,
  cleanupBundles,
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
const GLB = new Uint8Array(readFileSync(join(REPO, 'fixtures', 'm2', 'assets', 'tiny-v1.glb')));

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
});
