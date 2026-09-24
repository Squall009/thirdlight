/**
 * Phase 9.9: the overlay's gameplay helpers — a mover's path and the areas of
 * triggers, switches and enemies follow the projection (three.js objects, no
 * pixels; how they look in the browser is unverified here).
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { ZoneOverlay } from './zone-overlay';
import type { ProjectedEntity } from '../session/projection';

const entity = (id: string, blocks: ProjectedEntity['blocks']): ProjectedEntity =>
  ({ id, name: id, parentId: null, kind: 'box', active: true, locked: false, static: false, tags: 0, position: [2, 1, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], blocks }) as ProjectedEntity;

describe('zone overlay gameplay helpers', () => {
  it('draws a mover path through its stops and outlines trigger/switch/enemy areas; follows removal', () => {
    const scene = new THREE.Scene();
    const canvas = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) } as unknown as HTMLCanvasElement;
    const overlay = new ZoneOverlay(scene, new THREE.PerspectiveCamera(), canvas);
    overlay.sync([
      entity('lift', { mover: { waypoints: [[0, 3, 0], [4, 3, 0]], speed: 1, mode: 'loop' } }),
      entity('plate', { switch: { mode: 'stand', signal: 'open', size: [1, 1] } }),
      entity('slime', { enemy: { patrol: 'points', range: [-2, 2], speed: 1, size: [0.8, 0.8], contactDamage: 1, stompable: true, health: 1 } }),
    ]);
    const h = overlay.blockHelpers();
    expect(h.moverPaths).toEqual(['lift']);
    const path = scene.getObjectByName('mover-path:lift') as THREE.Line;
    const pos = path.geometry.getAttribute('position');
    expect(pos.count).toBe(4); // start, two stops, back to the start (loop)
    expect([pos.getX(1), pos.getY(1)]).toEqual([2, 4]);
    expect(h.count).toBe(1 + 3 + 1 + 1 + 1); // path + a dot per stop (3), switch area, enemy area + range
    overlay.sync([entity('plate', { switch: { mode: 'stand', signal: 'open', size: [1, 1] } })]);
    expect(overlay.blockHelpers()).toEqual({ moverPaths: [], count: 1, colliders: 0 });
    overlay.dispose();
  });

  it('phase 9.12: collider outlines for every collider; a waypoint handle is picked and dragged (preview + new offset)', () => {
    const scene = new THREE.Scene();
    const canvas = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) } as unknown as HTMLCanvasElement;
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.set(0, 0, 10);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const overlay = new ZoneOverlay(scene, camera, canvas);
    const lift = { ...entity('lift', { mover: { waypoints: [[2, 0, 0]], speed: 1, mode: 'once' } }), position: [0, 0, 0], collider: { shape: { type: 'box', hx: 1, hy: 0.2 } } } as ProjectedEntity;
    const ramp = { ...entity('ramp', undefined), collider: { shape: { type: 'polygon', vertices: [[0, 0], [2, 0], [2, 1]] } } } as ProjectedEntity;
    overlay.sync([lift, ramp]);
    expect(overlay.blockHelpers().colliders).toBe(2);
    const box = scene.getObjectByName('collider-outline:lift') as THREE.Line;
    expect(box.geometry.getAttribute('position').count).toBe(5); // a closed rectangle
    // The handle of waypoint 1 (world 2, 0) on screen.
    const p = new THREE.Vector3(2, 0, 0).project(camera);
    const sx = ((p.x + 1) / 2) * 100;
    const sy = ((1 - p.y) / 2) * 100;
    expect(overlay.pickWaypoint(sx, sy)).toEqual({ entityId: 'lift', index: 1 });
    expect(overlay.pickWaypoint(50, 50)).toBeNull(); // the mover's own position is not a handle
    expect(overlay.previewWaypoint('lift', 1, { x: 3, y: 1 })).toEqual([3, 1, 0]);
    const path = scene.getObjectByName('mover-path:lift') as THREE.Line;
    expect([path.geometry.getAttribute('position').getX(1), path.geometry.getAttribute('position').getY(1)]).toEqual([3, 1]);
    overlay.setGizmos({ colliders: false, gameplay: false });
    expect(overlay.pickWaypoint(sx, sy)).toBeNull(); // hidden helpers are not handles
    overlay.dispose();
  });
});
