import { describe, expect, it } from 'vitest';

import { architectureCopies } from './arch-generate';
import { expandArchitecture } from './arch-rooms';
import { architectureStylesOf } from './arch-style';
import { architectureModelAssets, validateArchitectureComponent, type ArchitectureComponent, type ArchitectureRepeat } from './architecture';
import type { ModelErrorV2 } from './errors';

/**
 * Kit pieces on generated architecture: a piece on a wall an outline makes
 * names that element (its id starts with the outline's), and a run's
 * repeated piece is a model of its own; both are checked and shipped.
 */
describe('kit pieces on rooms', () => {
  const rooms: ArchitectureComponent = {
    elements: [],
    outlines: [
      { id: 'room-1', preset: 'starter-room', path: { points: [[0, 0, 0], [6, 0, 0], [6, 0, 4], [0, 0, 4]], closed: true } },
      { id: 'run-1', preset: 'starter-fence', path: { points: [[0, 0, 8], [6, 0, 8]] }, repeatModel: { assetId: 'kit-rail' } },
    ],
    overrides: [{ element: 'room-1-11hgyhe', segment: 2, model: { assetId: 'kit-wall' } }],
  };
  const errorsOf = (c: unknown): string[] => {
    const errors: ModelErrorV2[] = [];
    validateArchitectureComponent(c, '', errors);
    return errors.map((e) => e.path);
  };

  it('accepts a piece on an element an outline makes and a run\'s repeated piece; ships both models', () => {
    expect(errorsOf(rooms)).toEqual([]);
    expect(architectureModelAssets(rooms).sort()).toEqual(['kit-rail', 'kit-wall']);
  });

  it('refuses a piece on an element nothing makes, and a repeated piece that is no model', () => {
    expect(errorsOf({ ...rooms, overrides: [{ element: 'room-2-x', segment: 0, model: { assetId: 'kit-wall' } }] })).toEqual(['/overrides/0/element']);
    expect(errorsOf({ ...rooms, outlines: [rooms.outlines![0]!, { ...rooms.outlines![1]!, repeatModel: { assetId: '' } }] })).toEqual(['/outlines/1/repeatModel/assetId']);
  });
});

describe('a kit piece on a wall segment', () => {
  /** A raw straight wall along x then z (the corner at x 4), a kit piece on each segment. */
  const wall = (segments: { segment: number; stretch?: boolean }[], cellSize?: number[]): ArchitectureComponent => ({
    elements: [{ id: 'w', kind: 'sweep', path: { points: [[0, 0, 0], [4, 0, 0], [4, 0, 6]] }, profile: 'p' }],
    profiles: { p: { points: [[0, 0], [0, 3]], slots: ['lower_wall'] } },
    overrides: segments.map((s) => ({ element: 'w', ...s, model: { assetId: 'kit-wall' }, centre: true })),
    ...(cellSize !== undefined ? { paint: { cellSize, offset: [0, 0, 0], chunks: {} } } : {}),
  });
  /** Each copy: [id, x, z, scale along]. */
  const copies = (c: ArchitectureComponent): [string, number, number, number][] => {
    const set = architectureCopies(c)[0]!;
    return set.ids.map((id, i) => [id, Math.round(set.transforms[i * 10]! * 1000) / 1000, Math.round(set.transforms[i * 10 + 2]! * 1000) / 1000, Math.round(set.transforms[i * 10 + 7]! * 1000) / 1000]);
  };

  it('is modelled one cell long and drawn one copy per cell, as block edge pieces are', () => {
    expect(copies(wall([{ segment: 0 }]))).toEqual([
      ['w:seg0', 0.5, 0, 1],
      ['w:seg0.1', 1.5, 0, 1],
      ['w:seg0.2', 2.5, 0, 1],
      ['w:seg0.3', 3.5, 0, 1],
    ]);
  });

  it("follows the layer's cell along the segment (non-1 m cells), and stands once at its own size with stretch off", () => {
    // 2 m cells along x (two copies on 4 m), 3 m along z (two on 6 m).
    expect(copies(wall([{ segment: 0 }, { segment: 1 }], [2, 1, 3]))).toEqual([
      ['w:seg0', 1, 0, 1],
      ['w:seg0.1', 3, 0, 1],
      ['w:seg1', 4, 1.5, 1],
      ['w:seg1.1', 4, 4.5, 1],
    ]);
    expect(copies(wall([{ segment: 1, stretch: false }], [2, 1, 3]))).toEqual([['w:seg1', 4, 3, 1]]);
  });

  it('on a segment no whole number of cells long takes the nearest count, each copy scaled to fill it', () => {
    const diag: ArchitectureComponent = { ...wall([{ segment: 0 }]), elements: [{ id: 'w', kind: 'sweep', path: { points: [[0, 0, 0], [3, 0, 4]] }, profile: 'p' }] };
    const c = copies(diag);
    expect(c.map((x) => x[0])).toEqual(['w:seg0', 'w:seg0.1', 'w:seg0.2', 'w:seg0.3', 'w:seg0.4']);
    expect(c.every((x) => x[3] === 1)).toBe(true);
    const odd: ArchitectureComponent = { ...diag, elements: [{ id: 'w', kind: 'sweep', path: { points: [[0, 0, 0], [3.6, 0, 0]] }, profile: 'p' }] };
    expect(copies(odd).map((x) => x[3])).toEqual([0.9, 0.9, 0.9, 0.9]);
  });
});

