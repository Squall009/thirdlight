/**
 * Mesh simplification: coarser levels of detail for meshes that have no
 * authored ones — models imported without `<piece>_LOD<n>` nodes, and the
 * meshes the engine makes itself (spline meshes, merged far tiles, impostor
 * proxies).
 *
 * meshoptimizer's simplifier (the pinned WebAssembly build) collapses edges
 * by quadric error and keeps the mesh's vertices: a level is a new index list
 * over the same vertex data, so levels share their vertex buffers. Attribute
 * seams (UV and normal splits) stay where they are; the error is measured as a
 * share of the mesh's extent, so the same settings suit a pebble and a tower.
 *
 * Pure: no I/O. The WebAssembly module loads on first use, so a package that
 * imports this one pays nothing until it simplifies.
 */

import { MESH_LOD_RATIOS_DEFAULT } from '@thirdlight/project-model/limits';

/**
 * How far level 1 (half the triangles) may move the surface: 1 % of the
 * mesh's extent. A coarser level is shown smaller on screen, so its bound
 * grows with it: level n may deviate `MESH_SIMPLIFY_ERROR_DEFAULT × 0.5 / ratio`
 * (2 % at a quarter, 4 % at an eighth).
 */
export const MESH_SIMPLIFY_ERROR_DEFAULT = 0.01;
/** A level is kept only below this share of the previous level's triangles (a smaller step costs a switch and saves little). */
export const MESH_LOD_KEEP_SHARE = 0.8;

export interface SimplifyMeshInput {
  /** xyz per vertex. */
  positions: Float32Array;
  /** A triangle list (null: the vertices in order, three a triangle). */
  indices: Uint32Array | Uint16Array | null;
  /**
   * Vertex attributes whose look the simplifier keeps (normals, UVs), each
   * vertex's `stride` floats, and how much each float counts against a
   * position's error.
   */
  attributes?: { data: Float32Array; stride: number; weights: readonly number[] };
}

export interface SimplifyOptions {
  /** The share of the triangles to keep, (0, 1]. */
  ratio: number;
  /** The most the surface may move, as a share of the mesh's extent (default: `MESH_SIMPLIFY_ERROR_DEFAULT × 0.5 / ratio`). */
  maxError?: number;
  /** Keep the open edges where they are (a piece that meets another, a chunk border). */
  lockBorder?: boolean;
}

export interface SimplifiedMesh {
  /** The level's triangle list over the input's vertices. */
  indices: Uint32Array;
  triangles: number;
  /**
   * How far the surface moved, as a share of the mesh's extent: the
   * simplifier's quadric estimate (the measured distance of the original
   * vertices from the new surface can be up to about twice it).
   */
  error: number;
  /** The same in the positions' units. */
  errorAbsolute: number;
}

export interface MeshSimplifier {
  /** One coarser version of a mesh. */
  simplify(input: SimplifyMeshInput, options: SimplifyOptions): SimplifiedMesh;
  /**
   * Levels 1… of a mesh at the given triangle shares of the original
   * (default {@link MESH_LOD_RATIOS_DEFAULT}), each made from the one before.
   * The chain stops at the first level that is not below
   * {@link MESH_LOD_KEEP_SHARE} of the previous one's triangles (its error
   * bound was reached first), so a mesh that cannot get simpler gets fewer
   * levels or none.
   */
  levels(input: SimplifyMeshInput, ratios?: readonly number[], options?: { lockBorder?: boolean }): SimplifiedMesh[];
}

type Meshopt = (typeof import('meshoptimizer/simplifier'))['MeshoptSimplifier'];

let loading: Promise<MeshSimplifier> | null = null;

/** The simplifier, its WebAssembly module loaded (once per process or page). */
export function loadMeshSimplifier(): Promise<MeshSimplifier> {
  loading ??= import('meshoptimizer/simplifier').then(async ({ MeshoptSimplifier }) => {
    if (!MeshoptSimplifier.supported) throw new Error('mesh simplification needs WebAssembly');
    await MeshoptSimplifier.ready;
    return simplifierOver(MeshoptSimplifier);
  });
  return loading;
}

function simplifierOver(m: Meshopt): MeshSimplifier {
  const indicesOf = (input: SimplifyMeshInput): Uint32Array => {
    if (input.indices instanceof Uint32Array) return input.indices;
    if (input.indices !== null) return new Uint32Array(input.indices);
    const n = input.positions.length / 3 - ((input.positions.length / 3) % 3);
    const out = new Uint32Array(n);
    for (let i = 0; i < n; i++) out[i] = i;
    return out;
  };
  const run = (input: SimplifyMeshInput, indices: Uint32Array, targetIndices: number, maxError: number, lockBorder: boolean): [Uint32Array, number] => {
    const flags: ('LockBorder' | 'ErrorAbsolute')[] = lockBorder ? ['LockBorder'] : [];
    const a = input.attributes;
    if (a !== undefined && a.stride > 0) return m.simplifyWithAttributes(indices, input.positions, 3, a.data, a.stride, [...a.weights], null, targetIndices, maxError, flags);
    return m.simplify(indices, input.positions, 3, targetIndices, maxError, flags);
  };
  const check = (input: SimplifyMeshInput, ratio: number): void => {
    if (!(ratio > 0 && ratio <= 1)) throw new RangeError(`a triangle share is in (0, 1], not ${ratio}`);
    if (input.positions.length % 3 !== 0) throw new RangeError('positions are xyz per vertex');
  };
  const errorFor = (ratio: number, maxError: number | undefined): number => maxError ?? (MESH_SIMPLIFY_ERROR_DEFAULT * 0.5) / ratio;
  const target = (indexCount: number, ratio: number): number => Math.max(3, Math.floor((indexCount * ratio) / 3) * 3);

  return {
    simplify(input, options) {
      check(input, options.ratio);
      const indices = indicesOf(input);
      const [out, error] = run(input, indices, Math.min(indices.length, target(indices.length, options.ratio)), errorFor(options.ratio, options.maxError), options.lockBorder === true);
      return { indices: out, triangles: out.length / 3, error, errorAbsolute: error * m.getScale(input.positions, 3) };
    },
    levels(input, ratios = MESH_LOD_RATIOS_DEFAULT, options = {}) {
      const original = indicesOf(input);
      const scale = m.getScale(input.positions, 3);
      const out: SimplifiedMesh[] = [];
      let from = original;
      for (const ratio of ratios) {
        check(input, ratio);
        const [indices, error] = run(input, from, Math.min(from.length, target(original.length, ratio)), errorFor(ratio, undefined), options.lockBorder === true);
        if (indices.length === 0 || indices.length > from.length * MESH_LOD_KEEP_SHARE) break;
        // The error of a level made from the one before adds up along the chain: kept as the sum, an upper bound.
        const total = error + (out.at(-1)?.error ?? 0);
        out.push({ indices, triangles: indices.length / 3, error: total, errorAbsolute: total * scale });
        from = indices;
      }
      return out;
    },
  };
}
