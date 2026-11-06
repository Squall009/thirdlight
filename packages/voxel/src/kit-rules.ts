/**
 * The kit rule set: the terrain rules (construction classes and ground
 * features) and the case pass composed into one {@link AssemblyRuleSet},
 * so a derive job runs one evaluation over one neighbourhood: one radius
 * (the larger of the two parts), one apron, one invalidation reach.
 *
 * The case pass gives every detail-bearing cell its case (kit-cases.ts: a
 * u16 a cell beside the class byte). Cases live only inside the derive job,
 * like classes: nothing stores them, and the world formats do not change.
 *
 * **Levels.** Kits draw pieces in chunks (level 0) only. Coarser nodes draw
 * no pieces (their cells are bodies of the base surface), so the case pass
 * is skipped there and no cell gets a case.
 */
import { CONSUMER_REACH, type AssemblyRuleSet, type Neighbourhood } from './assembly';
import { isRoofPlaneCell, ROOF_PLANE_REACH } from './roof-mesher';
import { caseFormTable, isDebrisCell } from './case-forms';
import { levelDrawsPieces } from './derived-mesh';
import { EDGE_REACH, extractEdges, type EdgeMasks } from './edge-cases';
import { EDGE_CASE_CATALOGUE } from './kit-case-catalogue';
import { CASE_REACH, CaseCatalogue, NO_CASE, type CaseCatalogueDef } from './kit-cases';
import { TERRAIN_RULES } from './terrain-rules';

/** True when a node of chunk-tree level `level` draws pieces, so its cells need cases. */
export function levelHasCases(level: number): boolean {
  return levelDrawsPieces(level);
}

/** Sets every cell of the box [lo, hi) (padded coordinates, all three axes) to `none` ({@link NO_CASE} by default). */
function clearBox(n: Neighbourhood, lo: number, hi: number, out: Uint16Array | Uint32Array, none = NO_CASE): void {
  const s = n.side;
  for (let x = lo; x < hi; x++) for (let z = lo; z < hi; z++) {
    const row = (x * s + z) * s;
    out.fill(none, row + lo, row + hi);
  }
}

/**
 * A rule set with the case pass added: `base` resolves the classes, the
 * catalogue the cases. Its radius is the larger of the two; its id and
 * version name the pair, so a change to either part (a catalogue version
 * included) takes a new version here. The catalogue is compiled in each
 * thread on its first case pass, so a thread that never derives does not
 * hold its window cache.
 */
export function withCases(base: AssemblyRuleSet, catalogue: CaseCatalogueDef, id: string, version: number): AssemblyRuleSet {
  let compiled: CaseCatalogue | null = null;
  // A catalogue without rules or fallbacks gives no cell a case: the window pass is skipped.
  const windowed = catalogue.rules.length > 0 || Object.values(catalogue.fallback).some((f) => f !== null);
  return Object.freeze({
    id,
    version,
    radius: Math.max(base.radius, CASE_REACH),
    caseForms: caseFormTable(catalogue.cases),
    catalogue,
    resolve(n: Neighbourhood, lo: number, hi: number, out: Uint8Array): void {
      base.resolve(n, lo, hi, out);
    },
    resolveCases(n: Neighbourhood, lo: number, hi: number, level: number, out: Uint16Array): number {
      if (!windowed || !levelHasCases(level)) {
        clearBox(n, lo, hi, out);
        return 0;
      }
      compiled ??= new CaseCatalogue(catalogue);
      return compiled.extract(n, lo, hi, out);
    },
  });
}

/**
 * The cases of the cells a derive job's consumers read (the chunk and
 * {@link CONSUMER_REACH} around it) into `out`, beside the classes
 * `evaluateAssembly` gives: the rule set's case pass, or no case anywhere
 * for a set without one. Returns the cells given a case.
 */
