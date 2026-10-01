/**
 * Lightmap UVs (UV1) for a block-layer chunk: every face of the chunk's
 * merged mesh gets a place in one square lightmap per chunk, so a bake can
 * give block layers baked light like any static object.
 *
 * The layout is by cell and facing: each triangle belongs to the cell its
 * centre lies in (nudged inside along its normal) and to the axis it faces
 * most (±x, ±y, ±z); each such (cell, facing) pair is a slot, a square of the
 * chunk's lightmap in a grid of slots, and its triangles are projected onto
 * the facing's plane and stretched over the slot (inside a margin, so
 * filtering never reads the next slot). Every renderer, the editor's bake and
 * the running game build the same layout from the same mesh; its `layout`
 * digest (the slots and their projected extents) is stored with the bake, so
 * a chunk whose geometry changed since the bake is drawn without the stale
 * lightmap instead of with wrong texels.
 *
 * Vertices shared by triangles of different slots are split. Pure and
 * deterministic.
 */
import type { ChunkMeshPart } from './block-mesh';

/** The margin inside each slot, as a fraction of its side (a texel or two at usual densities). */
const SLOT_MARGIN = 0.08;

export interface ChunkLightmapLayout {
  /** The parts again, with `uv1` (vertices split where slots meet). */
  parts: ChunkMeshPart[];
  /** A digest of the slots and their extents (16 hex digits). */
  layout: string;
  /** Slots per side of the square layout. */
  side: number;
  /** The mesh's surface area in square metres (the lightmap's size follows it). */
  area: number;
  /** The slots by `x,y,z,facing` (another level of detail of the chunk maps into the same ones). */
  slots: ReadonlyMap<string, Readonly<Slot>>;
}

/** 64-bit FNV-1a over a string, as 16 hex digits (two 32-bit lanes). */
function digest(text: string): string {
  let a = 0x811c9dc5;
  let b = 0xcbf29ce4;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x01000193) >>> 0;
    b = (b ^ (a >>> 13)) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

export interface Slot {
  key: string;
  cell: [number, number, number];
  dir: number;
  minU: number;
  minV: number;
  maxU: number;
  maxV: number;
  index: number;
}

/** The two coordinates a facing projects onto: ±x → (z, y), ±y → (x, z), ±z → (x, y). */
const PLANE: readonly (readonly [number, number])[] = [
  [2, 1],
  [2, 1],
  [0, 2],
  [0, 2],
  [0, 1],
  [0, 1],
];

/**
 * The lightmap layout of a chunk's parts (layer-local metres, as the mesher
 * gives them). With `reference` (the layout of the chunk's most detailed
 * level), the parts of a coarser level map into the reference's slots: the
 * same planar projection, so a face of the coarse level reads the texels of
 * the detailed faces at its place (a face whose cell and facing the detailed
 * level lacks takes a slot of the same cell, else the first).
 *
 * `shading` names how the chunk was meshed when that changes what a bake sees
 * without moving a face (smoothed normals): it goes into the digest, so a bake
 * made before such a change no longer matches the chunk. Absent: the digest
 * is the faces' alone, as it always was.
 */
