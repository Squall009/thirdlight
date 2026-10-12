/**
 * Generated buildings on the outdoor level classes' area, for measuring what
 * a wall material costs (`node tools/perf/run.mjs level --classes area
 * --layered-walls N [--wall-layers 1|2|4]`). At 0 (the default) the class is
 * the scene it was: nothing is placed, published or counted.
 *
 * The buildings are one generated-architecture object (the engine's starter
 * room preset inside and out, one or two storeys, a door and windows, a hip
 * or gable roof) standing on the area's free ground: clear of its rooms, of
 * each other, of the area's edge and of the ground just ahead of the camera
 * (a wall there would hide the rest). The props stay where the class put
 * them, so a few stand inside a building; the class's own content never moves
 * with the count. Each building stands at the lowest ground under its
 * footprint, so no wall floats.
 *
 * The walls wear one material, from `WALL_LAYER_SETS`: the layers a variant
 * blends, each a trim sheet (rows mapped by the generator's UVs) or a tiling
 * texture (moss, rust: tiled in metres), plus wetness. One layer is today's
 * trim shader on a 1024² sheet in the starter row layout (albedo with height
 * in alpha, normal, ORM): the baseline. The 2- and 4-layer variants are the
 * layered surface material's; until that material exists they are refused at
 * build time (`layeredWallsNotBuilt`) rather than measured as something else.
 *
 * Pure: the placements and textures are a function of the seed and the
 * options, from a generator of their own.
 */
import { defaultTrimSheet, type TrimSheet } from '@thirdlight/project-model';

import { makePng } from '../../tests/e2e/png-make';
import { prng, type EntityValue } from './generate';

/** The layer counts a variant can have. */
export const WALL_LAYER_COUNTS = [1, 2, 4] as const;
export type WallLayerCount = (typeof WALL_LAYER_COUNTS)[number];

export interface LayeredWallsOptions {
  /** Buildings placed (0: none, the class as recorded). */
  buildings: number;
  layers: WallLayerCount;
}

export const NO_LAYERED_WALLS: Readonly<LayeredWallsOptions> = Object.freeze({ buildings: 0, layers: 1 });

/** One layer of the wall material: a trim sheet, or a texture tiled every `tiling` metres. */
export type WallLayer = { kind: 'trim'; id: string; tint: readonly [number, number, number] } | { kind: 'tiling'; id: string; tint: readonly [number, number, number]; tiling: number };

/** What each variant blends: a base trim sheet, a second sheet, then moss and rust; wetness on top of four. */
export const WALL_LAYER_SETS: Readonly<Record<WallLayerCount, { layers: readonly WallLayer[]; wetness: boolean }>> = {
  1: { layers: [{ kind: 'trim', id: 'trim-a', tint: [0.72, 0.66, 0.58] }], wetness: false },
  2: {
    layers: [
      { kind: 'trim', id: 'trim-a', tint: [0.72, 0.66, 0.58] },
      { kind: 'trim', id: 'trim-b', tint: [0.55, 0.42, 0.34] },
    ],
    wetness: false,
  },
  4: {
    layers: [
      { kind: 'trim', id: 'trim-a', tint: [0.72, 0.66, 0.58] },
      { kind: 'trim', id: 'trim-b', tint: [0.55, 0.42, 0.34] },
      { kind: 'tiling', id: 'moss', tint: [0.3, 0.42, 0.18], tiling: 2 },
      { kind: 'tiling', id: 'rust', tint: [0.5, 0.26, 0.12], tiling: 1.5 },
    ],
    wetness: true,
  },
};

/** Texels of a tiling layer's side (a trim layer is its sheet's size). */
export const WALL_TILING_TEXTURE = 512;
/** The wall material, the object wearing it and its starter preset (inside and out). */
export const WALL_MATERIAL = 'mat-level-walls';
export const WALL_PRESET = 'starter-room';
/** Footprint sides (m): from the first up to the first plus the second; storeys 1 or 2. */
const FOOTPRINT_W: readonly [number, number] = [6, 5];
const FOOTPRINT_D: readonly [number, number] = [5, 4];
/** Metres kept between buildings, from rooms and from the area's edge. */
const CLEARANCE = 2;
/** The ground kept clear ahead of the camera (area columns from the middle across, and from the south edge). */
const CAMERA_CLEAR: readonly [number, number] = [10, 16];
/** Tries per building before the area is called full. */
const TRIES = 400;

