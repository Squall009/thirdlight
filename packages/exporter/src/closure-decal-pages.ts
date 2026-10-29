/**
 * Decal pages in a build (Play and the export alike).
 *
 * The used decal materials' images go onto decal pages (project-model
 * `decal-pages.ts` plans the rectangles), and the pages ship as texture
 * arrays the backend makes, each page's channel sets side by side in one
 * (injected: `ClosureDecalPages`, cached in the import cache). The arrays ship under ids of their own made from
 * their files' digests (`decals-…`), so the same pages give the same ids
 * build after build; each decal material reaches the runtime with its place
 * on them (`decalPage`: the rectangle, its mip cap, each set's array and
 * layer). A placed decal material reaches the runtime without its own
 * textures or sheet cell: it draws from the pages, so no scene's
 * dependencies name those files for it and the game never loads them.
 */
import type { WorkspaceService, BlobFile } from '@thirdlight/workspace';
import { DECAL_PAGE_SETS, decalPageRefs, decalPageReport, heightAlphaTextures, planDecalPages, type DecalPageReport, type DecalPageLayer, type DecalPageLayerRef, type DecalPageRef, type DecalPageSet, type DecalPageSheet, type ManifestAssetInputV2, type MaterialDef } from '@thirdlight/project-model';

import type { ClosureArtifact, ClosureFileArtifact, ContentClosureError } from './content-closure';
import { readWhole } from './closure-texture-slots';

/**
 * The backend's decal page arrays (project-model `decalPageArrays`: each page's sets side by side in one array)
 * and where each set's i-th page went.
 */
export interface ClosureDecalPages {
  decalPages?(
    projectId: string,
    request: {
      readonly size: number;
      readonly sets: Readonly<Record<DecalPageSet, readonly { readonly page: number; readonly layer: DecalPageLayer }[]>>;
      readonly sources: ReadonlyMap<string, { readonly assetId: string; readonly version: number; readonly sourceDigest: string }>;
    },
  ): Promise<{ ok: true; arrays: ClosureDecalPageArray[]; at: Record<DecalPageSet, readonly { readonly array: number; readonly layer: number }[]>; ms: number; preview?: true } | { ok: false; code: string; message: string }>;
}

/**
 * One array of pages: its file in the import cache, or a preview's
 * bytes (pages at a reduced size, never stored), which only the editor's
 * decal atlas asks for and a build refuses.
 */
export type ClosureDecalPageArray = { readonly file: BlobFile; readonly layers: number } | { readonly preview: Uint8Array; readonly digest: string; readonly layers: number };

/** The id prefix of a decal page array (then its file digest's first 57 hex digits: 64 characters, the id syntax's most). */
export const DECAL_PAGE_ID_PREFIX = 'decals-';

/** What the build ships for the decal pages, and each decal material's place on them. */
export interface ClosureDecalPageArrays {
  readonly refs: ReadonlyMap<string, DecalPageRef>;
  readonly rows: readonly ManifestAssetInputV2[];
  readonly files: readonly ClosureFileArtifact[];
  readonly artifacts: readonly ClosureArtifact[];
  /** Page side, page count and arrays (the build's report). */
  readonly size: number;
  readonly pages: number;
  readonly notes: readonly string[];
}

export interface AssetRecordLike {
  readonly assetId: string;
  readonly kind?: string;
  readonly currentVersion?: number;
  readonly versions?: readonly { readonly version: number; readonly sourceDigest: string; readonly metrics?: unknown }[];
}

const refused = (message: string, reason = 'decal_pages'): { ok: false; error: ContentClosureError } => ({ ok: false, error: { code: 'export_scene_invalid', cls: 'validation', reason, message: message.slice(0, 256) } });

/** Whether the used materials (resolved) have a decal material to place. */
export function hasDecalMaterials(materials: readonly MaterialDef[]): boolean {
  return materials.some((m) => m.shader === 'decal');
}

/** A texture asset's current version (undefined: not a texture of the project). */
function currentTexture(byId: ReadonlyMap<string, AssetRecordLike>, id: string): { version: number; sourceDigest: string; metrics?: unknown } | undefined {
  const a = byId.get(id);
  return a?.kind === 'texture' ? a.versions?.find((v) => v.version === a.currentVersion) : undefined;
}

/**
 * What the build plans the decal pages from (project-model `planDecalPages`): the shipped materials,
 * their trim sheets by id and each texture's size from its current version's metrics. The editor's
 * decal atlas reads the same, so its pages are the build's.
 */
export function decalPageInput(assets: readonly AssetRecordLike[], materials: readonly MaterialDef[]): { materials: readonly MaterialDef[]; sheets: ReadonlyMap<string, DecalPageSheet>; sizeOf: (textureId: string) => readonly [number, number] | null } {
  const byId = new Map(assets.map((a) => [a.assetId, a]));
  const sheets = new Map<string, DecalPageSheet>();
  // A sheet a layered surface reads as a layer carries a height in its albedo's A, which its cells must not take as opacity.
  const heights = heightAlphaTextures(materials);
  for (const m of materials) if (m.shader === 'trim' && m.trim !== undefined) sheets.set(m.materialId, { trim: m.trim, textures: m.textures, ...(m.textures['map'] !== undefined && heights.has(m.textures['map']) ? { alphaIsHeight: true } : {}) });
  return {
    materials,
    sheets,
    sizeOf: (id) => {
      const m = currentTexture(byId, id)?.metrics as { width?: unknown; height?: unknown } | undefined;
      return typeof m?.width === 'number' && typeof m.height === 'number' ? [m.width, m.height] : null;
    },
  };
}

