/**
 * The simulation step's spans in the frame profiler (shared profiler.ts): a
 * step is one span, and the stages inside it that the budget table plans
 * apart are spans of their own: the voxel worlds' streaming, the scripts'
 * phases, physics, the timelines, the camera, sounds and animation. They are
 * recorded on whatever thread runs the simulation (the worker, or the page
 * in single-thread mode), into that thread's recorder.
 *
 * Path finding has no span yet: the only path query today is `ctx.grid`'s
 * walk over block layers, which run inside the scripts' phases.
 */
import { FRAME_BUDGET_BY_TIER, type LightingTier } from '@thirdlight/project-model';
import { frameArbiter, threadProfiler } from '@thirdlight/shared';

const p = threadProfiler;

export const STEP_SPAN = Object.freeze({
  step: p.span('step', 'other'),
  scenes: p.span('scene loads', 'other'),
  voxels: p.span('voxel streaming', 'voxelStream'),
  scripts: p.span('scripts', 'scripts'),
  physics: p.span('physics', 'physics'),
  blocks: p.span('gameplay blocks', 'scripts'),
  timelines: p.span('timelines', 'scripts'),
  camera: p.span('camera', 'other'),
  audio: p.span('sounds', 'audio'),
  animation: p.span('animation', 'characters'),
});

/** The step's thread follows the page's stats: the frame interval its time slices are taken from, and its tier's slices. */
export function arbiterFollows(frameRateCap: number | null, tier: LightingTier): void {
  frameArbiter.setInterval(frameRateCap !== null ? 1000 / frameRateCap : null);
  frameArbiter.install(FRAME_BUDGET_BY_TIER[tier].slices);
}
