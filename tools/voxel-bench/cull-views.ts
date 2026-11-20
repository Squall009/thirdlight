/**
 * The views connectivity culling is measured at (connectivity-cli.ts, light-shots `--cull`): engine-owned bench
 * data. On the town inside the 8 km world (lighting-cameras.ts's town and cave): the room camera's room on the ground
 * floor looking at its window wall with the town behind it, the same room's upper floor, the street along the house
 * row, the dug cave 22 m in looking out and looking in, a walk through the room camera's house (street, door, room,
 * stairs, upper floor: the camera crossing units), and the town orbit's poses (an open view). On the generated caves
 * and vertical worlds, views found where the worlds are (tunnels with rock over them, the tower's shaft) by
 * {@link findCaveViews}.
 */
import { CAVE, LIGHTING_CAMERAS, yawOf } from './lighting-cameras';

export interface CullView {
  readonly name: string;
  readonly world: 'far' | 'caves' | 'vertical';
  readonly eye: readonly [number, number, number];
  /** Yaw (rad, 0 looks along −z) and pitch (rad, down). */
  readonly yaw: number;
  readonly pitch: number;
  readonly shows: string;
}

const cam = (name: string): (typeof LIGHTING_CAMERAS)[number] => LIGHTING_CAMERAS.find((c) => c.name === name)!;
const room = cam('room-window');
const street = cam('street-noon');
const cave = cam('cave');

/** The room camera's house (lot 6, 6; x −5…5 m, z −4…6 m): its door in the z −4 m wall at x −0.5…0.5 m, its stairs up the x −4.5…−3.5 m strip from z −3 m. */
const WALK: ReadonlyArray<{ eye: [number, number, number]; to: [number, number]; pitch: number; shows: string }> = [
  { eye: [0, 1.7, -14], to: [0, 1], pitch: 0.05, shows: 'the street in front of the house, facing its door' },
  { eye: [0, 1.7, -6], to: [0, 1], pitch: 0.05, shows: '2 m before the door' },
  { eye: [0, 1.7, -3.75], to: [0, 1], pitch: 0.05, shows: 'in the doorway' },
  { eye: [0, 1.7, -1], to: [-1, 0.6], pitch: 0.05, shows: 'in the room, turning to the stairs' },
  { eye: [-4, 1.7, -3.4], to: [0, 1], pitch: -0.2, shows: 'at the stairs’ foot, looking up them' },
  { eye: [-4, 3.2, -1.5], to: [0, 1], pitch: -0.1, shows: 'half way up the stairs' },
  { eye: [-4, 5.2, 0.5], to: [1, 0.3], pitch: 0.05, shows: 'at the stairs’ top, on the upper floor' },
  { eye: [1, 5.2, 2.5], to: [-1, 0.15], pitch: 0.05, shows: 'on the upper floor, looking at its west wall' },
];

/** The town orbit's poses (flight-camera.ts TOWN_ORBIT_POSE: 12 m round the town's middle, 20 m up, pitch 0.03). */
const ORBIT_POSES = 8;
function orbitPose(i: number): CullView {
  const yaw = (i / ORBIT_POSES) * Math.PI * 2;
  const pitch = 0.03;
  const c = Math.cos(pitch);
  return { name: `orbit-${i}`, world: 'far', eye: [Math.sin(yaw) * c * 12, 20 + Math.sin(pitch) * 12, Math.cos(yaw) * c * 12], yaw, pitch, shows: 'the town orbit (an open view)' };
}

export const CULL_VIEWS: readonly CullView[] = Object.freeze([
  { name: 'room-window', world: 'far', eye: room.eye, yaw: room.yaw, pitch: room.pitch, shows: room.shows },
  { name: 'house-upper', world: 'far', eye: [room.eye[0], 5.2, room.eye[2]], yaw: room.yaw, pitch: room.pitch, shows: 'the room camera’s house, upper floor, looking at its west wall' },
  { name: 'street-row', world: 'far', eye: street.eye, yaw: street.yaw, pitch: street.pitch, shows: street.shows },
  { name: 'cave-out', world: 'far', eye: cave.eye, yaw: cave.yaw, pitch: cave.pitch, shows: cave.shows },
  { name: 'cave-in', world: 'far', eye: cave.eye, yaw: yawOf(CAVE.into[0], CAVE.into[1]), pitch: 0.02, shows: 'deep in the dug cave looking in: the tube’s end 4 m ahead, the hill round it' },
  ...WALK.map((w, i) => ({ name: `walk-${i + 1}`, world: 'far' as const, eye: w.eye, yaw: yawOf(w.to[0], w.to[1]), pitch: w.pitch, shows: w.shows })),
  ...Array.from({ length: ORBIT_POSES }, (_, i) => orbitPose(i)),
] satisfies CullView[]);

/**
 * Views inside a generated world's tunnels: open cells with rock over them (at least `roofCells` of the next 24 up),
 * at least 10 m below the ground's surface, each looking along its longest horizontal free run (≥ 12 m); the
 * `count` best runs at least 40 m apart. `solid(x, y, z)` reads a level-0 cell (a voxel present).
 */
export function findCaveViews(world: 'caves' | 'vertical', solid: (x: number, y: number, z: number) => boolean, area: { x0: number; x1: number; z0: number; z1: number; y0: number; y1: number }, count = 3, roofCells = 8): CullView[] {
  const found: Array<{ eye: [number, number, number]; dir: [number, number]; run: number }> = [];
  const dirs: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  for (let x = area.x0; x < area.x1; x += 16) for (let z = area.z0; z < area.z1; z += 16) {
    for (let y = area.y1; y > area.y0; y -= 4) {
      if (solid(x, y, z) || solid(x, y - 1, z) === false) continue;
      // Stand 3 cells over a floor: the eye's cell and two above it open.
      if (solid(x, y + 1, z) || solid(x, y + 2, z) || solid(x, y + 3, z)) continue;
      let roof = 0;
      for (let k = 4; k < 28; k++) if (solid(x, y + k, z)) roof++;
      if (roof < roofCells) continue;
      let best = 0;
      let bestDir: [number, number] = [1, 0];
      for (const d of dirs) {
        const l = Math.hypot(d[0], d[1]);
        let n = 0;
        while (n < 120 && !solid(Math.round(x + (d[0] / l) * n), y + 3, Math.round(z + (d[1] / l) * n))) n++;
        if (n > best) {
          best = n;
          bestDir = d;
        }
      }
      if (best >= 24) found.push({ eye: [(x + 0.5) * 0.5, (y + 3.5) * 0.5, (z + 0.5) * 0.5], dir: bestDir, run: best });
      break;
    }
  }
  found.sort((a, b) => b.run - a.run);
  const picked: typeof found = [];
  for (const f of found) {
    if (picked.length >= count) break;
    if (picked.some((p) => Math.hypot(p.eye[0] - f.eye[0], p.eye[2] - f.eye[2]) < 40)) continue;
    picked.push(f);
  }
  return picked.map((p, i) => ({ name: `${world}-tunnel-${i + 1}`, world, eye: p.eye, yaw: yawOf(p.dir[0], p.dir[1]), pitch: 0.02, shows: `inside a tunnel with rock over it, looking along its longest free run (${(p.run / 2).toFixed(0)} m)` }));
}
