/**
 * Derived data of one chunk (format v4 DRAFT): everything rebuilt from the
 * authoritative voxels for meshing, culling, physics, navigation and
 * lighting. Never committed, never saved: always rebuilt, in workers, from
 * a chunk and its apron.
 *
 * One assembly evaluation (assembly.ts) resolves the cells: their classes,
 * and with the kit rules their cases. Each consumer then reads a cell's
 * form (case-forms.ts): its case's declared coarse shape and base where it
 * has a case, its class's otherwise; ground reads its density. So the same
 * open rail is open for every consumer while the wall beside it is solid
 * for every consumer, and no consumer reads a piece mesh:
 *
 * | form / class  | render solid  | collision          | nav blocks / supports | light coverage   |
 * |---------------|---------------|--------------------|-----------------------|------------------|
 * | box (wall)    | yes           | full box           | yes / yes             | 255              |
 * | slab, panel, bar, post | no   | the shape's box    | yes / slab only       | the shape's share ({@link LIGHT_COVERAGE}) |
 * | none          | no            | none               | no / no               | 0                |
 * | ground        | density ≥ 128 | the ground surface | density ≥ 128         | its density      |
 *
 * A class without a case takes the form its class stands for: a wall the
 * box, a beam a bar, a rail a panel (a post a post).
 *
 * Representations (picked by the measurements in the phase plan):
 * - **occupancy**: a chunk flag (empty, solid, mixed), a 2-bit flag per 4³
 *   brick, and one bit per cell only for a mixed chunk;
 * - **light**: one coverage byte for a uniform chunk; otherwise one bit
 *   per fully covered cell plus a list of the partly covered cells
 *   (cell index, coverage);
 * - **collision**: boxes in 1/{@link COLLISION_STEPS_PER_CELL} cell steps
 *   (full cells merged into columns, slabs and blocks; partial shapes one a cell),
 *   plus the ground surface as the trimesh;
 * - **navigation**: a blocking bit per cell and the standable cells
 *   (cell index, clearance in cells, and whether the clearance continues
 *   into the chunk above);
 * - **meshes** (derived-mesh.ts layouts): the ground surface (the terrain
 *   mesher, terrain-mesher.ts), the base surface (base-surface.ts) and the
 *   detail-instance list;
 * - **shader data** (derived-shader.ts): the material and wetness of the
 *   chunk's cells and a border around them, for the surface shader.
 *
 * Only the shader data reads a voxel's material or wetness: every other
 * output is a function of role and shape alone, so a change of material or
 * wetness re-derives the shader data and nothing else (record.ts,
 * FIELD_FEEDS).
 *
 * A result records the format version and the rules it came from (id,
 * version, radius), so a result of other rules is never mistaken for a
 * current one.
 */
import { evaluateAssembly, rulesRef, ASSEMBLY_CLASS, CLASS_MASK, type AssemblyRulesRef, type AssemblyRuleSet, type Neighbourhood } from './assembly';
import { classForm, evaluateForms, FORM_BASE, FORM_BODY, FORM_SHAPE, FORM_STEPS, formBaseOf, formBox, formCoverage, formFoldOf, formShapeOf, formSupports } from './case-forms';
import { BRICK_EDGE } from './brick-layout';
import { baseSurface } from './base-surface';
import { detailInstances, INSTANCE_FLAG, PIECE_DETAIL, PIECE_FAMILY, PIECE_SECTION, pieceDetailAt, SURFACE_ISO, type CellPiece, type InstanceList, type SurfaceBuffer } from './derived-mesh';
import { shaderBytes, shaderOfNeighbourhood, type ShaderOut } from './derived-shader';
import { evaluateCases, evaluateRuns } from './kit-rules';
import { caseIndexOf, NO_CASE } from './kit-cases';
import { NO_SECTION, RUN_SECTION, runSectionOf } from './kit-runs';
import { defaultPiece, NO_PIECE, PIECE_VARIANT_MIRROR, pieceVariant, tablePiece, type PieceTable } from './piece-table';
import { MATERIAL_ID_MAX } from './record';
import { appendSurface, classifyRoofs, roofSurface } from './roof-mesher';
import { terrainSurface } from './terrain-mesher';
import { utf8Encode } from '@thirdlight/shared';

