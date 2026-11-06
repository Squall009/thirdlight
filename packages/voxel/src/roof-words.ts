/**
 * Which roof cells the roof mesher draws as sloped planes, and how: a
 * **plane cell**'s word (rising directions, slope, phases, support, roof
 * edges). roof-mesher.ts draws the planes from these words; derive-pieces.ts
 * places the roof-edge pieces they name.
 *
 * **Slopes.** A sloped roof is laid as a stair of roof cells drawn whole
 * (intact, or cracked: damage stage 1 of their kit, or an integrity the kit
 * leaves out of every stage) with nothing solid above them, at one of two
 * slopes:
 * - **45°** (steep): each cell one up and one across from the next. A cell
 *   rises toward a direction d when a roof cell sits one up and one across
 *   in d, or one down and one across against d; with none such, a diagonal
 *   one gives the two directions of a hip's eave corner. A single-direction
 *   cell with a roof cell beside it at its own level on its low side is a
 *   flatter stair, not 45°.
 * - **1:2** (shallow, about 26.6°): two cells along at a level, then one up.
 *   Each cell of a pair carries a **phase** for each direction it rises
 *   toward: 0 for the pair's low cell (its plane rises from its voxel's top
 *   to half a cell above it), 1 for the high cell (from half a cell up to a
 *   whole one). At one cell's reach the high cell of a pair at a ridge
 *   cannot be told from a flat roof's edge, so a shallow reading looks two
 *   cells along each way ({@link ROOF_PLANE_REACH}): every direction is
 *   fitted to the 1:2 stair of either phase (cells where the stair puts
 *   them count for it; a cell a step steeper than the stair, ahead or
 *   behind, rules the phase out; fewer than two agreeing cells is no
 *   reading), and a cell rising no way on an axis is read along the
 *   diagonals (a 1:2 hip's eave corners).
 *
 * A cell is read at 45° first, exactly as a 45° roof always was; it is read
 * as 1:2 instead when there is none, when the 45° reading was the flatter
 * stair, or when a cell two along says the stair is 1:2 (the cell behind
 * and the one behind that both one down; on a diagonal, one up and one up
 * again two along with a cell at its own level behind it), and then keeps
 * its voxel faces when the 1:2 reading finds nothing. **One slope a roof:** a cell's
 * directions are all 45° or all 1:2, so hips and valleys join equal slopes
 * only (default chosen, owner to confirm: a roof never mixes its slopes).
 * A 1:2 direction whose plane lies over another of the cell's planes
 * everywhere (a ridge pair of an even 1:2 gable reads both ways) is dropped.
 * A cell with two neighbouring directions is a **valley** (its planes meet
 * concave, the highest of them) when both stairs go on upward from it (at
 * 1:2, two cells along each way), else a hip (the lowest).
 *
 * A roof cell at a hole stage (2 or 3 of its kit) is not drawn: it is a hole
 * in the roof, and the cells round it read the roof without it. Every cell
 * read neither way keeps its voxel faces (the mandatory fallback), so a roof
 * never disappears. A cracked plane cell stays in its plane and the planes
 * carry its crack (roof-mesher.ts).
 *
 * **Support.** Where the roof cell's kit fills wall tops (its `wallTopFill`;
 * no kit: no), a plane cell over a body (any solid construction cell drawn
 * as a voxel, intact or cracked), or over one air cell over a body, is **supported**:
 * the body's top is cut to the roof's underside, so the roof's slab closes
 * down onto the body (a gable's end wall up under its verge, an eave wall
 * up to the slope inside the attic) and no voxel step shows under the
 * roof, inside or out. The underside drawn anywhere else, and everywhere
 * without the fill, is the plane one cell below the top: the walls under it
 * keep their stepped tops.
 *
 * **Roof edges** (what kit pieces dress): an eave on a low side open below
 * and in front, a verge (gable edge) on a side along the slope's level line
 * open beside it, a ridge where a plane meets the other slope (owned by the
 * cell rising toward +x or +z) or along a cell's middle, a hip where two
 * planes meet convex, a valley where they meet concave.
 */
import { OPEN_ROLE, type Neighbourhood } from './assembly';
import { SURFACE_ISO } from './derived-mesh';
import { DAMAGE_STAGE } from './damage-stages';
import { cellWallTopFill, damageStageOf, type PieceTable } from './piece-table';
import { MATERIAL_AIR, ROLE_MASK, ROLE_SHIFT, valueMaterial, valueShape, VOXEL_ROLE } from './record';

