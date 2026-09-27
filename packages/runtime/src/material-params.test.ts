/**
 * Phase 23.12 (E9): `ctx.materials` — the catalogue, value checks, the data
 * grid, the per-step limit, the renderer's diffs and the digest text.
 */
import { describe, expect, it } from 'vitest';

import type { EntityV3 } from '@thirdlight/project-model';

import { MATERIAL_WRITES_PER_STEP, RuntimeMaterials, materialCatalogOf, materialCatalogProblem, type RuntimeMaterialCatalog } from './material-params';

const T = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const entity = (id: string, components: Record<string, unknown>): EntityV3 => ({ id, components: { transform: T, ...components } }) as unknown as EntityV3;

const MATERIALS = [
  {
    materialId: 'look',
    graph: { nodes: [], edges: [] },
    parameters: [
      { key: 'tint', type: 'color' as const, default: '#ffffff' },
      { key: 'amount', type: 'float' as const, default: 0.5, min: 0, max: 1 },
      { key: 'offset', type: 'vec2' as const, default: [0, 0] },
      { key: 'skin', type: 'texture' as const, default: '' },
      { key: 'cells', type: 'data' as const, default: [1, 2, 3, 4], size: [4, 2] as [number, number] },
      { key: 'secret', type: 'float' as const, default: 1, visibility: 'private' as const },
    ],
  },
  { materialId: 'other', graph: { nodes: [], edges: [] }, parameters: [{ key: 'tint', type: 'color' as const, default: '#000000' }] },
  // A shader material and a graph material with private parameters only: not in the catalogue.
  { materialId: 'plain', parameters: [{ key: 'tint', type: 'color' as const, default: '#000000' }] },
  { materialId: 'closed', graph: { nodes: [], edges: [] }, parameters: [{ key: 'x', type: 'float' as const, default: 0, visibility: 'private' as const }] },
];
const ASSETS = [
  { assetId: 'tex-a', kind: 'texture' },
  { assetId: 'tex-b', kind: 'texture' },
  { assetId: 'model-a', kind: 'model', materials: { Body: 'look', Trim: 'other' } },
];

function setup(): { m: RuntimeMaterials; catalog: RuntimeMaterialCatalog } {
  const catalog = materialCatalogOf(MATERIALS, ASSETS)!;
  const m = new RuntimeMaterials(catalog);
  m.addEntities([
    entity('a', { box: { size: [1, 1, 1] }, materials: { '*': 'look' } }),
    entity('b', { box: { size: [1, 1, 1] }, materials: { '*': 'look' }, materialParams: { look: { tint: '#ff0000' } } }),
    entity('model', { model: { asset: { assetId: 'model-a' } } }),
    entity('plain', { box: { size: [1, 1, 1] }, materials: { '*': 'plain' } }),
  ]);
  m.beginStep(1);
  return { m, catalog };
}

describe('phase 23.12: the material catalogue', () => {
  it('keeps graph materials with a public parameter, the model mappings and the closure textures', () => {
    const c = materialCatalogOf(MATERIALS, ASSETS)!;
    expect(c.materials.map((x) => x.materialId)).toEqual(['look', 'other']);
    expect(c.assetMaterials).toEqual({ 'model-a': { Body: 'look', Trim: 'other' } });
    expect(c.textures).toEqual(['tex-a', 'tex-b']);
    expect(materialCatalogProblem(c)).toBeNull();
    expect(materialCatalogOf([MATERIALS[2]!, MATERIALS[3]!], ASSETS)).toBeUndefined();
  });

  it('refuses a malformed catalogue (a snapshot field)', () => {
    expect(materialCatalogProblem([])).toMatch(/object/);
    expect(materialCatalogProblem({ materials: [], extra: 1 })).toMatch(/unknown/);
    expect(materialCatalogProblem({ materials: [{ materialId: 'x', parameters: [{ key: 'd', type: 'data', size: [65, 1] }] }] })).toMatch(/size/);
    expect(materialCatalogProblem({ materials: [{ materialId: 'x', parameters: [{ key: 'd', type: 'nope' }] }] })).toMatch(/key\/type/);
  });
});

