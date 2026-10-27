/**
 * The saved result of the live lighting: a host over a real block layer and
 * a generated building, made resident at one bake level as "Bake lighting"
 * does, saved (pages, tiles, probe tiles) into its PNG files and read back,
 * then drawn by a second host from those files the way WebGL 2 and the low
 * tier draw it: the same tiles on the same blocks, found by the materials'
 * lookup at the same texels — and a tile whose geometry changed since is not
 * drawn from the bake.
 */
import { describe, expect, it } from 'vitest';
import { BlockGrid, type ArchitectureComponent, type BlockType } from '@thirdlight/runtime';

import { SURFACE_PAGE_TEXELS } from './surface-cache-atlas';
import { SurfaceCacheHost, type SurfaceHostLayer } from './surface-cache-host';
import { opaqueByBlockTypes } from './tracer-sources';
import { SURFACE_READ, lookupSurfaceCpu, packSurfaceLookup } from './surface-cache-lookup';
import { decodeSavedSurface, encodeSavedSurface, savedSurfaceFiles, savedSurfaceFromFiles, type SavedSurfaceLight } from './surface-bake-file';
import { emptyPackedProbeTile } from './probe-pack';
import type { SavedSurfaceTile } from './surface-cache';

const OPAQUE = opaqueByBlockTypes([{ blockId: 'rock', shape: 'full' } as BlockType]);
const path = { points: [[0, 0, 0], [8, 0, 0], [8, 0, 6], [0, 0, 6]] as [number, number, number][], closed: true as const };
const ROOM: ArchitectureComponent = {
  chunkSize: 16,
  profiles: { wall: { points: [[0.15, 0], [0.15, 3], [-0.15, 3], [-0.15, 0]], slots: ['lower_wall', 'bevel', 'upper_wall'] } },
  elements: [
    { id: 'a', kind: 'sweep', path, profile: 'wall', openings: [{ id: 'door', at: 4, width: 1.2, bottom: 0, top: 2.2 }] },
    { id: 'a-floor', kind: 'fill', path, shape: 'flat', slot: 'floor' },
  ],
} as ArchitectureComponent;

function floor(edit = false): BlockGrid {
  const grid = new BlockGrid({ cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [24, 4, 24] } });
  for (let x = 0; x < 20; x += 1) for (let z = 0; z < 20; z += 1) grid.set(x, 0, z, { block: 'rock' });
  for (let y = 1; y < 3; y += 1) grid.set(4, y, 4, { block: 'rock' });
  if (edit) grid.set(18, 1, 18, { block: 'rock' });
  return grid;
}

function host(grid: BlockGrid, version = 1): SurfaceCacheHost {
  const layer: SurfaceHostLayer = { id: 'floor', origin: [0, 0, 0], grid, version, chunks: [['0,0', version], ['1,0', version], ['0,1', version], ['1,1', version]], opaque: OPAQUE };
  return new SurfaceCacheHost({ layers: () => [layer], terrains: () => [], architecture: () => [{ id: 'house', component: ROOM, origin: [2, 1, 30] }], models: () => [], bricks: () => null }, 64 * 1024 * 1024);
}

/** Frames until every surface is made and resident (`all` false: until made, however many are resident). */
function settle(h: SurfaceCacheHost, eye: number[], all = true): void {
  for (let i = 0; i < 400; i += 1) {
    h.update(eye);
    const d = h.diagnostics();
    if (h.preparedTiles() !== null && d.tiles.offered > 0 && (!all || d.tiles.resident === d.tiles.offered)) {
      h.touch();
      h.update(eye);
      return;
    }
  }
  const d = h.diagnostics();
  throw new Error(`the host did not settle: ${JSON.stringify({ prepared: h.preparedTiles() !== null, offered: d.tiles, preparing: d.preparing, reading: d.reading, pages: d.pages, levels: d.levels })}`);
}

/** A texel's value as a bake would hold it: its page, place and a mark (half floats of small integers). */
function pattern(pages: number): Uint16Array {
  const t = new Uint16Array(pages * SURFACE_PAGE_TEXELS * SURFACE_PAGE_TEXELS * 4);
  for (let i = 0; i < t.length / 4; i += 1) {
    t[i * 4] = 0x3c00 + (i % 1024); // 1.0 + a fraction that names the texel
    t[i * 4 + 3] = 0x3c00;
  }
  return t;
}

