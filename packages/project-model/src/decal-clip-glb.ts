/**
 * A clipped decal's mesh as a glTF binary: what "Bake to model" writes, so a
 * mark cut from its surfaces can be edited by hand in a modelling tool and
 * placed as a model.
 *
 * One node, one mesh, one primitive: positions, normals, the box's texture
 * coordinates (0–1 over the decal's image), tangents, the per-vertex fade
 * (the clipper's normal and edge fades) as the custom attribute
 * {@link DECAL_FADE_GLTF_ATTRIBUTE}, and the index. Its one material is
 * named after the decal material with `_decal` added, so the file draws as a
 * decal by itself and the asset's material map can name the project's decal
 * material for it. Positions are in the decal entity's space: placed where
 * the decal was, the model covers the same surfaces.
 *
 * Pure: no three.js, no I/O.
 */
import { glbBytes } from '@thirdlight/shared';
import type { DecalClipMesh } from './decal-clip';

/**
 * The glTF attribute a baked clipped decal keeps its per-vertex fade in (one
 * float a vertex, 0–1). three's loader lowercases custom attribute names
 * (`_decal_fade`), which is what the decal material reads.
 */
export const DECAL_FADE_GLTF_ATTRIBUTE = '_DECAL_FADE';

/** The glTF material name of a baked decal of decal material `materialId` (the `_decal` ending draws it as a decal). */
export function bakedDecalMaterialName(materialId: string): string {
  return `${materialId}_decal`;
}

const FLOAT = 5126;
const USHORT = 5123;
const UINT = 5125;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

/** The mesh as a GLB (`name` names its node and mesh; `materialId` its material: {@link bakedDecalMaterialName}). */
export function decalClipGlb(m: Pick<DecalClipMesh, 'positions' | 'normals' | 'uvs' | 'tangents' | 'fades' | 'index'>, opts: { name: string; materialId: string }): Uint8Array {
  const vc = m.positions.length / 3;
  const index = vc > 0xffff ? (m.index instanceof Uint32Array ? m.index : Uint32Array.from(m.index)) : m.index instanceof Uint16Array ? m.index : Uint16Array.from(m.index);
  const parts: { bytes: Uint8Array; target: number }[] = [];
  const views: Record<string, unknown>[] = [];
  const accessors: Record<string, unknown>[] = [];
  let offset = 0;
  const add = (a: Float32Array | Uint16Array | Uint32Array, target: number, accessor: Record<string, unknown>): number => {
    const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    views.push({ buffer: 0, byteOffset: offset, byteLength: bytes.byteLength, target });
    parts.push({ bytes, target });
    offset += bytes.byteLength + ((4 - (bytes.byteLength % 4)) % 4);
    accessors.push({ bufferView: views.length - 1, ...accessor });
    return accessors.length - 1;
  };
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vc; i++) {
    for (let k = 0; k < 3; k++) {
      const v = m.positions[i * 3 + k]!;
      if (v < min[k]!) min[k] = v;
      if (v > max[k]!) max[k] = v;
    }
  }
  const attributes: Record<string, number> = {
    POSITION: add(m.positions, ARRAY_BUFFER, { componentType: FLOAT, count: vc, type: 'VEC3', ...(vc > 0 ? { min, max } : {}) }),
    NORMAL: add(m.normals, ARRAY_BUFFER, { componentType: FLOAT, count: vc, type: 'VEC3' }),
    TEXCOORD_0: add(m.uvs, ARRAY_BUFFER, { componentType: FLOAT, count: vc, type: 'VEC2' }),
    TANGENT: add(m.tangents, ARRAY_BUFFER, { componentType: FLOAT, count: vc, type: 'VEC4' }),
    [DECAL_FADE_GLTF_ATTRIBUTE]: add(m.fades, ARRAY_BUFFER, { componentType: FLOAT, count: vc, type: 'SCALAR' }),
  };
  const indices = add(index, ELEMENT_ARRAY_BUFFER, { componentType: index instanceof Uint32Array ? UINT : USHORT, count: index.length, type: 'SCALAR' });
  const json = {
    asset: { version: '2.0', generator: 'Thirdlight decal bake' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: opts.name, mesh: 0 }],
    meshes: [{ name: opts.name, primitives: [{ attributes, indices, material: 0 }] }],
    materials: [{ name: bakedDecalMaterialName(opts.materialId), alphaMode: 'BLEND', pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1 } }],
    buffers: [{ byteLength: offset }],
    bufferViews: views,
    accessors,
  };
  const bin = new Uint8Array(offset);
  let at = 0;
  for (const p of parts) {
    bin.set(p.bytes, at);
    at += p.bytes.byteLength + ((4 - (p.bytes.byteLength % 4)) % 4);
  }
  return glbBytes(JSON.stringify(json), bin);
}
