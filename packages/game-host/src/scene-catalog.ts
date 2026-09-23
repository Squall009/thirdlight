/**
 * Phase 12 (c): the page side of additive scenes, shared by the editor's Play
 * page and the exported game. A v4 build ships every scene as
 * `scenes/<sceneId>.json` (listed in `manifest.scenes` with its digest) and
 * every instance-set buffer as `content/sha256/<digest>` (`manifest.buffers`).
 *
 * - `prepareSceneCatalog` reads the start scenes once (their entity ids become
 *   the snapshot's scene membership) and returns the loader the host calls
 *   when the game asks for another scene;
 * - `bufferResolver` reads and verifies instance-set buffers on demand.
 *
 * Every read is re-hashed against the manifest before it is used. The page
 * owns the fetch (`read`); nothing here reaches the network by itself.
 */
import { sceneEntitiesFromDocument, type LoadedSceneBatch, type RuntimeSceneRow } from '@thirdlight/runtime';

/** One `manifest.scenes` row. */
export interface ManifestSceneRow {
  readonly sceneId: string;
  readonly path: string;
  readonly digest: string;
  readonly byteLength: number;
  readonly start: boolean;
}

/** One `manifest.buffers` row. */
export interface ManifestBufferRow {
  readonly digest: string;
  readonly byteLength: number;
}

export interface SceneCatalogIo {
  /** Read one manifest-declared relative path. */
  readonly read: (path: string) => Promise<ArrayBuffer>;
  readonly sha256Hex: (bytes: Uint8Array) => Promise<string>;
}

async function readVerified(io: SceneCatalogIo, path: string, digest: string, byteLength: number): Promise<ArrayBuffer> {
  const buf = await io.read(path);
  if (buf.byteLength !== byteLength) throw new Error(`${path}: ${buf.byteLength} bytes, the manifest says ${byteLength}`);
  if ((await io.sha256Hex(new Uint8Array(buf))) !== digest) throw new Error(`${path}: the digest does not match the manifest`);
  return buf;
}

/**
 * The snapshot's scene rows (start scenes with their members) and the
 * scene loader for `GameHostConfig.loadScene`.
 */
export async function prepareSceneCatalog(
  rows: readonly ManifestSceneRow[],
  io: SceneCatalogIo,
): Promise<{ rows: RuntimeSceneRow[]; loadScene: (sceneId: string) => Promise<LoadedSceneBatch['entities']> }> {
  const out: RuntimeSceneRow[] = [];
  for (const row of rows) {
    if (!row.start) {
      out.push({ sceneId: row.sceneId, start: false });
      continue;
    }
    const doc = JSON.parse(new TextDecoder().decode(await readVerified(io, row.path, row.digest, row.byteLength))) as { entities?: { id?: unknown }[] };
    const entityIds = (doc.entities ?? []).map((e) => e.id).filter((id): id is string => typeof id === 'string');
    out.push({ sceneId: row.sceneId, start: true, entityIds });
  }
  const bySceneId = new Map(rows.map((r) => [r.sceneId, r]));
  const loadScene = async (sceneId: string): Promise<LoadedSceneBatch['entities']> => {
    const row = bySceneId.get(sceneId);
    if (row === undefined) throw new Error(`scene "${sceneId}" is not part of this build`);
    const doc: unknown = JSON.parse(new TextDecoder().decode(await readVerified(io, row.path, row.digest, row.byteLength)));
    const res = sceneEntitiesFromDocument(doc, sceneId);
    if (!res.ok) throw new Error(res.message);
    return res.entities;
  };
  return { rows: out, loadScene };
}

/** The instance-set buffer resolver for the adapter's `models.resolveBuffer`. */
export function bufferResolver(rows: readonly ManifestBufferRow[], io: SceneCatalogIo): (digest: string) => Promise<ArrayBuffer> {
  const byDigest = new Map(rows.map((r) => [r.digest, r]));
  return (digest: string) => {
    const row = byDigest.get(digest);
    if (row === undefined) return Promise.reject(new Error(`instance buffer ${digest.slice(0, 12)}… is not part of this build`));
    return readVerified(io, `content/sha256/${digest}`, digest, row.byteLength);
  };
}
