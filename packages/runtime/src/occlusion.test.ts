import { describe, expect, it } from 'vitest';

import { engineStatsOf, ENGINE_STATS_NONE } from './engine-stats';
import { occludeeClassOf, occludeeScreenShare, OCCLUSION_MAX_SCREEN_SHARE, OCCLUSION_MIN_TRIANGLES, occlusionPathFrom, occlusionPathOf } from './occlusion';

describe('occlusion culling rules', () => {
  it('auto takes the renderer\'s path (a depth pyramid on WebGPU, queries on WebGL 2); off and an unknown renderer draw everything', () => {
    expect(occlusionPathOf('auto', 'webgpu')).toEqual({ path: 'hiz', source: 'setting' });
    expect(occlusionPathOf('auto', 'webgl2')).toEqual({ path: 'queries', source: 'setting' });
    expect(occlusionPathOf('auto', null).path).toBe('off');
    expect(occlusionPathOf('off', 'webgpu').path).toBe('off');
  });

  it('a page pin wins over the setting, and a path the renderer lacks draws with none', () => {
    expect(occlusionPathOf('off', 'webgpu', 'hiz')).toEqual({ path: 'hiz', source: 'page' });
    expect(occlusionPathOf('auto', 'webgpu', 'queries')).toEqual({ path: 'queries', source: 'page' });
    expect(occlusionPathOf('auto', 'webgpu', 'off')).toEqual({ path: 'off', source: 'page' });
    expect(occlusionPathOf('auto', 'webgl2', 'hiz')).toEqual({ path: 'off', source: 'page' });
    expect(occlusionPathFrom('queries')).toBe('queries');
    expect(occlusionPathFrom('pyramid')).toBeNull();
    expect(occlusionPathFrom(null)).toBeNull();
  });

  it('size on screen: the projected radius over half the view height; the eye inside the sphere is infinite', () => {
    expect(occludeeScreenShare(1, 10, 0.5)).toBeCloseTo(0.2);
    expect(occludeeScreenShare(2, 2, 0.5)).toBe(Number.POSITIVE_INFINITY);
    expect(occludeeScreenShare(2, 1, 0.5)).toBe(Number.POSITIVE_INFINITY);
  });

  it('decides what is worth testing: by triangles, by size on screen, copies of instanced draws one by one', () => {
    const at = { screenShare: 0.1, items: 1 };
    expect(occludeeClassOf({ kind: 'single', triangles: OCCLUSION_MIN_TRIANGLES, ...at })).toBe('whole');
    expect(occludeeClassOf({ kind: 'single', triangles: OCCLUSION_MIN_TRIANGLES - 1, ...at })).toBe('never');
    // Many small copies add up: their draw is worth testing, copy by copy.
    expect(occludeeClassOf({ kind: 'instanced', triangles: 12, items: 100, screenShare: 0.1 })).toBe('items');
    expect(occludeeClassOf({ kind: 'terrain', triangles: 128, items: 40, screenShare: Number.POSITIVE_INFINITY })).toBe('items');
    // An instanced draw of one copy is a draw like any other.
    expect(occludeeClassOf({ kind: 'instanced', triangles: 500, items: 1, screenShare: 0.1 })).toBe('whole');
    // Too large on screen (or around the eye) to be hidden whole.
    expect(occludeeClassOf({ kind: 'blocks', triangles: 5000, items: 1, screenShare: OCCLUSION_MAX_SCREEN_SHARE + 0.01 })).toBe('never');
    expect(occludeeClassOf({ kind: 'merged', triangles: 5000, items: 30, screenShare: Number.POSITIVE_INFINITY })).toBe('never');
    // Transparent draws hide nothing but can be hidden.
    expect(occludeeClassOf({ kind: 'transparent', triangles: 200, ...at })).toBe('whole');
    expect(occludeeClassOf({ kind: 'single', triangles: 500, items: 1, screenShare: Number.NaN })).toBe('never');
  });

  it('ctx.stats carries what occlusion culling left out; stats without it read as none on no path', () => {
    const base = { fps: 60, frameMs: { avg: 16, worst: 20 }, cpuMs: { avg: 4, worst: 6 }, gpuMs: null, drawCalls: 10, triangles: 100, textureBytes: 0, textureBudgetBytes: 0, geometryBytes: 0, entities: 1, quality: 'high', frameRateCap: null, windowMs: 500 };
    expect(engineStatsOf(base)?.occlusion).toEqual(ENGINE_STATS_NONE.occlusion);
    expect(engineStatsOf({ ...base, occlusion: { path: 'hiz', tested: 40, culled: 12 } })?.occlusion).toEqual({ path: 'hiz', tested: 40, culled: 12 });
    expect(engineStatsOf({ ...base, occlusion: { path: 'pyramid', tested: 1, culled: 0 } })).toBeNull();
    expect(engineStatsOf({ ...base, occlusion: { path: 'queries', tested: -1, culled: 0 } })).toBeNull();
  });
});
