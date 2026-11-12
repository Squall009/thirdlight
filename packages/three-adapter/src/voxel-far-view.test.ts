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
import { chunkGrid, createWorldStore, DISTANCE_BRICK_SAMPLES, DISTANCE_BRICK_SIDE, FAR_BRICK_BAKED_BYTES, FAR_BRICK_GPU_BYTES, FAR_BRICK_TABLE_GPU_BYTES, farBricksGpuBytes, FAR_VERTEX_BYTES, farBricksFromFaces, farNodeMarchedBox, FloatingOrigin, MATERIAL_BITS, SHADER_BORDER_CELLS, SHADER_READ_DEPTH_CELLS, shaderGridSide, SHAPE_FULL, VOXEL_ROLE, VOXEL_SIZE_M, WETNESS_MAX, type FarNodeDraw } from '@thirdlight/voxel';

import { CULLED_COPIES_ATTRIBUTE, CULLED_COPIES_KEY, type CulledCopies } from './attribute-instancing';
import { OccludeeRegistry } from './occludees';
import { COPY_BOX_FLOAT } from './occlusion-instances-rule';
import { TwoPassFrame } from './occlusion-passes';
import { fragmentWgslOf, glslRenderer, litScene, wgslOf, wgslRenderer } from './test-wgsl';
import { voxelStandInLook } from './voxel-chunk-view';
import { FAR_NODE_ATTRIBUTE } from './voxel-far-bricks';
import { FAR_NODE_FLOATS, FAR_NODE_HI_FLOAT, FAR_NODE_LO_FLOAT, FAR_NODE_PAGE_FLOAT, unpackFarBoxCorner } from './voxel-far-cull';
import { VoxelFarView } from './voxel-far-mesh';
import { createVoxelSurface, GRID_TRIM_SLACK, VoxelShaderGrids, type VoxelGridRenderer } from './voxel-surface';
import { FarBrickAtlas } from './voxel-far-bricks';
import { FAR_VIS_CELL_FROM, FAR_VIS_CELL_SPAN, FAR_VIS_CELL_STEPS, packFarVisibility, unpackFarVisibility } from './voxel-far-visibility';
import { installMotionVectors, motionVectorOutput, MOTION_TARGET } from './motion-vectors';
import { INSTANCE_CULLER_KEY } from './attribute-instancing';
import { mrt, output } from 'three/tsl';

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

