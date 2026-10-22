/**
 * GLB inspection step 9 (meshes and primitives) and the skin/morph-target caps of step 14b.
 *
 * One step per function over the shared `GlbState`; `inspect.ts` runs them in the
 * profile order and stops at the first that reports.
 */

import { UNSIGNED_COMPONENTS, ATTRIBUTE_ALLOWLIST } from './gltf-rules';
import { escapePointer } from './json';
import { M2_GLTF_MAX_DIAGNOSTICS, MODEL_MAX_MORPH_TARGETS, MODEL_MAX_SKIN_JOINTS, MODEL_MAX_SKINS } from './limits';
import type { ImportDiagnostic } from './types';
import { isPlainObject, asIndex, diag, ptr, type GlbState } from './inspect-glb-state';
import { checkExtensionObject } from './inspect-glb-container';

export function checkMeshes(glb: GlbState): ImportDiagnostic[] | null {
  const out: ImportDiagnostic[] = [];
  const meshes = glb.json['meshes'];
  if (glb.animationOnly()) return null;
  if (!Array.isArray(meshes) || meshes.length < 1) {
    return [
      diag('asset_mesh_invalid', ptr('meshes'), 'the M2 profile requires at least one mesh', {
        found: Array.isArray(meshes) ? meshes.length : meshes === undefined ? 'absent' : typeof meshes,
        expected: 'meshes.length >= 1',
      }),
    ];
  }
  for (let i = 0; i < meshes.length; i++) {
    const mesh = meshes[i];
    const path = ptr('meshes', i);
    if (!isPlainObject(mesh)) {
      out.push(diag('asset_mesh_invalid', path, 'mesh must be an object', { found: typeof mesh, expected: 'an object' }));
      continue;
    }
    checkExtensionObject(glb, mesh, path, out, 'mesh');
    const primitives = mesh['primitives'];
    if (!Array.isArray(primitives)) {
      out.push(
        diag('asset_mesh_invalid', `${path}/primitives`, 'mesh primitives must be an array', {
          found: primitives === undefined ? 'absent' : typeof primitives,
          expected: 'an array',
        }),
      );
      continue;
    }
    for (let j = 0; j < primitives.length; j++) {
      const primitive = primitives[j];
      const ppath = ptr('meshes', i, 'primitives', j);
      if (!isPlainObject(primitive)) {
        out.push(
          diag('asset_mesh_invalid', ppath, 'primitive must be an object', { found: typeof primitive, expected: 'an object' }),
        );
        continue;
      }
      const before = out.length;
      checkExtensionObject(glb, primitive, ppath, out, 'primitive');
      if (out.length > before) continue;
      const dracoExt = isPlainObject(primitive['extensions']) ? primitive['extensions']['KHR_draco_mesh_compression'] : undefined;
      if (isPlainObject(dracoExt)) {
        const dpath = `${ppath}/extensions/KHR_draco_mesh_compression`;
        const dbv = asIndex(dracoExt['bufferView']);
        const view = dbv === null ? undefined : glb.bufferViews[dbv];
        const dattrs = dracoExt['attributes'];
        const prim = isPlainObject(primitive['attributes']) ? primitive['attributes'] : {};
        if (view === undefined || view.compressed || view.buffer !== 0) {
          out.push(diag('asset_primitive_unsupported', `${dpath}/bufferView`, 'the Draco stream must be an existing uncompressed bufferView in the BIN chunk', { found: dracoExt['bufferView'], expected: `0 .. ${glb.bufferViews.length - 1}` }));
          continue;
        }
        if (!isPlainObject(dattrs) || Object.entries(dattrs).some(([name, id]) => asIndex(id) === null || prim[name] === undefined)) {
          out.push(diag('asset_primitive_unsupported', `${dpath}/attributes`, 'Draco attributes must map primitive attributes to Draco attribute ids', { found: dattrs, expected: 'an object of primitive attribute names → integer ids' }));
          continue;
        }
      }
      const mode = primitive['mode'] ?? 4;
      if (mode !== 4) {
        out.push(
          diag('asset_primitive_unsupported', `${ppath}/mode`, 'only triangle primitives (mode 4) are in the M2 profile', {
            found: mode,
            expected: '4',
          }),
        );
        continue;
      }
      const attributes = primitive['attributes'];
      if (!isPlainObject(attributes) || Object.keys(attributes).length === 0) {
        out.push(
          diag('asset_mesh_invalid', `${ppath}/attributes`, 'primitive attributes must be a non-empty object', {
            found: attributes === undefined ? 'absent' : typeof attributes,
            expected: 'an object with POSITION',
          }),
        );
        continue;
      }
      const attributeMap = new Map<string, number>();
      let attributeError = false;
      for (const name of Object.keys(attributes)) {
        if (!ATTRIBUTE_ALLOWLIST.has(name)) {
          out.push(
            diag('asset_primitive_unsupported', `${ppath}/attributes/${escapePointer(name)}`, `attribute "${name}" is not in the M2 profile`, {
              found: name,
              expected: `one of [${[...ATTRIBUTE_ALLOWLIST].join(', ')}]`,
            }),
          );
          attributeError = true;
          continue;
        }
        const index = asIndex(attributes[name]);
        if (index === null || glb.accessors[index] === undefined) {
          out.push(
            diag('asset_accessor_invalid', `${ppath}/attributes/${escapePointer(name)}`, 'primitive attribute must reference an existing accessor', {
              found: attributes[name],
              expected: `0 .. ${glb.accessors.length - 1}`,
            }),
          );
          attributeError = true;
          continue;
        }
        attributeMap.set(name, index);
      }
      if (attributeError) continue;
      if (!attributeMap.has('POSITION')) {
        out.push(
          diag('asset_mesh_invalid', `${ppath}/attributes`, 'every primitive must carry POSITION', {
            found: Object.keys(attributes),
            expected: 'POSITION present',
          }),
        );
        continue;
      }
      let indices: number | null = null;
      if (primitive['indices'] !== undefined) {
        const index = asIndex(primitive['indices']);
        const info = index === null ? undefined : glb.accessors[index];
        if (index === null || info === undefined) {
          out.push(
            diag('asset_accessor_invalid', `${ppath}/indices`, 'primitive indices must reference an existing accessor', {
              found: primitive['indices'],
              expected: `0 .. ${glb.accessors.length - 1}`,
            }),
          );
          continue;
        }
        if (!UNSIGNED_COMPONENTS.has(info.componentType) || info.type !== 'SCALAR') {
          out.push(
            diag('asset_accessor_unsupported', `${ppath}/indices`, 'primitive indices must be an unsigned SCALAR accessor', {
              found: { componentType: info.componentType, type: info.type },
              expected: 'UNSIGNED_BYTE/UNSIGNED_SHORT/UNSIGNED_INT SCALAR',
            }),
          );
          continue;
        }
        indices = index;
      }
      const material = primitive['material'];
      let materialIndex: number | null = null;
      if (material !== undefined) {
        const index = asIndex(material);
        if (index === null) {
          out.push(
            diag('asset_material_invalid', `${ppath}/material`, 'primitive material must be a material index', {
              found: material,
              expected: 'a non-negative integer',
            }),
          );
          continue;
        }
        materialIndex = index;
      }
      glb.primitives.push({ path: ppath, attributes: attributeMap, indices, material: materialIndex });
    }
  }
  return out.length > 0 ? out : null;
}