/**
 * Version of the derived-data layout and meaning. 4: the ground surface is
 * the terrain mesher's (vertices on the column lattice and at creases, not
 * at the mean of their crossings); the layout is v3's. 5: the ground's
 * normals: lattice vertices take the slope over 4 × 4 columns, and crease
 * vertices are split into copies carrying their quads' face normals (one
 * position may now appear in several vertices); the layout is v3's. 6: a
 * straight step's crease vertex sits on the column lattice at a column's top
 * (its true edge), not at the dual-contouring point, and the base
 * surface's coplanar faces are merged inside a section; the layout is v3's.
 * 7: a result records its chunk-tree level (0: a chunk; L: a mip node of
 * 0.5 m × 2^L cells, every position and size in the node's own cells), and
 * the canonical bytes carry it; mip nodes' shape is the share of solid.
 * 8: a mip node's material is the one its surface shows (the material of
 * the cells nearest the surface), not the dominant one; the layout is v3's.
 * 9: pieces per level: a level-1 node's pieces carry the `low` instance
 * flag, coarser nodes list none and draw those cells in the base surface;
 * a mip node's bodies hold a parent cell by their cells (half of the 8, or
 * two in a sheet), not their fill, so one-cell shells stay closed; the
 * layout is v3's.
 * 10: the job resolves every detail-bearing cell's case beside its class
 * (the kit rule set's case pass); the layout and every output are v9's.
 * 11: every consumer reads a cell's form: its case's declared shape and
 * base where it has a case (an open banister's posts and rail, a beam's
 * bar, a soffit's raised underside drawn by the base surface), its class's
 * otherwise; light coverage is the shape's share of the cell (a beam 100, a
 * rail 64, a post 16, was 128, 51, 51); pieces come from suppressed cases
 * with their case's run section; the layout is v3's.
 * 12: instances carry kit pieces: the piece u16 is kit-local (the engine's
 * default pieces family << 3 | run section, corners and junctions their own
 * sections; from piece-table.ts KIT_PIECE_BASE the own piece of the kit the
 * cell's material names, by the table's fallback order), and the reserved
 * u16 is the variant word (the variant from a hash of the world cell and
 * the kit's seed, bit 15 the case transform's mirror); a kit's piece on a
 * cell whose base stays (a moulding, a coping) is listed without
 * `replacesBase` where the cell shows; still 8 bytes an instance.
 * 13: a case window carries the same-material bit only for a catalogue
 * whose rules read it, so with the draft catalogue a cell's case transform
 * (its pieces' turns and mirror) no longer depends on its neighbours'
 * materials, and a material paint changes no piece within one kit; the
 * layout is v12's.
 * 14: a construction cell's shape is its integrity, not a fill: every
 * consumer (meshes, collision, light, navigation, cases) reads a
 * construction cell of any integrity as full, and a mip parent of a
 * construction role is intact; terrain and liquid keep their fill. Results
 * differ from v13's only where a construction cell was below 15 and in mip
 * nodes of construction; the layout is v13's.
 * 15: roofs laid as 45° stairs are drawn as sloped planes (roof-mesher.ts):
 * their cells' voxel faces, collision boxes and pieces are left out, the
 * planes are appended to the base surface (same vertex layout), and the
 * collision carries them as a ramp mesh (`collision.ramps`, a new array in
 * the canonical bytes, and its vertex count a new header flag); light,
 * occupancy and navigation still read the stair voxels. Results differ from
 * v14's only round roof cells.
 */
export const DERIVED_FORMAT_VERSION = 15;

/** Chunk and brick occupancy flags. */
export const OCCUPANCY = Object.freeze({ empty: 0, solid: 1, mixed: 2 });

/** Collision box steps per cell: the declared shapes' steps (1/16 cell ≈ 3 cm), so a shape's box is a collision box. */
export const COLLISION_STEPS_PER_CELL = FORM_STEPS;

/** Standing room a standable cell's clearance counts up to (4 cells = 2 m). */
export const NAV_CLEARANCE_CELLS = 4;

