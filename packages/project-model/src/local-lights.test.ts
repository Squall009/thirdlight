/**
 * Phase 9.5 (v4): point, spot and hemisphere lights and the light mode.
 */
import { describe, expect, it } from 'vitest';

import { validateSceneV4 } from './scene-v3';

const T = { position: [0, 2, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const scene = (lights: Record<string, unknown>[]) => ({
  schemaVersion: 4,
  sceneId: 'scene-a',
  revision: 1,
  entities: lights.map((light, i) => ({ id: `light-${String(i + 1).padStart(4, '0')}`, components: { transform: T, light } })),
});
const ok = (lights: Record<string, unknown>[]) => {
  const r = validateSceneV4(scene(lights));
  return r.ok ? r : (expect.fail(JSON.stringify(r.errors)) as never);
};

describe('local lights (v4)', () => {
  it('accepts point, spot and hemisphere lights and keeps their fields', () => {
    const r = ok([
      { type: 'point', color: '#FFAA00', intensity: 40, range: 8, decay: 2, castShadow: true, mode: 'mixed' },
      { type: 'spot', color: '#ffffff', intensity: 200, range: 12, angle: 25, penumbra: 0.3, direction: [0, -1, 0] },
      { type: 'hemisphere', color: '#bcd7ff', groundColor: '#5A4A38', intensity: 0.8 },
      { type: 'directional', color: '#ffffff', intensity: 1, direction: [0, -1, 0], mode: 'baked' },
    ]);
    const lights = r.normalized.entities.map((e) => (e.components as unknown as { light: Record<string, unknown> }).light);
    expect(lights[0]).toEqual({ type: 'point', color: '#ffaa00', intensity: 40, castShadow: true, range: 8, decay: 2, mode: 'mixed' });
    expect(lights[1]).toMatchObject({ type: 'spot', angle: 25, penumbra: 0.3, direction: [0, -1, 0] });
    expect(lights[2]).toEqual({ type: 'hemisphere', color: '#bcd7ff', intensity: 0.8, groundColor: '#5a4a38' });
    expect(lights[3]).toMatchObject({ type: 'directional', mode: 'baked' });
  });

  it('refuses wrong fields, ranges, a spot without direction and too many lights', () => {
    expect(validateSceneV4(scene([{ type: 'point', color: '#ffffff', intensity: 5, angle: 30 }])).ok).toBe(false);
    expect(validateSceneV4(scene([{ type: 'point', color: '#ffffff', intensity: 5000 }])).ok).toBe(false);
    expect(validateSceneV4(scene([{ type: 'spot', color: '#ffffff', intensity: 5 }])).ok).toBe(false);
    expect(validateSceneV4(scene([{ type: 'spot', color: '#ffffff', intensity: 5, angle: 95, direction: [0, -1, 0] }])).ok).toBe(false);
    expect(validateSceneV4(scene([{ type: 'point', color: '#ffffff', intensity: 5, mode: 'sometimes' }])).ok).toBe(false);
    expect(validateSceneV4(scene(Array.from({ length: 17 }, () => ({ type: 'point', color: '#ffffff', intensity: 5 })))).ok).toBe(false);
    expect(validateSceneV4(scene([{ type: 'hemisphere', color: '#ffffff', intensity: 1 }, { type: 'hemisphere', color: '#ffffff', intensity: 1 }])).ok).toBe(false);
  });
});