/** The switches from the command line's flags (`get` returns a flag's value). */
export function parseLayeredWalls(get: (flag: string) => string | undefined): LayeredWallsOptions {
  const out: LayeredWallsOptions = { ...NO_LAYERED_WALLS };
  const n = get('layered-walls');
  if (n !== undefined) {
    const v = Number(n);
    if (n.trim() === '' || !Number.isInteger(v) || v < 0) throw new Error(`--layered-walls: a whole number of buildings (0 or more), not ${n}`);
    out.buildings = v;
  }
  const l = get('wall-layers');
  if (l !== undefined) {
    const v = Number(l);
    if (!(WALL_LAYER_COUNTS as readonly number[]).includes(v)) throw new Error(`--wall-layers: ${WALL_LAYER_COUNTS.join(', ')}, not ${l}`);
    if (out.buildings === 0) throw new Error('--wall-layers: the layers of the --layered-walls buildings, so it needs --layered-walls');
    out.layers = v as WallLayerCount;
  }
  return out;
}

/** One building: its footprint (area columns, x0 z0 x1 z1), storeys, roof and the ground it stands on (m). */
export interface WallBuilding {
  box: [number, number, number, number];
  storeys: 1 | 2;
  roof: 'hip' | 'gable';
  ground: number;
}

export interface LayeredWalls {
  options: LayeredWallsOptions;
  buildings: WallBuilding[];
}

/** What the buildings stand on: the area's side (columns), its origin (min corner, world), its ground and its rooms. */
export interface WallReceivers {
  seed: number;
  side: number;
  origin: [number, number, number];
  /** Ground height (world m) at area column coordinates. */
  groundY: (x: number, z: number) => number;
  rooms: readonly { box: readonly [number, number, number, number] }[];
}

const overlaps = (a: readonly number[], b: readonly number[], m: number): boolean => a[0]! < b[2]! + m && b[0]! < a[2]! + m && a[1]! < b[3]! + m && b[1]! < a[3]! + m;

/** The buildings of `o` on the area (none at 0); throws when the area has no room for them all. */
export function layeredWalls(r: WallReceivers, o: LayeredWallsOptions): LayeredWalls {
  const rnd = prng(r.seed * 6007 + 11);
  const buildings: WallBuilding[] = [];
  const half = r.side / 2;
  const camera = [half - CAMERA_CLEAR[0], r.side - CAMERA_CLEAR[1], half + CAMERA_CLEAR[0], r.side];
  for (let i = 0; i < o.buildings; i += 1) {
    let placed = false;
    for (let t = 0; t < TRIES && !placed; t += 1) {
      const w = FOOTPRINT_W[0] + Math.floor(rnd() * (FOOTPRINT_W[1] + 1));
      const d = FOOTPRINT_D[0] + Math.floor(rnd() * (FOOTPRINT_D[1] + 1));
      const x0 = CLEARANCE + Math.floor(rnd() * (r.side - w - 2 * CLEARANCE));
      const z0 = CLEARANCE + Math.floor(rnd() * (r.side - d - 2 * CLEARANCE));
      const box: [number, number, number, number] = [x0, z0, x0 + w, z0 + d];
      if (overlaps(box, camera, 0) || r.rooms.some((room) => overlaps(box, room.box, CLEARANCE)) || buildings.some((b) => overlaps(box, b.box, CLEARANCE))) continue;
      let ground = Infinity;
      for (let x = box[0]; x <= box[2]; x += 1) for (let z = box[1]; z <= box[3]; z += 1) ground = Math.min(ground, r.groundY(x, z));
      buildings.push({ box, storeys: rnd() < 0.5 ? 1 : 2, roof: rnd() < 0.5 ? 'hip' : 'gable', ground: Math.round(ground * 1000) / 1000 });
      placed = true;
    }
    if (!placed) throw new Error(`--layered-walls: the area's free ground holds ${buildings.length} buildings, not ${o.buildings}`);
  }
  return { options: { ...o }, buildings };
}

/**
 * The object carrying every building (absent at 0), at the area's origin: each footprint is a closed outline
 * (clockwise seen from above, the inside to the right of travel) at its ground, a door in its first
 * wall and a window in every other wall of each storey.
 */
