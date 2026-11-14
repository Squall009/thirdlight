/**
 * Quality levels: named sets of graphics settings a player picks from (Unity's
 * Quality levels, Unreal's scalability groups). The project's environment
 * lists them (`environment.qualityLevels`, lowest first) and names the one a
 * game starts at (`environment.quality`); a project that lists none has the
 * engine's three (`DEFAULT_QUALITY_LEVELS`).
 *
 * A level changes how the scenes are drawn, never what they are:
 *
 * - `post`: the scene look's post-processing, per effect (bloom, ambient
 *   occlusion, depth of field) and the anti-aliasing kind. A level's effect
 *   fields lay over the scene's where the scene has the effect on (a smaller
 *   AO radius, a weaker bloom), and `enabled: false` turns it off; a level
 *   never turns on an effect, or anti-aliasing, that the scene's look leaves
 *   off (each scene's look stays the author's).
 * - renderer settings: the render scale, the most drawing-buffer pixels per
 *   CSS pixel, MSAA, the largest shadow map, the kind of ambient
 *   occlusion, the LOD bias, dynamic resolution and occlusion culling. Each one a level leaves out is the
 *   project's setting.
 * - `lighting`: the level's lighting tier (`low`, `medium`, `high`;
 *   `LIGHTING_TIER_SETTINGS` holds what each tier sets, the one place its
 *   values live). A level that names none is `DEFAULT_LIGHTING_TIER`. The
 *   tier sets the five lighting settings below; a level's own value of one
 *   lays over its tier's.
 * - `surfaceCacheMiB`: the memory the surface cache (the static surfaces'
 *   light) may hold around the view, in MiB: a budget, never a count of
 *   surfaces or lights.
 * - `surfaceLightMs`: the GPU time a frame may spend lighting the surface
 *   cache's stale texels, in ms (changes are lit within it, nearest first;
 *   a settled scene spends none). 0 draws only saved light, as WebGL 2
 *   always does.
 * - `contactShadows`: screen-space contact shadows on the sun's light (its
 *   map's missing fine detail), where the frame is drawn through the post
 *   stack.
 * - `reflections`: screen-space reflections on glossy surfaces (WebGPU,
 *   with the look's post effects), where they miss traced through the
 *   static world and lit from the surface cache: `off`, `medium` or `high`
 *   (more steps, more traced rays).
 * - `shadowAtlas`: the side of the shadow atlas (texels), the memory every
 *   shadowed local light's shadow shares: lights largest on screen get the
 *   larger tiles, and a light the atlas has no room for draws unshadowed (a
 *   quality budget, never a count of lights).
 * - `voxelRings`: how much every voxel world's ring distances are scaled at
 *   the level (load, collision, the detail levels; a scene may scale or set
 *   its own per level, `voxelWorld.quality`). Absent: the tier's
 *   (`VOXEL_RING_SCALES`: the area loaded halves or doubles from medium's).
 *   The voxel stream budget is the tier's (`VOXEL_STREAM_BUDGET_BYTES`).
 * - `frameRateCap`: the most frames a second the page draws at the level
 *   (frame-rate-cap.ts). Under a game's own cap the lower of the two paces
 *   the frames; dynamic resolution budgets from it.
 *
 * Each tier also has a frame budget (`FRAME_BUDGET_BY_TIER`): what every
 * thread's frame may spend per category at the tier's frame rate, and the
 * time slices the frame arbiter hands out there. Engine constants, never part
 * of a project.
 *
 * A player's settings field bound to one of those renderer settings (`renderScale`,
 * `ambientOcclusion`, `dynamicResolution`) lays over the level: a player's own
 * choice is the most specific.
 *
 * Pure: no I/O.
 */
import { FRAME_SLICE_DEFAULTS, MEMORY_BUDGET_IDS, type FrameSlice, type FrameSliceId, type MemoryBudgetId, type SpanCategory } from '@thirdlight/shared';
import { FAR_BUDGET_BYTES, FAR_ERROR_PIXELS_BY_TIER, FAR_FIELD_BY_TIER, FAR_FINE_HOLD_M_BY_TIER, FAR_GPU_BUDGET_BYTES_BY_TIER, RELIEF_RING_SCALES, RELIEF_STEPS_BY_TIER, UNDO_MEMORY_BUDGET_BYTES, VOXEL_REACH_SCALES, VOXEL_RING_SCALES, VOXEL_STREAM_BUDGET_BYTES, type FarFieldMode } from '@thirdlight/voxel';
import { TEXTURE_BUDGET_DEFAULT_MB } from './texture-streaming';
import { STREAMING_BUDGET_DEFAULT_MB } from './world-streaming';
import type { FrameRateCap } from './frame-rate-cap';
import type { PostConfig } from './materials';
import type { AmbientOcclusionKind, OcclusionCulling } from './render-settings';

