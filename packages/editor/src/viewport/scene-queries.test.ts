/**
 * The one pointer → ray of the Scene view's tools (`aimAtPointer`): the
 * pointer's client position over its element's rectangle, the element's
 * offset on the page included, gives the ray through that point of the
 * camera's picture.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { aimAtPointer } from './scene-queries';

function camera(): THREE.PerspectiveCamera {
  const c = new THREE.PerspectiveCamera(60, 2, 0.1, 100);
  c.position.set(1, 2, 3);
  c.lookAt(1, 2, -10);
  c.updateMatrixWorld(true);
  return c;
}

describe('aimAtPointer', () => {
  const rect = { left: 40, top: 30, width: 800, height: 400 };

  it('aims through the camera\'s middle from the rectangle\'s middle, wherever the element sits', () => {
    const r = new THREE.Raycaster();
    aimAtPointer(r, camera(), 440, 230, rect);
    expect(r.ray.origin.distanceTo(new THREE.Vector3(1, 2, 3))).toBeLessThan(1e-9);
    expect(r.ray.direction.distanceTo(new THREE.Vector3(0, 0, -1))).toBeLessThan(1e-9);
  });

  it('maps the rectangle\'s corners to the picture\'s corners (y down on screen is down in the picture)', () => {
    const c = camera();
    const r = new THREE.Raycaster();
    aimAtPointer(r, c, rect.left, rect.top, rect);
    const topLeft = new THREE.Vector3(-1, 1, 0.5).unproject(c).sub(c.position).normalize();
    expect(r.ray.direction.distanceTo(topLeft)).toBeLessThan(1e-9);
    aimAtPointer(r, c, rect.left + rect.width, rect.top + rect.height, rect);
    const bottomRight = new THREE.Vector3(1, -1, 0.5).unproject(c).sub(c.position).normalize();
    expect(r.ray.direction.distanceTo(bottomRight)).toBeLessThan(1e-9);
    expect(r.ray.direction.y).toBeLessThan(0);
  });

  it('is the formula every tool used: client over the rectangle, ×2 − 1, y flipped', () => {
    const c = camera();
    const a = new THREE.Raycaster();
    const b = new THREE.Raycaster();
    for (const [x, y] of [[123, 77], [40, 430], [839, 31], [500, 300]] as const) {
      aimAtPointer(a, c, x, y, rect);
      b.setFromCamera(new THREE.Vector2(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1), c);
      expect(a.ray.direction.toArray()).toEqual(b.ray.direction.toArray());
      expect(a.ray.origin.toArray()).toEqual(b.ray.origin.toArray());
    }
  });
});
