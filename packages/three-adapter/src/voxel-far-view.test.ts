/**
 * The far view's two draw modes at the program boundary: brick nodes go into
 * brick groups (an instanced box a stored brick, each brick's samples and
 * looks uploaded into a region of the shared atlas), their program marches
 * and writes its own depth on WebGPU (WGSL) and WebGL 2 (GLSL) alike, a node
 * that comes back as a mesh leaves its brick group and gives its regions
 * back, and removals free the groups.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { chunkGrid, createWorldStore, DISTANCE_BRICK_SAMPLES, DISTANCE_BRICK_SIDE, FAR_VERTEX_BYTES, farBricksOf, FloatingOrigin, MATERIAL_BITS, SHADER_BORDER_CELLS, SHADER_READ_DEPTH_CELLS, shaderGridSide, SHAPE_FULL, VOXEL_ROLE, VOXEL_SIZE_M, WETNESS_MAX, type FarNodeDraw } from '@thirdlight/voxel';

import { fragmentWgslOf, glslRenderer, litScene, wgslRenderer } from './test-wgsl';
import { voxelStandInLook } from './voxel-chunk-view';
import { FAR_BRICK_ATTRIBUTE, FAR_BRICK_BLOCK_ATTRIBUTE, FAR_BRICK_BOUNDS_ATTRIBUTE } from './voxel-far-bricks';
import { VoxelFarView } from './voxel-far-mesh';
import { createVoxelSurface, type VoxelGridRenderer } from './voxel-surface';

const grid = chunkGrid(32);

/** A WebGL 2-like uploader that records each region's upload (three's copy into the atlas). */
function recorder(): VoxelGridRenderer & { uploads: Array<{ at: THREE.Vector3; bytes: Uint8Array }> } {
  const uploads: Array<{ at: THREE.Vector3; bytes: Uint8Array }> = [];
  return {
    uploads,
    backend: { isWebGLBackend: true, get: () => ({}), copyTextureToTexture: (src, _dst, _r, at) => void uploads.push({ at: at.clone(), bytes: (src.image as { data: Uint8Array }).data.slice() }) },
    initTexture: () => undefined,
    copyTextureToTexture: () => undefined,
  };
}

function view(renderer: VoxelGridRenderer): VoxelFarView {
  const surface = createVoxelSurface({ cellMetres: VOXEL_SIZE_M, side: shaderGridSide(grid.edge), border: SHADER_BORDER_CELLS, materialBits: MATERIAL_BITS, wetnessMax: WETNESS_MAX, readDepthCells: SHADER_READ_DEPTH_CELLS }, { look: voxelStandInLook, blendMetres: 0.25 });
  return new VoxelFarView({ grid, origin: new FloatingOrigin({ grid, rebaseDistanceM: 512, origin: { x: 0, y: 0, z: 0 } }), surface, renderer });
}

/** A level-2 node of flat ground (its top at cell 44 of node row 1) as bricks. */
function brickNode(nx: number): FarNodeDraw {
  const s = createWorldStore(grid);
  for (let x = nx * 32 - 4; x < nx * 32 + 36; x++) for (let z = -4; z < 36; z++) for (let y = 28; y < 44; y++) s.setVoxel(x, y, z, { material: 3, role: VOXEL_ROLE.terrain, shape: SHAPE_FULL, wetness: 0 });
  return { level: 2, nx, ny: 1, nz: 0, bricks: farBricksOf(grid, s, [nx, 1, 0]) };
}

