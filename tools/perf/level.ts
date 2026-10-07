/**
 * The level-building perf classes: neutral, generated content (no game data)
 * shaped like a level a game builds — a block area the player moves through,
 * and that area inside a landscape reaching a few kilometres.
 *
 * - `area`: one block layer of `areaSide`² 1 m columns (rolling
 *   ground from corner heights, smoothed and cut tops), rooms of rock walls
 *   with a door gap, static props (model files with `_LOD` levels, part with
 *   box colliders), foliage instance sets over the ground (no shadow, density
 *   falloff), a few point lights in the rooms, a shadowed sun, exp2 fog and
 *   the post stack a 3D game uses.
 * - `landscape`: the same area plus what stands around it out to
 *   the outer far ring (3 km): a flat ground plane and rings of large instanced copies
 *   (trees and rocks) under the same fog, the camera's far plane pushed out.
 *   The plane and the rings stand in for terrain and its scatter until the
 *   engine has a terrain component; the plan grows a `terrain` part then and
 *   drops the plane, keeping the rings' layout so the numbers stay comparable.
 *
 * Either class can carry `liveDoors` live door cells on the ground outside the
 * rooms (`--live N`; none by default, so the classes' numbers stay
 * comparable): a live block type whose prefab is a root with a script (it
 * reads its cell's `open` field every step) and a door leaf with a box and a
 * box collider, so each cell spawns two objects in the game.
 *
 * Either class can build its rooms from edge pieces instead (`--edge-walls`;
 * cell walls by default, as recorded): each wall a stack of one-row edge
 * pieces on the room's outline from the ground up, the door gap two closed
 * door pieces, so the two runs compare walls of cells with walls of edges.
 *
 * Either class can give its layer wall paint (`--wall-paint`; none by
 * default, as recorded): walls with paint of their own (cut at the points),
 * each room's front wall painted with a patch of layer 3 and wetness up its
 * face from the ground, and the tops around it, so the chunks carry paint
 * colours and the cut walls.
 *
 * Either class can roof its rooms (`--roofs`: a rock slab one row thick on
 * each room's walls, a region per roof; none by default, as recorded), and
 * make the roofs cut-aways (`--cutaway`): the layer lists the roof regions and
 * a script forces every odd roof cut and swaps the even ones between cut and
 * drawn every two seconds, so the measurement holds cut roofs, drawn roofs and
 * fades (`--roofs` alone is the same roofs never cut).
 *
 * Either class can swap its kit while it runs (`--kit-swap`; none by default,
 * as recorded): every block type (soil, rock, the edge walls) has a `burnt`
 * twin of the same shape in other colours, and a script shows the burnt kit
 * over the whole layer and takes it off again every two seconds, so the
 * measurement holds whole-layer restyles (the page marks each one's time
 * and its long frames, `tl:blocks:restyle`).
 *
 * Both classes share the camera (at the area's edge, looking across it to the
 * horizon) and the environment, so the landscape's extra cost is the far part.
 * `levelPlan` is a pure function of the kind and the seed; `buildLevel`
 * applies it through the real command API, like the village.
 */
import { INSTANCE_DENSITY_MIN_NEW } from '@thirdlight/project-model';

import { packGlb } from './assets';
import { publishBehaviorVia, publishBufferVia, publishFileVia, splitBySize } from './build';
import type { PerfBackend } from './backend';
import { prng, type BehaviorPlan, type EntityValue } from './generate';
import { propGlb, scatterKitGlb, type PropSpec } from './village-assets';

/** Bump when the generated content changes. */
export const LEVEL_VERSION = 1;
export const LEVEL_SEED = 30;

export type LevelKind = 'area' | 'landscape';
export const LEVEL_KINDS: readonly LevelKind[] = ['area', 'landscape'];

/** The classes' sizes (the plan fills them exactly). */
export const LEVEL_SPEC = {
  /** Block columns per side (1 m cells): about 100 × 100 m. */
  areaSide: 100,
  cellHeight: 0.5,
  rooms: 10,
  propFiles: 24,
  props: 300,
  propColliders: 150,
  foliageSets: 40,
  foliageCopies: 150,
  pointLights: 6,
  /** The landscape's far rings: [inner, outer] radius (m) from the area's centre; then sectors (one instance set each) per ring and copies per set. */
  farRings: [
    [150, 400],
    [400, 900],
    [900, 1800],
    [1800, 3000],
  ] as readonly (readonly [number, number])[],
  farSectors: 16,
  farCopies: 500,
  /** Far copies are scaled up from the scatter kit's pieces (0.2–0.8 m) to tree and boulder size. */
  farScale: [8, 16] as const,
  /** Instance chunk size of the far sets (m): coarse, as a game sets for distant scatter. */
  farChunk: 256,
  /** The camera's far plane in the landscape (m). */
  farPlane: 4000,
} as const;

