/**
 * The Dressing card's edits, apart from its drawing: each returns the
 * dressing as the next `setDressing` sends it (the card holds no copy of
 * its own: it shows the project's record and sends a whole new one), or the
 * material as the next `setMaterial` sends it.
 *
 * A dressing is shared: every material that names it (or whose parent
 * does) grows by it, so {@link dressingUsers} is shown on the card.
 *
 * Pure.
 */
import type { FadeRange } from '@thirdlight/shared';
import type { DressingConditions, DressingDef, DressingNoise, DressingSpecies, MaterialDef } from '@thirdlight/project-model';
import { DRESSING_FORMAT, DRESSING_LIMITS } from '@thirdlight/project-model/dressing';
import { resolvedVoxelParts, voxelUseTakesKit, type MaterialVoxel } from '@thirdlight/project-model/voxel-materials';
import { DRESSING_CONDITIONS, type DressingConditionName } from '@thirdlight/voxel';

/** A new, empty dressing. */
export function newDressing(dressingId: string, name: string): DressingDef {
  return { dressingFormat: DRESSING_FORMAT, dressingId, name, species: [] };
}

/** What a species starts as: one cover plant a square metre, on every surface of the materials naming the dressing. */
export function newSpecies(model: string): DressingSpecies {
  return { model, class: 'cover', density: 1 };
}

const withList = (d: DressingDef, species: DressingSpecies[]): DressingDef => ({ ...d, species });

export function withName(d: DressingDef, name: string): DressingDef {
  return { ...d, name };
}

/** A species added at the end of the list (the others keep their places, so their plants stay where they are). */
export function withSpeciesAdded(d: DressingDef, model: string): DressingDef {
  return withList(d, [...d.species, newSpecies(model)]);
}

export function withSpeciesRemoved(d: DressingDef, index: number): DressingDef {
  return withList(d, d.species.filter((_, i) => i !== index));
}

/** Entry `index` moved to place `to` (null: no such move). An entry's place picks its plants' positions, so a move re-seats them. */
export function withSpeciesMoved(d: DressingDef, index: number, to: number): DressingDef | null {
  if (index < 0 || index >= d.species.length || to < 0 || to >= d.species.length || to === index) return null;
  const species = [...d.species];
  const [s] = species.splice(index, 1);
  species.splice(to, 0, s!);
  return withList(d, species);
}

/** Entry `index` with `patch` over it (a field set to undefined is left out: the format's default). */
export function withSpecies(d: DressingDef, index: number, patch: Partial<DressingSpecies>): DressingDef {
  return withList(d, d.species.map((s, i) => {
    if (i !== index) return s;
    const next: DressingSpecies = { ...s, ...patch };
    for (const k of Object.keys(patch) as (keyof DressingSpecies)[]) if (patch[k] === undefined) delete next[k];
    // A cover species' spacing has the cover job's bound; a class change brings it inside.
    if (next.class === 'cover' && next.spacing !== undefined && next.spacing > DRESSING_LIMITS.coverSpacingMax) next.spacing = DRESSING_LIMITS.coverSpacingMax;
    return next;
  }));
}

/** Entry `index` with condition `name` set (undefined: the condition is taken off; with none left the entry has no conditions). */
export function withCondition<K extends DressingConditionName>(d: DressingDef, index: number, name: K, value: DressingConditions[K] | undefined): DressingDef {
  const s = d.species[index];
  if (s === undefined) return d;
  const conditions: DressingConditions = {};
  // Kept in the format's order, whatever order they were set in.
  for (const k of DRESSING_CONDITIONS) {
    const v = k === name ? value : s.conditions?.[k];
    if (v !== undefined) (conditions as Record<string, unknown>)[k] = v;
  }
  return withSpecies(d, index, { conditions: Object.keys(conditions).length > 0 ? conditions : undefined });
}

/** A range with `patch` over it (an end set to undefined is open); undefined once nothing is left of it. */
export function rangeWith(r: FadeRange | undefined, patch: FadeRange): FadeRange | undefined {
  const next: FadeRange = { ...r, ...patch };
  for (const k of ['min', 'max', 'fade'] as const) if (next[k] === undefined || (k === 'fade' && next[k] === 0)) delete next[k];
  // A fade alone bounds nothing.
  return next.min === undefined && next.max === undefined ? undefined : next;
}

/** A species' scale range with one end set (an empty field: 1); the other end gives way so least ≤ most; undefined at [1, 1] (the default). */
export function scaleWith(scale: readonly [number, number] | undefined, end: 0 | 1, v: number | undefined): [number, number] | undefined {
  const value = v ?? 1;
  const other = scale?.[end === 0 ? 1 : 0] ?? 1;
  const next: [number, number] = end === 0 ? [value, Math.max(value, other)] : [Math.min(value, other), value];
  return next[0] === 1 && next[1] === 1 ? undefined : next;
}

/** The scale a noise condition starts with (metres between its bumps). */
export const NOISE_SCALE_START = 8;

