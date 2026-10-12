/**
 * The layered surface as data: the template with its layer weights, the trim
 * material as the layered surface it draws as, the row table a layered
 * material's trim layers follow (and where its sheets disagree), the
 * `layerSheets` field, and the material as drawn — only the layers it uses,
 * trim layers and tiling layers in arrays of their own.
 */
import { describe, expect, it } from 'vitest';

import type { ModelErrorV2 } from './errors';
import type { GraphEdge, GraphNode } from './graph';
import { LAYER_NOT_READ, LAYERED_TEXTURES, layeredMaterial, layerSheetMismatches, layerSheetRows, trimSurfaceMaterial, UV_SOURCES } from './layered-surface';
import { canonicalMaterials, materialGraphContext, resolveMaterialInstances, validateMaterials, type MaterialDef } from './materials';
import { layeredForDraw, materialTextureSlotSets, TRIM_GROUP_KEY, withAssembledSlots } from './texture-slots';
import { defaultTrimSheet, type TrimSheet } from './trim-sheet';

const errorsOf = (list: readonly MaterialDef[], build = false): ModelErrorV2[] => {
  const errors: ModelErrorV2[] = [];
  validateMaterials(list, '', errors, materialGraphContext(list[0]?.parameters, undefined), undefined, build);
  return errors;
};
const into = (m: MaterialDef, node: string, port: string): GraphEdge | undefined => m.graph!.edges.find((e) => e.to.node === node && e.to.port === port);
const nodeOf = (m: MaterialDef, id: string): GraphNode | undefined => m.graph!.nodes.find((n) => n.id === id);
const param = (m: MaterialDef, key: string): unknown => m.parameters?.find((p) => p.key === key)?.default;

/** A layered material with these colour (and normal, ORM) slots and UV sources. */
function walls(slots: string[], sources: number[]): MaterialDef {
  const m = layeredMaterial('mat-walls', 'Walls');
  return {
    ...m,
    parameters: m.parameters!.map((p) => {
      if (p.key === LAYERED_TEXTURES.albedo) return { ...p, default: slots };
      if (p.key === LAYERED_TEXTURES.normals) return { ...p, default: slots.map((s) => (s === 'moss' || s === 'rust' ? '' : `${s}-n`)) };
      if (p.key === 'layerProjection') return { ...p, default: [0, 1, 2, 3].map((i) => sources[i] ?? 0) };
      return p;
    }),
  };
}

