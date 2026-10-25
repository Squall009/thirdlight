/**
 * The notes the upgrade lists for a 2D-plane project's gameplay blocks on
 * the 3D backend: what each reads as, by kind, and nothing for the forms
 * that read alike.
 */
import { describe, expect, it } from 'vitest';

import { blocks2DTo3D } from './block-2d-3d';

const T = (rotation: number[] = [0, 0, 0, 1]) => ({ position: [0, 0, 0], rotation, scale: [1, 1, 1] });
const kinds = (c: unknown): string[] => blocks2DTo3D(c).map((x) => `${x.kind} ${x.field}`);

describe('blocks2DTo3D', () => {
  it('a circle trigger: a sphere; a [w, h] box trigger: depth and the capsule test', () => {
    expect(kinds({ transform: T(), trigger: { shape: 'circle', radius: 1, signal: 's' } })).toEqual(['trigger-circle /components/trigger/shape']);
    expect(kinds({ transform: T(), trigger: { size: [2, 1], signal: 's' } })).toEqual(['area-depth /components/trigger/size', 'capsule-test /components/trigger/size']);
    // A 3D box keeps its depth; a sphere has none to note.
    expect(kinds({ transform: T(), trigger: { size: [2, 1, 3], signal: 's' } })).toEqual(['capsule-test /components/trigger/size']);
    expect(kinds({ transform: T(), trigger: { shape: 'sphere', radius: 1, signal: 's' } })).toEqual([]);
  });

  it('switches, hitboxes and collectibles on a turned object turn with it', () => {
    const q = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
    expect(kinds({ transform: T(q), switch: { mode: 'stand', signal: 'open', size: [1, 0.4] } })).toEqual(['area-depth /components/switch/size', 'capsule-test /components/switch/size', 'turned-area /components/transform/rotation']);
    expect(kinds({ transform: T(q), hitbox: { size: [1, 1, 1] } })).toEqual(['turned-area /components/transform/rotation']);
    expect(kinds({ transform: T(q), hitbox: { shape: 'sphere', radius: 1 } })).toEqual([]);
  });

  it('movers and patrols with z offsets move in depth; flat ones read alike', () => {
    expect(kinds({ transform: T(), mover: { waypoints: [[0, 3, 0]] } })).toEqual([]);
    expect(kinds({ transform: T(), mover: { waypoints: [[0, 3, 1]] } })).toEqual(['depth-motion /components/mover/waypoints']);
    expect(kinds({ transform: T(), patrol: { mode: 'edges', direction: [1, 0, 0.5] } })).toEqual(['depth-motion /components/patrol/direction']);
    expect(kinds({ transform: T(), patrol: { mode: 'waypoints', waypoints: [[2, 0, 0]] } })).toEqual([]);
  });

  it('is total', () => {
    for (const v of [null, 1, 'x', [], {}, { trigger: 1 }, { mover: { waypoints: 'x' } }]) expect(blocks2DTo3D(v)).toEqual([]);
  });
});
