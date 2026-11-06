/**
 * Decals on a voxel world's draws, with the voxel package's real derive and
 * join and the adapter's real decal paths:
 *
 * - projected: a chunk's surface and its kit pieces 8 km out are reached by a
 *   decal's box and blend it in a program of their own that still places
 *   vertices with the 64-bit model-view; the world's decal layers keep a
 *   decal of other layers off them, pieces built later included;
 * - clipped: a level-0 chunk's surface is a surface the scene's clipped
 *   decals are cut from (through the scene's link, as the adapter keeps it);
 *   a dig under the mark swaps the chunk and the decal is cut again from the
 *   new surface, the old mark drawn until then and never two; a coarser
 *   level is no surface; a change of the world's layers takes the mark away.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  buildApron,
  chunkGrid,
  createWorldStore,
  deriveWithApron,
  FloatingOrigin,
  jobRadius,
  joinSectionsForDraw,
  MATERIAL_BITS,
  SHADER_BORDER_CELLS,
  SHADER_READ_DEPTH_CELLS,
  shaderGridSide,
  VOXEL_ROLE,
  VOXEL_SIZE_M,
  WETNESS_MAX,
  WORLD_RULES,
  worldPieceTable,
  type PaletteStore,
  type PieceTable,
} from '@thirdlight/voxel';

import { ClippedDecals } from './clipped-decals';
import { installDecalDraw } from './mesh-decals';
import { decalVariant, DECAL_LAYERS_KEY, DECAL_SURFACE_KEY, installProjectedDecalSteps, ProjectedDecals } from './projected-decals';
import { RenderGraph } from './render-graph';
import { wgslOf, wgslRenderer } from './test-wgsl';
import { VoxelChunkView, voxelStandInLook } from './voxel-chunk-view';
import { VoxelKitMeshes, type VoxelKitRecordLike } from './voxel-kit-pieces';
import { attachVoxelWorldDecals, voxelWorldDecalsOf, VoxelWorldDecals } from './voxel-world-decals';
import { createVoxelSurface, type VoxelGridRenderer } from './voxel-surface';

installProjectedDecalSteps();

const grid = chunkGrid(32);
const STONE = 3;

/** Ground under y = 4 and a stone wall along x at z = 0, 8 cells tall (y 4…11), x −6…5: its front face at z = 0.5 m. */
function world(): PaletteStore {
  const s = createWorldStore(grid);
  for (let x = -24; x < 24; x++) for (let z = -24; z < 24; z++) for (let y = -6; y < 4; y++) s.setVoxel(x, y, z, { material: 1, role: VOXEL_ROLE.terrain, shape: 15, wetness: 0 });
  for (let x = -6; x < 6; x++) for (let y = 4; y < 12; y++) s.setVoxel(x, y, 0, { material: STONE, role: VOXEL_ROLE.wall, shape: 15, wetness: 0 });
  return s;
}

const renderer: VoxelGridRenderer = { backend: { isWebGLBackend: true, get: () => ({}), copyTextureToTexture: () => undefined }, initTexture: () => undefined, copyTextureToTexture: () => undefined };

function view(kits?: { set: ReturnType<VoxelKitMeshes['set']> }): VoxelChunkView {
  const surface = createVoxelSurface({ cellMetres: VOXEL_SIZE_M, side: shaderGridSide(grid.edge), border: SHADER_BORDER_CELLS, materialBits: MATERIAL_BITS, wetnessMax: WETNESS_MAX, readDepthCells: SHADER_READ_DEPTH_CELLS }, { look: voxelStandInLook, blendMetres: 0.25 });
  const v = new VoxelChunkView({ grid, origin: new FloatingOrigin({ grid }), surface, renderer });
  if (kits !== undefined) v.setKits(kits.set);
  return v;
}

/** Chunk (cx, cy, cz)'s derive with the world rules, joined for drawing, drawn as chunk (at…) of `v`. */
function draw(v: VoxelChunkView, s: PaletteStore, table: PieceTable, c: [number, number, number], at = c, level = 0): void {
  const d = deriveWithApron(grid, WORLD_RULES, buildApron(s, ...c, jobRadius(WORLD_RULES)), (out) => s.exportChunk(...c, out), undefined, 0, { table, chunk: c });
  const j = joinSectionsForDraw(grid.edge, grid.edge, [d], v.cells);
  v.set(...at, { ground: j.ground, base: j.base, instances: j.instances, solid: j.solid }, level);
}

const chunkGroup = (v: VoxelChunkView, name: string): THREE.Object3D => v.root.children.find((c) => c.name === name)!;
const surfaceOf = (g: THREE.Object3D): THREE.Mesh => g.children.find((c) => !(c instanceof THREE.InstancedMesh)) as THREE.Mesh;
const piecesOf = (g: THREE.Object3D): THREE.InstancedMesh[] => g.children.filter((c): c is THREE.InstancedMesh => c instanceof THREE.InstancedMesh);