/** A level's id: what `environment.quality`, a player's quality setting and the game-control command name. */
export const QUALITY_LEVEL_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;

/**
 * MSAA sample counts a level may ask for. WebGPU multisamples only at 1 or 4
 * samples (its render targets take no other count), so 4 is the one count
 * both renderers draw; 0 draws without MSAA.
 */
export const MSAA_SAMPLE_COUNTS = [0, 4] as const;
export type MsaaSamples = (typeof MSAA_SAMPLE_COUNTS)[number];

/** Shadow map sizes, texels per side: a directional light's own size and a level's largest shadow map name one. */
export const SHADOW_MAP_SIZES: readonly number[] = Object.freeze([512, 1024, 2048, 4096]);

/**
 * Shadow atlas sides, texels: the one depth texture every shadowed local
 * light draws its shadow into, a tile each (the shadow map sizes and 8,192,
 * a discrete GPU's).
 */
export const SHADOW_ATLAS_SIZES: readonly number[] = Object.freeze([...SHADOW_MAP_SIZES, 8192]);

/**
 * The range of a level's pixel-ratio cap. Below 1 the render scale is the
 * knob (it upscales with FSR 1); above 2 a HiDPI display draws four times the
 * pixels of a 1080p one for a difference few players see.
 */
export const PIXEL_RATIO_CAP_MIN = 1;
export const PIXEL_RATIO_CAP_MAX = 2;

/** The range of a level's surface-cache budget (MiB): below 16 the terrain rings alone fill it; above 2 GiB no integrated GPU has it to spare. */
export const SURFACE_CACHE_MIB_MIN = 16;
export const SURFACE_CACHE_MIB_MAX = 2048;
/** The range of a level's GPU time a frame for live surface light (ms): above 8 a 60 Hz frame has little left to draw with. */
export const SURFACE_LIGHT_MS_MIN = 0;
export const SURFACE_LIGHT_MS_MAX = 8;

/** The range of a ring scale (a level's `voxelRings`, a scene's per level): a quarter to four times the distances a scene sets. */
export const VOXEL_RING_SCALE_MIN = 0.25;
export const VOXEL_RING_SCALE_MAX = 4;

/**
 * Texel densities a level may keep for the voxel surfaces (px/m on a
 * construction tile): powers of two, as the mip levels are.
 */
export const VOXEL_TEXEL_DENSITIES: readonly number[] = Object.freeze([64, 128, 256, 512, 1024, 2048, 4096]);

/**
 * A level's voxel texel density by its tier: an integrated GPU's low tier keeps half of the authored 1024 px/m, as
 * medium does (the arrays fit inside low's memory budget, `LOW_MEMORY_BUDGET_MIB`); high keeps all of it.
 */
export const VOXEL_TEXEL_DENSITY_BY_TIER: Readonly<Record<'low' | 'medium' | 'high', number>> = Object.freeze({ low: 512, medium: 512, high: 1024 });

/** A level's reflections: none, or screen-space rays with traced fallback at a quality. */
export const REFLECTION_QUALITIES = ['off', 'medium', 'high'] as const;
export type ReflectionQuality = (typeof REFLECTION_QUALITIES)[number];

/**
 * Lighting tiers, lowest first: how much of the lighting runs live.
 *
 * - low: the saved light (cache pages and probes from the bake) and the
 *   sun's shadow map; nothing is lit live. What WebGL 2 always draws.
 * - medium: the cache and probes re-lit live within a GPU budget,
 *   screen-space reflections with a traced fallback, contact shadows (an
 *   integrated GPU).
 * - high: medium with twice the rays a cache texel casts, finer texels
 *   twice as far out, a larger budget and memory, traced glossy
 *   reflections at more of the pixels (a discrete GPU).
 */
export const LIGHTING_TIERS = ['low', 'medium', 'high'] as const;
export type LightingTier = (typeof LIGHTING_TIERS)[number];

