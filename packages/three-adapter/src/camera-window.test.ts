/**
 * The camera-following window: its origin snapped to whole steps round the
 * eye, its moves in whole cells, the scroll's source texels (entering ones
 * have none), and the world ↔ texture mapping the shaders build being the
 * same steps as the CPU's.
 */
import * as THREE from 'three';
import * as TSL from 'three/tsl';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { describe, expect, it } from 'vitest';

import { CameraWindow, scrolledSourceAt, windowEdgeSteps, windowUvSteps } from './camera-window';
import { CPU_SCALAR_OPS } from './field-ops';
import { litScene, wgslOf, wgslRenderer } from './test-wgsl';

describe('the camera window', () => {
  it('snaps its origin to whole cells round the eye and moves by whole cells', () => {
    const w = new CameraWindow({ texels: 256, cellM: 0.25 });
    expect(w.follow(10.1, -3.2)).toBe(true);
    // The first follow carries nothing over.
    expect(w.moved).toEqual([256, 256]);
    expect(w.originX).toBe(10 - 32);
    expect(w.originZ).toBe(-3.25 - 32);
    expect(w.centre()).toEqual([10, -3.25]);
    // Inside the same cell: no move.
    expect(w.wouldMove(10.05, -3.3)).toBe(false);
    expect(w.follow(10.05, -3.3)).toBe(false);
    expect(w.moved).toEqual([0, 0]);
    // Three cells on in x, two back in z.
    expect(w.follow(10.8, -3.7)).toBe(true);
    expect(w.moved).toEqual([3, -2]);
    expect(w.originX).toBe(10.75 - 32);
    // A texel holds the ground texel it held, shifted by the move; texels entering have no source.
    expect(scrolledSourceAt(0, 2, w.moved, 256)).toEqual([3, 0]);
    expect(scrolledSourceAt(10, 10, w.moved, 256)).toEqual([13, 8]);
    expect(scrolledSourceAt(254, 10, w.moved, 256)).toBeNull();
    expect(scrolledSourceAt(10, 1, w.moved, 256)).toBeNull();
  });

  it('a coarse window moves in steps of several cells (the wind map: 8 × 4 m)', () => {
    const w = new CameraWindow({ texels: 64, cellM: 4, stepCells: 8 });
    w.follow(3, 4);
    expect([w.originX, w.originZ]).toEqual([-128, -128]);
    expect(w.follow(15, 15)).toBe(false);
    expect(w.follow(17, 15)).toBe(true);
    expect(w.moved).toEqual([8, 0]);
    expect(w.originX).toBe(32 - 128);
  });

  it('maps world points to texels and back, the CPU and the shader by the same steps', () => {
    const w = new CameraWindow({ texels: 256, cellM: 0.25 });
    w.follow(100, 200);
    const [i, j] = w.texelAt(100.3, 199.1)!;
    const [cx, cz] = w.texelCentre(i, j);
    expect(Math.abs(cx - 100.3)).toBeLessThanOrEqual(0.125);
    expect(Math.abs(cz - 199.1)).toBeLessThanOrEqual(0.125);
    expect(w.texelAt(100 + 40, 200)).toBeNull();
    const [u, v] = w.uvAt(cx, cz);
    expect(u * 256).toBeCloseTo(i + 0.5, 9);
    expect(v * 256).toBeCloseTo(j + 0.5, 9);
    // The edge distance: half a texel at the outermost texel's centre, negative outside.
    const edge = (x: number, z: number): number => {
      const q = w.uvAt(x, z);
      return windowEdgeSteps(CPU_SCALAR_OPS, q[0], q[1], 256);
    };
    expect(edge(...w.texelCentre(0, 100))).toBeCloseTo(0.5, 9);
    expect(edge(w.originX - 1, 200)).toBeLessThan(0);
    // The shader's mapping is built from the same steps over the window's rect uniform.
    const m = new MeshBasicNodeMaterial();
    (m as unknown as { colorNode: unknown }).colorNode = TSL.vec4(w.uvNode(TSL.positionWorld.xz), w.edgeNode(w.uvNode(TSL.positionWorld.xz)), 1);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(), m);
    const scene = litScene();
    scene.add(mesh);
    const wgsl = wgslOf(wgslRenderer(), scene, mesh);
    expect(wgsl).toMatch(/- render\.nodeUniform\d+\.x \) \* render\.nodeUniform\d+\.z/);
    expect(wgsl).toMatch(/\* 256\.0/);
    const steps = windowUvSteps(CPU_SCALAR_OPS, cx, cz, w.originX, w.originZ, 1 / w.side);
    expect([steps.u, steps.v]).toEqual([u, v]);
  });
});
