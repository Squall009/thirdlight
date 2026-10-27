/**
 * The page's frame statistics: one snapshot per window with the frame
 * interval, the page work and the GPU time (average and worst), the GPU
 * null where nothing measures it; and the overlay's text.
 */
import { describe, expect, it } from 'vitest';

import { engineStatsOf, type BehaviorStats, type BehaviorStatsLighting } from '@thirdlight/runtime';

import { createFrameStats, createHostStats, geometryBytesOf } from './frame-stats';
import { statsOverlayLines, statsOverlayModeOf } from './stats-overlay';

const sources = (gpu: { ms: number; frames: number; worst: number } | null) => ({
  frame: () => ({ drawCalls: 12, triangles: 3400 }),
  gpu: () => gpu,
  textures: () => ({ residentBytes: 64 * 1024 * 1024, budgetBytes: 512 * 1024 * 1024 }),
  geometryBytes: () => 2048,
  entities: () => 9,
  quality: () => 'low',
  frameRateCap: () => 60,
});

describe('frame stats', () => {
  it('averages frames over the window and keeps the worst; a new snapshot each window', () => {
    const s = createFrameStats(sources({ ms: 30, frames: 5, worst: 9 }), 500);
    let t = 1000;
    expect(s.frame(2, t)).toBe(false);
    // 16 ms frames and one 50 ms hitch.
    const gaps = [16, 16, 50, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16];
    let ended = false;
    for (const [i, g] of gaps.entries()) {
      t += g;
      ended = s.frame(i === 2 ? 12 : 3, t);
      if (ended) break;
    }
    expect(ended).toBe(true);
    const snap = s.snapshot()!;
    expect(snap.frameMs.worst).toBe(50);
    expect(snap.frameMs.avg).toBeGreaterThan(16);
    expect(snap.fps).toBeCloseTo(1000 / snap.frameMs.avg, 0);
    expect(snap.cpuMs.worst).toBe(12);
    expect(snap.gpuMs).toEqual({ avg: 6, worst: 9 });
    expect(snap).toMatchObject({ drawCalls: 12, triangles: 3400, textureBytes: 64 * 1024 * 1024, textureBudgetBytes: 512 * 1024 * 1024, geometryBytes: 2048, entities: 9, quality: 'low', frameRateCap: 60 });
    expect(snap.windowMs).toBeGreaterThanOrEqual(500);
  });

  it('says the GPU time is not measured (null) without timestamp queries; the overlay writes so', () => {
    const s = createFrameStats(sources(null), 100);
    for (let t = 0; t <= 200; t += 20) s.frame(1, t);
    const snap = s.snapshot()!;
    expect(snap.gpuMs).toBeNull();
    const lines = statsOverlayLines(snap);
    expect(lines.find((l) => l.startsWith('gpu'))).toBe('gpu   not measured');
    expect(lines.find((l) => l.startsWith('tex'))).toBe('tex   64.0 MiB / 512.0 MiB');
  });

  it('reports the adapter\'s lighting at the frame it changes, not at the window\'s end, in stats the runtime takes', () => {
    let lighting: BehaviorStatsLighting = { tier: 'medium', live: true, settled: false };
    const published: BehaviorStats[] = [];
    const host = createHostStats({ adapter: () => ({ qualityLevel: () => 'medium', lightingState: () => lighting }), entities: () => 0, worker: true, frameRateCap: () => 60, published: (s) => void published.push(s) });
    const frame = (): void => {
      host.begin();
      host.end();
    };
    frame();
    // The first frame reports the lighting at once (before any window ended): nothing measured yet, the level drawn.
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ fps: 0, quality: 'medium', frameRateCap: 60, lighting: { tier: 'medium', live: true, settled: false } });
    frame();
    expect(published).toHaveLength(1);
    lighting = { tier: 'medium', live: true, settled: true };
    frame();
    expect(published).toHaveLength(2);
    expect(published[1]!.lighting.settled).toBe(true);
    // What the page publishes, the runtime takes.
    expect(engineStatsOf(published[1])).toEqual(published[1]);
  });

  it('reads geometry bytes from the model kinds without their embedded images, and the overlay setting', () => {
    expect(geometryBytesOf({ model: { bytes: 1000, textures: { bytes: 600 } }, 'effect-model': { bytes: 50 }, texture: { bytes: 9999 } })).toBe(450);
    expect(statsOverlayModeOf({})).toBe('off');
    expect(statsOverlayModeOf({ stats_overlay: 0 })).toBe('off');
    expect(statsOverlayModeOf({ stats_overlay: 1 })).toBe('shown');
    expect(statsOverlayModeOf({ stats_overlay: 2 })).toBe('hidden');
  });
});
