/**
 * Derived data of one chunk (format v1 DRAFT): everything rebuilt from the
 * authoritative voxels for meshing, culling, physics, navigation and
 * lighting. Never committed, never saved: always rebuilt, in workers, from
 * a chunk and its apron.
 *
 * One assembly evaluation (assembly.ts) resolves the cells; each consumer
 * then reads the resolved classes through its own table, so the same open
 * rail is open for every consumer while the wall beside it is solid for
 * every consumer:
 *
 * | class  | render solid | collision            | nav blocks / supports | light coverage |
 * |--------|--------------|----------------------|-----------------------|----------------|
 * | wall   | yes          | full box             | yes / yes             | 255            |
 * | ground | density ≥ 128 | the ground surface  | density ≥ 128         | its density    |
 * | beam   | no           | partial box          | yes / no              | {@link LIGHT_COVERAGE}.beam |
 * | rail   | no           | thin slab (post: bar)| yes / no              | {@link LIGHT_COVERAGE}.rail |
 * | liquid | no           | none                 | no / no               | 0              |
 *
 * Representations (picked by the measurements in the phase plan):
 * - **occupancy**: a chunk flag (empty, solid, mixed), a 2-bit flag per 4³
 *   brick, and one bit per cell only for a mixed chunk;
 * - **light**: one coverage byte for a uniform chunk; otherwise one bit
 *   per fully covered cell plus a list of the partly covered cells
 *   (cell index, coverage);
 * - **collision**: boxes in 1/{@link COLLISION_STEPS_PER_CELL} cell steps
 *   (full cells merged into columns, slabs and blocks; partial shapes one a cell)
 *   with a material slot each, plus the ground surface as the trimesh;
 * - **navigation**: a blocking bit per cell and the standable cells
 *   (cell index, clearance in cells, and whether the clearance continues
 *   into the chunk above);
 * - **meshes** (derived-mesh.ts): the ground surface, the base surface and
 *   the detail-instance list, sharing one material table.
 *
 * A result records the format version and the rules it came from (id,
 * version, radius), so a result of other rules is never mistaken for a
 * current one.
 */
import { evaluateAssembly, rulesRef, ASSEMBLY_CLASS, CLASS_MASK, RUN_X, RUN_Z, type AssemblyRulesRef, type AssemblyRuleSet, type Neighbourhood } from './assembly';
import { BRICK_EDGE } from './brick-layout';
import { baseSurface, detailInstances, groundSurface, MaterialSlots, SURFACE_ISO, type InstanceList, type SurfaceBuffer } from './derived-mesh';
import { DERIVED_PART, fieldsFeed, PLANE_BIT, valueMaterial, valueWetness } from './record';
import { shaderBytes, shaderDataOfValues, shaderEntry, type ShaderOut } from './derived-shader';
import { utf8Encode } from '@thirdlight/shared';

/** Version of the derived-data layout. */
export const DERIVED_FORMAT_VERSION = 2;

/** Chunk and brick occupancy flags. */
export const OCCUPANCY = Object.freeze({ empty: 0, solid: 1, mixed: 2 });

/**
 * Light coverage of the resolved features (0 … 255 for 0 … 1): placeholder
 * values standing in for each piece's measured cover, which the kit pipeline
 * will supply per piece.
 */
export const LIGHT_COVERAGE = Object.freeze({ wall: 255, beam: 128, rail: 51 });

/** Collision box steps per cell (1/16 cell ≈ 3 cm). */
export const COLLISION_STEPS_PER_CELL = 16;

/** Standing room a standable cell's clearance counts up to (4 cells = 2 m). */
export const NAV_CLEARANCE_CELLS = 4;

/** Clearance bit: the free run reaches the chunk's top before {@link NAV_CLEARANCE_CELLS}; read on in the chunk above. */
export const NAV_CLEARANCE_CONTINUES = 0x80;

/**
 * Partial collision shapes per resolved class and run, as boxes in
 * collision steps within a cell: a beam is a 0.3 m-ish bar along its run,
 * a rail a thin slab along its run, a post a thin bar.
 */
