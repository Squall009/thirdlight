import { describe, expect, it } from 'vitest';

import { MAX_TEXTURE_EDGE } from './content-limits';
import {
  canonicalTrimSheet,
  defaultTrimSheet,
  equalTrimRows,
  TRIM_STARTER_LAYOUT,
  trimLayoutMissing,
  trimMaxFootprint,
  trimPaddingProblems,
  trimRowMetres,
  trimRowOf,
  trimRowV,
  trimRunMapping,
  trimSafeMipLevel,
  trimSheetErrors,
  trimSheetFromLayout,
  trimCellMetres,
  trimCellOf,
  trimSheetMipLevels,
  trimSheetProblems,
  trimSheetSafeMipLevel,
  trimU,
  trimV,
  writeTrimStripUvs,
  writeTrimVertexColour,
  type TrimRow,
  type TrimSheet,
} from './trim-sheet';

/** Unequal rows on a 256² sheet: a tall panel, two thin trims, a medium band (padding 4). */
const UNEQUAL: TrimSheet = {
  size: [256, 256],
  texelDensity: 128,
  padding: 4,
  rows: [
    { slot: 'lower_wall', top: 4, bottom: 124 },
    { slot: 'baseboard', top: 132, bottom: 148 },
    { slot: 'crown', top: 156, bottom: 164, texelDensity: 64 },
    { slot: 'floor', top: 172, bottom: 252, tileV: true },
  ],
};

/**
 * What a strip of each row reads at each mip level, by brute force: the
 * sheet's pixel rows as one-hot owners (a row's band with its padding is the
 * row's; the rest is nobody's), box-filtered down the chain as the GPU's mips
 * are, then sampled bilinearly (wrapping in v) at the strip's inset edges.
 * Returns, per row, the deepest level at which every read is the row's own.
 */
function bruteSafeLevels(sheet: TrimSheet): number[] {
  const h = sheet.size[1];
  const owners = sheet.rows.length + 1;
  const nobody = sheet.rows.length;
  const owner = new Int32Array(h).fill(-1);
  // A pixel two padded rows claim holds nobody's colour for sure.
  sheet.rows.forEach((r, i) => {
    for (let y = Math.max(0, r.top - sheet.padding); y < Math.min(h, r.bottom + sheet.padding); y++) owner[y] = owner[y] === -1 ? i : nobody;
  });
  for (let y = 0; y < h; y++) if (owner[y] === -1) owner[y] = nobody;
  let level: Float64Array[] = Array.from({ length: h }, (_, y) => Float64Array.from({ length: owners }, (_, k) => (k === owner[y] ? 1 : 0)));
  const chain: Float64Array[][] = [level];
  while (level.length > 1) {
    const next: Float64Array[] = [];
    for (let i = 0; i < level.length / 2; i++) next.push(level[2 * i]!.map((v, k) => (v + level[2 * i + 1]![k]!) / 2));
    chain.push(next);
    level = next;
  }
  return sheet.rows.map((r, i) => {
    const [v0, v1] = trimRowV(sheet, r);
    let safe = -1;
    for (let l = 0; l < chain.length; l++) {
      const texels = chain[l]!;
      const pure = [v0, v1].every((v) => {
        const yl = v * texels.length - 0.5;
        const i0 = Math.floor(yl);
        const f = yl - i0;
        const at = (k: number): Float64Array => texels[((k % texels.length) + texels.length) % texels.length]!;
        const read = at(i0).map((x, k) => x * (1 - f) + at(i0 + 1)[k]! * f);
        return read.every((x, k) => (k === i ? x > 1 - 1e-9 : x < 1e-9));
      });
      if (!pure) break;
      safe = l;
    }
    return safe;
  });
}

