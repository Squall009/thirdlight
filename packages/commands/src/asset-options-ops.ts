/**
 * `setAssetOptions`: per-asset render options on the asset record (one undo).
 *
 * `vertexColors` (model only): `data` (the default, stored as absence) keeps
 * COLOR_0 as shader data that never multiplies the albedo; `tint` restores the
 * glTF behaviour.
 */

import { assetKindMismatch, assetNotFound } from './errors';
import { contentOf, type OpInput } from './content-ops';
import { deepClone, gateResultState, type OpOutcome } from './ops';
import { assetKindOf } from './v3';
import type { CommandAssetRecord, ContentDocument, SetAssetOptionsArgs, SetAssetOptionsChange } from './types';

export function applySetAssetOptions(input: OpInput, args: SetAssetOptionsArgs): OpOutcome {
  const catalog = contentOf(input.content);
  const existing = (catalog.assets as unknown as CommandAssetRecord[]).find((a) => a.assetId === args.assetId);
  if (existing === undefined) return { ok: false, error: assetNotFound(args.assetId) };
  if (assetKindOf(existing) !== 'model') return { ok: false, error: assetKindMismatch(args.assetId, 'model', assetKindOf(existing)) };
  const previous = deepClone(existing);
  const { vertexColors: _old, ...rest } = deepClone(existing);
  const next: CommandAssetRecord = args.vertexColors === 'tint' ? { ...rest, vertexColors: 'tint' } : rest;
  const assets = (catalog.assets as unknown as CommandAssetRecord[]).map((a) => (a.assetId === args.assetId ? next : a));
  const nextContent = { ...catalog, assets } as unknown as ContentDocument;
  const resultScene = { ...input.scene, revision: input.scene.revision + 1 };
  const gate = gateResultState({ scene: input.scene, content: catalog, manifest: input.manifest }, resultScene, nextContent);
  if (!gate.ok) return gate;
  const committed = (gate.content?.assets as unknown as CommandAssetRecord[] | undefined)?.find((a) => a.assetId === args.assetId) ?? next;
  const change: SetAssetOptionsChange = { type: 'setAssetOptions', assetId: args.assetId, previous, next: deepClone(committed) };
  return {
    ok: true,
    op: { scene: gate.scene, content: gate.content, change, inverse: { kind: 'setAssetOptions', assetId: args.assetId, restore: previous } },
  };
}