function partialBox(resolved: number): readonly [number, number, number, number, number, number] {
  const k = resolved & CLASS_MASK;
  const x = (resolved & RUN_X) !== 0;
  const z = (resolved & RUN_Z) !== 0;
  if (k === ASSEMBLY_CLASS.beam) return x ? [0, 3, 3, 16, 13, 13] : [3, 3, 0, 13, 13, 16];
  if (x && z) return [6, 0, 6, 10, 16, 10];
  return x ? [0, 0, 6, 16, 16, 10] : [6, 0, 0, 10, 16, 16];
}

export interface OccupancyOut {
  /** {@link OCCUPANCY} of the whole chunk. */
  readonly flag: number;
  /** 2 bits per 4³ brick (brick (bx·n + bz)·n + by, four to a byte, low bits first). */
  readonly bricks: Uint8Array;
  /** One bit per cell (local index) for a mixed chunk, else null. */
  readonly mask: Uint32Array | null;
}

export interface LightOut {
  /** The coverage of every cell when the chunk is uniform, else −1. */
  readonly uniform: number;
  /** Cells covering fully (255), one bit each; null when none or uniform. */
  readonly full: Uint32Array | null;
  /** Partly covering cells (local index) and their coverage, in cell order. */
  readonly partialCells: Uint16Array;
  readonly partialCover: Uint8Array;
}

export interface CollisionOut {
  /** Boxes: min x, y, z, max x, y, z in collision steps from the chunk corner. */
  readonly boxes: Uint16Array;
  /** Material slot per box. */
  readonly boxSlots: Uint16Array;
  /** How many leading boxes are full-cell merges (the rest are partial shapes). */
  readonly fullBoxes: number;
}

export interface NavOut {
  /** Whether any / every cell blocks movement. */
  readonly blocking: number;
  /** One bit per blocking cell for a mixed chunk, else null. */
  readonly blocks: Uint32Array | null;
  /** Standable cells (free, on a supporting cell), local index, in cell order. */
  readonly standable: Uint16Array;
  /** Per standable cell: free cells upward from it (≤ {@link NAV_CLEARANCE_CELLS}) | {@link NAV_CLEARANCE_CONTINUES}. */
  readonly clearance: Uint8Array;
}

/** Cells of each resolved class in the chunk (what the measurements count). */
export interface DerivedCounts {
  readonly wall: number;
  readonly ground: number;
  readonly groundPartial: number;
  readonly beam: number;
  readonly rail: number;
  readonly liquid: number;
}

export interface DerivedData {
  readonly v: number;
  readonly rules: AssemblyRulesRef;
  readonly edge: number;
  /** Material table: slot → material id (shared by meshes, instances and boxes). */
  readonly materials: Uint32Array;
  readonly occupancy: OccupancyOut;
  readonly light: LightOut;
  readonly collision: CollisionOut;
  readonly nav: NavOut;
  /** The projected ground surface; also the ground's collision trimesh. */
  readonly ground: SurfaceBuffer;
  /** The modular base surface. */
  readonly base: SurfaceBuffer;
  readonly instances: InstanceList;
  /** Material and wetness per cell for the surface shader (derived-shader.ts). */
  readonly shader: ShaderOut;
  readonly counts: DerivedCounts;
}

/**
 * The parts whose bytes today also carry material ids (the surface
 * vertices' material slots and weights, the instances' and collision
 * boxes' slots). The feeds table sends material to the shader data only;
 * until the mesh format leaves material blending to the shader, a material
 * change makes these stale too.
 */
export const MATERIAL_SLOT_PARTS = DERIVED_PART.mesh | DERIVED_PART.collision;

/** The derived parts a change of `fields` (PLANE_BIT mask) makes stale, as this build derives them. */
export function stalePartsOf(fields: number): number {
  return fieldsFeed(fields) | (fields & PLANE_BIT.material ? MATERIAL_SLOT_PARTS : 0);
}