describe('the layered surface', () => {
  it('the template blends by the Layer weights node and darkens by its vertex occlusion', () => {
    const m = layeredMaterial('mat-l', 'Layers');
    expect(errorsOf([m])).toEqual([]);
    expect(nodeOf(m, 'layerWeights')?.type).toBe('layerWeights');
    expect(into(m, 'heightBlend', 'weights')?.from).toEqual({ node: 'layerWeights', port: 'weights' });
    expect(into(m, 'wet', 'a')?.from).toEqual({ node: 'layerWeights', port: 'wetness' });
    expect(into(m, 'vertexOcclusion', 'a')?.from).toEqual({ node: 'layerWeights', port: 'occlusion' });
    expect(m.graph!.nodes.some((n) => n.type === 'vertexColor')).toBe(false);
  });

  it('a trim material draws as a layered surface: one mesh-UV layer of its sheet, a grime colour layer, its data kept', () => {
    const trim: MaterialDef = { materialId: 'mat-trim', name: 'Trim', shader: 'trim', params: { grime: 1.5, alphaMode: 'cutout' }, textures: { map: 'sheet', normalMap: 'sheet-n', ormMap: 'sheet-orm' }, trim: defaultTrimSheet() };
    const drawn = trimSurfaceMaterial(trim);
    // The material's own data stays (the generator, decal cells and the editor read it); a graph is added.
    expect({ ...drawn, graph: undefined, parameters: undefined }).toEqual({ ...trim, graph: undefined, parameters: undefined });
    expect(param(drawn, LAYERED_TEXTURES.albedo)).toBe('sheet');
    expect(param(drawn, LAYERED_TEXTURES.normals)).toBe('sheet-n');
    expect(param(drawn, LAYERED_TEXTURES.orm)).toBe('sheet-orm');
    expect(param(drawn, 'grime')).toBe(1.5);
    // Every read is at the mesh's own UVs (mode 3), layer 0.
    const reads = drawn.graph!.nodes.filter((n) => n.type === 'projectedSample');
    expect(reads.map((n) => n.id).sort()).toEqual(['albedo1', 'normal1', 'orm1']);
    for (const r of reads) {
      expect(nodeOf(drawn, into(drawn, r.id, 'mode')!.from.node)?.data?.['value']).toBe(UV_SOURCES.geometry);
      expect(nodeOf(drawn, into(drawn, r.id, 'layer')!.from.node)?.data?.['value']).toBe(0);
    }
    // Two layers: the sheet and grime, weighted by COLOR_0's grime plus the paint's G; cut out by the albedo's alpha.
    expect(into(drawn, 'colourMix', 'weights')?.from.node).toBe('layerWeights');
    expect(into(drawn, 'output', 'alphaClip')).toBeDefined();
    const { trim: _rows, ...graphOnly } = drawn;
    const errors = errorsOf([{ ...graphOnly, materialId: 'mat-g', shader: 'standard', params: {} }]);
    expect(errors).toEqual([]);
    // No normal map, no ORM: no read of them (the ORM's plain values, a flat normal).
    const bare = trimSurfaceMaterial({ ...trim, params: {}, textures: { map: 'sheet' } });
    expect(bare.graph!.nodes.filter((n) => n.type === 'projectedSample').map((n) => n.id)).toEqual(['albedo1']);
    expect(into(bare, 'output', 'normal')).toBeUndefined();
    expect(into(bare, 'output', 'alphaClip')).toBeUndefined();
  });

  it('a layered material\'s trim layers follow its first sheet\'s rows; sheets that differ are listed with the rows that differ', () => {
    const a = defaultTrimSheet();
    const b: TrimSheet = { ...a, rows: a.rows.map((r, i) => (i === 1 ? { ...r, bottom: r.bottom - 8 } : r)) };
    const sheets: Record<string, TrimSheet> = { a, a2: a, b };
    const sheetOf = (id: string): TrimSheet | null => sheets[id] ?? null;
    expect(layerSheetRows({ layerSheets: ['', 'a', 'b'] }, sheetOf)).toBe(a);
    expect(layerSheetRows({ layerSheets: ['nope'] }, sheetOf)).toBeNull();
    // A build's own copy wins (the sheets need not ship).
    expect(layerSheetRows({ trim: b, layerSheets: ['a'] }, sheetOf)).toBe(b);
    expect(layerSheetMismatches({ layerSheets: ['a', 'a2', 'a'] }, sheetOf)).toEqual([]);
    expect(layerSheetMismatches({ layerSheets: ['a', 'b'] }, sheetOf)).toEqual([{ layer: 1, sheet: 'b', differ: [a.rows[1]!.slot] }]);
    expect(layerSheetMismatches({ layerSheets: ['a', 'b'] }, (id) => (id === 'b' ? { ...a, padding: a.padding + 2 } : a))).toEqual([{ layer: 1, sheet: 'b', differ: ['padding'] }]);
  });

  it('layerSheets: trim material ids (or ""), kept canonical, its root\'s on an instance; a build may carry the rows', () => {
    const m: MaterialDef = { ...walls(['a', 'b'], [3, 3]), layerSheets: ['sheet-a', 'sheet-b', ''] };
    expect(errorsOf([m])).toEqual([]);
    expect(canonicalMaterials([m])[0]!.layerSheets).toEqual(['sheet-a', 'sheet-b']);
    expect(errorsOf([{ ...m, layerSheets: ['Not An Id'] }]).map((e) => e.path)).toEqual(['/0/layerSheets']);
    const inst: MaterialDef = { materialId: 'i', name: 'I', shader: 'standard', params: {}, textures: {}, instanceOf: m.materialId };
    expect(resolveMaterialInstances([m, inst])[1]!.layerSheets).toEqual(m.layerSheets);
    expect(errorsOf([{ ...m, trim: defaultTrimSheet() }]).map((e) => e.path)).toEqual(['/0/trim']);
    expect(errorsOf([{ ...m, trim: defaultTrimSheet() }], true)).toEqual([]);
  });
});

