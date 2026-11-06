/**
 * The voxel surface program as three builds it (WGSL and GLSL, no GPU):
 * what it reads a pixel and how many texture units it binds, against the
 * lit programs' budget; the grid projection of construction (the program's
 * own math, run on numbers): bands at one height on every wall, floors
 * continuous across chunks and phase wraps, a roof's V up its slope; and
 * the grid store's regions and growth.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { CONSTRUCTION_TILE_METRES, MATERIAL_BITS, SHADER_BORDER_CELLS, SHADER_READ_DEPTH_CELLS, shaderGridSide, VOXEL_SIZE_M, WETNESS_MAX } from '@thirdlight/voxel';

import { fragmentWgslOf, glslRenderer, settle, wgslRenderer } from './test-wgsl';
import { LIGHT_PATH_TEXTURE_UNITS, LIT_TEXTURE_UNITS } from './texture-units';
import { createVoxelSurface, PHASE_CELLS, VOXEL_SURFACE_KEY, type VoxelGridRenderer } from './voxel-surface';
import { gridPhases, gridUv, type ProjectionOps } from './voxel-surface-projection';

// The layout the voxel package derives for 32³ chunks.
const LAYOUT = { cellMetres: VOXEL_SIZE_M, side: shaderGridSide(32), border: SHADER_BORDER_CELLS, materialBits: MATERIAL_BITS, wetnessMax: WETNESS_MAX, readDepthCells: SHADER_READ_DEPTH_CELLS };

function program(shading: 'blend' | 'flat', bands = false, glsl = false): string {
  const surface = createVoxelSurface(LAYOUT, { look: (m) => ({ colour: 0x808080 + m, pattern: m % 4 }), blendMetres: 0.5, shading, bands });
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1), new THREE.DirectionalLight(0xffffff, 2));
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]), 3));
  const mesh = new THREE.Mesh(geo, surface.material);
  mesh.userData[VOXEL_SURFACE_KEY] = surface.objectValues();
  scene.add(mesh);
  return fragmentWgslOf(glsl ? glslRenderer() : wgslRenderer(), scene, mesh);
}

/** Texture bindings a WGSL fragment program declares. */
const bindings = (wgsl: string): number => (wgsl.match(/:\s*texture_(?:2d|3d|cube|depth)\w*(?:<[^>]*>)?\s*;/g) ?? []).length;
/** Texture reads in a WGSL program's text (every load and sample call). */
const reads = (wgsl: string): number => (wgsl.match(/\btexture(?:Load|Sample\w*)\s*\(/g) ?? []).length;

describe('the voxel surface program', () => {
  it('reads nine grid texels (the eight round the pixel, the one under them for a pixel above its roof), four table texels and six pattern samples a pixel, and binds three textures (the bands: two samples and a texture more)', async () => {
    await settle();
    // Both programs also read three's BRDF table (the standard material's environment term): one read, one binding.
    const flat = program('flat');
    expect(reads(flat)).toBe(1);
    expect(bindings(flat)).toBe(1);
    const blend = program('blend');
    expect(reads(blend) - reads(flat)).toBe(19);
    expect((blend.match(/\btextureLoad\s*\(/g) ?? []).length).toBe(13);
    // The grid is a 3D texture read at whole 3D texel coordinates (no flip, no transform).
    expect(blend).toMatch(/:\s*texture_3d<f32>\s*;/);
    expect((blend.match(/\btextureLoad\(\s*\w+,\s*vec3<i32>\(/g) ?? []).length).toBe(9);
    expect(bindings(blend) - bindings(flat)).toBe(3);
    // The engine's lit programs keep the light path's units free; the surface's leave room for them.
    expect(bindings(blend) + LIGHT_PATH_TEXTURE_UNITS).toBeLessThanOrEqual(LIT_TEXTURE_UNITS);
    // Every pattern sample (implicit derivatives) is in the program's top-level flow, outside any branch: WGSL's
    // uniformity rules refuse one in a branch that varies per pixel.
    const body = blend.slice(blend.indexOf('@fragment'));
    for (const line of body.split('\n').filter((l) => /\btextureSample\(/.test(l))) expect(line.startsWith('\t') && !line.startsWith('\t\t'), line).toBe(true);
    // The band test texture: a binding and a sample a material more, still in the top-level flow; off, nothing of it.
    const banded = program('blend', true);
    expect(reads(banded) - reads(blend)).toBe(2);
    expect(bindings(banded) - bindings(blend)).toBe(1);
    expect(bindings(banded) + LIGHT_PATH_TEXTURE_UNITS).toBeLessThanOrEqual(LIT_TEXTURE_UNITS);
    const bandBody = banded.slice(banded.indexOf('@fragment'));
    for (const line of bandBody.split('\n').filter((l) => /\btextureSample\(/.test(l))) expect(line.startsWith('\t') && !line.startsWith('\t\t'), line).toBe(true);
    // WebGL 2 builds the same program: the same fetches and samples (texelFetch / texture in GLSL).
    for (const bandsOn of [false, true]) {
      const glsl = program('blend', bandsOn, true);
      expect((glsl.match(/\btexelFetch\s*\(/g) ?? []).length, `bands ${bandsOn}`).toBe(13);
      expect((glsl.match(/\btexture\s*\(/g) ?? []).length - (program('flat', false, true).match(/\btexture\s*\(/g) ?? []).length, `bands ${bandsOn}`).toBe(bandsOn ? 8 : 6);
    }
  });

  it('refuses a material tile that does not divide the phase length (the texture would move where the phase wraps)', () => {
    expect(() => createVoxelSurface(LAYOUT, { look: (m) => ({ colour: 0, pattern: 0, ...(m === 7 ? { constructionTileMetres: 3 } : {}) }), blendMetres: 0.5 })).toThrow(/material 7: a construction tile of 3 m/);
    expect(() => createVoxelSurface(LAYOUT, { look: () => ({ colour: 0, pattern: 0, terrainTileMetres: 8 }), blendMetres: 0.5 })).not.toThrow();
  });
});

const NUM: ProjectionOps<number, boolean> = {
  num: (v) => v,
  add: (a, b) => a + b,
  sub: (a, b) => a - b,
  mul: (a, b) => a * b,
  div: (a, b) => a / b,
  abs: Math.abs,
  max: Math.max,
  sqrt: Math.sqrt,
  less: (a, b) => a < b,
  pick: (c, a, b) => (c ? a : b),
};

/** A normal as the mesh carries it (snorm8, read back as the view does). */
const snorm = (v: readonly number[]): [number, number, number] => {
  const l = Math.hypot(...v);
  const q = v.map((c) => Math.max(-1, Math.round((c / l) * 127) / 127));
  const m = Math.hypot(...q);
  return [q[0]! / m, q[1]! / m, q[2]! / m];
};

/**
 * The (U, V) the program computes for a world point (metres) on a surface
 * with normal `n`, drawn by the chunk whose corner is cell `corner`: the
 * chunk's phases as the view sets them, plus the point's local position.
 */
function uvAt(world: readonly number[], n: readonly number[], corner: readonly number[]): [number, number] {
  const phase = { x: 0, y: 0, z: 0, set(x: number, y: number, z: number) { Object.assign(this, { x, y, z }); } };
  const slope = { ...phase };
  const slope5 = { ...phase };
  gridPhases(corner, VOXEL_SIZE_M, PHASE_CELLS, phase, slope, slope5);
  const local = world.map((w, a) => w - corner[a]! * VOXEL_SIZE_M);
  const p = [phase.x, phase.y, phase.z].map((c, a) => c * VOXEL_SIZE_M + local[a]!) as [number, number, number];
  const ps = [slope.x, slope.y, slope.z].map((c, a) => c + local[a]!) as [number, number, number];
  const ps5 = [slope5.x, slope5.y, slope5.z].map((c, a) => c + local[a]!) as [number, number, number];
  return gridUv(NUM, p, ps, ps5, snorm(n));
}

const T = CONSTRUCTION_TILE_METRES;
/** `v` within the tile, [0, T). */
const inTile = (v: number): number => ((v % T) + T) % T;
/** Two tile coordinates equal (within a 1/1024 m, either side of a tile's edge). */
const sameInTile = (a: number, b: number): boolean => Math.min(Math.abs(inTile(a) - inTile(b)), T - Math.abs(inTile(a) - inTile(b))) < 1 / 1024;
const corner = (cell: readonly number[]): number[] => cell.map((c) => Math.floor(c / 32) * 32);

describe('the grid projection of construction', () => {
  it('puts a band at the same world height on every wall: any chunk, level, side or phase wrap', () => {
    // Walls facing each way, in chunks far apart (one past a phase wrap at 1,024 cells, one kilometres out, one below 0).
    const walls: Array<{ at: number[]; n: number[] }> = [
      { at: [3.25, 1.7, 10], n: [0, 0, 1] },
      { at: [700.5, 1.7, -3], n: [0, 0, -1] },
      { at: [511.9, 1.7, 40.2], n: [1, 0, 0] },
      { at: [-4000.25, 1.7, 9000.75], n: [-1, 0, 0] },
    ];
    for (const lift of [0, 4, 8, -12]) {
      for (const w of walls) {
        const at = [w.at[0]!, w.at[1]! + lift, w.at[2]!];
        const [, v] = uvAt(at, w.n, corner(at.map((m) => Math.floor(m / VOXEL_SIZE_M))));
        // V is the world height within the tile: 1.7 m at every wall, every storey of 4 m.
        expect(sameInTile(v, 1.7), `${at.join(',')} n ${w.n.join(',')}: v ${v}`).toBe(true);
      }
    }
    // A wall's U runs along it to the right seen from outside, by the metre.
    const u = (x: number, z: number, n: number[]): number => uvAt([x, 1, z], n, corner([Math.floor(x / VOXEL_SIZE_M), 2, Math.floor(z / VOXEL_SIZE_M)]))[0];
    expect(u(3.5, 10, [0, 0, 1]) - u(3, 10, [0, 0, 1])).toBeCloseTo(0.5, 5);
    expect(u(3.5, 10, [0, 0, -1]) - u(3, 10, [0, 0, -1])).toBeCloseTo(-0.5, 5);
    expect(u(5, 10.5, [1, 0, 0]) - u(5, 10, [1, 0, 0])).toBeCloseTo(-0.5, 5);
    expect(u(5, 10.5, [-1, 0, 0]) - u(5, 10, [-1, 0, 0])).toBeCloseTo(0.5, 5);
  });

  it('runs a floor on across chunk faces and phase wraps: the same point gives the same (U, V) from either chunk', () => {
    // Points on chunk faces (x = 16 m, z = 512 m: the phase wrap at 1,024 cells): drawn by the chunk on either side.
    for (const at of [[16, 2, 5.25], [7.3, 2, 512], [512, -6, 512], [-16, 30, -1.75]]) {
      const cell = at.map((m) => m / VOXEL_SIZE_M);
      const sides = [corner(cell.map((c) => c - 1e-6)), corner(cell.map((c) => c + 1e-6))];
      for (const n of [[0, 1, 0], [0, -1, 0]]) {
        const [a, b] = sides.map((c) => uvAt(at, n, c));
        expect(sameInTile(a![0], b![0]) && sameInTile(a![1], b![1]), `${at.join(',')} n ${n.join(',')}: ${a} vs ${b}`).toBe(true);
      }
      // U along x, V along −z on a floor (x and z under a ceiling), by the metre.
      const [u0, v0] = uvAt(at, [0, 1, 0], sides[1]!);
      const [u1, v1] = uvAt([at[0]! + 0.25, at[1]!, at[2]! + 0.25], [0, 1, 0], sides[1]!);
      expect([u1 - u0, v1 - v0].map((d) => Math.round(d * 1e6) / 1e6)).toEqual([0.25, -0.25]);
    }
  });

  it("maps a roof plane along its slope: V the distance up it, the same along the eave (a band parallel to the eave), continuous where the phase wraps", () => {
    // A 45° plane facing +z and up (it rises toward −z), as the roof mesher's snorm8 normal; one facing −x (a hip's
    // other side); a 1:2 plane facing +z (rising toward −z, half a cell a cell) and one facing −x.
    for (const [n, along, up] of [
      [[0, 1, 1], [1, 0, 0], [0, 1, -1]],
      [[-1, 1, 0], [0, 0, 1], [1, 1, 0]],
      [[0, 2, 1], [1, 0, 0], [0, 1, -2]],
      [[-1, 2, 0], [0, 0, 1], [2, 1, 0]],
    ] as const) {
      const base = [100.25, 20.5, 37.75];
      const len = Math.hypot(...up);
      const at = (s: number, t: number): number[] => base.map((b, a) => b + along[a]! * s + (up[a]! / len) * t);
      const uv = (p: number[]): [number, number] => uvAt(p, n, corner(p.map((m) => Math.floor(m / VOXEL_SIZE_M))));
      const [u0, v0] = uv(at(0, 0));
      // Along the eave (level, across chunk faces): V the same, U the metres along it.
      for (const s of [0.5, 3, 17.25]) {
        const [u, v] = uv(at(s, 0));
        expect(v - v0, `along ${s}`).toBeCloseTo(0, 2);
        expect(u - u0, `along ${s}`).toBeCloseTo(s, 4);
      }
      // Up the slope: V the distance along it (within the snorm8 normal's tilt).
      for (const t of [0.5, 2, 5.5]) expect(uv(at(0, t))[1] - v0, `up ${t}`).toBeCloseTo(t, 2);
    }
    // Where the plain phase wraps (z = 512 m, x = 512 m), the slope's V from either chunk is the same point of the
    // tile, at 45° and at 1:2.
    for (const n of [[0, 1, 1], [0, 2, 1], [2, 1, 0].map((c, a) => (a === 1 ? 2 : a === 0 ? -1 : 0))]) {
      for (const at of [[3, 40.5, 512], [512, 40.5, 30], [512, 512, 512]]) {
        const cell = at.map((m) => m / VOXEL_SIZE_M);
        const [a, b] = [corner(cell.map((c) => c - 1e-6)), corner(cell.map((c) => c + 1e-6))].map((c) => uvAt(at, n, c));
        expect(sameInTile(a![1], b![1]) && sameInTile(a![0], b![0]), `${at.join(',')} n ${n.join(',')}: ${a} vs ${b}`).toBe(true);
      }
    }
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
