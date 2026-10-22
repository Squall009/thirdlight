/**
 * GLB inspection steps 6–8: buffers, bufferViews (meshopt-compressed views are decoded here,
 * within the decoded-geometry cap) and accessors.
 *
 * One step per function over the shared `GlbState`; `inspect.ts` runs them in the
 * profile order and stops at the first that reports.
 */

import { decodeMeshopt, MeshoptError, type MeshoptFilter, type MeshoptMode } from '@thirdlight/project-model/meshopt';
import { COMPONENT_SIZES, TYPE_COMPONENTS } from './gltf-rules';
import { M2_GLTF_DECODED_GEOMETRY_BYTES } from './limits';
import type { ImportDiagnostic } from './types';
import { isPlainObject, asIndex, diag, ptr, type GlbState } from './inspect-glb-state';
import { checkExtensionObject } from './inspect-glb-container';

export function checkBuffers(glb: GlbState): ImportDiagnostic[] | null {
  const out: ImportDiagnostic[] = [];
  const buffers = glb.json['buffers'];
  if (!Array.isArray(buffers) || buffers.length < 1) {
    out.push(
      diag('asset_buffer_invalid', ptr('buffers'), 'the profile requires one embedded buffer (plus EXT_meshopt_compression fallbacks)', {
        found: Array.isArray(buffers) ? buffers.length : buffers === undefined ? 'absent' : typeof buffers,
        expected: 'one buffer without uri',
      }),
    );
    return out;
  }
  // Buffers after the first can only be EXT_meshopt_compression fallbacks:
  // no data (no uri) — the compressed bufferViews decode into them.
  for (let i = 1; i < buffers.length; i++) {
    const fb = buffers[i];
    const fpath = ptr('buffers', i);
    const fext = isPlainObject(fb) && isPlainObject(fb['extensions']) ? fb['extensions']['EXT_meshopt_compression'] : undefined;
    const length = isPlainObject(fb) ? fb['byteLength'] : undefined;
    if (!isPlainObject(fb) || fb['uri'] !== undefined || !isPlainObject(fext) || fext['fallback'] !== true) {
      out.push(
        diag('asset_buffer_invalid', fpath, 'a second buffer is only allowed as an EXT_meshopt_compression fallback without uri', {
          found: isPlainObject(fb) ? Object.keys(fb) : typeof fb,
          expected: '{ byteLength, extensions: { EXT_meshopt_compression: { fallback: true } } }',
        }),
      );
      continue;
    }
    checkExtensionObject(glb, fb, fpath, out, 'buffer');
    if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > M2_GLTF_DECODED_GEOMETRY_BYTES) {
      out.push(
        diag('asset_buffer_invalid', `${fpath}/byteLength`, 'a fallback buffer byteLength must be an integer within the decoded-geometry cap', {
          found: length,
          expected: `0 .. ${M2_GLTF_DECODED_GEOMETRY_BYTES}`,
        }),
      );
      continue;
    }
    glb.fallbackBuffers.set(i, length);
  }
  if (out.length > 0) return out;
  const buffer = buffers[0];
  if (!isPlainObject(buffer)) {
    out.push(
      diag('asset_buffer_invalid', ptr('buffers', 0), 'buffer must be an object', {
        found: typeof buffer,
        expected: 'an object',
      }),
    );
    return out;
  }
  if (buffer['uri'] !== undefined) {
    out.push(
      diag('asset_uri_rejected', ptr('buffers', 0, 'uri'), 'buffers must be embedded in the BIN chunk; URIs are never fetched', {
        found: buffer['uri'],
        expected: 'no uri member',
      }),
    );
    return out;
  }
  const byteLength = buffer['byteLength'];
  if (typeof byteLength !== 'number' || !Number.isSafeInteger(byteLength) || byteLength < 0) {
    out.push(
      diag('asset_buffer_invalid', ptr('buffers', 0, 'byteLength'), 'buffer byteLength must be a non-negative integer', {
        found: byteLength,
        expected: 'a non-negative integer',
      }),
    );
    return out;
  }
  if (byteLength > glb.bin.length) {
    out.push(
      diag('asset_buffer_invalid', ptr('buffers', 0, 'byteLength'), 'buffer byteLength exceeds the BIN chunk', {
        found: byteLength,
        expected: `<= ${glb.bin.length}`,
      }),
    );
    return out;
  }
  if (glb.bin.length - byteLength > 3) {
    out.push(
      diag('asset_buffer_invalid', ptr('buffers', 0, 'byteLength'), 'BIN chunk padding after the buffer must be at most 3 bytes', {
        found: glb.bin.length - byteLength,
        expected: 'BIN chunk length - buffer byteLength <= 3',
      }),
    );
    return out;
  }
  glb.bufferByteLength = byteLength;
  return null;
}

