/**
 * The point sets of a block layer's cover rule as the GPU reads them
 * (`cover-gpu.ts` draws them): one float texture per rule holding every
 * chunk's points that the view reaches, in blocks of
 * {@link COVER_POINT_BLOCK}, and the blocks each ring lists per frame.
 *
 * A chunk's set is asked for when the view's reach first meets the chunk,
 * baked off the main thread, and asked again when its ground changes (the
 * old one drawn until the new one arrives); sets of chunks the view left are
 * let go after a while. A set's points are sorted by threshold, so a ring,
 * which keeps at most the share at its inner edge, lists only the blocks
 * holding that prefix.
 */
import * as THREE from 'three';
import { COVER_POINT_FLOATS, coverPointsBelow, type CoverPointSet } from '@thirdlight/runtime';

import type { CoverRing } from './cover-placement';

/** Points a block holds (a listed block is one entry of a ring's list; a draw's instance is a point of one). */
export const COVER_POINT_BLOCK = 256;
/** Texels a row of the point texture holds. */
export const COVER_POINT_ROW = 1024;
/** Blocks a rule's point texture starts with (doubled when full). */
const BLOCKS_START = 64;
/** Frames a chunk's set is kept after the view's reach last met it. */
const POINTS_KEEP_FRAMES = 300;

/** One chunk's set of one rule. */
interface PointEntry {
  readonly cx: number;
  readonly cz: number;
  set: CoverPointSet | null;
  /** The blocks its points fill, in order. */
  slots: number[];
  /** Arrived; asked again (an answer on the way is the one wanted). */
  stale: boolean;
  asked: boolean;
  token: number;
  used: number;
}

/** A rule's point sets: the texture its draws read and the chunks it holds. */
export class CoverPointAtlas {
  texture: THREE.DataTexture;
  private blocks: number;
  private readonly free: number[] = [];
  readonly entries = new Map<string, PointEntry>();

  constructor() {
    this.blocks = BLOCKS_START;
    this.texture = pointTexture(new Float32Array(BLOCKS_START * COVER_POINT_BLOCK * COVER_POINT_FLOATS));
    for (let b = BLOCKS_START - 1; b >= 0; b--) this.free.push(b);
  }

  /** Blocks the texture holds (a ring's list is no longer). */
  get capacity(): number {
    return this.blocks;
  }

  /** The entry of chunk (cx, cz), made when first asked for. */
  entry(cx: number, cz: number, frame: number): PointEntry {
    const key = `${cx},${cz}`;
    let e = this.entries.get(key);
    if (e === undefined) this.entries.set(key, (e = { cx, cz, set: null, slots: [], stale: true, asked: false, token: 0, used: frame }));
    e.used = frame;
    return e;
  }

  /** A set arrived: its points put in blocks (the old ones freed). True: the texture grew (draws read the new one). */
  store(e: PointEntry, set: CoverPointSet | null): boolean {
    for (const s of e.slots) this.free.push(s);
    e.slots = [];
    e.set = set;
    e.stale = false;
    e.asked = false;
    if (set === null || set.count === 0) return false;
    const need = Math.ceil(set.count / COVER_POINT_BLOCK);
    let grew = false;
    if (this.free.length < need) {
      let blocks = this.blocks;
      while (blocks - this.blocks + this.free.length < need) blocks *= 2;
      const data = new Float32Array(blocks * COVER_POINT_BLOCK * COVER_POINT_FLOATS);
      data.set(this.texture.image.data as Float32Array);
      this.texture.dispose();
      this.texture = pointTexture(data);
      for (let b = blocks - 1; b >= this.blocks; b--) this.free.push(b);
      this.blocks = blocks;
      grew = true;
    }
    const data = this.texture.image.data as Float32Array;
    const per = COVER_POINT_BLOCK * COVER_POINT_FLOATS;
    for (let k = 0; k < need; k++) {
      const slot = this.free.pop()!;
      e.slots.push(slot);
      data.set(set.data.subarray(k * per, Math.min(set.data.length, (k + 1) * per)), slot * per);
    }
    this.texture.needsUpdate = true;
    return grew;
  }

  /** The chunk's set is made again (its ground changed): its old one stays drawn until the new one arrives. */
  invalidate(e: PointEntry): void {
    e.stale = true;
    e.asked = false;
    e.token += 1;
  }

  /** Let go of the sets of chunks the view's reach has not met for a while. */
  forget(frame: number): void {
    for (const [key, e] of this.entries) {
      if (frame - e.used <= POINTS_KEEP_FRAMES) continue;
      for (const s of e.slots) this.free.push(s);
      this.entries.delete(key);
    }
  }

  dispose(): void {
    this.texture.dispose();
  }
}

function pointTexture(data: Float32Array): THREE.DataTexture {
  const rows = data.length / COVER_POINT_FLOATS / COVER_POINT_ROW;
  const tex = new THREE.DataTexture(data, COVER_POINT_ROW, rows, THREE.RGBAFormat, THREE.FloatType);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Write the blocks ring `ring` draws of chunk entry `e` into `out` from
 * entry `n` (4 floats each: block, points in it, chunk x and z); returns the
 * entries written so far. Only the points whose threshold is under the
 * ring's most kept share are listed.
 */
export function listCoverPointBlocks(ring: CoverRing, e: { readonly cx: number; readonly cz: number; readonly set: CoverPointSet | null; readonly slots: readonly number[] }, out: Float32Array, n: number): number {
  if (e.set === null) return n;
  const points = coverPointsBelow(e.set, ring.gridShare);
  for (let k = 0; k * COVER_POINT_BLOCK < points && n * 4 < out.length; k++, n++) {
    out[n * 4] = e.slots[k]!;
    out[n * 4 + 1] = Math.min(COVER_POINT_BLOCK, points - k * COVER_POINT_BLOCK);
    out[n * 4 + 2] = e.cx;
    out[n * 4 + 3] = e.cz;
  }
  return n;
}
