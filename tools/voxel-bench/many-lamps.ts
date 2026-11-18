/**
 * The many-lamps scene: lamps of every type in the town of staging's 8 km world (far-world.ts puts town.ts's town at
 * the world's centre, its middle at the origin), at three sizes, placed from the town's own layout so a later item
 * measures the same lamps. Bench data the benches add before Play and take out after (`--lamps N` in light-shots,
 * headroom and coverage), as the five street lamps are: nothing in the generators, nothing written to the world.
 *
 * - Street lamps: point lights 3 m up along every street (the gaps between the house rows), every 8 m, on the fronts'
 *   side and the backs' side by turns.
 * - Spots under the eaves: one a house, 0.75 m out from its front, half a metre under the roof's edge, aimed down at
 *   the front (30°, a soft edge).
 * - Rect panels: a 0.6 × 0.3 m area light over each house's door, a quarter metre off the front wall, facing the street.
 * - Line lights: a 4 m line 1.5 m over a lot's front fence, shining down along it.
 * - Room lamps: a point light in the middle of a house's ground-floor room, 2.25 m up.
 * - Emissive: the bench's glowing materials (lighting-cameras.ts `BENCH_GLOW_MATERIALS`) painted at run time by the
 *   camera's behaviour where the world is loaded (`ctx.voxels.paint`, as `--glow` paints): lava strips 6 × 0.5 m in
 *   the ground beside a street, crystal panels 1 × 1 m on a house front, crystal blocks at a house's front corner (one
 *   cell across, two up). An emissive light is counted as one painted patch (the volume counts its glowing faces as
 *   emitters per brick and facing; the benches read that count beside).
 *
 * Every kind's places are ordered by their distance from the scene's middle ({@link MANY_LAMPS_CENTRE}, the street in
 * front of the room camera's house) and each size takes the nearest of each kind, so the sizes nest (32 ⊂ 128 ⊂ 512)
 * and the smallest is round the cameras. Shadows as a game would give them: the lamps a player stands close to cast
 * (every spot, every room lamp, every fourth street lamp); panels, lines and the glow do not (an area light's shadow
 * is five atlas faces; small fixtures in a game are left unshadowed). The shadow atlas serves them by its own rule (a
 * memory budget, best ranked first): the benches read what it did (`data-tl-shadow-atlas`).
 *
 * Engine-owned test data for measuring, not a product feature.
 */
import { BENCH_GLOW_MATERIALS } from './lighting-cameras';
import { HOUSE_AT_X, HOUSE_AT_Z, LOT, lotOf, STOREY, TOWN_SEED } from './town';

/** The sizes (lights in the scene, emissive patches counted). */
export const MANY_LAMPS_SIZES = [32, 128, 512] as const;
export type ManyLampsSize = (typeof MANY_LAMPS_SIZES)[number];

/** The kinds of light the scene has. */
export const MANY_LAMP_KINDS = ['street', 'spot', 'rect', 'line', 'room', 'strip', 'panel', 'block'] as const;
export type ManyLampKind = (typeof MANY_LAMP_KINDS)[number];

/**
 * The mix at each size (default chosen, owner to confirm): points 50 % (street 37.5 %, rooms 12.5 %), spots 18.75 %,
 * rect panels 12.5 %, line lights 6.25 %, emissive patches 12.5 % (strips half, panels and blocks a quarter each).
 */
export const MANY_LAMPS_MIX: Readonly<Record<ManyLampsSize, Readonly<Record<ManyLampKind, number>>>> = Object.freeze({
  32: Object.freeze({ street: 12, spot: 6, rect: 4, line: 2, room: 4, strip: 2, panel: 1, block: 1 }),
  128: Object.freeze({ street: 48, spot: 24, rect: 16, line: 8, room: 16, strip: 8, panel: 4, block: 4 }),
  512: Object.freeze({ street: 192, spot: 96, rect: 64, line: 32, room: 64, strip: 32, panel: 16, block: 16 }),
});

