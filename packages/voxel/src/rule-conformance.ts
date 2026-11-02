/**
 * The radius conformance check every assembly rule set must pass.
 *
 * A rule set declares how far its rules read (`radius`); derive jobs get an
 * apron of exactly radius + consumer reach, and edits invalidate results
 * that far around them. Nothing stops a rule from reading further: it then
 * reads past the neighbourhood (air, or cells of another row), gets wrong
 * classes and misses invalidations, all without an error. So the declared
 * radius is checked by evaluating the same chunks twice, once with the
 * neighbourhood the jobs build and once with a wider one, and comparing
 * every resolved cell the consumers read: a rule within its radius cannot
 * tell the two apart.
 */
import { buildApron, checkRadius } from './apron';
import { CONSUMER_REACH, createNeighbourhood, fillNeighbourhood, jobRadius, type AssemblyRuleSet } from './assembly';
import type { ChunkCoord } from './coords';
import { createDenseChunk } from './dense-chunk';
import type { VoxelStoreCandidate } from './store';

/** Cells more than the job's apron that the wider evaluation sees (3: a rule reading up to 3 cells too far is caught). */
export const RULE_CONFORMANCE_EXTRA_PAD = 3;

/** A cell resolved differently with the job's apron than with a wider one. */
export interface RuleRadiusMismatch {
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  /** Local cell in the chunk (−reach … edge + reach − 1). */
  readonly lx: number;
  readonly ly: number;
  readonly lz: number;
  /** The class byte with the job's apron, and with the wider one. */
  readonly declared: number;
  readonly wider: number;
}

/**
 * Evaluates `rules` on each chunk of `store` with the job's apron (radius +
 * reach) and with `extra` cells more, and returns every cell the consumers
 * read (the chunk and the reach around it) that differs, at most `limit`.
 * Empty: within these chunks the rules read no further than they declare.
 */
export function ruleRadiusMismatches(store: VoxelStoreCandidate, rules: AssemblyRuleSet, chunks: Iterable<Readonly<ChunkCoord>>, extra = RULE_CONFORMANCE_EXTRA_PAD, limit = 100): RuleRadiusMismatch[] {
  const grid = store.grid;
  const e = grid.edge;
  const pad = jobRadius(rules);
  const wide = pad + extra;
  if (!(extra >= 1)) throw new RangeError('the wider apron must be at least 1 cell wider');
  checkRadius(e, wide);
  const narrowN = createNeighbourhood(e, pad);
  const wideN = createNeighbourhood(e, wide);
  const narrowOut = new Uint8Array(narrowN.values.length);
  const wideOut = new Uint8Array(wideN.values.length);
  const dense = createDenseChunk(grid);
  const out: RuleRadiusMismatch[] = [];
  for (const c of chunks) {
    const has = store.exportChunk(c.cx, c.cy, c.cz, dense);
    fillNeighbourhood(narrowN, grid, has ? dense : null, buildApron(store, c.cx, c.cy, c.cz, pad));
    fillNeighbourhood(wideN, grid, has ? dense : null, buildApron(store, c.cx, c.cy, c.cz, wide));
    narrowOut.fill(0);
    wideOut.fill(0);
    rules.resolve(narrowN, pad - CONSUMER_REACH, pad + e + CONSUMER_REACH, narrowOut);
    rules.resolve(wideN, wide - CONSUMER_REACH, wide + e + CONSUMER_REACH, wideOut);
    const sn = narrowN.side;
    const sw = wideN.side;
    for (let x = -CONSUMER_REACH; x < e + CONSUMER_REACH; x++) for (let z = -CONSUMER_REACH; z < e + CONSUMER_REACH; z++) for (let y = -CONSUMER_REACH; y < e + CONSUMER_REACH; y++) {
      const a = narrowOut[((x + pad) * sn + (z + pad)) * sn + (y + pad)]!;
      const b = wideOut[((x + wide) * sw + (z + wide)) * sw + (y + wide)]!;
      if (a === b) continue;
      out.push({ cx: c.cx, cy: c.cy, cz: c.cz, lx: x, ly: y, lz: z, declared: a, wider: b });
      if (out.length >= limit) return out;
    }
  }
  return out;
}
