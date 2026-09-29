/**
 * Material instances resolve the same way in project-model (the
 * manifest Play and the export ship) and in three-adapter (the editor's views,
 * which may use project-model types only).
 */
import { describe, expect, it } from 'vitest';

import { canonicalMaterials, resolveMaterial, resolveMaterialInstances, type MaterialDef } from '../packages/project-model/src/materials';
import { resolveMaterialInstancesLike, type MaterialDefLike } from '../packages/three-adapter/src/material-library';

const LIST: MaterialDef[] = [
  {
    materialId: 'mat-g',
    name: 'Graph',
    shader: 'standard',
    params: { color: '#111111' },
    textures: { map: 'tex-a' },
    parameters: [
      { key: 'tint', type: 'color', default: '#ffffff' },
      { key: 'gloss', type: 'float', default: 0.5 },
    ],
    graph: { nodes: [{ id: 'out', type: 'pbr', position: [0, 0] }], edges: [] },
  },
  { materialId: 'mi-red', name: 'Red', shader: 'standard', params: {}, textures: {}, instanceOf: 'mat-g', values: { tint: '#ff0000' } },
  { materialId: 'mi-red-dull', name: 'Red dull', shader: 'standard', params: {}, textures: {}, instanceOf: 'mi-red', values: { gloss: 0 } },
  { materialId: 'mat-s', name: 'Shader', shader: 'kit', params: { roughness: 0.4, uvPeriod: 2 }, textures: { map: 'tex-a', normalMap: 'tex-n' } },
  { materialId: 'mi-s', name: 'Shader rough', shader: 'kit', params: { roughness: 1 }, textures: { map: 'tex-b' }, instanceOf: 'mat-s' },
  { materialId: 'mi-broken', name: 'Broken', shader: 'standard', params: {}, textures: {}, instanceOf: 'mat-missing' },
];

describe('material instance resolution (phase 25.19)', () => {
  it('folds the chain: the root graph and parameters, the nearer values, params and textures win', () => {
    const r = resolveMaterialInstances(LIST);
    expect(r.map((m) => m.materialId)).toEqual(['mat-g', 'mi-red', 'mi-red-dull', 'mat-s', 'mi-s']);
    const dull = r.find((m) => m.materialId === 'mi-red-dull')!;
    expect(dull.instanceOf).toBeUndefined();
    expect(dull.graph).toBe(LIST[0]!.graph);
    expect(dull.parameters!.map((p) => [p.key, p.default])).toEqual([['tint', '#ff0000'], ['gloss', 0]]);
    expect(dull.name).toBe('Red dull');
    const s = r.find((m) => m.materialId === 'mi-s')!;
    expect(s).toEqual({ materialId: 'mi-s', name: 'Shader rough', shader: 'kit', params: { roughness: 1, uvPeriod: 2 }, textures: { map: 'tex-b', normalMap: 'tex-n' } });
    expect(resolveMaterial(LIST, 'mat-s')).toBe(LIST[3]);
    expect(resolveMaterial(LIST, 'mi-broken')).toBeNull();
  });

  it('the adapter copy resolves identically (and leaves a resolved list unchanged)', () => {
    const model = resolveMaterialInstances(LIST);
    const adapter = resolveMaterialInstancesLike(LIST as unknown as MaterialDefLike[]);
    expect(adapter).toEqual(model);
    expect(resolveMaterialInstancesLike(adapter)).toEqual(model);
  });

  it('canonical form keeps instanceOf and sorted, lowercase values last', () => {
    const [c] = canonicalMaterials([{ materialId: 'mi', name: 'I', shader: 'standard', params: {}, textures: {}, instanceOf: 'mat-g', values: { tint: '#FF0000', gloss: 1 } }]);
    expect(Object.keys(c!)).toEqual(['materialId', 'name', 'shader', 'params', 'textures', 'instanceOf', 'values']);
    expect(c!.values).toEqual({ gloss: 1, tint: '#ff0000' });
    expect(Object.keys(c!.values!)).toEqual(['gloss', 'tint']);
  });
});