/** The report of the decal pages a build of these shipped materials plans (project-model `decalPageReport`). */
export function decalPageReportOf(assets: readonly AssetRecordLike[], materials: readonly MaterialDef[]): DecalPageReport {
  const input = decalPageInput(assets, materials);
  return decalPageReport(input.materials, input.sheets, input.sizeOf);
}

/** Plan the used decal materials' pages and have the backend make (or find cached) their arrays. */
export async function closureDecalPages(o: {
  readonly port: ClosureDecalPages | undefined;
  readonly service: WorkspaceService;
  readonly projectId: string;
  readonly assets: readonly AssetRecordLike[];
  readonly materials: readonly MaterialDef[];
  readonly locate: boolean;
  readonly hash: (bytes: Uint8Array) => string;
  /** The editor's decal atlas takes preview arrays (as artifacts); a build never does. */
  readonly previews?: boolean;
}): Promise<{ ok: true; pages: ClosureDecalPageArrays } | { ok: false; error: ContentClosureError }> {
  const byId = new Map(o.assets.map((a) => [a.assetId, a]));
  const current = (id: string): { version: number; sourceDigest: string; metrics?: unknown } | undefined => currentTexture(byId, id);
  const input = decalPageInput(o.assets, o.materials);
  const plan = planDecalPages(input.materials, input.sheets, input.sizeOf);
  const empty = { refs: new Map<string, DecalPageRef>(), rows: [], files: [], artifacts: [], size: plan.size, pages: 0, notes: plan.notes };
  if (plan.pages === 0) return { ok: true, pages: empty };
  if (o.port?.decalPages === undefined) return refused('a used decal material has images to place on decal pages, and this build has no texture assembly');
  const sources = new Map<string, { assetId: string; version: number; sourceDigest: string }>();
  for (const s of DECAL_PAGE_SETS) {
    for (const { layer } of plan.sets[s]) {
      const ids = 'whole' in layer ? [layer.whole] : layer.place.flatMap((p) => p.channels.flatMap((c) => ('texture' in c ? [c.texture] : [])));
      for (const id of ids) {
        const v = current(id);
        if (v === undefined) return refused(`decal texture "${id}" is not a texture of the project`);
        sources.set(id, { assetId: id, version: v.version, sourceDigest: v.sourceDigest });
      }
    }
  }
  const made = await o.port.decalPages(o.projectId, { size: plan.size, sets: plan.sets, sources });
  if (!made.ok) return refused(`decal pages: ${made.message}`, made.code);
  const rows: ManifestAssetInputV2[] = [];
  const files: ClosureFileArtifact[] = [];
  const artifacts: ClosureArtifact[] = [];
  const shipped = new Set<string>();
  // Each array shipped once, under an id of its own.
  const ids: string[] = [];
  for (const arr of made.arrays) {
    if ('preview' in arr && o.previews !== true) return refused('decal pages: the assembly answered preview pages, which a build never ships');
    const digest = 'preview' in arr ? arr.digest : arr.file.digest;
    const id = `${DECAL_PAGE_ID_PREFIX}${digest.slice(0, 57)}`;
    if (byId.has(id)) return refused(`the decal page array's id ${id} is an asset of the project`);
    ids.push(id);
    if (shipped.has(id)) continue;
    shipped.add(id);
    const path = `content/sha256/${digest}`;
    if ('preview' in arr) {
      artifacts.push({ path, bytes: arr.preview, digest, contentType: 'image/x-texture' });
      rows.push({ assetId: id, kind: 'texture', version: 1, sourceDigest: digest, sourceByteLength: arr.preview.byteLength, metricsDigest: o.hash(new TextEncoder().encode(JSON.stringify({ decalPages: 'array', digest }))) });
      continue;
    }
    const f = arr.file;
    if (o.locate) files.push({ path, digest: f.digest, byteLength: f.byteLength, contentType: 'image/x-texture', file: f });
    else {
      const bytes = await readWhole(o.service, o.projectId, f);
      if (typeof bytes === 'string') return { ok: false, error: { code: 'asset_digest_mismatch', cls: 'unavailable', reason: 'asset_digest_mismatch', message: bytes } };
      artifacts.push({ path, bytes, digest: f.digest, contentType: 'image/x-texture' });
    }
    rows.push({ assetId: id, kind: 'texture', version: 1, sourceDigest: f.digest, sourceByteLength: f.byteLength, metricsDigest: o.hash(new TextEncoder().encode(JSON.stringify({ decalPages: 'array', digest: f.digest }))) });
  }
  // Each set's layer i: the array holding it and its layer there.
  const layerAt = new Map<DecalPageSet, DecalPageLayerRef[]>(DECAL_PAGE_SETS.map((s) => [s, made.at[s].map((a) => ({ texture: ids[a.array]!, layer: a.layer }))]));
  const refs = decalPageRefs(plan, (s, i) => layerAt.get(s)![i]!);
  return { ok: true, pages: { refs, rows, files, artifacts, size: plan.size, pages: plan.pages, notes: plan.notes } };
}

/**
 * The materials with each decal material's place on the pages (`decalPage`); others as they are. A placed
 * decal material draws from the pages only, so its own textures and its sheet cell are left out of the
 * runtime material (nothing loads them for it).
 */
export function withDecalPages(materials: readonly MaterialDef[], refs: ReadonlyMap<string, DecalPageRef>): MaterialDef[] {
  if (refs.size === 0) return [...materials];
  return materials.map((m) => {
    const ref = refs.get(m.materialId);
    if (ref === undefined) return m;
    const { decal: _cell, ...rest } = m;
    return { ...rest, textures: {}, decalPage: ref };
  });
}