describe('projected decals on a voxel world', () => {
  it('reach a chunk 8 km out and its kit pieces, blend in their own program on the 64-bit model-view, and keep to the world\'s decal layers', () => {
    const mesh = { assetId: 'board', digest: 'b'.repeat(64) };
    const records: VoxelKitRecordLike[] = [{ voxelKitId: 'stone', materials: [STONE], slots: { 'edge-out-top': { meshes: [{ mesh }] } } }];
    const kitMeshes = new VoxelKitMeshes();
    kitMeshes.add(mesh, new THREE.BoxGeometry(0.5, 0.06, 0.06));
    const table = worldPieceTable(records, 0);
    const v = view({ set: kitMeshes.set(table, records) });
    const scene = new THREE.Scene();
    scene.add(v.root);
    const far = 512;
    draw(v, world(), table, [0, 0, 0], [far, 0, far]);
    scene.updateMatrixWorld();
    const g = chunkGroup(v, `voxel-chunk ${far},0,${far}`);
    const surface = surfaceOf(g);
    const pieces = piecesOf(g);
    expect(pieces.length).toBeGreaterThan(0);
    // A decal box on the wall's top edge, 8 km out on x and z (metres): the wall's cells x 0…5, y 11, z 0 of that chunk.
    const x0 = far * 32 * VOXEL_SIZE_M;
    const decals = new ProjectedDecals();
    decals.setBoxes([{ min: [x0 + 0.5, 5.5, x0 - 0.2], max: [x0 + 1.5, 6.2, x0 + 0.8], layerMask: 0b01 }]);
    expect(decals.hits(surface)).toBe(true);
    expect(pieces.every((p) => decals.hits(p))).toBe(true);
    // Each wears the decal variant: the decal loop, and the vertices still placed relative to the camera in 64 bits.
    const r = wgslRenderer();
    for (const m of [surface, pieces[0]!]) {
      const own = m.material as THREE.Material;
      m.material = decalVariant(own, decals);
      const wgsl = wgslOf(r, scene, m);
      m.material = own;
      expect(wgsl).toContain('tlDecalAlbedo');
      const vertex = wgsl.split('@fragment')[0]!;
      expect(vertex).toMatch(/modelViewMatrix = object\.nodeUniform\d+;/);
      expect(vertex).not.toMatch(/cameraViewMatrix \* object\./);
    }
    // The world in layer 2 only (its object's decalLayers): the layer-1 decal reaches none of its draws, pieces built later included.
    v.setDecalLayers(0b10);
    expect([surface, ...pieces].map((m) => m.userData[DECAL_LAYERS_KEY])).toEqual([surface, ...pieces].map(() => 0b10));
    expect(decals.hits(surface)).toBe(false);
    expect(pieces.some((p) => decals.hits(p))).toBe(false);
    v.setKits(kitMeshes.set(table, records));
    draw(v, world(), table, [0, 0, 0], [far, 0, far]);
    // A frame's matrix update (the renderer's).
    scene.updateMatrixWorld();
    const again = chunkGroup(v, `voxel-chunk ${far},0,${far}`);
    expect([surfaceOf(again), ...piecesOf(again)].every((m) => m.userData[DECAL_LAYERS_KEY] === 0b10)).toBe(true);
    // Back to every layer: the key goes (absent is every layer), and the decal reaches them again.
    v.setDecalLayers(undefined);
    expect(surfaceOf(again).userData[DECAL_LAYERS_KEY]).toBeUndefined();
    expect(decals.hits(surfaceOf(again))).toBe(true);
  });
});

/** A decal material as the library makes one. */
function decalMaterial(): THREE.Material {
  const m = new THREE.MeshStandardMaterial();
  installDecalDraw(m, { blend: 'blend', sortOrder: 0 });
  return m;
}

