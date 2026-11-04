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
 * **Levels.** Kits draw high pieces in chunks and low pieces in level-1
 * nodes, which pick their piece by case like a chunk does, so the case pass
 * runs at both. Coarser nodes draw no pieces (their cells are bodies of the
 * base surface), so it is skipped there and no cell gets a case.
 */
import { CONSUMER_REACH, type AssemblyRuleSet, type Neighbourhood } from './assembly';
import { PIECE_DETAIL, pieceDetailAt } from './derived-mesh';
import { DRAFT_CASE_CATALOGUE } from './kit-case-catalogue';
import { CASE_REACH, CaseCatalogue, NO_CASE, type CaseCatalogueDef } from './kit-cases';
import { TERRAIN_RULES } from './terrain-rules';

/** True when a node of chunk-tree level `level` draws pieces, so its cells need cases. */
export function levelHasCases(level: number): boolean {
  return pieceDetailAt(level) !== PIECE_DETAIL.none;
}

/** Sets every cell of the box [lo, hi) (padded coordinates, all three axes) to {@link NO_CASE}. */
function clearBox(n: Neighbourhood, lo: number, hi: number, out: Uint16Array): void {
  const s = n.side;
  for (let x = lo; x < hi; x++) for (let z = lo; z < hi; z++) {
    const row = (x * s + z) * s;
    out.fill(NO_CASE, row + lo, row + hi);
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
  return Object.freeze({
    id,
    version,
    radius: Math.max(base.radius, CASE_REACH),
    resolve(n: Neighbourhood, lo: number, hi: number, out: Uint8Array): void {
      base.resolve(n, lo, hi, out);
    },
    resolveCases(n: Neighbourhood, lo: number, hi: number, level: number, out: Uint16Array): number {
      if (!levelHasCases(level)) {
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
 * The world rule set from kits on: the terrain rules (`terrain` v1) with
 * the case pass over the case catalogue. Version 1 composes catalogue
 * `cases-draft` v0, a DRAFT until the owner approves the role spec: the
 * cases it gives are not yet read by any output, so derived results are the
 * terrain rules' byte for byte but for the rule set they name.
 */
export const KIT_RULES: AssemblyRuleSet = withCases(TERRAIN_RULES, DRAFT_CASE_CATALOGUE, 'kits', 1);
