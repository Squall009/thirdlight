/**
 * Phase 23.5 (E8): meshing a block layer chunk — the stand-in shapes (full,
 * half, ramp, stairs, custom boxes), the hidden-face removal between
 * neighbours, and the merged per-chunk geometry the renderer draws (one
 * part per block look and material) and the collision triangles the 3D
 * physics port takes (one triangle mesh per chunk, split to the port's
 * mesh limits).
 *
 * Hidden faces: a triangle lying on one of its cell's six boundary planes is
 * dropped when the neighbour across that plane is solid (fills its cell), or
 * shows the very same face profile on the opposite side (two half blocks side
 * by side, two ramps next to each other). That works for any mesh whose outer
 * faces lie on the cell boundary — the stand-ins and kit models alike — and
 * never drops a triangle that could be seen. Multi-cell footprints keep all
 * their faces and never hide a neighbour's.
 *
 * Block-local frame: the origin at the bottom centre of the block's
 * footprint, +Y up, metres; a rotation turns it about +Y counter-clockwise
 * seen from above (x' = x cos + z sin, z' = −x sin + z cos — three.js's
 * rotation.y). Ramps and stairs rise toward +Z at rotation 0.
 */
import { CHUNK_SIZE, blockTypeSolid, rotatedFootprint, type BlockCell, type BlockShape, type BlockType } from './block-layers';
import { autoVariant, chunkKeyOf, type BlockGrid } from './block-grid';

/** Indexed triangles in the block-local frame; `groups` split the index list by material. */
export interface BlockMeshSource {
  positions: Float32Array;
  normals: Float32Array;
  uvs?: Float32Array;
  indices: Uint32Array;
  groups: { start: number; count: number; material: number }[];
}

// ---- stand-in shapes -----------------------------------------------------------------

interface Quad {
  p: [number, number, number][];
  n: [number, number, number];
}

function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Quad[] {
  return [
    { p: [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], n: [1, 0, 0] },
    { p: [[x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0]], n: [-1, 0, 0] },
    { p: [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]], n: [0, 1, 0] },
    { p: [[x0, y0, z1], [x0, y0, z0], [x1, y0, z0], [x1, y0, z1]], n: [0, -1, 0] },
    { p: [[x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [x0, y0, z1]], n: [0, 0, 1] },
    { p: [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]], n: [0, 0, -1] },
  ];
}

function quadsToSource(quads: readonly Quad[]): BlockMeshSource {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (const q of quads) {
    const base = positions.length / 3;
    for (const v of q.p) {
      positions.push(v[0], v[1], v[2]);
      normals.push(q.n[0], q.n[1], q.n[2]);
    }
    if (q.p.length === 4) indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    else indices.push(base, base + 1, base + 2);
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), indices: new Uint32Array(indices), groups: [{ start: 0, count: indices.length, material: 0 }] };
}

/** Drop box faces that meet another box's opposite face over their whole area (custom shapes). */
function withoutInnerFaces(boxes: readonly number[][]): Quad[] {
  const all = boxes.map((b) => box(b[0]!, b[1]!, b[2]!, b[3]!, b[4]!, b[5]!));
  const out: Quad[] = [];
  const eps = 1e-6;
  all.forEach((faces, i) => {
    for (const f of faces) {
      const axis = f.n[0] !== 0 ? 0 : f.n[1] !== 0 ? 1 : 2;
      const plane = f.p[0]![axis]!;
      const others = [0, 1, 2].filter((a) => a !== axis);
      const lo = others.map((a) => Math.min(...f.p.map((v) => v[a]!)));
      const hi = others.map((a) => Math.max(...f.p.map((v) => v[a]!)));
      const covered = boxes.some((b, j) => {
        if (j === i) return false;
        // The other box touches this face's plane from the outside.
        const inside = f.n[axis]! > 0 ? Math.abs(b[axis]! - plane) < eps : Math.abs(b[axis + 3]! - plane) < eps;
        if (!inside) return false;
        return others.every((a, k) => b[a]! <= lo[k]! + eps && b[a + 3]! >= hi[k]! - eps);
      });
      if (!covered) out.push(f);
    }
  });
  return out;
}

