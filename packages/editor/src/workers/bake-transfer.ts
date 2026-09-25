/**
 * Phase 22.1: the browser bake's input as a worker message.
 *
 * The Scene view hands the baker live `BufferGeometry` objects (shared by
 * every mesh that uses them) and world matrices. For a worker they become
 * plain typed arrays — each geometry once, meshes refer to it by index —
 * copied, so transferring them never detaches the Scene view's own arrays.
 * Only what the baker reads is sent (position, normal, uv1, the index and
 * the draw range), with each array's own type and `normalized` flag, so the
 * GPU sees the same values on both sides.
 */
import * as THREE from 'three';
import type { BakeLightInput, BakeMeshInput, BrowserBakeInput } from '@thirdlight/three-adapter';

type Typed = Float32Array | Uint32Array | Uint16Array | Uint8Array | Int16Array | Int8Array | Int32Array;

export interface PackedAttribute {
  array: Typed;
  itemSize: number;
  normalized: boolean;
}

export interface PackedGeometry {
  attributes: Record<string, PackedAttribute>;
  index: Uint32Array | Uint16Array | null;
  drawRange: [number, number];
}

export interface PackedMesh {
  geometry: number;
  matrixWorld: number[];
}

export interface PackedBakeInput {
  atlases: { width: number; height: number }[];
  targets: { entityId: string; atlas: number; scaleOffset: [number, number, number, number]; meshes: PackedMesh[] }[];
  occluders: PackedMesh[];
  lights: BakeLightInput[];
  geometries: PackedGeometry[];
  samples: number;
  range: number;
  padding: number;
  softness?: number;
  renderer?: BrowserBakeInput['renderer'];
}

/** The attributes the baker reads (the Lambert bake material: position, the normal, UV1). */
const BAKE_ATTRIBUTES = ['position', 'normal', 'uv1'] as const;

function packAttribute(attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): PackedAttribute {
  const n = attr.count * attr.itemSize;
  if ((attr as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute === true) {
    const ia = attr as THREE.InterleavedBufferAttribute;
    const src = ia.data.array as unknown as Typed;
    const out = new (src.constructor as new (n: number) => Typed)(n);
    for (let i = 0; i < ia.count; i++) for (let k = 0; k < ia.itemSize; k++) out[i * ia.itemSize + k] = src[i * ia.data.stride + ia.offset + k]!;
    return { array: out, itemSize: ia.itemSize, normalized: ia.normalized };
  }
  const ba = attr as THREE.BufferAttribute;
  const src = ba.array as unknown as Typed;
  return { array: src.slice(0, n) as Typed, itemSize: ba.itemSize, normalized: ba.normalized };
}

/** A structured-clone-able copy of a bake input and the buffers to transfer with it. */
export function packBakeInput(input: Omit<BrowserBakeInput, 'onProgress' | 'signal' | 'canvas'>): { input: PackedBakeInput; transfer: ArrayBuffer[] } {
  const ids = new Map<THREE.BufferGeometry, number>();
  const geometries: PackedGeometry[] = [];
  const transfer: ArrayBuffer[] = [];
  const geometry = (g: THREE.BufferGeometry): number => {
    const known = ids.get(g);
    if (known !== undefined) return known;
    const attributes: Record<string, PackedAttribute> = {};
    for (const name of BAKE_ATTRIBUTES) {
      const a = g.getAttribute(name);
      if (a === undefined) continue;
      const p = packAttribute(a);
      attributes[name] = p;
      transfer.push(p.array.buffer as ArrayBuffer);
    }
    const idx = g.getIndex();
    const index = idx !== null ? ((idx.array as Uint32Array | Uint16Array).slice(0, idx.count) as Uint32Array | Uint16Array) : null;
    if (index !== null) transfer.push(index.buffer as ArrayBuffer);
    const id = geometries.length;
    geometries.push({ attributes, index, drawRange: [g.drawRange.start, g.drawRange.count] });
    ids.set(g, id);
    return id;
  };
  const mesh = (m: BakeMeshInput): PackedMesh => ({ geometry: geometry(m.geometry), matrixWorld: Array.from(m.matrixWorld.elements) });
  const message: PackedBakeInput = {
    atlases: input.atlases.map((a) => ({ width: a.width, height: a.height })),
    targets: input.targets.map((t) => ({ entityId: t.entityId, atlas: t.atlas, scaleOffset: [...t.scaleOffset] as [number, number, number, number], meshes: t.meshes.map(mesh) })),
    occluders: input.occluders.map(mesh),
    lights: input.lights.map((l) => ({ ...l })),
    geometries,
    samples: input.samples,
    range: input.range,
    padding: input.padding,
    ...(input.softness !== undefined ? { softness: input.softness } : {}),
    ...(input.renderer !== undefined ? { renderer: input.renderer } : {}),
  };
  return { input: message, transfer };
}

/** The bake input again (worker side): one `BufferGeometry` per packed geometry, shared as before. */
export function unpackBakeInput(p: PackedBakeInput): Omit<BrowserBakeInput, 'onProgress' | 'signal' | 'canvas'> {
  const geometries = p.geometries.map((pg) => {
    const g = new THREE.BufferGeometry();
    for (const [name, a] of Object.entries(pg.attributes)) g.setAttribute(name, new THREE.BufferAttribute(a.array, a.itemSize, a.normalized));
    if (pg.index !== null) g.setIndex(new THREE.BufferAttribute(pg.index, 1));
    g.setDrawRange(pg.drawRange[0], pg.drawRange[1]);
    return g;
  });
  const mesh = (m: PackedMesh): BakeMeshInput => ({ geometry: geometries[m.geometry]!, matrixWorld: new THREE.Matrix4().fromArray(m.matrixWorld) });
  return {
    atlases: p.atlases,
    targets: p.targets.map((t) => ({ entityId: t.entityId, atlas: t.atlas, scaleOffset: t.scaleOffset, meshes: t.meshes.map(mesh) })),
    occluders: p.occluders.map(mesh),
    lights: p.lights,
    samples: p.samples,
    range: p.range,
    padding: p.padding,
    ...(p.softness !== undefined ? { softness: p.softness } : {}),
    ...(p.renderer !== undefined ? { renderer: p.renderer } : {}),
  };
}
