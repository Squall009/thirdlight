/**
 * How a block layer is walked (`blockLayer.walk`): the step, drop and
 * headroom its walk queries use unless a query names its own, the cell field
 * that marks where walking is allowed, and the named region the editor's
 * reachability check walks from. Absent fields take the engine's defaults
 * (`defaultWalkSettings`), so a layer without `walk` walks as any other.
 *
 * Pure data: validation, the canonical form, and the settings a layer walks
 * with.
 */
import type { ModelErrorV2 } from './errors';
import { CELL_FIELD_KEY_RE, REGION_ID_RE, type BlockLayerComponent } from './block-layers';
import type { WalkSettings } from './block-walk';

export interface BlockLayerWalk {
  /** The region the reachability check walks from (absent: no check). */
  from?: string;
  /** How far a step may rise (m). */
  maxStep?: number;
  /** How far a step may drop (m). */
  maxDrop?: number;
  /** The free height a place needs above it (m). */
  headroom?: number;
  /** A boolean cell field: only tops whose cell has it true are walked (absent: every top). */
  field?: string;
  /** Steps across cell corners too. */
  diagonal?: boolean;
}

/** The engine's walk defaults for a layer (each overridable by the layer's `walk` and by a query). */
export function defaultWalkSettings(cellSize: readonly number[], maxSlope: number): WalkSettings {
  // Half a cell: a stair's front step; a whole row is a ledge, not a step. One row of headroom: the walker
  // stands in the cell above the top.
  return { maxStep: cellSize[1]! / 2, maxDrop: cellSize[1]! / 2, headroom: cellSize[1]!, maxSlope, diagonal: false };
}

/** The range of the walk's lengths (m). */
export const WALK_METRES_RANGE = Object.freeze({ min: 0, max: 64 });

const LENGTHS = ['maxStep', 'maxDrop', 'headroom'] as const;

function err(errors: ModelErrorV2[], code: string, path: string, message: string, found?: unknown): void {
  errors.push({ code, path, message, ...(found !== undefined ? { found } : {}) } as ModelErrorV2);
}

export function validateBlockLayerWalk(v: unknown, path: string, errors: ModelErrorV2[]): void {
  if (v === undefined) return;
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return err(errors, 'field_type', path, 'walk is {from?, maxStep?, maxDrop?, headroom?, field?, diagonal?}', v);
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!['from', 'maxStep', 'maxDrop', 'headroom', 'field', 'diagonal'].includes(k)) err(errors, 'field_unexpected', `${path}/${k}`, `walk has no field "${k}" (from, maxStep, maxDrop, headroom, field, diagonal)`, k);
  if (o['from'] !== undefined && (typeof o['from'] !== 'string' || !REGION_ID_RE.test(o['from']))) err(errors, 'field_value', `${path}/from`, 'walk.from is a region id', o['from']);
  for (const k of LENGTHS) {
    const n = o[k];
    if (n !== undefined && (typeof n !== 'number' || !Number.isFinite(n) || n < WALK_METRES_RANGE.min || n > WALK_METRES_RANGE.max)) err(errors, 'field_value', `${path}/${k}`, `walk.${k} is metres in ${WALK_METRES_RANGE.min}-${WALK_METRES_RANGE.max}`, n);
  }
  if (o['field'] !== undefined && (typeof o['field'] !== 'string' || !CELL_FIELD_KEY_RE.test(o['field']))) err(errors, 'field_value', `${path}/field`, 'walk.field is a cell field key', o['field']);
  if (o['diagonal'] !== undefined && typeof o['diagonal'] !== 'boolean') err(errors, 'field_type', `${path}/diagonal`, 'walk.diagonal is a boolean', o['diagonal']);
}

export function canonicalBlockLayerWalk(w: BlockLayerWalk | undefined): BlockLayerWalk | undefined {
  if (w === undefined) return undefined;
  const out: BlockLayerWalk = {
    ...(w.from !== undefined ? { from: w.from } : {}),
    ...(w.maxStep !== undefined ? { maxStep: w.maxStep === 0 ? 0 : w.maxStep } : {}),
    ...(w.maxDrop !== undefined ? { maxDrop: w.maxDrop === 0 ? 0 : w.maxDrop } : {}),
    ...(w.headroom !== undefined ? { headroom: w.headroom === 0 ? 0 : w.headroom } : {}),
    ...(w.field !== undefined ? { field: w.field } : {}),
    ...(w.diagonal === true ? { diagonal: true } : {}),
  };
  return Object.keys(out).length === 0 ? undefined : out;
}

/** The settings a layer walks with: a query's own, else the layer's `walk`, else the engine's defaults (`maxSlope`: the layer's, else `defaultMaxSlope`). */
export function walkSettingsOf(c: Pick<BlockLayerComponent, 'cellSize' | 'maxSlope' | 'walk'>, defaultMaxSlope: number, query: Partial<WalkSettings> = {}): WalkSettings {
  const d = defaultWalkSettings(c.cellSize, c.maxSlope ?? defaultMaxSlope);
  const w = c.walk ?? {};
  return {
    maxStep: query.maxStep ?? w.maxStep ?? d.maxStep,
    maxDrop: query.maxDrop ?? w.maxDrop ?? d.maxDrop,
    headroom: query.headroom ?? w.headroom ?? d.headroom,
    maxSlope: query.maxSlope ?? d.maxSlope,
    diagonal: query.diagonal ?? w.diagonal ?? d.diagonal,
  };
}
