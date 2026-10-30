/**
 * GLB inspection step 14 (nodes and scenes) and step 15: the metrics, the model bounds and the
 * decoded-size caps.
 *
 * One step per function over the shared `GlbState`; `inspect.ts` runs them in the
 * profile order and stops at the first that reports.
 */

import { mulMat4 } from '@thirdlight/shared';
import type { AssetMetrics } from '@thirdlight/project-model';
import { decodedImageBytes } from './images';
import {
  M2_GLTF_DECODED_GEOMETRY_BYTES,
  M2_GLTF_DECODED_IMAGE_BYTES,
  M2_GLTF_PROFILE_LIMITS,
  M2_GLTF_TOTAL_DECODED_BYTES,
} from './limits';
import type { ImportDiagnostic, ImportLimitName } from './types';
import {
  isPlainObject,
  isFiniteNumber,
  asIndex,
  diag,
  ptr,
  type GlbState,
  type AccessorInfo,
} from './inspect-glb-state';
import { checkExtensionObject } from './inspect-glb-container';

export function checkNodesAndScenes(glb: GlbState): ImportDiagnostic[] | null {
  const out: ImportDiagnostic[] = [];
  const rawNodes = glb.json['nodes'];
  if (rawNodes !== undefined && !Array.isArray(rawNodes)) {
    return [
      diag('asset_node_invalid', ptr('nodes'), 'nodes must be an array', {
        found: typeof rawNodes,
        expected: 'an array',
      }),
    ];
  }
  const nodes = Array.isArray(rawNodes) ? rawNodes : [];
  const childrenOf: number[][] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const path = ptr('nodes', i);
    childrenOf.push([]);
    if (!isPlainObject(node)) {
      out.push(diag('asset_node_invalid', path, 'node must be an object', { found: typeof node, expected: 'an object' }));
      continue;
    }
    checkExtensionObject(glb, node, path, out, 'node');
    const hasMatrix = node['matrix'] !== undefined;
    const hasTrs =
      node['translation'] !== undefined || node['rotation'] !== undefined || node['scale'] !== undefined;
    if (hasMatrix && hasTrs) {
      out.push(
        diag('asset_node_invalid', path, 'a node must carry either matrix or TRS, never both', {
          found: 'matrix and TRS',
          expected: 'one transform representation',
        }),
      );
    }
    if (hasMatrix) {
      const matrix = node['matrix'];
      if (
        !Array.isArray(matrix) ||
        matrix.length !== 16 ||
        matrix.some((v) => !isFiniteNumber(v))
      ) {
        out.push(
          diag('asset_node_invalid', `${path}/matrix`, 'node matrix must be 16 finite numbers', {
            found: Array.isArray(matrix) ? matrix.length : typeof matrix,
            expected: '16 finite numbers',
          }),
        );
      }
    }
    for (const key of ['translation', 'rotation', 'scale'] as const) {
      if (node[key] === undefined) continue;
      const expectedLength = key === 'rotation' ? 4 : 3;
      const value = node[key];
      if (
        !Array.isArray(value) ||
        value.length !== expectedLength ||
        value.some((v) => !isFiniteNumber(v))
      ) {
        out.push(
          diag('asset_node_invalid', `${path}/${key}`, `node ${key} must be ${expectedLength} finite numbers`, {
            found: Array.isArray(value) ? value.length : typeof value,
            expected: `${expectedLength} finite numbers`,
          }),
        );
      }
    }
    if (node['mesh'] !== undefined) {
      const meshIndex = asIndex(node['mesh']);
      if (meshIndex === null || meshIndex >= glb.collection('meshes').length) {
        out.push(
          diag('asset_node_invalid', `${path}/mesh`, 'node mesh must resolve to an existing mesh', {
            found: node['mesh'],
            expected: `0 .. ${glb.collection('meshes').length - 1}`,
          }),
        );
      }
    }
    const children = node['children'];
    if (children !== undefined) {
      if (!Array.isArray(children)) {
        out.push(
          diag('asset_node_invalid', `${path}/children`, 'node children must be an array', {
            found: typeof children,
            expected: 'an array of node indices',
          }),
        );
        continue;
      }
      for (let c = 0; c < children.length; c++) {
        const child = asIndex(children[c]);
        if (child === null || child >= nodes.length) {
          out.push(
            diag('asset_node_invalid', `${path}/children/${c}`, 'node child must resolve to an existing node', {
              found: children[c],
              expected: `0 .. ${nodes.length - 1}`,
            }),
          );
          continue;
        }
        if (child === i) {
          out.push(
            diag('asset_node_invalid', `${path}/children/${c}`, 'a node must not be its own child', {
              found: child,
              expected: 'a different node index',
            }),
          );
          continue;
        }
        (childrenOf[i] as number[]).push(child);
      }
    }
  }
  // Cycle detection over the child graph (iterative DFS with colours).
  const colour = new Uint8Array(nodes.length);
  for (let start = 0; start < nodes.length; start++) {
    if (colour[start] !== 0) continue;
    const stack: { node: number; next: number }[] = [{ node: start, next: 0 }];
    colour[start] = 1;
    while (stack.length > 0) {
      const top = stack[stack.length - 1] as { node: number; next: number };
      const children = childrenOf[top.node] as number[];
      if (top.next >= children.length) {
        colour[top.node] = 2;
        stack.pop();
        continue;
      }
      const child = children[top.next] as number;
      top.next += 1;
      if (colour[child] === 1) {
        out.push(
          diag('asset_node_invalid', ptr('nodes', child), 'node hierarchy must not contain a cycle', {
            found: `nodes[${top.node}] -> nodes[${child}]`,
            expected: 'an acyclic hierarchy',
          }),
        );
        continue;
      }
      if (colour[child] === 0) {
        colour[child] = 1;
        stack.push({ node: child, next: 0 });
      }
    }
  }

  const rawScenes = glb.json['scenes'];
  if (rawScenes !== undefined && !Array.isArray(rawScenes)) {
    out.push(
      diag('asset_scene_invalid', ptr('scenes'), 'scenes must be an array', {
        found: typeof rawScenes,
        expected: 'an array',
      }),
    );
    return out;
  }
  const scenes = Array.isArray(rawScenes) ? rawScenes : [];
  if (scenes.length < 1) {
    out.push(
      diag('asset_scene_invalid', ptr('scenes'), 'the M2 profile requires at least one scene', {
        found: scenes.length,
        expected: 'scenes.length >= 1',
      }),
    );
  }
  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const path = ptr('scenes', i);
    if (!isPlainObject(scene)) {
      out.push(diag('asset_scene_invalid', path, 'scene must be an object', { found: typeof scene, expected: 'an object' }));
      continue;
    }
    checkExtensionObject(glb, scene, path, out, 'scene');
    const nodesList = scene['nodes'];
    if (nodesList !== undefined) {
      if (!Array.isArray(nodesList)) {
        out.push(
          diag('asset_scene_invalid', `${path}/nodes`, 'scene nodes must be an array', {
            found: typeof nodesList,
            expected: 'an array of node indices',
          }),
        );
        continue;
      }
      for (let n = 0; n < nodesList.length; n++) {
        const index = asIndex(nodesList[n]);
        if (index === null || index >= nodes.length) {
          out.push(
            diag('asset_scene_invalid', `${path}/nodes/${n}`, 'scene node must resolve to an existing node', {
              found: nodesList[n],
              expected: `0 .. ${nodes.length - 1}`,
            }),
          );
        }
      }
    }
  }
  const sceneIndex = glb.json['scene'];
  if (sceneIndex !== undefined) {
    const index = asIndex(sceneIndex);
    if (index === null || index >= scenes.length) {
      out.push(
        diag('asset_scene_invalid', ptr('scene'), 'scene must be a valid scene index', {
          found: sceneIndex,
          expected: `0 .. ${scenes.length - 1}`,
        }),
      );
    }
  }
  return out.length > 0 ? out : null;
}

