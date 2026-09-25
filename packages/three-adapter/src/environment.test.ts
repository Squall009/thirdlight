/**
 * Phase 14.4: a level's look laid over the project environment.
 * Pure (no renderer): the merge rule the renderer, Play, the export and the
 * editor's Scene view share. (The post pipeline's lifetime — no rebuild on a
 * same-size frame — is covered by environment-nodes.test.ts since phase 17.4.)
 */
import { describe, expect, it } from 'vitest';

import { environmentHasLook, layerEnvironment, type EnvironmentLike } from './environment';

const BASE: EnvironmentLike & { wind?: unknown } = {
  sky: { mode: 'procedural', turbidity: 6 },
  fog: { mode: 'linear', color: '#ffffff', near: 10, far: 100 },
  post: { toneMapping: 'agx', exposure: 1.2, bloom: { enabled: true, strength: 0.5 }, grading: { contrast: 0.1 } },
  quality: 'medium',
  wind: { direction: [1, 0], strength: 0.5, gust: 0.4, gustFrequency: 0.3, turbulence: 0.3 },
};

describe('layerEnvironment', () => {
  it('no layer: the project environment unchanged (existing projects look identical)', () => {
    expect(layerEnvironment(BASE, null)).toBe(BASE);
    expect(layerEnvironment(BASE, undefined)).toBe(BASE);
    expect(layerEnvironment(null, null)).toBeNull();
  });

  it('sky, fog and wind replace the project part whole; quality stays the project one', () => {
    const out = layerEnvironment(BASE, { sky: { mode: 'color', color: '#ff0000' }, fog: { mode: 'none', color: '#000000' }, wind: { direction: [0, 1], strength: 3, gust: 0, gustFrequency: 0, turbulence: 0 } })!;
    expect(out.sky).toEqual({ mode: 'color', color: '#ff0000' });
    expect(out.fog).toEqual({ mode: 'none', color: '#000000' });
    expect(out.wind).toEqual({ direction: [0, 1], strength: 3, gust: 0, gustFrequency: 0, turbulence: 0 });
    expect(out.post).toBe(BASE.post);
    expect(out.quality).toBe('medium');
  });

  it('post merges per effect: a level changes its grading and keeps the project bloom and tone mapping', () => {
    const out = layerEnvironment(BASE, { post: { grading: { lift: 0.1, gamma: 1.3, gain: 0.9 } } })!;
    expect(out.post).toEqual({ toneMapping: 'agx', exposure: 1.2, bloom: { enabled: true, strength: 0.5 }, grading: { lift: 0.1, gamma: 1.3, gain: 0.9 } });
    expect(out.sky).toBe(BASE.sky);
  });

  it('a level look over a project without an environment', () => {
    const out = layerEnvironment(null, { sky: { mode: 'color', color: '#00ff00' } });
    expect(out).toEqual({ sky: { mode: 'color', color: '#00ff00' } });
    expect(environmentHasLook(out)).toBe(true);
    expect(environmentHasLook(layerEnvironment({}, null))).toBe(false);
    expect(environmentHasLook(null)).toBe(false);
  });
});
