/**
 * The far view's draws at the program boundary: brick nodes go into brick
 * groups (an instanced box a node over its bricks' boxes, each brick's
 * distances and baked samples uploaded into a region of the shared atlas,
 * each node's brick table into a page), their program walks the node's
 * bricks and writes its own depth on WebGPU (WGSL) and WebGL 2 (GLSL)
 * alike, a node that comes back as a mesh (the fallback) leaves its brick
 * group and gives its regions and page back, removals free the groups, and
 * the half-resolution march moves the brick draws into its own pass.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { chunkGrid, createWorldStore, DISTANCE_BRICK_SAMPLES, DISTANCE_BRICK_SIDE, FAR_BRICK_BAKED_BYTES, FAR_VERTEX_BYTES, farBricksFromFaces, farNodeMarchedBox, FloatingOrigin, MATERIAL_BITS, SHADER_BORDER_CELLS, SHADER_READ_DEPTH_CELLS, shaderGridSide, SHAPE_FULL, VOXEL_ROLE, VOXEL_SIZE_M, WETNESS_MAX, type FarNodeDraw } from '@thirdlight/voxel';

import { fragmentWgslOf, glslRenderer, litScene, wgslRenderer } from './test-wgsl';
import { voxelStandInLook } from './voxel-chunk-view';
import { FAR_NODE_ATTRIBUTE, FAR_NODE_HI_ATTRIBUTE, FAR_NODE_LO_ATTRIBUTE, FAR_NODE_PAGE_ATTRIBUTE } from './voxel-far-bricks';
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

/** A level-2 node of flat ground (its top at cell 44 of node row 1) as the far field's bricks (faces from its cells). */
function brickNode(nx: number): FarNodeDraw {
  const s = createWorldStore(grid);
  for (let x = nx * 32 - 4; x < nx * 32 + 36; x++) for (let z = -4; z < 36; z++) for (let y = 28; y < 44; y++) s.setVoxel(x, y, z, { material: 3, role: VOXEL_ROLE.terrain, shape: SHAPE_FULL, wetness: 0 });
  return { level: 2, nx, ny: 1, nz: 0, bricks: farBricksFromFaces(grid, s, [nx, 1, 0], 1) };
}

/** Atlas bytes at its first size (4³ regions of 9³ texels): the distances (1 byte) and the baked samples, and the two page stores (4³ pages of 4³ texels, 4 bytes). */
const ATLAS_BYTES = (4 * DISTANCE_BRICK_SIDE) ** 3 * (1 + FAR_BRICK_BAKED_BYTES) + 2 * (4 * 4) ** 3 * 4;