/** How far (Chebyshev, cells) whether a cell is a plane cell reads: a 1:2 stair's pair is told apart two cells along. */
export const ROOF_PLANE_REACH = 2;

/** Cells past the job the roof mesher reads: the plane cells round it and what decides them. */
export const ROOF_MESHER_REACH = ROOF_PLANE_REACH + 1;

/**
 * A plane cell's word: bits 0–3 the directions it rises toward (bit k:
 * {@link ROOF_DIR} k), then flags, then per side k (the side facing
 * direction k) its roof edges, then per direction its 1:2 phase. 0: not a
 * plane cell.
 */
export const ROOF_WORD = Object.freeze({
  dirs: 0x0f,
  /** Its planes meet concave (a valley): the highest of them. */
  concave: 0x10,
  /** A body carries it (directly, or across one air cell, {@link ROOF_WORD.gap}): its slab closes down onto the body's top. */
  supported: 0x20,
  /** Its slopes are 1:2 (one cell up every two along); without it, 45°. */
  shallow: 0x40,
  /** Supported across one air cell: the body's top is a cell below the voxel's floor. */
  gap: 0x80,
  /** Shift of the 4 eave-side bits. */
  eaveShift: 8,
  /** Shift of the 4 verge-side bits. */
  vergeShift: 12,
  /** Shift of the 4 ridge-side bits (a ridge on that side, owned here). */
  ridgeShift: 16,
  /** A ridge along the cell's middle (rising both ways along one axis). */
  centreRidge: 0x100000,
  /** Shift of the 4 phase bits (bit k: the cell is the high cell of its 1:2 pair rising toward k). */
  phaseShift: 21,
});

/** Horizontal directions in yaw order (a quarter turn takes one to the next): +x, +z, −x, −z. */
export const ROOF_DIR = Object.freeze({ px: 0, pz: 1, nx: 2, nz: 3 });
export const ROOF_DX = Object.freeze([1, 0, -1, 0] as const);
export const ROOF_DZ = Object.freeze([0, 1, 0, -1] as const);

/** The roof-edge cases a plane cell's word names, for kit pieces (the catalogue's ids). */
export type RoofEdgeCase = 'roof-ridge' | 'roof-eave' | 'roof-gable' | 'roof-hip' | 'roof-valley';

/** Every roof-edge case, in a fixed order. */
export const ROOF_EDGE_CASE_IDS: readonly RoofEdgeCase[] = Object.freeze(['roof-ridge', 'roof-eave', 'roof-gable', 'roof-hip', 'roof-valley']);

/**
 * One roof-edge piece of a plane cell. Yaw (quarter turns about +y, +x to
 * +z) places the case's own orientation: an eave open toward +z, its plane
 * rising toward −z; a verge open toward +z, its plane rising toward +x; a
 * ridge running along x on the cell's +z side, its plane rising toward +z;
 * a hip or valley running from the cell's +x, +z corner (the low one) up to
 * its −x, −z corner. The two verges of a gable rise in opposite senses seen
 * from outside, which no quarter turn of one mesh gives: the verge rising
 * toward its own −x is `mirror` (drawn by the verge mesh mirrored across
 * x = 0, piece-table.ts `PIECE_VARIANT_MIRROR`), so one verge mesh follows
 * the slope on both sides. A ridge along the cell's middle is `centred`
 * (moved half a cell in from the side its yaw names and half a cell down:
 * the middle of a 45° cell is half a cell below its high side). On a cell
 * rising three or four ways (the apex at a hip roof's ridge end, a
 * pyramid's top) the ridge runs from the cell's middle on, toward the side
 * the cell rises toward, and each hip from its low corner up to the middle:
 * those are `half` (drawn over the half of their run on the case's +x side,
 * piece-placement.ts `pieceHalfRun`; the ridge's yaw points that way).
 *
 * A piece of a 1:2 roof is `shallow`, with the `high` phase of the plane it
 * follows: one mesh serves both slopes, the renderer pitches it onto the
 * 1:2 plane at the height the phase gives (piece-placement.ts
 * `roofPitch`).
 */
