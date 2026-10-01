import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { objectResidentBytes } from './resource-bytes';

describe('objectResidentBytes', () => {
  it('counts geometry once and each image once, and says which bytes are textures', () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
    geometry.setIndex(new THREE.BufferAttribute(new Uint16Array(3), 1));
    const geometryBytes = 9 * 4 + 3 * 2;
    // An RGBA image with mips: 4/3 of its pixels' bytes.
    const albedo = new THREE.Texture({ width: 64, height: 64 } as unknown as HTMLImageElement);
    albedo.generateMipmaps = true;
    // A copy for another sampler or UV transform shares the image: counted once.
    const copy = albedo.clone();
    // A compressed texture (KTX2): its mip data as stored.
    const ktx2 = new THREE.CompressedTexture([{ data: new Uint8Array(2048), width: 64, height: 64 }, { data: new Uint8Array(512), width: 32, height: 32 }] as never, 64, 64);
    const root = new THREE.Group();
    root.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ map: albedo, roughnessMap: ktx2 })));
    root.add(new THREE.Mesh(geometry, [new THREE.MeshStandardMaterial({ map: copy }), new THREE.MeshBasicMaterial()]));
    const textureBytes = Math.round((64 * 64 * 4 * 4) / 3) + 2048 + 512;
    expect(objectResidentBytes(root)).toEqual({ bytes: geometryBytes + textureBytes, textures: { count: 2, bytes: textureBytes } });
  });

  it('a model without textures carries none', () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
    expect(objectResidentBytes(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial()))).toEqual({ bytes: 36, textures: { count: 0, bytes: 0 } });
  });
});
