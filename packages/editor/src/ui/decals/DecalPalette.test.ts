import { describe, expect, it } from 'vitest';
import type { MaterialDef } from '@thirdlight/project-model';

import { decalPalette } from '../../session/decal-editor';
import { paletteTiles } from './DecalPalette';

const sheet = (id: string, name: string, cells: string[]): MaterialDef =>
  ({ materialId: id, name, shader: 'trim', params: {}, textures: { map: `tex-${id}` }, trim: { size: [1024, 1024], texelDensity: 256, padding: 8, rows: [], cells: cells.map((c, i) => ({ name: c, rect: [i * 128, 0, 128, 128] })) } }) as unknown as MaterialDef;

describe('the decal palette groups its pictures by sheet', () => {
  // Two sheets that both have a "panel" cell, a decal material of its own image listed after them, and one drawn from the second sheet.
  const materials: MaterialDef[] = [
    sheet('mat-village', 'Village trim', ['panel', 'crack']),
    sheet('mat-metal', 'Metal trim', ['panel', 'bolt']),
    { materialId: 'mat-bolt', name: 'Bolt', shader: 'decal', params: {}, textures: {}, decal: { sheet: 'mat-metal', cell: 'bolt' } },
    { materialId: 'mat-puddle', name: 'Puddle', shader: 'decal', params: {}, textures: { map: 'tex-puddle' } },
  ];

  it('lists own images first, then each sheet with its materials and its free cells, in the project order', () => {
    const p = decalPalette(materials);
    expect(p.map((e) => [e.group, e.name])).toEqual([
      [null, 'Puddle'],
      ['Village trim', 'panel'],
      ['Village trim', 'crack'],
      ['Metal trim', 'Bolt'],
      ['Metal trim', 'panel'],
    ]);
  });

  it('heads each group with its sheet, and names the sheet in the two "panel" tiles', () => {
    const tiles = paletteTiles(decalPalette(materials));
    expect(tiles.map((t) => t.group)).toEqual(['Images', 'Village trim', 'Village trim', 'Metal trim', 'Metal trim']);
    const panels = tiles.filter((t) => t.name === 'panel');
    expect(panels.map((t) => t.aria)).toEqual(['decal panel · Village trim', 'decal panel · Metal trim']);
    expect(panels.map((t) => t.sub)).toEqual(['trim cell · Village trim', 'trim cell · Metal trim']);
    // The index is the position shown: the number keys follow the grouped order.
    expect(tiles.map((t) => t.index)).toEqual([0, 1, 2, 3, 4]);
  });

  it('shows no headings when every picture comes from one place', () => {
    const tiles = paletteTiles(decalPalette([sheet('mat-village', 'Village trim', ['panel', 'crack'])]));
    expect(tiles.every((t) => t.group === undefined)).toBe(true);
  });
});