describe('the far view', () => {
  it('draws a brick node as one instanced box over its bricks in the shared atlas, a program walking its brick table with its own depth on both backends, and swaps kinds per node', () => {
    const r = recorder();
    const v = view(r);
    expect(v.brickHalf).toBe(false);
    const a = brickNode(0);
    const b = brickNode(1);
    v.apply({ added: [a, b], removed: [] }, undefined);
    expect(v.draws).toBe(1);
    expect(v.nodes).toBe(2);
    expect(v.bricks).toBe(32);
    expect(v.triangles).toBe(0);
    const mesh = v.root.children[0] as THREE.Mesh;
    const geo = mesh.geometry as THREE.InstancedBufferGeometry;
    expect(geo.instanceCount).toBe(2);
    // The second node starts one node (32 cells of 2 m) along x from the group's corner.
    const inst = geo.getAttribute(FAR_NODE_ATTRIBUTE).array as Float32Array;
    expect([inst[0], inst[4], inst[3]]).toEqual([0, 64, 4 * VOXEL_SIZE_M]);
    // The node's box is its stored bricks' union, the lip on its node faces.
    const lo = geo.getAttribute(FAR_NODE_LO_ATTRIBUTE).array as Float32Array;
    const hi = geo.getAttribute(FAR_NODE_HI_ATTRIBUTE).array as Float32Array;
    const box = farNodeMarchedBox(a.bricks!)!;
    expect([...lo.subarray(0, 3)]).toEqual(box.lo);
    expect([...hi.subarray(0, 3)]).toEqual(box.hi);
    // Each brick's distances and baked samples (four bytes a sample) went into one region each; each node's page
    // (two stores) names its 16 stored bricks' regions.
    const sizes = r.uploads.map((u) => u.bytes.length);
    expect(sizes.filter((n) => n === DISTANCE_BRICK_SAMPLES).length).toBe(32);
    expect(sizes.filter((n) => n === DISTANCE_BRICK_SAMPLES * FAR_BRICK_BAKED_BYTES).length).toBe(32);
    const pages = r.uploads.filter((u) => u.bytes.length === 64 * 4);
    expect(pages.length).toBe(4);
    const page = geo.getAttribute(FAR_NODE_PAGE_ATTRIBUTE).array as Float32Array;
    const table = pages.find((u) => u.at.x === page[0] && u.at.y === page[1] && u.at.z === page[2] && u.bytes.some((x, i) => i % 4 === 3 && x === 255))!.bytes;
    let stored = 0;
    for (let i = 0; i < 64; i++) if (table[i * 4 + 3] === 255) stored++;
    expect(stored).toBe(16);
    // The atlas, two instances of two vec4s and two vec3s, and the box.
    expect(v.bytes).toBe(ATLAS_BYTES + 2 * (16 + 16 + 12 + 12) + 24 * 4 + 36 * 2);
    const scene = litScene();
    scene.add(v.root);
    const wgsl = fragmentWgslOf(wgslRenderer(), scene, mesh);
    expect(wgsl).toContain('frag_depth');
    expect(wgsl).toMatch(/for \(|loop/);
    expect(wgsl).toContain('discard');
    const glsl = fragmentWgslOf(glslRenderer(), scene, mesh);
    expect(glsl).toContain('gl_FragDepth');
    expect(glsl).toContain('discard');
    // Node b comes back as a mesh (the fallback switched on): it leaves the brick group for a mesh group, between the same two frames.
    const tri: FarNodeDraw = { level: 2, nx: 1, ny: 1, nz: 0, mesh: { vertexCount: 3, vertices: new Uint8Array(3 * FAR_VERTEX_BYTES).map((_, i) => (i % FAR_VERTEX_BYTES === 0 ? 40 + i : 0)), indices: new Uint16Array([0, 1, 2]), skirtTriangles: 0 } };
    v.apply({ added: [tri], removed: [] }, undefined);
    expect(v.draws).toBe(2);
    expect(v.bricks).toBe(16);
    expect(v.triangles).toBe(1);
    // Its regions and page are given back: a node arriving uploads into them, and the atlas does not grow.
    const c = brickNode(2);
    const before = r.uploads.length;
    v.apply({ added: [c], removed: [] }, undefined);
    expect(r.uploads.length).toBe(before + 32 + 2);
    expect(v.bricks).toBe(32);
    expect(v.bytes - ATLAS_BYTES).toBeLessThan(ATLAS_BYTES);
    v.apply({ added: [], removed: [{ level: 2, nx: 0, ny: 1, nz: 0 }, { level: 2, nx: 1, ny: 1, nz: 0 }, { level: 2, nx: 2, ny: 1, nz: 0 }] }, undefined);
    expect(v.draws).toBe(0);
    expect(v.bricks).toBe(0);
    expect(v.bytes).toBe(ATLAS_BYTES);
    v.dispose();
  });

  it('marches at half resolution: the brick draws move to the pass scene, write the packed target, and a lit composite in the frame writes their depth (both backends)', () => {
    const r = recorder();
    const v = view(r);
    v.apply({ added: [brickNode(0)], removed: [] }, undefined);
    const uploads = r.uploads.length;
    v.setBrickHalf(true);
    // No upload: the same atlas, the draws made again into the pass's scene; the frame keeps only the composite.
    expect(r.uploads.length).toBe(uploads);
    const bricks: THREE.Mesh[] = [];
    v.halfScene!.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) bricks.push(o as THREE.Mesh);
    });
    expect(bricks.length).toBe(1);
    const inFrame = v.root.children as THREE.Mesh[];
    expect(inFrame.map((m) => m.name)).toEqual(['voxel-far half-resolution composite']);
    expect(v.bricks).toBe(16);
    // The half pass's program: the march with its depth, its output the packed texel (no lighting).
    const pass = new THREE.Scene();
    pass.add(v.halfScene!);
    const wgsl = fragmentWgslOf(wgslRenderer(), pass, bricks[0]!);
    expect(wgsl).toContain('frag_depth');
    expect(fragmentWgslOf(glslRenderer(), pass, bricks[0]!)).toContain('gl_FragDepth');
    // The composite: lit by the scene, its depth the hit's.
    const scene = litScene();
    scene.add(v.root);
    const composite = fragmentWgslOf(wgslRenderer(), scene, inFrame[0]!);
    expect(composite).toContain('frag_depth');
    expect(composite).toContain('discard');
    expect(fragmentWgslOf(glslRenderer(), scene, inFrame[0]!)).toContain('gl_FragDepth');
    // Back in the frame: the brick draws return, the composite goes.
    v.setBrickHalf(false);
    expect(v.halfScene).toBeNull();
    expect(v.root.children.length).toBe(1);
    expect((v.root.children[0] as THREE.Mesh).name).not.toContain('composite');
    v.dispose();
  });

});
