/**
 * The layered surface as data: the template with its layer weights, the trim
 * material as the layered surface it draws as, the row table a layered
 * material's trim layers follow (and where its sheets disagree), the
 * `layerSheets` field, and the material as drawn — only the layers it uses,
 * trim layers and tiling layers in arrays of their own; stored materials with
 * the built-in grime of before, upgraded at the load.
 */
import { describe, expect, it } from 'vitest';

import type { ModelErrorV2 } from './errors';
import type { GraphEdge, GraphNode } from './graph';
import { graphWithoutGrime, upgradeBuiltInGrime } from './grime-upgrade';
import { LAYER_NOT_READ, LAYERED_TEXTURES, layeredMaterial, layerSheetMismatches, layerSheetRows, trimSurfaceMaterial, UV_SOURCES } from './layered-surface';
import { canonicalMaterials, materialGraphContext, resolveMaterialInstances, validateMaterials, type MaterialDef } from './materials';
import { heightAlphaTextures, layeredForDraw, materialTextureSlotSets, TRIM_GROUP_KEY, withAssembledSlots } from './texture-slots';
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

  it('a trim material draws as a layered surface: one mesh-UV layer of its sheet, wetness from the paint\'s A, no grime, its data kept', () => {
    const trim: MaterialDef = { materialId: 'mat-trim', name: 'Trim', shader: 'trim', params: { wetness: 0.25, alphaMode: 'cutout' }, textures: { map: 'sheet', normalMap: 'sheet-n', ormMap: 'sheet-orm' }, trim: defaultTrimSheet() };
    const drawn = trimSurfaceMaterial(trim);
    // The material's own data stays (the generator, decal cells and the editor read it); a graph is added.
    expect({ ...drawn, graph: undefined, parameters: undefined }).toEqual({ ...trim, graph: undefined, parameters: undefined });
    expect(param(drawn, LAYERED_TEXTURES.albedo)).toBe('sheet');
    expect(param(drawn, LAYERED_TEXTURES.normals)).toBe('sheet-n');
    expect(param(drawn, LAYERED_TEXTURES.orm)).toBe('sheet-orm');
    expect(param(drawn, 'wetness')).toBe(0.25);
    expect(drawn.parameters!.map((p) => p.key)).not.toContain('grime');
    expect(drawn.parameters!.map((p) => p.key)).not.toContain('grimeColor');
    // Every read is at the mesh's own UVs (mode 3), layer 0.
    const reads = drawn.graph!.nodes.filter((n) => n.type === 'projectedSample');
    expect(reads.map((n) => n.id).sort()).toEqual(['albedo1', 'normal1', 'orm1']);
    for (const r of reads) {
      expect(nodeOf(drawn, into(drawn, r.id, 'mode')!.from.node)?.data?.['value']).toBe(UV_SOURCES.geometry);
      expect(nodeOf(drawn, into(drawn, r.id, 'layer')!.from.node)?.data?.['value']).toBe(0);
    }
    // One layer, no mix: the tinted sheet, darkened by wetness (the trim data's B plus the paint's A); cut out by the albedo's alpha.
    expect(drawn.graph!.nodes.some((n) => n.type === 'weightedMix' || n.id.startsWith('grime'))).toBe(false);
    expect(into(drawn, 'wetColour', 'a')?.from).toEqual({ node: 'tint', port: 'out' });
    expect(into(drawn, 'wetVertexSum', 'a')?.from).toEqual({ node: 'trimData', port: 'z' });
    expect(into(drawn, 'wetVertexSum', 'b')?.from).toEqual({ node: 'paintSplit', port: 'w' });
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
    // A real-height sheet and a whole-rows one lay a wall's rows differently: a mismatch even with the same rows.
    expect(layerSheetMismatches({ layerSheets: ['a', 'b'] }, (id) => (id === 'b' ? { ...a, realHeight: a.realHeight !== true } : a))).toEqual([{ layer: 1, sheet: 'b', differ: ['realHeight'] }]);
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

  it('as drawn it is still a valid material: the runtime\'s read takes its keys and ids (build validation)', () => {
    const [assembled] = withAssembledSlots([walls(['trim-a', 'trim-b', 'moss'], [3, 3, 1])], (s) => `arr-${s.layers.length}`);
    expect(errorsOf([assembled!], true)).toEqual([]);
  });

  it('empty slots of used layers are neutral: mid grey with height 0, never the black of a left-out layer nor a winning white', () => {
    const neutral = '#80808000';
    // An empty slot inside a group: the neutral constant layer (not the first slot's texture, nor black).
    const inGroup = layeredForDraw(walls(['trim-a', '', 'moss'], [3, 3, 1]));
    expect(param(inGroup, TRIM_GROUP_KEY(LAYERED_TEXTURES.albedo))).toEqual(['trim-a', neutral]);
    expect(param(inGroup, LAYERED_TEXTURES.albedo)).toEqual(['moss']);
    // An empty base beside a trim layer: its group names no texture, so it reads the trim array's neutral layer.
    const emptyBase = layeredForDraw(walls(['', 'trim-b'], [1, 3]));
    expect(param(emptyBase, TRIM_GROUP_KEY(LAYERED_TEXTURES.albedo))).toEqual(['trim-b', neutral]);
    expect(param(emptyBase, LAYERED_TEXTURES.albedo)).toBe('');
    expect(nodeOf(emptyBase, into(emptyBase, 'albedo1', 'tex')!.from.node)?.data?.['key']).toBe(TRIM_GROUP_KEY(LAYERED_TEXTURES.albedo));
    expect(nodeOf(emptyBase, into(emptyBase, 'albedo1', 'layer')!.from.node)?.data?.['value']).toBe(1);
    // The arrays: the constant layer goes in as a layer of its own; the left-out layers' black does not fill slots.
    const sets = materialTextureSlotSets([walls(['trim-a', '', 'trim-c'], [3, 3, 3])]).map((x) => `${x.mode}:${x.layers.join(',')}`);
    expect(sets).toContain(`color:trim-a,${neutral},trim-c`);
  });

  it('a material with layers past the four (a terrain\'s) draws as it is, mesh-UV layer or not', () => {
    const five = walls(['rock', 'trim-b', 'moss', 'rust', 'sand'], [1, 3, 1, 1]);
    expect(layeredForDraw(five)).toBe(five);
    const extra = { ...walls(['rock', 'trim-b'], [1, 3]), parameters: walls(['rock', 'trim-b'], [1, 3]).parameters!.map((p) => (p.key === 'layerTiling' ? { ...p, extraLayers: [4] } : p)) };
    expect(layeredForDraw(extra)).toBe(extra);
  });
});


