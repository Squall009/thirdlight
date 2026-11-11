import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';

import { samePose, TAAU_STILL_EPSILON } from './post-taau';

describe('the temporal upscale\'s still camera', () => {
  it('reads a pose rebuilt in its last bits as still and a real move as moving', () => {
    // The pose Play's camera alternated between frame after frame (a 10 degree tilt composed again each step).
    const a = new THREE.Matrix4().set(1, 0, 0, 0, 0, 0.9848077678595771, 0.17364809346329488, 2.5, 0, -0.17364809346329488, 0.9848077678595771, 8, 0, 0, 0, 1);
    const b = a.clone();
    b.elements[6] = -0.17364809346329485;
    b.elements[9] = 0.17364809346329485;
    expect(a.equals(b)).toBe(false);
    expect(samePose(a, b)).toBe(true);
    // A thousandth of a degree, or a tenth of a millimetre, is a move.
    const turned = new THREE.Matrix4().makeRotationY(1e-5).multiply(a);
    expect(samePose(a, turned)).toBe(false);
    const stepped = a.clone().setPosition(2.5, 0, 8.0001);
    expect(samePose(a, stepped)).toBe(false);
    expect(TAAU_STILL_EPSILON).toBeLessThan(1e-5);
  });
});
