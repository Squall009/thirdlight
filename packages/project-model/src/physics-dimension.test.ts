/**
 * The one physics backend: the retired `physics_dimension` setting (every
 * project is 3D; a 2D project's open upgrades it to scenes with a default
 * plane), and the data rules: a box collider's optional depth `hz` and the
 * capsule offset's optional third component (both kept by the canonical
 * form; absent keeps the old bytes), any collider rotation, a box without
 * `hz` and a polygon taking their 3D form, the controller upright.
 */
import { describe, expect, it } from 'vitest';

import { validateProjectV4 } from './project-v4';
import { canonicalController } from './components';
import { resolveGameplaySettings } from './content';
import { validateSceneV3, validateSceneV4 } from './scene-v3';

const T = (rotation: number[] = [0, 0, 0, 1], position: number[] = [0, 0, 0]) => ({ position, rotation, scale: [1, 1, 1] });
const TILT_X = [Math.sin(Math.PI / 8), 0, 0, Math.cos(Math.PI / 8)];
const MANIFEST = { schemaVersion: 8, engineVersion: '0.1.0', id: 'p', name: 'P', createdAt: '2026-09-23T00:00:00Z' };
const content = (settings: Record<string, unknown>) => ({
  assets: [],
  prefabs: [],
  behaviors: [],
  settings,
  behaviorTrust: { entries: [] },
  scenes: [{ sceneId: 'scene-main', name: 'Main' }],
  startScenes: ['scene-main'],
});
const CAMERA = { id: 'cam-main', components: { transform: T(undefined, [0, 2, 10]), virtualCamera: { rig: 'fixed' } } };
const scene = (entities: unknown[]) => ({ schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities });
const floor = (shape: Record<string, unknown>, rotation?: number[]) => ({ id: 'floor-0001', components: { transform: T(rotation, [0, -0.5, 0]), collider: { shape } } });
const player = (rotation?: number[], capsule?: Record<string, unknown>) => ({ id: 'player-0001', components: { transform: T(rotation, [0, 2, 0]), controller: capsule !== undefined ? { capsule } : {} } });

function problems(settings: Record<string, unknown>, entities: unknown[]): { code: string; reason?: string; path: string }[] {
  const r = validateProjectV4(MANIFEST, content(settings), [scene([...entities, CAMERA])]);
  return r.ok ? [] : r.errors.map((e) => ({ code: e.code, path: e.path, ...(e.reason !== undefined ? { reason: e.reason } : {}) }));
}

describe('the retired physics_dimension setting', () => {
  it('is refused in the settings', () => {
    const plain = resolveGameplaySettings({ settings: {} });
    expect(plain.ok && Object.keys(plain.normalized)).not.toContain('physics_dimension');
    expect(resolveGameplaySettings({ settings: { physics_dimension: 3 } }).ok).toBe(false);
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

describe('the rules of the one backend', () => {
  it('any collider rotation; a box without hz and a polygon take their 3D form; the controller upright', () => {
    expect(problems({}, [floor({ type: 'box', hx: 2, hy: 0.5, hz: 2 }, TILT_X), player()])).toEqual([]);
    expect(problems({}, [floor({ type: 'box', hx: 2, hy: 0.5 }, TILT_X)])).toEqual([]);
    expect(problems({}, [floor({ type: 'polygon', vertices: [[-1, -1], [1, -1], [0, 1]] })])).toEqual([]);
    expect(problems({}, [player([0, Math.sin(0.2), 0, Math.cos(0.2)])])).toEqual([{ code: 'physics_transform_unsupported', reason: 'upright', path: '/entities/0/transform/rotation' }]);
    // A v3 document (the format before the 3D backend) keeps the rotation-about-Z rule on its own.
    const v3 = validateSceneV3({ schemaVersion: 3, sceneId: 'scene-main', revision: 1, entities: [floor({ type: 'box', hx: 2, hy: 0.5 }, TILT_X)] });
    expect(v3.ok).toBe(false);
  });
});