describe('trim sheet row table', () => {
  it('accepts equal and unequal rows and refuses malformed tables', () => {
    expect(trimSheetErrors(defaultTrimSheet())).toEqual([]);
    expect(trimSheetErrors(UNEQUAL)).toEqual([]);
    const bad = (patch: Record<string, unknown>): string[] => trimSheetErrors({ ...UNEQUAL, ...patch }).map((e) => e.path);
    expect(bad({ size: [0, 256] })).toEqual(['/size']);
    // A sheet larger than a texture may be is refused where it is declared, in the table and in an imported layout alike.
    expect(bad({ size: [MAX_TEXTURE_EDGE * 2, MAX_TEXTURE_EDGE * 2] })).toEqual(['/size']);
    expect(bad({ size: [MAX_TEXTURE_EDGE, MAX_TEXTURE_EDGE] })).toEqual([]);
    expect(trimSheetFromLayout({ format: 'trim/1', size: [MAX_TEXTURE_EDGE * 2, MAX_TEXTURE_EDGE * 2], texel_density_px_per_m: 256, gutter_px: 8, layers: [] }).ok).toBe(false);
    expect(bad({ padding: 1.5 })).toEqual(['/padding']);
    expect(bad({ texelDensity: 0 })).toEqual(['/texelDensity']);
    expect(bad({ rows: [] })).toEqual(['/rows']);
    expect(bad({ rows: [{ slot: 'a', top: 10, bottom: 10 }] })).toEqual(['/rows/0/bottom']);
    expect(bad({ rows: [{ slot: 'a', top: 0, bottom: 257 }] })).toEqual(['/rows/0/bottom']);
    expect(bad({ rows: [{ slot: 'a', top: 0, bottom: 20 }, { slot: 'a', top: 30, bottom: 40 }] })).toEqual(['/rows/1/slot']);
    expect(bad({ rows: [{ slot: 'a', top: 30, bottom: 50 }, { slot: 'b', top: 0, bottom: 31 }] })).toEqual(['/rows/0/top']);
    expect(bad({ rows: [{ slot: 'Bad Slot', top: 0, bottom: 20 }] })).toEqual(['/rows/0/slot']);
    expect(bad({ extra: 1 })).toEqual(['/extra']);
  });

  it('splits a sheet into equal rows with their padding, in canonical order', () => {
    const rows = equalTrimRows(1024, ['a', 'b', 'c', 'd'], 8);
    expect(rows).toEqual([
      { slot: 'a', top: 8, bottom: 248 },
      { slot: 'b', top: 264, bottom: 504 },
      { slot: 'c', top: 520, bottom: 760 },
      { slot: 'd', top: 776, bottom: 1016 },
    ]);
    // Too many rows for the padding: the padding shrinks so each row keeps a pixel.
    expect(equalTrimRows(8, ['a', 'b', 'c', 'd'], 8).every((r) => r.bottom > r.top)).toBe(true);
    const shuffled = { ...UNEQUAL, rows: [...UNEQUAL.rows].reverse() };
    expect(canonicalTrimSheet(shuffled)).toEqual(UNEQUAL);
    expect(defaultTrimSheet().rows.map((r) => r.slot).sort()).toEqual([...TRIM_STARTER_LAYOUT].sort());
  });

  it('a new sheet is the spec: 2048², 512 px/m, rows at their real heights in 16 px aligned bands, drawn at real height', () => {
    const s = defaultTrimSheet();
    expect([s.size, s.texelDensity, s.padding, s.realHeight]).toEqual([[2048, 2048], 512, 8, true]);
    const metres = Object.fromEntries(s.rows.map((r) => [r.slot, trimRowMetres(s, r)]));
    expect(metres).toEqual({ floor: 1, upper_wall: 1, lower_wall: 0.5, baseboard: 0.15625, crown: 0.125, frame: 0.125, column: 0.25, bevel: 0.0625, emissive: 0.125 });
    for (const r of s.rows) {
      expect((r.bottom - r.top) % 16).toBe(0);
      expect((r.top - s.padding) % 16).toBe(0);
    }
    expect(s.rows.filter((r) => r.tileV === true).map((r) => r.slot)).toEqual(['floor', 'upper_wall', 'lower_wall', 'column', 'bevel']);
    expect(trimSheetProblems(s)).toEqual([]);
    expect(trimSheetSafeMipLevel(s)).toBe(4);
    // The flag is stored only when on: a sheet saved before it keeps its bytes.
    expect(canonicalTrimSheet(s).realHeight).toBe(true);
    expect('realHeight' in canonicalTrimSheet({ ...s, realHeight: false })).toBe(false);
    expect(trimSheetErrors({ ...s, realHeight: 'yes' }).map((e) => e.path)).toEqual(['/realHeight']);
  });
});

