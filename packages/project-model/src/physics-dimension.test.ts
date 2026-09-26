/**
 * Phase 23.0: the `physics_dimension` setting (2 the 2D plane, absent = 2;
 * 3 the 3D backend) and the data rules that follow it: a box collider's
 * optional depth `hz` and the capsule offset's optional third component
 * (both kept by the canonical form; absent keeps the old bytes); in a 2D
 * project the rotation about Z only rule (as before); in a 3D project any
 * collider rotation, a box needs `hz` (no guessed depth), no polygons, the
 * controller upright.
 */
import { describe, expect, it } from 'vitest';

import { validateProjectV4 } from './project-v4';
import { canonicalController } from './components';
import { physicsDimensionOf, resolveGameplaySettings } from './content';
import { validateSceneV3, validateSceneV4 } from './scene-v3';

const T = (rotation: number[] = [0, 0, 0, 1], position: number[] = [0, 0, 0]) => ({ position, rotation, scale: [1, 1, 1] });
const TILT_X = [Math.sin(Math.PI / 8), 0, 0, Math.cos(Math.PI / 8)];
const MANIFEST = { schemaVersion: 2, engineVersion: '0.1.0', id: 'p', name: 'P', createdAt: '2026-09-23T00:00:00Z' };
const content = (settings: Record<string, unknown>) => ({
  assets: [],
  prefabs: [],
  behaviors: [],
  settings,
  behaviorTrust: { entries: [] },
  game: null,
  scenes: [{ sceneId: 'scene-main', name: 'Main' }],
  startScenes: ['scene-main'],
});
const CAMERA = { id: 'cam-main', components: { transform: T(undefined, [0, 2, 10]), camera: { type: 'perspective', fovY: 60, near: 0.1, far: 100 } } };
const scene = (entities: unknown[]) => ({ schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities });
const floor = (shape: Record<string, unknown>, rotation?: number[]) => ({ id: 'floor-0001', components: { transform: T(rotation, [0, -0.5, 0]), collider: { shape } } });
const player = (rotation?: number[], capsule?: Record<string, unknown>) => ({ id: 'player-0001', components: { transform: T(rotation, [0, 2, 0]), controller: capsule !== undefined ? { capsule } : {} } });

function problems(settings: Record<string, unknown>, entities: unknown[]): { code: string; reason?: string; path: string }[] {
  const r = validateProjectV4(MANIFEST, content(settings), [scene([...entities, CAMERA])]);
  return r.ok ? [] : r.errors.map((e) => ({ code: e.code, path: e.path, ...(e.reason !== undefined ? { reason: e.reason } : {}) }));
}

describe('the physics_dimension setting', () => {
  it('is optional: absent resolves to the 2D plane and stays out of the resolved settings', () => {
    const plain = resolveGameplaySettings({ settings: {} });
    expect(plain.ok && Object.keys(plain.normalized)).not.toContain('physics_dimension');
    expect(physicsDimensionOf({})).toBe(2);
    expect(physicsDimensionOf({ physics_dimension: 2 })).toBe(2);
    expect(physicsDimensionOf({ physics_dimension: 3 })).toBe(3);
    expect(resolveGameplaySettings({ settings: { physics_dimension: 4 } }).ok).toBe(false);
  });
});

describe('collider depth and capsule z (canonical form)', () => {
  it('keeps hz and the third offset component; absent keeps the old shape', () => {
    const v = validateSceneV4(scene([floor({ type: 'box', hx: 2, hy: 0.5, hz: 3 }), player(undefined, { radius: 0.3, height: 1.8, offset: [0, 0.1, 0.2] })]));
    expect(v.ok, JSON.stringify(!v.ok && v.errors)).toBe(true);
    if (!v.ok) return;
    expect(v.normalized.entities[0]!.components.collider).toEqual({ shape: { type: 'box', hx: 2, hy: 0.5, hz: 3 } });
    expect((v.normalized.entities[1]!.components.controller as { capsule: unknown }).capsule).toEqual({ radius: 0.3, height: 1.8, offset: [0, 0.1, 0.2] });
    expect(canonicalController({ capsule: { radius: 0.3, height: 1.8, offset: [0.1, 0.2] } })).toEqual({ capsule: { radius: 0.3, height: 1.8, offset: [0.1, 0.2] } });
    const flat = validateSceneV4(scene([floor({ type: 'box', hx: 2, hy: 0.5 })]));
    expect(flat.ok && flat.normalized.entities[0]!.components.collider).toEqual({ shape: { type: 'box', hx: 2, hy: 0.5 } });
    expect(validateSceneV4(scene([floor({ type: 'box', hx: 2, hy: 0.5, hz: 0 })])).ok).toBe(false);
    expect(validateSceneV4(scene([player(undefined, { radius: 0.3, height: 1.8, offset: [0, 0, 0, 0] })])).ok).toBe(false);
  });
});

describe('the rules that follow the dimension', () => {
  it('2D plane (absent or 2): a collider rotated off Z is refused, as before', () => {
    for (const settings of [{}, { physics_dimension: 2 }]) {
      expect(problems(settings, [floor({ type: 'box', hx: 2, hy: 0.5 }, TILT_X)])).toEqual([{ code: 'physics_transform_unsupported', reason: 'rotation', path: '/entities/0/transform/rotation' }]);
      expect(problems(settings, [floor({ type: 'box', hx: 2, hy: 0.5 }), player()])).toEqual([]);
      expect(problems(settings, [floor({ type: 'polygon', vertices: [[-1, -1], [1, -1], [0, 1]] })])).toEqual([]);
    }
    // A v3 document keeps the rule on its own.
    const v3 = validateSceneV3({ schemaVersion: 3, sceneId: 'scene-main', revision: 1, entities: [floor({ type: 'box', hx: 2, hy: 0.5 }, TILT_X)] });
    expect(v3.ok).toBe(false);
  });

  it('3D: any collider rotation; a box needs hz; no polygon; the controller upright', () => {
    const three = { physics_dimension: 3 };
    expect(problems(three, [floor({ type: 'box', hx: 2, hy: 0.5, hz: 2 }, TILT_X), player()])).toEqual([]);
    expect(problems(three, [floor({ type: 'box', hx: 2, hy: 0.5 })])).toEqual([{ code: 'collider_shape_invalid', path: '/entities/0/components/collider/shape/hz' }]);
    expect(problems(three, [floor({ type: 'polygon', vertices: [[-1, -1], [1, -1], [0, 1]] })])).toEqual([{ code: 'collider_shape_invalid', path: '/entities/0/components/collider/shape/type' }]);
    expect(problems(three, [player([0, Math.sin(0.2), 0, Math.cos(0.2)])])).toEqual([{ code: 'physics_transform_unsupported', reason: 'upright', path: '/entities/0/transform/rotation' }]);
  });
});
