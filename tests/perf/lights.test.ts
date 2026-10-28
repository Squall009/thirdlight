/**
 * The many-lights class's plan without a browser: every scene it makes is one
 * the model accepts (so the backend's commands take it as built), the lights
 * are the mix the class names (points and spots, the shadowed ones of both
 * kinds, a few area lights), the field is lit densely enough that a pixel
 * sees many lights, and a count builds the same plan every time.
 */
import { describe, expect, it } from 'vitest';

import { MAX_LOCAL_LIGHTS, takesLocalLightSlot, validateSceneV4 } from '@thirdlight/project-model';

import { DEFAULT_LIGHTS_OPTIONS, LIGHTS_COUNTS, LIGHTS_SPEC, lightsPlan, meanLightsReaching } from '../../tools/perf/lights';

const sceneDoc = (entities: unknown[]): unknown => ({ schemaVersion: 4, sceneId: 'main', revision: 1, entities: entities.map((e) => ({ parentId: null, ...(e as object) })) });

describe('the many-lights class', () => {
  it.each(LIGHTS_COUNTS)('%i lights: valid scenes holding exactly that many local lights, the mix and the shadowed ones as named', (n) => {
    const plan = lightsPlan(n);
    for (const s of plan.scenes) {
      const r = validateSceneV4(sceneDoc(s.entities));
      expect(r.ok ? [] : r.errors.slice(0, 3)).toEqual([]);
      expect(s.entities.filter((e) => takesLocalLightSlot(e.components['light'])).length).toBeLessThanOrEqual(MAX_LOCAL_LIGHTS);
    }
    const lights = plan.scenes.flatMap((s) => s.entities.map((e) => e.components['light'] as Record<string, unknown> | undefined)).filter((l) => l !== undefined);
    const local = lights.filter((l) => takesLocalLightSlot(l));
    expect(local).toHaveLength(n);
    expect(plan.counts.point + plan.counts.spot).toBe(n);
    expect(plan.counts.spot).toBeGreaterThan(n / 4);
    expect(lights.filter((l) => l['type'] === 'area')).toHaveLength(LIGHTS_SPEC.areaRects + LIGHTS_SPEC.areaLines);
    expect(local.filter((l) => l['castShadow'] === true)).toHaveLength(DEFAULT_LIGHTS_OPTIONS.shadowed);
    expect(plan.counts.shadowedPoint).toBe(DEFAULT_LIGHTS_OPTIONS.shadowed / 2);
    expect(plan.counts.shadowedSpot).toBe(DEFAULT_LIGHTS_OPTIONS.shadowed / 2);
    expect(plan.scenes[0]!.sceneId).toBe('scene-main');
    expect(plan.scenes).toHaveLength(Math.ceil(n / MAX_LOCAL_LIGHTS));
  });

  it('lights a floor point with more lights as the count grows (about one in fourteen of them)', () => {
    const reach = LIGHTS_COUNTS.map((n) => meanLightsReaching(lightsPlan(n)));
    expect(reach[0]).toBeGreaterThan(3);
    for (let i = 1; i < reach.length; i += 1) expect(reach[i]!).toBeGreaterThan(reach[i - 1]! * 3);
    expect(reach[2]).toBeGreaterThan(60);
  });

  it('builds the same plan for a count every time, and refuses a count that is not a whole number above 0', () => {
    expect(lightsPlan(256)).toEqual(lightsPlan(256));
    for (const bad of [0, -1, 1.5]) expect(() => lightsPlan(bad)).toThrow(/a count is a whole number/);
  });
});