describe('a row over a run (trimRunMapping)', () => {
  const sheet = defaultTrimSheet();
  const row = (slot: string): TrimRow => trimRowOf(sheet, slot)!;
  /** Where across its row a run shows each place (metres from its start), with the repeat holding the place's neighbourhood. */
  const across = (m: ReturnType<typeof trimRunMapping>, d: number, towardStart = false): number => m.acrossAt(d, m.stackAt(towardStart ? d - 1e-6 : d + 1e-6));

  it('without realHeight fits a part to whole rows, stretched (stored sheets keep their look)', () => {
    const legacy = { ...sheet, realHeight: undefined };
    // A 0.9 m dado on a 0.5 m row: two repeats of 0.45 m; the top of the part shows the row's top.
    const m = trimRunMapping(legacy, row('lower_wall'), 0.9, false);
    expect([m.stacks, m.boundaries]).toEqual([2, [0.45]]);
    expect(across(m, 0)).toBeCloseTo(1);
    expect(across(m, 0.45, true)).toBeCloseTo(0);
    expect(across(m, 0.9, true)).toBeCloseTo(0);
    // A trim three times its row is stacked three times.
    expect(trimRunMapping(legacy, row('baseboard'), 0.47, false).stacks).toBe(3);
  });

  it('a field repeats at its own height from the lower end, the last repeat cut where the run ends', () => {
    // 2.1 m of upper wall on a 1 m row, run upward: repeats at 1 and 2 m, 0.1 m of a third at the top.
    const up = trimRunMapping(sheet, row('upper_wall'), 2.1, false);
    expect(up.stacks).toBe(3);
    expect(up.boundaries.map((b) => +b.toFixed(9))).toEqual([1, 2]);
    expect(across(up, 0)).toBeCloseTo(1);
    expect(across(up, 0.5)).toBeCloseTo(0.5);
    expect(across(up, 1, true)).toBeCloseTo(0);
    expect(across(up, 1)).toBeCloseTo(1);
    // The cut repeat continues the one below (the row tiles in v): 0.1 m into it is 0.1 of the row up from its bottom.
    expect(across(up, 2.1, true)).toBeCloseTo(0.9);
    // The same run walked from the top down: counted from its lower end all the same.
    const down = trimRunMapping(sheet, row('upper_wall'), 2.1, true);
    expect(down.boundaries.map((b) => +b.toFixed(9))).toEqual([0.1, 1.1]);
    expect(across(down, 2.1, true)).toBeCloseTo(1);
    expect(across(down, 0)).toBeCloseTo(0.9);
    // Whole repeats exactly: 3 m on 1 m, no sliver.
    expect(trimRunMapping(sheet, row('upper_wall'), 3.0000001, false).stacks).toBe(3);
  });

  it('a trim is drawn once: fitted within the tolerance, else at its own height from the top', () => {
    // 0.15 m on the 0.15625 m baseboard: within 5 %, fitted.
    const fit = trimRunMapping(sheet, row('baseboard'), 0.15, false);
    expect([fit.stacks, fit.boundaries]).toEqual([1, []]);
    expect(across(fit, 0.15, true)).toBeCloseTo(0);
    expect(across(fit, 0)).toBeCloseTo(1);
    // 0.3 m: the row's own 0.15625 m at the top, its bottom edge carried on below.
    const tall = trimRunMapping(sheet, row('baseboard'), 0.3, false);
    expect(tall.boundaries.map((b) => +b.toFixed(9))).toEqual([0.14375]);
    expect(across(tall, 0.3, true)).toBeCloseTo(0);
    expect(across(tall, 0.3 - 0.078125)).toBeCloseTo(0.5);
    expect(across(tall, 0.1)).toBe(1);
    expect(across(tall, 0)).toBe(1);
    // 0.05 m: the row's top 0.05 m (a third of it), not squashed.
    const short = trimRunMapping(sheet, row('baseboard'), 0.05, false);
    expect(across(short, 0)).toBeCloseTo(0.05 / 0.15625);
    // A curved moulding's row is painted to wrap its curve: fitted whatever its length.
    expect(trimRunMapping(sheet, row('crown'), 0.4, false, true).boundaries).toEqual([]);
    expect(across(trimRunMapping(sheet, row('crown'), 0.4, false, true), 0.2)).toBeCloseTo(0.5);
  });

  it('a sheet conforms to a layout when it has every slot', () => {
    expect(trimLayoutMissing(defaultTrimSheet(), TRIM_STARTER_LAYOUT)).toEqual([]);
    expect(trimLayoutMissing(UNEQUAL, ['floor', 'baseboard', 'frame'])).toEqual(['frame']);
    expect(trimRowOf(UNEQUAL, 'crown')?.top).toBe(156);
    expect(trimRowOf(UNEQUAL, 'nope')).toBeNull();
  });
});

