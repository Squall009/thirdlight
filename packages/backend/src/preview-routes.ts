import { type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyLocatorPath, isContentId, redactContentId, sessionError, type SessionError } from '@thirdlight/protocol';
import { type BackendConfig } from './config';
import { decodersNeeded } from '@thirdlight/exporter';
import { PlayContentStore, type PlayContentSet } from './play-content';

import { hex } from './util';

export interface PreviewRoutesContext {
  readonly config: BackendConfig;
  readonly logStartup: (message: string) => void;
  readonly playContent: PlayContentStore;
  readonly sendJson: (res: ServerResponse, status: number, body: unknown) => void;
  readonly parseQuery: (qs: string) => Map<string, string>;
  readonly serveStatic: (res: ServerResponse, dir: string, urlPath: string) => void;
  readonly previewCsp: (nonce?: string, allowEval?: boolean) => string;
  readonly locatorBaseHeaders: (res: ServerResponse) => void;
  readonly previewTemplate: () => string;
  readonly previewShellHtml: (playSessionId: string, contentId: string, nonce: string) => string;
  /** Phase 22.0: COOP + COEP when the deployment asks for cross-origin isolation (`embeddable`: the play page itself). */
  readonly isolationHeaders: (res: ServerResponse, embeddable?: boolean) => void;
}