export function checkBufferViews(glb: GlbState): ImportDiagnostic[] | null {
  const out: ImportDiagnostic[] = [];
  const raw = glb.json['bufferViews'];
  if (raw !== undefined && !Array.isArray(raw)) {
    return [
      diag('asset_buffer_invalid', ptr('bufferViews'), 'bufferViews must be an array', {
        found: typeof raw,
        expected: 'an array',
      }),
    ];
  }
  const list = Array.isArray(raw) ? raw : [];
  const referencedByAccessor = accessorBufferViewReferences(glb.json, list.length);
  for (let i = 0; i < list.length; i++) {
    const bv = list[i];
    const path = ptr('bufferViews', i);
    if (!isPlainObject(bv)) {
      out.push(diag('asset_buffer_invalid', path, 'bufferView must be an object', { found: typeof bv, expected: 'an object' }));
      continue;
    }
    checkExtensionObject(glb, bv, path, out, 'bufferView');
    const meshopt = isPlainObject(bv['extensions']) ? bv['extensions']['EXT_meshopt_compression'] : undefined;
    const bufferIndex = bv['buffer'] ?? 0;
    const bufferLength = bufferIndex === 0 ? glb.bufferByteLength : typeof bufferIndex === 'number' ? glb.fallbackBuffers.get(bufferIndex) : undefined;
    if (bufferLength === undefined || (bufferIndex !== 0 && meshopt === undefined)) {
      out.push(
        diag('asset_buffer_invalid', `${path}/buffer`, 'a bufferView must reference buffer 0, or a fallback buffer when it is EXT_meshopt_compression-compressed', {
          found: bufferIndex,
          expected: '0 (or a fallback buffer with EXT_meshopt_compression)',
        }),
      );
      continue;
    }
    const byteOffset = bv['byteOffset'] ?? 0;
    if (typeof byteOffset !== 'number' || !Number.isSafeInteger(byteOffset) || byteOffset < 0) {
      out.push(
        diag('asset_buffer_invalid', `${path}/byteOffset`, 'bufferView byteOffset must be a non-negative integer', {
          found: byteOffset,
          expected: 'a non-negative integer',
        }),
      );
      continue;
    }
    const byteLength = bv['byteLength'];
    if (typeof byteLength !== 'number' || !Number.isSafeInteger(byteLength) || byteLength < 1) {
      out.push(
        diag('asset_buffer_invalid', `${path}/byteLength`, 'bufferView byteLength must be a positive integer', {
          found: byteLength,
          expected: 'a positive integer',
        }),
      );
      continue;
    }
    // glTF 2.0 alignment: a bufferView consumed by accessors must start at a
    // 4-byte boundary (stricter than a literal "byteOffset <= 3" reading of
    // the profile's bufferView step).
    if (referencedByAccessor.has(i) && byteOffset % 4 !== 0) {
      out.push(
        diag('asset_buffer_invalid', `${path}/byteOffset`, 'an accessor-backed bufferView must be 4-byte aligned', {
          found: byteOffset,
          expected: 'byteOffset % 4 === 0',
        }),
      );
      continue;
    }
    if (byteOffset + byteLength > bufferLength) {
      out.push(
        diag('asset_buffer_invalid', `${path}/byteLength`, 'bufferView range overruns its buffer', {
          found: { byteOffset, byteLength, bufferByteLength: bufferLength },
          expected: 'byteOffset + byteLength <= buffer byteLength',
        }),
      );
      continue;
    }
    const target = bv['target'];
    if (target !== undefined && target !== 34962 && target !== 34963) {
      out.push(
        diag('asset_buffer_invalid', `${path}/target`, 'bufferView target must be ARRAY_BUFFER or ELEMENT_ARRAY_BUFFER', {
          found: target,
          expected: '34962 or 34963',
        }),
      );
      continue;
    }
    let data: Uint8Array;
    if (meshopt !== undefined) {
      const decoded = decodeMeshoptView(glb, meshopt, byteLength, path, out);
      if (decoded === null) continue;
      data = decoded;
    } else {
      data = glb.bin.subarray(byteOffset, byteOffset + byteLength);
    }
    glb.bufferViews.push({ byteOffset, byteLength, buffer: bufferIndex as number, compressed: meshopt !== undefined, data });
  }
  return out.length > 0 ? out : null;
}



/**
 * Decode one EXT_meshopt_compression bufferView (its compressed stream is kept
 * in the BIN chunk) into exactly `byteLength` bytes, or report why not.
 */
