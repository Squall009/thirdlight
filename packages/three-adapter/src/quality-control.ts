/**
 * The adapter's quality level (project-model quality-levels.ts): which level
 * is drawn, and its renderer settings applied where they live.
 *
 * The level is the page's `?quality=` flag (a diagnostic comparison, as the
 * perf harness's `--switches`), else the one a player or the game-control
 * API chose, else the project's (`environment.quality`), else the device's
 * (`deviceQualityLevel`: the highest level whose lighting tier the device's
 * renderer and GPU fit, told once the renderer is up), else the highest. A
 * name the levels lack is passed over (the device's choice, logged).
 * Its settings go to:
 *
 * - the environment renderer (`setQuality`): the look's post per effect and MSAA;
 * - the render control: AO kind, render scale, dynamic resolution, occlusion culling (over the
 *   project's settings, under a player's fields and the page's flags);
 * - the LOD tuning: the bias (over the project's `lod_bias`);
 * - the scene lights: the largest shadow map;
 * - the renderer's pixel ratio cap;
 * - the surface cache: its memory budget, live-light time, rays and reach
 *   (the level's lighting tier, `levelLighting`).
 *
 * Kept out of `adapter.ts`: the adapter creates one with those targets, tells
 * it the project's environment and LOD tuning and a player's choice; a change
 * applies at once (nothing per frame).
 */
import { deviceLightingTier, deviceQualityLevel, levelLighting, levelScalingIsEngineDefault, qualityLevelOf, qualityLevelsOf, type DeviceGpuInfo, type DeviceLightingTier, type LightingTier, type QualityLevelConfig } from '@thirdlight/runtime';

import { MAX_RENDER_PIXEL_RATIO, type EnvironmentRenderer } from './environment';
import type { RenderControl } from './render-control';

/** The page flag that pins the quality level (`?quality=low`; a diagnostic comparison over a player's choice). */
export const QUALITY_URL_PARAM = 'quality';

/** The level a page's query string pins (null: none). */
export function qualityFromUrl(search: string): string | null {
  const v = new URLSearchParams(search).get(QUALITY_URL_PARAM);
  return v === null || v === '' ? null : v;
}

/**
 * What a renderer says of its GPU: WebGPU's adapter info (`GPUDevice.adapterInfo`;
 * three keeps no adapter), nothing more on WebGL 2 (its tier is low whatever
 * the GPU: no compute, so saved light only).
 */
export function deviceGpuInfoOf(renderer: unknown, api: 'webgpu' | 'webgl2'): DeviceGpuInfo {
  if (api === 'webgl2') return { api };
  const info = (renderer as { backend?: { device?: { adapterInfo?: { vendor?: unknown; architecture?: unknown; device?: unknown; description?: unknown; isFallbackAdapter?: unknown } } } }).backend?.device?.adapterInfo;
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
  const vendor = str(info?.vendor);
  const architecture = str(info?.architecture);
  const device = str(info?.device);
  const description = str(info?.description);
  return { api, ...(vendor !== undefined ? { vendor } : {}), ...(architecture !== undefined ? { architecture } : {}), ...(device !== undefined ? { device } : {}), ...(description !== undefined ? { description } : {}), ...(info?.isFallbackAdapter === true ? { isFallbackAdapter: true } : {}) };
}

/** The project environment's part a level comes from (structural). */
export interface QualityProjectLike {
  readonly quality?: string;
  readonly qualityLevels?: readonly QualityLevelConfig[];
}

export interface QualityTargets {
  readonly renderControl: RenderControl;
  readonly lodTuning: { readonly bias: number; set(t: { readonly bias?: number; readonly hysteresis?: number }): boolean };
  /** The scene lights' limits; true when the lights that are on must be selected again. */
  readonly setLightLimits: (limits: { readonly shadowMapSize: number | null }) => boolean;
  readonly reselectLights: () => void;
  /** The most drawing-buffer pixels per CSS pixel. */
  readonly setPixelRatioCap: (cap: number) => void;
  /** The surface cache's budget (MiB; absent: the page keeps no cache). */
  readonly setSurfaceCacheMiB?: (mib: number) => void;
  /** The level's GPU time a frame for live surface light (ms; 0: saved light only). */
  readonly setSurfaceLightMs?: (ms: number) => void;
  /** The level's lighting tier's multiples of the rays a cache texel casts and of each cache level's reach. */
  readonly setSurfaceDetail?: (rays: number, reach: number) => void;
  /** The shadow atlas's side (texels) at the level. */
  readonly setShadowAtlas?: (side: number) => void;
  readonly environment: () => EnvironmentRenderer | null;
  /** Something drawn changed (a host drawing on demand draws again). */
  readonly changed: () => void;
}