export interface RoofEdge {
  readonly caseId: RoofEdgeCase;
  readonly yaw: number;
  readonly centred?: true;
  readonly mirror?: true;
  readonly half?: true;
  readonly shallow?: true;
  readonly high?: true;
}

function bits4(m: number): number {
  return (m & 1) + ((m >>> 1) & 1) + ((m >>> 2) & 1) + ((m >>> 3) & 1);
}

/** Whether direction k of a word is the high cell of its 1:2 pair. */
function phaseOf(word: number, k: number): number {
  return (word >>> (ROOF_WORD.phaseShift + k)) & 1;
}

/** The roof-edge pieces a plane cell's word names. */
export function roofEdgesOf(word: number): RoofEdge[] {
  const out: RoofEdge[] = [];
  const dirs = word & ROOF_WORD.dirs;
  if (dirs === 0) return out;
  const shallow = (word & ROOF_WORD.shallow) !== 0;
  // A piece on a 1:2 roof names the phase of the plane it follows.
  const pitch = (k: number): { shallow?: true; high?: true } => (!shallow ? {} : phaseOf(word, k) === 1 ? { shallow: true, high: true } : { shallow: true });
  for (let k = 0; k < 4; k++) {
    const yaw = (k + 3) & 3;
    // An eave on side k is the low side of the direction rising away from it.
    if (((word >>> (ROOF_WORD.eaveShift + k)) & 1) !== 0) out.push({ caseId: 'roof-eave', yaw, ...pitch((k + 2) & 3) });
    // A verge is on a single-direction cell: at yaw k + 3 the case's +x is the direction k − 1, so the verge on the
    // side after the rise (k = rise + 1) rises toward its +x, the one before it (k = rise − 1) toward its −x.
    if (((word >>> (ROOF_WORD.vergeShift + k)) & 1) !== 0) {
      const rise = ((dirs >>> ((k + 1) & 3)) & 1) !== 0 ? (k + 1) & 3 : (k + 3) & 3;
      out.push(rise === ((k + 1) & 3) ? { caseId: 'roof-gable', yaw, mirror: true, ...pitch(rise) } : { caseId: 'roof-gable', yaw, ...pitch(rise) });
    }
    if (((word >>> (ROOF_WORD.ridgeShift + k)) & 1) !== 0) out.push({ caseId: 'roof-ridge', yaw, ...pitch(k) });
  }
  const apex = bits4(dirs) >= 3 && (word & ROOF_WORD.concave) === 0;
  if ((word & ROOF_WORD.centreRidge) !== 0) {
    const across = (dirs & 0b0101) === 0b0101 ? 0b0101 : 0b1010;
    // An apex's ridge points (case +x) toward the one way it rises along the ridge: the ridge goes on that way.
    const on = dirs & ~across & ROOF_WORD.dirs;
    const k = across === 0b0101 ? 0 : 1;
    out.push(apex ? { caseId: 'roof-ridge', yaw: on === 1 ? 0 : on === 2 ? 1 : on === 4 ? 2 : 3, centred: true, half: true, ...pitch(k) } : { caseId: 'roof-ridge', yaw: across === 0b0101 ? 3 : 0, centred: true, ...pitch(k) });
  }
  for (let a = 0; a < 4; a++) {
    const b = (a + 1) & 3;
    if (((dirs >>> a) & 1) === 0 || ((dirs >>> b) & 1) === 0) continue;
    if ((word & ROOF_WORD.concave) !== 0) out.push({ caseId: 'roof-valley', yaw: (a + 2) & 3, ...pitch(a) });
    else out.push(apex ? { caseId: 'roof-hip', yaw: (a + 2) & 3, half: true, ...pitch(a) } : { caseId: 'roof-hip', yaw: (a + 2) & 3, ...pitch(a) });
  }
  return out;
}

/** Whether the cell (dx, dy, dz) from the one being read is an intact roof cell. */
export type RoofProbe = (dx: number, dy: number, dz: number) => boolean;

/** The steep reading's outcome when a single-direction cell has a roof cell at its own level on its low side. */
const FLATTER = -1;

/** Whether the last {@link steepDirs} read its directions off a diagonal (no axis neighbour rises). */
let steepDiagonal = false;

