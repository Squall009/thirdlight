/**
 * Per-layer texture slots: the rules of a slot list, the encoding read from
 * the graph, the distinct sets the materials draw with, and the materials as
 * the runtime gets them (each list replaced by its assembled array's id).
 */
import { describe, expect, it } from 'vitest';

import type { GraphData, GraphEdge, GraphNode } from './graph';
import { LAYERED_TEXTURES, layeredMaterial, TEMPLATE_LAYERS, UV_SOURCES } from './layered-surface';
import { heightAlphaParams } from './material-reads';
import { canonicalMaterials, materialParameterValueError, MATERIAL_LAYER_NAME_MAX, resolveMaterialInstances, validateMaterials, type MaterialDef } from './materials';
import { fillLayerId, materialSlotTextureRefs, materialTextureSlotSets, parseFillLayer, parseTextureSlotSetKey, textureSlotFill, textureSlotLayers, textureSlotMode, textureSlotSetKey, withAssembledSlots } from './texture-slots';

const graph = (target: { type: string; data?: Record<string, string> }, key = 'tex'): GraphData => ({
  nodes: [
    { id: 'p', type: 'parameter', position: [0, 0], data: { key } },
    { id: 't', type: target.type, position: [200, 0], ...(target.data !== undefined ? { data: target.data } : {}) },
  ],
  edges: [{ id: 'e', from: { node: 'p', port: 'value' }, to: { node: 't', port: 'tex' } }],
});

describe('texture slots', () => {
  it('a slot list: 1-256 ids or "", at least one filled; an empty slot takes the first filled one', () => {
    expect(materialParameterValueError({ type: 'texture' }, ['a', '', 'b'])).toBeNull();
    expect(materialParameterValueError({ type: 'texture' }, [])).toMatch(/1-256/);
    expect(materialParameterValueError({ type: 'texture' }, ['', ''])).toMatch(/at least one/);
    expect(materialParameterValueError({ type: 'texture' }, ['A B'])).toMatch(/each slot/);
    expect(textureSlotLayers(['', 'b', '', 'c'])).toEqual(['b', 'b', 'b', 'c']);
    expect(textureSlotLayers(['', ''])).toBeNull();
  });

  it('an empty slot of a normal map array is a flat normal, of an ORM read its neutral; other empty slots the first filled one', () => {
    expect(textureSlotFill(graph({ type: 'normalMap' }), 'tex')).toEqual([0.5, 0.5, 1, 1]);
    expect(textureSlotFill(graph({ type: 'projectedSample', data: { decode: 'normal', colorSpace: 'linear' } }), 'tex')).toEqual([0.5, 0.5, 1, 1]);
    expect(textureSlotFill(graph({ type: 'projectedSample', data: { colorSpace: 'linear', absent: 'orm' } }), 'tex')).toEqual([1, 0.8, 0, 0]);
    // Without the field (or for a colour read) nothing changes: the first filled slot's texture.
    expect(textureSlotFill(graph({ type: 'sampleTexture' }), 'tex')).toBeNull();
    expect(textureSlotFill(graph({ type: 'sampleTexture', data: { absent: 'nonsense' } }), 'tex')).toBeNull();
    const orm = textureSlotLayers(['rock_orm', '', 'sand_orm'], [1, 0.8, 0, 0]);
    expect(orm).toEqual(['rock_orm', '#ffcc0000', 'sand_orm']);
    expect(parseFillLayer('#ffcc0000')).toEqual([255, 204, 0, 0]);
    expect(fillLayerId([0.5, 0.5, 1, 1])).toBe('#8080ffff');
    expect(parseFillLayer('rock_orm')).toBeNull();
    // The runtime's materials name the array with the constant layer; the template's arrays get theirs.
    const base = { shader: 'standard' as const, params: {}, textures: {} };
    const m = { ...base, materialId: 'm', name: 'M', graph: graph({ type: 'normalMap' }), parameters: [{ key: 'tex', type: 'texture' as const, default: ['', 'rock_n'] }] };
    expect(materialTextureSlotSets([m]).map(textureSlotSetKey)).toEqual(['normal:#8080ffff,rock_n']);
  });

  it('the encoding follows how the graph reads the parameter', () => {
    expect(textureSlotMode(graph({ type: 'sampleTexture' }), 'tex')).toBe('color');
    expect(textureSlotMode(graph({ type: 'sampleTexture', data: { colorSpace: 'linear' } }), 'tex')).toBe('data');
    expect(textureSlotMode(graph({ type: 'normalMap' }), 'tex')).toBe('normal');
    expect(textureSlotMode(graph({ type: 'normalMap' }, 'other'), 'tex')).toBe('color');
    expect(textureSlotMode(undefined, 'tex')).toBe('color');
    // Triplanar reads with its own colour space too.
    expect(textureSlotMode(graph({ type: 'triplanar', data: { colorSpace: 'linear' } }), 'tex')).toBe('data');
    expect(textureSlotMode(graph({ type: 'triplanar' }), 'tex')).toBe('color');
    // A projected sample: by its decode and colour space.
    expect(textureSlotMode(graph({ type: 'projectedSample', data: { decode: 'normal', colorSpace: 'linear' } }), 'tex')).toBe('normal');
    expect(textureSlotMode(graph({ type: 'projectedSample', data: { colorSpace: 'linear' } }), 'tex')).toBe('data');
    expect(textureSlotMode(graph({ type: 'projectedSample' }), 'tex')).toBe('color');
  });

  it('a set key reads back as its set; other strings are not keys', () => {
    const set = { layers: ['rock', 'sand', 'rock'], mode: 'normal' as const };
    expect(parseTextureSlotSetKey(textureSlotSetKey(set))).toEqual(set);
    expect(parseTextureSlotSetKey('rock')).toBeNull();
    expect(parseTextureSlotSetKey('srgb:rock')).toBeNull();
    expect(parseTextureSlotSetKey('data:')).toBeNull();
  });

  it('one set per distinct layers and encoding; the runtime materials name the assembled ids only', () => {
    const base = { shader: 'standard' as const, params: {}, textures: {}, graph: graph({ type: 'sampleTexture' }) };
    const a = { ...base, materialId: 'a', name: 'A', parameters: [{ key: 'tex', type: 'texture' as const, default: ['x', 'y'] }] };
    const b = { ...base, materialId: 'b', name: 'B', parameters: [{ key: 'tex', type: 'texture' as const, default: ['x', 'y'] }] };
    const c = { ...base, materialId: 'c', name: 'C', parameters: [{ key: 'tex', type: 'texture' as const, default: ['x', 'z'] }] };
    const plain = { ...base, materialId: 'd', name: 'D', parameters: [{ key: 'tex', type: 'texture' as const, default: 'arr' }] };
    const sets = materialTextureSlotSets([a, b, c, plain]);
    expect(sets.map(textureSlotSetKey)).toEqual(['color:x,y', 'color:x,z']);
    const out = withAssembledSlots([a, c, plain], (s) => `arr-${s.layers.join('')}`);
    expect(out.map((m) => m.parameters[0]!.default)).toEqual(['arr-xy', 'arr-xz', 'arr']);
    expect(out[2]).toBe(plain);
    expect(materialSlotTextureRefs({ parameters: a.parameters, values: { tex: ['q', ''] } })).toEqual(['q', 'x', 'y']);
  });
});