/** Clearance bit: the free run reaches the chunk's top before {@link NAV_CLEARANCE_CELLS}; read on in the chunk above. */
export const NAV_CLEARANCE_CONTINUES = 0x80;

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
  /** How many leading boxes are full-cell merges (the rest are partial shapes). */
  readonly fullBoxes: number;
  /** The roof planes as a triangle mesh (the derive's surface layout): a roof collides as the ramp it is drawn as, not as its stair. */
  readonly ramps: SurfaceBuffer;
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
  /**
   * The chunk-tree level it was derived at (voxel-mips.ts): 0 for a chunk,
   * L for a mip node. Every position, box and cell index is in the level's
   * cells ({@link mipCellMetres}), so one mesher and one layout serve every
   * level and only the scale to metres differs.
   */
  readonly level: number;
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

/** Ground filled to the surface: solid for every consumer. */
function solidGround(n: Neighbourhood, classes: Uint8Array, i: number): boolean {
  return (classes[i]! & CLASS_MASK) === ASSEMBLY_CLASS.ground && n.shapes[i]! >= SURFACE_ISO;
}

/** Whether a cell is solid for rendering and culling: a whole-box form, or ground. */
function renderSolid(n: Neighbourhood, classes: Uint8Array, forms: Uint8Array, i: number): boolean {
  return formShapeOf(forms[i]!) === FORM_SHAPE.box || solidGround(n, classes, i);
}

/** Whether a cell blocks movement: any shape, or ground. */
function navBlocks(n: Neighbourhood, classes: Uint8Array, forms: Uint8Array, i: number): boolean {
  return formShapeOf(forms[i]!) !== FORM_SHAPE.none || solidGround(n, classes, i);
}

