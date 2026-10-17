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
 * - `POST …/content/decal-pages?preview=1`: the same, but while some page is
 *   still to be composed, the pages at a preview size (seconds sooner for a
 *   cold atlas; held in memory, never stored), with the composition of the
 *   pages themselves started behind it — the editor then asks for those
 *   (`POST` again) and swaps them in. A build never takes a preview;
 * - `GET …/content/decal-pages/arrays/:id`: an array's bytes (the ones the
 *   last composition made).
 *
 * The last composition is remembered per project in memory, for the most
 * recently used projects (a restarted server composes again on request;
 * the cache makes that quick). Concurrent requests to compose one project
 * queue behind the running composition and share the next one.
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
  /** The pages at a preview size (the pages themselves are being composed). */
  readonly preview?: true;
}

/** The decal page assembly the atlas asks (the build's; `preview`: pages at a preview size while some are not made). */
export interface DecalAtlasPort {
  decalPages?(projectId: string, request: Parameters<NonNullable<ClosureDecalPages['decalPages']>>[1], options?: { readonly preview?: boolean }): ReturnType<NonNullable<ClosureDecalPages['decalPages']>>;
}

interface Read {
  readonly report: DecalPageReport;
  readonly signature: string;
  readonly assets: readonly AssetRecordLike[];
  readonly materials: readonly MaterialDef[];
}

/**
 * The projects whose last composition is remembered. Each is a few hundred
 * bytes (the places, the arrays' file records, never their bytes), so this
 * only bounds a long-running server that has opened many projects; the one
 * forgotten composes again on request (from the cache: quick).
 */
const DECAL_ATLAS_PROJECTS_KEPT = 16;

/** A composition's answer, shared by every request it serves. */
type Outcome = { readonly ok: true; readonly view: DecalAtlasView } | { readonly ok: false; readonly error: SessionError; readonly status?: number };

