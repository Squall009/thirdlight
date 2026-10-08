/**
 * The `streaming` field of the components that stream (terrain, block
 * layers): one descriptor, so both show the same rings the same way.
 *
 * Pure data.
 */
import { num, obj } from './descriptor-builders';
import type { ObjectFieldDescriptor } from './descriptor-types';
import { STREAMING_HYSTERESIS_LIMITS, STREAMING_RADIUS_LIMITS } from './world-streaming';

const ring = (key: string, label: string, tooltip: string, required?: number): ReturnType<typeof num> => num(key, label, tooltip, { min: STREAMING_RADIUS_LIMITS.min, max: STREAMING_RADIUS_LIMITS.max, step: 1, unit: 'm', ...(required !== undefined ? { required: true, default: required } : {}) });

/**
 * `streaming` of a terrain (what) or of a block layer (`live`: its live ring
 * too); `render` is the render ring a new `streaming` starts with.
 */
export function streamingField(what: string, live: boolean, render: number): ObjectFieldDescriptor {
  return obj('streaming', 'Streaming', `Rings around the camera (in Play and the export) within which its ${what} are loaded, measured across the ground; past them they are let go, within the project's streaming budget (streaming_budget_mb). Empty: everything loaded.`, [
    ring('render', 'Render ring', live ? 'Metres within which chunks are drawn.' : 'Metres within which tiles are drawn at full detail (never less than where they reach their coarsest level); past it they are drawn from the overview a build ships.', render),
    ring('collision', 'Collision ring', `Metres around the camera, its target and every character within which ${what} have colliders (empty: the render ring).`),
    ring('scatter', 'Scatter ring', 'Metres within which stored scatter is drawn (empty: the render ring).'),
    ...(live ? [ring('live', 'Live ring', "Metres around the camera, its target and every character within which live blocks' objects are in the game (empty: the collision ring).")] : []),
    num('hysteresis', 'Hysteresis', 'Metres something loaded may be past its ring before it is let go (empty: a tenth of each ring).', { min: STREAMING_HYSTERESIS_LIMITS.min, max: STREAMING_HYSTERESIS_LIMITS.max, step: 1, unit: 'm' }),
  ]);
}
