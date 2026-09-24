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
    expect(h.count).toBe(1 + 4 + 1 + 1 + 1); // path + 4 dots, switch area, enemy area + range
    overlay.sync([entity('plate', { switch: { mode: 'stand', signal: 'open', size: [1, 1] } })]);
    expect(overlay.blockHelpers()).toEqual({ moverPaths: [], count: 1 });
    overlay.dispose();
  });
});
