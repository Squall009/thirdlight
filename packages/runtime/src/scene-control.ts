/**
 * `ctx.scenes`: a script's scene requests — load, unload, reload, the active
 * scene — checked when they are made and committed with the step that made
 * them, and why a request would be refused. The runtime owns the scene set
 * and applies the committed requests at the next step boundary.
 */
import { MAX_TRANSITION_FADE, MAX_TRANSITION_UNLOADS } from '@thirdlight/project-model';

import { BehaviorHostError } from './behavior';
import { ENVIRONMENT_EASINGS, type EnvironmentEasing } from './environment-blend';
import { MAX_ENVIRONMENT_BLEND_SECONDS } from './environment-director';
import type { BehaviorSceneControl, SceneActivateOptions, SceneLoadingView, SceneLoadOptions, SceneStatus } from './types';

/** What a transition does once its scene is in: the scenes it unloads (in the same step), its fade (seconds, colour). */
export interface TransitionSpec {
  readonly unload: readonly string[];
  readonly fade: number;
  readonly color: string;
}

/** One requested scene operation, committed with its step. */
export type SceneOp =
  | { op: 'load'; sceneId: string; at?: readonly [number, number, number]; transition?: TransitionSpec }
  | { op: 'unload'; sceneId: string }
  /** The scene's objects as authored again (at the next boundary; an unloaded scene loads). */
  | { op: 'reload'; sceneId: string }
  /** `ctx.scenes.setActive`: its look blends in over `blend` seconds. */
  | { op: 'activate'; sceneId: string; blend: number; easing: EnvironmentEasing };

/**
 * `ctx.lifecycle.restart()` restarts the whole run — the engine does not know
 * what a level restart is. It keeps working with one Problems line per Play
 * naming what replaces it, and is removed once no game uses it.
 */
export const LIFECYCLE_RESTART_DEPRECATED = Object.freeze({ code: 'deprecated_lifecycle_restart', replacement: 'ctx.scenes.reload(sceneId) for each scene to start over, with the game resetting what it keeps itself' });

/** A transition's fade colour. */
export const FADE_COLOR_RE = /^#[0-9a-f]{6}$/;

/** What the requests read of the runtime's scene set. */
export interface SceneRequestHost {
  /** Whether the game runs with a scene catalog. */
  hasCatalog(): boolean;
  /** A scene's place in its load cycle (undefined: no such scene). */
  status(sceneId: string): SceneStatus | undefined;
  /** The player a loaded scene holds when it is not kept loaded (null: none). */
  unkeptPlayerIn(sceneId: string): string | null;
  /** The loaded scene ids, in load order. */
  loaded(): readonly string[];
  loadingView(): SceneLoadingView;
  activeScene(): string | null;
  /** Queue an op with the step (committed when the step is). */
  push(op: SceneOp): void;
}

