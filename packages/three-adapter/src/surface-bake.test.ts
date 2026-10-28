/**
 * The saved result of the live lighting: a host over a real block layer and
 * a generated building, made resident at one bake level as "Bake lighting"
 * does, saved (pages, tiles, probe tiles) into its PNG files and read back,
 * then drawn by a second host from those files the way WebGL 2 and the low
 * tier draw it: the same tiles on the same blocks, found by the materials'
 * lookup at the same texels — and a tile whose geometry changed since is not
 * drawn from the bake. A live host starts from the same saved light: its
 * tiles and probes take it and only what changed since the bake is stale.
 */
import { describe, expect, it } from 'vitest';
import { BlockGrid, type ArchitectureComponent, type BlockType } from '@thirdlight/runtime';

import { SURFACE_PAGE_TEXELS } from './surface-cache-atlas';
import { SurfaceCacheHost, type SurfaceHostLayer } from './surface-cache-host';
import { opaqueByBlockTypes } from './tracer-sources';
import { SURFACE_READ, lookupSurfaceCpu, packSurfaceLookup } from './surface-cache-lookup';
import { decodeSavedSurface, encodeSavedSurface, savedSurfaceFiles, savedSurfaceFromFiles, type SavedSurfaceLight } from './surface-bake-file';
import { emptyPackedProbeTile } from './probe-pack';
import { ownSavedLight, surfaceKeyOwner } from './adapter-surface-bake';
import { GLOW_LIGHT_MARK } from './surface-highlights';
import type { SavedSurfaceTile } from './surface-cache';
import type { CacheLight } from './surface-changes';

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

function host(grid: BlockGrid, version = 1, relightMs = 0): SurfaceCacheHost {
  const layer: SurfaceHostLayer = { id: 'floor', origin: [0, 0, 0], grid, version, chunks: [['0,0', version], ['1,0', version], ['0,1', version], ['1,1', version]], opaque: OPAQUE };
  return new SurfaceCacheHost({ layers: () => [layer], terrains: () => [], architecture: () => [{ id: 'house', component: ROOM, origin: [2, 1, 30] }], models: () => [], bricks: () => null }, 64 * 1024 * 1024, relightMs);
}