/** Whether a resolved cell is solid for rendering and culling. */
function renderSolid(n: Neighbourhood, classes: Uint8Array, i: number): boolean {
  const k = classes[i]! & CLASS_MASK;
  return k === ASSEMBLY_CLASS.wall || (k === ASSEMBLY_CLASS.ground && n.shapes[i]! >= SURFACE_ISO);
}

/** Whether a resolved cell blocks movement. */
function navBlocks(n: Neighbourhood, classes: Uint8Array, i: number): boolean {
  const k = classes[i]! & CLASS_MASK;
  return k === ASSEMBLY_CLASS.wall || k === ASSEMBLY_CLASS.beam || k === ASSEMBLY_CLASS.rail || (k === ASSEMBLY_CLASS.ground && n.shapes[i]! >= SURFACE_ISO);
}

/** Light coverage of a resolved cell. */
function coverage(n: Neighbourhood, classes: Uint8Array, i: number): number {
  switch (classes[i]! & CLASS_MASK) {
    case ASSEMBLY_CLASS.wall:
      return LIGHT_COVERAGE.wall;
    case ASSEMBLY_CLASS.ground:
      return n.shapes[i]!;
    case ASSEMBLY_CLASS.beam:
      return LIGHT_COVERAGE.beam;
    case ASSEMBLY_CLASS.rail:
      return LIGHT_COVERAGE.rail;
    default:
      return 0;
  }
}

/** A per-cell bit set over a chunk (local index (x·E + z)·E + y). */
function bitSet(cells: number): Uint32Array {
  return new Uint32Array(cells >>> 5);
}

function setBit(m: Uint32Array, i: number): void {
  m[i >>> 5]! |= 1 << (i & 31);
}

/** Whether bit `i` of a cell bit set is set. */
export function cellBit(m: Uint32Array | null, i: number): boolean {
  return m !== null && ((m[i >>> 5]! >>> (i & 31)) & 1) === 1;
}

function occupancyOf(n: Neighbourhood, classes: Uint8Array): OccupancyOut {
  const e = n.edge;
  const p = n.pad;
  const s = n.side;
  const nb = e / BRICK_EDGE;
  const bricks = new Uint8Array(Math.ceil((nb * nb * nb) / 4));
  const mask = bitSet(e * e * e);
  let solid = 0;
  for (let bx = 0; bx < nb; bx++) for (let bz = 0; bz < nb; bz++) for (let by = 0; by < nb; by++) {
    let inBrick = 0;
    for (let x = bx * BRICK_EDGE; x < (bx + 1) * BRICK_EDGE; x++) for (let z = bz * BRICK_EDGE; z < (bz + 1) * BRICK_EDGE; z++) for (let y = by * BRICK_EDGE; y < (by + 1) * BRICK_EDGE; y++) {
      if (!renderSolid(n, classes, ((x + p) * s + (z + p)) * s + (y + p))) continue;
      setBit(mask, (x * e + z) * e + y);
      inBrick++;
    }
    solid += inBrick;
    const flag = inBrick === 0 ? OCCUPANCY.empty : inBrick === BRICK_EDGE ** 3 ? OCCUPANCY.solid : OCCUPANCY.mixed;
    const k = (bx * nb + bz) * nb + by;
    bricks[k >>> 2]! |= flag << ((k & 3) * 2);
  }
  const flag = solid === 0 ? OCCUPANCY.empty : solid === e * e * e ? OCCUPANCY.solid : OCCUPANCY.mixed;
  return { flag, bricks, mask: flag === OCCUPANCY.mixed ? mask : null };
}

