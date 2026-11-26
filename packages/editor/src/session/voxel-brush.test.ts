import { describe, expect, it } from 'vitest';
import { brushMask } from '@thirdlight/runtime';
import { canonicalEditCommand, recordValue, SHAPE_FULL, VOXEL_ROLE, VOXEL_SIZE_M, type BrushEdit } from '@thirdlight/voxel';

import { DEFAULT_BRUSH_MASK } from './brush';
import { addRoleOf, brushCells, dabCell, dabSpacingCells, DabTrail, maskedColumns, surfaceHeightCells, voxelPalette, voxelStrokeCommand, type VoxelStroke } from './voxel-brush';
import { paletteTiles, pickedEntry, WORLD_BRUSH_START, worldBrushArming } from './world-mode';

const stroke = (o: Partial<VoxelStroke>): VoxelStroke => ({ grid: 0, kind: 'dig', shape: 'sphere', across: 9, soft: true, cells: [[0, 0, 0]], ...o });
/** The command as the backend reads it: refused fields throw. */
const read = (s: VoxelStroke): BrushEdit => canonicalEditCommand(voxelStrokeCommand(s)) as BrushEdit;

describe('the voxel brush: cells, spacing and the dabs of a drag', () => {
  it('a brush is an odd count of cells across, centred on a cell; the spacing is a share of it, never under a cell', () => {
    expect([0.2, 0.5, 1, 1.5, 2, 4].map(brushCells)).toEqual([1, 1, 3, 3, 5, 9]);
    expect(dabSpacingCells(9, 0.25)).toBe(2);
    expect(dabSpacingCells(17, 0.25)).toBe(4);
    expect(dabSpacingCells(1, 0.25)).toBe(1);
  });

  it('a dab sits on the cell met, Add\'s on the cell in front of the face; a surface\'s height is its row plus its fill', () => {
    expect(dabCell('dig', [4, -1, 2], [0, 1, 0])).toEqual([4, -1, 2]);
    expect(dabCell('add', [4, -1, 2], [0, 1, 0])).toEqual([4, 0, 2]);
    expect(dabCell('add', [4, 3, 2], [-1, 0, 0])).toEqual([3, 3, 2]);
    expect(surfaceHeightCells([0, -1, 0], recordValue(5, VOXEL_ROLE.terrain, SHAPE_FULL, 0))).toBe(0);
    expect(surfaceHeightCells([0, 6, 0], recordValue(5, VOXEL_ROLE.terrain, 6, 0))).toBeCloseTo(6.4, 12);
    // A block is whole whatever its integrity; a cell not read counts whole.
    expect(surfaceHeightCells([0, 2, 0], recordValue(5, VOXEL_ROLE.wall, 3, 0))).toBe(3);
    expect(surfaceHeightCells([0, 2, 0], null)).toBe(3);
  });

  it('a drag\'s dabs are thinned to the spacing: none nearer, a gap filled along the line, a cell once', () => {
    const t = new DabTrail(4);
    expect(t.add([0, 0, 0])).toBe(1);
    // Nearer than a spacing: nothing.
    expect(t.add([1, 0, 0])).toBe(0);
    expect(t.add([3, 0, 0])).toBe(0);
    expect(t.add([4, 0, 0])).toBe(1);
    // A fast drag: 13 cells on in one pick is three dabs, a spacing apart.
    expect(t.add([17, 0, 0])).toBe(3);
    expect(t.cells).toEqual([[0, 0, 0], [4, 0, 0], [8, 0, 0], [12, 0, 0], [16, 0, 0]]);
    // Back over the stroke: the cells it already holds are not kept twice.
    expect(t.add([8, 0, 0])).toBe(0);
    expect(t.cells).toHaveLength(5);
    // A one-cell brush keeps every cell a drag passes, diagonals too.
    const one = new DabTrail(1);
    for (const c of [[5, 3, 1], [6, 3, 1], [6, 4, 1], [7, 5, 1], [7, 5, 1]] as const) one.add(c);
    expect(one.cells).toEqual([[5, 3, 1], [6, 3, 1], [6, 4, 1], [7, 5, 1]]);
  });
});

