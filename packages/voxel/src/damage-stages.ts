/**
 * Damage stages: how a construction cell's integrity (its shape: 15 intact,
 * lower damaged, air broken) is shown. The engine has no damage value of its
 * own and decides nothing about when a cell is hit; it only maps the
 * integrity a game wrote to one of three stages, per kit:
 *
 * - **stage 1, cracks** (default 11–14): the block is drawn as intact, with
 *   its edge pieces, and its faces carry the crack overlay (the surface
 *   shader; one engine crack texture, replaceable per kit), stronger the
 *   lower the integrity within the stage;
 * - **stage 2** (default 6–10): the block is not drawn. The hole is not open
 *   air, so no edge piece goes round it; each intact neighbour's face
 *   toward it is drawn and carries many damage pieces from the neighbour's
 *   own kit (its `damage-stage-2` slot, scattered over the face);
 * - **stage 3** (default 1–5): the same hole, with fewer pieces (the
 *   `damage-stage-3` slot).
 *
 * A kit may move the ranges, change the piece counts or leave a stage out
 * (an integrity in no stage of its kit draws as intact). A material without
 * a kit takes the defaults: its holes and cracks show, with no pieces.
 * Whatever the stage, the cell stays whole for collision and navigation
 * until it is air; only its light coverage follows the integrity
 * (derived-data.ts). Damage shows at level 0 only: a coarser node's cell of
 * construction is intact (voxel-mips.ts).
 */
import { SHAPE_FULL } from './record';

/** The stages, by number (0: shown intact). */
export const DAMAGE_STAGE = Object.freeze({ none: 0, crack: 1, many: 2, few: 3 });

/** The slot (case id) a hole's neighbour faces draw their damage pieces from, by stage (2 and 3). */
export const DAMAGE_PIECE_SLOTS = Object.freeze({ 2: 'damage-stage-2', 3: 'damage-stage-3' } as const);

/** The most damage pieces one face carries (the scatter index's bits in an instance's dressing word). */
export const DAMAGE_PIECES_MAX = 16;

/** One stage's integrity range (both ends included, 1 … 14) and, for stages 2 and 3, the pieces each neighbour face carries. */
export interface DamageStageSpan {
  readonly min: number;
  readonly max: number;
  /** Stages 2 and 3: damage pieces a face toward the hole (1 … {@link DAMAGE_PIECES_MAX}; absent: the default). */
  readonly pieces?: number;
}

/** A kit's stages (absent: the default stage; null: the kit leaves that stage out). */
export interface DamageStagesSource {
  readonly stage1?: DamageStageSpan | null;
  readonly stage2?: DamageStageSpan | null;
  readonly stage3?: DamageStageSpan | null;
}

/** The engine's split (owner): cracks 11–14, a hole with many pieces 6–10, a hole with fewer 1–5. */
export const DAMAGE_STAGES_DEFAULT: Readonly<Required<{ [K in keyof DamageStagesSource]: DamageStageSpan }>> = Object.freeze({
  stage1: Object.freeze({ min: 11, max: 14 }),
  stage2: Object.freeze({ min: 6, max: 10, pieces: 6 }),
  stage3: Object.freeze({ min: 1, max: 5, pieces: 3 }),
});

/** A kit's stages resolved for lookups: per integrity (0 … 15) its stage and crack strength, per stage its pieces. */
export interface DamageStages {
  /** Per integrity: its {@link DAMAGE_STAGE}. */
  readonly stage: Uint8Array;
  /** Per integrity: the crack overlay's strength (1 … 255) in stage 1, else 0. */
  readonly crack: Uint8Array;
  /** Per stage (0 … 3): the pieces a neighbour face carries (stages 2 and 3). */
  readonly pieces: Uint8Array;
  /** The resolved spans, as written to a piece table (stage 1, 2, 3; null: left out). */
  readonly spans: readonly (DamageStageSpan | null)[];
}

const STAGE_KEYS = ['stage1', 'stage2', 'stage3'] as const;

