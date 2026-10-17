import { describe, expect, it } from 'vitest';

import { expandArchitecture } from './arch-rooms';
import { architectureStylesOf } from './arch-style';
import type { ArchitectureComponent, ArchitectureSweep } from './architecture';

/**
 * An outside preset of another height than the room's walls (a Tall room's
 * facade on Room storeys): its trims sit on the walls it dresses, not at its
 * own ceiling height.
 */
describe('an outside preset on walls of another height', () => {
  const table = architectureStylesOf([]);
  const building = (outside: string): ArchitectureComponent => ({
    elements: [],
    outlines: [{ id: 'room-1', preset: 'starter-room', outside, storeys: 2, path: { points: [[0, 0, 0], [6, 0, 0], [6, 0, 4], [0, 0, 4]], closed: true } }],
  });
  /** The tops of the outside's trims (metres), highest first. */
  const trimTops = (c: ArchitectureComponent): number[] => {
    const x = expandArchitecture(c, [0, 0, 0], table).component;
    const tops = (x.elements.filter((e) => e.kind === 'sweep' && e.wall !== true && /-x\d/.test(e.id)) as ArchitectureSweep[]).map((e) => {
      const ys = (x.profiles?.[e.profile]?.points ?? []).map((q) => q[1]!);
      return Math.round((Math.max(...ys) + e.path.points[0]![1]) * 1000) / 1000;
    });
    return [...new Set(tops)].sort((a, b) => b - a);
  };

  it('puts the crown at the top of each storey of walls (3 m storeys), not at its own 4.2 m', () => {
    const tall = trimTops(building('starter-room-tall'));
    const same = trimTops(building('starter-room'));
    expect(tall.length).toBeGreaterThan(0);
    // The highest trim is the top storey's crown, at the walls' top (two 3 m storeys), as with a facade of the room's own height.
    expect(tall[0]).toBeCloseTo(same[0]!, 3);
    expect(tall[0]).toBeLessThanOrEqual(6 + 1e-3);
    // No trim of the ground storey reaches into the storey above (above 3 m but under the top storey's own trims).
    expect(tall.filter((t) => t > 3 + 1e-3 && t < 3.15)).toEqual([]);
  });
});
