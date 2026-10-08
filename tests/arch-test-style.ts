/**
 * A neutral generated-architecture style for tests: a walled room with a
 * door and a window (frame mouldings), a crown moulding round its inside,
 * a floor, a barrel vault, and a row of columns (a profile swept round a
 * small square, made once and stamped) — the engine's two primitives and a
 * fill, worn on the starter layout's rows. Test data only; games bring
 * their own styles.
 */
import type { ArchitectureComponent, ArchitectureProfile } from '../packages/project-model/src/architecture';

export const TEST_PROFILES: Record<string, ArchitectureProfile> = {
  // A wall 0.2 m thick and 3 m tall, centred on its path: the face right of travel, the top, the face left of it.
  wall: { points: [[0.1, 0], [0.1, 3], [-0.1, 3], [-0.1, 0]], slots: ['lower_wall', 'bevel', 'upper_wall'], chamfer: 0.02 },
  // A crown moulding on a wall's face: a cove and a fillet stepping out from the wall.
  crown: { points: [[0, 2.6], [0.04, 2.65], [0.08, 2.75], [0.1, 2.9], [0.1, 3]], slots: ['crown', 'crown', 'crown', 'crown'], smooth: true },
  // A frame round an opening: a flat band 0.12 m wide standing 0.04 m out of the wall (its outer edge, its face, its
  // edge at the hole; across is away from the hole, up out of the wall).
  frame: { points: [[0.12, 0], [0.12, 0.04], [0, 0.04], [0, 0]], slots: ['frame', 'frame', 'frame'] },
  // A column's shaft face, drawn downward so it faces left of travel: swept round a closed square walked with the
  // inside on its right, its four faces look out, mitred at the corners.
  shaft: { points: [[0, 2.5], [0, 0]], slots: ['column'] },
};

/** A room 8 × 6 m (closed path), its crown inside, a door and a window, a floor, a vault, and four columns along its middle. */
export function testArchitecture(chunkSize = 32): ArchitectureComponent {
  const room: [number, number, number][] = [
    [0, 0, 0],
    [8, 0, 0],
    [8, 0, 6],
    [0, 0, 6],
  ];
  return {
    chunkSize,
    profiles: TEST_PROFILES,
    elements: [
      {
        id: 'walls',
        kind: 'sweep',
        path: { points: room, closed: true },
        profile: 'wall',
        openings: [
          { id: 'door', at: 4, width: 1.2, bottom: 0, top: 2.2, frame: 'frame', frameSides: 'both' },
          { id: 'window', at: 11, width: 1.4, bottom: 1, top: 2.2, frame: 'frame' },
        ],
      },
      // Inside the room (the path runs clockwise seen from above: right of travel is inside), 0.1 m in from the wall's centre.
      { id: 'crown', kind: 'sweep', path: { points: room, closed: true, offset: 0.1 }, profile: 'crown', detail: true },
      { id: 'floor', kind: 'fill', path: { points: room, closed: true }, shape: 'flat', slot: 'floor' },
      { id: 'vault', kind: 'fill', path: { points: room.map((p) => [p[0], 3, p[2]] as [number, number, number]), closed: true }, shape: 'barrel', slot: 'upper_wall', rise: 1.5, collide: false },
      {
        id: 'columns',
        kind: 'repeat',
        path: { points: [[1.5, 0, 3], [6.5, 0, 3]] },
        spacing: 5 / 3,
        piece: {
          elements: [
            {
              id: 'shaft',
              kind: 'sweep',
              path: {
                points: [
                  [-0.15, 0, -0.15],
                  [0.15, 0, -0.15],
                  [0.15, 0, 0.15],
                  [-0.15, 0, 0.15],
                ],
                closed: true,
              },
              profile: 'shaft',
            },
          ],
        },
      },
    ],
  };
}
