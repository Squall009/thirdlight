/**
 * The one pointer → ray of the Scene view's tools (`aimAtPointer`): the
 * pointer's client position over its element's rectangle, the element's
 * offset on the page included, gives the ray through that point of the
 * camera's picture. And the click pick on it: the nearest entity under the
 * pointer that is shown and not locked, the ones in front of it skipped.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { aimAtPointer, SceneQueries, type SceneQueriesHost } from './scene-queries';

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

describe('the Scene view\'s click pick', () => {
  type Flags = { active: boolean; locked: boolean };
  /** Boxes on the camera's axis, nearest first (1 m apart from 5 m out), each an entity's drawable. */
  function view(ids: readonly string[], flags: Record<string, Flags>): { queries: SceneQueries; meshes: Map<string, THREE.Mesh> } {
    const scene = new THREE.Scene();
    const meshes = new Map<string, THREE.Mesh>();
    ids.forEach((id, i) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), new THREE.MeshBasicMaterial());
      m.position.set(0, 0, -5 - i);
      m.userData['entityId'] = id;
      scene.add(m);
      meshes.set(id, m);
    });
    scene.updateMatrixWorld(true);
    const cam = new THREE.PerspectiveCamera(60, 2, 0.1, 100);
    cam.updateMatrixWorld(true);
    const host = {
      adapter: () => ({ threeScene: () => scene, entityOf: (o: THREE.Object3D) => (o.userData['entityId'] as string | undefined) ?? null }),
      root: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 400 }) }),
      camera: cam,
      overlay: new THREE.Group(),
      synced: new Map(ids.map((id) => [id, {}])),
      projected: () => [],
      flags: () => new Map(Object.entries(flags)),
      isolation: { hits: (h: THREE.Intersection[]) => h },
      helpers: { capsuleAt: () => null },
      focus: () => new THREE.Vector3(),
      snapping: () => false,
      cellTopSnap: () => null,
    } as unknown as SceneQueriesHost;
    return { queries: new SceneQueries(host), meshes };
  }
  const shown = { active: true, locked: false };
  const middle = [400, 200] as const;

  it('picks the nearest entity under the pointer and says how far along the ray it was', () => {
    const { queries } = view(['near', 'far'], { near: shown, far: shown });
    expect(queries.pick(...middle)).toBe('near');
    expect(queries.pickedAt).toBeCloseTo(4.75, 6);
    expect(queries.pick(10, 10)).toBeNull();
    expect(queries.pickedAt).toBe(Infinity);
  });

  it('skips a locked entity and a hidden (inactive) one in front, and picks what is behind them', () => {
    const { queries } = view(['locked', 'hidden', 'behind'], { locked: { active: true, locked: true }, hidden: { active: false, locked: false }, behind: shown });
    expect(queries.pick(...middle)).toBe('behind');
    expect(queries.pickedAt).toBeCloseTo(6.75, 6);
    expect(queries.pickable('locked')).toBe(false);
    expect(queries.pickable('hidden')).toBe(false);
    // An entity with no flags of its own is pickable.
    expect(queries.pickable('unlisted')).toBe(true);
  });

  it('skips a drawable that is not drawn (visible off), and picks nothing when only unpickable ones are hit', () => {
    const a = view(['off', 'behind'], { off: shown, behind: shown });
    a.meshes.get('off')!.visible = false;
    expect(a.queries.pick(...middle)).toBe('behind');
    const b = view(['locked'], { locked: { active: true, locked: true } });
    expect(b.queries.pick(...middle)).toBeNull();
  });
});
