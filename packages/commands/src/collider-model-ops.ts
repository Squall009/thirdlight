/**
 * `colliderFromModel`: an object's collider made from its own model — a box
 * around it, a convex hull or mesh of its `_COL` node (else its geometry), on
 * a 2D plane its polygon, or a compound of the `_COL` node's convex parts.
 * One command and one undo (a `setComponent collider` change), so the API
 * does what the editor's button does.
 *
 * The host reads the model file (the commands never read files), makes the
 * shape with the project model's `modelColliderShape` and hands it over as a
 * `PreparedModelCollider`; an existing collider keeps its other fields
 * (layers, one-way).
 */
import { MODEL_COLLIDER_KINDS, modelColliderShape, physicsDimensionOf, readModelGeometry, type ModelColliderKind } from '@thirdlight/project-model';

import { applySetComponent, type OpInput } from './content-ops';
import { componentMissing, entityNotFound, fieldMissing, fieldUnexpected, fieldValue, type CommandError } from './errors';
import type { OpOutcome } from './ops';
import type { ContentDocument, SceneDocument } from './types';
import { assetsOf } from './v3';

/** `colliderFromModel` args: the object and what to make. */
export interface ColliderFromModelArgs {
  entityId: string;
  kind: ModelColliderKind;
}

/** The host's shape for the object (made from its model's file). */
export interface PreparedModelCollider {
  entityId: string;
  shape: Record<string, unknown>;
}

export function validateColliderFromModelArgs(args: Record<string, unknown>): { ok: true; args: ColliderFromModelArgs } | { ok: false; error: CommandError } {
  for (const key of Object.keys(args)) if (key !== 'entityId' && key !== 'kind') return { ok: false, error: fieldUnexpected(`/args/${key}`, key, 'entityId, kind') };
  if (args['entityId'] === undefined) return { ok: false, error: fieldMissing('/args/entityId', 'entityId') };
  if (typeof args['entityId'] !== 'string') return { ok: false, error: fieldValue('/args/entityId', args['entityId'], 'an entity id', 'entityId names the object whose model the collider is made from') };
  if (args['kind'] === undefined) return { ok: false, error: fieldMissing('/args/kind', 'kind') };
  if (!(MODEL_COLLIDER_KINDS as readonly unknown[]).includes(args['kind'])) {
    return { ok: false, error: fieldValue('/args/kind', args['kind'], MODEL_COLLIDER_KINDS.map((k) => `"${k}"`).join(' | '), 'kind is box, convex, mesh (3D), polygon (2D plane) or compound') };
  }
  return { ok: true, args: { entityId: args['entityId'], kind: args['kind'] as ModelColliderKind } };
}

/**
 * The shape for the object (the host's half, pure apart from `read`): its
 * model's latest version is read, its geometry made into the asked kind
 * for the project's physics dimension. `source` says whether the `_COL`
 * node or the render geometry was used; `skipped` lists parts left out.
 */
export function planModelCollider(
  scene: SceneDocument,
  content: ContentDocument | undefined,
  args: ColliderFromModelArgs,
  read: (assetId: string, version: number) => { ok: true; bytes: Uint8Array } | { ok: false; error: CommandError },
): { ok: true; prepared: PreparedModelCollider; source: 'collision' | 'geometry'; skipped: string[] } | { ok: false; error: CommandError } {
  const entity = (scene.entities as unknown as { id: string; components: Record<string, unknown> }[]).find((e) => e.id === args.entityId);
  if (entity === undefined) return { ok: false, error: entityNotFound(args.entityId) };
  const model = entity.components['model'] as { asset?: { assetId?: unknown }; piece?: unknown } | undefined;
  const assetId = model?.asset?.assetId;
  if (typeof assetId !== 'string') return { ok: false, error: componentMissing(args.entityId, 'model') };
  const record = content === undefined ? undefined : assetsOf(content).find((a) => a.assetId === assetId);
  const latest = record?.versions.reduce((m, v) => Math.max(m, v.version), 0) ?? 0;
  if (latest < 1) return { ok: false, error: fieldValue('/args/entityId', assetId, 'an object whose model is imported', `the model ${assetId} has no imported version to read`) };
  const bytes = read(assetId, latest);
  if (!bytes.ok) return bytes;
  const geometry = readModelGeometry(bytes.bytes);
  if (!geometry.ok) return { ok: false, error: fieldValue('/args/entityId', assetId, 'a readable model', `the model ${assetId} cannot be read: ${geometry.message}`) };
  const dimension = physicsDimensionOf((content as { settings?: unknown } | undefined)?.settings);
  const made = modelColliderShape(geometry.geometry, typeof model?.piece === 'string' ? model.piece : null, args.kind, dimension);
  if (!made.ok) return { ok: false, error: fieldValue('/args/kind', args.kind, 'a collider the model can give', made.message) };
  return { ok: true, prepared: { entityId: args.entityId, shape: made.shape }, source: made.source, skipped: made.skipped };
}

/** Store the host's shape as the object's collider (added, or its shape replaced). */
export function applyColliderFromModel(input: OpInput, args: ColliderFromModelArgs, prepared: PreparedModelCollider | undefined): OpOutcome {
  if (prepared === undefined || prepared.entityId !== args.entityId) {
    return { ok: false, error: fieldValue('/args', undefined, 'a shape the host made', "colliderFromModel runs through the project host, which reads the object's model file") };
  }
  return applySetComponent(input, { entityId: args.entityId, component: 'collider', value: { shape: prepared.shape } });
}
