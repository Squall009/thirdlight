/**
 * The dressing rules' conditions: whether a species grows on a surface, and
 * how much of its density it keeps there. One arithmetic over the surface
 * fields (surface-fields.ts), read by the page, the derive workers and the
 * tests alike, so a plant stands where the editor says it will.
 *
 * A species' conditions ({@link DressingConditions}) are the ten the dressing
 * format names, each a set, a yes or no, or a range with soft ends
 * (`FadeRange`: 1 inside, fading to 0 over `fade` past an end):
 * - `material`: the surface cell's voxel material id is one of these;
 * - `role`: its role is one of these (names of the role traits table);
 * - `slope` (degrees), `height` (metres, the grid's own), `wetness` (0–7),
 *   `waterDepth` (metres of liquid standing on it; 0 dry), `materialEdge`
 *   and `construction` (metres, both capped at the surface fields' cap, which
 *   also says "none within it"): ranges;
 * - `sky`: true grows under open sky only, false only under cover;
 * - `noise`: a range over value noise in [0, 1] across the ground, its bumps
 *   `scale` metres apart, on its own `seed` (the brush mask's noise at one
 *   octave, read flat so sculpting a patch's ground does not move it).
 *
 * The answer is the product of the conditions' values: 0 does not grow, 1
 * grows at the species' full density, between them that share of it. A
 * condition left out is 1. {@link dressingWhyNot} names the first condition,
 * in {@link DRESSING_CONDITIONS} order, whose value is 0, from the same
 * table of checks the share is made of.
 *
 * **Props.** Rule plants keep clear of hand-placed props: a point inside a
 * prop's box across the ground, between a little under its foot and its top,
 * grows nothing ({@link clearedByProp}); the boxes are what the light stamps
 * read of a prop (prop-coverage.ts `propBounds` of its shape), so nothing is
 * stored for it.
 *
 * Pure: typed data in, numbers out; no three.js, no Node built-ins.
 */
import { fadeRangeAt, valueNoise01, type FadeRange } from '@thirdlight/shared';
import { VOXEL_SIZE_M } from './coords';
import { MATERIAL_ID_MAX } from './record';
import { propBounds, type PropShape } from './prop-coverage';
import { ROLE_SLOTS, ROLE_TRAITS } from './role-traits';
import type { SurfacePoint } from './surface-fields';

/** The conditions a species may carry, in the order they are checked and named. */
export const DRESSING_CONDITIONS = Object.freeze(['material', 'role', 'slope', 'height', 'sky', 'wetness', 'waterDepth', 'materialEdge', 'construction', 'noise'] as const);
export type DressingConditionName = (typeof DRESSING_CONDITIONS)[number];

/** Why a species does not grow at a point: the condition that failed, or a prop standing there. */
export type DressingWhyNot = DressingConditionName | 'prop';

/** The noise condition: a range over the noise's value, with the noise's own scale (metres) and seed. */
export interface DressingNoise extends FadeRange {
  scale: number;
  seed?: number;
}

/** A species' conditions, as its dressing stores them (each absent: any). */
export interface DressingConditions {
  material?: readonly number[];
  role?: readonly string[];
  slope?: FadeRange;
  height?: FadeRange;
  sky?: boolean;
  wetness?: FadeRange;
  waterDepth?: FadeRange;
  materialEdge?: FadeRange;
  construction?: FadeRange;
  noise?: DressingNoise;
}

/** The roles a surface can have (the roles drawn as a body), by name: what a `role` condition may list. */
export const DRESSING_ROLE_NAMES: readonly string[] = Object.freeze(ROLE_TRAITS.filter((t) => t.body && t.name !== null).map((t) => t.name!));

/** Conditions made ready to check many points: the sets as lookups, and whether a check reads the two distances. */
export interface DressingRule {
  readonly conditions: DressingConditions;
  /** 1 a voxel material id the `material` condition lists (null: any). */
  readonly materials: Uint8Array | null;
  /** A bit a role the `role` condition lists (−1: any). */
  readonly roles: number;
  /** The conditions read `materialEdge` or `construction`: the fields must be read with their distances. */
  readonly distances: boolean;
}

/** A species' conditions ready to check (`undefined`: no condition, grows on every surface). */
export function dressingRule(c: DressingConditions | undefined): DressingRule {
  const conditions = c ?? {};
  let materials: Uint8Array | null = null;
  if (conditions.material !== undefined) {
    materials = new Uint8Array(MATERIAL_ID_MAX + 1);
    for (const id of conditions.material) if (Number.isInteger(id) && id >= 0 && id <= MATERIAL_ID_MAX) materials[id] = 1;
  }
  let roles = -1;
  if (conditions.role !== undefined) {
    roles = 0;
    for (let r = 0; r < ROLE_SLOTS; r++) if (ROLE_TRAITS[r]!.name !== null && conditions.role.includes(ROLE_TRAITS[r]!.name!)) roles |= 1 << r;
  }
  return { conditions, materials, roles, distances: conditions.materialEdge !== undefined || conditions.construction !== undefined };
}