/** What a lighting tier sets. */
export interface LightingTierSettings {
  /** The surface cache's memory budget (MiB). */
  readonly surfaceCacheMiB: number;
  /** GPU time a frame for live surface light (ms; 0: saved light only). */
  readonly surfaceLightMs: number;
  readonly contactShadows: boolean;
  readonly reflections: ReflectionQuality;
  /** Rays a cache texel casts toward each light, as a multiple of the engine's counts (a power of two). */
  readonly surfaceRays: number;
  /** How far out each cache level's texels reach, as a multiple of the engine's distances. */
  readonly surfaceReach: number;
  /** The shadow atlas's side (texels, one of `SHADOW_ATLAS_SIZES`): 16-bit depth and the R8 colour three's render target needs, so 12, 48 and 192 MiB. */
  readonly shadowAtlas: number;
}

/** Each tier's settings: the one place they are defined (a level may lay its own surface-cache, live-light, contact-shadow and reflection values over them). */
export const LIGHTING_TIER_SETTINGS: Readonly<Record<LightingTier, Readonly<LightingTierSettings>>> = Object.freeze({
  low: Object.freeze({ surfaceCacheMiB: 32, surfaceLightMs: 0, contactShadows: false, reflections: 'off' as const, surfaceRays: 1, surfaceReach: 1, shadowAtlas: 2048 }),
  medium: Object.freeze({ surfaceCacheMiB: 64, surfaceLightMs: 1.5, contactShadows: true, reflections: 'medium' as const, surfaceRays: 1, surfaceReach: 1, shadowAtlas: 4096 }),
  high: Object.freeze({ surfaceCacheMiB: 128, surfaceLightMs: 3, contactShadows: true, reflections: 'high' as const, surfaceRays: 2, surfaceReach: 2, shadowAtlas: 8192 }),
});

/** The tier of a level that names none. */
export const DEFAULT_LIGHTING_TIER: LightingTier = 'medium';
/** The settings of a level that names neither a tier nor the setting (the default tier's). */
export const DEFAULT_SURFACE_CACHE_MIB = LIGHTING_TIER_SETTINGS[DEFAULT_LIGHTING_TIER].surfaceCacheMiB;
export const DEFAULT_SURFACE_LIGHT_MS = LIGHTING_TIER_SETTINGS[DEFAULT_LIGHTING_TIER].surfaceLightMs;
export const DEFAULT_CONTACT_SHADOWS = LIGHTING_TIER_SETTINGS[DEFAULT_LIGHTING_TIER].contactShadows;
export const DEFAULT_REFLECTIONS: ReflectionQuality = LIGHTING_TIER_SETTINGS[DEFAULT_LIGHTING_TIER].reflections;
export const DEFAULT_SHADOW_ATLAS = LIGHTING_TIER_SETTINGS[DEFAULT_LIGHTING_TIER].shadowAtlas;

/** One lighting setting across the tiers, for help texts ("low 32, medium 64, high 128"). */
export function lightingTierValues(pick: (t: LightingTierSettings) => string | number | boolean): string {
  return LIGHTING_TIERS.map((t) => `${t} ${String(pick(LIGHTING_TIER_SETTINGS[t]))}`).join(', ');
}

/** A tier's place, lowest first. */
export function lightingTierRank(tier: LightingTier): number {
  return LIGHTING_TIERS.indexOf(tier);
}

/** A level's lighting: its tier's settings with the level's own values laid over them. */
export function levelLighting(level: Pick<QualityLevelConfig, 'lighting' | 'surfaceCacheMiB' | 'surfaceLightMs' | 'contactShadows' | 'reflections' | 'shadowAtlas'>): LightingTierSettings & { readonly tier: LightingTier } {
  const tier = level.lighting ?? DEFAULT_LIGHTING_TIER;
  const t = LIGHTING_TIER_SETTINGS[tier];
  return {
    tier,
    surfaceCacheMiB: level.surfaceCacheMiB ?? t.surfaceCacheMiB,
    surfaceLightMs: level.surfaceLightMs ?? t.surfaceLightMs,
    contactShadows: level.contactShadows ?? t.contactShadows,
    reflections: level.reflections ?? t.reflections,
    surfaceRays: t.surfaceRays,
    surfaceReach: t.surfaceReach,
    shadowAtlas: level.shadowAtlas ?? t.shadowAtlas,
  };
}

