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
 * editor's palette: a texture; a GLB dropped on a kit slot: a model) as a
 * new asset. Its asset id, or why it failed (`what` names the file in the
 * message).
 */
export async function publishFileAsset(client: SessionClient, bytes: Uint8Array, displayName: string, what: string, kind: 'texture' | 'model' = 'texture'): Promise<string | { message: string }> {
  const target: ImportTarget = { mode: 'create', assetId: makeAssetId(), displayName };
  const up = await client.uploadAsset(bytes, { kind, displayName, target });
  if (!up.ok) return { message: `${what} upload failed: ${up.error.message}` };
  const args = publishArgsFromProposal(up.proposal, target, utcSecondTimestamp(), kind);
  if (!args.ok) return { message: `${what} publish failed: ${args.error.message}` };
  const res = await client.command('publishAsset', args.args, client.projection.revision);
  if (!res.ok) return { message: `${what} publish refused: ${(res.response as { message?: string }).message ?? 'unknown'}` };
  return String((args.args as { assetId: string }).assetId);
}
