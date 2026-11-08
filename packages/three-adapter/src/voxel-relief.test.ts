/**
 * Relief displacement as three builds it, on a real relief derive: a chunk
 * of the voxel package's relief mesh (16³ sections, joined) drawn by the
 * chunk view carries its crease weights as an attribute and culling bounds
 * grown by the deepest relief; its vertex program (WGSL and GLSL) reads the
 * height array at an explicit level (no sharper than the vertex spacing),
 * a plain chunk's program reads none; three's shadow pass takes the
 * material's position node, so a shadow is displaced the same; without
 * heights nothing of relief is built. And the test heights themselves:
 * deterministic, tileable, using the 0–1 range.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  buildApron,
  chunkGrid,
  createWorldStore,
  deriveSectionsWithApron,
  FloatingOrigin,
  jobRadius,
  joinSectionsForDraw,
  MATERIAL_BITS,
  PLACEHOLDER_RULES,
  SHADER_BORDER_CELLS,
  SHADER_READ_DEPTH_CELLS,
  shaderGridSide,
  VOXEL_ROLE,
  VOXEL_SIZE_M,
  WETNESS_MAX,
  type JoinedDraw,
  type PaletteStore,
} from '@thirdlight/voxel';

import { glslRenderer, settle, wgslOf, wgslRenderer } from './test-wgsl';
import { VoxelChunkView, voxelStandInLook } from './voxel-chunk-view';
import { RELIEF_TEST_LAYERS, RELIEF_TEST_MAX_DEPTH_M, reliefTestHeights, voxelTestRelief } from './voxel-relief';
import { createVoxelSurface, VOXEL_CREASE_ATTRIBUTE, type VoxelGridRenderer, type VoxelMaterialLook } from './voxel-surface';

const grid = chunkGrid(32);
const R = jobRadius(PLACEHOLDER_RULES);
const SECTION = 16;
const LAYOUT = { cellMetres: VOXEL_SIZE_M, side: shaderGridSide(grid.edge), border: SHADER_BORDER_CELLS, materialBits: MATERIAL_BITS, wetnessMax: WETNESS_MAX, readDepthCells: SHADER_READ_DEPTH_CELLS };
/** Small height layers: the program and the bounds do not depend on the size. */
const SIZE = 16;
const heights = { size: SIZE, layers: RELIEF_TEST_LAYERS.map((_, k) => new Uint8Array(SIZE * SIZE).fill(40 * k)) };
const look = (m: number): VoxelMaterialLook => ({ ...voxelStandInLook(m), ...(voxelTestRelief(m) === null ? {} : { relief: voxelTestRelief(m)! }) });

/** Rock ground (id 1) with a stone wall (id 10) on it, inside chunk (0, 0, 0). */
function world(): PaletteStore {
  const s = createWorldStore(grid);
  for (let x = 0; x < 32; x++) for (let z = 0; z < 32; z++) for (let y = 0; y < 6; y++) s.setVoxel(x, y, z, { material: 1, role: VOXEL_ROLE.terrain, shape: 15, wetness: 0 });
  for (let x = 8; x < 20; x++) for (let y = 6; y < 14; y++) s.setVoxel(x, y, 12, { material: 10, role: VOXEL_ROLE.wall, shape: 15, wetness: 0 });
  return s;
}

/** Chunk (0, 0, 0)'s 16³ sections derived as the worker does, with the relief mesh `n` steps a cell (null: none), joined. */
function joined(s: PaletteStore, n: number | null): JoinedDraw {
  const ids = Array.from({ length: 8 }, (_, i) => i);
  const results = deriveSectionsWithApron(grid, PLACEHOLDER_RULES, buildApron(s, 0, 0, 0, R), (out) => s.exportChunk(0, 0, 0, out), SECTION, ids, 0, undefined, n === null ? null : () => ({ n }));
  return joinSectionsForDraw(grid.edge, SECTION, results.map((r) => r.assembly), new Uint16Array(LAYOUT.side ** 3));
}

const noUploads: VoxelGridRenderer = { backend: { isWebGLBackend: true, get: () => ({}), copyTextureToTexture: () => undefined }, initTexture: () => undefined, copyTextureToTexture: () => undefined };