/**
 * The stand-in / collision geometry of a shape for a footprint of `w × h × d`
 * metres (`none` gives a full box: a look without collision).
 */
export function shapeSource(shape: BlockShape, w: number, h: number, d: number, boxes?: readonly number[][]): BlockMeshSource {
  const x0 = -w / 2;
  const x1 = w / 2;
  const z0 = -d / 2;
  const z1 = d / 2;
  switch (shape) {
    case 'half':
      return quadsToSource(box(x0, 0, z0, x1, h / 2, z1));
    case 'ramp': {
      const s = Math.hypot(h, d);
      return quadsToSource([
        { p: [[x0, 0, z1], [x0, 0, z0], [x1, 0, z0], [x1, 0, z1]], n: [0, -1, 0] },
        { p: [[x1, 0, z1], [x1, h, z1], [x0, h, z1], [x0, 0, z1]], n: [0, 0, 1] },
        { p: [[x0, 0, z0], [x0, h, z1], [x1, h, z1], [x1, 0, z0]], n: [0, d / s, -h / s] },
        { p: [[x1, 0, z0], [x1, h, z1], [x1, 0, z1]], n: [1, 0, 0] },
        { p: [[x0, 0, z1], [x0, h, z1], [x0, 0, z0]], n: [-1, 0, 0] },
      ]);
    }
    case 'stairs': {
      const hm = h / 2;
      return quadsToSource([
        { p: [[x0, 0, z1], [x0, 0, z0], [x1, 0, z0], [x1, 0, z1]], n: [0, -1, 0] },
        { p: [[x1, 0, z1], [x1, h, z1], [x0, h, z1], [x0, 0, z1]], n: [0, 0, 1] },
        { p: [[x0, 0, z0], [x0, hm, z0], [x1, hm, z0], [x1, 0, z0]], n: [0, 0, -1] },
        { p: [[x0, hm, z0], [x0, hm, 0], [x1, hm, 0], [x1, hm, z0]], n: [0, 1, 0] },
        { p: [[x0, hm, 0], [x0, h, 0], [x1, h, 0], [x1, hm, 0]], n: [0, 0, -1] },
        { p: [[x0, h, 0], [x0, h, z1], [x1, h, z1], [x1, h, 0]], n: [0, 1, 0] },
        { p: [[x1, 0, z0], [x1, hm, z0], [x1, hm, 0], [x1, 0, 0]], n: [1, 0, 0] },
        { p: [[x1, 0, 0], [x1, h, 0], [x1, h, z1], [x1, 0, z1]], n: [1, 0, 0] },
        { p: [[x0, 0, 0], [x0, hm, 0], [x0, hm, z0], [x0, 0, z0]], n: [-1, 0, 0] },
        { p: [[x0, 0, z1], [x0, h, z1], [x0, h, 0], [x0, 0, 0]], n: [-1, 0, 0] },
      ]);
    }
    case 'custom': {
      const bs = (boxes ?? [[0, 0, 0, 1, 1, 1]]).map((b) => [x0 + b[0]! * w, b[1]! * h, z0 + b[2]! * d, x0 + b[3]! * w, b[4]! * h, z0 + b[5]! * d]);
      return quadsToSource(withoutInnerFaces(bs));
    }
    default:
      return quadsToSource(box(x0, 0, z0, x1, h, z1));
  }
}

// ---- face classification ------------------------------------------------------------

/** Sides: 0 +X, 1 −X, 2 +Y, 3 −Y, 4 +Z, 5 −Z; −1 interior. */
const OPPOSITE = [1, 0, 3, 2, 5, 4];
const SIDE_OFFSET: [number, number, number][] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