/** ≤ MODEL_MAX_SKINS skins, ≤ MODEL_MAX_SKIN_JOINTS joints each, ≤ MODEL_MAX_MORPH_TARGETS morph targets per primitive. */
export function checkRigCaps(glb: GlbState): ImportDiagnostic[] | null {
  const out: ImportDiagnostic[] = [];
  const skins = glb.collection('skins');
  if (skins.length > MODEL_MAX_SKINS) {
    out.push(diag('asset_limits_exceeded', ptr('skins'), `a model has at most ${MODEL_MAX_SKINS} skins`, { found: skins.length, expected: `<= ${MODEL_MAX_SKINS}`, limit: 'skins' }));
  }
  skins.forEach((skin, i) => {
    const joints = isPlainObject(skin) && Array.isArray(skin['joints']) ? skin['joints'].length : 0;
    if (joints > MODEL_MAX_SKIN_JOINTS) {
      out.push(diag('asset_limits_exceeded', ptr('skins', i, 'joints'), `a skin has at most ${MODEL_MAX_SKIN_JOINTS} joints`, { found: joints, expected: `<= ${MODEL_MAX_SKIN_JOINTS}`, limit: 'skin_joints' }));
    }
  });
  glb.collection('meshes').forEach((mesh, m) => {
    const primitives = isPlainObject(mesh) && Array.isArray(mesh['primitives']) ? mesh['primitives'] : [];
    primitives.forEach((prim, p) => {
      const targets = isPlainObject(prim) && Array.isArray(prim['targets']) ? prim['targets'].length : 0;
      if (targets > MODEL_MAX_MORPH_TARGETS) {
        out.push(diag('asset_limits_exceeded', ptr('meshes', m, 'primitives', p, 'targets'), `a primitive has at most ${MODEL_MAX_MORPH_TARGETS} morph targets`, { found: targets, expected: `<= ${MODEL_MAX_MORPH_TARGETS}`, limit: 'morph_targets' }));
      }
    });
  });
  return out.length > 0 ? out.slice(0, M2_GLTF_MAX_DIAGNOSTICS) : null;
}
