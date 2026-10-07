/**
 * A block layer's scatter (`scatter.ts`): its rules' copies baked per chunk
 * into the chunk's stored `scatter`, by the layer's own edits.
 *
 * After an edit's cells are final, the chunks it wrote are baked again over
 * their boxes grown by the rules' reach (a wall built on a lawn takes the
 * trees off its top, a hill raised carries its rocks up), a scatter stroke
 * adds its hand edits and bakes over itself, and `bakeScatter` bakes every
 * chunk (after the rules changed). Copies belong to the chunk whose columns
 * hold their point, in the layer's frame.
 *
 * Pure.
 */
import { CHUNK_SIZE, type BlockLayerComponent, type BlockType } from './block-layers';
import type { BlockGrid } from './block-grid';
import { bakeScatterCell, storedScatterRules, decodeChunkScatter, encodeChunkScatter, sameScatterCell, scatterReach, scatterStrokeRect, strokeScatterEdits, withScatterEdits, type ScatterCell, type ScatterRect, type ScatterRule, type ScatterStroke } from './scatter';
import { blockScatterSurface, regionExcluder, type ScatterRegionLayer } from './scatter-surfaces';
import { SurfaceRuleSet } from './surface-rules';

/** What a layer's scatter bake reads besides its grid. */
export interface BlockScatterContext {
  readonly component: BlockLayerComponent;
  readonly types: ReadonlyMap<string, BlockType>;
  /** The layer object's world position. */
  readonly origin: readonly number[];
  /** Other block layers' named regions (the layer's own are its grid's). */
  readonly otherRegions?: readonly ScatterRegionLayer[];
}

/** A scatter stroke as `editBlocks` gives it (columns and cells). */
export interface BlockScatterStroke {
  readonly rule: string;
  readonly at: readonly number[];
  readonly radius: number;
  readonly erase?: boolean;
}

/** A chunk's world box in XZ. */
export function blockChunkRect(origin: readonly number[], cellSize: readonly number[], cx: number, cz: number): ScatterRect {
  const w = CHUNK_SIZE * cellSize[0]!;
  const d = CHUNK_SIZE * cellSize[2]!;
  return [origin[0]! + cx * w, origin[2]! + cz * d, origin[0]! + (cx + 1) * w, origin[2]! + (cz + 1) * d];
}

const overlaps = (a: ScatterRect, b: ScatterRect): boolean => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

/**
 * Bake the layer's scatter after an edit: over the chunks in `changed`
 * (keys "cx,cz"; null: every chunk, a whole bake) grown by the rules' reach,
 * then each stroke's hand edits and its rectangle. Writes the chunks whose
 * scatter changed into the grid (they become dirty). Returns the candidates
 * looked at, or the stroke whose rule the layer lacks.
 */
export function bakeBlockScatter(grid: BlockGrid, ctx: BlockScatterContext, changed: readonly string[] | null, strokes: readonly BlockScatterStroke[]): { ok: true; looked: number } | { ok: false; stroke: number; message: string } {
  // Ground cover is made at run time, never stored.
  const rules: readonly ScatterRule[] = storedScatterRules(ctx.component.scatter);
  const cs = grid.cellSize;
  const origin = ctx.origin;
  const own: ScatterRegionLayer = { regions: grid.regions, cellSize: cs, origin };
  const surface = blockScatterSurface(
    { grid, types: ctx.types, origin, topSubdivision: ctx.component.topSubdivision ?? 1, ...(ctx.component.rules !== undefined && ctx.component.rules.length > 0 ? { rules: new SurfaceRuleSet(ctx.component.rules) } : {}) },
    regionExcluder([own, ...(ctx.otherRegions ?? [])]),
  );
  const keys = grid.chunkKeys().map((k) => k.split(',').map(Number) as [number, number]);
  const cells = new Map<string, ScatterCell | null>();
  const cellOf = (cx: number, cz: number): ScatterCell | null => {
    const k = `${cx},${cz}`;
    if (!cells.has(k)) cells.set(k, decodeChunkScatter(grid.chunkScatter(cx, cz)));
    return cells.get(k)!;
  };
  let looked = 0;
  const bake = (rect: ScatterRect | null): void => {
    for (const [cx, cz] of keys) {
      const box = blockChunkRect(origin, cs, cx, cz);
      if (rect !== null && !overlaps(rect, box)) continue;
      const r = bakeScatterCell(rules, surface, cellOf(cx, cz), box, rect, origin);
      looked += r.looked;
      cells.set(`${cx},${cz}`, r.cell.size === 0 ? null : r.cell);
    }
  };
  const reach = scatterReach(rules) + 2 * Math.max(cs[0]!, cs[2]!);
  if (changed === null) bake(null);
  else if (rules.length > 0) {
    for (const k of changed) {
      const [cx, cz] = k.split(',').map(Number) as [number, number];
      const b = blockChunkRect(origin, cs, cx, cz);
      bake([b[0] - reach, b[1] - reach, b[2] + reach, b[3] + reach]);
    }
  }
  for (let i = 0; i < strokes.length; i++) {
    const s = strokes[i]!;
    const rule = rules.find((r) => r.id === s.rule);
    if (rule === undefined) return { ok: false, stroke: i, message: `the layer has no scatter rule "${s.rule}" (it has ${rules.map((r) => r.id).join(', ') || 'none'})` };
    const dabs: [number, number][] = [];
    for (let k = 0; k < s.at.length; k += 2) dabs.push([origin[0]! + s.at[k]! * cs[0]!, origin[2]! + s.at[k + 1]! * cs[2]!]);
    const stroke: ScatterStroke = { rule: s.rule, mode: s.erase === true ? 'erase' : 'paint', dabs, radius: s.radius * cs[0]! };
    for (const [cx, cz] of keys) {
      const box = blockChunkRect(origin, cs, cx, cz);
      const prev = cellOf(cx, cz);
      const edits = strokeScatterEdits(prev?.get(s.rule), rule, stroke, box);
      if (edits !== null) cells.set(`${cx},${cz}`, withScatterEdits(prev, s.rule, edits));
    }
    bake(scatterStrokeRect(stroke, scatterReach([rule]) + 2 * Math.max(cs[0]!, cs[2]!)));
  }
  for (const [k, cell] of cells) {
    const [cx, cz] = k.split(',').map(Number) as [number, number];
    const before = decodeChunkScatter(grid.chunkScatter(cx, cz));
    if (!sameScatterCell(before, cell)) grid.setChunkScatter(cx, cz, encodeChunkScatter(cell));
  }
  return { ok: true, looked };
}
