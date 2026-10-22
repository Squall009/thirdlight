/**
 * The See-through preview's subject: the selection when a camera would
 * follow it, else the camera's target, else none.
 */
import { describe, expect, it } from 'vitest';

import type { ProjectedEntity } from '../session/projection';
import { previewSubject } from './see-through-preview';

function entity(id: string, extra: Partial<ProjectedEntity> = {}): ProjectedEntity {
  return { id, name: id, parentId: null, active: true, locked: false, static: false, tags: 0, kind: 'box', position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], components: {}, ...extra } as ProjectedEntity;
}

describe('see-through preview subject', () => {
  const hero = entity('hero', { kind: 'entity', controller: true });
  const crate = entity('crate');
  const root = entity('root', { kind: 'entity' });
  const part = entity('part', { kind: 'model', parentId: 'root' });
  const lamp = entity('lamp', { kind: 'light' });
  const floor = entity('floor', { kind: 'entity', components: { blockLayer: {} } });
  const low = entity('cam-low', { kind: 'entity', components: { virtualCamera: { rig: 'follow', priority: 1, target: 'crate' } } });
  const high = entity('cam-high', { kind: 'entity', components: { virtualCamera: { rig: 'follow', priority: 5, target: 'hero' } } });
  const off = entity('cam-off', { kind: 'entity', components: { virtualCamera: { rig: 'follow', priority: 9, enabled: false, target: 'crate' } } });
  const all = [part, root, hero, crate, lamp, floor, low, high, off];

  it('a box, a model, a character or a prefab root selected: itself', () => {
    expect(previewSubject('crate', all)).toBe('crate');
    expect(previewSubject('hero', all)).toBe('hero');
    expect(previewSubject('root', all)).toBe('root');
  });

  it('nothing suitable selected: the live camera’s target (enabled, highest priority)', () => {
    for (const sel of [null, 'lamp', 'floor', 'cam-low', 'gone']) expect(previewSubject(sel, all)).toBe('hero');
  });

  it('no camera with a target in the scene: none', () => {
    expect(previewSubject(null, [crate, lamp, entity('cam', { kind: 'entity', components: { virtualCamera: { rig: 'follow', target: 'missing' } } })])).toBeNull();
  });
});
