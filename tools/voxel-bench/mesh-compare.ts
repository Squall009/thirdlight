/**
 * Comparing derived draws whose vertex order differs (a chunk joined from
 * its sections against the chunk's own derive): triangles and instances as
 * sorted lists of what they hold.
 */
import { INSTANCE_BYTES, SURFACE_VERTEX_BYTES, type InstanceList, type SurfaceBuffer } from '@thirdlight/voxel';

/** A surface's triangles as position and normal triples (each turned to start at its least vertex, winding kept), sorted. */
export function triangleList(buf: SurfaceBuffer): string[] {
  const view = new DataView(buf.vertices.buffer, buf.vertices.byteOffset, buf.vertices.byteLength);
  const vtx = (i: number): string => {
    const o = i * SURFACE_VERTEX_BYTES;
    return [view.getUint16(o, true), view.getUint16(o + 2, true), view.getUint16(o + 4, true), view.getInt8(o + 8), view.getInt8(o + 9), view.getInt8(o + 10)].join(',');
  };
  const out: string[] = [];
  for (let t = 0; t < buf.indices.length; t += 3) {
    const v = [vtx(buf.indices[t]!), vtx(buf.indices[t + 1]!), vtx(buf.indices[t + 2]!)];
    const k = v.indexOf([...v].sort()[0]!);
    out.push([v[k], v[(k + 1) % 3], v[(k + 2) % 3]].join('|'));
  }
  return out.sort();
}

/** Instance records (8 bytes each, hex), sorted. */
export function instanceList(list: InstanceList): string[] {
  const out: string[] = [];
  for (let k = 0; k < list.count; k++) out.push(Buffer.from(list.data.subarray(k * INSTANCE_BYTES, (k + 1) * INSTANCE_BYTES)).toString('hex'));
  return out.sort();
}