const PROP_FILE = (i: number): string => `level-prop-${String(i + 1).padStart(2, '0')}`;
const FOLIAGE_KIT = 'level-foliage';
const FOLIAGE_PIECES = ['tuft', 'fern', 'flower', 'shrub'] as const;
const FAR_KIT = 'level-far';
const FAR_PIECES = ['tree', 'pine', 'boulder'] as const;
const GROUND_PLANE = 'level-ground-plane';
/** The starter's objects the classes do without (player, spawn, boxes, pillar). */
const STARTER_REMOVED = ['model-0001', 'spawn-0001', 'box-0001', 'box-0002', 'box-0003', 'box-0004', 'model-0002'];
const PASTE_MAX = 256;
/** The far ground's height (m): under the area's lowest ground (levelHeightAt's minimum, 4 rows = 2 m), so the plane never shows through it. */
const FAR_GROUND_Y = 1.5;
/** Columns per `surface` edit (a command is at most 64 KiB). */
const SURFACE_PER_EDIT = 1500;

const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const r6 = (v: number): number => Math.round(v * 1e6) / 1e6;
const yawQ = (rad: number): [number, number, number, number] => [0, r6(Math.sin(rad / 2)), 0, r6(Math.cos(rad / 2))];
const T = (x: number, y: number, z: number, yaw = 0, s = 1): Record<string, unknown> => ({ position: [r3(x), r3(y), r3(z)], rotation: yawQ(yaw), scale: [r3(s), r3(s), r3(s)] });

/** Ground height (rows) at a layer corner: gentle hills, quantised to 1/16 row as a brush leaves it. */
export const levelHeightAt = (x: number, z: number): number => Math.round((8 + 3 * Math.sin(x / 13) * Math.cos(z / 17) + Math.sin(x / 5.3 + z / 6.1)) * 16) / 16;

/** World ground height (m) at area-local column coordinates (the layer's origin is its corner on y = 0). */
const groundY = (x: number, z: number): number => levelHeightAt(x, z) * LEVEL_SPEC.cellHeight;

export interface LevelRoom {
  /** Columns [x0, z0, x1, z1) in the layer. */
  box: [number, number, number, number];
  /** Top row of the walls (exclusive). */
  top: number;
}

export interface LevelPlan {
  kind: LevelKind;
  version: number;
  seed: number;
  props: { assetId: string; spec: PropSpec; seed: number }[];
  buffers: { key: string; floats: Float32Array }[];
  /** The block layer, pasted alone (its created id is looked up). */
  layer: EntityValue;
  /** Pasted in order. */
  batches: EntityValue[][];
  /** `editBlocks` edits, applied in order. */
  blockEdits: Record<string, unknown>[];
  rooms: LevelRoom[];
  camera: { position: [number, number, number]; rotation: [number, number, number, number] };
  counts: Record<string, number>;
  /** Live door cells [x, y, z] of the layer (empty: none). */
  liveDoors: [number, number, number][];
  /** The rooms' walls are edge pieces (`rock-wall`, the door gap `rock-door`). */
  edgeWalls: boolean;
  /** The layer has wall paint, and the rooms' front walls are painted. */
  wallPaint: boolean;
  /** The rooms' roofs: none, roofs, or roofs that are cut-aways driven by a script. */
  roofs: LevelRoofs;
  /** A script swaps the layer's kit every two seconds. */
  kitSwap: boolean;
}

/** The kit swap's script: the burnt kit over the whole layer every other 240 steps (2 s), off in between. */
const KIT_BEHAVIOR: BehaviorPlan = {
  behaviorId: 'level-kit',
  displayName: 'Level kit swap',
  ownedTransforms: [],
  declaration: { properties: [] },
  source: [
    'export default {',
    '  instantiate() { return {}; },',
    '  step(state: any, ctx: any) {',
    "    if (ctx.phase !== 'intent' || ctx.stepIndex % 240 !== 1) return;",
    '    const layer = ctx.grid.layers()[0];',
    "    ctx.grid.setKit(layer, Math.floor(ctx.stepIndex / 240) % 2 === 0 ? 'burnt' : null);",
    '  },',
    '};',
  ].join('\n'),
};

export type LevelRoofs = 'none' | 'roofs' | 'cutaway';