/** The 45° reading: the directions (bits), {@link FLATTER}, or 0. */
function steepDirs(r: RoofProbe): number {
  let dirs = 0;
  steepDiagonal = false;
  for (let k = 0; k < 4; k++) if (r(ROOF_DX[k]!, 1, ROOF_DZ[k]!) || r(-ROOF_DX[k]!, -1, -ROOF_DZ[k]!)) dirs |= 1 << k;
  if (dirs === 0) {
    for (let k = 0; k < 4; k++) {
      const j = (k + 1) & 3;
      const dx = ROOF_DX[k]! + ROOF_DX[j]!;
      const dz = ROOF_DZ[k]! + ROOF_DZ[j]!;
      if (r(dx, 1, dz) || r(-dx, -1, -dz)) {
        if (dirs !== 0) return 0;
        dirs = (1 << k) | (1 << j);
      }
    }
    steepDiagonal = dirs !== 0;
    return dirs;
  }
  if (bits4(dirs) === 1) for (let k = 0; k < 4; k++) if (((dirs >>> k) & 1) !== 0 && r(-ROOF_DX[k]!, 0, -ROOF_DZ[k]!)) return FLATTER;
  return dirs;
}

/** Whether a 45° reading's direction along (sx, sz) has a cell two along that says the stair is 1:2. */
function looksShallow(r: RoofProbe, sx: number, sz: number, diagonal: boolean): boolean {
  // The cell behind and the one behind that both one down: two cells a level, as a 1:2 stair has them, and so in
  // a column beside it on its own level (a 1:2 slope runs on along its level line). A 45° stair has the second two
  // down; where it meets the other slope of a valley or an L's arm (or goes on up ahead, beside a valley line) one
  // column alone can look so.
  if (r(-sx, -1, -sz) && r(-2 * sx, -1, -2 * sz) && !r(sx, 1, sz)) {
    // On a diagonal (a valley where the arms of an L meet) the columns beside it lie on the other planes.
    if (diagonal) return true;
    for (const side of [1, -1]) {
      const lx = side * sz;
      const lz = -side * sx;
      if (r(lx, 0, lz) && r(lx - sx, -1, lz - sz) && r(lx - 2 * sx, -1, lz - 2 * sz)) return true;
    }
  }
  // On a diagonal (a 1:2 hip's corner cell, which reads no axis): one up, again one up two along, and a cell at its
  // own level behind it, the high cell of a 1:2 pair. A 45° stair has the cell two along two up.
  return diagonal && r(sx, 1, sz) && r(2 * sx, 1, 2 * sz) && r(-sx, 0, -sz);
}

/**
 * Whether a 45° reading of two neighbouring directions (sa, sb) is the high cell of a 1:2 valley: along each, one
 * up and again one up two along, a cell at its own level behind, and the cell diagonally behind (the valley's
 * next cell down) at its own level too. Where a 45° L's arms meet, a flat two-cell ridge ahead looks the same
 * along each direction, but the cell diagonally behind is one down.
 */
function looksShallowValley(r: RoofProbe, ax: number, az: number, bx: number, bz: number): boolean {
  const pair = (sx: number, sz: number): boolean => r(sx, 1, sz) && r(2 * sx, 1, 2 * sz) && r(-sx, 0, -sz);
  return pair(ax, az) && pair(bx, bz) && r(-ax - bx, 0, -az - bz);
}

/** Scratch of the last scoring: agreeing cells ahead. */
let ahead = 0;

/**
 * A direction (sx, sz) fitted to the 1:2 stair of `phase`: the cells
 * along it (two each way) where the stair puts them, counted from the cell
 * out until one is missing; −1 when a missing one has a cell a step steeper
 * (one higher ahead, one lower behind). Sets {@link ahead}.
 */
function shallowFit(r: RoofProbe, sx: number, sz: number, phase: number): number {
  return stairFit(r, sx, sz, false, phase);
}

/** {@link shallowFit} against the 1:2 stair, or (`steep`) against the 45° one. */
function stairFit(r: RoofProbe, sx: number, sz: number, steep: boolean, phase: number): number {
  let agree = 0;
  ahead = 0;
  for (let j = 1; j <= 2; j++) {
    const h = steep ? j : (phase + j) >> 1;
    if (r(j * sx, h, j * sz)) {
      agree++;
      ahead++;
      continue;
    }
    if (r(j * sx, h + 1, j * sz)) return -1;
    break;
  }
  for (let j = -1; j >= -2; j--) {
    const h = steep ? j : (phase + j) >> 1;
    if (r(j * sx, h, j * sz)) {
      agree++;
      continue;
    }
    if (r(j * sx, h - 1, j * sz)) return -1;
    break;
  }
  return agree;
}

