/**
 * The bench worlds' generated chunks, cached on disk, so a test that loads a
 * real-scale world reads it instead of generating it on every run (a 512 m
 * hilly square is about 5 s of noise, a 1 km one about 18 s; reading either
 * back is a fraction of that).
 *
 * Where: `benchDir('worlds')` (`~/.cache/thirdlight-voxel-bench/worlds/`), on
 * disk outside the repository, beside the other benches' output.
 *
 * What a file is keyed by, so a stale world is never served:
 * - the grid's `cacheKey` (the generator and every parameter it was given; a
 *   grid without one is never cached),
 * - the area, the chunk edge and the store's name,
 * - the generators' code: a digest of the bundle esbuild builds of the
 *   generator modules and everything they reach, after tree shaking and
 *   without comments. A change to any code that fills a world gives a new
 *   digest, so that world is generated again once, on its next use; a change
 *   elsewhere (or to a comment) keeps the cache. Chosen over a version
 *   constant, which a change could forget to bump.
 * - the V8 serializer's version (payloads are stored with `v8.serialize`, the
 *   structured clone the workers already send them through).
 *
 * A miss generates the area as `loadArea` does, writes the file under a
 * temporary name and renames it into place: two workers filling the same
 * world each write a whole file and one rename wins, never a mix. It prints
 * what it filled and how long it took. Files of the same world under an older
 * digest are removed when a new one is written, so the folder does not grow
 * with every change.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deserialize, serialize } from 'node:v8';
import * as esbuild from 'esbuild';
import type { ChunkPayload, PaletteStore } from '@thirdlight/voxel';
import { benchDir } from './bench-dirs';
import { loadArea } from './regions';
import type { TestGrid } from './world-kit';

const HERE = dirname(fileURLToPath(import.meta.url));
/** Bumped when this file's own layout changes. */
const CACHE_FORMAT = 1;
/** The modules whose code fills a world: the generators and the area loader. */
const GENERATORS = ['./worlds', './regions', './far-landscape'];

/** The cache folder; THIRDLIGHT_WORLD_CACHE moves it (the cache's own tests use a folder of their own). */
export function worldCacheDir(): string {
  return process.env['THIRDLIGHT_WORLD_CACHE'] ?? benchDir('worlds');
}

interface CachedArea {
  readonly chunks: number;
  readonly payloads: Array<[number, number, number, ChunkPayload]>;
}

/** A digest of the code `modules` (resolved from `dir`) run: their bundle, tree-shaken, without comments. */
export function codeDigest(modules: readonly string[], dir: string): string {
  const out = esbuild.buildSync({
    stdin: { contents: modules.map((m) => `export * from '${m}';`).join('\n'), resolveDir: dir, loader: 'ts' },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    legalComments: 'none',
    // This module reaches esbuild itself (features.ts loads through the cache); its code fills no world.
    external: ['esbuild'],
    logLevel: 'silent',
  });
  return createHash('sha256').update(out.outputFiles[0]!.contents).digest('hex').slice(0, 16);
}

let digest: string | undefined;

/** The digest of the generators' code (once a process). */
export function generatorDigest(): string {
  digest ??= codeDigest(GENERATORS, HERE);
  return digest;
}

/** The cache file of one area (a grid with no `cacheKey` has none). */
export function worldCacheFile(g: TestGrid, store: PaletteStore, x0: number, z0: number, x1: number, z1: number): string | null {
  if (g.cacheKey === undefined) return null;
  const world = createHash('sha256').update(JSON.stringify([CACHE_FORMAT, g.cacheKey, store.name, store.grid.edge, x0, z0, x1, z1])).digest('hex').slice(0, 16);
  return join(worldCacheDir(), `${world}-${generatorDigest()}-v8.${process.versions.v8}.bin`);
}

/**
 * `loadArea` (the chunks of `g` over the column area into `store`; returns how many chunks hold anything), read
 * from the cache when it holds the area, else generated and cached.
 */
export function loadAreaCached(g: TestGrid, store: PaletteStore, x0: number, z0: number, x1: number, z1: number): number {
  const file = worldCacheFile(g, store, x0, z0, x1, z1);
  if (file === null) return loadArea(g, store, x0, z0, x1, z1);
  let cached: CachedArea | undefined;
  try {
    cached = deserialize(readFileSync(file)) as CachedArea;
  } catch {
    cached = undefined;
  }
  if (cached !== undefined) {
    for (const [cx, cy, cz, p] of cached.payloads) store.adoptPayload(cx, cy, cz, p);
    return cached.chunks;
  }
  const t = performance.now();
  // The chunks the generator fills are the ones loadArea writes; their payloads are what a hit adopts.
  const filled: Array<[number, number, number]> = [];
  const recording: TestGrid = {
    ...g,
    fill: (grid, cx, cy, cz, out) => {
      const any = g.fill(grid, cx, cy, cz, out);
      if (any) filled.push([cx, cy, cz]);
      return any;
    },
  };
  const chunks = loadArea(recording, store, x0, z0, x1, z1);
  let payloads: CachedArea['payloads'];
  try {
    payloads = filled.map(([cx, cy, cz]) => [cx, cy, cz, store.chunkPayload(cx, cy, cz, true)]);
  } catch {
    return chunks; // a store without record palettes has no payload form: generated, not cached
  }
  write(file, serialize({ chunks, payloads } satisfies CachedArea));
  process.stderr.write(`world cache: generated ${g.cacheKey} (${chunks} chunks) in ${((performance.now() - t) / 1000).toFixed(1)} s into ${file}\n`);
  return chunks;
}

function write(file: string, bytes: Uint8Array): void {
  const dir = worldCacheDir();
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, file);
  // The same area under an older generator digest (or serializer) is never read again.
  const name = file.slice(dir.length + 1);
  const area = name.slice(0, name.indexOf('-'));
  for (const f of readdirSync(dir)) if (f.startsWith(`${area}-`) && f !== name && f.endsWith('.bin')) rmSync(join(dir, f), { force: true });
}
