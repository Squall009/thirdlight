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
 *   the outer far ring (3 km): a terrain of 12 × 12 tiles (257 samples 2 m
 *   apart: 6 km square), flat under the area and rising into hills away from
 *   it (an uploaded RAW heightmap), wearing a height-blended layers material
 *   (four layers of noise textures packed into texture arrays) with discs of
 *   the other three layers painted over it; trees, pines and rocks placed on
 *   it by scatter rules (slope, height, noise; the block area kept clear by
 *   a region) and shrubs on the block layer's soil by a rule of its own, and
 *   ground cover (grass, flowers) on both near the camera, under the same
 *   fog, the camera's far plane pushed out.
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
 * Either class can fly its camera (`--flight`; still by default, as recorded):
 * a script flies it round a loop of {@link FLIGHT_RADIUS} m about the area
 * in {@link FLIGHT_SECONDS} s, a few metres over the ground it reads with a
 * ray, and on the way hides the nearest scatter copy every half second
 * (shown again a second later) and removes one every two seconds (its group's
 * set made again, as a re-bake makes it): ground cover, near shadows and set
 * builds all happen while frames are counted.
 *
 * Both classes share the camera (at the area's edge, looking across it to the
 * horizon) and the environment, so the landscape's extra cost is the far part.
 * `levelPlan` is a pure function of the kind and the seed; `buildLevel`
 * applies it through the real command API, like the village.
 */
import { DEFAULT_FIXED_STEP_HZ, FOLIAGE_NEAR_METRES, INSTANCE_DENSITY_MIN_NEW } from '@thirdlight/project-model';

import { layeredMaterial } from '../../packages/editor/src/session/material-graph';
import { makePng } from '../../tests/e2e/png-make';
import { publishBehaviorVia, publishBufferVia, publishFileVia, splitBySize } from './build';
import type { PerfBackend } from './backend';
import { prng, type BehaviorPlan, type EntityValue } from './generate';
import { coverKitGlb, propGlb, scatterKitGlb, type PropSpec } from './village-assets';

/** Bump when the generated content changes. */
export const LEVEL_VERSION = 3;
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
  /** The camera's far plane in the landscape (m). */
  farPlane: 4000,
  /** The landscape's terrain: tiles per side (centred on the area), samples per tile side, metres between samples, its height range (m). */
  terrain: { tiles: 12, tileSamples: 257, spacing: 2, heightRange: [-64, 192] as [number, number] },
  /** The terrain is flat at `terrainBase` within the first radius of the area's centre and fully hilly past the second (m). */
  terrainFlat: [72, 400] as const,
  /** Layer textures' side (texels). */
  terrainTexture: 256,
} as const;

const PROP_FILE = (i: number): string => `level-prop-${String(i + 1).padStart(2, '0')}`;
const FOLIAGE_KIT = 'level-foliage';
const FOLIAGE_PIECES = ['tuft', 'fern', 'flower', 'shrub'] as const;
const FAR_KIT = 'level-far';
const COVER_KIT = 'level-cover';
const COVER_PIECES = ['grass', 'flower'] as const;
const FAR_PIECES = ['tree', 'pine', 'boulder'] as const;
/** The block layer's region the terrain's scatter keeps clear (the whole area). */
const SCATTER_CLEAR = 'scatter-clear';

/** The foliage policy the landscape's scatter follows (`--foliage off`: every copy casts, sways and stays, no blobs). */
export type LevelFoliage = 'on' | 'off';


/**
 * The landscape's terrain scatter: trees in clumps (noise) on gentle ground,
 * pines up high, rocks on the steep parts, none on the block area; the far
 * kit's pieces (0.2–0.8 m) scaled to tree and boulder size; about as many
 * copies as the far rings they replace (32,000). Ground cover (grass, a few
 * flowers) near the camera. Under the foliage policy (the engine's default
 * for scatter) the big copies cast only within FOLIAGE_NEAR_METRES, a blob
 * under each near one, and thin out with distance; off, every copy casts
 * into the static map and none thins out.
 */
