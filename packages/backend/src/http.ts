/**
 * The HTTP plumbing every route shares: JSON answers, the session-layer error
 * shape and its status, the bearer token, the bounded body read, the query
 * string, and the workspace's errors surfaced unchanged.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sessionError, statusFor, type SessionError } from '@thirdlight/protocol';
import type { CommandError } from '@thirdlight/workspace';

import { MAX_HTTP_BODY } from './util';

export type BodyRead = { ok: true; bytes: Uint8Array } | { ok: false; error: SessionError };

export const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  res.setHeader('content-type', 'application/json');
  res.statusCode = status;
  res.end(JSON.stringify(body));
};

export const sendError = (res: ServerResponse, error: SessionError, statusOverride?: number): void => {
  // The error-class status mapping, with the contract's explicit exceptions:
  // unauthorized ⇒ 401, bad_origin / session_required ⇒ 403.
  let status = statusFor(error.cls);
  if (error.code === 'unauthorized') status = 401;
  if (error.code === 'bad_origin' || error.code === 'session_required') status = 403;
  if (statusOverride !== undefined) status = statusOverride;
  sendJson(res, status, { ok: false, error });
};

export const bearerToken = (req: IncomingMessage): string | null => {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return null;
  const m = h.match(/^Bearer\s+(\S+)$/);
  return m?.[1] ?? null;
};

export const readBody = (req: IncomingMessage): Promise<BodyRead> =>
  new Promise((resolve) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk: Uint8Array) => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_HTTP_BODY) {
        done = true;
        resolve({ ok: false, error: sessionError('invalid_request', 'validation', 'request body exceeds the 1 MiB bound') });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      const bytes = new Uint8Array(size);
      let off = 0;
      for (const c of chunks) {
        bytes.set(c, off);
        off += c.length;
      }
      resolve({ ok: true, bytes });
    });
    req.on('error', () => {
      if (!done) {
        done = true;
        resolve({ ok: false, error: sessionError('invalid_request', 'validation', 'request body read failed') });
      }
    });
  });

export const parseQuery = (qs: string): Map<string, string> => {
  const out = new Map<string, string>();
  if (qs.length === 0) return out;
  for (const pair of qs.split('&')) {
    if (pair.length === 0) continue;
    const eq = pair.indexOf('=');
    const k = eq === -1 ? pair : pair.slice(0, eq);
    const v = eq === -1 ? '' : pair.slice(eq + 1);
    try {
      out.set(decodeURIComponent(k), decodeURIComponent(v));
    } catch {
      // un-decodable pair: dropped
    }
  }
  return out;
};

/** Surface a workspace/command error through the session layer unchanged
 * (workspace codes surface through the session operations unchanged). */
export const workspaceError = (e: CommandError): SessionError =>
  sessionError(e.code as SessionError['code'], e.cls as SessionError['cls'], e.message, {
    ...(e.hint !== undefined ? { hint: e.hint } : {}),
    ...(e.projectId !== undefined ? { projectId: e.projectId } : {}),
    ...(e.reason !== undefined ? { reason: e.reason } : {}),
    ...(e.holder !== undefined ? { holder: e.holder } : {}),
    // Why a project does not load (the model's problems, at most 10) reaches the caller.
    ...(e.details !== undefined ? { details: e.details } : {}),
  });

export const badOriginError = (found: string): SessionError =>
  sessionError('bad_origin', 'validation', 'Origin is not in the authoring allowlist', { found: found.slice(0, 256) });

/** A 405 naming the method the route takes. */
export const methodNotAllowed = (res: ServerResponse, expected: string): void =>
  sendError(res, sessionError('invalid_request', 'validation', 'method not allowed', { expected }), 405);