function decodeMeshoptView(glb: GlbState, ext: unknown, byteLength: number, path: string, out: ImportDiagnostic[]): Uint8Array | null {
  const epath = `${path}/extensions/EXT_meshopt_compression`;
  const bad = (message: string, found: unknown, expected: string): null => {
    out.push(diag('asset_buffer_invalid', epath, message, { found, expected }));
    return null;
  };
  if (!isPlainObject(ext)) return bad('EXT_meshopt_compression must be an object', typeof ext, 'an object');
  const { buffer, byteOffset = 0, byteLength: srcLength, byteStride, count, mode, filter = 'NONE' } = ext as Record<string, unknown>;
  if (buffer !== 0) return bad('the compressed stream must be in buffer 0 (the BIN chunk)', buffer, '0');
  if (typeof byteOffset !== 'number' || !Number.isSafeInteger(byteOffset) || byteOffset < 0) return bad('byteOffset must be a non-negative integer', byteOffset, '>= 0');
  if (typeof srcLength !== 'number' || !Number.isSafeInteger(srcLength) || srcLength < 1 || byteOffset + srcLength > glb.bufferByteLength) {
    return bad('the compressed range must lie inside the BIN chunk', { byteOffset, byteLength: srcLength }, `byteOffset + byteLength <= ${glb.bufferByteLength}`);
  }
  if (mode !== 'ATTRIBUTES' && mode !== 'TRIANGLES' && mode !== 'INDICES') return bad('mode must be ATTRIBUTES, TRIANGLES or INDICES', mode, 'ATTRIBUTES | TRIANGLES | INDICES');
  if (filter !== 'NONE' && filter !== 'OCTAHEDRAL' && filter !== 'QUATERNION' && filter !== 'EXPONENTIAL') {
    return bad('filter must be NONE, OCTAHEDRAL, QUATERNION or EXPONENTIAL', filter, 'NONE | OCTAHEDRAL | QUATERNION | EXPONENTIAL');
  }
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1) return bad('count must be a positive integer', count, '>= 1');
  if (typeof byteStride !== 'number' || !Number.isSafeInteger(byteStride) || byteStride < 1 || byteStride > 256) return bad('byteStride must be 1..256', byteStride, '1 .. 256');
  if (count * byteStride !== byteLength) return bad('count * byteStride must equal the bufferView byteLength', { count, byteStride, byteLength }, `${byteLength}`);
  glb.meshoptDecodedBytes += byteLength;
  if (glb.meshoptDecodedBytes > M2_GLTF_DECODED_GEOMETRY_BYTES) {
    out.push(
      diag('asset_limits_exceeded', epath, 'the meshopt-compressed data decodes past the decoded-geometry cap', {
        found: glb.meshoptDecodedBytes,
        expected: `<= ${M2_GLTF_DECODED_GEOMETRY_BYTES}`,
        limit: 'decoded_bytes',
      }),
    );
    return null;
  }
  try {
    return decodeMeshopt(glb.bin.subarray(byteOffset, byteOffset + srcLength), count, byteStride, mode as MeshoptMode, filter as MeshoptFilter);
  } catch (e) {
    if (!(e instanceof MeshoptError)) throw e;
    return bad(`the meshopt-compressed stream does not decode: ${e.message}`, mode, 'a valid EXT_meshopt_compression stream');
  }
}

/** Accessors a KHR_draco_mesh_compression primitive decodes into (they carry no bufferView). */
function dracoAccessors(glb: GlbState): Set<number> {
  const out = new Set<number>();
  for (const mesh of glb.collection('meshes')) {
    if (!isPlainObject(mesh) || !Array.isArray(mesh['primitives'])) continue;
    for (const p of mesh['primitives']) {
      if (!isPlainObject(p) || !isPlainObject(p['extensions']) || !isPlainObject(p['extensions']['KHR_draco_mesh_compression'])) continue;
      if (isPlainObject(p['attributes'])) for (const v of Object.values(p['attributes'])) if (asIndex(v) !== null) out.add(v as number);
      if (asIndex(p['indices']) !== null) out.add(p['indices'] as number);
    }
  }
  return out;
}

