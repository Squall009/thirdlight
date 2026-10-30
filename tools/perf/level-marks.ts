/**
 * The marks the outdoor level classes can carry on their surfaces, for
 * measuring decals and vertex paint (`node tools/perf/run.mjs level --classes
 * area --decals N --mesh-decals N --clipped-decals N --painted N`). Every
 * count is 0 by default, and at 0 the class is the scene it was: nothing is
 * placed, published or counted.
 *
 * - `--decals N`: projected decals, box projectors spread over the block
 *   layer's ground, its rooms' walls and the props, ~30 % of them in
 *   overlapping pairs (a pixel under two decals is the case that costs).
 * - `--mesh-decals N`: flat marks over the ground and the walls.
 * - `--clipped-decals N`: projectors like `--decals` (static, the same
 *   decal material) in `clipped` mode: their meshes are clipped at load
 *   from the block layer's chunks and the props under them, on the
 *   generator workers, and merge into the static cells.
 * - `--painted N`: placed props, then foliage copies (one from each set in
 *   turn), painted by `paintVertices` strokes and wearing a standard
 *   material that tints by the paint (`paintTint`); measure the paint's
 *   cost against the same scene with `--switches paint=off`.
 * - `--moving-decals N` (with `--decals`): the first N projected decals move
 *   to and fro along their surface (a `mover`, 1 m at 0.5 m/s), so their
 *   index cells change every frame.
 * - `--decal-spawns N` (with `--decals`): a script spawns N decals a second
 *   (`ctx.decals.spawn` of a prefab carrying the projected decals' decal) on
 *   the projected decals' ground spots, round and round; past the transient
 *   budget the oldest fade out, so a steady state of spawning and fading.
 *
 * The placements exist for every kind now, so each kind's measurement is the
 * same scene once its engine feature exists; what the engine can't draw yet
 * is refused at build time (`marksNotBuilt`) rather than measured as
 * something it isn't. Mesh decals are the engine's: quads wearing one decal
 * material with a stain image, laid a few millimetres over the surface
 * (static, so they merge into the static cells). Projected decals are the
 * engine's too: static projector entities with the same decal material. Painted
 * props and copies are the engine's: the strokes store real paint, drawn as
 * an attribute (props alone or merged) or a batch's or set's paint stream.
 *
 * The area class has no generated architecture, so generated walls are
 * left to the interior class; the area's walls are block walls.
 *
 * Pure: the placements are a function of the seed, the counts and the plan's
 * rooms and props, each kind from a generator of its own, so the class's own
 * content never moves with the counts.
 */
import { mulberry32 } from '@thirdlight/shared';
import { type EntityValue } from './generate';

/** The switches' counts (all 0: the class as recorded). */
export interface LevelMarksOptions {
  decals: number;
  meshDecals: number;
  clippedDecals: number;
  painted: number;
  /** Of the projected decals, how many move; decals spawned a second. */
  movingDecals: number;
  decalSpawns: number;
}

export const NO_LEVEL_MARKS: Readonly<LevelMarksOptions> = Object.freeze({ decals: 0, meshDecals: 0, clippedDecals: 0, painted: 0, movingDecals: 0, decalSpawns: 0 });

/** Each switch's flag and its option. */
export const LEVEL_MARK_FLAGS: readonly (readonly [string, keyof LevelMarksOptions])[] = [
  ['decals', 'decals'],
  ['mesh-decals', 'meshDecals'],
  ['clipped-decals', 'clippedDecals'],
  ['painted', 'painted'],
  ['moving-decals', 'movingDecals'],
  ['decal-spawns', 'decalSpawns'],
];

/** The switches from the command line's flags (`get` returns a flag's value); a count is a whole number ≥ 0. */
export function parseLevelMarks(get: (flag: string) => string | undefined): LevelMarksOptions {
  const out: LevelMarksOptions = { ...NO_LEVEL_MARKS };
  for (const [flag, key] of LEVEL_MARK_FLAGS) {
    const v = get(flag);
    if (v === undefined) continue;
    const n = Number(v);
    if (v.trim() === '' || !Number.isInteger(n) || n < 0) throw new Error(`--${flag}: a whole number of marks (0 or more), not ${v}`);
    out[key] = n;
  }
  if (out.movingDecals > out.decals) throw new Error(`--moving-decals: at most the --decals placed (${out.decals}), not ${out.movingDecals}`);
  if (out.decalSpawns > 0 && out.decals === 0) throw new Error('--decal-spawns: spawns on the projected decals\' spots, so it needs --decals');
  return out;
}