export function computeMetrics(glb: GlbState): AssetMetrics {
  let primitives = 0;
  let vertices = 0;
  let triangles = 0;
  let decodedGeometry = 0;
  for (const primitive of glb.primitives) {
    primitives += 1;
    let positionCount = 0;
    for (const [, accessorIndex] of primitive.attributes) {
      const info = glb.accessors[accessorIndex] as AccessorInfo;
      decodedGeometry += info.byteLength;
    }
    const positionIndex = primitive.attributes.get('POSITION');
    if (positionIndex !== undefined) positionCount = (glb.accessors[positionIndex] as AccessorInfo).count;
    vertices += positionCount;
    if (primitive.indices !== null) {
      const indices = glb.accessors[primitive.indices] as AccessorInfo;
      decodedGeometry += indices.byteLength;
      triangles += Math.floor(indices.count / 3);
    } else {
      triangles += Math.floor(positionCount / 3);
    }
  }
  let animationChannels = 0;
  for (const animation of glb.collection('animations')) {
    if (isPlainObject(animation) && Array.isArray(animation['channels'])) {
      animationChannels += animation['channels'].length;
    }
  }
  const bounds = computeBounds(glb);
  return {
    nodes: glb.collection('nodes').length,
    meshes: glb.collection('meshes').length,
    primitives,
    materials: glb.collection('materials').length,
    images: glb.collection('images').length,
    textures: glb.collection('textures').length,
    vertices,
    triangles,
    animations: glb.collection('animations').length,
    animationChannels,
    clipDurationMs: glb.clipDurationMs,
    decodedGeometryBytes: decodedGeometry,
    decodedImageBytes: glb.imageDecodedBytes,
    // The model's bounds (what the runtime uses for a pickup without a size).
    ...(bounds !== null ? { bounds } : {}),
  };
}

