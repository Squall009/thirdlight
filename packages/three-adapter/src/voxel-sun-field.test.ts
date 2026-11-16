/**
 * The sun field's frame against its slice and the camera's speed, counted (no GPU: the march's dispatch and copy go
 * to a renderer that counts them; times are given, never read from the clock):
 *
 * - with the slice spent before anything is done, a frame still does one piece of work, the march's row or (when the
 *   last frame composed none) a tile in its place, never two;
 * - past the streamer's level-0 speed the near window stays where it was (a frame repeating the last pose does not let
 *   it go), composes nothing and reads as no window (the march skips it), and a far node drawn over far tiles already
 *   composed leaves them waiting; once the camera has stopped for the
 *   streamer's stop time it comes to the camera, composes what entered within the slice, its lines
 *   are marched again, and it holds the same tops as a field that never travelled.
 */
import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { DISTANCE_BRICK_INSIDE, SkyColumns, STREAM_DETAIL_SPEED, STREAM_STOPPED_MS, type FarBricks } from '@thirdlight/voxel';

import { SunField, type SunFieldRenderer } from './voxel-sun-field';

const EDGE = 32;
const VOXEL_M = 0.5;
const DIR = new THREE.Vector3(0.3, -1, 0.2).normalize();

/** Sky heights over chunk columns −40 … 40 (a ground that steps from column to column). */
function skies(): SkyColumns {
  const s = new SkyColumns(EDGE);
  const wires = [];
  for (let cx = -40; cx <= 40; cx++) {
    for (let cz = -40; cz <= 40; cz++) {
      const h = new Int16Array(EDGE * EDGE);
      for (let i = 0; i < h.length; i++) h[i] = 40 + (((cx * 7 + cz * 3 + (i >> 5)) & 31) as number);
      wires.push({ cx, cz, heights: h });
    }
  }
  s.apply(wires);
  return s;
}

/** A far node solid through (its tops at its top), no samples needed. */
const SOLID_NODE = { side: 4, bricks: new Int32Array(64).fill(DISTANCE_BRICK_INSIDE), samples: new Uint8Array(0), looks: new Uint16Array(0), blocks: new Uint8Array(0) } as unknown as FarBricks;

function counting(): SunFieldRenderer & { computes: number; copies: number } {
  const r = {
    computes: 0,
    copies: 0,
    compute: () => {
      r.computes++;
    },
    copyTextureToTexture: () => {
      r.copies++;
    },
  };
  return r;
}

/** Frames, each with a slice of `tiles` readings of `more()`, until no tile waits in either window (capped). */
function settle(f: SunField, r: SunFieldRenderer, tiles: number): number {
  let frames = 0;
  while ((f.near.waiting > 0 || f.far.window.waiting > 0) && frames < 10_000) {
    let left = tiles;
    f.frame(() => left-- > 0, r);
    frames++;
  }
  return frames;
}

describe('the sun field a frame', () => {
  const sky = skies();

  it('with the slice spent, does one piece of work a frame: the row, or a tile in its place when the last frame composed none', () => {
    const f = new SunField(EDGE, VOXEL_M, () => [sky]);
    f.setSteps(12);
    const r = counting();
    f.follow(0, 0, DIR, 100, 0);
    const waiting = f.near.waiting + f.far.window.waiting;
    expect(waiting).toBe(2 * 32 * 32);
    for (let i = 0; i < 21; i++) f.frame(() => false, r);
    // Frame 1 has nothing to march yet and composes one tile; then a row and a tile frame about (never both in one).
    expect(r.computes).toBe(10);
    expect(r.copies).toBe(10);
    expect(f.stats.nearTiles + f.stats.farTiles).toBe(11);
    expect(f.near.waiting + f.far.window.waiting).toBe(waiting - 11);
  });

  it('past the level-0 speed the near window stays; after the stop it comes, composes in slices and holds what a field that never moved holds', () => {
    const f = new SunField(EDGE, VOXEL_M, () => [sky]);
    f.setSteps(12);
    const r = counting();
    let t = 0;
    let x = 0;
    f.follow(x, 0, DIR, 100, t);
    settle(f, r, 4096);
    const tileX = f.near.tileX;
    const near = f.stats.nearTiles;
    // 150 m/s at 30 frames a second, 2 s less the frames that repeat a pose: 240 m, 15 of the near window's 16 m tiles.
    expect(150).toBeGreaterThan(STREAM_DETAIL_SPEED * VOXEL_M);
    for (let i = 0; i < 60; i++) {
      t += 1000 / 30;
      // Every fifth frame shows the last frame's pose again (the simulation's step had not come): not a stop.
      if (i % 5 !== 4) x += 5;
      else x += 0;
      f.follow(x, 0, DIR, 100, t);
      // A far node drawn over far tiles composed before: they wait for the let-go.
      if (i === 10) f.farAdded('node', { level: 3, nx: 0, ny: 0, nz: 0 }, SOLID_NODE);
      f.frame(() => true, r);
      expect(f.held).toBe(true);
      // Held, the near window reads as none (the march skips its columns; lit points read the far window).
      expect((f.nearRect.value as THREE.Vector4).w).toBe(0);
    }
    expect(f.near.tileX).toBe(tileX);
    expect(f.stats.nearTiles).toBe(near);
    expect(f.far.held).toBe(1);
    expect(f.stats.heldFrames).toBe(60);
    // The far window kept following (its 128 m tiles: two columns of them entered).
    expect(f.far.window.tileX).toBe(Math.floor(x / 128) - 16);
    // Stopped: held while the camera has been still for less than the streamer's stop time, then let go.
    const stoppedAt = t;
    for (t += 1000 / 30; t - stoppedAt < STREAM_STOPPED_MS + 1000 / 30; t += 1000 / 30) {
      expect(f.held).toBe(true);
      f.follow(x, 0, DIR, 100, t);
    }
    expect(f.held).toBe(false);
    expect(f.far.held).toBe(0);
    expect(f.near.tileX).toBe(Math.floor(x / 16) - 16);
    expect((f.nearRect.value as THREE.Vector4).w).toBe(1);
    expect(f.marching).toBe(32);
    const entered = f.near.waiting;
    expect(entered).toBe(15 * 32);
    // 64 tiles a frame (the slice), nearest first: done within the frames that takes.
    const frames = settle(f, r, 64);
    expect(frames).toBeLessThanOrEqual(Math.ceil(entered / 64) + 1);
    expect(f.stats.nearTiles - near).toBe(entered);
    // The same tops as a field that went straight there.
    const g = new SunField(EDGE, VOXEL_M, () => [sky]);
    g.setSteps(12);
    g.follow(x, 0, DIR, 100, 0);
    settle(g, counting(), 4096);
    expect(g.near.tileX).toBe(f.near.tileX);
    let differ = 0;
    for (let i = 0; i < f.near.data.length; i++) if (f.near.data[i] !== g.near.data[i]) differ++;
    expect(differ).toBe(0);
    expect(f.probe([x + 3, 30, 7]).near).toBe(g.probe([x + 3, 30, 7]).near);
    expect(f.near.topAt(x + 3, 7)).toBeGreaterThan(19);
  });
});
