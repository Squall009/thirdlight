import { describe, expect, it } from 'vitest';

import { BLOOM_DEFAULTS } from './materials';
import { upgradeBloomExposure } from './upgrade-bloom-exposure';

const scene = (sceneId: string, post: Record<string, unknown>): Record<string, unknown> => ({ sceneId, environment: { post } });

describe('bloom-exposure upgrade step', () => {
  it('writes the old default strength where a look with bloom on left it out, at any exposure', () => {
    const r = upgradeBloomExposure({}, [
      scene('a', { bloom: { enabled: true } }),
      scene('b', { exposure: 0.5, bloom: { enabled: true, threshold: 1 } }),
      scene('c', { bloom: { enabled: true, strength: 0.3 } }),
      scene('d', { bloom: { enabled: false } }),
    ]);
    expect(r.changed).toBe(true);
    expect(r.scenes.map((s) => (s as { environment: { post: unknown } }).environment.post)).toEqual([
      { bloom: { enabled: true, strength: 0.6 } },
      { exposure: 0.5, bloom: { enabled: true, threshold: 0.5, strength: 0.6 } },
      { bloom: { enabled: true, strength: 0.3 } },
      { bloom: { enabled: false } },
    ]);
    expect(BLOOM_DEFAULTS.strength).toBeLessThan(0.6);
    expect(r.notes.filter((n) => n.includes('strength was written as 0.6')).map((n) => n.split(':')[0])).toEqual(['scene a', 'scene b']);
    expect(r.notes.filter((n) => n.includes('threshold is now compared')).map((n) => n.split(':')[0])).toEqual(['scene b']);
  });

  it('scales quality levels’ threshold overrides by the one exposure the looks with bloom share', () => {
    const content = { environment: { presets: [{ presetId: 'dusk', post: { exposure: 2, bloom: { enabled: true, strength: 1 } } }], qualityLevels: [{ id: 'low', post: { bloom: { enabled: false } } }, { id: 'high', post: { bloom: { threshold: 0.5 } } }] } };
    const r = upgradeBloomExposure(content, [scene('a', { exposure: 2, bloom: { enabled: true, strength: 1 } })]);
    const env = (r.content as typeof content).environment;
    expect(env.qualityLevels).toEqual([{ id: 'low', post: { bloom: { enabled: false } } }, { id: 'high', post: { bloom: { threshold: 1 } } }]);
    expect(env.presets[0]!.post.bloom).toEqual({ enabled: true, strength: 1, threshold: 1.7 });
    expect(r.notes).toEqual(expect.arrayContaining([expect.stringMatching(/^quality levels high: the bloom threshold override was scaled by the looks' exposure \(2\)/)]));
  });

  it('leaves a level override with a note where the looks with bloom differ in exposure, and alone where all are at 1', () => {
    const levels = [{ id: 'high', post: { bloom: { threshold: 0.5 } } }];
    const mixed = upgradeBloomExposure({ environment: { qualityLevels: levels } }, [scene('a', { exposure: 2, bloom: { enabled: true, strength: 1 } }), scene('b', { exposure: 0.5, bloom: { enabled: true, strength: 1 } })]);
    expect((mixed.content as { environment: { qualityLevels: unknown } }).environment.qualityLevels).toEqual(levels);
    expect(mixed.notes).toEqual(expect.arrayContaining([expect.stringMatching(/^quality levels high: .*left as it was.*\(0\.5, 2\)/)]));
    const atOne = upgradeBloomExposure({ environment: { qualityLevels: levels } }, [scene('a', { bloom: { enabled: true, strength: 1 } })]);
    expect(atOne).toMatchObject({ changed: false, notes: [] });
  });
});