/**
 * The axis-aligned box of the default scene's meshes in model
 * space (metres, node transforms applied) — from each POSITION accessor's
 * `min`/`max` (required by glTF; normalized integers dequantized), so no
 * vertex is read. `<piece>_COL` collision and `<piece>_OCC` occluder nodes are left out (never drawn in colour).
 * Rounded to the micrometre; null when there is no geometry (an
 * animation-only file) or it lies beyond the model's length bound.
 */
function computeBounds(glb: GlbState): { min: [number, number, number]; max: [number, number, number] } | null {
  const nodes = glb.collection('nodes');
  const meshes = glb.collection('meshes');
  const accessors = glb.collection('accessors');
  const scenes = glb.collection('scenes');
  const sceneIndex = asIndex(glb.json['scene']) ?? 0;
  const scene = scenes[sceneIndex];
  if (!isPlainObject(scene) || !Array.isArray(scene['nodes'])) return null;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  const dequantize = (v: number, componentType: unknown, normalized: boolean): number => {
    if (!normalized) return v;
    if (componentType === 5120) return Math.max(v / 127, -1);
    if (componentType === 5121) return v / 255;
    if (componentType === 5122) return Math.max(v / 32767, -1);
    if (componentType === 5123) return v / 65535;
    return v;
  };
  const visit = (index: number, parent: readonly number[], depth: number): void => {
    const node = nodes[index];
    if (!isPlainObject(node) || depth > 64) return;
    if (typeof node['name'] === 'string' && /_(COL|OCC)$/.test(node['name'])) return;
    const world = mulMat4(new Array<number>(16), parent, nodeMatrix(node));
    const meshIndex = asIndex(node['mesh']);
    const mesh = meshIndex !== null ? meshes[meshIndex] : undefined;
    if (isPlainObject(mesh) && Array.isArray(mesh['primitives'])) {
      for (const primitive of mesh['primitives']) {
        const attrs = isPlainObject(primitive) ? primitive['attributes'] : undefined;
        const pos = isPlainObject(attrs) ? asIndex(attrs['POSITION']) : null;
        const acc = pos !== null ? accessors[pos] : undefined;
        if (!isPlainObject(acc) || !Array.isArray(acc['min']) || !Array.isArray(acc['max']) || acc['min'].length < 3 || acc['max'].length < 3) continue;
        const normalized = acc['normalized'] === true;
        const mn = (acc['min'] as unknown[]).slice(0, 3).map((v) => dequantize(Number(v), acc['componentType'], normalized));
        const mx = (acc['max'] as unknown[]).slice(0, 3).map((v) => dequantize(Number(v), acc['componentType'], normalized));
        if (![...mn, ...mx].every(Number.isFinite)) continue;
        for (let corner = 0; corner < 8; corner++) {
          const x = corner & 1 ? mx[0]! : mn[0]!;
          const y = corner & 2 ? mx[1]! : mn[1]!;
          const z = corner & 4 ? mx[2]! : mn[2]!;
          for (let axis = 0; axis < 3; axis++) {
            const w = world[axis]! * x + world[4 + axis]! * y + world[8 + axis]! * z + world[12 + axis]!;
            if (w < lo[axis]!) lo[axis] = w;
            if (w > hi[axis]!) hi[axis] = w;
          }
        }
      }
    }
    if (Array.isArray(node['children'])) for (const c of node['children']) {
      const ci = asIndex(c);
      if (ci !== null) visit(ci, world, depth + 1);
    }
  };
  for (const n of scene['nodes'] as unknown[]) {
    const ni = asIndex(n);
    if (ni !== null) visit(ni, IDENTITY_4, 0);
  }
  const round = (v: number): number => {
    const r = Math.round(v * 1e6) / 1e6;
    return r === 0 ? 0 : r;
  };
  if (!lo.every(Number.isFinite) || !hi.every(Number.isFinite)) return null;
  const min = lo.map(round) as [number, number, number];
  const max = hi.map(round) as [number, number, number];
  if ([...min, ...max].some((v) => Math.abs(v) > 1e6)) return null;
  return { min, max };
}

