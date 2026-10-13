/**
 * The kit checks against the trim sheet spec: a piece's placement, size,
 * levels, collision and UVs from its file; a sheet's table and pixels
 * (gutters, seams at the wraps, height in A).
 */
import { describe, expect, it } from 'vitest';

import { bakedDecalMaterialName, decalClipGlb } from './decal-clip-glb';
import { kitCheckTally, kitPieceChecks, pieceFacts, trimSpecChecks, type KitCheck } from './kit-checks';
import { defaultTrimSheet, trimRowOf, trimRowV, type TrimSheet } from './trim-sheet';

/** A 1 × 2 m slab (door-sized, 0.1 m deep) as a GLB of one node, its front face's v inside `vRange`. */
function slab(name: string, opts: { dx?: number; vRange: [number, number] }): Uint8Array {
  const dx = opts.dx ?? 0;
  const x0 = -0.5 + dx, x1 = 0.5 + dx;
  const positions = new Float32Array([x0, 0, 0.05, x1, 0, 0.05, x1, 2, 0.05, x0, 2, 0.05, x0, 0, -0.05, x1, 2, -0.05]);
  const [v0, v1] = opts.vRange;
  const uvs = new Float32Array([0, v1, 0.25, v1, 0.25, v0, 0, v0, 0, v1, 0.25, v0]);
  const vc = positions.length / 3;
  return decalClipGlb({ positions, normals: new Float32Array(vc * 3).fill(0), uvs, tangents: new Float32Array(vc * 4), fades: new Float32Array(vc).fill(1), index: new Uint16Array([0, 1, 2, 0, 2, 3, 4, 5, 1]) }, { name, materialId: 'wood' });
}

const SHEET = defaultTrimSheet();
const FRAME_V = trimRowV(SHEET, trimRowOf(SHEET, 'frame')!);
const ctx = { slot: 'door', sheet: { materialId: 'trim', trim: SHEET }, materials: { [bakedDecalMaterialName('wood')]: 'trim' } };
const byId = (checks: KitCheck[]): Record<string, string> => Object.fromEntries(checks.map((c) => [c.id, c.state]));

describe('kit piece checks', () => {
  it('a centred piece on one row passes placement, size and UVs; levels and collision are flagged', () => {
    const f = pieceFacts(slab('door', { vRange: FRAME_V }), 'door');
    expect(f.found).toBe(true);
    expect(f.bounds!.max[1]).toBe(2);
    expect(f.bounds!.min[0]).toBe(-0.5);
    expect(byId(kitPieceChecks(f, ctx))).toEqual({ origin: 'ok', transform: 'ok', size: 'ok', collision: 'warn', lods: 'warn', uvs: 'ok', colour: 'ok' });
  });

  it('an origin off the bottom centre and UVs across two rows fail', () => {
    const f = pieceFacts(slab('door', { dx: 0.4, vRange: [FRAME_V[0], FRAME_V[1] + 0.05] }), 'door');
    const checks = kitPieceChecks(f, ctx);
    expect(byId(checks)).toMatchObject({ origin: 'err', uvs: 'err' });
    expect(checks.find((c) => c.id === 'origin')!.detail).toContain('0.40 m right (+X)');
    expect(kitCheckTally(checks)).toMatchObject({ state: 'err', errors: 2 });
  });

  it('a piece the file lacks, an unmapped material (with its fix), a kit without a sheet', () => {
    const bytes = slab('door', { vRange: FRAME_V });
    expect(kitPieceChecks(pieceFacts(bytes, 'window'), ctx)).toEqual([expect.objectContaining({ id: 'file', state: 'err', detail: expect.stringContaining('door') })]);
    const unmapped = kitPieceChecks(pieceFacts(bytes, 'door'), { ...ctx, materials: {} }).find((c) => c.id === 'uvs')!;
    expect(unmapped).toMatchObject({ state: 'info', fix: { kind: 'map-material', source: 'wood_decal', material: 'trim' } });
    expect(kitPieceChecks(pieceFacts(bytes, 'door'), { slot: 'door' }).find((c) => c.id === 'uvs')!.state).toBe('info');
    expect(kitPieceChecks(pieceFacts(new Uint8Array(8)), ctx)[0]).toMatchObject({ id: 'file', state: 'err' });
  });

  it('a file too large for the UV check says its UVs were not checked (never ok)', () => {
    const f = pieceFacts(slab('door', { vRange: [FRAME_V[0], FRAME_V[1] + 0.05] }), 'door');
    expect(f.uvSkipped).toBe(false);
    // As a file over the UV check's triangle budget reads: its v ranges stop being collected.
    const big = { ...f, uvSkipped: true, surfaces: f.surfaces.map((s) => ({ ...s, v: [] })) };
    expect(kitPieceChecks(big, ctx).find((c) => c.id === 'uvs')).toMatchObject({ state: 'info', title: 'UVs not checked' });
  });
});