describe('trim strip coordinates', () => {
  it('insets v by half a texel at the row edges and runs u in metres at the row density', () => {
    const crown = trimRowOf(UNEQUAL, 'crown')!;
    expect(trimRowV(UNEQUAL, crown)).toEqual([156.5 / 256, 163.5 / 256]);
    expect(trimV(UNEQUAL, crown, 0)).toBe(156.5 / 256);
    expect(trimV(UNEQUAL, crown, 1)).toBe(163.5 / 256);
    expect(trimV(UNEQUAL, crown, 2)).toBe(163.5 / 256);
    // 64 px/m on a 256 px sheet: one repeat every 4 m; the sheet's 128 px/m elsewhere: every 2 m.
    expect(trimU(UNEQUAL, crown, 4)).toBe(1);
    expect(trimU(UNEQUAL, trimRowOf(UNEQUAL, 'floor')!, 4)).toBe(2);
    // Square texels: the crown is 8 px at 64 px/m = 0.125 m tall.
    expect(trimRowMetres(UNEQUAL, crown)).toBe(0.125);
    // A one-pixel row samples its pixel centre at both edges.
    const thin: TrimSheet = { ...UNEQUAL, rows: [{ slot: 'line', top: 10, bottom: 11 }] };
    expect(trimRowV(thin, thin.rows[0]!)).toEqual([10.5 / 256, 10.5 / 256]);
  });

  it('writes a strip into flat arrays and packs vertex colours', () => {
    const floor = trimRowOf(UNEQUAL, 'floor')!;
    const uv = new Float32Array(10);
    writeTrimStripUvs(UNEQUAL, floor, [0, 1, 1, 0], [0, 0, 1, 1], uv, 2);
    const [v0, v1] = trimRowV(UNEQUAL, floor);
    expect([...uv]).toEqual([0, 0, 0, v0, 0.5, v0, 0.5, v1, 0, v1].map((x) => Math.fround(x)));
    const c = new Float32Array(8);
    writeTrimVertexColour(c, 1, 0.25, 2, -1);
    expect([...c]).toEqual([0, 0, 0, 0, 0.25, 1, 0, 1]);
  });
});

describe('mip bleed bounds', () => {
  it('the safe level per row matches a brute-force box-mip and bilinear simulation', () => {
    const sheets: TrimSheet[] = [
      UNEQUAL,
      defaultTrimSheet(),
      { size: [256, 256], texelDensity: 128, padding: 0, rows: equalTrimRows(256, ['a', 'b', 'c', 'd'], 0) },
      { size: [256, 256], texelDensity: 128, padding: 2, rows: equalTrimRows(256, ['a', 'b', 'c'], 2) },
      { size: [512, 128], texelDensity: 128, padding: 8, rows: [{ slot: 'a', top: 8, bottom: 40 }, { slot: 'b', top: 51, bottom: 77 }, { slot: 'c', top: 90, bottom: 120 }] },
    ];
    for (const s of sheets) {
      const brute = bruteSafeLevels(s);
      // A chain the sheet's width reaches past its height: those levels are 1 texel tall (every row reads everything).
      const rowsLevels = Math.floor(Math.log2(s.size[1])) + 1;
      s.rows.forEach((r, i) => expect(Math.min(trimSafeMipLevel(s, r), rowsLevels - 1), `${r.slot}`).toBe(Math.max(0, brute[i]!)));
    }
  });

  it('padding raises the safe level; the sheet takes its worst row', () => {
    // 4 rows of 64 px: 4 px of padding is safe to level 3 (8 px texels aligned with the bands), 8 px to level 4.
    const four = (padding: number): TrimSheet => ({ size: [256, 256], texelDensity: 128, padding, rows: equalTrimRows(256, ['a', 'b', 'c', 'd'], padding) });
    expect(trimSheetSafeMipLevel(four(0))).toBe(0);
    expect(trimSheetSafeMipLevel(four(4))).toBe(3);
    expect(trimSheetSafeMipLevel(four(8))).toBe(4);
    expect(trimMaxFootprint(four(4))).toBe(8);
    // The unequal sheet: the 8 px crown is the limit.
    const levels = UNEQUAL.rows.map((r) => trimSafeMipLevel(UNEQUAL, r));
    expect(trimSheetSafeMipLevel(UNEQUAL)).toBe(Math.min(...levels));
    expect(trimSheetMipLevels(UNEQUAL)).toBe(9);
  });

  it('warns about missing or thin padding and a shallow safe level', () => {
    expect(trimSheetProblems(defaultTrimSheet())).toEqual([]);
    const tight: TrimSheet = { size: [256, 256], texelDensity: 128, padding: 4, rows: [{ slot: 'a', top: 2, bottom: 100 }, { slot: 'b', top: 104, bottom: 250 }] };
    const msgs = trimSheetProblems(tight).map((p) => `${p.slot}: ${p.message}`);
    expect(msgs.some((m) => m.startsWith('a: its padding above runs off'))).toBe(true);
    expect(msgs.some((m) => m.startsWith('a: 4 px to "b"'))).toBe(true);
    expect(msgs.some((m) => m.startsWith('null: mip levels past'))).toBe(true);
    expect(trimSheetProblems({ ...tight, padding: 0 }).some((p) => p.message.startsWith('no padding'))).toBe(true);
    expect(trimSheetProblems({ ...defaultTrimSheet(), size: [1000, 1024] }).some((p) => p.message.includes('powers of two'))).toBe(true);
  });
});

