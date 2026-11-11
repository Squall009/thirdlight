/**
 * The coverage bench's view check for a camera seeing a far stand-in from
 * inside: rays through the lower half of the view, and a ray counted
 * when it enters a far node's solid at a box face rather than at a surface
 * inside one node.
 */
import { describe, expect, it } from 'vitest';
import { entersAtFace, viewRayPoints, type FarSample } from './coverage';

describe('the coverage bench\'s view check', () => {
  it('casts rays from the eye through the lower half of the view, the bottom row steepest', () => {
    const rays = viewRayPoints({ x: 0, y: 10, z: 0, yaw: 0, pitch: 0 }, Math.PI / 3, 16 / 9, { cols: 3, rows: 2, steps: 4, stepM: 1 });
    expect(rays.length).toBe(6);
    // Yaw 0 looks along −z; every point is below the eye, the bottom row's 30° down.
    const first = rays[1]!;
    expect(first[0]).toBeCloseTo(0, 9);
    expect(first[1]).toBeCloseTo(10 - Math.sin(Math.PI / 6), 9);
    expect(first[2]).toBeCloseTo(-Math.cos(Math.PI / 6), 9);
    for (const r of rays) for (let k = 0; k < r.length; k += 3) expect(r[k + 1]!).toBeLessThan(10);
    // The rows rise toward the middle; the outer columns spread left and right.
    expect(rays[4]![1]!).toBeGreaterThan(rays[1]![1]!);
    expect(rays[0]![0]!).toBeLessThan(0);
    expect(rays[2]![0]!).toBeGreaterThan(0);
  });

  it('counts a ray that enters a stand-in\'s solid at a box face, not one that meets the surface inside a node', () => {
    const a = (inside: boolean): FarSample => ({ level: 2, node: '2:0,0,0', inside });
    const b = (inside: boolean): FarSample => ({ level: 4, node: '4:0,0,-1', inside });
    // Air, then the ground inside the same node: a surface.
    expect(entersAtFace(a(false), [a(false), a(false), a(true)])).toBe(false);
    // Out of a fine node in the air straight into a coarse node's solid: its face, seen from inside.
    expect(entersAtFace(a(false), [a(false), b(true)])).toBe(true);
    // From where no far node is drawn (the near field's place) into solid.
    expect(entersAtFace(a(false), [null, b(true)])).toBe(true);
    // The eye already inside a solid.
    expect(entersAtFace(b(true), [b(true)])).toBe(true);
    // Never into solid within the reach: nothing.
    expect(entersAtFace(a(false), [a(false), null, b(false)])).toBe(false);
  });
});