/** Why a scene request would be refused (null: it would be accepted). */
export function sceneRequestProblem(host: SceneRequestHost, op: 'load' | 'unload' | 'reload', sceneId: unknown, options?: SceneLoadOptions): string | null {
  if (!host.hasCatalog()) return 'this game has no scene catalog (a v4 project runs with one)';
  if (typeof sceneId !== 'string' || host.status(sceneId) === undefined) return `unknown scene ${JSON.stringify(String(sceneId))}`;
  if (op === 'load' && options !== undefined) {
    if (typeof options !== 'object' || options === null) return 'load options must be an object';
    const at = (options as { at?: unknown }).at;
    if (at !== undefined && !(Array.isArray(at) && at.length === 3 && at.every((v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e6))) {
      return 'load option "at" must be [x, y, z] (finite, |v| <= 1e6)';
    }
    // A transition's unloads and fade.
    const o = options as { unload?: unknown; fade?: unknown; fadeColor?: unknown };
    if (o.unload !== undefined) {
      if (!Array.isArray(o.unload) || o.unload.length > MAX_TRANSITION_UNLOADS || !o.unload.every((x) => typeof x === 'string')) return `load option "unload" must be up to ${MAX_TRANSITION_UNLOADS} scene ids`;
      for (const u of o.unload as string[]) {
        if (u === sceneId) return `load option "unload" names the scene it loads (${JSON.stringify(u)})`;
        const p = sceneRequestProblem(host, 'unload', u);
        if (p !== null) return `load option "unload": ${p}`;
      }
    }
    if (o.fade !== undefined && !(typeof o.fade === 'number' && Number.isFinite(o.fade) && o.fade >= 0 && o.fade <= MAX_TRANSITION_FADE)) return `load option "fade" must be seconds (0–${MAX_TRANSITION_FADE})`;
    if (o.fadeColor !== undefined && !(typeof o.fadeColor === 'string' && FADE_COLOR_RE.test(o.fadeColor))) return 'load option "fadeColor" must be "#rrggbb" (lower case)';
  }
  if (op === 'unload' || op === 'reload') {
    // The player's body is made once, when the game starts: it can leave its scene only as a kept object.
    const player = host.unkeptPlayerIn(sceneId);
    if (player !== null) return `scene "${sceneId}" holds the player "${player}", which is not kept loaded (mark it Keep loaded to ${op} its scene)`;
  }
  return null;
}

/** A load op from (validated) load options: its offset, and a transition when it unloads or fades. */
export function loadOp(sceneId: string, options: SceneLoadOptions | undefined): SceneOp {
  const at = options?.at;
  const unload = options?.unload ?? [];
  const fade = options?.fade ?? 0;
  return {
    op: 'load',
    sceneId,
    ...(at !== undefined ? { at: Object.freeze([at[0], at[1], at[2]] as const) } : {}),
    ...(unload.length > 0 || fade > 0 ? { transition: Object.freeze({ unload: Object.freeze([...unload]), fade, color: options?.fadeColor ?? '#000000' }) } : {}),
  };
}

/** `ctx.scenes`: requests are collected with the step and committed with it; a bad argument is a script error. */
export function createSceneControl(host: SceneRequestHost): BehaviorSceneControl {
  const refuse = (message: string): never => {
    throw new BehaviorHostError('module_error', 'behavior_scene_invalid', message);
  };
  return Object.freeze({
    load(sceneId: string, options?: SceneLoadOptions): void {
      const problem = sceneRequestProblem(host, 'load', sceneId, options);
      if (problem !== null) refuse(`ctx.scenes.load: ${problem}`);
      host.push(loadOp(sceneId, options));
    },
    unload(sceneId: string): void {
      const problem = sceneRequestProblem(host, 'unload', sceneId);
      if (problem !== null) refuse(`ctx.scenes.unload: ${problem}`);
      host.push({ op: 'unload', sceneId });
    },
    reload(sceneId: string): void {
      const problem = sceneRequestProblem(host, 'reload', sceneId);
      if (problem !== null) refuse(`ctx.scenes.reload: ${problem}`);
      host.push({ op: 'reload', sceneId });
    },
    status(sceneId: string): SceneStatus {
      const st = host.status(sceneId);
      if (st === undefined) refuse(`ctx.scenes.status: unknown scene ${JSON.stringify(String(sceneId))}`);
      return st as SceneStatus;
    },
    loaded(): readonly string[] {
      return Object.freeze([...host.loaded()]);
    },
    loading(): readonly string[] {
      return host.loadingView().loading;
    },
    transition() {
      return host.loadingView().transition;
    },
    active(): string | null {
      return host.activeScene();
    },
    setActive(sceneId: string, options?: SceneActivateOptions): void {
      if (!host.hasCatalog()) refuse('ctx.scenes.setActive: this game has no scene catalog (a v4 project runs with one)');
      if (typeof sceneId !== 'string' || !host.loaded().includes(sceneId)) refuse(`ctx.scenes.setActive: scene ${JSON.stringify(String(sceneId))} is not loaded`);
      const o = (typeof options === 'object' && options !== null ? options : {}) as SceneActivateOptions;
      const blend = o.blend ?? 0;
      if (typeof blend !== 'number' || !Number.isFinite(blend) || blend < 0 || blend > MAX_ENVIRONMENT_BLEND_SECONDS) refuse(`ctx.scenes.setActive: blend is 0–${MAX_ENVIRONMENT_BLEND_SECONDS} seconds`);
      const easing = o.easing ?? 'linear';
      if (!(ENVIRONMENT_EASINGS as readonly string[]).includes(easing)) refuse(`ctx.scenes.setActive: easing is one of ${ENVIRONMENT_EASINGS.join(', ')}`);
      host.push({ op: 'activate', sceneId, blend, easing });
    },
  });
}
