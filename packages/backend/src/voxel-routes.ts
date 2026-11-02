/**
 * A project's voxel worlds over HTTP: the world's manifest and region files
 * (GET), each region file read by byte range, and the voxel world commands
 * the command route hands over (`editVoxels`, `undoVoxels`), applied by the
 * workspace. Clients never write files; they read ranges and re-read the
 * chunks a command answers changed.
 *
 * Region files are served with their entity tag (the hash of the bytes the
 * workspace last wrote): `If-Match` with another tag is refused (412), so a
 * client that wants a table and its chunks from one version of a file can
 * have that. One `bytes=` range per request (what the chunk source sends);
 * anything else gets the whole file, as RFC 9110 lets a server do.
 */
import { closeSync, createReadStream, fstatSync, openSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sessionError, statusFor, type SessionError } from '@thirdlight/protocol';
import type { VoxelWorlds } from '@thirdlight/workspace';

import type { Problem } from './backend';

export interface VoxelRoutesContext {
  readonly worlds: VoxelWorlds;
  readonly requireAuth: (req: IncomingMessage, projectId: string, adminOnly: boolean) => SessionError | null;
  readonly sendJson: (res: ServerResponse, status: number, body: unknown) => void;
  readonly sendError: (res: ServerResponse, error: SessionError, statusOverride?: number) => void;
  readonly recordProblem: (projectId: string, source: Problem['source'], code: string, message: string) => void;
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

export function makeVoxelRoutes(ctx: VoxelRoutesContext) {
  const { worlds, requireAuth, sendJson, sendError, recordProblem } = ctx;

  /** GET …/voxels/:world — the manifest and the region files with their tags. */
  const info = async (req: IncomingMessage, res: ServerResponse, projectId: string, world: string): Promise<void> => {
    const auth = requireAuth(req, projectId, false);
    if (auth !== null) {
      sendError(res, auth);
      return;
    }
    const r = await worlds.info(projectId, world);
    if (!r.ok) sendJson(res, statusFor(r.error.cls), r);
    else sendJson(res, 200, r);
  };

  /** GET …/voxels/:world/regions/:file — a region file, whole or one byte range. */
  const region = async (req: IncomingMessage, res: ServerResponse, projectId: string, world: string, file: string): Promise<void> => {
    const auth = requireAuth(req, projectId, false);
    if (auth !== null) {
      sendError(res, auth);
      return;
    }
    const r = await worlds.regionFile(projectId, world, file);
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

  /** A voxel world command from the command route (envelope already parsed as strict JSON). */
  const command = async (res: ServerResponse, projectId: string, envelope: Record<string, unknown>): Promise<void> => {
    const r = await worlds.command(projectId, envelope);
    if (r.ok) {
      sendJson(res, 200, r);
      return;
    }
    if (r.error.code !== 'no_change') recordProblem(projectId, 'command', r.error.code, `${String(envelope.op)}: ${r.error.message}`);
    sendJson(res, statusFor(r.error.cls), r);
  };

  return { info, region, command };
}
