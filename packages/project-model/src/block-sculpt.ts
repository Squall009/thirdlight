/**
 * Terrain editing of a block layer: a column's top surface as four corner
 * heights (in rows of the layer, e.g. 3.25 = a quarter of a cell above row
 * 3's bottom), setting it (`surface` edits: the column grows or shrinks and
 * its top cell takes the corners) and the brushes that change it (`sculpt`
 * edits: raise, lower, smooth, flatten under a round brush). The editor's
 * height and smooth brushes send `sculpt` dabs; MCP and scripts at edit time
 * may send either.
 *
 * A lattice vertex is shared by the four columns around it; a brush changes
 * each column's corner at a vertex by the vertex's distance from the brush
 * centre, so neighbouring columns move together and a cliff (two columns
 * whose shared corners differ) stays a cliff until smoothed. Heights are
 * kept on the 1/64 grid of `BLOCK_CORNER_STEPS`; the falloff uses squared
 * distances only (no trigonometry), so the same edits give the same cells in
 * every JavaScript engine.
 *
 * Pure and deterministic.
 */
import { BLOCK_CORNER_MAX, BLOCK_CORNER_STEPS, blockTypeSlopes, type BlockCell, type BlockType } from './block-layers';
import type { BlockGrid } from './block-grid';
import { blockTopAt, cellCorners } from './block-surface';

export type SculptOp = 'raise' | 'lower' | 'smooth' | 'flatten';
export const SCULPT_OPS: readonly SculptOp[] = ['raise', 'lower', 'smooth', 'flatten'];

/** The largest brush radius (cells) and strength (cells per dab for raise and lower). */
export const SCULPT_LIMITS = Object.freeze({ radiusMin: 0.5, radiusMax: 32, strengthMax: 16 });

/** Column corner heights in rows: −x−z, +x−z, +x+z, −x+z. */
export type ColumnHeights = [number, number, number, number];

const quantize = (v: number): number => Math.round(v * BLOCK_CORNER_STEPS) / BLOCK_CORNER_STEPS;

/** The corner heights of a column's top (rows), or null when it holds no block. */
export function columnHeights(g: BlockGrid, types: ReadonlyMap<string, BlockType>, x: number, z: number): ColumnHeights | null {
  const top = g.columnTop(x, z);
  if (top === null) return null;
  const cell = g.get(x, top, z)!;
  const t = cell.block !== undefined ? types.get(cell.block) : undefined;
  const c = t !== undefined && blockTypeSlopes(t) ? cellCorners(cell) : null;
  if (c !== null) return [top + c[0], top + c[1], top + c[2], top + c[3]];
  if (t === undefined || t.shape === 'full' || t.shape === 'none') return [top + 1, top + 1, top + 1, top + 1];
  // Another shape: its own top at the corners (a half block's 0.5, a ramp's rise).
  const cs = g.cellSize;
  const at = (u: number, v: number): number => top + (blockTopAt(t, cell, cs, (u - 0.5) * cs[0]!, (v - 0.5) * cs[2]!)?.height ?? cs[1]!) / cs[1]!;
  return [at(0, 0), at(1, 0), at(1, 1), at(0, 1)];
}

function blockOnly(cell: BlockCell): BlockCell {
  return { ...(cell.block !== undefined ? { block: cell.block } : {}), ...(cell.rot !== undefined ? { rot: cell.rot } : {}), ...(cell.variant !== undefined ? { variant: cell.variant } : {}) };
}

function withoutCorners(cell: BlockCell): BlockCell {
  if (cell.corners === undefined) return cell;
  const { corners: _c, ...rest } = cell;
  return rest;
}

/**
 * Set a column's top surface to corner heights `h` (rows; kept within the
 * layer's rows, on the 1/64 grid): the column's top becomes the row under its
 * lowest corner, holding the corners (up to `BLOCK_CORNER_MAX` rows over its
 * bottom: a steeper column keeps a wall); cells above it are cleared (their metadata
 * stays), the rows up to it are filled with `fill` (absent: the column's top
 * block, flat). A column whose top block cannot slope is left as it is unless
 * `fill` names a block. Returns the number of cells changed, or -1 when the
 * column was skipped.
 */
