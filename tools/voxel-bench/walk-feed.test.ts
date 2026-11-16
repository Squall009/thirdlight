/**
 * The page's walk feed against real boundaries: a streamer deriving with the world rules in `worker_threads`
 * workers from region files on disk (16³ derive sections, a level of mip nodes), two draw batchers on it, one with
 * the feed off and one with it on. Off, no walk block is packed or sent and every other part of the batches is the
 * same; turned on, every block the streamer knows arrives, a slice a task, and is what the per-cell packing gives,
 * byte for byte.
 */
import { join } from 'node:path';
import {
  ChunkDrawBatcher,
  createWorldStore,
  jobRadius,
  packWalkBlock,
  streamerWalkBlocks,
  streamerWalkSource,
  VoxelStreamer,
  WORLD_RULES,
  type ChunkDrawBatch,
  type WalkSource,
} from '@thirdlight/voxel';
import { FRAME_SLICE_DEFAULTS, frameArbiter } from '@thirdlight/shared';
import { describe, expect, it } from 'vitest';
import { DiskRegions } from './stream-node';
import { surfaceY } from './regions';
import { dir, disks, grid, oracle, pool, RING, sleep, useStreamWorld } from './stream-fixture';

useStreamWorld();

/** The same source read cell by cell (its views without their column words): the packing as it was. */
function byCells(src: WalkSource): WalkSource {
  return {
    maxLevel: src.maxLevel,
    blockShift: (l) => src.blockShift(l),
    block: (l, x, y, z, stop) => {
      const v = src.block(l, x, y, z, stop);
      return v === null ? null : { flag: v.flag, brick: (i) => v.brick(i), cell: (i) => v.cell(i) };
    },
  };
}

/** What a batch carries besides the walk: its draws, seams, swaps and far changes, as keys and sizes. */
function drawsOf(batches: readonly ChunkDrawBatch[]): string[] {
  return batches.flatMap((b) => [
    ...b.chunks.map((c) => `${c.kind} ${c.level ?? 0}:${c.cx},${c.cy},${c.cz} ${c.kind === 'draw' ? `${c.ground.vertexCount}/${c.base.vertexCount}/${c.instances.count}` : ''}`),
    ...(b.seams ?? []).map((s) => `seam ${s.kind} ${s.level}:${s.nx},${s.ny},${s.nz},${s.face}`),
    ...b.swaps.map((s) => `swap ${s.chunks}`),
  ]);
}

const key = (w: { level: number; bx: number; by: number; bz: number }): string => `${w.level}:${w.bx},${w.by},${w.bz}`;

describe('the page walk feed (workers, region files on disk)', () => {
  it('packs and sends no walk block while off, and every block known, sliced, once turned on', async () => {
    const disk = new DiskRegions(join(dir, 'world'));
    disks.push(disk);
    const s = new VoxelStreamer({ store: createWorldStore(grid), source: disk.source(grid, 'stacked', 512), pool: pool(4), ring: RING, budgetBytes: 256 * 1024 * 1024, dependencyRadius: jobRadius(WORLD_RULES), derive: true, rules: WORLD_RULES, sectionEdge: 16, deriveMsPerUpdate: 10_000, mips: [{ level: 1, radius: 64 }] });
    const walk = { source: streamerWalkSource(s), blocks: () => streamerWalkBlocks(s) };
    const off: ChunkDrawBatch[] = [];
    const on: ChunkDrawBatch[] = [];
    const quiet = new ChunkDrawBatcher('w', s, 16, (b) => off.push(b), { walk });
    const fed = new ChunkDrawBatcher('w', s, 16, (b) => on.push(b), { walk, walkFeed: 1 });
    // On the ground: chunks the surface crosses hold pages.
    const ground = surfaceY(oracle, 0, 0, 1024, -1024) ?? 0;
    s.setFocus(0, ground, 0);
    await s.settle();
    // The batchers' last packing slices go in later tasks.
    for (let i = 0; i < 200 && fed.walkCounts.packed === 0; i++) await sleep(5);
    await sleep(50);

    expect(quiet.walkCounts).toEqual({ packed: 0, held: 0 });
    expect(off.some((b) => b.walk !== undefined)).toBe(false);
    expect(fed.walkCounts.held).toBeGreaterThan(50);
    // The rest of the batches as with the feed on (the feed's own batches carry walk blocks alone).
    const offDraws = drawsOf(off);
    expect(offDraws.length).toBeGreaterThan(100);
    expect(offDraws).toEqual(drawsOf(on));

    // The blocks known now, as the page's first reader would get them: those that pack (every part derived).
    const src = streamerWalkSource(s);
    const known = new Set<string>();
    let mips = 0;
    for (const [level, x, y, z] of streamerWalkBlocks(s)) {
      if (packWalkBlock(src, level, x, y, z) === null) continue;
      known.add(key({ level, bx: x, by: y, bz: z }));
      if (level > 0) mips++;
    }
    expect(mips).toBeGreaterThan(0);
    expect(known.size).toBe(fed.walkCounts.held);

    const at = off.length;
    const t0 = performance.now();
    // A slice of a block or two (the arbiter's table on this thread), so the blocks go over many tasks.
    frameArbiter.install({ ...FRAME_SLICE_DEFAULTS, voxelDerive: { ...FRAME_SLICE_DEFAULTS.voxelDerive, ms: 0.05 } });
    try {
      quiet.setWalkFeed(2);
      for (let i = 0; i < 400 && quiet.walkCounts.held < known.size; i++) await sleep(5);
    } finally {
      frameArbiter.install(FRAME_SLICE_DEFAULTS);
    }
    const ms = performance.now() - t0;
    const sent = off.slice(at).filter((b) => b.walk !== undefined);
    const got = new Set(sent.flatMap((b) => b.walk!.map(key)));
    console.log(`[walk-feed] ${known.size} blocks known (${mips} mip nodes) sent in ${sent.length} batches over ${ms.toFixed(0)} ms; ${sent.map((b) => b.walk!.length).join(' ')}`);
    expect(got).toEqual(known);
    expect(sent.every((b) => b.walkFeed === 2)).toBe(true);
    // A slice a task: many batches, none holding them all.
    expect(sent.length).toBeGreaterThan(3);
    // Each page as the per-cell packing gives it, byte for byte (derive sections of 16 at level 0, nodes of 32 at 1).
    const slow = byCells(src);
    let pages = 0;
    for (const w of sent.flatMap((b) => b.walk!)) {
      const want = packWalkBlock(slow, w.level, w.bx, w.by, w.bz);
      expect([w.packed?.solid, w.packed?.light], key(w)).toEqual([want?.solid, want?.light]);
      if (want?.page == null) {
        expect(w.packed?.page ?? null).toBeNull();
        continue;
      }
      pages++;
      expect(Buffer.compare(Buffer.from(w.packed!.page!.buffer), Buffer.from(want.page.buffer)), key(w)).toBe(0);
    }
    expect(pages).toBeGreaterThan(10);

    // Off again: nothing more is packed, whatever changes.
    quiet.setWalkFeed(0);
    const packed = quiet.walkCounts.packed;
    s.setFocus(64, ground, 0);
    await s.settle();
    await sleep(50);
    expect(quiet.walkCounts.packed).toBe(packed);
    quiet.close();
    fed.close();
  }, 120_000);
});
