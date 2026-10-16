/**
 * Decal pages made into KTX2 texture arrays (Play and the export alike; the
 * plan of what goes where is project-model's `planDecalPages`).
 *
 * Per channel set, each page becomes one single-layer UASTC KTX2, then the
 * pages are joined into arrays without touching a texel (`joinUastcLayers`):
 * - a page that is a texture as it is (a trim sheet, a loose decal the page
 *   size) is that texture's file when it can join as stored (UASTC, the
 *   page size, a full mip chain, the set's colour space); nothing is copied
 *   or encoded. A texture that cannot (ETC1S, a PNG, another chain) is
 *   copied onto a page of its own and encoded like a composed one (from its
 *   lossless PNG when there is one, else transcoded: `reencoded`);
 * - a composed page is drawn from its rectangles and encoded once, UASTC in
 *   every set so it joins with the rest (`decal-page-compose.ts`).
 * The composed pages are independent, so they are encoded side by side on
 * the encoder's threads (`TextureEncoder.parallelism`), then joined in page
 * order.
 * Each composed page and each array is cached in the project's import cache
 * by what it is made of (the sources' digests, their lossless originals,
 * the layout, the encoder), so the next Play, the export and a restart find
 * it, and adding one decal encodes only the page it lands on.
 *
 * A set is split into several arrays when one would hold more than a join
 * takes (`KTX2_JOIN_LEVEL_BYTES_MAX`, `MAX_TEXTURE_LAYERS`): there is no cap
 * on pages.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { DecalPageChannel, DecalPageLayer, DecalPageSet } from '@thirdlight/project-model';
import { DECAL_PAGE_ENCODINGS, DECAL_PAGE_SETS, MAX_TEXTURE_LAYERS } from '@thirdlight/project-model/limits';
import type { BlobFile, ImportKey, WorkspaceService } from '@thirdlight/workspace';

import type { ComposeChannel, ComposeLayer } from './decal-page-compose';
import { joinUastcLayers, KTX2_JOIN_LEVEL_BYTES_MAX, KTX2_TRANSFER_LINEAR, KTX2_TRANSFER_SRGB, readKtx2 } from './ktx2-container';
import { decalPreviewSide, KTX2_ENCODER, type TextureEncoder } from './texture-encode';
import { losslessOriginal, textureVersionsOf } from './texture-originals';

/** A texture a page reads: its version and file digest (the build's captured content). */
export interface DecalPageSource {
  readonly assetId: string;
  readonly version: number;
  readonly sourceDigest: string;
}

export interface DecalPageRequest {
  /** The page side. */
  readonly size: number;
  /** Per set, its pages in order (project-model `DecalPagePlan.sets`). */
  readonly sets: Readonly<Record<DecalPageSet, readonly { readonly layer: DecalPageLayer }[]>>;
  /** Every texture the layers name. */
  readonly sources: ReadonlyMap<string, DecalPageSource>;
}

/**
 * One array of a set: its file and how many pages it holds (the set's pages
 * in order, array after array); a preview's array is its bytes, never stored.
 */
export type DecalPageArray = { readonly file: BlobFile; readonly layers: number } | { readonly preview: Uint8Array; readonly digest: string; readonly layers: number };

export type DecalPageResult =
  | {
      ok: true;
      sets: Record<DecalPageSet, DecalPageArray[]>;
      /** Pages taken as stored, composed now, found composed in the cache. */
      stats: { asStored: number; composed: number; cached: number };
      /** The textures read from transcoded texels (a second lossy generation). */
      reencoded: string[];
      ms: number;
      /** The pages at a preview size (`preview` asked and some page not made yet): the arrays are bytes, never stored. */
      preview?: true;
    }
  | { ok: false; code: string; message: string };

type DecalPageFailure = Extract<DecalPageResult, { ok: false }>;

/**
 * Composes kept in flight per encoder thread: one running, one waiting at
 * the pool so a thread never idles while its last page is stored; more
 * would only hold more source copies in memory.
 */
const DECAL_COMPOSES_PER_THREAD = 2;