/** Whether a span is well formed: whole ends 1 … 14, min ≤ max, and pieces (stages 2, 3) 1 … {@link DAMAGE_PIECES_MAX}. */
function spanProblem(s: DamageStageSpan, stage: number): string | null {
  const whole = (v: unknown, lo: number, hi: number): boolean => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
  if (!whole(s.min, 1, SHAPE_FULL - 1) || !whole(s.max, 1, SHAPE_FULL - 1) || s.min > s.max) return `stage ${stage} is an integrity range min ≤ max within 1-${SHAPE_FULL - 1}`;
  if (s.pieces !== undefined && (stage === 1 || !whole(s.pieces, 1, DAMAGE_PIECES_MAX))) return stage === 1 ? 'stage 1 (cracks) has no pieces' : `stage ${stage} pieces is 1-${DAMAGE_PIECES_MAX}`;
  return null;
}

/**
 * A kit's stages resolved from what it sets (absent stages take the default
 * span, null ones are left out). Problems (a malformed span, two stages
 * overlapping) are returned, and the default stages drawn instead, never
 * thrown: the kit check reports them.
 */
export function resolveDamageStages(src: DamageStagesSource | undefined): { stages: DamageStages; problems: string[] } {
  const problems: string[] = [];
  const spans: (DamageStageSpan | null)[] = STAGE_KEYS.map((k, i) => {
    const s = src?.[k];
    if (s === null) return null;
    if (s === undefined) return DAMAGE_STAGES_DEFAULT[k];
    const p = spanProblem(s, i + 1);
    if (p !== null) problems.push(p);
    return p === null ? s : DAMAGE_STAGES_DEFAULT[k];
  });
  const stage = new Uint8Array(SHAPE_FULL + 1);
  let overlap = false;
  spans.forEach((s, k) => {
    if (s === null) return;
    for (let v = s.min; v <= s.max; v++) {
      if (stage[v] !== 0) overlap = true;
      stage[v] = k + 1;
    }
  });
  if (overlap) {
    problems.push('two damage stages share an integrity');
    return { stages: DAMAGE_STAGES, problems };
  }
  return { stages: stagesOf(spans, stage), problems };
}

function stagesOf(spans: readonly (DamageStageSpan | null)[], stage: Uint8Array): DamageStages {
  const crack = new Uint8Array(SHAPE_FULL + 1);
  const s1 = spans[0];
  // Stronger the lower the integrity within the stage: its highest integrity a quarter … its lowest full, for the default four.
  if (s1 !== null && s1 !== undefined) for (let v = s1.min; v <= s1.max; v++) crack[v] = Math.round((255 * (s1.max - v + 1)) / (s1.max - s1.min + 1));
  const pieces = new Uint8Array(4);
  for (const k of [2, 3] as const) {
    const s = spans[k - 1];
    if (s !== null && s !== undefined) pieces[k] = s.pieces ?? DAMAGE_STAGES_DEFAULT[STAGE_KEYS[k - 1]!].pieces!;
  }
  return Object.freeze({ stage, crack, pieces, spans: Object.freeze([...spans]) });
}

/** The default stages, resolved once (a material without a kit, a derive without a table). */
export const DAMAGE_STAGES: DamageStages = (() => {
  const spans = STAGE_KEYS.map((k) => DAMAGE_STAGES_DEFAULT[k]);
  const stage = new Uint8Array(SHAPE_FULL + 1);
  spans.forEach((s, k) => {
    for (let v = s.min; v <= s.max; v++) stage[v] = k + 1;
  });
  return stagesOf(spans, stage);
})();

/**
 * Light coverage (0 … 255) of a damaged construction cell: its integrity's
 * share of intact, so a damaged block lets light through by how broken it
 * is (as a prop's coverage fraction does); 255 for an intact one.
 */
export function integrityCoverage(integrity: number): number {
  return Math.round((255 * integrity) / SHAPE_FULL);
}
