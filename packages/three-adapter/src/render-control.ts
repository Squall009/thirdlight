/**
 * The adapter's render settings: the kind of ambient occlusion, the render
 * scale and dynamic resolution (the project's `ambient_occlusion`,
 * `render_scale`, `dynamic_resolution`, or a player's settings fields), applied
 * to the environment renderer, with dynamic resolution fed from each drawn
 * frame's GPU time (`gpu-timing.ts`) and frame interval.
 *
 * Kept out of `adapter.ts`: the adapter creates one, tells it the settings and
 * each drawn frame, and draws through the environment renderer while
 * `needsEnvironment()` says the scale needs its pipeline.
 */
import { RENDER_SCALE_MAX, RENDER_SCALE_MIN, renderScaleOf } from '@thirdlight/runtime';

import { DynamicResolution, type DynamicResolutionState } from './dynamic-resolution';
import type { EnvironmentRenderer } from './environment';
import type { GpuTiming } from './gpu-timing';
import type { UpscaleFilter } from './post-upscale';

/** The settings a host gives (structural: the project-model `RenderSettings` plus page diagnostics). */
export interface RenderSettingsLike {
  readonly ambientOcclusion?: 'off' | 'ssao' | 'gtao';
  /** 0.5–1 (out of range: clamped). */
  readonly renderScale?: number;
  readonly dynamicResolution?: boolean;
}

export interface RenderControlOptions extends RenderSettingsLike {
  /** How the scaled picture is upscaled (FSR 1; bilinear is a diagnostic comparison, `?upscale=bilinear`). */
  readonly upscale?: UpscaleFilter;
  /** A forced overload for dynamic resolution's first `slowFramesMs` (a diagnostic, `?slowFrames=`). */
  readonly slowFramesMs?: number;
  /** The frame's budget in ms (the frame-rate cap's; absent: 60 fps). */
  readonly frameBudgetMs?: () => number;
}

export interface RenderControlDiagnostics {
  readonly ambientOcclusion: 'off' | 'ssao' | 'gtao';
  /** The project's or player's scale (the most dynamic resolution draws at). */
  readonly renderScale: number;
  readonly dynamicResolution: boolean;
  /** The scale frames are drawn at now. */
  readonly scale: number;
  readonly upscale: UpscaleFilter;
  readonly dynamic: DynamicResolutionState | null;
}

export interface RenderControl {
  /** New settings (unset parts keep their value). */
  set(next: RenderSettingsLike): void;
  /** Whether frames must go through the environment renderer for the scale (a scene without a look draws directly otherwise). */
  needsEnvironment(): boolean;
  /** Apply the settings to an environment renderer (a new one, or after a change). */
  apply(env: EnvironmentRenderer): void;
  /** A frame was drawn (`cpuMs`: the adapter's own work for it): dynamic resolution picks the next frame's scale. */
  frameDrawn(env: EnvironmentRenderer | null, now: number, cpuMs: number, gpu: GpuTiming): void;
  diagnostics(): RenderControlDiagnostics;
}

const FRAME_BUDGET_60_FPS_MS = 1000 / 60;

/**
 * Page flags over the project's render settings (a diagnostic comparison, as
 * `?probes=off`; the perf harness's `--switches`): `?ao=off|ssao|gtao`,
 * `?renderScale=0.5…1`, `?dynamicResolution=on|off`.
 */
export const RENDER_URL_PARAMS = { ao: 'ao', renderScale: 'renderScale', dynamicResolution: 'dynamicResolution' } as const;

/** The render settings a page's query string pins (only the flags it has). */
export function renderSettingsFromUrl(search: string): RenderSettingsLike {
  const q = new URLSearchParams(search);
  const ao = q.get(RENDER_URL_PARAMS.ao);
  const scale = renderScaleOf(Number(q.get(RENDER_URL_PARAMS.renderScale) ?? Number.NaN));
  const dynamic = q.get(RENDER_URL_PARAMS.dynamicResolution);
  return {
    ...(ao === 'off' || ao === 'ssao' || ao === 'gtao' ? { ambientOcclusion: ao } : {}),
    ...(scale !== undefined && q.has(RENDER_URL_PARAMS.renderScale) ? { renderScale: scale } : {}),
    ...(dynamic === 'on' || dynamic === 'off' ? { dynamicResolution: dynamic === 'on' } : {}),
  };
}

export function createRenderControl(opts: RenderControlOptions = {}): RenderControl {
  let ao: 'off' | 'ssao' | 'gtao' = opts.ambientOcclusion ?? 'ssao';
  let renderScale = renderScaleOf(opts.renderScale) ?? RENDER_SCALE_MAX;
  let dynamic = opts.dynamicResolution === true;
  const upscale: UpscaleFilter = opts.upscale ?? 'fsr1';
  const drs = new DynamicResolution(RENDER_SCALE_MIN, renderScale);
  if ((opts.slowFramesMs ?? 0) > 0) drs.stress(opts.slowFramesMs!);
  let applied: EnvironmentRenderer | null = null;
  let dirty = true;
  let lastFrameAt: number | null = null;
  const scaleNow = (): number => (dynamic ? drs.current() : renderScale);
  return {
    set(next) {
      if (next.ambientOcclusion !== undefined) ao = next.ambientOcclusion;
      if (next.renderScale !== undefined) {
        const s = renderScaleOf(next.renderScale);
        if (s !== undefined && s !== renderScale) {
          renderScale = s;
          drs.setRange(RENDER_SCALE_MIN, renderScale);
          drs.reset();
        }
      }
      if (next.dynamicResolution !== undefined && next.dynamicResolution !== dynamic) {
        dynamic = next.dynamicResolution;
        drs.reset();
      }
      dirty = true;
    },
    needsEnvironment: () => renderScale < 1 || dynamic,
    apply(env) {
      if (env === applied && !dirty) return;
      applied = env;
      dirty = false;
      env.setRender({ ao, scale: scaleNow(), dynamic, upscale });
    },
    frameDrawn(env, now, cpuMs, gpu) {
      const interval = lastFrameAt === null ? null : now - lastFrameAt;
      lastFrameAt = now;
      if (!dynamic || env === null) return;
      const before = drs.current();
      const s = drs.frame({ now, gpuMs: gpu.recent(), measuresGpu: gpu.measuring(), intervalMs: interval, cpuMs, budgetMs: opts.frameBudgetMs?.() ?? FRAME_BUDGET_60_FPS_MS });
      if (s !== before) env.setRender({ scale: s });
    },
    diagnostics: () => ({ ambientOcclusion: ao, renderScale, dynamicResolution: dynamic, scale: scaleNow(), upscale, dynamic: dynamic ? drs.state() : null }),
  };
}
