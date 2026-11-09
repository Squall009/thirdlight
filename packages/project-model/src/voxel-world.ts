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
 *   level 2 (2 m cells) past that to the load ring. Level 0 is also the
 *   detail-piece ring: kit pieces are drawn where level 0 is and nowhere
 *   else. Level 0 always reaches at least as far as a chunk keeps its
 *   collider (the collision radius and the voxel format's hysteresis): the
 *   voxel package widens it. `relief`: surfaces within it of a focus are
 *   drawn with relief (meshed finer per derive section and moved by their
 *   materials' heights, fading to none at it; 0: none); how fine is the
 *   quality level's (`voxelRelief`, its tier's: none on low), so a level
 *   without relief draws none at any distance. Never past `level0`.
 * - `quality`: per quality level id, how the distances above change at that
 *   level: `scale` (every distance times it, in place of the level's own
 *   `voxelRings` scale), or distances of its own (`ring`, `collision`,
 *   `levels`, metres, each one set replacing the scaled one). A level the
 *   scene does not name scales by its own `voxelRings` (absent: its tier's).
 *   No ring distance is fixed anywhere else: the voxel package's defaults
 *   apply only where a scene leaves a distance out.
 * - `sectionEdge`: the edge (cells) of the sections a chunk is derived in.
 * - `savedFields`: which fields of a runtime change a game save keeps
 *   (the overlay's saved-fields mask; the rest is dropped on quit).
 * - `decalLayers`: the decal layers the world's surfaces and kit pieces are
 *   in, as any drawn object's (absent: every layer). A draw setting only:
 *   it never changes how the world streams.
 *
 * Pure data.
 */
import { isPlainObject } from '@thirdlight/shared';
import { DEFAULT_QUALITY_LEVELS, levelVoxels, QUALITY_LEVEL_ID_RE, qualityLevelOf, VOXEL_RING_SCALE_MAX, VOXEL_RING_SCALE_MIN, type QualityLevelConfig } from './quality-levels';
import { DEFAULT_COLLISION_RING, DEFAULT_LEVEL_RINGS, DEFAULT_RELIEF_RADIUS_CELLS, DEFAULT_SAVED_FIELDS, DEFAULT_SECTION_EDGE, DEFAULT_STREAM_RING, PLANE_BIT, SECTION_EDGES, VOXEL_PLANES, VOXEL_SIZE_M, VOXEL_WORLD_NAME_RE, type FarFieldMode, type SectionEdge, type VoxelPlane } from '@thirdlight/voxel';
import { validateDecalLayerMask } from './decals';
import type { ModelErrorV2 } from './errors';
import { STREAMING_RADIUS_LIMITS } from './world-streaming';

/** The project settings key of the voxel piece seed: which of a kit slot's meshes each piece draws, and its jitter. */
export const VOXEL_PIECE_SEED_KEY = 'voxel_piece_seed';

/** The largest voxel piece seed (a voxel piece table holds a u32). */
export const VOXEL_PIECE_SEED_MAX = 0xffffffff;

/** The project's voxel piece seed (its settings' `voxel_piece_seed`; absent or out of range: 0). */
export function voxelPieceSeedOf(settings: unknown): number {
  const v = typeof settings === 'object' && settings !== null ? (settings as Record<string, unknown>)[VOXEL_PIECE_SEED_KEY] : undefined;
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= VOXEL_PIECE_SEED_MAX ? v : 0;
}

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
  /** Metres from a focus within which surfaces are drawn with relief (0: none; past `level0`: taken as it). */
  relief?: number;
}

/** A world's ring distances (metres), each group and field optional: what a scene, a quality level of it, or a script sets. */
export interface VoxelWorldRings {
  ring?: VoxelWorldRing;
  collision?: VoxelWorldCollision;
  levels?: VoxelWorldLevels;
}

/** A scene's distances at one quality level: a scale of its own distances, and distances that replace the scaled ones. */
export interface VoxelWorldQuality extends VoxelWorldRings {
  /** 0.25–4: every distance times this at the level (absent: the level's `voxelRings`, else its tier's). */
  scale?: number;
}

export interface VoxelWorldComponent extends VoxelWorldRings {
  /** The world's name: its folder `voxels/<world>/` in the project. */
  world: string;
  /** Per quality level id, the distances at that level (absent: the level's scale of the distances above). */
  quality?: Record<string, VoxelWorldQuality>;
  /** Cells along a derive section's edge (absent: the voxel default). */
  sectionEdge?: SectionEdge;
  /** The fields a game save keeps of a runtime change, in the voxel planes' order (absent: the voxel default). */
  savedFields?: VoxelPlane[];
  /** The decal layers its draws are in (absent: every layer). */
  decalLayers?: number;
}

export const VOXEL_WORLD_FIELDS: readonly string[] = Object.freeze(['world', 'ring', 'collision', 'levels', 'quality', 'sectionEdge', 'savedFields', 'decalLayers']);
export const VOXEL_WORLD_QUALITY_FIELDS = ['scale', 'ring', 'collision', 'levels'] as const;
export const VOXEL_WORLD_RING_FIELDS = ['loadRadius', 'unloadRadius', 'loadHeight', 'unloadHeight'] as const;
export const VOXEL_WORLD_COLLISION_FIELDS = ['radius', 'height'] as const;
export const VOXEL_WORLD_LEVEL_FIELDS = ['level0', 'level1', 'relief'] as const;
/** Distance fields that may be 0 (none) rather than at least `STREAMING_RADIUS_LIMITS.min`. */
const ZERO_ALLOWED: ReadonlySet<string> = new Set(['relief']);

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
  levels: Object.freeze({ level0: cellsToMetres(DEFAULT_LEVEL_RINGS.radii[0]!), level1: cellsToMetres(DEFAULT_LEVEL_RINGS.radii[1]!), relief: cellsToMetres(DEFAULT_RELIEF_RADIUS_CELLS) }),
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
  /** The quality level the distances are for (null: none known; the scene's own distances). */
  readonly quality: string | null;
  /** The level's stream memory budget in bytes (null: none known; the host's, else the low tier's). */
  readonly budgetBytes: number | null;
  /** Relief lattice steps a cell in the relief ring (the level's `voxelRelief`; 0: none, and with no level known). */
  readonly reliefSteps: number;
  /** How the world is drawn past its near rings and the far nodes' on-screen error (the level's `voxelFarField`, `voxelFarError`; with no level known, the medium tier's). */
  readonly far: { readonly mode: FarFieldMode; readonly errorPixels: number };
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

/** The scene's own distances, the voxel defaults where it leaves one out (an unload distance: the default ring's gap past its load distance). */
function baseRings(c: VoxelWorldRings): { ring: Required<VoxelWorldRing>; collision: Required<VoxelWorldCollision>; levels: Required<VoxelWorldLevels> } {
  const D = VOXEL_WORLD_DEFAULTS;
  const r = c.ring ?? {};
  const loadRadius = r.loadRadius ?? D.ring.loadRadius;
  const loadHeight = r.loadHeight ?? D.ring.loadHeight;
  return {
    ring: { loadRadius, unloadRadius: r.unloadRadius ?? loadRadius + (D.ring.unloadRadius - D.ring.loadRadius), loadHeight, unloadHeight: r.unloadHeight ?? loadHeight + (D.ring.unloadHeight - D.ring.loadHeight) },
    collision: { radius: c.collision?.radius ?? D.collision.radius, height: c.collision?.height ?? D.collision.height },
    levels: { level0: c.levels?.level0 ?? D.levels.level0, level1: c.levels?.level1 ?? D.levels.level1, relief: c.levels?.relief ?? D.levels.relief },
  };
}

/**
 * A world's settings with the voxel defaults filled in, at a quality level
 * (`level`; null or absent: none known, the scene's own distances and no
 * budget). At a level every distance is scaled (the scene's `quality`
 * entry's `scale`, else the level's `voxelRings`, else its tier's), then
 * replaced where the entry sets one of its own. An unload distance below
 * its load distance is taken as the load distance (no hysteresis), since an
 * unload ring inside the load ring would drop chunks the ring just loaded.
 * Likewise a level-1 distance below the level-0 one is taken as it (no
 * level-1 band). A scaled distance stays within the limits an authored one
 * has ({@link STREAMING_RADIUS_LIMITS}).
 */
export function resolveVoxelWorld(c: VoxelWorldComponent, level?: QualityLevelConfig | null): ResolvedVoxelWorld {
  const D = VOXEL_WORLD_DEFAULTS;
  const b = baseRings(c);
  const at = level === null || level === undefined ? null : levelVoxels(level);
  const own = level === null || level === undefined ? undefined : c.quality?.[level.id];
  const k = own?.scale ?? at?.ringScale ?? 1;
  // The relief distance has its tier's own scale (sized by what is seen, not by the budget's area).
  const kRelief = own?.scale ?? at?.reliefScale ?? 1;
  const pick = (group: keyof VoxelWorldRings, field: string): number => {
    const set = (own?.[group] as Readonly<Record<string, number | undefined>> | undefined)?.[field];
    if (set !== undefined) return set;
    const scaled = (b[group] as Readonly<Record<string, number>>)[field]! * (field === 'relief' ? kRelief : k);
    if (scaled === 0 && ZERO_ALLOWED.has(field)) return 0;
    return Math.min(STREAMING_RADIUS_LIMITS.max, Math.max(STREAMING_RADIUS_LIMITS.min, scaled));
  };
  const loadRadius = pick('ring', 'loadRadius');
  const loadHeight = pick('ring', 'loadHeight');
  const level0 = pick('levels', 'level0');
  return Object.freeze({
    world: c.world,
    ring: Object.freeze({ loadRadius, unloadRadius: Math.max(loadRadius, pick('ring', 'unloadRadius')), loadHeight, unloadHeight: Math.max(loadHeight, pick('ring', 'unloadHeight')) }),
    collision: Object.freeze({ radius: pick('collision', 'radius'), height: pick('collision', 'height') }),
    levels: Object.freeze({ level0, level1: Math.max(level0, pick('levels', 'level1')), relief: Math.min(level0, pick('levels', 'relief')) }),
    sectionEdge: c.sectionEdge ?? D.sectionEdge,
    savedFields: c.savedFields !== undefined ? planeMaskOf(c.savedFields) : DEFAULT_SAVED_FIELDS,
    quality: level?.id ?? null,
    budgetBytes: at?.budgetBytes ?? null,
    reliefSteps: at?.relief ?? 0,
    far: Object.freeze({ mode: (at ?? NO_LEVEL_VOXELS).farField, errorPixels: (at ?? NO_LEVEL_VOXELS).farError }),
  });
}

/** What a world is drawn with past its near rings when no quality level is known: the medium tier's. */
const NO_LEVEL_VOXELS = levelVoxels({ lighting: 'medium' });

/** The engine's quality level named `id` (else its highest): what a view without a project's own levels resolves a world at. */
export function engineQualityLevel(id: string | null): QualityLevelConfig {
  return qualityLevelOf(DEFAULT_QUALITY_LEVELS, id);
}

const L = STREAMING_RADIUS_LIMITS;
const inRange = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= L.min && v <= L.max;
function err(errors: ModelErrorV2[], code: string, path: string, message: string, found?: unknown): void {
  errors.push({ code, path, message, ...(found !== undefined ? { found } : {}) } as ModelErrorV2);
}

function validateDistances(v: unknown, path: string, what: string, keys: readonly string[], errors: ModelErrorV2[]): void {
  if (!isPlainObject(v)) return err(errors, 'field_type', path, `${what} is an object {${keys.map((k) => `${k}?`).join(', ')}} in metres`, v);
  for (const k of Object.keys(v)) if (!keys.includes(k)) err(errors, 'field_unexpected', `${path}/${k}`, `unknown ${what} field "${k}" (${keys.join(', ')})`, k);
  for (const k of keys) {
    if (v[k] === undefined || inRange(v[k]) || (v[k] === 0 && ZERO_ALLOWED.has(k))) continue;
    err(errors, 'field_value', `${path}/${k}`, `${k} is ${ZERO_ALLOWED.has(k) ? `0 (none) or ` : ''}${L.min}-${L.max} metres`, v[k]);
  }
}

/** `ring?`, `collision?`, `levels?` of a scene, a quality entry or a script's change. */
export function validateVoxelWorldRings(value: Record<string, unknown>, path: string, errors: ModelErrorV2[]): void {
  if (value['ring'] !== undefined) validateDistances(value['ring'], `${path}/ring`, 'ring', VOXEL_WORLD_RING_FIELDS, errors);
  if (value['collision'] !== undefined) validateDistances(value['collision'], `${path}/collision`, 'collision', VOXEL_WORLD_COLLISION_FIELDS, errors);
  if (value['levels'] !== undefined) validateDistances(value['levels'], `${path}/levels`, 'levels', VOXEL_WORLD_LEVEL_FIELDS, errors);
}

function validateQuality(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(value)) return err(errors, 'field_type', path, 'quality is an object { <level id>: { scale?, ring?, collision?, levels? } }', value);
  for (const [id, q] of Object.entries(value)) {
    const at = `${path}/${id}`;
    if (!QUALITY_LEVEL_ID_RE.test(id)) err(errors, 'field_value', at, 'a quality level id is a lowercase letter, then up to 31 lowercase letters, digits, _ or -', id);
    if (!isPlainObject(q)) {
      err(errors, 'field_type', at, 'a level\'s distances are an object { scale?, ring?, collision?, levels? }', q);
      continue;
    }
    for (const k of Object.keys(q)) if (!(VOXEL_WORLD_QUALITY_FIELDS as readonly string[]).includes(k)) err(errors, 'field_unexpected', `${at}/${k}`, `unknown field "${k}" (${VOXEL_WORLD_QUALITY_FIELDS.join(', ')})`, k);
    const scale = q['scale'];
    if (scale !== undefined && (typeof scale !== 'number' || !Number.isFinite(scale) || scale < VOXEL_RING_SCALE_MIN || scale > VOXEL_RING_SCALE_MAX)) err(errors, 'field_value', `${at}/scale`, `scale is ${VOXEL_RING_SCALE_MIN}-${VOXEL_RING_SCALE_MAX}`, scale);
    validateVoxelWorldRings(q, at, errors);
  }
}

export function validateVoxelWorldComponent(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(value)) return err(errors, 'field_type', path, 'voxelWorld is an object { world, ring?, collision?, levels?, quality?, sectionEdge?, savedFields?, decalLayers? }', value);
  for (const k of Object.keys(value)) if (!VOXEL_WORLD_FIELDS.includes(k)) err(errors, 'field_unexpected', `${path}/${k}`, `unknown voxelWorld field "${k}" (${VOXEL_WORLD_FIELDS.join(', ')})`, k);
  const world = value['world'];
  if (world === undefined) err(errors, 'field_missing', `${path}/world`, "voxelWorld needs its world's name");
  else if (typeof world !== 'string' || !VOXEL_WORLD_NAME_RE.test(world)) err(errors, 'field_value', `${path}/world`, `a world name matches ${VOXEL_WORLD_NAME_RE.source}`, world);
  validateVoxelWorldRings(value, path, errors);
  if (value['quality'] !== undefined) validateQuality(value['quality'], `${path}/quality`, errors);
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
  validateDecalLayerMask(value['decalLayers'], `${path}/decalLayers`, errors, 0);
}

/** Ring distance groups in canonical form, field by field (into `out`). */
export function canonicalVoxelWorldRings(c: VoxelWorldRings, out: VoxelWorldRings): void {
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
}

/** `voxelWorld` in canonical form: fields in order, only those set, quality levels by id, saved fields in the voxel planes' order. */
export function canonicalVoxelWorld(c: VoxelWorldComponent): VoxelWorldComponent {
  const out: VoxelWorldComponent = { world: c.world };
  canonicalVoxelWorldRings(c, out);
  if (c.quality !== undefined) {
    const quality: Record<string, VoxelWorldQuality> = {};
    for (const id of Object.keys(c.quality).sort()) {
      const q = c.quality[id]!;
      const one: VoxelWorldQuality = {};
      if (q.scale !== undefined) one.scale = q.scale;
      canonicalVoxelWorldRings(q, one);
      quality[id] = one;
    }
    out.quality = quality;
  }
  if (c.sectionEdge !== undefined) out.sectionEdge = c.sectionEdge;
  if (c.savedFields !== undefined) out.savedFields = planesOf(planeMaskOf(c.savedFields));
  if (c.decalLayers !== undefined) out.decalLayers = c.decalLayers;
  return out;
}