describe('layer names', () => {
  const base = { materialId: 'mat-l', name: 'Layers', shader: 'standard' as const, params: {}, textures: {} };
  const errorsOf = (m: Record<string, unknown>): string[] => {
    const errors: { path: string }[] = [];
    validateMaterials([m as unknown as MaterialDef], '', errors as never);
    return errors.map((e) => e.path);
  };
  it('takes a name or "" per layer, refuses other values and names on an instance', () => {
    expect(errorsOf({ ...base, layerNames: ['Grass', '', 'Rock'] })).toEqual([]);
    expect(errorsOf({ ...base, layerNames: ['x'.repeat(MATERIAL_LAYER_NAME_MAX + 1)] })).toEqual(['/0/layerNames']);
    expect(errorsOf({ ...base, layerNames: [3] })).toEqual(['/0/layerNames']);
    expect(errorsOf({ ...base, layerNames: 'Grass' })).toEqual(['/0/layerNames']);
    expect(errorsOf({ materialId: 'mat-i', name: 'Instance', shader: 'standard', params: {}, textures: {}, instanceOf: 'mat-l', layerNames: ['Grass'] })).toContain('/0/layerNames');
  });
  it('stores no trailing "" names (absent when none is left) and an instance draws with its root\'s', () => {
    expect(canonicalMaterials([{ ...base, layerNames: ['Grass', '', 'Rock', '', ''] }])[0]!.layerNames).toEqual(['Grass', '', 'Rock']);
    expect('layerNames' in canonicalMaterials([{ ...base, layerNames: ['', ''] }])[0]!).toBe(false);
    const resolved = resolveMaterialInstances([{ ...base, layerNames: ['Grass'] }, { materialId: 'mat-i', name: 'Instance', shader: 'standard', params: {}, textures: {}, instanceOf: 'mat-l' }]);
    expect(resolved.find((m) => m.materialId === 'mat-i')!.layerNames).toEqual(['Grass']);
  });
});

