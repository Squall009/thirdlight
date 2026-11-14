/**
 * A plain static file server over a folder, on a free port: an exported game
 * is served this way with the backend stopped, so it gets nothing else (no
 * API, no listing, no file outside the folder).
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize } from 'node:path';

/** The content types every export needs; anything else is served as `application/octet-stream`. */
export const SERVE_DIR_TYPES: Readonly<Record<string, string>> = Object.freeze({
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
});

export interface ServeDirOptions {
  /** More content types by extension (a test that reads a picture or a model by type). */
  types?: Readonly<Record<string, string>>;
  /** Every path served (relative to the folder) is pushed here, in order. */
  served?: string[];
  /** Cross-origin isolation headers on every file (COOP same-origin, COEP require-corp). */
  isolated?: boolean;
  /** `close` also drops open keep-alive connections (a page that stays open would hold it). */
  dropConnections?: boolean;
  /** The address to listen on (default 127.0.0.1). */
  host?: string;
}

export interface ServedDir {
  url: string;
  close: () => Promise<void>;
  server: Server;
}

/** Serve `root` statically on a free port; `index.html` for `/`, 404 for anything that is not a file inside it. */
export function serveDir(root: string, options: ServeDirOptions = {}): Promise<ServedDir> {
  const types = { ...SERVE_DIR_TYPES, ...options.types };
  const host = options.host ?? '127.0.0.1';
  const server: Server = createServer((req, res) => {
    const rel = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]!)).replace(/^\/+/, '') || 'index.html';
    const file = join(root, rel);
    if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader('content-type', types[extname(file)] ?? 'application/octet-stream');
    if (options.isolated === true) {
      res.setHeader('cross-origin-opener-policy', 'same-origin');
      res.setHeader('cross-origin-embedder-policy', 'require-corp');
    }
    options.served?.push(rel);
    createReadStream(file).pipe(res);
  });
  const close = (): Promise<void> =>
    new Promise((done) => {
      server.close(() => done());
      if (options.dropConnections === true) server.closeAllConnections();
    });
  return new Promise((ok) => {
    server.listen(0, host, () => {
      const port = (server.address() as { port: number }).port;
      ok({ url: `http://${host}:${port}/`, close, server });
    });
  });
}
