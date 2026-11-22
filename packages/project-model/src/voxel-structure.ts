/**
 * The `voxelStructure` component: a building's definition on a scene
 * object. The structure owns one grid of a voxel world (`world`, `grid`):
 * the voxels in that grid are what its generator writes from the
 * definition, plus the hand edits kept over them (the grid's overrides).
 * The definition is authoring data: the game, the light, collision and
 * exports read the voxels, never this component, and exports leave it out.
 *
 * The record's fields after `world` and `grid` are the voxel package's
 * structure definition (`@thirdlight/voxel` structures/definition.ts),
 * checked and rebuilt field by field there: this module only adds where
 * the voxels go. Where the grid stands is the object's own transform: its
 * position, and a turn about the vertical axis only (floors stay level,
 * never a tilt or a scale), so moving a structure rewrites no voxel.
 *
 * A structure object stands in its scene's frame (a root object, or in a
 * folder), and no two structures of a world in a scene share a grid; the
 * backend writes its voxels only in a scene that holds its world's
 * `voxelWorld` object.
 *
 * Pure data.
 */
import { isPlainObject } from '@thirdlight/shared';
import { parseStructureDefinition, StructureDefinitionError, VOXEL_WORLD_NAME_RE, type GridPlacement, type StructureDefinition } from '@thirdlight/voxel';
import type { ModelErrorV2 } from './errors';

/** The definition's parts as the voxel package types them (the descriptor's JSON fields name them). */
export type { FootprintPolygon, StructureDefinition, StructureOpening, StructureStair } from '@thirdlight/voxel';

/** The highest structure grid id (region files carry it as a u32; 0 is the world grid). */
export const VOXEL_STRUCTURE_GRID_MAX = 0xffffffff;

/** How far a structure's rotation quaternion's x and z may stray from 0 and still turn about the vertical axis only. */
export const STRUCTURE_YAW_TOLERANCE = 1e-6;

export interface VoxelStructureComponent extends StructureDefinition {
  /** The voxel world whose grid it owns (`voxels/<world>/`). */
  readonly world: string;
  /** Its grid id in that world (≥ 1; the grid's files are `grid-<id>/`). */
  readonly grid: number;
}

/** The component's fields in canonical order: where the voxels go, then the definition's own. */
export const VOXEL_STRUCTURE_FIELDS: readonly string[] = Object.freeze(['world', 'grid', 'footprint', 'storeys', 'storeyHeight', 'foundationDepth', 'roof', 'materials', 'openings', 'stairs', 'generator']);

function err(errors: ModelErrorV2[], code: string, path: string, message: string, found?: unknown): void {
  errors.push({ code, path, message, ...(found !== undefined ? { found } : {}) } as ModelErrorV2);
}

/** The definition part of a component value (everything but `world` and `grid`). */
export function structureDefinitionOf(value: Record<string, unknown>): Record<string, unknown> {
  const { world: _w, grid: _g, ...def } = value;
  return def;
}

/**
 * The component's fields: the world's name, the grid id, and the definition
 * by its own field checks (types, ranges, names, each polygon's outline).
 * What needs the building's plan (an opening on an outside wall, a stair
 * inside its polygon) is the generator's, checked when the backend writes
 * the voxels.
 */
export function validateVoxelStructureComponent(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(value)) return err(errors, 'field_type', path, `voxelStructure is an object { ${VOXEL_STRUCTURE_FIELDS.join(', ')} }`, value);
  const world = value['world'];
  if (world === undefined) err(errors, 'field_missing', `${path}/world`, "voxelStructure needs its voxel world's name");
  else if (typeof world !== 'string' || !VOXEL_WORLD_NAME_RE.test(world)) err(errors, 'field_value', `${path}/world`, `a world name matches ${VOXEL_WORLD_NAME_RE.source}`, world);
  const grid = value['grid'];
  if (grid === undefined) err(errors, 'field_missing', `${path}/grid`, 'voxelStructure needs its grid id (the backend gives a new structure the next free one)');
  else if (typeof grid !== 'number' || !Number.isInteger(grid) || grid < 1 || grid > VOXEL_STRUCTURE_GRID_MAX) err(errors, 'field_value', `${path}/grid`, `grid is a whole number 1 … ${VOXEL_STRUCTURE_GRID_MAX} (0 is the world grid)`, grid);
  try {
    parseStructureDefinition(structureDefinitionOf(value));
  } catch (e) {
    if (!(e instanceof StructureDefinitionError)) throw e;
    err(errors, e.message.includes('unknown field') ? 'field_unexpected' : 'field_value', `${path}${e.path}`, e.message);
  }
}

/** `voxelStructure` in canonical form: `world`, `grid`, then the definition rebuilt field by field (every field kept). */
export function canonicalVoxelStructure(c: VoxelStructureComponent): VoxelStructureComponent {
  return { world: c.world, grid: c.grid, ...parseStructureDefinition(structureDefinitionOf(c as unknown as Record<string, unknown>)) };
}

