/**
 * Height in alpha: an albedo a layered surface blends by height carries its
 * height in A (linear), and the blend between layers follows it. A texture
 * whose A is missing or flat would let a constant decide every blend (soft,
 * even edges), so:
 *
 * - the backend checks the A of every texture in such a slot (the arrays
 *   `heightSlotKeys` names: never a cut-out, transparent or decal material's,
 *   whose A is opacity) when the project loads and after a change that can
 *   put one there (a material set, a texture published or re-imported). A
 *   texture found without height is a problem in the project's problems
 *   ("… no height in alpha — blends between layers will be soft"), logged
 *   when it appears; the editor's layer palette asks the route for its badge;
 * - the array assembly (`texture-slots.ts`) gives such a layer a height made
 *   from its brightness (`brightnessHeight`), once, when the array is made —
 *   Play, the export and the views all draw that array, so they agree, and
 *   no shader works it out per pixel. A texture with a real height replaces
 *   it the next time the array is assembled (its digest is in the key).
 *
 * The check reads what a layer is encoded from: a KTX2's lossless PNG where
 * one is proven (`losslessOriginal`), else the KTX2's top level transcoded.
 * Results are kept per file digest in memory and as a marker in the
 * project's import cache, so a restart does not decode them again.
 *
 * The same decode gives the texture's mean colour (`texture-mean.ts`), kept
 * the same way: a view draws a layer in it while the layer's array encodes.
 */
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { MaterialDef } from '@thirdlight/project-model';
import { ID_RE, MAX_TEXTURE_LAYERS } from '@thirdlight/project-model/limits';
import { heightSlotKeys, isTextureSlots } from '@thirdlight/project-model/texture-slots';
import { sessionError, type SessionError } from '@thirdlight/protocol';
import type { ImportKey, WorkspaceService } from '@thirdlight/workspace';

import { FLAT_ALPHA_SPREAD, heightAlphaOf, type HeightAlpha } from './height-pixels';
import { readKtx2 } from './ktx2-container';
import { KTX2_SOURCE_PIXELS_MAX, type TextureEncoder } from './texture-encode';
import { meanOfRgba, type TextureMean } from './texture-mean';
import { losslessOriginal, textureVersionsOf } from './texture-originals';

/** The import cache's marker of a checked file (found = this is its result). */
const MARKER_IMPORTER = 'height-alpha';
// Raised whenever the rule in `heightAlphaOf` changes, so files checked under the old one are checked again.
const MARKER_VERSION = '2';
const markerKey = (digest: string, result: HeightAlpha): ImportKey => ({ sourceDigest: digest, importer: MARKER_IMPORTER, importerVersion: MARKER_VERSION, settings: { result, flatSpread: FLAT_ALPHA_SPREAD } });
/** The import cache's record of a file's mean colour (its 8 bytes: `srgb` then `plain`). */
const MEAN_IMPORTER = 'texture-mean';
const MEAN_VERSION = '1';
const meanKey = (digest: string): ImportKey => ({ sourceDigest: digest, importer: MEAN_IMPORTER, importerVersion: MEAN_VERSION, settings: {} });
/** Results kept in memory (one per file digest; the oldest go first). */
const RESULTS_MAX = 4096;

export interface HeightAlphaChecks {
  /**
   * A texture file's alpha (`digest` its sha-256; `bytes` it, `lossless` its
   * proven PNG or null), from memory, the import cache, or decoded now. Null:
   * it cannot be decoded (the assembly says why on its own).
   */
  ofFile(projectId: string, digest: string, bytes: Uint8Array, lossless: Uint8Array | null): Promise<HeightAlpha | null>;
  /** A texture asset's current version's alpha (null: no such texture, an array, or unreadable). */
  ofTexture(projectId: string, assetId: string): Promise<HeightAlpha | null>;
  /** A texture file's mean colour, as `ofFile` finds its alpha (null: it cannot be decoded). */
  meanOfFile(projectId: string, digest: string, bytes: Uint8Array, lossless: Uint8Array | null): Promise<TextureMean | null>;
}

