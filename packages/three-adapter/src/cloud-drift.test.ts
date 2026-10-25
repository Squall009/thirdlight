/**
 * The clouds' travel: a function of the clock and the global wind, the same
 * at the same second however the frames fell (a replay starts and runs on
 * the same sky), carried on without a jump when the wind or the start
 * changes. And the sky draws it: the travel reaches the shader through the
 * renderer's one drift uniform.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { CloudDrift } from './cloud-drift';
import { cloudDriftUniform, createSkyMesh } from './environment-nodes';
import { CLOUD_LAYER_HEIGHT_M, PhysicalSky } from './physical-sky';
import { wgslOf, wgslRenderer } from './test-wgsl';

const EAST = { dirX: 1, dirZ: 0, speed: 6 };
const NORTH_EAST = { dirX: Math.SQRT1_2, dirZ: -Math.SQRT1_2, speed: 10 };

describe('the clouds drift with the global wind', () => {
  it('travel = velocity × (start + clock) under a steady wind, whatever the frame times', () => {
    const steady = new CloudDrift();
    const jittery = new CloudDrift();
    // Two runs that sample the clock differently land on the same sky at the same second.
    for (const t of [0.016, 0.033, 0.05, 1, 2.5, 30]) steady.at(t, EAST, 120);
    for (const t of [0.4, 7, 7.001, 29.9]) jittery.at(t, EAST, 120);
    expect(steady.at(30, EAST, 120)).toEqual([6 * 150, 0]);
    expect(jittery.at(30, EAST, 120)[0]).toBeCloseTo(6 * 150, 9);
    // The start alone sets the first frame's sky (clock 0): the same start, the same sky.
    expect(new CloudDrift().at(0, NORTH_EAST, 50)).toEqual([NORTH_EAST.dirX * 500, NORTH_EAST.dirZ * 500]);
    // No wind, or no speed: the clouds stay where the start put them.
    expect(new CloudDrift().at(100, { dirX: 1, dirZ: 0, speed: 0 }, 300)).toEqual([0, 0]);
  });

  it('a new wind carries on from where the clouds are (no jump), along its direction and at its speed', () => {
    const d = new CloudDrift();
    d.at(0, EAST, 0);
    const before = [...d.at(10, EAST, 0)];
    expect(before).toEqual([60, 0]);
    // The same second under the new wind: still where they were.
    expect(d.at(10, NORTH_EAST, 0)).toEqual(before);
    const after = d.at(14, NORTH_EAST, 0);
    expect(after[0]).toBeCloseTo(60 + 40 * Math.SQRT1_2, 9);
    expect(after[1]).toBeCloseTo(-40 * Math.SQRT1_2, 9);
    // A later start moves them as if the clock had moved by the difference.
    const moved = d.at(14, NORTH_EAST, 3);
    expect(moved[0]).toBeCloseTo(after[0] + 30 * Math.SQRT1_2, 9);
  });

  it('the sky reads the travel from one shared uniform: no new program for a wind, a start or another coverage', () => {
    const drift = cloudDriftUniform() as { value: THREE.Vector2 };
    const params = { turbidity: 6, rayleigh: 1.5, mieCoefficient: 0.005, mieDirectionalG: 0.8, sun: new THREE.Vector3(0, 1, 0), cloudCoverage: 0.7, cloudDensity: 0.2 };
    const a = createSkyMesh(params, drift);
    const b = createSkyMesh({ ...params, cloudCoverage: 0.1, cloudDensity: 0.9 }, drift);
    expect(a).toBeInstanceOf(PhysicalSky);
    expect(b.cloudDrift).toBe(a.cloudDrift);
    expect([a.cloudCoverage.value, a.cloudDensity.value, b.cloudCoverage.value]).toEqual([0.7, 0.2, 0.1]);
    const renderer = wgslRenderer();
    const sceneA = new THREE.Scene().add(a);
    const first = wgslOf(renderer, sceneA, a);
    drift.value.set(5000, -300);
    const sceneB = new THREE.Scene().add(b);
    expect(wgslOf(renderer, sceneB, b)).toBe(first);
    // The cloud plane's height turns metres into sky (a positive constant in the program).
    expect(first).toContain(CLOUD_LAYER_HEIGHT_M.toFixed(1));
  });
});
