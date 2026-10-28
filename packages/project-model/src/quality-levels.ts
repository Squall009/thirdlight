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
 *   CSS pixel, MSAA, the largest shadow map, how many point and spot lights
 *   are drawn and how many of them draw their shadow, the kind of ambient
 *   occlusion, the LOD bias, dynamic resolution and occlusion culling. Each one a level leaves out is the
 *   project's setting.
 * - `lighting`: the level's lighting tier (`low`, `medium`, `high`;
 *   `LIGHTING_TIER_SETTINGS` holds what each tier sets, the one place its
 *   values live). A level that names none is `DEFAULT_LIGHTING_TIER`. The
 *   tier sets the four lighting settings below; a level's own value of one
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
 *
 * A player's settings field bound to one of those renderer settings (`renderScale`,
 * `ambientOcclusion`, `dynamicResolution`) lays over the level: a player's own
 * choice is the most specific.
 *
 * Pure: no I/O.
 */
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
}

/** Each tier's settings: the one place they are defined (a level may lay its own surface-cache, live-light, contact-shadow and reflection values over them). */
export const LIGHTING_TIER_SETTINGS: Readonly<Record<LightingTier, Readonly<LightingTierSettings>>> = Object.freeze({
  low: Object.freeze({ surfaceCacheMiB: 32, surfaceLightMs: 0, contactShadows: false, reflections: 'off' as const, surfaceRays: 1, surfaceReach: 1 }),
  medium: Object.freeze({ surfaceCacheMiB: 64, surfaceLightMs: 1.5, contactShadows: true, reflections: 'medium' as const, surfaceRays: 1, surfaceReach: 1 }),
  high: Object.freeze({ surfaceCacheMiB: 128, surfaceLightMs: 3, contactShadows: true, reflections: 'high' as const, surfaceRays: 2, surfaceReach: 2 }),
});

/** The tier of a level that names none. */
export const DEFAULT_LIGHTING_TIER: LightingTier = 'medium';
/** The settings of a level that names neither a tier nor the setting (the default tier's). */
export const DEFAULT_SURFACE_CACHE_MIB = LIGHTING_TIER_SETTINGS[DEFAULT_LIGHTING_TIER].surfaceCacheMiB;
export const DEFAULT_SURFACE_LIGHT_MS = LIGHTING_TIER_SETTINGS[DEFAULT_LIGHTING_TIER].surfaceLightMs;
export const DEFAULT_CONTACT_SHADOWS = LIGHTING_TIER_SETTINGS[DEFAULT_LIGHTING_TIER].contactShadows;
export const DEFAULT_REFLECTIONS: ReflectionQuality = LIGHTING_TIER_SETTINGS[DEFAULT_LIGHTING_TIER].reflections;

/** One lighting setting across the tiers, for help texts ("low 32, medium 64, high 128"). */
export function lightingTierValues(pick: (t: LightingTierSettings) => string | number | boolean): string {
  return LIGHTING_TIERS.map((t) => `${t} ${String(pick(LIGHTING_TIER_SETTINGS[t]))}`).join(', ');
}

/** A tier's place, lowest first. */
export function lightingTierRank(tier: LightingTier): number {
  return LIGHTING_TIERS.indexOf(tier);
}

/** A level's lighting: its tier's settings with the level's own values laid over them. */
export function levelLighting(level: Pick<QualityLevelConfig, 'lighting' | 'surfaceCacheMiB' | 'surfaceLightMs' | 'contactShadows' | 'reflections'>): LightingTierSettings & { readonly tier: LightingTier } {
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
  /** How many point and spot lights the loaded scenes draw at once (0 – the scenes' budget). */
  localLights?: number;
  /**
   * How many point and spot lights draw their shadow at once (0 – the scenes'
   * budget; absent: every one that casts, every frame): the ones largest on
   * screen, spot before point, fading out with distance, their maps drawn
   * again only when something in reach changed.
   */
  shadowedLights?: number;
  ambientOcclusion?: AmbientOcclusionKind;
  /** 0.25–4: divides every LOD switch point and cull size (over the project's `lod_bias`). */
  lodBias?: number;
  dynamicResolution?: boolean;
  /** Occlusion culling at this level (absent: the project's `occlusion_culling`). */
  occlusionCulling?: OcclusionCulling;
  /** The lighting tier (absent: `DEFAULT_LIGHTING_TIER`): sets the four settings below where the level leaves them out. */
  lighting?: LightingTier;
  /** 16–2048: the surface cache's memory budget in MiB (absent: the tier's). */
  surfaceCacheMiB?: number;
  /** 0–8: the GPU time a frame may spend lighting stale surface-cache texels, ms (absent: the tier's; 0: saved light only). */
  surfaceLightMs?: number;
  /** Screen-space contact shadows on the sun's light (absent: the tier's). */
  contactShadows?: boolean;
  /** Reflections on glossy surfaces (absent: the tier's). */
  reflections?: ReflectionQuality;
}

/**
 * The memory (MiB) a scene's saved lighting may take on the cache's pages:
 * the engine's low level's whole budget, so a low-tier device holds a
 * scene's saved light whole (a larger scene is saved at coarser texels).
 */
export const SAVED_SURFACE_CACHE_MIB = LIGHTING_TIER_SETTINGS.low.surfaceCacheMiB;

/**
 * The render scale of the engine's medium level: a 1080p screen drawn from
 * 1280 × 720 and upscaled by TAAU, with dynamic resolution below it (on an
 * integrated GPU every measured scene class holds 60 Hz there, and the
 * interior misses it at full resolution).
 */
export const MEDIUM_RENDER_SCALE = 0.667;

/**
 * The engine's levels, for a project that lists none, one per lighting
 * tier: low draws no bloom, ambient occlusion, depth of field or
 * anti-aliasing (no MSAA either); medium drops ambient occlusion and depth
 * of field and draws at `MEDIUM_RENDER_SCALE` with dynamic resolution
 * (defaults under the project's own `render_scale` and `dynamic_resolution`,
 * where it sets them: the adapter's quality control); high
 * draws the look as authored at the project's render scale. Medium and high
 * anti-alias with temporal upscaling where the look anti-aliases
 * (`ANTIALIAS_KINDS`: the look's own FXAA or SMAA in its place on WebGL 2 and
 * in the editor's Scene view).
 */
export const DEFAULT_QUALITY_LEVELS: readonly Readonly<QualityLevelConfig>[] = Object.freeze([
  Object.freeze({ id: 'low', name: 'Low', lighting: 'low' as const, post: { bloom: { enabled: false }, ssao: { enabled: false }, dof: { enabled: false }, antialias: 'none' as const }, msaa: 0 as const }),
  Object.freeze({ id: 'medium', name: 'Medium', lighting: 'medium' as const, post: { ssao: { enabled: false }, dof: { enabled: false }, antialias: 'taau' as const }, renderScale: MEDIUM_RENDER_SCALE, dynamicResolution: true }),
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

