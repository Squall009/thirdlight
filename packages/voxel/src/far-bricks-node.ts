/**
 * A far node's bricks marched as one: the ray enters the node's box (the
 * union of its bricks' marched boxes) once and walks its 4³ bricks in ray
 * order (a 3D DDA over the node's brick table), marching only the stored
 * bricks over their own boxes and stepping over the rest in one step each,
 * so a pixel costs one fragment a node instead of one a brick its ray
 * crosses. The draw in three-adapter `voxel-far-bricks.ts` (its node
 * march) is this function's port.
 *
 * Why it finds what the brick-by-brick draw found: a brick's march here is
 * that draw's march over the same box from the same entry; bricks the DDA
 * steps over are those the build did not store (no sign change: nothing to
 * draw), and the stored ones are visited front to back, so the first hit
 * is the nearest one (`far-bricks-node.test.ts` against every brick).
 */
import { DISTANCE_BRICK_CELLS } from './distance-brick-format';
import { FAR_BRICK_BLOCK_BYTES, FAR_BRICK_BOUNDS_BYTES, FAR_BRICK_LIP_CELLS, marchBrickBox, type FarBricks } from './far-bricks';

/** A box in node cells. */
export interface FarCellBox {
  readonly lo: [number, number, number];
  readonly hi: [number, number, number];
}

/**
 * A stored block's marched box in its brick's cells (the build's bounds, grown by the lip where they reach a node
 * face it lies on), as the draw grows it.
 */
export function farBrickMarchedBox(b: FarBricks, block: number): FarCellBox {
  const C = DISTANCE_BRICK_CELLS;
  const L = FAR_BRICK_LIP_CELLS;
  const q = block * FAR_BRICK_BOUNDS_BYTES;
  const faces = b.blocks[block * FAR_BRICK_BLOCK_BYTES + 3]!;
  const lo: [number, number, number] = [0, 0, 0];
  const hi: [number, number, number] = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    const l = b.bounds[q + a]!;
    const h = b.bounds[q + 3 + a]!;
    lo[a] = l - (l === 0 && faces & (1 << (2 * a)) ? L : 0);
    hi[a] = h + (h === C && faces & (2 << (2 * a)) ? L : 0);
  }
  return { lo, hi };
}

/** The node's marched box: the union of its stored blocks' boxes (node cells); null with none. */
export function farNodeMarchedBox(b: FarBricks): FarCellBox | null {
  const C = DISTANCE_BRICK_CELLS;
  const n = b.blocks.length / FAR_BRICK_BLOCK_BYTES;
  if (n === 0) return null;
  const lo: [number, number, number] = [Infinity, Infinity, Infinity];
  const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < n; k++) {
    const box = farBrickMarchedBox(b, k);
    for (let a = 0; a < 3; a++) {
      const at = b.blocks[k * FAR_BRICK_BLOCK_BYTES + a]! * C;
      lo[a] = Math.min(lo[a]!, at + box.lo[a]!);
      hi[a] = Math.max(hi[a]!, at + box.hi[a]!);
    }
  }
  return { lo, hi };
}

/** The ray's entry and exit of a box (t along the unit direction; null: it misses). */
export function rayBox(o: readonly number[], d: readonly number[], box: FarCellBox): [number, number] | null {
  let t0 = 0;
  let t1 = Infinity;
  for (let a = 0; a < 3; a++) {
    const inv = 1 / (Math.abs(d[a]!) < 1e-8 ? (d[a]! < 0 ? -1e-8 : 1e-8) : d[a]!);
    const ta = (box.lo[a]! - o[a]!) * inv;
    const tb = (box.hi[a]! - o[a]!) * inv;
    t0 = Math.max(t0, Math.min(ta, tb));
    t1 = Math.min(t1, Math.max(ta, tb));
  }
  return t0 <= t1 ? [t0, t1] : null;
}

/**
 * A ray's march through a far node (node cells, unit direction): the first hit in ray order, its block and the
 * bricks the walk looked at; null: it leaves the node first.
 */
export function marchFarNode(b: FarBricks, o: readonly number[], d: readonly number[]): { t: number; block: number; visited: number } | null {
  const node = farNodeMarchedBox(b);
  if (node === null) return null;
  const span = rayBox(o, d, node);
  if (span === null) return null;
  const C = DISTANCE_BRICK_CELLS;
  const side = b.side;
  const [t0, t1] = span;
  const cell = [0, 1, 2].map((a) => Math.min(side - 1, Math.max(0, Math.floor((o[a]! + d[a]! * t0) / C))));
  const step = [0, 1, 2].map((a) => (d[a]! < 0 ? -1 : 1));
  const inv = [0, 1, 2].map((a) => 1 / (Math.abs(d[a]!) < 1e-8 ? (d[a]! < 0 ? -1e-8 : 1e-8) : d[a]!));
  const tMax = [0, 1, 2].map((a) => ((cell[a]! + (step[a]! > 0 ? 1 : 0)) * C - o[a]!) * inv[a]!);
  const tDelta = [0, 1, 2].map((a) => Math.abs(C * inv[a]!));
  for (let visited = 1; visited <= 3 * side; visited++) {
    const block = b.bricks[(cell[2]! * side + cell[1]!) * side + cell[0]!]!;
    if (block >= 0) {
      const box = farBrickMarchedBox(b, block);
      const local = [o[0]! - cell[0]! * C, o[1]! - cell[1]! * C, o[2]! - cell[2]! * C];
      const hit = marchBrickBox(b.samples, block, box.lo, box.hi, local, d);
      if (hit !== null) return { t: hit.t, block, visited };
    }
    const tn = Math.min(tMax[0]!, tMax[1]!, tMax[2]!);
    if (tn >= t1) return null;
    const a = tMax[0] === tn ? 0 : tMax[1] === tn ? 1 : 2;
    cell[a]! += step[a]!;
    if (cell[a]! < 0 || cell[a]! >= side) return null;
    tMax[a]! += tDelta[a]!;
  }
  return null;
}