export function createHeightAlphaChecks(deps: { service: WorkspaceService; encoder: TextureEncoder | undefined }): HeightAlphaChecks {
  const results = new Map<string, HeightAlpha>();
  const means = new Map<string, TextureMean>();
  const running = new Map<string, Promise<{ alpha: HeightAlpha; mean: TextureMean } | null>>();
  const remember = <T>(map: Map<string, T>, digest: string, r: T): void => {
    if (map.size >= RESULTS_MAX) map.delete(map.keys().next().value as string);
    map.set(digest, r);
  };
  /** One decode for both facts (a second asker while it runs shares it). */
  const decodeFacts = (projectId: string, digest: string, bytes: Uint8Array, lossless: Uint8Array | null): Promise<{ alpha: HeightAlpha; mean: TextureMean } | null> => {
    const busy = running.get(digest);
    if (busy !== undefined) return busy;
    const encoder = deps.encoder;
    if (encoder === undefined) return Promise.resolve(null);
    const run = (async (): Promise<{ alpha: HeightAlpha; mean: TextureMean } | null> => {
      const decoded = await encoder.decode(lossless ?? bytes, KTX2_SOURCE_PIXELS_MAX);
      if (!decoded.ok) return null;
      const alpha = heightAlphaOf(decoded.data);
      const mean = meanOfRgba(decoded.data);
      remember(results, digest, alpha);
      remember(means, digest, mean);
      // Markers: a failed write just means a decode after a restart.
      deps.service.writeImportedArtifact(projectId, markerKey(digest, alpha), new Uint8Array([alpha === 'height' ? 1 : 0]));
      deps.service.writeImportedArtifact(projectId, meanKey(digest), new Uint8Array([...mean.srgb, ...mean.plain]));
      return { alpha, mean };
    })().finally(() => running.delete(digest));
    running.set(digest, run);
    return run;
  };
  const ofFile: HeightAlphaChecks['ofFile'] = async (projectId, digest, bytes, lossless) => {
    const known = results.get(digest);
    if (known !== undefined) return known;
    for (const r of ['height', 'flat'] as const) {
      if (deps.service.locateImportedArtifact(projectId, markerKey(digest, r)) !== null) {
        remember(results, digest, r);
        return r;
      }
    }
    return (await decodeFacts(projectId, digest, bytes, lossless))?.alpha ?? null;
  };
  const meanOfFile: HeightAlphaChecks['meanOfFile'] = async (projectId, digest, bytes, lossless) => {
    const known = means.get(digest);
    if (known !== undefined) return known;
    const file = deps.service.locateImportedArtifact(projectId, meanKey(digest));
    if (file !== null) {
      try {
        const b = readFileSync(file.real);
        if (b.length === 8) {
          const mean: TextureMean = { srgb: [b[0]!, b[1]!, b[2]!, b[3]!], plain: [b[4]!, b[5]!, b[6]!, b[7]!] };
          remember(means, digest, mean);
          return mean;
        }
      } catch {
        // Unreadable: decoded again below.
      }
    }
    return (await decodeFacts(projectId, digest, bytes, lossless))?.mean ?? null;
  };
  return {
    ofFile,
    meanOfFile,
    async ofTexture(projectId, assetId) {
      const v = textureVersionsOf(deps.service, projectId).get(assetId);
      if (v === undefined) return null;
      const recorded = results.get((v as { sourceDigest?: string }).sourceDigest ?? '');
      if (recorded !== undefined) return recorded;
      const read = deps.service.readBlob(projectId, { assetId, version: v.version });
      if (!read.ok) return null;
      const known = results.get(read.digest);
      if (known !== undefined) return known;
      const head = readKtx2(read.bytes);
      if (head !== null && head.layerCount >= 2) return null;
      const original = head === null ? null : losslessOriginal(deps.service, projectId, v, read.bytes, head.width, head.height);
      return ofFile(projectId, read.digest, read.bytes, original?.bytes ?? null);
    },
  };
}

/** One texture in a height slot: the material, the layer (0-based) and the texture. */
export interface HeightSlotUse {
  readonly materialId: string;
  readonly name: string;
  readonly layer: number;
  readonly textureId: string;
}

/** How deep an instance chain is followed (the model refuses cycles; this only bounds a broken project). */
const INSTANCE_DEPTH_MAX = 16;

/**
 * Every texture a project's materials read their height from in A, per
 * material and layer. An instance reads as its root's graph, its slots the
 * nearest value along its chain (its own, its parent's …), else the root's.
 */
export function heightSlotUses(materials: readonly MaterialDef[]): HeightSlotUse[] {
  const byId = new Map(materials.map((m) => [m.materialId, m]));
  const out: HeightSlotUse[] = [];
  for (const m of materials) {
    const chain: MaterialDef[] = [m];
    while (chain.length <= INSTANCE_DEPTH_MAX && chain[chain.length - 1]!.instanceOf !== undefined) {
      const parent = byId.get(chain[chain.length - 1]!.instanceOf!);
      if (parent === undefined) break;
      chain.push(parent);
    }
    const root = chain[chain.length - 1]!;
    if (root.instanceOf !== undefined) continue;
    const keys = heightSlotKeys(root);
    if (keys.size === 0) continue;
    for (const p of root.parameters ?? []) {
      if (p.type !== 'texture' || !keys.has(p.key)) continue;
      const own = chain.find((x) => x.values?.[p.key] !== undefined)?.values?.[p.key];
      const slots = own ?? p.default;
      if (!isTextureSlots(slots)) continue;
      slots.forEach((textureId, layer) => {
        if (textureId !== '') out.push({ materialId: m.materialId, name: m.name ?? m.materialId, layer, textureId });
      });
    }
  }
  return out;
}

/** The problem line of a texture without height (one per texture, naming where it is used). */
export function heightProblemLine(textureId: string, uses: readonly HeightSlotUse[]): string {
  const where = uses.slice(0, 3).map((u) => `"${u.name}" layer ${u.layer + 1}`).join(', ') + (uses.length > 3 ? ` and ${uses.length - 3} more` : '');
  return `${textureId}: no height in alpha — blends between layers will be soft (${where}). Its brightness stands in until a texture with height in A replaces it (Texture Designer: albedo + height export).`;
}

