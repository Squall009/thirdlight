/**
 * The materials a build ships: the ones its objects and its assets' default
 * mappings use, each instance resolved (its root's graph and parameters with
 * its own values folded in, no `instanceOf` left), a parent only when
 * something names it, a material only a script names once it is loadable,
 * nothing unused.
 */
import { describe, expect, it } from 'vitest';
import type { MaterialDef } from '@thirdlight/project-model';

import { shippedMaterials } from './closure-materials';

const GLOW: MaterialDef = {
  materialId: 'glow',
  name: 'Glow',
  shader: 'standard',
  params: {},
  textures: {},
  parameters: [{ key: 'tint', type: 'color', default: '#ffffff' }],
  graph: { nodes: [{ id: 'out', type: 'pbr', position: [0, 0] }], edges: [] },
};
const MATERIALS: MaterialDef[] = [
  GLOW,
  { materialId: 'glow-red', name: 'Red', shader: 'standard', params: {}, textures: {}, instanceOf: 'glow', values: { tint: '#ff0000' } },
  { materialId: 'glow-yellow', name: 'Yellow', shader: 'standard', params: {}, textures: {}, instanceOf: 'glow', values: { tint: '#ffff00' } },
  { materialId: 'plain-blue', name: 'Blue', shader: 'standard', params: { color: '#0000ff' }, textures: {} },
  { materialId: 'unused', name: 'Unused', shader: 'standard', params: {}, textures: {} },
];
const noStyles = () => ({ presets: new Map() }) as never;

describe('shippedMaterials', () => {
  it('ships the used instances resolved, neither their parent nor anything unused', () => {
    const shipped = shippedMaterials({
      content: { materials: MATERIALS },
      entities: [{ components: { box: {}, materials: { '*': 'glow-red' } } }, { components: { box: {}, materials: { '*': 'plain-blue' } } }],
      // A model asset's default mapping names the yellow instance.
      assets: [{ materials: { '*': 'glow-yellow' } }],
      styles: noStyles,
    })!;
    expect(shipped.map((m) => m.materialId).sort()).toEqual(['glow-red', 'glow-yellow', 'plain-blue']);
    expect(shipped.some((m) => m.instanceOf !== undefined)).toBe(false);
    const yellow = shipped.find((m) => m.materialId === 'glow-yellow')!;
    expect(yellow.parameters).toEqual([{ key: 'tint', type: 'color', default: '#ffff00' }]);
    expect(yellow.graph).toEqual(GLOW.graph);
    // Named directly, the parent ships too.
    const withParent = shippedMaterials({ content: { materials: MATERIALS }, entities: [{ components: { box: {}, materials: { '*': 'glow' } } }], assets: [], styles: noStyles })!;
    expect(withParent.map((m) => m.materialId)).toEqual(['glow']);
    // A material only a script names ships once it is loadable (a label).
    const loadable = shippedMaterials({ content: { materials: MATERIALS, loadable: [{ kind: 'material', id: 'unused', labels: ['swaps'] }] }, entities: [], assets: [], styles: noStyles })!;
    expect(loadable.map((m) => m.materialId)).toEqual(['unused']);
    expect(shippedMaterials({ content: {}, entities: [], assets: [], styles: noStyles })).toBeUndefined();
  });

  it('ships a voxel world\'s gas materials with their plain look: the colour and full density a game\'s fog is drawn with, an instance\'s folded onto its base\'s', () => {
    const materials: MaterialDef[] = [
      { materialId: 'mist', name: 'Mist', shader: 'standard', params: {}, textures: {}, voxel: { id: 31, use: 'gas', gas: { color: '#dfe6ea', density: 0.4 } } },
      { materialId: 'mist-thick', name: 'Thick mist', shader: 'standard', params: {}, textures: {}, instanceOf: 'mist', voxel: { id: 32, gas: { density: 2 } } } as MaterialDef,
      { materialId: 'smoke', name: 'Smoke', shader: 'standard', params: {}, textures: {}, voxel: { id: 33, use: 'gas' } },
      { materialId: 'rock', name: 'Rock', shader: 'standard', params: { color: '#404040' }, textures: {}, voxel: { id: 2, use: 'terrain' } },
    ];
    const shipped = shippedMaterials({ content: { materials }, entities: [{ components: { voxelWorld: { world: 'w' } } }], assets: [], styles: noStyles })!;
    const voxel = Object.fromEntries(shipped.map((m) => [m.materialId, m.voxel]));
    expect(voxel['mist']).toEqual({ id: 31, use: 'gas', gas: { color: '#dfe6ea', density: 0.4 } });
    expect(voxel['mist-thick']).toEqual({ id: 32, use: 'gas', gas: { color: '#dfe6ea', density: 2 } });
    // A gas that names no look ships none: the page draws it with the record's defaults.
    expect(voxel['smoke']).toEqual({ id: 33, use: 'gas' });
    expect(voxel['rock']).toEqual({ id: 2, use: 'terrain' });
    // Without a voxel world nothing names them.
    expect(shippedMaterials({ content: { materials }, entities: [], assets: [], styles: noStyles })).toEqual([]);
  });
});