describe('height in alpha', () => {
  const withSlots = (m: MaterialDef, values: Record<string, unknown>): MaterialDef => ({ ...m, parameters: (m.parameters ?? []).map((p) => (p.key in values ? { ...p, default: values[p.key] } : p)) as MaterialDef['parameters'] });

  it('a layered surface\'s albedo array is a height array; its normal and ORM arrays are not', () => {
    const m = withSlots(layeredMaterial('ground', 'Ground'), { [LAYERED_TEXTURES.albedo]: ['rock', 'moss'], [LAYERED_TEXTURES.normals]: ['rock_n', ''] });
    expect([...heightAlphaParams(m.graph!)]).toEqual([LAYERED_TEXTURES.albedo]);
    const keys = materialTextureSlotSets([m]).map(textureSlotSetKey);
    expect(keys).toContain('color+height:rock,moss');
    expect(keys.some((k) => k.startsWith('normal:'))).toBe(true);
    expect(keys.filter((k) => k.includes('+height'))).toHaveLength(1);
    // The views and builds name the height array by its own key.
    const [drawn] = withAssembledSlots([m], textureSlotSetKey);
    expect(drawn!.parameters!.find((p) => p.key === LAYERED_TEXTURES.albedo)!.default).toBe('color+height:rock,moss');
  });

  it('a height key reads back with its rule; the plain key stays as it was', () => {
    const set = { layers: ['rock', 'moss'], mode: 'color' as const, height: true as const };
    expect(textureSlotSetKey(set)).toBe('color+height:rock,moss');
    expect(parseTextureSlotSetKey('color+height:rock,moss')).toEqual(set);
    expect(parseTextureSlotSetKey('color:rock,moss')).toEqual({ layers: ['rock', 'moss'], mode: 'color' });
    expect(parseTextureSlotSetKey('srgb+height:rock')).toBeNull();
  });

  it('the trim group of a layered surface with a mesh-UV layer is a height array too', () => {
    const projection = Array.from({ length: TEMPLATE_LAYERS }, (_, i) => (i === 0 ? UV_SOURCES.geometry : UV_SOURCES.top));
    const m = withSlots(layeredMaterial('wall', 'Wall'), { [LAYERED_TEXTURES.albedo]: ['sheet', 'moss'], layerProjection: projection });
    const keys = materialTextureSlotSets([m]).map(textureSlotSetKey);
    expect(keys).toEqual(expect.arrayContaining(['color+height:sheet', 'color+height:moss']));
  });

  it('a cut-out or decal material keeps A as opacity: no height array, even with a Height blend', () => {
    const n = (id: string, type: string, data?: GraphNode['data']): GraphNode => ({ id, type, position: [0, 0], ...(data !== undefined ? { data } : {}) });
    const e = (id: string, from: string, fp: string, to: string, tp: string): GraphEdge => ({ id, from: { node: from, port: fp }, to: { node: to, port: tp } });
    const nodes = [n('p', 'parameter', { key: 'alb' }), n('t', 'sampleTexture'), n('h', 'combine'), n('hb', 'heightBlend'), n('mix', 'weightedMix'), n('out', 'pbr')];
    const edges = [e('1', 'p', 'value', 't', 'tex'), e('2', 't', 'a', 'h', 'x'), e('3', 'h', 'xyzw', 'hb', 'heights'), e('4', 'hb', 'weights', 'mix', 'weights'), e('5', 't', 'rgb', 'mix', 'a'), e('6', 'mix', 'out', 'out', 'baseColor')];
    expect([...heightAlphaParams({ nodes, edges })]).toEqual(['alb']);
    expect([...heightAlphaParams({ nodes, edges: [...edges, e('7', 't', 'a', 'out', 'opacity')] })]).toEqual([]);
    expect([...heightAlphaParams({ nodes: nodes.map((x) => (x.id === 'out' ? n('out', 'pbr', { decal: 'blend' }) : x)), edges })]).toEqual([]);
    // A texture whose colour only is read is no height texture.
    expect([...heightAlphaParams({ nodes: [...nodes, n('q', 'parameter', { key: 'tint' }), n('t2', 'sampleTexture')], edges: [...edges, e('8', 'q', 'value', 't2', 'tex'), e('9', 't2', 'rgb', 'out', 'emissive')] })]).toEqual(['alb']);
  });
});
