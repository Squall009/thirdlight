/**
 * The Scene view draws a building's interior in its interior scene while that
 * scene is open, wherever the building is, made from the building's one
 * definition (and the same objects until the building changes).
 */
import { describe, expect, it } from 'vitest';
import { buildingInteriorId } from '@thirdlight/runtime';

import { withSceneViewInteriors } from './building-interiors';
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
