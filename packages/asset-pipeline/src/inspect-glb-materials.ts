/**
 * GLB inspection steps 10–12: materials, images and textures with their samplers.
 *
 * One step per function over the shared `GlbState`; `inspect.ts` runs them in the
 * profile order and stops at the first that reports.
 */

import { decodedImageBytes, detectImageMime, imageDimensions, type ImportImageMime } from './images';
import {
  CORE_MATERIAL_FIELDS,
  CORE_PBR_FIELDS,
  SAMPLER_FILTERS,
  CORE_TEXTURE_MIMES,
  SAMPLER_WRAPS,
} from './gltf-rules';
import { escapePointer } from './json';
import { M2_GLTF_IMAGE_BYTES } from './limits';
import type { ImportDiagnostic } from './types';
import { isPlainObject, isFiniteNumber, asIndex, diag, ptr, type GlbState } from './inspect-glb-state';
import { checkExtensionObject } from './inspect-glb-container';

export function checkMaterials(glb: GlbState): ImportDiagnostic[] | null {
  const out: ImportDiagnostic[] = [];
  const raw = glb.json['materials'];
  if (raw !== undefined && !Array.isArray(raw)) {
    return [
      diag('asset_material_invalid', ptr('materials'), 'materials must be an array', {
        found: typeof raw,
        expected: 'an array',
      }),
    ];
  }
  const materials = Array.isArray(raw) ? raw : [];
  for (const primitive of glb.primitives) {
    if (primitive.material !== null && materials[primitive.material] === undefined) {
      out.push(
        diag('asset_material_invalid', `${primitive.path}/material`, 'primitive material must reference an existing material', {
          found: primitive.material,
          expected: `0 .. ${materials.length - 1}`,
        }),
      );
    }
  }
  const textureCount = glb.collection('textures').length;
  const textureRef = (owner: Record<string, unknown>, path: string, key: string): void => {
    if (owner[key] === undefined) return;
    const ref = owner[key];
    if (!isPlainObject(ref)) {
      out.push(diag('asset_material_invalid', path, `${key} must be a texture reference object`, { found: typeof ref, expected: 'an object with index' }));
      return;
    }
    const index = asIndex(ref['index']);
    if (index === null || index >= textureCount) {
      out.push(
        diag('asset_material_invalid', `${path}/${key}/index`, 'texture reference must resolve to an existing texture', {
          found: ref['index'],
          expected: `0 .. ${textureCount - 1}`,
        }),
      );
    }
    checkExtensionObject(glb, ref, `${path}/${key}`, out, 'textureInfo');
    const transform = isPlainObject(ref['extensions']) ? ref['extensions']['KHR_texture_transform'] : undefined;
    if (isPlainObject(transform)) {
      const tpath = `${path}/${key}/extensions/KHR_texture_transform`;
      for (const [field, size] of [['offset', 2], ['scale', 2]] as const) {
        const v = transform[field];
        if (v !== undefined && (!Array.isArray(v) || v.length !== size || !v.every(isFiniteNumber))) {
          out.push(diag('asset_material_invalid', `${tpath}/${field}`, `${field} must be ${size} finite numbers`, { found: v, expected: `[number, number]` }));
        }
      }
      if (transform['rotation'] !== undefined && !isFiniteNumber(transform['rotation'])) {
        out.push(diag('asset_material_invalid', `${tpath}/rotation`, 'rotation must be a finite number', { found: transform['rotation'], expected: 'a finite number' }));
      }
    }
  };
  for (let i = 0; i < materials.length; i++) {
    const material = materials[i];
    const path = ptr('materials', i);
    if (!isPlainObject(material)) {
      out.push(diag('asset_material_invalid', path, 'material must be an object', { found: typeof material, expected: 'an object' }));
      continue;
    }
    checkExtensionObject(glb, material, path, out, 'material');
    // Textures referenced from material extensions (specular, clearcoat,
    // sheen, transmission, volume …) resolve like core texture references.
    const mext = material['extensions'];
    if (isPlainObject(mext)) {
      for (const [name, body] of Object.entries(mext)) {
        if (!isPlainObject(body)) continue;
        for (const key of Object.keys(body)) {
          if (key.endsWith('Texture')) textureRef(body, `${path}/extensions/${escapePointer(name)}`, key);
        }
      }
    }
    for (const key of Object.keys(material)) {
      if (!CORE_MATERIAL_FIELDS.has(key)) {
        out.push(
          diag('asset_material_invalid', `${path}/${escapePointer(key)}`, `material field "${key}" is not a core PBR field of the M2 profile`, {
            found: key,
            expected: `one of [${[...CORE_MATERIAL_FIELDS].join(', ')}]`,
          }),
        );
      }
    }
    const alphaMode = material['alphaMode'] ?? 'OPAQUE';
    if (alphaMode !== 'OPAQUE' && alphaMode !== 'MASK' && alphaMode !== 'BLEND') {
      out.push(
        diag('asset_material_invalid', `${path}/alphaMode`, 'alphaMode must be OPAQUE, MASK or BLEND', {
          found: alphaMode,
          expected: 'OPAQUE | MASK | BLEND',
        }),
      );
    }
    if (material['alphaCutoff'] !== undefined && !isFiniteNumber(material['alphaCutoff'])) {
      out.push(
        diag('asset_material_invalid', `${path}/alphaCutoff`, 'alphaCutoff must be a finite number', {
          found: material['alphaCutoff'],
          expected: 'a finite number',
        }),
      );
    }
    if (material['doubleSided'] !== undefined && typeof material['doubleSided'] !== 'boolean') {
      out.push(
        diag('asset_material_invalid', `${path}/doubleSided`, 'doubleSided must be a boolean', {
          found: material['doubleSided'],
          expected: 'a boolean',
        }),
      );
    }
    if (material['emissiveFactor'] !== undefined) {
      checkUnitVector(material['emissiveFactor'], 3, `${path}/emissiveFactor`, out);
    }
    const pbr = material['pbrMetallicRoughness'];
    if (pbr !== undefined) {
      if (!isPlainObject(pbr)) {
        out.push(
          diag('asset_material_invalid', `${path}/pbrMetallicRoughness`, 'pbrMetallicRoughness must be an object', {
            found: typeof pbr,
            expected: 'an object',
          }),
        );
      } else {
        const ppath = `${path}/pbrMetallicRoughness`;
        for (const key of Object.keys(pbr)) {
          if (!CORE_PBR_FIELDS.has(key)) {
            out.push(
              diag('asset_material_invalid', `${ppath}/${escapePointer(key)}`, `pbrMetallicRoughness field "${key}" is not in the M2 profile`, {
                found: key,
                expected: `one of [${[...CORE_PBR_FIELDS].join(', ')}]`,
              }),
            );
          }
        }
        if (pbr['baseColorFactor'] !== undefined) checkUnitVector(pbr['baseColorFactor'], 4, `${ppath}/baseColorFactor`, out);
        for (const key of ['metallicFactor', 'roughnessFactor']) {
          const value = pbr[key];
          if (value === undefined) continue;
          if (!isFiniteNumber(value) || value < 0 || value > 1) {
            out.push(
              diag('asset_material_invalid', `${ppath}/${key}`, `${key} must be a finite factor in [0, 1]`, {
                found: value,
                expected: '0 <= value <= 1',
              }),
            );
          }
        }
        textureRef(pbr, ppath, 'baseColorTexture');
        textureRef(pbr, ppath, 'metallicRoughnessTexture');
      }
    }
    textureRef(material, path, 'normalTexture');
    textureRef(material, path, 'occlusionTexture');
    textureRef(material, path, 'emissiveTexture');
  }
  return out.length > 0 ? out : null;
}

