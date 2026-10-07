import { describe, expect, it } from 'vitest';

import { NEW_PROJECT_SETTINGS, resolveGameplaySettings } from './index';
import { ambientOcclusionOf, RENDER_SETTINGS_DEFAULT, renderScaleOf, renderSettingsOf } from './render-settings';

describe('render settings', () => {
  it('reads the project settings, with defaults for what is absent or out of range', () => {
    expect(renderSettingsOf(undefined)).toEqual(RENDER_SETTINGS_DEFAULT);
    // Unset: GTAO, the kind every project drew before the setting existed (new projects write SSAO).
    expect(renderSettingsOf({})).toEqual({ ambientOcclusion: 'gtao', renderScale: 1, dynamicResolution: false });
    expect(renderSettingsOf(NEW_PROJECT_SETTINGS)).toMatchObject({ ambientOcclusion: 'ssao' });
    expect(renderSettingsOf({ ambient_occlusion: 2, render_scale: 0.75, dynamic_resolution: 1 })).toEqual({ ambientOcclusion: 'gtao', renderScale: 0.75, dynamicResolution: true });
    expect(renderSettingsOf({ ambient_occlusion: 0, render_scale: 0.2 })).toMatchObject({ ambientOcclusion: 'off', renderScale: 0.5 });
    expect(renderSettingsOf({ ambient_occlusion: 7, render_scale: 'x' })).toMatchObject({ ambientOcclusion: 'gtao', renderScale: 1 });
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
