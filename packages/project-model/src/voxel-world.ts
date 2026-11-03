/**
 * The `voxelWorld` component: a scene entity that names one of the
 * project's voxel worlds (`voxels/<world>/`) and how it streams while the
 * scene is loaded (scenes change with `ctx.scenes.load/unload`).
 *
 * Every setting but the world is optional; absent, the voxel format's own
 * defaults apply (`@thirdlight/voxel`: the load ring, the collision ring,
 * the derive section edge and the saved-fields mask), so a default changed
 * there reaches every world that did not choose its own. Distances here are
 * metres; the voxel package counts cells of `VOXEL_SIZE_M`.
 *
 * - `ring`: chunks load within `loadRadius` across the ground and
 *   `loadHeight` above and below the focus, and stay until past
 *   `unloadRadius` / `unloadHeight` (the hysteresis; absent: the load
 *   distance plus the default ring's gap; never less than the load distance).
 * - `collision`: loaded chunks have physics bodies only within `radius`
 *   across the ground and `height` above and below a focus (never past the
 *   load ring, which holds the chunks).
 * - `levels`: the coarser levels of the world are drawn past `level0`
 *   (full detail, 0.5 m cells, within it), level 1 (1 m cells) to `level1`,
 *   level 2 (2 m cells) past that to the load ring. Level 0 always reaches
 *   at least as far as a chunk keeps its collider (the collision radius
 *   and the voxel format's hysteresis): the voxel package widens it.
 * - `sectionEdge`: the edge (cells) of the sections a chunk is derived in.
 * - `savedFields`: which fields of a runtime change a game save keeps
 *   (the overlay's saved-fields mask; the rest is dropped on quit).
 *
 * Pure data.
 */
import { isPlainObject } from '@thirdlight/shared';
import { DEFAULT_COLLISION_RING, DEFAULT_LEVEL_RINGS, DEFAULT_SAVED_FIELDS, DEFAULT_SECTION_EDGE, DEFAULT_STREAM_RING, PLANE_BIT, SECTION_EDGES, VOXEL_PLANES, VOXEL_SIZE_M, VOXEL_WORLD_NAME_RE, type SectionEdge, type VoxelPlane } from '@thirdlight/voxel';
import type { ModelErrorV2 } from './errors';
import { STREAMING_RADIUS_LIMITS } from './world-streaming';

export interface VoxelWorldRing {
  /** Metres across the ground within which chunks load. */
  loadRadius?: number;
  /** Metres across the ground past which loaded chunks go (below `loadRadius`: taken as it). */
  unloadRadius?: number;
  /** Metres above and below the focus within which chunks load. */
  loadHeight?: number;
  /** Metres above and below past which loaded chunks go (below `loadHeight`: taken as it). */
  unloadHeight?: number;
}

export interface VoxelWorldCollision {
  /** Metres across the ground from a focus within which chunks have bodies. */
  radius?: number;
  /** Metres above and below a focus within which chunks have bodies. */
  height?: number;
}

export interface VoxelWorldLevels {
  /** Metres across the ground from a focus within which the world is drawn at full detail. */
  level0?: number;
  /** Metres across the ground within which level 1 (1 m cells) is drawn; past it, level 2 (below `level0`: taken as it). */
  level1?: number;
}

export interface VoxelWorldComponent {
  /** The world's name: its folder `voxels/<world>/` in the project. */
  world: string;
  ring?: VoxelWorldRing;
  collision?: VoxelWorldCollision;
  levels?: VoxelWorldLevels;
  /** Cells along a derive section's edge (absent: the voxel default). */
  sectionEdge?: SectionEdge;
  /** The fields a game save keeps of a runtime change, in the voxel planes' order (absent: the voxel default). */
  savedFields?: VoxelPlane[];
}

export const VOXEL_WORLD_FIELDS: readonly string[] = Object.freeze(['world', 'ring', 'collision', 'levels', 'sectionEdge', 'savedFields']);
export const VOXEL_WORLD_RING_FIELDS = ['loadRadius', 'unloadRadius', 'loadHeight', 'unloadHeight'] as const;
export const VOXEL_WORLD_COLLISION_FIELDS = ['radius', 'height'] as const;
export const VOXEL_WORLD_LEVEL_FIELDS = ['level0', 'level1'] as const;