export function levelScatterTerrain(foliage: LevelFoliage = 'on', impostorSize = 0): Record<string, unknown>[] {
  const big = { ...(foliage === 'on' ? { castShadow: true, shadowDistance: FOLIAGE_NEAR_METRES, blobShadow: 0.6, densityMin: INSTANCE_DENSITY_MIN_NEW } : { castShadow: true }), ...(impostorSize > 0 ? { impostorSize } : {}) };
  return [
    { id: 'trees', asset: { assetId: FAR_KIT, piece: 'tree' }, density: 0.0012, spacing: 10, scale: [8, 16], slope: { max: 22, fade: 6 }, noise: { scale: 300, seed: 3, min: 0.35, fade: 0.15 }, exclude: [SCATTER_CLEAR], ...big },
    { id: 'pines', asset: { assetId: FAR_KIT, piece: 'pine' }, density: 0.0008, spacing: 10, scale: [8, 16], height: { min: 40, fade: 20 }, slope: { max: 30, fade: 5 }, exclude: [SCATTER_CLEAR], ...big },
    { id: 'rocks', asset: { assetId: FAR_KIT, piece: 'boulder' }, density: 0.0005, spacing: 6, scale: [6, 12], align: 0.5, slope: { min: 15, fade: 5 }, exclude: [SCATTER_CLEAR], ...big },
    // Ground cover near the camera (never stored): grass tufts and a few flowers on gentle ground.
    { id: 'grass', asset: { assetId: COVER_KIT, piece: 'grass' }, density: 2, scale: [1, 2], align: 0.7, slope: { max: 30, fade: 5 }, exclude: [SCATTER_CLEAR], cover: true, coverDistance: 40, ...(foliage === 'off' ? { densityMin: 1 } : {}) },
    { id: 'flowers', asset: { assetId: COVER_KIT, piece: 'flower' }, density: 0.3, scale: [1, 2], slope: { max: 20, fade: 5 }, noise: { scale: 20, seed: 9, min: 0.5, fade: 0.1 }, exclude: [SCATTER_CLEAR], cover: true, coverDistance: 30, ...(foliage === 'off' ? { densityMin: 1 } : {}) },
  ];
}

/** The landscape's block-layer scatter: shrubs on the soil tops (not the rock walls), a few metres apart, and grass. */
export function levelScatterBlocks(foliage: LevelFoliage = 'on'): Record<string, unknown>[] {
  return [
    { id: 'shrubs', asset: { assetId: FOLIAGE_KIT, piece: 'shrub' }, density: 0.05, spacing: 2.5, scale: [2, 4], blocks: ['soil'], slope: { max: 35, fade: 5 }, ...(foliage === 'on' ? { blobShadow: 0.4, densityMin: INSTANCE_DENSITY_MIN_NEW } : { castShadow: true }) },
    // Ground cover on the soil (never stored).
    { id: 'grass', asset: { assetId: COVER_KIT, piece: 'grass' }, density: 2, scale: [1, 2], align: 0.7, blocks: ['soil'], slope: { max: 35, fade: 5 }, cover: true, coverDistance: 40, ...(foliage === 'off' ? { densityMin: 1 } : {}) },
  ];
}

/** The scatter kits wear a foliage material: the wind sways them near the camera only under the policy (everywhere off). */
const FOLIAGE_MATERIAL = 'mat-level-foliage';
const TERRAIN_MATERIAL = 'mat-level-terrain';

/** The starter's objects the classes do without (player, spawn, boxes, pillar). */
const STARTER_REMOVED = ['model-0001', 'spawn-0001', 'box-0001', 'box-0002', 'box-0003', 'box-0004', 'model-0002'];
const PASTE_MAX = 256;
/** The terrain's height under the area (m): under the area's lowest ground (levelHeightAt's minimum, 4 rows = 2 m), so it never shows through it. */
const TERRAIN_BASE = 1.5;
/** Columns per `surface` edit (a command is at most 64 KiB). */
const SURFACE_PER_EDIT = 1500;

const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const r6 = (v: number): number => Math.round(v * 1e6) / 1e6;
const yawQ = (rad: number): [number, number, number, number] => [0, r6(Math.sin(rad / 2)), 0, r6(Math.cos(rad / 2))];
const T = (x: number, y: number, z: number, yaw = 0, s = 1): Record<string, unknown> => ({ position: [r3(x), r3(y), r3(z)], rotation: yawQ(yaw), scale: [r3(s), r3(s), r3(s)] });

/** Ground height (rows) at a layer corner: gentle hills, quantised to 1/16 row as a brush leaves it. */
export const levelHeightAt = (x: number, z: number): number => Math.round((8 + 3 * Math.sin(x / 13) * Math.cos(z / 17) + Math.sin(x / 5.3 + z / 6.1)) * 16) / 16;

