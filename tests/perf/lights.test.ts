/**
 * The many-lights class's plan without a browser: its one scene is one the
 * model accepts (so the backend's commands take it as built), the lights
 * are the mix the class names (points and spots, the shadowed ones of both
 * kinds, a few area lights), the field is lit densely enough that a pixel
 * sees many lights, and a count builds the same plan every time. With
 * walkers, the figures' loop passes under every shadowed lamp and the
 * script's own sum puts a walker where the plan's does.
 */
import { describe, expect, it } from 'vitest';

import { validateSceneV4 } from '@thirdlight/project-model';

import { DEFAULT_FIXED_STEP_HZ } from '@thirdlight/project-model';

import { DEFAULT_LIGHTS_OPTIONS, LIGHTS_COUNTS, LIGHTS_SPEC, lightsPlan, meanLightsReaching, walkAt } from '../../tools/perf/lights';

const sceneDoc = (entities: unknown[]): unknown => ({ schemaVersion: 4, sceneId: 'main', revision: 1, entities: entities.map((e) => ({ parentId: null, ...(e as object) })) });

describe('the many-lights class', () => {
  it.each(LIGHTS_COUNTS)('%i lights: one valid scene holding exactly that many local lights, the mix and the shadowed ones as named', (n) => {
    const plan = lightsPlan(n);
    expect(plan.scenes).toHaveLength(1);
    const r = validateSceneV4(sceneDoc(plan.scenes[0]!.entities));
    expect(r.ok ? [] : r.errors.slice(0, 3)).toEqual([]);
    const lights = plan.scenes[0]!.entities.map((e) => e.components['light'] as Record<string, unknown> | undefined).filter((l) => l !== undefined);
    const local = lights.filter((l) => l['type'] === 'point' || l['type'] === 'spot');
    expect(local).toHaveLength(n);
    expect(plan.counts.point + plan.counts.spot).toBe(n);
    expect(plan.counts.spot).toBeGreaterThan(n / 4);
    expect(lights.filter((l) => l['type'] === 'area')).toHaveLength(LIGHTS_SPEC.areaRects + LIGHTS_SPEC.areaLines);
    expect(local.filter((l) => l['castShadow'] === true)).toHaveLength(DEFAULT_LIGHTS_OPTIONS.shadowed);
    expect(plan.counts.shadowedPoint).toBe(DEFAULT_LIGHTS_OPTIONS.shadowed / 2);
    expect(plan.counts.shadowedSpot).toBe(DEFAULT_LIGHTS_OPTIONS.shadowed / 2);
    expect(plan.scenes[0]!.sceneId).toBe('scene-main');
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

  it('walkers: figures spread round a loop under every shadowed lamp (and under as many without shadows), moved by a script that walks it as the plan does', () => {
    expect(lightsPlan(64).scenes[0]!.entities.some((e) => e.id.startsWith('walker-'))).toBe(false);
    const plan = lightsPlan(64, { ...DEFAULT_LIGHTS_OPTIONS, walkers: 4 });
    const walkers = plan.scenes[0]!.entities.filter((e) => e.id.startsWith('walker-'));
    expect(walkers).toHaveLength(4);
    expect(plan.counts.walkers).toBe(4);
    const r = validateSceneV4(sceneDoc(plan.scenes[0]!.entities));
    expect(r.ok ? [] : r.errors.slice(0, 3)).toEqual([]);
    // The loop holds a point under each shadowed lamp, and nothing else.
    const under = plan.locals.filter((l) => l.shadowed).map((l) => [l.at[0], l.at[2]]);
    expect(plan.walk).toHaveLength(under.length);
    for (const [x, z] of under) expect(plan.walk.some(([wx, wz]) => Math.hypot(wx - x!, wz - z!) < 1e-9)).toBe(true);
    // The script (its TypeScript annotations stripped) puts a walker where `walkAt` does, at its phase and after walking.
    const js = plan.walker!.source.replace(/: \[number, number\]\[\]/, '').replace(/\(state: any, ctx: any\)/, '(state, ctx)').replace('export default', 'return');
    const behavior = new Function(js)() as { step(state: unknown, ctx: unknown): void };
    for (const w of walkers) {
      const phase = (w.components['behavior'] as { values: { phase: number } }).values.phase;
      const len = plan.walk.reduce((sum, a, i) => sum + Math.hypot(plan.walk[(i + 1) % plan.walk.length]![0] - a[0], plan.walk[(i + 1) % plan.walk.length]![1] - a[1]), 0);
      for (const stepIndex of [0, 1234, 98765]) {
        const emitted: { position: { x: number; y: number; z: number } }[] = [];
        behavior.step({}, { phase: 'transform', stepIndex, entityId: w.id, properties: { phase }, emit: (e: { position: { x: number; y: number; z: number } }) => emitted.push(e) });
        const want = walkAt(plan.walk, phase * len + (stepIndex / DEFAULT_FIXED_STEP_HZ) * LIGHTS_SPEC.walkSpeed);
        expect(emitted).toHaveLength(1);
        expect(Math.hypot(emitted[0]!.position.x - want[0], emitted[0]!.position.z - want[2])).toBeLessThan(0.01);
      }
    }
    // Without shadows (the run to compare with) the walkers still walk, under as many lamps.
    const bare = lightsPlan(64, { ...DEFAULT_LIGHTS_OPTIONS, walkers: 4, shadowed: 0 });
    expect(bare.counts.walkers).toBe(4);
    expect(bare.walk).toHaveLength(plan.walk.length);
  });
});
