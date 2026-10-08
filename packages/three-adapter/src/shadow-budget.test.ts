/**
 * The shadowed point and spot lights' budget: the lights largest on screen
 * keep their shadow (spot before point), lights out of view or in a room not
 * seen get none, shadows fade out with distance, a map is drawn again only
 * when the light moved, the static casters changed or something moved in
 * its reach, and without a budget every shadow is drawn every frame.
 * Browser-free.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { ROOM_KEY } from './light-layers';
import { LOCAL_SHADOW_DISTANCE, ShadowBudget } from './shadow-budget';

function lamp(kind: 'point' | 'spot', at: [number, number, number], range = 6): THREE.Light {
  const l = kind === 'point' ? new THREE.PointLight(0xffffff, 1, range) : new THREE.SpotLight(0xffffff, 1, range);
  l.castShadow = true;
  l.position.set(...at);
  l.updateMatrixWorld();
  return l;
}

const camera = (): THREE.PerspectiveCamera => {
  const c = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 200);
  c.position.set(0, 2, 0);
  c.lookAt(0, 2, -10);
  c.updateMatrixWorld();
  return c;
};

describe('shadow budget', () => {
  it('keeps the largest on screen, spot before point, none out of view or in a room not seen', () => {
    let revision = 0;
    let movers: number[] = [];
    const unseen = new Set<number>([7]);
    const b = new ShadowBudget({ roomSeen: (k) => k === undefined || !unseen.has(k), movers: () => movers, staticRevision: () => revision });
    b.setBudget(2);
    const near = lamp('point', [0, 2, -5]);
    const spot = lamp('spot', [2, 2, -6]);
    const far = lamp('point', [0, 2, -20]);
    const behind = lamp('spot', [0, 2, 30]);
    const shut = lamp('spot', [-1, 2, -4]);
    shut.userData[ROOM_KEY] = 7;
    const all = [near, spot, far, behind, shut];
    b.update(camera(), all);
    const intensity = (l: THREE.Light): number => (l as THREE.PointLight).shadow.intensity;
    // The spot (6 m from the eye) ranks with the point 5 m away: spot first (one view, not six), then the near point.
    expect(all.map((l) => intensity(l) > 0)).toEqual([true, true, false, false, false]);
    expect(b.diagnostics()).toEqual({ budget: 2, casting: 5, shadowed: 2, drawn: 2 });
    // Nothing changed: no map drawn again.
    for (const l of all) (l as THREE.PointLight).shadow.needsUpdate = false;
    b.update(camera(), all);
    expect(b.diagnostics().drawn).toBe(0);
    // Something moved within the near lamp's reach: its map only.
    movers = [-5, 1, -3, 0.5];
    b.update(camera(), all);
    expect([(near as THREE.PointLight).shadow.needsUpdate, (spot as THREE.SpotLight).shadow.needsUpdate]).toEqual([true, false]);
    movers = [];
    // The static casters changed: both.
    revision += 1;
    b.update(camera(), all);
    expect(b.diagnostics().drawn).toBe(2);
  });

  it('fades out with distance; without a budget every shadow is drawn every frame', () => {
    const b = new ShadowBudget({ roomSeen: () => true, movers: () => [], staticRevision: () => 0 });
    b.setBudget(4);
    const mid = lamp('spot', [0, 2, -LOCAL_SHADOW_DISTANCE * 0.875], 20);
    const out = lamp('spot', [0, 2, -LOCAL_SHADOW_DISTANCE - 2], 20);
    b.update(camera(), [mid, out]);
    expect((mid as THREE.SpotLight).shadow.intensity).toBeCloseTo(0.5, 1);
    expect((out as THREE.SpotLight).shadow.intensity).toBe(0);
    expect((mid as THREE.SpotLight).shadow.autoUpdate).toBe(false);
    b.setBudget(null);
    b.update(camera(), [mid, out]);
    expect([(mid as THREE.SpotLight).shadow.intensity, (out as THREE.SpotLight).shadow.intensity]).toEqual([1, 1]);
    expect((out as THREE.SpotLight).shadow.autoUpdate).toBe(true);
  });
});
