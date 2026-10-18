import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { boxMayShow, copiesWorthCulling, depthOfViewZ, firstPassList, levelFor, listedCopy, RangeAllocator, secondPassList, sphereMayShow, type CopyStep, type SphereTest } from './occlusion-instances-rule';
import { pyramidLayout, reducePyramid } from './occlusion-pyramid-rule';

describe('the pools of culled copies', () => {
  it('hand out ranges first fit, join freed neighbours and grow when nothing fits', () => {
    const a = new RangeAllocator(10);
    expect([a.alloc(4), a.alloc(4)]).toEqual([0, 4]);
    // Only 2 left: grows (at least doubling), the new range where the old pool ended.
    expect(a.alloc(3)).toBe(8);
    expect(a.size).toBe(20);
    a.release(0, 4);
    a.release(4, 4);
    // The two freed ranges are one again.
    expect(a.alloc(8)).toBe(0);
    expect(a.freeCopies()).toBe(20 - 8 - 3);
    // A request larger than double grows to fit it.
    expect(a.alloc(100)).toBe(11);
    expect(a.size).toBe(111);
  });
});

describe('the compaction of a draw\'s copies over two passes', () => {
  const step = (over: Partial<CopyStep> & { visible: Uint8Array }): CopyStep => ({ n: 6, firstPass: true, fresh: false, slots: [5, 3, 0, 1, 4, 2], ...over });

  it('draws every copy seen in the finished frame once, keeping the drawn order', () => {
    // Last frame slots 5, 0 and 2 were visible; this frame places 1, 2 and 4 (slots 3, 0, 4) are.
    const visible = new Uint8Array([1, 0, 1, 0, 0, 1]);
    const s = step({ visible });
    const first = firstPassList(s);
    expect(first, 'the first pass: last frame\'s visible copies, in order').toEqual([0, 2, 5]);
    const seenNow = new Set([1, 2, 4]);
    const second = secondPassList(s, (p) => seenNow.has(p));
    expect(second, 'the second pass: visible now, not drawn yet, in order').toEqual([1, 4]);
    // Every copy visible now is drawn, none twice.
    const drawn = [...first, ...second];
    for (const p of seenNow) expect(drawn).toContain(p);
    expect(new Set(drawn).size).toBe(drawn.length);
    // What is kept for the next frame is this frame's answer, by slot.
    expect([...visible]).toEqual([1, 0, 0, 1, 1, 0]);
  });

  it('a new draw counts every copy visible last frame; a draw only the second pass draws gets no first list', () => {
    const fresh = step({ fresh: true, visible: new Uint8Array(6) });
    expect(firstPassList(fresh)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(secondPassList(fresh, () => true), 'all were drawn first').toEqual([]);
    const late = step({ firstPass: false, visible: new Uint8Array(6).fill(1) });
    expect(firstPassList(late)).toEqual([]);
    expect(secondPassList(late, (p) => p !== 3)).toEqual([0, 1, 2, 4, 5]);
  });

  it('the vertex stage reads a listed copy\'s 16 floats as written: the paint slot in the fourth row rides along', () => {
    const base = 7;
    const pool = new Float32Array((base + 4) * 16);
    for (let p = 0; p < 4; p += 1) {
      const m = new THREE.Matrix4().makeTranslation(p, 2 * p, 3 * p).elements;
      pool.set(m, (base + p) * 16);
      // 1 + the copy's paint slot (0: unpainted), as the drawn buffer carries it.
      pool[(base + p) * 16 + 3] = p === 2 ? 5 : 0;
    }
    const list = [2, 0];
    const read = listedCopy(pool, base, list, 0);
    expect([...read]).toEqual([...pool.subarray((base + 2) * 16, (base + 3) * 16)]);
    expect(read[3]).toBe(5);
    expect(read[12]).toBe(2);
  });
});

describe('a copy\'s sphere against the depth pyramid', () => {
  const W = 64;
  const H = 32;
  const camera = new THREE.PerspectiveCamera(60, W / H, 0.1, 100);
  camera.coordinateSystem = THREE.WebGPUCoordinateSystem;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  const kind = { near: 0.1, far: 100, perspective: true, logarithmic: false };
  /** A wall 10 m ahead over the left half of the screen, the sky elsewhere. */
  const sceneWith = (reversed: boolean): SphereTest => {
    const wall = depthOfViewZ(-10, { ...kind, reversed });
    const sky = reversed ? 0 : 1;
    const depth = new Float32Array(W * H);
    for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) depth[y * W + x] = x < W / 2 ? wall : sky;
    return { view: camera.matrixWorldInverse.elements, projection: camera.projectionMatrix.elements, ...kind, reversed, layout: pyramidLayout(W, H), pyramid: reducePyramid(depth, W, H, reversed) };
  };

  for (const reversed of [false, true]) {
    it(`hides only what lies wholly behind the wall (${reversed ? 'reversed' : 'standard'} depth)`, () => {
      const t = sceneWith(reversed);
      expect(sphereMayShow(t, -3, 0, -20, 0.5), 'behind the wall').toBe(false);
      expect(sphereMayShow(t, -3, 0, -5, 0.5), 'in front of it').toBe(true);
      expect(sphereMayShow(t, 3, 0, -20, 0.5), 'beside it, under the sky').toBe(true);
      expect(sphereMayShow(t, -0.3, 0, -20, 1), 'reaching past its edge').toBe(true);
      expect(sphereMayShow(t, -3, 0, -10.5, 0.5), 'touching it').toBe(true);
      expect(sphereMayShow(t, -3, 0, -20.0, 10.5), 'reaching the eye').toBe(true);
    });

    it(`tests a box by its corners: a flat one behind the wall is hidden where its sphere is not (${reversed ? 'reversed' : 'standard'} depth)`, () => {
      const t = sceneWith(reversed);
      const flat = [-6, -0.1, -30, -1, 0.1, -20] as const;
      expect(boxMayShow(t, ...flat), 'the box behind the wall').toBe(false);
      const c = [(flat[0] + flat[3]) / 2, 0, (flat[2] + flat[5]) / 2] as const;
      expect(sphereMayShow(t, ...c, Math.hypot(2.5, 0.1, 5)), 'its sphere reaches past the wall\'s edge').toBe(true);
      expect(boxMayShow(t, -6, -0.1, -30, 1, 0.1, -20), 'past the edge, under the sky').toBe(true);
      expect(boxMayShow(t, -6, -0.1, -12, -1, 0.1, -5), 'in front of the wall').toBe(true);
      expect(boxMayShow(t, -6, -0.1, -30, -1, 0.1, 0.5), 'reaching behind the eye').toBe(true);
    });
  }

  it('reads the level whose 2 × 2 texels cover the box', () => {
    expect(levelFor(5, 5, 9, 9, 8)).toBe(0);
    expect(levelFor(0, 3, 0, 0, 8)).toBe(1);
    // Four pixels across a level-1 texel border still fit two texels of level 1.
    expect(levelFor(2, 5, 0, 0, 8)).toBe(1);
    expect(levelFor(3, 6, 0, 0, 8)).toBe(1);
    expect(levelFor(3, 8, 0, 0, 8)).toBe(2);
    expect(levelFor(0, 1000, 0, 0, 4)).toBe(3);
  });
});

describe('instanced draws worth culling', () => {
  it('counts every copy against the floor, a draw of one copy included', () => {
    // One dense copy (a kit copy alone in its room's draw): tested; one light copy: not.
    expect(copiesWorthCulling(2352, 1, false)).toBe(true);
    expect(copiesWorthCulling(12, 1, false)).toBe(false);
    // Many light copies together over the floor; under it, or see-through, not.
    expect(copiesWorthCulling(12, 200, false)).toBe(true);
    expect(copiesWorthCulling(12, 100, false)).toBe(false);
    expect(copiesWorthCulling(2352, 4, true)).toBe(false);
  });
});