describe('clipped decals on a voxel world', () => {
  it('are cut from a level-0 chunk\'s surface; a dig under the mark cuts it again from the swapped chunk, the old one drawn until then, never two; a coarser level is no surface; the world\'s layers apply', () => {
    const scene = new THREE.Scene();
    const graph = new RenderGraph(scene, () => false);
    const material = decalMaterial();
    const clipped = new ClippedDecals({
      node: (id) => graph.nodeFor(id) ?? null,
      dress: (m) => {
        m.material = material;
        return null;
      },
      workers: null,
      store: null,
      changed: () => undefined,
    });
    graph.onSurfaces(clipped);
    // The link a scene adapter keeps on its scene; the world's draws take it when their view is made.
    attachVoxelWorldDecals(scene, new VoxelWorldDecals(clipped));
    const link = voxelWorldDecalsOf(scene)!;
    const v = view();
    scene.add(v.root);
    v.setDecalSurfaces(link.surfaces);
    const s = world();
    const table = worldPieceTable([], 0);
    // Drawn 4 chunks (64 m) out on x: a surface's place must come from its chunk's matrix, never the identity.
    const OUT = 4;
    const M = OUT * 32 * VOXEL_SIZE_M;
    draw(v, s, table, [0, 0, 0], [OUT, 0, 0]);
    draw(v, s, table, [-1, 0, 0], [OUT - 1, 0, 0]);
    const frame = (): void => {
      graph.update();
      clipped.beforeFrame();
    };
    // A 1 m mark on the wall's front (z 0.5 m), centred on cell (3, 8): it projects along −z onto the face.
    graph.addEntity('moss', null);
    graph.world.setLocal('moss', [M + 1.75, 4.25, 0.5], [0, 0, 0, 1], [1, 1, 1]);
    graph.update();
    clipped.set('moss', { size: [1, 1, 0.6], material: 'moss', mode: 'clipped' } as never, 'scene-a');
    frame();
    frame();
    const first = clipped.meshOf('moss')!;
    expect(first).not.toBeNull();
    const trisOf = (m: THREE.Mesh): number => (m.geometry.index?.count ?? m.geometry.getAttribute('position').count) / 3;
    // The face's quads in the box, cut to it: the mark lies on the one surface, the chunk's (no other is listed).
    expect(trisOf(first)).toBeGreaterThan(0);
    const d0 = clipped.diagnostics();
    expect(d0).toMatchObject({ decals: 1, drawn: 1, pending: 0, surfaces: 2 });
    expect(surfaceOf(chunkGroup(v, `voxel-chunk ${OUT},0,0`)).userData[DECAL_SURFACE_KEY]).toBe(true);

    // A cell dug under the mark: the chunk is swapped; until the next frames the old mark stays drawn, alone.
    s.setVoxel(3, 8, 0, { material: 0, role: VOXEL_ROLE.air, shape: 0, wetness: 0 });
    draw(v, s, table, [0, 0, 0], [OUT, 0, 0]);
    expect(clipped.meshOf('moss')).toBe(first);
    const t0 = performance.now();
    frame();
    frame();
    const reclipMs = performance.now() - t0;
    const second = clipped.meshOf('moss')!;
    expect(second).not.toBe(first);
    expect(trisOf(second)).not.toBe(trisOf(first));
    // One mark under the decal's node (the old one went when the new one came).
    expect(graph.node('moss')!.children.filter((c) => (c as THREE.Mesh).isMesh === true)).toEqual([second]);
    const d1 = clipped.diagnostics();
    expect(d1).toMatchObject({ decals: 1, drawn: 1, pending: 0, surfaces: 2 });
    expect(d1.made.page).toBe(2);
    console.log(`[voxel decals] a dig under a clipped mark: re-cut on the page ${d1.pageMs.max.toFixed(2)} ms (worst), both frames ${reclipMs.toFixed(2)} ms; ${trisOf(first)} → ${trisOf(second)} triangles`);

    // The chunk drawn coarser (level 1 in its place): no surface, so the mark goes with the level-0 chunk.
    v.remove(OUT, 0, 0);
    draw(v, s, table, [0, 0, 0], [OUT / 2, 0, 0], 1);
    frame();
    frame();
    expect(clipped.meshOf('moss')).toBeNull();
    expect(clipped.diagnostics().surfaces).toBe(1);
    // Level 0 again: the same surface as before the coarse draw, so its mesh comes from memory, not a new cut.
    v.remove(OUT / 2, 0, 0, 1);
    draw(v, s, table, [0, 0, 0], [OUT, 0, 0]);
    frame();
    frame();
    expect(clipped.meshOf('moss')).not.toBeNull();
    expect(clipped.diagnostics().made).toMatchObject({ page: 2, memory: 1 });

    // The world's object puts it in layer 2; the decal marks layer 1 only.
    clipped.set('moss', { size: [1, 1, 0.6], material: 'moss', mode: 'clipped', layers: 0b01 } as never, 'scene-a');
    frame();
    frame();
    expect(clipped.meshOf('moss')).not.toBeNull();
    v.setDecalLayers(0b10);
    frame();
    frame();
    expect(clipped.meshOf('moss')).toBeNull();

    // The view gone: its surfaces leave the decals.
    v.dispose();
    frame();
    expect(clipped.diagnostics().surfaces).toBe(0);
  });

  it('a scene\'s link gives each world its first object\'s decal layers and tells the draws when they change', () => {
    const link = new VoxelWorldDecals(null);
    const told: string[] = [];
    link.onLayers((w) => told.push(w));
    link.set('a', { voxelWorld: { world: 'town', decalLayers: 4 } });
    link.set('b', { voxelWorld: { world: 'town', decalLayers: 1 } });
    link.set('c', { box: {} });
    expect(link.layersOf('town')).toBe(4);
    expect(link.layersOf('other')).toBeUndefined();
    // Edited in place: the new mask, told once.
    link.set('a', { voxelWorld: { world: 'town', decalLayers: 6 } });
    expect(link.layersOf('town')).toBe(6);
    // The first object goes: the next one's mask.
    link.set('a', null);
    expect(link.layersOf('town')).toBe(1);
    link.set('b', { voxelWorld: { world: 'town' } });
    expect(link.layersOf('town')).toBeUndefined();
    expect(told).toEqual(['town', 'town', 'town', 'town']);
    // A mask that is no mask is the default.
    link.set('d', { voxelWorld: { world: 'cave', decalLayers: 999 } });
    expect(link.layersOf('cave')).toBeUndefined();
  });
});