/** Cells a 1:2 direction needs agreeing (one alone is a flat roof's neighbour). */
const SHALLOW_AGREE = 2;

/** Heights (quarter cells above the voxel's top) of a direction's plane at its low side, by slope and phase. */
function planeLow(shallow: boolean, phase: number): number {
  return shallow ? 2 * phase : 0;
}

/** A direction's plane at sample `along` (quarter cells across the cell toward the rise, 0 … 4), above the voxel's top. */
export function roofPlaneAt(shallow: boolean, phase: number, along: number): number {
  return planeLow(shallow, phase) + (shallow ? along >> 1 : along);
}

/** How far across the cell (quarter cells, 0 … 4) sample (iu, iv) lies toward direction k. */
export function roofAlong(k: number, iu: number, iv: number): number {
  return k === 0 ? iu : k === 1 ? iv : k === 2 ? 4 - iu : 4 - iv;
}

/** The directions of a 1:2 reading that never lie under (over, concave) another of its planes anywhere in the cell. */
function undominated(dirs: number, phases: number, concave: boolean): number {
  let keep = 0;
  for (let k = 0; k < 4; k++) {
    if (((dirs >>> k) & 1) === 0) continue;
    let wins = false;
    for (let iu = 0; iu <= 4 && !wins; iu += 2) for (let iv = 0; iv <= 4 && !wins; iv += 2) {
      const h = roofPlaneAt(true, (phases >>> k) & 1, roofAlong(k, iu, iv));
      let best = true;
      for (let o = 0; o < 4 && best; o++) {
        if (o === k || ((dirs >>> o) & 1) === 0) continue;
        const g = roofPlaneAt(true, (phases >>> o) & 1, roofAlong(o, iu, iv));
        best = concave ? h > g : h < g;
      }
      wins = best;
    }
    if (wins) keep |= 1 << k;
  }
  return keep;
}

/**
 * The phase of a 1:2 direction (sx, sz) read from behind: 1 when the cell behind is at its own level (the pair's
 * low cell) and the one behind that is not, else 0. A direction whose stair the stair fit could not read (a cell in
 * from a 1:2 hip's corner, where the other slope's eave row runs flat along it) takes its phase so.
 */
function phaseBehind(r: RoofProbe, sx: number, sz: number): number {
  return r(-sx, 0, -sz) && !r(-2 * sx, 0, -2 * sz) ? 1 : 0;
}

/** Whether the roof ends within two cells behind along (sx, sz): a column there holds no roof cell near this level. */
function endsBehind(r: RoofProbe, sx: number, sz: number): boolean {
  for (let j = 1; j <= 2; j++) if (!r(-j * sx, -1, -j * sz) && !r(-j * sx, 0, -j * sz) && !r(-j * sx, 1, -j * sz)) return true;
  return false;
}

