import { type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyLocatorPath, isContentId, redactContentId, sessionError, type SessionError } from '@thirdlight/protocol';
import { type BackendConfig } from './config';
import { decodersNeeded } from '@thirdlight/exporter';
import { PlayContentStore, type PlayArtifact, type PlayContentSet } from './play-content';
import { etagMatches, parsePlayBuildPath, type PlayBuildCache } from './play-build';

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
  readonly previewShellHtml: (playSessionId: string, contentId: string, nonce: string, roots?: { cacheRoot: string; buildRoot: string | null }) => string;
  /** The prebuilt play scripts at digest-keyed URLs. */
  readonly playBuild: PlayBuildCache;
  /** COOP + COEP when the deployment asks for cross-origin isolation (`embeddable`: the play page itself). */
  readonly isolationHeaders: (res: ServerResponse, embeddable?: boolean) => void;
}

export function makePreviewRoutes(ctx: PreviewRoutesContext) {
  const { config, logStartup, playContent, sendJson, parseQuery, serveStatic, previewCsp, locatorBaseHeaders, previewTemplate, previewShellHtml, isolationHeaders, playBuild } = ctx;

  /** The page's stable roots (the project's cache root, the play build). */
  const rootsOf = (set: PlayContentSet): { cacheRoot: string; buildRoot: string | null } => ({
    cacheRoot: `/play-content/${playContent.cacheIdFor(set.projectId)}/`,
    buildRoot: playBuild.current()?.root ?? null,
  });

  /**
   * One immutable, digest-named response — `ETag` the digest, a
   * year's `max-age` (the URL can never mean other bytes), 304 for a
   * revalidation that names it.
   */
  const sendImmutable = (req: IncomingMessage, res: ServerResponse, a: { bytes: Uint8Array; digest: string; contentType: string }, maxAge: number): void => {
    const etag = `"${a.digest}"`;
    res.setHeader('etag', etag);
    res.setHeader('cache-control', `private, max-age=${maxAge}, immutable`);
    res.setHeader('x-thirdlight-digest', a.digest);
    locatorBaseHeaders(res);
    if (etagMatches(req.headers['if-none-match'], etag)) {
      res.statusCode = 304;
      res.end();
      return;
    }
    res.setHeader('content-type', a.contentType);
    res.setHeader('content-length', String(a.bytes.length));
    res.end(req.method === 'HEAD' ? undefined : a.bytes);
  };
  /** A year: digest-named bytes never change. */
  const IMMUTABLE_MAX_AGE = 31_536_000;

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

  /** Send a locator failure with the contentId redaction applied to the message/hint. */
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
    // Every preview-origin response (the play page, its bundle, the worker script, artifacts).
    isolationHeaders(res);
    try {
      // The locator shell by play session.
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
        res.end(previewShellHtml(psid, contentId, nonce, rootsOf(set)));
        return;
      }
      // The prebuilt play scripts, by the play build's digest.
      if (p.startsWith('/play-build/')) {
        const parsed = parsePlayBuildPath(p);
        const file = parsed === null ? undefined : playBuild.get(parsed.digest)?.files.get(parsed.name);
        if (file === undefined) {
          locatorError(res, sessionError('path_rejected', 'not_found', 'no such play build file (a rebuilt build has a new address)'), 404);
          return;
        }
        sendImmutable(req, res, file, IMMUTABLE_MAX_AGE);
        return;
      }
      // The locator paths (artifact root + shell).
      if (p === '/play-content' || p.startsWith('/play-content/')) {
        const locator = classifyLocatorPath(p);
        if (locator.kind === 'invalid') {
          locatorError(res, sessionError('path_rejected', 'validation', 'no locator route matches this path (listing/traversal/undeclared path rejected)'), 400);
          return;
        }
        // A project's cache root serves its declared artifacts by digest (the same URL every Play).
        const cacheProject = playContent.cacheProject(locator.contentId);
        if (cacheProject !== undefined) {
          const digest = locator.kind === 'asset-digest' ? locator.digest : locator.kind === 'behavior' || locator.kind === 'library' ? locator.outputDigest : null;
          const artifact: PlayArtifact | undefined = digest === null ? undefined : playContent.artifactByDigest(cacheProject, digest);
          if (artifact === undefined) {
            locatorError(res, sessionError('path_rejected', 'not_found', 'no play of this project declares this artifact'), 404);
            return;
          }
          sendImmutable(req, res, artifact, IMMUTABLE_MAX_AGE);
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
          res.end(previewShellHtml(set.playSessionId, set.contentId, nonce, rootsOf(set)));
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
        sendImmutable(req, res, artifact, playContent.remainingMaxAge(set));
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