/** The post effects a level may change (the costly passes and the anti-aliasing; tone, exposure and grading are the look's). */
export const QUALITY_POST_EFFECTS = ['bloom', 'ssao', 'dof'] as const;
export type QualityPostEffect = (typeof QUALITY_POST_EFFECTS)[number];

/** A level's post-processing: per effect, the fields it changes (`enabled: false` turns the effect off). */
export interface QualityLevelPost {
  bloom?: Partial<NonNullable<PostConfig['bloom']>>;
  ssao?: Partial<NonNullable<PostConfig['ssao']>>;
  dof?: Partial<NonNullable<PostConfig['dof']>>;
  /** The anti-aliasing kind where the scene's look has anti-aliasing ('none': off). */
  antialias?: NonNullable<PostConfig['antialias']>;
}

export interface QualityLevelConfig {
  id: string;
  /** Shown in the editor and a game's settings screen (absent: the id). */
  name?: string;
  post?: QualityLevelPost;
  /** 0.5–1: the share of the screen's resolution the 3D view is drawn at (FSR 1 upscales). */
  renderScale?: number;
  /** 1–2: the most drawing-buffer pixels per CSS pixel (absent: 1). */
  pixelRatio?: number;
  /** MSAA samples (0 or 4; absent: the renderer's). */
  msaa?: MsaaSamples;
  /** The largest shadow map any light draws (a light's own larger size is lowered to it). */
  shadowMapSize?: number;
  ambientOcclusion?: AmbientOcclusionKind;
  /** 0.25–4: divides every LOD switch point and cull size (over the project's `lod_bias`). */
  lodBias?: number;
  dynamicResolution?: boolean;
  /** Occlusion culling at this level (absent: the project's `occlusion_culling`). */
  occlusionCulling?: OcclusionCulling;
  /** The lighting tier (absent: `DEFAULT_LIGHTING_TIER`): sets the five settings below where the level leaves them out. */
  lighting?: LightingTier;
  /** 16–2048: the surface cache's memory budget in MiB (absent: the tier's). */
  surfaceCacheMiB?: number;
  /** 0–8: the GPU time a frame may spend lighting stale surface-cache texels, ms (absent: the tier's; 0: saved light only). */
  surfaceLightMs?: number;
  /** Screen-space contact shadows on the sun's light (absent: the tier's). */
  contactShadows?: boolean;
  /** Reflections on glossy surfaces (absent: the tier's). */
  reflections?: ReflectionQuality;
  /** The shadow atlas's side in texels, one of `SHADOW_ATLAS_SIZES` (absent: the tier's). */
  shadowAtlas?: number;
  /** 0.25–4: scales every voxel world's ring distances (absent: the tier's, `VOXEL_RING_SCALES`). */
  voxelRings?: number;
  /** Texels a metre the voxel surfaces keep resident at most, one of `VOXEL_TEXEL_DENSITIES` (absent: the tier's, `VOXEL_TEXEL_DENSITY_BY_TIER`). */
  voxelTexelDensity?: number;
  /** Relief lattice steps a voxel cell in the relief ring, one of `RELIEF_STEPS` (0: no relief mesh; absent: the tier's, `RELIEF_STEPS_BY_TIER`). */
  voxelRelief?: number;
  /** How voxel worlds are drawn past their near rings, one of `FAR_FIELD_MODES` (absent: the tier's, `FAR_FIELD_BY_TIER`). */
  voxelFarField?: FarFieldMode;
  /** The on-screen error (pixels) a far node's cell may make before finer nodes are drawn, `FAR_ERROR_PIXELS_RANGE` (absent: the tier's, `FAR_ERROR_PIXELS_BY_TIER`). */
  voxelFarError?: number;
  /** The most frames a second drawn at the level, one of `FRAME_RATE_CAPS` (absent: none; the game's cap, where it sets one, still holds). */
  frameRateCap?: FrameRateCap;
}

/**
 * What a level sets for the voxel worlds: the scale of their ring distances, their stream memory budget (bytes), the
 * most texels a metre their surfaces keep resident and the relief lattice steps a cell in their relief rings, each by
 * its tier unless the level sets it.
 */