describe('textures read with a height in alpha', () => {
  it('a layered surface\'s colour slots (a trim sheet among them) are; a decal material\'s and a plain sampler\'s are not', () => {
    const m = walls(['sheet-a', 'moss'], [3, 1]);
    const plain: MaterialDef = { materialId: 'p', name: 'P', shader: 'standard', params: {}, textures: { map: 'sheet-b' } };
    expect([...heightAlphaTextures([m, plain])].sort()).toEqual(['moss', 'sheet-a']);
  });
});

/**
 * The layered template as it was stored with built-in grime: the colour mixed toward `grimeColor` and the roughness
 * toward matte by the Layer weights node's grime × `grime` (the graph the load upgrades).
 */
function withOldGrime(m: MaterialDef): MaterialDef {
  const g = m.graph!;
  const node = (id: string, type: string, data?: Record<string, unknown>): GraphNode => ({ id, type, position: [0, 0], ...(data !== undefined ? { data } : {}) }) as GraphNode;
  let n = 0;
  const edge = (from: [string, string], to: [string, string]): GraphEdge => ({ id: `g${++n}`, from: { node: from[0], port: from[1] }, to: { node: to[0], port: to[1] } });
  const edges = g.edges.map((e) => {
    if (e.to.node === 'wetColour' && e.to.port === 'a') return { ...e, from: { node: 'grimeColourMix', port: 'out' } };
    if (e.to.node === 'wetGloss' && e.to.port === 'a') return { ...e, from: { node: 'grimeRoughMix', port: 'out' } };
    return e;
  });
  return {
    ...m,
    parameters: [...m.parameters!, { key: 'grime', type: 'float', default: 1 }, { key: 'grimeColor', type: 'color', default: '#3b3328' }],
    graph: {
      nodes: [...g.nodes, node('grime', 'parameter', { key: 'grime' }), node('grimeColor', 'parameter', { key: 'grimeColor' }), node('grimeScaled', 'multiply'), node('grimeAmount', 'saturate'), node('grimeColourMix', 'lerp'), node('grimeRoughMix', 'lerp'), node('grimeRoughness', 'float', { value: 0.95 })],
      edges: [
        ...edges,
        edge(['layerWeights', 'grime'], ['grimeScaled', 'a']),
        edge(['grime', 'value'], ['grimeScaled', 'b']),
        edge(['grimeScaled', 'out'], ['grimeAmount', 'in']),
        edge(['albedoMix', 'out'], ['grimeColourMix', 'a']),
        edge(['grimeColor', 'value'], ['grimeColourMix', 'b']),
        edge(['grimeAmount', 'out'], ['grimeColourMix', 't']),
        edge(['ormSplit', 'y'], ['grimeRoughMix', 'a']),
        edge(['grimeRoughness', 'value'], ['grimeRoughMix', 'b']),
        edge(['grimeAmount', 'out'], ['grimeRoughMix', 't']),
      ],
    },
  };
}
const wiring = (m: { graph?: { edges: readonly GraphEdge[] } }): string[] => m.graph!.edges.map((e) => `${e.from.node}.${e.from.port}>${e.to.node}.${e.to.port}`).sort();

