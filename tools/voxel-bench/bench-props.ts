/**
 * The lit props scene (`--props N` in light-shots and headroom): objects marked `affectsLighting` in the town of
 * staging's 8 km world, placed from the town's own layout (many-lamps.ts `townLots`) as bench data the benches add
 * before Play and take out after, as the lamps are: nothing in the generators, nothing written to the world.
 *
 * Every prop is the project's kit log model (`voxel-kit-log`, the one model the test project has) scaled to the prop's
 * box: its recorded bounds stretched to the box are what the world's lighting occupancy stamps (prop-light-shape.ts:
 * no collider, so the model's bounds), and what is drawn is the stretched log filling it.
 *
 * - Two props for the readings, always first: **the cart** 2.5 × 1.6 × 1.2 m in the night street's front yard east of
 *   the third street lamp (lighting-cameras.ts `BENCH_LAMPS`, x 8, 3 m up), so the ground east of it lies in its shade
 *   from the lamp (`PROP_READINGS.cart`: those cells against the same cells west of the lamp); **the table** top
 *   2 × 0.1 × 1.6 m, 0.75 m over the floor of the room camera's house by its window wall (`PROP_READINGS.table`: the
 *   floor cells under it, read with and without it).
 * - Indoors, each house's ground floor: a crate 1 × 0.8 × 0.8 m in its back corner, a table top 1.6 × 0.1 × 1 m in its
 *   middle and a shelf 0.4 × 1.8 × 1.6 m against its east wall.
 * - Outdoors, by each street lamp's place (many-lamps.ts's street places): a cart 2.4 × 1.4 × 1.2 m two metres along
 *   the street and a stall 3 × 2.4 × 1.5 m four metres the other way; every fifth cart moves 3 m along the street and
 *   back at 1 m/s (a `mover`), so the stamps follow moving props.
 *
 * Ordered by distance from the many-lamps scene's middle (the street in front of the room camera's house), so the
 * sizes nest and the smallest is round the cameras. Engine-owned test data for measuring, not a product feature.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MANY_LAMPS_CENTRE, townLots } from './many-lamps';

/** The model every bench prop is (the test project's one model) and the file its recorded bounds are read from. */
export const BENCH_PROP_MODEL = 'voxel-kit-log';
const MODEL_RECORD = join('assets', 'kits', `${BENCH_PROP_MODEL}.glb.tlasset`);
/** Bench props' names start with this (a run's leftovers are found by it). */
export const BENCH_PROP_PREFIX = 'BP ';
/** The house floor's top and the ground's (metres): the town's floors are one cell over the ground at 0. */
const FLOOR_Y = 0.5;
const GROUND_Y = 0;

export interface BenchProp {
  readonly name: string;
  readonly kind: 'cart' | 'table' | 'crate' | 'shelf' | 'stall';
  /** The box the prop stands for (world metres). */
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
  /** Moves along the street and back (metres, x). */
  readonly moves?: number;
}

/** The two reading props' boxes and the cells read for them (world metres; every 0.5 m cell whose centre lies inside). */
export const PROP_READINGS = Object.freeze({
  /** The cart; cells: the ground's open cells (one layer) east of it in its shade from lamp 3, and the same west of the lamp (the control). */
  cart: Object.freeze({ min: [11, GROUND_Y, -26.1] as const, max: [13.5, GROUND_Y + 1.6, -24.9] as const, cells: Object.freeze({ min: [13.5, GROUND_Y, -26] as const, max: [15.5, GROUND_Y + 0.5, -25] as const }), control: Object.freeze({ min: [0.5, GROUND_Y, -26] as const, max: [2.5, GROUND_Y + 0.5, -25] as const }), camera: 'night-lamps' as const }),
  /** The table by the room camera's window wall; cells: the floor's open cells under it (read against a run without it). */
  table: Object.freeze({ min: [-4.4, FLOOR_Y + 0.7, 0] as const, max: [-2.4, FLOOR_Y + 0.8, 1.6] as const, cells: Object.freeze({ min: [-4, FLOOR_Y, 0.5] as const, max: [-3, FLOOR_Y + 0.5, 1.5] as const }), control: Object.freeze({ min: [-4, FLOOR_Y, 3] as const, max: [-3, FLOOR_Y + 0.5, 4] as const }), camera: 'room-window' as const }),
});

/** Street lamps' places (as many-lamps.ts places them): every 8 m along each street, fronts' and backs' side by turns. */
function streetPlaces(): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let j = 1; j < 12; j++) {
    const zb = -128 + j * 20;
    let n = 0;
    for (let x = -124; x < 128; x += 8, n++) out.push([x, n % 2 === 0 ? zb + 2.25 : zb - 1.25]);
  }
  return out;
}

