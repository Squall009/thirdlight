import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';

import { ClusterGpu } from './cluster-gpu';
import { CLUSTER_TEXTURE_WIDTH, type ClusterTextures } from './cluster-pack';
import { copyTextureInto, freshTexture, uploadTextureRegion, type RegionTextureRenderer, type TexelBox } from './region-texture';
import { VoxelShaderGrids } from './voxel-surface';

/**
 * A renderer whose textures are CPU byte arrays: what three's two backends do with these calls (WebGPU's
 * `writeTexture` of packed rows into a box; WebGL 2's `texSubImage` of a staging image's data at a place; a box copy
 * between textures), so a test reads the texels a store's uploads and grows leave behind.
 */
function cpuRenderer(webgl: boolean, bytesPerTexel: number): RegionTextureRenderer & { texels(t: THREE.Texture): Uint8Array; writes: number; stagingKinds: string[] } {
  const store = new Map<THREE.Texture, Uint8Array>();
  const size = (t: THREE.Texture): [number, number, number] => {
    const im = t.image as { width: number; height: number; depth?: number };
    return [im.width, im.height, im.depth ?? 1];
  };
  const of = (t: THREE.Texture): Uint8Array => {
    let a = store.get(t);
    if (a === undefined) {
      const [w, h, d] = size(t);
      store.set(t, (a = new Uint8Array(w * h * d * bytesPerTexel)));
    }
    return a;
  };
  const writeBox = (dst: THREE.Texture, src: Uint8Array, box: TexelBox): void => {
    const [w, h] = size(dst);
    const d = of(dst);
    const row = box.width * bytesPerTexel;
    for (let z = 0; z < box.depth; z++) for (let y = 0; y < box.height; y++) {
      const from = (z * box.height + y) * row;
      d.set(src.subarray(from, from + row), (((box.z + z) * h + box.y + y) * w + box.x) * bytesPerTexel);
    }
  };
  const gpuOf = new Map<object, THREE.Texture>();
  const r = {
    writes: 0,
    stagingKinds: [] as string[],
    texels: of,
    backend: {
      isWebGLBackend: webgl,
      device: webgl
        ? undefined
        : {
            queue: {
              writeTexture: (dst: { texture: object; origin: { x: number; y: number; z: number } }, data: ArrayBufferView, layout: { bytesPerRow: number; rowsPerImage: number }, s: { width: number; height: number; depthOrArrayLayers: number }) => {
                expect(layout.bytesPerRow).toBe(s.width * bytesPerTexel);
                expect(layout.rowsPerImage).toBe(s.height);
                r.writes++;
                writeBox(gpuOf.get(dst.texture)!, new Uint8Array(data.buffer, data.byteOffset, data.byteLength), { ...dst.origin, width: s.width, height: s.height, depth: s.depthOrArrayLayers });
              },
            },
          },
      get: (t: object) => {
        const handle = { tex: t };
        gpuOf.set(handle, t as THREE.Texture);
        return { texture: handle };
      },
      copyTextureToTexture: (src: THREE.Texture, dst: THREE.Texture, _region: null, at: THREE.Vector3) => {
        r.writes++;
        r.stagingKinds.push((src as { isData3DTexture?: boolean }).isData3DTexture === true ? '3d' : '2d');
        const im = src.image as { data: ArrayBufferView; width: number; height: number; depth?: number };
        writeBox(dst, new Uint8Array(im.data.buffer, im.data.byteOffset, im.data.byteLength), { x: at.x, y: at.y, z: at.z, width: im.width, height: im.height, depth: im.depth ?? 1 });
      },
    },
    initTexture: (t: THREE.Texture) => void of(t),
    copyTextureToTexture: (src: THREE.Texture, dst: THREE.Texture, box: THREE.Box3 | null, at: THREE.Vector3 | null) => {
      const [w, h] = size(src);
      const s = of(src);
      const b = box!;
      const o = at!;
      const [dw, dh] = size(dst);
      const d = of(dst);
      for (let z = b.min.z; z < b.max.z; z++) for (let y = b.min.y; y < b.max.y; y++) for (let x = b.min.x; x < b.max.x; x++) {
        for (let k = 0; k < bytesPerTexel; k++) d[(((o.z + z) * dh + o.y + y) * dw + o.x + x) * bytesPerTexel + k] = s[((z * h + y) * w + x) * bytesPerTexel + k]!;
      }
    },
  };
  return r as unknown as ReturnType<typeof cpuRenderer>;
}

const texel = (r: ReturnType<typeof cpuRenderer>, t: THREE.Texture, x: number, y: number, z: number, bpt: number): number[] => {
  const im = t.image as { width: number; height: number };
  const at = ((z * im.height + y) * im.width + x) * bpt;
  return Array.from(r.texels(t).subarray(at, at + bpt));
};

