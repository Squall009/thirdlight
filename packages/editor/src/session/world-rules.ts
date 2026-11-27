/**
 * The world edit mode's Rules rail, apart from its drawing: for the surface
 * under the cursor, what its material's dressing grows there and why each
 * species that does not, does not; and the surface's fields as numbers, so
 * a designer learns what to type into a condition.
 *
 * Whether a species grows, its share and the failing condition are the
 * dressing rules' own answers (`dressingWhyNot`, `dressingShare`: the
 * arithmetic the cover job runs); this module only puts them into words,
 * with the value read beside the range it was checked against.
 *
 * Pure.
 */
import type { DressingDef, DressingSpecies, MaterialDef } from '@thirdlight/project-model';
import { voxelDressingIds } from '@thirdlight/project-model/voxel-materials';
import { DRESSING_CONDITIONS, dressingConditionAt, dressingNoise, dressingRule, dressingShare, dressingWhyNot, roleTraits, SURFACE_DISTANCE_CAP_M, type DressingConditions, type DressingWhyNot, type SurfacePoint } from '@thirdlight/voxel';
import type { FadeRange } from '@thirdlight/shared';

/** One species of the dressing at the point. */
export interface RuleSpeciesAnswer {
  /** Its place in the dressing's list. */
  readonly index: number;
  readonly model: string;
  readonly class: DressingSpecies['class'];
  /** Whether it grows here (a large species is never placed yet). */
  readonly grows: boolean;
  /** The share of its density kept here, 0 … 1 (0 where it does not grow). */
  readonly share: number;
  /** The first failing condition, a prop standing here, or null. */
  readonly why: DressingWhyNot | null;
  /** The answer in a sentence. */
  readonly text: string;
}

/** A field of the surface as the rail lists it. */
export interface RuleFieldRow {
  readonly name: string;
  readonly label: string;
  readonly value: string;
}

export interface RulesAnswer {
  /** The surface's material (null: no project material has its voxel id). */
  readonly material: { readonly voxelId: number; readonly materialId: string | null; readonly name: string };
  /** The dressing that material grows by (null: it names none, or the one it names is gone). */
  readonly dressing: { readonly dressingId: string; readonly name: string } | null;
  /** Why nothing is listed (no dressing, an empty one); null with species. */
  readonly note: string | null;
  readonly species: readonly RuleSpeciesAnswer[];
  readonly fields: readonly RuleFieldRow[];
}

const num = (v: number, digits = 1): string => {
  const t = v.toFixed(digits);
  return t.includes('.') ? t.replace(/\.?0+$/, '') : t;
};

/** A distance field in words: capped at the search's reach, which also means "none nearer". */
const distanceText = (v: number): string => (Number.isNaN(v) ? 'not read' : v >= SURFACE_DISTANCE_CAP_M ? `${SURFACE_DISTANCE_CAP_M} m or more (none within ${SURFACE_DISTANCE_CAP_M} m)` : `${num(v, 2)} m`);

/** A range in words: "0–35°", "at least 2 m", "at most 0 m", with its fade. */
function rangeText(r: FadeRange, unit: string): string {
  const u = unit === '' ? '' : unit === '°' ? '°' : ` ${unit}`;
  const body = r.min !== undefined && r.max !== undefined ? `${num(r.min, 2)}–${num(r.max, 2)}${u}` : r.min !== undefined ? `at least ${num(r.min, 2)}${u}` : r.max !== undefined ? `at most ${num(r.max, 2)}${u}` : 'any';
  return r.fade !== undefined && r.fade > 0 ? `${body}, fading over ${num(r.fade, 2)}${u}` : body;
}

const RANGE_FIELDS: Readonly<Record<string, { label: string; unit: string; value: (p: SurfacePoint) => number }>> = Object.freeze({
  slope: { label: 'the slope', unit: '°', value: (p) => p.slope },
  height: { label: 'the height', unit: 'm', value: (p) => p.height },
  wetness: { label: 'the wetness', unit: '', value: (p) => p.wetness },
  waterDepth: { label: 'the water depth', unit: 'm', value: (p) => p.waterDepth },
  materialEdge: { label: 'the distance to another material', unit: 'm', value: (p) => p.materialEdge },
  construction: { label: 'the distance to construction', unit: 'm', value: (p) => p.construction },
});

const roleName = (role: number): string => roleTraits(role).name ?? `role ${role}`;