describe('stored built-in grime, upgraded at the load', () => {
  it('a layered surface stored with grime becomes the template of today: the same nodes, wiring and parameters', () => {
    const today = layeredMaterial('mat-l', 'Walls');
    const old = withOldGrime(today);
    // The old graph is not valid any more (the Layer weights node has no grime output).
    expect(errorsOf([old]).length).toBeGreaterThan(0);
    const u = upgradeBuiltInGrime({ materials: [old] }, []);
    expect(u.changed).toBe(true);
    expect(u.named).toEqual(['"Walls" (mat-l)']);
    const [m] = (u.content as { materials: MaterialDef[] }).materials;
    expect(m!.graph!.nodes.map((x) => x.id).sort()).toEqual(today.graph!.nodes.map((x) => x.id).sort());
    expect(wiring(m!)).toEqual(wiring(today));
    expect(m!.parameters).toEqual(today.parameters);
    expect(errorsOf([m!])).toEqual([]);
    // Today's documents come back as given.
    const again = upgradeBuiltInGrime(u.content, []);
    expect(again.changed).toBe(false);
    expect(again.content).toBe(u.content);
  });

  it('a grime amount of 0 is not named; a graph that read the grime output otherwise reads a 0 there', () => {
    const today = layeredMaterial('mat-z', 'Zero');
    const zero = withOldGrime(today);
    zero.parameters = zero.parameters!.map((p) => (p.key === 'grime' ? { ...p, default: 0 } : p));
    const custom: MaterialDef = {
      materialId: 'mat-c',
      name: 'Custom',
      shader: 'standard',
      params: {},
      textures: {},
      graph: {
        nodes: [{ id: 'out', type: 'pbr', position: [0, 0] }, { id: 'w', type: 'layerWeights', position: [0, 0] }, { id: 'sum', type: 'add', position: [0, 0] }],
        edges: [
          { id: 'e1', from: { node: 'w', port: 'grime' }, to: { node: 'sum', port: 'a' } },
          { id: 'e2', from: { node: 'w', port: 'wetness' }, to: { node: 'sum', port: 'b' } },
          { id: 'e3', from: { node: 'sum', port: 'out' }, to: { node: 'out', port: 'roughness' } },
        ],
      },
    };
    const u = upgradeBuiltInGrime({ materials: [zero, custom] }, []);
    expect(u.named).toEqual(['"Custom" (mat-c)']);
    const c = (u.content as { materials: MaterialDef[] }).materials[1]!;
    expect(wiring(c)).toEqual(['noGrime.value>sum.a', 'sum.out>out.roughness', 'w.wetness>sum.b']);
    expect(c.graph!.nodes.find((x) => x.id === 'noGrime')).toMatchObject({ type: 'float', data: { value: 0 } });
    expect(graphWithoutGrime(c.graph)).toBeNull();
  });

  it('a trim material\'s grime params, an instance\'s values and objects\' overrides of the dropped parameters go', () => {
    const walls = withOldGrime(layeredMaterial('mat-w', 'Walls'));
    const trim = { materialId: 'mat-t', name: 'Sheet', shader: 'trim', params: { grime: 0.6, grimeColor: '#302010', roughness: 0.5 }, textures: {} };
    const clean = { materialId: 'mat-t0', name: 'Clean', shader: 'trim', params: { grime: 0 }, textures: {} };
    const inst = { materialId: 'mat-wi', name: 'Walls 2', shader: 'standard', params: {}, textures: {}, instanceOf: 'mat-w', values: { grime: 2, wetness: 0.5 } };
    const scene = { entities: [{ id: 'box-1', components: { materialParams: { 'mat-wi': { grime: 1 }, 'mat-w': { grimeColor: '#000000', color: '#ff0000' } } } }, { id: 'box-2', components: {} }] };
    const u = upgradeBuiltInGrime({ materials: [walls, trim, clean, inst] }, [scene]);
    const [w, t, t0, i] = (u.content as { materials: Record<string, unknown>[] }).materials;
    expect(u.named).toEqual(['"Walls" (mat-w)', '"Sheet" (mat-t)']);
    expect(t!['params']).toEqual({ roughness: 0.5 });
    expect(t0!['params']).toEqual({});
    expect(i!['values']).toEqual({ wetness: 0.5 });
    expect((w!['parameters'] as { key: string }[]).map((p) => p.key)).not.toContain('grime');
    const s = u.scenes[0] as typeof scene;
    expect(s.entities[0]!.components).toEqual({ materialParams: { 'mat-w': { color: '#ff0000' } } });
    expect(s.entities[1]).toBe(scene.entities[1]);
  });
});
