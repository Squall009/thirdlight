/** An instance set's chunk size (the component field and the project setting). */
import { describe, expect, it } from 'vitest';

import { instanceChunkSizeOf, M2_SETTINGS_KEYS } from './content';
import { validateInstancesComponent } from './scene-v3';
import type { ModelErrorV3 } from './errors';

const SET = { asset: { assetId: 'rock' }, buffer: 'a'.repeat(64), count: 10 };

describe('instance chunk size', () => {
  it('a set may carry chunkSize 1–4096 m', () => {
    const check = (v: unknown): ModelErrorV3[] => {
      const errors: ModelErrorV3[] = [];
      validateInstancesComponent({ ...SET, chunkSize: v }, '/c', errors);
      return errors;
    };
    expect(check(1)).toEqual([]);
    expect(check(24.5)).toEqual([]);
    expect(check(4096)).toEqual([]);
    for (const bad of [0, -3, 5000, '8', Number.NaN]) expect(check(bad)[0]?.path).toBe('/c/chunkSize');
  });

  it('the project setting is optional with a 32 m default (three-adapter INSTANCE_CHUNK_METERS)', () => {
    const spec = M2_SETTINGS_KEYS.find((s) => s.key === 'instance_chunk_m');
    expect(spec).toMatchObject({ default: 32, min: 1, max: 4096, optional: true, unit: 'm' });
    expect(instanceChunkSizeOf({})).toBeUndefined();
    expect(instanceChunkSizeOf({ instance_chunk_m: 50 })).toBe(50);
  });
});