describe("a run's repeated kit piece", () => {
  // Posts on the run's own line and pilasters on a line beside it: two repeats in one style.
  const style = {
    nodes: [
      { id: 'outline', type: 'outline', position: [0, 0] },
      { id: 'square', type: 'square', position: [0, 0], data: { size: 0.2 } },
      { id: 'shaft', type: 'shaft', position: [0, 0], data: { height: 1 } },
      { id: 'post', type: 'sweep', position: [0, 0] },
      { id: 'beside', type: 'offset', position: [0, 0], data: { distance: 1 } },
      { id: 'pilasters', type: 'repeat', position: [0, 0], data: { spacing: 3 } },
      { id: 'posts', type: 'repeat', position: [0, 0], data: { spacing: 2 } },
      { id: 'output', type: 'output', position: [0, 0] },
    ],
    edges: [
      { id: 'e1', from: { node: 'square', port: 'path' }, to: { node: 'post', port: 'path' } },
      { id: 'e2', from: { node: 'shaft', port: 'profile' }, to: { node: 'post', port: 'profile' } },
      { id: 'e3', from: { node: 'outline', port: 'path' }, to: { node: 'beside', port: 'path' } },
      { id: 'e4', from: { node: 'beside', port: 'path' }, to: { node: 'pilasters', port: 'path' } },
      { id: 'e5', from: { node: 'post', port: 'element' }, to: { node: 'pilasters', port: 'piece' } },
      { id: 'e6', from: { node: 'outline', port: 'path' }, to: { node: 'posts', port: 'path' } },
      { id: 'e7', from: { node: 'post', port: 'element' }, to: { node: 'posts', port: 'piece' } },
      { id: 'e8', from: { node: 'pilasters', port: 'element' }, to: { node: 'output', port: 'elements' } },
      { id: 'e9', from: { node: 'posts', port: 'element' }, to: { node: 'output', port: 'elements' } },
    ],
  };
  const table = architectureStylesOf([
    { graphId: 'two-repeats-style', kind: 'architecture-style', graph: style },
    { graphId: 'two-repeats', kind: 'architecture-preset', graph: { nodes: [{ id: 'preset', type: 'preset', position: [0, 0], data: { style: 'two-repeats-style', base: '', sheet: '' } }], edges: [] } },
  ] as never);

  it("stands in for the posts on the run's line only; the pilasters keep the style's piece", () => {
    const run: ArchitectureComponent = { elements: [], outlines: [{ id: 'run-1', preset: 'two-repeats', path: { points: [[0, 0, 0], [6, 0, 0]] }, repeatModel: { assetId: 'kit-rail' } }] };
    const repeats = expandArchitecture(run, [0, 0, 0], table).component.elements.filter((e): e is ArchitectureRepeat => e.kind === 'repeat');
    expect(repeats.map((r) => [r.spacing, 'model' in r.piece ? r.piece.model.assetId : 'style'])).toEqual([
      [3, 'style'],
      [2, 'kit-rail'],
    ]);
  });
});
