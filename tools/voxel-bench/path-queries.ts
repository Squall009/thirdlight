/**
 * The path bench's fixed queries on the 8 km world (paths-cli.ts, the voxel world page's overlay pictures, the Play
 * run): engine-owned bench data, world metres. The town's room camera house (lot 6, 6; lighting-cameras.ts) stands
 * at x −5 … 5 m, z −4 … 6 m: its door in the z −4 m wall at x −0.5 … 0.5 m (0.5 … 2.5 m up), its stairs up the
 * x −4.5 … −3.5 m strip from z −3 m, its upper floor stood on at 3.5 m. Its lot's front garden runs to a fence at
 * z −7.5 m with a gap at x 0.5 … 3 m; past it the street between the lot rows (z −8.5 … −7.5 m, between this lot's
 * fence and the back fence of the lot across). A point is where a body stands or its middle: a query looks for the
 * standable cell at or under it (to 2 m) or beside it; `toGround` / `fromGround` points are put on the highest
 * standing place at or below them first (the bench finds it).
 */
import { CAVE } from './lighting-cameras';

export interface PathQuery {
  readonly name: string;
  readonly from: readonly [number, number, number];
  readonly to: readonly [number, number, number];
  /** On the town (the hundred queued queries mix these ends). */
  readonly town: boolean;
  /** `to` is the top of what stands in its column (the bench finds its height): a roof. */
  readonly toTop?: boolean;
  readonly fromTop?: boolean;
  /** The highest standing place at or below the point's height in its column (the ground, a cave's floor under the hill). */
  readonly fromGround?: boolean;
  readonly toGround?: boolean;
  /** Where the bench's camera stands for it in Play: the street camera, or the cave's. */
  readonly at: 'street' | 'cave';
  readonly shows: string;
}

const STREET: readonly [number, number, number] = [6.25, 0.5, -7.75];
const ROOM: readonly [number, number, number] = [1.25, 0.75, 1.75];
const ROOF: readonly [number, number, number] = [0.25, 40, 1.25];
const along = (m: number, y: number): [number, number, number] => [CAVE.foot[0] + CAVE.into[0] * m, y, CAVE.foot[2] + CAVE.into[1] * m];

export const PATH_QUERIES: readonly PathQuery[] = Object.freeze([
  { name: 'across-room', from: [-2.25, 0.75, 4.25], to: [3.75, 0.75, -2.75], town: true, at: 'street', shows: 'across the room house’s ground floor, corner to corner' },
  { name: 'room-street', from: ROOM, to: STREET, toGround: true, town: true, at: 'street', shows: 'from the room out through its door and the garden’s fence gap to the street' },
  { name: 'ground-upper', from: ROOM, to: [2.25, 3.75, 4.25], town: true, at: 'street', shows: 'from the ground floor up the stairs to the upper floor' },
  { name: 'street-far', from: STREET, fromGround: true, to: [-108.25, 0.5, 111.75], toGround: true, town: true, at: 'street', shows: 'along the streets to the town’s far corner (about 200 m)' },
  { name: 'cave-in', from: along(-3, 125), fromGround: true, to: along(20, CAVE.axisY), toGround: true, town: false, at: 'cave', shows: 'from the hillside’s foot into the dug cave, 20 m in' },
  { name: 'roof-street', from: ROOF, fromTop: true, to: STREET, toGround: true, town: false, at: 'street', shows: 'from the room house’s roof to the street: no way down (unreachable)' },
  { name: 'street-roof', from: STREET, fromGround: true, to: ROOF, toTop: true, town: false, at: 'street', shows: 'from the street onto the roof: no way up, but the street reaches chunks not loaded (unknown)' },
  { name: 'beyond-ring', from: STREET, fromGround: true, to: [2000, 60, 0], town: false, at: 'street', shows: 'to a place 2 km off, past the loaded ring (unknown, the path to the frontier)' },
] satisfies PathQuery[]);

/** The room house's door cells (world cells, inclusive): the edit that walls it up and digs it again. */
export const PATH_DOOR = Object.freeze({ min: Object.freeze([-1, 1, -8] as const), max: Object.freeze([0, 4, -8] as const) });
