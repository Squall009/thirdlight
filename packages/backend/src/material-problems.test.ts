/**
 * The backend's material check reads per-layer texture slots as the editor
 * does: a slot list compiles as its assembled array, there when every slot
 * names a texture of the project (an empty slot of a normal-map array is a
 * constant layer), so a layered material whose slots are filled has no
 * "no texture" problem.
 */
import { describe, expect, it } from 'vitest';

import { defaultTrimSheet } from '@thirdlight/project-model/trim-sheet';

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

  it('a trim sheet of a layer may be an instance of a trim material (its root\'s rows); a plain material is not one', () => {
    const sheet = { materialId: 'sheet', name: 'Sheet', shader: 'trim', params: {}, textures: {}, trim: defaultTrimSheet() };
    const variant = { materialId: 'sheet-dark', name: 'Sheet dark', shader: 'trim', params: {}, textures: { map: 'rock' }, instanceOf: 'sheet' };
    const plain = { materialId: 'plain', name: 'Plain', shader: 'standard', params: {}, textures: {} };
    const sheetErrors = (layerSheets: string[]): string[] => {
      const rows = createMaterialProblemChecker().check({ materials: [{ ...material(['rock_n', '', '']), layerSheets }, sheet, variant, plain], assets });
      return rows[0]!.problems.filter((p) => p.message.includes('trim sheet')).map((p) => p.message);
    };
    expect(sheetErrors(['sheet-dark', 'sheet'])).toEqual([]);
    expect(sheetErrors(['plain'])).toEqual([expect.stringContaining('"plain" is not a trim material')]);
  });

  it('a trim sheet drawing rows at their real height names the presets whose row-tied sliders do not fit its rows', () => {
    const sheet = { materialId: 'sheet', name: 'Sheet', shader: 'trim', params: { color: '#ffffff' }, textures: {}, trim: defaultTrimSheet() };
    const preset = (graphId: string, values: Record<string, number>, sheetId = 'sheet') => ({ graphId, kind: 'architecture-preset', name: graphId, graph: { nodes: [{ id: 'preset', type: 'preset', position: [0, 0], data: { style: '', base: 'starter-room', sheet: sheetId } }, ...Object.entries(values).map(([parameter, value], i) => ({ id: `v${i}`, type: 'value', position: [0, 150], data: { parameter, value } }))], edges: [] } });
    const problems = (graphs: unknown[], trim = sheet.trim): string[] => createMaterialProblemChecker().check({ materials: [{ ...sheet, trim }], graphs, assets }).find((r) => r.materialId === 'sheet')!.problems.map((p) => p.message);
    // The starter room's 0.15 m baseboard fits the 0.156 m row; 0.3 m does not, and both heights are named.
    expect(problems([preset('fits', {})])).toEqual([]);
    expect(problems([preset('tall', { baseboard_height: 0.3 })])).toEqual(['preset "tall" (tall): baseboard_height is 0.3 m, its row "baseboard" is 0.156 m — the row is drawn at its own height, not fitted (Snap to row beside the preset\'s slider)']);
    // A sheet fitting rows to parts (stored before the option) has nothing to say; nor a preset naming another sheet.
    expect(problems([preset('tall', { baseboard_height: 0.3 })], { ...sheet.trim, realHeight: undefined } as never)).toEqual([]);
    expect(problems([preset('tall', { baseboard_height: 0.3 }, 'other')])).toEqual([]);
  });
});
