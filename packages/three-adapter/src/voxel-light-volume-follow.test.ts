import { describe, expect, it } from 'vitest';
import { LIGHTING_TIER_SETTINGS } from '@thirdlight/project-model';

import { followCutUpdates, followPeriod, followWeight, VolumeFollow, volumeLightStep, volumeSkyStep, VolumeSunSkyWatch, type FollowBrick } from './voxel-light-volume-follow';
import { volumeBlendWeight } from './voxel-light-volume-layout';

/** Updates a brick is refined to (the low tier's). */
const VOLUME_HISTORY_UPDATES = LIGHTING_TIER_SETTINGS.low.voxelLightVolume.historyUpdates;

/** A row of level-0 bricks along +x from the eye at brick 0 (the camera looking along +x), each one cell's light. */
interface ModelBrick extends FollowBrick {
  value: number;
}

function row(n: number): ModelBrick[] {
  return Array.from({ length: n }, (_, i) => ({ level: 0, bx: i, by: 0, bz: 0, slot: i, updates: VOLUME_HISTORY_UPDATES, seen: -Infinity, value: 0 }));
}

/** A pseudo-random sequence in [−1, 1) (a fixed one: the test's numbers are the same every run). */
function noise(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 31 - 1;
  };
}

/**
 * The follow over a CPU model of the update: each frame the light (the same everywhere; `light(f)`) takes a step, the
 * follow takes `perFrame` bricks and each blends a noisy estimate (± `sigma`) in by its weight. Returns the bricks and,
 * per frame, the brick at the eye's value and the largest change of any brick's value.
 */
function run(bricks: ModelBrick[], light: (f: number) => number, frames: number, perFrame: number, window: number, sigma: number, follow = new VolumeFollow<ModelBrick>(30), moving = (f: number): boolean => true): { eye: number[]; jumps: number[]; follow: VolumeFollow<ModelBrick> } {
  const rnd = noise(7);
  const eye: number[] = [];
  const jumps: number[] = [];
  for (let f = 0; f < frames; f++) {
    if (moving(f)) follow.change(f);
    if (follow.frame(f)) for (const b of bricks) b.updates = Math.min(b.updates, followCutUpdates(window));
    const list: ModelBrick[] = [];
    follow.take(() => bricks, () => true, [1, 1, 1], [1, 0, 0], f, perFrame, list);
    let jump = 0;
    for (const b of list) {
      const w = follow.behind(b) ? followWeight(volumeBlendWeight(b.updates), window) : volumeBlendWeight(b.updates);
      const est = light(f) * (1 + sigma * rnd());
      const next = b.value + (est - b.value) * w;
      jump = Math.max(jump, Math.abs(next - b.value));
      b.value = next;
      b.updates++;
      b.seen = f;
    }
    eye.push(bricks[0]!.value);
    jumps.push(jump);
  }
  return { eye, jumps, follow };
}

