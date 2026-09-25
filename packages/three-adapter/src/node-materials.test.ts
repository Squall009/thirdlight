/**
 * Phase 17.2: the node-material side of the project shading (no GPU: node
 * construction and the per-mesh rules; the pixels are checked by the
 * shader-parity e2e on WebGL 2 and WebGPU).
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { applyLightmap, lightmappedMaterial, refreshLightmappedMaterial } from './lightmaps';
import { createMaterialLibrary, type MaterialDefLike } from './material-library';
import { cloneMaterial, isNodeMaterial, setEmissiveLook, setSelectionHighlight, SELECTION_HIGHLIGHT_EMISSIVE, toNodeMaterial, withoutAmbientLight } from './node-materials';

type NodeProps = { positionNode: unknown; emissiveNode: unknown; normalNode: unknown; colorNode: unknown; contextNode: unknown; aoNode: unknown };
const props = (m: THREE.Material): NodeProps => m as unknown as NodeProps;
const def = (materialId: string, shader: MaterialDefLike['shader'], params: MaterialDefLike['params'] = {}, textures: MaterialDefLike['textures'] = {}): MaterialDefLike => ({ materialId, name: materialId, shader, params, textures });
const settle = async (): Promise<void> => {
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
};
function mesh(material: THREE.Material = new THREE.MeshStandardMaterial({ name: 'file', color: 0x336699 })): THREE.Mesh {
  return new THREE.Mesh(new THREE.BoxGeometry(), material);
}

describe('material library: node materials', () => {
  it('builds node materials for every shader type, keeping the file material values', () => {
    const lib = createMaterialLibrary({ loadTexture: async () => null, nodeMaterials: true });
    lib.setMaterials([def('std', 'standard', { roughness: 0.2 }), def('fol', 'foliage'), def('kit', 'kit'), def('flat', 'unlit', { color: '#ff0000' }), def('wat', 'water')]);
    const got: Record<string, THREE.Material> = {};
    for (const id of ['std', 'fol', 'kit', 'flat', 'wat']) {
      const m = mesh();
      lib.apply(m, { '*': id });
      got[id] = m.material as THREE.Material;
      expect(isNodeMaterial(got[id]), id).toBe(true);
    }
    expect(got['std']!.type).toBe('MeshStandardNodeMaterial');
    expect((got['std'] as THREE.MeshStandardMaterial).roughness).toBe(0.2);
    // The file's colour carries over (the definition sets none).
    expect((got['std'] as THREE.MeshStandardMaterial).color.getHex()).toBe(0x336699);
    expect(got['flat']!.type).toBe('MeshBasicNodeMaterial');
    // Foliage: vertex displacement + the translucency term; double-sided.
    expect(props(got['fol']!).positionNode).not.toBeNull();
    expect(props(got['fol']!).emissiveNode).not.toBeNull();
    expect(got['fol']!.side).toBe(THREE.DoubleSide);
    // Kit: the world-X UV context; water: the fresnel colour, transparent.
    expect(props(got['kit']!).contextNode).not.toBeNull();
    expect(props(got['wat']!).colorNode).not.toBeNull();
    expect(got['wat']!.transparent).toBe(true);
    expect(lib.animated()).toBe(true);
  });

  it('rebuilds the kit normal once its normal and macro maps arrive', async () => {
    const tex = new THREE.Texture();
    const lib = createMaterialLibrary({ loadTexture: async () => tex, nodeMaterials: true });
    lib.setMaterials([def('kit', 'kit', {}, { normalMap: 'n', macroNormalMap: 'm', ormMap: 'o' })]);
    const m = mesh();
    lib.apply(m, { '*': 'kit' });
    const mat = m.material as THREE.MeshStandardMaterial;
    expect(props(mat).normalNode).toBeNull();
    const version = mat.version;
    await settle();
    expect(mat.normalMap).not.toBeNull();
    expect(props(mat).normalNode).not.toBeNull();
    // AO keeps its own UVs (an explicit node once the ORM map is there).
    expect(props(mat).aoNode).not.toBeNull();
    expect(mat.version).toBeGreaterThan(version);
  });

  it('switches between node and WebGL materials, rebuilding what is applied', () => {
    const lib = createMaterialLibrary({ loadTexture: async () => null });
    lib.setMaterials([def('fol', 'foliage')]);
    const m = mesh();
    lib.apply(m, { '*': 'fol' });
    const legacy = m.material as THREE.Material;
    expect(isNodeMaterial(legacy)).toBe(false);
    lib.setNodeMaterials(true);
    expect(lib.nodeMaterials()).toBe(true);
    expect(isNodeMaterial(m.material)).toBe(true);
    lib.setNodeMaterials(false);
    expect(isNodeMaterial(m.material)).toBe(false);
    expect(m.material).not.toBe(legacy);
  });
});

describe('lightmaps on node materials', () => {
  it('converts a plain material to a node copy with the lightmap on UV1 and the range as intensity', () => {
    const plain = new THREE.MeshLambertMaterial({ color: 0x808080 });
    const map = new THREE.Texture();
    const c = lightmappedMaterial(plain, map, 1.6, false, true) as THREE.MeshLambertMaterial;
    expect(c.type).toBe('MeshLambertNodeMaterial');
    expect(c.lightMap).toBe(map);
    expect(c.lightMapIntensity).toBe(1.6);
    expect(c.color.getHex()).toBe(0x808080);
    // The legacy path is unchanged: a plain clone.
    expect(isNodeMaterial(lightmappedMaterial(plain, map, 1, false, false))).toBe(false);
  });

  it('the no-ambient copy leaves ambient and hemisphere lights out of its lighting and says so in its cache key', () => {
    const c = toNodeMaterial(new THREE.MeshStandardMaterial()) as THREE.Material & { setupLighting(b: unknown): unknown };
    const plainKey = c.customProgramCacheKey();
    let seen: THREE.Light[] = [];
    expect(typeof c.setupLighting).toBe('function');
    // Stand in for three's lighting build: it reads builder.lightsNode; the stub records what it got.
    c.setupLighting = function (this: unknown, b: { lightsNode: { getLights(): THREE.Light[] } }) {
      seen = b.lightsNode.getLights();
      return null;
    } as never;
    withoutAmbientLight(c);
    const lights = [new THREE.AmbientLight(), new THREE.HemisphereLight(), new THREE.DirectionalLight()];
    const all = { getLights: () => lights };
    const builder = { lightsNode: all, renderer: { lighting: { createNode: (l: THREE.Light[]) => ({ getLights: () => l }) } } };
    c.setupLighting(builder);
    expect(seen.map((l) => l.type)).toEqual(['DirectionalLight']);
    expect(builder.lightsNode).toBe(all); // restored after the build
    expect(c.customProgramCacheKey()).toBe(`${plainKey}|tl-lightmap-no-ambient`);
  });

  it('a lightmapped node copy follows its source and keeps its hooks', () => {
    const src = new THREE.MeshStandardMaterial({ color: 0x111111 });
    const copy = lightmappedMaterial(src, new THREE.Texture(), 2, true, true) as THREE.MeshStandardMaterial;
    const key = copy.customProgramCacheKey();
    src.color.setHex(0x22aa22);
    refreshLightmappedMaterial(copy, src);
    expect(copy.color.getHex()).toBe(0x22aa22);
    expect(copy.lightMapIntensity).toBe(2);
    expect(copy.customProgramCacheKey()).toBe(key);
    expect(cloneMaterial(copy).customProgramCacheKey()).toBe(key);
  });

  it('applyLightmap with nodeMaterials puts node copies on UV1 meshes and undoes', () => {
    const g = new THREE.BoxGeometry();
    g.setAttribute('uv1', g.getAttribute('uv').clone());
    const original = new THREE.MeshLambertMaterial();
    const m = new THREE.Mesh(g, original);
    const undo = applyLightmap(m, new THREE.Texture(), [1, 1, 0, 0], 1.2, { ignoreAmbient: true, nodeMaterials: true });
    expect(isNodeMaterial(m.material)).toBe(true);
    undo();
    expect(m.material).toBe(original);
  });
});

describe('per-mesh looks', () => {
  it('the checkpoint glow gives a mesh wearing a shared project material its own copy', () => {
    const lib = createMaterialLibrary({ loadTexture: async () => null, nodeMaterials: true });
    lib.setMaterials([def('pad', 'standard')]);
    const file = new THREE.MeshStandardMaterial({ name: 'file' });
    const a = mesh(file);
    const b = mesh(file);
    lib.apply(a, { '*': 'pad' });
    lib.apply(b, { '*': 'pad' });
    const shared = a.material as THREE.MeshStandardMaterial;
    expect(b.material).toBe(shared);
    setEmissiveLook(a, { emissive: '#ff8800', emissiveIntensity: 2 });
    const own = a.material as THREE.MeshStandardMaterial;
    expect(own).not.toBe(shared);
    expect(isNodeMaterial(own)).toBe(true);
    expect(own.emissive.getHexString()).toBe('ff8800');
    expect(shared.emissive.getHex()).toBe(0);
    setEmissiveLook(a, null);
    expect(own.emissive.getHex()).toBe(0);
    expect(own.emissiveIntensity).toBe(1);
  });

  it('the selection tint sets and clears the emissive of an own material', () => {
    const m = new THREE.MeshLambertMaterial();
    setSelectionHighlight(m, true);
    expect(m.emissive.getHex()).toBe(SELECTION_HIGHLIGHT_EMISSIVE);
    setSelectionHighlight(m, false);
    expect(m.emissive.getHex()).toBe(0);
  });
});
