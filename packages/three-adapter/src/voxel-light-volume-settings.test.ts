import { describe, expect, it } from 'vitest';
import { LIGHTING_TIER_SETTINGS, LIGHTING_TIERS } from '@thirdlight/project-model';

import { VOLUME_WINDOW_BRICKS } from './voxel-light-volume-layout';
import { volumeSettingsOf, volumeSettingsWithFlag, volumeShareFromFlag } from './voxel-light-volume-settings';

describe('the light volume\'s settings as the volume reads them', () => {
  it('takes every tier\'s settings whole (a switch as 0 or 1), its level-0 window within the layout\'s the index wraps by', () => {
    for (const t of LIGHTING_TIERS) {
      const v = LIGHTING_TIER_SETTINGS[t].voxelLightVolume;
      const s = volumeSettingsOf(v);
      expect(Object.keys(s).sort()).toEqual(Object.keys(v).sort());
      expect(s.reachCoarse).toBe(v.reachCoarse ? 1 : 0);
      expect(s.windowBricks).toBeLessThanOrEqual(VOLUME_WINDOW_BRICKS[0]);
      expect(s.windowBricks >> 1).toBeLessThanOrEqual(VOLUME_WINDOW_BRICKS[1]);
    }
  });

  it('lays a comparison flag\'s known values over them, nothing else; the shares by the flag or the table\'s', () => {
    const low = volumeSettingsOf(LIGHTING_TIER_SETTINGS.low.voxelLightVolume);
    expect(volumeSettingsWithFlag(low, null)).toBe(low);
    expect(volumeSettingsWithFlag(low, 'followWindow:4,outerSettle:8,nonsense:3,rays:-1')).toEqual({ ...low, followWindow: 4, outerSettle: 8 });
    expect(volumeSettingsWithFlag(low, 'reachCoarse:1').reachCoarse).toBe(1);
    expect(volumeShareFromFlag('liveMs:4.5,idleMs:2', 'liveMs')).toBe(4.5);
    expect(volumeShareFromFlag('liveMs:4.5,idleMs:2', 'idleMs')).toBe(2);
    expect(volumeShareFromFlag('followWindow:4', 'liveMs')).toBeNull();
    expect(volumeShareFromFlag(null, 'idleMs')).toBeNull();
  });
});
