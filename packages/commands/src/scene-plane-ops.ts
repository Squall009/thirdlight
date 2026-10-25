/**
 * `setScenePlane {sceneId, plane}`: a scene's default plane (`{axis: 'x' |
 * 'z', origin}`, or null for none). A collider or controller of the scene
 * without a `plane` of its own is locked to it in the game, and a script's
 * `{x, y}` queries run on it. One undo step; the content is unchanged.
 */
import { isPlaneLock, planeLockOf, type Migrated2DMarks, type PlaneLock } from '@thirdlight/project-model';

import type { OpInput } from './content-ops';
import { contentOf } from './content-ops';
import { fieldValue } from './errors';
import { gateResultState, type OpOutcome } from './ops';
import type { SetScenePlaneChange } from './types';

type WithPlane = OpInput['scene'] & { defaultPlane?: PlaneLock };

/** The scene with its default plane replaced (null: none). */
export function withScenePlane<S extends OpInput['scene']>(scene: S, plane: PlaneLock | null): S {
  const out = { ...scene } as S & { defaultPlane?: PlaneLock };
  if (plane !== null) out.defaultPlane = { axis: plane.axis, origin: plane.origin };
  else delete out.defaultPlane;
  return out;
}

/** The scene without the upgrade's note on its plane. */
function withoutPlaneNote<S extends OpInput['scene']>(scene: S): S {
  const marks = (scene as { migratedFrom2D?: Migrated2DMarks }).migratedFrom2D;
  if (marks?.plane === undefined) return scene;
  const { migratedFrom2D: _m, ...rest } = scene as S & { migratedFrom2D?: Migrated2DMarks };
  return (marks.objects !== undefined ? { ...rest, migratedFrom2D: { objects: marks.objects } } : rest) as S;
}

/** A scene's default plane now (null: none). */
export const scenePlaneOf = (scene: OpInput['scene']): PlaneLock | null => planeLockOf({ plane: (scene as WithPlane).defaultPlane });

export function applySetScenePlane(input: OpInput, args: { sceneId: string; plane: PlaneLock | null }): OpOutcome {
  if (input.scene.schemaVersion !== 4) return { ok: false, error: fieldValue('/args/sceneId', args.sceneId, 'a scene of a v4 project', 'a scene carries its own plane only in a v4 project') };
  if (input.scene.sceneId !== args.sceneId) return { ok: false, error: fieldValue('/args/sceneId', args.sceneId, 'an existing scene id', `no scene "${args.sceneId}" in this project`) };
  const next = args.plane !== null && isPlaneLock(args.plane) ? { axis: args.plane.axis, origin: args.plane.origin === 0 ? 0 : args.plane.origin } : null;
  const previous = scenePlaneOf(input.scene);
  const catalog = contentOf(input.content);
  // Setting it (even to what the upgrade of a former 2D project gave) settles the upgrade's note on it.
  const resultScene = { ...withoutPlaneNote(withScenePlane(input.scene, next)), revision: input.scene.revision + 1 };
  const gate = gateResultState({ scene: input.scene, content: catalog, manifest: input.manifest }, resultScene, catalog);
  if (!gate.ok) return gate;
  const change: SetScenePlaneChange = { type: 'setScenePlane', sceneId: args.sceneId, previous, next };
  return { ok: true, op: { scene: gate.scene, content: gate.content, change, inverse: { kind: 'setScenePlane', sceneId: args.sceneId, restore: previous } } };
}
