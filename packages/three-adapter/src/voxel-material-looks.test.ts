/**
 * The voxel material table from the material records: each voxel id's look
 * from its record (instances resolved, ids without one their stand-in), and
 * a record changed rewriting the surface's table only, with the program the
 * surface built (WGSL, as three builds it) unchanged.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { MATERIAL_BITS, SHADER_BORDER_CELLS, SHADER_READ_DEPTH_CELLS, shaderGridSide, VOXEL_SIZE_M, WETNESS_MAX } from '@thirdlight/voxel';
import { fragmentWgslOf, wgslRenderer } from './test-wgsl';
import { voxelStandInLook } from './voxel-chunk-view';
import { phaseTileMetres, voxelLooksKey, voxelRecordLooks, voxelRecordTextures, type VoxelLookRecord } from './voxel-material-looks';
import { createVoxelSurface, PHASE_CELLS, VOXEL_SURFACE_KEY } from './voxel-surface';
import { CRACK_TEXELS } from './voxel-crack-texture';

const LAYOUT = { cellMetres: VOXEL_SIZE_M, side: shaderGridSide(32), border: SHADER_BORDER_CELLS, materialBits: MATERIAL_BITS, wetnessMax: WETNESS_MAX, readDepthCells: SHADER_READ_DEPTH_CELLS };

const records: VoxelLookRecord[] = [
  { materialId: 'stone', shader: 'standard', params: { color: '#808070' }, voxel: { id: 10, use: 'construction', tileMetres: 3, heightDepth: 0.08 } },
  // A voxel variant: its own id, the parent's colour, its own tile.
  { materialId: 'stone-dark', shader: 'standard', params: { color: '#202020' }, instanceOf: 'stone', voxel: { id: 11, tileMetres: 8 } },
  // A mesh variant (no voxel part of its own) and a mesh-only material: no voxel id.
  { materialId: 'stone-prop', shader: 'standard', params: {}, instanceOf: 'stone' },
  { materialId: 'crate', shader: 'standard', params: { color: '#ff0000' } },
  // A record that names no colour keeps the stand-in's.
  { materialId: 'soil', shader: 'standard', params: {}, voxel: { id: 2, use: 'terrain' } },
];

describe('voxel looks from material records', () => {
  it('draws each voxel id as its record says, over the stand-in for what it leaves out and for ids without one', () => {
    const base = (m: number) => ({ ...voxelStandInLook(m), ...(m === 10 ? { relief: { layer: 1, depthMetres: 0.03 } } : {}) });
    const look = voxelRecordLooks(records, base);
    expect(look(10)).toEqual({ ...voxelStandInLook(10), colour: 0x808070, constructionTileMetres: phaseTileMetres(3), terrainTileMetres: phaseTileMetres(3), relief: { layer: 1, depthMetres: 0.08 } });
    expect(look(11)).toEqual({ ...voxelStandInLook(11), colour: 0x202020, constructionTileMetres: 8, terrainTileMetres: 8 });
    expect(look(2)).toEqual(voxelStandInLook(2));
    for (const id of [1, 3, 12, 4095]) expect(look(id)).toEqual(voxelStandInLook(id));
    // A tile that does not divide the 512 m phase is drawn at the nearest that does.
    expect(phaseTileMetres(3)).toBeCloseTo((PHASE_CELLS * VOXEL_SIZE_M) / 171, 9);
    expect(phaseTileMetres(4)).toBe(4);
    // The key moves with a look-relevant change only.
    expect(voxelLooksKey(records)).toBe(voxelLooksKey(records.map((r) => ({ ...r, textures: { map: 'x' } }))));
    expect(voxelLooksKey(records)).not.toBe(voxelLooksKey(records.map((r) => (r.materialId === 'stone' ? { ...r, params: { color: '#000000' } } : r))));
  });

  it('draws a record with a texture set as its set (white unless it names a colour, a tint) and finds its layers from the records, a variant\'s own sets included', () => {
    const textured: VoxelLookRecord[] = [
      { materialId: 'brick', shader: 'standard', params: {}, voxel: { id: 15, use: 'construction', surfaces: { wall: { albedoHeight: 'brick-a', normal: 'brick-n' } } } },
      // A tinted variant on the same textures (one layer), and one with a floor set of its own.
      { materialId: 'brick-red', shader: 'standard', params: { color: '#d08a70' }, instanceOf: 'brick', voxel: { id: 16 } },
      { materialId: 'brick-floor', shader: 'standard', params: {}, instanceOf: 'brick', voxel: { id: 17, surfaces: { floor: { albedoHeight: 'tile-a' } } } },
      ...records,
    ];
    const look = voxelRecordLooks(textured);
    expect(look(15).colour).toBe(0xffffff);
    expect(look(16).colour).toBe(0xd08a70);
    expect(look(10).colour).toBe(0x808070);
    expect(look(2)).toEqual(voxelStandInLook(2));
    const t = voxelRecordTextures(textured)!;
    expect(t.sets.albedoHeight.layers).toEqual(['brick-a', 'tile-a']);
    expect([...t.layers]).toEqual([
      [15, [0, 0, 0]],
      [16, [0, 0, 0]],
      [17, [0, 1, 0]],
    ]);
    expect(voxelRecordTextures(records)).toBeNull();
  });

  it('rewrites the table alone when a record changes: the program stays, the crack layers stay', () => {
    const surface = createVoxelSurface(LAYOUT, { look: voxelRecordLooks(records), blendMetres: 0.5 });
    surface.setCracks([new Uint8Array(CRACK_TEXELS * CRACK_TEXELS)], (m) => (m === 10 ? 1 : 0));
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1));
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]), 3));
    const mesh = new THREE.Mesh(geo, surface.material);
    mesh.userData[VOXEL_SURFACE_KEY] = surface.objectValues();
    scene.add(mesh);
    const before = fragmentWgslOf(wgslRenderer(), scene, mesh);
    const version = surface.material.version;
    const stone = surface.tableEntry(10);
    // The table holds 32-bit floats.
    expect(stone).toMatchObject({ pattern: voxelStandInLook(10).pattern, constructionTileMetres: Math.fround(phaseTileMetres(3)), terrainTileMetres: Math.fround(phaseTileMetres(3)), crackLayer: 1 });
    expect(stone.colour.map((c) => Math.round(c * 1000) / 1000)).toEqual(new THREE.Color(0x808070).toArray().map((c) => Math.round(c * 1000) / 1000));

    const ms = surface.setLooks(voxelRecordLooks(records.map((r) => (r.materialId === 'stone' ? { ...r, params: { color: '#ff8000' }, voxel: { ...r.voxel!, tileMetres: 16 } } : r))));
    expect(ms).toBeGreaterThanOrEqual(0);
    expect([surface.tableUploads, surface.material.version]).toEqual([1, version]);
    const after = surface.tableEntry(10);
    expect(after).toMatchObject({ constructionTileMetres: 16, terrainTileMetres: 16, crackLayer: 1 });
    expect(after.colour[0]).toBeCloseTo(1, 6);
    // The variant names its own colour; the soil, naming none, keeps its stand-in's.
    expect(surface.tableEntry(11).colour[0]).toBeCloseTo(new THREE.Color(0x202020).r, 6);
    expect(surface.tableEntry(2).colour).toEqual(new THREE.Color(voxelStandInLook(2).colour).toArray().map(Math.fround));
    expect(fragmentWgslOf(wgslRenderer(), scene, mesh)).toBe(before);
    surface.dispose();
  });
});