export function levelVoxels(level: Pick<QualityLevelConfig, 'lighting' | 'voxelRings' | 'voxelTexelDensity' | 'voxelRelief' | 'voxelFarField' | 'voxelFarError'>): { readonly ringScale: number; readonly reachScale: number; readonly reliefScale: number; readonly budgetBytes: number; readonly texelDensity: number; readonly relief: number; readonly farField: FarFieldMode; readonly farError: number; readonly farGpuBudget: number; readonly farFineHoldM: number } {
  const tier = level.lighting ?? DEFAULT_LIGHTING_TIER;
  return {
    ringScale: level.voxelRings ?? VOXEL_RING_SCALES[tier],
    // The load ring and level 1 (the near field's reach): a level's own scale moves them too.
    reachScale: level.voxelRings ?? VOXEL_REACH_SCALES[tier],
    // A level's own ring scale moves relief by the same factor against its tier's, keeping relief's own tier scale.
    reliefScale: level.voxelRings !== undefined ? (level.voxelRings / VOXEL_RING_SCALES[tier]) * RELIEF_RING_SCALES[tier] : RELIEF_RING_SCALES[tier],
    budgetBytes: VOXEL_STREAM_BUDGET_BYTES[tier],
    texelDensity: level.voxelTexelDensity ?? VOXEL_TEXEL_DENSITY_BY_TIER[tier],
    relief: level.voxelRelief ?? RELIEF_STEPS_BY_TIER[tier],
    farField: level.voxelFarField ?? FAR_FIELD_BY_TIER[tier],
    farError: level.voxelFarError ?? FAR_ERROR_PIXELS_BY_TIER[tier],
    farGpuBudget: FAR_GPU_BUDGET_BYTES_BY_TIER[tier],
    farFineHoldM: FAR_FINE_HOLD_M_BY_TIER[tier],
  };
}

/**
 * The memory (MiB) a scene's saved lighting may take on the cache's pages:
 * the engine's low level's whole budget, so a low-tier device holds a
 * scene's saved light whole (a larger scene is saved at coarser texels).
 */
export const SAVED_SURFACE_CACHE_MIB = LIGHTING_TIER_SETTINGS.low.surfaceCacheMiB;

/**
 * The render scale of the engine's low and medium levels: a 1080p screen
 * drawn from 1280 × 720 (a 720p one from 853 × 480) and upscaled by TAAU,
 * with dynamic resolution below it (on an integrated GPU every measured
 * scene class holds 60 Hz there at medium, and the interior misses it at
 * full resolution).
 */
export const UPSCALED_RENDER_SCALE = 0.667;

/**
 * The engine's low level's frame-rate cap: low is the integrated-GPU target
 * (an Iris Xe at 720p upscaled), and 30 frames a second leaves it the room a
 * 60 Hz frame does not.
 */
export const LOW_FRAME_RATE_CAP: FrameRateCap = 30;

/**
 * The memory the engine's low level is designed to (MiB): the minimum spec is
 * an 8 GB machine, not a phone, and about half of it is the game's, page and
 * GPU together (an integrated GPU's memory is the system's). Split as the
 * page's JavaScript heap (with the array buffers it holds) and the GPU memory
 * the browser's GPU process holds (the driver's resident count): the GPU side
 * holds the voxel meshes, the far atlas and the texture arrays, which grow
 * with the tier's budgets, the page only the copies it keeps to draw them.
 * The low tier's budgets (voxel stream, far field, textures, surface cache)
 * are sized to fit inside it; the benches report what they measure against
 * it. Medium and high have no budget of their own until they are measured on
 * their own hardware, and none of their budgets is below low's.
 */
export const LOW_MEMORY_BUDGET_MIB: Readonly<{ readonly total: number; readonly pageHeap: number; readonly gpu: number }> = Object.freeze({ total: 4096, pageHeap: 1536, gpu: 2560 });

/**
 * The engine's levels, for a project that lists none, one per lighting
 * tier: low draws no bloom, ambient occlusion or depth of field, at
 * `UPSCALED_RENDER_SCALE` with dynamic resolution (and, like medium, MSAA
 * where no post stack anti-aliases: an upscale wants an anti-aliased input), capped at
 * `LOW_FRAME_RATE_CAP`, its largest shadow map 2048; medium drops ambient
 * occlusion and depth of field and draws at `UPSCALED_RENDER_SCALE` with
 * dynamic resolution (the scale and dynamic resolution are defaults under the
 * project's own `render_scale` and `dynamic_resolution`, where it sets them:
 * the adapter's quality control); high draws the look as authored at the
 * project's render scale. Every level anti-aliases with temporal upscaling
 * where the look anti-aliases (`ANTIALIAS_KINDS`: the look's own FXAA or
 * SMAA in its place on WebGL 2 and in the editor's Scene view).
 */