export function makeDecalAtlasRoutes(o: {
  readonly service: WorkspaceService;
  readonly port: DecalAtlasPort | undefined;
  readonly requireAuth: (req: IncomingMessage, projectId: string, adminOnly: boolean) => SessionError | null;
  readonly sendJson: (res: ServerResponse, status: number, body: unknown) => void;
  readonly sendError: (res: ServerResponse, error: SessionError, statusOverride?: number) => void;
}) {
  /** The last composition per project, least recently composed or read first (a preview's arrays are bytes). */
  const last = new Map<string, { composed: DecalAtlasComposed; files: Map<string, BlobFile | Uint8Array> }>();
  const lastOf = (projectId: string): { composed: DecalAtlasComposed; files: Map<string, BlobFile | Uint8Array> } | undefined => {
    const known = last.get(projectId);
    if (known !== undefined) {
      last.delete(projectId);
      last.set(projectId, known);
    }
    return known;
  };
  /** Each project's last preview's arrays (by id). */
  const lastPreview = new Map<string, Map<string, BlobFile | Uint8Array>>();
  const remember = (projectId: string, entry: { composed: DecalAtlasComposed; files: Map<string, BlobFile | Uint8Array> }): void => {
    last.delete(projectId);
    last.set(projectId, entry);
    while (last.size > DECAL_ATLAS_PROJECTS_KEPT) last.delete(last.keys().next().value!);
  };
  /**
   * Per project, one composition at a time: the one running, and the one
   * that starts after it. A request while one runs waits for the next (the
   * project may have changed since the running one read it); every request
   * arriving before that next one starts shares its answer. A request for
   * the very contents the running one read (the same signature) shares the
   * running one: the editor's request for the pages right after a preview
   * finds the background composition the preview started.
   */
  const running = new Map<string, { run: Promise<Outcome>; signature: string | null }>();
  const waiting = new Map<string, Promise<Outcome>>();

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
    const known = lastOf(projectId)?.composed ?? null;
    o.sendJson(res, 200, { ok: true, report: r.report, signature: r.signature, composed: known !== null && known.signature === r.signature ? known : null } satisfies DecalAtlasView);
  };

  /** Compose the pages (`preview`: at a preview size while some page is not made yet) and remember them. */
  const composeNow = async (projectId: string, preview = false, pre?: Read | string | null): Promise<Outcome> => {
    const r = pre !== undefined ? pre : read(projectId);
    if (r === null) return { ok: false, error: sessionError('project_not_found', 'not_found', 'the project cannot be read', { projectId }), status: 404 };
    if (typeof r === 'string') return { ok: false, error: sessionError('invalid_request', 'validation', r) };
    if (o.port?.decalPages === undefined) return { ok: false, error: sessionError('converter_unavailable', 'unavailable', 'decal page assembly is not available on this server') };
    const t0 = performance.now();
    // The assembly's own counts (pages taken as stored, composed now, found composed), and whether it answered a preview.
    let stats: DecalAtlasComposed['stats'] = null;
    let previewed = false;
    const port: ClosureDecalPages = {
      decalPages: async (p, request) => {
        const made = await o.port!.decalPages!(p, request, preview ? { preview: true } : undefined);
        if (made.ok) {
          stats = (made as { stats?: DecalAtlasComposed['stats'] }).stats ?? null;
          previewed = made.preview === true;
        }
        return made;
      },
    };
    const made = await closureDecalPages({ port, service: o.service, projectId, assets: r.assets, materials: r.materials, locate: true, hash: sha256, previews: preview });
    if (!made.ok) return { ok: false, error: sessionError('conversion_failed', 'validation', made.error.message.slice(0, 256)) };
    const files = new Map<string, BlobFile | Uint8Array>();
    // An array's id is its file digest's start (the build's naming).
    for (const f of made.pages.files) {
      const row = made.pages.rows.find((x) => x.sourceDigest === f.digest);
      if (row !== undefined) files.set(row.assetId, f.file);
    }
    for (const a of made.pages.artifacts) {
      const row = made.pages.rows.find((x) => x.sourceDigest === a.digest);
      if (row !== undefined) files.set(row.assetId, a.bytes);
    }
    const composed: DecalAtlasComposed = { signature: r.signature, refs: Object.fromEntries(made.pages.refs), ms: Math.round(performance.now() - t0), stats: previewed ? null : stats, ...(previewed ? { preview: true as const } : {}) };
    // A preview's arrays stay readable after the pages themselves replace it (a view may still be fetching them).
    if (previewed) {
      lastPreview.delete(projectId);
      lastPreview.set(projectId, files);
      while (lastPreview.size > DECAL_ATLAS_PROJECTS_KEPT) lastPreview.delete(lastPreview.keys().next().value!);
    }
    // A preview never replaces the pages themselves (a composition that finished first).
    const known = lastOf(projectId)?.composed;
    if (!(previewed && known !== undefined && known.signature === r.signature && known.preview !== true)) remember(projectId, { composed, files });
    else return { ok: true, view: { ok: true, report: r.report, signature: r.signature, composed: known } };
    return { ok: true, view: { ok: true, report: r.report, signature: r.signature, composed } };
  };

  /** Start a composition now, or after the running one; a waiting one is shared. */
  const enqueue = (projectId: string): Promise<Outcome> => {
    const queued = waiting.get(projectId);
    if (queued !== undefined) return queued;
    const settle = (e: unknown): Outcome => ({ ok: false, error: sessionError('conversion_failed', 'internal', `decal pages: ${e instanceof Error ? e.message : String(e)}`.slice(0, 256)) });
    const signatureOf = (r: Read | string | null): string | null => (r !== null && typeof r !== 'string' ? r.signature : null);
    const begin = (): Promise<Outcome> => {
      const r = read(projectId);
      const run = composeNow(projectId, false, r).catch(settle);
      const entry = { run, signature: signatureOf(r) };
      running.set(projectId, entry);
      void run.finally(() => {
        if (running.get(projectId) === entry) running.delete(projectId);
      });
      return run;
    };
    const busy = running.get(projectId);
    if (busy === undefined) return begin();
    if (busy.signature !== null && busy.signature === signatureOf(read(projectId))) return busy.run;
    const next = busy.run.then(() => {
      waiting.delete(projectId);
      return begin();
    });
    waiting.set(projectId, next);
    return next;
  };

  /**
   * A preview, unless the pages of these very contents are composed already;
   * the composition of the pages themselves starts behind it (the editor asks
   * for it next and shares it).
   */
  const previewNow = async (projectId: string): Promise<Outcome> => {
    const r = read(projectId);
    const known = lastOf(projectId)?.composed;
    if (r !== null && typeof r !== 'string' && known !== undefined && known.signature === r.signature && known.preview !== true) return { ok: true, view: { ok: true, report: r.report, signature: r.signature, composed: known } };
    const out = await composeNow(projectId, true).catch((e: unknown): Outcome => ({ ok: false, error: sessionError('conversion_failed', 'internal', `decal pages: ${e instanceof Error ? e.message : String(e)}`.slice(0, 256)) }));
    // The pages start behind the preview. Should they fail, the preview is not kept as the pages: a later read finds
    // none and asks again (the error reaches the request that shares this composition).
    if (out.ok && out.view.composed?.preview === true) {
      void enqueue(projectId).then((made) => {
        if (!made.ok && last.get(projectId)?.composed.preview === true) last.delete(projectId);
      });
    }
    return out;
  };

  const compose = async (res: ServerResponse, projectId: string, preview: boolean): Promise<void> => {
    const out = await (preview ? previewNow(projectId) : enqueue(projectId));
    if (out.ok) o.sendJson(res, 200, out.view satisfies DecalAtlasView);
    else o.sendError(res, out.error, out.status);
  };

  const array = async (res: ServerResponse, projectId: string, arrayId: string): Promise<void> => {
    const file = ID_RE.test(arrayId) ? (lastOf(projectId)?.files.get(arrayId) ?? lastPreview.get(projectId)?.get(arrayId)) : undefined;
    if (file === undefined) return o.sendError(res, sessionError('asset_not_found', 'not_found', `no composed decal page array "${arrayId}" (rebuild the pages)`, { path: '/arrayId' }), 404);
    if (file instanceof Uint8Array) {
      res.setHeader('content-type', 'application/octet-stream');
      res.setHeader('content-length', String(file.byteLength));
      res.setHeader('x-thirdlight-digest', sha256(file));
      res.statusCode = 200;
      res.end(Buffer.from(file.buffer, file.byteOffset, file.byteLength));
      return;
    }
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
  return async (req: IncomingMessage, res: ServerResponse, parts: readonly string[], query?: ReadonlyMap<string, string>): Promise<void> => {
    const projectId = parts[3]!;
    const method = req.method ?? 'GET';
    const auth = o.requireAuth(req, projectId, false);
    if (auth !== null) return o.sendError(res, auth);
    if (parts.length === 6) {
      if (method === 'GET') return view(res, projectId);
      if (method === 'POST') return compose(res, projectId, query?.get('preview') === '1');
      return o.sendError(res, sessionError('invalid_request', 'validation', 'method not allowed', { expected: 'GET, POST' }), 405);
    }
    if (parts.length === 8 && parts[6] === 'arrays') {
      if (method !== 'GET') return o.sendError(res, sessionError('invalid_request', 'validation', 'method not allowed', { expected: 'GET' }), 405);
      return array(res, projectId, decodeURIComponent(parts[7]!));
    }
    return o.sendError(res, sessionError('invalid_request', 'validation', 'no such decal pages route'), 404);
  };
}
