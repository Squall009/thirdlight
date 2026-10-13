/**
 * The editor's decal atlas: the decal pages Play and the export will use,
 * read from the project as its build would read it (the shipped materials,
 * the same planner: exporter `decalPageReportOf`), and composed on request
 * so the Scene view can draw from them as Play does.
 *
 * - `GET …/content/decal-pages`: the pages (each page's rectangles, the
 *   unused share, the GPU memory, the images that set the pages' size), a
 *   signature of what they are made of, and the composed pages' places when
 *   the last composition was of these very pages;
 * - `POST …/content/decal-pages`: compose them now — the build's decal page
 *   assembly (each page drawn and encoded on the KTX2 worker thread, cached
 *   in the import cache: the next Play finds them made) — and answer each
 *   decal material's place on the arrays;
 * - `GET …/content/decal-pages/arrays/:id`: an array's bytes (the ones the
 *   last composition made).
 *
 * The last composition is remembered per project in memory (a restarted
 * server composes again on request; the cache makes that quick).
 */
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { closureDecalPages, decalPageReportOf, shippedMaterialsOfCapture, type AssetRecordLike, type ClosureDecalPages } from '@thirdlight/exporter';
import type { DecalPageRef, DecalPageReport, MaterialDef } from '@thirdlight/project-model';
import { ID_RE } from '@thirdlight/project-model/limits';
import { sessionError, type SessionError } from '@thirdlight/protocol';
import type { BlobFile, WorkspaceService } from '@thirdlight/workspace';

const sha256 = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');

/** What the editor reads (the report, its signature, the composed places when they are of these pages). */
export interface DecalAtlasView {
  readonly ok: true;
  readonly report: DecalPageReport;
  readonly signature: string;
  readonly composed: DecalAtlasComposed | null;
}

/** A composition: each decal material's place on the arrays (array ids as the build names them), how long it took. */
export interface DecalAtlasComposed {
  readonly signature: string;
  readonly refs: Readonly<Record<string, DecalPageRef>>;
  readonly ms: number;
  readonly stats: { readonly asStored: number; readonly composed: number; readonly cached: number } | null;
}

interface Read {
  readonly report: DecalPageReport;
  readonly signature: string;
  readonly assets: readonly AssetRecordLike[];
  readonly materials: readonly MaterialDef[];
}