describe('padding pixels', () => {
  /** A 16 × 64 sheet: row a (solid red, its edges repeated), row b (a ramp that tiles in v, its padding the wrap). */
  const sheet: TrimSheet = { size: [16, 64], texelDensity: 16, padding: 4, rows: [{ slot: 'a', top: 4, bottom: 24 }, { slot: 'b', top: 32, bottom: 56, tileV: true }] };
  const image = (): Uint8Array => {
    const px = new Uint8Array(16 * 64 * 4);
    const set = (y: number, v: [number, number, number]): void => {
      for (let x = 0; x < 16; x++) px.set([...v, 255], (y * 16 + x) * 4);
    };
    const ramp = (y: number): [number, number, number] => [0, 40 + ((y - 32) * 8), 0];
    for (let y = 0; y < 28; y++) set(y, [220, 10, 10]);
    for (let y = 32; y < 56; y++) set(y, ramp(y));
    // b tiles in v: the padding above continues from its bottom, below from its top.
    for (let k = 1; k <= 4; k++) {
      set(32 - k, ramp(56 - k));
      set(55 + k, ramp(32 + k - 1));
    }
    return px;
  };

  it('a sheet whose padding repeats its edges (or wrap) passes', () => {
    expect(trimPaddingProblems(image(), 16, 64, sheet)).toEqual([]);
  });

  it('padding that differs from the row is found, per side, with its worst pixel row', () => {
    const px = image();
    // Row a's lowest padding row is the next row's colour (a sheet packed without padding).
    for (let x = 0; x < 16; x++) px.set([0, 0, 200, 255], (27 * 16 + x) * 4);
    expect(trimPaddingProblems(px, 16, 64, sheet)).toEqual([{ slot: 'a', side: 'below', y: 27, difference: 220 }]);
    // Lossy compression's small changes stay under the tolerance.
    const noisy = image();
    noisy[(2 * 16 + 5) * 4] = 214;
    expect(trimPaddingProblems(noisy, 16, 64, sheet)).toEqual([]);
    // Edge repeat where the row tiles in v is wrong.
    const edge = image();
    for (let x = 0; x < 16; x++) edge.set([0, 40, 0, 255], (31 * 16 + x) * 4);
    expect(trimPaddingProblems(edge, 16, 64, sheet)[0]).toMatchObject({ slot: 'b', side: 'above', y: 31 });
  });
});

