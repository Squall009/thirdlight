/**
 * Phase 17.3: a lightmapped copy made before its project material's texture
 * arrived follows the material once the texture lands (the scene adapter
 * wires the library's `onChange` to `LightmapSet.refresh`). Both renderer
 * classes: the WebGL materials and the node materials.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { addBoxLightmapUv, createLightmapSet } from './lightmaps';
import { createMaterialLibrary } from './material-library';

const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
};

describe('lightmap set: late project textures', () => {
  for (const nodeMaterials of [false, true]) {
    it(`a copy made before the texture arrived gets it on refresh (${nodeMaterials ? 'node' : 'WebGL'} materials)`, async () => {
      let arrive: (t: THREE.Texture) => void = () => undefined;
      const late = new Promise<THREE.Texture>((ok) => (arrive = ok));
      let lightmaps: ReturnType<typeof createLightmapSet> | null = null;
      const lib = createMaterialLibrary({ loadTexture: (id) => (id === 'albedo' ? late : Promise.resolve(null)), nodeMaterials, onChange: () => lightmaps?.refresh() });
      lib.setMaterials([{ materialId: 'm', name: 'm', shader: 'standard', params: {}, textures: { map: 'albedo' } }]);
      const geometry = new THREE.BoxGeometry();
      addBoxLightmapUv(geometry);
      const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
      lib.apply(mesh, { '*': 'm' });
      const project = mesh.material as THREE.MeshStandardMaterial;
      expect(project.map).toBeNull();

      lightmaps = createLightmapSet(
        { s: { range: 2, atlases: ['atlas'], entries: [{ entityId: 'e', atlas: 0, scaleOffset: [1, 1, 0, 0] }], bakedLights: [] } },
        async () => new THREE.Texture(),
        () => false,
        { nodeMaterials },
      );
      lightmaps.apply('e', mesh);
      await settle();
      const copy = mesh.material as THREE.MeshStandardMaterial;
      expect(copy).not.toBe(project);
      expect(copy.lightMap).not.toBeNull();
      expect(copy.map).toBeNull();

      // The project texture lands after the copy was made.
      arrive(new THREE.Texture());
      await settle();
      expect(project.map).not.toBeNull();
      expect(mesh.material).toBe(copy);
      expect(copy.map).not.toBeNull();
      expect(copy.map!.uuid).toBe(project.map!.uuid);
      // The lightmap stays.
      expect(copy.lightMap).not.toBeNull();
      expect(copy.lightMapIntensity).toBe(2);
      lightmaps.dispose();
      expect(mesh.material).toBe(project);
    });
  }
});
