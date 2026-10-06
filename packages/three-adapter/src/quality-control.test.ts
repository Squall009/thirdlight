import { describe, expect, it } from 'vitest';

import type { EnvironmentRenderer } from './environment';
import { LodTuning } from './lod-switch';
import { createQualityControl, qualityFromUrl, type QualityProjectLike } from './quality-control';
import { createRenderControl } from './render-control';

function harness(project: QualityProjectLike | null, o: { pinned?: string; lod?: { bias?: number; hysteresis?: number }; render?: Parameters<typeof createRenderControl>[0] } = {}) {
  const renderControl = createRenderControl(o.render ?? {});
  const lodTuning = new LodTuning();
  if (o.lod !== undefined) lodTuning.set(o.lod);
  const limits: { shadowMapSize: number | null; localLights: number | null }[] = [];
  const caps: number[] = [];
  let reselects = 0;
  let changes = 0;
  const envQuality: (string | null)[] = [];
  const env = { setQuality: (id: string | null) => envQuality.push(id) } as unknown as EnvironmentRenderer;
  const q = createQualityControl(
    {
      renderControl,
      lodTuning,
      setLightLimits: (l) => {
        const last = limits[limits.length - 1];
        limits.push({ ...l });
        return last === undefined ? l.shadowMapSize !== null || l.localLights !== null : last.shadowMapSize !== l.shadowMapSize || last.localLights !== l.localLights;
      },
      reselectLights: () => void (reselects += 1),
      setPixelRatioCap: (cap) => void caps.push(cap),
      environment: () => env,
      changed: () => void (changes += 1),
    },
    { project, ...(o.lod !== undefined ? { lod: o.lod } : {}), pinned: o.pinned ?? null },
  );
  return { q, renderControl, lodTuning, limits, caps, envQuality, reselects: () => reselects, changes: () => changes };
}

const LEVELS: QualityProjectLike = {
  quality: 'mid',
  qualityLevels: [
    { id: 'potato', renderScale: 0.5, ambientOcclusion: 'off', msaa: 0, shadowMapSize: 512, localLights: 2, lodBias: 0.5, pixelRatio: 1 },
    { id: 'mid', ambientOcclusion: 'ssao' },
    { id: 'ultra', ambientOcclusion: 'gtao', shadowMapSize: 4096, pixelRatio: 2, dynamicResolution: true },
  ],
};

describe('quality control', () => {
  it('a project without levels draws as before: the engine\'s high level changes no renderer setting', () => {
    const h = harness(null, { render: { ambientOcclusion: 'gtao', renderScale: 0.75 }, lod: { bias: 2 } });
    expect(h.q.level().id).toBe('high');
    expect(h.q.needsEnvironment()).toBe(false);
    expect(h.renderControl.diagnostics()).toMatchObject({ ambientOcclusion: 'gtao', renderScale: 0.75, dynamicResolution: false });
    expect(h.lodTuning.bias).toBe(2);
    expect(h.limits).toEqual([{ shadowMapSize: null, localLights: null }]);
    expect(h.reselects()).toBe(0);
    expect(h.caps).toEqual([]);
    expect(h.q.diagnostics()).toMatchObject({ level: 'high', levels: ['low', 'medium', 'high'], source: 'highest', pixelRatioCap: 1, shadowMapSize: null, localLights: null, lodBias: 2 });
    // The engine's low level draws without MSAA: through the environment renderer.
    expect(h.q.choose('low')).toBe(true);
    expect(h.q.needsEnvironment()).toBe(true);
    expect(h.envQuality[h.envQuality.length - 1]).toBe('low');
  });

  it('applies a project level\'s renderer settings over the project\'s, under a player\'s fields and the page\'s flags', () => {
    const h = harness(LEVELS, { render: { ambientOcclusion: 'gtao', renderScale: 0.9, pinned: { dynamicResolution: false } }, lod: { bias: 1.5, hysteresis: 0.2 } });
    expect(h.q.level().id).toBe('mid');
    expect(h.q.diagnostics().source).toBe('project');
    // mid: its AO kind over the project's; the project's scale (the level sets none).
    expect(h.renderControl.diagnostics()).toMatchObject({ ambientOcclusion: 'ssao', renderScale: 0.9 });
    expect(h.q.choose('potato')).toBe(true);
    expect(h.renderControl.diagnostics()).toMatchObject({ ambientOcclusion: 'off', renderScale: 0.5 });
    expect(h.lodTuning.bias).toBe(0.5);
    expect(h.lodTuning.hysteresis).toBe(0.2);
    expect(h.limits[h.limits.length - 1]).toEqual({ shadowMapSize: 512, localLights: 2 });
    expect(h.reselects()).toBe(1);
    // A player's field lays over the level.
    h.renderControl.set({ renderScale: 0.75 });
    expect(h.renderControl.diagnostics().renderScale).toBe(0.75);
    // ultra: dynamic resolution, but the page pins it off.
    expect(h.q.choose('ultra')).toBe(true);
    expect(h.renderControl.diagnostics()).toMatchObject({ ambientOcclusion: 'gtao', renderScale: 0.75, dynamicResolution: false });
    expect(h.caps).toEqual([2]);
    expect(h.lodTuning.bias).toBe(1.5);
    expect(h.q.diagnostics()).toMatchObject({ level: 'ultra', source: 'chosen', pixelRatioCap: 2, shadowMapSize: 4096, localLights: null, lodBias: 1.5 });
    // An unknown level changes nothing.
    const changes = h.changes();
    expect(h.q.choose('nope')).toBe(false);
    expect(h.q.level().id).toBe('ultra');
    expect(h.changes()).toBe(changes);
    // The same level again applies nothing.
    expect(h.q.choose('ultra')).toBe(true);
    expect(h.changes()).toBe(changes);
  });

  it('the page\'s ?quality= pins the level over a choice; a project edit that drops the chosen level falls back to the highest', () => {
    expect(qualityFromUrl('?quality=potato&x=1')).toBe('potato');
    expect(qualityFromUrl('?x=1')).toBeNull();
    const h = harness(LEVELS, { pinned: 'potato' });
    expect(h.q.level().id).toBe('potato');
    expect(h.q.choose('ultra')).toBe(true);
    expect(h.q.level().id).toBe('potato');
    expect(h.q.diagnostics().source).toBe('page');
    const g = harness(LEVELS);
    g.q.choose('potato');
    g.q.setProject({ qualityLevels: [{ id: 'a' }, { id: 'b', renderScale: 0.8 }] });
    expect(g.q.level().id).toBe('b');
    expect(g.renderControl.diagnostics().renderScale).toBe(0.8);
    // The project's LOD bias changes under a level without its own bias.
    g.q.setProjectLod({ bias: 3 });
    expect(g.lodTuning.bias).toBe(3);
  });

  it('a fixed-scale view (the editor\'s Scene view) draws at full resolution whatever the level says', () => {
    const h = harness(LEVELS, { render: { fixedScale: true } });
    h.q.choose('potato');
    expect(h.renderControl.diagnostics()).toMatchObject({ ambientOcclusion: 'off', renderScale: 1, dynamicResolution: false });
    h.q.choose('ultra');
    expect(h.renderControl.diagnostics()).toMatchObject({ renderScale: 1, dynamicResolution: false });
  });
});
