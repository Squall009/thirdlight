/**
 * Imported models' distance-field bricks, over HTTP against the real backend
 * and the real disk: an imported model gets its bricks made right after the
 * import and kept in the project's import cache; an export ships them beside
 * the models a scene places static (the catalog's model row names the file,
 * the cached one), and not for a model placed movable.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { modelBricksBlob, modelBricksKey } from '@thirdlight/exporter';

import { api, mkRequestId, startBackend, type TestBackend } from './test-helpers';

const REPO = resolve(import.meta.dirname, '..', '..', '..');
const GLB = readFileSync(join(REPO, 'templates', 'starter', 'assets', 'Character.glb'));
const PID = 'demo-0001';

/** Every object with a `bricks` entry in the export's JSON files (the catalog's are content files, some gzipped). */
function rowsWithBricks(dir: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) for (const x of v) visit(x);
    else if (v !== null && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (o['bricks'] !== undefined && typeof o['assetId'] === 'string') out.push(o);
      for (const x of Object.values(o)) visit(x);
    }
  };
  const walk = (d: string): void => {
    for (const e of readdirSync(d)) {
      const full = join(d, e);
      if (statSync(full).isDirectory()) walk(full);
      else {
        let bytes: Uint8Array = readFileSync(full);
        if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes);
        if (bytes[0] !== 0x7b && bytes[0] !== 0x5b) continue;
        try {
          visit(JSON.parse(new TextDecoder().decode(bytes)) as unknown);
        } catch {
          // Not JSON (a model, a buffer).
        }
      }
    }
  };
  walk(dir);
  return out;
}

describe('imported models get distance-field bricks', () => {
  let tb: TestBackend;
  let exportRoot: string;
  const game = (...rel: string[]): string => join(tb.root, 'data', 'projects', PID, ...rel);
  const revision = (): number => {
    const r = tb.backend._test.service.readCapturedV3(PID);
    if (!r.ok) throw new Error(r.error.code);
    return r.read.revision;
  };
  const command = async (op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const r = await api(`${tb.authUrl}/api/v1/projects/${PID}/commands`, { body: { op, projectId: PID, expectedRevision: revision(), requestId: mkRequestId(), origin: { kind: 'mcp', clientId: 'model-bricks-test' }, args }, token: tb.adminToken, origin: null });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    return r.json as Record<string, unknown>;
  };
  let assetId = '';
  let sourceDigest = '';
  let stored: Uint8Array = new Uint8Array(0);

  beforeAll(async () => {
    exportRoot = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'tl-model-bricks-'));
    tb = await startBackend({ exportRoot, engineRoot: REPO });
    mkdirSync(game('assets', 'models'), { recursive: true });
    writeFileSync(game('assets', 'models', 'character.glb'), GLB);
    await command('importAssets', { folder: 'assets/models' });
    const assets = (tb.backend._test.service.query({ op: 'queryAssets', projectId: PID, args: { limit: 50, offset: 0 } }) as unknown as { assets: { assetId: string; kind: string; currentVersion: number; versions?: { version: number; sourceDigest: string }[] }[] }).assets;
    const model = assets.find((a) => a.kind === 'model')!;
    assetId = model.assetId;
    const read = tb.backend._test.service.readBlob(PID, { assetId, version: model.currentVersion });
    if (!read.ok) throw new Error(read.error.code);
    sourceDigest = read.digest;
    stored = read.bytes;
  }, 120_000);
  afterAll(async () => {
    await tb.teardown();
    rmSync(exportRoot, { recursive: true, force: true });
  });

  it('makes them right after the import, into the import cache', async () => {
    await tb.backend._test.modelBricks.idle();
    const file = tb.backend._test.service.locateImportedArtifact(PID, modelBricksKey(sourceDigest));
    expect(file).not.toBeNull();
    // The model file's own bricks (their decoding is the tracer's test), made from the stored model.
    const made = modelBricksBlob(stored);
    expect(made.ok && made.bytes !== null).toBe(true);
    expect(new Uint8Array(readFileSync(file!.real))).toEqual(made.ok ? made.bytes : null);
  });

  it("serves a version's file to the editor's Scene view, made again when the cache lost it", async () => {
    await tb.backend._test.modelBricks.idle();
    const versions = (tb.backend._test.service.query({ op: 'queryAssets', projectId: PID, args: { assetId, includeVersions: true, limit: 1, offset: 0 } }) as unknown as { assets: { currentVersion: number }[] }).assets;
    const url = `${tb.authUrl}/api/v1/projects/${PID}/content/assets/${assetId}/versions/${versions[0]!.currentVersion}/bricks`;
    const read = async (token: string | null): Promise<Response> => fetch(url, { headers: token === null ? {} : { authorization: `Bearer ${token}` } });
    expect((await read(null)).status).toBe(401);
    const cached = tb.backend._test.service.locateImportedArtifact(PID, modelBricksKey(sourceDigest))!;
    const res = await read(tb.adminToken);
    expect(res.status).toBe(200);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes).toEqual(new Uint8Array(readFileSync(cached.real)));
    // The model file's own bricks (made from the stored model, as the import made them).
    const made = modelBricksBlob(stored);
    expect(made.ok ? made.bytes : null).toEqual(bytes);
    // A cache without the file (an import before bricks existed): the read makes it.
    rmSync(cached.real);
    const again = await read(tb.adminToken);
    expect(again.status).toBe(200);
    expect(new Uint8Array(await again.arrayBuffer())).toEqual(bytes);
    const missing = await fetch(`${tb.authUrl}/api/v1/projects/${PID}/content/assets/no-such-model/versions/1/bricks`, { headers: { authorization: `Bearer ${tb.adminToken}` } });
    expect(missing.status).toBeGreaterThanOrEqual(400);
  }, 120_000);

  it('ships them with a model placed static, and not with one placed movable', async () => {
    const exportNow = async (): Promise<string> => {
      const r = await api(`${tb.authUrl}/api/v1/admin/projects/${PID}/export`, { body: {}, token: tb.adminToken, origin: null });
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      return join(exportRoot, String((r.json as { outputDir: string }).outputDir));
    };
    const id = String((await command('createEntity', { sceneId: 'scene-main', kind: 'model', name: 'Statue', model: { asset: { assetId } } }))['createdId']);
    expect(rowsWithBricks(await exportNow())).toEqual([]);
    await command('updateEntity', { entityId: id, static: true });
    const out = await exportNow();
    const rows = rowsWithBricks(out).filter((r) => r['assetId'] === assetId);
    expect(rows.length).toBeGreaterThan(0);
    const b = rows[0]!['bricks'] as { path: string; digest: string; byteLength: number };
    const bytes = new Uint8Array(readFileSync(join(out, b.path)));
    expect(bytes.byteLength).toBe(b.byteLength);
    const cached = tb.backend._test.service.locateImportedArtifact(PID, modelBricksKey(sourceDigest))!;
    expect(b.digest).toBe(cached.digest);
    expect(bytes).toEqual(new Uint8Array(readFileSync(cached.real)));
  }, 240_000);
});