/** A structure's place from its object's transform: the position, and the yaw of a rotation about the vertical axis. */
export function structurePlacementOf(gridId: number, transform: { readonly position: readonly number[]; readonly rotation: readonly number[] }): GridPlacement {
  const [, y, , w] = transform.rotation as [number, number, number, number];
  return { gridId, position: [transform.position[0]!, transform.position[1]!, transform.position[2]!], yawRad: 2 * Math.atan2(y, w) };
}

/** Why a structure object's transform is refused (null: a place and a yaw). */
export function structureTransformProblem(t: { readonly rotation: readonly number[]; readonly scale: readonly number[] }): { field: 'rotation' | 'scale'; message: string } | null {
  if (!(t.scale[0] === 1 && t.scale[1] === 1 && t.scale[2] === 1)) return { field: 'scale', message: 'a structure is at unit scale [1, 1, 1]: a building is made bigger in its definition (whole cells), never stretched' };
  if (Math.abs(t.rotation[0]!) > STRUCTURE_YAW_TOLERANCE || Math.abs(t.rotation[2]!) > STRUCTURE_YAW_TOLERANCE) return { field: 'rotation', message: 'a structure turns about the vertical axis only (its floors stay level): its rotation is [0, sin(yaw/2), 0, cos(yaw/2)]' };
  return null;
}

/** A structure object as a scene holds it: its id, component and transform. */
export interface SceneStructure {
  readonly entityId: string;
  readonly component: VoxelStructureComponent;
  readonly transform: { readonly position: readonly number[]; readonly rotation: readonly number[]; readonly scale: readonly number[] } | null;
}

/** Every structure object of the scenes (as stored), in scene and entity order. */
export function sceneStructures(scenes: readonly unknown[]): Array<SceneStructure & { readonly sceneId: string | null }> {
  const out: Array<SceneStructure & { readonly sceneId: string | null }> = [];
  // A scene given twice (the project's read names its main scene among its scenes too) is read once.
  const seen = new Set<string>();
  for (const sc of scenes) {
    const entities = (sc as { entities?: unknown } | null)?.entities;
    if (!Array.isArray(entities)) continue;
    const sceneId = typeof (sc as { sceneId?: unknown }).sceneId === 'string' ? (sc as { sceneId: string }).sceneId : null;
    if (sceneId !== null && seen.has(sceneId)) continue;
    if (sceneId !== null) seen.add(sceneId);
    for (const e of entities as Array<{ id?: unknown; components?: Record<string, unknown> } | null>) {
      const c = e?.components?.['voxelStructure'] as VoxelStructureComponent | undefined;
      if (c === undefined || typeof e?.id !== 'string' || typeof c.world !== 'string' || typeof c.grid !== 'number') continue;
      const t = e.components?.['transform'] as SceneStructure['transform'] | undefined;
      out.push({ sceneId, entityId: e.id, component: c, transform: t ?? null });
    }
  }
  return out;
}

/**
 * Where each world's structure grids stand, from the structure objects of the scenes: by world, a placement a grid
 * (the first object naming a grid wins; the commands keep a grid to one object), sorted by grid id.
 */
export function structurePlacements(scenes: readonly unknown[]): Map<string, GridPlacement[]> {
  const out = new Map<string, GridPlacement[]>();
  for (const s of sceneStructures(scenes)) {
    if (s.transform === null) continue;
    const list = out.get(s.component.world) ?? [];
    if (list.some((p) => p.gridId === s.component.grid)) continue;
    list.push(structurePlacementOf(s.component.grid, s.transform));
    out.set(s.component.world, list);
  }
  for (const list of out.values()) list.sort((a, b) => a.gridId - b.gridId);
  return out;
}

/**
 * The scene rule of structure objects over a structurally valid scene: no two structures of a world on one grid.
 * (That a structure's scene holds its world's `voxelWorld` object is the backend's check, when it writes the
 * voxels: a scene may be built in any order.)
 */
export function checkSceneStructures(entities: readonly { readonly id: string; readonly components: Record<string, unknown> }[], errors: ModelErrorV2[]): void {
  const grids = new Map<string, string>();
  entities.forEach((e, idx) => {
    const c = e.components['voxelStructure'] as VoxelStructureComponent | undefined;
    if (c === undefined) return;
    const key = `${c.world}\u0000${c.grid}`;
    const other = grids.get(key);
    if (other !== undefined) err(errors, 'field_value', `/entities/${idx}/components/voxelStructure/grid`, `grid ${c.grid} of world "${c.world}" is ${other}'s: a structure owns its grid`, c.grid);
    else grids.set(key, e.id);
  });
}