export function evaluateCases(n: Neighbourhood, rules: AssemblyRuleSet, level: number, out: Uint16Array): number {
  if (out.length !== n.values.length) throw new RangeError('cell cases: wrong length');
  const lo = n.pad - CONSUMER_REACH;
  const hi = n.pad + n.edge + CONSUMER_REACH;
  if (rules.resolveCases === undefined) {
    clearBox(n, lo, hi, out);
    return 0;
  }
  return rules.resolveCases(n, lo, hi, level, out);
}

/**
 * A rule set with the case pass and the edge pass added ({@link withCases}
 * plus edge-cases.ts): the window cases, if its catalogue has rules, and
 * every cell's edge and corner pieces. Its radius covers both passes.
 */
export function withEdges(base: AssemblyRuleSet, catalogue: CaseCatalogueDef, id: string, version: number): AssemblyRuleSet {
  const cased = withCases(base, catalogue, id, version);
  return Object.freeze({
    ...cased,
    radius: Math.max(cased.radius, EDGE_REACH + ROOF_PLANE_REACH),
    resolveEdges(n: Neighbourhood, lo: number, hi: number, level: number, out: EdgeMasks): number {
      if (!levelHasCases(level)) {
        clearBox(n, lo, hi, out.pieces, 0);
        clearBox(n, lo, hi, out.inner, 0);
        return 0;
      }
      return extractEdges(n, lo, hi, out, edgeExclusions(n, lo, hi));
    },
  });
}

/** Per thread, by neighbourhood size: the cells the edge pass leaves pieces off round. */
const exclusionScratch = new Map<number, Uint8Array>();

/**
 * The cells round a box the edge pass leaves pieces off round: the roof's
 * plane cells ({@link isRoofPlaneCell}: the roof's own edges are the roof
 * mesher's) and debris cells ({@link isDebrisCell}: the faces opening
 * toward them are dressed by debris pieces, not edges).
 */
function edgeExclusions(n: Neighbourhood, lo: number, hi: number): Uint8Array {
  let out = exclusionScratch.get(n.values.length);
  if (out === undefined) exclusionScratch.set(n.values.length, (out = new Uint8Array(n.values.length)));
  const s = n.side;
  for (let x = lo - 1; x <= hi; x++) for (let z = lo - 1; z <= hi; z++) {
    const row = (x * s + z) * s;
    for (let y = lo - 1; y <= hi; y++) out[row + y] = isDebrisCell(n, row + y) || isRoofPlaneCell(n, row + y) ? 1 : 0;
  }
  return out;
}

/**
 * The edge pieces of a derive job's own cells (the chunk) into `out`: the
 * rule set's edge pass, or none anywhere for a set without one. Returns the
 * cells owning a piece.
 */
export function evaluateEdges(n: Neighbourhood, rules: AssemblyRuleSet, level: number, out: EdgeMasks): number {
  if (out.pieces.length !== n.values.length || out.inner.length !== n.values.length) throw new RangeError('edge pieces: wrong length');
  const lo = n.pad;
  const hi = n.pad + n.edge;
  if (rules.resolveEdges === undefined) {
    clearBox(n, lo, hi, out.pieces, 0);
    clearBox(n, lo, hi, out.inner, 0);
    return 0;
  }
  return rules.resolveEdges(n, lo, hi, level, out);
}

/**
 * The edge rule set (DRAFT, with the edge catalogue), the world's: the
 * terrain rules and the edge pass; a derive with it draws pieces only on
 * edges, corners, roof edges and damaged cells (derived-pieces.ts).
 * Version 2: no edge piece round a cell the roof's planes may draw.
 * Version 3 (catalogue `edges-draft` v1, two debris stages): none round a
 * damaged construction cell either, which the derive draws as debris.
 * Version 4 (catalogue v2): no beam or banister cases, so no window pass.
 * Version 5: mixed corners (outer and inner edges meeting) take a corner
 * piece, its anchor and inner/outer from the shape at the point.
 */
export const EDGE_RULES: AssemblyRuleSet = withEdges(TERRAIN_RULES, EDGE_CASE_CATALOGUE, 'edges', 5);

