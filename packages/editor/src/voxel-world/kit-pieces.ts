/**
 * The editor's side of a project's voxel kits: the kit records read through
 * the command route (`queryGameConfig`'s `voxelKits`), and each kit mesh's
 * GLB read from the backend at the version its digest names (the current
 * one when no version has those bytes, as a build ships it). The voxel world
 * page and the Scene view draw kit pieces from these, through the same
 * piece table their streamer derives with (`worldPieceTable`).
 */
import { VoxelKitMeshes, type VoxelKitBytes, type VoxelKitRecordLike, type VoxelKitSet } from '@thirdlight/three-adapter';
import { createGltfLoaderPort } from '@thirdlight/three-adapter/gltf-loader';
import { worldPieceTable, type PieceTable } from '@thirdlight/voxel';

/** The project route (`/api/v1/projects/<id>`) and the headers it needs. */
export interface KitRoute {
  readonly api: string;
  readonly projectId: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** The project's voxel kits now. */
export async function readVoxelKits(r: KitRoute): Promise<VoxelKitRecordLike[]> {
  const res = await fetch(`${r.api}/commands`, { method: 'POST', headers: { ...r.headers, 'content-type': 'application/json' }, body: JSON.stringify({ op: 'queryGameConfig', projectId: r.projectId, args: { omit: ['dialogues'] } }) });
  if (!res.ok) throw new Error(`queryGameConfig: HTTP ${res.status}`);
  return ((await res.json()) as { voxelKits?: VoxelKitRecordLike[] }).voxelKits ?? [];
}

/** Reads a kit mesh's GLB from the backend: the asset's version whose source digest the mesh names, else its current one (as a build ships it). */
export function backendKitBytes(r: KitRoute): VoxelKitBytes {
  return async (ref) => {
    const rec = await fetch(`${r.api}/content/assets/${encodeURIComponent(ref.assetId)}`, { headers: r.headers });
    if (!rec.ok) return null;
    const record = (await rec.json()) as { asset?: { currentVersion?: number }; versions?: { version: number; sourceDigest?: string }[] };
    const versions = record.versions ?? [];
    const v = versions.find((x) => x.sourceDigest === ref.digest) ?? versions.find((x) => x.version === record.asset?.currentVersion);
    if (v === undefined) return null;
    const bytes = await fetch(`${r.api}/content/assets/${encodeURIComponent(ref.assetId)}/versions/${v.version}/bytes`, { headers: r.headers });
    if (!bytes.ok) return null;
    return { bytes: new Uint8Array(await bytes.arrayBuffer()), version: v.version };
  };
}

/** A page's kit pieces: the table its streamer derives with, the set its view draws from, and the meshes loading. */
export interface PageKitPieces {
  /** Null: no table (the engine's default stand-in pieces only). */
  readonly table: PieceTable | null;
  readonly set: VoxelKitSet | null;
  readonly meshes: VoxelKitMeshes;
  /** Resolves once every kit mesh has loaded or failed: a line naming those that failed ('' when none). */
  readonly loaded: Promise<string>;
}

/** The project's kits (null: none, not even the default kit) with their meshes loading from the backend. */
export function pageKitPieces(r: KitRoute, kits: readonly VoxelKitRecordLike[] | null): PageKitPieces {
  const meshes = new VoxelKitMeshes();
  if (kits === null) return { table: null, set: null, meshes, loaded: Promise.resolve('') };
  const table = worldPieceTable(kits);
  const loaded = meshes.load(kits, backendKitBytes(r), createGltfLoaderPort()).then((l) => (l.failed.length === 0 ? '' : `kit meshes not drawn: ${l.failed.join('; ')}`));
  return { table, set: meshes.set(table, kits), meshes, loaded };
}
