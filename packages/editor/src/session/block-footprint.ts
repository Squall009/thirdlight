/**
 * Props on block layers.
 *
 * - Snap to cell tops: a free-placed prop lands on the top of the column
 *   under it — x/z at the centre of its footprint (a cell centre for an odd
 *   side, a cell corner for an even one), y on the top face of the highest
 *   block (the layer's floor over an empty column).
 * - Occupancy footprint (`blockFootprint`): the cells beneath a prop — a
 *   rectangle of `size` cells centred on it, turned with its quarter turns
 *   about +Y — take the component's metadata. Moving the prop clears the
 *   fields it wrote where it stood (set to null) and writes them where it
 *   lands: one `editBlocks` of `meta` edits per layer.
 *
 * Pure: no DOM, no three.js.
 */
import type { BlockCell, BlockEdit, BlockFootprintComponent, BlockLayerComponent, CellMetaValue } from '@thirdlight/project-model';

/** A layer as the editor places props on it. */
export interface PropLayer {
  entityId: string;
  component: BlockLayerComponent;
  origin: readonly number[];
  /** The highest cell of a column holding a block (null: none). */
  columnTop(x: number, z: number): number | null;
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
function rectMin(layer: Pick<PropLayer, 'component' | 'origin'>, px: number, pz: number, w: number, d: number): [number, number] {
  const cs = layer.component.cellSize;
  const lx = (px - (layer.origin[0] ?? 0)) / cs[0];
  const lz = (pz - (layer.origin[2] ?? 0)) / cs[2];
  return [Math.round(lx - w / 2), Math.round(lz - d / 2)];
}

/** Whether a world point lies over the layer's cells (x/z within its bounds). */
export function overLayer(layer: Pick<PropLayer, 'component' | 'origin'>, px: number, pz: number): boolean {
  const cs = layer.component.cellSize;
  const lx = (px - (layer.origin[0] ?? 0)) / cs[0];
  const lz = (pz - (layer.origin[2] ?? 0)) / cs[2];
  const b = layer.component.bounds;
  return lx >= b.min[0] && lx < b.max[0] && lz >= b.min[2] && lz < b.max[2];
}

/**
 * Snap a prop's position to the top of the cells under it (null: over no
 * layer). The highest top under the footprint wins, so a wide prop rests on
 * its tallest column.
 */
export function snapToCellTop(layers: readonly PropLayer[], p: readonly number[], size: readonly number[] | undefined, turns: number): [number, number, number] | null {
  const [w, d] = turnedSize(size, turns);
  let best: [number, number, number] | null = null;
  for (const layer of layers) {
    if (layer.component.metadataOnly === true || !overLayer(layer, p[0]!, p[2]!)) continue;
    const cs = layer.component.cellSize;
    const [x0, z0] = rectMin(layer, p[0]!, p[2]!, w, d);
    let top = layer.component.bounds.min[1] - 1;
    for (let x = x0; x < x0 + w; x++) for (let z = z0; z < z0 + d; z++) top = Math.max(top, layer.columnTop(x, z) ?? layer.component.bounds.min[1] - 1);
    const ox = layer.origin[0] ?? 0;
    const oy = layer.origin[1] ?? 0;
    const oz = layer.origin[2] ?? 0;
    const at: [number, number, number] = [round4(ox + (x0 + w / 2) * cs[0]), round4(oy + (top + 1) * cs[1]), round4(oz + (z0 + d / 2) * cs[2])];
    if (best === null || at[1] > best[1]) best = at;
  }
  return best;
}

function round4(v: number): number {
  const r = Math.round(v * 10_000) / 10_000;
  return r === 0 ? 0 : r;
}

/**
 * The cells beneath a prop on one layer (flat x, y, z, …): the footprint
 * rectangle on the row just below the prop's base, clipped to the bounds.
 * Empty when the prop is not over the layer.
 */
export function footprintCells(layer: Pick<PropLayer, 'component' | 'origin'>, position: readonly number[], rotation: readonly number[], fp: Pick<BlockFootprintComponent, 'size'>): number[] {
  if (!overLayer(layer, position[0]!, position[2]!)) return [];
  const turns = yawQuarterTurns(rotation);
  const [w, d] = turnedSize(fp.size, turns);
  const [x0, z0] = rectMin(layer, position[0]!, position[2]!, w, d);
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
 * component's fields cleared (null) on the cells it leaves, written on the
 * cells it covers. Null: nothing to change.
 */
export function footprintEdits(before: readonly number[], after: readonly number[], set: Readonly<Record<string, CellMetaValue>>): BlockEdit[] | null {
  const keys = Object.keys(set);
  if (keys.length === 0) return null;
  const covered = new Set<string>();
  for (let i = 0; i < after.length; i += 3) covered.add(`${after[i]},${after[i + 1]},${after[i + 2]}`);
  const left: number[] = [];
  for (let i = 0; i < before.length; i += 3) if (!covered.has(`${before[i]},${before[i + 1]},${before[i + 2]}`)) left.push(before[i]!, before[i + 1]!, before[i + 2]!);
  const edits: BlockEdit[] = [];
  if (left.length > 0) edits.push({ kind: 'meta', set: Object.fromEntries(keys.map((k) => [k, null])), at: left });
  if (after.length > 0) edits.push({ kind: 'meta', set: { ...set }, at: [...after] });
  return edits.length > 0 ? edits : null;
}

/** Whether every footprint cell already holds the metadata (nothing to write). */
export function footprintWritten(after: readonly number[], set: Readonly<Record<string, CellMetaValue>>, get: (x: number, y: number, z: number) => BlockCell | null): boolean {
  for (let i = 0; i < after.length; i += 3) {
    const meta = get(after[i]!, after[i + 1]!, after[i + 2]!)?.meta ?? {};
    for (const [k, v] of Object.entries(set)) if (meta[k] !== v) return false;
  }
  return true;
}