export function checkImages(glb: GlbState): ImportDiagnostic[] | null {
  const out: ImportDiagnostic[] = [];
  const raw = glb.json['images'];
  if (raw !== undefined && !Array.isArray(raw)) {
    return [
      diag('asset_image_invalid', ptr('images'), 'images must be an array', {
        found: typeof raw,
        expected: 'an array',
      }),
    ];
  }
  const images = Array.isArray(raw) ? raw : [];
  let decoded = 0;
  for (let i = 0; i < images.length; i++) {
    const image = images[i];
    const path = ptr('images', i);
    if (!isPlainObject(image)) {
      out.push(diag('asset_image_invalid', path, 'image must be an object', { found: typeof image, expected: 'an object' }));
      continue;
    }
    if (image['uri'] !== undefined) {
      out.push(
        diag('asset_uri_rejected', `${path}/uri`, 'images must be embedded bufferViews; URIs (including data:) are never fetched', {
          found: image['uri'],
          expected: 'no uri member',
        }),
      );
      continue;
    }
    const bufferViewIndex = asIndex(image['bufferView']);
    const bv = bufferViewIndex === null ? undefined : glb.bufferViews[bufferViewIndex];
    if (bufferViewIndex === null || bv === undefined) {
      out.push(
        diag('asset_image_invalid', `${path}/bufferView`, 'every image must reference an embedded bufferView', {
          found: image['bufferView'],
          expected: `0 .. ${glb.bufferViews.length - 1}`,
        }),
      );
      continue;
    }
    const mime = image['mimeType'];
    if (mime !== 'image/png' && mime !== 'image/jpeg' && mime !== 'image/webp' && mime !== 'image/ktx2') {
      out.push(
        diag('asset_image_invalid', `${path}/mimeType`, 'image mimeType must be image/png, image/jpeg, image/webp or image/ktx2', {
          found: mime,
          expected: 'image/png | image/jpeg | image/webp | image/ktx2',
        }),
      );
      continue;
    }
    if (bv.byteLength > M2_GLTF_IMAGE_BYTES) {
      out.push(
        diag('asset_image_invalid', path, 'image exceeds the per-image byte cap', {
          found: bv.byteLength,
          expected: `<= ${M2_GLTF_IMAGE_BYTES}`,
          limit: 'image_bytes',
        }),
      );
      continue;
    }
    const data = bv.data;
    const actualMime = detectImageMime(data);
    if (actualMime === null) {
      out.push(
        diag('asset_image_invalid', path, 'image bytes are not PNG, JPEG, WebP or KTX2', {
          found: [...data.subarray(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join(' '),
          expected: 'a PNG, JPEG, WebP or KTX2 signature',
        }),
      );
      continue;
    }
    if (actualMime !== mime) {
      out.push(
        diag('asset_image_mime_mismatch', `${path}/mimeType`, 'the declared mimeType does not match the image magic bytes', {
          found: { declared: mime, actual: actualMime },
          expected: mime,
        }),
      );
      continue;
    }
    const dims = imageDimensions(data, actualMime as ImportImageMime);
    if (dims === null) {
      out.push(
        diag('asset_image_invalid', path, 'the image header is unreadable, so decoded bytes cannot be bounded', {
          found: 'unreadable header',
          expected: 'a readable PNG IHDR, JPEG frame header, WebP VP8/VP8L/VP8X header or a 2D Basis Universal KTX2 header',
        }),
      );
      continue;
    }
    glb.imageMimes[i] = actualMime;
    decoded += decodedImageBytes(dims);
  }
  if (out.length > 0) return out;
  glb.imageDecodedBytes = decoded;
  return null;
}

export function checkTextures(glb: GlbState): ImportDiagnostic[] | null {
  const out: ImportDiagnostic[] = [];
  const samplersRaw = glb.json['samplers'];
  if (samplersRaw !== undefined && !Array.isArray(samplersRaw)) {
    return [
      diag('asset_texture_invalid', ptr('samplers'), 'samplers must be an array', {
        found: typeof samplersRaw,
        expected: 'an array',
      }),
    ];
  }
  const samplers = Array.isArray(samplersRaw) ? samplersRaw : [];
  for (let i = 0; i < samplers.length; i++) {
    const sampler = samplers[i];
    const path = ptr('samplers', i);
    if (!isPlainObject(sampler)) {
      out.push(diag('asset_texture_invalid', path, 'sampler must be an object', { found: typeof sampler, expected: 'an object' }));
      continue;
    }
    for (const key of ['wrapS', 'wrapT'] as const) {
      const value = sampler[key];
      if (value === undefined) continue;
      if (typeof value !== 'number' || !SAMPLER_WRAPS.has(value)) {
        out.push(
          diag('asset_texture_invalid', `${path}/${key}`, `${key} must be a glTF wrap enum`, {
            found: value,
            expected: '33071 (CLAMP) | 33648 (MIRRORED_REPEAT) | 10497 (REPEAT)',
          }),
        );
      }
    }
    for (const key of ['magFilter', 'minFilter'] as const) {
      const value = sampler[key];
      if (value === undefined) continue;
      if (typeof value !== 'number' || !SAMPLER_FILTERS.has(value)) {
        out.push(
          diag('asset_texture_invalid', `${path}/${key}`, `${key} must be a glTF filter enum`, {
            found: value,
            expected: '9728 | 9729 | 9984 | 9985 | 9986 | 9987',
          }),
        );
      }
    }
  }
  const texturesRaw = glb.json['textures'];
  if (texturesRaw !== undefined && !Array.isArray(texturesRaw)) {
    out.push(
      diag('asset_texture_invalid', ptr('textures'), 'textures must be an array', {
        found: typeof texturesRaw,
        expected: 'an array',
      }),
    );
    return out;
  }
  const textures = Array.isArray(texturesRaw) ? texturesRaw : [];
  const imageCount = glb.collection('images').length;
  for (let i = 0; i < textures.length; i++) {
    const texture = textures[i];
    const path = ptr('textures', i);
    if (!isPlainObject(texture)) {
      out.push(diag('asset_texture_invalid', path, 'texture must be an object', { found: typeof texture, expected: 'an object' }));
      continue;
    }
    checkExtensionObject(glb, texture, path, out, 'texture');
    // A texture's image comes from `source` (PNG/JPEG) and/or from an
    // extension naming a source in its own container (EXT_texture_webp).
    const ext = isPlainObject(texture['extensions']) ? texture['extensions'] : {};
    const sources: { key: string; value: unknown; mimes: ReadonlySet<string> }[] = [];
    if (texture['source'] !== undefined) sources.push({ key: 'source', value: texture['source'], mimes: CORE_TEXTURE_MIMES });
    if (isPlainObject(ext['EXT_texture_webp'])) {
      sources.push({ key: 'extensions/EXT_texture_webp/source', value: ext['EXT_texture_webp']['source'], mimes: new Set(['image/webp']) });
    }
    if (isPlainObject(ext['KHR_texture_basisu'])) {
      sources.push({ key: 'extensions/KHR_texture_basisu/source', value: ext['KHR_texture_basisu']['source'], mimes: new Set(['image/ktx2']) });
    }
    if (sources.length === 0) {
      out.push(
        diag('asset_texture_invalid', `${path}/source`, 'texture source must resolve to an existing image', {
          found: texture['source'],
          expected: `0 .. ${imageCount - 1}`,
        }),
      );
    }
    for (const src of sources) {
      const source = asIndex(src.value);
      if (source === null || source >= imageCount) {
        out.push(
          diag('asset_texture_invalid', `${path}/${src.key}`, 'texture source must resolve to an existing image', {
            found: src.value,
            expected: `0 .. ${imageCount - 1}`,
          }),
        );
        continue;
      }
      const mime = glb.imageMimes[source];
      if (mime !== undefined && mime !== null && !src.mimes.has(mime)) {
        out.push(
          diag('asset_texture_invalid', `${path}/${src.key}`, `a ${mime} image cannot be used from texture ${src.key}`, {
            found: mime,
            expected: [...src.mimes].join(' | '),
          }),
        );
      }
    }
    if (texture['sampler'] !== undefined) {
      const sampler = asIndex(texture['sampler']);
      if (sampler === null || samplers[sampler] === undefined) {
        out.push(
          diag('asset_texture_invalid', `${path}/sampler`, 'texture sampler must resolve to an existing sampler', {
            found: texture['sampler'],
            expected: `0 .. ${samplers.length - 1}`,
          }),
        );
      }
    }
  }
  return out.length > 0 ? out : null;
}

function checkUnitVector(
  value: unknown,
  length: number,
  path: string,
  out: ImportDiagnostic[],
): void {
  if (
    !Array.isArray(value) ||
    value.length !== length ||
    value.some((v) => !isFiniteNumber(v) || v < 0 || v > 1)
  ) {
    out.push(
      diag('asset_material_invalid', path, `factor must be ${length} finite numbers in [0, 1]`, {
        found: value,
        expected: `${length} values in [0, 1]`,
      }),
    );
  }
}