/**
 * The landscape terrain's height (world m) at world (x, z): `TERRAIN_BASE` under the area, rising smoothly
 * past `terrainFlat[0]` into hills of a few tens of metres (fully past `terrainFlat[1]`).
 */
export function levelTerrainHeight(x: number, z: number): number {
  const [r0, r1] = LEVEL_SPEC.terrainFlat;
  const t = Math.min(1, Math.max(0, (Math.hypot(x, z) - r0) / (r1 - r0)));
  const s = t * t * (3 - 2 * t);
  const hills = 55 * (0.5 + 0.5 * Math.sin(x / 410 + 1.3) * Math.cos(z / 530)) + 22 * Math.sin(x / 170) * Math.sin(z / 230) + 5 * Math.sin(x / 37 + z / 53) + 1.5 * Math.sin(x / 7.3) * Math.cos(z / 9.1);
  return TERRAIN_BASE + s * hills;
}

/** The terrain object's position: its tile [0, 0]'s min corner, so the tiles lie centred on the area. */
export const levelTerrainOrigin = (): [number, number, number] => {
  const T = LEVEL_SPEC.terrain;
  const half = (T.tiles * (T.tileSamples - 1) * T.spacing) / 2;
  return [-half, 0, -half];
};

/** The terrain's heights as a RAW heightmap (16-bit little-endian steps of its range, one per sample, rows +z). */
export function levelTerrainRaw(): Uint8Array {
  const T = LEVEL_SPEC.terrain;
  const side = T.tiles * (T.tileSamples - 1) + 1;
  const [ox, , oz] = levelTerrainOrigin();
  const [lo, hi] = T.heightRange;
  const out = new Uint8Array(side * side * 2);
  const dv = new DataView(out.buffer);
  for (let j = 0; j < side; j += 1) {
    for (let i = 0; i < side; i += 1) {
      const h = levelTerrainHeight(ox + i * T.spacing, oz + j * T.spacing);
      dv.setUint16((j * side + i) * 2, Math.max(0, Math.min(65535, Math.round(((h - lo) / (hi - lo)) * 65535))), true);
    }
  }
  return out;
}

/** The painted discs over the terrain: layer, centre (world x, z) and radius (m); layer 0 elsewhere. */
export function levelTerrainPaint(seed: number): { layer: number; at: [number, number]; radius: number }[] {
  const rnd = prng(seed * 7151 + 3);
  const out: { layer: number; at: [number, number]; radius: number }[] = [];
  for (let i = 0; i < 24; i += 1) {
    const a = rnd() * Math.PI * 2;
    const r = 90 + rnd() * 2400;
    out.push({ layer: 1 + (i % 3), at: [r3(Math.cos(a) * r), r3(Math.sin(a) * r)], radius: r3(40 + rnd() * 220) });
  }
  return out;
}

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
  /** Material rules on the block layer and the terrain (baked), and per-layer settings for every terrain layer. */
  rules: boolean;
  /** Every terrain layer's projection (0 top, 1 by slope, 2 biplanar). */
  projection: number;
  /** The terrain's macro distance (m; 0: none, the layers everywhere). */
  macro: number;
  /** The foliage policy the landscape's scatter follows. */
  foliage: LevelFoliage;
  /** The camera flies a loop (`FLIGHT_BEHAVIOR`) instead of standing still. */
  flight: boolean;
  /** The terrain's trees, pines and rocks draw as impostors below this screen size (0: their meshes all the way). */
  impostorSize: number;
}

/**
 * The material rules `--rules` gives the landscape's terrain (baked into its tiles) and the block layer (layers
 * 0-3): rock on steep ground, a second layer in hollows, a noise patch where little rock is, a fourth up high.
 */
export const LEVEL_RULES = [
  { layer: 2, slope: { min: 30, fade: 8 } },
  { layer: 1, cavity: { min: 0.3, fade: 0.3, radius: 3 }, face: 'top' },
  { layer: 3, noise: { scale: 24, seed: 5, min: 0.65, fade: 0.1 }, weight: { layer: 2, max: 0.3 } },
  { layer: 3, height: { min: 40, fade: 10 }, strength: 0.6 },
];

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

/** The flight's loop: its radius about the area's middle (m), a lap's time (s), the camera's height over the ground (m) and its look down (radians). */
export const FLIGHT_RADIUS = 400;
export const FLIGHT_SECONDS = 60;
const FLIGHT_HEIGHT = 6;
const FLIGHT_PITCH = 0.12;