function lightOf(n: Neighbourhood, classes: Uint8Array): LightOut {
  const e = n.edge;
  const p = n.pad;
  const s = n.side;
  const full = bitSet(e * e * e);
  const cells: number[] = [];
  const cover: number[] = [];
  let fulls = 0;
  let first = -1;
  let uniform = true;
  for (let x = 0; x < e; x++) for (let z = 0; z < e; z++) for (let y = 0; y < e; y++) {
    const c = coverage(n, classes, ((x + p) * s + (z + p)) * s + (y + p));
    if (first < 0) first = c;
    else if (c !== first) uniform = false;
    const i = (x * e + z) * e + y;
    if (c === 255) {
      setBit(full, i);
      fulls++;
    } else if (c > 0) {
      cells.push(i);
      cover.push(c);
    }
  }
  if (uniform) return { uniform: first, full: null, partialCells: new Uint16Array(0), partialCover: new Uint8Array(0) };
  return { uniform: -1, full: fulls === 0 ? null : full, partialCells: Uint16Array.from(cells), partialCover: Uint8Array.from(cover) };
}

function navOf(n: Neighbourhood, classes: Uint8Array): NavOut {
  const e = n.edge;
  const p = n.pad;
  const s = n.side;
  const blocks = bitSet(e * e * e);
  const standable: number[] = [];
  const clearance: number[] = [];
  let blocking = 0;
  for (let x = 0; x < e; x++) for (let z = 0; z < e; z++) {
    const col = ((x + p) * s + (z + p)) * s + p;
    for (let y = 0; y < e; y++) {
      const i = col + y;
      const local = (x * e + z) * e + y;
      if (navBlocks(n, classes, i)) {
        setBit(blocks, local);
        blocking++;
        continue;
      }
      const k = classes[i - 1]! & CLASS_MASK;
      const supported = k === ASSEMBLY_CLASS.wall || (k === ASSEMBLY_CLASS.ground && n.shapes[i - 1]! >= SURFACE_ISO);
      if (!supported) continue;
      let free = 0;
      while (free < NAV_CLEARANCE_CELLS && y + free < e && !navBlocks(n, classes, i + free)) free++;
      standable.push(local);
      clearance.push(free < NAV_CLEARANCE_CELLS && y + free === e ? free | NAV_CLEARANCE_CONTINUES : free);
    }
  }
  const all = blocking === e * e * e;
  return { blocking: blocking === 0 ? OCCUPANCY.empty : all ? OCCUPANCY.solid : OCCUPANCY.mixed, blocks: blocking === 0 || all ? null : blocks, standable: Uint16Array.from(standable), clearance: Uint8Array.from(clearance) };
}

/**
 * Collision boxes: wall cells merged into vertical runs (same material),
 * runs merged along z where equal, then those slabs merged along x where
 * equal; beams and rails one partial box a cell. Ground collides against
 * its surface, liquid not at all.
 */
function collisionOf(n: Neighbourhood, classes: Uint8Array, slots: MaterialSlots): CollisionOut {
  const e = n.edge;
  const p = n.pad;
  const s = n.side;
  const S = COLLISION_STEPS_PER_CELL;
  // Slabs of one x: [y0, y1, z0, z1, slot] in cells.
  type Slab = [number, number, number, number, number];
  const boxes: number[] = [];
  const boxSlots: number[] = [];
  let prev = new Map<string, number>();
  for (let x = 0; x < e; x++) {
    const slabs: Slab[] = [];
    let open = new Map<number, Slab>();
    for (let z = 0; z < e; z++) {
      const next = new Map<number, Slab>();
      const col = ((x + p) * s + (z + p)) * s + p;
      let y = 0;
      while (y < e) {
        if ((classes[col + y]! & CLASS_MASK) !== ASSEMBLY_CLASS.wall) {
          y++;
          continue;
        }
        const slot = slots.slot(valueMaterial(n.values[col + y]!));
        let y1 = y + 1;
        while (y1 < e && (classes[col + y1]! & CLASS_MASK) === ASSEMBLY_CLASS.wall && slots.slot(valueMaterial(n.values[col + y1]!)) === slot) y1++;
        const key = (y * 64 + y1) * 65536 + slot;
        const slab = open.get(key);
        if (slab !== undefined && slab[3] === z) {
          slab[3] = z + 1;
          next.set(key, slab);
        } else {
          const fresh: Slab = [y, y1, z, z + 1, slot];
          slabs.push(fresh);
          next.set(key, fresh);
        }
        y = y1;
      }
      open = next;
    }
    // Extend last x's box where this x has the same slab, else start a box.
    const now = new Map<string, number>();
    for (const [y0, y1, z0, z1, slot] of slabs) {
      const key = `${y0},${y1},${z0},${z1},${slot}`;
      const b = prev.get(key);
      if (b !== undefined) {
        boxes[b * 6 + 3] = (x + 1) * S;
        now.set(key, b);
      } else {
        now.set(key, boxSlots.length);
        boxes.push(x * S, y0 * S, z0 * S, (x + 1) * S, y1 * S, z1 * S);
        boxSlots.push(slot);
      }
    }
    prev = now;
  }
  const fullBoxes = boxSlots.length;
  for (let x = 0; x < e; x++) for (let z = 0; z < e; z++) for (let y = 0; y < e; y++) {
    const i = ((x + p) * s + (z + p)) * s + (y + p);
    const k = classes[i]! & CLASS_MASK;
    if (k !== ASSEMBLY_CLASS.beam && k !== ASSEMBLY_CLASS.rail) continue;
    const b = partialBox(classes[i]!);
    boxes.push(x * S + b[0], y * S + b[1], z * S + b[2], x * S + b[3], y * S + b[4], z * S + b[5]);
    boxSlots.push(slots.slot(valueMaterial(n.values[i]!)));
  }
  return { boxes: Uint16Array.from(boxes), boxSlots: Uint16Array.from(boxSlots), fullBoxes };
}

