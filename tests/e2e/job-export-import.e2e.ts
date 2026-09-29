/**
 * Phase 25.22: importing an asset tool's job export (a folder or a zip with
 * a GLB and manifest.json) against the real backend and the real MCP stdio
 * adapter, on a project in a game folder. The export is generated here: a
 * GLB fixture, a stand-in preview file and a manifest with their SHA-256
 * digests (no asset tool is read or run).
 *
 * Checked: a folder export is inspected over HTTP and its model referenced
 * in place (sourcePath), committed by the ordinary publishAsset; a zip in
 * the game folder (wrapped in one top folder) and an uploaded zip (MCP
 * dataBase64) are inspected through tl_content_upload {jobExport} and
 * committed by tl_command publishAsset; the manifest's triangle claim is
 * compared with the inspected model (a warning when they differ); a file
 * whose bytes do not match its digest, a manifest without a model and a
 * file that is not a zip are refused with content_invalid and write nothing.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, test } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';

const REPO = resolve(import.meta.dirname, '..', '..');
const GLB = join(REPO, 'fixtures', 'import-ext', 'base-png.glb');

let be: E2EBackend;
let games: string;
test.beforeEach(async () => {
  be = await startBackend('home-0001');
  games = mkdtempSync(join(tmpdir(), 'tl-e2e-jobexport-'));
});
test.afterEach(async () => {
  await be.stop();
  rmSync(games, { recursive: true, force: true });
});

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

/** A zip of the files (deflated), as common tools write one. */
function makeZip(files: { name: string; data: Uint8Array }[]): Buffer {
  const locals: Buffer[] = [];
  const cens: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const body = deflateRawSync(f.data);
    const crc = crc32(f.data) >>> 0;
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0);
    loc.writeUInt16LE(20, 4);
    loc.writeUInt16LE(8, 8);
    loc.writeUInt32LE(crc, 14);
    loc.writeUInt32LE(body.length, 18);
    loc.writeUInt32LE(f.data.length, 22);
    loc.writeUInt16LE(name.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(8, 10);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(f.data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    locals.push(loc, name, body);
    cens.push(cen, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(cens);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

test('a job export (folder, zip in the game folder, uploaded zip) imports through the ordinary asset path; bad exports are refused', async () => {
  test.setTimeout(120_000);
  const game = join(games, 'game');
  const made = await be.admin('projects', { projectId: 'game', name: 'Job exports', folder: game });
  expect(made.status, JSON.stringify(made.json)).toBe(201);

  // The generated export: a model, a preview and the manifest.
  const glb = new Uint8Array(readFileSync(GLB));
  const preview = new TextEncoder().encode('a preview image stands here');
  const manifest = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    name: 'Crate',
    files: [{ path: 'crate.glb', role: 'model', digest: sha(glb) }, { path: 'preview.png', role: 'preview', digest: `sha256:${sha(preview)}` }],
    triangles: 999_999,
    lods: [999_999],
    producer: { job: 'j-1', settings: { any: true } },
    ...over,
  });
  const dir = join(game, 'exports', 'crate');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'crate.glb'), glb);
  writeFileSync(join(dir, 'preview.png'), preview);
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest(), null, 2));

  const api = async (path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
    const r = await fetch(`${be.origin}/api/v1/projects/game/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${be.token}`, 'content-type': 'application/json', origin: be.origin },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
  };
  const mcp = new Client({ name: 'thirdlight-e2e', version: '0.0.0' });
  await mcp.connect(new StdioClientTransport({
    command: process.execPath,
    args: [join(REPO, 'dist', 'mcp-adapter', 'mcp.mjs')],
    env: { ...(process.env as Record<string, string>), THIRDLIGHT_AUTHORING_ORIGIN: be.origin, THIRDLIGHT_PROJECT_ID: 'game', THIRDLIGHT_MCP_TOKEN: be.token },
    stderr: 'ignore',
  }));
  const call = async (name: string, args: Record<string, unknown>): Promise<{ isError: boolean; body: Record<string, unknown> }> => {
    const res = (await mcp.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
    return { isError: res.isError === true, body: JSON.parse(res.content[0]!.text) as Record<string, unknown> };
  };
  const publish = async (assetId: string, inspected: Record<string, unknown>): Promise<{ isError: boolean; body: Record<string, unknown> }> => {
    const p = inspected.proposal as Record<string, unknown>;
    const project = await call('tl_inspect', { target: 'project' });
    return call('tl_command', {
      op: 'publishAsset',
      expectedRevision: project.body.revision,
      args: {
        mode: 'create', assetId, kind: 'model', displayName: (inspected.jobExport as { name: string }).name,
        sourceDigest: p.sourceDigest, sourceByteLength: p.sourceByteLength,
        ...(inspected.sourcePath !== undefined ? { sourcePath: inspected.sourcePath } : {}),
        importRecipe: p.importRecipe, metrics: p.metrics, importedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      },
    });
  };
  const assets = async (): Promise<{ assetId: string; displayName: string }[]> => {
    const q = await call('tl_content_query', { target: 'assets' });
    return (q.body.assets ?? []) as { assetId: string; displayName: string }[];
  };

  try {
    // ---- a folder in the game folder, over HTTP: the model is referenced in place ----
    const folder = await api('content/job-exports/inspect', { path: 'exports/crate' });
    expect(folder.status, JSON.stringify(folder.json)).toBe(200);
    expect(folder.json.sourcePath).toBe('exports/crate/crate.glb');
    const fp = folder.json.proposal as { sourceDigest: string; suggestedDisplayName: string; metrics: { triangles: number } };
    expect(fp.sourceDigest).toBe(sha(glb));
    expect(fp.suggestedDisplayName).toBe('Crate');
    const triangles = fp.metrics.triangles;
    expect(triangles).toBeGreaterThan(0);
    expect(folder.json.jobExport).toEqual({
      name: 'Crate',
      files: [{ path: 'crate.glb', role: 'model', digest: sha(glb), byteLength: glb.length }, { path: 'preview.png', role: 'preview', digest: sha(preview), byteLength: preview.length }],
      triangles: 999_999,
      lods: [999_999],
      inspected: { triangles },
      ignoredKeys: ['producer'],
      warnings: [`the manifest says 999999 triangles; the model has ${triangles}`],
    });
    const pub1 = await publish('crate-folder', folder.json);
    expect(pub1.isError, JSON.stringify(pub1.body)).toBe(false);

    // ---- a zip in the game folder (one top folder), through MCP ----
    const good = manifest({ triangles, lods: [triangles] });
    writeFileSync(join(game, 'exports', 'crate.zip'), makeZip([
      { name: 'crate/manifest.json', data: new TextEncoder().encode(JSON.stringify(good)) },
      { name: 'crate/crate.glb', data: glb },
      { name: 'crate/preview.png', data: preview },
    ]));
    const zipped = await call('tl_content_upload', { jobExport: { path: 'exports/crate.zip' } });
    expect(zipped.isError, JSON.stringify(zipped.body)).toBe(false);
    expect(zipped.body.sourcePath).toBeUndefined();
    expect((zipped.body.jobExport as { warnings: string[] }).warnings).toEqual([]);
    const pub2 = await publish('crate-zip', zipped.body);
    expect(pub2.isError, JSON.stringify(pub2.body)).toBe(false);

    // ---- an uploaded zip (manifest at the root), through MCP ----
    const upload = makeZip([
      { name: 'manifest.json', data: new TextEncoder().encode(JSON.stringify({ ...good, name: 'Crate upload' })) },
      { name: 'crate.glb', data: glb },
      { name: 'preview.png', data: preview },
    ]);
    const uploaded = await call('tl_content_upload', { jobExport: {}, dataBase64: upload.toString('base64') });
    expect(uploaded.isError, JSON.stringify(uploaded.body)).toBe(false);
    expect((uploaded.body.proposal as { suggestedDisplayName: string }).suggestedDisplayName).toBe('Crate upload');
    const pub3 = await publish('crate-upload', uploaded.body);
    expect(pub3.isError, JSON.stringify(pub3.body)).toBe(false);
    expect((await assets()).map((a) => [a.assetId, a.displayName]).sort()).toEqual([['crate-folder', 'Crate'], ['crate-upload', 'Crate upload'], ['crate-zip', 'Crate']]);
    // The imported model is usable like any other.
    const project = await call('tl_inspect', { target: 'project' });
    const placed = await call('tl_command', { op: 'createEntity', expectedRevision: project.body.revision, args: { kind: 'model', name: 'Crate', model: { asset: { assetId: 'crate-zip' } }, transform: { position: [0, 0, 0] } } });
    expect(placed.isError, JSON.stringify(placed.body)).toBe(false);

    // ---- refusals: nothing is written ----
    const before = (await call('tl_inspect', { target: 'project' })).body.revision;
    writeFileSync(join(dir, 'preview.png'), new TextEncoder().encode('changed'));
    const tampered = await api('content/job-exports/inspect', { path: 'exports/crate' });
    expect(tampered.status).toBe(400);
    expect(tampered.json.error).toMatchObject({ code: 'content_invalid', path: '/files/1/digest' });
    writeFileSync(join(game, 'exports', 'nomodel.zip'), makeZip([{ name: 'manifest.json', data: new TextEncoder().encode(JSON.stringify({ name: 'X', files: [{ path: 'preview.png', role: 'preview', digest: sha(preview) }] })) }, { name: 'preview.png', data: preview }]));
    const noModel = await call('tl_content_upload', { jobExport: { path: 'exports/nomodel.zip' } });
    expect(noModel.isError).toBe(true);
    expect(JSON.stringify(noModel.body)).toContain('content_invalid');
    const notZip = await call('tl_content_upload', { jobExport: {}, dataBase64: Buffer.from('not a zip at all').toString('base64') });
    expect(notZip.isError).toBe(true);
    expect(JSON.stringify(notZip.body)).toContain('content_invalid');
    const escape = await api('content/job-exports/inspect', { path: '../outside' });
    expect(escape.json.error).toMatchObject({ code: 'path_rejected' });
    expect((await call('tl_inspect', { target: 'project' })).body.revision).toBe(before);
    expect((await assets()).length).toBe(3);
  } finally {
    await mcp.close();
  }
  // Keep a copy of the generated export beside the test results (small) for inspection.
  mkdirSync(join(REPO, 'test-results', 'job-export'), { recursive: true });
  copyFileSync(join(game, 'exports', 'crate.zip'), join(REPO, 'test-results', 'job-export', 'crate.zip'));
});
