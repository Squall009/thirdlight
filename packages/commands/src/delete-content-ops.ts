/**
 * `deleteAsset {assetId}` and `deletePrefab {prefabId}`.
 *
 * Each removes one catalog record, and is refused while anything references
 * it. "Anything" is every typed reference the project model checks: scene
 * objects in any scene (a model, an instance set, an audio source, a pickup
 * cue, a script property of type asset, a prefab copy's link, a block
 * variant), prefab objects, other assets (clips for a rig), materials'
 * textures, UI documents, dialogue, timelines, the shell. The record is taken
 * out and the result validated like any edit: whatever no longer resolves is
 * a reference, and the refusal (`reference_in_use`) lists them. The
 * workspace runs the same rule across every scene of the project, and also
 * refuses while a script's source names the id as a string literal
 * (`ctx.spawn("crate")`).
 *
 * The record's bytes stay in the content store (unreferenced blobs are
 * kept), so one undo puts the record back as it was: an asset as a
 * `publishAsset` change (previous: null), a prefab as a `createPrefab` change.
 * A file referenced in a game folder is never touched.
 */

import { gateResultState, deepClone, type OpOutcome } from './ops';
import { contentOf, type OpInput } from './content-ops';
import { fieldValue, type CommandError } from './errors';
import type { ModelError } from '@thirdlight/project-model';
import type { CommandAssetRecord, ContentDocument } from './types';

/** The most references a refusal lists (the count says how many there are). */
const IN_USE_LISTED = 16;

/**
 * The `reference_in_use` refusal of a delete: `details` are the rules that
 * would break (each with its document, scene and path), `message` names the
 * first few.
 */
export function contentInUse(kind: 'asset' | 'prefab', id: string, errors: readonly { path?: string; document?: string; sceneId?: string }[]): CommandError {
  const where = (e: { path?: string; document?: string; sceneId?: string }): string =>
    e.sceneId !== undefined ? `scene ${e.sceneId} ${e.path ?? ''}` : `${e.document ?? 'content'} ${e.path ?? ''}`;
  const listed = errors.slice(0, 3).map(where).join('; ');
  return {
    code: 'reference_in_use',
    cls: 'validation',
    path: kind === 'asset' ? '/args/assetId' : '/args/prefabId',
    found: id,
    ...(kind === 'asset' ? { assetId: id } : { prefabId: id }),
    details: errors.slice(0, IN_USE_LISTED) as unknown as readonly ModelError[],
    detailCount: errors.length,
    ...(errors.length > IN_USE_LISTED ? { detailsTruncated: true } : {}),
    message: `${kind} "${id}" is still used (${errors.length} reference${errors.length === 1 ? '' : 's'}: ${listed}${errors.length > 3 ? '; …' : ''})`,
    hint: `remove those uses first (delete or change the objects, prefabs or documents that name it), then delete the ${kind}`,
  };
}

function refusedByGate(kind: 'asset' | 'prefab', id: string, error: CommandError): CommandError {
  const details = (error.details ?? []) as unknown as { path?: string; document?: string; sceneId?: string }[];
  return contentInUse(kind, id, details.length > 0 ? details : [{ path: error.path ?? '' }]);
}

export function applyDeleteAsset(input: OpInput, args: { assetId: string }): OpOutcome {
  const catalog = contentOf(input.content);
  const record = catalog.assets.find((a) => a.assetId === args.assetId);
  if (record === undefined) {
    return { ok: false, error: fieldValue('/args/assetId', args.assetId, 'an existing assetId', 'no asset with this id') };
  }
  const next: ContentDocument = { ...catalog, assets: catalog.assets.filter((a) => a.assetId !== args.assetId) };
  const resultScene = { ...input.scene, revision: input.scene.revision + 1 };
  const gate = gateResultState({ scene: input.scene, content: catalog, manifest: input.manifest }, resultScene, next);
  if (!gate.ok) return { ok: false, error: refusedByGate('asset', args.assetId, gate.error) };
  const previous = deepClone(record) as CommandAssetRecord;
  return {
    ok: true,
    op: {
      scene: gate.scene,
      content: gate.content,
      change: { type: 'removeAsset', assetId: args.assetId, previous },
      inverse: { kind: 'publishAsset', assetId: args.assetId, restore: deepClone(previous) },
    },
  };
}

export function applyDeletePrefab(input: OpInput, args: { prefabId: string }): OpOutcome {
  const catalog = contentOf(input.content);
  const definition = catalog.prefabs.find((d) => d.prefabId === args.prefabId);
  if (definition === undefined) {
    return { ok: false, error: fieldValue('/args/prefabId', args.prefabId, 'an existing prefabId', 'no prefab with this id') };
  }
  const next: ContentDocument = { ...catalog, prefabs: catalog.prefabs.filter((d) => d.prefabId !== args.prefabId) };
  const resultScene = { ...input.scene, revision: input.scene.revision + 1 };
  const gate = gateResultState({ scene: input.scene, content: catalog, manifest: input.manifest }, resultScene, next);
  if (!gate.ok) return { ok: false, error: refusedByGate('prefab', args.prefabId, gate.error) };
  return {
    ok: true,
    op: {
      scene: gate.scene,
      content: gate.content,
      change: { type: 'removePrefab', prefabId: args.prefabId },
      inverse: { kind: 'restorePrefab', prefabId: args.prefabId, definition: deepClone(definition) },
    },
  };
}
