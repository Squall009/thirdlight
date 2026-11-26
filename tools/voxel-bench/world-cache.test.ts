/**
 * The world cache (world-cache.ts): a cached area holds what the generator
 * writes, chunk by chunk; a second load reads it without generating; the key
 * tells areas, parameters and stores apart; the code digest moves with the
 * code a world is filled by and not with its comments; an older digest's file
 * goes when the new one is written; a grid without a key is never cached.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chunkGrid, chunkOfKey, createDenseChunk, createWorldStore, exportOrAir, sameDenseChunk, type PaletteStore } from '@thirdlight/voxel';
import { loadArea } from './regions';
import { codeDigest, generatorDigest, loadAreaCached, worldCacheDir, worldCacheFile } from './world-cache';
import type { TestGrid } from './world-kit';
import { hillyWorld, townWorld } from './worlds';

const grid = chunkGrid(32);
let dir = '';
let before: string | undefined;

beforeAll(() => {
  before = process.env['THIRDLIGHT_WORLD_CACHE'];
  dir = mkdtempSync(join(tmpdir(), 'tl-world-cache-'));
  process.env['THIRDLIGHT_WORLD_CACHE'] = join(dir, 'cache');
});
afterAll(() => {
  if (before === undefined) delete process.env['THIRDLIGHT_WORLD_CACHE'];
  else process.env['THIRDLIGHT_WORLD_CACHE'] = before;
  rmSync(dir, { recursive: true, force: true });
});

/** `g` with its fill calls counted. */
function counted(g: TestGrid): { grid: TestGrid; calls: () => number } {
  let n = 0;
  return { grid: { ...g, fill: (gr, cx, cy, cz, out) => (n++, g.fill(gr, cx, cy, cz, out)) }, calls: () => n };
}

function expectSameStores(a: PaletteStore, b: PaletteStore): number {
  const keys = new Set([...a.chunkKeys(), ...b.chunkKeys()]);
  const da = createDenseChunk(grid);
  const db = createDenseChunk(grid);
  for (const k of keys) {
    const c = chunkOfKey(grid, k);
    exportOrAir(a, c.cx, c.cy, c.cz, da);
    exportOrAir(b, c.cx, c.cy, c.cz, db);
    expect(sameDenseChunk(da, db), `chunk ${c.cx},${c.cy},${c.cz}`).toBe(true);
  }
  return keys.size;
}

describe('the world cache', () => {
  it('serves the generated chunks: a miss generates and stores them, a hit reads them back without generating', () => {
    const town = townWorld({ footprint: 96 }).grids[0]!;
    const truth = createWorldStore(grid);
    const n = loadArea(town, truth, 0, 0, 96, 96);
    const first = counted(town);
    const a = createWorldStore(grid);
    expect(loadAreaCached(first.grid, a, 0, 0, 96, 96)).toBe(n);
    expect(first.calls()).toBeGreaterThan(0);
    expect(expectSameStores(truth, a)).toBeGreaterThan(0);
    const second = counted(town);
    const b = createWorldStore(grid);
    expect(loadAreaCached(second.grid, b, 0, 0, 96, 96)).toBe(n);
    expect(second.calls()).toBe(0);
    expectSameStores(truth, b);
    expect(b.memoryBytes()).toBe(truth.memoryBytes());
  });

  it('keys an area by the generator and its parameters, the area, the chunk edge and the store', () => {
    const store = createWorldStore(grid);
    const g = hillyWorld({ footprint: 64 }).grids[0]!;
    const file = worldCacheFile(g, store, -32, -32, 32, 32);
    expect(file).toContain(worldCacheDir());
    expect(file).toContain(generatorDigest());
    const others = [
      worldCacheFile(hillyWorld({ footprint: 64, seed: 24 }).grids[0]!, store, -32, -32, 32, 32),
      worldCacheFile(hillyWorld({ footprint: 128 }).grids[0]!, store, -32, -32, 32, 32),
      worldCacheFile(g, store, -32, -32, 32, 0),
      worldCacheFile(g, createWorldStore(chunkGrid(16)), -32, -32, 32, 32),
      worldCacheFile(g, createWorldStore(grid, 'other'), -32, -32, 32, 32),
    ];
    expect(new Set([file, ...others]).size).toBe(6);
    expect(worldCacheFile(hillyWorld({ footprint: 64 }).grids[0]!, createWorldStore(grid), -32, -32, 32, 32)).toBe(file);
  });

  it('never caches a grid without a key', () => {
    const { cacheKey: _, ...plain } = townWorld({ footprint: 64 }).grids[0]!;
    const g = counted(plain as TestGrid);
    expect(worldCacheFile(g.grid, createWorldStore(grid), 0, 0, 64, 64)).toBeNull();
    loadAreaCached(g.grid, createWorldStore(grid), 0, 0, 64, 64);
    const calls = g.calls();
    loadAreaCached(g.grid, createWorldStore(grid), 0, 0, 64, 64);
    expect(g.calls()).toBe(2 * calls);
  });

  it('digests the code a world is filled by: a changed body changes it, a changed comment or an unused export does not', () => {
    const src = join(dir, 'src');
    mkdirSync(src, { recursive: true });
    const write = (gen: string, helper: string): string => {
      writeFileSync(join(src, 'gen.ts'), gen);
      writeFileSync(join(src, 'helper.ts'), helper);
      return codeDigest(['./gen'], src);
    };
    const helper = 'export function height(x: number): number { return x * 2; }\nexport function unused(): number { return 1; }\n';
    const base = write("import { height } from './helper';\nexport function fill(x: number): number { return height(x) + 1; }\n", helper);
    expect(write("import { height } from './helper';\n// a comment\nexport function fill(x: number): number { return height(x) + 1; }\n", helper)).toBe(base);
    expect(write("import { height } from './helper';\nexport function fill(x: number): number { return height(x) + 1; }\n", helper.replace('return 1', 'return 2'))).toBe(base);
    expect(write("import { height } from './helper';\nexport function fill(x: number): number { return height(x) + 1; }\n", helper.replace('x * 2', 'x * 3'))).not.toBe(base);
    expect(write("import { height } from './helper';\nexport function fill(x: number): number { return height(x) + 2; }\n", helper)).not.toBe(base);
  });

  it('removes the same area\'s file of an older digest when it writes a new one', () => {
    const g = townWorld({ footprint: 64 }).grids[0]!;
    const store = createWorldStore(grid);
    const file = worldCacheFile(g, store, 0, 0, 64, 64)!;
    const name = file.slice(file.lastIndexOf('/') + 1);
    const stale = name.replace(generatorDigest(), '0000000000000000');
    mkdirSync(worldCacheDir(), { recursive: true });
    writeFileSync(join(worldCacheDir(), stale), 'old');
    loadAreaCached(g, store, 0, 0, 64, 64);
    const files = readdirSync(worldCacheDir());
    expect(files).toContain(name);
    expect(files).not.toContain(stale);
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
  });
});
