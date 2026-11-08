/**
 * Game data: the opaque JSON a game hangs on engine records (a voxel kit and
 * its slots, a material, a physical profile) for its own logic (sounds, break
 * tags, block health). The engine validates that it is JSON, keeps it, ships
 * it, and never reads a member.
 */
import { isPlainObjectStrict } from '@thirdlight/shared';
import type { ModelErrorV2 } from './errors';

export type GameDataJson = null | boolean | number | string | GameDataJson[] | { [key: string]: GameDataJson };

/** Nesting depth of game data (JSON parsers stop far deeper; this keeps a walk over it bounded). */
export const GAME_DATA_DEPTH_MAX = 32;

/** Whether a value is JSON within the depth bound (plain objects, arrays, finite numbers, strings, booleans, null). */
export function isGameData(v: unknown, depth = 0): boolean {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (depth >= GAME_DATA_DEPTH_MAX) return false;
  if (Array.isArray(v)) return v.every((x) => isGameData(x, depth + 1));
  if (isPlainObjectStrict(v)) return Object.values(v).every((x) => isGameData(x, depth + 1));
  return false;
}

/** Game data at `path` (absent is valid). */
export function validateGameData(v: unknown, path: string, errors: ModelErrorV2[]): void {
  if (v !== undefined && !isGameData(v)) errors.push({ code: 'field_value', path, message: `gameData is JSON (objects, lists, finite numbers, text, true/false, null) nested at most ${GAME_DATA_DEPTH_MAX} deep` } as ModelErrorV2);
}