const box = (cx: number, y0: number, cz: number, w: number, h: number, d: number): Pick<BenchProp, 'min' | 'max'> => ({ min: [cx - w / 2, y0, cz - d / 2], max: [cx + w / 2, y0 + h, cz + d / 2] });

/** The scene of `n` props (the two reading props first); throws when the town has too few places. */
export function benchProps(n: number): BenchProp[] {
  const r = PROP_READINGS;
  const fixed: BenchProp[] = [
    { name: `${BENCH_PROP_PREFIX}reading cart`, kind: 'cart', min: r.cart.min, max: r.cart.max },
    { name: `${BENCH_PROP_PREFIX}reading table`, kind: 'table', min: r.table.min, max: r.table.max },
  ];
  const rest: Array<BenchProp & { at: [number, number] }> = [];
  for (const l of townLots()) {
    const h = l.house;
    if (h === null) continue;
    const at: [number, number] = [h.x0 + h.w / 2, h.z0 + h.d / 2];
    rest.push({ name: `${BENCH_PROP_PREFIX}crate ${l.i},${l.j}`, kind: 'crate', ...box(h.x0 + 1.5, FLOOR_Y, h.z0 + h.d - 1.5, 1, 0.8, 0.8), at });
    rest.push({ name: `${BENCH_PROP_PREFIX}table ${l.i},${l.j}`, kind: 'table', ...box(at[0], FLOOR_Y + 0.7, at[1], 1.6, 0.1, 1), at });
    rest.push({ name: `${BENCH_PROP_PREFIX}shelf ${l.i},${l.j}`, kind: 'shelf', ...box(h.x0 + h.w - 0.95, FLOOR_Y, at[1], 0.4, 1.8, 1.6), at });
  }
  let carts = 0;
  for (const [x, z] of streetPlaces()) {
    const moves = carts++ % 5 === 0 ? 3 : undefined;
    rest.push({ name: `${BENCH_PROP_PREFIX}cart ${x},${z}`, kind: 'cart', ...box(x + 2, GROUND_Y, z, 2.4, 1.4, 1.2), ...(moves !== undefined ? { moves } : {}), at: [x + 2, z] });
    rest.push({ name: `${BENCH_PROP_PREFIX}stall ${x},${z}`, kind: 'stall', ...box(x - 4, GROUND_Y, z, 3, 2.4, 1.5), at: [x - 4, z] });
  }
  // Clear of the reading props (their cells must see only what the readings name).
  const clear = (p: BenchProp): boolean => [r.cart, r.table].every((q) => p.max[0] < q.min[0] - 3 || p.min[0] > q.max[0] + 3 || p.max[2] < q.min[2] - 3 || p.min[2] > q.max[2] + 3);
  const away = (a: readonly [number, number]): number => Math.hypot(a[0] - MANY_LAMPS_CENTRE[0], a[1] - MANY_LAMPS_CENTRE[1]);
  const sorted = rest.filter(clear).sort((a, b) => away(a.at) - away(b.at) || a.at[0] - b.at[0] || a.at[1] - b.at[1] || (a.name < b.name ? -1 : 1));
  if (n < 2 || sorted.length + 2 < n) throw new Error(`bench props: between 2 and ${sorted.length + 2}, not ${n}`);
  return [...fixed, ...sorted.slice(0, n - 2).map(({ at: _at, ...p }) => p)];
}

/** The `--props N` option (0: none). */
export function parsePropsOption(argv: readonly string[]): number {
  const i = argv.indexOf('--props');
  if (i < 0) return 0;
  const n = Number(argv[i + 1]);
  if (!Number.isInteger(n) || n < 2) throw new Error(`--props: a whole number of 2 or more, not ${String(argv[i + 1])}`);
  return n;
}

/** The model's recorded bounds in the project (the box a prop of it stamps, before its scale). */
export function benchPropBounds(projectDir: string): { min: number[]; max: number[] } {
  const rec = JSON.parse(readFileSync(join(projectDir, MODEL_RECORD), 'utf8')) as { record: { currentVersion: number; versions: Array<{ version: number; metrics?: { bounds?: { min: number[]; max: number[] } } }> } };
  const b = rec.record.versions.find((v) => v.version === rec.record.currentVersion)?.metrics?.bounds;
  if (b === undefined) throw new Error(`${BENCH_PROP_MODEL} has no recorded bounds`);
  return b;
}

