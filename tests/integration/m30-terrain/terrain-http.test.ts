/**
 * Terrain over HTTP against the real backend and disk: a terrain made with
 * setComponent, sculpted with editTerrain (the result names the tiles it
 * wrote; the tiles are content-addressed blobs read back by digest), read with
 * queryTerrain, undone and redone (the tiles' old digests come back), a RAW
 * heightmap uploaded and imported, a digest that is no tile refused, and the
 * export shipping the tile blobs in manifest.buffers, which the game page's
 * loader reads back to the same heights.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadTerrainField } from '../../../packages/game-host/src/terrain-tiles';
import { api, mkRequestId, startBackend, type TestBackend } from '../../../packages/backend/src/test-helpers';

const REPO = resolve(import.meta.dirname, '..', '..', '..');
const PID = 'demo-0001';
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
type Json = Record<string, unknown>;
type Terrain = { tileSamples: number; spacing: number; heightRange: [number, number]; tiles: { x: number; z: number; data?: string }[] };

describe('terrain over HTTP', () => {
  let tb: TestBackend;
  let exportRoot: string;
  let ground = '';
  const revision = (): number => {
    const r = tb.backend._test.service.readCapturedV3(PID);
    if (!r.ok) throw new Error(r.error.code);
    return r.read.revision;
  };
  const command = (op: string, args: Json) =>
    api(`${tb.authUrl}/api/v1/projects/${PID}/commands`, { body: { op, projectId: PID, expectedRevision: revision(), requestId: mkRequestId(), origin: { kind: 'mcp', clientId: 'terrain-test' }, args }, token: tb.adminToken, origin: null });
  const query = async (args: Json): Promise<Json> => {
    const r = await api(`${tb.authUrl}/api/v1/projects/${PID}/commands`, { body: { op: 'queryTerrain', projectId: PID, args }, token: tb.adminToken, origin: null });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    return r.json as Json;
  };
  const heightAt = async (x: number, z: number): Promise<number | null> => ((await query({ entityId: ground, points: [[x, z]] }))['points'] as { height: number | null }[])[0]!.height;
  const terrainNow = async (): Promise<Terrain> => (await query({ entityId: ground }))['component'] as Terrain;

  beforeAll(async () => {
    exportRoot = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'tl-terrain-'));
    tb = await startBackend({ exportRoot, engineRoot: REPO });
    const made = await command('createEntity', { sceneId: 'scene-main', kind: 'group', name: 'Ground' });
    expect(made.status, JSON.stringify(made.json)).toBe(200);
    ground = (made.json as { createdId: string }).createdId;
    const moved = await command('setTransform', { entityId: ground, transform: { position: [100, 2, -40] } });
    expect(moved.status, JSON.stringify(moved.json)).toBe(200);
    const set = await command('setComponent', { entityId: ground, component: 'terrain', value: { tileSamples: 65, spacing: 1, heightRange: [-32, 96], tiles: [{ x: 0, z: 0 }, { x: 1, z: 0 }] } });
    expect(set.status, JSON.stringify(set.json)).toBe(200);
  }, 120_000);
  afterAll(async () => {
    await tb.teardown();
    rmSync(exportRoot, { recursive: true, force: true });
  });

  it('sculpts in one command, names the tiles it wrote, stores them as blobs; undo and redo swap the digests', async () => {
    expect(await heightAt(164, -30)).toBeCloseTo(2, 3);
    const r = await command('editTerrain', { entityId: ground, kind: 'raise', dabs: [[164, -30]], radius: 6, strength: 3 });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const body = r.json as { terrain: { tiles: number[][]; added: number[][]; changed: number }; change: { type: string; next: Terrain } };
    expect(body.change.type).toBe('setComponent');
    expect(body.terrain.tiles).toEqual([[0, 0], [1, 0]]);
    expect(body.terrain.added).toEqual([]);
    expect(body.terrain.changed).toBeGreaterThan(50);
    const digests = body.change.next.tiles.map((t) => t.data);
    expect(digests.every((d) => typeof d === 'string')).toBe(true);
    // Each tile is a blob read back by its digest (the editor's and MCP's reader).
    for (const d of digests) {
      const res = await fetch(`${tb.authUrl}/api/v1/projects/${PID}/content/buffers/${d}`, { headers: { authorization: `Bearer ${tb.adminToken}` } });
      expect(res.status).toBe(200);
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect(sha(bytes)).toBe(d);
      expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe('TLTR');
    }
    expect(await heightAt(164, -30)).toBeCloseTo(5, 2);
    const list = (await query({}))['terrains'] as Json[];
    expect(list).toEqual([expect.objectContaining({ entityId: ground, tileSamples: 65, tiles: 2, tilesWithData: 2, memoryBytes: 2 * 65 * 65 * 2 })]);
    expect((list[0]!['storedBytes'] as number) < 2 * 65 * 65 * 2).toBe(true);

    expect((await command('undo', {})).status).toBe(200);
    expect((await terrainNow()).tiles).toEqual([{ x: 0, z: 0 }, { x: 1, z: 0 }]);
    expect(await heightAt(164, -30)).toBeCloseTo(2, 3);
    expect((await command('redo', {})).status).toBe(200);
    expect((await terrainNow()).tiles.map((t) => t.data)).toEqual(digests);
    expect(await heightAt(164, -30)).toBeCloseTo(5, 2);
  }, 120_000);

  it('imports an uploaded RAW heightmap onto a new tile; a digest that is no stored tile is refused', async () => {
    const side = 65;
    const raw = new Uint8Array(side * side * 2);
    for (let z = 0; z < side; z++) for (let x = 0; x < side; x++) new DataView(raw.buffer).setUint16((z * side + x) * 2, 30000 + x * 100, true);
    const stage = await api(`${tb.authUrl}/api/v1/projects/${PID}/content/stages`, { body: {}, token: tb.adminToken, origin: null });
    expect(stage.status, JSON.stringify(stage.json)).toBe(200);
    const stageId = (stage.json as { stageId: string }).stageId;
    const up = await fetch(`${tb.authUrl}/api/v1/projects/${PID}/content/stages/${stageId}/bytes`, { method: 'PUT', headers: { authorization: `Bearer ${tb.adminToken}`, 'content-type': 'application/octet-stream', 'x-thirdlight-offset': '0', 'x-thirdlight-total': String(raw.length) }, body: raw });
    expect(up.status).toBe(200);
    const r = await command('editTerrain', { entityId: ground, kind: 'import', stageId, format: 'raw16', at: [0, 1] });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((r.json as { terrain: { added: number[][] } }).terrain.added).toEqual([[0, 1]]);
    // Sample (10, 70) is pixel (10, 6) of the image: 30000 + 1000 steps of the range above the object at y 2.
    expect(await heightAt(110, 30)).toBeCloseTo(2 - 32 + (31000 / 65535) * 128, 2);

    const t = await terrainNow();
    const bad = await command('setComponent', { entityId: ground, component: 'terrain', value: { tiles: [...t.tiles, { x: 5, z: 5, data: 'e'.repeat(64) }] } });
    expect(bad.status).not.toBe(200);
    expect(JSON.stringify(bad.json)).toMatch(/blob_missing/);
  }, 120_000);

  it('the export ships the tile blobs as buffers and the game page reads the same heights', async () => {
    const r = await api(`${tb.authUrl}/api/v1/admin/projects/${PID}/export`, { body: {}, token: tb.adminToken, origin: null });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const out = join(exportRoot, String((r.json as { outputDir: string }).outputDir));
    // The catalog's buffer table (a block file of the manifest's catalog) lists each tile; the bytes ship under their digest.
    const files = (r.json as { files: Record<string, number> }).files;
    const t = await terrainNow();
    const tileDigests = t.tiles.map((x) => x.data).filter((d): d is string => d !== undefined);
    // Catalog block files are JSON stored under their digests too.
    const catalogText = Object.keys(files).filter((f) => f.startsWith('content/sha256/') && !tileDigests.includes(f.slice('content/sha256/'.length))).map((f) => readFileSync(join(out, f))).filter((b) => b[0] === 0x7b || b[0] === 0x5b).map((b) => b.toString('utf8')).join('\n');
    expect(tileDigests.length).toBe(3);
    for (const d of tileDigests) {
      expect(catalogText).toContain(d);
      const bytes = readFileSync(join(out, 'content', 'sha256', d));
      expect(files[`content/sha256/${d}`]).toBe(bytes.length);
      expect(sha(bytes)).toBe(d);
    }
    // The scene file a game reads names the same tiles.
    const sceneFile = readdirSync(join(out, 'scenes')).map((f) => JSON.parse(readFileSync(join(out, 'scenes', f), 'utf8')) as { entities: { id: string; components: { terrain?: Terrain; transform?: { position: number[] } } }[] }).find((s) => s.entities.some((e) => e.id === ground))!;
    const entity = sceneFile.entities.find((e) => e.id === ground)!;
    expect(entity.components.terrain).toEqual(t);
    const field = await loadTerrainField(entity.components.terrain!, entity.components.transform!.position, async (digest) => {
      const b = readFileSync(join(out, 'content', 'sha256', digest));
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    });
    for (const [x, z] of [[164, -30], [110, 30], [130, -10]] as const) expect(field.heightAt(x, z)).toBeCloseTo((await heightAt(x, z))!, 5);
    expect(field.memory().tiles).toBe(3);
  }, 240_000);
});