export function wallEntities(w: LayeredWalls, origin: readonly [number, number, number]): EntityValue[] {
  if (w.buildings.length === 0) return [];
  const buildings = w.buildings.map((b, i) => {
    const [x0, z0, x1, z1] = b.box;
    const y = b.ground - origin[1];
    const width = x1 - x0;
    const depth = z1 - z0;
    const points: [number, number, number][] = [[x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1]];
    // Metres along the outline to each wall's middle: north (the door's), east, south, west.
    const middles = [width / 2, width + depth / 2, width + depth + width / 2, 2 * width + depth + depth / 2];
    const openings: Record<string, unknown>[] = [{ id: 'door', at: middles[0], width: 1.2, bottom: 0, top: 2.2 }];
    for (let s = 0; s < b.storeys; s += 1) {
      for (let k = s === 0 ? 1 : 0; k < 4; k += 1) openings.push({ id: `window-${s}-${k}`, at: middles[k], width: 1, bottom: 0.9, top: 2, storey: s, pane: true });
    }
    return { id: `house-${i}`, preset: WALL_PRESET, outside: WALL_PRESET, storeys: b.storeys, roof: { shape: b.roof }, openings, path: { points, closed: true } };
  });
  return [
    {
      id: 'level-walls',
      name: 'Village walls',
      static: true,
      components: {
        transform: { position: [...origin], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        architecture: { elements: [], buildings },
        materials: { '*': WALL_MATERIAL },
      },
    },
  ];
}

/** Why a variant can't be built yet (null: it can): the engine part it waits for. */
export function layeredWallsNotBuilt(o: LayeredWallsOptions): string | null {
  if (o.buildings === 0 || o.layers === 1) return null;
  return `--wall-layers ${o.layers}: walls blending ${o.layers} layers need the layered surface material, which the engine does not have yet (today's trim shader draws one layer)`;
}

/** The counts a run logs and reports (absent at 0). */
export function wallCounts(w: LayeredWalls): Record<string, number> {
  if (w.buildings.length === 0) return {};
  return { wallBuildings: w.buildings.length, wallStoreys: w.buildings.reduce((n, b) => n + b.storeys, 0), wallLayers: w.options.layers };
}

/** The sheet a trim layer is laid out on: the engine's default (1024², the starter rows). */
export const wallTrimSheet = (): TrimSheet => defaultTrimSheet();

/**
 * A layer's three textures: albedo with height in alpha, a normal map from that height, and ORM (occlusion from
 * the height, rough, not metal). A trim layer draws a different pattern in each of its sheet's rows (courses,
 * planks, panels); a tiling layer is a noise of its tint. Deterministic from the seed and the layer.
 */
export function wallLayerTextures(layer: WallLayer, seed: number): { albedo: Buffer; normal: Buffer; orm: Buffer; size: number } {
  const sheet = wallTrimSheet();
  const size = layer.kind === 'trim' ? sheet.size[0] : WALL_TILING_TEXTURE;
  const salt = [...layer.id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, seed);
  const rnd = prng(salt);
  const grain = new Float32Array(64 * 64).map(() => rnd());
  const noise = (x: number, y: number): number => grain[((y >> 2) & 63) * 64 + ((x >> 2) & 63)]!;
  const rowOf = (y: number): number => (layer.kind === 'trim' ? Math.min(sheet.rows.length - 1, Math.floor((y / size) * sheet.rows.length)) : 0);
  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y += 1) {
    const row = rowOf(y);
    for (let x = 0; x < size; x += 1) {
      let h = 0.5 + 0.3 * (noise(x, y) - 0.5);
      if (layer.kind === 'trim') {
        // Courses of blocks, planks or panels by row: a mortar line where the pattern's cell ends.
        const cell = 32 << row % 3;
        const course = Math.floor(y / 32);
        const u = (x + (course % 2) * (cell >> 1)) % cell;
        if (u < 3 || y % 32 < 3) h *= 0.3;
      }
      height[y * size + x] = Math.max(0, Math.min(1, h));
    }
  }
  const at = (x: number, y: number): number => height[((y + size) % size) * size + ((x + size) % size)]!;
  const [tr, tg, tb] = layer.tint;
  const albedo = makePng(size, size, (x, y) => {
    const h = at(x, y);
    const k = 0.6 + 0.5 * h + 0.1 * (rowOf(y) % 2);
    return [Math.min(255, Math.floor(255 * tr * k)), Math.min(255, Math.floor(255 * tg * k)), Math.min(255, Math.floor(255 * tb * k)), Math.floor(255 * h)];
  });
  const normal = makePng(size, size, (x, y) => {
    const dx = (at(x + 1, y) - at(x - 1, y)) * 2;
    const dy = (at(x, y + 1) - at(x, y - 1)) * 2;
    const l = Math.hypot(dx, dy, 1);
    return [Math.round(127.5 * (1 - dx / l)), Math.round(127.5 * (1 - dy / l)), Math.round(127.5 * (1 + 1 / l)), 255];
  });
  const orm = makePng(size, size, (x, y) => [Math.floor(255 * (0.55 + 0.45 * at(x, y))), 215, 0, 255]);
  return { albedo, normal, orm, size };
}
