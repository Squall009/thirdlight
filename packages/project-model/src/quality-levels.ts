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
 *   occlusion, the LOD bias and dynamic resolution. Each one a level leaves out is the project's setting.
 *
 * A player's settings field bound to one of those renderer settings (`renderScale`,
 * `ambientOcclusion`, `dynamicResolution`) lays over the level: a player's own
 * choice is the most specific.
 *
 * Pure: no I/O.
 */
import type { PostConfig } from './materials';
import type { AmbientOcclusionKind } from './render-settings';

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
}

/**
 * The engine's levels, for a project that lists none: low draws no bloom,
 * ambient occlusion, depth of field or anti-aliasing (no MSAA either);
 * medium drops ambient occlusion and depth of field; high draws the look as
 * authored.
 */
export const DEFAULT_QUALITY_LEVELS: readonly Readonly<QualityLevelConfig>[] = Object.freeze([
  Object.freeze({ id: 'low', name: 'Low', post: { bloom: { enabled: false }, ssao: { enabled: false }, dof: { enabled: false }, antialias: 'none' as const }, msaa: 0 as const }),
  Object.freeze({ id: 'medium', name: 'Medium', post: { ssao: { enabled: false }, dof: { enabled: false } } }),
  Object.freeze({ id: 'high', name: 'High' }),
]);

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