/** Why a species does not grow, in words: the failing condition with the value read against what the condition asks. */
export function whyNotText(why: DressingWhyNot, c: DressingConditions, p: SurfacePoint, x: number, z: number, materialName: (voxelId: number) => string): string {
  switch (why) {
    case 'prop':
      return 'a static prop stands here (rule plants keep clear of its box)';
    case 'material':
      return `the material here is ${materialName(p.material)} (${p.material}); it grows on ${(c.material ?? []).map((id) => `${materialName(id)} (${id})`).join(', ')}`;
    case 'role':
      return `the surface here is ${roleName(p.role)}; it grows on ${(c.role ?? []).join(', ')}`;
    case 'sky':
      return c.sky === true ? 'it is under cover here; it grows under open sky only' : 'it is under open sky here; it grows under cover only';
    case 'noise': {
      const n = c.noise!;
      return `the noise here is ${num(dressingNoise(n, x, z), 2)}; it grows where it is ${rangeText(n, '')} (bumps ${num(n.scale, 1)} m apart${n.seed !== undefined ? `, seed ${n.seed}` : ''})`;
    }
    default: {
      const f = RANGE_FIELDS[why]!;
      const v = f.value(p);
      const read = why === 'materialEdge' || why === 'construction' ? distanceText(v) : `${num(v, 2)}${f.unit === '°' ? '°' : f.unit === '' ? '' : ` ${f.unit}`}`;
      return `${f.label} here is ${read}; it grows where it is ${rangeText(c[why]!, f.unit)}`;
    }
  }
}

/** The surface's fields as the rail lists them: what each condition would be checked against here. */
export function ruleFieldRows(p: SurfacePoint, materialName: (voxelId: number) => string): RuleFieldRow[] {
  return [
    { name: 'material', label: 'Material', value: `${materialName(p.material)} · ${p.material}` },
    { name: 'role', label: 'Role', value: roleName(p.role) },
    { name: 'slope', label: 'Slope', value: `${num(p.slope, 1)}°` },
    { name: 'height', label: 'Height', value: `${num(p.height, 2)} m` },
    { name: 'sky', label: 'Sky', value: p.sky === 1 ? 'open' : 'under cover' },
    { name: 'wetness', label: 'Wetness', value: String(p.wetness) },
    { name: 'waterDepth', label: 'Water depth', value: p.waterDepth > 0 ? `${num(p.waterDepth, 2)} m` : '0 m (dry)' },
    { name: 'materialEdge', label: 'To another material', value: distanceText(p.materialEdge) },
    { name: 'construction', label: 'To construction', value: distanceText(p.construction) },
  ];
}

/**
 * What grows at a surface and why not: `p` the surface's fields read with
 * their distances, (x, z) where on the ground (metres: the noise is read
 * there), `clear` the boxes of the props cover keeps clear of.
 */
export function rulesAt(input: { readonly materials: readonly MaterialDef[]; readonly dressings: readonly DressingDef[]; readonly point: SurfacePoint; readonly x: number; readonly z: number; readonly clear?: Float32Array | null }): RulesAnswer {
  const { materials, point: p, x, z } = input;
  const byVoxel = new Map(materials.flatMap((m) => (m.voxel !== undefined ? [[m.voxel.id, m] as const] : [])));
  const materialName = (id: number): string => byVoxel.get(id)?.name ?? `voxel material ${id}`;
  const here = byVoxel.get(p.material);
  const material = { voxelId: p.material, materialId: here?.materialId ?? null, name: materialName(p.material) };
  const fields = ruleFieldRows(p, materialName);
  const dressingId = voxelDressingIds(materials).get(p.material);
  if (dressingId === undefined) return { material, dressing: null, note: `${material.name} names no dressing: nothing grows on it by rule. Give it one on its material (Project → the material → Dressing).`, species: [], fields };
  const d = input.dressings.find((x2) => x2.dressingId === dressingId);
  if (d === undefined) return { material, dressing: null, note: `${material.name} names the dressing "${dressingId}", which the project does not hold.`, species: [], fields };
  const dressing = { dressingId: d.dressingId, name: d.name };
  if (d.species.length === 0) return { material, dressing, note: `${d.name} has no species yet: nothing grows.`, species: [], fields };
  const clear = input.clear ?? undefined;
  const species = d.species.map((s, index): RuleSpeciesAnswer => {
    const base = { index, model: s.model, class: s.class };
    if (s.class !== 'cover') return { ...base, grows: false, share: 0, why: null, text: 'a large species: stored with the dressing, placed in a later phase' };
    const rule = dressingRule(s.conditions);
    const why = dressingWhyNot(rule, p, x, z, clear);
    if (why !== null) return { ...base, grows: false, share: 0, why, text: `does not grow: ${whyNotText(why, s.conditions ?? {}, p, x, z, materialName)}` };
    const share = dressingShare(rule, p, x, z);
    // The conditions thinning it here: those whose own value is under 1 (the rules' own reading of each).
    const fading = share < 1 ? DRESSING_CONDITIONS.filter((k) => dressingConditionAt(rule, k, p, x, z) < 1) : [];
    return { ...base, grows: true, share, why: null, text: share >= 1 ? `grows at its full density (${num(s.density, 2)} /m²)` : `grows at ${Math.round(share * 100)} % of its density (${num(s.density * share, 2)} of ${num(s.density, 2)} /m²): a condition is fading here (${fading.join(', ')})` };
  });
  return { material, dressing, note: null, species, fields };
}