/** A source turned by a rotation, its triangles' sides and the profile key per side. */
interface Classified {
  positions: Float32Array;
  normals: Float32Array;
  side: Int8Array;
  profile: string[];
}

function rotateXZ(x: number, z: number, rot: number): [number, number] {
  switch (rot) {
    case 90:
      return [z, -x];
    case 180:
      return [-x, -z];
    case 270:
      return [-z, x];
    default:
      return [x, z];
  }
}

const classifiedCache = new WeakMap<BlockMeshSource, Map<string, Classified>>();

function classify(src: BlockMeshSource, rot: number, w: number, h: number, d: number): Classified {
  let byKey = classifiedCache.get(src);
  if (byKey === undefined) {
    byKey = new Map();
    classifiedCache.set(src, byKey);
  }
  const key = `${rot}|${w}|${h}|${d}`;
  const hit = byKey.get(key);
  if (hit !== undefined) return hit;
  const n = src.positions.length / 3;
  const positions = new Float32Array(n * 3);
  const normals = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const [x, z] = rotateXZ(src.positions[i * 3]!, src.positions[i * 3 + 2]!, rot);
    positions[i * 3] = x;
    positions[i * 3 + 1] = src.positions[i * 3 + 1]!;
    positions[i * 3 + 2] = z;
    const [nx, nz] = rotateXZ(src.normals[i * 3]!, src.normals[i * 3 + 2]!, rot);
    normals[i * 3] = nx;
    normals[i * 3 + 1] = src.normals[i * 3 + 1]!;
    normals[i * 3 + 2] = nz;
  }
  const tris = src.indices.length / 3;
  const side = new Int8Array(tris).fill(-1);
  const planes = [w / 2, -w / 2, h, 0, d / 2, -d / 2];
  const eps = 1e-4 * Math.max(w, h, d);
  // A side's profile: the set of its boundary points projected onto the side
  // plane plus the area they cover (independent of how a face is triangulated).
  const points: Set<string>[] = [new Set(), new Set(), new Set(), new Set(), new Set(), new Set()];
  const area = [0, 0, 0, 0, 0, 0];
  for (let t = 0; t < tris; t++) {
    const a = src.indices[t * 3]!;
    const b = src.indices[t * 3 + 1]!;
    const c = src.indices[t * 3 + 2]!;
    for (let s = 0; s < 6; s++) {
      const axis = s >> 1;
      const plane = planes[s]!;
      if (Math.abs(positions[a * 3 + axis]! - plane) < eps && Math.abs(positions[b * 3 + axis]! - plane) < eps && Math.abs(positions[c * 3 + axis]! - plane) < eps) {
        side[t] = s;
        const [u, v] = [0, 1, 2].filter((x) => x !== axis) as [number, number];
        for (const p of [a, b, c]) points[s]!.add(`${Math.round(positions[p * 3 + u]! * 1e4)}:${Math.round(positions[p * 3 + v]! * 1e4)}`);
        const e1u = positions[b * 3 + u]! - positions[a * 3 + u]!;
        const e1v = positions[b * 3 + v]! - positions[a * 3 + v]!;
        const e2u = positions[c * 3 + u]! - positions[a * 3 + u]!;
        const e2v = positions[c * 3 + v]! - positions[a * 3 + v]!;
        area[s] = area[s]! + Math.abs(e1u * e2v - e1v * e2u) / 2;
        break;
      }
    }
  }
  const profile = points.map((set, s) => (set.size === 0 ? '' : `${[...set].sort().join('/')}#${Math.round(area[s]! * 1e4)}`));
  const out = { positions, normals, side, profile };
  byKey.set(key, out);
  return out;
}

// ---- chunk meshing --------------------------------------------------------------------