export function checkAccessors(glb: GlbState): ImportDiagnostic[] | null {
  const out: ImportDiagnostic[] = [];
  const draco = dracoAccessors(glb);
  const raw = glb.json['accessors'];
  if (raw !== undefined && !Array.isArray(raw)) {
    return [
      diag('asset_accessor_invalid', ptr('accessors'), 'accessors must be an array', {
        found: typeof raw,
        expected: 'an array',
      }),
    ];
  }
  const list = Array.isArray(raw) ? raw : [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    const path = ptr('accessors', i);
    if (!isPlainObject(a)) {
      out.push(diag('asset_accessor_invalid', path, 'accessor must be an object', { found: typeof a, expected: 'an object' }));
      continue;
    }
    if (a['sparse'] !== undefined) {
      out.push(
        diag('asset_accessor_unsupported', `${path}/sparse`, 'sparse accessors are not in the M2 profile', {
          found: 'sparse',
          expected: 'a fully embedded accessor',
        }),
      );
      continue;
    }
    checkExtensionObject(glb, a, path, out, 'accessor');
    const componentType = a['componentType'];
    const componentSize =
      typeof componentType === 'number' ? COMPONENT_SIZES[componentType] : undefined;
    if (typeof componentType !== 'number' || componentSize === undefined) {
      out.push(
        diag('asset_accessor_invalid', `${path}/componentType`, 'accessor componentType is not a glTF 2.0 component type', {
          found: componentType,
          expected: '5120, 5121, 5122, 5123, 5125 or 5126',
        }),
      );
      continue;
    }
    const type = a['type'];
    const components = typeof type === 'string' ? TYPE_COMPONENTS[type] : undefined;
    if (components === undefined) {
      out.push(
        diag('asset_accessor_invalid', `${path}/type`, 'accessor type is not a glTF 2.0 accessor type', {
          found: type,
          expected: 'SCALAR, VEC2, VEC3, VEC4, MAT2, MAT3 or MAT4',
        }),
      );
      continue;
    }
    const count = a['count'];
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1) {
      out.push(
        diag('asset_accessor_invalid', `${path}/count`, 'accessor count must be a positive integer', {
          found: count,
          expected: 'count >= 1',
        }),
      );
      continue;
    }
    const bufferViewIndex = a['bufferView'];
    if (bufferViewIndex === undefined && draco.has(i)) {
      // Filled by the Draco decoder at load; its size is the declared count.
      glb.accessors.push({ count, type: typeof type === 'string' ? type : 'SCALAR', componentType, byteLength: count * components * componentSize });
      continue;
    }
    const bv = typeof bufferViewIndex === 'number' ? glb.bufferViews[bufferViewIndex] : undefined;
    if (bv === undefined) {
      out.push(
        diag('asset_accessor_invalid', `${path}/bufferView`, 'accessor must reference an existing embedded bufferView', {
          found: bufferViewIndex,
          expected: `0 .. ${glb.bufferViews.length - 1}`,
        }),
      );
      continue;
    }
    const byteOffset = a['byteOffset'] ?? 0;
    if (typeof byteOffset !== 'number' || !Number.isSafeInteger(byteOffset) || byteOffset < 0) {
      out.push(
        diag('asset_accessor_invalid', `${path}/byteOffset`, 'accessor byteOffset must be a non-negative integer', {
          found: byteOffset,
          expected: 'a non-negative integer',
        }),
      );
      continue;
    }
    if (byteOffset % componentSize !== 0) {
      out.push(
        diag('asset_accessor_invalid', `${path}/byteOffset`, 'accessor byteOffset must be aligned to its component size', {
          found: byteOffset,
          expected: `byteOffset % ${componentSize} === 0`,
        }),
      );
      continue;
    }
    const elementBytes = components * componentSize;
    const accessorBytes = count * elementBytes;
    if (!Number.isSafeInteger(accessorBytes) || byteOffset + accessorBytes > bv.byteLength) {
      out.push(
        diag('asset_accessor_invalid', path, 'accessor byte range overruns its bufferView', {
          found: { count, elementBytes, byteOffset, bufferViewByteLength: bv.byteLength },
          expected: 'byteOffset + count * elementBytes <= bufferView byteLength',
        }),
      );
      continue;
    }
    glb.accessors.push({
      count,
      type: typeof type === 'string' ? type : 'SCALAR',
      componentType,
      byteLength: accessorBytes,
    });
  }
  return out.length > 0 ? out : null;
}

/** BufferView indices referenced by any accessor (for the alignment rule). */
function accessorBufferViewReferences(
  json: Record<string, unknown>,
  bufferViewCount: number,
): Set<number> {
  const out = new Set<number>();
  const accessors = json['accessors'];
  if (!Array.isArray(accessors)) return out;
  for (const accessor of accessors) {
    if (!isPlainObject(accessor)) continue;
    const index = asIndex(accessor['bufferView']);
    if (index !== null && index < bufferViewCount) out.add(index);
  }
  return out;
}