export function makeDecalAtlasRoutes(o: {
  readonly service: WorkspaceService;
  readonly port: ClosureDecalPages | undefined;
  readonly requireAuth: (req: IncomingMessage, projectId: string, adminOnly: boolean) => SessionError | null;
  readonly sendJson: (res: ServerResponse, status: number, body: unknown) => void;
  readonly sendError: (res: ServerResponse, error: SessionError, statusOverride?: number) => void;
}) {
  const last = new Map<string, { composed: DecalAtlasComposed; files: Map<string, BlobFile> }>();
  /** One composition at a time per project (a second request waits for the first's answer). */
  const running = new Map<string, Promise<unknown>>();

  /** The pages as the project's build would plan them now (null: the project cannot be read; a string: why not). */
  const read = (projectId: string): Read | string | null => {
    const captured = o.service.readCapturedV3(projectId);
    if (!captured.ok) return null;
    const materials = shippedMaterialsOfCapture(captured.read, sha256);
    if (materials === null) return 'the project does not build (its content view is invalid)';
    const assets = ((captured.read.content as { assets?: AssetRecordLike[] } | null)?.assets ?? []) as readonly AssetRecordLike[];
    const shipped = materials ?? [];
    const report = decalPageReportOf(assets, shipped);
    // What the pages are made of: the plan and the files of every texture a decal material or its sheet names.
    const byId = new Map(assets.map((a) => [a.assetId, a]));
    const decal = shipped.filter((m) => m.shader === 'decal');
    const sheetIds = new Set(decal.flatMap((m) => (m.decal !== undefined ? [m.decal.sheet] : [])));
    const textures = [...new Set([...decal, ...shipped.filter((m) => sheetIds.has(m.materialId))].flatMap((m) => Object.values(m.textures)))].sort();
    const digests = textures.map((id) => {
      const a = byId.get(id);
      return `${id}@${a?.versions?.find((v) => v.version === a.currentVersion)?.sourceDigest ?? ''}`;
    });
    return { report, signature: sha256(JSON.stringify([report.size, report.pages, digests])), assets, materials: shipped };
  };

  const view = (res: ServerResponse, projectId: string): void => {
    const r = read(projectId);
    if (r === null) return o.sendError(res, sessionError('project_not_found', 'not_found', 'the project cannot be read', { projectId }), 404);
    if (typeof r === 'string') return o.sendError(res, sessionError('invalid_request', 'validation', r));
    const known = last.get(projectId)?.composed ?? null;
    o.sendJson(res, 200, { ok: true, report: r.report, signature: r.signature, composed: known !== null && known.signature === r.signature ? known : null } satisfies DecalAtlasView);
  };

  const compose = async (res: ServerResponse, projectId: string): Promise<void> => {
    const before = running.get(projectId);
    if (before !== undefined) await before.catch(() => undefined);
    const work = (async (): Promise<void> => {
      const r = read(projectId);
      if (r === null) return o.sendError(res, sessionError('project_not_found', 'not_found', 'the project cannot be read', { projectId }), 404);
      if (typeof r === 'string') return o.sendError(res, sessionError('invalid_request', 'validation', r));
      if (o.port?.decalPages === undefined) return o.sendError(res, sessionError('converter_unavailable', 'unavailable', 'decal page assembly is not available on this server'));
      const t0 = performance.now();
      // The assembly's own counts (pages taken as stored, composed now, found composed).
      let stats: DecalAtlasComposed['stats'] = null;
      const port: ClosureDecalPages = {
        decalPages: async (p, request) => {
          const made = await o.port!.decalPages!(p, request);
          if (made.ok) stats = (made as { stats?: DecalAtlasComposed['stats'] }).stats ?? null;
          return made;
        },
      };
      const made = await closureDecalPages({ port, service: o.service, projectId, assets: r.assets, materials: r.materials, locate: true, hash: sha256 });
      if (!made.ok) return o.sendError(res, sessionError('conversion_failed', 'validation', made.error.message.slice(0, 256)));
      const files = new Map<string, BlobFile>();
      for (const f of made.pages.files) {
        // An array's id is its file digest's start (the build's naming).
        const row = made.pages.rows.find((x) => x.sourceDigest === f.digest);
        if (row !== undefined) files.set(row.assetId, f.file);
      }
      const composed: DecalAtlasComposed = { signature: r.signature, refs: Object.fromEntries(made.pages.refs), ms: Math.round(performance.now() - t0), stats };
      last.set(projectId, { composed, files });
      o.sendJson(res, 200, { ok: true, report: r.report, signature: r.signature, composed } satisfies DecalAtlasView);
    })();
    running.set(projectId, work);
    try {
      await work;
    } finally {
      if (running.get(projectId) === work) running.delete(projectId);
    }
  };

  const array = async (res: ServerResponse, projectId: string, arrayId: string): Promise<void> => {
    const file = ID_RE.test(arrayId) ? last.get(projectId)?.files.get(arrayId) : undefined;
    if (file === undefined) return o.sendError(res, sessionError('asset_not_found', 'not_found', `no composed decal page array "${arrayId}" (rebuild the pages)`, { path: '/arrayId' }), 404);
    const opened = o.service.openBlobFile(projectId, file);
    if (!opened.ok) return o.sendError(res, sessionError('asset_source_changed', 'conflict', 'the decal pages changed; rebuild them'));
    const parts: Uint8Array[] = [];
    try {
      for await (const c of opened.blob.chunks()) parts.push(c);
    } catch {
      return o.sendError(res, sessionError('asset_source_changed', 'conflict', 'the decal page array changed while it was read; rebuild the pages'));
    }
    res.setHeader('content-type', 'application/octet-stream');
    res.setHeader('content-length', String(file.byteLength));
    res.setHeader('x-thirdlight-digest', file.digest);
    res.statusCode = 200;
    res.end(Buffer.concat(parts));
  };

  /** `parts`: the URL path's segments (api, v1, projects, :id, content, decal-pages, …). */
  return async (req: IncomingMessage, res: ServerResponse, parts: readonly string[]): Promise<void> => {
    const projectId = parts[3]!;
    const method = req.method ?? 'GET';
    const auth = o.requireAuth(req, projectId, false);
    if (auth !== null) return o.sendError(res, auth);
    if (parts.length === 6) {
      if (method === 'GET') return view(res, projectId);
      if (method === 'POST') return compose(res, projectId);
      return o.sendError(res, sessionError('invalid_request', 'validation', 'method not allowed', { expected: 'GET, POST' }), 405);
    }
    if (parts.length === 8 && parts[6] === 'arrays') {
      if (method !== 'GET') return o.sendError(res, sessionError('invalid_request', 'validation', 'method not allowed', { expected: 'GET' }), 405);
      return array(res, projectId, decodeURIComponent(parts[7]!));
    }
    return o.sendError(res, sessionError('invalid_request', 'validation', 'no such decal pages route'), 404);
  };
}
