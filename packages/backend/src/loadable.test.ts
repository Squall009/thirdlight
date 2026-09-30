/**
 * Addresses and labels at the HTTP boundary (a project in the data root):
 *
 * - `setLabels` / `setAddress` over the command route write an asset's
 *   names into its sidecar record and a resource's into its resource file;
 *   the index answers `loadable` and `address` queries;
 * - the export ships a labelled asset no scene references and leaves out an
 *   unlabelled one; its manifest lists the loadable entries for the runtime;
 * - a script (a library file) naming a non-loadable asset is a Problem;
 * - a project whose sidecars predate addresses opens with the assets its
 *   scripts name labelled `script-named` (reported), once.
 */
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { api, mkRequestId, mkSessionId, startBackend, type TestBackend } from './test-helpers';

const REPO = resolve(import.meta.dirname, '..', '..', '..');
const WAV = readFileSync(join(REPO, 'fixtures', 'm3', 'media', 'wav', 'cue-jump.wav'));
const OPUS = readFileSync(join(REPO, 'fixtures', 'music', 'chord-opus.ogg'));
const PID = 'demo-0001';
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

describe('addresses and labels over HTTP', () => {
  let tb: TestBackend;
  let exportRoot: string;
  const dir = (id = PID): string => join(tb.root, 'data', 'projects', id);
  const put = (rel: string, bytes: Uint8Array, id = PID): void => {
    mkdirSync(join(dir(id), ...rel.split('/').slice(0, -1)), { recursive: true });
    writeFileSync(join(dir(id), ...rel.split('/')), bytes);
  };
  const revision = (id = PID): number => {
    const r = tb.backend._test.service.readCapturedV3(id);
    if (!r.ok) throw new Error(r.error.code);
    return r.read.revision;
  };
  const command = (op: string, args: Record<string, unknown>, id = PID) =>
    api(`${tb.authUrl}/api/v1/projects/${id}/commands`, { body: { op, projectId: id, expectedRevision: revision(id), requestId: mkRequestId(), origin: { kind: 'mcp', clientId: 'loadable-test' }, args }, token: tb.adminToken, origin: null });
  const json = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const problems = async (id = PID): Promise<{ code: string; message: string }[]> => ((await api(`${tb.authUrl}/api/v1/projects/${id}/problems`, { method: 'GET', token: tb.adminToken, origin: null })).json as { problems: { code: string; message: string }[] }).problems;
  const exportProject = async (id = PID): Promise<string> => {
    const r = await api(`${tb.authUrl}/api/v1/admin/projects/${id}/export`, { body: {}, token: tb.adminToken, origin: null });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    return join(exportRoot, String((r.json as { outputDir: string }).outputDir));
  };

  beforeAll(async () => {
    exportRoot = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'tl-loadable-export-'));
    tb = await startBackend({ exportRoot, engineRoot: REPO });
  });
  afterAll(async () => {
    await tb.teardown();
    rmSync(exportRoot, { recursive: true, force: true });
  });

  it('a labelled asset no scene references ships; an unlabelled one does not; the manifest lists what is loadable', async () => {
    put('assets/sfx/labelled.wav', WAV);
    put('assets/sfx/plain.ogg', OPUS);
    expect((await command('importAssets', { folder: 'assets/sfx' })).status).toBe(200);
    expect((await command('setMaterial', { material: { materialId: 'mat-loadable', name: 'Loadable', shader: 'standard', params: {}, textures: {} } })).status).toBe(200);
    const before = revision();
    const labels = await command('setLabels', { items: [{ kind: 'asset', id: 'labelled' }, { kind: 'material', id: 'mat-loadable' }], add: ['sfx', 'level-1'] });
    expect(labels.status, JSON.stringify(labels.json)).toBe(200);
    expect((labels.json as { revision: number }).revision).toBe(before + 1);
    const address = await command('setAddress', { kind: 'asset', id: 'labelled', address: 'sfx/jump' });
    expect(address.status, JSON.stringify(address.json)).toBe(200);

    // The asset's names are in its sidecar record; the material's in its resource file, beside the record.
    const sidecar = json(join(dir(), 'assets', 'sfx', 'labelled.wav.tlasset'));
    expect(sidecar).toMatchObject({ tlasset: 3, labels: ['level-1', 'sfx'], address: 'sfx/jump', record: { assetId: 'labelled', labels: ['level-1', 'sfx'], address: 'sfx/jump' } });
    const material = json(join(dir(), 'assets', 'materials', 'mat-loadable.material.json'));
    expect(material).toMatchObject({ tlresource: 1, kind: 'material', id: 'mat-loadable', labels: ['level-1', 'sfx'] });
    expect(material['data']).not.toHaveProperty('labels');

    // An address is unique project-wide.
    const taken = await command('setAddress', { kind: 'material', id: 'mat-loadable', address: 'sfx/jump' });
    expect(taken.status).not.toBe(200);
    expect(JSON.stringify(taken.json)).toContain('unique project-wide');

    // The index finds them by label, address, and as loadable.
    const index = async (args: Record<string, unknown>) => ((await api(`${tb.authUrl}/api/v1/projects/${PID}/commands`, { body: { op: 'queryIndex', projectId: PID, args }, token: tb.adminToken, origin: null })).json as { entries: { kind: string; id: string; labels: string[]; address?: string }[] }).entries;
    expect((await index({ loadable: true })).map((e) => `${e.kind}:${e.id}`)).toEqual(['audio:labelled', 'material:mat-loadable']);
    expect((await index({ address: 'sfx/jump' })).map((e) => e.id)).toEqual(['labelled']);
    expect((await index({ label: 'level-1' })).map((e) => e.id).sort()).toEqual(['labelled', 'mat-loadable']);

    // The export: the labelled file ships though no scene uses it; the plain one does not.
    const out = await exportProject();
    const shipped = readdirSync(join(out, 'content', 'sha256'));
    expect(shipped).toContain(sha(WAV));
    expect(shipped).not.toContain(sha(OPUS));
    const manifest = json(join(out, 'manifest.json')) as { assets: { assetId: string }[]; loadable?: unknown; contentFiles?: { key: string; path: string }[] };
    expect(manifest.assets.map((a) => a.assetId)).toContain('labelled');
    expect(manifest.assets.map((a) => a.assetId)).not.toContain('plain');
    expect(manifest.loadable).toEqual([
      { kind: 'audio', id: 'labelled', address: 'sfx/jump', labels: ['level-1', 'sfx'] },
      { kind: 'material', id: 'mat-loadable', labels: ['level-1', 'sfx'] },
    ]);
    // The loadable material ships though nothing draws with it.
    const materials = manifest.contentFiles?.find((f) => f.key === 'materials');
    expect(materials).toBeDefined();
    expect(readFileSync(join(out, materials!.path), 'utf8')).toContain('mat-loadable');

    // Undo takes the address back off; the sidecar follows.
    const undo = await api(`${tb.authUrl}/api/v1/projects/${PID}/commands`, { body: { op: 'undo', projectId: PID, expectedRevision: revision(), requestId: mkRequestId(), origin: { kind: 'mcp', clientId: 'loadable-test' }, args: {} }, token: tb.adminToken, origin: null });
    expect(undo.status, JSON.stringify(undo.json)).toBe(200);
    expect(json(join(dir(), 'assets', 'sfx', 'labelled.wav.tlasset'))).toMatchObject({ address: null, labels: ['level-1', 'sfx'] });
  }, 120_000);

  it('a script naming an asset that is not loadable is a Problem, until the asset gets a label', async () => {
    const r = await command('setScriptLibrary', { libraryId: 'sounds', name: 'Sounds', files: [{ path: 'src/index.ts', text: 'export const HIT = "plain";\nexport const JUMP = "labelled";\n' }] });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    await expect.poll(async () => (await problems()).filter((p) => p.code === 'script_names_unloadable_asset').map((p) => p.message).join('\n'), { timeout: 10_000 }).toContain('"plain" (library sounds (src/index.ts))');
    const lines = (await problems()).filter((p) => p.code === 'script_names_unloadable_asset');
    // The labelled one is loadable: only "plain" is named.
    expect(lines.at(-1)!.message).toContain('A script names an asset that isn\'t loadable');
    expect(lines.at(-1)!.message).not.toContain('"labelled"');
    const count = lines.length;
    expect((await command('setLabels', { items: [{ kind: 'asset', id: 'plain' }], add: ['sfx'] })).status).toBe(200);
    // Nothing new is reported once it is loadable.
    await new Promise((res) => setTimeout(res, 200));
    expect((await problems()).filter((p) => p.code === 'script_names_unloadable_asset')).toHaveLength(count);
  }, 60_000);

  it('a project whose sidecars predate addresses labels the assets its scripts name, once, and reports it', async () => {
    // A project as the engine wrote it before: sidecar format 2 (an address beside the record, none in it).
    const ID = 'legacy-0001';
    /** A copy of a project under another id (its files name their project); `downgrade` writes its sidecars as format 2. */
    const copyAs = (from: string, to: string, downgrade: boolean): void => {
      cpSync(dir(from), dir(to), { recursive: true, filter: (src) => !src.includes('.thirdlight') });
      const rewrite = (abs: string): void => {
        for (const e of readdirSync(abs, { withFileTypes: true })) {
          const p = join(abs, e.name);
          if (e.isDirectory()) {
            if (e.name !== 'cache') rewrite(p);
            continue;
          }
          if (e.name.endsWith('.json')) writeFileSync(p, readFileSync(p, 'utf8').replaceAll(`"${from}"`, `"${to}"`).replaceAll(`${from}@`, `${to}@`));
          if (downgrade && e.name.endsWith('.tlasset')) {
            const doc = json(p) as { record: Record<string, unknown>; labels: string[]; address: string | null };
            const { labels: _l, address: _a, ...record } = doc.record;
            // "labelled" had its address beside the record; nothing had labels yet.
            writeFileSync(p, `${JSON.stringify({ ...doc, tlasset: 2, labels: [], address: record['assetId'] === 'labelled' ? 'sfx/jump' : null, record }, null, 2)}\n`);
          }
        }
      };
      rewrite(dir(to));
    };
    copyAs(PID, ID, true);
    // Resource files predate addresses too: no names beside the records.
    for (const f of ['assets/materials/mat-loadable.material.json']) {
      const doc = json(join(dir(ID), ...f.split('/')));
      const { labels: _l, address: _a, ...rest } = doc;
      writeFileSync(join(dir(ID), ...f.split('/')), `${JSON.stringify(rest, null, 2)}\n`);
    }
    const s = await api(`${tb.authUrl}/api/v1/sessions`, { body: { projectId: ID, sessionId: mkSessionId(), clientInfo: { kind: 'browser', label: 'loadable-upgrade' } }, token: tb.adminToken });
    expect(s.status, JSON.stringify(s.json)).toBe(200);
    const opened = (s.json as { revision: number }).revision;

    // The library names both; "plain" had no names, so it gets the label; "labelled" had an address (now in its record).
    const plain = json(join(dir(ID), 'assets', 'sfx', 'plain.ogg.tlasset'));
    expect(plain).toMatchObject({ tlasset: 3, labels: ['script-named'], record: { labels: ['script-named'] } });
    const labelled = json(join(dir(ID), 'assets', 'sfx', 'labelled.wav.tlasset'));
    expect(labelled).toMatchObject({ tlasset: 3, labels: [], address: 'sfx/jump', record: { address: 'sfx/jump' } });
    expect((labelled['record'] as Record<string, unknown>)['labels']).toBeUndefined();
    const notes = (await problems(ID)).filter((p) => p.code === 'project_upgraded').map((p) => p.message).join('\n');
    expect(notes).toContain('1 asset a script names by id got the label "script-named"');
    expect(json(join(dir(ID), 'upgrade-report.json'))['scriptNamed']).toMatchObject({ label: 'script-named', assets: [{ assetId: 'plain', scripts: ['library sounds (src/index.ts)'] }] });

    // What it shipped before (the scenes' assets) still ships, and now the script-named file too.
    const out = await exportProject(ID);
    expect(readdirSync(join(out, 'content', 'sha256'))).toContain(sha(OPUS));

    // Once: removing the label is not undone by the next open.
    expect((await command('setLabels', { items: [{ kind: 'asset', id: 'plain' }], remove: ['script-named'] }, ID)).status).toBe(200);
    // A later open of that project (a copy opened fresh) keeps it as it is.
    copyAs(ID, 'legacy-0002', false);
    const again = await api(`${tb.authUrl}/api/v1/sessions`, { body: { projectId: 'legacy-0002', sessionId: mkSessionId(), clientInfo: { kind: 'browser', label: 'loadable-upgrade-2' } }, token: tb.adminToken });
    expect(again.status, JSON.stringify(again.json)).toBe(200);
    expect((again.json as { revision: number }).revision).toBe(revision(ID));
    expect(json(join(dir('legacy-0002'), 'assets', 'sfx', 'plain.ogg.tlasset'))).toMatchObject({ tlasset: 3, labels: [] });
    expect((await problems('legacy-0002')).filter((p) => p.code === 'project_upgraded')).toEqual([]);
    expect(opened).toBeGreaterThan(0);
  }, 120_000);
});