/** The change types that can put a texture into a height slot or change one there. */
const RELEVANT = new Set(['setMaterial', 'setMaterials', 'publishAsset', 'importAssets', 'importResources', 'setAssetOptions']);
/** How long after the last relevant change the check runs (a burst of slot edits settles first). */
const SETTLE_MS = 250;

export interface HeightAlphaProblems {
  loaded(projectId: string): void;
  changed(projectId: string, change: unknown): void;
  /** The texture ids among `ids` without height in A, as checked now (null: the project cannot be read). */
  flat(projectId: string, ids: readonly string[]): Promise<Record<string, HeightAlpha | null> | null>;
}

export function createHeightAlphaProblems(deps: {
  service: WorkspaceService;
  checks: HeightAlphaChecks;
  recordProblem: (projectId: string, code: string, message: string) => void;
  logStartup: (line: string) => void;
  closed: () => boolean;
}): HeightAlphaProblems {
  /** Per project: texture → the line last logged. */
  const last = new Map<string, Map<string, string>>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const check = async (projectId: string): Promise<void> => {
    const captured = deps.service.readCapturedV3(projectId);
    if (!captured.ok) return;
    const materials = ((captured.read.content as { materials?: MaterialDef[] } | undefined)?.materials ?? []);
    const byTexture = new Map<string, HeightSlotUse[]>();
    for (const u of heightSlotUses(materials)) byTexture.set(u.textureId, [...(byTexture.get(u.textureId) ?? []), u]);
    const before = last.get(projectId);
    const now = new Map<string, string>();
    for (const [textureId, uses] of byTexture) {
      if (deps.closed()) return;
      if ((await deps.checks.ofTexture(projectId, textureId)) !== 'flat') continue;
      const line = heightProblemLine(textureId, uses);
      now.set(textureId, line);
      if (before?.get(textureId) !== line) deps.recordProblem(projectId, 'no_height_in_alpha', line);
    }
    last.set(projectId, now);
  };
  const safeCheck = (projectId: string): void => {
    check(projectId).catch((e: unknown) => deps.logStartup(`height-in-alpha check of ${projectId} failed: ${e instanceof Error ? e.message : String(e)}`));
  };
  return {
    loaded(projectId) {
      if (!last.has(projectId) && !deps.closed()) safeCheck(projectId);
    },
    changed(projectId, change) {
      const type = (change as { type?: unknown } | null)?.type;
      if (typeof type !== 'string' || !RELEVANT.has(type) || deps.closed()) return;
      const old = timers.get(projectId);
      if (old !== undefined) clearTimeout(old);
      const t = setTimeout(() => {
        timers.delete(projectId);
        if (!deps.closed()) safeCheck(projectId);
      }, SETTLE_MS);
      (t as { unref?: () => void }).unref?.();
      timers.set(projectId, t);
    },
    async flat(projectId, ids) {
      if (!deps.service.readCapturedV3(projectId).ok) return null;
      const out: Record<string, HeightAlpha | null> = {};
      for (const id of ids) out[id] = await deps.checks.ofTexture(projectId, id);
      return out;
    },
  };
}

/** Texture ids one height-alpha query takes (a palette's layers, a few materials' worth). */
export const HEIGHT_ALPHA_QUERY_MAX = MAX_TEXTURE_LAYERS;

/** `GET /api/v1/projects/:projectId/content/textures/height-alpha?ids=a,b` — each texture's alpha: `height`, `flat`, or null (not a readable single texture). */
export function makeHeightAlphaRoute(o: {
  readonly problems: HeightAlphaProblems;
  readonly requireAuth: (req: IncomingMessage, projectId: string, adminOnly: boolean) => SessionError | null;
  readonly sendJson: (res: ServerResponse, status: number, body: unknown) => void;
  readonly sendError: (res: ServerResponse, error: SessionError, statusOverride?: number) => void;
}) {
  return async (req: IncomingMessage, res: ServerResponse, projectId: string, query: ReadonlyMap<string, string>): Promise<void> => {
    if ((req.method ?? 'GET') !== 'GET') return o.sendError(res, sessionError('invalid_request', 'validation', 'method not allowed', { expected: 'GET' }), 405);
    const auth = o.requireAuth(req, projectId, false);
    if (auth !== null) return o.sendError(res, auth);
    const ids = (query.get('ids') ?? '').split(',').filter((x) => x !== '');
    if (ids.length < 1 || ids.length > HEIGHT_ALPHA_QUERY_MAX || !ids.every((x) => ID_RE.test(x))) {
      return o.sendError(res, sessionError('invalid_request', 'validation', `ids lists 1-${HEIGHT_ALPHA_QUERY_MAX} texture asset ids, comma-separated`, { path: '/query/ids' }));
    }
    const textures = await o.problems.flat(projectId, ids);
    if (textures === null) return o.sendError(res, sessionError('project_not_found', 'not_found', 'the project cannot be read', { projectId }), 404);
    o.sendJson(res, 200, { ok: true, projectId, textures });
  };
}