/** The flight's script, on the camera: its transform each step, scatter copies hidden, shown and removed on the way. */
const FLIGHT_BEHAVIOR: BehaviorPlan = {
  behaviorId: 'level-flight',
  displayName: 'Level flight',
  ownedTransforms: ['@self'],
  declaration: { properties: [] },
  source: [
    'export default {',
    '  instantiate() { return { y: null, hidden: [] }; },',
    '  step(state: any, ctx: any) {',
    `    const lap = ${FLIGHT_SECONDS * DEFAULT_FIXED_STEP_HZ};`,
    '    const t = ((ctx.stepIndex % lap) / lap) * Math.PI * 2;',
    `    const x = Math.cos(t) * ${FLIGHT_RADIUS};`,
    `    const z = Math.sin(t) * ${FLIGHT_RADIUS};`,
    "    if (ctx.phase === 'intent') {",
    '      if (ctx.scatter === undefined) return;',
    '      // The nearest copy hidden every half second, shown again a second later; one removed every two seconds.',
    '      if (ctx.stepIndex % 60 === 0) {',
    '        const near = ctx.scatter.near([x, 0, z], 80, { limit: 1 })[0];',
    '        if (near !== undefined && ctx.scatter.hide(near.address)) state.hidden.push([near.address, ctx.stepIndex]);',
    '      }',
    '      while (state.hidden.length > 0 && ctx.stepIndex - state.hidden[0][1] >= 120) ctx.scatter.show(state.hidden.shift()[0]);',
    '      if (ctx.stepIndex % 240 === 120) {',
    '        const near = ctx.scatter.near([x, 0, z], 80, { limit: 1 })[0];',
    '        if (near !== undefined) ctx.scatter.remove(near.address);',
    '      }',
    '      return;',
    '    }',
    "    if (ctx.phase !== 'transform') return;",
    '    const hit = ctx.physics.raycast3d([x, 1000, z], [0, -1, 0], 2000);',
    '    const ground = hit === null ? 0 : hit.point[1];',
    '    state.y = state.y === null ? ground : state.y + (ground - state.y) * 0.05;',
    '    // Along the loop (three cameras look down -z), pitched down a little.',
    '    const yaw = Math.PI - t;',
    `    const a = Math.sin(yaw / 2), b = Math.cos(yaw / 2), c = Math.sin(-${FLIGHT_PITCH} / 2), d = Math.cos(-${FLIGHT_PITCH} / 2);`,
    `    ctx.emit({ kind: 'transform', entityId: ctx.entityId, position: { x, y: Math.max(state.y, ground) + ${FLIGHT_HEIGHT}, z }, quaternion: [b * c, a * d, -a * c, b * d] });`,
    '  },',
    '};',
  ].join('\n'),
};

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

export function levelPlan(kind: LevelKind, seed = LEVEL_SEED, liveDoorCount = 0, edgeWalls = false, wallPaint = false, roofs: LevelRoofs = 'none', kitSwap = false, vertexAO = 0, rules = false, projection = 0, macro = 0, foliage: LevelFoliage = 'on', flight = false, impostorSize = 0): LevelPlan {
  const S = LEVEL_SPEC;
  const N = S.areaSide;
  const rnd = prng(seed * 104729 + N);
  const half = N / 2;
  const counts: Record<string, number> = { props: 0, propColliders: 0, foliageSets: 0, foliageCopies: 0, rooms: 0, pointLights: 0, terrainTiles: 0 };
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
    // The terrain (its tiles' heights and paint come by `editTerrain` once it exists).
    const TS = S.terrain;
    const tiles: { x: number; z: number }[] = [];
    for (let z = 0; z < TS.tiles; z += 1) for (let x = 0; x < TS.tiles; x += 1) tiles.push({ x, z });
    const [tx, ty, tz] = levelTerrainOrigin();
    entities.push({ id: 'terrain', name: 'Terrain', static: true, components: { transform: T(tx, ty, tz), terrain: { tileSamples: TS.tileSamples, spacing: TS.spacing, heightRange: [...TS.heightRange], tiles, ...(macro > 0 ? { macroDistance: macro } : {}) }, materials: { '*': TERRAIN_MATERIAL } } });
    counts.terrainTiles = tiles.length;
  }

  // The landscape's terrain scatter keeps off the whole block area (a region of the layer's every column).
  if (kind === 'landscape') blockEdits.push({ kind: 'region', regionId: SCATTER_CLEAR, op: 'set', boxes: [[0, 0, 0, N, 32, N]] });

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
  const layer: EntityValue = { id: 'ground', name: 'Ground', components: { transform: T(-half, 0, -half), blockLayer: { cellSize: [1, S.cellHeight, 1], bounds: { min: [0, 0, 0], max: [N, 32, N] }, maxSlope: 60, smoothAngle: 40, topSubdivision: 2, ...(wallPaint ? { wallPaint: true } : {}), ...(vertexAO > 0 ? { vertexAO } : {}), ...(rules ? { rules: LEVEL_RULES } : {}), ...(kind === 'landscape' ? { scatter: levelScatterBlocks(foliage) } : {}), ...(roofs === 'cutaway' ? { cutaway: { regions: rooms.map((_, i) => ({ region: `roof-${i}` })) } } : {}) } } };
  // At the area's south edge, 8 m over its ground, looking north across it to the horizon.
  const pitch = -0.12;
  const camera: LevelPlan['camera'] = { position: [0, r3(groundY(half, N - 2) + 8), half - 2], rotation: [r6(Math.sin(pitch / 2)), 0, 0, r6(Math.cos(pitch / 2))] };
  return { kind, version: LEVEL_VERSION, seed, props, buffers, layer, batches, blockEdits, rooms, camera, counts, liveDoors, edgeWalls, wallPaint, roofs, kitSwap, rules, projection, macro, foliage, flight, impostorSize };
}