/** One merged part of a chunk mesh (a block look × material), in layer-local metres. */
export interface ChunkMeshPart {
  /** `<source key>#<material>` — the renderer's draw-group key. */
  key: string;
  blockId: string;
  variant: number;
  material: number;
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
}

/** What the mesher needs per block cell: the source to draw (null: nothing), and a key naming it. */
export interface BlockLookResolver {
  /** The look of a block type's variant (a stand-in or a model's geometry); null while not loaded (nothing drawn yet). */
  source(type: BlockType, variant: number, footprintMetres: [number, number, number]): { key: string; source: BlockMeshSource } | null;
  /** Whether a block type hides neighbours' faces (default: `blockTypeSolid`). */
  solid?(type: BlockType): boolean;
}

interface CellLook {
  type: BlockType;
  variant: number;
  rot: number;
  single: boolean;
  classified: Classified | null;
  key: string | null;
  source: BlockMeshSource | null;
}

class Accumulator {
  positions: number[] = [];
  normals: number[] = [];
  uvs: number[] = [];
  indices: number[] = [];
}

/**
 * The merged geometry of one chunk: for each block cell of the chunk its
 * look, turned and placed, with the faces hidden by neighbours left out.
 * Positions are relative to the layer origin (the min corner of cell 0).
 */
