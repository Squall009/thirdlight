/**
 * A bench's world chunks into a store, on demand: read from a world's region files on disk (staging's 8 km world,
 * the cave dug in it), or generated (a synthetic test world). Engine-owned bench helpers; nothing is written.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chunkGrid, createDenseChunk, RegionChunkSource, WORLD_GRID_ID, type PaletteStore } from '@thirdlight/voxel';
import { importRead } from '@thirdlight/workspace';

import { DiskRegions } from './stream-node';
import type { TestWorld } from './world-kit';

const grid = chunkGrid(32);

/** The world's chunks into a store, on demand: read from its region files, or generated. */
export interface ChunkFeed {
  ensure(chunks: Array<[number, number, number]>): Promise<void>;
}

export function generatedFeed(world: TestWorld, store: PaletteStore): ChunkFeed {
  const g = world.grids[0]!;
  const d = createDenseChunk(grid);
  const done = new Set<string>();
  return {
    async ensure(chunks) {
      for (const [cx, cy, cz] of chunks) {
        const k = `${cx},${cy},${cz}`;
        if (done.has(k)) continue;
        done.add(k);
        if (g.fill(grid, cx, cy, cz, d)) store.importChunk(cx, cy, cz, d);
      }
    },
  };
}

export function diskFeed(dir: string, store: PaletteStore): ChunkFeed {
  const meta = JSON.parse(readFileSync(join(dir, 'world.json'), 'utf8')) as { worldId: string; layout: 'stacked' | 'column'; footprint: 512 };
  const worldId = Uint8Array.from(meta.worldId.match(/../g)!.map((h) => parseInt(h, 16)));
  const disk = new DiskRegions(join(dir, 'grid-0'));
  const src = new RegionChunkSource({ worldId, gridId: WORLD_GRID_ID, grid, layout: meta.layout, footprint: meta.footprint, open: (n) => disk.open(n), maxOpen: 64 });
  const done = new Set<string>();
  return {
    async ensure(chunks) {
      const want = chunks.filter(([cx, cy, cz]) => !done.has(`${cx},${cy},${cz}`)).map(([cx, cy, cz]) => ({ cx, cy, cz }));
      for (const c of want) done.add(`${c.cx},${c.cy},${c.cz}`);
      for (let i = 0; i < want.length; i += 256) {
        for (const r of await src.read(want.slice(i, i + 256))) {
          if (r.kind === 'damaged') throw new Error(`chunk ${r.cx},${r.cy},${r.cz}: ${r.reason}`);
          importRead(store, r);
        }
      }
    },
  };
}

