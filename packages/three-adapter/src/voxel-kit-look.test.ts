/**
 * What kit pieces wear: their kit's one texture set read from the pieces'
 * GLB material (a real GLB parsed by the engine's loader port, its image
 * drawn from the texture asset an import extracted it into), at the
 * world-anchored U for a kit with a trim layout; a stand-in colour when the
 * material has no image; the labelled debug textures only behind the debug
 * switch. The programs build on both backends.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { DRAFT_TRIM_LAYOUT } from '@thirdlight/project-model';

import { createGltfLoaderPort } from './gltf-loader';
import { TEXTURE_ASSET_KEY } from './resource-bytes';
import { buildGlb } from './test-glb';
import { fragmentWgslOf, glslRenderer, litScene, wgslRenderer } from './test-wgsl';
import { VoxelKitMeshes, type VoxelKitBytes, type VoxelKitRecordLike } from './voxel-kit-pieces';
import { instancedTrimGeometry, trimRunGeometry } from './voxel-trim-u';

const DIGEST = 'c'.repeat(64);

/** A kit whose two slots name two nodes of one GLB (a textured material on the mesh node). */
function kit(trimLayout?: string): VoxelKitRecordLike {
  const mesh = { assetId: 'sheet-kit', digest: DIGEST };
  return { voxelKitId: 'k', materials: [3], ...(trimLayout !== undefined ? { trimLayout } : {}), slots: { 'edge-out-top': { meshes: [{ mesh: { ...mesh, node: 'Rotor' } }] }, 'edge-out-vertical': { meshes: [{ mesh: { ...mesh, node: 'Main' } }] } } };
}

/** The sheet texture asset an import extracted the GLB's image into (a DataTexture standing in for its KTX2). */
function sheet(): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array([200, 120, 60, 255]), 1, 1);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

describe("kit pieces wear their kit's texture set", () => {
  it("reads the GLB's material once a file, its image from the extracted texture asset: a lit material with the sheet, the trim U on every map for a layout kit", async () => {
    const glb = buildGlb({ image: true, clip: false });
    let reads = 0;
    const read: VoxelKitBytes = async () => (reads++, { bytes: glb, version: 1, textures: { '0': 'sheet-albedo' } });
    const asked: string[] = [];
    const meshes = new VoxelKitMeshes();
    const loaded = await meshes.load([kit()], read, createGltfLoaderPort(), undefined, async (id) => (asked.push(id), sheet()));
    expect(loaded.failed).toEqual([]);
    // Two nodes of one file: read and parsed once, the extracted image asked for once.
    expect(reads).toBe(1);
    expect(asked).toEqual(['sheet-albedo']);
    const ref = kit().slots['edge-out-top']!.meshes[0]!.mesh;
    const look = meshes.look(ref)!;
    expect(look).not.toBeNull();
    expect(look.map!.userData[TEXTURE_ASSET_KEY]).toBe('sheet-albedo');
    // Every node of the file shares the look, so the kit's pieces share one draw material.
    expect(meshes.look(kit().slots['edge-out-vertical']!.meshes[0]!.mesh)).toBe(look);
    const plain = meshes.material('k', undefined, look) as THREE.MeshStandardMaterial;
    expect(plain.type).toBe('MeshStandardNodeMaterial');
    expect(plain.map).toBe(look.map);
    expect([plain.roughness, plain.metalness]).toEqual([look.roughness, look.metalness]);
    expect(meshes.material('k', undefined, look)).toBe(plain);
    const trim = meshes.material('k', DRAFT_TRIM_LAYOUT, look) as THREE.MeshStandardMaterial & { colorNode: unknown };
    expect(trim).not.toBe(plain);
    expect(trim.colorNode).not.toBeNull();
    // Both programs build, the trim one reading the per-instance U.
    for (const renderer of [wgslRenderer(), glslRenderer()]) {
      const geometry = instancedTrimGeometry(trimRunGeometry(new THREE.BoxGeometry(0.5, 0.1, 0.1), DRAFT_TRIM_LAYOUT, 0), 2).geometry;
      for (const [m, g] of [[trim, geometry], [plain, new THREE.BoxGeometry()]] as const) {
        const scene = litScene();
        const mesh = new THREE.InstancedMesh(g, m, 2);
        scene.add(mesh);
        expect(fragmentWgslOf(renderer, scene, mesh).length).toBeGreaterThan(100);
      }
    }
    meshes.dispose();
  });

  it('draws a stand-in colour for a material without an image, and the debug sets only behind the debug switch', async () => {
    const glb = buildGlb({ clip: false });
    const read: VoxelKitBytes = async () => ({ bytes: glb, version: 1 });
    const meshes = new VoxelKitMeshes();
    await meshes.load([kit()], read, createGltfLoaderPort());
    const ref = kit().slots['edge-out-top']!.meshes[0]!.mesh;
    expect(meshes.look(ref)).toBeNull();
    const stand = meshes.material('k', DRAFT_TRIM_LAYOUT, null) as THREE.MeshLambertMaterial;
    expect(stand.map).toBeNull();
    expect(meshes.material('k', undefined, null)).toBe(stand);
    meshes.dispose();
    // Debug: the labelled sets even with a textured look (a page's ?trimDebug=1).
    const debug = new VoxelKitMeshes({ debug: true });
    const withImage = buildGlb({ image: true, clip: false });
    await debug.load([kit()], async () => ({ bytes: withImage, version: 1, textures: { '0': 'sheet-albedo' } }), createGltfLoaderPort(), undefined, async () => sheet());
    const look = debug.look(ref);
    expect((debug.material('k', undefined, look) as THREE.MeshLambertMaterial).map).toBe(debug.texture);
    expect((debug.material('k', DRAFT_TRIM_LAYOUT, look) as THREE.MeshLambertMaterial).map).not.toBe(debug.texture);
    debug.dispose();
  });
});