export function makePreviewRoutes(ctx: PreviewRoutesContext) {
  const { config, logStartup, playContent, sendJson, parseQuery, serveStatic, previewCsp, locatorBaseHeaders, previewTemplate, previewShellHtml, isolationHeaders } = ctx;

  /** `trusted`: the page request came from a trusted network — the editor then asks for no token. */
  const serveEditorPage = (res: ServerResponse, trusted = false): void => {
    let html: string;
    try {
      html = readFileSync(join(config.editorStaticDir, 'index.html'), 'utf8');
    } catch {
      sendJson(res, 404, { ok: false, error: sessionError('invalid_request', 'validation', 'no such file') });
      return;
    }
    const pageConfig = JSON.stringify({ v: 1, previewOrigin: config.previewOrigin, ...(trusted ? { trusted: true } : {}) }).replace(/</g, '\\u003c');
    const script = `<script>window.__thirdlightEditor = ${pageConfig};</script>`;
    const i = html.indexOf('<script src="./main.js">');
    const out = new TextEncoder().encode(i === -1 ? html.replace('</body>', `${script}</body>`) : html.slice(0, i) + script + '\n    ' + html.slice(i));
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('content-length', String(out.length));
    res.statusCode = 200;
    res.end(out);
  };

  /**
   * The TTL/terminal verdict for a locator set. `null` ⇒ serveable; otherwise
   * the structured failure (`play_locator_expired`, cls unavailable).
   */
  const locatorStatus = (
    set: PlayContentSet,
  ): { error: SessionError; status: number } | null => {
    const status = playContent.status(set);
    if (status !== 'expired') return null;
    const expiresAt = new Date(set.terminalAtMs !== null ? set.terminalAtMs + 60_000 : set.expiresAtMs).toISOString();
    return {
      error: sessionError('play_locator_expired', 'unavailable', 'this play-content locator has expired; start a new play', { expiresAt }),
      status: 503,
    };
  };

  /** Send a locator failure with the §17.4 redaction applied to the message/hint. */
  const locatorError = (res: ServerResponse, error: SessionError, status: number): void => {
    for (const contentId of playContent.allContentIds()) {
      error.message = redactContentId(error.message, contentId);
      if (error.hint !== undefined) error.hint = redactContentId(error.hint, contentId);
    }
    locatorBaseHeaders(res);
    sendJson(res, status, { ok: false, error });
  };

  /** Does this play ship a KTX2/Basis texture (the transcoder then needs 'unsafe-eval')? */
  const needsBasis = (set: PlayContentSet): boolean => decodersNeeded([...set.artifacts.values()]).includes('basis');

  const dispatchPreview = (req: IncomingMessage, res: ServerResponse): void => {
    const url = req.url ?? '';
    const qIdx = url.indexOf('?');
    const p = qIdx === -1 ? url : url.slice(0, qIdx);
    const query = parseQuery(qIdx === -1 ? '' : url.slice(qIdx + 1));
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      sendJson(res, 405, { ok: false, error: sessionError('invalid_request', 'validation', 'method not allowed', { expected: 'GET' }) });
      return;
    }
    // Phase 22.0: every preview-origin response (the play page, its bundle, the worker script, artifacts).
    isolationHeaders(res);
    try {
      // M2 locator shell by play session (sessions.md §17.2.1).
      if (p === '/play' || p.startsWith('/play/')) {
        const psid = p === '/play' ? '' : p.slice('/play/'.length);
        const contentId = query.get('content');
        if (psid.length === 0 || !isContentId(contentId)) {
          locatorError(res, sessionError('play_locator_invalid', 'not_found', 'the play/content pairing is malformed'), 404);
          return;
        }
        const set = playContent.get(contentId);
        if (set === undefined || set.playSessionId !== psid) {
          locatorError(res, sessionError('play_locator_invalid', 'not_found', 'unknown or unpaired play-content locator'), 404);
          return;
        }
        const verdict = locatorStatus(set);
        if (verdict !== null) {
          locatorError(res, verdict.error, verdict.status);
          return;
        }
        const nonce = hex(16);
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.setHeader('content-security-policy', previewCsp(nonce, needsBasis(set)));
        res.setHeader('referrer-policy', 'no-referrer');
        res.setHeader('cache-control', 'no-store');
        isolationHeaders(res, true);
        res.end(previewShellHtml(psid, contentId, nonce));
        return;
      }
      // M2 locator paths (artifact root + shell).
      if (p === '/play-content' || p.startsWith('/play-content/')) {
        const locator = classifyLocatorPath(p);
        if (locator.kind === 'invalid') {
          locatorError(res, sessionError('path_rejected', 'validation', 'no locator route matches this path (listing/traversal/undeclared path rejected)'), 400);
          return;
        }
        const set = playContent.get(locator.contentId);
        if (set === undefined) {
          locatorError(res, sessionError('play_locator_invalid', 'not_found', 'unknown or unpaired play-content locator'), 404);
          return;
        }
        if (locator.kind === 'shell') {
          const psid = query.get('play');
          if (psid !== undefined && psid !== set.playSessionId) {
            locatorError(res, sessionError('play_locator_invalid', 'not_found', 'unknown or unpaired play-content locator'), 404);
            return;
          }
          const verdict = locatorStatus(set);
          if (verdict !== null) {
            locatorError(res, verdict.error, verdict.status);
            return;
          }
          const nonce = hex(16);
          res.setHeader('content-type', 'text/html; charset=utf-8');
          res.setHeader('content-security-policy', previewCsp(nonce, needsBasis(set)));
          res.setHeader('referrer-policy', 'no-referrer');
          res.setHeader('cache-control', 'no-store');
          isolationHeaders(res, true);
          res.end(previewShellHtml(set.playSessionId, set.contentId, nonce));
          return;
        }
        const verdict = locatorStatus(set);
        if (verdict !== null) {
          locatorError(res, verdict.error, verdict.status);
          return;
        }
        const artifact = playContent.artifactFor(set, locator);
        if (artifact === undefined) {
          // Undeclared artifact of a served set: never a filesystem fallback.
          locatorError(res, sessionError('path_rejected', 'validation', 'the requested artifact is not declared by the served manifest'), 400);
          return;
        }
        const maxAge = playContent.remainingMaxAge(set);
        res.setHeader('content-type', artifact.contentType);
        res.setHeader('content-length', String(artifact.bytes.length));
        res.setHeader('x-thirdlight-digest', artifact.digest);
        res.setHeader('etag', `"${artifact.digest}"`);
        res.setHeader('cache-control', `private, max-age=${maxAge}, immutable`);
        locatorBaseHeaders(res);
        res.end(artifact.bytes);
        return;
      }
    } catch (err) {
      logStartup(`locator error: ${err instanceof Error ? err.message : String(err)}`);
      sendJson(res, 500, { ok: false, error: sessionError('invalid_request', 'internal', 'internal error') });
      return;
    }
    if (p === '/' || p === '/index.html') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.setHeader('content-security-policy', previewCsp());
      res.end(previewTemplate());
      return;
    }
    serveStatic(res, config.previewStaticDir, p);
  };


  return { serveEditorPage, dispatchPreview };
}
