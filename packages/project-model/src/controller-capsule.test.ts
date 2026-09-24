/**
 * Phase 14.0 (v4): the player controller's collision capsule — validation,
 * the canonical form and the default when it is absent.
 */
import { describe, expect, it } from 'vitest';

import { CAPSULE_LIMITS, DEFAULT_CONTROLLER_CAPSULE, controllerCapsuleOf } from './components';
import { validateSceneV4 } from './scene-v3';

const T = { position: [0, 1, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const scene = (controller: unknown) => ({
  schemaVersion: 4,
  sceneId: 'scene-a',
  revision: 1,
  entities: [{ id: 'player-0001', components: { transform: T, controller } }],
});
const normalized = (controller: unknown): unknown => {
  const r = validateSceneV4(scene(controller));
  if (!r.ok) return expect.fail(JSON.stringify(r.errors));
  return (r.normalized.entities[0]!.components as unknown as { controller: unknown }).controller;
};
const errorPaths = (controller: unknown): string[] => {
  const r = validateSceneV4(scene(controller));
  return r.ok ? [] : r.errors.map((e) => e.path);
};

describe('controller capsule (v4)', () => {
  it('keeps an empty controller and a capsule field by field (offset only when given)', () => {
    expect(normalized({})).toEqual({});
    expect(normalized({ capsule: { height: 1, radius: 0.25 } })).toEqual({ capsule: { radius: 0.25, height: 1 } });
    expect(normalized({ capsule: { radius: 0.25, height: 1, offset: [0, 0.5] } })).toEqual({ capsule: { radius: 0.25, height: 1, offset: [0, 0.5] } });
  });

  it('refuses out-of-range values, a height under two radii, bad offsets and unknown fields', () => {
    expect(errorPaths({ capsule: { radius: 0.01, height: 1 } })).toContain('/entities/0/components/controller/capsule/radius');
    expect(errorPaths({ capsule: { radius: 6, height: 20 } })).toContain('/entities/0/components/controller/capsule/radius');
    expect(errorPaths({ capsule: { radius: 0.3, height: 25 } })).toContain('/entities/0/components/controller/capsule/height');
    expect(errorPaths({ capsule: { radius: 0.5, height: 0.8 } })).toContain('/entities/0/components/controller/capsule/height');
    expect(errorPaths({ capsule: { radius: 0.3 } })).toContain('/entities/0/components/controller/capsule/height');
    expect(errorPaths({ capsule: { radius: 0.3, height: 1, offset: [0, 6] } })).toContain('/entities/0/components/controller/capsule/offset');
    expect(errorPaths({ capsule: { radius: 0.3, height: 1, offset: [0] } })).toContain('/entities/0/components/controller/capsule/offset');
    expect(errorPaths({ capsule: { radius: 0.3, height: 1, depth: 2 } })).toContain('/entities/0/components/controller/capsule/depth');
    expect(errorPaths({ speed: 3 })).toContain('/entities/0/components/controller/speed');
    expect(errorPaths({ capsule: 'small' })).toContain('/entities/0/components/controller/capsule');
  });

  it('resolves the default capsule when the controller has none (the pre-14.0 shape)', () => {
    expect(DEFAULT_CONTROLLER_CAPSULE).toMatchObject({ radius: 0.3, height: 1.8 });
    expect(controllerCapsuleOf({})).toEqual({ radius: 0.3, height: 1.8, offset: [0, 0] });
    expect(controllerCapsuleOf(undefined)).toEqual({ radius: 0.3, height: 1.8, offset: [0, 0] });
    expect(controllerCapsuleOf({ capsule: { radius: 0.2, height: 0.9, offset: [0.1, 0.45] } })).toEqual({ radius: 0.2, height: 0.9, offset: [0.1, 0.45] });
    expect(CAPSULE_LIMITS).toEqual({ minRadius: 0.05, maxRadius: 5, minHeight: 0.1, maxHeight: 20, maxOffset: 5 });
  });
});
