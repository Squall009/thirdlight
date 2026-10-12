/**
 * Per-layer texture slots: the rules of a slot list, the encoding read from
 * the graph, the distinct sets the materials draw with, and the materials as
 * the runtime gets them (each list replaced by its assembled array's id).
 */
import { describe, expect, it } from 'vitest';

import type { GraphData } from './graph';
import { canonicalMaterials, materialParameterValueError, MATERIAL_LAYER_NAME_MAX, resolveMaterialInstances, validateMaterials, type MaterialDef } from './materials';
import { materialSlotTextureRefs, materialTextureSlotSets, parseTextureSlotSetKey, textureSlotLayers, textureSlotMode, textureSlotSetKey, withAssembledSlots } from './texture-slots';

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