export function meshBlockChunk(grid: BlockGrid, cx: number, cz: number, types: ReadonlyMap<string, BlockType>, looks: BlockLookResolver): ChunkMeshPart[] {
  const cs = grid.cellSize;
  const lookCache = new Map<number, CellLook | null>();
  const lookOf = (x: number, y: number, z: number): CellLook | null => {
    const idx = grid.indexAt(x, y, z);
    if (idx < 0) return null;
    const cell = grid.valueOf(idx);
    if (cell.block === undefined) return null;
    const t = types.get(cell.block);
    if (t === undefined) return null;
    const auto = cell.variant === undefined && t.variants.length > 1;
    const cacheKey = auto ? -1 : idx;
    if (!auto && lookCache.has(cacheKey)) return lookCache.get(cacheKey)!;
    const variant = cell.variant ?? autoVariant(t, x, y, z);
    const f = rotatedFootprint(t, 0);
    const fm: [number, number, number] = [f[0] * cs[0]!, f[1] * cs[1]!, f[2] * cs[2]!];
    const single = f[0] === 1 && f[1] === 1 && f[2] === 1;
    const src = looks.source(t, variant, fm);
    const rot = cell.rot ?? 0;
    const look: CellLook = { type: t, variant, rot, single, classified: src !== null && single ? classify(src.source, rot, fm[0], fm[1], fm[2]) : null, key: src?.key ?? null, source: src?.source ?? null };
    if (!auto) lookCache.set(cacheKey, look);
    return look;
  };
  const solidOf = (t: BlockType): boolean => (looks.solid !== undefined ? looks.solid(t) : blockTypeSolid(t));
  const parts = new Map<string, { acc: Accumulator; blockId: string; variant: number; material: number }>();
  grid.forEachInChunk(chunkKeyOf(cx, cz), (x, y, z, idx) => {
    const cell: BlockCell = grid.valueOf(idx);
    if (cell.block === undefined) return;
    const look = lookOf(x, y, z);
    if (look === null || look.source === null || look.key === null) return;
    const src = look.source;
    const f = rotatedFootprint(look.type, look.rot);
    // The block origin: the bottom centre of its (turned) footprint.
    const ox = (x + f[0] / 2) * cs[0]!;
    const oy = y * cs[1]!;
    const oz = (z + f[2] / 2) * cs[2]!;
    // Which sides are hidden.
    const hidden = [false, false, false, false, false, false];
    if (look.classified !== null) {
      for (let s = 0; s < 6; s++) {
        if (look.classified.profile[s] === '') continue;
        const o = SIDE_OFFSET[s]!;
        const nb = lookOf(x + o[0], y + o[1], z + o[2]);
        if (nb === null || !nb.single) continue;
        if (solidOf(nb.type)) hidden[s] = true;
        else if (nb.classified !== null && nb.classified.profile[OPPOSITE[s]!] === look.classified.profile[s]) hidden[s] = true;
      }
    }
    const rotated = look.classified ?? classifyUnculled(src, look.rot);
    for (const g of src.groups) {
      const key = `${look.key}#${g.material}`;
      let part = parts.get(key);
      if (part === undefined) {
        part = { acc: new Accumulator(), blockId: look.type.blockId, variant: look.variant, material: g.material };
        parts.set(key, part);
      }
      const acc = part.acc;
      const remap = new Map<number, number>();
      for (let i = g.start; i < g.start + g.count; i += 3) {
        const t = i / 3;
        const s = look.classified !== null ? look.classified.side[t]! : -1;
        if (s >= 0 && hidden[s]) continue;
        for (let k = 0; k < 3; k++) {
          const v = src.indices[i + k]!;
          let out = remap.get(v);
          if (out === undefined) {
            out = acc.positions.length / 3;
            remap.set(v, out);
            const px = rotated.positions[v * 3]! + ox;
            const py = rotated.positions[v * 3 + 1]! + oy;
            const pz = rotated.positions[v * 3 + 2]! + oz;
            acc.positions.push(px, py, pz);
            const nx = rotated.normals[v * 3]!;
            const ny = rotated.normals[v * 3 + 1]!;
            const nz = rotated.normals[v * 3 + 2]!;
            acc.normals.push(nx, ny, nz);
            if (src.uvs !== undefined) acc.uvs.push(src.uvs[v * 2]!, src.uvs[v * 2 + 1]!);
            else {
              // World-aligned planar UVs (one unit per cell) for the stand-ins.
              const ax = Math.abs(nx);
              const ay = Math.abs(ny);
              const az = Math.abs(nz);
              if (ay >= ax && ay >= az) acc.uvs.push(px / cs[0]!, pz / cs[2]!);
              else if (ax >= az) acc.uvs.push(pz / cs[2]!, py / cs[1]!);
              else acc.uvs.push(px / cs[0]!, py / cs[1]!);
            }
          }
          acc.indices.push(out);
        }
      }
    }
  });
  const out: ChunkMeshPart[] = [];
  for (const [key, p] of [...parts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (p.acc.indices.length === 0) continue;
    out.push({ key, blockId: p.blockId, variant: p.variant, material: p.material, positions: new Float32Array(p.acc.positions), normals: new Float32Array(p.acc.normals), uvs: new Float32Array(p.acc.uvs), indices: new Uint32Array(p.acc.indices) });
  }
  return out;
}

const unculledCache = new WeakMap<BlockMeshSource, Map<number, Classified>>();
function classifyUnculled(src: BlockMeshSource, rot: number): Classified {
  let m = unculledCache.get(src);
  if (m === undefined) {
    m = new Map();
    unculledCache.set(src, m);
  }
  const hit = m.get(rot);
  if (hit !== undefined) return hit;
  // No boundary planes to match: every triangle is interior (kept).
  const c = classify(src, rot, Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE);
  const kept = { ...c, side: new Int8Array(c.side.length).fill(-1), profile: ['', '', '', '', '', ''] };
  m.set(rot, kept);
  return kept;
}

// ---- collision ---------------------------------------------------------------------------

const collisionSources = new Map<string, BlockMeshSource>();

function collisionSourceOf(t: BlockType, fm: [number, number, number]): BlockMeshSource | null {
  if (t.shape === 'none') return null;
  const key = `${t.shape}|${fm.join(',')}|${JSON.stringify(t.boxes ?? null)}`;
  let s = collisionSources.get(key);
  if (s === undefined) {
    if (collisionSources.size > 4096) collisionSources.clear();
    s = shapeSource(t.shape, fm[0], fm[1], fm[2], t.boxes);
    collisionSources.set(key, s);
  }
  return s;
}

/** A 3D port triangle mesh (flat lists, layer-local metres). */
export interface CollisionMeshPiece {
  vertices: number[];
  indices: number[];
}

/** The port's mesh limits (physics-rapier `MAX_MESH_VERTICES_3D` / `MAX_MESH_TRIANGLES_3D`). */
export const COLLISION_PIECE_LIMITS = Object.freeze({ vertices: 1024, triangles: 2048 });

/**
 * The collision triangles of one chunk from its blocks' collision shapes
 * (faces between neighbours hidden with the collision rule: a neighbour with
 * a full single-cell shape, or the same face profile), vertices merged, split
 * into pieces within the port's mesh limits. Empty: nothing to collide with.
 */
export function collisionMeshChunk(grid: BlockGrid, cx: number, cz: number, types: ReadonlyMap<string, BlockType>): CollisionMeshPiece[] {
  const parts = meshBlockChunk(grid, cx, cz, types, {
    source: (t, _v, fm) => {
      const s = collisionSourceOf(t, fm);
      return s === null ? null : { key: 'c', source: s };
    },
    solid: (t) => t.shape === 'full' && (t.footprint === undefined || (t.footprint[0] === 1 && t.footprint[1] === 1 && t.footprint[2] === 1)),
  });
  // Merge vertices (1e-4 m grid) and collect the triangles.
  const tris: number[] = [];
  const verts: number[] = [];
  const at = new Map<string, number>();
  const vid = (x: number, y: number, z: number): number => {
    const k = `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
    let i = at.get(k);
    if (i === undefined) {
      i = verts.length / 3;
      at.set(k, i);
      verts.push(x, y, z);
    }
    return i;
  };
  for (const p of parts) {
    for (let i = 0; i < p.indices.length; i += 3) {
      const a = p.indices[i]!;
      const b = p.indices[i + 1]!;
      const c = p.indices[i + 2]!;
      const ia = vid(p.positions[a * 3]!, p.positions[a * 3 + 1]!, p.positions[a * 3 + 2]!);
      const ib = vid(p.positions[b * 3]!, p.positions[b * 3 + 1]!, p.positions[b * 3 + 2]!);
      const ic = vid(p.positions[c * 3]!, p.positions[c * 3 + 1]!, p.positions[c * 3 + 2]!);
      if (ia === ib || ib === ic || ia === ic) continue;
      tris.push(ia, ib, ic);
    }
  }
  // Split into pieces within the limits (triangles in order; vertices remapped per piece).
  const pieces: CollisionMeshPiece[] = [];
  let cur: CollisionMeshPiece = { vertices: [], indices: [] };
  let remap = new Map<number, number>();
  for (let i = 0; i < tris.length; i += 3) {
    const need = [tris[i]!, tris[i + 1]!, tris[i + 2]!].filter((v) => !remap.has(v)).length;
    if (cur.indices.length / 3 >= COLLISION_PIECE_LIMITS.triangles || remap.size + need > COLLISION_PIECE_LIMITS.vertices) {
      pieces.push(cur);
      cur = { vertices: [], indices: [] };
      remap = new Map();
    }
    for (let k = 0; k < 3; k++) {
      const v = tris[i + k]!;
      let o = remap.get(v);
      if (o === undefined) {
        o = remap.size;
        remap.set(v, o);
        cur.vertices.push(verts[v * 3]!, verts[v * 3 + 1]!, verts[v * 3 + 2]!);
      }
      cur.indices.push(o);
    }
  }
  if (cur.indices.length > 0) pieces.push(cur);
  return pieces;
}

/** The chunk (cx, cz) holding a cell column. */
export function chunkOfCell(x: number, z: number): [number, number] {
  return [Math.floor(x / CHUNK_SIZE), Math.floor(z / CHUNK_SIZE)];
}