/** The column-major 4x4 identity (glTF matrices are column-major). */
const IDENTITY_4: readonly number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** A node's local matrix — its `matrix`, else translation × rotation × scale. */
function nodeMatrix(node: Record<string, unknown>): number[] {
  const m = node['matrix'];
  if (Array.isArray(m) && m.length === 16 && m.every((v) => typeof v === 'number' && Number.isFinite(v))) return [...(m as number[])];
  const t = Array.isArray(node['translation']) ? (node['translation'] as number[]) : [0, 0, 0];
  const r = Array.isArray(node['rotation']) ? (node['rotation'] as number[]) : [0, 0, 0, 1];
  const s = Array.isArray(node['scale']) ? (node['scale'] as number[]) : [1, 1, 1];
  const [x, y, z, w] = [r[0] ?? 0, r[1] ?? 0, r[2] ?? 0, r[3] ?? 1];
  const [sx, sy, sz] = [s[0] ?? 1, s[1] ?? 1, s[2] ?? 1];
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    t[0] ?? 0, t[1] ?? 0, t[2] ?? 0, 1,
  ];
}

/** Compare metrics with every cap, in table order. */
export function checkMetricCaps(metrics: AssetMetrics, imageDecodedBytes: number): ImportDiagnostic[] {
  const out: ImportDiagnostic[] = [];
  const cap = (name: ImportLimitName, value: number, limit: number, message: string): void => {
    if (value > limit) {
      out.push(
        diag('asset_limits_exceeded', '', message, {
          found: value,
          expected: `<= ${limit}`,
          limit: name,
        }),
      );
    }
  };
  cap('nodes', metrics.nodes, M2_GLTF_PROFILE_LIMITS['nodes'] as number, 'node count exceeds the M2 cap');
  cap('meshes', metrics.meshes, M2_GLTF_PROFILE_LIMITS['meshes'] as number, 'mesh count exceeds the M2 cap');
  cap('primitives', metrics.primitives, M2_GLTF_PROFILE_LIMITS['primitives'] as number, 'primitive count exceeds the M2 cap');
  cap('materials', metrics.materials, M2_GLTF_PROFILE_LIMITS['materials'] as number, 'material count exceeds the M2 cap');
  cap('images', metrics.images, M2_GLTF_PROFILE_LIMITS['images'] as number, 'image count exceeds the M2 cap');
  cap('textures', metrics.textures, M2_GLTF_PROFILE_LIMITS['textures'] as number, 'texture count exceeds the M2 cap');
  cap('vertices', metrics.vertices, M2_GLTF_PROFILE_LIMITS['vertices'] as number, 'vertex count exceeds the M2 cap');
  cap('triangles', metrics.triangles, M2_GLTF_PROFILE_LIMITS['triangles'] as number, 'triangle count exceeds the M2 cap');
  cap('animations', metrics.animations, M2_GLTF_PROFILE_LIMITS['animations'] as number, 'animation count exceeds the M2 cap');
  cap(
    'animation_channels',
    metrics.animationChannels,
    M2_GLTF_PROFILE_LIMITS['animation_channels'] as number,
    'animation channel count exceeds the M2 cap',
  );
  cap('clip_duration', metrics.clipDurationMs, M2_GLTF_PROFILE_LIMITS['clip_duration'] as number, 'clip duration exceeds the M2 cap');
  cap(
    'decoded_bytes',
    metrics.decodedGeometryBytes,
    M2_GLTF_DECODED_GEOMETRY_BYTES,
    'decoded geometry bytes exceed the M2 cap',
  );
  cap(
    'decoded_bytes',
    imageDecodedBytes,
    M2_GLTF_DECODED_IMAGE_BYTES,
    'decoded image pixel bytes exceed the M2 cap',
  );
  cap(
    'decoded_bytes',
    metrics.decodedGeometryBytes + imageDecodedBytes,
    M2_GLTF_TOTAL_DECODED_BYTES,
    'total decoded bytes exceed the M2 cap',
  );
  return out;
}