describe('the voxel brush: a stroke is one edit command the backend reads', () => {
  it('each tool sends its mode: add and dig with the rim, smooth and flatten with no voxel, flatten its height', () => {
    expect(read(stroke({ kind: 'add', voxel: { material: 7, role: VOXEL_ROLE.terrain, wetness: 0 }, cells: [[3, 0, 2], [5, 0, 2]] }))).toEqual({ v: 3, grid: 0, kind: 'brush', shape: 'sphere', size: [4.5, 4.5, 4.5], points: [3.5, 0.5, 2.5, 5.5, 0.5, 2.5], mode: 'add', voxel: { material: 7, role: VOXEL_ROLE.terrain, wetness: 0 }, smooth: true });
    expect(read(stroke({ kind: 'dig', soft: false, shape: 'box', across: 1, grid: 4 }))).toEqual({ v: 3, grid: 4, kind: 'brush', shape: 'box', size: [0.5, 0.5, 0.5], points: [0.5, 0.5, 0.5], mode: 'dig', smooth: false });
    // A voxel handed to a tool that writes none is left out (the command would be refused with it).
    expect(read(stroke({ kind: 'smooth', voxel: { material: 7, role: VOXEL_ROLE.terrain, wetness: 0 } }))).toMatchObject({ mode: 'smooth', smooth: true });
    expect(read(stroke({ kind: 'smooth' })).voxel).toBeUndefined();
    const flat = read(stroke({ kind: 'flatten', shape: 'cylinder', height: 6.4 }));
    expect(flat).toMatchObject({ mode: 'flatten', height: 6.4, shape: 'cylinder', size: [4.5, 4.5, 4.5] });
    expect(flat.voxel).toBeUndefined();
    expect(voxelStrokeCommand(stroke({ cells: [] }))).toBeNull();
  });

  it('a paint names its material and wetness and no role, hard-rimmed', () => {
    const c = read(stroke({ kind: 'paint', soft: true, voxel: { material: 9, wetness: 5 } }));
    expect(c).toMatchObject({ v: 3, mode: 'paint', voxel: { material: 9, wetness: 5 }, smooth: false });
    expect(c.voxel).not.toHaveProperty('role');
  });

  it('a masked paint is the columns the mask lets through under the dabs, one cell across and the brush\'s height, each once', () => {
    const mask = { ...DEFAULT_BRUSH_MASK, scale: 2 };
    const s = stroke({ kind: 'paint', across: 9, shape: 'sphere', cells: [[10, -1, 10], [13, -1, 10]], voxel: { material: 9, wetness: 0 }, mask });
    const c = read(s);
    expect(c.shape).toBe('box');
    expect(c.size).toEqual([0.5, 4.5, 0.5]);
    const cols: string[] = [];
    for (let i = 0; i < c.points.length; i += 3) cols.push(`${c.points[i]! - 0.5},${c.points[i + 2]! - 0.5}`);
    expect(new Set(cols).size).toBe(cols.length);
    // Exactly the footprint's columns at half weight or more: some, not all.
    const want: string[] = [];
    for (let x = 0; x < 30; x++) for (let z = 0; z < 30; z++) {
      const under = s.cells.some((d) => (x - d[0]) ** 2 + (z - d[2]) ** 2 <= 4.5 ** 2);
      if (under && brushMask(mask, (x + 0.5) * VOXEL_SIZE_M, (z + 0.5) * VOXEL_SIZE_M) >= 0.5) want.push(`${x},${z}`);
    }
    expect([...cols].sort()).toEqual([...want].sort());
    const footprint = maskedColumns(s, { ...mask, threshold: 0, contrast: 0 }).length / 3;
    expect(cols.length).toBeGreaterThan(0);
    expect(cols.length).toBeLessThan(footprint);
    // A mask that lets nothing through sends nothing; no mask sends the brush itself.
    expect(voxelStrokeCommand({ ...s, mask: { ...mask, threshold: 1, contrast: 16 } })).toBeNull();
    expect(read({ ...s, mask: null })).toMatchObject({ shape: 'sphere', size: [4.5, 4.5, 4.5], points: [10.5, -0.5, 10.5, 13.5, -0.5, 10.5] });
    // A sculpt stroke never reads the mask.
    expect(read({ ...s, kind: 'dig', voxel: undefined as never }).shape).toBe('sphere');
  });
});