export const anyLevelMarks = (o: LevelMarksOptions): boolean => o.decals > 0 || o.meshDecals > 0 || o.clippedDecals > 0 || o.painted > 0;

/** The share of decals placed in overlapping pairs. */
export const DECAL_PAIR_SHARE = 0.3;
/** How far a pair's second decal sits from its first, in the first's widths (they overlap by the rest). */
const PAIR_OFFSET = 0.4;
/** A mark's side (m): from the first up to the first plus the second. */
const MARK_SIDE: readonly [number, number] = [0.6, 1.4];
/** A projector's depth over the ground or a wall (m): it reaches the surface under bumps of the ground's smoothing. */
const PROJECTOR_DEPTH = 0.5;
/** A projector over a prop reaches through it (its depth in the prop's scales): the lathes are at most ~2 m across. */
const PROP_PROJECTOR_DEPTH = 4;
/** How far a mesh decal sits over its surface (m): as an artist lays one; the decal's push toward the camera does the rest. */
export const MESH_DECAL_LIFT = 0.005;
/** Where the projected and clipped decals go (ground, walls, props) and where mesh decals go (ground, walls): shares of the count. */
const PROJECTED_SPREAD = { ground: 0.5, wall: 0.3, prop: 0.2 } as const;
const MESH_SPREAD = { ground: 0.6, wall: 0.4, prop: 0 } as const;

export type MarkSurface = 'ground' | 'wall' | 'prop';

/** One decal: its centre on the surface (world), its rotation (+Z on the surface's normal: a projector looks along −Z), its box (m). */
export interface LevelDecalPlacement {
  surface: MarkSurface;
  position: [number, number, number];
  rotation: [number, number, number, number];
  size: [number, number, number];
  /** The index of the decal it overlaps (a pair's second). */
  overlaps?: number;
}

export interface LevelMarks {
  options: LevelMarksOptions;
  decals: LevelDecalPlacement[];
  meshDecals: LevelDecalPlacement[];
  clippedDecals: LevelDecalPlacement[];
  /** The placed props drawn painted (entity ids), and the foliage copies (set entity, copy index). */
  paintedProps: string[];
  paintedCopies: { entityId: string; index: number }[];
}

/** What the marks are placed on: the area's rooms (layer columns, wall top row), its props, its foliage sets, its ground. */
export interface LevelMarkReceivers {
  seed: number;
  /** Columns per side of the layer, its origin in the world (min corner), row height (m). */
  side: number;
  origin: [number, number, number];
  cellHeight: number;
  /** Ground height (world m) at layer column coordinates. */
  groundY: (x: number, z: number) => number;
  rooms: readonly { box: readonly [number, number, number, number]; top: number }[];
  props: readonly { id: string; position: readonly number[]; scale: number }[];
  foliage: readonly { id: string; count: number }[];
}

type Quat = [number, number, number, number];
const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const r6 = (v: number): number => Math.round(v * 1e6) / 1e6;

function mul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
}

