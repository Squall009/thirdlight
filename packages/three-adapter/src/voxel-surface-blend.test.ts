/**
 * The material blend distance: a world's default and a material's own,
 * the smaller winning where two meet, with the voxel package's real derive
 * and join, the adapter's real surface and draws and three's program
 * builders on both backends:
 *
 * - the rule on numbers (the very function the program is built from);
 * - a record's `voxel.blendMetres` lands in the material table, a world's
 *   `voxelWorld.blendMetres` in the surface's uniform;
 * - changing either rebuilds no mesh and no program: a record edit uploads
 *   the table only, a world's object edit sets the uniform only (the path
 *   Play, exports and the Scene view draw through).
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { VOXEL_MATERIAL_LIMITS, voxelWorldBlendMetres } from '@thirdlight/project-model';
import { buildApron, chunkGrid, createWorldStore, deriveWithApron, jobRadius, joinSectionsForDraw, MATERIAL_BITS, SHADER_BORDER_CELLS, SHADER_READ_DEPTH_CELLS, shaderGridSide, VOXEL_ROLE, VOXEL_SIZE_M, WETNESS_MAX, WORLD_RULES, worldPieceTable, type PaletteStore } from '@thirdlight/voxel';
import { fragmentWgslOf, glslRenderer, wgslRenderer } from './test-wgsl';
import { voxelStandInLook } from './voxel-chunk-view';
import { seamBlendMetres } from './voxel-surface-blend';
import { createVoxelSurface, type VoxelGridRenderer } from './voxel-surface';
import type { ProjectionOps } from './voxel-surface-projection';
import { attachVoxelWorldDecals, VoxelWorldDecals } from './voxel-world-decals';
import type { VoxelLookRecord } from './voxel-material-looks';
import { VoxelWorldDraws } from './voxel-world-draws';

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

const grid = chunkGrid(32);
const LAYOUT = { cellMetres: VOXEL_SIZE_M, side: shaderGridSide(grid.edge), border: SHADER_BORDER_CELLS, materialBits: MATERIAL_BITS, wetnessMax: WETNESS_MAX, readDepthCells: SHADER_READ_DEPTH_CELLS };
const GRASS = 3;
const STONE = 10;
const noUploads: VoxelGridRenderer = { backend: { isWebGLBackend: true, get: () => ({}), copyTextureToTexture: () => undefined }, initTexture: () => undefined, copyTextureToTexture: () => undefined };

/** Grass ground with a stone wall on it, in chunk (0, 0, 0). */
function world(): PaletteStore {
  const s = createWorldStore(grid);
  for (let x = 0; x < 32; x++) for (let z = 0; z < 32; z++) for (let y = 0; y < 6; y++) s.setVoxel(x, y, z, { material: GRASS, role: VOXEL_ROLE.terrain, shape: 15, wetness: 0 });
  for (let x = 8; x < 20; x++) for (let y = 6; y < 14; y++) s.setVoxel(x, y, 12, { material: STONE, role: VOXEL_ROLE.wall, shape: 15, wetness: 0 });
  return s;
}

const record = (id: number, blendMetres?: number): VoxelLookRecord => ({ materialId: `mat-${id}`, name: `M${id}`, shader: 'standard', params: {}, textures: {}, voxel: { id, use: id === STONE ? ('construction' as const) : ('terrain' as const), ...(blendMetres !== undefined ? { blendMetres } : {}) } });