function countsOf(n: Neighbourhood, classes: Uint8Array): DerivedCounts {
  const e = n.edge;
  const p = n.pad;
  const s = n.side;
  const c = { wall: 0, ground: 0, groundPartial: 0, beam: 0, rail: 0, liquid: 0 };
  for (let x = 0; x < e; x++) for (let z = 0; z < e; z++) for (let y = 0; y < e; y++) {
    const i = ((x + p) * s + (z + p)) * s + (y + p);
    switch (classes[i]! & CLASS_MASK) {
      case ASSEMBLY_CLASS.wall:
        c.wall++;
        break;
      case ASSEMBLY_CLASS.ground:
        c.ground++;
        if (n.shapes[i]! < 255) c.groundPartial++;
        break;
      case ASSEMBLY_CLASS.beam:
        c.beam++;
        break;
      case ASSEMBLY_CLASS.rail:
        c.rail++;
        break;
      case ASSEMBLY_CLASS.liquid:
        c.liquid++;
        break;
      default:
    }
  }
  return c;
}

/**
 * The result for a chunk whose evaluated region (the chunk and the
 * consumers' margin) is one voxel and one class everywhere (deep ground,
 * open sky, the inside of a wall mass): nothing to draw, nothing to stand
 * on, one value per consumer. The same arrays the general path would give,
 * without its per-cell passes; null when the region is not uniform.
 */
