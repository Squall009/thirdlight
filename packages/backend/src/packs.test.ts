/**
 * The engine's Basic Kit pack, as files and over HTTP:
 *
 * - the pack resolves: `pack.json` reads, every file matches its digest;
 * - its trim sheet passes the trim sheet spec's checklist as the kit editor
 *   runs it (project-model `trimSpecChecks`: size, density, gutters, the
 *   standard slots at their bounds, safe mip level, gutters repeating their
 *   rows within the compression's tolerance, no seams, height in A), with
 *   KTX2 maps of the sheet's size (albedo sRGB, normal and ORM linear);
 * - the door and window pass the kit's piece checks (`kitPieceChecks`:
 *   origin at the bottom centre, transforms applied, whole cells, `_COL`,
 *   LOD0..2, trim UVs inside one row, no vertex colours), within their
 *   triangle budgets;
 * - `POST …/packs/basic-kit` adds it to a project as ordinary items (the
 *   assets published and inspected, the material, presets, block types and
 *   the kit) as one undo (and redo) step, the kit's references all resolve,
 *   a second add is refused, and the kit check (`GET …/kits/basic-kit/check`)
 *   finds its pieces and sheet to the spec.
 */
import { resolve } from 'node:path';

import type { MaterialDef } from '@thirdlight/project-model';
import { kitProblems } from '@thirdlight/project-model/kits';
import { kitPieceChecks, pieceFacts, trimSpecChecks, type KitCheckReport } from '@thirdlight/project-model/kit-checks';
import { TRIM_STARTER_ROWS, type TrimSheet } from '@thirdlight/project-model/trim-sheet';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { KTX2_TRANSFER_SRGB, readKtx2 } from './ktx2-container';
import { listPacks, loadPack, type Pack } from './packs';
import { api, startBackend, type TestBackend } from './test-helpers';
import { decodeTextureRgba } from './texture-encode';

const REPO = resolve(import.meta.dirname, '..', '..', '..');
const loaded = loadPack(REPO, 'basic-kit');
if (!loaded.ok) throw new Error(loaded.message);
const PACK: Pack = loaded.pack;
const FILES = loaded.files;
const fileOf = (assetId: string): Uint8Array => FILES.get(PACK.assets.find((a) => a.assetId === assetId)!.file)!;
const MATERIAL = (PACK.commands.find((c) => c.op === 'setMaterial')!.args['material'] as MaterialDef);
const SHEET = MATERIAL.trim as TrimSheet;

describe('the Basic Kit pack', () => {
  it('resolves: listed, every file present with its digest, inside the download target', () => {
    expect(listPacks(REPO).map((p) => p.packId)).toContain('basic-kit');
    const total = PACK.assets.reduce((n, a) => n + a.bytes, 0);
    // The kit's sheet and pieces download in at most 4 MB.
    expect(total).toBeLessThanOrEqual(4_000_000);
    expect(PACK.commands.map((c) => c.op)).toEqual(['setMaterial', ...Array(6).fill('setGraph'), ...Array(7).fill('setBlockType'), 'setKit']);
  });

  it('has a trim sheet made to the spec', async () => {
    expect(SHEET.realHeight).toBe(true);
    // The engine's starter rows are the spec's table.
    for (const r of TRIM_STARTER_ROWS) expect(SHEET.rows.find((x) => x.slot === r.slot), r.slot).toEqual(r);
    for (const id of [MATERIAL.textures['map']!, MATERIAL.textures['normalMap']!, MATERIAL.textures['ormMap']!]) {
      const k = readKtx2(fileOf(id))!;
      expect([k.width, k.height], id).toEqual([2048, 2048]);
      expect(k.levels.length, id).toBe(12);
      expect(k.transfer === KTX2_TRANSFER_SRGB, id).toBe(id === MATERIAL.textures['map']);
    }
    const albedo = await decodeTextureRgba(fileOf(MATERIAL.textures['map']!), 2048 * 2048);
    if (!albedo.ok) throw new Error(albedo.message);
    // The spec's checklist, as the kit editor runs it: gutters within what ETC1S moves.
    const report = trimSpecChecks(SHEET, { rgba: albedo.data, width: albedo.width, height: albedo.height, tolerance: 24 });
    expect(report.checks.filter((c) => c.state !== 'ok')).toEqual([]);
    expect(report.rows.every((r) => r.state === 'ok')).toBe(true);
  });

  for (const [assetId, piece, budget] of [['basic-door', 'door', 500], ['basic-window', 'window', 400]] as const) {
    it(`${piece}: passes the kit's piece checks within its triangle budget`, () => {
      const facts = pieceFacts(fileOf(assetId), piece);
      const asset = PACK.assets.find((a) => a.assetId === assetId)!;
      const checks = kitPieceChecks(facts, { slot: piece, sheet: { materialId: MATERIAL.materialId, trim: SHEET }, materials: asset.materials! });
      expect(checks.filter((c) => c.state !== 'ok')).toEqual([]);
      expect(checks.map((c) => c.id)).toEqual(['origin', 'transform', 'size', 'collision', 'lods', 'uvs', 'colour']);
      expect(facts.lods).toEqual([0, 1, 2]);
      expect(facts.triangles[0]).toBeLessThanOrEqual(budget);
      expect(facts.triangles[1]).toBeLessThan(facts.triangles[0]!);
      expect(facts.triangles[2]).toBeLessThanOrEqual(facts.triangles[1]!);
    });
  }
});