describe('region uploads and grows by copy', () => {
  for (const webgl of [false, true]) {
    it(`writes exactly the box's texels on ${webgl ? 'WebGL 2 (a staging image of the destination’s kind)' : 'WebGPU (packed rows)'}, 2D and 3D`, () => {
      const r = cpuRenderer(webgl, 2);
      const t3 = new THREE.Data3DTexture(null, 8, 6, 4);
      const box = { x: 2, y: 1, z: 1, width: 3, height: 2, depth: 2 };
      const data = new Uint8Array(3 * 2 * 2 * 2).map((_, i) => i + 1);
      expect(uploadTextureRegion(r, t3, data, box, 2)).toBe(24);
      for (let z = 0; z < 4; z++) for (let y = 0; y < 6; y++) for (let x = 0; x < 8; x++) {
        const inside = x >= 2 && x < 5 && y >= 1 && y < 3 && z >= 1 && z < 3;
        const i = (((z - 1) * 2 + (y - 1)) * 3 + (x - 2)) * 2;
        expect(texel(r, t3, x, y, z, 2)).toEqual(inside ? [i + 1, i + 2] : [0, 0]);
      }
      const t2 = new THREE.DataTexture(null, 4, 4);
      // A longer array (the cluster rows' whole buffer) is read from its start.
      uploadTextureRegion(r, t2, new Uint8Array(32).fill(7), { x: 0, y: 0, z: 0, width: 4, height: 2, depth: 1 }, 2);
      expect(texel(r, t2, 3, 1, 0, 2)).toEqual([7, 7]);
      expect(texel(r, t2, 0, 2, 0, 2)).toEqual([0, 0]);
      if (webgl) expect(r.stagingKinds).toEqual(['3d', '2d']);
    });
  }

  it('a grow copies the kept box to the same places and nothing past it; an empty box copies nothing', () => {
    const r = cpuRenderer(false, 1);
    const old = new THREE.Data3DTexture(null, 4, 4, 4);
    uploadTextureRegion(r, old, new Uint8Array(64).map((_, i) => i + 1), { x: 0, y: 0, z: 0, width: 4, height: 4, depth: 4 }, 1);
    const next = new THREE.Data3DTexture(null, 8, 4, 4);
    copyTextureInto(r, old, next, { width: 4, height: 4, depth: 4 });
    for (let z = 0; z < 4; z++) for (let y = 0; y < 4; y++) for (let x = 0; x < 8; x++) expect(texel(r, next, x, y, z, 1)).toEqual([x < 4 ? ((z * 4 + y) * 4 + x) + 1 : 0]);
    const writes = r.writes;
    copyTextureInto(r, old, new THREE.Data3DTexture(null, 2, 2, 2), { width: 0, height: 2, depth: 2 });
    expect(r.writes).toBe(writes);
  });

  it('fresh textures get versions no earlier one had', () => {
    const a = freshTexture(new THREE.DataTexture(null, 1, 1));
    const b = freshTexture(new THREE.DataTexture(null, 1, 1));
    expect(b.version).toBeGreaterThan(a.version);
    expect(a.version).toBeGreaterThan(1_000_000);
  });

  for (const webgl of [false, true]) {
    it(`the voxel grid store keeps every region's bytes through its grows and a trim (${webgl ? 'WebGL 2' : 'WebGPU'})`, () => {
      const side = 3;
      const r = cpuRenderer(webgl, 2);
      const grids = new VoxelShaderGrids({ side });
      const held: { at: THREE.Vector3; entries: Uint16Array }[] = [];
      // 4³ regions first, then growth by a quarter along the shortest axis: 200 regions grow it several times.
      for (let k = 0; k < 200; k++) {
        const at = grids.allocate(r);
        const entries = new Uint16Array(side ** 3).map((_, i) => (k * 131 + i) & 0xffff);
        grids.upload(r, at, entries);
        held.push({ at, entries });
      }
      expect(grids.grown).toBeGreaterThan(2);
      const check = (): void => {
        const t = grids.texture;
        for (const h of held) for (let z = 0; z < side; z++) for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
          const e = h.entries[(z * side + y) * side + x]!;
          expect(texel(r, t, h.at.x + x, h.at.y + y, h.at.z + z, 2)).toEqual([e & 0xff, e >> 8]);
        }
      };
      check();
      // Let go of everything added after the first size, then trim back to it: the first 64 keep their bytes.
      for (const h of held.splice(64)) grids.release(h.at);
      for (const h of held.splice(40)) grids.release(h.at);
      expect(grids.trim(r)).toBe(true);
      expect(grids.capacity).toBe(64);
      check();
      expect(grids.uploadedBytes).toBe(200 * side ** 3 * 2);
    });
  }

  it('the light clusters send only the rows written, through the same upload', () => {
    const r = cpuRenderer(false, 16);
    const rows = 4;
    const width = CLUSTER_TEXTURE_WIDTH;
    const data = new Uint32Array(width * rows * 4).map((_, i) => i);
    const lists = new ClusterGpu({ data: new Uint32Array(width * 4), rows: 1 } as unknown as ClusterTextures).lists;
    // The first upload makes the texture whole; the next sends one row's texels.
    lists.upload(r, data, rows, width * rows);
    const before = r.writes;
    data.fill(9, 0, 4);
    const sent = lists.upload(r, data, rows, 1);
    expect(sent).toEqual({ remade: false, bytes: width * 16 });
    expect(r.writes).toBe(before + 1);
    expect(texel(r, lists.texture, 0, 0, 0, 16).slice(0, 4)).toEqual([9, 0, 0, 0]);
  });
});
