/**
 * The render settings a game sets and a player may change: the kind of
 * ambient occlusion, the render scale (the share of the screen's resolution
 * the 3D view is drawn at, upscaled with FSR 1), and dynamic resolution (the
 * scale lowered while the GPU runs over its frame budget, raised again when
 * it has room).
 *
 * Where a game sets them: the project settings `ambient_occlusion`,
 * `render_scale` and `dynamic_resolution`; a player's settings field bound
 * to `ambientOcclusion` (an enum of off/ssao/gtao), `renderScale` (a number
 * within 0.5–1) or `dynamicResolution` (a bool), which scripts change through
 * `ctx.saves.setSetting` like any settings field.
 *
 * Pure: no I/O.
 */

/**
 * The kinds of ambient occlusion. `ssao`: fast screen-space occlusion at half
 * resolution (the default); `gtao`: ground-truth AO, darker and more exact in
 * creases, about twice the cost; `off`: none. Either darkens only the
 * indirect light (ambient, sky and probe light), never the direct light of
 * the sun and lamps, and only where a scene's look turns ambient occlusion on.
 */
export const AMBIENT_OCCLUSION_KINDS = ['off', 'ssao', 'gtao'] as const;
export type AmbientOcclusionKind = (typeof AMBIENT_OCCLUSION_KINDS)[number];
/** The `ambient_occlusion` setting's values, in `AMBIENT_OCCLUSION_KINDS` order. */
export const AMBIENT_OCCLUSION_SETTING_VALUES = [0, 1, 2] as const;
export const AMBIENT_OCCLUSION_DEFAULT: AmbientOcclusionKind = 'ssao';

/**
 * The render scale's range. Below half the resolution FSR 1 can no longer
 * rebuild edges (AMD's lowest preset, "performance", is 0.5); 1 is the
 * screen's own resolution (the render pixel ratio's cap still applies).
 */
export const RENDER_SCALE_MIN = 0.5;
export const RENDER_SCALE_MAX = 1;
export const RENDER_SCALE_DEFAULT = 1;

export interface RenderSettings {
  readonly ambientOcclusion: AmbientOcclusionKind;
  /** 0.5–1: the scale the 3D view is drawn at (with dynamic resolution, the most it is drawn at). */
  readonly renderScale: number;
  readonly dynamicResolution: boolean;
}

export const RENDER_SETTINGS_DEFAULT: Readonly<RenderSettings> = Object.freeze({ ambientOcclusion: AMBIENT_OCCLUSION_DEFAULT, renderScale: RENDER_SCALE_DEFAULT, dynamicResolution: false });

/** An AO kind from a setting value (0/1/2) or a player's choice ('off'/'ssao'/'gtao'); undefined when it is neither. */
export function ambientOcclusionOf(v: unknown): AmbientOcclusionKind | undefined {
  if (typeof v === 'number') {
    const i = (AMBIENT_OCCLUSION_SETTING_VALUES as readonly number[]).indexOf(v);
    return i < 0 ? undefined : AMBIENT_OCCLUSION_KINDS[i];
  }
  return (AMBIENT_OCCLUSION_KINDS as readonly unknown[]).includes(v) ? (v as AmbientOcclusionKind) : undefined;
}

/** A render scale clamped to its range; undefined when `v` is not a finite number. */
export function renderScaleOf(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(RENDER_SCALE_MAX, Math.max(RENDER_SCALE_MIN, v)) : undefined;
}

/** The project's render settings (the defaults for what it leaves out or sets out of range). */
export function renderSettingsOf(settings: unknown): RenderSettings {
  const s = typeof settings === 'object' && settings !== null ? (settings as Record<string, unknown>) : {};
  return {
    ambientOcclusion: ambientOcclusionOf(s['ambient_occlusion']) ?? AMBIENT_OCCLUSION_DEFAULT,
    renderScale: renderScaleOf(s['render_scale']) ?? RENDER_SCALE_DEFAULT,
    dynamicResolution: s['dynamic_resolution'] === 1,
  };
}
