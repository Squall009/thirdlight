/**
 * The far field's visibility feedback where it is drawn: the reduction of a
 * known visibility target to per-brick counts and nearest depths (the CPU
 * form the GPU pass is checked against in the browser), the region owners'
 * versions (a late round never speaks for a region given after its frame or
 * given back), and the rounds through the far view's own pass hook: a round
 * every few passes, never a second while one is out, its nodes handed on.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { chunkGrid, createWorldStore, DISTANCE_BRICK_SIDE, farBricksFromFaces, FAR_SEEN_STRIDE, FloatingOrigin, MATERIAL_BITS, SHADER_BORDER_CELLS, SHADER_READ_DEPTH_CELLS, shaderGridSide, SHAPE_FULL, VOXEL_ROLE, VOXEL_SIZE_M, WETNESS_MAX, type FarNodeDraw, type FarSeenWire } from '@thirdlight/voxel';

import { voxelStandInLook } from './voxel-chunk-view';
import { FAR_FEEDBACK_EVERY_FRAMES, FAR_FEEDBACK_NO_DEPTH, FAR_FEEDBACK_PIXEL_STEP, farFeedbackFromUrl, farFeedbackIndex, farFeedbackMismatch, FarRegionOwners, reduceFarVisibility } from './voxel-far-feedback';
import { VoxelFarView } from './voxel-far-mesh';
import { packFarVisibility } from './voxel-far-visibility';
import { createVoxelSurface, type VoxelGridRenderer } from './voxel-surface';

const grid = chunkGrid(32);

/** A float's bits (the reduction keeps the nearest depth as them). */
function bitsOf(v: number): number {
  return new Uint32Array(new Float32Array([v]).buffer)[0]!;
}

/** A visibility target of `w` × `h` texels, nothing hit, and a way to put a hit of brick `b` at view depth `z` on a pixel. */
function target(w: number, h: number): { texels: Float32Array; hit(x: number, y: number, b: [number, number, number], z: number): void } {
  const texels = new Float32Array(w * h * 4);
  return {
    texels,
    hit: (x, y, b, z) => texels.set(packFarVisibility({ brick: b, at: [4, 4, 4], viewZ: z, face: 3 }), (y * w + x) * 4),
  };
}