describe('phase 23.12: ctx.materials values', () => {
  it('sets per object: only that object changes, values are checked against the parameter', () => {
    const { m } = setup();
    const api = m.api;
    expect(api.set('a', 'tint', '#00FF00')).toBe(true);
    expect(api.get('a', 'tint')).toBe('#00ff00');
    // b keeps its authored override, and a material default shows where nothing is set.
    expect(api.get('b', 'tint')).toBe('#ff0000');
    expect(api.get('a', 'amount')).toBe(0.5);
    // Types and ranges.
    expect(api.set('a', 'tint', 'green')).toBe(false);
    expect(api.set('a', 'amount', 2)).toBe(false);
    expect(api.set('a', 'amount', Number.NaN)).toBe(false);
    expect(api.set('a', 'amount', 0.25)).toBe(true);
    expect(api.set('a', 'offset', [1, 2, 3])).toBe(false);
    expect(api.set('a', 'offset', [1, 2])).toBe(true);
    expect(api.get('a', 'offset')).toEqual([1, 2]);
    // A texture of the game's closure, or none.
    expect(api.set('a', 'skin', 'tex-a')).toBe(true);
    expect(api.set('a', 'skin', 'not-in-game')).toBe(false);
    expect(api.set('a', 'skin', '')).toBe(true);
    // Private parameters, data parameters (setData), unknown ones, objects without graph materials.
    expect(api.set('a', 'secret', 2)).toBe(false);
    expect(api.set('a', 'cells', 1)).toBe(false);
    expect(api.set('a', 'nope', 1)).toBe(false);
    expect(api.set('plain', 'tint', '#000000')).toBe(false);
    expect(api.set('ghost', 'tint', '#000000')).toBe(false);
    expect(api.get('ghost', 'tint')).toBeNull();
  });

  it('an object with a model wears its asset\'s mapping; materialId limits a call to one material', () => {
    const { m } = setup();
    const api = m.api;
    expect(api.set('model', 'tint', '#123456')).toBe(true);
    expect(api.get('model', 'tint', 'look')).toBe('#123456');
    expect(api.get('model', 'tint', 'other')).toBe('#123456');
    expect(api.set('model', 'tint', '#abcdef', 'other')).toBe(true);
    expect(api.get('model', 'tint', 'look')).toBe('#123456');
    expect(api.get('model', 'tint', 'other')).toBe('#abcdef');
    // A material the object does not wear.
    expect(api.set('a', 'tint', '#000000', 'other')).toBe(false);
  });

  it('writes a data grid by rectangles and reads cells back; resets restore the starting cells', () => {
    const { m } = setup();
    const api = m.api;
    expect(api.getData('a', 'cells', 0, 0)).toEqual([1, 2, 3, 4]);
    expect(api.setData('a', 'cells', 1, 0, 2, 2, [10, 11, 12, 13, 20, 21, 22, 23, 30, 31, 32, 33, 40, 41, 42, 43])).toBe(true);
    expect(api.getData('a', 'cells', 1, 0)).toEqual([10, 11, 12, 13]);
    expect(api.getData('a', 'cells', 2, 1)).toEqual([40, 41, 42, 43]);
    expect(api.getData('a', 'cells', 0, 1)).toEqual([1, 2, 3, 4]);
    // A Uint8Array works too; out of the grid, a wrong length or a non-byte is refused.
    expect(api.setData('a', 'cells', 3, 1, 1, 1, new Uint8Array([9, 9, 9, 9]) as unknown as number[])).toBe(true);
    expect(api.setData('a', 'cells', 3, 1, 2, 1, [0, 0, 0, 0, 0, 0, 0, 0])).toBe(false);
    expect(api.setData('a', 'cells', 0, 0, 1, 1, [0, 0, 0])).toBe(false);
    expect(api.setData('a', 'cells', 0, 0, 1, 1, [0, 0, 0, 256])).toBe(false);
    expect(api.setData('a', 'cells', 0, 0, 1, 1, [0, 0, 0, 1.5])).toBe(false);
    expect(api.setData('a', 'cells', -1, 0, 1, 1, [0, 0, 0, 0])).toBe(false);
    expect(api.setData('a', 'tint', 0, 0, 1, 1, [0, 0, 0, 0])).toBe(false);
    expect(api.getData('a', 'cells', 4, 0)).toBeNull();
    // b's grid is its own.
    expect(api.getData('b', 'cells', 1, 0)).toEqual([1, 2, 3, 4]);
    expect(api.reset('a', 'cells')).toBe(true);
    expect(api.getData('a', 'cells', 1, 0)).toEqual([1, 2, 3, 4]);
  });

  it('reset puts one parameter or all of an object back to its authored value', () => {
    const { m } = setup();
    const api = m.api;
    api.set('b', 'tint', '#0000ff');
    api.set('b', 'amount', 1);
    expect(api.reset('b', 'tint')).toBe(true);
    expect(api.get('b', 'tint')).toBe('#ff0000');
    expect(api.get('b', 'amount')).toBe(1);
    expect(api.reset('b')).toBe(true);
    expect(api.get('b', 'amount')).toBe(0.5);
    expect(m.digestText()).toBeNull();
    expect(api.reset('ghost')).toBe(false);
  });

  it('refuses writes beyond the per-step limit; the next step may write again', () => {
    const { m } = setup();
    for (let i = 0; i < MATERIAL_WRITES_PER_STEP; i++) expect(m.api.set('a', 'amount', (i % 10) / 10)).toBe(true);
    expect(m.api.set('a', 'amount', 1)).toBe(false);
    m.beginStep(2);
    expect(m.api.set('a', 'amount', 1)).toBe(true);
  });
});

