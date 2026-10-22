/**
 * The interior level class (`--classes interior`): neutral, generated content
 * shaped like a building a player walks through, to measure what rooms cost
 * when the camera stands inside them (and, with `--switches portals=off`, the
 * same export with room/portal culling off).
 *
 * A flat block layer (one row of soil) and one generated-architecture object
 * drawn on it, as the layer's Rooms tool draws it: `grid.cols` × `grid.rows`
 * rooms of `room` metres side by side in the engine's starter room preset
 * (walls, baseboard, cove, floor, ceiling), every inner wall shared. Doorways
 * join every pair of neighbours along x and, in two columns, the rows; one
 * doorway leads outside and a few outer walls have windows. Half of the
 * doorways hold a closed door (edge pieces of the layer on the cell edges it
 * covers); the other half are left open, with no piece in them (an edge
 * piece is drawn the same open or closed, so an open door would still hide
 * the room beyond). Static props stand on each room's floor clear of
 * its walls and doorway lines; a lamp hangs in some rooms, two of them
 * shadowed spots. The camera stands in a room in the middle of the building,
 * looking along its row through the doorways: an open doorway shows the room
 * beyond, a closed door hides it.
 *
 * With more storeys (`--storeys N`) every room is stacked that many times: the
 * upper storeys' doorways and windows repeat the ground storey's, all open (a
 * closed door is a block edge, and the layer's door rows stand on the slab), a
 * flight of stairs climbs to each next storey in a few rooms, and every storey
 * has its props. The camera then looks down on the building from above and
 * behind, as a follow camera over a player inside it does: the top storey's
 * ceilings and every storey's walls stand between it and the ground storey.
 *
 * Pure: a function of the seed, so the measured content is the same every run.
 */
import { ARCHITECTURE_FLOOR_ON_CELLS, architectureOpeningEdges, MAX_LOCAL_LIGHTS, type ArchitectureOpening, type ArchitectureOutline } from '@thirdlight/project-model';

import { ROOM_OPENING_KINDS } from '../../packages/editor/src/session/room-draw';
import { prng, type EntityValue } from './generate';
import { LEVEL_SEED, LEVEL_SPEC, LEVEL_VERSION, levelProp, levelPropFiles, levelTransform, levelYaw, type LevelPlan, type LevelRoom } from './level';

/** The interior's sizes (the plan fills them exactly). */
export const LEVEL_INTERIOR_SPEC = {
  /** Block columns of the layer (1 m cells) and its rows of `LEVEL_SPEC.cellHeight`. */
  layer: { x: 64, z: 48, rows: 8 },
  /** Rooms along x and z, and each room's side (m). */
  grid: { cols: 8, rows: 5 },
  room: 6,
  /** The columns whose rooms have doorways between rows. */
  rowDoorColumns: [1, 6],
  /** Static models per room, and metres they keep from the walls. */
  propsPerRoom: 10,
  propMargin: 1,
  /** Rooms with a lamp (at most the scene's local-light budget), of which the first `spots` are shadowed spots. */
  lamps: 16,
  spots: 2,
  /** A lamp's height over the floor and its range (m). */
  lampHeight: 2.4,
  lampRange: 6,
  /** The camera's eye over the floor (m). */
  eye: 1.6,
  /** The camera's room (column, row): in the middle of the building. */
  cameraRoom: [3, 2] as const,
  /** Whether each doorway ahead of the camera along its row is open, nearest first. */
  cameraDoors: [true, true, false, true],
  /**
   * More than one storey: metres from one storey's floor to the next (the starter room's walls), the rooms
   * (column, row) with stairs up along their north wall, and the camera's height over the ground storey's
   * floor and its distance south of the middle of the four rooms from the camera room to the north-east, which
   * it looks at.
   */
  upper: { storeyHeight: 3, stairRooms: [[3, 2], [5, 1], [1, 3]], viewHeight: 10, viewBack: 9 },
} as const;

/** Rows of the soil slab the building stands on. */
const SLAB_ROWS = 1;
/** The rooms' outlines lie on the slab's top (object frame: the object stands at the layer's place). */
const SLAB_TOP = SLAB_ROWS * LEVEL_SPEC.cellHeight;
/** The floor the generator lays over the cells: where props stand and the camera's eye is measured from. */
const FLOOR_Y = SLAB_TOP + ARCHITECTURE_FLOOR_ON_CELLS;
const PRESET = 'starter-room';
/** The edge block type the doors are (its own id: the area's live doors are `door`). */
const DOOR_BLOCK = 'room-door';
const WINDOW = { bottom: 1, top: 2 };

const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const r6 = (v: number): number => Math.round(v * 1e6) / 1e6;

/** A doorway: the room that lists it, the opening, and whether it is open (no door) or holds a closed door (null: a window). */
export interface InteriorDoorway {
  room: number;
  opening: ArchitectureOpening;
  open: boolean | null;
  exterior: boolean;
}