describe('a layered surface as drawn', () => {
  it('a material without a mesh-UV layer draws as it is (every layer read: terrain, block ground, tiling walls)', () => {
    const m = walls(['rock', 'grass'], [0, 1]);
    expect(layeredForDraw(m)).toBe(m);
    const unset = layeredMaterial('mat-u', 'U');
    expect(layeredForDraw(unset)).toBe(unset);
  });

  it('only the layers it uses: two slots read two layers, the others read nothing and weigh nothing', () => {
    const m = walls(['trim-a', 'trim-b'], [3, 3]);
    const d = layeredForDraw(m);
    for (const i of [3, 4]) {
      for (const id of [`albedo${i}`, `normal${i}`, `orm${i}`]) expect(nodeOf(d, into(d, id, 'layer')!.from.node)?.data?.['value']).toBe(LAYER_NOT_READ);
      // A colour read of an unused layer gives black: no height to win the blend with.
      expect(nodeOf(d, `albedo${i}`)?.data?.['absent']).toBe('black');
      expect(nodeOf(d, `orm${i}`)?.data?.['absent']).toBe('orm');
    }
    for (const i of [1, 2]) expect(nodeOf(d, into(d, `albedo${i}`, 'layer')!.from.node)?.data?.['value']).toBe(i - 1);
    // The weights are masked before the Height blend.
    const masked = into(d, 'heightBlend', 'weights')!.from.node;
    expect(into(d, masked, 'a')?.from).toEqual({ node: 'layerWeights', port: 'weights' });
    expect(nodeOf(d, into(d, masked, 'b')!.from.node)?.data?.['value']).toEqual([1, 1, 0, 0]);
    // One group (both trim): the lists as they were, no second key.
    expect(param(d, LAYERED_TEXTURES.albedo)).toEqual(['trim-a', 'trim-b']);
    expect(d.parameters!.some((p) => p.key === TRIM_GROUP_KEY(LAYERED_TEXTURES.albedo))).toBe(false);
    // The project's material is not changed.
    expect(param(m, LAYERED_TEXTURES.albedo)).toEqual(['trim-a', 'trim-b']);
    expect(nodeOf(m, 'albedo3')?.data?.['absent']).toBeUndefined();
  });

  it('trim layers and tiling layers each read arrays of their own (at most two per map)', () => {
    const m = walls(['trim-a', 'trim-b', 'moss', 'rust'], [3, 3, 1, 1]);
    const d = layeredForDraw(m);
    const key = (k: string): string => TRIM_GROUP_KEY(k);
    expect(param(d, key(LAYERED_TEXTURES.albedo))).toEqual(['trim-a', 'trim-b']);
    expect(param(d, LAYERED_TEXTURES.albedo)).toEqual(['moss', 'rust']);
    expect(param(d, key(LAYERED_TEXTURES.normals))).toEqual(['trim-a-n', 'trim-b-n']);
    // The tiling layers have no normal maps: that group's normals read nothing (a flat normal).
    expect(param(d, LAYERED_TEXTURES.normals)).toBe('');
    for (const [i, group, local] of [[1, 'trim', 0], [2, 'trim', 1], [3, 'tiling', 0], [4, 'tiling', 1]] as const) {
      const tex = nodeOf(d, into(d, `albedo${i}`, 'tex')!.from.node)!;
      expect(tex.data?.['key']).toBe(group === 'trim' ? key(LAYERED_TEXTURES.albedo) : LAYERED_TEXTURES.albedo);
      expect(nodeOf(d, into(d, `albedo${i}`, 'layer')!.from.node)?.data?.['value']).toBe(local);
    }
    for (const i of [3, 4]) expect(nodeOf(d, into(d, `normal${i}`, 'layer')!.from.node)?.data?.['value']).toBe(LAYER_NOT_READ);
    // All four used: no weight mask.
    expect(into(d, 'heightBlend', 'weights')?.from.node).toBe('layerWeights');
    // The arrays assembled are the groups' (the tiling group's normals none), each read by its own key.
    const sets = materialTextureSlotSets([m]).map((s) => `${s.mode}:${s.layers.join(',')}`);
    expect(sets).toEqual(['color:moss,rust', 'color:trim-a,trim-b', 'normal:trim-a-n,trim-b-n']);
    const [assembled] = withAssembledSlots([m], (s) => `arr(${s.layers.join('+')})`);
    expect(param(assembled!, LAYERED_TEXTURES.albedo)).toBe('arr(moss+rust)');
    expect(param(assembled!, key(LAYERED_TEXTURES.albedo))).toBe('arr(trim-a+trim-b)');
    expect(param(assembled!, LAYERED_TEXTURES.normals)).toBe('');
  });
});
