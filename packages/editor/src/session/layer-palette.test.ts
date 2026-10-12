import { describe, expect, it } from 'vitest';
import type { MaterialDef } from '@thirdlight/project-model';

import { isLayeredMaterial, layerSetting, paletteLayers, paletteSource, slotTexture, standInLayers, withLayerName, withLayerSetting, withSlotTexture } from './layer-palette';
import { layeredMaterial } from './material-graph';

const names: Record<string, string> = { grass: 'Meadow grass', dirt: 'Forest dirt' };
const nameOf = (id: string): string | undefined => names[id];

describe('layer palette', () => {
  const base = layeredMaterial('mat-l', 'Ground');
  it('finds the object\'s layered material through its "*" mapping (instances shown on their parent)', () => {
    const plain: MaterialDef = { materialId: 'mat-p', name: 'Plain', shader: 'standard', params: {}, textures: {} };
    const inst: MaterialDef = { materialId: 'mat-i', name: 'Inst', shader: 'standard', params: {}, textures: {}, instanceOf: 'mat-l' };
    expect(isLayeredMaterial(base)).toBe(true);
    expect(isLayeredMaterial(plain)).toBe(false);
    expect(paletteSource(undefined, [base]).kind).toBe('none');
    expect(paletteSource({ '*': 'mat-p' }, [base, plain]).kind).toBe('none');
    expect(paletteSource({ '*': 'mat-l' }, [base])).toMatchObject({ kind: 'layered', slots: 'unset' });
    expect(paletteSource({ '*': 'mat-i' }, [base, inst])).toMatchObject({ kind: 'instance', parent: 'mat-l' });
  });
  it('shows one tile per slot, named by layerNames, the slot texture or its number', () => {
    expect(paletteLayers(base, nameOf, null).map((l) => [l.name, l.texture, l.empty ?? false])).toEqual([1, 2, 3, 4].map((n) => [`Layer ${n}`, null, true]));
    let m = withSlotTexture(base, 1, 'dirt');
    expect(paletteSource({ '*': 'mat-l' }, [m])).toMatchObject({ slots: 'slots' });
    m = withSlotTexture(m, 4, 'grass');
    m = withLayerName(m, 0, 'Base');
    const tiles = paletteLayers(m, nameOf, null);
    expect(tiles.map((l) => l.name)).toEqual(['Base', 'Forest dirt', 'Layer 3', 'Layer 4', 'Meadow grass']);
    expect(tiles.map((l) => l.texture)).toEqual([null, 'dirt', null, null, 'grass']);
    expect(tiles[0]!.empty).toBe(true);
    expect(tiles[1]!.sub).toBe('tiling 1 m');
    // A prebuilt array: as many tiles as it has layers, none with a picture.
    const arr = { ...base, parameters: base.parameters!.map((p) => (p.key === 'albedoHeight' ? { ...p, default: 'terrain-albedo' } : p)) };
    expect(paletteLayers(arr, nameOf, 5).map((l) => l.texture)).toEqual([null, null, null, null, null]);
  });
  it('a layer takes a texture in each of its arrays: the normal and ORM lists line up with the colour one; emptied, an array is unset again', () => {
    let m = withSlotTexture(withSlotTexture(base, 4, 'grass'), 4, 'grass-n', 'normals');
    const normals = (x: MaterialDef): unknown => x.parameters!.find((p) => p.key === 'normals')!.default;
    expect(normals(m)).toEqual(['', '', '', '', 'grass-n']);
    expect(slotTexture(m, 'normals', 4)).toBe('grass-n');
    expect(slotTexture(m, 'normals', 1)).toBeNull();
    expect(slotTexture(m, 'albedoHeight', 4)).toBe('grass');
    m = withSlotTexture(m, 4, '', 'normals');
    expect(normals(m)).toBe('');
  });
  it('names: "" drops back to the texture name; trailing empty names are not kept', () => {
    const m = withLayerName(withLayerName(base, 2, 'Rock'), 2, '  ');
    expect('layerNames' in m).toBe(false);
    expect(withLayerName(base, 1, 'Dirt').layerNames).toEqual(['', 'Dirt']);
  });
  it('a layer setting past the four gets its own value; the layers between keep what they showed', () => {
    let m = withLayerSetting(base, 'layerTiling', 1, 5);
    expect(layerSetting(m, 'layerTiling', 1)).toBe(5);
    m = withLayerSetting(m, 'layerTiling', 5, 3);
    // Layer 4 showed column 0's value (1), layer 5 column 1's (5): now its own 3.
    expect(m.parameters!.find((p) => p.key === 'layerTiling')!.extraLayers).toEqual([1, 3]);
    expect(layerSetting(m, 'layerTiling', 4)).toBe(1);
    expect(layerSetting(m, 'layerTiling', 5)).toBe(3);
    expect(paletteLayers(withLayerSetting(m, 'layerProjection', 0, 2), nameOf, null)[0]!.sub).toBe('tiling 1 m · biplanar');
  });
  it('stand-ins name the default colours as having no material', () => {
    expect(standInLayers(['#111111', '#222222']).map((l) => [l.name, l.sub, l.colour])).toEqual([['Layer 1', 'no material', '#111111'], ['Layer 2', 'no material', '#222222']]);
  });
});