/** A sheet image made to its table: every row a pattern that repeats 4× across and (fields) in v, gutters filled, height in A. */
function sheetImage(sheet: TrimSheet): Uint8Array {
  const [w, h] = sheet.size;
  const rgba = new Uint8Array(w * h * 4);
  const put = (x: number, y: number, r: (typeof sheet.rows)[number], ly: number): void => {
    const rows = r.bottom - r.top;
    const t = (2 * Math.PI * 4 * x) / w;
    const s = r.tileV === true ? (2 * Math.PI * ly) / rows : ly / rows;
    const o = (y * w + x) * 4;
    rgba[o] = 128 + Math.round(60 * Math.sin(t));
    rgba[o + 1] = 128 + Math.round(60 * Math.cos(s * 2));
    rgba[o + 2] = 100;
    rgba[o + 3] = 60 + Math.round(80 * (1 + Math.sin(t + s)));
  };
  for (const r of sheet.rows) {
    const rows = r.bottom - r.top;
    for (let y = r.top - sheet.padding; y < r.bottom + sheet.padding; y++) {
      const ly = y < r.top ? (r.tileV === true ? rows - ((r.top - y - 1) % rows) - 1 : 0) : y >= r.bottom ? (r.tileV === true ? (y - r.bottom) % rows : rows - 1) : y - r.top;
      for (let x = 0; x < w; x++) put(x, y, r, ly);
    }
  }
  return rgba;
}

describe('trim spec checks', () => {
  it('the spec sheet passes its table checks; the pixels wait for Check all', () => {
    const r = trimSpecChecks(SHEET);
    expect(r.checks.filter((c) => c.state !== 'ok').map((c) => c.id)).toEqual(['pixels']);
    expect(r.rows.map((x) => x.slot)).toEqual(SHEET.rows.map((x) => x.slot));
  });

  it('a small sheet with thin gutters and a row off the grid', () => {
    const sheet: TrimSheet = { size: [1024, 1024], texelDensity: 256, padding: 4, rows: [{ slot: 'floor', top: 4, bottom: 132, tileV: true }, { slot: 'edge', top: 140, bottom: 236 }] };
    const r = trimSpecChecks(sheet);
    expect(byId(r.checks)).toMatchObject({ size: 'warn', gutters: 'warn', 'row:floor': 'err', 'row:edge': 'err', slots: 'warn' });
    expect(r.checks.find((c) => c.id === 'row:edge')!.title).toBe('edge starts at 140 px');
  });

  it('pixels: a clean image passes; a broken wrap, a stale gutter and an opaque A are flagged on their rows', () => {
    const img = sheetImage(SHEET);
    const clean = trimSpecChecks(SHEET, { rgba: img, width: 2048, height: 2048, tolerance: 8 });
    expect(clean.checks.filter((c) => c.state !== 'ok')).toEqual([]);
    const crown = trimRowOf(SHEET, 'crown')!;
    const floor = trimRowOf(SHEET, 'floor')!;
    // The crown row ramps left to right (its right edge never meets its left), its A opaque.
    for (let y = crown.top - 8; y < crown.bottom + 8; y++) for (let x = 0; x < 2048; x++) {
      img[(y * 2048 + x) * 4] = Math.floor((x / 2048) * 255);
      img[(y * 2048 + x) * 4 + 3] = 255;
    }
    // The floor's top gutter is painted over.
    for (let x = 0; x < 2048; x++) img[((floor.top - 3) * 2048 + x) * 4 + 2] = 250;
    const r = trimSpecChecks(SHEET, { rgba: img, width: 2048, height: 2048, tolerance: 8 });
    expect(byId(r.checks)).toMatchObject({ 'seam-u:crown': 'warn', 'gutter:floor:above': 'warn', height: 'warn' });
    expect(r.checks.find((c) => c.id === 'height')!.title).toBe('No height in A on crown');
    expect(r.rows.find((x) => x.slot === 'crown')!.state).toBe('warn');
    expect(r.rows.find((x) => x.slot === 'upper_wall')!.state).toBe('ok');
  });
});
