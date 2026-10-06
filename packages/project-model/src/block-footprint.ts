/**
 * A prop's block footprint: the cells beneath a prop carrying
 * `blockFootprint` — a rectangle of `size` cells centred on it, turned with
 * its quarter turns about +Y, on the row its base stands on — and the meta
 * edits that move the footprint's fields from one set of cells to another.
 *
 * The command layer writes footprints with the change that moves, places or
 * deletes the prop; the editor uses the same geometry to snap props onto
 * cell tops. Pure: no DOM, no three.js.
 */
import type { BlockFootprintComponent, BlockLayerComponent, CellMetaValue } from './block-layers';
import type { BlockEdit } from './block-grid';

/** A layer as footprints see it: its component and the world position of its cell 0's min corner. */
export interface FootprintLayer {
  component: BlockLayerComponent;
  origin: readonly number[];
}

/** The quarter turns (0-3) of a rotation about +Y (the nearest; tilted props use their yaw). */
export function yawQuarterTurns(q: readonly number[]): 0 | 1 | 2 | 3 {
  const [x = 0, y = 0, z = 0, w = 1] = q;
  // The rotated +X axis projected on the ground plane.
  const fx = 1 - 2 * (y * y + z * z);
  const fz = 2 * (x * z - w * y);
  const yaw = Math.atan2(-fz, fx);
  const turns = Math.round(yaw / (Math.PI / 2));
  return (((turns % 4) + 4) % 4) as 0 | 1 | 2 | 3;
}

/** The footprint's size turned by the quarter turns (x and z swap on odd turns). */
export function turnedSize(size: readonly number[] | undefined, turns: number): [number, number] {
  const w = size?.[0] ?? 1;
  const d = size?.[1] ?? 1;
  return turns % 2 === 1 ? [d, w] : [w, d];
}

/** The min cell (x, z) of a `w × d` rectangle centred on a world point. */
export function footprintMinCell(layer: FootprintLayer, px: number, pz: number, w: number, d: number): [number, number] {
  const cs = layer.component.cellSize;
  const lx = (px - (layer.origin[0] ?? 0)) / cs[0];
  const lz = (pz - (layer.origin[2] ?? 0)) / cs[2];
  return [Math.round(lx - w / 2), Math.round(lz - d / 2)];
}

/** Whether a world point lies over the layer's cells (x/z within its bounds). */
export function overLayer(layer: FootprintLayer, px: number, pz: number): boolean {
  const cs = layer.component.cellSize;
  const lx = (px - (layer.origin[0] ?? 0)) / cs[0];
  const lz = (pz - (layer.origin[2] ?? 0)) / cs[2];
  const b = layer.component.bounds;
  return lx >= b.min[0] && lx < b.max[0] && lz >= b.min[2] && lz < b.max[2];
}

/**
 * The cells beneath a prop on one layer (flat x, y, z, …): the footprint
 * rectangle on the row just below the prop's base, clipped to the bounds.
 * Empty when the prop is not over the layer.
 */
export function footprintCells(layer: FootprintLayer, position: readonly number[], rotation: readonly number[], fp: Pick<BlockFootprintComponent, 'size'>): number[] {
  if (!overLayer(layer, position[0]!, position[2]!)) return [];
  const turns = yawQuarterTurns(rotation);
  const [w, d] = turnedSize(fp.size, turns);
  const [x0, z0] = footprintMinCell(layer, position[0]!, position[2]!, w, d);
  const cs = layer.component.cellSize;
  // The row whose top face the base stands on (a small tolerance keeps a hand-placed prop on its row).
  const y = Math.round((position[1]! - (layer.origin[1] ?? 0)) / cs[1] - 1e-3) - 1;
  const b = layer.component.bounds;
  if (y < b.min[1] || y >= b.max[1]) return [];
  const out: number[] = [];
  for (let z = Math.max(z0, b.min[2]); z < Math.min(z0 + d, b.max[2]); z++) for (let x = Math.max(x0, b.min[0]); x < Math.min(x0 + w, b.max[0]); x++) out.push(x, y, z);
  return out;
}

/**
 * The edits that move a footprint from `before` cells to `after` cells: the
 * fields of `previousSet` (the footprint's fields before; default `set`)
 * cleared (null) where the footprint no longer writes them, and `set`
 * written on the cells it covers. Null: nothing to change.
 */
export function footprintEdits(before: readonly number[], after: readonly number[], set: Readonly<Record<string, CellMetaValue>>, previousSet: Readonly<Record<string, CellMetaValue>> = set): BlockEdit[] | null {
  const keys = Object.keys(set);
  const oldKeys = Object.keys(previousSet);
  const covered = new Set<string>();
  for (let i = 0; i < after.length; i += 3) covered.add(`${after[i]},${after[i + 1]},${after[i + 2]}`);
  const left: number[] = [];
  const kept: number[] = [];
  for (let i = 0; i < before.length; i += 3) (covered.has(`${before[i]},${before[i + 1]},${before[i + 2]}`) ? kept : left).push(before[i]!, before[i + 1]!, before[i + 2]!);
  const edits: BlockEdit[] = [];
  if (left.length > 0 && oldKeys.length > 0) edits.push({ kind: 'meta', set: Object.fromEntries(oldKeys.map((k) => [k, null])), at: left });
  // Cells still covered lose only the fields the footprint stopped writing.
  const dropped = oldKeys.filter((k) => !keys.includes(k));
  if (kept.length > 0 && dropped.length > 0) edits.push({ kind: 'meta', set: Object.fromEntries(dropped.map((k) => [k, null])), at: kept });
  if (after.length > 0 && keys.length > 0) edits.push({ kind: 'meta', set: { ...set }, at: [...after] });
  return edits.length > 0 ? edits : null;
}