describe('the far field\'s visibility feedback', () => {
  it('reduces a known visibility target to each brick\'s hit pixels and nearest view depth, a texel every step', () => {
    const t = target(16, 12);
    // Brick (1, 0, 0) over a 6 × 4 block at 120 m, one pixel of it nearer (90 m); brick (0, 1, 0) on two pixels.
    for (let y = 2; y < 6; y++) for (let x = 4; x < 10; x++) t.hit(x, y, [1, 0, 0], -120);
    t.hit(8, 4, [1, 0, 0], -90);
    t.hit(0, 10, [0, 1, 0], -50.5);
    t.hit(1, 10, [0, 1, 0], -40.25);
    // A brick past the atlas's regions (a texel from before a trim) is not counted.
    t.hit(15, 11, [5, 0, 0], -10);
    const dims = [4, 2, 1] as const;
    const all = reduceFarVisibility(t.texels, 16, 12, dims, 1);
    const k1 = farFeedbackIndex([1, 0, 0], dims);
    const k2 = farFeedbackIndex([0, 1, 0], dims);
    expect(all[k1 * 2]).toBe(24);
    expect(all[k1 * 2 + 1]).toBe(bitsOf(90));
    expect(all[k2 * 2]).toBe(2);
    expect(all[k2 * 2 + 1]).toBe(bitsOf(40.25));
    // Every other region: nothing counted, no depth.
    for (let k = 0; k < 8; k++) if (k !== k1 && k !== k2) expect([all[k * 2], all[k * 2 + 1]]).toEqual([0, FAR_FEEDBACK_NO_DEPTH]);
    // A texel every 2 pixels a side: a quarter of the block (x 4, 6, 8 × y 2, 4), the nearer pixel among them, the
    // two-pixel brick met once (x 0).
    const half = reduceFarVisibility(t.texels, 16, 12, dims, FAR_FEEDBACK_PIXEL_STEP);
    expect(FAR_FEEDBACK_PIXEL_STEP).toBe(2);
    expect(half[k1 * 2]).toBe(6);
    expect(half[k1 * 2 + 1]).toBe(bitsOf(90));
    expect(half[k2 * 2]).toBe(1);
    expect(half[k2 * 2 + 1]).toBe(bitsOf(50.5));
    expect(farFeedbackMismatch(half, half)).toEqual({ regions: 8, hits: 7, cpuHits: 7, differ: 0 });
    expect(farFeedbackMismatch(all, half).differ).toBe(2);
  });

  it('speaks per node only for regions held since before the round\'s frame: one given later or given back is stale', () => {
    const S = DISTANCE_BRICK_SIDE;
    const owners = new FarRegionOwners();
    const dims = [4, 2, 1] as const;
    const a = { level: 3, nx: 1, ny: 0, nz: -2 };
    const b = { level: 2, nx: 7, ny: 1, nz: 3 };
    owners.version = 1;
    owners.give(a, [new THREE.Vector3(S, 0, 0), new THREE.Vector3(2 * S, 0, 0)]);
    owners.version = 2;
    owners.give(b, [new THREE.Vector3(0, S, 0)]);
    const data = new Uint32Array(16);
    const put = (br: [number, number, number], n: number, depthM: number): void => {
      const k = farFeedbackIndex(br, dims);
      data[k * 2] = n;
      data[k * 2 + 1] = bitsOf(depthM);
    };
    put([1, 0, 0], 3, 200);
    put([2, 0, 0], 5, 150);
    put([0, 1, 0], 2, 60);
    // Reduced at version 1: b's region was given after that frame.
    const early = owners.round(data, dims, 1, 2, 7, 11);
    expect(early.stale).toBe(1);
    expect(early.bricks).toBe(2);
    expect(early.wire).toEqual({ round: 7, farSeq: 11, nodes: [3, 1, 0, -2, (3 + 5) * 4, 150 / VOXEL_SIZE_M] });
    // Reduced at version 2: both, b's nearest depth in cells.
    const late = owners.round(data, dims, 2, 2, 8, 12);
    expect(late.stale).toBe(0);
    expect(late.wire.nodes.length).toBe(2 * FAR_SEEN_STRIDE);
    expect(late.wire.nodes.slice(FAR_SEEN_STRIDE)).toEqual([2, 7, 1, 3, 8, 60 / VOXEL_SIZE_M]);
    // a gave its regions back (and one went to b, at version 3): a round of version 2 names neither for a.
    owners.take([new THREE.Vector3(S, 0, 0), new THREE.Vector3(2 * S, 0, 0)]);
    owners.version = 3;
    owners.give(b, [new THREE.Vector3(S, 0, 0)]);
    const after = owners.round(data, dims, 2, 2, 9, 12);
    expect(after.stale).toBe(2);
    expect(after.wire.nodes).toEqual([2, 7, 1, 3, 8, 60 / VOXEL_SIZE_M]);
    expect(farFeedbackFromUrl('?farFeedback=off')).toBe(false);
    expect(farFeedbackFromUrl('?farPass=direct')).toBe(true);
  });

  it('makes a round after every few visibility passes, never a second while one is out, and hands its nodes on with the far event its frame drew', async () => {
    const seen: FarSeenWire[] = [];
    const v = view(gpuRecorder(), (s) => seen.push(s));
    v.apply({ added: [brickNode(0)], removed: [], seq: 4 }, undefined);
    const shade = v.root.children[0] as THREE.Mesh;
    const scene = new THREE.Scene();
    scene.add(v.root);
    const computes: unknown[][] = [];
    const reads: Array<{ ok: (b: ArrayBuffer) => void; count: number }> = [];
    let target: THREE.RenderTarget | null = null;
    const fake = {
      autoClear: true, autoClearColor: true, autoClearDepth: true, autoClearStencil: true,
      getRenderTarget: () => target, setRenderTarget: (t: THREE.RenderTarget | null) => void (target = t),
      getMRT: () => null, setMRT: () => undefined,
      getDrawingBufferSize: (s: THREE.Vector2) => s.set(64, 32),
      getClearColor: (c: THREE.Color) => c, getClearAlpha: () => 1, setClearColor: () => undefined,
      render: () => undefined,
      compute: (nodes: unknown[]) => void computes.push(nodes),
      getArrayBufferAsync: (_a: unknown, _t: unknown, _o: number, count: number) => new Promise<ArrayBuffer>((ok) => reads.push({ ok, count })),
    };
    const cam = new THREE.PerspectiveCamera(60, 2, 0.5, 400);
    const pass = (): void => shade.onBeforeRender(fake as never, scene, cam, shade.geometry, shade.material as THREE.Material, null as never);
    for (let i = 0; i < FAR_FEEDBACK_EVERY_FRAMES - 1; i++) pass();
    expect(computes.length).toBe(0);
    pass();
    // One compute call: the clear and the reduction in one pass.
    expect(computes.length).toBe(1);
    expect(computes[0]!.length).toBe(2);
    expect(reads.length).toBe(1);
    // The round is out: more passes make none.
    for (let i = 0; i < 3 * FAR_FEEDBACK_EVERY_FRAMES; i++) pass();
    expect(computes.length).toBe(1);
    // A node given after the round's frame: its regions are not the round's to name.
    v.apply({ added: [brickNode(1)], removed: [], seq: 5 }, undefined);
    const regions = (v as unknown as { regions: Map<string, THREE.Vector3[]> }).regions;
    const dims = (v as unknown as { atlas: { distance: { regionDims: readonly [number, number, number] } } }).atlas.distance.regionDims;
    const data = new Uint32Array(reads[0]!.count / 4);
    for (let k = 0; k < data.length / 2; k++) data[k * 2 + 1] = FAR_FEEDBACK_NO_DEPTH;
    const mark = (r: THREE.Vector3, n: number, m: number): void => {
      const k = farFeedbackIndex([r.x / DISTANCE_BRICK_SIDE, r.y / DISTANCE_BRICK_SIDE, r.z / DISTANCE_BRICK_SIDE], dims);
      data[k * 2] = n;
      data[k * 2 + 1] = bitsOf(m);
    };
    mark(regions.get('2:0,1,0')![0]!, 10, 300);
    mark(regions.get('2:0,1,0')![3]!, 2, 280);
    mark(regions.get('2:1,1,0')![0]!, 9, 100);
    reads[0]!.ok(data.buffer);
    await Promise.resolve();
    await Promise.resolve();
    expect(seen.length).toBe(1);
    expect(seen[0]).toEqual({ round: 1, farSeq: 4, nodes: [2, 0, 1, 0, 12 * FAR_FEEDBACK_PIXEL_STEP ** 2, 280 / VOXEL_SIZE_M] });
    expect(v.feedbackStats).toMatchObject({ rounds: 1, readBack: 1, sent: 1, stale: 1, bricks: 2, nodes: 1 });
    // Back: the next round comes on its pass count.
    for (let i = 0; i < FAR_FEEDBACK_EVERY_FRAMES; i++) pass();
    expect(computes.length).toBe(2);
    v.dispose();
    // Without a place to send rounds to, none is made.
    const quiet = view(gpuRecorder());
    quiet.apply({ added: [brickNode(0)], removed: [] }, undefined);
    expect(quiet.feedbackStats).toBeNull();
    quiet.dispose();
  });
});