export interface QualityDiagnostics {
  /** The level drawn and the project's levels (lowest first). */
  readonly level: string;
  readonly levels: readonly string[];
  /** Where the level comes from. */
  readonly source: 'page' | 'chosen' | 'project' | 'device' | 'highest';
  /** The level's lighting tier (`low` on WebGL 2 whatever the level: its light is the saved light). */
  readonly tier: LightingTier;
  /** The device's tier and the rule's line (null: the renderer is not up yet). */
  readonly device: DeviceLightingTier | null;
  readonly pixelRatioCap: number;
  /** The largest shadow map (null: each light's own size). */
  readonly shadowMapSize: number | null;
  /** The LOD bias drawn with (the level's, else the project's). */
  readonly lodBias: number;
  /** The surface cache's budget at the level (MiB). */
  readonly surfaceCacheMiB: number;
  /** The GPU time a frame may spend on live surface light at the level (ms; 0: saved light only). */
  readonly surfaceLightMs: number;
  /** The shadow atlas's side at the level (texels). */
  readonly shadowAtlas: number;
}

export interface QualityControl {
  /** The project's environment (its levels and starting level) changed. */
  setProject(project: QualityProjectLike | null): void;
  /** The project's LOD bias and hysteresis (a level's bias lays over the bias). */
  setProjectLod(tuning: { readonly bias?: number; readonly hysteresis?: number }): void;
  /** A player's or the game-control API's choice (an editor's preview), null: none again; false when the project has no such level (nothing changes). */
  choose(id: string | null): boolean;
  /** The level drawn. */
  level(): QualityLevelConfig;
  /** Whether frames go through the environment renderer for the level (a level was chosen or set, or it draws without MSAA). */
  needsEnvironment(): boolean;
  /** A new environment renderer draws the level. */
  applyEnvironment(env: EnvironmentRenderer): void;
  /** The pixel ratio cap now (a renderer made later starts with it). */
  pixelRatioCap(): number;
  /** The renderer is up: its API and GPU give the device's tier, the level when nobody chose one. */
  setDevice(info: DeviceGpuInfo): void;
  /** The lighting tier drawn (`low` on WebGL 2). */
  tier(): LightingTier;
  diagnostics(): QualityDiagnostics;
}

