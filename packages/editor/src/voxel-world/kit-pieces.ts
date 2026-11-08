/**
 * The editor's side of a project's voxel kits: the kit records (each with
 * the material ids it binds, from the material records), and the project's
 * piece seed read through the command route (`queryGameConfig`'s
 * `voxelKits`, `materials` and `settings`), and each kit mesh's
 * GLB read from the backend at the version its digest names (the current
 * one when no version has those bytes, as a build ships it). The voxel world
 * page and the Scene view draw kit pieces from these, through the same
 * piece table their streamer derives with (`worldPieceTable`).
 */
import { decodeTexture, setKtx2DecoderBase, VoxelKitMeshes, type VoxelKitBytes, type VoxelKitRecordLike, type VoxelKitSet, type VoxelKitTextures } from '@thirdlight/three-adapter';
import { createGltfLoaderPort } from '@thirdlight/three-adapter/gltf-loader';
import { voxelPieceSeedOf } from '@thirdlight/project-model/voxel-world';
import { boundVoxelKits } from '@thirdlight/project-model/voxel-materials';
import type { MaterialDef } from '@thirdlight/project-model';
import { worldPieceTable, type PieceTable } from '@thirdlight/voxel';

/** The project route (`/api/v1/projects/<id>`) and the headers it needs. */
export interface KitRoute {
  readonly api: string;
  readonly projectId: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** A project's voxel kits and its piece seed (project settings: which of a slot's meshes each piece draws). */
export interface ProjectVoxelKits {
  readonly kits: readonly VoxelKitRecordLike[];
  readonly seed: number;
  /** The material records read with them (absent: not read). */
  readonly materials?: readonly MaterialDef[];
}

/** The project's voxel kits and piece seed now, and its material records. */
export async function readVoxelKits(r: KitRoute): Promise<ProjectVoxelKits> {
  const res = await fetch(`${r.api}/commands`, { method: 'POST', headers: { ...r.headers, 'content-type': 'application/json' }, body: JSON.stringify({ op: 'queryGameConfig', projectId: r.projectId, args: { omit: ['dialogues'] } }) });
  if (!res.ok) throw new Error(`queryGameConfig: HTTP ${res.status}`);
  const body = (await res.json()) as { voxelKits?: VoxelKitRecordLike[]; materials?: MaterialDef[]; settings?: unknown };
  // Each kit with the material ids it binds: the material records' (voxel.kit), then its own test list for the rest.
  return { kits: boundVoxelKits(body.voxelKits ?? [], body.materials ?? []), seed: voxelPieceSeedOf(body.settings), materials: body.materials ?? [] };
}

/** Reads a kit mesh's GLB from the backend: the asset's version whose source digest the mesh names, else its current one (as a build ships it). */
export function backendKitBytes(r: KitRoute): VoxelKitBytes {
  return async (ref) => {
    const rec = await fetch(`${r.api}/content/assets/${encodeURIComponent(ref.assetId)}`, { headers: r.headers });
    if (!rec.ok) return null;
    const record = (await rec.json()) as { asset?: { currentVersion?: number; textures?: Record<string, string> }; versions?: { version: number; sourceDigest?: string }[] };
    const versions = record.versions ?? [];
    const v = versions.find((x) => x.sourceDigest === ref.digest) ?? versions.find((x) => x.version === record.asset?.currentVersion);
    if (v === undefined) return null;
    const bytes = await fetch(`${r.api}/content/assets/${encodeURIComponent(ref.assetId)}/versions/${v.version}/bytes`, { headers: r.headers });
    if (!bytes.ok) return null;
    // The images extracted from the current version (an older pinned version draws its file's stand-ins).
    const textures = v.version === record.asset?.currentVersion ? record.asset?.textures : undefined;
    return { bytes: new Uint8Array(await bytes.arrayBuffer()), version: v.version, ...(textures !== undefined ? { textures } : {}) };
  };
}

/** Reads a texture asset's current version from the backend and decodes it (a kit sheet's extracted image; null: unavailable). */
export function backendKitTextures(r: KitRoute): VoxelKitTextures {
  // A sheet extracted on import is a KTX2: three's Basis files are served next to the editor's pages.
  setKtx2DecoderBase('./decoders/');
  return async (assetId) => {
    try {
      const rec = await fetch(`${r.api}/content/assets/${encodeURIComponent(assetId)}`, { headers: r.headers });
      if (!rec.ok) return null;
      const version = ((await rec.json()) as { asset?: { currentVersion?: number } }).asset?.currentVersion;
      if (version === undefined) return null;
      const bytes = await fetch(`${r.api}/content/assets/${encodeURIComponent(assetId)}/versions/${version}/bytes`, { headers: r.headers });
      return bytes.ok ? await decodeTexture(await bytes.arrayBuffer()) : null;
    } catch {
      return null;
    }
  };
}

/** A page's kit pieces: the table its streamer derives with, the set its view draws from, and the meshes loading. */
export interface PageKitPieces {
  /** Null: no table (no pieces). */
  readonly table: PieceTable | null;
  readonly set: VoxelKitSet | null;
  readonly meshes: VoxelKitMeshes;
  /** Resolves once every kit mesh has loaded or failed: a line naming those that failed ('' when none). */
  readonly loaded: Promise<string>;
}

/**
 * The project's kits and seed (null: no table at all) with their meshes
 * loading from the backend into `meshes` (a page's own, kept across kit
 * changes: meshes already loaded are not read again, and draws built from
 * the old kits keep theirs).
 */
export function pageKitPieces(r: KitRoute, project: ProjectVoxelKits | null, meshes: VoxelKitMeshes = new VoxelKitMeshes()): PageKitPieces {
  if (project === null) return { table: null, set: null, meshes, loaded: Promise.resolve('') };
  const table = worldPieceTable(project.kits, project.seed);
  const loaded = meshes.load(project.kits, backendKitBytes(r), createGltfLoaderPort(), undefined, backendKitTextures(r)).then((l) => (l.failed.length === 0 ? '' : `kit meshes not drawn: ${l.failed.join('; ')}`));
  return { table, set: meshes.set(table, project.kits), meshes, loaded };
}
