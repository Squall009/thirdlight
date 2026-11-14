/**
 * Sky heights by chunk column where a world is drawn: what the stitching
 * where the world runs (open-region-stitch.ts) found for each chunk column
 * (the highest solid cell + 1 of each of its E² columns, world cells), sent
 * with the draw batches as they change, for lighting to read on the page.
 */
import { WORLD_CELL_MIN_Y } from './coords';

/** A chunk column's sky heights (E² values, x · E + z), or none any more (the column left). */
export interface SkyColumnWire {
  readonly cx: number;
  readonly cz: number;
  /** Absent: the column is no longer known. */
  readonly heights?: Int16Array;
}

/** Height a column with no solid cell reads (every cell of it under open sky). */
export const SKY_NONE = WORLD_CELL_MIN_Y;

const columnKey = (cx: number, cz: number): number => (cx + 0x8000) * 0x10000 + (cz + 0x8000);

/** A world's sky heights on the page: the columns the batches brought. */
export class SkyColumns {
  private readonly cols = new Map<number, Int16Array>();
  private readonly shift: number;

  constructor(readonly edge: number) {
    this.shift = Math.log2(edge);
  }

  apply(wires: readonly SkyColumnWire[]): void {
    for (const w of wires) {
      if (w.heights === undefined) this.cols.delete(columnKey(w.cx, w.cz));
      else this.cols.set(columnKey(w.cx, w.cz), w.heights);
    }
  }

  /** The sky height of world column (x, z) in cells ({@link SKY_NONE}: nothing solid), or null when not known. */
  heightAt(x: number, z: number): number | null {
    const h = this.cols.get(columnKey(x >> this.shift, z >> this.shift));
    const m = this.edge - 1;
    return h === undefined ? null : h[(x & m) * this.edge + (z & m)]!;
  }

  /** A chunk column's heights (null: not known). */
  column(cx: number, cz: number): Int16Array | null {
    return this.cols.get(columnKey(cx, cz)) ?? null;
  }

  get count(): number {
    return this.cols.size;
  }

  get bytes(): number {
    return this.cols.size * this.edge * this.edge * 2;
  }

  clear(): void {
    this.cols.clear();
  }
}