/** The scene's middle (metres x, z): by the street in front of the room camera's house (lot 6, 6), so that house is the nearest. */
export const MANY_LAMPS_CENTRE = Object.freeze([0, -6] as const);
/** The town's side (metres) and where its corner lies in the world (its middle is the origin). */
const TOWN_SIDE_M = 256;
const TOWN_MIN_M = -TOWN_SIDE_M / 2;
const LOTS = TOWN_SIDE_M / (LOT / 2);
/** Cells to metres. */
const M = 0.5;
/** The night look's lamp strength (lighting-cameras.ts sets the street lamps to it at night) authored on the point lights, so a run without a look has them lit. */
const POINT_CD = 60;
/** Street lamps: every this many metres along a street. */
const STREET_STEP_M = 8;
/** Every this many street lamps (in the order of their distance) casts a shadow. */
const STREET_SHADOW_EVERY = 4;

export const MANY_LAMP_LIGHTS = Object.freeze({
  street: { type: 'point', color: '#ffc27a', intensity: POINT_CD, range: 14, decay: 2 },
  room: { type: 'point', color: '#ffd29a', intensity: POINT_CD, range: 8, decay: 2, castShadow: true },
  spot: { type: 'spot', color: '#ffe2b0', intensity: 150, range: 12, decay: 2, angle: 30, penumbra: 0.3, direction: [0, -0.8137, 0.5812], castShadow: true },
  rect: { type: 'area', shape: 'rect', width: 0.6, height: 0.3, color: '#fff1d6', intensity: 40, range: 8, castShadow: false },
  line: { type: 'area', shape: 'line', width: 4, color: '#a8f0ff', intensity: 40, range: 6, castShadow: false },
} as const);

/** A rect panel turned to face −z (a front wall faces −z; an area light faces its local −y): 90° about x. */
const FACE_MINUS_Z = Object.freeze([Math.SQRT1_2, 0, 0, Math.SQRT1_2] as const);

export interface ManyLamp {
  readonly kind: 'street' | 'spot' | 'rect' | 'line' | 'room';
  readonly name: string;
  readonly position: readonly [number, number, number];
  readonly rotation?: readonly [number, number, number, number];
  readonly light: Readonly<Record<string, unknown>>;
}
export interface GlowPatch {
  readonly kind: 'strip' | 'panel' | 'block';
  /** The box painted (metres, world). */
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
  /** The bench glow material's voxel id. */
  readonly material: number;
}
export interface ManyLampsScene {
  readonly size: ManyLampsSize;
  readonly lamps: readonly ManyLamp[];
  readonly glow: readonly GlowPatch[];
}

/** A house of the far world's town in world metres: its footprint's corner and size, its height, and its lot's fence. */
interface PlacedHouse {
  readonly x0: number;
  readonly z0: number;
  readonly w: number;
  readonly d: number;
  readonly top: number;
  /** The door's middle along x (cells: the town's `mid − 1`, `mid`). */
  readonly doorX: number;
}

/** The far world's lots (only the world grid's houses: houses in their own grids are not in the far world). */
function townLots(): Array<{ i: number; j: number; x0: number; z0: number; house: PlacedHouse | null; fence: boolean }> {
  const out: Array<{ i: number; j: number; x0: number; z0: number; house: PlacedHouse | null; fence: boolean }> = [];
  for (let i = 0; i < LOTS; i++) for (let j = 0; j < LOTS; j++) {
    const lot = lotOf(i, j, TOWN_SEED);
    const x0 = TOWN_MIN_M + i * LOT * M;
    const z0 = TOWN_MIN_M + j * LOT * M;
    const h = lot.house !== null && lot.yaw === 0 && !lot.pond ? lot.house : null;
    const house = h === null ? null : { x0: x0 + HOUSE_AT_X * M, z0: z0 + HOUSE_AT_Z * M, w: h.w * M, d: h.d * M, top: h.storeys * STOREY * M, doorX: x0 + HOUSE_AT_X * M + (h.w >> 1) * M };
    out.push({ i, j, x0, z0, house, fence: lot.fence });
  }
  return out;
}