describe('the light volume following a moving light', () => {
  it('follows a light that never stops with a bounded lag, every brick in turn and the ones at the eye more often', () => {
    const W = 8;
    const bricks = row(40);
    for (const b of bricks) b.value = 1;
    // A light rising steadily (a sun climbing): 1 → 2 over 3,000 frames.
    const slope = 1 / 3000;
    const light = (f: number): number => 1 + slope * f;
    const { eye } = run(bricks, light, 3000, 4, W, 0);
    // Refreshed in turn: every brick of the row, the ones at the eye more often than those 30 bricks off.
    const counts = bricks.map((b) => b.updates - VOLUME_HISTORY_UPDATES);
    expect(Math.min(...counts)).toBeGreaterThan(0);
    expect(counts[0]! / counts[30]!).toBeGreaterThan(0.8 * (followPeriod(30, false) / followPeriod(0, false)));
    // The lag at the eye: an exponential mean over the last W refreshes of the eye's brick lags by (W − 1) periods.
    const period = 3000 / counts[0]!;
    const lagFrames = (light(2999) - eye[2999]!) / slope;
    expect(lagFrames).toBeGreaterThan(0.7 * (W - 1) * period);
    expect(lagFrames).toBeLessThan(1.3 * (W - 1) * period);
    // A far brick lags more, as its period is longer, but by a bound too.
    const farLag = (light(2999) - bricks[30]!.value) / slope;
    expect(farLag).toBeLessThan(1.5 * (W - 1) * (3000 / counts[30]!));
  });

  it('keeps the noise of a moving light bounded by the window: the spread of a face round its mean is a few rays\' over √(2W − 1)', () => {
    const W = 8;
    const sigma = 0.5;
    const bricks = row(10);
    for (const b of bricks) b.value = 1;
    const { eye } = run(bricks, () => 1, 4000, 2, W, sigma);
    const tail = eye.slice(1000);
    const mean = tail.reduce((s, v) => s + v, 0) / tail.length;
    const sd = Math.sqrt(tail.reduce((s, v) => s + (v - mean) ** 2, 0) / tail.length);
    // An exponential mean of weight 1/W over noise σ/√3 (uniform): σ_v = σ/√3 · √(1 / (2W − 1)).
    const expected = (sigma / Math.sqrt(3)) * Math.sqrt(1 / (2 * W - 1));
    expect(Math.abs(mean - 1)).toBeLessThan(0.02);
    expect(sd).toBeGreaterThan(0.6 * expected);
    expect(sd).toBeLessThan(1.4 * expected);
    // A restart every step would hold one estimate's noise (σ/√3 ≈ 0.29): this is under a third of it.
    expect(sd).toBeLessThan((sigma / Math.sqrt(3)) / 3);
  });

  it('once the light stops, hands the bricks to the refining with their history cut, which converges to the light where it stopped', () => {
    const W = 8;
    const bricks = row(20);
    for (const b of bricks) b.value = 1;
    const follow = new VolumeFollow<ModelBrick>(30);
    // Moving for 600 frames (1 → 1.6), then still at 1.6.
    const light = (f: number): number => 1 + Math.min(f, 600) / 1000;
    let ended = -1;
    const rnd = noise(3);
    for (let f = 0; f < 4000; f++) {
      if (f < 600) follow.change(f);
      if (follow.frame(f)) {
        expect(ended).toBe(-1);
        ended = f;
        for (const b of bricks) b.updates = Math.min(b.updates, followCutUpdates(W));
      }
      const list: ModelBrick[] = [];
      if (follow.following) follow.take(() => bricks, () => true, [1, 1, 1], [1, 0, 0], f, 2, list);
      // After the follow: the refining's model (every brick short of its history, one a frame in turn).
      else for (const b of bricks) if (b.updates < VOLUME_HISTORY_UPDATES && list.length < 2 && b.seen < f - 5) list.push(b);
      for (const b of list) {
        const w = follow.behind(b) ? followWeight(volumeBlendWeight(b.updates), W) : volumeBlendWeight(b.updates);
        b.value += (light(f) * (1 + 0.05 * rnd()) - b.value) * w;
        b.updates++;
        b.seen = f;
      }
    }
    expect(ended).toBe(600 + 30);
    // Converged to the light where it stopped: what the lag left at the stop (0.1–0.3 of the light) fades to a few
    // hundredths of itself over the refining, under the estimates' own noise (±5 %).
    let sum = 0;
    for (const b of bricks) {
      expect(b.updates).toBe(VOLUME_HISTORY_UPDATES);
      expect(Math.abs(b.value - 1.6) / 1.6).toBeLessThan(0.03);
      sum += b.value;
    }
    expect(Math.abs(sum / bricks.length - 1.6) / 1.6).toBeLessThan(0.01);
  });

  it('tells a step of the sun or the sky it follows from a jump it restarts for, by how fast it changes', () => {
    const at = (deg: number): number[] => [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180), 0];
    const frame = 1 / 30;
    // A 2-minute day (3° a second) a frame at a time, and a minute's (6°): followed; 5° in a frame, or 12° in a second: a jump.
    expect(volumeLightStep({ dir: at(40), lit: 3 }, { dir: at(40.1), lit: 3 }, frame)).toBe(true);
    expect(volumeLightStep({ dir: at(40), lit: 3 }, { dir: at(40.2), lit: 3 }, frame)).toBe(true);
    expect(volumeLightStep({ dir: at(40), lit: 3 }, { dir: at(45), lit: 3 }, frame)).toBe(false);
    expect(volumeLightStep({ dir: at(40), lit: 3 }, { dir: at(52), lit: 3 }, 1)).toBe(false);
    // Lit to unlit (noon to night), a light doubled at once or two thirds gone in a second are jumps; a sunset's fall a step.
    expect(volumeLightStep({ dir: at(40), lit: 3 }, { dir: at(40), lit: 0 }, frame)).toBe(false);
    expect(volumeLightStep({ dir: at(40), lit: 3 }, { dir: at(40), lit: 6 }, frame)).toBe(false);
    expect(volumeLightStep({ dir: at(40), lit: 3 }, { dir: at(40), lit: 1 }, 1)).toBe(false);
    expect(volumeLightStep({ dir: at(40), lit: 3 }, { dir: at(40), lit: 2.99 }, frame)).toBe(true);
    // A look blended over a second: each frame's step is a thirtieth of the change, still a jump by its rate.
    expect(volumeLightStep({ dir: at(40), lit: 3 }, { dir: at(40), lit: 3 * (1 - 1 / 30) }, frame)).toBe(false);
    // Through the watch, looked at every page frame: a day of 3° a second moved by simulation steps of 30 a second, the
    // page drawing at 100 a second (a step's whole turn shows in one 10 ms frame): every change a step.
    const watch = new VolumeSunSkyWatch();
    expect(watch.sun(at(40), 3, 0)).toBe('jump');
    let deg = 40;
    let t = 0;
    const told: string[] = [];
    for (let k = 1; k <= 300; k++) {
      t = k / 100;
      deg = 40 + 3 * Math.floor(t * 30) / 30;
      told.push(watch.sun(at(deg), 3, t));
    }
    expect(told.filter((x) => x === 'jump')).toEqual([]);
    expect(told.filter((x) => x === 'step').length).toBeGreaterThan(60);
    // Standing still for a minute (looked at every frame), then switched at once by 15°: a jump.
    for (let k = 1; k <= 60 * 30; k++) watch.sun(at(deg), 3, t + k / 30);
    t += 60;
    expect(watch.sun(at(deg + 15), 3, t + 1 / 30)).toBe('jump');
    t += 1 / 30;
    deg += 15;
    // A day moving on through a hitch (a frame of a second at 3° a second) is a step.
    for (let k = 1; k <= 30; k++) watch.sun(at(deg), 3, t + k / 30);
    t += 1;
    expect(watch.sun(at(deg + 3), 3, t + 1)).toBe('step');
    t += 1;
    deg += 3;
    // A sunset's light falling 4 % a second, seen each frame: steps; halved at once: a jump.
    let lit = 3;
    const fall: string[] = [];
    for (let k = 1; k <= 60; k++) {
      lit *= 1 - 0.04 / 30;
      fall.push(watch.sun(at(deg), lit, t + k / 30));
    }
    expect(fall.filter((x) => x === 'jump')).toEqual([]);
    expect(watch.sun(at(deg), lit / 2, t + 2 + 1 / 30)).toBe('jump');
    const sky = Float32Array.from({ length: 12 }, (_, i) => 0.5 + i / 24);
    expect(volumeSkyStep(sky, sky.map((v) => v * 1.002), frame)).toBe(true);
    expect(volumeSkyStep(sky, sky.map((v) => v * 1.02), frame)).toBe(false);
    expect(volumeSkyStep(sky, sky.map((v) => v * 0.2), 1)).toBe(false);
    expect(volumeSkyStep(new Float32Array(12), new Float32Array(12), 1)).toBe(false);
    // Through the watch (looked at twice a second): a day's sky moving 8 % in a projection 4 s after the last one is a
    // step; a look switched at once after standing still (60 % of its light gone in one projection) a jump.
    const w2 = new VolumeSunSkyWatch();
    expect(w2.sky(1, sky, 0)).toBe('jump');
    for (let t = 0.5; t < 4; t += 0.5) expect(w2.sky(1, sky, t)).toBe('none');
    expect(w2.sky(2, sky.map((v) => v * 1.08), 4)).toBe('step');
    for (let t = 4.5; t < 60; t += 0.5) w2.sky(2, sky, t);
    expect(w2.sky(3, sky.map((v) => v * 0.4), 60)).toBe('jump');
  });
});