/** The 1:2 reading: dirs | shallow | concave | phases (0: none). */
function shallowWord(r: RoofProbe): number {
  let dirs = 0;
  let phases = 0;
  let full = 0;
  for (let k = 0; k < 4; k++) {
    let best = -1;
    let phase = 0;
    let fwd = 0;
    for (let ph = 0; ph < 2; ph++) {
      const s = shallowFit(r, ROOF_DX[k]!, ROOF_DZ[k]!, ph);
      if (s >= SHALLOW_AGREE && s > best) {
        best = s;
        phase = ph;
        fwd = ahead;
      }
    }
    if (best < 0) continue;
    dirs |= 1 << k;
    phases |= phase << k;
    if (fwd === 2) full |= 1 << k;
  }
  if (dirs === 0) {
    // A 1:2 hip's eave corner and the corner cell in from it read only along their diagonal.
    for (let k = 0; k < 4; k++) {
      const j = (k + 1) & 3;
      let best = -1;
      for (let ph = 0; ph < 2; ph++) best = Math.max(best, shallowFit(r, ROOF_DX[k]! + ROOF_DX[j]!, ROOF_DZ[k]! + ROOF_DZ[j]!, ph));
      // Only by a hip's eave corner (the roof ends within two cells behind along both axes): where an L's arms meet
      // the arms' stairs flatten each other and a diagonal reads planes the cell does not lie on, so it keeps its
      // voxel faces.
      if (best < SHALLOW_AGREE || !endsBehind(r, ROOF_DX[k]!, ROOF_DZ[k]!) || !endsBehind(r, ROOF_DX[j]!, ROOF_DZ[j]!)) continue;
      if (dirs !== 0) return 0;
      dirs = (1 << k) | (1 << j);
      full = 0;
      // Each of the two directions keeps the phase its own axis gives: the cell in from a hip's corner is the low
      // cell of one slope's pair and the high cell of the other's (whose plane the lower one then covers).
      phases = (phaseBehind(r, ROOF_DX[k]!, ROOF_DZ[k]!) << k) | (phaseBehind(r, ROOF_DX[j]!, ROOF_DZ[j]!) << j);
    }
    if (dirs === 0) return 0;
  }
  let concave = false;
  if (bits4(dirs) === 2) {
    // Two neighbouring directions meet concave (a valley) where both stairs go on upward two cells along.
    for (let k = 0; k < 4; k++) if (((dirs >>> k) & 1) !== 0 && ((dirs >>> ((k + 1) & 3)) & 1) !== 0) concave = ((full >>> k) & 1) !== 0 && ((full >>> ((k + 1) & 3)) & 1) !== 0;
  }
  dirs = undominated(dirs, phases, concave);
  if (dirs === 0) return 0;
  phases &= dirs;
  return dirs | ROOF_WORD.shallow | (concave && bits4(dirs) === 2 ? ROOF_WORD.concave : 0) | (phases << ROOF_WORD.phaseShift);
}

/**
 * How an intact roof cell with nothing solid above it reads as a sloped
 * roof, from the roof cells round it (`r`, within {@link ROOF_PLANE_REACH}):
 * its rising directions, slope, phases and whether its planes meet concave
 * (a word without support or roof edges; 0: no slope, voxel faces).
 */
export function roofReading(r: RoofProbe): number {
  const steep = steepDirs(r);
  let shallow = steep === FLATTER || steep === 0;
  if (!shallow) {
    if (steepDiagonal) {
      for (let k = 0; k < 4 && !shallow; k++) {
        const j = (k + 1) & 3;
        if (((steep >>> k) & 1) !== 0 && ((steep >>> j) & 1) !== 0) shallow = looksShallow(r, ROOF_DX[k]! + ROOF_DX[j]!, ROOF_DZ[k]! + ROOF_DZ[j]!, true);
      }
    } else {
      for (let k = 0; k < 4 && !shallow; k++) if (((steep >>> k) & 1) !== 0) shallow = looksShallow(r, ROOF_DX[k]!, ROOF_DZ[k]!, false);
      for (let k = 0; k < 4 && !shallow; k++) {
        const j = (k + 1) & 3;
        if (((steep >>> k) & 1) !== 0 && ((steep >>> j) & 1) !== 0) shallow = looksShallowValley(r, ROOF_DX[k]!, ROOF_DZ[k]!, ROOF_DX[j]!, ROOF_DZ[j]!);
      }
    }
  }
  if (shallow) return shallowWord(r);
  if (steepDiagonal) {
    // Read off a diagonal at 45° only, but read at 1:2 too, and along that diagonal the 1:2 stair fits more cells
    // than the 45° one: a 1:2 hip's cell by its ridge's end, whose diagonal neighbour one up is the ridge, or a
    // cell in from a small 1:2 hip's corner. (A 45° hip's eave corner fits 45° along its diagonal, and so does a
    // cell where a 45° L's arms meet.)
    const w = shallowWord(r);
    if (w !== 0) {
      let k = 0;
      while (((steep >>> k) & 1) === 0 || ((steep >>> ((k + 1) & 3)) & 1) === 0) k++;
      const dx = ROOF_DX[k]! + ROOF_DX[(k + 1) & 3]!;
      const dz = ROOF_DZ[k]! + ROOF_DZ[(k + 1) & 3]!;
      if (Math.max(stairFit(r, dx, dz, false, 0), stairFit(r, dx, dz, false, 1)) > stairFit(r, dx, dz, true, 0)) return w;
    }
  }
  let w = steep;
  if (bits4(steep) === 2) {
    for (let k = 0; k < 4; k++) {
      const b = (k + 1) & 3;
      if (((steep >>> k) & 1) === 0 || ((steep >>> b) & 1) === 0) continue;
      // Concave: both slopes go on up (a valley), or, where they meet a ridge (the top of an L's corner), the two
      // corners off the low one each have the three cells round them on this level (high corners, not low).
      const kx = ROOF_DX[k]!, kz = ROOF_DZ[k]!, bx = ROOF_DX[b]!, bz = ROOF_DZ[b]!;
      const up = r(kx, 1, kz) && r(bx, 1, bz);
      const level = r(-kx, 0, -kz) && r(bx, 0, bz) && r(bx - kx, 0, bz - kz) && r(kx, 0, kz) && r(-bx, 0, -bz) && r(kx - bx, 0, kz - bz);
      if (up || level) w |= ROOF_WORD.concave;
    }
  }
  return w;
}

