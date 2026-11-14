import { describe, expect, it } from 'vitest';

import { ResidentBytes } from './resident-bytes';

describe('resident bytes by budget', () => {
  it("adds a budget's readers up, leaves out a budget no reader knows, and forgets a reader once unregistered", () => {
    const r = new ResidentBytes();
    let a = 100;
    const offA = r.register('voxelStream', () => a);
    const offB = r.register('voxelStream', () => 50);
    r.register('physics', () => null);
    r.register('textures', () => {
      throw new Error('gone');
    });
    expect(r.read()).toEqual({ voxelStream: 150 });
    a = 300;
    expect(r.read()).toEqual({ voxelStream: 350 });
    offA();
    expect(r.read()).toEqual({ voxelStream: 50 });
    offB();
    offB();
    expect(r.read()).toEqual({});
    // A reader of nonsense counts as not knowing.
    r.register('probes', () => Number.NaN);
    r.register('farGpu', () => -1);
    expect(r.read()).toEqual({});
  });
});