/** A WebGPU-like uploader (the far view takes the visibility pass there). */
function gpuRecorder(): VoxelGridRenderer {
  const device = { queue: { writeTexture: () => undefined } };
  return {
    backend: { isWebGPUBackend: true, device, get: () => ({ texture: {} }), copyTextureToTexture: () => undefined } as VoxelGridRenderer['backend'],
    initTexture: () => undefined,
    copyTextureToTexture: () => undefined,
  };
}

function view(renderer: VoxelGridRenderer, onSeen?: (s: FarSeenWire) => void): VoxelFarView {
  const surface = createVoxelSurface({ cellMetres: VOXEL_SIZE_M, side: shaderGridSide(grid.edge), border: SHADER_BORDER_CELLS, materialBits: MATERIAL_BITS, wetnessMax: WETNESS_MAX, readDepthCells: SHADER_READ_DEPTH_CELLS }, { look: voxelStandInLook, blendMetres: 0.25 });
  return new VoxelFarView({ grid, origin: new FloatingOrigin({ grid, rebaseDistanceM: 512, origin: { x: 0, y: 0, z: 0 } }), surface, renderer, ...(onSeen !== undefined ? { onSeen } : {}) });
}

/** A level-2 node of flat ground as the far field's bricks. */
function brickNode(nx: number): FarNodeDraw {
  const s = createWorldStore(grid);
  for (let x = nx * 32 - 4; x < nx * 32 + 36; x++) for (let z = -4; z < 36; z++) for (let y = 28; y < 44; y++) s.setVoxel(x, y, z, { material: 3, role: VOXEL_ROLE.terrain, shape: SHAPE_FULL, wetness: 0 });
  return { level: 2, nx, ny: 1, nz: 0, bricks: farBricksFromFaces(grid, s, [nx, 1, 0], 1) };
}