export const DEFAULT_QUALITY_LEVELS: readonly Readonly<QualityLevelConfig>[] = Object.freeze([
  Object.freeze({ id: 'low', name: 'Low', lighting: 'low' as const, post: { bloom: { enabled: false }, ssao: { enabled: false }, dof: { enabled: false }, antialias: 'taau' as const }, renderScale: UPSCALED_RENDER_SCALE, dynamicResolution: true, shadowMapSize: 2048, frameRateCap: LOW_FRAME_RATE_CAP }),
  Object.freeze({ id: 'medium', name: 'Medium', lighting: 'medium' as const, post: { ssao: { enabled: false }, dof: { enabled: false }, antialias: 'taau' as const }, renderScale: UPSCALED_RENDER_SCALE, dynamicResolution: true }),
  Object.freeze({ id: 'high', name: 'High', lighting: 'high' as const, post: { antialias: 'taau' as const } }),
]);

/**
 * Whether a level's render scale and dynamic resolution are the engine's
 * level's of the same id. They are then defaults under the project's own
 * `render_scale` and `dynamic_resolution`: a project that copied the engine's
 * levels to change another field (the editor's Lighting window does) keeps
 * its own scale, as with the engine's levels themselves.
 */
export function levelScalingIsEngineDefault(level: QualityLevelConfig): boolean {
  const engine = DEFAULT_QUALITY_LEVELS.find((l) => l.id === level.id);
  return engine !== undefined && engine.renderScale === level.renderScale && engine.dynamicResolution === level.dynamicResolution;
}

/** The project's levels (the engine's when it lists none). */
export function qualityLevelsOf(env: { readonly qualityLevels?: readonly QualityLevelConfig[] } | null | undefined): readonly QualityLevelConfig[] {
  const own = env?.qualityLevels;
  return own !== undefined && own.length > 0 ? own : DEFAULT_QUALITY_LEVELS;
}

/** The level with `id`, else the highest (the last) — a level a project no longer has falls back to it. */
export function qualityLevelOf(levels: readonly QualityLevelConfig[], id: string | null | undefined): QualityLevelConfig {
  const all = levels.length > 0 ? levels : DEFAULT_QUALITY_LEVELS;
  return all.find((l) => l.id === id) ?? all[all.length - 1]!;
}

/**
 * A scene's post-processing at a level: each effect the level names lays its
 * fields over the scene's where the scene has it on (`enabled: false` turns
 * it off); the anti-aliasing kind replaces the scene's where the scene has
 * anti-aliasing. The scene's own object when the level changes nothing.
 */
export function levelPost<P extends PostConfig>(post: P | undefined, level: QualityLevelPost | undefined): P | undefined {
  if (post === undefined || level === undefined) return post;
  let out: Record<string, unknown> | null = null;
  const put = (k: string, v: unknown): void => {
    const o = out ?? (out = { ...(post as Record<string, unknown>) });
    o[k] = v;
  };
  for (const k of QUALITY_POST_EFFECTS) {
    const l = level[k];
    const s = post[k];
    if (l === undefined || s === undefined || s.enabled !== true) continue;
    put(k, l.enabled === false ? { ...s, enabled: false } : { ...s, ...l, enabled: true });
  }
  const aa = level.antialias;
  if (aa !== undefined && post.antialias !== undefined && post.antialias !== 'none' && aa !== post.antialias) put('antialias', aa);
  return (out ?? post) as P;
}


/** What one thread's frame may spend per category, as shares of the tier's frame interval (categories left out: none planned). */
export type FrameBudgetShares = Readonly<Partial<Record<SpanCategory, number>>>;

/**
 * A tier's frame budget: the frame rate it is made for, and per thread what
 * each category may spend of that frame. Made from the hardware target (the
 * low tier is the Iris Xe at 30 Hz: 33.3 ms), never from what a scene uses
 * today. The profiler compares each category's use with it; the frame
 * arbiter's time slices (`slices`) are installed from it.
 */