export function chunkLightmapLayout(parts: readonly ChunkMeshPart[], cellSize: readonly number[], reference?: ChunkLightmapLayout, shading?: string): ChunkLightmapLayout {
  const slots = new Map<string, Slot>();
  const triSlot: Slot[][] = [];
  let area = 0;
  const p = (part: ChunkMeshPart, i: number, k: number): number => part.positions[part.indices[i]! * 3 + k]!;
  for (const part of parts) {
    const list: Slot[] = [];
    for (let i = 0; i < part.indices.length; i += 3) {
      const ex = [p(part, i + 1, 0) - p(part, i, 0), p(part, i + 1, 1) - p(part, i, 1), p(part, i + 1, 2) - p(part, i, 2)];
      const fx = [p(part, i + 2, 0) - p(part, i, 0), p(part, i + 2, 1) - p(part, i, 1), p(part, i + 2, 2) - p(part, i, 2)];
      const n = [ex[1]! * fx[2]! - ex[2]! * fx[1]!, ex[2]! * fx[0]! - ex[0]! * fx[2]!, ex[0]! * fx[1]! - ex[1]! * fx[0]!];
      const len = Math.hypot(n[0]!, n[1]!, n[2]!);
      area += len / 2;
      const ax = Math.abs(n[0]!) >= Math.abs(n[1]!) && Math.abs(n[0]!) >= Math.abs(n[2]!) ? 0 : Math.abs(n[1]!) >= Math.abs(n[2]!) ? 1 : 2;
      const dir = ax * 2 + (n[ax]! >= 0 ? 0 : 1);
      // The cell the face belongs to: its centre, a hair inside along its normal (a face on a cell side belongs to its own cell).
      const nudge = (k: number): number => (len > 0 ? (n[k]! / len) * 1e-4 * cellSize[k]! : 0);
      const cell: [number, number, number] = [0, 1, 2].map((k) => Math.floor(((p(part, i, k) + p(part, i + 1, k) + p(part, i + 2, k)) / 3 - nudge(k)) / cellSize[k]!)) as [number, number, number];
      const key = `${cell[0]},${cell[1]},${cell[2]},${dir}`;
      if (reference !== undefined) {
        const cellKey = `${cell[0]},${cell[1]},${cell[2]},`;
        const ref = reference.slots.get(key) ?? [...reference.slots.values()].find((x) => x.key.startsWith(cellKey)) ?? reference.slots.values().next().value;
        if (ref !== undefined) {
          list.push(ref as Slot);
          continue;
        }
      }
      let s = slots.get(key);
      if (s === undefined) {
        s = { key, cell, dir, minU: Infinity, minV: Infinity, maxU: -Infinity, maxV: -Infinity, index: -1 };
        slots.set(key, s);
      }
      const [u, v] = PLANE[dir]!;
      for (let k = 0; k < 3; k++) {
        s.minU = Math.min(s.minU, p(part, i + k, u));
        s.maxU = Math.max(s.maxU, p(part, i + k, u));
        s.minV = Math.min(s.minV, p(part, i + k, v));
        s.maxV = Math.max(s.maxV, p(part, i + k, v));
      }
      list.push(s);
    }
    triSlot.push(list);
  }
  const ordered = [...slots.values()].sort((a, b) => a.cell[1] - b.cell[1] || a.cell[2] - b.cell[2] || a.cell[0] - b.cell[0] || a.dir - b.dir);
  ordered.forEach((s, i) => (s.index = i));
  const side = reference?.side ?? Math.max(1, Math.ceil(Math.sqrt(ordered.length)));
  const round = (x: number): number => Math.round(x * 1e4);
  const layout = reference?.layout ?? digest(`${shading !== undefined && shading !== '' ? `${shading}|` : ''}${side}|${ordered.map((s) => `${s.key}:${round(s.minU)},${round(s.minV)},${round(s.maxU)},${round(s.maxV)}`).join(';')}`);
  const out = parts.map((part, pi) => {
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const uv1: number[] = [];
    const indices: number[] = [];
    const at = new Map<string, number>();
    const list = triSlot[pi]!;
    for (let i = 0; i < part.indices.length; i += 3) {
      const s = list[i / 3]!;
      const [u, v] = PLANE[s.dir]!;
      const col = s.index % side;
      const row = Math.floor(s.index / side);
      const du = s.maxU - s.minU;
      const dv = s.maxV - s.minV;
      for (let k = 0; k < 3; k++) {
        const vi = part.indices[i + k]!;
        const key = `${vi}|${s.index}`;
        let o = at.get(key);
        if (o === undefined) {
          o = positions.length / 3;
          at.set(key, o);
          positions.push(part.positions[vi * 3]!, part.positions[vi * 3 + 1]!, part.positions[vi * 3 + 2]!);
          normals.push(part.normals[vi * 3]!, part.normals[vi * 3 + 1]!, part.normals[vi * 3 + 2]!);
          uvs.push(part.uvs[vi * 2]!, part.uvs[vi * 2 + 1]!);
          // Clamped: a coarser level's face reaching past the detailed extent stays inside the slot.
          const fu = du > 0 ? Math.min(1, Math.max(0, (part.positions[vi * 3 + u]! - s.minU) / du)) : 0.5;
          const fv = dv > 0 ? Math.min(1, Math.max(0, (part.positions[vi * 3 + v]! - s.minV) / dv)) : 0.5;
          uv1.push((col + SLOT_MARGIN + fu * (1 - 2 * SLOT_MARGIN)) / side, (row + SLOT_MARGIN + fv * (1 - 2 * SLOT_MARGIN)) / side);
        }
        indices.push(o);
      }
    }
    return { ...part, positions: new Float32Array(positions), normals: new Float32Array(normals), uvs: new Float32Array(uvs), uv1: new Float32Array(uv1), indices: new Uint32Array(indices) };
  });
  return { parts: out, layout, side, area, slots: reference?.slots ?? slots };
}