const cellsToMetres = (cells: number): number => cells * VOXEL_SIZE_M;

/** The voxel format's defaults in metres, as a world without its own settings streams. */
export const VOXEL_WORLD_DEFAULTS = Object.freeze({
  ring: Object.freeze({
    loadRadius: cellsToMetres(DEFAULT_STREAM_RING.loadRadius),
    unloadRadius: cellsToMetres(DEFAULT_STREAM_RING.unloadRadius),
    loadHeight: cellsToMetres(DEFAULT_STREAM_RING.loadHeight),
    unloadHeight: cellsToMetres(DEFAULT_STREAM_RING.unloadHeight),
  }),
  collision: Object.freeze({ radius: cellsToMetres(DEFAULT_COLLISION_RING.radius), height: cellsToMetres(DEFAULT_COLLISION_RING.height) }),
  levels: Object.freeze({ level0: cellsToMetres(DEFAULT_LEVEL_RINGS.radii[0]!), level1: cellsToMetres(DEFAULT_LEVEL_RINGS.radii[1]!) }),
  sectionEdge: DEFAULT_SECTION_EDGE,
  savedFields: Object.freeze(planesOf(DEFAULT_SAVED_FIELDS)),
});

/** Every voxel world setting resolved: metres, and the saved fields as the voxel planes' bit mask. */
export interface ResolvedVoxelWorld {
  readonly world: string;
  readonly ring: Readonly<Required<VoxelWorldRing>>;
  readonly collision: Readonly<Required<VoxelWorldCollision>>;
  readonly levels: Readonly<Required<VoxelWorldLevels>>;
  readonly sectionEdge: SectionEdge;
  readonly savedFields: number;
}

/** The planes of a `PLANE_BIT` mask, in the voxel planes' order. */
export function planesOf(mask: number): VoxelPlane[] {
  return VOXEL_PLANES.filter((p) => (mask & PLANE_BIT[p]) !== 0);
}

/** The `PLANE_BIT` mask of a list of planes. */
export function planeMaskOf(planes: readonly VoxelPlane[]): number {
  let mask = 0;
  for (const p of planes) mask |= PLANE_BIT[p];
  return mask;
}

/**
 * A world's settings with the voxel defaults filled in. An unload distance
 * left out keeps the default ring's gap past its load distance; one set below
 * its load distance is taken as the load distance (no hysteresis), since an
 * unload ring inside the load ring would drop chunks the ring just loaded.
 * Likewise a level-1 distance below the level-0 one is taken as it (no
 * level-1 band).
 */
export function resolveVoxelWorld(c: VoxelWorldComponent): ResolvedVoxelWorld {
  const D = VOXEL_WORLD_DEFAULTS;
  const r = c.ring ?? {};
  const loadRadius = r.loadRadius ?? D.ring.loadRadius;
  const loadHeight = r.loadHeight ?? D.ring.loadHeight;
  const level0 = c.levels?.level0 ?? D.levels.level0;
  return Object.freeze({
    world: c.world,
    ring: Object.freeze({
      loadRadius,
      unloadRadius: Math.max(loadRadius, r.unloadRadius ?? loadRadius + (D.ring.unloadRadius - D.ring.loadRadius)),
      loadHeight,
      unloadHeight: Math.max(loadHeight, r.unloadHeight ?? loadHeight + (D.ring.unloadHeight - D.ring.loadHeight)),
    }),
    collision: Object.freeze({ radius: c.collision?.radius ?? D.collision.radius, height: c.collision?.height ?? D.collision.height }),
    levels: Object.freeze({ level0, level1: Math.max(level0, c.levels?.level1 ?? D.levels.level1) }),
    sectionEdge: c.sectionEdge ?? D.sectionEdge,
    savedFields: c.savedFields !== undefined ? planeMaskOf(c.savedFields) : DEFAULT_SAVED_FIELDS,
  });
}

const L = STREAMING_RADIUS_LIMITS;
const inRange = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= L.min && v <= L.max;
function err(errors: ModelErrorV2[], code: string, path: string, message: string, found?: unknown): void {
  errors.push({ code, path, message, ...(found !== undefined ? { found } : {}) } as ModelErrorV2);
}

