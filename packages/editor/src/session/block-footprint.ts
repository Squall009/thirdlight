/**
 * Props on block layers: snapping to cell tops. A free-placed prop lands on
 * the top of the column under it — x/z at the centre of its footprint (a
 * cell centre for an odd side, a cell corner for an even one), y on the top
 * face of the highest block (the layer's floor over an empty column).
 *
 * The footprint's cells and the edits that move it are the model's
 * (`footprintCells`, `footprintEdits`); the backend writes them with the
 * command that moves, places or deletes the prop.
 *
 * Pure: no DOM, no three.js.
 */
import { footprintMinCell, overLayer, turnedSize, type FootprintLayer } from '@thirdlight/runtime';

/** A layer as the editor places props on it. */
export interface PropLayer extends FootprintLayer {
  entityId: string;
  /** The highest cell of a column holding a block (null: none). */
  columnTop(x: number, z: number): number | null;
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
    const [x0, z0] = footprintMinCell(layer, p[0]!, p[2]!, w, d);
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
