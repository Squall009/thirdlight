/**
 * The Scene view draws a building's interior in its interior scene while that
 * scene is open, wherever the building is, made from the building's one
 * definition (and the same objects until the building changes); a
 * furnished building's lights as the build makes them, within the scene's
 * light budget.
 */
import { describe, expect, it } from 'vitest';
import { architectureStylesOf, buildingInteriorId, furnishingLightEntity, MAX_LOCAL_LIGHTS } from '@thirdlight/runtime';

import { withSceneViewInteriors, withSceneViewLights } from './building-interiors';
import type { ProjectedEntity } from './projection';

const entity = (id: string, sceneId: string, components: Record<string, unknown>): ProjectedEntity => ({
  id,
  name: id,
  parentId: null,
  kind: 'entity',
  active: true,
  visible: true,
  locked: false,
  static: false,
  keepLoaded: false,
  tags: 0,
  position: [5, 0, 5],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
  sceneId,
  components,
});

const house = entity('rooms', 'outside', {
  transform: { position: [5, 0, 5], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
  architecture: { elements: [], buildings: [{ id: 'b', preset: 'starter-room', path: { points: [[0, 0, 0], [4, 0, 0], [4, 0, 4], [0, 0, 4]], closed: true }, interior: { scene: 'inside', offset: [0, -50, 0] } }] },
});
const lamp = entity('lamp', 'inside', {});

describe('building interiors in the Scene view', () => {
  it('adds the interior while its scene is open (the building\'s own may be closed), at the building\'s place moved by the offset', () => {
    const visible = [lamp];
    const all = [house, lamp];
    expect(withSceneViewInteriors(visible, all, new Set(['outside']))).toBe(visible);
    const shown = withSceneViewInteriors(visible, all, new Set(['inside']));
    expect(shown.map((e) => e.id)).toEqual(['lamp', buildingInteriorId('rooms', 'b')]);
    const interior = shown[1]!;
    expect(interior.sceneId).toBe('inside');
    expect(interior.position).toEqual([5, -50, 5]);
    expect((interior.components['architecture'] as { interiorOf: unknown }).interiorOf).toEqual({ scene: 'outside', entity: 'rooms' });
    // The same object while the building is the same (the view re-makes nothing); a new one when it changes.
    expect(withSceneViewInteriors(visible, all, new Set(['inside']))[1]).toBe(interior);
    const moved = { ...house, components: { ...house.components } };
    expect(withSceneViewInteriors(visible, [moved, lamp], new Set(['inside']))[1]).not.toBe(interior);
  });
});

describe('furnishing lights in the Scene view', () => {
  // Test data: a two-room program and a set with one light per room.
  const table = architectureStylesOf([
    { graphId: 'p', kind: 'room-program', graph: { nodes: [{ id: 'program', type: 'program', position: [0, 0] }, { id: 'a', type: 'room', position: [0, 0], data: { type: 'a' } }, { id: 'b', type: 'room', position: [0, 0], data: { type: 'b' } }], edges: [] } },
    { graphId: 'f', kind: 'furnishing-set', graph: { nodes: [{ id: 'furnishing', type: 'furnishing', position: [0, 0], data: { lights: 4 } }, { id: 'l', type: 'light', position: [0, 0] }], edges: [] } },
  ]);
  const furnished = entity('rooms', 'outside', {
    transform: { position: [5, 0, 5], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    architecture: { elements: [], buildings: [{ id: 'b', preset: 'starter-room', program: 'p', furnishing: 'f', path: { points: [[0, 0, 0], [8, 0, 0], [8, 0, 6], [0, 0, 6]], closed: true } }] },
  });

  it('adds a light object per furnished room, the building object\'s child, the same objects while nothing changes, within the budget', () => {
    const shown = withSceneViewLights([furnished], table);
    const lights = shown.filter((e) => e.kind === 'light');
    expect(lights).toHaveLength(2);
    expect(lights.every((l) => l.parentId === 'rooms' && l.light?.type === 'point' && l.sceneId === 'outside')).toBe(true);
    expect(withSceneViewLights([furnished], table).find((e) => e.kind === 'light')).toBe(lights[0]);
    expect(lights[0]!.id).toBe(furnishingLightEntity({ id: 'rooms', components: furnished.components }, { id: 'b-r1-light', room: 'b-r1', position: [0, 0, 0], color: '#ffffff', intensity: 1, range: 1 }).id);
    const lamps = Array.from({ length: MAX_LOCAL_LIGHTS - 1 }, (_x, i) => ({ ...entity(`lamp-${i}`, 'outside', {}), kind: 'light' as const, light: { type: 'point' as const, color: '#ffffff', intensity: 1 } }));
    expect(withSceneViewLights([furnished, ...lamps], table).length - lamps.length - 1).toBe(1);
  });
});