/** A distance field's value for a range: it must have been read (the fields give NaN without their distances). */
function distance(v: number, name: string): number {
  if (Number.isNaN(v)) throw new RangeError(`dressing rules: ${name} was not read (the surface's fields were asked without their distances)`);
  return v;
}

/** The noise condition's noise at a point across the ground (metres), in [0, 1]. */
export function dressingNoise(n: Pick<DressingNoise, 'scale' | 'seed'>, x: number, z: number): number {
  return valueNoise01(x / n.scale, z / n.scale, n.seed ?? 0);
}

/** Each condition's value at a surface (0 … 1; 1 where the species carries none), by name: the one table the share and the reason are both read from. */
const CHECKS: { readonly [K in DressingConditionName]: (r: DressingRule, p: SurfacePoint, x: number, z: number) => number } = {
  material: (r, p) => (r.materials === null || r.materials[p.material] === 1 ? 1 : 0),
  role: (r, p) => (r.roles === -1 || (r.roles & (1 << p.role)) !== 0 ? 1 : 0),
  slope: (r, p) => (r.conditions.slope === undefined ? 1 : fadeRangeAt(r.conditions.slope, p.slope)),
  height: (r, p) => (r.conditions.height === undefined ? 1 : fadeRangeAt(r.conditions.height, p.height)),
  sky: (r, p) => (r.conditions.sky === undefined || (p.sky === 1) === r.conditions.sky ? 1 : 0),
  wetness: (r, p) => (r.conditions.wetness === undefined ? 1 : fadeRangeAt(r.conditions.wetness, p.wetness)),
  waterDepth: (r, p) => (r.conditions.waterDepth === undefined ? 1 : fadeRangeAt(r.conditions.waterDepth, p.waterDepth)),
  materialEdge: (r, p) => (r.conditions.materialEdge === undefined ? 1 : fadeRangeAt(r.conditions.materialEdge, distance(p.materialEdge, 'materialEdge'))),
  construction: (r, p) => (r.conditions.construction === undefined ? 1 : fadeRangeAt(r.conditions.construction, distance(p.construction, 'construction'))),
  noise: (r, p, x, z) => (r.conditions.noise === undefined ? 1 : fadeRangeAt(r.conditions.noise, dressingNoise(r.conditions.noise, x, z))),
};

/**
 * The share (0 … 1) of a species' density that grows on surface `p` at
 * (x, z) metres across the ground: the product of its conditions' values, 0
 * as soon as one is.
 */
export function dressingShare(r: DressingRule, p: SurfacePoint, x: number, z: number): number {
  let f = 1;
  for (const name of DRESSING_CONDITIONS) {
    f *= CHECKS[name](r, p, x, z);
    if (f <= 0) return 0;
  }
  return f;
}

/** One condition's value at a surface (what a rule preview shows beside the condition). */
export function dressingConditionAt(r: DressingRule, name: DressingConditionName, p: SurfacePoint, x: number, z: number): number {
  return CHECKS[name](r, p, x, z);
}

/** Metres under a prop's foot that still count as under it (a prop sunk a little into the ground, or standing on a cell not filled to its top). */
export const DRESSING_CLEAR_UNDER_M = VOXEL_SIZE_M;

/** Floats a prop's box takes in a clearance list: its least corner, then its greatest (metres in the grid's frame). */
export const DRESSING_CLEAR_FLOATS = 6;

/** The clearance list of props' shapes where they stand: the box of each ({@link DRESSING_CLEAR_FLOATS} floats a prop). */
export function propClearances(shapes: readonly PropShape[]): Float32Array {
  const out = new Float32Array(shapes.length * DRESSING_CLEAR_FLOATS);
  shapes.forEach((s, i) => {
    const b = propBounds(s);
    out.set(b.min, i * DRESSING_CLEAR_FLOATS);
    out.set(b.max, i * DRESSING_CLEAR_FLOATS + 3);
  });
  return out;
}

/** Whether a prop keeps point (x, y, z) clear: it lies in a box across the ground, from {@link DRESSING_CLEAR_UNDER_M} under its foot to its top. */
export function clearedByProp(clear: Float32Array | undefined, x: number, y: number, z: number): boolean {
  if (clear === undefined) return false;
  for (let o = 0; o + DRESSING_CLEAR_FLOATS <= clear.length; o += DRESSING_CLEAR_FLOATS) {
    if (x >= clear[o]! && x <= clear[o + 3]! && z >= clear[o + 2]! && z <= clear[o + 5]! && y >= clear[o + 1]! - DRESSING_CLEAR_UNDER_M && y <= clear[o + 4]!) return true;
  }
  return false;
}

/**
 * Why a species grows nothing on surface `p` at (x, z): the first condition
 * whose value is 0, else `prop` where a prop keeps the point clear, else
 * null (it grows, at {@link dressingShare}).
 */
export function dressingWhyNot(r: DressingRule, p: SurfacePoint, x: number, z: number, clear?: Float32Array): DressingWhyNot | null {
  for (const name of DRESSING_CONDITIONS) if (CHECKS[name](r, p, x, z) <= 0) return name;
  return clearedByProp(clear, x, p.height, z) ? 'prop' : null;
}