/**
 * The terrain material's sources: per layer an albedo noise PNG in its own
 * tint with a noise height in alpha, one normal map of gentle noise and one
 * ORM (occlusion 1, rough, not metal) — plain textures the pack route turns
 * into the three texture arrays the layered template reads.
 */
export function levelTerrainTextures(seed: number, size: number): { assetId: string; png: Buffer }[] {
  const tints = [
    [0.42, 0.55, 0.26],
    [0.5, 0.4, 0.28],
    [0.55, 0.54, 0.52],
    [0.78, 0.72, 0.52],
  ];
  const out: { assetId: string; png: Buffer }[] = [];
  tints.forEach((tint, i) => {
    const rnd = prng(seed * 31 + i);
    out.push({ assetId: `level-terrain-albedo-${i + 1}`, png: makePng(size, size, () => {
      const n = 0.7 + 0.3 * rnd();
      return [Math.floor(255 * tint[0]! * n), Math.floor(255 * tint[1]! * n), Math.floor(255 * tint[2]! * n), Math.floor(255 * rnd())];
    }) });
  });
  const rn = prng(seed * 31 + 9);
  out.push({ assetId: 'level-terrain-normal', png: makePng(size, size, () => [Math.floor(128 + 40 * (rn() - 0.5)), Math.floor(128 + 40 * (rn() - 0.5)), 250, 255]) });
  out.push({ assetId: 'level-terrain-orm', png: makePng(size, size, () => [255, 230, 0, 255]) });
  return out;
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
    await publishFileVia(be, projectId, cmd, { assetId: COVER_KIT, kind: 'model', displayName: 'Level ground cover', bytes: coverKitGlb(plan.seed + 2, COVER_PIECES) });
    // The kits' foliage material: its wind distance is the policy's (0 off: the wind's work in every vertex).
    await cmd('setMaterial', { material: { materialId: FOLIAGE_MATERIAL, name: 'Level foliage', shader: 'foliage', params: { color: '#5a8a3a', roughness: 0.9, windDistance: plan.foliage === 'on' ? FOLIAGE_NEAR_METRES : 0 }, textures: {} } });
    for (const [assetId, name] of [[FAR_KIT, 'scatter'], [COVER_KIT, 'cover']] as const) await cmd('setAssetOptions', { assetId, materials: { [name]: FOLIAGE_MATERIAL } });
    // The terrain's layered material: four layers of albedo (height in alpha), normal and ORM arrays packed from plain textures.
    const sources = levelTerrainTextures(plan.seed, LEVEL_SPEC.terrainTexture);
    for (const t of sources) await publishFileVia(be, projectId, cmd, { assetId: t.assetId, kind: 'texture', displayName: t.assetId, bytes: t.png });
    const pack = async (assetId: string, encoding: 'color' | 'normal' | 'data', layers: { assetId: string; channel: 'r' | 'g' | 'b' | 'a' }[][]): Promise<void> => {
      const packed = await be.post(`/api/v1/projects/${projectId}/content/textures/pack`, { layers, encoding, displayName: assetId });
      const proposal = packed.json['proposal'] as Record<string, unknown> | undefined;
      if (packed.json['ok'] !== true || proposal?.['status'] !== 'ok') throw new Error(`pack ${assetId}: ${JSON.stringify(packed.json).slice(0, 400)}`);
      await cmd('publishAsset', { mode: 'create', assetId, kind: 'texture', displayName: assetId, sourceDigest: proposal['sourceDigest'], sourceByteLength: proposal['sourceByteLength'], packedFrom: packed.json['packedFrom'], importRecipe: proposal['importRecipe'], metrics: proposal['metrics'], importedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') });
    };
    const rgba = (id: string): { assetId: string; channel: 'r' | 'g' | 'b' | 'a' }[] => (['r', 'g', 'b', 'a'] as const).map((channel) => ({ assetId: id, channel }));
    await pack('level-terrain-albedo', 'color', [1, 2, 3, 4].map((i) => rgba(`level-terrain-albedo-${i}`)));
    await pack('level-terrain-normals', 'normal', [1, 2, 3, 4].map(() => rgba('level-terrain-normal')));
    await pack('level-terrain-orms', 'data', [1, 2, 3, 4].map(() => rgba('level-terrain-orm')));
    const mat = layeredMaterial(TERRAIN_MATERIAL, 'Level terrain');
    const arrays: Record<string, string> = { albedoHeight: 'level-terrain-albedo', normals: 'level-terrain-normals', orm: 'level-terrain-orms' };
    // With rules, every per-layer setting holds values of its own for four more layers (the per-pixel lookup is drawn).
    const extra = (p: { type: string; default: unknown }): Record<string, unknown> => (plan.rules && p.type === 'vec4' && Array.isArray(p.default) ? { extraLayers: [...(p.default as number[])] } : {});
    // `--projection`: every layer read by slope or biplanar.
    const projected = (p: { key: string; default: unknown }): Record<string, unknown> => (p.key === 'layerProjection' && plan.projection > 0 ? { default: [plan.projection, plan.projection, plan.projection, plan.projection] } : {});
    await cmd('setMaterial', { material: { ...mat, parameters: (mat.parameters ?? []).map((p) => (arrays[p.key] !== undefined ? { ...p, default: arrays[p.key] } : { ...p, ...extra(p), ...projected(p) })) } });
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
  if (plan.kind === 'landscape') {
    // The terrain's heights (an uploaded RAW heightmap) and its painted discs.
    const listedNow = (await p.query('queryEntities', { limit: 2000, offset: 0 }))['entities'] as { id: string; components: Record<string, unknown> }[];
    const terrainId = listedNow.find((e) => e.components['terrain'] !== undefined)?.id;
    if (terrainId === undefined) throw new Error('level: the terrain was not created');
    const stageId = await be.stage(projectId, levelTerrainRaw());
    await cmd('editTerrain', { entityId: terrainId, kind: 'import', stageId, format: 'raw16', at: [0, 0] });
    await be.discardStage(projectId, stageId);
    for (const d of levelTerrainPaint(plan.seed)) await cmd('editTerrain', { entityId: terrainId, kind: 'paint', dabs: [d.at], radius: d.radius, strength: 1, falloff: 'smooth', layer: d.layer });
    if (plan.rules) {
      const t = performance.now();
      await cmd('editTerrain', { entityId: terrainId, kind: 'bake', rules: LEVEL_RULES });
      log(`level ${plan.kind}: rules baked into ${plan.counts['terrainTiles']} tiles in ${Math.round(performance.now() - t)} ms (the command's round trip)`);
    }
    // The scatter rules, baked into every tile (the block area's region is set by now).
    const ts = performance.now();
    const baked = (await cmd('editTerrain', { entityId: terrainId, kind: 'bake', scatter: levelScatterTerrain(plan.foliage, plan.impostorSize) }))['terrain'] as { scatter?: unknown[] } | undefined;
    log(`level ${plan.kind}: scatter baked into ${baked?.scatter?.length ?? 0} tiles in ${Math.round(performance.now() - ts)} ms (the command's round trip)`);
  }
  log(`level ${plan.kind}: ${JSON.stringify(plan.counts)}`);

  await cmd('setTransform', { entityId: 'cam-main', transform: { position: plan.camera.position, rotation: plan.camera.rotation } });
  if (plan.flight) {
    await publishBehaviorVia(be, p, cmd, FLIGHT_BEHAVIOR);
    await cmd('setBehaviorProperties', { entityId: 'cam-main', behaviorId: FLIGHT_BEHAVIOR.behaviorId, values: {} });
  }
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
