/**
 * What the light volume reads of the materials' looks, kept in step with them: each kept level-0 brick's colours and
 * glow words written from the chunks' grids (voxel-light-volume-colours.ts), the glow words only where a cell glows
 * (a world without glowing materials uploads none and its update reads none), and a record edit held against what
 * each voxel id gave the volume before: the chunks are looked through in the volume's slice for the ids whose bounce
 * colours or glow changed, and the bricks holding the cells beside them are written again and their reach marked.
 */
import { MATERIAL_BITS } from '@thirdlight/voxel';

import { VolumeColourCache, volumeBrickColours, volumeBrickGlows, volumeLookKey, volumeMaterialBricks, type VolumeBounceMeans, type VolumeChunkGrid } from './voxel-light-volume-colours';
import { VOLUME_BRICK_VOLUME } from './voxel-light-volume-layout';
import type { VoxelMaterialLook } from './voxel-surface';

/** A kept brick as the looks write it. */
export interface VolumeLookBrick {
  readonly bx: number;
  readonly by: number;
  readonly bz: number;
  readonly slot: number;
}

/** Where the words go: a slot's 64 colour words and its 64 glow words. */
export interface VolumeLookWriter {
  writeAlbedo(slot: number, words: Uint32Array): void;
  writeGlow(slot: number, words: Uint32Array): void;
}

export class VolumeLookWatch {
  /** What each voxel id's look gave the volume when last looked at (null: not yet). */
  private keys: string[] | null = null;
  /** Chunks to look through for the ids a record edit changed (an edit while one waits adds its ids). */
  private readonly pending = new Map<string, Set<number>>();
  /** Slots whose glow words are not all 0. */
  private readonly glowSlots = new Set<number>();
  /** Record edits that changed what the volume reads, and the ids the last one changed. */
  edits = 0;
  lastIds = 0;

  /** Chunks waiting to be looked through. */
  get waiting(): number {
    return this.pending.size;
  }

  /** Some kept cell glows (the update's rays read the glow words only then). */
  get glowing(): boolean {
    return this.glowSlots.size > 0;
  }

  /**
   * The looks as they read now held against those last looked at: the chunks `grids` holds are queued for the ids
   * that changed (none the first time, or after {@link forget}). The ids changed.
   */
  changed(look: (material: number) => VoxelMaterialLook, means: VolumeBounceMeans | null, grids: Iterable<string>): number {
    const ids = 2 ** MATERIAL_BITS;
    const keys = new Array<string>(ids);
    for (let m = 1; m < ids; m++) keys[m] = volumeLookKey(look(m), means?.get(m) ?? null);
    const was = this.keys;
    this.keys = keys;
    if (was === null) return 0;
    const changed = new Set<number>();
    for (let m = 1; m < ids; m++) if (keys[m] !== was[m]) changed.add(m);
    if (changed.size === 0) return 0;
    for (const key of grids) {
      const had = this.pending.get(key);
      if (had === undefined) this.pending.set(key, new Set(changed));
      else for (const m of changed) had.add(m);
    }
    this.edits++;
    this.lastIds = changed.size;
    return changed.size;
  }

  /** Nothing held (every brick is written again anyway): the next {@link changed} only takes the looks as they are. */
  forget(): void {
    this.keys = null;
    this.pending.clear();
  }

  /**
   * Chunks looked through while `more()` says so (one at least): for each, the level-0 bricks (world bricks lo … hi)
   * holding the cells beside a changed material are handed to `found`.
   */
  drain(more: () => boolean, grids: ReadonlyMap<string, VolumeChunkGrid>, found: (lo: readonly number[], hi: readonly number[]) => void): void {
    let n = 0;
    for (const [key, ids] of this.pending) {
      if (n > 0 && !more()) return;
      n++;
      this.pending.delete(key);
      const grid = grids.get(key);
      if (grid === undefined) continue;
      const box = volumeMaterialBricks(grid, key.split(',').map(Number), ids);
      if (box !== null) found(box[0], box[1]);
    }
  }

  /** The bricks' colours and glows made and written (a brick that glows nowhere writes no glow unless its slot held one). */
  write(bricks: Iterable<VolumeLookBrick>, grids: ReadonlyMap<string, VolumeChunkGrid>, look: (material: number) => VoxelMaterialLook, means: VolumeBounceMeans | null, gpu: VolumeLookWriter): void {
    const colours = new VolumeColourCache(look, means);
    const words = new Uint32Array(VOLUME_BRICK_VOLUME);
    for (const b of bricks) {
      if (b.slot < 0) continue;
      volumeBrickColours(b.bx, b.by, b.bz, grids, colours, words);
      gpu.writeAlbedo(b.slot, words);
      if (volumeBrickGlows(b.bx, b.by, b.bz, grids, colours, words)) {
        gpu.writeGlow(b.slot, words);
        this.glowSlots.add(b.slot);
      } else if (this.glowSlots.delete(b.slot)) gpu.writeGlow(b.slot, words);
    }
  }
}