/** A WebGPU-like uploader (the far view takes the visibility pass there): each region's write through the device's queue. */
function gpuRecorder(): ReturnType<typeof recorder> {
  const r = recorder();
  const device = { queue: { writeTexture: (dst: { origin: { x: number; y: number; z: number } }, bytes: Uint8Array) => void r.uploads.push({ at: new THREE.Vector3(dst.origin.x, dst.origin.y, dst.origin.z), bytes: bytes.slice() }) } };
  return { ...r, backend: { isWebGPUBackend: true, device, get: () => ({ texture: {} }), copyTextureToTexture: () => undefined } as VoxelGridRenderer['backend'] };
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
    // The second node starts one node (32 cells of 2 m) along x from the group's corner (a node's floats in one buffer).
    const inst = geo.getAttribute(FAR_NODE_ATTRIBUTE).array as Float32Array;
    expect([inst[0], inst[FAR_NODE_FLOATS], inst[3]]).toEqual([0, 64, 4 * VOXEL_SIZE_M]);
    // The node's box is its stored bricks' union, the lip on its node faces (packed, exactly).
    const box = farNodeMarchedBox(a.bricks!)!;
    expect(unpackFarBoxCorner(inst[FAR_NODE_LO_FLOAT]!)).toEqual(box.lo);
    expect(unpackFarBoxCorner(inst[FAR_NODE_HI_FLOAT]!)).toEqual(box.hi);
    // Each brick's distances and baked samples (four bytes a sample) went into one region each; each node's page
    // (two stores) names its 16 stored bricks' regions.
    const sizes = r.uploads.map((u) => u.bytes.length);
    expect(sizes.filter((n) => n === DISTANCE_BRICK_SAMPLES).length).toBe(32);
    expect(sizes.filter((n) => n === DISTANCE_BRICK_SAMPLES * FAR_BRICK_BAKED_BYTES).length).toBe(32);
    const pages = r.uploads.filter((u) => u.bytes.length === 64 * 4);
    expect(pages.length).toBe(4);
    const page = inst.subarray(FAR_NODE_PAGE_FLOAT, FAR_NODE_PAGE_FLOAT + 3);
    const table = pages.find((u) => u.at.x === page[0] && u.at.y === page[1] && u.at.z === page[2] && u.bytes.some((x, i) => i % 4 === 3 && x === 255))!.bytes;
    let stored = 0;
    for (let i = 0; i < 64; i++) if (table[i * 4 + 3] === 255) stored++;
    expect(stored).toBe(16);
    // The atlas, two instances of 16 floats, and the box.
    expect(v.bytes).toBe(ATLAS_BYTES + 2 * FAR_NODE_FLOATS * 4 + 24 * 4 + 36 * 2);
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

  it('is culled node by node on the GPU (WebGPU): its nodes are rows of the culled-instance table, tested as world boxes in the far depth, drawn after the pyramid, read through the list; no culler, no change', () => {
    const r = recorder();
    const v = view(r);
    const a = brickNode(0);
    v.apply({ added: [a, brickNode(1)], removed: [] }, undefined);
    const mesh = v.root.children[0] as THREE.Mesh;
    const scene = litScene();
    const holder = new THREE.Group();
    holder.position.set(10, -4, 6);
    holder.add(v.root);
    scene.add(holder);
    scene.updateMatrixWorld(true);
    // Without a culler (WebGL 2, or the pyramid path off) the draw stays as it was: every node from its own attributes.
    const whole = fragmentWgslOf(wgslRenderer(), scene, mesh);
    mesh.onBeforeRender({} as never, scene, new THREE.PerspectiveCamera(), mesh.geometry, mesh.material as THREE.Material, null as never);
    expect(mesh.geometry.getAttribute(CULLED_COPIES_ATTRIBUTE)).toBeUndefined();
    expect(fragmentWgslOf(glslRenderer(), scene, mesh)).toContain('gl_FragDepth');
    // The two-pass frame draws it in its second pass only, after the pyramid.
    const frame = new TwoPassFrame(wgslRenderer(), new OccludeeRegistry());
    expect(frame.secondPass(mesh)).toBe(true);
    const occ = frame.instances;
    occ.attach(scene);
    const cam = new THREE.PerspectiveCamera(60, 2, 0.5, 400);
    cam.position.set(40, 60, 200);
    cam.lookAt(40, 60, 0);
    cam.updateMatrixWorld(true);
    mesh.onBeforeRender({} as never, scene, cam, mesh.geometry, mesh.material as THREE.Material, null as never);
    expect(mesh.geometry.getAttribute(CULLED_COPIES_ATTRIBUTE), 'adopted at its first draw').toBeDefined();
    // Twelve triangles a node, yet listed: a node's cost is its march.
    occ.update([], cam);
    expect(occ.diagnostics().draws).toBe(1);
    const c = mesh.userData[CULLED_COPIES_KEY] as CulledCopies & { n: number; row: number; firstPass: boolean };
    expect([c.n, c.firstPass]).toEqual([2, false]);
    const table = (occ as unknown as { table: THREE.BufferAttribute }).table.array as Uint32Array;
    const flags = table[c.row * 8 + 3]!;
    expect(flags & 8, 'tested as boxes').toBe(8);
    expect(flags & 16, 'in the far depth').toBe(16);
    // The pool holds each node's 16 floats as drawn, its world box among them: the group's corner + the node's marched box.
    const pool = c.matrices.array as Float32Array;
    const own = mesh.geometry.getAttribute(FAR_NODE_ATTRIBUTE).array as Float32Array;
    expect(Array.from(pool.subarray(c.base * FAR_NODE_FLOATS, (c.base + 2) * FAR_NODE_FLOATS))).toEqual(Array.from(own.subarray(0, 2 * FAR_NODE_FLOATS)));
    const box = farNodeMarchedBox(a.bricks!)!;
    const cellM = 4 * VOXEL_SIZE_M;
    const at = new THREE.Vector3().setFromMatrixPosition(mesh.matrixWorld);
    const world = [at.x + box.lo[0] * cellM, at.y + 32 * cellM + box.lo[1] * cellM, at.z + box.lo[2] * cellM, at.x + box.hi[0] * cellM, at.y + 32 * cellM + box.hi[1] * cellM, at.z + box.hi[2] * cellM];
    const got = [0, 1, 2, 4, 5, 6].map((k) => pool[c.base * FAR_NODE_FLOATS + COPY_BOX_FLOAT + k]!);
    got.forEach((g, k) => expect(g).toBeCloseTo(world[k]!, 3));
    // Moved (a floating-origin re-base): the boxes follow, nothing uploaded.
    holder.position.x += 8;
    scene.updateMatrixWorld(true);
    occ.update([], cam);
    expect(pool[c.base * FAR_NODE_FLOATS + COPY_BOX_FLOAT]).toBeCloseTo(world[0]! + 8, 3);
    // The culled program reads the nodes through the list (more storage bindings than the whole draw's) and still marches with its own depth.
    const culled = wgslOf(wgslRenderer(), scene, mesh);
    expect(culled).toMatch(/instanceIndex|instance_index/);
    expect((culled.match(/var<storage/g) ?? []).length).toBeGreaterThan((whole.match(/var<storage/g) ?? []).length);
    expect(culled).toContain('frag_depth');
    // Its fragment stage reads the frame's pyramid before the march (a hidden entry is discarded first); the whole draw's does not.
    const storageIn = (w: string): number => (w.match(/var<storage/g) ?? []).length;
    expect(storageIn(fragmentWgslOf(wgslRenderer(), scene, mesh))).toBeGreaterThan(storageIn(whole));
    // A group made again (a batch's change) lets the culler go and is adopted anew; hidden, it is not listed.
    v.apply({ added: [brickNode(2)], removed: [] }, undefined);
    occ.update([], cam);
    expect(occ.diagnostics().draws).toBe(0);
    v.setVisible(false);
    const again = v.root.children[0] as THREE.Mesh;
    again.onBeforeRender({} as never, scene, cam, again.geometry, again.material as THREE.Material, null as never);
    occ.update([], cam);
    expect(occ.diagnostics().draws).toBe(0);
    v.setVisible(true);
    occ.update([], cam);
    expect(occ.diagnostics().draws).toBe(1);
    frame.dispose();
    v.dispose();
  });

  it('leaves nodes the near field hides whole out of the culled draw (kept resident), and back when the cover goes', () => {
    const v = view(recorder());
    v.apply({ added: [brickNode(0), brickNode(1)], removed: [] }, undefined);
    const mesh = v.root.children[0] as THREE.Mesh;
    const scene = litScene();
    scene.add(v.root);
    scene.updateMatrixWorld(true);
    const frame = new TwoPassFrame(wgslRenderer(), new OccludeeRegistry());
    frame.instances.attach(scene);
    const cam = new THREE.PerspectiveCamera(60, 2, 0.5, 400);
    cam.position.set(64, 60, 200);
    cam.updateMatrixWorld(true);
    mesh.onBeforeRender({} as never, scene, cam, mesh.geometry, mesh.material as THREE.Material, null as never);
    const copies = mesh.userData[CULLED_COPIES_KEY] as CulledCopies & { n: number };
    frame.instances.update([], cam);
    expect(copies.n).toBe(2);
    // The near field hides the far field in the chunks under node 0 (a level-2 node is 4 chunks a side; its box's
    // lip reaches a metre into the chunks either side: x −1 … 4), not under node 1 (x 3 … 8).
    const size = [10, 8, 6] as const;
    const cells = new Uint8Array(size[0] * size[1] * size[2]).map((_, i) => (i % size[0] <= 5 ? 2 : 0));
    v.apply(undefined, { min: [-1, 0, -1], size, cells });
    frame.instances.update([], cam);
    expect(copies.n, 'node 0 left out').toBe(1);
    expect(v.coveredNodes).toBe(1);
    expect(v.nodes, 'still resident and drawn by every other pass').toBe(2);
    // The listed node is node 1 (its corner one node along x): the culler reads it at its own slot.
    const pool = copies.matrices.array as Float32Array;
    const slots = (frame.instances as unknown as { pools: { slots: THREE.BufferAttribute } }).pools.slots.array as Uint32Array;
    expect(pool[(copies.base + slots[copies.base]!) * FAR_NODE_FLOATS]).toBe(64);
    // An edge ring there (the far field drawn behind the near field) is no hiding.
    v.apply(undefined, { min: [-1, 0, -1], size, cells: cells.map((c) => (c === 2 ? 1 : 0)) });
    frame.instances.update([], cam);
    expect(copies.n).toBe(2);
    expect(v.coveredNodes).toBe(0);
    frame.dispose();
    v.dispose();
  });

  it('holds a far hit in one visibility texel and reads it back: its brick, its place in the brick to a 4095th of the span, its depth exactly, its entry face, whether its brick is fine; nothing hit reads as none', () => {
    const step = FAR_VIS_CELL_SPAN / FAR_VIS_CELL_STEPS;
    // The atlas's largest region index on its widest axis (2048 texels / 9) and the brick's whole span, lip included.
    const cases = [
      { brick: [0, 0, 0], at: [0, 0, 0], viewZ: -12.5, face: 1 },
      { brick: [227, 3, 201], at: [8, 8, 8], viewZ: -4123.75, face: 6 },
      { brick: [17, 226, 0], at: [FAR_VIS_CELL_FROM, 3.3333, FAR_VIS_CELL_FROM + FAR_VIS_CELL_SPAN], viewZ: -61_000.125, face: 3 },
      { brick: [5, 6, 7], at: [-0.5, 8.5, 4.123], viewZ: -0.75, face: 4 },
      // Fine bricks' hits.
      { brick: [227, 226, 201], at: [8.5, 0, 3], viewZ: -150.5, face: 5, fine: true },
      { brick: [1, 2, 3], at: [1, 2, 3], viewZ: -20, face: 6, fine: true },
    ] as const;
    for (const h of cases) {
      const t = packFarVisibility(h);
      // Every float an integer below 2^24 (exact in a float32) but the depth.
      for (const k of [0, 1, 3]) {
        expect(Number.isInteger(t[k]!)).toBe(true);
        expect(t[k]!).toBeLessThan(2 ** 24);
        expect(Math.fround(t[k]!)).toBe(t[k]);
      }
      const back = unpackFarVisibility(t.map((x) => Math.fround(x)))!;
      expect(back.brick).toEqual(h.brick);
      expect(back.face).toBe(h.face);
      expect(back.fine === true).toBe('fine' in h && h.fine);
      expect(back.viewZ).toBe(Math.fround(h.viewZ));
      for (let a = 0; a < 3; a++) expect(Math.abs(back.at[a]! - h.at[a]!)).toBeLessThanOrEqual(step / 2 + 1e-9);
    }
    // A cleared texel (nothing marched there) is no hit.
    expect(unpackFarVisibility([0, 0, 0, 0])).toBeNull();
    expect(() => packFarVisibility({ brick: [0, 0, 0], at: [0, 0, 0], viewZ: -1, face: 0 })).toThrow();
  });

  it('on WebGPU marches into its visibility target and shades once a pixel: the brick draws move to the pass scene (unlit, the texel and its depth), the frame keeps one full-screen shade, lit, with its depth and the hit\'s own motion; WebGL 2 shades in the frame', () => {
    const r = gpuRecorder();
    const v = view(r);
    v.apply({ added: [brickNode(0)], removed: [] }, undefined);
    expect(v.brickPass).toBe('visibility');
    const bricks: THREE.Mesh[] = [];
    v.visibilityScene!.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) bricks.push(o as THREE.Mesh);
    });
    expect(bricks.length).toBe(1);
    const inFrame = v.root.children as THREE.Mesh[];
    expect(inFrame.map((m) => m.name)).toEqual(['voxel-far shade']);
    expect(inFrame[0]!.visible).toBe(true);
    // The march: its depth, no lights read, no normal's six reads nor the colour's (the shade reads those).
    const pass = new THREE.Scene();
    pass.add(v.visibilityScene!);
    const march = fragmentWgslOf(wgslRenderer(), pass, bricks[0]!);
    expect(march).toContain('frag_depth');
    expect(march).toContain('discard');
    const lit = fragmentWgslOf(wgslRenderer(), litScene(), (() => {
      const w = view(recorder());
      w.apply({ added: [brickNode(0)], removed: [] }, undefined);
      return w.root.children[0] as THREE.Mesh;
    })());
    const samples = (w: string): number => (w.match(/textureSampleLevel/g) ?? []).length;
    // Not counting the fine hits' reads: in their own branch.
    const samplesTop = (w: string): number => w.split('\n').filter((l) => /^\t[^\t]/.test(l) && l.includes('textureSampleLevel')).length;
    expect(samplesTop(lit) - samplesTop(march), 'the six gradient reads and the colour read left to the shade').toBe(7);
    // The shade: lit by the scene, its depth the hit's, every pixel's own texel read once (no filtering).
    const scene = litScene();
    scene.add(v.root);
    const shade = fragmentWgslOf(wgslRenderer(), scene, inFrame[0]!);
    expect(shade).toContain('frag_depth');
    expect(shade).toContain('discard');
    expect(shade).toContain('textureLoad');
    expect(samplesTop(shade)).toBe(7);
    // A fine brick's hit (its own branch, only its pixels): the occlusion, the two words' far colours (each set's
    // mean), and, nearer than the fade's end, the two materials' albedo, normal and ORM at an explicit level, one
    // projection each; its eight words are loads.
    expect(samples(shade) - samplesTop(shade), 'the fine hits\' reads').toBe(1 + 2 + 2 * 3);
    // Under the temporal upscale's motion target the shade writes the hit's motion from its own fragment (the texel's
    // place), not the full-screen quad's vertices: no motion varying in its vertex stage.
    installMotionVectors();
    const g = wgslRenderer();
    const target = new THREE.RenderTarget(4, 4, { count: 2 });
    target.textures[0]!.name = 'output';
    target.textures[1]!.name = MOTION_TARGET;
    g.setRenderTarget(target);
    g.setMRT(mrt({ output, [MOTION_TARGET]: motionVectorOutput() }));
    const vertexOf = (r: ReturnType<typeof wgslRenderer>): string => {
      const all = wgslOf(r, scene, inFrame[0]!);
      return all.slice(0, all.length - fragmentWgslOf(r, scene, inFrame[0]!).length);
    };
    expect(fragmentWgslOf(g, scene, inFrame[0]!)).toMatch(/@location\(\s*1\s*\)/);
    const varyings = (w: string): number => (w.match(/@location\(\s*\d+\s*\)/g) ?? []).length;
    expect(varyings(vertexOf(g)), 'the vertex stage passes what it passes without motion').toBe(varyings(vertexOf(wgslRenderer())));
    target.dispose();
    expect(v.brickPass).toBe('visibility');
    // Removed, the shade hides (nothing to march).
    v.apply({ added: [], removed: [{ level: 2, nx: 0, ny: 1, nz: 0 }] }, undefined);
    expect((v.root.children[0] as THREE.Mesh).visible).toBe(false);
    v.dispose();
    // WebGL 2 keeps the march shading itself in the frame.
    const w = view(recorder());
    w.apply({ added: [brickNode(0)], removed: [] }, undefined);
    expect(w.brickPass).toBe('direct');
    expect(w.visibilityScene).toBeNull();
    w.dispose();
  });

  it('draws the visibility pass from the shade inside the frame: into its own target at the frame target\'s size with no MRT, the culler and the clear set for it and put back; a hit\'s last place follows a floating-origin re-base', () => {
    const r = gpuRecorder();
    const v = view(r);
    v.apply({ added: [brickNode(0)], removed: [] }, undefined);
    const shade = v.root.children[0] as THREE.Mesh;
    const scene = new THREE.Scene();
    scene.add(v.root);
    const culler = { adopt: () => undefined };
    scene.userData[INSTANCE_CULLER_KEY] = culler;
    const frameTarget = new THREE.RenderTarget(853, 480);
    const frameMrt = { mrt: true };
    const calls: Array<{ scene: THREE.Object3D; target: THREE.RenderTarget | null; mrt: unknown; clear: boolean; alpha: number }> = [];
    let target: THREE.RenderTarget | null = frameTarget;
    let mrtNow: unknown = frameMrt;
    let alpha = 1;
    const fake = {
      autoClear: false, autoClearColor: true, autoClearDepth: true, autoClearStencil: true,
      getRenderTarget: () => target, setRenderTarget: (t: THREE.RenderTarget | null) => void (target = t),
      getMRT: () => mrtNow, setMRT: (m: unknown) => void (mrtNow = m),
      getDrawingBufferSize: (s: THREE.Vector2) => s.set(1280, 720),
      getClearColor: (c: THREE.Color) => c.set(0x336699), getClearAlpha: () => alpha, setClearColor: (_c: unknown, a = 1) => void (alpha = a),
      render(s: THREE.Object3D) { calls.push({ scene: s, target, mrt: mrtNow, clear: this.autoClear, alpha }); },
    };
    const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.5, 400);
    shade.onBeforeRender(fake as never, scene, cam, shade.geometry, shade.material as THREE.Material, null as never);
    expect(calls.length).toBe(1);
    expect(calls[0]!.scene).toBe(v.visibilityScene);
    expect(calls[0]!.target).not.toBe(frameTarget);
    expect([calls[0]!.target!.width, calls[0]!.target!.height]).toEqual([853, 480]);
    expect(calls[0]!.mrt).toBeNull();
    expect(calls[0]!.clear).toBe(true);
    expect(calls[0]!.alpha).toBe(0);
    expect(v.visibilityScene!.userData[INSTANCE_CULLER_KEY]).toBe(culler);
    // Put back as it was for the rest of the frame.
    expect([target, mrtNow, fake.autoClear, fake.autoClearStencil, alpha]).toEqual([frameTarget, frameMrt, false, true, 1]);
    expect(shade.matrixWorld.equals(cam.matrixWorld)).toBe(true);
    // The target's bytes are the far field's: a texel and a depth a pixel.
    expect(v.visibilityBytes).toBe(853 * 480 * 20);
    // A re-base by one chunk along x moves every far draw 64 m: a point drawn now at x was at x + 64 on the last frame.
    const origin = (v as unknown as { opts: { origin: FloatingOrigin } }).opts.origin;
    (origin as unknown as { ox: number }).ox += 32;
    v.rebase();
    shade.onBeforeRender(fake as never, scene, cam, shade.geometry, shade.material as THREE.Material, null as never);
    const m = ((v as unknown as { vis: { lastFromNow: { value: THREE.Matrix4 } } }).vis.lastFromNow.value);
    const p = new THREE.Vector3(10, 20, 30).applyMatrix4(m);
    expect(p.toArray()).toEqual([10 + 32 * VOXEL_SIZE_M, 20, 30]);
    // Still on the next frame: no motion of its own.
    shade.onBeforeRender(fake as never, scene, cam, shade.geometry, shade.material as THREE.Material, null as never);
    expect(new THREE.Vector3(10, 20, 30).applyMatrix4(m).toArray()).toEqual([10, 20, 30]);
    frameTarget.dispose();
    v.dispose();
  });

  it('reuses released bricks\' regions and gives the atlas\'s emptied end back after many moves; a brick\'s GPU bytes are the far field\'s count', () => {
    // The far field budgets by these bytes: they must be what the atlas keeps a brick and a brick table in.
    const atlas = new FarBrickAtlas(4);
    expect(atlas.distance.regionBytes + atlas.colours.regionBytes).toBe(FAR_BRICK_GPU_BYTES);
    expect((atlas.pages.regionBytes + atlas.pageBounds.regionBytes) / 64).toBe(FAR_BRICK_TABLE_GPU_BYTES);
    atlas.dispose();
    const r = recorder();
    const v = view(r);
    const nodes = new Map<number, FarNodeDraw>();
    const node = (nx: number): FarNodeDraw => {
      let n = nodes.get(nx % 12);
      if (n === undefined) nodes.set(nx % 12, (n = brickNode(nx % 12)));
      return { ...n, nx };
    };
    // A window of 8 nodes slides 60 nodes along: each move one node in ahead, one out behind (a flight's turnover).
    v.apply({ added: Array.from({ length: 8 }, (_, i) => node(i)), removed: [] }, undefined);
    const held = v.atlasBytes;
    for (let x = 0; x < 60; x++) v.apply({ added: [node(x + 8)], removed: [{ level: 2, nx: x, ny: 1, nz: 0 }] }, undefined);
    // The regions the leaving nodes gave back were used again: the atlas held its size.
    expect(v.bricks).toBe(8 * 16);
    expect(v.atlasBytes).toBe(held);
    // 32 more at once grow it; the window and the last 28 going give its grown end back, the first 4 of the 32 (in
    // the space the window left and the first growths after it) drawn where they were.
    v.apply({ added: Array.from({ length: 32 }, (_, i) => node(100 + i)), removed: [] }, undefined);
    const grown = v.atlasBytes;
    expect(grown).toBeGreaterThan(2 * held);
    v.apply({ added: [], removed: [...Array.from({ length: 8 }, (_, i) => ({ level: 2, nx: 60 + i, ny: 1, nz: 0 })), ...Array.from({ length: 28 }, (_, i) => ({ level: 2, nx: 104 + i, ny: 1, nz: 0 }))] }, undefined);
    expect(v.bricks).toBe(4 * 16);
    expect(v.trims).toBeGreaterThan(0);
    expect(v.atlasBytes).toBeLessThan(grown / 2);
    // Nodes added since come into the space kept (the store grows a step at most, not back to its old size).
    v.apply({ added: Array.from({ length: 4 }, (_, i) => node(200 + i)), removed: [] }, undefined);
    expect(v.bricks).toBe(8 * 16);
    expect(v.atlasBytes).toBeLessThan(grown / 2);
    expect(farBricksGpuBytes(nodes.get(0)!.bricks!)).toBe(16 * FAR_BRICK_GPU_BYTES + 64 * FAR_BRICK_TABLE_GPU_BYTES);
    v.dispose();
  });

  it('region stores hand out their oldest part first and shrink only past regions in use, keeping each one where it was', () => {
    const copies: THREE.Box3[] = [];
    const r: VoxelGridRenderer = { ...recorder(), copyTextureToTexture: (_s, _d, box) => void copies.push(box!.clone()) };
    const g = new VoxelShaderGrids({ side: 2 }, { format: THREE.RedFormat, bytes: 1, filter: THREE.NearestFilter });
    const at = Array.from({ length: 200 }, () => g.allocate(r));
    const cap = g.capacity;
    expect(g.grown).toBeGreaterThan(3);
    // Every region but the first 10 and the last one handed out given back: the last keeps the grown end in use.
    for (const o of at.slice(10, 199)) g.release(o);
    expect(g.trim(r)).toBe(false);
    expect(g.capacity).toBe(cap);
    // Freed regions go out again from the first size on, not from the end.
    const again = g.allocate(r);
    expect(Math.max(again.x, again.y, again.z)).toBeLessThan(4 * 2);
    g.release(again);
    g.release(at[199]!);
    expect(g.trim(r)).toBe(true);
    expect(g.count).toBe(10);
    expect(g.capacity).toBeLessThan(cap);
    expect(g.count).toBeLessThanOrEqual(g.capacity * (1 - GRID_TRIM_SLACK));
    // The copy kept the smaller size's box from the corner, and the regions left lie in it.
    const box = copies[copies.length - 1]!;
    expect(box.min.toArray()).toEqual([0, 0, 0]);
    for (const o of at.slice(0, 10)) expect(o.x < box.max.x && o.y < box.max.y && o.z < box.max.z).toBe(true);
    expect([box.max.x, box.max.y, box.max.z]).toEqual([g.texture.image.width, g.texture.image.height, g.texture.image.depth]);
    // And it grows again from there.
    for (let i = 0; i < 300; i++) g.allocate(r);
    expect(g.count).toBe(310);
    g.dispose();
  });

});