describe('the material blend distance', () => {
  it('is the smallest any solid cell round the point asks for (its material\'s own, else the world\'s); air asks for nothing', () => {
    const cell = (own: number, solid = true) => ({ own, solid });
    const world = 0.25;
    // Two materials meet, one crisp: the crisp one wins from both sides of the seam (both read the same eight cells).
    expect(seamBlendMetres(NUM, [cell(-1), cell(-1), cell(0.05), cell(-1)], world)).toBe(0.05);
    // A soft material alone (beside air) keeps its own, wider than the world's.
    expect(seamBlendMetres(NUM, [cell(0.5), cell(0, false), cell(0.5), cell(0.5)], world)).toBe(0.5);
    // A soft one beside a material that sets none: the world's is the smaller.
    expect(seamBlendMetres(NUM, [cell(0.5), cell(-1)], world)).toBe(world);
    // 0 is a hard line and wins over everything; air's table row (whatever it holds) is never read as a blend.
    expect(seamBlendMetres(NUM, [cell(0), cell(0.5), cell(0.01, false)], world)).toBe(0);
    expect(seamBlendMetres(NUM, [cell(0.3), cell(0.001, false)], world)).toBe(0.3);
    // Nothing solid: the world's.
    expect(seamBlendMetres(NUM, [cell(0.1, false), cell(0.2, false)], world)).toBe(world);
  });

  it("puts a record's blend in the material table and a world's in the uniform; neither change builds a new program", () => {
    const surface = createVoxelSurface(LAYOUT, { look: (m) => ({ ...voxelStandInLook(m), ...(m === STONE ? { blendMetres: 0.05 } : {}) }), blendMetres: VOXEL_MATERIAL_LIMITS.blendMetresDefault });
    expect(surface.tableEntry(STONE).blendM).toBeCloseTo(0.05, 6);
    expect(surface.tableEntry(GRASS).blendM).toBe(-1);
    expect(surface.blendMetres).toBe(VOXEL_SIZE_M / 2);
    // The program builds on both backends.
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), surface.material);
    const scene = new THREE.Scene().add(new THREE.DirectionalLight(0xffffff, 1), mesh);
    expect([fragmentWgslOf(wgslRenderer(), scene, mesh), fragmentWgslOf(glslRenderer(), scene, mesh)].every((src) => src.length > 0)).toBe(true);
    // three builds a material's program again only when its version moves.
    const version = surface.material.version;
    const uploads = surface.tableUploads;
    surface.setBlendMetres(0);
    expect(surface.blendMetres).toBe(0);
    expect(surface.tableUploads).toBe(uploads);
    surface.setLooks((m) => ({ ...voxelStandInLook(m), ...(m === GRASS ? { blendMetres: 0.4 } : {}) }));
    expect(surface.tableUploads).toBe(uploads + 1);
    expect([surface.tableEntry(GRASS).blendM, surface.tableEntry(STONE).blendM]).toEqual([expect.closeTo(0.4, 6), -1]);
    expect(surface.material.version).toBe(version);
    expect(() => surface.setLooks((m) => ({ ...voxelStandInLook(m), blendMetres: Number.NaN }))).toThrow(/a blend of NaN m/);
    surface.dispose();
  });

  it("draws a world at its voxelWorld object's blend and follows an edit of it or of a record live, without a mesh build (the draws Play, exports and the Scene view use)", () => {
    const s = world();
    const d = deriveWithApron(grid, WORLD_RULES, buildApron(s, 0, 0, 0, jobRadius(WORLD_RULES)), (out) => s.exportChunk(0, 0, 0, out), undefined, 0, { table: worldPieceTable([], 0), chunk: [0, 0, 0] });
    const j = joinSectionsForDraw(grid.edge, grid.edge, [d], new Uint16Array(LAYOUT.side ** 3));
    const scene = new THREE.Scene();
    const link = new VoxelWorldDecals(null);
    attachVoxelWorldDecals(scene, link);
    link.set('world-1', { voxelWorld: { world: 'w', blendMetres: 0.1 } });
    const draws = new VoxelWorldDraws({ scene: () => scene, renderer: () => noUploads, report: () => undefined, materials: [record(GRASS), record(STONE, 0.05)] });
    draws.receive({ world: 'w', edge: grid.edge, chunks: [{ kind: 'draw', cx: 0, cy: 0, cz: 0, ground: j.ground, base: j.base, instances: j.instances, solid: j.solid }], swaps: [], sentAt: 0, joinMs: 0 });
    const at = () => draws.stats().worlds['w']!;
    expect(at().blendM).toBe(0.1);
    const built = at().meshBuilds;
    const uploads = at().tableUploads;
    // The world's object edited (as the Scene view's command, Play's live edit or a load would): the uniform only.
    link.set('world-1', { voxelWorld: { world: 'w', blendMetres: 0 } });
    expect([at().blendM, at().meshBuilds, at().tableUploads]).toEqual([0, built, uploads]);
    // Its field removed: the engine's default.
    link.set('world-1', { voxelWorld: { world: 'w' } });
    expect(at().blendM).toBe(voxelWorldBlendMetres(null));
    // A record's own blend edited: the table only.
    expect(draws.setMaterials([record(GRASS, 0.2), record(STONE, 0.05)])).toBe(true);
    expect([at().meshBuilds, at().tableUploads]).toEqual([built, uploads + 1]);
    draws.dispose();
    attachVoxelWorldDecals(scene, null);
  });
});
