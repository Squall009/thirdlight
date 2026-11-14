/**
 * A project's voxel worlds over HTTP: the world's manifest and region files
 * (GET), each region file read by byte range, and the voxel world commands
 * the command route hands over (`editVoxels`, `writeKitTestScene`), applied
 * by the workspace through the project's undo timeline (the project's `undo`
 * and `redo` step strokes too: session-routes.ts). Clients never write files; they read ranges and re-read the
 * chunks a command answers changed.
 *
 * Region files are served with their entity tag (the hash of the bytes the
 * workspace last wrote): `If-Match` with another tag is refused (412), so a
 * client that wants a table and its chunks from one version of a file can
 * have that. One `bytes=` range per request (what the chunk source sends);
 * anything else gets the whole file, as RFC 9110 lets a server do.
 *
 * A world's far cache (the far field's nodes, rebuilt by the workspace on
 * every change and built whole when missing) is served the same way under
 * `…/far`: its manifest and files, each file by range; `…/far/bake` pauses or
 * resumes the world's fine bake (the bake level is the scene's).
 *
 * Play reads the same worlds on the preview origin under its play's
 * locator (`reads`, see preview-routes.ts): the locator is the permission
 * there, as for the play's other files, and no token reaches that origin.
 */
import { closeSync, createReadStream, fstatSync, openSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseStrictJsonBytes, sessionError, statusFor, type SessionError, type VoxelsChangedPayload } from '@thirdlight/protocol';
import type { VoxelCommandApplied, VoxelCommandResult, VoxelWorlds } from '@thirdlight/workspace';

import type { Problem } from './backend';
import { readBody } from './http';

export interface VoxelRoutesContext {
  readonly worlds: VoxelWorlds;
  readonly requireAuth: (req: IncomingMessage, projectId: string, adminOnly: boolean) => SessionError | null;
  readonly sendJson: (res: ServerResponse, status: number, body: unknown) => void;
  readonly sendError: (res: ServerResponse, error: SessionError, statusOverride?: number) => void;
  readonly recordProblem: (projectId: string, source: Problem['source'], code: string, message: string) => void;
  /** A command applied (not an answer repeated for a request id seen before): the editor's feed tells open views. */
  readonly onApplied?: (projectId: string, change: VoxelsChangedPayload) => void;
  /** Applies a voxel command (the project's undo timeline, which records the stroke; default the worlds themselves). */
  readonly run?: (projectId: string, envelope: Record<string, unknown>) => Promise<VoxelCommandResult>;
}