export interface FrameBudget {
  readonly tier: LightingTier;
  /** The frame rate the budget is made for (the tier's target). */
  readonly hz: number;
  readonly intervalMs: number;
  /** The page's thread: the frame's sync, culling and draw submission, voxel draws made, the presentation's systems. */
  readonly page: FrameBudgetShares;
  /** The simulation's thread (a worker; the page's in single-thread mode): game logic and what steps with it. */
  readonly sim: FrameBudgetShares;
  /** One voxel job worker's frame. */
  readonly jobs: FrameBudgetShares;
  /** The GPU's frame, compared with pass shares (timestamps are not milliseconds at a cap). */
  readonly gpu: FrameBudgetShares;
  /** The frame arbiter's time slices at the tier. */
  readonly slices: Readonly<Record<FrameSliceId, FrameSlice>>;
}

/**
 * The shares every tier plans with (default chosen, owner to confirm). The
 * page keeps about a seventh of its frame for the browser itself (input,
 * compositing, garbage collection); the simulation a tenth for messages and
 * collection; the GPU a twentieth for the compositor.
 */
const FRAME_SHARES: Readonly<{ page: FrameBudgetShares; sim: FrameBudgetShares; jobs: FrameBudgetShares; gpu: FrameBudgetShares }> = Object.freeze({
  page: Object.freeze({ render: 0.25, voxelApply: 0.25, props: 0.08, characters: 0.04, effects: 0.04, lighting: 0.06, ui: 0.04, audio: 0.02, other: 0.07 }),
  sim: Object.freeze({ scripts: 0.25, physics: 0.15, pathfinding: 0.1, characters: 0.1, voxelStream: 0.2, audio: 0.02, other: 0.08 }),
  jobs: Object.freeze({ voxelMesh: 0.8, voxelStream: 0.1 }),
  gpu: Object.freeze({ render: 0.55, lighting: 0.2, effects: 0.08, other: 0.12 }),
});

/** The frame rate medium and high are planned at (their levels set no cap: a 60 Hz display's rate). */
const UNCAPPED_TIER_HZ = 60;

const frameBudget = (tier: LightingTier, hz: number): FrameBudget => Object.freeze({ tier, hz, intervalMs: 1000 / hz, ...FRAME_SHARES, slices: FRAME_SLICE_DEFAULTS });

/** Each tier's frame budget: the one place it is defined. */
export const FRAME_BUDGET_BY_TIER: Readonly<Record<LightingTier, FrameBudget>> = Object.freeze({
  low: frameBudget('low', LOW_FRAME_RATE_CAP),
  medium: frameBudget('medium', UNCAPPED_TIER_HZ),
  high: frameBudget('high', UNCAPPED_TIER_HZ),
});

/** A level's frame budget (its tier's). */
export function levelFrameBudget(level: Pick<QualityLevelConfig, 'lighting'>): FrameBudget {
  return FRAME_BUDGET_BY_TIER[level.lighting ?? DEFAULT_LIGHTING_TIER];
}

/** What a category may spend on a thread (ms) in a frame of the budget's interval (0: nothing planned). */
export function frameBudgetMs(budget: FrameBudget, thread: 'page' | 'sim' | 'jobs' | 'gpu', category: SpanCategory): number {
  return (budget[thread][category] ?? 0) * budget.intervalMs;
}

const MIB = 1024 * 1024;

/**
 * Engine limit: the physics engine's WebAssembly memory may grow to
 * this many bytes; past it the simulation stops with `physics_memory_limit`
 * instead of growing without bound (a runaway spawn loop, a leak). 512 MiB is
 * far above any benchmark scene (the 16 000-entity one uses a few MiB).
 */
export const PHYSICS_MEMORY_CAP_BYTES = 512 * MIB;

/**
 * The bytes one scene's document may take: about four times what 16,384
 * plain objects take (a box as createEntity makes it is about 530 bytes).
 * Here, not with the scene's byte count (`scene-memory.ts`), so the budget
 * table reads it without the serializer's imports.
 */
export const SCENE_OBJECT_BUDGET_BYTES = 32 * MIB;

/** GPU memory the resident probe tiles may take (bytes): the packed texture, as placed (each tile's column width and the deepest tile's depth). */
export const PROBE_RESIDENT_BYTES = 128 * MIB;

/**
 * One entry of a tier's memory budget: what it holds, where (`page`: the
 * page's and its workers' heaps; `gpu`: GPU memory; `backend`: the editor's
 * backend, not part of a game's memory), its bytes, and the constant (or
 * project setting) the system that keeps it to the budget reads.
 */
