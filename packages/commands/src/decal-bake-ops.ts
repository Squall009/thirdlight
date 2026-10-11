/**
 * "Bake to model" inside a model's publish: the clipped decal's mesh, staged
 * as a GLB, becomes a model asset, and the decal's object becomes a placed
 * model of it, in one change. Separate commands would leave a half-made bake
 * behind when one is refused (the model and the decal both drawn, or a model
 * without its material map) and take several undos to take back.
 *
 * The baked file names its one material `<decal material>_decal`; the new
 * record's material map names the decal's own material for it, so the model
 * draws as a mesh decal of that material wherever it is placed. The object's
 * `decal` component is replaced by `model`, written as follow-ups of the
 * publish (the history entry restores both before the record is removed).
 */
import { bakedDecalMaterialName } from '@thirdlight/project-model';

import { componentMissing, entityNotFound, fieldValue, type CommandError } from './errors';
import type { ComponentFollow } from './follow-ops';
import { deepClone } from './ops';
import type { PublishAssetArgs, SceneDocument } from './types';

type AnyEntity = { id: string; components: Record<string, unknown> };

/** What a bake adds to the publish. */
export interface DecalBakePlan {
  /** The new record's material map. */
  materials: Record<string, string>;
  /** The scene's entities with the object's decal swapped for the model. */
  entities: unknown[];
  entityId: string;
  /** The decal component the undo puts back. */
  decal: unknown;
}

function conflict(path: string, reason: string, message: string, expected: string): CommandError {
  return { code: 'component_conflict', cls: 'validation', path, reason, message, expected } as CommandError;
}

/** Check the bake against the scene and plan it; nothing is applied. */
export function planDecalBake(scene: SceneDocument, args: PublishAssetArgs, bake: { entityId: string }): { ok: true; plan: DecalBakePlan } | { ok: false; error: CommandError } {
  if (args.mode !== 'create' || args.kind !== 'model') {
    return { ok: false, error: fieldValue('/args/bakeDecal', bake, 'a model create (mode "create", kind "model")', 'bakeDecal publishes a new model asset') };
  }
  const index = scene.entities.findIndex((e) => e.id === bake.entityId);
  if (index < 0) return { ok: false, error: entityNotFound(bake.entityId) };
  const entity = scene.entities[index] as unknown as AnyEntity;
  const decal = entity.components['decal'] as { mode?: unknown; material?: unknown } | undefined;
  if (decal === undefined) return { ok: false, error: componentMissing(bake.entityId, 'decal') };
  // A projected decal has no mesh of its own: only a clipped one was cut into the file being published.
  if (decal.mode !== 'clipped') return { ok: false, error: conflict('/args/bakeDecal/entityId', 'decal_mode', 'only a clipped decal is baked to a model', 'a decal with mode "clipped"') };
  if (typeof decal.material !== 'string') return { ok: false, error: componentMissing(bake.entityId, 'decal') };
  if (entity.components['model'] !== undefined) {
    return { ok: false, error: conflict('/args/bakeDecal/entityId', 'model_present', 'the object already carries a model; the baked model would replace it', 'an object without a model') };
  }
  const components: Record<string, unknown> = { ...entity.components, model: { asset: { assetId: args.assetId } } };
  delete components['decal'];
  const entities = [...scene.entities] as unknown[];
  entities[index] = { ...deepClone(entity), components };
  return {
    ok: true,
    plan: { materials: { [bakedDecalMaterialName(decal.material)]: decal.material }, entities, entityId: bake.entityId, decal: deepClone(decal) },
  };
}

/** The follow-ups a passed bake recorded, with the model as the gate stored it. */
export function decalBakeFollows(plan: DecalBakePlan, gated: SceneDocument): ComponentFollow[] {
  const stored = (gated.entities.find((e) => e.id === plan.entityId) as unknown as AnyEntity | undefined)?.components['model'];
  return [
    { entityId: plan.entityId, component: 'decal', restore: plan.decal, next: null },
    { entityId: plan.entityId, component: 'model', restore: null, next: deepClone(stored ?? null) },
  ];
}