/** The roofs' script: every odd roof cut, the even ones swapped between cut and drawn every 240 steps (2 s). */
const CUTAWAY_BEHAVIOR = (rooms: number): BehaviorPlan => ({
  behaviorId: 'level-cutaway',
  displayName: 'Level cut-aways',
  ownedTransforms: [],
  declaration: { properties: [] },
  source: [
    'export default {',
    '  instantiate() { return {}; },',
    '  step(state: any, ctx: any) {',
    "    if (ctx.phase !== 'intent' || ctx.stepIndex % 240 !== 1) return;",
    '    const layer = ctx.grid.layers()[0];',
    '    const even = Math.floor(ctx.stepIndex / 240) % 2 === 0;',
    `    for (let i = 0; i < ${rooms}; i += 1) ctx.grid.setCutaway(layer, \`roof-\${i}\`, i % 2 === 1 ? true : even);`,
    '  },',
    '};',
  ].join('\n'),
});

/** The live door's script: it finds its cell once, then reads the cell's `open` field every step. */
const DOOR_BEHAVIOR: BehaviorPlan = {
  behaviorId: 'level-door',
  displayName: 'Level door',
  ownedTransforms: [],
  declaration: { properties: [] },
  source: [
    'export default {',
    '  instantiate() { return { open: false, cell: null }; },',
    '  step(state: any, ctx: any) {',
    "    if (ctx.phase !== 'intent') return;",
    '    if (state.cell === null) state.cell = ctx.grid.cellOf(ctx.entityId);',
    '    const c = state.cell;',
    '    if (c === null) return;',
    "    const open = ctx.grid.meta(c.layer, c.x, c.y, c.z, 'open') === true;",
    "    if (open !== state.open) { state.open = open; ctx.signals.emit('door'); }",
    '  },',
    '};',
  ].join('\n'),
};

/** Copies of one instance set as the engine's 10 floats each (position, rotation, scale). */
function copies(n: number, at: (i: number) => { x: number; y: number; z: number; yaw: number; s: number }): Float32Array {
  const f = new Float32Array(n * 10);
  for (let i = 0; i < n; i += 1) {
    const c = at(i);
    f.set([r3(c.x), r3(c.y), r3(c.z), 0, Math.sin(c.yaw / 2), 0, Math.cos(c.yaw / 2), r3(c.s), r3(c.s), r3(c.s)], i * 10);
  }
  return f;
}

