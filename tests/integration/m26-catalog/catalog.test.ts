/**
 * The catalog a game page reads, at its boundaries.
 *
 * - A scene's load reads that scene's file and its dependency file, nothing
 *   else of the catalog (over HTTP from a real Play's locator, and from the
 *   files of a build in memory); an asset no read so far named reads the one
 *   shard whose id range holds it.
 * - A v4 build (`fixtures/phase26/legacy-v4-build`, written by the engine
 *   before the catalog) opens on the page into the same content as the v5
 *   build the engine makes now of the same project: every asset row, block,
 *   scene row and what the simulation reads of each asset, so a recorded run
 *   replays the same. The project's last command replays from its record.
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createBehaviorCompiler } from '@thirdlight/behavior-build';
import { buildContentClosureM3 } from '@thirdlight/exporter';
import { openRuntimeContent, prepareSceneCatalog, type RuntimeContent } from '@thirdlight/game-host';
import { audioDurationsFromAssetRows, materialCatalogOf, modelBoundsFromAssetRows } from '@thirdlight/runtime';

import { FakeEditor } from '../../../packages/backend/src/test-editor';
import { api, establish, mkRequestId, mkSessionId, startBackend, upgrade, type TestBackend } from '../../../packages/backend/src/test-helpers';

const REPO = resolve(import.meta.dirname, '..', '..', '..');
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const sha256Hex = (b: Uint8Array): Promise<string> => Promise.resolve(sha(b));
type Manifest = Record<string, unknown> & { assets: { assetId: string; kind: string }[]; scenes?: { sceneId: string; path: string; digest: string; byteLength: number; start: boolean }[] };

/** A reader over a build's folder that records every path read. */
function dirIo(dir: string, reads: string[] = []): { read: (p: string) => Promise<ArrayBuffer>; sha256Hex: typeof sha256Hex; reads: string[] } {
  return {
    reads,
    sha256Hex,
    read: (p) => {
      reads.push(p);
      const file = join(dir, p);
      if (!existsSync(file)) return Promise.reject(new Error(`${p}: 404`));
      const b = readFileSync(file);
      return Promise.resolve(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
    },
  };
}

describe('a scene load reads its own catalog files (HTTP, a real Play)', () => {
  const PID = 'demo-0001';
  const WAV = new Uint8Array(readFileSync(join(REPO, 'fixtures', 'm3', 'media', 'wav', 'cue-jump.wav')));
  let tb: TestBackend;
  beforeAll(async () => {
    tb = await startBackend({ timeouts: { presentTimeoutSeconds: 60, inactivityTtlSeconds: 300 } });
  });
  afterAll(async () => {
    await tb.teardown();
  });
  const revision = (): number => {
    const r = tb.backend._test.service.readCapturedV3(PID);
    if (!r.ok) throw new Error(r.error.code);
    return r.read.revision;
  };
  const command = async (op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const r = await api(`${tb.authUrl}/api/v1/projects/${PID}/commands`, { body: { op, projectId: PID, expectedRevision: revision(), requestId: mkRequestId(), origin: { kind: 'mcp', clientId: 'catalog-test' }, args }, token: tb.adminToken, origin: null });
    expect(r.status, `${op}: ${JSON.stringify(r.json)}`).toBe(200);
    return r.json as Record<string, unknown>;
  };

  it('the start reads the root, the blocks and the start scenes\' entries; a scene load reads its file and its dependency file', async () => {
    // Two sounds: one a second scene plays, one only its label ships.
    const dir = join(tb.root, 'data', 'projects', PID, 'assets', 'sfx');
    mkdirSync(dir, { recursive: true });
    for (const name of ['tone.wav', 'other.wav']) {
      const bytes = name === 'tone.wav' ? WAV : WAV.map((b, i) => (i === WAV.length - 1 ? b ^ 1 : b));
      writeFileSync(join(dir, name), bytes);
      utimesSync(join(dir, name), (Date.now() - 60_000) / 1000, (Date.now() - 60_000) / 1000);
    }
    await command('importAssets', { folder: 'assets/sfx', labels: ['sfx'] });
    await command('createScene', { sceneId: 'scene-two', name: 'Second' });
    await command('createEntity', { kind: 'box', parentId: null, name: 'Chime', sceneId: 'scene-two', components: { audioSource: { assetId: 'tone', volume: 1, range: 10 } } });

    const sid = mkSessionId();
    const est = await establish(tb, sid);
    const ws = await upgrade(tb, sid, est.wsToken);
    await ws.waitFor((m) => (m as { type?: string }).type === 'attached');
    const editor = new FakeEditor(ws);
    const start = await api(`${tb.authUrl}/api/v1/projects/${PID}/play`, { body: {}, token: tb.authToken });
    expect(start.status, JSON.stringify(start.json)).toBe(200);
    const j = start.json as { playSessionId: string; playContent: { path: string } };
    const reads: string[] = [];
    const io = {
      sha256Hex,
      read: async (p: string): Promise<ArrayBuffer> => {
        reads.push(p);
        const res = await fetch(`${tb.prevUrl}${j.playContent.path}${p}`);
        if (!res.ok) throw new Error(`${p}: HTTP ${res.status}`);
        return res.arrayBuffer();
      },
    };
    const doc = (await (await fetch(`${tb.prevUrl}${j.playContent.path}manifest.json`)).json()) as Record<string, unknown>;
    expect(doc['manifestVersion']).toBe(5);
    const content = await openRuntimeContent<Manifest>(doc, io);
    const root = JSON.parse(new TextDecoder().decode(new Uint8Array(await io.read((doc['catalog'] as { path: string }).path)))) as { files: { key: string; path: string }[]; scenes: { sceneId: string; path: string; dependencies: { path: string } }[]; entries: { path: string }[] };
    reads.pop();
    // At open: the root, every block but the loadable index, the start scene's entries; no entry shard.
    const startDeps = root.scenes.find((s) => s.sceneId !== 'scene-two')!.dependencies.path;
    expect(new Set(reads)).toEqual(new Set([(doc['catalog'] as { path: string }).path, ...root.files.filter((f) => f.key !== 'loadable').map((f) => f.path), startDeps]));
    for (const shard of root.entries) expect(reads).not.toContain(shard.path);
    expect(content.catalog.row('tone')).toBeUndefined();

    // Loading the second scene: its file and its dependency file, nothing else.
    reads.length = 0;
    const scenes = await prepareSceneCatalog(content.manifest.scenes!, io, content.catalog);
    reads.length = 0;
    const entities = await scenes.loadScene('scene-two');
    expect(entities.map((e) => (e as { name?: string }).name)).toContain('Chime');
    const two = root.scenes.find((s) => s.sceneId === 'scene-two')!;
    expect(reads.sort()).toEqual([two.path, two.dependencies.path].sort());
    expect(content.catalog.sceneEntriesRead('scene-two')!.map((r) => r.assetId)).toEqual(['tone']);
    expect(content.catalog.row('tone')).toMatchObject({ kind: 'audio', sourceDigest: sha(WAV) });
    // An asset no scene names (shipped for its label): its one shard.
    reads.length = 0;
    expect(await content.catalog.lookup('other')).toMatchObject({ assetId: 'other', labels: ['sfx'] });
    expect(reads).toHaveLength(1);
    expect(root.entries.map((e) => e.path)).toContain(reads[0]);
    // The loadable index is read when asked for.
    expect((await content.catalog.loadable()).map((r) => r.id).sort()).toEqual(['other', 'tone']);

    await editor.waitUntil(() => tb.backend._test.plays.get(j.playSessionId)?.state === 'presented');
    await api(`${tb.authUrl}/api/v1/projects/${PID}/play/${j.playSessionId}/stop`, { body: {}, token: tb.authToken });
    await editor.waitForEvent('play.stopped');
    editor.close();
  }, 120_000);

  it('a script\'s required modules reach the build\'s module set', async () => {
    const captured = (): { scene: unknown; content: unknown; scenes?: readonly unknown[]; startScenes?: readonly string[]; revision: number } => {
      const r = tb.backend._test.service.readCapturedV3(PID);
      if (!r.ok) throw new Error(r.error.code);
      return r.read;
    };
    const modulesOf = async (): Promise<readonly string[]> => {
      const c = captured();
      const built = await buildContentClosureM3({ service: tb.backend._test.service, compiler: createBehaviorCompiler() as never, projectId: PID, revision: c.revision, capturedAt: '2026-09-30T00:00:00Z', scene: c.scene, content: c.content, ...(c.scenes !== undefined ? { scenes: c.scenes, startScenes: c.startScenes ?? [] } : {}), locate: true });
      if (!built.ok) throw new Error(JSON.stringify(built.error));
      return built.closure.moduleIds;
    };
    const physics = (ids: readonly string[]): string[] => ids.filter((id) => id.startsWith('thirdlight.physics-rapier:'));
    expect(physics(await modulesOf())).toEqual([]);
    // A script that needs the physics backend, in a project whose scenes pull none in.
    const bytes = Buffer.from(`${JSON.stringify({ graphVersion: 1, entryPath: 'src/index.ts', requiredModules: ['@thirdlight/physics-rapier', '@thirdlight/runtime'], ownedTransforms: [], files: [{ path: 'src/index.ts', text: 'export default { prepare() { return {}; }, instantiate() { return {}; }, step() {}, dispose() {} };\n' }] }, null, 2)}\n`);
    const stage = await api(`${tb.authUrl}/api/v1/projects/${PID}/content/stages`, { body: {}, token: tb.adminToken, origin: null });
    const stageId = String((stage.json as { stageId: string }).stageId);
    const put = await fetch(`${tb.authUrl}/api/v1/projects/${PID}/content/stages/${stageId}/bytes`, { method: 'PUT', headers: { authorization: `Bearer ${tb.adminToken}`, 'content-type': 'application/octet-stream', 'x-thirdlight-offset': '0', 'x-thirdlight-total': String(bytes.length) }, body: bytes });
    expect(put.status).toBe(200);
    const declaration = { properties: [] };
    await command('publishBehavior', { behaviorId: 'reader', displayName: 'Reader', mode: 'declaration-create', declaration });
    await command('acknowledgeBehaviorTrust', { sourceDigest: sha(bytes) });
    const published = await api(`${tb.authUrl}/api/v1/projects/${PID}/content/behaviors/source`, { body: { stageId, behaviorId: 'reader', displayName: 'Reader', declaration, expectedRevision: revision(), requestId: mkRequestId() }, token: tb.adminToken, origin: null });
    expect(published.status, JSON.stringify(published.json)).toBe(200);
    const holder = String((await command('createEntity', { kind: 'group', parentId: null, name: 'Reader' }))['createdId']);
    await command('setBehaviorProperties', { entityId: holder, behaviorId: 'reader', values: {} });
    expect(physics(await modulesOf())).toHaveLength(1);
  }, 120_000);
});

describe('a v4 build opens on the page as the v5 build of the same project', () => {
  const FIXTURE = join(REPO, 'fixtures', 'phase26', 'legacy-v4-build');
  const ID = 'legacy-v4-assets';
  let tb: TestBackend;
  let exportRoot: string;
  beforeAll(async () => {
    exportRoot = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'tl-catalog-export-'));
    tb = await startBackend({ tokens: [], exportRoot, engineRoot: REPO });
    cpSync(join(FIXTURE, 'project'), join(tb.root, 'data', 'projects', ID), { recursive: true });
  });
  afterAll(async () => {
    await tb.teardown();
    rmSync(exportRoot, { recursive: true, force: true });
  });

  it('the same rows, blocks, scenes and simulation facts; its last command replays from its record', async () => {
    const opened = await api(`${tb.authUrl}/api/v1/sessions`, { body: { projectId: ID, sessionId: mkSessionId(), clientInfo: { kind: 'browser', label: 'catalog-v4' } }, token: tb.adminToken });
    expect(opened.status, JSON.stringify(opened.json)).toBe(200);
    // The last command, sent again, answers its recorded result (nothing applied twice).
    const replay = JSON.parse(readFileSync(join(FIXTURE, 'replay.json'), 'utf8')) as Record<string, unknown>;
    const again = await api(`${tb.authUrl}/api/v1/projects/${ID}/commands`, { body: replay, token: tb.adminToken, origin: null });
    expect(again.status, JSON.stringify(again.json)).toBe(200);
    expect(again.json).toMatchObject({ ok: true, duplicated: true, requestId: replay['requestId'] });

    const exported = await api(`${tb.authUrl}/api/v1/admin/projects/${ID}/export`, { body: {}, token: tb.adminToken, origin: null });
    expect(exported.status, JSON.stringify(exported.json)).toBe(200);
    const out = join(exportRoot, String((exported.json as { outputDir: string }).outputDir));

    const v4Doc = JSON.parse(readFileSync(join(FIXTURE, 'build', 'manifest.json'), 'utf8')) as Record<string, unknown>;
    const v5Doc = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) as Record<string, unknown>;
    expect(v4Doc['manifestVersion']).toBe(4);
    expect(v5Doc['manifestVersion']).toBe(5);
    const v4Reads: string[] = [];
    const a: RuntimeContent<Manifest> = await openRuntimeContent<Manifest>(v4Doc, dirIo(join(FIXTURE, 'build'), v4Reads));
    const b: RuntimeContent<Manifest> = await openRuntimeContent<Manifest>(v5Doc, dirIo(out));
    expect(a.version).toBe(4);
    expect(b.version).toBe(5);
    // A v4 build: its content files only, every row known at open.
    expect(v4Reads).toEqual(((v4Doc['contentFiles'] as { path: string }[] | undefined) ?? []).map((r) => r.path));
    expect(a.catalog.known().map((r) => r.assetId).sort()).toEqual(['beep', 'crate', 'wall']);

    // The same content: the blocks, the scene rows (the same scene files), the media and behaviors.
    for (const k of ['settings', 'tags', 'prefabs', 'materials', 'media', 'behaviors', 'sceneDigest', 'projectId']) expect(b.manifest[k], k).toEqual(a.manifest[k]);
    const sceneRow = (s: { sceneId: string; path: string; digest: string; byteLength: number; start: boolean }) => ({ sceneId: s.sceneId, path: s.path, digest: s.digest, byteLength: s.byteLength, start: s.start });
    expect(b.manifest.scenes!.map(sceneRow)).toEqual(a.manifest.scenes!.map(sceneRow));
    expect(b.manifest['start']).toEqual(a.manifest['start']);
    // Every asset row, found in the v5 catalog (by its shard), as the v4 manifest had it.
    for (const row of a.catalog.known()) {
      const found = await b.catalog.lookup(row.assetId);
      const { address: _a, labels: _l, dependencies: _d, ...plain } = found as Record<string, unknown>;
      expect(plain, row.assetId).toEqual(row);
    }
    expect(await b.catalog.loadable()).toEqual(v4Doc['loadable']);
    // What the simulation starts with is the same, so a recorded run replays the same.
    expect(modelBoundsFromAssetRows(b.facts as never)).toEqual(modelBoundsFromAssetRows(a.facts as never));
    expect(audioDurationsFromAssetRows(b.facts as never)).toEqual(audioDurationsFromAssetRows(a.facts as never));
    expect(materialCatalogOf(b.manifest['materials'] as never, b.facts as never)).toEqual(materialCatalogOf(a.manifest['materials'] as never, a.facts as never));
    // The v5 build lists what each scene needs: the model and the texture its material draws with; the sound.
    const deps = async (id: string): Promise<string[]> => [...(await b.catalog.sceneEntries(id)!)].map((r) => r.assetId).sort();
    expect(await deps('scene-main')).toEqual(['crate', 'wall']);
    expect(await deps('scene-two')).toEqual(['beep']);
  }, 180_000);
});
