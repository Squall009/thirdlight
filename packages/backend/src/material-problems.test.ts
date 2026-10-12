/**
 * The backend's material check reads per-layer texture slots as the editor
 * does: a slot list compiles as its assembled array, there when every slot
 * names a texture of the project (an empty slot of a normal-map array is a
 * constant layer), so a layered material whose slots are filled has no
 * "no texture" problem.
 */
import { describe, expect, it } from 'vitest';

import { createMaterialProblemChecker } from './material-problems';

const material = (normals: unknown, albedo: unknown = ['rock', '', 'sand']) => ({
  materialId: 'layers',
  name: 'Layers',
  parameters: [
    { key: 'albedo', type: 'texture', default: albedo },
    { key: 'normals', type: 'texture', default: normals },
  ],
  graph: {
    nodes: [
      { id: 'pa', type: 'parameter', position: [0, 0], data: { key: 'albedo' } },
      { id: 'pn', type: 'parameter', position: [0, 100], data: { key: 'normals' } },
      { id: 'sa', type: 'sampleTexture', position: [200, 0] },
      { id: 'sn', type: 'normalMap', position: [200, 100] },
      { id: 'out', type: 'pbr', position: [400, 0] },
    ],
    edges: [
      { id: 'e1', from: { node: 'pa', port: 'value' }, to: { node: 'sa', port: 'tex' } },
      { id: 'e2', from: { node: 'pn', port: 'value' }, to: { node: 'sn', port: 'tex' } },
      { id: 'e3', from: { node: 'sa', port: 'rgb' }, to: { node: 'out', port: 'baseColor' } },
      { id: 'e4', from: { node: 'sn', port: 'normal' }, to: { node: 'out', port: 'normal' } },
    ],
  },
});
const assets = ['rock', 'sand', 'rock_n'].map((assetId) => ({ assetId, kind: 'texture' }));

describe('material problems on the backend', () => {
  it('filled slot lists compile as their arrays: no problem', () => {
    const [row] = createMaterialProblemChecker().check({ materials: [material(['rock_n', '', ''])], assets });
    expect(row!.problems).toEqual([]);
  });

  it('a slot naming no texture of the project is a problem; an unset parameter still reads white', () => {
    const [missing] = createMaterialProblemChecker().check({ materials: [material(['rock_n', 'gone', ''])], assets });
    expect(missing!.problems.map((p) => p.nodeId)).toEqual(['sn']);
    const [unset] = createMaterialProblemChecker().check({ materials: [material(['rock_n'], '')], assets });
    expect(unset!.problems).toEqual([{ nodeId: 'sa', severity: 'warning', message: 'no texture (set its Texture field or wire a texture in); it reads white' }]);
  });
});
