import { describe, expect, it } from 'vitest';

import { NEW_PROJECT_SETTINGS, resolveGameplaySettings } from './index';
import { ambientOcclusionOf, occlusionCullingOf, occlusionCullingSettingValue, RENDER_SETTINGS_DEFAULT, renderScaleOf, renderSettingsOf } from './render-settings';

describe('render settings', () => {
  it('reads the project settings, with defaults for what is absent or out of range', () => {
    expect(renderSettingsOf(undefined)).toEqual(RENDER_SETTINGS_DEFAULT);
    // Unset: GTAO, the kind every project drew before the setting existed (new projects write SSAO).
    expect(renderSettingsOf({})).toEqual({ ambientOcclusion: 'gtao', renderScale: 1, dynamicResolution: false, occlusionCulling: 'auto' });
    expect(renderSettingsOf(NEW_PROJECT_SETTINGS)).toMatchObject({ ambientOcclusion: 'ssao' });
    expect(renderSettingsOf({ ambient_occlusion: 2, render_scale: 0.75, dynamic_resolution: 1 })).toEqual({ ambientOcclusion: 'gtao', renderScale: 0.75, dynamicResolution: true, occlusionCulling: 'auto' });
    expect(renderSettingsOf({ ambient_occlusion: 0, render_scale: 0.2 })).toMatchObject({ ambientOcclusion: 'off', renderScale: 0.5 });
    expect(renderSettingsOf({ ambient_occlusion: 7, render_scale: 'x' })).toMatchObject({ ambientOcclusion: 'gtao', renderScale: 1 });
  });

  it('occlusion culling: absent or unknown is auto (culls nothing for now), 0 off, 2 on; the setting round-trips', () => {
    expect(renderSettingsOf({}).occlusionCulling).toBe('auto');
    expect(renderSettingsOf(NEW_PROJECT_SETTINGS).occlusionCulling).toBe('auto');
    expect(renderSettingsOf({ occlusion_culling: 0 }).occlusionCulling).toBe('off');
    expect(renderSettingsOf({ occlusion_culling: 1 }).occlusionCulling).toBe('auto');
    expect(renderSettingsOf({ occlusion_culling: 2 }).occlusionCulling).toBe('on');
    expect(renderSettingsOf({ occlusion_culling: 5 }).occlusionCulling).toBe('auto');
    for (const mode of ['off', 'auto', 'on'] as const) expect(occlusionCullingOf(occlusionCullingSettingValue(mode))).toBe(mode);
    expect(occlusionCullingOf('auto')).toBe('auto');
    expect(occlusionCullingOf('hiz')).toBeUndefined();
    expect(resolveGameplaySettings({ settings: { occlusion_culling: 0 } }).ok).toBe(true);
    expect(resolveGameplaySettings({ settings: { occlusion_culling: 2 } }).ok).toBe(true);
    expect(resolveGameplaySettings({ settings: { occlusion_culling: 3 } }).ok).toBe(false);
  });

  it("takes a player's choices by name", () => {
    expect(ambientOcclusionOf('gtao')).toBe('gtao');
    expect(ambientOcclusionOf('hbao')).toBeUndefined();
    expect(renderScaleOf(0.6)).toBe(0.6);
    expect(renderScaleOf(Number.NaN)).toBeUndefined();
  });

  it('the settings validate in their ranges', () => {
    expect(resolveGameplaySettings({ settings: { ambient_occlusion: 2, render_scale: 0.5, dynamic_resolution: 1 } }).ok).toBe(true);
    expect(resolveGameplaySettings({ settings: { render_scale: 0.4 } }).ok).toBe(false);
    expect(resolveGameplaySettings({ settings: { ambient_occlusion: 3 } }).ok).toBe(false);
  });
});