/** The single byte range a `Range` header asks for, against a file of `size` bytes. */
export function parseByteRange(header: string | undefined, size: number): { kind: 'whole' } | { kind: 'range'; start: number; end: number } | { kind: 'unsatisfiable' } {
  if (header === undefined) return { kind: 'whole' };
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (m === null || (m[1] === '' && m[2] === '')) return { kind: 'whole' };
  if (m[1] === '') {
    // A suffix: the last N bytes.
    const n = Number(m[2]);
    if (n === 0) return { kind: 'unsatisfiable' };
    return size === 0 ? { kind: 'unsatisfiable' } : { kind: 'range', start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === '' ? size - 1 : Math.min(size - 1, Number(m[2]));
  if (!Number.isSafeInteger(start) || start >= size) return { kind: 'unsatisfiable' };
  if (end < start) return { kind: 'whole' };
  return { kind: 'range', start, end };
}

/** The envelope's origin as the feed names it (the workspace refused a malformed one; the route bound a browser origin to its session). */
function originOf(v: unknown): VoxelsChangedPayload['origin'] {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as VoxelsChangedPayload['origin']) : null;
}

export function makeVoxelRoutes(ctx: VoxelRoutesContext) {
  const { worlds, requireAuth, sendJson, sendError, recordProblem, onApplied } = ctx;
  const run = ctx.run ?? ((projectId: string, envelope: Record<string, unknown>) => worlds.command(projectId, envelope));

  /** Tells the editor's feed what a voxel change (a stroke, or the project's undo or redo of one) changed. */
  const applied = (projectId: string, r: VoxelCommandApplied, origin: unknown): void => {
    onApplied?.(projectId, { op: r.op, world: r.world, revision: r.revision, chunks: r.chunks, box: r.box, parts: r.parts, materialSwaps: r.materialSwaps, files: r.files, requestId: r.requestId, origin: originOf(origin) });
  };

  /** The manifest and the region files with their tags (the caller checked who may read them). */
  const sendInfo = async (res: ServerResponse, projectId: string, world: string): Promise<void> => {
    const r = await worlds.info(projectId, world);
    if (!r.ok) sendJson(res, statusFor(r.error.cls), r);
    else sendJson(res, 200, r);
  };

  /** A region file, whole or one byte range (the caller checked who may read it). */
  const sendRegion = async (req: IncomingMessage, res: ServerResponse, projectId: string, world: string, file: string): Promise<void> => {
    sendFile(req, res, await worlds.regionFile(projectId, world, file), file);
  };

  /** The far cache's manifest and files with their tags (the caller checked who may read them). */
  const sendFarInfo = async (res: ServerResponse, projectId: string, world: string): Promise<void> => {
    const r = await worlds.farInfo(projectId, world);
    // A cache being built is not a failure: 202 (the client asks again), so a page's console stays clean meanwhile.
    sendJson(res, r.ok ? 200 : r.error.code === 'far_cache_building' ? 202 : statusFor(r.error.cls), r);
  };

  /** A far cache file (`L<level>/<name>`), whole or one byte range (the caller checked who may read it). */
  const sendFarFile = async (req: IncomingMessage, res: ServerResponse, projectId: string, world: string, level: string, file: string): Promise<void> => {
    sendFile(req, res, await worlds.farFile(projectId, world, level, file), `${level}/${file}`);
  };

  /** A world file the workspace answered for, whole or one byte range, with its tag. */
  const sendFile = (req: IncomingMessage, res: ServerResponse, r: Awaited<ReturnType<VoxelWorlds['regionFile']>>, file: string): void => {
    if (!r.ok) {
      sendJson(res, statusFor(r.error.cls), r);
      return;
    }
    const tag = `"${r.etag}"`;
    const ifMatch = req.headers['if-match'];
    if (typeof ifMatch === 'string' && ifMatch.trim() !== '*' && !ifMatch.split(',').some((t) => t.trim() === tag)) {
      res.writeHead(412, { etag: tag, 'cache-control': 'no-cache' }).end();
      return;
    }
    // Opened in the same tick the tag was read: a command's replace of the file cannot fall between them.
    let fd: number;
    try {
      fd = openSync(r.path, 'r');
    } catch {
      sendError(res, sessionError('invalid_request', 'not_found', `region ${file} is gone`), 404);
      return;
    }
    const size = fstatSync(fd).size;
    const range = parseByteRange(typeof req.headers.range === 'string' ? req.headers.range : undefined, size);
    const headers = { etag: tag, 'accept-ranges': 'bytes', 'content-type': 'application/octet-stream', 'cache-control': 'no-cache' };
    if (range.kind === 'unsatisfiable') {
      closeSync(fd);
      res.writeHead(416, { ...headers, 'content-range': `bytes */${size}` }).end();
      return;
    }
    const start = range.kind === 'range' ? range.start : 0;
    const end = range.kind === 'range' ? range.end : size - 1;
    res.writeHead(range.kind === 'range' ? 206 : 200, { ...headers, 'content-length': String(Math.max(0, end - start + 1)), ...(range.kind === 'range' ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}) });
    if (size === 0) {
      closeSync(fd);
      res.end();
      return;
    }
    createReadStream('', { fd, start, end, autoClose: true }).pipe(res);
  };

  /** GET …/voxels/:world — the manifest and the region files with their tags. */
  const info = async (req: IncomingMessage, res: ServerResponse, projectId: string, world: string): Promise<void> => {
    const auth = requireAuth(req, projectId, false);
    if (auth !== null) sendError(res, auth);
    else await sendInfo(res, projectId, world);
  };

  /** GET …/voxels/:world/regions/:file — a region file, whole or one byte range. */
  const region = async (req: IncomingMessage, res: ServerResponse, projectId: string, world: string, file: string): Promise<void> => {
    const auth = requireAuth(req, projectId, false);
    if (auth !== null) sendError(res, auth);
    else await sendRegion(req, res, projectId, world, file);
  };

  /** GET …/voxels/:world/far — the far cache's manifest and files with their tags. */
  const farInfo = async (req: IncomingMessage, res: ServerResponse, projectId: string, world: string): Promise<void> => {
    const auth = requireAuth(req, projectId, false);
    if (auth !== null) sendError(res, auth);
    else await sendFarInfo(res, projectId, world);
  };

  /** GET …/voxels/:world/far/:level/:file — a far cache file, whole or one byte range. */
  const farRegion = async (req: IncomingMessage, res: ServerResponse, projectId: string, world: string, level: string, file: string): Promise<void> => {
    const auth = requireAuth(req, projectId, false);
    if (auth !== null) sendError(res, auth);
    else await sendFarFile(req, res, projectId, world, level, file);
  };

  /**
   * POST …/voxels/:world/far/bake {run} — pauses (false) or resumes (true) the world's fine bake (a background job, not
   * the project's state: the bake level itself is the scene's, set by its commands); answers the far info with its state.
   */
  const farBake = async (req: IncomingMessage, res: ServerResponse, projectId: string, world: string): Promise<void> => {
    const auth = requireAuth(req, projectId, false);
    if (auth !== null) return sendError(res, auth);
    const body = await readBody(req);
    if (!body.ok) return sendError(res, body.error);
    const strict = parseStrictJsonBytes(body.bytes);
    const run = strict.ok ? (strict.value as { run?: unknown } | null)?.run : undefined;
    if (typeof run !== 'boolean') return sendError(res, sessionError('invalid_request', 'validation', 'the body is {"run": true | false}'));
    const r = await worlds.fineBakeControl(projectId, world, run);
    sendJson(res, r.ok ? 200 : r.error.code === 'far_cache_building' ? 202 : statusFor(r.error.cls), r);
  };

  /** A voxel world command from the command route (envelope already parsed as strict JSON). */
  const command = async (res: ServerResponse, projectId: string, envelope: Record<string, unknown>): Promise<void> => {
    const r = await run(projectId, envelope);
    if (r.ok) {
      sendJson(res, 200, r);
      if (!r.duplicated) applied(projectId, r, envelope.origin);
      return;
    }
    if (r.error.code !== 'no_change') recordProblem(projectId, 'command', r.error.code, `${String(envelope.op)}: ${r.error.message}`);
    sendJson(res, statusFor(r.error.cls), r);
  };

  return { info, region, farInfo, farRegion, farBake, command, applied, reads: { info: sendInfo, region: sendRegion, farInfo: sendFarInfo, farFile: sendFarFile } };
}