describe('adding the Basic Kit to a project over HTTP', () => {
  let tb: TestBackend;
  const P = 'demo-0001';
  beforeAll(async () => {
    tb = await startBackend({ engineRoot: REPO });
  });
  afterAll(async () => {
    await tb.teardown();
  });
  const post = async (path: string, body: unknown = {}): Promise<{ status: number; json: Record<string, any> }> => {
    const r = await api(`${tb.authUrl}${path}`, { body, token: tb.authToken, origin: null });
    return { status: r.status, json: r.json as Record<string, any> };
  };

  it('adds every item once, the kit resolving; a second add is refused', async () => {
    const listed = await api(`${tb.authUrl}/api/v1/packs`, { method: 'GET', token: tb.authToken, origin: null });
    expect((listed.json as { packs: { packId: string }[] }).packs.map((p) => p.packId)).toContain('basic-kit');
    const r = await post(`/api/v1/projects/${P}/packs/basic-kit`, { origin: { kind: 'mcp', clientId: 'packs-test' } });
    expect(r.status, JSON.stringify(r.json).slice(0, 600)).toBe(200);
    expect(r.json['added'].length).toBe(PACK.assets.length + 2 + PACK.commands.length);
    const q = await post(`/api/v1/projects/${P}/commands`, { op: 'queryProject', projectId: P, args: {} });
    const content = await api(`${tb.authUrl}/api/v1/projects/${P}/content/assets`, { method: 'GET', token: tb.authToken, origin: null });
    const assets = (content.json as { assets?: { assetId: string; materials?: Record<string, string> }[]; entries?: { assetId: string }[] });
    const ids = (assets.assets ?? assets.entries ?? []).map((a) => a.assetId);
    for (const a of PACK.assets) expect(ids, a.assetId).toContain(a.assetId);
    expect(Number(q.json['revision'])).toBe(r.json['revision']);
    const captured = tb.backend._test.service.readCapturedV3(P);
    if (!captured.ok) throw new Error('no project');
    const c = captured.read.content as unknown as Record<string, any>;
    expect(c['kits'].map((k: { kitId: string }) => k.kitId)).toEqual(['basic-kit']);
    expect(c['blockTypes'].length).toBe(7);
    expect(c['assets'].find((a: { assetId: string }) => a.assetId === 'basic-door').materials).toEqual({ trim: 'basic-trim' });
    expect(kitProblems(c as never)).toEqual([]);
    // The whole pack is one undo step, and one redo.
    const kitsNow = (): string[] => {
      const read = tb.backend._test.service.readCapturedV3(P);
      return read.ok ? ((read.read.content as unknown as { kits?: { kitId: string }[] }).kits ?? []).map((k) => k.kitId) : [];
    };
    const assetsNow = (): string[] => {
      const read = tb.backend._test.service.readCapturedV3(P);
      return read.ok ? ((read.read.content as unknown as { assets?: { assetId: string }[] }).assets ?? []).map((a) => a.assetId) : [];
    };
    const step = async (op: 'undo' | 'redo', expectedRevision: number, n: string): Promise<number> => {
      const u = await post(`/api/v1/projects/${P}/commands`, { op, projectId: P, expectedRevision, requestId: `req-${n.repeat(32)}`, args: {} });
      expect(u.status, JSON.stringify(u.json).slice(0, 300)).toBe(200);
      return Number(u.json['revision']);
    };
    const undone = await step('undo', r.json['revision'], 'a');
    expect(undone).toBe(r.json['revision'] + r.json['added'].length);
    expect(kitsNow()).toEqual([]);
    expect(assetsNow().filter((id) => id.startsWith('basic-'))).toEqual([]);
    await step('redo', undone, 'b');
    expect(kitsNow()).toEqual(['basic-kit']);
    expect(assetsNow()).toContain('basic-door');
    const again = await post(`/api/v1/projects/${P}/packs/basic-kit`);
    expect(again.status).toBe(409);
    expect(again.json['error'].code).toBe('pack_present');
    // The kit editor's check of it: both pieces and the sheet (its pixels read) meet the spec.
    const check = await api(`${tb.authUrl}/api/v1/projects/${P}/kits/basic-kit/check?image=1`, { method: 'GET', token: tb.authToken, origin: null });
    expect(check.status, JSON.stringify(check.json).slice(0, 300)).toBe(200);
    const report = check.json as KitCheckReport;
    expect(report.pieces.map((p) => [p.slot, p.piece, p.checks.filter((c) => c.state !== 'ok').map((c) => c.id)])).toEqual([['door', 'door', []], ['window', 'window', []]]);
    expect(report.sheet?.imageRead).toBe(true);
    expect(report.sheet?.report.checks.filter((c) => c.state !== 'ok')).toEqual([]);
    expect((await api(`${tb.authUrl}/api/v1/projects/${P}/kits/nope/check`, { method: 'GET', token: tb.authToken, origin: null })).status).toBe(404);
    // Each piece's size, which an opening sized to the piece takes: the door 1 × 2 m, the window 1 × 1 m.
    expect(report.pieces.map((p) => p.size?.slice(0, 2))).toEqual([[1, 2], [1, 1]]);
  });

  it('makes the commands of one editor action one undo step, only when nothing ran between them', async () => {
    const graph = (graphId: string): Record<string, unknown> => ({ graph: { graphId, kind: 'architecture-preset', name: graphId, graph: { nodes: [{ id: 'preset', type: 'preset', position: [0, 0], data: { style: '', base: 'starter-room', sheet: '' } }], edges: [] } } });
    const graphsNow = (): string[] => {
      const read = tb.backend._test.service.readCapturedV3(P);
      return read.ok ? ((read.read.content as unknown as { graphs?: { graphId: string }[] }).graphs ?? []).map((g) => g.graphId).filter((id) => id.startsWith('grp-')) : [];
    };
    let rev = Number((await post(`/api/v1/projects/${P}/commands`, { op: 'queryProject', projectId: P, args: {} })).json['revision']);
    const run = async (id: string, n: string): Promise<string> => {
      const requestId = `req-${n.repeat(32)}`;
      const r = await post(`/api/v1/projects/${P}/commands`, { op: 'setGraph', projectId: P, expectedRevision: rev, requestId, args: graph(id) });
      expect(r.status, JSON.stringify(r.json).slice(0, 300)).toBe(200);
      rev = Number(r.json['revision']);
      return requestId;
    };
    const ids = [await run('grp-a', 'c'), await run('grp-b', 'd')];
    // Out of order, or not the last entries: refused, nothing grouped.
    expect((await post(`/api/v1/projects/${P}/history/group`, { requestIds: [ids[1], ids[0]] })).status).toBe(409);
    expect((await post(`/api/v1/projects/${P}/history/group`, { requestIds: ['x'] })).status).toBe(400);
    expect((await post(`/api/v1/projects/${P}/history/group`, { requestIds: ids })).status).toBe(200);
    const undo = await post(`/api/v1/projects/${P}/commands`, { op: 'undo', projectId: P, expectedRevision: rev, requestId: `req-${'e'.repeat(32)}`, args: {} });
    expect(undo.status).toBe(200);
    expect(graphsNow()).toEqual([]);
    rev = Number(undo.json['revision']);
    // A command of someone else between two: they stay apart.
    const c = await run('grp-c', 'f');
    await post(`/api/v1/projects/${P}/commands`, { op: 'setGraph', projectId: P, expectedRevision: rev, requestId: `req-${'1'.repeat(32)}`, args: graph('other') }).then((r) => (rev = Number(r.json['revision'])));
    const d = await run('grp-d', '2');
    expect((await post(`/api/v1/projects/${P}/history/group`, { requestIds: [c, d] })).status).toBe(409);
  });
});
