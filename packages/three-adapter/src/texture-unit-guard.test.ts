import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { fragmentTextureNamesOf, fragmentTexturesOf, TextureUnitGuard } from './texture-unit-guard';

/** A render object as the guard reads it: bindings with stages and textures (2: the fragment stage). */
function program(textures: readonly [string, string | null, number][], object = new THREE.Mesh()) {
  const material = new THREE.MeshStandardNodeMaterial();
  material.name = 'voxel surface';
  return {
    object,
    material,
    scene: new THREE.Scene(),
    getBindings: () => [{ bindings: textures.map(([name, tex, visibility]) => ({ isSampledTexture: true, visibility, name, texture: tex === null ? null : { name: tex } })) }],
    getNodeBuilderState: () => ({ fragmentShader: null }),
  };
}

describe('the texture-unit guard', () => {
  it('names a program\'s sampled fragment textures and, while recording, keeps each program with its count and verdict', () => {
    const fits = program([['nodeTexture_1', 'voxel albedo', 2], ['nodeTexture_2', null, 2], ['vertexOnly', 'heights', 1]]);
    expect(fragmentTexturesOf(fits)).toBe(2);
    expect(fragmentTextureNamesOf(fits)).toEqual(['nodeTexture_1 (voxel albedo)', 'nodeTexture_2']);
    const guard = new TextureUnitGuard({ renderObject: () => undefined, backend: { device: { limits: { maxSampledTexturesPerShaderStage: 2 } } } });
    expect(guard.admit(fits as never, fits.material, fits.scene)).toBe(true);
    // Not recording: nothing kept.
    expect(guard.programs.size).toBe(0);
    guard.recording = true;
    const over = program([['a', 'surface texels', 2], ['b', 'light volume pool', 2], ['c', null, 2]]);
    expect(guard.admit(fits as never, fits.material, fits.scene)).toBe(true);
    expect(guard.admit(over as never, over.material, over.scene)).toBe(false);
    expect(guard.admit(program([['a', 'surface texels', 2], ['b', 'light volume pool', 2], ['c', null, 2]]) as never, over.material, over.scene)).toBe(false);
    const kept = [...guard.programs.values()];
    expect(kept.map((p) => [p.used, p.admitted, p.objects])).toEqual([[2, true, 1], [3, false, 2]]);
    expect(kept[1]!.names).toEqual(['a (surface texels)', 'b (light volume pool)', 'c']);
    expect(guard.over).toBe(2);
  });
});