describe('the far view', () => {
  it('draws brick nodes as instanced boxes over the shared atlas, builds a marching program with its own depth on both backends, and swaps kinds per node', () => {
    const r = recorder();
    const v = view(r);
    const a = brickNode(0);
    const b = brickNode(1);
    v.apply({ added: [a, b], removed: [] }, undefined);
    expect(v.draws).toBe(1);
    expect(v.nodes).toBe(2);
    expect(v.bricks).toBe(32);
    expect(v.triangles).toBe(0);
    const mesh = v.root.children[0] as THREE.Mesh;
    const geo = mesh.geometry as THREE.InstancedBufferGeometry;
    expect(geo.instanceCount).toBe(32);
    // The second node's bricks start one node (32 cells of 2 m) along x from the group's corner.
    const inst = geo.getAttribute(FAR_BRICK_ATTRIBUTE).array as Float32Array;
    const xs = new Set<number>();
    for (let i = 0; i < 32; i++) xs.add(inst[i * 4]!);
    expect([...xs].sort((p, q) => p - q)).toEqual([0, 16, 32, 48, 64, 80, 96, 112]);
    // Each brick's samples and looks went into one region of each atlas texture, at the region its instance names.
    expect(r.uploads.length).toBe(64);
    const blocks = geo.getAttribute(FAR_BRICK_BLOCK_ATTRIBUTE).array as Float32Array;
    const first = r.uploads.filter((u) => u.at.x === blocks[0] && u.at.y === blocks[1] && u.at.z === blocks[2]);
    expect(first.map((u) => u.bytes.length).sort((p, q) => p - q)).toEqual([DISTANCE_BRICK_SAMPLES, DISTANCE_BRICK_SAMPLES * 2]);
    expect([...first.find((u) => u.bytes.length === DISTANCE_BRICK_SAMPLES)!.bytes]).toEqual([...a.bricks!.samples.subarray(0, DISTANCE_BRICK_SAMPLES)]);
    expect(blocks[3]).toBe(4 * VOXEL_SIZE_M);
    // The atlas (4³ regions to start, 1 + 2 bytes a texel) and the instances' two vec4s and packed bounds, and the box.
    const atlasBytes = (4 * DISTANCE_BRICK_SIDE) ** 3 * 3;
    expect(v.bytes).toBe(atlasBytes + 32 * (32 + 8) + 24 * 4 + 36 * 2);
    // The occupancy build's bricks are marched over their whole box: bounds 0–8 on every axis.
    const bounds = geo.getAttribute(FAR_BRICK_BOUNDS_ATTRIBUTE).array as Float32Array;
    expect([bounds[0], bounds[1]]).toEqual([0, 8 + 16 * 8 + 256 * 8]);
    const scene = litScene();
    scene.add(v.root);
    const wgsl = fragmentWgslOf(wgslRenderer(), scene, mesh);
    expect(wgsl).toContain('frag_depth');
    expect(wgsl).toMatch(/for \(|loop/);
    expect(wgsl).toContain('discard');
    const glsl = fragmentWgslOf(glslRenderer(), scene, mesh);
    expect(glsl).toContain('gl_FragDepth');
    expect(glsl).toContain('discard');
    // Node b comes back as a mesh (the mode switched): it leaves the brick group for a mesh group, between the same two frames.
    const tri: FarNodeDraw = { level: 2, nx: 1, ny: 1, nz: 0, mesh: { vertexCount: 3, vertices: new Uint8Array(3 * FAR_VERTEX_BYTES).map((_, i) => (i % FAR_VERTEX_BYTES === 0 ? 40 + i : 0)), indices: new Uint16Array([0, 1, 2]), skirtTriangles: 0 } };
    v.apply({ added: [tri], removed: [] }, undefined);
    expect(v.draws).toBe(2);
    expect(v.bricks).toBe(16);
    expect(v.triangles).toBe(1);
    // Its regions are given back: a node arriving uploads into them, and the atlas does not grow.
    const c = brickNode(2);
    const before = r.uploads.length;
    v.apply({ added: [c], removed: [] }, undefined);
    expect(r.uploads.length).toBe(before + 32);
    expect(v.bricks).toBe(32);
    expect(v.bytes - atlasBytes).toBeLessThan(atlasBytes);
    v.apply({ added: [], removed: [{ level: 2, nx: 0, ny: 1, nz: 0 }, { level: 2, nx: 1, ny: 1, nz: 0 }, { level: 2, nx: 2, ny: 1, nz: 0 }] }, undefined);
    expect(v.draws).toBe(0);
    expect(v.bricks).toBe(0);
    expect(v.bytes).toBe(atlasBytes);
    v.dispose();
  });
});