/** Light coverage of a cell: its shape's share, or ground's density. */
function coverage(n: Neighbourhood, classes: Uint8Array, forms: Uint8Array, i: number): number {
  return (classes[i]! & CLASS_MASK) === ASSEMBLY_CLASS.ground ? n.shapes[i]! : formCoverage(forms[i]!);
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

function occupancyOf(n: Neighbourhood, classes: Uint8Array, forms: Uint8Array): OccupancyOut {
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
      if (!renderSolid(n, classes, forms, ((x + p) * s + (z + p)) * s + (y + p))) continue;
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

function lightOf(n: Neighbourhood, classes: Uint8Array, forms: Uint8Array): LightOut {
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
    const c = coverage(n, classes, forms, ((x + p) * s + (z + p)) * s + (y + p));
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

function navOf(n: Neighbourhood, classes: Uint8Array, forms: Uint8Array): NavOut {
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
      if (navBlocks(n, classes, forms, i)) {
        setBit(blocks, local);
        blocking++;
        continue;
      }
      if (!formSupports(forms[i - 1]!) && !solidGround(n, classes, i - 1)) continue;
      let free = 0;
      while (free < NAV_CLEARANCE_CELLS && y + free < e && !navBlocks(n, classes, forms, i + free)) free++;
      standable.push(local);
      clearance.push(free < NAV_CLEARANCE_CELLS && y + free === e ? free | NAV_CLEARANCE_CONTINUES : free);
    }
  }
  const all = blocking === e * e * e;
  return { blocking: blocking === 0 ? OCCUPANCY.empty : all ? OCCUPANCY.solid : OCCUPANCY.mixed, blocks: blocking === 0 || all ? null : blocks, standable: Uint16Array.from(standable), clearance: Uint8Array.from(clearance) };
}

/**
 * Collision boxes: whole-box cells merged into vertical runs, runs merged
 * along z where equal, then those slabs merged along x where equal; every
 * other shape (a beam's bar, a rail's panel, a post, a soffit's slab) one
 * box a cell, its declared shape's. Ground collides against its surface,
 * liquid not at all. Boxes carry no material (a physics material comes from
 * the shader data's cell, where a game needs one), so a material change
 * leaves them as they are.
 */
function collisionOf(n: Neighbourhood, forms: Uint8Array, roofs: Uint32Array, ramps: SurfaceBuffer): CollisionOut {
  const e = n.edge;
  const p = n.pad;
  const s = n.side;
  const S = COLLISION_STEPS_PER_CELL;
  // Slabs of one x: [y0, y1, z0, z1] in cells.
  type Slab = [number, number, number, number];
  const boxes: number[] = [];
  let count = 0;
  let prev = new Map<string, number>();
  for (let x = 0; x < e; x++) {
    const slabs: Slab[] = [];
    let open = new Map<number, Slab>();
    for (let z = 0; z < e; z++) {
      const next = new Map<number, Slab>();
      const col = ((x + p) * s + (z + p)) * s + p;
      let y = 0;
      while (y < e) {
        if (formShapeOf(forms[col + y]!) !== FORM_SHAPE.box || roofs[col + y] !== 0) {
          y++;
          continue;
        }
        let y1 = y + 1;
        while (y1 < e && formShapeOf(forms[col + y1]!) === FORM_SHAPE.box && roofs[col + y1] === 0) y1++;
        const key = y * 64 + y1;
        const slab = open.get(key);
        if (slab !== undefined && slab[3] === z) {
          slab[3] = z + 1;
          next.set(key, slab);
        } else {
          const fresh: Slab = [y, y1, z, z + 1];
          slabs.push(fresh);
          next.set(key, fresh);
        }
        y = y1;
      }
      open = next;
    }
    // Extend last x's box where this x has the same slab, else start a box.
    const now = new Map<string, number>();
    for (const [y0, y1, z0, z1] of slabs) {
      const key = `${y0},${y1},${z0},${z1}`;
      const b = prev.get(key);
      if (b !== undefined) {
        boxes[b * 6 + 3] = (x + 1) * S;
        now.set(key, b);
      } else {
        now.set(key, count++);
        boxes.push(x * S, y0 * S, z0 * S, (x + 1) * S, y1 * S, z1 * S);
      }
    }
    prev = now;
  }
  const fullBoxes = count;
  const b = [0, 0, 0, 0, 0, 0];
  for (let x = 0; x < e; x++) for (let z = 0; z < e; z++) for (let y = 0; y < e; y++) {
    const i = ((x + p) * s + (z + p)) * s + (y + p);
    const f = forms[i]!;
    if (formShapeOf(f) === FORM_SHAPE.box || roofs[i] !== 0 || !formBox(f, b)) continue;
    boxes.push(x * S + b[0]!, y * S + b[1]!, z * S + b[2]!, x * S + b[3]!, y * S + b[4]!, z * S + b[5]!);
  }
  return { boxes: Uint16Array.from(boxes), fullBoxes, ramps };
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
 * consumers' margin) is one class and one shape everywhere (deep ground,
 * open sky, the inside of a wall mass): nothing to draw, nothing to stand
 * on, one value per consumer. The same arrays the general path would give,
 * without its per-cell passes; null when the region is not uniform. Material
 * and wetness do not decide it (only the shader data reads them), so a
 * material change never moves a chunk between the two paths.
 */
function uniformDerived(n: Neighbourhood, rules: AssemblyRuleSet, classes: Uint8Array, level: number): DerivedData | null {
  const e = n.edge;
  const p = n.pad;
  const s = n.side;
  const lo = p - 1;
  const hi = p + e + 1;
  const first = (lo * s + lo) * s + lo;
  const k0 = classes[first]!;
  const s0 = n.shapes[first]!;
  const k = k0 & CLASS_MASK;
  if (k0 !== k || (k !== ASSEMBLY_CLASS.empty && k !== ASSEMBLY_CLASS.wall && k !== ASSEMBLY_CLASS.ground && k !== ASSEMBLY_CLASS.liquid)) return null;
  for (let x = lo; x < hi; x++) for (let z = lo; z < hi; z++) {
    const row = (x * s + z) * s;
    for (let y = lo; y < hi; y++) if (classes[row + y] !== k0 || n.shapes[row + y] !== s0) return null;
  }
  const cells = e * e * e;
  // A uniform region holds no case of another form than its class's (deriveChunk checks a body region's cases).
  const form = classForm(k0);
  const ground = k === ASSEMBLY_CLASS.ground && s0 >= SURFACE_ISO;
  const solid = formShapeOf(form) === FORM_SHAPE.box || ground;
  const blocks = formShapeOf(form) !== FORM_SHAPE.none || ground;
  const flag = solid ? OCCUPANCY.solid : OCCUPANCY.empty;
  const nb = e / BRICK_EDGE;
  const bricks = new Uint8Array(Math.ceil((nb * nb * nb) / 4)).fill(flag * 0x55);
  const empty: SurfaceBuffer = { vertexCount: 0, vertices: new Uint8Array(0), indices: new Uint16Array(0) };
  let boxes = new Uint16Array(0);
  if (k === ASSEMBLY_CLASS.wall) {
    const S = COLLISION_STEPS_PER_CELL;
    boxes = Uint16Array.of(0, 0, 0, e * S, e * S, e * S);
  }
  const count = (c: number): number => (k === c ? cells : 0);
  return {
    v: DERIVED_FORMAT_VERSION,
    rules: rulesRef(rules),
    edge: e,
    level,
    occupancy: { flag, bricks, mask: null },
    light: { uniform: k === ASSEMBLY_CLASS.ground ? s0 : formCoverage(form), full: null, partialCells: new Uint16Array(0), partialCover: new Uint8Array(0) },
    collision: { boxes, fullBoxes: boxes.length / 6, ramps: { ...empty, vertices: new Uint8Array(0), indices: new Uint16Array(0) } },
    nav: { blocking: blocks ? OCCUPANCY.solid : OCCUPANCY.empty, blocks: null, standable: new Uint16Array(0), clearance: new Uint8Array(0) },
    ground: empty,
    base: { ...empty, vertices: new Uint8Array(0), indices: new Uint16Array(0) },
    instances: { count: 0, data: new Uint8Array(0) },
    shader: shaderOfNeighbourhood(n),
    counts: { wall: count(ASSEMBLY_CLASS.wall), ground: count(ASSEMBLY_CLASS.ground), groundPartial: k === ASSEMBLY_CLASS.ground && s0 < 255 ? cells : 0, beam: 0, rail: 0, liquid: count(ASSEMBLY_CLASS.liquid) },
  };
}

/** Per thread, by neighbourhood size: the cells' cases and run sections (a u16 each a cell beside the class byte) and forms (a byte) of the derive running. */
const caseScratches = new Map<number, Uint16Array>();
const runScratches = new Map<number, Uint16Array>();
const formScratches = new Map<number, Uint8Array>();
const roofScratches = new Map<number, Uint32Array>();

function u16Scratch(map: Map<number, Uint16Array>, len: number): Uint16Array {
  let a = map.get(len);
  if (a === undefined) {
    a = new Uint16Array(len);
    map.set(len, a);
  }
  return a;
}

/** The default piece's stand-in family for each declared shape a piece replaces (0: none). */
const SHAPE_FAMILY = new Uint8Array(8);
SHAPE_FAMILY[FORM_SHAPE.bar] = PIECE_FAMILY.beam;
SHAPE_FAMILY[FORM_SHAPE.panel] = PIECE_FAMILY.rail;
SHAPE_FAMILY[FORM_SHAPE.post] = PIECE_FAMILY.post;

/**
 * The kit pieces a derive chooses from: the world's piece table (null: no
 * kit binds a material, every cell draws the default pieces) and the
 * derive unit's first cell in world cells of its level (what a variant's
 * hash reads, so a cell keeps its variant whichever chunk, section or job
 * derives it).
 */
export interface DerivePieces {
  readonly table: PieceTable | null;
  readonly origin: readonly [number, number, number];
}

const NO_PIECES: DerivePieces = Object.freeze({ table: null, origin: [0, 0, 0] as const });

/** What one derive's piece choice reads (built once a derive). */
interface PieceInputs {
  readonly n: Neighbourhood;
  readonly classes: Uint8Array;
  readonly forms: Uint8Array;
  readonly cases: Uint16Array;
  readonly runs: Uint16Array;
  readonly pieces: DerivePieces;
  readonly level: number;
  /** Roof plane words (roof-mesher.ts): a plane cell takes no piece. */
  readonly roofs: Uint32Array;
}

/** Whether a cell whose base surface stays shows: an opening, or a body with a face against a cell that is not solid. */
function shows(p: PieceInputs, i: number): boolean {
  if (formShapeOf(p.forms[i]!) !== FORM_SHAPE.box) return true;
  const s = p.n.side;
  const solid = (j: number): boolean => renderSolid(p.n, p.classes, p.forms, j);
  return !solid(i + 1) || !solid(i - 1) || !solid(i + s) || !solid(i - s) || !solid(i + s * s) || !solid(i - s * s);
}

/**
 * The piece of padded cell `i` (local x, y, z) into `out`, or false: the
 * own piece of the kit its material names, by its case and run section
 * (piece-table.ts's fallback order), where the kit has one and the cell
 * shows; else, where its form leaves the base to a piece (a beam, a
 * banister's rail and posts), the engine's default piece for its declared
 * shape and run section, or for a cell without a case (rule sets without a
 * case pass), its section from the neighbours along its run with the same
 * class byte. Turns, and the mirror bit, come from its case's transform.
 */
function pieceAt(p: PieceInputs, i: number, x: number, y: number, z: number, out: CellPiece): boolean {
  if (p.roofs[i] !== 0) return false;
  const f = p.forms[i]!;
  const base = formBaseOf(f);
  const fold = formFoldOf(f);
  const packed = p.cases[i]!;
  const run = p.runs[i]!;
  const table = p.pieces.table;
  out.turns = fold & 3;
  out.flags = base === FORM_BASE.suppress ? INSTANCE_FLAG.replacesBase : 0;
  const mirror = fold >= 4 ? PIECE_VARIANT_MIRROR : 0;
  if (table !== null && packed !== NO_CASE) {
    const mat = p.n.values[i]! & MATERIAL_ID_MAX;
    const piece = tablePiece(table, mat, caseIndexOf(packed), run === NO_SECTION ? RUN_SECTION.single : runSectionOf(run));
    if (piece !== NO_PIECE && (base !== FORM_BASE.keep || shows(p, i))) {
      const o = p.pieces.origin;
      out.piece = piece;
      out.variant = pieceVariant(table, mat, piece, p.level, o[0] + x, o[1] + y, o[2] + z) | mirror;
      return true;
    }
  }
  if (base !== FORM_BASE.suppress) return false;
  const family = SHAPE_FAMILY[formShapeOf(f)]!;
  if (family === 0) return false;
  let section: number = PIECE_SECTION.single;
  if (run !== NO_SECTION) section = runSectionOf(run);
  else if (family !== PIECE_FAMILY.post) {
    // Along the run: x unturned or half turned, z otherwise.
    const s = p.n.side;
    const step = (fold & 1) === 0 ? s * s : s;
    const k = p.classes[i]!;
    const prev = p.classes[i - step] === k;
    const next = p.classes[i + step] === k;
    section = prev && next ? PIECE_SECTION.body : next ? PIECE_SECTION.start : prev ? PIECE_SECTION.end : PIECE_SECTION.single;
  }
  out.piece = defaultPiece(family, section);
  out.variant = mirror;
  return true;
}

/** Whether every cell the consumers read of a uniform body region keeps the body's form once its case is resolved. */
function bodyFormsOnly(n: Neighbourhood, rules: AssemblyRuleSet, classes: Uint8Array, cases: Uint16Array, forms: Uint8Array, level: number): boolean {
  evaluateCases(n, rules, level, cases);
  evaluateForms(n, rules, classes, cases, forms);
  const s = n.side;
  const lo = n.pad - 1;
  const hi = n.pad + n.edge + 1;
  for (let x = lo; x < hi; x++) for (let z = lo; z < hi; z++) {
    const row = (x * s + z) * s;
    for (let y = lo; y < hi; y++) if (forms[row + y] !== FORM_BODY) return false;
  }
  return true;
}

/** A fresh empty surface (never shared: a result's buffers are transferred to the thread that draws). */
function emptySurface(): SurfaceBuffer {
  return { vertexCount: 0, vertices: new Uint8Array(0), indices: new Uint16Array(0) };
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
 * Deterministic: the same voxels give the same arrays. A mip node derives
 * the same way from its own cells (`level` > 0): the rule set's thresholds
 * and the mesher read cells, whatever their size.
 */
export function deriveChunk(n: Neighbourhood, rules: AssemblyRuleSet, scratch?: Uint8Array, times?: DeriveTimes, level = 0, pieces: DerivePieces = NO_PIECES): DerivedData {
  if (!Number.isInteger(level) || level < 0) throw new RangeError(`derive: level ${level}`);
  const table = pieces.table;
  if (table !== null && (table.rules.id !== rules.id || table.rules.version !== rules.version)) throw new RangeError(`derive: a piece table of rules ${table.rules.id} v${table.rules.version} for rules ${rules.id} v${rules.version}`);
  const classes = scratch !== undefined && scratch.length === n.values.length ? scratch : new Uint8Array(n.values.length);
  const t0 = performance.now();
  evaluateAssembly(n, rules, classes);
  const uniform = uniformDerived(n, rules, classes, level);
  const cases = u16Scratch(caseScratches, classes.length);
  let forms = formScratches.get(classes.length);
  if (forms === undefined) formScratches.set(classes.length, (forms = new Uint8Array(classes.length)));
  // A uniform region (one class and shape: deep ground, open sky, the inside of a mass) draws no piece, so it
  // resolves no cases, unless it is a body whose cells could still have cases of another form than the box
  // (a margin cell's case reads cells past the region): those are checked, and any such form takes the general path.
  if (uniform !== null && (uniform.counts.wall === 0 || rules.resolveCases === undefined || bodyFormsOnly(n, rules, classes, cases, forms, level))) {
    if (times !== undefined) times.evaluateUs += (performance.now() - t0) * 1000;
    return uniform;
  }
  // Cases, run sections and forms stay in this job, read by the consumers beside the classes.
  const runs = u16Scratch(runScratches, classes.length);
  evaluateRuns(n, rules, cases, runs, evaluateCases(n, rules, level, cases));
  evaluateForms(n, rules, classes, cases, forms);
  const t1 = performance.now();
  const ground = terrainSurface(n, classes);
  const detail = pieceDetailAt(level);
  let roofs = roofScratches.get(classes.length);
  if (roofs === undefined) roofScratches.set(classes.length, (roofs = new Uint32Array(classes.length)));
  const ramps = classifyRoofs(n, roofs) === 0 ? emptySurface() : roofSurface(n, roofs);
  const base = appendSurface(baseSurface(n, classes, forms, detail === PIECE_DETAIL.none, roofs), ramps);
  const inputs: PieceInputs = { n, classes, forms, cases, runs, pieces, level, roofs };
  const instances = detailInstances(n, (i, x, y, z, out) => pieceAt(inputs, i, x, y, z, out), detail);
  const t2 = performance.now();
  const collision = collisionOf(n, forms, roofs, ramps);
  const out: DerivedData = {
    v: DERIVED_FORMAT_VERSION,
    rules: rulesRef(rules),
    edge: n.edge,
    level,
    occupancy: occupancyOf(n, classes, forms),
    light: lightOf(n, classes, forms),
    collision,
    nav: navOf(n, classes, forms),
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
  const out: ArrayBufferView[] = [d.occupancy.bricks];
  if (d.occupancy.mask !== null) out.push(d.occupancy.mask);
  if (d.light.full !== null) out.push(d.light.full);
  out.push(d.light.partialCells, d.light.partialCover, d.collision.boxes, d.collision.ramps.vertices, d.collision.ramps.indices);
  if (d.nav.blocks !== null) out.push(d.nav.blocks);
  out.push(d.nav.standable, d.nav.clearance, d.ground.vertices, d.ground.indices, d.base.vertices, d.base.indices, d.instances.data, d.shader.palette, d.shader.ids);
  return out;
}

/** Bytes a derived chunk holds in memory (its arrays; what the streaming budget counts). */
export function derivedBytes(d: DerivedData): number {
  let n = 0;
  for (const a of arraysOf(d)) n += a.byteLength;
  return n;
}

/** Bytes per consumer (for reports). */
export function derivedPartBytes(d: DerivedData): { occupancy: number; light: number; collision: number; nav: number; ground: number; base: number; instances: number; shader: number } {
  const b = (a: ArrayBufferView | null): number => a?.byteLength ?? 0;
  return {
    occupancy: b(d.occupancy.bricks) + b(d.occupancy.mask),
    light: b(d.light.full) + b(d.light.partialCells) + b(d.light.partialCover),
    collision: b(d.collision.boxes) + b(d.collision.ramps.vertices) + b(d.collision.ramps.indices),
    nav: b(d.nav.blocks) + b(d.nav.standable) + b(d.nav.clearance),
    ground: b(d.ground.vertices) + b(d.ground.indices),
    base: b(d.base.vertices) + b(d.base.indices),
    instances: b(d.instances.data),
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
  const flags = [d.v, d.edge, d.rules.version, d.rules.radius, d.occupancy.flag, d.light.uniform + 1, d.collision.fullBoxes, d.nav.blocking, d.ground.vertexCount, d.base.vertexCount, d.instances.count, d.shader.side, d.occupancy.mask === null ? 0 : 1, d.light.full === null ? 0 : 1, d.nav.blocks === null ? 0 : 1, d.shader.width, d.level, d.collision.ramps.vertexCount];
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
