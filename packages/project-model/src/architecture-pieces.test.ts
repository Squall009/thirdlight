import { describe, expect, it } from 'vitest';

import { architectureModelAssets, validateArchitectureComponent, type ArchitectureComponent } from './architecture';
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