describe('saved lighting', () => {
  it('bakes every tile at one level, saves pages, tiles and probes into PNG files, and draws them from the files on the same texels', async () => {
    const baking = host(floor());
    // The editor's eye far from everything: a bake's tiles do not follow it.
    settle(baking, [500, 50, 500]);
    const savedBytes = 32 * 1024 * 1024;
    const level = baking.cache.fitLevel(baking.preparedTiles() ?? [], savedBytes);
    expect(level).toBe(0);
    baking.cache.setBakeLevel(level);
    settle(baking, [500, 50, 500]);
    const d = baking.diagnostics();
    expect(d.levels[0]).toBe(d.tiles.resident);
    const tiles = baking.savedTiles();
    expect(tiles.length).toBe(d.tiles.offered);
    expect(tiles.map((t) => t.key).sort()).toEqual(expect.arrayContaining(['floor/0,0', 'floor/1,1', 'house']));
    const pages = Math.max(...tiles.flatMap((t) => t.blocks.map((b) => b.page))) + 1;
    const probe = emptyPackedProbeTile([4, 4, 4]);
    probe.data.forEach((_, i) => (probe.data[i] = i & 0x3fff));
    const saved: SavedSurfaceLight = {
      level: level!,
      pages,
      texels: pattern(pages),
      tiles,
      probes: [{ key: 'live:b0:1,0,2', min: [0, 0, 0], max: [6, 6, 6], resolution: [4, 4, 4], brick: true, validity: new Float32Array(64).fill(1), data: probe.data }],
    };
    const files = await savedSurfaceFiles(encodeSavedSurface(saved));
    expect(files.length).toBe(1);
    const back = await savedSurfaceFromFiles(files);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.saved.level).toBe(level);
    expect(back.saved.pages).toBe(pages);
    expect(back.saved.tiles).toEqual(tiles.map((t) => ({ ...t, blocks: [...t.blocks] })));
    expect(back.saved.texels).toEqual(saved.texels);
    expect(back.saved.probes[0]!.data).toEqual(probe.data);
    expect(back.saved.probes[0]!.brick).toBe(true);

    // A page drawing the saved light (WebGL 2, the low tier): the same tiles on the same blocks, whatever the eye.
    const drawing = host(floor());
    drawing.cache.setSaved(new Map<string, SavedSurfaceTile>(back.saved.tiles.map((t) => [t.key, t])), back.saved.pages);
    settle(drawing, [10, 2, 10]);
    const drawn = new Map(drawing.savedTiles().map((t) => [t.key, t]));
    for (const t of tiles) expect(drawn.get(t.key)?.blocks).toEqual(t.blocks);
    expect(drawing.diagnostics().pages).toBe(pages);
    // The materials' lookup finds a floor pixel's texel on the page and place the bake lit it at.
    const live = packSurfaceLookup(baking.resolveScene().scene, baking.cache, () => undefined);
    const fromFile = packSurfaceLookup(drawing.resolveScene().scene, drawing.cache, () => undefined);
    for (const p of [[2.5, 1, 2.5], [13.3, 1, 7.7], [19.5, 1, 19.5]]) {
      const a = lookupSurfaceCpu(live, SURFACE_READ.blocks, p, [0, 1, 0]);
      const b = lookupSurfaceCpu(fromFile, SURFACE_READ.blocks, p, [0, 1, 0]);
      expect(a).not.toBeNull();
      expect(b).toEqual(a);
    }
    // Seven pages through the PNG encoder and back take a few seconds, more on a loaded host.
  }, 60_000);

  it('does not draw a tile from the bake once its geometry changed (it keeps its per-pixel light), and refuses a damaged file', async () => {
    const baking = host(floor());
    settle(baking, [0, 0, 0]);
    baking.cache.setBakeLevel(1);
    settle(baking, [0, 0, 0]);
    const tiles = baking.savedTiles();
    expect(tiles.every((t) => t.level === 1)).toBe(true);
    // A block added in chunk (1,1) since the bake: that chunk's charts differ.
    const drawing = host(floor(true), 2);
    drawing.cache.setSaved(new Map<string, SavedSurfaceTile>(tiles.map((t) => [t.key, t])), Math.max(...tiles.flatMap((t) => t.blocks.map((b) => b.page))) + 1);
    settle(drawing, [1, 1, 1], false);
    const drawn = new Set(drawing.savedTiles().map((t) => t.key));
    expect(drawn.has('floor/1,1')).toBe(false);
    expect(drawn.has('floor/0,0')).toBe(true);
    expect(drawn.has('house')).toBe(true);
    const bytes = encodeSavedSurface({ level: 1, pages: 0, texels: new Uint16Array(0), tiles, probes: [] });
    expect(decodeSavedSurface(bytes.subarray(0, 20)).ok).toBe(false);
    bytes[4] = 9;
    expect(decodeSavedSurface(bytes).ok).toBe(false);
  }, 60_000);
});