const away = (x: number, z: number): number => Math.hypot(x - MANY_LAMPS_CENTRE[0], z - MANY_LAMPS_CENTRE[1]);
/** Nearest first; equal distances by place, so the order never depends on a sort's stability. */
const byDistance = <T extends { at: readonly [number, number] }>(list: T[]): T[] => list.sort((a, b) => away(a.at[0], a.at[1]) - away(b.at[0], b.at[1]) || a.at[0] - b.at[0] || a.at[1] - b.at[1]);

interface Candidates {
  street: Array<{ at: [number, number]; y: number }>;
  houses: Array<{ at: [number, number]; h: PlacedHouse }>;
  fences: Array<{ at: [number, number] }>;
  strips: Array<{ at: [number, number] }>;
}

function candidates(): Candidates {
  const lots = townLots();
  const street: Candidates['street'] = [];
  const strips: Candidates['strips'] = [];
  // Street j runs along x between row j − 1's backs and row j's fronts (its lot line at z0 of row j).
  for (let j = 1; j < LOTS; j++) {
    const zb = TOWN_MIN_M + j * LOT * M;
    let n = 0;
    for (let x = TOWN_MIN_M + STREET_STEP_M / 2; x < -TOWN_MIN_M; x += STREET_STEP_M, n++) {
      // Fronts' side: between the front fence (0.5–1 m in) and the fronts (4 m in); backs' side: between the backs
      // (at most 18.5 m into the lot before, the roof's edge) and its back fence (19 m).
      street.push({ at: [x, n % 2 === 0 ? zb + 2.25 : zb - 1.25], y: 3 });
    }
    for (let x = TOWN_MIN_M + STREET_STEP_M; x < -TOWN_MIN_M - 4; x += 2 * STREET_STEP_M) strips.push({ at: [x, zb + 2] });
  }
  const houses = lots.filter((l) => l.house !== null).map((l) => ({ at: [l.house!.x0 + l.house!.w / 2, l.house!.z0 + l.house!.d / 2] as [number, number], h: l.house! }));
  // The left half of a lot's front fence (its gap is at the middle).
  const fences = lots.filter((l) => l.fence).map((l) => ({ at: [l.x0 + 5, l.z0 + 0.75] as [number, number] }));
  return { street: byDistance(street), houses: byDistance(houses), fences: byDistance(fences), strips: byDistance(strips) };
}

/** The scene at one size: its lamps (by kind, nearest first) and glowing patches. Throws when the town has too few places for a kind. */
export function manyLampsScene(size: ManyLampsSize): ManyLampsScene {
  const mix = MANY_LAMPS_MIX[size];
  if (mix === undefined) throw new Error(`many lamps: a size among ${MANY_LAMPS_SIZES.join(', ')}, not ${String(size)}`);
  const c = candidates();
  const take = <T>(list: T[], n: number, kind: string): T[] => {
    if (list.length < n) throw new Error(`many lamps: the town has ${list.length} places for ${kind}, ${n} asked`);
    return list.slice(0, n);
  };
  const lamps: ManyLamp[] = [];
  take(c.street, mix.street, 'street lamps').forEach((p, k) => lamps.push({ kind: 'street', name: `ML street ${k + 1}`, position: [p.at[0], p.y, p.at[1]], light: { ...MANY_LAMP_LIGHTS.street, castShadow: k % STREET_SHADOW_EVERY === 0 } }));
  take(c.houses, mix.spot, 'spots').forEach(({ h }, k) => lamps.push({ kind: 'spot', name: `ML spot ${k + 1}`, position: [h.x0 + 1.25, h.top - 0.5, h.z0 - 0.75], light: MANY_LAMP_LIGHTS.spot }));
  take(c.houses, mix.rect, 'door panels').forEach(({ h }, k) => lamps.push({ kind: 'rect', name: `ML panel ${k + 1}`, position: [h.doorX, 2.75, h.z0 - 0.25], rotation: FACE_MINUS_Z, light: MANY_LAMP_LIGHTS.rect }));
  take(c.fences, mix.line, 'fence lines').forEach((f, k) => lamps.push({ kind: 'line', name: `ML line ${k + 1}`, position: [f.at[0], 1.5, f.at[1]], light: MANY_LAMP_LIGHTS.line }));
  take(c.houses, mix.room, 'room lamps').forEach(({ h }, k) => lamps.push({ kind: 'room', name: `ML room ${k + 1}`, position: [h.x0 + h.w / 2, 2.25, h.z0 + h.d / 2], light: MANY_LAMP_LIGHTS.room }));
  const [lava, crystal] = BENCH_GLOW_MATERIALS.map((m) => m.voxel.id) as [number, number];
  const glow: GlowPatch[] = [];
  for (const s of take(c.strips, mix.strip, 'glow strips')) glow.push({ kind: 'strip', min: [s.at[0] - 3, -0.5, s.at[1]], max: [s.at[0] + 3, 0, s.at[1] + 0.5], material: lava });
  // Panels on the fronts' right part, blocks at their left corner, of the nearest houses.
  for (const { h } of take(c.houses, mix.panel, 'glow panels')) glow.push({ kind: 'panel', min: [h.x0 + h.w - 2, 1, h.z0], max: [h.x0 + h.w - 1, 2, h.z0 + 0.5], material: crystal });
  for (const { h } of take(c.houses, mix.block, 'glow blocks')) glow.push({ kind: 'block', min: [h.x0, 0, h.z0], max: [h.x0 + 0.5, 1, h.z0 + 0.5], material: crystal });
  return { size, lamps, glow };
}