function validateDistances(v: unknown, path: string, what: string, keys: readonly string[], errors: ModelErrorV2[]): void {
  if (!isPlainObject(v)) return err(errors, 'field_type', path, `${what} is an object {${keys.map((k) => `${k}?`).join(', ')}} in metres`, v);
  for (const k of Object.keys(v)) if (!keys.includes(k)) err(errors, 'field_unexpected', `${path}/${k}`, `unknown ${what} field "${k}" (${keys.join(', ')})`, k);
  for (const k of keys) if (v[k] !== undefined && !inRange(v[k])) err(errors, 'field_value', `${path}/${k}`, `${k} is ${L.min}-${L.max} metres`, v[k]);
}

export function validateVoxelWorldComponent(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(value)) return err(errors, 'field_type', path, 'voxelWorld is an object { world, ring?, collision?, levels?, sectionEdge?, savedFields? }', value);
  for (const k of Object.keys(value)) if (!VOXEL_WORLD_FIELDS.includes(k)) err(errors, 'field_unexpected', `${path}/${k}`, `unknown voxelWorld field "${k}" (${VOXEL_WORLD_FIELDS.join(', ')})`, k);
  const world = value['world'];
  if (world === undefined) err(errors, 'field_missing', `${path}/world`, "voxelWorld needs its world's name");
  else if (typeof world !== 'string' || !VOXEL_WORLD_NAME_RE.test(world)) err(errors, 'field_value', `${path}/world`, `a world name matches ${VOXEL_WORLD_NAME_RE.source}`, world);
  if (value['ring'] !== undefined) {
    validateDistances(value['ring'], `${path}/ring`, 'ring', VOXEL_WORLD_RING_FIELDS, errors);
  }
  if (value['collision'] !== undefined) validateDistances(value['collision'], `${path}/collision`, 'collision', VOXEL_WORLD_COLLISION_FIELDS, errors);
  if (value['levels'] !== undefined) validateDistances(value['levels'], `${path}/levels`, 'levels', VOXEL_WORLD_LEVEL_FIELDS, errors);
  const edge = value['sectionEdge'];
  if (edge !== undefined && !(SECTION_EDGES as readonly unknown[]).includes(edge)) err(errors, 'field_value', `${path}/sectionEdge`, `sectionEdge is one of ${SECTION_EDGES.join(', ')} cells`, edge);
  const saved = value['savedFields'];
  if (saved !== undefined) {
    if (!Array.isArray(saved)) err(errors, 'field_type', `${path}/savedFields`, `savedFields is a list of ${VOXEL_PLANES.join(', ')}`, saved);
    else {
      saved.forEach((p, i) => {
        if (!(VOXEL_PLANES as readonly unknown[]).includes(p)) err(errors, 'field_value', `${path}/savedFields/${i}`, `a saved field is one of ${VOXEL_PLANES.join(', ')}`, p);
        else if (saved.indexOf(p) !== i) err(errors, 'field_value', `${path}/savedFields/${i}`, `"${String(p)}" is listed twice`, p);
      });
    }
  }
}

/** `voxelWorld` in canonical form: fields in order, only those set, saved fields in the voxel planes' order. */
export function canonicalVoxelWorld(c: VoxelWorldComponent): VoxelWorldComponent {
  const out: VoxelWorldComponent = { world: c.world };
  if (c.ring !== undefined) {
    const ring: VoxelWorldRing = {};
    for (const k of VOXEL_WORLD_RING_FIELDS) if (c.ring[k] !== undefined) ring[k] = c.ring[k];
    out.ring = ring;
  }
  if (c.collision !== undefined) {
    const collision: VoxelWorldCollision = {};
    for (const k of VOXEL_WORLD_COLLISION_FIELDS) if (c.collision[k] !== undefined) collision[k] = c.collision[k];
    out.collision = collision;
  }
  if (c.levels !== undefined) {
    const levels: VoxelWorldLevels = {};
    for (const k of VOXEL_WORLD_LEVEL_FIELDS) if (c.levels[k] !== undefined) levels[k] = c.levels[k];
    out.levels = levels;
  }
  if (c.sectionEdge !== undefined) out.sectionEdge = c.sectionEdge;
  if (c.savedFields !== undefined) out.savedFields = planesOf(planeMaskOf(c.savedFields));
  return out;
}
