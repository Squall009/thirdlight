/**
 * Phase 9.6: a scene's bake record (content.lighting).
 */
import { describe, expect, it } from 'vitest';

import { canonicalLighting, validateLighting, validateLightingBake, type LightingBake } from './lighting';

const bake = (extra: Partial<Record<keyof LightingBake, unknown>> = {}): Record<string, unknown> => ({
  bakeId: 'bake-abc',
  createdAt: '2026-09-24T05:00:00.123Z',
  source: 'browser',
  range: 4,
  texelsPerMeter: 16,
  samples: 64,
  bounces: 0,
  atlases: ['asset-0001'],
  entries: [
    { entityId: 'box-0002', atlas: 0, scaleOffset: [0.25, 0.25, 0.5, 0] },
    { entityId: 'box-0001', atlas: 0, scaleOffset: [2.5, 1.5, -0.25, -3] },
  ],
  bakedLights: ['light-0002', 'light-0001'],
  lightsHash: '0123456789abcdef',
  staticsHash: 'fedcba9876543210',
  ...extra,
});
const paths = (v: unknown): string[] => {
  const errors: { path: string }[] = [];
  validateLightingBake(v, '/b', errors as never);
  return errors.map((e) => e.path);
};

describe('lighting bakes', () => {
  it('accepts a bake (a UV1 box may map past the unit square) and canonicalizes it', () => {
    expect(paths(bake())).toEqual([]);
    const c = canonicalLighting({ 'scene-b': bake() as unknown as LightingBake, 'scene-a': bake({ source: 'blender', bounces: 3 }) as unknown as LightingBake });
    expect(Object.keys(c)).toEqual(['scene-a', 'scene-b']);
    expect(c['scene-b']!.entries.map((e) => e.entityId)).toEqual(['box-0001', 'box-0002']);
    expect(c['scene-b']!.bakedLights).toEqual(['light-0001', 'light-0002']);
  });

  it('refuses missing and unknown fields, bad ids, hashes, ranges and entries', () => {
    const { range: _r, ...noRange } = bake();
    expect(paths(noRange)).toEqual(['/b/range']);
    expect(paths(bake({ extra: 1 } as never))).toEqual(['/b/extra']);
    expect(paths(bake({ source: 'unity' }))).toEqual(['/b/source']);
    expect(paths(bake({ createdAt: 'yesterday' }))).toEqual(['/b/createdAt']);
    expect(paths(bake({ lightsHash: 'XYZ' }))).toEqual(['/b/lightsHash']);
    expect(paths(bake({ atlases: [] }))).toContain('/b/atlases');
    expect(paths(bake({ bakedLights: ['light-0001', 'light-0001'] }))).toEqual(['/b/bakedLights']);
    expect(paths(bake({ entries: [{ entityId: 'box-0001', atlas: 1, scaleOffset: [1, 1, 0, 0] }] }))).toEqual(['/b/entries/0/atlas']);
    expect(paths(bake({ entries: [{ entityId: 'box-0001', atlas: 0, scaleOffset: [0, 1, 0, 0] }] }))).toEqual(['/b/entries/0/scaleOffset']);
    expect(
      paths(
        bake({
          entries: [
            { entityId: 'box-0001', atlas: 0, scaleOffset: [1, 1, 0, 0] },
            { entityId: 'box-0001', atlas: 0, scaleOffset: [1, 1, 0, 0] },
          ],
        }),
      ),
    ).toEqual(['/b/entries/1/entityId']);
  });

  it('keys content.lighting by scene id', () => {
    const errors: { path: string }[] = [];
    validateLighting({ 'Scene A': bake() }, '/lighting', errors as never);
    expect(errors.map((e) => e.path)).toEqual(['/lighting/Scene A']);
  });
});
