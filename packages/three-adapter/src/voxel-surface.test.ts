/**
 * The voxel surface program as three builds it (WGSL, no GPU): what it
 * reads a pixel and how many texture units it binds, against the lit
 * programs' budget; and the grid store's regions and growth.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { fragmentWgslOf, settle, wgslRenderer } from './test-wgsl';
import { LIGHT_PATH_TEXTURE_UNITS, LIT_TEXTURE_UNITS } from './texture-units';
import { createVoxelSurface, VOXEL_SURFACE_KEY, type VoxelGridRenderer } from './voxel-surface';

const LAYOUT = { cellMetres: 0.5, side: 34, border: 1, materialBits: 12, wetnessMax: 7 };

function program(shading: 'blend' | 'flat'): string {
  const surface = createVoxelSurface(LAYOUT, { look: (m) => ({ colour: 0x808080 + m, pattern: m % 4 }), blendMetres: 0.5, shading });
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1), new THREE.DirectionalLight(0xffffff, 2));
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]), 3));
  const mesh = new THREE.Mesh(geo, surface.material);
  mesh.userData[VOXEL_SURFACE_KEY] = surface.objectValues();
  scene.add(mesh);
  return fragmentWgslOf(wgslRenderer(), scene, mesh);
}

/** Texture bindings a WGSL fragment program declares. */
const bindings = (wgsl: string): number => (wgsl.match(/:\s*texture_(?:2d|3d|cube|depth)\w*(?:<[^>]*>)?\s*;/g) ?? []).length;
/** Texture reads in a WGSL program's text (every load and sample call). */
const reads = (wgsl: string): number => (wgsl.match(/\btexture(?:Load|Sample\w*)\s*\(/g) ?? []).length;

describe('the voxel surface program', () => {
  it('reads eight grid texels, two table texels and six pattern samples a pixel, and binds three textures', async () => {
    await settle();
    // Both programs also read three's BRDF table (the standard material's environment term): one read, one binding.
    const flat = program('flat');
    expect(reads(flat)).toBe(1);
    expect(bindings(flat)).toBe(1);
    const blend = program('blend');
    expect(reads(blend) - reads(flat)).toBe(16);
    expect((blend.match(/\btextureLoad\s*\(/g) ?? []).length).toBe(10);
    // The grid is a 3D texture read at whole 3D texel coordinates (no flip, no transform).
    expect(blend).toMatch(/:\s*texture_3d<f32>\s*;/);
    expect((blend.match(/\btextureLoad\(\s*\w+,\s*vec3<i32>\(/g) ?? []).length).toBe(8);
    expect(bindings(blend) - bindings(flat)).toBe(3);
    // The engine's lit programs keep the light path's units free; the surface's leave room for them.
    expect(bindings(blend) + LIGHT_PATH_TEXTURE_UNITS).toBeLessThanOrEqual(LIT_TEXTURE_UNITS);
    // Every pattern sample (implicit derivatives) is in the program's top-level flow, outside any branch: WGSL's
    // uniformity rules refuse one in a branch that varies per pixel.
    const body = blend.slice(blend.indexOf('@fragment'));
    for (const line of body.split('\n').filter((l) => /\btextureSample\(/.test(l))) expect(line.startsWith('\t') && !line.startsWith('\t\t'), line).toBe(true);
  });
});

describe('the shader grid store', () => {
  /** A renderer that records region uploads and copies (the WebGL 2 path: a copy from a fresh data texture). */
  function recorder(): VoxelGridRenderer & { copies: Array<{ at: THREE.Vector3 | null; box: THREE.Box3 | null }>; uploads: THREE.Vector3[] } {
    const copies: Array<{ at: THREE.Vector3 | null; box: THREE.Box3 | null }> = [];
    const uploads: THREE.Vector3[] = [];
    return {
      copies,
      uploads,
      backend: { isWebGLBackend: true, get: () => ({}), copyTextureToTexture: (_src, _dst, _r, at) => void uploads.push(at.clone()) },
      initTexture: () => undefined,
      copyTextureToTexture: (_src, _dst, box, at) => void copies.push({ at, box }),
    };
  }

  it('hands out side³ regions, uploads each on its own, and grows a quarter at a time by a GPU copy keeping every region in place', () => {
    const surface = createVoxelSurface(LAYOUT, { look: () => ({ colour: 0, pattern: 0 }), blendMetres: 0.5 });
    const g = surface.grids;
    const r = recorder();
    const at = [];
    for (let k = 0; k < 64; k++) at.push(g.allocate(r));
    expect(new Set(at.map((v) => v.toArray().join())).size).toBe(64);
    expect(at.every((v) => v.x % 34 === 0 && v.y % 34 === 0 && v.z % 34 === 0)).toBe(true);
    expect(g.gpuBytes).toBe(64 * 34 ** 3 * 2);
    expect(r.copies).toHaveLength(0);
    const first = g.texture;
    // The 65th region grows the texture: the old regions are copied to the same place.
    at.push(g.allocate(r));
    expect(g.texture).not.toBe(first);
    expect(r.copies).toHaveLength(1);
    expect(r.copies[0]!.box!.max.toArray()).toEqual([136, 136, 136]);
    expect(r.copies[0]!.at!.toArray()).toEqual([0, 0, 0]);
    expect(g.gpuBytes).toBe(80 * 34 ** 3 * 2);
    expect(new Set(at.map((v) => v.toArray().join())).size).toBe(65);
    g.upload(r, at[64]!, new Uint16Array(34 ** 3));
    expect(r.uploads.map((v) => v.toArray())).toEqual([at[64]!.toArray()]);
    expect(g.uploadedBytes).toBe(34 ** 3 * 2);
    g.release(at[3]!);
    expect(g.count).toBe(64);
    expect(g.allocate(r).equals(at[3]!)).toBe(true);
  });
});
