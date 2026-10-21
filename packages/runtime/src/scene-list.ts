/**
 * The shell's scene list as a way to move between levels — `ctx.shell` and
 * the `nextScene` UI engine action — and the Problems lines of the deprecated
 * UI engine actions. A game changes levels with the scene API
 * (`ctx.scenes.load` / `unload`, `setActive` for whose look shows); the list's
 * move is a second, older way that keeps working with one Problems line per
 * Play until no game uses it. The list itself stays: a kept player still
 * arrives at a listed scene's spawn however the scene loads.
 */
import { UI_DEPRECATED_ENGINE_ACTIONS, type UiEngineAction } from '@thirdlight/project-model';

import type { BehaviorShell } from './types';

/** `ctx.shell` (any of its calls): what replaces it. */
export const SHELL_SCENE_LIST_DEPRECATED = Object.freeze({
  code: 'deprecated_shell_scene_list',
  replacement: 'ctx.scenes.load(next, {unload: [current]}) and ctx.scenes.setActive(next) for its look',
});

/** The Problems line a deprecated UI engine action writes (null: the action is not deprecated). */
export function deprecatedEngineActionLine(name: string): { code: string; message: string } | null {
  const deprecated = UI_DEPRECATED_ENGINE_ACTIONS[name as UiEngineAction];
  if (deprecated === undefined) return null;
  const what = name === 'nextScene' ? "it moves along the shell's scene list" : 'it restarts the whole run';
  return { code: deprecated.code, message: `the ${name} engine action is deprecated and will be removed (${what}); use ${deprecated.replacement} — see the migration notes` };
}

/** What `ctx.shell` reads and asks of the runtime. */
export interface ShellControlHost {
  /** The scene list entry the run is at (-1: none). */
  listedIndex(): number;
  /** How many entries the list has. */
  count(): number;
  /** Move to this entry at the next step boundary. */
  goTo(index: number): void;
  /** One Problems line per Play. */
  problem(code: string, message: string): void;
}

/** `ctx.shell`: the shell's scene list from scripts; every call keeps working and says it is deprecated once. */
export function createShellControl(host: ShellControlHost): BehaviorShell {
  const said = (call: string): void =>
    host.problem(SHELL_SCENE_LIST_DEPRECATED.code, `ctx.shell.${call}() is deprecated and will be removed (a second way to change levels); use ${SHELL_SCENE_LIST_DEPRECATED.replacement} — see the migration notes`);
  return Object.freeze({
    nextScene(): boolean {
      said('nextScene');
      // From the entry the run is at (calling it twice in a step asks for the same move).
      const next = host.listedIndex() + 1;
      if (next >= host.count()) return false;
      host.goTo(next);
      return true;
    },
    sceneIndex(): number {
      said('sceneIndex');
      return host.listedIndex();
    },
    sceneCount(): number {
      said('sceneCount');
      return host.count();
    },
  });
}
