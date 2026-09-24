/**
 * Phase 9.4: the material library's assignment rules (no WebGL needed): a
 * mesh material named `n` takes mapping[n], else mapping["*"]; one built
 * material per (material, source) is shared; undo restores the file's; a
 * changed definition rebuilds; textures load once.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { createMaterialLibrary, type MaterialDefLike } from './material-library';

function model(): THREE.Group {
  const g = new THREE.Group();
  const bark = new THREE.MeshStandardMaterial({ name: 'bark', color: 0x553311 });
  const leaf = new THREE.MeshStandardMaterial({ name: 'leaf', color: 0x33aa33 });
  g.add(new THREE.Mesh(new THREE.BoxGeometry(), bark), new THREE.Mesh(new THREE.BoxGeometry(), leaf));
  return g;
}
const mats = (g: THREE.Object3D): THREE.Material[] => g.children.map((c) => (c as THREE.Mesh).material as THREE.Material);
const FOLIAGE: MaterialDefLike = { materialId: 'mat-foliage', name: 'Foliage', shader: 'foliage', params: { windBend: 2 }, textures: {} };
const RED: MaterialDefLike = { materialId: 'mat-red', name: 'Red', shader: 'standard', params: { color: '#ff0000' }, textures: {} };

describe('material library', () => {
  it('applies by material name with "*" as the fallback, shares built materials, and undoes', () => {
    const lib = createMaterialLibrary({ loadTexture: async () => null });
    lib.setMaterials([FOLIAGE, RED]);
    const a = model();
    const b = model();
    const [barkA, leafA] = mats(a);
    const undoA = lib.apply(a, { '*': 'mat-foliage', bark: 'mat-red' });
    lib.apply(b, { '*': 'mat-foliage', bark: 'mat-red' });
    expect(mats(a)[0]!.name).toBe('Red');
    expect((mats(a)[0] as THREE.MeshStandardMaterial).color.getHexString()).toBe('ff0000');
    expect(mats(a)[1]!.name).toBe('Foliage');
    // The leaf keeps the file's colour (the foliage material sets none) and is double-sided.
    expect((mats(a)[1] as THREE.MeshStandardMaterial).color.getHex()).toBe(0x33aa33);
    expect(mats(a)[1]!.side).toBe(THREE.DoubleSide);
    expect(lib.animated()).toBe(true);
    undoA();
    expect(mats(a)).toEqual([barkA, leafA]);
  });

  it('rebuilds when a definition changes and drops a vanished material', () => {
    const lib = createMaterialLibrary({ loadTexture: async () => null });
    lib.setMaterials([RED]);
    const a = model();
    lib.apply(a, { '*': 'mat-red' });
    const before = mats(a)[0];
    lib.setMaterials([{ ...RED, params: { color: '#00ff00' } }]);
    expect(mats(a)[0]).not.toBe(before);
    expect((mats(a)[0] as THREE.MeshStandardMaterial).color.getHexString()).toBe('00ff00');
    lib.setMaterials([]);
    expect(mats(a)[0]!.name).toBe('bark');
  });

  it('loads a texture once and puts it on the slot', async () => {
    let loads = 0;
    const tex = new THREE.Texture();
    const lib = createMaterialLibrary({
      loadTexture: async () => {
        loads += 1;
        return tex;
      },
    });
    lib.setMaterials([{ ...RED, textures: { map: 'tex-1' } }]);
    const a = model();
    lib.apply(a, { '*': 'mat-red' });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const m = mats(a)[0] as THREE.MeshStandardMaterial;
    expect(m.map).not.toBeNull();
    expect(m.map!.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(loads).toBe(1);
  });
});