/** Counts by kind (the scene's mix as built). */
export function manyLampsCounts(s: ManyLampsScene): Record<ManyLampKind, number> & { lights: number; shadowed: number } {
  const out = Object.fromEntries(MANY_LAMP_KINDS.map((k) => [k, 0])) as Record<ManyLampKind, number>;
  for (const l of s.lamps) out[l.kind]++;
  for (const g of s.glow) out[g.kind]++;
  return { ...out, lights: s.lamps.length + s.glow.length, shadowed: s.lamps.filter((l) => l.light['castShadow'] === true).length };
}

/** The `--lamps N` option (0: none); throws on a size that is not one of the scene's. */
export function parseLampsOption(argv: readonly string[]): ManyLampsSize | 0 {
  const i = argv.indexOf('--lamps');
  if (i < 0) return 0;
  const n = Number(argv[i + 1]);
  if (!(MANY_LAMPS_SIZES as readonly number[]).includes(n)) throw new Error(`--lamps: one of ${MANY_LAMPS_SIZES.join(', ')}, not ${String(argv[i + 1])}`);
  return n as ManyLampsSize;
}

/** The debug commands of the scene's edits: the room camera's room lamp switched off, a glowing block set on that room's floor. */
export const MANY_LAMPS_COMMANDS = Object.freeze({ lampOff: 'ml_lamp_off', glowBlock: 'ml_glow_block' });
/** The room the edits are made in (the first room lamp's house: the room camera's). */
export const MANY_LAMPS_EDIT_ROOM = 'ML room 1';

/**
 * The scene's run-time part as behaviour code (declarations for the module's top, a piece of its `intent` phase,
 * `put` and `ctx` in scope): the glowing patches painted once each where the world is loaded (a few looked at a step;
 * counters `ml_glow_painted`, `ml_glow_refused`), the edits' commands (`ml_lamp_off`: the edit room's lamp at
 * intensity 0 by `ctx.entity(id).set('light', …)`; `ml_glow_block`: a crystal cell set on that room's floor under its
 * lamp, the floor found by a ray). With `glow` false nothing is painted (the coverage flight: a flight would measure
 * the paint as edits).
 */