function uniformDerived(n: Neighbourhood, rules: AssemblyRuleSet, classes: Uint8Array): DerivedData | null {
  const e = n.edge;
  const p = n.pad;
  const s = n.side;
  const lo = p - 1;
  const hi = p + e + 1;
  const first = (lo * s + lo) * s + lo;
  const k0 = classes[first]!;
  const v0 = n.values[first]!;
  const s0 = n.shapes[first]!;
  const k = k0 & CLASS_MASK;
  if (k0 !== k || (k !== ASSEMBLY_CLASS.empty && k !== ASSEMBLY_CLASS.wall && k !== ASSEMBLY_CLASS.ground && k !== ASSEMBLY_CLASS.liquid)) return null;
  for (let x = lo; x < hi; x++) for (let z = lo; z < hi; z++) {
    const row = (x * s + z) * s;
    for (let y = lo; y < hi; y++) if (classes[row + y] !== k0 || n.values[row + y] !== v0 || n.shapes[row + y] !== s0) return null;
  }
  const cells = e * e * e;
  const solid = renderSolid(n, classes, first);
  const blocks = navBlocks(n, classes, first);
  const flag = solid ? OCCUPANCY.solid : OCCUPANCY.empty;
  const nb = e / BRICK_EDGE;
  const bricks = new Uint8Array(Math.ceil((nb * nb * nb) / 4)).fill(flag * 0x55);
  const slots = new MaterialSlots();
  const empty: SurfaceBuffer = { vertexCount: 0, slotBytes: 1, vertices: new Uint8Array(0), indices: new Uint16Array(0) };
  let boxes = new Uint16Array(0);
  let boxSlots = new Uint16Array(0);
  if (k === ASSEMBLY_CLASS.wall) {
    const S = COLLISION_STEPS_PER_CELL;
    boxes = Uint16Array.of(0, 0, 0, e * S, e * S, e * S);
    boxSlots = Uint16Array.of(slots.slot(valueMaterial(v0)));
  }
  const count = (c: number): number => (k === c ? cells : 0);
  return {
    v: DERIVED_FORMAT_VERSION,
    rules: rulesRef(rules),
    edge: e,
    materials: slots.table(),
    occupancy: { flag, bricks, mask: null },
    light: { uniform: coverage(n, classes, first), full: null, partialCells: new Uint16Array(0), partialCover: new Uint8Array(0) },
    collision: { boxes, boxSlots, fullBoxes: boxSlots.length },
    nav: { blocking: blocks ? OCCUPANCY.solid : OCCUPANCY.empty, blocks: null, standable: new Uint16Array(0), clearance: new Uint8Array(0) },
    ground: empty,
    base: { ...empty, vertices: new Uint8Array(0), indices: new Uint16Array(0) },
    instances: { count: 0, data: new Uint8Array(0) },
    shader: { palette: Uint16Array.of(shaderEntry(valueMaterial(v0), valueWetness(v0))), width: 0, ids: new Uint32Array(0) },
    counts: { wall: count(ASSEMBLY_CLASS.wall), ground: count(ASSEMBLY_CLASS.ground), groundPartial: k === ASSEMBLY_CLASS.ground && s0 < 255 ? cells : 0, beam: 0, rail: 0, liquid: count(ASSEMBLY_CLASS.liquid) },
  };
}

/** Microseconds the parts of a derive took (for measurements). */
export interface DeriveTimes {
  evaluateUs: number;
  consumersUs: number;
  meshUs: number;
}

/**
 * Derives a chunk from its filled neighbourhood (pad = jobRadius(rules)):
 * the one assembly evaluation, then every consumer's output from it.
 * Deterministic: the same voxels give the same arrays.
 */
export function deriveChunk(n: Neighbourhood, rules: AssemblyRuleSet, scratch?: Uint8Array, times?: DeriveTimes): DerivedData {
  const classes = scratch !== undefined && scratch.length === n.values.length ? scratch : new Uint8Array(n.values.length);
  const t0 = performance.now();
  evaluateAssembly(n, rules, classes);
  const t1 = performance.now();
  const uniform = uniformDerived(n, rules, classes);
  if (uniform !== null) {
    if (times !== undefined) times.evaluateUs += (t1 - t0) * 1000;
    return uniform;
  }
  const slots = new MaterialSlots();
  const ground = groundSurface(n, classes, slots);
  const base = baseSurface(n, classes, slots);
  const instances = detailInstances(n, classes, slots);
  const t2 = performance.now();
  const collision = collisionOf(n, classes, slots);
  const out: DerivedData = {
    v: DERIVED_FORMAT_VERSION,
    rules: rulesRef(rules),
    edge: n.edge,
    materials: slots.table(),
    occupancy: occupancyOf(n, classes),
    light: lightOf(n, classes),
    collision,
    nav: navOf(n, classes),
    ground,
    base,
    instances,
    shader: shaderOfNeighbourhood(n),
    counts: countsOf(n, classes),
  };
  if (times !== undefined) {
    times.evaluateUs += (t1 - t0) * 1000;
    times.meshUs += (t2 - t1) * 1000;
    times.consumersUs += (performance.now() - t2) * 1000;
  }
  return out;
}