/** A room's outline corners (layer metres), inside to the right of travel: south, east, north, west sides in that order. */
const roomPoints = (x0: number, z0: number, side: number): [number, number, number][] => [
  [x0, SLAB_TOP, z0],
  [x0 + side, SLAB_TOP, z0],
  [x0 + side, SLAB_TOP, z0 + side],
  [x0, SLAB_TOP, z0 + side],
];

/**
 * Distance along a room's outline to a point on one of its sides: `along` metres from the side's first corner
 * (south runs +x from x0, east +z from z0, north −x from x0 + side, west −z from z0 + side).
 */
const alongOutline = (side: 'south' | 'east' | 'north' | 'west', along: number, room: number): number => ({ south: 0, east: 1, north: 2, west: 3 })[side] * room + along;

/** Shuffle in place with the generator (Fisher–Yates). */
function shuffle<T>(xs: T[], rnd: () => number): T[] {
  for (let i = xs.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    [xs[i], xs[j]] = [xs[j]!, xs[i]!];
  }
  return xs;
}

/** A stair's run along its room's north wall: from this far off the west wall to this far off the east one, this far off the north one (m). */
const STAIR = { west: 0.8, east: 1.2, north: 0.8, width: 1 };

export function levelInteriorPlan(seed = LEVEL_SEED, storeys = 1): LevelPlan {
  if (!Number.isInteger(storeys) || storeys < 1) throw new Error(`interior: storeys is a whole number from 1, not ${storeys}`);
  const S = LEVEL_INTERIOR_SPEC;
  const U = S.upper;
  const stairRoom = (c: number, r: number): boolean => storeys > 1 && U.stairRooms.some(([sc, sr]) => sc === c && sr === r);
  const L = S.layer;
  const { cols, rows } = S.grid;
  const side = S.room;
  // The level's prop files: the same first draws the other classes take, so the same files.
  const rnd = prng(seed * 104729 + LEVEL_SPEC.areaSide);
  const props = levelPropFiles(rnd);
  const cellSize = [1, LEVEL_SPEC.cellHeight, 1];
  // The building centred on the layer, the layer centred on the world's origin.
  const bx = (L.x - cols * side) / 2;
  const bz = (L.z - rows * side) / 2;
  const origin: [number, number, number] = [-L.x / 2, 0, -L.z / 2];
  const roomAt = (c: number, r: number): [number, number] => [bx + c * side, bz + r * side];
  const index = (c: number, r: number): number => r * cols + c;
  // Openings of one cell's width on a cell (not on a cell line): the door edges are then whole cells.
  const mid = Math.floor(side / 2) + 0.5;
  const door = ROOM_OPENING_KINDS.door;

  const doorways: InteriorDoorway[] = [];
  const add = (room: number, id: string, at: number, kind: 'door' | 'window', exterior: boolean): void => {
    const o = kind === 'door' ? { bottom: door.bottom, top: door.top } : WINDOW;
    doorways.push({ room, opening: { id, at, width: 1, ...o }, open: kind === 'door' ? false : null, exterior });
  };
  // Between neighbours along x: listed by the west room on its east side (the expansion cuts it through the shared wall).
  for (let r = 0; r < rows; r += 1) for (let c = 0; c + 1 < cols; c += 1) add(index(c, r), 'door-e', alongOutline('east', mid, side), 'door', false);
  // Between rows in a few columns: listed by the south room on its north side.
  for (const c of S.rowDoorColumns) for (let r = 0; r + 1 < rows; r += 1) add(index(c, r), 'door-n', alongOutline('north', side - mid, side), 'door', false);
  // One way out (the middle of the south front) and windows on the north and south fronts.
  add(index(Math.floor(cols / 2) - 1, 0), 'door-out', alongOutline('south', mid, side), 'door', true);
  for (const c of [0, 2, 4, 6]) add(index(c, rows - 1), 'window-n', alongOutline('north', side - mid, side), 'window', true);
  for (const c of [1, 5]) add(index(c, 0), 'window-s', alongOutline('south', mid, side), 'window', true);

  // Half of the inner doors open: those ahead of the camera as `cameraDoors` says, the rest drawn by the seed.
  const [cc, cr] = S.cameraRoom;
  const inner = doorways.filter((d) => d.open !== null && !d.exterior);
  const ahead = S.cameraDoors.map((open, k) => ({ d: doorways.find((x) => x.room === index(cc + k, cr) && x.opening.id === 'door-e')!, open }));
  for (const a of ahead) a.d.open = a.open;
  const rest = shuffle(inner.filter((d) => !ahead.some((a) => a.d === d)), rnd);
  const openWanted = Math.ceil(inner.length / 2) - ahead.filter((a) => a.open).length;
  rest.forEach((d, k) => {
    d.open = k < openWanted;
  });

  // The outlines, each with the openings it lists.
  const outlines: ArchitectureOutline[] = [];
  let upperOpenings = 0;
  const rooms: LevelRoom[] = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const i = index(c, r);
      const [x0, z0] = roomAt(c, r);
      const own = doorways.filter((d) => d.room === i);
      // The upper storeys repeat the ground storey's openings, the way out excepted (all open: see the header).
      const upper = Array.from({ length: storeys - 1 }, (_, k) => own.filter((d) => !(d.exterior && d.open !== null)).map((d) => ({ ...d.opening, id: `${d.opening.id}-s${k + 1}`, storey: k + 1 }))).flat();
      upperOpenings += upper.length;
      const openings = [...own.map((d) => d.opening), ...upper];
      // Stairs up to each next storey along the north wall, rising west to east.
      const stairs = stairRoom(c, r) ? Array.from({ length: storeys - 1 }, (_, k) => ({ id: `up-${k}`, from: [x0 + STAIR.west, FLOOR_Y + k * U.storeyHeight, z0 + side - STAIR.north] as [number, number, number], to: [x0 + side - STAIR.east, FLOOR_Y + (k + 1) * U.storeyHeight, z0 + side - STAIR.north] as [number, number, number], width: STAIR.width })) : [];
      outlines.push({ id: `room-${i + 1}`, path: { points: roomPoints(x0, z0, side), closed: true }, preset: PRESET, ...(openings.length > 0 ? { openings } : {}), ...(storeys > 1 ? { storeys, storeyHeight: U.storeyHeight } : {}), ...(stairs.length > 0 ? { stairs } : {}) });
      // The walls are generated, not cells: the layer's top row bounds them.
      rooms.push({ box: [x0, z0, x0 + side, z0 + side], top: L.rows });
    }
  }

  // Closed doors in their doorways: the layer's edges each opening covers, from the floor up to its head (as the Rooms tool puts them).
  const closedAt: number[] = [];
  for (const d of doorways) {
    if (d.open !== false) continue;
    for (const e of architectureOpeningEdges(outlines[d.room]!.path, d.opening, SLAB_TOP, [0, 0, 0], cellSize)) closedAt.push(...e);
  }
  const blockEdits: Record<string, unknown>[] = [
    { kind: 'fill', box: [0, 0, 0, L.x, SLAB_ROWS, L.z], cell: { block: 'soil' } },
    { kind: 'edges', at: closedAt, edge: { block: DOOR_BLOCK } },
  ];

  const world = (x: number, y: number, z: number): [number, number, number] => [x + origin[0], y + origin[1], z + origin[2]];
  const entities: EntityValue[] = [];
  // Props on each room's floor, clear of its walls and of the lines through its doorways' middles (the camera's view and the way through).
  const lo = S.propMargin;
  const hi = side - S.propMargin;
  const clear = (v: number): boolean => Math.abs(v - mid) >= 1;
  let propCount = 0;
  let propColliders = 0;
  for (let i = 0; i < cols * rows; i += 1) {
    const [x0, z0] = roomAt(i % cols, Math.floor(i / cols));
    for (let k = 0; k < S.propsPerRoom; k += 1) {
      let x = 0;
      let z = 0;
      do {
        x = lo + rnd() * (hi - lo);
        z = lo + rnd() * (hi - lo);
      } while (!clear(x) || !clear(z));
      const file = props[Math.floor(rnd() * props.length)]!;
      const s = 0.7 + rnd() * 0.6;
      const [wx, wy, wz] = world(x0 + x, FLOOR_Y, z0 + z);
      entities.push(levelProp(propCount, file.assetId, wx, wy, wz, rnd() * Math.PI * 2, s, propCount % 2 === 0));
      if (propCount % 2 === 0) propColliders += 1;
      propCount += 1;
    }
  }
  // The upper storeys' props, the same way (after the ground storey's: a one-storey plan draws as before), and in a
  // room with stairs clear of their run along the north wall.
  const groundProps = propCount;
  for (let k = 1; k < storeys; k += 1) {
    for (let i = 0; i < cols * rows; i += 1) {
      const [c, r] = [i % cols, Math.floor(i / cols)];
      const [x0, z0] = roomAt(c, r);
      const zHi = stairRoom(c, r) ? side - STAIR.north - STAIR.width : hi;
      for (let n = 0; n < S.propsPerRoom; n += 1) {
        let x = 0;
        let z = 0;
        do {
          x = lo + rnd() * (hi - lo);
          z = lo + rnd() * (zHi - lo);
        } while (!clear(x) || !clear(z));
        const file = props[Math.floor(rnd() * props.length)]!;
        const s = 0.7 + rnd() * 0.6;
        const [wx, wy, wz] = world(x0 + x, FLOOR_Y + k * U.storeyHeight, z0 + z);
        entities.push(levelProp(propCount, file.assetId, wx, wy, wz, rnd() * Math.PI * 2, s, propCount % 2 === 0));
        if (propCount % 2 === 0) propColliders += 1;
        propCount += 1;
      }
    }
  }

  // Lamps: every room of the camera's row (what it sees), then rooms drawn by the seed, within the local-light budget;
  // the spots (shadowed, pointing down) in the camera's room and the next one ahead.
  const lampCount = Math.min(S.lamps, MAX_LOCAL_LIGHTS);
  const row = Array.from({ length: cols }, (_, c) => index(c, cr));
  const spotRooms = [index(cc, cr), index(cc + 1, cr)].slice(0, S.spots);
  const others = shuffle(Array.from({ length: cols * rows }, (_, i) => i).filter((i) => !row.includes(i)), rnd);
  const lit = [...spotRooms, ...row.filter((i) => !spotRooms.includes(i)), ...others].slice(0, lampCount);
  let pointLights = 0;
  let spotLights = 0;
  for (const [k, i] of lit.entries()) {
    const [x0, z0] = roomAt(i % cols, Math.floor(i / cols));
    const [wx, wy, wz] = world(x0 + side / 2, FLOOR_Y + S.lampHeight, z0 + side / 2);
    const spot = spotRooms.includes(i);
    const light = spot
      ? { type: 'spot', color: '#ffc27a', intensity: 60, direction: [0, -1, 0], angle: 60, penumbra: 0.3, range: S.lampRange, decay: 2, castShadow: true }
      : { type: 'point', color: '#ffc27a', intensity: 30, range: S.lampRange, decay: 2 };
    entities.push({ id: `lamp-${k}`, name: `Lamp ${k + 1}`, components: { transform: levelTransform(wx, wy, wz), light } });
    if (spot) spotLights += 1;
    else pointLights += 1;
  }

  // The camera: by the camera room's west wall on its doorway line, eye high, looking +x (three cameras look down −z).
  // With more storeys: above and south of the four rooms from the camera room to the north-east, looking +z down at their middle.
  const [cx0, cz0] = roomAt(cc, cr);
  let camera: LevelPlan['camera'];
  if (storeys > 1) {
    const at = world(cx0 + side, FLOOR_Y + U.viewHeight, cz0 + side - U.viewBack);
    const pitch = -Math.atan2(U.viewHeight, U.viewBack);
    // Yaw half a turn (to +z), then the pitch about the camera's own x.
    camera = { position: [r3(at[0]), r3(at[1]), r3(at[2])], rotation: [0, r6(Math.cos(pitch / 2)), r6(-Math.sin(pitch / 2)), 0] };
  } else {
    const eye = world(cx0 + S.propMargin, FLOOR_Y + S.eye, cz0 + mid);
    camera = { position: [r3(eye[0]), r3(eye[1]), r3(eye[2])], rotation: levelYaw(-Math.PI / 2) };
  }

  const batches: EntityValue[][] = [];
  for (let i = 0; i < entities.length; i += 256) batches.push(entities.slice(i, i + 256));
  const layer: EntityValue = { id: 'ground', name: 'Ground', components: { transform: levelTransform(origin[0], origin[1], origin[2]), blockLayer: { cellSize, bounds: { min: [0, 0, 0], max: [L.x, L.rows, L.z] } } } };
  const doors = doorways.filter((d) => d.open !== null);
  const counts: Record<string, number> = {
    rooms: outlines.length,
    doorways: doors.length,
    closedDoors: doors.filter((d) => d.open === false).length,
    openDoorways: doors.filter((d) => d.open === true).length,
    windows: doorways.length - doors.length,
    doorEdges: closedAt.length / 4,
    props: propCount,
    propColliders,
    ...(storeys > 1 ? { storeys, upperProps: propCount - groundProps, upperOpenings, stairs: outlines.reduce((n, o) => n + (o.stairs?.length ?? 0), 0) } : {}),
    lamps: pointLights + spotLights,
    pointLights,
    spotLights,
  };
  return {
    kind: 'interior',
    version: LEVEL_VERSION,
    seed,
    props,
    buffers: [],
    layer,
    batches,
    blockEdits,
    rooms,
    camera,
    counts,
    liveDoors: [],
    edgeWalls: false,
    wallPaint: false,
    roofs: 'none',
    kitSwap: false,
    rules: false,
    projection: 0,
    macro: 0,
    foliage: 'on',
    flight: false,
    flightOps: false,
    impostorSize: 0,
    splines: false,
    blocksSeam: false,
    fields: null,
    interior: {
      architecture: { elements: [], outlines },
      doorType: { blockId: DOOR_BLOCK, name: 'Room door', variants: [{ color: '#6b4a2b' }], shape: 'full', placement: 'edge' },
    },
  };
}