export interface MemoryBudgetEntry {
  readonly id: MemoryBudgetId;
  readonly label: string;
  readonly side: 'page' | 'gpu' | 'backend';
  readonly bytes: number;
  readonly from: string;
}

/** A tier's memory budget: every entry, and the hardware target the page and GPU entries must fit in (null: the tier has no target of its own yet). */
export interface MemoryBudget {
  readonly tier: LightingTier;
  readonly entries: readonly MemoryBudgetEntry[];
  /** The target's page and GPU memory (bytes). */
  readonly target: { readonly page: number; readonly gpu: number } | null;
  /** The page and GPU entries' sums (bytes). */
  readonly sums: { readonly page: number; readonly gpu: number };
}

/**
 * Each budget's bytes at a tier: every one the value its system had (the
 * table gathers them; it changes none). Shown in this order.
 */
function memoryEntries(tier: LightingTier): readonly MemoryBudgetEntry[] {
  const e = (id: MemoryBudgetId, label: string, side: MemoryBudgetEntry['side'], bytes: number, from: string): MemoryBudgetEntry => Object.freeze({ id, label, side, bytes, from });
  const all: Readonly<Record<MemoryBudgetId, MemoryBudgetEntry>> = {
    voxelStream: e('voxelStream', 'voxel streaming (chunks, derived parts, overlay, tables, mips, kits)', 'page', VOXEL_STREAM_BUDGET_BYTES[tier], 'VOXEL_STREAM_BUDGET_BYTES'),
    physics: e('physics', 'physics memory (the simulation stops past it)', 'page', PHYSICS_MEMORY_CAP_BYTES, 'PHYSICS_MEMORY_CAP_BYTES'),
    farSelection: e('farSelection', 'far nodes drawn at once (their stored bytes)', 'page', FAR_BUDGET_BYTES, 'FAR_BUDGET_BYTES'),
    sceneObjects: e('sceneObjects', "a scene's objects (each scene)", 'page', SCENE_OBJECT_BUDGET_BYTES, 'SCENE_OBJECT_BUDGET_BYTES'),
    farGpu: e('farGpu', 'far field on the GPU', 'gpu', FAR_GPU_BUDGET_BYTES_BY_TIER[tier], 'FAR_GPU_BUDGET_BYTES_BY_TIER'),
    textures: e('textures', 'streamed textures (the project may set its own)', 'gpu', TEXTURE_BUDGET_DEFAULT_MB * MIB, 'TEXTURE_BUDGET_DEFAULT_MB'),
    worldStream: e('worldStream', 'streamed scene cells (the project may set its own)', 'gpu', STREAMING_BUDGET_DEFAULT_MB * MIB, 'STREAMING_BUDGET_DEFAULT_MB'),
    surfaceCache: e('surfaceCache', 'surface cache', 'gpu', LIGHTING_TIER_SETTINGS[tier].surfaceCacheMiB * MIB, 'LIGHTING_TIER_SETTINGS.surfaceCacheMiB'),
    probes: e('probes', 'probe tiles', 'gpu', PROBE_RESIDENT_BYTES, 'PROBE_RESIDENT_BYTES'),
    undo: e('undo', 'voxel undo (each world, in the backend)', 'backend', UNDO_MEMORY_BUDGET_BYTES, 'UNDO_MEMORY_BUDGET_BYTES'),
  };
  return Object.freeze(MEMORY_BUDGET_IDS.map((id) => all[id]));
}

const memoryBudget = (tier: LightingTier): MemoryBudget => {
  const entries = memoryEntries(tier);
  const sum = (side: MemoryBudgetEntry['side']): number => entries.filter((x) => x.side === side).reduce((n, x) => n + x.bytes, 0);
  // Low is the hardware target (an 8 GB machine); medium and high have none of their own until measured on their hardware.
  const target = tier === 'low' ? Object.freeze({ page: LOW_MEMORY_BUDGET_MIB.pageHeap * MIB, gpu: LOW_MEMORY_BUDGET_MIB.gpu * MIB }) : null;
  return Object.freeze({ tier, entries, target, sums: Object.freeze({ page: sum('page'), gpu: sum('gpu') }) });
};

/** Each tier's memory budget: the one table of them (the frame budget's memory side). */
export const MEMORY_BUDGET_BY_TIER: Readonly<Record<LightingTier, MemoryBudget>> = Object.freeze({
  low: memoryBudget('low'),
  medium: memoryBudget('medium'),
  high: memoryBudget('high'),
});
