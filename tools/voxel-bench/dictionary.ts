/**
 * A zstd raw-content dictionary for a candidate's chunk bytes: encoded
 * chunks of small test worlds at seeds the measured worlds do not use, so
 * the dictionary has never seen the chunks it then compresses (as an engine
 * dictionary shipped with the runtime would not have seen a game's world).
 */
import type { ChunkGrid, VoxelStoreFactory } from '@thirdlight/voxel';
import { sweepWorld } from './sweep';
import { townWorld } from './town';
import { cavesWorld, hillyWorld, plainWorld, verticalWorld } from './worlds';

/** zstd's guidance for dictionary size (about 100 KB). */
export const DICTIONARY_BYTES = 110_000;

/** Seeds offset from every world's default, so no measured chunk is in the dictionary. */
const OTHER_SEED = 1000;

/** The dictionary for one candidate and chunk edge: non-uniform chunks picked evenly from each sample world. */
export function buildDictionary(factory: VoxelStoreFactory, grid: ChunkGrid, size = DICTIONARY_BYTES): Uint8Array {
  const worlds = [
    plainWorld({ seed: 11 + OTHER_SEED, footprint: 128 }),
    hillyWorld({ seed: 23 + OTHER_SEED, footprint: 256 }),
    townWorld({ seed: 71 + OTHER_SEED, footprint: 160 }),
    cavesWorld({ seed: 37 + OTHER_SEED, footprint: 96 }),
    verticalWorld({ seed: 53 + OTHER_SEED, footprint: 96 }),
  ];
  const per = Math.floor(size / worlds.length);
  const parts: Uint8Array[] = [];
  for (const world of worlds) {
    const chunks: Uint8Array[] = [];
    // A uniform chunk's bytes are a dozen and say nothing a dictionary could reuse.
    sweepWorld(world, factory, grid, undefined, undefined, undefined, { codecs: [], corpus: (b) => (b.length > 16 ? chunks.push(b.slice()) : 0) });
    const total = chunks.reduce((s, c) => s + c.length, 0);
    // Every step-th chunk: about `per` bytes spread over the whole world.
    const step = Math.max(1, Math.floor(total / per));
    let budget = per;
    for (let k = 0; k < chunks.length && budget > 0; k += step) {
      const c = chunks[k]!.subarray(0, budget);
      parts.push(c);
      budget -= c.length;
    }
  }
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