describe('phase 23.12: renderer diffs and the digest', () => {
  it('sends one change per changed parameter: the latest value, a clear, a data parameter\'s whole grid', () => {
    const { m } = setup();
    const api = m.api;
    expect(m.takeRenderChanges()).toEqual([]);
    api.set('a', 'tint', '#00ff00');
    api.set('a', 'tint', '#0000ff');
    api.set('b', 'amount', 1);
    api.setData('a', 'cells', 0, 0, 1, 1, [5, 6, 7, 8]);
    const first = m.takeRenderChanges();
    expect(first.map((c) => [c.op, c.entityId, c.key])).toEqual([['set', 'a', 'tint'], ['set', 'b', 'amount'], ['data', 'a', 'cells']]);
    expect(first[0]).toMatchObject({ op: 'set', materialId: 'look', type: 'color', value: '#0000ff' });
    const data = first[2] as { size: readonly number[]; bytes: Uint8Array };
    expect(data.size).toEqual([4, 2]);
    expect([...data.bytes.slice(0, 8)]).toEqual([5, 6, 7, 8, 1, 2, 3, 4]);
    expect(data.bytes.length).toBe(4 * 2 * 4);
    // Taken: nothing pending until the next write.
    expect(m.takeRenderChanges()).toEqual([]);
    api.reset('b', 'amount');
    api.reset('a', 'cells');
    const second = m.takeRenderChanges();
    expect(second.map((c) => c.op)).toEqual(['clear', 'data']);
    expect([...(second[1] as { bytes: Uint8Array }).bytes.slice(0, 4)]).toEqual([1, 2, 3, 4]);
  });

  it('the digest text covers values and grids, in a stable order, and is null while nothing is set', () => {
    const one = setup().m;
    const two = setup().m;
    expect(one.digestText()).toBeNull();
    one.api.set('b', 'amount', 1);
    one.api.set('a', 'tint', '#00ff00');
    two.api.set('a', 'tint', '#00ff00');
    two.api.set('b', 'amount', 1);
    expect(one.digestText()).toBe(two.digestText());
    one.api.setData('a', 'cells', 0, 0, 1, 1, [0, 0, 0, 0]);
    expect(one.digestText()).not.toBe(two.digestText());
  });

  it('a new run clears every value (the renderer is told); objects that leave take theirs along', () => {
    const { m } = setup();
    m.api.set('a', 'tint', '#00ff00');
    m.api.setData('b', 'cells', 0, 0, 1, 1, [9, 9, 9, 9]);
    m.takeRenderChanges();
    m.reset();
    expect(m.digestText()).toBeNull();
    expect(m.takeRenderChanges().map((c) => [c.op, c.entityId])).toEqual([['clear', 'a'], ['data', 'b']]);
    m.api.set('a', 'tint', '#00ff00');
    m.removeEntities(new Set(['a']));
    expect(m.takeRenderChanges()).toEqual([]);
    expect(m.digestText()).toBeNull();
    expect(m.api.set('a', 'tint', '#00ff00')).toBe(false);
  });

  it('a runtime without a catalogue answers false and null', () => {
    const m = new RuntimeMaterials(undefined);
    m.addEntities([entity('a', { materials: { '*': 'look' } })]);
    expect(m.api.set('a', 'tint', '#000000')).toBe(false);
    expect(m.api.get('a', 'tint')).toBeNull();
    expect(m.api.getData('a', 'cells', 0, 0)).toBeNull();
  });
});
