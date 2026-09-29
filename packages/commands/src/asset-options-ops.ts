/**
 * `setAssetOptions`: per-asset render options on the asset record (one undo).
 *
 * `vertexColors` (model only): `data` (the default, stored as absence) keeps
 * COLOR_0 as shader data that never multiplies the albedo; `tint` restores the
 * glTF behaviour.
 *
 * `clipsFor` (model only, v4): marks an animation-only file whose
 * clips play on another model asset's rig (matched by bone names); null
 * clears it. The resulting-state check refuses a missing or non-model rig,
 * the asset itself and a rig that is itself clips-only.
 *
 * `sourcePath` (any kind): where the asset's file now is in the game folder.
 * The file is the asset and the id stays, so every reference keeps working;
 * the workspace moves the file and its `.tlasset` sidecar when they are still
 * at the old path, or records a move made outside the editor. A converted
 * version records the path of its original (FBX, PNG/JPEG).
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
  const modelOnly = args.vertexColors !== undefined || args.materials !== undefined || args.clipsFor !== undefined;
  if (modelOnly && assetKindOf(existing) !== 'model') return { ok: false, error: assetKindMismatch(args.assetId, 'model', assetKindOf(existing)) };
  const previous = deepClone(existing);
  let next: CommandAssetRecord = deepClone(existing);
  if (args.vertexColors !== undefined) {
    const { vertexColors: _old, ...rest } = next;
    next = args.vertexColors === 'tint' ? { ...rest, vertexColors: 'tint' } : rest;
  }
  if (args.materials !== undefined) {
    const { materials: _m, ...rest } = next as CommandAssetRecord & { materials?: Record<string, string> };
    next = (args.materials === null ? rest : { ...rest, materials: deepClone(args.materials) }) as CommandAssetRecord;
  }
  if (args.clipsFor !== undefined) {
    const { clipsFor: _c, ...rest } = next as CommandAssetRecord & { clipsFor?: string };
    next = (args.clipsFor === null ? rest : { ...rest, clipsFor: args.clipsFor }) as CommandAssetRecord;
  }
  if (args.sourcePath !== undefined) {
    const current = next.versions.find((v) => v.version === next.currentVersion);
    if (current !== undefined) {
      const moved = { ...current } as typeof current & { sourcePath?: string; convertedFrom?: { sourcePath?: string } };
      if (moved.convertedFrom !== undefined) moved.convertedFrom = { ...moved.convertedFrom, sourcePath: args.sourcePath };
      else moved.sourcePath = args.sourcePath;
      next = { ...next, versions: next.versions.map((v) => (v === current ? moved : v)) };
    }
  }
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