const lamp = (id: string, position: number[], mode: CacheLight['mode']): CacheLight => ({ id, kind: 'point', on: true, position, direction: [0, -1, 0], color: [5, 5, 5], range: 3, cone: 0, penumbra: 0, mode });

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
      lights: [lamp('baked', [15, 1.5, 10], 'baked')],
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
    expect(back.saved.lights).toEqual(saved.lights);

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

  it('a live host starts from the saved light: tiles and probes take it, and only what changed since the bake is stale', () => {
    const baking = host(floor());
    settle(baking, [500, 50, 500]);
    baking.cache.setBakeLevel(0);
    settle(baking, [500, 50, 500]);
    const tiles = baking.savedTiles();
    const pages = Math.max(...tiles.flatMap((t) => t.blocks.map((b) => b.page))) + 1;
    const texels = pattern(pages);
    const live = host(floor(), 1, 1.5);
    // A realtime lamp (never saved) by the floor's middle, and a baked lamp moved 5 m since the bake.
    const realtime = lamp('rt', [5, 1.5, 5], 'realtime');
    const baked = lamp('baked', [15, 1.5, 15], 'baked');
    live.setLights([realtime, baked]);
    const probeLight = Float32Array.from({ length: 12 }, (_, k) => (k < 3 ? 0.5 : 0));
    settle(live, [10, 2, 10], false);
    // The light goes live with the saved light to start from: the resident tiles take it on the next frame.
    live.setLive(true);
    live.seeding.set({ tiles: new Map<string, SavedSurfaceTile>(tiles.map((t) => [t.key, t])), texels, probes: () => null, lights: [lamp('baked', [15, 1.5, 10], 'baked')] });
    live.update([10, 2, 10]);
    // What waits for light: still stale, or planned this frame (no pass runs here).
    const planned = new Set(live.slicesThisFrame().map((sl) => sl.unit.key));
    const waits = (k: string): boolean => live.relight.isStale(k) || planned.has(k);
    // The tiles at the bake's level took the saved blocks; their units are stale only within the lamps' reach.
    const seeded = tiles.filter((t) => live.cache.levelOf(t.key) === 0);
    expect(seeded.length).toBeGreaterThan(0);
    expect(live.seeding.seededTiles).toBeGreaterThanOrEqual(seeded.length);
    const copies = live.seeding.take().copies;
    for (const t of seeded) {
      const r = live.cache.residentOf(t.key)!;
      for (let i = 0; i < t.blocks.length; i += 1) expect(copies.some((c) => c.to === r.blocks[i] && c.from.page === t.blocks[i]!.page && c.from.x === t.blocks[i]!.x && c.from.y === t.blocks[i]!.y && c.texels === texels)).toBe(true);
    }
    const all = live.relight.unitsIn([-1e9, -1e9, -1e9], [1e9, 1e9, 1e9]);
    const onSeeded = all.filter((k) => seeded.some((t) => k.startsWith(`${t.key}|`)));
    const near = new Set([...live.relight.unitsNear(realtime.position, 3), ...live.relight.unitsNear(baked.position, 3), ...live.relight.unitsNear([15, 1.5, 10], 3)]);
    const stale = onSeeded.filter(waits);
    expect(onSeeded.length).toBeGreaterThan(stale.length);
    expect(stale.length).toBeGreaterThan(0);
    for (const k of stale) expect(near.has(k), k).toBe(true);
    for (const k of onSeeded) if (live.relight.unitsNear(realtime.position, 3).includes(k)) expect(waits(k), k).toBe(true);
    for (const k of onSeeded) if (live.relight.unitsNear([15, 1.5, 10], 3).includes(k)) expect(waits(k), k).toBe(true);

    // Probes: each placed probe takes its grid's saved light and is settled, but where the realtime lamp reaches.
    // Placed a share of a frame at a time, after a short wait for the tiles.
    let t = performance.now();
    for (let i = 0; i < 400 && live.probes.count === 0; i += 1) live.update([10, 2, 10], (t += 50));
    expect(live.probes.count).toBeGreaterThan(0);
    const grids = new Map(live.probes.grids.map((g) => [`live:${g.key}`, g]));
    live.seeding.set({ tiles: new Map(), texels, lights: [lamp('baked', [15, 1.5, 15], 'baked')], probes: (key) => {
      const g = grids.get(key);
      return g === undefined ? null : { min: g.min, max: g.max, resolution: g.resolution, read: (_l, light) => (light.set(probeLight), { filled: false }) };
    } });
    const layout = live.probes.layout;
    live.update([10, 2, 10], (t += 50));
    expect(live.seeding.seededProbes).toBeGreaterThan(0);
    // Probes that took saved light are laid out again: the GPU's records are uploaded only on a new layout.
    expect(live.probes.layout).not.toBe(layout);
    const P = live.probes.positions;
    let staleFar = 0;
    let lit = 0;
    for (let i = 0; i < live.probes.count; i += 1) {
      if (!live.probes.probeLit(i)) continue;
      lit += 1;
      expect(live.probes.state[i * 24]).toBeCloseTo(0.5, 6);
      const d = Math.max(...[0, 1, 2].map((k) => Math.abs(P[i * 3 + k]! - realtime.position[k]!)));
      if (d > 3 && live.probes.probeWeight(i) === 0) staleFar += 1;
    }
    expect(lit).toBeGreaterThan(0);
    expect(staleFar).toBe(0);
    expect(live.probes.diagnostics().stale).toBeLessThan(lit);
    expect(live.probes.diagnostics().stale).toBeGreaterThan(0);
  });

  it('a live start marks round what the scene lost or gained since the bake: a tile gone (where its saved box was), a tile new', () => {
    const floorLayer: SurfaceHostLayer = { id: 'floor', origin: [0, 0, 0], grid: floor(), version: 1, chunks: [['0,0', 1], ['1,0', 1], ['0,1', 1], ['1,1', 1]], opaque: OPAQUE };
    const pillar = new BlockGrid({ cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [4, 4, 4] } });
    for (let y = 0; y < 4; y += 1) pillar.set(0, y, 0, { block: 'rock' });
    const pillarAt = (id: string, origin: number[]): SurfaceHostLayer => ({ id, origin, grid: pillar, version: 1, chunks: [['0,0', 1]], opaque: OPAQUE });
    const hostOf = (layers: SurfaceHostLayer[], relightMs: number): SurfaceCacheHost => new SurfaceCacheHost({ layers: () => layers, terrains: () => [], architecture: () => [], models: () => [], bricks: () => null }, 64 * 1024 * 1024, relightMs);
    // Baked: the floor with a pillar on it.
    const baking = hostOf([floorLayer, pillarAt('pillar', [2, 1, 2])], 0);
    settle(baking, [500, 50, 500]);
    baking.cache.setBakeLevel(0);
    settle(baking, [500, 50, 500]);
    const tiles = baking.savedTiles();
    expect(tiles.find((t) => t.key.startsWith('pillar/'))?.min).toBeDefined();
    const pages = Math.max(...tiles.flatMap((t) => t.blocks.map((b) => b.page))) + 1;
    const texels = pattern(pages);
    /** A live host of `layers` started from the bake. */
    const liveFrom = (layers: SurfaceHostLayer[]): SurfaceCacheHost => {
      const live = hostOf(layers, 1.5);
      settle(live, [10, 2, 10], false);
      live.setLive(true);
      live.seeding.set({ tiles: new Map<string, SavedSurfaceTile>(tiles.map((t) => [t.key, t])), texels, probes: () => null, lights: [] });
      live.update([10, 2, 10]);
      expect(live.seeding.seededTiles).toBeGreaterThan(0);
      return live;
    };
    const waitsNear = (live: SurfaceCacheHost, p: number[]): boolean => {
      const planned = new Set(live.slicesThisFrame().map((sl) => sl.unit.key));
      const units = live.relight.unitsNear(p, 1).filter((k) => k.startsWith('floor/'));
      expect(units.length, `units near ${p.join(',')}`).toBeGreaterThan(0);
      return units.every((k) => live.relight.isStale(k) || planned.has(k));
    };
    // The pillar gone: the floor where it stood is lit again (it was saved in the pillar's shadow and bounce), the far corner keeps the bake.
    const gone = liveFrom([floorLayer]);
    expect(waitsNear(gone, [3.5, 1, 3.5])).toBe(true);
    expect(waitsNear(gone, [19.5, 1, 19.5])).toBe(false);
    // A second pillar added: the floor round it is lit again, the floor far from both keeps the bake.
    const added = liveFrom([floorLayer, pillarAt('pillar', [2, 1, 2]), pillarAt('pillar-2', [15, 1, 15])]);
    expect(waitsNear(added, [16.5, 1, 16.5])).toBe(true);
    expect(waitsNear(added, [3.5, 1, 12])).toBe(false);
    // As baked: neither waits.
    const same = liveFrom([floorLayer, pillarAt('pillar', [2, 1, 2])]);
    expect(waitsNear(same, [3.5, 1, 3.5])).toBe(false);
    expect(waitsNear(same, [16.5, 1, 16.5])).toBe(false);
  });

  it('saves one scene of the loaded ones: its tiles on their own pages, the probes over them, its own lights', () => {
    // Two scenes open: a floor (this scene) and a yard 100 m off (another scene), lit together at one level.
    const yard = floor();
    const layers: SurfaceHostLayer[] = [
      { id: 'floor', origin: [0, 0, 0], grid: floor(), version: 1, chunks: [['0,0', 1], ['1,0', 1], ['0,1', 1], ['1,1', 1]], opaque: OPAQUE },
      { id: 'yard', origin: [100, 0, 0], grid: yard, version: 1, chunks: [['0,0', 1], ['1,0', 1], ['0,1', 1], ['1,1', 1]], opaque: OPAQUE },
    ];
    const baking = new SurfaceCacheHost({ layers: () => layers, terrains: () => [], architecture: () => [], models: () => [], bricks: () => null }, 64 * 1024 * 1024, 0);
    settle(baking, [500, 50, 500]);
    baking.cache.setBakeLevel(0);
    settle(baking, [500, 50, 500]);
    const owns = (id: string): boolean => id === 'floor';
    const tiles = baking.savedTiles();
    expect(new Set(tiles.map((t) => surfaceKeyOwner(t.key)))).toEqual(new Set(['floor', 'yard']));
    const pages = Math.max(...tiles.flatMap((t) => t.blocks.map((b) => b.page))) + 1;
    const texels = pattern(pages);
    const probe = (key: string, x: number): SavedSurfaceLight['probes'][number] => ({ key, min: [x, 0, 0], max: [x + 6, 6, 6], resolution: [4, 4, 4], brick: true, validity: new Float32Array(64).fill(1), data: emptyPackedProbeTile([4, 4, 4]).data });
    const own = (baking.preparedTiles() ?? []).filter((t) => owns(surfaceKeyOwner(t.key)));
    const mine = tiles.filter((t) => owns(surfaceKeyOwner(t.key)));
    const all: SavedSurfaceLight = {
      level: 0,
      pages,
      texels,
      tiles: mine,
      probes: [probe('live:b0:0,0,0', 0), probe('live:b0:16,0,0', 100)],
      lights: [lamp('lamp-floor', [5, 1.5, 5], 'baked'), lamp('lamp-yard', [105, 1.5, 5], 'baked'), lamp(`floor${GLOW_LIGHT_MARK}0+`, [8, 1, 8], 'baked')],
    };
    const part = ownSavedLight(all, own, (id) => id === 'floor' || id === 'lamp-floor');
    expect(part.tiles.map((t) => t.key).sort()).toEqual(mine.map((t) => t.key).sort());
    expect(part.probes.map((p) => p.key)).toEqual(['live:b0:0,0,0']);
    expect(part.lights?.map((l) => l.id)).toEqual(['lamp-floor', `floor${GLOW_LIGHT_MARK}0+`]);
    // Only the pages its tiles are on, packed in order; each block holds the texels it was lit with.
    const used = new Set(mine.flatMap((t) => t.blocks.map((b) => b.page)));
    expect(part.pages).toBe(used.size);
    expect(part.pages).toBeLessThan(pages);
    const halves = SURFACE_PAGE_TEXELS * SURFACE_PAGE_TEXELS * 4;
    const at = (tx: Uint16Array, page: number, x: number, y: number): number[] => [...tx.subarray(page * halves + (y * SURFACE_PAGE_TEXELS + x) * 4, page * halves + (y * SURFACE_PAGE_TEXELS + x) * 4 + 4)];
    mine.forEach((t, i) => t.blocks.forEach((b, j) => {
      const nb = part.tiles[i]!.blocks[j]!;
      expect(nb.page).toBeLessThan(part.pages);
      for (const [dx, dy] of [[0, 0], [b.side - 1, b.side - 1]]) expect(at(part.texels, nb.page, nb.x + dx!, nb.y + dy!)).toEqual(at(texels, b.page, b.x + dx!, b.y + dy!));
    }));
  });

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