/**
 * How damage is shown to the predicates below (one job at a time a thread):
 * the job's piece table (each kit's stages; null: the engine's) and whether
 * its rule set draws damage at all (one that does not draws a damaged cell
 * whole).
 */
let damageTable: PieceTable | null = null;
let damageDrawn = true;

/** Whether a construction cell of value `v` is drawn whole: intact, cracked, or at an integrity its kit shows in no stage (not a hole). */
function drawnWhole(v: number): boolean {
  return valueShape(v) !== 0 && (!damageDrawn || damageStageOf(damageTable, v) < DAMAGE_STAGE.many);
}

/** Cell predicates over a neighbourhood. */
function roofValue(v: number): boolean {
  return ((v >>> ROLE_SHIFT) & ROLE_MASK) === VOXEL_ROLE.roof && drawnWhole(v);
}

function solid(n: Neighbourhood, i: number): boolean {
  return OPEN_ROLE[(n.values[i]! >>> ROLE_SHIFT) & ROLE_MASK] !== 1 && n.shapes[i]! >= SURFACE_ISO;
}

/** A body a roof can rest on: a solid construction cell drawn whole (terrain is drawn by its own mesher, a hole is not drawn). */
function body(v: number): boolean {
  const role = (v >>> ROLE_SHIFT) & ROLE_MASK;
  return valueMaterial(v) !== MATERIAL_AIR && OPEN_ROLE[role] !== 1 && role !== VOXEL_ROLE.terrain && drawnWhole(v);
}

/** Plain air (not an opening, not liquid). */
function air(v: number): boolean {
  return ((v >>> ROLE_SHIFT) & ROLE_MASK) === VOXEL_ROLE.air || valueMaterial(v) === MATERIAL_AIR;
}

/** The neighbourhood the probe reads (one job at a time a thread). */
let probeValues: Uint32Array = new Uint32Array(0);
let probeCell = 0;
let probeSide = 0;
const neighbourhoodProbe: RoofProbe = (dx, dy, dz) => roofValue(probeValues[probeCell + (dx * probeSide + dz) * probeSide + dy]!);

/** Sets how the predicates read damage: `table`'s kits' stages (null: the engine's), or none drawn. */
function useDamage(table: PieceTable | null, drawn: boolean): void {
  damageTable = table;
  damageDrawn = drawn;
}

/**
 * Whether cell `i` is a plane cell (reads {@link ROOF_PLANE_REACH} round it):
 * the edge pass leaves pieces off round these. Damage by `table`'s stages,
 * as {@link classifyRoofs}.
 */
export function isRoofPlaneCell(n: Neighbourhood, i: number, table: PieceTable | null = null): boolean {
  useDamage(table, true);
  return planeWord(n, i) !== 0;
}

/**
 * Whether cell `i` may lie under a supported roof across one air cell
 * (reads one cell round it): an air cell between a body and an intact roof
 * cell whose kit fills wall tops. The roof's slab closes down through it onto the body, so the edge
 * pass dresses no edge of it.
 */
export function isRoofGapCell(n: Neighbourhood, i: number, table: PieceTable | null = null): boolean {
  useDamage(table, true);
  return roofValue(n.values[i + 1]!) && cellWallTopFill(damageTable, n.values[i + 1]!) && air(n.values[i]!) && body(n.values[i - 1]!);
}

