/**
 * The See-through preview's subject: the selection when a camera would
 * follow it, else the camera's target, else none; and what it hands the
 * adapter's real see-through view (the subject, and the project's setting
 * arming the view ahead).
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { SEE_THROUGH_DEFAULTS } from '@thirdlight/runtime';
import { SeeThroughView, type SceneAdapter } from '@thirdlight/three-adapter';

import type { ProjectedEntity } from '../session/projection';
import { previewSubject, SeeThroughPreview } from './see-through-preview';

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

  it('hands the view its subject; with the project\'s setting on the view is on from load round no one (armed: the switch then builds nothing), off it arms at the first switch-on', () => {
    const camera = new THREE.PerspectiveCamera();
    for (const projectOn of [true, false]) {
      const view = new SeeThroughView({ matrix: () => false, drawn: () => [], components: () => ({}), cameraTarget: () => 'hero' });
      const adapter = { seeThrough: () => view } as unknown as SceneAdapter;
      const r = { contextNode: { value: {}, needsUpdate: false } };
      const preview = new SeeThroughPreview();
      const settings = { ...SEE_THROUGH_DEFAULTS, enabled: projectOn };
      preview.set(false, settings);
      preview.apply(adapter, null, all, true);
      view.update(r, camera, 0);
      expect(view.diagnostics(), `project ${projectOn ? 'on' : 'off'}`).toMatchObject({ enabled: projectOn, armed: projectOn });
      // Round no one: not the camera's target.
      if (projectOn) expect(view.subjects()).toEqual([]);
      // A prefab root selected: it is the subject.
      preview.set(true, settings);
      expect(preview.apply(adapter, 'root', all)).toBe(true);
      view.update(r, camera, 16);
      expect(view.subjects()).toEqual(['root']);
      expect(view.diagnostics()).toMatchObject({ enabled: true, armed: true });
      // Off again: it stays armed (building the shaders back would hold the view again).
      preview.set(false, settings);
      preview.apply(adapter, 'root', all);
      view.update(r, camera, 32);
      expect(view.diagnostics()).toMatchObject({ enabled: projectOn, armed: true });
    }
  });
});
