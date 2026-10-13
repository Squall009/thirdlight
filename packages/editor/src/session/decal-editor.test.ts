import { describe, expect, it } from 'vitest';
import type { DecalComponent, MaterialDef } from '@thirdlight/project-model';

import { DECAL_TOOL_DEFAULTS } from './decal-place';
import { decalMatches, decalPalette, filterPalette, sanitizeScatter, scatterPlacement, scatterSpacing, ScatterStroke, selectionEdit, selectionFields, DECAL_SCATTER_DEFAULTS } from './decal-editor';

const SHEET: MaterialDef = { materialId: 'mat-trim', name: 'Trim', shader: 'trim', params: {}, textures: { map: 'tex-trim' }, trim: { size: [1024, 512], texelDensity: 256, padding: 8, rows: [], cells: [{ name: 'sign', rect: [512, 256, 256, 128] }, { name: 'crack', rect: [0, 0, 128, 128] }] } } as unknown as MaterialDef;
const MATERIALS: MaterialDef[] = [
  { materialId: 'mat-puddle', name: 'Puddle', shader: 'decal', params: {}, textures: { map: 'tex-puddle' } },
  { materialId: 'mat-sign', name: 'Sign decal', shader: 'decal', params: {}, textures: {}, decal: { sheet: 'mat-trim', cell: 'sign' } },
  { materialId: 'mat-wall', name: 'Wall', shader: 'standard', params: {}, textures: {} },
  SHEET,
];

describe('the decal palette', () => {
  it('lists decal materials (a cell material with its sheet picture and crop) and the cells without a material', () => {
    const p = decalPalette(MATERIALS);
    expect(p.map((e) => e.key)).toEqual(['material:mat-puddle', 'material:mat-sign', 'cell:mat-trim:crack']);
    expect(p[0]).toMatchObject({ texture: 'tex-puddle', material: 'mat-puddle' });
    expect(p[1]).toMatchObject({ texture: 'tex-trim', crop: [0.5, 0.5, 0.25, 0.25], cell: { sheet: 'mat-trim', cell: 'sign' } });
    expect(p[2]).toMatchObject({ kind: 'cell', material: null, crop: [0, 0, 0.125, 0.25] });
    expect(filterPalette(p, 'cell').map((e) => e.name)).toEqual(['crack']);
    expect(filterPalette(p, 'material')).toHaveLength(2);
  });
});

describe('picking filters', () => {
  it('match by material and by decal layer (absent layers: every layer)', () => {
    expect(decalMatches({ material: 'a' }, { material: null, layer: null })).toBe(true);
    expect(decalMatches({ material: 'a' }, { material: 'b', layer: null })).toBe(false);
    expect(decalMatches({ material: 'a' }, { material: null, layer: 7 })).toBe(true);
    expect(decalMatches({ material: 'a', layers: 0b10 }, { material: null, layer: 0 })).toBe(false);
    expect(decalMatches({ material: 'a', layers: 0b10 }, { material: 'a', layer: 1 })).toBe(true);
  });
});

const A: DecalComponent = { size: [2, 1, 0.5], material: 'mat-puddle' };
const B: DecalComponent = { size: [2, 3, 0.5], material: 'mat-puddle', opacity: { normal: 0.4 }, fadeDistance: 30 };