/** The plane-cell word of cell `i` without its edge bits (reads {@link ROOF_PLANE_REACH} round it), 0 when it is none. */
function planeWord(n: Neighbourhood, i: number): number {
  const v = n.values;
  if (!roofValue(v[i]!) || solid(n, i + 1)) return 0;
  probeValues = v;
  probeCell = i;
  probeSide = n.side;
  const w = roofReading(neighbourhoodProbe);
  if (w === 0 || !cellWallTopFill(damageTable, v[i]!)) return w;
  if (body(v[i - 1]!)) return w | ROOF_WORD.supported;
  if (air(v[i - 1]!) && body(v[i - 2]!)) return w | ROOF_WORD.supported | ROOF_WORD.gap;
  return w;
}

/** Neighbourhood offsets of the four horizontal directions for a side (cached). */
const offsetsBySide = new Map<number, Int32Array>();
function offsets(s: number): Int32Array {
  let o = offsetsBySide.get(s);
  if (o === undefined) offsetsBySide.set(s, (o = Int32Array.from([0, 1, 2, 3], (k) => (ROOF_DX[k]! * s + ROOF_DZ[k]!) * s)));
  return o;
}

/**
 * The plane-cell words of a job: every cell of the job and one round it
 * into `out` (neighbourhood indexing; 0: none; cells further out are left as
 * they are), the job's own cells
 * with their roof edges. The pad must be at least {@link ROOF_MESHER_REACH}.
 * A damaged roof cell is a plane cell while its kit's stages (`table`; null:
 * the engine's) draw it whole; under a rule set that draws no damage
 * (`damageDrawn` false) every damaged cell is drawn whole. Returns the job's
 * own plane cells.
 */
export function classifyRoofs(n: Neighbourhood, out: Uint32Array, table: PieceTable | null = null, damageDrawnHere = true): number {
  const e = n.edge;
  const p = n.pad;
  const s = n.side;
  if (p < ROOF_MESHER_REACH) throw new RangeError(`roof mesher: pad ${p}, it reads ${ROOF_MESHER_REACH} cells past the job`);
  if (out.length !== n.values.length) throw new RangeError('roof words: wrong length');
  useDamage(table, damageDrawnHere);
  const off = offsets(s);
  const lo = p - 1;
  const hi = p + e + 1;
  const vals = n.values;
  let any = false;
  for (let x = lo; x < hi; x++) for (let z = lo; z < hi; z++) {
    const row = (x * s + z) * s;
    for (let y = lo; y < hi; y++) {
      const i = row + y;
      if (((vals[i]! >>> ROLE_SHIFT) & ROLE_MASK) !== VOXEL_ROLE.roof) {
        out[i] = 0;
        continue;
      }
      const w = planeWord(n, i);
      out[i] = w;
      if (w !== 0) any = true;
    }
  }
  if (!any) return 0;
  let count = 0;
  for (let x = p; x < p + e; x++) for (let z = p; z < p + e; z++) {
    const row = (x * s + z) * s;
    for (let y = p; y < p + e; y++) {
      const i = row + y;
      const w = out[i]!;
      if (w === 0) continue;
      count++;
      const dirs = w & ROOF_WORD.dirs;
      const many = bits4(dirs);
      let edges = 0;
      for (let k = 0; k < 4; k++) {
        if (((dirs >>> k) & 1) === 0) continue;
        const low = (k + 2) & 3;
        const below = i - off[k]!;
        if (!solid(n, below) && !solid(n, below - 1)) edges |= 1 << (ROOF_WORD.eaveShift + low);
        if (many === 1) {
          const a = (k + 1) & 3;
          const c = (k + 3) & 3;
          if (!solid(n, i + off[a]!)) edges |= 1 << (ROOF_WORD.vergeShift + a);
          if (!solid(n, i + off[c]!)) edges |= 1 << (ROOF_WORD.vergeShift + c);
          const other = out[i + off[k]!]!;
          if (k < 2 && other !== 0 && ((other >>> low) & 1) !== 0) edges |= 1 << (ROOF_WORD.ridgeShift + k);
        }
      }
      if (many >= 2 && many !== 4 && ((dirs & 0b0101) === 0b0101 || (dirs & 0b1010) === 0b1010)) edges |= ROOF_WORD.centreRidge;
      out[i] = w | edges;
    }
  }
  return count;
}