describe('Texture Designer layout import', () => {
  it('reads strip layers as rows and decal layers as named cells', () => {
    const layout = {
      format: 'trim/1',
      size: [1024, 512],
      texel_density_px_per_m: 512,
      gutter_px: 8,
      layers: [
        { name: 'plaster_field', kind: 'tile_uv', px: [8, 264] },
        { name: 'coping', kind: 'tile_u', px: [280, 376] },
        { name: 'decals', kind: 'decals', px: [392, 504], cells: [{ name: 'window_round', px_rect: [8, 392, 112, 112], size_m: [0.21875, 0.21875] }, { name: 'crack', px_rect: [136, 392, 64, 64] }] },
        { name: 'notes', kind: 'text' },
      ],
    };
    const r = trimSheetFromLayout(layout);
    // The designer paints rows at their real height: the imported table draws them so.
    const sheet = { size: [1024, 512], texelDensity: 512, padding: 8, rows: [{ slot: 'plaster_field', top: 8, bottom: 264, tileV: true }, { slot: 'coping', top: 280, bottom: 376 }], cells: [{ name: 'window_round', rect: [8, 392, 112, 112] }, { name: 'crack', rect: [136, 392, 64, 64] }], realHeight: true };
    expect(r).toEqual({ ok: true, skipped: ['notes'], sheet });
    expect(trimCellMetres(sheet as TrimSheet, trimCellOf(sheet as TrimSheet, 'window_round')!)).toEqual([0.21875, 0.21875]);
    // A decal layer without cells adds no cells key: a sheet without them keeps its bytes.
    const bare = trimSheetFromLayout({ ...layout, layers: layout.layers.slice(0, 2).concat([{ name: 'decals', kind: 'decals', px: [392, 504], cells: [] }]) });
    expect(bare.ok && 'cells' in bare.sheet).toBe(false);
    // A cell off the sheet fails the import.
    const off = trimSheetFromLayout({ ...layout, layers: [...layout.layers.slice(0, 2), { name: 'decals', kind: 'decals', cells: [{ name: 'big', px_rect: [1000, 0, 64, 64] }] }] });
    expect(off).toEqual({ ok: false, message: 'layout.json: /cells/0/rect the cell runs off the 1024 × 512 sheet' });
    expect(trimSheetFromLayout({ format: 'tdg/1' }).ok).toBe(false);
    expect(trimSheetFromLayout({ ...layout, layers: [{ name: 'Bad Name', kind: 'tile_u', px: [0, 10] }] }).ok).toBe(false);
  });
});

describe('decal cells', () => {
  const base: TrimSheet = { size: [256, 128], texelDensity: 128, padding: 4, rows: [{ slot: 'floor', top: 4, bottom: 60 }] };
  it('are named rectangles inside the sheet, names unique; the table keeps their order and drops an empty list', () => {
    const sheet: TrimSheet = { ...base, cells: [{ name: 'stain', rect: [128, 64, 64, 64] }, { name: 'crack', rect: [0, 64, 64, 32] }] };
    expect(trimSheetErrors(sheet)).toEqual([]);
    expect(canonicalTrimSheet(sheet).cells!.map((c) => c.name)).toEqual(['stain', 'crack']);
    expect('cells' in canonicalTrimSheet({ ...base, cells: [] })).toBe(false);
    expect(canonicalTrimSheet(base)).toEqual(base);
    const msgs = (cells: unknown): string[] => trimSheetErrors({ ...base, cells } as unknown as TrimSheet).map((e) => `${e.path} ${e.message}`);
    expect(msgs([{ name: 'a', rect: [0, 0, 8, 8] }, { name: 'a', rect: [8, 0, 8, 8] }])).toEqual(['/cells/1/name cell "a" is listed twice']);
    expect(msgs([{ name: 'a', rect: [250, 0, 8, 8] }])).toEqual(['/cells/0/rect the cell runs off the 256 × 128 sheet']);
    expect(msgs([{ name: 'a', rect: [0, 0, 0, 8] }])[0]).toMatch(/^\/cells\/0\/rect rect is/);
    expect(msgs([{ name: 'Bad', rect: [0, 0, 8, 8], tile: true }])).toEqual(['/cells/0/tile unknown cell field "tile"', '/cells/0/name a cell name uses the id syntax [a-z0-9][a-z0-9_-]{0,63}']);
    expect(trimCellOf(sheet, 'crack')!.rect).toEqual([0, 64, 64, 32]);
    expect(trimCellOf(sheet, 'none')).toBeNull();
    expect(trimCellMetres(sheet, trimCellOf(sheet, 'crack')!)).toEqual([0.5, 0.25]);
  });
});
