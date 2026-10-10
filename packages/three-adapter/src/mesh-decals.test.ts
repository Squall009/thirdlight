/**
 * Mesh decals: what a decal material builds, how the batcher and the static
 * merger take it, and what a scene without one still builds.
 *
 * The digests are the WGSL of every shader type's material (not a decal) as
 * the library built them before mesh decals existed (three r186). A scene
 * without decals must keep its programs; a change of three.js changes the
 * text: re-record them then (the failure prints the new ones).
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { DECAL_LIMITS, decalSheetCellSampling } from '@thirdlight/runtime';

import { BATCH_KEY, batchRefusal, createAutoBatcher } from './batching';
import { decalPageArray } from './decal-material';
import { digestOf } from './material-graph';
import { createMaterialLibrary, MATERIAL_NO_SHADOW_KEY, type MaterialDefLike } from './material-library';
import { DECAL_POLYGON_OFFSET, decalDrawOf, decalRenderOrder, decalRenderOrderFor, installDecalDraw, markFileDecals, setDecalDepthMode } from './mesh-decals';
import { MERGED_RENDER_ORDER, STATIC_KEY } from './static-merge';
import { litScene, settle, wgslOf, wgslRenderer } from './test-wgsl';

const TRIM = { size: [256, 256] as [number, number], texelDensity: 256, padding: 8, rows: [{ slot: 'a', top: 8, bottom: 120 }, { slot: 'b', top: 136, bottom: 248 }] };

/** One material of every shader type that is not a decal (textured where the type takes textures). */
const SHADER_MATERIALS: readonly MaterialDefLike[] = [
  { materialId: 'standard', name: 'standard', shader: 'standard', params: {}, textures: {} },
  { materialId: 'textured', name: 'textured', shader: 'standard', params: { color: '#c08040', roughness: 0.6 }, textures: { map: 'tex', normalMap: 'tex', ormMap: 'tex', emissiveMap: 'tex' } },
  { materialId: 'blended', name: 'blended', shader: 'standard', params: { alphaMode: 'blend', opacity: 0.6 }, textures: {} },
  { materialId: 'foliage', name: 'foliage', shader: 'foliage', params: {}, textures: { map: 'tex' } },
  { materialId: 'kit', name: 'kit', shader: 'kit', params: {}, textures: { map: 'tex', normalMap: 'tex' } },
  { materialId: 'water', name: 'water', shader: 'water', params: {}, textures: { normalMap: 'tex' } },
  { materialId: 'unlit', name: 'unlit', shader: 'unlit', params: {}, textures: { map: 'tex' } },
  { materialId: 'trim', name: 'trim', shader: 'trim', params: {}, textures: { map: 'tex', normalMap: 'tex', ormMap: 'tex' }, trim: TRIM },
];

/** Recorded before mesh decals existed (three r186). */
const BEFORE: Record<string, string> = {
  standard: '2cc544a08f2da47b',
  textured: '39c822174bd5badf',
  blended: '4df9b83631a1f83c',
  foliage: '3062ba15d8ae7ab1',
  kit: '83a0897a5b6be10d',
  water: '588fd2ffeda77232',
  unlit: '6c19ec5d6d3f2a86',
  trim: 'f247953ef4436cd6',
};

function texture(): THREE.Texture {
  const t = new THREE.DataTexture(new Uint8Array([200, 120, 60, 255]), 1, 1);
  t.needsUpdate = true;
  return t;
}

describe('a scene without decals keeps its programs', () => {
  it('the WGSL of every other shader type is what it was', async () => {
    const tex = texture();
    const library = createMaterialLibrary({ loadTexture: async () => tex });
    library.setMaterials(SHADER_MATERIALS);
    const scene = litScene();
    const meshes: Record<string, THREE.Mesh> = {};
    for (const d of SHADER_MATERIALS) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(1, 8, 6), new THREE.MeshStandardMaterial());
      scene.add(m);
      library.apply(m, { '*': d.materialId });
      meshes[d.materialId] = m;
    }
    await settle();
    const renderer = wgslRenderer();
    const now: Record<string, string> = {};
    for (const [id, m] of Object.entries(meshes)) now[id] = digestOf(wgslOf(renderer, scene, m));
    expect(now).toEqual(BEFORE);
  });
});