export function manyLampsBehaviour(scene: ManyLampsScene, glow = true): { head: string; intent: string } {
  const room = scene.lamps.find((l) => l.name === MANY_LAMPS_EDIT_ROOM)!;
  const crystal = BENCH_GLOW_MATERIALS[1]!.voxel.id;
  return {
    head: `const ML_GLOW = ${JSON.stringify(glow ? scene.glow.map((g) => ({ min: g.min, max: g.max, material: g.material })) : [])};
const ML_ROOM = ${JSON.stringify({ name: room.name, at: room.position, crystal })};`,
    intent: `
      if (s.mlNext === undefined) { s.mlNext = 0; s.mlDone = []; }
      if (v !== undefined && v !== null && s.mlNext < ML_GLOW.length) {
        // Up to 8 patches looked at a step, from the first not painted: each painted once its cells are loaded.
        for (let k = 0, i = s.mlNext; k < 8 && i < ML_GLOW.length; k++, i++) {
          if (s.mlDone[i] === true || !v.isResident({ min: ML_GLOW[i].min, max: ML_GLOW[i].max })) continue;
          const r = v.paint({ min: ML_GLOW[i].min, max: ML_GLOW[i].max }, { material: ML_GLOW[i].material });
          s.mlDone[i] = true;
          ctx.game.add(r.ok ? 'ml_glow_painted' : 'ml_glow_refused', 1);
        }
        while (s.mlNext < ML_GLOW.length && s.mlDone[s.mlNext] === true) s.mlNext++;
        if (s.mlNext < ML_GLOW.length && ctx.stepIndex % 120 === 0) { const i = ML_GLOW.findIndex((_g, n) => s.mlDone[n] !== true); if (i >= 0) s.mlNext = i; }
      }
      for (const _ of ctx.debug.command('${MANY_LAMPS_COMMANDS.lampOff}')) {
        const id = ctx.world.find(ML_ROOM.name);
        const r = id === undefined ? null : ctx.entity(id)?.set('light', { intensity: 0 });
        ctx.game.add(r !== null && r !== undefined && r.ok !== false ? 'ml_lamp_offs' : 'ml_edit_refused', 1);
      }
      for (const _ of ctx.debug.command('${MANY_LAMPS_COMMANDS.glowBlock}')) {
        const h = v?.raycast([ML_ROOM.at[0] + 1, ML_ROOM.at[1], ML_ROOM.at[2]], [0, -1, 0], 4) ?? null;
        const ok = h !== null && h.voxel !== null && v.set({ at: [h.at[0], h.at[1] + 0.5, h.at[2]] }, { material: ML_ROOM.crystal, role: h.voxel.role }).ok;
        ctx.game.add(ok ? 'ml_glow_blocks' : 'ml_edit_refused', 1);
      }`,
  };
}

/** What the benches send to put the scene's lamps in the project and take them out: the `createEntity` arguments. */
export function manyLampEntities(scene: ManyLampsScene): Array<{ name: string; args: Record<string, unknown> }> {
  return scene.lamps.map((l) => ({
    name: l.name,
    args: { sceneId: 'scene-main', kind: 'group', name: l.name, transform: { position: [...l.position], ...(l.rotation !== undefined ? { rotation: [...l.rotation] } : {}) }, components: { light: { ...l.light } } },
  }));
}

/** The scene's lamps' names start with this (a run's leftovers are found by it). */
export const MANY_LAMP_PREFIX = 'ML ';

/**
 * Puts the scene's lamps in the project (taking out any left by a run that stopped) and gives back what takes them
 * out again. `command` sends one editing command; `entities` reads the scene's objects now.
 */
export async function placeManyLamps(scene: ManyLampsScene, command: (op: string, args: Record<string, unknown>) => Promise<void>, entities: () => Array<{ id: string; name: string }>): Promise<() => Promise<void>> {
  const clear = async (): Promise<number> => {
    let n = 0;
    for (const e of entities().filter((x) => x.name.startsWith(MANY_LAMP_PREFIX))) {
      await command('deleteEntity', { entityId: e.id });
      n++;
    }
    return n;
  };
  const left = await clear();
  if (left > 0) console.log(`many lamps: ${left} left by an earlier run taken out`);
  for (const e of manyLampEntities(scene)) await command('createEntity', e.args);
  console.log(`many lamps: ${scene.lamps.length} lamps placed (${JSON.stringify(manyLampsCounts(scene))})`);
  return async () => {
    const n = await clear();
    console.log(`many lamps: ${n} lamps taken out`);
  };
}