export function levelPlan(kind: LevelKind, seed = LEVEL_SEED, liveDoorCount = 0, edgeWalls = false, wallPaint = false, roofs: LevelRoofs = 'none', kitSwap = false): LevelPlan {
  const S = LEVEL_SPEC;
  const N = S.areaSide;
  const rnd = prng(seed * 104729 + N);
  const half = N / 2;
  const counts: Record<string, number> = { props: 0, propColliders: 0, foliageSets: 0, foliageCopies: 0, rooms: 0, pointLights: 0, farSets: 0, farCopies: 0, groundPlane: 0 };
  const props = Array.from({ length: S.propFiles }, (_, i) => {
    const u = rnd();
    return { assetId: PROP_FILE(i), seed: Math.floor(rnd() * 2 ** 31), spec: { parts: u < 0.5 ? 1 : u < 0.85 ? 2 : 3, rings: 6 + Math.floor(rnd() * 4), sides: 10 + Math.floor(rnd() * 6), textureSize: i % 3 === 0 ? 256 : 0 } };
  });

  // Ground: every column's four corners.
  const blockEdits: Record<string, unknown>[] = [];
  let cols: number[] = [];
  for (let x = 0; x < N; x += 1) {
    for (let z = 0; z < N; z += 1) {
      cols.push(x, z, levelHeightAt(x, z), levelHeightAt(x + 1, z), levelHeightAt(x + 1, z + 1), levelHeightAt(x, z + 1));
      if (cols.length / 6 >= SURFACE_PER_EDIT) {
        blockEdits.push({ kind: 'surface', columns: cols, cell: { block: 'soil' } });
        cols = [];
      }
    }
  }
  if (cols.length > 0) blockEdits.push({ kind: 'surface', columns: cols, cell: { block: 'soil' } });

  // Rooms: rock walls one column thick on a 4 × 4 grid of plots (no two share a plot), a door gap in the north wall.
  const rooms: LevelRoom[] = [];
  const plots = Array.from({ length: 16 }, (_, i) => i);
  for (let i = plots.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    [plots[i], plots[j]] = [plots[j]!, plots[i]!];
  }
  const plot = N / 4;
  const walls: Record<string, unknown>[] = [];
  for (let i = 0; i < S.rooms; i += 1) {
    const p = plots[i]!;
    const w = 7 + Math.floor(rnd() * 6);
    const d = 6 + Math.floor(rnd() * 5);
    const x0 = Math.floor((p % 4) * plot + 2 + rnd() * (plot - w - 4));
    const z0 = Math.floor(Math.floor(p / 4) * plot + 2 + rnd() * (plot - d - 4));
    const x1 = x0 + w;
    const z1 = z0 + d;
    let hi = 0;
    for (let x = x0; x <= x1; x += 1) for (let z = z0; z <= z1; z += 1) hi = Math.max(hi, levelHeightAt(x, z));
    const top = Math.ceil(hi) + 6;
    const doorX = x0 + Math.floor(w / 2);
    const cell = { block: 'rock' };
    if (edgeWalls) {
      // The outline's edges from the ground (the lower end of the edge) up to the top; the door gap holds doors.
      const wall: number[] = [];
      const doors: number[] = [];
      const stack = (out: number[], x: number, z: number, axis: number, top_: number): void => {
        const ground = Math.floor(Math.min(levelHeightAt(x, z), axis === 0 ? levelHeightAt(x, z + 1) : levelHeightAt(x + 1, z)));
        for (let y = ground; y < top_; y += 1) out.push(x, y, z, axis);
      };
      for (let x = x0; x < x1; x += 1) {
        if (x === doorX || x === doorX + 1) stack(doors, x, z0, 1, Math.floor(levelHeightAt(x, z0)) + 4);
        else stack(wall, x, z0, 1, top);
        stack(wall, x, z1, 1, top);
      }
      for (let z = z0; z < z1; z += 1) {
        stack(wall, x0, z, 0, top);
        stack(wall, x1, z, 0, top);
      }
      walls.push({ kind: 'edges', at: wall, edge: { block: 'rock-wall' } }, { kind: 'edges', at: doors, edge: { block: 'rock-door' } });
      counts.edges = (counts.edges ?? 0) + (wall.length + doors.length) / 4;
      rooms.push({ box: [x0, z0, x1, z1], top });
      counts.rooms! += 1;
      continue;
    }
    // The z0 wall in two parts around a two-column door; the others whole.
    walls.push(
      { kind: 'fill', box: [x0, 0, z0, doorX, top, z0 + 1], cell },
      { kind: 'fill', box: [doorX + 2, 0, z0, x1, top, z0 + 1], cell },
      { kind: 'fill', box: [x0, 0, z1 - 1, x1, top, z1], cell },
      { kind: 'fill', box: [x0, 0, z0, x0 + 1, top, z1], cell },
      { kind: 'fill', box: [x1 - 1, 0, z0, x1, top, z1], cell },
    );
    rooms.push({ box: [x0, z0, x1, z1], top });
    counts.rooms! += 1;
  }
  blockEdits.push(...walls);
  if (roofs !== 'none') {
    // A rock slab on each room's walls (the outline included), and its region.
    rooms.forEach((r, i) => {
      const box = [r.box[0], r.top, r.box[1], r.box[2], r.top + 1, r.box[3]];
      blockEdits.push({ kind: 'fill', box, cell: { block: 'rock' } }, { kind: 'region', regionId: `roof-${i}`, op: 'set', boxes: [box] });
    });
    counts.roofs = rooms.length;
  }
  if (wallPaint) {
    // Each room's front (z0) wall: layer 3 and wetness up its face from the ground at both ends of the door, and the tops before it.
    for (const r of rooms) {
      for (const x of [r.box[0] + 2, r.box[2] - 2]) {
        const y = Math.floor(levelHeightAt(x, r.box[1])) + 2;
        blockEdits.push({ kind: 'paint', at: [x, r.box[1]], y, target: 'both', radius: 3, strength: 0.8, channel: 2 }, { kind: 'paint', at: [x, r.box[1]], y: y - 1, target: 'walls', radius: 2, strength: 0.6, channel: 4 });
      }
    }
    counts.wallPaintDabs = rooms.length * 4;
  }

  const inRoom = (x: number, z: number): boolean => rooms.some((r) => x >= r.box[0] - 0.5 && x < r.box[2] + 0.5 && z >= r.box[1] - 0.5 && z < r.box[3] + 0.5);
  const entities: EntityValue[] = [];
  const buffers: LevelPlan['buffers'] = [];
  const at = (x: number, z: number): [number, number, number] => [x - half, groundY(x, z), z - half];

  // Props outside the rooms (a level's scenery), static; every other one has a box collider.
  for (let i = 0; i < S.props; i += 1) {
    let x = 0;
    let z = 0;
    do {
      x = 1 + rnd() * (N - 2);
      z = 1 + rnd() * (N - 2);
    } while (inRoom(x, z));
    const file = props[Math.floor(rnd() * props.length)]!;
    const s = 0.7 + rnd() * 0.6;
    const [wx, wy, wz] = at(x, z);
    const components: Record<string, unknown> = { transform: T(wx, wy, wz, rnd() * Math.PI * 2, s), model: { asset: { assetId: file.assetId } } };
    if (i % 2 === 0) {
      components['collider'] = { shape: { type: 'box', hx: r3(0.5 * s), hy: r3(1 * s), hz: r3(0.5 * s) } };
      counts.propColliders! += 1;
    }
    entities.push({ id: `prop-${i}`, name: `Prop ${i + 1}`, static: true, components });
    counts.props! += 1;
  }
  // Foliage: sets of 10 × 10 m patches on the ground, copies following its height.
  for (let i = 0; i < S.foliageSets; i += 1) {
    const cx = 6 + rnd() * (N - 12);
    const cz = 6 + rnd() * (N - 12);
    const [wx, wy, wz] = at(cx, cz);
    const key = `foliage-${i}`;
    buffers.push({
      key,
      floats: copies(S.foliageCopies, () => {
        const dx = (rnd() - 0.5) * 10;
        const dz = (rnd() - 0.5) * 10;
        return { x: dx, y: groundY(cx + dx, cz + dz) - wy, z: dz, yaw: rnd() * Math.PI * 2, s: 0.7 + rnd() * 0.8 };
      }),
    });
    entities.push({ id: `foliage-${i}`, name: `Foliage ${i + 1}`, components: { transform: T(wx, wy, wz), instances: { asset: { assetId: FOLIAGE_KIT, piece: FOLIAGE_PIECES[i % FOLIAGE_PIECES.length] }, buffer: `$buffer:${key}`, count: S.foliageCopies, castShadow: false, densityMin: INSTANCE_DENSITY_MIN_NEW } } });
    counts.foliageSets! += 1;
    counts.foliageCopies! += S.foliageCopies;
  }
  // Point lights in the first rooms, 2.5 m over the floor.
  for (let i = 0; i < S.pointLights; i += 1) {
    const r = rooms[i % rooms.length]!;
    const x = (r.box[0] + r.box[2]) / 2;
    const z = (r.box[1] + r.box[3]) / 2;
    const [wx, wy, wz] = at(x, z);
    entities.push({ id: `lamp-${i}`, name: `Lamp ${i + 1}`, components: { transform: T(wx, wy + 2.5, wz), light: { type: 'point', color: '#ffc27a', intensity: 30, range: 10, decay: 2 } } });
    counts.pointLights! += 1;
  }

  if (kind === 'landscape') {
    // The ground plane under everything, a little below the area's lowest ground.
    entities.push({ id: 'ground-plane', name: 'Ground plane', static: true, components: { transform: T(0, FAR_GROUND_Y, 0), model: { asset: { assetId: GROUND_PLANE } } } });
    counts.groundPlane = 1;
    // The far rings: one set per sector, copies spread over the sector's area evenly by area.
    S.farRings.forEach(([r0, r1], ring) => {
      for (let s = 0; s < S.farSectors; s += 1) {
        const a0 = (s / S.farSectors) * Math.PI * 2;
        const a1 = ((s + 1) / S.farSectors) * Math.PI * 2;
        const am = (a0 + a1) / 2;
        const rm = (r0 + r1) / 2;
        const cx = Math.cos(am) * rm;
        const cz = Math.sin(am) * rm;
        const key = `far-${ring}-${s}`;
        buffers.push({
          key,
          floats: copies(S.farCopies, () => {
            const a = a0 + rnd() * (a1 - a0);
            const r = Math.sqrt(r0 * r0 + rnd() * (r1 * r1 - r0 * r0));
            return { x: Math.cos(a) * r - cx, y: 0, z: Math.sin(a) * r - cz, yaw: rnd() * Math.PI * 2, s: S.farScale[0] + rnd() * (S.farScale[1] - S.farScale[0]) };
          }),
        });
        entities.push({ id: key, name: `Far ${ring + 1}.${s + 1}`, components: { transform: T(cx, FAR_GROUND_Y, cz), instances: { asset: { assetId: FAR_KIT, piece: FAR_PIECES[(ring + s) % FAR_PIECES.length] }, buffer: `$buffer:${key}`, count: S.farCopies, castShadow: false, densityMin: INSTANCE_DENSITY_MIN_NEW, chunkSize: S.farChunk } } });
        counts.farSets! += 1;
        counts.farCopies! += S.farCopies;
      }
    });
  }

  // Live doors on free ground columns outside the rooms, a row above the column's highest corner (its own
  // generator, so the classes' content does not change with the count).
  const liveDoors: [number, number, number][] = [];
  const doorRnd = prng(seed * 7919 + liveDoorCount);
  const taken = new Set<number>();
  while (liveDoors.length < liveDoorCount) {
    const x = 1 + Math.floor(doorRnd() * (N - 2));
    const z = 1 + Math.floor(doorRnd() * (N - 2));
    if (taken.has(x * N + z) || inRoom(x + 0.5, z + 0.5)) continue;
    taken.add(x * N + z);
    liveDoors.push([x, Math.ceil(Math.max(levelHeightAt(x, z), levelHeightAt(x + 1, z), levelHeightAt(x + 1, z + 1), levelHeightAt(x, z + 1))), z]);
  }
  counts.liveDoors = liveDoors.length;

  const batches: EntityValue[][] = [];
  for (let i = 0; i < entities.length; i += PASTE_MAX) batches.push(entities.slice(i, i + PASTE_MAX));
  const layer: EntityValue = { id: 'ground', name: 'Ground', components: { transform: T(-half, 0, -half), blockLayer: { cellSize: [1, S.cellHeight, 1], bounds: { min: [0, 0, 0], max: [N, 32, N] }, maxSlope: 60, smoothAngle: 40, topSubdivision: 2, ...(wallPaint ? { wallPaint: true } : {}), ...(roofs === 'cutaway' ? { cutaway: { regions: rooms.map((_, i) => ({ region: `roof-${i}` })) } } : {}) } } };
  // At the area's south edge, 8 m over its ground, looking north across it to the horizon.
  const pitch = -0.12;
  const camera: LevelPlan['camera'] = { position: [0, r3(groundY(half, N - 2) + 8), half - 2], rotation: [r6(Math.sin(pitch / 2)), 0, 0, r6(Math.cos(pitch / 2))] };
  return { kind, version: LEVEL_VERSION, seed, props, buffers, layer, batches, blockEdits, rooms, camera, counts, liveDoors, edgeWalls, wallPaint, roofs, kitSwap };
}