/** A page array of `layers` 4×4 layers (its texels do not matter here). */
function pageArray(layers: number): THREE.DataArrayTexture {
  const t = new THREE.DataArrayTexture(new Uint8Array(4 * 4 * 4 * layers).fill(128), 4, 4, layers);
  t.needsUpdate = true;
  return t;
}

const PAGE = (layer: number) => ({ rect: [0.1, 0.1, 0.4, 0.4] as [number, number, number, number], mip: 2, albedo: { texture: 'decals-albedo', layer }, normal: { texture: 'decals-normal', layer: 0 }, orm: { texture: 'decals-orm', layer } });
const DECALS: readonly MaterialDefLike[] = [
  { materialId: 'stain', name: 'stain', shader: 'decal', params: {}, textures: {}, decalPage: PAGE(0) },
  { materialId: 'crack', name: 'crack', shader: 'decal', params: { sortOrder: 5, color: '#806040' }, textures: {}, decalPage: PAGE(1) },
  { materialId: 'soot', name: 'soot', shader: 'decal', params: { blend: 'multiply' }, textures: {}, decalPage: PAGE(0) },
  { materialId: 'glow', name: 'glow', shader: 'decal', params: { blend: 'add', emissive: '#ff8000', emissiveIntensity: 2 }, textures: {}, decalPage: PAGE(0) },
];

async function decalScene(defs: readonly MaterialDefLike[]): Promise<{ scene: THREE.Scene; meshes: Record<string, THREE.Mesh> }> {
  const arrays: Record<string, THREE.Texture> = { 'decals-albedo': pageArray(2), 'decals-normal': pageArray(1), 'decals-orm': pageArray(2), tex: texture() };
  const library = createMaterialLibrary({ loadTexture: async (id) => arrays[id] ?? null });
  library.setMaterials(defs);
  const scene = litScene();
  const meshes: Record<string, THREE.Mesh> = {};
  for (const d of defs) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial());
    m.castShadow = true;
    scene.add(m);
    library.apply(m, { '*': d.materialId });
    meshes[d.materialId] = m;
  }
  await settle();
  return { scene, meshes };
}