export function createQualityControl(targets: QualityTargets, o: { readonly project: QualityProjectLike | null; readonly lod?: { readonly bias?: number; readonly hysteresis?: number }; readonly pinned?: string | null }): QualityControl {
  let project: QualityProjectLike | null = o.project;
  let projectLod: { bias?: number; hysteresis?: number } = { ...(o.lod ?? {}) };
  let chosen: string | null = null;
  const pinned = o.pinned ?? null;
  let device: DeviceLightingTier | null = null;
  let api: DeviceGpuInfo['api'] | null = null;
  const levels = (): readonly QualityLevelConfig[] => qualityLevelsOf(project);
  const deviceLevel = (): string | null => (device === null ? null : (deviceQualityLevel(levels(), device.tier)?.id ?? null));
  const known = (id: string | null | undefined): string | null => (id !== null && id !== undefined && levels().some((l) => l.id === id) ? id : null);
  // A name the levels do not have (a mistyped `?quality=`, a project's level since removed) falls through to the
  // next source and so to the device's choice; the highest only before the renderer is up.
  const wanted = (): string | null => known(pinned) ?? known(chosen) ?? known(project?.quality) ?? deviceLevel();
  const current = (): QualityLevelConfig => qualityLevelOf(levels(), wanted());
  /** The level last applied and the project LOD it was applied with. */
  let applied: QualityLevelConfig | null = null;
  let appliedLod = '';
  let cap = MAX_RENDER_PIXEL_RATIO;

  const apply = (): void => {
    const l = current();
    const lodKey = JSON.stringify(projectLod);
    if (l === applied && lodKey === appliedLod) return;
    applied = l;
    appliedLod = lodKey;
    // The engine's levels' scale and dynamic resolution are defaults: a project's own render_scale and
    // dynamic_resolution settings stay its own, also where the project copied the engine's level. A
    // project's own scale on a level sets it over the project's.
    const scaling = { ...(l.renderScale !== undefined ? { renderScale: l.renderScale } : {}), ...(l.dynamicResolution !== undefined ? { dynamicResolution: l.dynamicResolution } : {}) };
    const engine = levelScalingIsEngineDefault(l);
    targets.renderControl.setLevel(
      {
        ...(l.ambientOcclusion !== undefined ? { ambientOcclusion: l.ambientOcclusion } : {}),
        ...(engine ? {} : scaling),
        ...(l.occlusionCulling !== undefined ? { occlusionCulling: l.occlusionCulling } : {}),
      },
      engine ? scaling : {},
    );
    targets.lodTuning.set({ ...projectLod, ...(l.lodBias !== undefined ? { bias: l.lodBias } : {}) });
    if (targets.setLightLimits({ shadowMapSize: l.shadowMapSize ?? null })) targets.reselectLights();
    const nextCap = l.pixelRatio ?? MAX_RENDER_PIXEL_RATIO;
    if (nextCap !== cap) {
      cap = nextCap;
      targets.setPixelRatioCap(cap);
    }
    const lit = levelLighting(l);
    targets.setSurfaceCacheMiB?.(lit.surfaceCacheMiB);
    targets.setSurfaceLightMs?.(lit.surfaceLightMs);
    targets.setSurfaceDetail?.(lit.surfaceRays, lit.surfaceReach);
    targets.setShadowAtlas?.(lit.shadowAtlas);
    targets.environment()?.setQuality(wanted());
    targets.changed();
  };
  apply();

  return {
    setProject(next) {
      project = next;
      apply();
    },
    setProjectLod(tuning) {
      projectLod = { ...projectLod, ...tuning };
      apply();
    },
    choose(id) {
      if (id !== null && !levels().some((l) => l.id === id)) return false;
      chosen = id;
      apply();
      return true;
    },
    level: current,
    needsEnvironment: () => wanted() !== null || current().msaa === 0,
    applyEnvironment(env) {
      env.setQuality(wanted());
    },
    pixelRatioCap: () => cap,
    setDevice(info) {
      const next = deviceLightingTier(info);
      api = info.api;
      if (device !== null && device.reason === next.reason) return;
      device = next;
      const level = deviceLevel();
      const unknown = pinned !== null && known(pinned) === null ? `; ?${QUALITY_URL_PARAM}=${pinned} names no level` : '';
      console.info(`[thirdlight] quality: ${next.reason}; starts at level "${level ?? current().id}" unless the player, the game or the project names one${unknown}`);
      apply();
    },
    tier: () => (api === 'webgl2' ? 'low' : levelLighting(current()).tier),
    diagnostics() {
      const l = current();
      const w = wanted();
      return {
        level: l.id,
        levels: levels().map((x) => x.id),
        source: w === null || w !== l.id ? 'highest' : known(pinned) !== null ? 'page' : known(chosen) !== null ? 'chosen' : known(project?.quality) !== null ? 'project' : 'device',
        tier: api === 'webgl2' ? 'low' : levelLighting(l).tier,
        device,
        pixelRatioCap: cap,
        shadowMapSize: l.shadowMapSize ?? null,
        lodBias: targets.lodTuning.bias,
        surfaceCacheMiB: levelLighting(l).surfaceCacheMiB,
        surfaceLightMs: levelLighting(l).surfaceLightMs,
        shadowAtlas: levelLighting(l).shadowAtlas,
      };
    },
  };
}
