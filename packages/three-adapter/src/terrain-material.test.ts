import { describe, expect, it } from 'vitest';
import { WORLD_UV_PERIOD_METRES } from '@thirdlight/runtime';

import { terrainUvShift } from './terrain-material';

describe('terrain texture coordinates', () => {
  it('count from the object without a texture origin (the look before it existed)', () => {
    expect(terrainUvShift([-256, 3, 40], undefined)).toEqual([0, 0]);
  });
  it('count from the texture origin: shifted by the object less the origin, within a period', () => {
    // A terrain at (−256, −256) meeting a block layer at (−28, −4): its UV 0 lies (−228, −252) from the layer's, i.e. 492 and 468 within 720.
    expect(terrainUvShift([-256, 0, -256], [-28, -4])).toEqual([WORLD_UV_PERIOD_METRES - 228, WORLD_UV_PERIOD_METRES - 252]);
    expect(terrainUvShift([10, 0, 20], [10, 20])).toEqual([0, 0]);
    expect(terrainUvShift([1450, 0, 0], [10, 0])).toEqual([0, 0]);
  });
});
