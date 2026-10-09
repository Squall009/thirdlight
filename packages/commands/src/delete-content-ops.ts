/**
 * `deleteAsset {assetId}`, `deletePrefab {prefabId}`, `deleteBehavior
 * {behaviorId}` and `revokeBehaviorTrust {sourceDigest}`.
 *
 * Each removes one catalog record, and is refused while anything references
 * it. "Anything" is every typed reference the project model checks: scene
 * objects in any scene (a model, an instance set, an audio source, a pickup
 * cue, a script property of type asset, a prefab copy's link, a block
 * variant, a behavior component), prefab objects (and through them live
 * block types and spawns), other assets (clips for a rig), materials'
 * textures, UI documents, dialogue, timelines, the shell. The record is taken
 * out and the result validated like any edit: whatever no longer resolves is
 * a reference, and the refusal (`reference_in_use`) lists them. The
 * workspace runs the same rule across every scene of the project, and also
 * refuses while a script's source names an asset or prefab id as a string
 * literal (`ctx.spawn("crate")`). A behavior is not looked up by name from
 * script code (no script call takes a behavior id), so a behavior's uses are
 * its components only.
 *
 * A trust entry is "used" while a published script was built from that exact
 * source or against that exact library version: revoking it then would leave
 * code in the project that nobody acknowledged. Delete the script (or publish
 * another version) first. A revoked digest is asked for again the next time
 * it is published.
 *
 * The record's bytes stay in the content store (unreferenced blobs are
 * kept), so one undo puts the record back as it was: an asset as a
 * `publishAsset` change (previous: null), a prefab as a `createPrefab`
 * change, a behavior as a `publishBehavior` change, a trust entry as an
 * `acknowledgeBehaviorTrust` change. A file referenced in a game folder is
 * never touched.
 */

import { gateResultState, deepClone, type OpOutcome } from './ops';
import { contentOf, type OpInput } from './content-ops';
import { fieldValue, type CommandError } from './errors';
import type { BehaviorRecord, ModelError, TrustEntry } from '@thirdlight/project-model';
import type { CommandAssetRecord, ContentDocument } from './types';

/** The most references a refusal lists (the count says how many there are). */
const IN_USE_LISTED = 16;

/**
 * The `reference_in_use` refusal of a delete: `details` are the rules that
 * would break (each with its document, scene and path), `message` names the
 * first few.
 */
/** What a delete removes, and the argument naming it. */
export type DeletedKind = 'asset' | 'prefab' | 'behavior' | 'trusted source';
const ID_KEY: Readonly<Record<DeletedKind, 'assetId' | 'prefabId' | 'behaviorId' | 'sourceDigest'>> = {
  asset: 'assetId',
  prefab: 'prefabId',
  behavior: 'behaviorId',
  'trusted source': 'sourceDigest',
};

export function contentInUse(kind: DeletedKind, id: string, errors: readonly { path?: string; document?: string; sceneId?: string }[]): CommandError {
  const where = (e: { path?: string; document?: string; sceneId?: string }): string =>
    e.sceneId !== undefined ? `scene ${e.sceneId} ${e.path ?? ''}` : `${e.document ?? 'content'} ${e.path ?? ''}`;
  const listed = errors.slice(0, 3).map(where).join('; ');
  return {
    code: 'reference_in_use',
    cls: 'validation',
    path: `/args/${ID_KEY[kind]}`,
    found: id,
    [ID_KEY[kind]]: id,
    details: errors.slice(0, IN_USE_LISTED) as unknown as readonly ModelError[],
    detailCount: errors.length,
    ...(errors.length > IN_USE_LISTED ? { detailsTruncated: true } : {}),
    message: `${kind} "${id}" is still used (${errors.length} reference${errors.length === 1 ? '' : 's'}: ${listed}${errors.length > 3 ? '; …' : ''})`,
    hint:
      kind === 'trusted source'
        ? 'delete those scripts (or publish another version of them) first, then revoke the source'
        : `remove those uses first (delete or change the objects, prefabs or documents that name it), then delete the ${kind}`,
  };
}

function refusedByGate(kind: DeletedKind, id: string, error: CommandError): CommandError {
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

export function applyDeleteBehavior(input: OpInput, args: { behaviorId: string }): OpOutcome {
  const catalog = contentOf(input.content);
  const record = catalog.behaviors.find((b) => b.behaviorId === args.behaviorId);
  if (record === undefined) {
    return { ok: false, error: fieldValue('/args/behaviorId', args.behaviorId, 'an existing behaviorId', 'no behavior with this id') };
  }
  const next: ContentDocument = { ...catalog, behaviors: catalog.behaviors.filter((b) => b.behaviorId !== args.behaviorId) };
  const resultScene = { ...input.scene, revision: input.scene.revision + 1 };
  const gate = gateResultState({ scene: input.scene, content: catalog, manifest: input.manifest }, resultScene, next);
  if (!gate.ok) return { ok: false, error: refusedByGate('behavior', args.behaviorId, gate.error) };
  const previous = deepClone(record) as BehaviorRecord;
  return {
    ok: true,
    op: {
      scene: gate.scene,
      content: gate.content,
      // A removal is a publication with nothing after it (the same change the undo of a first publish sends).
      change: { type: 'publishBehavior', behaviorId: args.behaviorId, previous, next: null },
      inverse: { kind: 'publishBehavior', behaviorId: args.behaviorId, restore: deepClone(previous) },
    },
  };
}

/** The published scripts built from this exact source, or against this exact library version. */
function scriptsTrusting(behaviors: readonly BehaviorRecord[], sourceDigest: string): { path: string; document: string }[] {
  const out: { path: string; document: string }[] = [];
  behaviors.forEach((b, i) => {
    if (b.source === null) return;
    if (b.source.sourceDigest === sourceDigest) out.push({ document: 'content', path: `/behaviors/${i}/source/sourceDigest (script ${b.behaviorId})` });
    (b.source.libraries ?? []).forEach((pin, j) => {
      if (pin.sourceDigest === sourceDigest) out.push({ document: 'content', path: `/behaviors/${i}/source/libraries/${j} (script ${b.behaviorId}, library ${pin.libraryId})` });
    });
  });
  return out;
}

export function applyRevokeBehaviorTrust(input: OpInput, args: { sourceDigest: string }): OpOutcome {
  const catalog = contentOf(input.content);
  const previous = deepClone(catalog.behaviorTrust.entries) as TrustEntry[];
  if (!previous.some((e) => e.sourceDigest === args.sourceDigest)) {
    return { ok: false, error: fieldValue('/args/sourceDigest', args.sourceDigest, 'an acknowledged sourceDigest', 'this source was never acknowledged (or was revoked already)') };
  }
  const uses = scriptsTrusting(catalog.behaviors, args.sourceDigest);
  if (uses.length > 0) return { ok: false, error: contentInUse('trusted source', args.sourceDigest, uses) };
  const entries = previous.filter((e) => e.sourceDigest !== args.sourceDigest);
  const nextContent: ContentDocument = { ...catalog, behaviorTrust: { entries } };
  const resultScene = { ...input.scene, revision: input.scene.revision + 1 };
  const gate = gateResultState({ scene: input.scene, content: catalog, manifest: input.manifest }, resultScene, nextContent);
  if (!gate.ok) return gate;
  return {
    ok: true,
    op: {
      scene: gate.scene,
      content: gate.content,
      change: { type: 'acknowledgeBehaviorTrust', sourceDigest: args.sourceDigest, previous, next: deepClone(entries) },
      inverse: { kind: 'acknowledgeBehaviorTrust', sourceDigest: args.sourceDigest, restore: previous },
    },
  };
}