/** Every array of a derived chunk, in a fixed order (canonical bytes, transfer lists, byte counts). */
function arraysOf(d: DerivedData): ArrayBufferView[] {
  const out: ArrayBufferView[] = [d.materials, d.occupancy.bricks];
  if (d.occupancy.mask !== null) out.push(d.occupancy.mask);
  if (d.light.full !== null) out.push(d.light.full);
  out.push(d.light.partialCells, d.light.partialCover, d.collision.boxes, d.collision.boxSlots);
  if (d.nav.blocks !== null) out.push(d.nav.blocks);
  out.push(d.nav.standable, d.nav.clearance, d.ground.vertices, d.ground.indices, d.base.vertices, d.base.indices, d.instances.data, d.shader.palette, d.shader.ids);
  return out;
}

/** The shader data of a neighbourhood's chunk cells. */
export function shaderOfNeighbourhood(n: Neighbourhood): ShaderOut {
  const e = n.edge;
  const p = n.pad;
  const s = n.side;
  const sh = Math.log2(e);
  const m = e - 1;
  return shaderDataOfValues(e * e * e, (i) => n.values[(((i >>> (sh << 1)) + p) * s + (((i >>> sh) & m) + p)) * s + ((i & m) + p)]!);
}

/** Bytes a derived chunk holds in memory (its arrays; what the streaming budget counts). */
export function derivedBytes(d: DerivedData): number {
  let n = 0;
  for (const a of arraysOf(d)) n += a.byteLength;
  return n;
}

/** Bytes per consumer (for reports). */
export function derivedPartBytes(d: DerivedData): { occupancy: number; light: number; collision: number; nav: number; ground: number; base: number; instances: number; materials: number; shader: number } {
  const b = (a: ArrayBufferView | null): number => a?.byteLength ?? 0;
  return {
    occupancy: b(d.occupancy.bricks) + b(d.occupancy.mask),
    light: b(d.light.full) + b(d.light.partialCells) + b(d.light.partialCover),
    collision: b(d.collision.boxes) + b(d.collision.boxSlots),
    nav: b(d.nav.blocks) + b(d.nav.standable) + b(d.nav.clearance),
    ground: b(d.ground.vertices) + b(d.ground.indices),
    base: b(d.base.vertices) + b(d.base.indices),
    instances: b(d.instances.data),
    materials: b(d.materials),
    shader: shaderBytes(d.shader),
  };
}

/** A derived chunk's buffers, for a postMessage transfer list. */
export function derivedTransfer(d: DerivedData, out: ArrayBuffer[] = []): ArrayBuffer[] {
  for (const a of arraysOf(d)) if (a.buffer instanceof ArrayBuffer && !out.includes(a.buffer)) out.push(a.buffer);
  return out;
}

/**
 * Canonical bytes of a derived chunk (little-endian): the header (format
 * version, edge, rules id, version and radius, the flags) then every array
 * with its length. Equal results give equal bytes; used to compare and
 * hash results, never stored.
 */
export function encodeDerived(d: DerivedData): Uint8Array {
  const id = utf8Encode(d.rules.id);
  const arrays = arraysOf(d);
  const flags = [d.v, d.edge, d.rules.version, d.rules.radius, d.occupancy.flag, d.light.uniform + 1, d.collision.fullBoxes, d.nav.blocking, d.ground.vertexCount, d.base.vertexCount, d.instances.count, d.ground.slotBytes, d.base.slotBytes, d.occupancy.mask === null ? 0 : 1, d.light.full === null ? 0 : 1, d.nav.blocks === null ? 0 : 1, d.shader.width];
  let size = 4 + id.length + 4 * flags.length;
  for (const a of arrays) size += 4 + a.byteLength;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let o = 0;
  view.setUint32(o, id.length, true);
  o += 4;
  out.set(id, o);
  o += id.length;
  for (const f of flags) {
    view.setInt32(o, f, true);
    o += 4;
  }
  for (const a of arrays) {
    view.setUint32(o, a.byteLength, true);
    o += 4;
    out.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), o);
    o += a.byteLength;
  }
  return out;
}