describe('a selection of many', () => {
  it('shows a field once when the selection agrees on it, mixed (null) when not', () => {
    const f = selectionFields([A, B]);
    expect(f.count).toBe(2);
    expect(f.material).toBe('mat-puddle');
    expect(f.width).toBe(2);
    expect(f.height).toBeNull();
    expect(f.opacity.albedo).toBe(1);
    expect(f.opacity.normal).toBeNull();
    expect(f.fadeDistance).toBeNull();
    expect(f.mode).toBe('projected');
    expect(f.normalFade).toBe(90);
  });

  it('is one command: the same value in entityIds when all agree, each decal\'s own in values when its other parts differ', () => {
    const entries = [{ id: 'd1', decal: A }, { id: 'd2', decal: B }];
    expect(selectionEdit(entries, { field: 'fadeDistance', value: 40 })).toEqual([{ entityId: 'd1', component: 'decal', value: { fadeDistance: 40 }, entityIds: ['d2'] }]);
    expect(selectionEdit(entries, { field: 'size', axis: 0, value: 4 })).toEqual([{ entityId: 'd1', component: 'decal', value: { size: [4, 1, 0.5] }, entityIds: ['d2'], values: [{ size: [4, 3, 0.5] }] }]);
    // Full opacity is the default: the field goes rather than store 1.
    expect(selectionEdit(entries, { field: 'opacity', channel: 'normal', value: 1 })).toEqual([{ entityId: 'd1', component: 'decal', value: { opacity: null }, entityIds: ['d2'] }]);
    expect(selectionEdit(entries, { field: 'opacity', channel: 'albedo', value: 0.5 })).toEqual([{ entityId: 'd1', component: 'decal', value: { opacity: { albedo: 0.5 } }, entityIds: ['d2'], values: [{ opacity: { normal: 0.4, albedo: 0.5 } }] }]);
    expect(selectionEdit([], { field: 'sortOrder', value: 1 })).toEqual([]);
    expect(selectionEdit(entries.slice(0, 1), { field: 'fadeDistance', value: 0 })).toEqual([{ entityId: 'd1', component: 'decal', value: { fadeDistance: null } }]);
  });
});

describe('scatter', () => {
  it('lays about density × area decals, never closer than the spacing, the same places for the same seed', () => {
    const s = { ...DECAL_SCATTER_DEFAULTS, density: 2, seed: 7 };
    const run = (): ScatterStroke => {
      const k = new ScatterStroke(s);
      for (let i = 0; i < 6; i++) k.dab([i * 1.5, 0, 0], [0, 1, 0], 2);
      return k;
    };
    const a = run();
    const b = run();
    expect(a.places).toEqual(b.places);
    // A 2 m-radius brush dragged 7.5 m covers about 4·7.5 + π·4 ≈ 42.6 m²: about 85 at 2/m², fewer where the spacing turns some away.
    expect(a.places.length).toBeGreaterThan(40);
    expect(a.places.length).toBeLessThan(100);
    const gap = scatterSpacing(s);
    for (let i = 0; i < a.places.length; i++)
      for (let j = i + 1; j < a.places.length; j++) {
        const p = a.places[i]!.point;
        const q = a.places[j]!.point;
        expect(Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])).toBeGreaterThanOrEqual(gap - 2e-3);
      }
    // On the floor's plane, numbered in order.
    expect(a.places.every((p, i) => p.point[1] === 0 && p.index === i)).toBe(true);
    const other = new ScatterStroke({ ...s, seed: 8 });
    other.dab([0, 0, 0], [0, 1, 0], 2);
    expect(other.places).not.toEqual(a.places.slice(0, other.places.length));
  });

  it('lays a wall dab on the wall\'s plane, and a decal per place turned and sized from the seed', () => {
    const k = new ScatterStroke({ ...DECAL_SCATTER_DEFAULTS, density: 4 });
    const placed = k.dab([0, 2, 5], [0, 0, -1], 1);
    expect(placed.length).toBeGreaterThan(3);
    expect(placed.every((p) => Math.abs(p.point[2] - 5) < 1e-6)).toBe(true);
    const tool = { ...DECAL_TOOL_DEFAULTS, size: [1, 1, 0.5] as [number, number, number] };
    const d = placed.map((p) => scatterPlacement(tool, DECAL_SCATTER_DEFAULTS, 'mat-puddle', p.point, p.normal, p.index));
    expect(d.every((x) => x.decal.size[0] >= 0.749 && x.decal.size[0] <= 1.251 && x.decal.size[2] === 0.5)).toBe(true);
    expect(new Set(d.map((x) => x.rotation.join())).size).toBe(d.length);
  });

  it('reads stored settings within bounds', () => {
    expect(sanitizeScatter({ density: 999, scaleMin: 2, scaleMax: 1, seed: -3, turn: 30 })).toEqual({ density: 20, turn: 30, scaleMin: 2, scaleMax: 2, seed: DECAL_SCATTER_DEFAULTS.seed });
    expect(sanitizeScatter(null)).toEqual(DECAL_SCATTER_DEFAULTS);
  });
});
