/**
 * Vertex paint on models: a placed model's painted meshes, an instance set's
 * painted copies (vertex-paint-draw.ts draws them).
 *
 * Paint is drawn only on the mesh it was painted on: the mesh's vertex count
 * and the hash of its positions must be what the paint records (a reimport
 * that changed the mesh leaves the paint undrawn; the editor reports it).
 * The hash is of POSITION as the file stores it — a normalized integer
 * position is scaled the way the backend's model reader scales it, not the
 * way three's attribute reads it — so the page and the backend hash the same
 * numbers.
 */
import * as THREE from 'three';
import { copySlot, decodeCopyTable, normalizedPositionScale, paintPositionsHash, VERTEX_PAINT_BYTES, type InstancePaint, type VertexPaintMesh } from '@thirdlight/project-model';

import type { InstanceSetPaint } from './instancing';
import { disposePaintedGeometry, paintedGeometry, paintStream, PAINT_MESH_KEY, type PaintStream } from './vertex-paint-draw';

/** A read blob's bytes (undefined: not read, or not readable). */
export type PaintBlobs = (digest: string) => Uint8Array | undefined;

const hashes = new WeakMap<THREE.BufferGeometry, string | null>();

/** A geometry's position hash as vertex paint records it (null: no positions in a shape paint can name). */
export function geometryPaintHash(g: THREE.BufferGeometry): string | null {
  const known = hashes.get(g);
  if (known !== undefined) return known;
  let out: string | null = null;
  const a = g.getAttribute('position') as THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined;
  if (a !== undefined && a.itemSize === 3) {
    const interleaved = (a as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute === true;
    const array = interleaved ? (a as THREE.InterleavedBufferAttribute).data.array : (a as THREE.BufferAttribute).array;
    const stride = interleaved ? (a as THREE.InterleavedBufferAttribute).data.stride : 3;
    const offset = interleaved ? (a as THREE.InterleavedBufferAttribute).offset : 0;
    const scale = a.normalized ? normalizedPositionScale(array) : 1;
    const values = new Float64Array(a.count * 3);
    for (let i = 0; i < a.count; i += 1) for (let k = 0; k < 3; k += 1) values[i * 3 + k] = array[i * stride + offset + k]! * scale;
    out = paintPositionsHash(values);
  }
  hashes.set(g, out);
  return out;
}

/** Whether paint recorded as `rec` was painted on `g` (its vertex count and position hash). */
export function paintFits(g: THREE.BufferGeometry, rec: Pick<VertexPaintMesh, 'vertices' | 'positions'>): boolean {
  const pos = g.getAttribute('position');
  return pos !== undefined && pos.count === rec.vertices && geometryPaintHash(g) === rec.positions;
}

/** The blobs a model's paint and an instance set's paint read. */
export function modelPaintDigests(records: readonly VertexPaintMesh[] | undefined): string[] {
  return (records ?? []).map((r) => r.paint);
}
export function instancePaintDigests(paint: InstancePaint | undefined): string[] {
  return paint === undefined ? [] : [paint.copies, ...paint.meshes.map((m) => m.paint)];
}

/**
 * Draw a model instance's painted meshes with their paint (each a geometry
 * sharing the model's, plus the paint); returns the undo (null: nothing
 * painted). Meshes the paint does not fit, or whose blob is not read, are
 * drawn as they are.
 */
export function applyModelPaint(root: THREE.Object3D, records: readonly VertexPaintMesh[], blobs: PaintBlobs): (() => void) | null {
  if (records.length === 0) return null;
  const byMesh = new Map(records.map((r) => [r.mesh, r]));
  const swapped: { mesh: THREE.Mesh; base: THREE.BufferGeometry; painted: THREE.BufferGeometry }[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    const key = mesh.userData[PAINT_MESH_KEY] as string | undefined;
    if (mesh.isMesh !== true || key === undefined) return;
    const rec = byMesh.get(key);
    const bytes = rec === undefined ? undefined : blobs(rec.paint);
    if (rec === undefined || bytes === undefined || bytes.length !== rec.vertices * VERTEX_PAINT_BYTES || !paintFits(mesh.geometry, rec)) return;
    const base = mesh.geometry;
    const painted = paintedGeometry(base, bytes);
    mesh.geometry = painted;
    swapped.push({ mesh, base, painted });
  });
  if (swapped.length === 0) return null;
  return () => {
    for (const s of swapped) {
      if (s.mesh.geometry === s.painted) s.mesh.geometry = s.base;
      disposePaintedGeometry(s.painted);
    }
  };
}

/**
 * What an instance set's draws read of its paint: each copy's slot from the
 * copy table and, per mesh of the template the paint fits, the stream of its
 * pool. Null when nothing can be drawn (a blob not read, no mesh fits).
 */
export function instanceSetPaint(template: THREE.Object3D, paint: InstancePaint, blobs: PaintBlobs): { readonly paint: InstanceSetPaint; readonly bytes: number; dispose(): void } | null {
  const tableBytes = blobs(paint.copies);
  const table = tableBytes === undefined ? null : decodeCopyTable(tableBytes);
  if (table === null) return null;
  const byMesh = new Map(paint.meshes.map((r) => [r.mesh, r]));
  const streams = new Map<string, PaintStream>();
  template.traverse((o) => {
    const mesh = o as THREE.Mesh;
    const key = mesh.userData[PAINT_MESH_KEY] as string | undefined;
    if (mesh.isMesh !== true || key === undefined || streams.has(key)) return;
    const rec = byMesh.get(key);
    const bytes = rec === undefined ? undefined : blobs(rec.paint);
    if (rec === undefined || bytes === undefined || bytes.length !== paint.slots * rec.vertices * VERTEX_PAINT_BYTES || !paintFits(mesh.geometry, rec)) return;
    const stream = paintStream(bytes, rec.vertices, paint.slots);
    if (stream !== null) streams.set(key, stream);
  });
  if (streams.size === 0) return null;
  let bytes = 0;
  for (const s of streams.values()) bytes += s.bytes;
  return {
    paint: { slotOf: (copy) => copySlot(table, copy), stream: (mesh) => streams.get(mesh) },
    bytes,
    dispose: () => {
      for (const s of streams.values()) s.dispose();
      streams.clear();
    },
  };
}
