/**
 * Generated levels of detail in a GLB (the "generate LODs" import setting):
 * a model without authored `<piece>_LOD<n>` levels gets them from the mesh
 * simplifier, in the file itself, so Play and the export draw them like
 * authored ones and nothing is simplified at load.
 *
 * Each mesh node that can be simplified becomes `<name>_LOD0` with siblings
 * `<name>_LOD1…` beside it (the same transform, the same vertex data, a new
 * index list per primitive), which is the authored-level naming the engine
 * already reads: the levels form one LOD group, a piece keeps its base name,
 * and the collision fallback still takes LOD0. A model that already has
 * authored levels is left as it is. Nodes that are skinned, animated, carry
 * morph targets or children, draw anything but triangles, or whose geometry
 * is compressed or not plain float positions are left as they are and named
 * in the report.
 *
 * Pure byte work: the new index lists are appended to the binary chunk;
 * everything else in the file is kept byte for byte.
 */
import type { MeshSimplifier, SimplifiedMesh } from '@thirdlight/asset-pipeline';
import { MESH_LOD_RATIOS_DEFAULT } from '@thirdlight/project-model/limits';

import { readGlb, writeGlb } from './glb-images';

/** What a generation did. */
export interface GlbLodReport {
  /** The triangle shares asked for. */
  ratios: number[];
  /** Mesh nodes that got levels. */
  nodes: number;
  /** The triangles of the nodes that got levels, per level, LOD0 first (a node with fewer levels counts its coarsest at the levels it does not have). */
  triangles: number[];
  /** The largest error of any level made, as a share of its mesh's extent. */
  maxError: number;
  /** Nodes left as they are, and why. */
  skipped: { node: string; reason: string }[];
  /** The model had authored levels: nothing was generated. */
  authored?: true;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const LOD_RE = /_LOD\d+$/i;
const COL_RE = /_COL$/i;
const FLOAT = 5126;
const INDEX_TYPES: Readonly<Record<number, number>> = { 5121: 1, 5123: 2, 5125: 4 };
const ELEMENT_ARRAY_BUFFER = 34963;

/** One primitive's readable geometry, or why it cannot be simplified. */
function primitiveGeometry(json: Json, bin: Uint8Array, prim: unknown): { positions: Float32Array; indices: Uint32Array | null } | string {
  if (!isObj(prim)) return 'a primitive is not an object';
  if (prim['mode'] !== undefined && prim['mode'] !== 4) return 'it draws lines or points';
  if (prim['targets'] !== undefined) return 'it has morph targets';
  if (isObj(prim['extensions']) && Object.keys(prim['extensions']).some((k) => /draco|compression/i.test(k))) return 'its geometry is compressed';
  const attrs = isObj(prim['attributes']) ? prim['attributes'] : {};
  const accessors = list(json['accessors']);
  const views = list(json['bufferViews']);
  const read = (index: unknown, components: number, componentTypes: readonly number[]): { data: number[]; count: number } | string => {
    const acc = typeof index === 'number' ? accessors[index] : undefined;
    if (!isObj(acc)) return 'an accessor is missing';
    if (acc['sparse'] !== undefined) return 'an accessor is sparse';
    const type = acc['componentType'] as number;
    if (!componentTypes.includes(type)) return componentTypes.includes(FLOAT) ? 'its positions are not plain floats' : 'its indices are not integers';
    const bv = views[acc['bufferView'] as number];
    if (!isObj(bv) || (bv['buffer'] ?? 0) !== 0 || bv['extensions'] !== undefined) return 'its data is not in the file\'s binary chunk';
    const size = type === FLOAT ? 4 : (INDEX_TYPES[type] ?? 4);
    const stride = typeof bv['byteStride'] === 'number' ? bv['byteStride'] : size * components;
    const start = ((bv['byteOffset'] as number | undefined) ?? 0) + ((acc['byteOffset'] as number | undefined) ?? 0);
    const count = acc['count'] as number;
    if (!Number.isInteger(count) || count < 0 || start + (count - 1) * stride + size * components > bin.byteLength) return 'an accessor runs past the binary chunk';
    const view = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
    const data: number[] = new Array(count * components);
    for (let i = 0; i < count; i++) {
      for (let c = 0; c < components; c++) {
        const at = start + i * stride + c * size;
        data[i * components + c] = type === FLOAT ? view.getFloat32(at, true) : size === 1 ? view.getUint8(at) : size === 2 ? view.getUint16(at, true) : view.getUint32(at, true);
      }
    }
    return { data, count };
  };
  const acc = accessors[attrs['POSITION'] as number];
  if (!isObj(acc) || acc['type'] !== 'VEC3') return 'it has no xyz positions';
  const pos = read(attrs['POSITION'], 3, [FLOAT]);
  if (typeof pos === 'string') return pos;
  if (prim['indices'] === undefined) return { positions: new Float32Array(pos.data), indices: null };
  const idx = read(prim['indices'], 1, [5121, 5123, 5125]);
  if (typeof idx === 'string') return idx;
  if (idx.data.some((i) => i >= pos.count)) return 'an index points past its vertices';
  return { positions: new Float32Array(pos.data), indices: new Uint32Array(idx.data) };
}

/**
 * The GLB with generated levels (`glb: null`: none could be made, the model
 * has authored ones, or the file cannot be read; the report says which).
 * `ratios` are the triangle shares of levels 1… (default
 * {@link MESH_LOD_RATIOS_DEFAULT}).
 */
export function generateGlbLods(glb: Uint8Array, simplifier: MeshSimplifier, ratios: readonly number[] = MESH_LOD_RATIOS_DEFAULT): { glb: Uint8Array | null; report: GlbLodReport | { error: string } } {
  const parts = readGlb(glb);
  if (typeof parts === 'string') return { glb: null, report: { error: parts } };
  const json = structuredClone(parts.json);
  const firstBuffer = list(json['buffers'])[0];
  if (isObj(firstBuffer) && firstBuffer['uri'] !== undefined) return { glb: null, report: { error: 'the geometry is in an external buffer, not the GLB' } };
  const bin = parts.bin ?? new Uint8Array(0);
  const report: GlbLodReport = { ratios: [...ratios], nodes: 0, triangles: [], maxError: 0, skipped: [] };
  const nodes = list(json['nodes']);
  if (nodes.some((n) => isObj(n) && typeof n['name'] === 'string' && LOD_RE.test(n['name']))) return { glb: null, report: { ...report, authored: true } };
  const meshes = list(json['meshes']);
  // Nodes an animation moves: a level beside one would stand still.
  const animated = new Set<number>();
  for (const a of list(json['animations'])) for (const c of isObj(a) ? list(a['channels']) : []) if (isObj(c) && isObj(c['target']) && typeof c['target']['node'] === 'number') animated.add(c['target']['node']);
  const parentOf = new Map<number, number>();
  nodes.forEach((n, i) => {
    if (isObj(n)) for (const c of list(n['children'])) if (typeof c === 'number') parentOf.set(c, i);
  });
  // Per mesh: its levels (each a list of index arrays, one per primitive), made once however many nodes draw it.
  const made = new Map<number, { levels: Uint32Array[][]; base: number } | string>();
  const levelsOf = (meshIndex: number): { levels: Uint32Array[][]; base: number } | string => {
    const cached = made.get(meshIndex);
    if (cached !== undefined) return cached;
    const mesh = meshes[meshIndex];
    let out: { levels: Uint32Array[][]; base: number } | string;
    if (!isObj(mesh)) out = 'its mesh is missing';
    else {
      const prims = list(mesh['primitives']);
      const per: SimplifiedMesh[][] = [];
      let base = 0;
      let why: string | null = null;
      for (const p of prims) {
        const g = primitiveGeometry(json, bin, p);
        if (typeof g === 'string') {
          why = g;
          break;
        }
        base += (g.indices?.length ?? g.positions.length / 3) / 3;
        per.push(simplifier.levels(g, ratios));
      }
      const count = why === null ? Math.max(0, ...per.map((l) => l.length)) : 0;
      if (why !== null) out = why;
      else if (count === 0) out = 'it cannot get simpler within the error bound';
      else {
        // A primitive that stopped earlier draws its last level at the coarser ones.
        const levels: Uint32Array[][] = [];
        for (let l = 0; l < count; l++) levels.push(per.map((p) => (p[Math.min(l, p.length - 1)] as SimplifiedMesh).indices));
        for (const p of per) for (const s of p) report.maxError = Math.max(report.maxError, s.error);
        out = { levels, base };
      }
    }
    made.set(meshIndex, out);
    return out;
  };

  const chunks: Uint8Array[] = [bin];
  let binLength = bin.byteLength;
  const views = list(json['bufferViews']);
  const accessors = list(json['accessors']);
  const indexAccessor = (indices: Uint32Array, vertexCount: number): number => {
    const small = vertexCount <= 65_535;
    const data = small ? new Uint16Array(indices) : indices;
    const pad = (4 - (binLength % 4)) % 4;
    if (pad > 0) chunks.push(new Uint8Array(pad));
    binLength += pad;
    views.push({ buffer: 0, byteOffset: binLength, byteLength: data.byteLength, target: ELEMENT_ARRAY_BUFFER });
    chunks.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    binLength += data.byteLength;
    accessors.push({ bufferView: views.length - 1, componentType: small ? 5123 : 5125, count: indices.length, type: 'SCALAR' });
    return accessors.length - 1;
  };
  const vertexCountOf = (prim: Json): number => {
    const acc = accessors[(prim['attributes'] as Json)['POSITION'] as number];
    return isObj(acc) ? (acc['count'] as number) : 0;
  };
  // Generated meshes per (mesh, level), shared by every node that draws the mesh.
  const levelMeshes = new Map<string, number>();
  const nodeCount = nodes.length;
  // Each node's triangles per level (LOD0 first), summed into the report at the end.
  const perNode: number[][] = [];
  // Level names are `<name>_LOD<n>`: a name two nodes share gets the node's index, so their levels do not mix.
  const named = new Map<string, number>();
  for (const n of nodes) if (isObj(n) && typeof n['name'] === 'string') named.set(n['name'], (named.get(n['name']) ?? 0) + 1);
  for (let i = 0; i < nodeCount; i++) {
    const node = nodes[i];
    if (!isObj(node) || typeof node['mesh'] !== 'number') continue;
    const own = typeof node['name'] === 'string' && node['name'] !== '' ? node['name'] : `mesh${i}`;
    const name = (named.get(own) ?? 0) > 1 ? `${own}.${i}` : own;
    const skip = (reason: string): void => void report.skipped.push({ node: name, reason });
    if (COL_RE.test(name)) continue;
    if (node['skin'] !== undefined) {
      skip('it is skinned');
      continue;
    }
    if (list(node['children']).length > 0) {
      skip('it has children (they would show at its finest level only)');
      continue;
    }
    if (node['weights'] !== undefined) {
      skip('it has morph weights');
      continue;
    }
    if (animated.has(i)) {
      skip('an animation moves it');
      continue;
    }
    const meshIndex = node['mesh'];
    const lv = levelsOf(meshIndex);
    if (typeof lv === 'string') {
      skip(lv);
      continue;
    }
    report.nodes += 1;
    const tris = [lv.base];
    perNode.push(tris);
    node['name'] = `${name}_LOD0`;
    const siblings: number[] = [];
    lv.levels.forEach((level, l) => {
      const key = `${meshIndex}:${l}`;
      let m = levelMeshes.get(key);
      if (m === undefined) {
        const mesh = meshes[meshIndex] as Json;
        const prims = list(mesh['primitives']) as Json[];
        meshes.push({ ...(typeof mesh['name'] === 'string' ? { name: `${mesh['name']}_LOD${l + 1}` } : {}), primitives: prims.map((p, k) => ({ ...p, indices: indexAccessor(level[k]!, vertexCountOf(p)) })) });
        m = meshes.length - 1;
        levelMeshes.set(key, m);
      }
      tris.push(level.reduce((n, x) => n + x.length / 3, 0));
      const copy: Json = { name: `${name}_LOD${l + 1}`, mesh: m };
      for (const k of ['matrix', 'translation', 'rotation', 'scale', 'extras']) if (node[k] !== undefined) copy[k] = structuredClone(node[k]);
      // Instancing goes with every level; a light on the node stays on LOD0 alone (one light, not one per level).
      if (isObj(node['extensions'])) {
        const { KHR_lights_punctual: _light, ...rest } = node['extensions'];
        if (Object.keys(rest).length > 0) copy['extensions'] = structuredClone(rest);
      }
      nodes.push(copy);
      siblings.push(nodes.length - 1);
    });
    // The levels sit beside the node: in its parent's children, or in each scene that lists it as a root.
    const parent = parentOf.get(i);
    if (parent !== undefined) {
      const p = nodes[parent] as Json;
      p['children'] = [...list(p['children']), ...siblings];
    } else {
      for (const scene of list(json['scenes'])) {
        if (isObj(scene) && list(scene['nodes']).includes(i)) scene['nodes'] = [...list(scene['nodes']), ...siblings];
      }
    }
  }
  const depth = Math.max(0, ...perNode.map((t) => t.length));
  report.triangles = Array.from({ length: depth }, (_, l) => perNode.reduce((n, t) => n + t[Math.min(l, t.length - 1)]!, 0));
  if (report.nodes === 0) return { glb: null, report };
  const out = new Uint8Array(binLength);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  json['nodes'] = nodes;
  json['meshes'] = meshes;
  json['bufferViews'] = views;
  json['accessors'] = accessors;
  const buffers = list(json['buffers']);
  if (buffers.length === 0) json['buffers'] = [{ byteLength: binLength }];
  else (buffers[0] as Json)['byteLength'] = binLength;
  return { glb: writeGlb(json, out), report };
}
