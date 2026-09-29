/**
 * The prebuilt play scripts at stable, digest-keyed URLs.
 *
 * The preview origin's play page loads three prebuilt scripts from the
 * preview directory: the game bundle (`preview-m3.js`, served as `game.js`),
 * the simulation worker (`sim-worker.js`) and the 3D physics backend
 * (`physics-3d.js`, loaded by a 3D project next to the worker's script).
 * Before, the bundle was served under each Play's own locator (a new URL per
 * Play: the browser downloaded and compiled 8.8 MB again every time) and the
 * worker scripts without cache headers.
 *
 * Here they are one "play build": read from disk once while the files are
 * unchanged (size and modification time; a rebuild of `dist/` is picked up
 * on the next read), each hashed once, and served under
 * `/play-build/<buildDigest>/<name>` — the digest of the three files'
 * digests. Those URLs never change meaning, so they are served `immutable`
 * with an `ETag` (the file's SHA-256): the browser's HTTP cache and its code
 * cache hit from the second Play on. The previous build stays servable (a
 * page that started before a rebuild still loads its worker).
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { sha256HexBytes } from './play-content';

/** The URL prefix of a play build's files (preview origin). */
export const PLAY_BUILD_PREFIX = '/play-build/';

/** Largest file of a play build (the bundle is ~9 MB). */
const PLAY_BUILD_FILE_MAX_BYTES = 33_554_432;

/** The served name → the file in the preview directory, and whether a build needs it. */
const FILES: readonly { readonly name: string; readonly file: string; readonly required: boolean }[] = [
  { name: 'game.js', file: 'preview-m3.js', required: true },
  { name: 'sim-worker.js', file: 'sim-worker.js', required: false },
  { name: 'physics-3d.js', file: 'physics-3d.js', required: false },
];

export interface PlayBuildFile {
  readonly name: string;
  readonly bytes: Uint8Array;
  /** SHA-256 of the bytes (lowercase hex; the `ETag`). */
  readonly digest: string;
  readonly contentType: string;
}

export interface PlayBuild {
  /** SHA-256 over the files' names and digests: the URL key. */
  readonly digest: string;
  /** `/play-build/<digest>/`. */
  readonly root: string;
  readonly files: ReadonlyMap<string, PlayBuildFile>;
}

export interface PlayBuildCache {
  /** The current build (files re-read only when changed on disk); null without a readable bundle. */
  current(): PlayBuild | null;
  /** A build by its digest (the current one or the one before it). */
  get(digest: string): PlayBuild | null;
  /** Files read from disk so far (tests: once per change). */
  readonly reads: () => number;
}

export function createPlayBuildCache(dir: string): PlayBuildCache {
  const seen = new Map<string, { size: number; mtimeMs: number; file: PlayBuildFile }>();
  let build: PlayBuild | null = null;
  let previous: PlayBuild | null = null;
  let reads = 0;

  const readFile = (entry: (typeof FILES)[number]): PlayBuildFile | null | 'missing' => {
    const path = join(dir, entry.file);
    try {
      if (!existsSync(path)) return 'missing';
      const st = statSync(path);
      if (!st.isFile()) return 'missing';
      const hit = seen.get(entry.name);
      if (hit !== undefined && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.file;
      const bytes = new Uint8Array(readFileSync(path));
      reads += 1;
      if (bytes.length === 0 || bytes.length > PLAY_BUILD_FILE_MAX_BYTES) return null;
      const file: PlayBuildFile = { name: entry.name, bytes, digest: sha256HexBytes(bytes), contentType: 'text/javascript; charset=utf-8' };
      seen.set(entry.name, { size: st.size, mtimeMs: st.mtimeMs, file });
      return file;
    } catch {
      return null;
    }
  };

  const current = (): PlayBuild | null => {
    const files = new Map<string, PlayBuildFile>();
    for (const entry of FILES) {
      const f = readFile(entry);
      if (f === null || f === 'missing') {
        if (entry.required) return null;
        seen.delete(entry.name);
        continue;
      }
      files.set(entry.name, f);
    }
    const listing = [...files.values()].map((f) => `${f.name}:${f.digest}\n`).join('');
    const digest = sha256HexBytes(new TextEncoder().encode(listing));
    if (build === null || build.digest !== digest) {
      previous = build;
      build = { digest, root: `${PLAY_BUILD_PREFIX}${digest}/`, files };
    }
    return build;
  };

  return {
    current,
    get: (digest) => (build?.digest === digest ? build : previous?.digest === digest ? previous : null),
    reads: () => reads,
  };
}

/** `/play-build/<64 hex>/<name>` → its parts, else null. */
export function parsePlayBuildPath(path: string): { digest: string; name: string } | null {
  if (!path.startsWith(PLAY_BUILD_PREFIX)) return null;
  const rest = path.slice(PLAY_BUILD_PREFIX.length).split('/');
  if (rest.length !== 2) return null;
  const [digest, name] = rest as [string, string];
  if (!/^[0-9a-f]{64}$/.test(digest) || !FILES.some((f) => f.name === name)) return null;
  return { digest, name };
}

/** Whether a request's `If-None-Match` names this entity tag (a weak or strong match, or `*`). */
export function etagMatches(header: string | string[] | undefined, etag: string): boolean {
  if (header === undefined) return false;
  const value = Array.isArray(header) ? header.join(',') : header;
  return value.split(',').some((t) => {
    const tag = t.trim();
    return tag === '*' || tag === etag || tag === `W/${etag}`;
  });
}
