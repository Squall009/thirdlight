import { type ServerResponse } from 'node:http';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, normalize, resolve as pathResolve } from 'node:path';
import { sessionError } from '@thirdlight/protocol';
import { type BackendConfig } from './config';

import { MIME } from './util';

export interface StaticRoutesContext {
  readonly config: BackendConfig;
  readonly sendJson: (res: ServerResponse, status: number, body: unknown) => void;
}

export function makeStaticRoutes(ctx: StaticRoutesContext) {
  const { config, sendJson } = ctx;

  const serveStatic = (res: ServerResponse, dir: string, urlPath: string): void => {
    let p: string;
    try {
      p = decodeURIComponent(urlPath);
    } catch {
      sendJson(res, 400, { ok: false, error: sessionError('invalid_request', 'validation', 'bad path encoding') });
      return;
    }
    if (p.includes('\0')) {
      sendJson(res, 400, { ok: false, error: sessionError('invalid_request', 'validation', 'bad path') });
      return;
    }
    const rel = p === '/' ? 'index.html' : normalize(p).replace(/^\/+/, '');
    const full = pathResolve(dir, rel);
    if (full !== pathResolve(dir) && !full.startsWith(pathResolve(dir) + '/')) {
      sendJson(res, 400, { ok: false, error: sessionError('invalid_request', 'validation', 'path traversal rejected') });
      return;
    }
    try {
      if (!existsSync(full) || !statSync(full).isFile()) {
        sendJson(res, 404, { ok: false, error: sessionError('invalid_request', 'validation', 'no such file') });
        return;
      }
      const real = realpathSync(full);
      const realDir = realpathSync(dir);
      if (real !== realDir && !real.startsWith(realDir + '/')) {
        sendJson(res, 400, { ok: false, error: sessionError('invalid_request', 'validation', 'path escape rejected') });
        return;
      }
      const bytes = readFileSync(full);
      res.setHeader('content-type', MIME[extname(full)] ?? 'application/octet-stream');
      res.setHeader('content-length', String(bytes.length));
      res.end(bytes);
    } catch {
      sendJson(res, 500, { ok: false, error: sessionError('invalid_request', 'internal', 'static read failed') });
    }
  };

  /**
   * The preview-origin CSP (sessions.md §17.4). `script-src` carries the
   * per-response nonce for the shell's injected page config (delivery §7); the
   * artifact responses use the same policy without a nonce.
   */
  const previewCsp = (nonce?: string): string =>
    // 'wasm-unsafe-eval': the game's physics (Rapier) is WebAssembly.
    "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'" +
    (nonce !== undefined ? ` 'nonce-${nonce}'` : '') +
    "; connect-src 'self'; img-src 'self' data:; style-src 'self'; font-src 'none'; worker-src 'none'; " +
    "object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; " +
    `frame-ancestors ${config.authoringOrigin}`;

  const locatorBaseHeaders = (res: ServerResponse): void => {
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('cross-origin-resource-policy', 'same-origin');
    res.setHeader('content-security-policy', previewCsp());
  };

  /** The preview origin's root page: plays load from their own locator, so this only says so. */
  const previewTemplate = (): string =>
    '<!doctype html>\n<html>\n  <head>\n    <meta charset="utf-8" />\n    <title>Thirdlight Play Preview</title>\n  </head>\n  <body>\n' +
    '    <p>Thirdlight play preview. Start Play in the editor.</p>\n  </body>\n</html>\n';

  /**
   * The M2 locator shell (sessions.md §17.2.1): the only dynamic page. It
   * injects the §13.2/§17.6 page config (no tokens, no API URLs) and loads the
   * pinned play bundle from the artifact root.
   */
  const previewShellHtml = (playSessionId: string, contentId: string, nonce: string): string => {
    const origin = config.authoringOrigin.replace(/"/g, '\\"');
    const root = `/play-content/${contentId}/`;
    return (
      '<!doctype html>\n<html>\n  <head>\n    <meta charset="utf-8" />\n    <title>Thirdlight Play Preview</title>\n  </head>\n  <body>\n' +
      `    <script nonce="${nonce}">window.__thirdlightPreview = { v: 2, authoringOrigin: "${origin}", playSessionId: "${playSessionId}", contentId: "${contentId}", manifestPath: "./manifest.json" };window.__thirdlightContentRoot = "${root}";</script>\n` +
      `    <script src="${root}game.js"></script>\n` +
      '  </body>\n</html>\n'
    );
  };

  // ---------- request dispatch ----------


  return { serveStatic, previewCsp, locatorBaseHeaders, previewTemplate, previewShellHtml };
}