/**
 * A flat square ground model of `size` m (`segments`² quads, centred on the
 * origin, facing up): what the landscape's far ground covers on screen until
 * terrain exists.
 */
export function groundPlaneGlb(size: number, segments: number): Buffer {
  const n = segments + 1;
  const pos = new Float32Array(n * n * 3);
  const nrm = new Float32Array(n * n * 3);
  const uv = new Float32Array(n * n * 2);
  for (let j = 0; j < n; j += 1) {
    for (let i = 0; i < n; i += 1) {
      const k = j * n + i;
      pos.set([(i / segments - 0.5) * size, 0, (j / segments - 0.5) * size], k * 3);
      nrm.set([0, 1, 0], k * 3);
      uv.set([(i / segments) * size * 0.25, (j / segments) * size * 0.25], k * 2);
    }
  }
  const idx = new Uint32Array(segments * segments * 6);
  let t = 0;
  for (let j = 0; j < segments; j += 1) {
    for (let i = 0; i < segments; i += 1) {
      const a = j * n + i;
      idx.set([a, a + n, a + 1, a + 1, a + n, a + n + 1], t);
      t += 6;
    }
  }
  const parts = [pos, nrm, uv, idx].map((a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength));
  let offset = 0;
  const views = parts.map((p, i) => {
    const v = { buffer: 0, byteOffset: offset, byteLength: p.length, target: i === 3 ? 34963 : 34962 };
    offset += p.length;
    return v;
  });
  const bin = Buffer.concat(parts);
  const h = size / 2;
  return packGlb(
    {
      asset: { version: '2.0', generator: 'thirdlight perf level ground plane' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ name: 'ground', mesh: 0 }],
      meshes: [{ name: 'ground', primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
      materials: [{ name: 'ground', pbrMetallicRoughness: { baseColorFactor: [0.36, 0.42, 0.26, 1], metallicFactor: 0, roughnessFactor: 0.95 } }],
      accessors: [
        { bufferView: 0, componentType: 5126, count: n * n, type: 'VEC3', min: [-h, 0, -h], max: [h, 0, h] },
        { bufferView: 1, componentType: 5126, count: n * n, type: 'VEC3' },
        { bufferView: 2, componentType: 5126, count: n * n, type: 'VEC2' },
        { bufferView: 3, componentType: 5125, count: idx.length, type: 'SCALAR' },
      ],
      bufferViews: views,
      buffers: [{ byteLength: bin.length }],
    },
    bin,
  );
}

export interface LevelBuild {
  projectId: string;
  kind: LevelKind;
  ms: number;
  commands: number;
  counts: Record<string, number>;
}

/** Build a level class into a new project through the backend's command API. */
export async function buildLevel(be: PerfBackend, projectId: string, plan: LevelPlan, log: (s: string) => void = () => undefined): Promise<LevelBuild> {
  const t0 = performance.now();
  const created = await be.post('/api/v1/admin/projects', { projectId, name: `Perf level ${plan.kind}` });
  if (created.status !== 201 && created.status !== 200) throw new Error(`project create failed: ${created.status} ${JSON.stringify(created.json)}`);
  const p = be.project(projectId);
  let commands = 0;
  const cmd = async (op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    commands += 1;
    return p.command(op, args);
  };
  for (const id of STARTER_REMOVED) await cmd('deleteEntity', { entityId: id }).catch(() => undefined);
  await cmd('setSettings', { settings: { physics_dimension: 3, ...(plan.kind === 'landscape' ? { camera_far_m: LEVEL_SPEC.farPlane } : {}) } });
  for (const f of plan.props) await publishFileVia(be, projectId, cmd, { assetId: f.assetId, kind: 'model', displayName: f.assetId, bytes: propGlb(f.seed, f.spec) });
  await publishFileVia(be, projectId, cmd, { assetId: FOLIAGE_KIT, kind: 'model', displayName: 'Level foliage', bytes: scatterKitGlb(plan.seed, FOLIAGE_PIECES) });
  if (plan.kind === 'landscape') {
    await publishFileVia(be, projectId, cmd, { assetId: FAR_KIT, kind: 'model', displayName: 'Level far scatter', bytes: scatterKitGlb(plan.seed + 1, FAR_PIECES) });
    await publishFileVia(be, projectId, cmd, { assetId: GROUND_PLANE, kind: 'model', displayName: 'Level ground plane', bytes: groundPlaneGlb(LEVEL_SPEC.farRings[LEVEL_SPEC.farRings.length - 1]![1] * 2, 64) });
  }
  // With a kit swap, each type's burnt twin first (a swap names a type that exists), same shape, darker colours.
  const burnt = (blockId: string): Record<string, unknown> => (plan.kitSwap ? { kits: { burnt: { block: `${blockId}-burnt` } } } : {});
  const blockType = async (block: Record<string, unknown>, burntColors: string[]): Promise<void> => {
    if (plan.kitSwap) await cmd('setBlockType', { block: { ...block, blockId: `${String(block['blockId'])}-burnt`, name: `${String(block['name'])} (burnt)`, variants: burntColors.map((color) => ({ color })) } });
    await cmd('setBlockType', { block: { ...block, ...burnt(String(block['blockId'])) } });
  };
  await blockType({ blockId: 'soil', name: 'Soil', variants: [{ color: '#6f8a4a' }, { color: '#7a9050' }], shape: 'full' }, ['#3a3430', '#2e2a26']);
  await blockType({ blockId: 'rock', name: 'Rock', variants: [{ color: '#8a8580' }, { color: '#7d7872' }], shape: 'full' }, ['#4a4440', '#3d3832']);
  if (plan.edgeWalls) {
    await blockType({ blockId: 'rock-wall', name: 'Rock wall', variants: [{ color: '#8a8580' }, { color: '#7d7872' }], shape: 'full', placement: 'edge' }, ['#4a4440', '#3d3832']);
    await blockType({ blockId: 'rock-door', name: 'Rock door', variants: [{ color: '#6b4a2b' }], shape: 'full', placement: 'edge' }, ['#2b1a0b']);
  }

  await cmd('pasteEntities', { sceneId: 'scene-main', entities: [plan.layer] });
  const listed = (await p.query('queryEntities', { limit: 100, offset: 0 }))['entities'] as { id: string; components: Record<string, unknown> }[];
  const layerId = listed.find((e) => e.components['blockLayer'] !== undefined)?.id;
  if (layerId === undefined) throw new Error('level: the block layer was not created');
  for (const edit of plan.blockEdits.filter((e) => e['kind'] === 'surface')) await cmd('editBlocks', { entityId: layerId, edits: [edit] });
  const fills = plan.blockEdits.filter((e) => e['kind'] !== 'surface' && e['kind'] !== 'edges');
  for (let i = 0; i < fills.length; i += 64) await cmd('editBlocks', { entityId: layerId, edits: fills.slice(i, i + 64) });
  // A room's edges per command (each a few kilobytes of edge lists).
  for (const e of plan.blockEdits.filter((x) => x['kind'] === 'edges' && (x['at'] as number[]).length > 0)) await cmd('editBlocks', { entityId: layerId, edits: [e] });
  if (plan.liveDoors.length > 0) {
    // The door prefab, kept in a scene the game never loads; the block type spawns it per cell.
    await cmd('setCellFields', { fields: [{ key: 'open', type: 'bool' }] });
    await publishBehaviorVia(be, p, cmd, DOOR_BEHAVIOR);
    await cmd('createScene', { sceneId: 'scene-kit', name: 'Kit' });
    const root = String((await cmd('createEntity', { sceneId: 'scene-kit', parentId: null, kind: 'group', name: 'Door', transform: { position: [0, 0, 0] } }))['createdId']);
    await cmd('setBehaviorProperties', { entityId: root, behaviorId: DOOR_BEHAVIOR.behaviorId, values: {} });
    await cmd('createEntity', { sceneId: 'scene-kit', parentId: root, kind: 'box', name: 'Leaf', transform: { position: [0, 1, 0] }, box: { size: [0.9, 2, 0.1], material: { color: '#8b5a2b' } }, components: { collider: { shape: { type: 'box', hx: 0.45, hy: 1, hz: 0.05 } } } });
    await cmd('createPrefab', { prefabId: 'level-door', displayName: 'Door', sourceEntityId: root });
    await cmd('setBlockType', { block: { blockId: 'door', name: 'Door', variants: [{ prefab: 'level-door' }], shape: 'none', live: true } });
    const doors = plan.liveDoors.map(([x, y, z]) => ({ kind: 'fill', box: [x, y, z, x + 1, y + 1, z + 1], cell: { block: 'door' } }));
    for (let i = 0; i < doors.length; i += 256) await cmd('editBlocks', { entityId: layerId, edits: doors.slice(i, i + 256) });
  }

  if (plan.kitSwap) {
    await publishBehaviorVia(be, p, cmd, KIT_BEHAVIOR);
    const driver = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Kit driver', transform: { position: [0, 0, 0] } }))['createdId']);
    await cmd('setBehaviorProperties', { entityId: driver, behaviorId: KIT_BEHAVIOR.behaviorId, values: {} });
  }

  if (plan.roofs === 'cutaway') {
    const behavior = CUTAWAY_BEHAVIOR(plan.rooms.length);
    await publishBehaviorVia(be, p, cmd, behavior);
    const driver = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Cut-away driver', transform: { position: [0, 0, 0] } }))['createdId']);
    await cmd('setBehaviorProperties', { entityId: driver, behaviorId: behavior.behaviorId, values: {} });
  }

  const digests = new Map<string, string>();
  for (const b of plan.buffers) digests.set(b.key, await publishBufferVia(be, projectId, b.floats));
  const resolve = (e: EntityValue): EntityValue => {
    const inst = e.components['instances'] as { buffer?: string } | undefined;
    if (inst?.buffer?.startsWith('$buffer:') !== true) return e;
    return { ...e, components: { ...e.components, instances: { ...inst, buffer: digests.get(inst.buffer.slice('$buffer:'.length)) } } };
  };
  for (const batch of plan.batches) for (const part of splitBySize(batch.map(resolve))) await cmd('pasteEntities', { sceneId: 'scene-main', entities: part });
  log(`level ${plan.kind}: ${JSON.stringify(plan.counts)}`);

  await cmd('setTransform', { entityId: 'cam-main', transform: { position: plan.camera.position, rotation: plan.camera.rotation } });
  await cmd('setComponent', { entityId: 'light-0001', component: 'light', value: { type: 'directional', color: '#ffe2bd', intensity: 2, direction: [0.5, -0.55, -0.65], castShadow: true } });
  await cmd('setEnvironment', {
    sceneId: 'scene-main',
    environment: {
      sky: { mode: 'color', color: '#b8c8e0' },
      fog: { color: '#c9d3df', density: 0.0008, mode: 'exp2' },
      post: { antialias: 'smaa', bloom: { enabled: true, radius: 0.4, strength: 0.25, threshold: 1.05 }, exposure: 1, grading: { contrast: 0.09, saturation: 0.05, tint: '#fff6ea' }, ssao: { enabled: true, intensity: 1, radius: 0.5 }, toneMapping: 'neutral' },
    },
  });
  return { projectId, kind: plan.kind, ms: Math.round(performance.now() - t0), commands, counts: plan.counts };
}
