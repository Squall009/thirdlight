/**
 * One file published as an asset through the commands (upload, then
 * `publishAsset`), as the editor's own tools need it.
 *
 * Browser-only.
 */
import { makeAssetId, type SessionClient } from './client';
import { publishArgsFromProposal, utcSecondTimestamp, type ImportTarget } from './asset-browser';

/**
 * Publish one file (a saved lighting file, an image dropped on the decal
 * editor's palette: a texture; a GLB dropped on a kit slot: a model) as an
 * asset: a new version of `reuse` when that asset still exists (a re-bake),
 * else a new asset. Its asset id, or why it failed (`what` names the file in
 * the message).
 */
export async function publishFileAsset(client: SessionClient, bytes: Uint8Array, displayName: string, reuse: string | undefined, what: string, kind: 'texture' | 'model' = 'texture'): Promise<string | { message: string }> {
  // Whether the previous file still exists is read by id (the editor holds no whole catalog).
  if (reuse !== undefined) await client.catalog.ensureAssets([reuse]);
  const target: ImportTarget = reuse !== undefined && client.content.resolveVersion(reuse) !== null ? { mode: 'reimport', assetId: reuse, displayName } : { mode: 'create', assetId: makeAssetId(), displayName };
  const up = await client.uploadAsset(bytes, { kind, displayName, target });
  if (!up.ok) return { message: `${what} upload failed: ${up.error.message}` };
  const args = publishArgsFromProposal(up.proposal, target, utcSecondTimestamp(), kind);
  if (!args.ok) return { message: `${what} publish failed: ${args.error.message}` };
  const res = await client.command('publishAsset', args.args, client.projection.revision);
  if (!res.ok) return { message: `${what} publish refused: ${(res.response as { message?: string }).message ?? 'unknown'}` };
  return String((args.args as { assetId: string }).assetId);
}