describe('a decal material', () => {
  it('draws over the surface: transparent, no depth written, no shadow cast, in the decal order before other transparent surfaces', async () => {
    const { meshes } = await decalScene(DECALS);
    const stain = meshes['stain']!;
    const m = stain.material as THREE.Material;
    expect([m.transparent, m.depthWrite, m.depthTest, m.blending]).toEqual([true, false, true, THREE.NormalBlending]);
    expect(decalDrawOf(m)).toEqual({ blend: 'blend', sortOrder: 0 });
    expect(stain.castShadow).toBe(false);
    expect(stain.renderOrder).toBe(decalRenderOrderFor(0));
    expect(stain.renderOrder).toBeLessThan(0);
    // A higher sort order draws later; every order stays below the other transparent surfaces' 0.
    expect(meshes['crack']!.renderOrder).toBe(stain.renderOrder + 5);
    expect(decalRenderOrderFor(DECAL_LIMITS.sortOrderMax)).toBeLessThan(MERGED_RENDER_ORDER);
    expect(decalRenderOrderFor(DECAL_LIMITS.sortOrderMin)).toBeLessThan(decalRenderOrderFor(DECAL_LIMITS.sortOrderMax));
    // Multiply: the unlit stain times the surface (the alpha kept); add: the lit colour added.
    const soot = meshes['soot']!.material as THREE.Material;
    expect(soot.type).toBe('MeshBasicNodeMaterial');
    expect([soot.blending, soot.blendSrc, soot.blendDst, soot.blendSrcAlpha, soot.blendDstAlpha]).toEqual([THREE.CustomBlending, THREE.ZeroFactor, THREE.SrcColorFactor, THREE.ZeroFactor, THREE.OneFactor]);
    expect((meshes['glow']!.material as THREE.Material).blending).toBe(THREE.AdditiveBlending);
  });

  it('takes the fixed depth offset only with a standard depth buffer', async () => {
    const { meshes } = await decalScene(DECALS.slice(0, 1));
    const m = meshes['stain']!.material as THREE.Material;
    expect([m.polygonOffset, m.polygonOffsetFactor, m.polygonOffsetUnits]).toEqual([true, DECAL_POLYGON_OFFSET.factor, DECAL_POLYGON_OFFSET.units]);
    setDecalDepthMode('logarithmic');
    expect(m.polygonOffset).toBe(false);
    setDecalDepthMode('reversed');
    expect(m.polygonOffset).toBe(false);
    setDecalDepthMode('standard');
    expect(m.polygonOffset).toBe(true);
  });

  it('is pushed toward the camera in the vertex stage and reads its page layers; decals of one blend share one program whatever their page', async () => {
    const { scene, meshes } = await decalScene(DECALS);
    const renderer = wgslRenderer();
    const stain = wgslOf(renderer, scene, meshes['stain']!);
    // The page arrays read at the material's layer (a uniform), with the footprint-capped gradients: four arguments
    // after the sampler (coordinates, layer, two gradients).
    expect(stain).toContain('texture_2d_array');
    const reads = stain.match(/textureSampleGrad\(.*\);/g) ?? [];
    expect(reads.length).toBe(3);
    for (const r of reads) expect(r).toMatch(/textureSampleGrad\( \w+, \w+_sampler, \w+, [^,]*nodeUniform\d+[^,]*, /);
    // The push in the vertex stage: toward the camera position, back in the object's space, before the view position.
    expect(stain).toMatch(/positionLocal = \( positionLocal \+ \( object\.nodeUniform\d+ \* vec4<f32>\(.*render\.cameraPosition|cameraPosition[\s\S]*positionLocal = \( positionLocal \+/);
    // Another page and layer, another sort order and tint: the same program.
    expect(digestOf(wgslOf(renderer, scene, meshes['crack']!))).toBe(digestOf(stain));
    expect(wgslOf(renderer, scene, meshes['soot']!)).not.toBe(stain);
  });

  it('a set of one page arrives as a 2D texture and is drawn as an array of one layer (no copy)', () => {
    const mip = { data: new Uint8Array(16), width: 4, height: 4 };
    const flat = new THREE.CompressedTexture([mip] as unknown as ImageData[], 4, 4, THREE.RGBA_BPTC_Format);
    flat.colorSpace = THREE.SRGBColorSpace;
    const a = decalPageArray(flat) as THREE.CompressedArrayTexture;
    expect(a.isCompressedArrayTexture).toBe(true);
    expect([a.image.depth, a.mipmaps![0]]).toEqual([1, mip]);
    expect(a.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(decalPageArray(flat)).toBe(a);
    expect(decalPageArray(a)).toBe(a);
    const disposed: string[] = [];
    a.addEventListener('dispose', () => disposed.push('array'));
    flat.dispose();
    expect(disposed).toEqual(['array']);
  });

  it('without pages it reads its own textures or its sheet cell (the Scene view), inside the cell and its gutter', async () => {
    // One row up top; the cell below it in its own band, with the sheet's 8 px gutter round it.
    const sheet = { ...TRIM, rows: [{ slot: 'a', top: 8, bottom: 56 }], cells: [{ name: 'crack', rect: [16, 128, 64, 64] as [number, number, number, number] }] };
    const defs: MaterialDefLike[] = [
      { materialId: 'trim', name: 'trim', shader: 'trim', params: {}, textures: { map: 'tex', normalMap: 'tex', ormMap: 'tex' }, trim: sheet },
      { materialId: 'cell', name: 'cell', shader: 'decal', params: {}, textures: {}, decal: { sheet: 'trim', cell: 'crack' } },
      { materialId: 'own', name: 'own', shader: 'decal', params: {}, textures: { map: 'tex', emissiveMap: 'tex' } },
    ];
    const { scene, meshes } = await decalScene(defs);
    const renderer = wgslRenderer();
    const cell = wgslOf(renderer, scene, meshes['cell']!);
    expect(cell).not.toContain('texture_2d_array');
    expect(cell).toContain('textureSampleGrad');
    expect(decalDrawOf(meshes['own']!.material as THREE.Material)).toEqual({ blend: 'blend', sortOrder: 0 });
    // The cell's rectangle on the sheet, inset half a texel, and the mip level its gutter allows.
    expect(decalSheetCellSampling(sheet, 'crack')).toEqual({ rect: [16.5 / 256, 128.5 / 256, 79.5 / 256, 191.5 / 256], mip: 3 });
  });
});

describe('decal meshes in batches and static cells', () => {
  const decal = (): THREE.Material => {
    const m = new THREE.MeshStandardMaterial();
    installDecalDraw(m, { blend: 'blend', sortOrder: 3 });
    return m;
  };
  const staticMesh = (material: THREE.Material, x: number): THREE.Mesh => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1 + x * 0.01), material);
    m.position.set(x, 0, 0);
    m.userData[BATCH_KEY] = true;
    m.userData[STATIC_KEY] = 'scene-a';
    m.renderOrder = decalRenderOrder(material) ?? 0;
    m.updateMatrixWorld(true);
    return m;
  };

  it('the batcher takes a decal (transparent, in its decal order) and still refuses other transparent meshes', () => {
    const glass = new THREE.MeshStandardMaterial({ transparent: true });
    const d = decal();
    const a = staticMesh(d, 0);
    expect(batchRefusal(a)).toBeNull();
    expect(batchRefusal(staticMesh(glass, 1))).toBe('transparent');
    // A decal in another order than its material's is drawn alone.
    const off = staticMesh(d, 2);
    off.renderOrder = 7;
    expect(batchRefusal(off)).toBe('render order');
  });

  it('merges a cell\'s static decals of one material into one draw in their decal order; another sort order is another draw', () => {
    const d = decal();
    const later = new THREE.MeshStandardMaterial();
    installDecalDraw(later, { blend: 'blend', sortOrder: 4 });
    const meshes = [staticMesh(d, 0), staticMesh(d, 1), staticMesh(d, 2), staticMesh(later, 3), staticMesh(later, 4)];
    const scene = new THREE.Scene();
    for (const m of meshes) scene.add(m);
    const b = createAutoBatcher(scene, {});
    for (const m of meshes) b.listed(m);
    b.update(new THREE.PerspectiveCamera(50, 1, 0.1, 1000));
    const cells = scene.children.filter((o): o is THREE.Mesh => (o as THREE.Mesh).isMesh === true && o.name.startsWith('tl-merged:'));
    expect(cells.map((c) => [c.material === d ? 'd' : 'later', c.renderOrder, c.castShadow]).sort()).toEqual([['d', decalRenderOrderFor(3), false], ['later', decalRenderOrderFor(4), false]]);
    expect(meshes.every((m) => m.layers.mask !== 1)).toBe(true);
  });
});

describe('a model file\'s *_decal material', () => {
  it('draws as a decal with the file\'s own textures; its meshes cast no shadow (the entity\'s flag kept to restore)', () => {
    const file = new THREE.MeshStandardMaterial({ name: 'Puddle_DECAL' });
    const plain = new THREE.MeshStandardMaterial({ name: 'wall' });
    const root = new THREE.Group();
    const mark = new THREE.Mesh(new THREE.PlaneGeometry(), file);
    mark.castShadow = true;
    const wall = new THREE.Mesh(new THREE.BoxGeometry(), plain);
    root.add(mark, wall);
    markFileDecals(root);
    expect([file.transparent, file.depthWrite, decalDrawOf(file)]).toEqual([true, false, { blend: 'blend', sortOrder: 0 }]);
    expect((file as unknown as { positionNode: unknown }).positionNode).not.toBeNull();
    expect([mark.castShadow, mark.userData[MATERIAL_NO_SHADOW_KEY], mark.renderOrder]).toEqual([false, true, decalRenderOrderFor(0)]);
    expect([plain.transparent, decalDrawOf(plain), wall.renderOrder]).toEqual([false, null, 0]);
  });
});