/** The rotation taking +Z onto the unit vector `n`. */
function alignZ(n: readonly [number, number, number]): Quat {
  const [x, y, z] = n;
  if (z < -0.999999) return [0, 1, 0, 0];
  // Half-way quaternion: axis +Z × n, angle between them.
  const q: Quat = [-y, x, 0, 1 + z];
  const l = Math.hypot(...q);
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

/** Rotate `v` by `q`. */
function rotate(q: Quat, v: readonly [number, number, number]): [number, number, number] {
  const [x, y, z, w] = q;
  const [vx, vy, vz] = v;
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
}

/** A wall face of a room: its line (layer columns) along x or z, its outward side, and the door gap it has (none: null). */
interface WallFace {
  axis: 'x' | 'z';
  /** The fixed coordinate, the span along the other, the face's normal sign along its axis' perpendicular. */
  at: number;
  from: number;
  to: number;
  sign: 1 | -1;
  gap: [number, number] | null;
  ground: number;
  top: number;
}

function wallFaces(rooms: LevelMarkReceivers['rooms'], groundY: LevelMarkReceivers['groundY'], cellHeight: number): WallFace[] {
  const out: WallFace[] = [];
  for (const { box: [x0, z0, x1, z1], top } of rooms) {
    // The door gap in the z0 wall (level.ts: two columns from the middle).
    const doorX = x0 + Math.floor((x1 - x0) / 2);
    const gap: [number, number] = [doorX, doorX + 2];
    let ground = -Infinity;
    for (let x = x0; x <= x1; x += 1) for (let z = z0; z <= z1; z += 1) ground = Math.max(ground, groundY(x, z));
    const wallTop = top * cellHeight;
    // Outer and inner faces of the four one-column walls.
    out.push(
      { axis: 'x', at: z0, from: x0, to: x1, sign: -1, gap, ground, top: wallTop },
      { axis: 'x', at: z0 + 1, from: x0 + 1, to: x1 - 1, sign: 1, gap, ground, top: wallTop },
      { axis: 'x', at: z1, from: x0, to: x1, sign: 1, gap: null, ground, top: wallTop },
      { axis: 'x', at: z1 - 1, from: x0 + 1, to: x1 - 1, sign: -1, gap: null, ground, top: wallTop },
      { axis: 'z', at: x0, from: z0, to: z1, sign: -1, gap: null, ground, top: wallTop },
      { axis: 'z', at: x0 + 1, from: z0 + 1, to: z1 - 1, sign: 1, gap: null, ground, top: wallTop },
      { axis: 'z', at: x1, from: z0, to: z1, sign: 1, gap: null, ground, top: wallTop },
      { axis: 'z', at: x1 - 1, from: z0 + 1, to: z1 - 1, sign: -1, gap: null, ground, top: wallTop },
    );
  }
  return out;
}

/** `count` decals spread over the surfaces by `spread`, the first `DECAL_PAIR_SHARE` of them in overlapping pairs. */
function placeDecals(r: LevelMarkReceivers, count: number, spread: Readonly<Record<MarkSurface, number>>, salt: number): LevelDecalPlacement[] {
  if (count === 0) return [];
  const rnd = mulberry32(r.seed * 8191 + salt);
  const faces = wallFaces(r.rooms, r.groundY, r.cellHeight);
  const inRoom = (x: number, z: number, m: number): boolean => r.rooms.some(({ box }) => x >= box[0] - m && x < box[2] + m && z >= box[1] - m && z < box[3] + m);
  const [ox, oy, oz] = r.origin;
  const side = (): number => MARK_SIDE[0] + rnd() * MARK_SIDE[1];
  const spin = (): Quat => {
    const a = rnd() * Math.PI;
    return [0, 0, Math.sin(a), Math.cos(a)];
  };
  const pairs = Math.floor((count * DECAL_PAIR_SHARE) / 2);
  const out: LevelDecalPlacement[] = [];
  const onGround = (): LevelDecalPlacement => {
    const w = side();
    let x = 0;
    let z = 0;
    do {
      x = 1 + rnd() * (r.side - 2);
      z = 1 + rnd() * (r.side - 2);
    } while (inRoom(x, z, w));
    // The ground's normal from its slope (central differences over half a metre).
    const e = 0.25;
    const dx = (r.groundY(x + e, z) - r.groundY(x - e, z)) / (2 * e);
    const dz = (r.groundY(x, z + e) - r.groundY(x, z - e)) / (2 * e);
    const l = Math.hypot(dx, 1, dz);
    const n: [number, number, number] = [-dx / l, 1 / l, -dz / l];
    return { surface: 'ground', position: [ox + x, oy + r.groundY(x, z), oz + z], rotation: mul(alignZ(n), spin()), size: [w, w * (0.7 + rnd() * 0.6), PROJECTOR_DEPTH] };
  };
  const onWall = (): LevelDecalPlacement => {
    const w = side();
    const h = w * (0.7 + rnd() * 0.6);
    let f: WallFace;
    let t = 0;
    do {
      f = faces[Math.floor(rnd() * faces.length)]!;
      t = f.from + w / 2 + rnd() * Math.max(0, f.to - f.from - w);
    } while (f.gap !== null && t + w / 2 > f.gap[0] && t - w / 2 < f.gap[1]);
    const y = f.ground + 0.3 + h / 2 + rnd() * Math.max(0, f.top - f.ground - 0.3 - h);
    const n: [number, number, number] = f.axis === 'x' ? [0, 0, f.sign] : [f.sign, 0, 0];
    const at: [number, number, number] = f.axis === 'x' ? [ox + t, y, oz + f.at] : [ox + f.at, y, oz + t];
    return { surface: 'wall', position: at, rotation: mul(alignZ(n), spin()), size: [w, h, PROJECTOR_DEPTH] };
  };
  const onProp = (): LevelDecalPlacement => {
    const p = r.props[Math.floor(rnd() * r.props.length)]!;
    const a = rnd() * Math.PI * 2;
    const w = side() * p.scale;
    return { surface: 'prop', position: [p.position[0]!, p.position[1]! + p.scale, p.position[2]!], rotation: mul(alignZ([Math.sin(a), 0, Math.cos(a)]), spin()), size: [w, w, PROP_PROJECTOR_DEPTH * p.scale] };
  };
  const pick = (): LevelDecalPlacement => {
    const u = rnd();
    if (u < spread.ground) return onGround();
    if (u < spread.ground + spread.wall || r.props.length === 0) return onWall();
    return onProp();
  };
  for (let i = 0; i < count; i += 1) {
    if (i < pairs * 2 && i % 2 === 1) {
      // A pair's second: the first's surface and box, moved along it by part of its width and turned.
      const first = out[i - 1]!;
      const along = rotate(first.rotation, [PAIR_OFFSET * first.size[0], 0, 0]);
      out.push({ ...first, position: [first.position[0] + along[0], first.position[1] + along[1], first.position[2] + along[2]], rotation: mul(first.rotation, spin()), overlaps: i - 1 });
      continue;
    }
    out.push(pick());
  }
  return out.map((d) => ({ ...d, position: [r3(d.position[0]), r3(d.position[1]), r3(d.position[2])], rotation: d.rotation.map(r6) as Quat, size: [r3(d.size[0]), r3(d.size[1]), r3(d.size[2])] }));
}

/** The marks of `o` over the receivers (all empty when every count is 0). */
export function levelMarks(r: LevelMarkReceivers, o: LevelMarksOptions): LevelMarks {
  const paintedProps = r.props.slice(0, o.painted).map((p) => p.id);
  // Past the props, copies: one from each set in turn.
  const paintedCopies: LevelMarks['paintedCopies'] = [];
  const total = r.foliage.reduce((n, f) => n + f.count, 0);
  for (let k = 0; paintedCopies.length < Math.min(o.painted - paintedProps.length, total); k += 1) {
    const f = r.foliage[k % r.foliage.length]!;
    const index = Math.floor(k / r.foliage.length);
    if (index < f.count) paintedCopies.push({ entityId: f.id, index });
  }
  return {
    options: { ...o },
    decals: placeDecals(r, o.decals, PROJECTED_SPREAD, 1),
    meshDecals: placeDecals(r, o.meshDecals, MESH_SPREAD, 2),
    clippedDecals: placeDecals(r, o.clippedDecals, PROJECTED_SPREAD, 3),
    paintedProps,
    paintedCopies,
  };
}

/** How far a moving decal goes along its surface (m) and how fast (m/s). */
const MOVING_DECAL_TRAVEL = 1;
const MOVING_DECAL_SPEED = 0.5;
/** The prefab whose decal the spawning script leaves, and the most spots it goes round. */
export const MARK_SPAWN_PREFAB = 'level-mark';
const SPAWN_SPOTS_MAX = 128;

/** The spots spawned decals go on: the projected ground decals' centres and normals (their box's +Z). */
export function spawnSpots(m: LevelMarks): { position: [number, number, number]; normal: [number, number, number] }[] {
  return m.decals
    .filter((d) => d.surface === 'ground')
    .slice(0, SPAWN_SPOTS_MAX)
    .map((d) => ({ position: d.position, normal: rotate(d.rotation, [0, 0, 1]).map(r6) as [number, number, number] }));
}

/** The spawning script: `perSecond` decals a second of fixed steps (`hz`), on the spots in turn, each turned and sized a little. */
export function spawnScript(m: LevelMarks, perSecond: number, hz: number): string {
  return [
    `const SPOTS = ${JSON.stringify(spawnSpots(m))};`,
    'export default {',
    '  instantiate() { return { owed: 0, n: 0 }; },',
    '  step(state: any, ctx: any) {',
    "    if (ctx.phase !== 'intent') return;",
    `    state.owed += ${perSecond / hz};`,
    '    while (state.owed >= 1) {',
    '      state.owed -= 1;',
    '      const s = SPOTS[state.n % SPOTS.length];',
    `      ctx.decals.spawn('${MARK_SPAWN_PREFAB}', { position: s.position, normal: s.normal, angle: (state.n * 47) % 360, scale: 0.6 + ((state.n * 13) % 7) / 10 });`,
    '      state.n += 1;',
    '    }',
    '  },',
    '};',
  ].join('\n');
}

/** The material painted props and the sets of painted copies wear: a standard surface tinted by its paint. */
export const PAINTED_MATERIAL = 'mat-level-painted';
/** A painted prop's stroke: a dab at its foot reaching all of it, red (R) at full alpha (A: how much it tints). */
export const PAINT_STROKE_RADIUS = 16;
/** A painted copy's stroke radius (a foliage copy is under a metre or two). */
export const COPY_STROKE_RADIUS = 4;
/** The mesh decals' quad file, its glTF material, the decal material that file maps it to and that material's image. */
export const MARK_QUAD = 'level-mark-quad';
export const MARK_QUAD_MATERIAL = 'mark';
export const MARK_DECAL_MATERIAL = 'mat-level-mark';
export const MARK_DECAL_IMAGE = 'level-mark-stain';

/** The marks' entities: the mesh decals, static (the decal material casts no shadow), and the projected decals' projectors. */
export function markEntities(m: LevelMarks): EntityValue[] {
  const projected = m.decals.map((d, i): EntityValue => {
    const moving = i < m.options.movingDecals;
    // A moving decal goes 1 m along its surface (its box's X) and back.
    const along = rotate(d.rotation, [MOVING_DECAL_TRAVEL, 0, 0]).map(r3) as [number, number, number];
    return {
      id: `projected-${i}`,
      name: `Projected ${i + 1}`,
      ...(moving ? {} : { static: true as const }),
      components: {
        transform: { position: [...d.position], rotation: d.rotation, scale: [1, 1, 1] },
        decal: { size: [...d.size], material: MARK_DECAL_MATERIAL },
        ...(moving ? { mover: { waypoints: [along], speed: MOVING_DECAL_SPEED, mode: 'pingpong' } } : {}),
      },
    };
  });
  const quads = m.meshDecals.map((d, i): EntityValue => {
    const lift = rotate(d.rotation, [0, 0, MESH_DECAL_LIFT]);
    return {
      id: `mark-${i}`,
      name: `Mark ${i + 1}`,
      static: true,
      components: {
        transform: { position: [r3(d.position[0] + lift[0]), r3(d.position[1] + lift[1]), r3(d.position[2] + lift[2])], rotation: d.rotation, scale: [d.size[0], d.size[1], 1] },
        model: { asset: { assetId: MARK_QUAD } },
      },
    };
  });
  const clipped = m.clippedDecals.map(
    (d, i): EntityValue => ({
      id: `clipped-${i}`,
      name: `Clipped ${i + 1}`,
      static: true,
      components: {
        transform: { position: [...d.position], rotation: d.rotation, scale: [1, 1, 1] },
        decal: { size: [...d.size], mode: 'clipped', material: MARK_DECAL_MATERIAL },
      },
    }),
  );
  return [...quads, ...projected, ...clipped];
}

/** Why a requested kind is refused (null: it can be built): the engine part it waits for. */
export function marksNotBuilt(m: LevelMarks): string | null {
  void m;
  return null;
}

/** The counts a run logs and reports (absent when 0, so an unmarked class counts as it did). */
export function markCounts(m: LevelMarks): Record<string, number> {
  const pairs = (list: LevelDecalPlacement[]): number => list.filter((d) => d.overlaps !== undefined).length;
  const c: Record<string, number> = {};
  if (m.decals.length > 0) Object.assign(c, { decals: m.decals.length, decalPairs: pairs(m.decals) });
  if (m.options.movingDecals > 0) c['movingDecals'] = m.options.movingDecals;
  if (m.options.decalSpawns > 0) c['decalSpawnsPerSecond'] = m.options.decalSpawns;
  if (m.meshDecals.length > 0) Object.assign(c, { meshDecals: m.meshDecals.length, meshDecalPairs: pairs(m.meshDecals) });
  if (m.clippedDecals.length > 0) Object.assign(c, { clippedDecals: m.clippedDecals.length, clippedDecalPairs: pairs(m.clippedDecals) });
  if (m.paintedProps.length > 0) c['paintedProps'] = m.paintedProps.length;
  if (m.paintedCopies.length > 0) c['paintedCopies'] = m.paintedCopies.length;
  return c;
}
