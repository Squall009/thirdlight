import { describe, expect, it } from 'vitest';
import type { MaterialDef } from '@thirdlight/project-model';

import { layerSheet, paintableMaterial, paletteLayers, paletteSource, slotTexture, withLayerName, withSlotTexture } from './layer-palette';
import { layeredMaterial } from './material-graph';
import { paintChannels, paintMaterialSlots, tileOf } from './vertex-paint-channels';

const plain: MaterialDef = { materialId: 'm-plain', name: 'Mill walls', shader: 'standard', params: {}, textures: { map: 'mill', normalMap: 'mill-n' } };
const tint: MaterialDef = { materialId: 'm-tint', name: 'Tint', shader: 'standard', params: { paintTint: true }, textures: {} };
const trim: MaterialDef = { materialId: 'm-trim', name: 'Sheet', shader: 'trim', params: {}, textures: { map: 'sheet', normalMap: 'sheet-n', ormMap: 'sheet-orm' }, trim: { size: [256, 256], texelDensity: 256, padding: 8, rows: [{ slot: 'a', top: 8, bottom: 120 }] } as MaterialDef['trim'] };

describe('what vertex paint means on a material', () => {
  it('a layered surface: Base, layers 2–4 on R, G, B by their names and pictures, Wet on A; the base erases R, G and B', () => {
    let layered = withSlotTexture(withSlotTexture(layeredMaterial('m-l', 'Walls'), 0, 'plaster'), 1, 'brick');
    layered = withLayerName(withLayerName(layered, 2, 'Moss'), 3, 'Rust');
    const c = paintChannels({ '*': 'm-l' }, [layered], paletteLayers(layered, (id) => ({ plaster: 'Plaster', brick: 'Brick' })[id], null));
    expect(c.meaning).toBe('layers');
    expect(c.tiles.map((t) => [t.name, t.badge ?? String(t.index + 1), t.texture])).toEqual([
      ['Plaster', 'B', 'plaster'],
      ['Brick', '2', 'brick'],
      ['Moss', '3', null],
      ['Rust', '4', null],
      ['Wet', 'W', null],
    ]);
    expect(c.targets).toEqual([{ channel: 0, channels: [1, 2], erases: true }, { channel: 0 }, { channel: 1 }, { channel: 2 }, { channel: 3 }]);
    expect(c.views.map((v) => [v.label, v.channel])).toEqual([['Final', null], ['Brick', 0], ['Moss', 1], ['Rust', 2], ['Wetness', 3]]);
    expect(c.summary).toMatch(/Layered surface · 4 layers \+ wetness/);
    expect(tileOf(c, { channel: 1 })).toBe(2);
    expect(tileOf(c, { channel: 0, channels: [1, 2] })).toBe(0);
  });
  it('a trim sheet is one layer: its paint is wetness on A; a paint tint names its channels; a material that reads no paint says so', () => {
    const t = paintChannels({ '*': 'm-trim' }, [trim]);
    expect(t.meaning).toBe('trim');
    expect(t.tiles.map((x) => x.name)).toEqual(['Wetness']);
    expect(t.targets).toEqual([{ channel: 3 }]);
    expect(t.tiles[0]!.wet).toBe(true);
    const n = paintChannels({ '*': 'm-tint' }, [tint]);
    expect(n.meaning).toBe('tint');
    expect(n.tiles.map((x) => x.name)).toEqual(['Tint red', 'Tint green', 'Tint blue', 'Tint amount']);
    expect(n.targets.map((x) => x.channel)).toEqual([0, 1, 2, 3]);
    const off = paintChannels({ '*': 'm-plain' }, [plain]);
    expect(off.meaning).toBe('none');
    expect(off.material?.name).toBe('Mill walls');
    expect(off.tiles).toHaveLength(5);
    expect(paintChannels(undefined, [plain])).toMatchObject({ meaning: 'none', material: null });
  });
  it('reads the material an object draws with: "*", else the one its named slots name', () => {
    expect(paintMaterialSlots(undefined)).toBeNull();
    expect(paintMaterialSlots({ '*': 'a' })).toEqual({ materialId: 'a', slots: [] });
    expect(paintMaterialSlots({ '*': 'a', body: 'a', lid: 'b' })).toEqual({ materialId: 'a', slots: ['body'] });
    expect(paintMaterialSlots({ spline: 't' })).toEqual({ materialId: 't', slots: ['spline'] });
    expect(paintMaterialSlots({ lid: 'b', body: 'a' })).toEqual({ materialId: 'a', slots: ['body'] });
  });
  it('Make it paintable: the base keeps the old maps and name; a trim sheet\'s base follows the sheet', () => {
    const m = paintableMaterial(plain, 'm-new', 'Mill walls layers');
    expect(slotTexture(m, 'albedoHeight', 0)).toBe('mill');
    expect(slotTexture(m, 'normals', 0)).toBe('mill-n');
    expect(m.layerNames?.[0]).toBe('Mill walls');
    expect(paintChannels({ '*': 'm-new' }, [m]).meaning).toBe('layers');
    const s = paintableMaterial(trim, 'm-new2', 'Sheet layers');
    expect(layerSheet(s, 0)).toBe('m-trim');
    expect(slotTexture(s, 'albedoHeight', 0)).toBe('sheet');
    expect(slotTexture(s, 'orm', 0)).toBe('sheet-orm');
    expect(s.layerNames?.[0]).toBe('Sheet');
  });
  it('an instance is read and made paintable as it draws: its root\'s shader, graph and rows with its own values', () => {
    const plainInst: MaterialDef = { materialId: 'm-plain-i', name: 'Mill walls red', shader: 'standard', params: {}, textures: { map: 'mill-red' }, instanceOf: 'm-plain' };
    const src = paletteSource({ '*': 'm-plain-i' }, [plain, plainInst]);
    expect(src.kind).toBe('none');
    const m = paintableMaterial(src.material, 'm-new3', 'Red layers');
    expect(slotTexture(m, 'albedoHeight', 0)).toBe('mill-red');
    expect(slotTexture(m, 'normals', 0)).toBe('mill-n');
    expect(m.layerNames?.[0]).toBe('Mill walls red');
    // A trim instance: paint means wetness (its root's), and its base follows the instance (its textures, the root's rows).
    const trimInst: MaterialDef = { materialId: 'm-trim-i', name: 'Sheet dark', shader: 'trim', params: {}, textures: { map: 'sheet-dark' }, instanceOf: 'm-trim' };
    expect(paintChannels({ '*': 'm-trim-i' }, [trim, trimInst]).meaning).toBe('trim');
    const t = paintableMaterial(paletteSource({ '*': 'm-trim-i' }, [trim, trimInst]).material, 'm-new4', 'Dark layers');
    expect(layerSheet(t, 0)).toBe('m-trim-i');
    expect(slotTexture(t, 'albedoHeight', 0)).toBe('sheet-dark');
    expect(slotTexture(t, 'orm', 0)).toBe('sheet-orm');
    // An instance of a graph that reads the paint its own way: the graph's bytes, not a paint tint.
    const graphRoot: MaterialDef = { materialId: 'm-g', name: 'Stain', shader: 'standard', params: {}, textures: {}, graph: { nodes: [{ id: 'out', type: 'pbr', position: [0, 0] }, { id: 'vc', type: 'vertexColor', position: [0, 0], data: { set: 'paint' } }], edges: [{ id: 'e', from: { node: 'vc', port: 'rgb' }, to: { node: 'out', port: 'baseColor' } }] } };
    const graphInst: MaterialDef = { materialId: 'm-g-i', name: 'Stain 2', shader: 'standard', params: {}, textures: {}, instanceOf: 'm-g' };
    expect(paintChannels({ '*': 'm-g-i' }, [graphRoot, graphInst]).meaning).toBe('raw');
  });
});