/** A noise condition with `patch` over it; undefined once its range has no end left (the scale and seed alone bound nothing). */
export function noiseWith(n: DressingNoise | undefined, patch: Partial<DressingNoise>): DressingNoise | undefined {
  const ends: FadeRange = {};
  for (const k of ['min', 'max', 'fade'] as const) {
    const v = k in patch ? patch[k] : n?.[k];
    if (v !== undefined) ends[k] = v;
  }
  const range = rangeWith(ends, {});
  if (range === undefined) return undefined;
  const seed = 'seed' in patch ? patch.seed : n?.seed;
  return { ...range, scale: patch.scale ?? n?.scale ?? NOISE_SCALE_START, ...(seed !== undefined && seed !== 0 ? { seed } : {}) };
}

/** A set condition with `item` in or out of it; undefined once it lists nothing (any). */
export function setWith<T>(list: readonly T[] | undefined, item: T, on: boolean): T[] | undefined {
  const next = (list ?? []).filter((x) => x !== item);
  if (on) next.push(item);
  return next.length > 0 ? next : undefined;
}

/** The material (or instance) record naming `dressingId` (undefined: none of its own; an instance then grows what its parent does). */
export function materialWithDressing(m: MaterialDef, dressingId: string | undefined): MaterialDef {
  if (m.voxel === undefined) return m;
  const { dressing: _old, ...voxel } = m.voxel;
  return { ...m, voxel: dressingId === undefined ? (voxel as MaterialVoxel) : { ...voxel, dressing: dressingId } };
}

/** Whether a voxel use has a surface a dressing grows on (ground and construction: not a liquid, not a gas). */
export const voxelUseTakesDressing = voxelUseTakesKit;

export interface DressingUser {
  readonly materialId: string;
  readonly name: string;
  readonly voxelId: number;
  /** It names the dressing through its parent chain, not itself. */
  readonly inherited: boolean;
}

/** The voxel materials that grow by dressing `dressingId`: those naming it and the variants that take it from their parent. */
export function dressingUsers(materials: readonly MaterialDef[], dressingId: string): DressingUser[] {
  const parts = resolvedVoxelParts(materials);
  const out: DressingUser[] = [];
  for (const m of materials) {
    const v = parts.get(m.materialId);
    if (v === undefined || v.dressing !== dressingId) continue;
    out.push({ materialId: m.materialId, name: m.name, voxelId: v.id, inherited: m.voxel?.dressing !== dressingId });
  }
  return out.sort((a, b) => a.voxelId - b.voxelId);
}

/** A range condition's row on the card: its label, unit, the bounds its ends take and a step. */
export interface ConditionRangeRow {
  readonly name: Exclude<DressingConditionName, 'material' | 'role' | 'sky'>;
  readonly label: string;
  readonly unit: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly hint: string;
}

const D = DRESSING_LIMITS;
const HEIGHT_BOUND = 100000;

/** The seven range conditions, in the format's order (noise last, with its scale and seed beside it). */
export const CONDITION_RANGE_ROWS: readonly ConditionRangeRow[] = Object.freeze([
  { name: 'slope', label: 'Slope', unit: '°', min: 0, max: D.slopeMax, step: 1, hint: 'The ground\'s slope in degrees from level (0 flat, 90 a cliff).' },
  { name: 'height', label: 'Height', unit: 'm', min: -HEIGHT_BOUND, max: HEIGHT_BOUND, step: 0.5, hint: 'The surface\'s height in the world, metres.' },
  { name: 'wetness', label: 'Wetness', unit: '', min: 0, max: D.wetnessMax, step: 1, hint: `The surface cell's painted wetness, 0 dry to ${D.wetnessMax}.` },
  { name: 'waterDepth', label: 'Water depth', unit: 'm', min: 0, max: 1000, step: 0.1, hint: 'Metres of water standing on the surface (0: dry). Leave it out and the species also grows under a lake: grass wants a max of 0.' },
  { name: 'materialEdge', label: 'To another material', unit: 'm', min: 0, max: D.distanceMax, step: 0.25, hint: `Metres to the nearest surface of another material (a road's edge, a verge). Searched ${D.distanceMax} m out: ${D.distanceMax} also means "none nearer".` },
  { name: 'construction', label: 'To construction', unit: 'm', min: 0, max: D.distanceMax, step: 0.25, hint: `Metres to the nearest wall, floor or building. Searched ${D.distanceMax} m out: ${D.distanceMax} also means "none nearer".` },
  { name: 'noise', label: 'Noise', unit: '', min: 0, max: 1, step: 0.05, hint: 'A patchy pattern across the ground, 0 to 1: a min of 0.6 keeps the species to patches covering about a third of the ground.' },
] as const);

/** How many of the ten conditions a species carries. */
export function conditionCount(s: Pick<DressingSpecies, 'conditions'>): number {
  return s.conditions === undefined ? 0 : DRESSING_CONDITIONS.filter((k) => s.conditions![k] !== undefined).length;
}
