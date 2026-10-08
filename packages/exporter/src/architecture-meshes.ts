/**
 * Generated architecture in a build. By default a build ships the
 * `architecture` component's parameters as they are and the game generates
 * the meshes at load. A project that sets `architecture_ship_meshes` gets
 * the meshes too: every chunk made here by the same generator (with the row
 * tables of the trim materials the object wears), in one blob per object
 * (`TLAR`, `content/sha256/<digest>`, listed in `manifest.buffers`), named by
 * the component as `baked`; the game draws them instead of generating.
 *
 * The blob carries no generator problems (those are the editor's to show).
 */
import { architectureSheets, encodeArchitectureChunks, generateArchitecture, trimSheetOfMaterial, type ArchitectureComponent, type MaterialDef } from '@thirdlight/project-model';

import type { BlockDataBlob } from './block-chunk-data';

/** Packs documents' generated architecture when the project ships its meshes (else documents pass unchanged). */
export function architectureMeshPacker(ship: boolean, materials: () => readonly MaterialDef[] | undefined, hash: (bytes: Uint8Array) => string): { pack(doc: unknown): unknown; blobs(): BlockDataBlob[] } {
  const blobs = new Map<string, Uint8Array>();
  const bakedOf = (c: ArchitectureComponent, mapping: Readonly<Record<string, string>> | undefined): string => {
    const defs = materials() ?? [];
    const sheets = architectureSheets(c, mapping, (id) => trimSheetOfMaterial(defs, id));
    const chunks = generateArchitecture(c, sheets).map((k) => ({ ...k, problems: [] }));
    const bytes = encodeArchitectureChunks(chunks);
    const digest = hash(bytes);
    blobs.set(digest, bytes);
    return digest;
  };
  return {
    pack(doc: unknown): unknown {
      if (!ship) return doc;
      const d = doc as { entities?: unknown } | null;
      if (d === null || typeof d !== 'object' || !Array.isArray(d.entities)) return doc;
      let changed = false;
      const entities = d.entities.map((e: unknown) => {
        const comps = (e as { components?: Record<string, unknown> } | null)?.components;
        const c = comps?.['architecture'] as ArchitectureComponent | undefined;
        if (c === undefined || !Array.isArray(c.elements)) return e;
        changed = true;
        const baked = bakedOf(c, comps?.['materials'] as Record<string, string> | undefined);
        return { ...(e as object), components: { ...comps, architecture: { ...c, baked } } };
      });
      return changed ? { ...d, entities } : doc;
    },
    blobs: () => [...blobs].map(([digest, bytes]) => ({ digest, bytes })),
  };
}
