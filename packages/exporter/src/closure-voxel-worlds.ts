/**
 * The voxel worlds an export ships.
 *
 * Every world a scene's `voxelWorld` component names ships its listed
 * region files whole, each as a content-addressed file
 * (`content/sha256/<digest>`), and the build's catalog lists the world
 * (`voxelWorlds`: its manifest fields and every file's name, digest and
 * length), and its far cache's files beside them (the far field's nodes,
 * as built at the world's revision). The exported game reads them through
 * its content reader, never by range (it has no backend). A world a scene names that the project
 * does not hold, or whose listed file is missing, fails the export.
 *
 * The files are found here, not read: the output copies them one at a
 * time and checks each against the digest the backend gave, so a world
 * edited while the export runs fails it instead of shipping mixed files.
 */
import type { ShippedVoxelWorld } from '@thirdlight/project-model';

/** One listed region file of a world, where the backend has it. */
export interface ExportVoxelFile {
  readonly name: string;
  /** Its path on disk. */
  readonly path: string;
  /** SHA-256 of its bytes as the backend last read or wrote them. */
  readonly digest: string;
  readonly byteLength: number;
}

/** A world as the backend holds it now. */
export type ExportVoxelWorldAnswer =
  | {
      readonly ok: true;
      readonly world: Omit<ShippedVoxelWorld, 'files' | 'far'>;
      readonly files: readonly ExportVoxelFile[];
      /** The world's far cache at that revision (`L<level>/<name>` files): shipped beside its region files, for the far field. */
      readonly far?: { readonly minLevel: number; readonly maxLevel: number; readonly files: readonly ExportVoxelFile[] };
    }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** The backend's voxel worlds, for an export (injected; the exporter never opens a world folder itself). */
export interface ExportVoxelWorlds {
  files(projectId: string, world: string): Promise<ExportVoxelWorldAnswer>;
}

/** A region file to copy into the output. */
export interface ShippedVoxelFileCopy {
  /** Its path in the output (`content/sha256/<digest>`). */
  readonly path: string;
  readonly digest: string;
  readonly byteLength: number;
  /** Where it is read from. */
  readonly source: string;
}

/** The world names the scenes' `voxelWorld` components name, sorted, each once. */
export function referencedVoxelWorlds(scenes: readonly unknown[]): string[] {
  const names = new Set<string>();
  for (const sc of scenes) {
    const entities = (sc as { entities?: unknown } | null)?.entities;
    if (!Array.isArray(entities)) continue;
    for (const e of entities) {
      const world = (e as { components?: { voxelWorld?: { world?: unknown } } } | null)?.components?.voxelWorld?.world;
      if (typeof world === 'string') names.add(world);
    }
  }
  return [...names].sort();
}

/**
 * The worlds the scenes name, with their files: the catalog rows and the
 * files to copy (a file two worlds hold byte for byte is copied once).
 */
export async function shipVoxelWorlds(
  port: ExportVoxelWorlds | undefined,
  projectId: string,
  names: readonly string[],
): Promise<{ ok: true; worlds: ShippedVoxelWorld[]; files: ShippedVoxelFileCopy[] } | { ok: false; message: string }> {
  if (names.length === 0) return { ok: true, worlds: [], files: [] };
  if (port === undefined) return { ok: false, message: `the scenes name voxel world ${names[0]!}, and this backend gives the export no voxel worlds` };
  const worlds: ShippedVoxelWorld[] = [];
  const files = new Map<string, ShippedVoxelFileCopy>();
  for (const name of names) {
    const got = await port.files(projectId, name);
    if (!got.ok) return { ok: false, message: `voxel world ${name}: ${got.message} (${got.code})` };
    const row = (f: ExportVoxelFile): { name: string; digest: string; byteLength: number } => ({ name: f.name, digest: f.digest, byteLength: f.byteLength });
    worlds.push({ ...got.world, world: name, files: got.files.map(row), ...(got.far !== undefined ? { far: { minLevel: got.far.minLevel, maxLevel: got.far.maxLevel, files: got.far.files.map(row) } } : {}) });
    for (const f of [...got.files, ...(got.far?.files ?? [])]) if (!files.has(f.digest)) files.set(f.digest, { path: `content/sha256/${f.digest}`, digest: f.digest, byteLength: f.byteLength, source: f.path });
  }
  return { ok: true, worlds, files: [...files.values()].sort((a, b) => (a.path < b.path ? -1 : 1)) };
}
