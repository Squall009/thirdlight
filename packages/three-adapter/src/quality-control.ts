/**
 * The adapter's quality level (project-model quality-levels.ts): which level
 * is drawn, and its renderer settings applied where they live.
 *
 * The level is the page's `?quality=` flag (a diagnostic comparison, as the
 * perf harness's `--switches`), else the one a player or the game-control
 * API chose, else the project's (`environment.quality`), else the highest.
 * Its settings go to:
 *
 * - the environment renderer (`setQuality`): the look's post per effect and MSAA;
 * - the render control: AO kind, render scale, dynamic resolution (over the
 *   project's settings, under a player's fields and the page's flags);
 * - the LOD tuning: the bias (over the project's `lod_bias`);
 * - the scene lights: the largest shadow map and the point/spot light budget;
 * - the renderer's pixel ratio cap.
 *
 * Kept out of `adapter.ts`: the adapter creates one with those targets, tells
 * it the project's environment and LOD tuning and a player's choice; a change
 * applies at once (nothing per frame).
 */
import { qualityLevelOf, qualityLevelsOf, type QualityLevelConfig } from '@thirdlight/runtime';

import { MAX_RENDER_PIXEL_RATIO, type EnvironmentRenderer } from './environment';
import type { RenderControl } from './render-control';

/** The page flag that pins the quality level (`?quality=low`; a diagnostic comparison over a player's choice). */
export const QUALITY_URL_PARAM = 'quality';

/** The level a page's query string pins (null: none). */
export function qualityFromUrl(search: string): string | null {
  const v = new URLSearchParams(search).get(QUALITY_URL_PARAM);
  return v === null || v === '' ? null : v;
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
  readonly setLightLimits: (limits: { readonly shadowMapSize: number | null; readonly localLights: number | null; readonly shadowedLights: number | null }) => boolean;
  readonly reselectLights: () => void;
  /** The most drawing-buffer pixels per CSS pixel. */
  readonly setPixelRatioCap: (cap: number) => void;
  readonly environment: () => EnvironmentRenderer | null;
  /** Something drawn changed (a host drawing on demand draws again). */
  readonly changed: () => void;
}

export interface QualityDiagnostics {
  /** The level drawn and the project's levels (lowest first). */
  readonly level: string;
  readonly levels: readonly string[];
  /** Where the level comes from. */
  readonly source: 'page' | 'chosen' | 'project' | 'highest';
  readonly pixelRatioCap: number;
  /** The largest shadow map (null: each light's own size) and the point/spot light budget (null: the scenes'). */
  readonly shadowMapSize: number | null;
  readonly localLights: number | null;
  /** The shadowed point and spot lights' budget (null: every one). */
  readonly shadowedLights: number | null;
  /** The LOD bias drawn with (the level's, else the project's). */
  readonly lodBias: number;
}

export interface QualityControl {
  /** The project's environment (its levels and starting level) changed. */
  setProject(project: QualityProjectLike | null): void;
  /** The project's LOD bias and hysteresis (a level's bias lays over the bias). */
  setProjectLod(tuning: { readonly bias?: number; readonly hysteresis?: number }): void;
  /** A player's or the game-control API's choice; false when the project has no such level (nothing changes). */
  choose(id: string): boolean;
  /** The level drawn. */
  level(): QualityLevelConfig;
  /** Whether frames go through the environment renderer for the level (a level was chosen or set, or it draws without MSAA). */
  needsEnvironment(): boolean;
  /** A new environment renderer draws the level. */
  applyEnvironment(env: EnvironmentRenderer): void;
  /** The pixel ratio cap now (a renderer made later starts with it). */
  pixelRatioCap(): number;
  diagnostics(): QualityDiagnostics;
}

export function createQualityControl(targets: QualityTargets, o: { readonly project: QualityProjectLike | null; readonly lod?: { readonly bias?: number; readonly hysteresis?: number }; readonly pinned?: string | null }): QualityControl {
  let project: QualityProjectLike | null = o.project;
  let projectLod: { bias?: number; hysteresis?: number } = { ...(o.lod ?? {}) };
  let chosen: string | null = null;
  const pinned = o.pinned ?? null;
  const levels = (): readonly QualityLevelConfig[] => qualityLevelsOf(project);
  const wanted = (): string | null => pinned ?? chosen ?? project?.quality ?? null;
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
    targets.renderControl.setLevel({
      ...(l.ambientOcclusion !== undefined ? { ambientOcclusion: l.ambientOcclusion } : {}),
      ...(l.renderScale !== undefined ? { renderScale: l.renderScale } : {}),
      ...(l.dynamicResolution !== undefined ? { dynamicResolution: l.dynamicResolution } : {}),
    });
    targets.lodTuning.set({ ...projectLod, ...(l.lodBias !== undefined ? { bias: l.lodBias } : {}) });
    if (targets.setLightLimits({ shadowMapSize: l.shadowMapSize ?? null, localLights: l.localLights ?? null, shadowedLights: l.shadowedLights ?? null })) targets.reselectLights();
    const nextCap = l.pixelRatio ?? MAX_RENDER_PIXEL_RATIO;
    if (nextCap !== cap) {
      cap = nextCap;
      targets.setPixelRatioCap(cap);
    }
    targets.environment()?.setQuality(pinned ?? chosen);
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
      if (!levels().some((l) => l.id === id)) return false;
      chosen = id;
      apply();
      return true;
    },
    level: current,
    needsEnvironment: () => wanted() !== null || current().msaa === 0,
    applyEnvironment(env) {
      env.setQuality(pinned ?? chosen);
    },
    pixelRatioCap: () => cap,
    diagnostics() {
      const l = current();
      const w = wanted();
      return {
        level: l.id,
        levels: levels().map((x) => x.id),
        source: w === null || w !== l.id ? 'highest' : pinned !== null ? 'page' : chosen !== null ? 'chosen' : 'project',
        pixelRatioCap: cap,
        shadowMapSize: l.shadowMapSize ?? null,
        localLights: l.localLights ?? null,
        shadowedLights: l.shadowedLights ?? null,
        lodBias: targets.lodTuning.bias,
      };
    },
  };
}