/** A prop as an entity value (what `pasteEntities` takes): the model scaled and placed so its bounds fill the prop's box. */
export function benchPropEntity(p: BenchProp, bounds: { min: number[]; max: number[] }, id: string, lit = true): Record<string, unknown> {
  const scale = [0, 1, 2].map((a) => (p.max[a]! - p.min[a]!) / (bounds.max[a]! - bounds.min[a]!));
  const position = [0, 1, 2].map((a) => (p.min[a]! + p.max[a]!) / 2 - ((bounds.min[a]! + bounds.max[a]!) / 2) * scale[a]!);
  return {
    id,
    name: p.name,
    components: {
      transform: { position, rotation: [0, 0, 0, 1], scale },
      model: { asset: { assetId: BENCH_PROP_MODEL }, ...(lit ? { affectsLighting: true } : {}) },
      ...(p.moves !== undefined ? { mover: { waypoints: [[p.moves, 0, 0]], speed: 1, mode: 'pingpong' } } : {}),
    },
  };
}

/** Puts the props in the project (`lit` false: the same objects not marked, the control for what drawing them costs) in pastes of a hundred (taking out any a stopped run left, in one delete) and gives back what takes them out again. */
export async function placeBenchProps(props: readonly BenchProp[], projectDir: string, command: (op: string, args: Record<string, unknown>) => Promise<void>, entities: () => Array<{ id: string; name: string }>, lit = true): Promise<() => Promise<void>> {
  const clear = async (): Promise<number> => {
    const ids = entities().filter((x) => x.name.startsWith(BENCH_PROP_PREFIX)).map((e) => e.id);
    if (ids.length > 0) await command('deleteEntity', { entityId: ids[0]!, ...(ids.length > 1 ? { entityIds: ids.slice(1) } : {}) });
    return ids.length;
  };
  const left = await clear();
  if (left > 0) console.log(`bench props: ${left} left by an earlier run taken out`);
  const bounds = benchPropBounds(projectDir);
  // A request is capped in bytes: the props go in pastes of a hundred.
  const all = props.map((p, i) => benchPropEntity(p, bounds, `bench-prop-${i}`, lit));
  for (let i = 0; i < all.length; i += 100) await command('pasteEntities', { entities: all.slice(i, i + 100), sceneId: 'scene-main' });
  console.log(`bench props: ${props.length} placed (${props.filter((p) => p.moves !== undefined).length} moving)`);
  return async () => {
    const n = await clear();
    console.log(`bench props: ${n} taken out`);
  };
}

/**
 * In the page: the light volume's level-0 cells whose centres lie in a box (world metres), summed: cells read, those
 * the walk says hold light (open beside a surface), those holding light on the GPU, the mean light (the mean of the six
 * faces' mean channel) of those, and the mean of their +Y face (the light a floor under them reads).
 */
export async function volumeBoxLight(b: { min: readonly number[]; max: readonly number[] }): Promise<{ cells: number; holds: number; lit: number; mean: number; up: number } | null> {
  type Cell = { holds: boolean; faces: (number[] | null)[] };
  const l = (window as unknown as { __tlVoxelPlay?: { light?: { volumeCells?(p: number[][]): Promise<Cell[] | null> } } }).__tlVoxelPlay?.light;
  const pts: number[][] = [];
  for (let x = Math.ceil(b.min[0]! * 2 - 0.5) / 2 + 0.25; x < b.max[0]!; x += 0.5) for (let y = Math.ceil(b.min[1]! * 2 - 0.5) / 2 + 0.25; y < b.max[1]!; y += 0.5) for (let z = Math.ceil(b.min[2]! * 2 - 0.5) / 2 + 0.25; z < b.max[2]!; z += 0.5) pts.push([x, y, z]);
  const cells = (await l?.volumeCells?.(pts)) ?? null;
  if (cells === null) return null;
  let holds = 0;
  let lit = 0;
  let sum = 0;
  let up = 0;
  for (const c of cells) {
    if (c.holds) holds++;
    const faces = c.faces.filter((f): f is number[] => f !== null);
    if (faces.length === 0) continue;
    lit++;
    sum += faces.reduce((a, f) => a + (f[0]! + f[1]! + f[2]!) / 3, 0) / 6;
    const f = c.faces[2];
    if (f != null) up += (f[0]! + f[1]! + f[2]!) / 3;
  }
  return { cells: cells.length, holds, lit, mean: lit === 0 ? 0 : sum / lit, up: lit === 0 ? 0 : up / lit };
}
