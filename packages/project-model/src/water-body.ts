/**
 * The `waterBody` component: a lake or pond as a definition on a scene
 * object, whose liquid voxels the editor's backend writes.
 *
 * - **The seed** is the object's own position (a point inside the basin).
 * - **`level`**: the surface's height in the scene, metres.
 * - **`material`**: the liquid's voxel material.
 * - **`reach`**: how far from the seed the body may spread, metres. It is the
 *   bound: water that would pass it is a breach.
 *
 * The body's liquid voxels are written by the level fill (`@thirdlight/voxel`
 * water/level-fill.ts): from the seed through every non-solid cell below the
 * level, bounded by solid voxels and by the reach; the top cells take the
 * partial fill. A body owns the liquid of its material connected to its seed:
 * regenerating clears that liquid and fills again, so no cell list is stored,
 * and liquid painted by hand against a body becomes part of it.
 *
 * In the editor, a ground edit or a structure regenerated inside a body's
 * reach writes the body again in the same undo step (ground, then buildings,
 * then water). A breach (the fill reaches the reach's edge or leaves the
 * loaded world below the level) writes nothing past the bound and is
 * flagged: a warning on the object and a marker where it leaks; the flag is
 * reported, never stored.
 *
 * Exports ship the liquid voxels; the record is authoring data and is left
 * out. At run time nothing regenerates.
 *
 * Pure data.
 */
import { isPlainObject } from '@thirdlight/shared';
import { MATERIAL_ID_MAX, VOXEL_WORLD_NAME_RE } from '@thirdlight/voxel';
import type { ModelErrorV2 } from './errors';

export interface WaterBodyComponent {
  /** The voxel world it fills (a `voxelWorld` object of its scene names it). */
  readonly world: string;
  /** The surface's height in the scene (metres). */
  readonly level: number;
  /** The liquid's voxel material id. */
  readonly material: number;
  /** How far from the seed the body may spread (metres, horizontal). */
  readonly reach: number;
}

/** A body's reach when none is set (metres): a lake of half a kilometre across. */
export const WATER_BODY_REACH_DEFAULT_M = 256;

/** The component's fields in canonical order. */
export const WATER_BODY_FIELDS: readonly string[] = Object.freeze(['world', 'level', 'material', 'reach']);

function err(errors: ModelErrorV2[], code: string, path: string, message: string, found?: unknown): void {
  errors.push({ code, path, message, ...(found !== undefined ? { found } : {}) } as ModelErrorV2);
}

export function validateWaterBodyComponent(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(value)) return err(errors, 'field_type', path, `waterBody is an object { ${WATER_BODY_FIELDS.join(', ')} }`, value);
  for (const k of Object.keys(value)) if (!WATER_BODY_FIELDS.includes(k)) err(errors, 'field_unexpected', `${path}/${k}`, `unknown waterBody field "${k}" (${WATER_BODY_FIELDS.join(', ')})`, k);
  const world = value['world'];
  if (world === undefined) err(errors, 'field_missing', `${path}/world`, "waterBody needs its voxel world's name");
  else if (typeof world !== 'string' || !VOXEL_WORLD_NAME_RE.test(world)) err(errors, 'field_value', `${path}/world`, `a world name matches ${VOXEL_WORLD_NAME_RE.source}`, world);
  const level = value['level'];
  if (level === undefined) err(errors, 'field_missing', `${path}/level`, 'waterBody needs its level (the surface height in metres)');
  else if (typeof level !== 'number' || !Number.isFinite(level)) err(errors, 'field_value', `${path}/level`, 'level is a height in metres (a finite number)', level);
  const material = value['material'];
  if (material === undefined) err(errors, 'field_missing', `${path}/material`, "waterBody needs its liquid's voxel material");
  else if (typeof material !== 'number' || !Number.isInteger(material) || material < 1 || material > MATERIAL_ID_MAX) err(errors, 'field_value', `${path}/material`, `material is a voxel material id (1-${MATERIAL_ID_MAX})`, material);
  const reach = value['reach'];
  if (reach !== undefined && (typeof reach !== 'number' || !Number.isFinite(reach) || reach <= 0)) err(errors, 'field_value', `${path}/reach`, 'reach is a distance in metres above 0', reach);
}

/** `waterBody` in canonical form, rebuilt field by field (the reach given its default when absent). */
export function canonicalWaterBody(c: WaterBodyComponent): WaterBodyComponent {
  return { world: c.world, level: c.level, material: c.material, reach: c.reach ?? WATER_BODY_REACH_DEFAULT_M };
}

/** A water body object as a scene holds it: its id, its body and where its seed stands (its position; null: no transform). */
export interface SceneWaterBody {
  readonly sceneId: string | null;
  readonly entityId: string;
  readonly body: WaterBodyComponent;
  readonly seed: readonly [number, number, number] | null;
}

/** Every water body object of the scenes (as stored), in scene and entity order. */
export function sceneWaterBodies(scenes: readonly unknown[]): SceneWaterBody[] {
  const out: SceneWaterBody[] = [];
  // A scene given twice (the project's read names its main scene among its scenes too) is read once.
  const seen = new Set<string>();
  for (const sc of scenes) {
    const entities = (sc as { entities?: unknown } | null)?.entities;
    if (!Array.isArray(entities)) continue;
    const sceneId = typeof (sc as { sceneId?: unknown }).sceneId === 'string' ? (sc as { sceneId: string }).sceneId : null;
    if (sceneId !== null && seen.has(sceneId)) continue;
    if (sceneId !== null) seen.add(sceneId);
    for (const e of entities as Array<{ id?: unknown; components?: Record<string, unknown> } | null>) {
      const b = e?.components?.['waterBody'] as Partial<WaterBodyComponent> | undefined;
      if (b === undefined || typeof e?.id !== 'string' || typeof b.world !== 'string' || typeof b.level !== 'number' || typeof b.material !== 'number') continue;
      const p = (e.components?.['transform'] as { position?: unknown } | undefined)?.position;
      const seed = Array.isArray(p) && p.length >= 3 && p.slice(0, 3).every((v) => typeof v === 'number') ? ([p[0], p[1], p[2]] as [number, number, number]) : null;
      out.push({ sceneId, entityId: e.id, body: { world: b.world, level: b.level, material: b.material, reach: typeof b.reach === 'number' ? b.reach : WATER_BODY_REACH_DEFAULT_M }, seed });
    }
  }
  return out;
}