/** Run `work` over `items`, at most `limit` at once; the first failure stops new work and is the answer. */
async function inFlight<T>(items: readonly T[], limit: number, work: (item: T) => Promise<DecalPageFailure | null>): Promise<DecalPageFailure | null> {
  let next = 0;
  let failure: DecalPageFailure | null = null;
  const lane = async (): Promise<void> => {
    while (failure === null && next < items.length) {
      const r = await work(items[next++]!);
      failure ??= r;
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return failure;
}

/** The import cache's importer of decal pages and arrays (a change to how they are made changes the version). */
export const DECAL_PAGE_IMPORTER = 'decal-pages';
export const DECAL_PAGE_IMPORTER_VERSION = '1';

const sha256 = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');
const keyOf = (settings: Record<string, unknown>): ImportKey => ({ sourceDigest: sha256(JSON.stringify(settings)), importer: DECAL_PAGE_IMPORTER, importerVersion: DECAL_PAGE_IMPORTER_VERSION, settings });

/** The pages of one array at most: what a join holds at the page size, and the arrays' layer limit. */
export function decalPagesPerArray(size: number): number {
  const level0 = Math.ceil(size / 4) * Math.ceil(size / 4) * 16;
  return Math.max(1, Math.min(MAX_TEXTURE_LAYERS, Math.floor(KTX2_JOIN_LEVEL_BYTES_MAX / level0)));
}

/** Whether a texture's file can be a page of a set as it is (it joins as stored). */
function joinsAsStored(bytes: Uint8Array, size: number, transfer: number): boolean {
  const c = readKtx2(bytes);
  if (c === null || c.width !== size || c.height !== size || c.layerCount > 1 || c.faceCount !== 1 || c.mipsAtLoad) return false;
  if (c.levels.length !== Math.floor(Math.log2(size)) + 1 || c.transfer !== transfer) return false;
  return joinUastcLayers([bytes], transfer).ok;
}

/**
 * `options.preview`: when any page is still to be composed, every page is
 * composed at a preview size instead (`decalPreviewSide`, the fastest
 * effort, ahead of the other encodes) and the arrays are answered as bytes:
 * nothing of a preview is stored, so the cache only ever holds the pages
 * themselves. With every page made already the answer is the pages.
 */
export function createDecalPageAssembler(deps: { service: WorkspaceService; encoder: TextureEncoder | undefined; now: () => number }): { assemble(projectId: string, request: DecalPageRequest, options?: { readonly preview?: boolean }): Promise<DecalPageResult>; readonly stats: { composed: number; cached: number; arrays: number; previews: number } } {
  const stats = { composed: 0, cached: 0, arrays: 0, previews: 0 };
  /** The pages being composed, by project and cache key: a second assembly needing one (the export beside the atlas) waits for it. */
  const composing = new Map<string, Promise<Uint8Array | DecalPageFailure>>();
  const store = (projectId: string, key: ImportKey, bytes: Uint8Array): BlobFile | string => {
    const w = deps.service.writeImportedArtifact(projectId, key, bytes);
    if (!w.ok) return w.error.message;
    const f = deps.service.locateImportedArtifact(projectId, key);
    return f !== null && f.digest === w.digest ? f : 'a decal page is not in the import cache after it was written';
  };
  const readFile = (f: BlobFile): Uint8Array | null => {
    try {
      const b = new Uint8Array(readFileSync(f.real));
      return sha256(b) === f.digest ? b : null;
    } catch {
      return null;
    }
  };

  return {
    stats,
    async assemble(projectId, request, options) {
      const t0 = deps.now();
      const preview = options?.preview === true;
      const encoder = deps.encoder;
      const size = request.size;
      // Each source read once, with its lossless original (read in its place when it has to be encoded).
      const read = new Map<string, { bytes: Uint8Array; lossless: Uint8Array | null; original: string | null }>();
      let versions: ReturnType<typeof textureVersionsOf> | null = null;
      const source = (id: string): { bytes: Uint8Array; lossless: Uint8Array | null; original: string | null } | string => {
        const known = read.get(id);
        if (known !== undefined) return known;
        const s = request.sources.get(id);
        if (s === undefined) return `decal texture "${id}" is not in the build`;
        const r = deps.service.readBlob(projectId, { assetId: s.assetId, version: s.version });
        if (!r.ok) return `decal texture "${id}": ${r.error.message}`;
        if (r.digest !== s.sourceDigest) return `decal texture "${id}" changed while the pages were made`;
        const head = readKtx2(r.bytes);
        let original: { bytes: Uint8Array; digest: string } | null = null;
        if (head !== null) {
          versions ??= textureVersionsOf(deps.service, projectId);
          const v = versions.get(s.assetId);
          if (v !== undefined && v.version === s.version) original = losslessOriginal(deps.service, projectId, v, r.bytes, head.width, head.height);
        }
        const out = { bytes: r.bytes, lossless: original?.bytes ?? null, original: original?.digest ?? null };
        read.set(id, out);
        return out;
      };
      const made = { asStored: 0, composed: 0, cached: 0 };
      const reencoded = new Set<string>();
      const sets = {} as Record<DecalPageSet, DecalPageArray[]>;
      // Every page of every set first: each is a texture as stored, found
      // in the cache, or a compose to run; the composes then run side by side
      // on the encoder's threads (pages are independent), in page order.
      const pagesOf = new Map<DecalPageSet, (Uint8Array | null)[]>();
      const composes: { set: DecalPageSet; at: number; run: () => Promise<Uint8Array | DecalPageFailure> }[] = [];
      /** Every page as a compose (a preview composes them all small, as stored or cached ones too). */
      const all: { set: DecalPageSet; at: number; preview: () => Promise<Uint8Array | DecalPageFailure> }[] = [];
      for (const set of DECAL_PAGE_SETS) {
        const mode = DECAL_PAGE_ENCODINGS[set];
        const transfer = mode === 'color' ? KTX2_TRANSFER_SRGB : KTX2_TRANSFER_LINEAR;
        const pages: (Uint8Array | null)[] = [];
        pagesOf.set(set, pages);
        for (const { layer } of request.sets[set]) {
          // The page as composed (a texture that cannot join as stored is copied whole onto one; a preview composes every page).
          const composed: DecalPageLayer = 'whole' in layer ? { fill: [0, 0, 0, 0], place: [{ channels: [0, 1, 2, 3].map((channel) => ({ texture: layer.whole, channel })) as unknown as [DecalPageChannel, DecalPageChannel, DecalPageChannel, DecalPageChannel], src: [0, 0, 1, 1], dst: [0, 0, size, size], pad: [0, 0, size, size] }] } : layer;
          const ids: string[] = [];
          const indexOf = (id: string): number => {
            const i = ids.indexOf(id);
            if (i >= 0) return i;
            ids.push(id);
            return ids.length - 1;
          };
          const place = (composed as Extract<DecalPageLayer, { place: unknown }>).place.map((p) => ({
            ...p,
            channels: p.channels.map((c): ComposeChannel => ('texture' in c ? { source: indexOf(c.texture), channel: c.channel } : { value: c.value })) as unknown as ComposeLayer['place'][number]['channels'],
          }));
          const resolved: { bytes: Uint8Array; lossless: Uint8Array | null; original: string | null }[] = [];
          for (const id of ids) {
            const s = source(id);
            if (typeof s === 'string') return { ok: false, code: 'asset_missing', message: s };
            resolved.push(s);
          }
          const spec: ComposeLayer = { fill: (composed as Extract<DecalPageLayer, { fill: unknown }>).fill, place };
          const at = pages.length;
          all.push({
            set,
            at,
            preview: async () => {
              if (encoder === undefined) return { ok: false, code: 'converter_unavailable', message: 'KTX2 encoding is not available on this server (decal pages)' };
              const r = await encoder.compose(resolved.map((s) => s.bytes), spec, size, mode, resolved.map((s) => s.lossless), 'preview');
              return r.ok ? r.ktx2 : { ok: false, code: 'conversion_failed', message: `a ${set} decal page's preview: ${r.message}` };
            },
          });
          if ('whole' in layer && joinsAsStored(resolved[0]!.bytes, size, transfer)) {
            pages.push(resolved[0]!.bytes);
            made.asStored += 1;
            continue;
          }
          const key = keyOf({ page: spec, size, mode, sources: ids.map((id) => request.sources.get(id)!.sourceDigest), originals: resolved.map((s) => s.original ?? 'none'), encoder: `${KTX2_ENCODER.name}@${KTX2_ENCODER.version}` });
          const found = deps.service.locateImportedArtifact(projectId, key);
          const bytes = found !== null ? readFile(found) : null;
          if (bytes !== null) {
            pages.push(bytes);
            made.cached += 1;
            stats.cached += 1;
            continue;
          }
          if (encoder === undefined) return { ok: false, code: 'converter_unavailable', message: 'KTX2 encoding is not available on this server (decal pages)' };
          const id = `${projectId}\u0000${key.sourceDigest}`;
          composes.push({
            set,
            at,
            run: async () => {
              const busy = composing.get(id);
              if (busy !== undefined) return busy;
              const run = (async (): Promise<Uint8Array | DecalPageFailure> => {
                const r = await encoder.compose(resolved.map((s) => s.bytes), spec, size, mode, resolved.map((s) => s.lossless));
                if (!r.ok) return { ok: false, code: 'conversion_failed', message: `a ${set} decal page: ${r.message}` };
                if (r.reencoded) for (let i = 0; i < ids.length; i++) if (resolved[i]!.lossless === null && readKtx2(resolved[i]!.bytes) !== null) reencoded.add(ids[i]!);
                const f = store(projectId, key, r.ktx2);
                if (typeof f === 'string') return { ok: false, code: 'internal', message: f };
                made.composed += 1;
                stats.composed += 1;
                return r.ktx2;
              })().finally(() => composing.delete(id));
              composing.set(id, run);
              return run;
            },
          });
          pages.push(null);
        }
      }
      // A preview while some page is still to be made: every page small, the arrays joined in memory.
      if (preview && composes.length > 0) {
        const small = new Map<DecalPageSet, Uint8Array[]>(DECAL_PAGE_SETS.map((x) => [x, []]));
        const failed = await inFlight(all, DECAL_COMPOSES_PER_THREAD * Math.max(1, encoder?.parallelism ?? 1), async (c) => {
          const r = await c.preview();
          if (!(r instanceof Uint8Array)) return r;
          small.get(c.set)![c.at] = r;
          return null;
        });
        if (failed !== null) return failed;
        const per = decalPagesPerArray(decalPreviewSide(size));
        for (const set of DECAL_PAGE_SETS) {
          const transfer = DECAL_PAGE_ENCODINGS[set] === 'color' ? KTX2_TRANSFER_SRGB : KTX2_TRANSFER_LINEAR;
          const list = small.get(set)!;
          const arrays: DecalPageArray[] = [];
          for (let at = 0; at < list.length; at += per) {
            const joined = joinUastcLayers(list.slice(at, at + per), transfer);
            if (!joined.ok) return { ok: false, code: 'conversion_failed', message: `the ${set} decal page previews ${at + 1}-${Math.min(list.length, at + per)} do not join: ${joined.reason}` };
            arrays.push({ preview: joined.ktx2, digest: sha256(joined.ktx2), layers: Math.min(per, list.length - at) });
          }
          sets[set] = arrays;
        }
        stats.previews += 1;
        return { ok: true, sets, stats: { asStored: 0, composed: 0, cached: 0 }, reencoded: [], ms: Math.round(deps.now() - t0), preview: true };
      }
      const failure = await inFlight(composes, DECAL_COMPOSES_PER_THREAD * Math.max(1, encoder?.parallelism ?? 1), async (c) => {
        const r = await c.run();
        if (!(r instanceof Uint8Array)) return r;
        pagesOf.get(c.set)![c.at] = r;
        return null;
      });
      if (failure !== null) return failure;
      for (const set of DECAL_PAGE_SETS) {
        const transfer = DECAL_PAGE_ENCODINGS[set] === 'color' ? KTX2_TRANSFER_SRGB : KTX2_TRANSFER_LINEAR;
        const pages = pagesOf.get(set)! as Uint8Array[];
        const digests = pages.map((b) => sha256(b));
        // Arrays of at most what a join takes, each cached by its pages' digests.
        const per = decalPagesPerArray(size);
        const arrays: DecalPageArray[] = [];
        for (let at = 0; at < pages.length; at += per) {
          const part = pages.slice(at, at + per);
          const key = keyOf({ array: digests.slice(at, at + per), transfer });
          let file = deps.service.locateImportedArtifact(projectId, key);
          if (file === null) {
            const joined = joinUastcLayers(part, transfer);
            if (!joined.ok) return { ok: false, code: 'conversion_failed', message: `the ${set} decal pages ${at + 1}-${at + part.length} do not join: ${joined.reason}` };
            const f = store(projectId, key, joined.ktx2);
            if (typeof f === 'string') return { ok: false, code: 'internal', message: f };
            file = f;
            stats.arrays += 1;
          }
          arrays.push({ file, layers: part.length });
        }
        sets[set] = arrays;
      }
      return { ok: true, sets, stats: made, reencoded: [...reencoded].sort(), ms: Math.round(deps.now() - t0) };
    },
  };
}
