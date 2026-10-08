/**
 * Terrain over HTTP against the real backend and disk: a terrain made with
 * setComponent, sculpted with editTerrain (the result names the tiles it
 * wrote; the tiles are content-addressed blobs read back by digest), read with
 * queryTerrain, undone and redone (the tiles' old digests come back), a RAW
 * heightmap uploaded and imported, a digest that is no tile refused, edit
 * layers (a stamp from a texture asset placed by setComponent, the ground
 * combined again; an erode on a rectangle stored as an erosion layer; undo),
 * and the export shipping the tile blobs in manifest.buffers — the combined
 * heights only, no layers or hand-made tiles — which the game page's loader
 * reads back to the same heights; and blocks on terrain (a blocks layer: the
 * ground meets a block area, a block edit's follow-up re-bakes it in the same
 * command and undo step, the export keeps the layer's settings).
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadTerrainField } from '../../../packages/game-host/src/terrain-tiles';
import { terrainOverviewOf, terrainTileOf } from '../../../packages/runtime/src/terrain-blob';
import { makePng } from '../../e2e/png-make';
import { api, mkRequestId, startBackend, type TestBackend } from '../../../packages/backend/src/test-helpers';

const REPO = resolve(import.meta.dirname, '..', '..', '..');
const PID = 'demo-0001';
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
type Json = Record<string, unknown>;
type Terrain = { tileSamples: number; spacing: number; heightRange: [number, number]; tiles: { x: number; z: number; data?: string; base?: string }[]; layers?: { id: string; kind: string; tiles?: { data: string }[] }[] };

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

  it('edit layers: a stamp raises the ground where it lies, an erode on a rectangle is kept as a layer, undo takes it back', async () => {
    // A cone (64², 8-bit) as a texture asset: the stamp's shape.
    const png = new Uint8Array(makePng(64, 64, (x, y) => {
      const v = Math.round(Math.max(0, 1 - Math.hypot(x - 31.5, y - 31.5) / 31.5) * 255);
      return [v, v, v, 255];
    }));
    const headers = { authorization: `Bearer ${tb.adminToken}` };
    const stage = await api(`${tb.authUrl}/api/v1/projects/${PID}/content/stages`, { body: {}, token: tb.adminToken, origin: null });
    const stageId = (stage.json as { stageId: string }).stageId;
    await fetch(`${tb.authUrl}/api/v1/projects/${PID}/content/stages/${stageId}/bytes`, { method: 'PUT', headers: { ...headers, 'content-type': 'application/octet-stream', 'x-thirdlight-offset': '0', 'x-thirdlight-total': String(png.length) }, body: png });
    const inspected = await api(`${tb.authUrl}/api/v1/projects/${PID}/content/stages/${stageId}/inspect`, { body: { kind: 'texture' }, token: tb.adminToken, origin: null });
    const p = (inspected.json as { proposal: Json }).proposal;
    const pub = await command('publishAsset', { mode: 'create', assetId: 'cone', kind: 'texture', displayName: 'Cone', sourceDigest: p['sourceDigest'], sourceByteLength: p['sourceByteLength'], importRecipe: p['importRecipe'], metrics: p['metrics'], importedAt: '2026-01-01T00:00:00Z' });
    expect(pub.status, JSON.stringify(pub.json)).toBe(200);

    const centre: [number, number] = [132, -8];
    const ground0 = (await heightAt(...centre))!;
    const far = (await heightAt(110, -30))!;
    const r = await command('setComponent', { entityId: ground, component: 'terrain', value: { layers: [{ id: 'peaks', kind: 'stamps', stamps: [{ asset: 'cone', at: centre, size: 30, height: 20, falloff: 0 }] }] } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    // One command: the layer and the ground combined again under it.
    expect((await heightAt(...centre))! - ground0).toBeCloseTo(20, 0);
    expect(await heightAt(110, -30)).toBe(far);
    const t1 = await terrainNow();
    expect(t1.tiles.filter((t) => t.base !== undefined).map((t) => [t.x, t.z])).toEqual([[0, 0]]);

    // Erosion over a square on the cone's flank: stored as a layer, the ground changed only inside it.
    const flank: [number, number] = [centre[0] + 8, centre[1]];
    const before = await query({ entityId: ground, points: [flank, [centre[0] - 10, centre[1]], [centre[0] + 12, centre[1]]] });
    const e = await command('editTerrain', { entityId: ground, kind: 'erode', rect: [centre[0] + 2, centre[1] - 8, centre[0] + 14, centre[1] + 8], hydraulic: { droplets: 2 }, thermal: { iterations: 20, talus: 30 }, seed: 3 });
    expect(e.status, JSON.stringify(e.json)).toBe(200);
    const t2 = await terrainNow();
    const erosion = t2.layers!.find((l) => l.kind === 'erosion')!;
    expect(erosion.id).toBe('erosion');
    expect(erosion.tiles!.length).toBe(1);
    const after = await query({ entityId: ground, points: [flank, [centre[0] - 10, centre[1]], [centre[0] + 12, centre[1]]] });
    const hs = (q: Json): (number | null)[] => (q['points'] as { height: number | null }[]).map((x) => x.height);
    expect(hs(after)[0]).not.toBe(hs(before)[0]);
    expect(hs(after)[1]).toBe(hs(before)[1]);
    // Undo: the erosion layer and its ground go; redo brings them back.
    expect((await command('undo', {})).status).toBe(200);
    expect((await terrainNow()).layers!.some((l) => l.kind === 'erosion')).toBe(false);
    expect(hs(await query({ entityId: ground, points: [flank] }))[0]).toBe(hs(before)[0]);
    expect((await command('redo', {})).status).toBe(200);
    expect(hs(await query({ entityId: ground, points: [flank] }))[0]).toBe(hs(after)[0]);
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
    // The stack is the editor's: no hand-made tile or erosion blob ships.
    const editorOnly = [...t.tiles.map((x) => x.base), ...(t.layers ?? []).flatMap((l) => (l.tiles ?? []).map((x) => x.data))].filter((d): d is string => d !== undefined);
    expect(editorOnly.length).toBeGreaterThan(1);
    for (const d of editorOnly) expect(files[`content/sha256/${d}`]).toBeUndefined();
    for (const d of tileDigests) {
      expect(catalogText).toContain(d);
      const bytes = readFileSync(join(out, 'content', 'sha256', d));
      expect(files[`content/sha256/${d}`]).toBe(bytes.length);
      expect(sha(bytes)).toBe(d);
    }
    // The scene file a game reads names the same tiles.
    const sceneFile = readdirSync(join(out, 'scenes')).map((f) => JSON.parse(readFileSync(join(out, 'scenes', f), 'utf8')) as { entities: { id: string; components: { terrain?: Terrain; transform?: { position: number[] } } }[] }).find((s) => s.entities.some((e) => e.id === ground))!;
    const entity = sceneFile.entities.find((e) => e.id === ground)!;
    expect(entity.components.terrain).toEqual({ ...(({ layers: _l, ...rest }) => rest)(t), tiles: t.tiles.map(({ base: _b, ...tile }) => tile) });
    const field = await loadTerrainField(entity.components.terrain!, entity.components.transform!.position, async (digest) => {
      const b = readFileSync(join(out, 'content', 'sha256', digest));
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    });
    for (const [x, z] of [[164, -30], [110, 30], [130, -10]] as const) expect(field.heightAt(x, z)).toBeCloseTo((await heightAt(x, z))!, 5);
    expect(field.memory().tiles).toBe(3);
    // Not streamed: no overview.
    expect((entity.components.terrain as { overview?: string }).overview).toBeUndefined();
  }, 240_000);

  it('a streamed terrain ships its overview (every tile at its coarsest level) beside its tiles; the editor stores none', async () => {
    const set = await command('setComponent', { entityId: ground, component: 'terrain', value: { streaming: { render: 300, collision: 40 } } });
    expect(set.status, JSON.stringify(set.json)).toBe(200);
    const t = await terrainNow();
    expect((t as { streaming?: unknown }).streaming).toEqual({ render: 300, collision: 40 });
    expect((t as { overview?: string }).overview).toBeUndefined();
    const r = await api(`${tb.authUrl}/api/v1/admin/projects/${PID}/export`, { body: {}, token: tb.adminToken, origin: null });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const out = join(exportRoot, String((r.json as { outputDir: string }).outputDir));
    const files = (r.json as { files: Record<string, number> }).files;
    const sceneFile = readdirSync(join(out, 'scenes')).map((f) => JSON.parse(readFileSync(join(out, 'scenes', f), 'utf8')) as { entities: { id: string; components: { terrain?: Terrain & { overview?: string } } }[] }).find((s) => s.entities.some((e) => e.id === ground))!;
    const shipped = sceneFile.entities.find((e) => e.id === ground)!.components.terrain!;
    const digest = shipped.overview!;
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    const bytes = readFileSync(join(out, 'content', 'sha256', digest));
    expect(files[`content/sha256/${digest}`]).toBe(bytes.length);
    expect(sha(bytes)).toBe(digest);
    // Read as the page reads it: one 17² tile per tile with data, its heights the full tile's every (65 − 1) / 16th sample.
    const overview = await terrainOverviewOf(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    const withData = shipped.tiles.filter((x) => x.data !== undefined);
    expect(overview.map((o) => `${o.x},${o.z}`).sort()).toEqual(withData.map((x) => `${x.x},${x.z}`).sort());
    for (const o of overview) {
      const d = withData.find((x) => x.x === o.x && x.z === o.z)!.data!;
      const b = readFileSync(join(out, 'content', 'sha256', d));
      const full = await terrainTileOf(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
      for (const [i, j] of [[0, 0], [16, 16], [5, 11]] as const) expect(o.tile.heights[j * 17 + i]).toBe(full.heights[j * 4 * 65 + i * 4]);
    }
    const off = await command('setComponent', { entityId: ground, component: 'terrain', value: { streaming: null } });
    expect(off.status, JSON.stringify(off.json)).toBe(200);
  }, 240_000);

  it('blocks on terrain: a blocks layer meets a block area, a block edit at its border re-bakes the ground in the same command, the export keeps the layer\'s settings', async () => {
    // A 6 × 6 block area two rows high (its top 2 m over the object at y 2, so 4 m), its corner on the terrain's samples.
    const made = await command('createEntity', { sceneId: 'scene-main', kind: 'group', name: 'Area' });
    expect(made.status, JSON.stringify(made.json)).toBe(200);
    const area = (made.json as { createdId: string }).createdId;
    expect((await command('setTransform', { entityId: area, transform: { position: [140, 2, -30] } })).status).toBe(200);
    expect((await command('setBlockType', { block: { blockId: 'rock', name: 'Rock', variants: [{ color: '#808080' }], shape: 'full' } })).status).toBe(200);
    expect((await command('setComponent', { entityId: area, component: 'blockLayer', value: { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [8, 4, 8] } } })).status).toBe(200);
    expect((await command('editBlocks', { entityId: area, edits: [{ kind: 'fill', box: [0, 0, 0, 6, 2, 6], cell: { block: 'rock' } }] })).status).toBe(200);
    const before = await terrainNow();
    // One command: the layer stored, the ground round the area and under it combined again.
    const set = await command('setComponent', { entityId: ground, component: 'terrain', value: { layers: [...(before.layers ?? []), { id: 'blocks', kind: 'blocks', blockLayers: [area], blend: 3 }] } });
    expect(set.status, JSON.stringify(set.json)).toBe(200);
    expect(await heightAt(143, -30), 'the border: the area\'s top').toBeCloseTo(4, 2);
    expect(await heightAt(146, -27), 'the +x border').toBeCloseTo(4, 2);
    expect((await query({ entityId: ground, points: [[143, -27]] }))['points']).toEqual([expect.objectContaining({ height: null, hole: true })]);
    const t1 = await terrainNow();
    expect((t1 as { uvOrigin?: number[] }).uvOrigin, 'textures counted from the area\'s origin').toEqual([140, -30]);
    // A column on the border raised a row: the same command follows the terrain there.
    const edit = await command('editBlocks', { entityId: area, edits: [{ kind: 'fill', box: [2, 2, 0, 4, 3, 1], cell: { block: 'rock' } }] });
    expect(edit.status, JSON.stringify(edit.json)).toBe(200);
    expect((edit.json as { change: { follows?: { entityId: string; component: string }[] } }).change.follows?.map((f) => `${f.entityId}:${f.component}`)).toEqual([`${ground}:terrain`]);
    expect(await heightAt(143, -30), 'the raised columns\' own border corner').toBeCloseTo(5, 2);
    expect(await heightAt(142, -30), 'the corner they share with the low columns').toBeCloseTo(4, 2);
    // Undo takes both back.
    expect((await command('undo', {})).status).toBe(200);
    expect(await heightAt(143, -30)).toBeCloseTo(4, 2);
    // One surface query: the area's tops where the ground is cut away under them, the terrain round them (as a game's ctx.surface).
    const surface = async (args: Json): Promise<{ status: number; json: Json }> => (await api(`${tb.authUrl}/api/v1/projects/${PID}/commands`, { body: { op: 'querySurface', projectId: PID, args }, token: tb.adminToken, origin: null })) as { status: number; json: Json };
    const asked = await surface({ points: [[143.5, -27.5], [148.5, -27.5], [143.5, 3, -27.5], [143.5, 0, -27.5]] });
    expect(asked.status, JSON.stringify(asked.json)).toBe(200);
    const pts = asked.json['points'] as { surface: { source: string; object: string; height: number; layers: number[]; weights: number[]; cell?: number[]; block?: string } | null }[];
    expect(pts[0]!.surface).toMatchObject({ source: 'blocks', object: area, height: 4, cell: [3, 1, 2], block: 'rock', layers: [0], weights: [1] });
    expect(pts[1]!.surface).toMatchObject({ source: 'terrain', object: ground });
    expect(pts[1]!.surface!.height).toBeCloseTo((await heightAt(148.5, -27.5))!, 6);
    expect(pts[2]!.surface, 'inside the blocks: their top').toMatchObject({ source: 'blocks', height: 4 });
    expect(pts[3]!.surface, 'under the area, in the cut-away ground: none').toBeNull();
    expect((await surface({ points: [[1, 2, 3, 4]] })).status).toBe(400);
    expect((await surface({ points: [[0, 0]], sceneId: 'no-such-scene' })).status).toBe(400);
    // The export: the blocks layer ships (its settings only, for the ground cover), the other layers and hand-made tiles do not.
    const r = await api(`${tb.authUrl}/api/v1/admin/projects/${PID}/export`, { body: {}, token: tb.adminToken, origin: null });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const out = join(exportRoot, String((r.json as { outputDir: string }).outputDir));
    const sceneFile = readdirSync(join(out, 'scenes')).map((f) => JSON.parse(readFileSync(join(out, 'scenes', f), 'utf8')) as { entities: { id: string; components: { terrain?: Terrain & { uvOrigin?: number[] } } }[] }).find((sc) => sc.entities.some((e) => e.id === ground))!;
    const shipped = sceneFile.entities.find((e) => e.id === ground)!.components.terrain!;
    expect(shipped.layers).toEqual([{ id: 'blocks', kind: 'blocks', blockLayers: [area], blend: 3 }]);
    expect(shipped.uvOrigin).toEqual([140, -30]);
    expect(shipped.tiles.every((x) => x.base === undefined)).toBe(true);
  }, 240_000);
});