describe('the world mode: its palette and what each rail arms', () => {
  const materials = [
    { materialId: 'mat-water', name: 'Water', params: { color: '#2a5fc0' } },
    { materialId: 'mat-brick', name: 'Brick', params: { color: '#c0603a' } },
    { materialId: 'mat-grass-dry', name: 'Dry grass', instanceOf: 'mat-grass', params: { color: '#8a8a3a' } },
    { materialId: 'mat-grass', name: 'Grass', params: { color: '#4d7a3a' } },
    { materialId: 'mat-grass-lush', name: 'Lush grass', instanceOf: 'mat-grass-dry', params: {} },
    { materialId: 'mat-mist', name: 'Mist', params: {} },
    { materialId: 'mat-plain', name: 'No voxel part', params: {} },
  ];
  const parts = new Map<string, { id: number; use?: 'terrain' | 'construction' | 'liquid' | 'gas' }>([
    ['mat-water', { id: 30, use: 'liquid' }],
    ['mat-brick', { id: 4, use: 'construction' }],
    ['mat-grass-dry', { id: 12, use: 'terrain' }],
    ['mat-grass', { id: 2, use: 'terrain' }],
    ['mat-grass-lush', { id: 11, use: 'terrain' }],
    ['mat-mist', { id: 40, use: 'gas' }],
  ]);
  const palette = voxelPalette(materials, parts);

  it('lists ground then construction materials, a base followed by its instances as its variants; liquids and gases are left out', () => {
    expect(palette.map((e) => [e.base, e.name, e.id, e.variant])).toEqual([
      ['Grass', 'Grass', 2, false],
      ['Grass', 'Lush grass', 11, true],
      ['Grass', 'Dry grass', 12, true],
      ['Brick', 'Brick', 4, false],
    ]);
    // A variant's colour is its own, else the nearest up its chain.
    expect(palette.map((e) => e.colour)).toEqual(['#4d7a3a', '#8a8a3a', '#8a8a3a', '#c0603a']);
    const tiles = paletteTiles(palette);
    expect(tiles.map((t) => [t.index, t.group, t.name, t.badge])).toEqual([[0, 'Grass', 'Grass', undefined], [1, 'Grass', 'Lush grass', 'V'], [2, 'Grass', 'Dry grass', 'V'], [3, 'Brick', 'Brick', undefined]]);
    // No variants anywhere: no headings.
    expect(paletteTiles(voxelPalette(materials.filter((m) => m.instanceOf === undefined), parts)).every((t) => t.group === undefined)).toBe(true);
    // The seam for a fog brush: a gas palette is the same list asked for another use.
    expect(voxelPalette(materials, parts, ['gas']).map((e) => e.name)).toEqual(['Mist']);
  });

  it('Sculpt arms its tool with the picked material as what Add writes; Paint arms a role-less paint with the wetness', () => {
    expect(pickedEntry(palette, null)?.id).toBe(2);
    expect(pickedEntry(palette, 4)?.name).toBe('Brick');
    // A picked material that is gone falls back to the first.
    expect(pickedEntry(palette, 99)?.id).toBe(2);
    expect(pickedEntry([], 2)).toBeNull();
    expect(worldBrushArming('sculpt', WORLD_BRUSH_START, palette)).toEqual({ kind: 'add', shape: 'sphere', soft: true, voxel: { material: 2, role: VOXEL_ROLE.terrain, wetness: 0 }, uses: ['size', 'spacing', 'invert'] });
    for (const sculpt of ['dig', 'smooth', 'flatten'] as const) expect(worldBrushArming('sculpt', { ...WORLD_BRUSH_START, sculpt, shape: 'box', soft: false }, palette)).toMatchObject({ kind: sculpt, shape: 'box', soft: false });
    expect(worldBrushArming('sculpt', { ...WORLD_BRUSH_START, material: 4 }, palette).voxel).toEqual({ material: 4, role: addRoleOf('construction'), wetness: 0 });
    expect(addRoleOf('construction')).toBe(VOXEL_ROLE.wall);
    const paint = worldBrushArming('paint', { ...WORLD_BRUSH_START, material: 12, wetness: 5 }, palette);
    expect(paint).toEqual({ kind: 'paint', shape: 'sphere', soft: false, voxel: { material: 12, wetness: 5 }, uses: ['size', 'spacing', 'mask'] });
    expect(worldBrushArming('paint', { ...WORLD_BRUSH_START, wetness: 40 }, palette).voxel?.wetness).toBe(7);
    expect(worldBrushArming('paint', WORLD_BRUSH_START, []).voxel).toBeNull();
  });
});
