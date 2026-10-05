/**
 * The authored scene drawn through the scene adapter (no renderer needed:
 * `sync` brings the adapter's world up to date): documents, world matrices,
 * edits that realize an entity again or only move it, overlays that ride on
 * an entity, inactive objects and the editor lighting rig.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createSceneAdapter, type SceneAdapter } from '@thirdlight/three-adapter';

import type { ProjectedEntity } from '../session/projection';
import { SceneSource } from './scene-source';

function entity(id: string, over: Partial<ProjectedEntity> = {}): ProjectedEntity {
  const position = over.position ?? [0, 0, 0];
  return {
    id,
    name: id,
    parentId: null,
    kind: 'box',
    active: true,
    visible: true,
    locked: false,
    static: false,
    keepLoaded: false,
    tags: 0,
    position,
    rotation: [0, 0, 0, 1],
    scale: [1, 1, 1],
    sceneId: 'scene-main',
    components: { transform: { position, rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, box: { size: [1, 1, 1], material: { color: '#808080' } } },
    ...over,
  };
}

function setup(entities: ProjectedEntity[]): { source: SceneSource; adapter: SceneAdapter } {
  const source = new SceneSource({ assetKey: () => '', instanceChunkSize: () => undefined });
  source.setCamera(new THREE.PerspectiveCamera());
  source.sync(entities, null);
  const adapter = createSceneAdapter(null, { runtime: source, snapshot: { scene: { schemaVersion: 4, entities: [] }, scenes: [] } as never });
  adapter.sync!();
  return { source, adapter };
}

const at = (adapter: SceneAdapter, id: string): number[] => {
  const m = new THREE.Matrix4();
  expect(adapter.worldMatrix!(id, m)).toBe(true);
  return new THREE.Vector3().setFromMatrixPosition(m).toArray();
};

describe('SceneSource through the scene adapter', () => {
  it('draws the authored boxes with their world matrices, children under their parents', () => {
    const parent = entity('p', { kind: 'entity', position: [10, 0, 0], components: { transform: { position: [10, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } } });
    const child = entity('c', { parentId: 'p', position: [0, 2, 0] });
    const { adapter } = setup([parent, child]);
    expect(at(adapter, 'c')).toEqual([10, 2, 0]);
    // Only the box is in the scene; the logic-only parent has no Object3D.
    const meshes = adapter.threeScene!().children.filter((o) => (o as THREE.Mesh).isMesh === true);
    expect(meshes).toHaveLength(1);
    expect(adapter.entityOf!(meshes[0]!)).toBe('c');
    expect(adapter.entityObject!('p')).toBeNull();
  });

  it('a transform edit moves the entity; a component edit realizes it again', () => {
    const a = entity('a');
    const { source, adapter } = setup([a]);
    const node = adapter.entityObject!('a');
    const moved = entity('a', { position: [3, 0, 0] });
    source.sync([moved], [moved]);
    adapter.sync!();
    expect(at(adapter, 'a')).toEqual([3, 0, 0]);
    // The same node: nothing realized again for a move.
    expect(adapter.entityObject!('a')).toBe(node);
    const resized = entity('a', { position: [3, 0, 0], components: { ...moved.components, box: { size: [2, 2, 2], material: { color: '#808080' } } } });
    source.sync([resized], [resized]);
    adapter.sync!();
    expect(adapter.entityObject!('a')).not.toBe(node);
    expect(at(adapter, 'a')).toEqual([3, 0, 0]);
  });

  it('a gizmo override draws the entity there until it is cleared', () => {
    const { source, adapter } = setup([entity('a')]);
    source.setOverride('a', { position: [0, 5, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
    adapter.sync!();
    expect(at(adapter, 'a')).toEqual([0, 5, 0]);
    source.setOverride('a', null);
    adapter.sync!();
    expect(at(adapter, 'a')).toEqual([0, 0, 0]);
  });

  it('an overlay rides on its entity, stays when the entity is realized again, and hides with it', () => {
    const a = entity('a', { kind: 'entity', components: { transform: { position: [1, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } }, position: [1, 0, 0] });
    const { source, adapter } = setup([a]);
    const icon = new THREE.Group();
    const line = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial());
    icon.add(line);
    adapter.attachOverlay!('a', icon);
    adapter.sync!();
    const scene = adapter.threeScene!();
    expect(scene.children).toContain(line);
    expect(new THREE.Vector3().setFromMatrixPosition(line.matrixWorld).toArray()).toEqual([1, 0, 0]);
    // A component edit: the entity is realized again, the overlay comes back on it.
    const tagged = { ...a, components: { ...a.components, playerSpawn: {} } };
    source.sync([tagged], [tagged]);
    adapter.sync!();
    expect(scene.children).toContain(line);
    // Inactive: hidden with what rides on it.
    source.setHidden(new Set(['a']));
    adapter.sync!();
    expect(scene.children).not.toContain(line);
  });

  it('editor lighting replaces the scenes’ lights with the rig', () => {
    const sun = entity('sun', { kind: 'light', components: { transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, light: { type: 'directional', color: '#ffffff', intensity: 2, direction: [0, -1, 0] } } });
    const { source, adapter } = setup([sun]);
    const lights = (): THREE.Light[] => adapter.threeScene!().children.filter((o): o is THREE.Light => (o as THREE.Light).isLight === true);
    expect(lights().map((l) => l.intensity)).toEqual([2]);
    source.setRig(true, [sun]);
    adapter.sync!();
    expect(lights().map((l) => l.type).sort()).toEqual(['AmbientLight', 'DirectionalLight']);
    expect(lights().some((l) => l.intensity === 2)).toBe(false);
  });
});