export function setColumnSurface(g: BlockGrid, types: ReadonlyMap<string, BlockType>, x: number, z: number, h: readonly number[], fill?: BlockCell): number {
  const lo = g.min[1];
  const hi = g.max[1];
  const cur = g.columnTop(x, z);
  const topCell = cur !== null ? g.get(x, cur, z)! : null;
  const topType = topCell?.block !== undefined ? types.get(topCell.block) : undefined;
  if (fill === undefined && (topCell === null || topType === undefined || !blockTypeSlopes(topType))) return -1;
  // The fill is the block alone (its type, rotation and look): metadata belongs to the cells that hold it.
  const block = fill ?? blockOnly(topCell!);
  const blockType = block.block !== undefined ? types.get(block.block) : undefined;
  const q = h.map((v) => quantize(Math.min(hi, Math.max(lo, v))));
  const low = Math.min(...q);
  const high = Math.max(...q);
  let changed = 0;
  const put = (y: number, cell: BlockCell | null): void => {
    if (g.set(x, y, z, cell)) changed += 1;
  };
  const clearFrom = (from: number): void => {
    for (let y = cur ?? lo - 1; y >= from; y--) {
      const c = g.get(x, y, z);
      if (c?.block !== undefined) put(y, c.meta !== undefined ? { meta: c.meta } : null);
    }
  };
  if (high <= lo) {
    clearFrom(lo);
    return changed;
  }
  let top: number;
  let corners: number[] | null;
  if (low === high && Number.isInteger(low)) {
    top = low - 1;
    corners = null;
  } else {
    top = Math.max(lo, Math.min(hi - 1, Math.floor(low)));
    // A corner may reach into the cells above as far as they are inside the layer.
    const cap = Math.min(BLOCK_CORNER_MAX, hi - top);
    corners = q.map((v) => Math.min(cap, Math.max(0, v - top)));
    if (corners.every((c) => c === 1)) corners = null;
  }
  if (blockType === undefined || !blockTypeSlopes(blockType)) corners = null;
  clearFrom(top + 1);
  // The old top becomes part of the column under the new one: flat.
  if (cur !== null && cur < top && topCell!.corners !== undefined) put(cur, withoutCorners(topCell!));
  for (let y = cur === null ? lo : cur + 1; y < top; y++) {
    const c = g.get(x, y, z);
    if (c?.block === undefined) put(y, { ...withoutCorners(block), ...(c?.meta !== undefined ? { meta: c.meta } : {}) });
  }
  const at = g.get(x, top, z);
  const base = at?.block !== undefined ? withoutCorners(at) : { ...withoutCorners(block), ...(at?.meta !== undefined ? { meta: at.meta } : {}) };
  const baseType = base.block !== undefined ? types.get(base.block) : undefined;
  put(top, corners !== null && baseType !== undefined && blockTypeSlopes(baseType) ? { ...base, corners: corners as [number, number, number, number] } : base);
  return changed;
}

/** One brush application. */
export interface SculptDab {
  op: SculptOp;
  /** The brush centre in columns (x, z; a lattice vertex is at whole numbers). */
  at: readonly number[];
  /** Cells. */
  radius: number;
  /** Raise/lower: cells at the centre; smooth/flatten: the blend toward the target at the centre (0-1). */
  strength: number;
  /** Flatten: the height to level to (rows). */
  height?: number;
}

/**
 * The new corner heights of the columns a dab touches (every value from the
 * heights before it): a smooth falloff (1 − d²/r²)² by each corner's distance
 * from the centre. An empty column counts as the layer's bottom row and
 * changes only when `grows`.
 */
export function sculptHeights(g: BlockGrid, types: ReadonlyMap<string, BlockType>, dab: SculptDab, grows: boolean): Map<string, { x: number; z: number; h: ColumnHeights }> {
  const [cx, cz] = dab.at as [number, number];
  const r = dab.radius;
  const r2 = r * r;
  const bottom = g.min[1];
  const cache = new Map<string, ColumnHeights | null>();
  const heightsOf = (x: number, z: number): ColumnHeights | null => {
    const k = `${x},${z}`;
    if (!cache.has(k)) cache.set(k, columnHeights(g, types, x, z));
    return cache.get(k)!;
  };
  const inside = (x: number, z: number): boolean => x >= g.min[0] && x < g.max[0] && z >= g.min[2] && z < g.max[2];
  /** A lattice vertex's height: the mean of the corners the columns around it hold there (empty columns: the bottom). */
  const vertex = (vx: number, vz: number): number | null => {
    let sum = 0;
    let n = 0;
    for (const [dx, dz, i] of [[-1, -1, 2], [0, -1, 3], [0, 0, 0], [-1, 0, 1]] as const) {
      const x = vx + dx;
      const z = vz + dz;
      if (!inside(x, z)) continue;
      sum += heightsOf(x, z)?.[i] ?? bottom;
      n += 1;
    }
    return n === 0 ? null : sum / n;
  };
  const blend = Math.min(1, dab.strength);
  const out = new Map<string, { x: number; z: number; h: ColumnHeights }>();
  const x0 = Math.max(g.min[0], Math.floor(cx - r));
  const x1 = Math.min(g.max[0] - 1, Math.ceil(cx + r) - 1);
  const z0 = Math.max(g.min[2], Math.floor(cz - r));
  const z1 = Math.min(g.max[2] - 1, Math.ceil(cz + r) - 1);
  for (let z = z0; z <= z1; z++)
    for (let x = x0; x <= x1; x++) {
      const before = heightsOf(x, z);
      if (before === null && !grows) continue;
      const cur: ColumnHeights = before ?? [bottom, bottom, bottom, bottom];
      const next = [...cur] as ColumnHeights;
      let moved = false;
      for (let i = 0; i < 4; i++) {
        const vx = x + (i === 1 || i === 2 ? 1 : 0);
        const vz = z + (i === 2 || i === 3 ? 1 : 0);
        const d2 = (vx - cx) * (vx - cx) + (vz - cz) * (vz - cz);
        if (d2 >= r2) continue;
        const k = 1 - d2 / r2;
        const w = k * k;
        const h = cur[i]!;
        let v = h;
        switch (dab.op) {
          case 'raise':
            v = h + dab.strength * w;
            break;
          case 'lower':
            v = h - dab.strength * w;
            break;
          case 'flatten':
            v = h + blend * w * ((dab.height ?? h) - h);
            break;
          case 'smooth': {
            let sum = 0;
            let n = 0;
            for (let a = -1; a <= 1; a++)
              for (let b = -1; b <= 1; b++) {
                const vh = vertex(vx + a, vz + b);
                if (vh === null) continue;
                sum += vh;
                n += 1;
              }
            v = h + blend * w * (sum / n - h);
            break;
          }
        }
        v = quantize(v);
        if (v !== h) moved = true;
        next[i] = v;
      }
      if (moved) out.set(`${x},${z}`, { x, z, h: next });
    }
  return out;
}
