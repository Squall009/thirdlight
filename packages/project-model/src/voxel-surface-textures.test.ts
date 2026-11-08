/**
 * The voxel surfaces' texture arrays from material records: one slot list a
 * map, a layer per distinct set, each id's wall / floor / ceiling layer
 * (floor and ceiling falling back to the wall), neutral constants for a map
 * a set leaves out, at least two layers, the array limit, and the encodings
 * the assembly gets (the slot lists' keys, as Play, the export and the
 * views name the arrays).
 */
import { describe, expect, it } from 'vitest';
import { MAX_TEXTURE_LAYERS } from './content-limits';
import { FLAT_NORMAL_TEXEL, TEXTURE_ABSENT_VALUES } from './material-graph-kinds';
import { fillLayerId, textureSlotSetKey } from './texture-slots';
import type { MaterialVoxel } from './voxel-materials';
import { VOXEL_NO_LAYER, voxelSurfaceTextures } from './voxel-surface-textures';

const mat = (voxel: MaterialVoxel, shader = 'standard'): { shader: string; voxel: MaterialVoxel } => ({ shader, voxel });

describe('the voxel surface texture arrays', () => {
  it('give each id its wall, floor and ceiling layer, sharing a layer between equal sets, and fill a map a set leaves out with its neutral constant', () => {
    const t = voxelSurfaceTextures([
      // Out of id order: layers are numbered by ascending id all the same.
      mat({ id: 12, use: 'construction', surfaces: { wall: { albedoHeight: 'plaster-a', normal: 'plaster-n', orm: 'plaster-o' }, floor: { albedoHeight: 'timber-a', normal: 'timber-n' } } }),
      mat({ id: 3, use: 'terrain', surfaces: { wall: { albedoHeight: 'grass-a', orm: 'grass-o' } } }),
      // The same textures as 12's floor: the same layer.
      mat({ id: 11, use: 'construction', surfaces: { wall: { albedoHeight: 'timber-a', normal: 'timber-n' } } }),
      // No texture set, an albedo-less set, a decal: no layers.
      mat({ id: 2, use: 'terrain' }),
      mat({ id: 5, use: 'construction', surfaces: { wall: { normal: 'x-n' } } }),
      mat({ id: 6, use: 'construction', surfaces: { wall: { albedoHeight: 'decal-a' } } }, 'decal'),
      // A second record with id 3 is not drawn (the first decides).
      mat({ id: 3, use: 'terrain', surfaces: { wall: { albedoHeight: 'other-a' } } }),
    ])!;
    expect([...t.layers]).toEqual([
      [3, [0, 0, 0]],
      [11, [1, 1, 1]],
      [12, [2, 1, 2]],
    ]);
    const flat = fillLayerId(FLAT_NORMAL_TEXEL);
    const orm = fillLayerId(TEXTURE_ABSENT_VALUES.orm);
    expect(t.sets.albedoHeight).toEqual({ layers: ['grass-a', 'timber-a', 'plaster-a'], mode: 'color', height: true });
    expect(t.sets.normal).toEqual({ layers: [flat, 'timber-n', 'plaster-n'], mode: 'normal' });
    expect(t.sets.orm).toEqual({ layers: ['grass-o', orm, 'plaster-o'], mode: 'data' });
    expect(t.dropped).toEqual([]);
    // The keys the arrays go by (the same layers, encoding and height rule are one assembled array everywhere).
    expect(textureSlotSetKey(t.sets.albedoHeight)).toBe('color+height:grass-a,timber-a,plaster-a');
  });

  it('are none without a set with an albedo; one set makes two layers (an array), and a map no set names has no array', () => {
    expect(voxelSurfaceTextures([])).toBeNull();
    expect(voxelSurfaceTextures([mat({ id: 4, use: 'terrain' }), { shader: 'standard' }])).toBeNull();
    const one = voxelSurfaceTextures([mat({ id: 4, use: 'terrain', surfaces: { wall: { albedoHeight: 'sand-a' } } })])!;
    expect(one.sets.albedoHeight.layers).toEqual(['sand-a', 'sand-a']);
    expect(one.sets.normal).toBeUndefined();
    expect(one.sets.orm).toBeUndefined();
    expect(one.layers.get(4)).toEqual([0, 0, 0]);
    // A ceiling of its own, the floor falling back to the wall.
    const c = voxelSurfaceTextures([mat({ id: 9, use: 'construction', surfaces: { wall: { albedoHeight: 'w' }, ceiling: { albedoHeight: 'c' } } })])!;
    expect(c.layers.get(9)).toEqual([0, 0, 1]);
    // Only a floor set: the wall and ceiling have none.
    const f = voxelSurfaceTextures([mat({ id: 9, use: 'construction', surfaces: { floor: { albedoHeight: 'f' } } })])!;
    expect(f.layers.get(9)).toEqual([VOXEL_NO_LAYER, 0, VOXEL_NO_LAYER]);
  });

  it('stop at the array limit: a set past it has no layer and its id is listed', () => {
    const many = Array.from({ length: MAX_TEXTURE_LAYERS + 2 }, (_, i) => mat({ id: i + 1, use: 'terrain', surfaces: { wall: { albedoHeight: `t${i}` } } }));
    const t = voxelSurfaceTextures(many)!;
    expect(t.sets.albedoHeight.layers).toHaveLength(MAX_TEXTURE_LAYERS);
    expect(t.layers.get(MAX_TEXTURE_LAYERS)).toEqual([MAX_TEXTURE_LAYERS - 1, MAX_TEXTURE_LAYERS - 1, MAX_TEXTURE_LAYERS - 1]);
    expect(t.layers.has(MAX_TEXTURE_LAYERS + 1)).toBe(false);
    expect(t.dropped).toEqual([MAX_TEXTURE_LAYERS + 1, MAX_TEXTURE_LAYERS + 2]);
  });
});