/** The chunk drawn by a view with a relief surface: its surface mesh. */
function drawn(d: JoinedDraw, relief: boolean): { mesh: THREE.Mesh; surface: ReturnType<typeof createVoxelSurface> } {
  const surface = createVoxelSurface(LAYOUT, { look, blendMetres: 0.25, heights });
  const view = new VoxelChunkView({ grid, origin: new FloatingOrigin({ grid, rebaseDistanceM: 512, origin: { x: 0, y: 0, z: 0 } }), surface, renderer: noUploads });
  const shown = relief ? { ground: d.relief!.ground, base: d.relief!.base } : { ground: d.ground, base: d.base };
  view.set(0, 0, 0, { ...shown, instances: d.instances, solid: d.solid });
  let mesh: THREE.Mesh | null = null;
  view.root.traverse((o) => {
    if (o instanceof THREE.Mesh && !(o instanceof THREE.InstancedMesh)) mesh = o;
  });
  return { mesh: mesh!, surface };
}

const stage = (src: string, which: 'vertex' | 'fragment'): string => {
  const at = src.indexOf('@fragment');
  return which === 'vertex' ? src.slice(0, at) : src.slice(at);
};

describe('relief displacement', () => {
  it('draws a relief chunk with its crease weights and bounds grown by the deepest relief; its vertex stage reads the heights at an explicit level on both backends, a plain chunk\'s reads none', async () => {
    await settle();
    const s = world();
    const d = joined(s, 4);
    expect(d.relief).toBeDefined();
    const { mesh, surface } = drawn(d, true);
    const geo = mesh.geometry;
    const crease = geo.getAttribute(VOXEL_CREASE_ATTRIBUTE);
    expect(crease.count).toBe(d.relief!.ground.vertexCount + d.relief!.base.vertexCount);
    const bytes = [...d.relief!.ground.crease.subarray(0, d.relief!.ground.vertexCount), ...d.relief!.base.crease.subarray(0, d.relief!.base.vertexCount)];
    for (let i = 0; i < crease.count; i += 97) expect(crease.getX(i)).toBeCloseTo(bytes[i]! / 255, 6);
    // Both kinds of vertex are there: fixed (creases, borders) and free.
    expect(bytes.some((b) => b === 0) && bytes.some((b) => b === 255)).toBe(true);
    // The bounds: the plain positions' sphere grown by the deepest relief of any material.
    expect(surface.reliefDepthM).toBe(RELIEF_TEST_MAX_DEPTH_M);
    const plain = new THREE.BufferGeometry().setAttribute('position', geo.getAttribute('position'));
    plain.computeBoundingSphere();
    expect(geo.boundingSphere!.radius).toBeCloseTo(plain.boundingSphere!.radius + RELIEF_TEST_MAX_DEPTH_M, 6);
    const scene = new THREE.Scene().add(new THREE.HemisphereLight(0xffffff, 0x444444, 1), new THREE.DirectionalLight(0xffffff, 2), mesh);
    const wgsl = wgslOf(wgslRenderer(), scene, mesh);
    const vs = stage(wgsl, 'vertex');
    // Two materials, three projections each, every one at an explicit level (the vertex stage has no derivatives).
    expect((vs.match(/\btextureSampleLevel\s*\(/g) ?? []).length).toBe(6);
    // The blend's grid reads (eight cells, the one under a roof apex, an owned face's cell) and the table's.
    expect((vs.match(/\btextureLoad\(\s*\w+,\s*vec3<i32>\(/g) ?? []).length).toBe(10);
    expect(vs).toMatch(new RegExp(`\\b${VOXEL_CREASE_ATTRIBUTE}\\b`));
    // The fragment: the lighting normal from the heights' screen derivatives (six samples more, in uniform flow).
    const fs = stage(wgsl, 'fragment');
    expect(fs).toMatch(/\bdpdx\b/);
    const glsl = wgslOf(glslRenderer(), scene, mesh);
    // The GLSL vertex program is the first of the two (each starts with its #version line).
    const gvs = glsl.slice(0, glsl.indexOf('#version', 1));
    expect((gvs.match(/\btextureLod\s*\(/g) ?? []).length).toBe(6);
    // A plain chunk of the same surface: no crease attribute, no height read in its vertex stage, no grown bounds.
    const flat = drawn(joined(s, null), false).mesh;
    expect(flat.geometry.getAttribute(VOXEL_CREASE_ATTRIBUTE)).toBeUndefined();
    const fvs = stage(wgslOf(wgslRenderer(), new THREE.Scene().add(new THREE.DirectionalLight(0xffffff, 2), flat), flat), 'vertex');
    expect(fvs).not.toMatch(/\btextureSampleLevel\s*\(/);
    expect(fvs).not.toMatch(/\btextureLoad\s*\(/);
  });

  it('displaces the shadow the same: three\'s shadow pass takes the material\'s position node, which builds the displacement for a relief chunk', async () => {
    await settle();
    const { mesh, surface } = drawn(joined(world(), 2), true);
    const renderer = wgslRenderer() as unknown as { _getShadowNodes(m: THREE.Material): { positionNode: unknown } };
    expect(surface.material.positionNode).not.toBeNull();
    expect(renderer._getShadowNodes(surface.material).positionNode).toBe(surface.material.positionNode);
    // A depth-only material with that position node, as the shadow pass's override is: its vertex stage displaces.
    const shadowMat = new (await import('three/webgpu')).MeshBasicNodeMaterial();
    shadowMat.positionNode = surface.material.positionNode;
    const shadowMesh = new THREE.Mesh(mesh.geometry, shadowMat as unknown as THREE.Material);
    shadowMesh.userData = mesh.userData;
    const vs = stage(wgslOf(wgslRenderer(), new THREE.Scene().add(shadowMesh), shadowMesh), 'vertex');
    expect((vs.match(/\btextureSampleLevel\s*\(/g) ?? []).length).toBe(6);
  });

  it('builds nothing of relief without heights (programs as before), and refuses a look naming a layer the heights lack', () => {
    const plain = createVoxelSurface(LAYOUT, { look, blendMetres: 0.25 });
    expect(plain.material.positionNode).toBeNull();
    expect(plain.material.normalNode).toBeNull();
    expect(plain.reliefDepthM).toBe(0);
    expect(() => createVoxelSurface(LAYOUT, { look: () => ({ colour: 0, pattern: 0, relief: { layer: 9, depthMetres: 0.1 } }), blendMetres: 0.25, heights })).toThrow(/relief layer 9/);
  });
});

describe('the relief test heights', () => {
  it('are five deterministic, tileable layers using the 0–1 range (rows and joints where the material has them)', () => {
    const size = 256;
    const a = reliefTestHeights(size);
    const b = reliefTestHeights(size);
    expect(a.length).toBe(RELIEF_TEST_LAYERS.length);
    for (let k = 0; k < a.length; k++) {
      const l = a[k]!;
      expect(l.length).toBe(size * size);
      expect(l.every((v, i) => v === b[k]![i]), RELIEF_TEST_LAYERS[k]).toBe(true);
      let lo = 255;
      let hi = 0;
      for (const v of l) {
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
      expect(hi - lo, RELIEF_TEST_LAYERS[k]).toBeGreaterThan(120);
      // Tileable: the last column runs on into the first (and the last row into the first) as any two neighbours do.
      let wrap = 0;
      let inner = 0;
      for (let y = 0; y < size; y++) {
        wrap += Math.abs(l[y * size + size - 1]! - l[y * size]!);
        inner += Math.abs(l[y * size + size / 2]! - l[y * size + size / 2 - 1]!);
      }
      for (let x = 0; x < size; x++) {
        wrap += Math.abs(l[(size - 1) * size + x]! - l[x]!);
        inner += Math.abs(l[(size / 2) * size + x]! - l[(size / 2 - 1) * size + x]!);
      }
      expect(wrap, RELIEF_TEST_LAYERS[k]).toBeLessThan(inner * 2.5 + size * 4);
    }
  });
});
