/**
 * The light volume's read as three builds it into a lit program (WGSL, no GPU): the form that draws clean on the
 * integrated GPU. The read written shorter (the eight cells as one loop sharing an index load, only the faces with a
 * weight loaded, one cell alone past a distance from the eye) drew white, green, magenta and black pixels on roofs,
 * gables and the ground by walls while every value it computed was finite and in range; that form is kept out here,
 * since nothing in Node can draw the pixels it made.
 */
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { describe, expect, it } from 'vitest';

import { volumeReadFlag, VOLUME_LEVELS, VOLUME_POOL_WIDTH } from './voxel-light-volume-layout';
import { registerVoxelLightVolume, VoxelVolumeLight } from './voxel-light-volume-read';
import { fragmentWgslOf, litScene, wgslRenderer } from './test-wgsl';

function readProgram(flag: string | null): string {
  registerVoxelLightVolume();
  const tex = (): THREE.Texture => new THREE.DataTexture(new Uint32Array(4), 2, 2, THREE.RedIntegerFormat, THREE.UnsignedIntType);
  const light = new VoxelVolumeLight({ pool: tex(), indexTex: tex(), originNodes: Array.from({ length: VOLUME_LEVELS }, () => TSL.uniform(new THREE.Vector3())) }, volumeReadFlag(flag));
  const scene = litScene();
  scene.add(light);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardNodeMaterial());
  scene.add(mesh);
  const wgsl = fragmentWgslOf(wgslRenderer(), scene, mesh);
  // The read: from its light's first assignment to its weight's.
  const from = wgsl.indexOf('tlVolumeLight = vec3<f32>( 0.0');
  const to = wgsl.indexOf('tlVolumeWeight = ');
  expect(from).toBeGreaterThan(0);
  expect(to).toBeGreaterThan(from);
  return wgsl.slice(from, to);
}

describe("the light volume's read in a lit program", () => {
  it('reads every level at every distance the same way: eight cells written out, each its own index load and its three faces; no loop, no distance', () => {
    const read = readProgram(null);
    expect(read).not.toMatch(/\bfor\s*\(/);
    expect(read).not.toMatch(/cameraPosition/);
    // Per level eight cells, each an index load and its faces: the x face, then y and z each written in both arms of
    // the normal's sign (one runs), five pool loads in the text for three run.
    const loads = read.match(/textureLoad\([^;]*/g) ?? [];
    const pool = loads.filter((l) => l.includes(`% ${VOLUME_POOL_WIDTH}u`));
    expect(loads.length - pool.length).toBe(VOLUME_LEVELS * 8);
    expect(pool.length).toBe(VOLUME_LEVELS * 8 * 5);
    for (let level = 0; level < VOLUME_LEVELS; level++) expect(read).toContain(`tlVolume${level}Weights`);
  });

  it('its index probe loads no face', () => {
    const read = readProgram('index');
    const loads = read.match(/textureLoad\([^;]*/g) ?? [];
    expect(loads.length).toBe(VOLUME_LEVELS * 8);
    expect(loads.filter((l) => l.includes(`% ${VOLUME_POOL_WIDTH}u`))).toEqual([]);
  });
});
