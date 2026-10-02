/**
 * A new project's starter camera and lights are the same values
 * the GameObject menu and "+ Add component" create (the virtual camera
 * descriptor's Camera entry and the light's Directional / Ambient presets) —
 * one set of genre-neutral defaults, not two drifting copies.
 */
import { describe, expect, it } from 'vitest';
import { DESCRIPTORS, VIRTUAL_CAMERA_LIMITS } from '@thirdlight/project-model';
import { defaultProjectFilesV4 } from './store-v4';

describe('starter content = the descriptor defaults', () => {
  const r = defaultProjectFilesV4('starter', 'Starter', '2026-09-24T00:00:00Z', '0.1.0');
  if (!r.ok) throw new Error(r.message);
  const entities = r.files.project.scene.entities as unknown as { components: Record<string, unknown> }[];
  const light = DESCRIPTORS.components.find((c) => c.name === 'light')!;
  const camera = DESCRIPTORS.components.find((c) => c.name === 'virtualCamera')!;
  const preset = (label: string): unknown => light.presets!.find((p) => p.label === label)!.value;
  const lightOf = (type: string): unknown => entities.map((e) => e.components['light'] as { type?: string } | undefined).find((l) => l?.type === type);

  it('the sun is the Directional light preset', () => {
    expect(lightOf('directional')).toEqual(preset('Directional light'));
  });

  it('the ambient is the Ambient light preset', () => {
    expect(lightOf('ambient')).toEqual(preset('Ambient light'));
  });

  it('the camera is the GameObject menu\'s Camera, at the lowest priority (any camera added later goes live over it), kept loaded', () => {
    const made = camera.create?.find((c) => c.label === 'Camera')?.value;
    expect(made).toEqual({ rig: 'fixed' });
    const cam = entities.find((e) => e.components['virtualCamera'] !== undefined) as { keepLoaded?: boolean; components: Record<string, unknown> } | undefined;
    expect(cam?.components['virtualCamera']).toEqual({ ...(made as object), priority: VIRTUAL_CAMERA_LIMITS.priority.min });
    expect(cam?.keepLoaded).toBe(true);
    expect(entities.some((e) => e.components['camera'] !== undefined)).toBe(false);
  });
});
