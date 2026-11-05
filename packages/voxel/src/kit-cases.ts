/**
 * The case pass: which detail case a construction cell is, read from its
 * own role and the cells around it, so a kit can draw it with the piece
 * authored for that case, turned and mirrored into place.
 *
 * **The window.** A cell's case reads 40 cells within two cells of it
 * (Chebyshev; the reach the Enshrouded detail rules describe): the 26 that
 * touch it, the six two cells out along an axis, and the eight one cell
 * aside of the cells two above and two below (what tells a post under a
 * rail, or a rail on a post, from a taller wall). Each window cell becomes
 * a 4-bit symbol: open (air, liquid, a cell filled below the surface),
 * an opening, ground, or one of the six built roles in the centre's
 * material or another one. So a case sees roles and fill classes, never
 * materials themselves. A catalogue none of whose rules tells the centre's
 * material from another ({@link catalogueReadsMaterial}) gets windows
 * without the same-material bit at all, so its cases and their transforms
 * are the same whatever the materials: a material paint then changes no
 * case, form or consumer (the feeds mask: material is shader data). A
 * catalogue whose rules read it makes a material paint feed geometry.
 *
 * **Folding.** The same arrangement turned or mirrored is the same case. A
 * window is folded over the four quarter turns about +y and the mirror
 * across a vertical plane (eight transforms), never flipped upside down:
 * gravity tells a soffit from a running board. The folded window with the
 * smallest packed symbols is the case key; the transform that maps it onto
 * the world is kept with the result, so a piece authored once in the case's
 * own orientation is placed turned and mirrored to fit.
 *
 * **Rules.** A catalogue lists cases and rules. A rule is a pattern (cells
 * of the window, each with the set of symbols it accepts; cells it does not
 * list are wildcards), the centre roles it applies to, a priority and the
 * case it names. The rules of the centre's role are tried in priority order
 * (equal priorities in table order), each under every transform of the
 * key; the first match wins. A cell no rule matches takes its role's
 * fallback case. A catalogue names the fallback of every detail role, a
 * case or `null` (no case: the cell shows its base surface alone); a
 * catalogue that leaves a role out is refused, so no role is forgotten.
 *
 * The extraction is pure and per thread: a small direct-mapped cache keyed
 * by the unfolded window skips folding and matching for windows seen
 * before, which on built-up worlds is nearly every cell.
 */
import { OPEN_ROLE, type Neighbourhood } from './assembly';
import { SURFACE_ISO } from './derived-mesh';
import { CONSTRUCTION_ROLES, MATERIAL_ID_MAX, ROLE_MASK, ROLE_SHIFT, VOXEL_ROLE } from './record';

/** How far (Chebyshev, cells) the case window reaches from its centre. */
export const CASE_REACH = 2;

/** The built roles, in symbol order: role b is symbol 3 + 2b (another material) and 4 + 2b (the centre's material). */
const BUILT_ROLES: readonly number[] = CONSTRUCTION_ROLES;

/** The roles that carry a case: the built roles and openings. Terrain, liquid and air have none. */
export const CASE_ROLES: readonly number[] = Object.freeze([...BUILT_ROLES, VOXEL_ROLE.opening]);

/** Window cell symbols (4 bits). */
export const CASE_SYMBOL = Object.freeze({
  /** Air, liquid, or any cell filled below the surface threshold. */
  open: 0,
  /** An opening: open, but a gap a door or window frames. */
  opening: 1,
  /** Terrain filled to the surface. */
  ground: 2,
  /** The first built symbol: a built role in another material (3 + 2b) or the centre's material (4 + 2b). */
  built: 3,
});

const bit = (s: number): number => 1 << s;
const builtBits = (role: number): number => {
  const b = BUILT_ROLES.indexOf(role);
  return bit(CASE_SYMBOL.built + 2 * b) | bit(CASE_SYMBOL.built + 2 * b + 1);
};

/**
 * Symbol sets a rule cell accepts, as bit masks over {@link CASE_SYMBOL}:
 * combine with `|` (either) and `&` (both), e.g. `CELL.wall & CELL.same`.
 */
export const CELL = (() => {
  let built = 0;
  let same = 0;
  for (let b = 0; b < BUILT_ROLES.length; b++) {
    built |= bit(CASE_SYMBOL.built + 2 * b) | bit(CASE_SYMBOL.built + 2 * b + 1);
    same |= bit(CASE_SYMBOL.built + 2 * b + 1);
  }
  const air = bit(CASE_SYMBOL.open);
  const opening = bit(CASE_SYMBOL.opening);
  const ground = bit(CASE_SYMBOL.ground);
  return Object.freeze({
    /** Air or liquid, or a partly filled cell: nothing an opening frames. */
    air,
    opening,
    /** Anything open: air or an opening. */
    open: air | opening,
    ground,
    /** Any built role, any material. */
    built,
    /** Built or ground. */
    solid: built | ground,
    /** Built in the centre's material. */
    same,
    /** Built in another material. */
    other: built & ~same,
    wall: builtBits(VOXEL_ROLE.wall),
    floor: builtBits(VOXEL_ROLE.floor),
    roof: builtBits(VOXEL_ROLE.roof),
    foundation: builtBits(VOXEL_ROLE.foundation),
    stair: builtBits(VOXEL_ROLE.stair),
    pillar: builtBits(VOXEL_ROLE.pillar),
    /** Every symbol (a wildcard written out). */
    any: (1 << (CASE_SYMBOL.built + 2 * BUILT_ROLES.length)) - 1,
  });
})();

/** A symbol with the same-material bit taken off (a built role reads as "another material"). */
function withoutSame(sy: number): number {
  return sy > CASE_SYMBOL.built ? sy - ((sy - CASE_SYMBOL.built) & 1) : sy;
}

/**
 * Whether any rule of a catalogue tells a built cell in the centre's
 * material from one in another (a rule cell accepting one of a role's two
 * symbols but not the other). Only then do materials decide cases.
 */
export function catalogueReadsMaterial(def: Pick<CaseCatalogueDef, 'rules'>): boolean {
  for (const r of def.rules) {
    for (const c of r.cells) {
      const mask = c[3];
      for (let b = 0; b < BUILT_ROLES.length; b++) {
        if (((mask >> (CASE_SYMBOL.built + 2 * b)) & 1) !== ((mask >> (CASE_SYMBOL.built + 2 * b + 1)) & 1)) return true;
      }
    }
  }
  return false;
}

/** Every symbol but those of `mask`. */
export function notCell(mask: number): number {
  return CELL.any & ~mask;
}

/** The window's cells, as offsets (dx, dy, dz) from the centre, in key order. */
export const CASE_WINDOW: readonly (readonly [number, number, number])[] = (() => {
  const w: [number, number, number][] = [];
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) if (dx !== 0 || dy !== 0 || dz !== 0) w.push([dx, dy, dz]);
  w.push([-2, 0, 0], [2, 0, 0], [0, 0, -2], [0, 0, 2], [0, -2, 0], [0, 2, 0]);
  for (const dy of [-2, 2]) w.push([-1, dy, 0], [1, dy, 0], [0, dy, -1], [0, dy, 1]);
  return Object.freeze(w.map((o) => Object.freeze(o)));
})();

/** Cells in the window. */
export const CASE_WINDOW_CELLS = CASE_WINDOW.length;
/** 32-bit words of a packed window (8 symbols a word). */
const KEY_WORDS = Math.ceil(CASE_WINDOW_CELLS / 8);

/** Transforms a case folds over: mirror (x → −x) first, then 0–3 quarter turns about +y, each taking +x to +z. */
export const FOLD_TRANSFORMS = 8;

/** The transform with `turns` quarter turns, mirrored first when `mirror`. */
export function foldTransform(turns: number, mirror: boolean): number {
  return (mirror ? 4 : 0) + (turns & 3);
}

/** Applies transform t to an offset. */
export function applyFold(t: number, o: readonly [number, number, number]): [number, number, number] {
  let x = t >= 4 ? -o[0] : o[0];
  let z = o[2];
  for (let k = 0; k < (t & 3); k++) {
    const nx = -z;
    z = x;
    x = nx;
  }
  return [x + 0, o[1], z + 0];
}

const windowIndex = new Map<string, number>(CASE_WINDOW.map((o, k) => [o.join(','), k]));

/** The window index of an offset, or −1 when the window does not hold it. */
export function caseWindowIndex(dx: number, dy: number, dz: number): number {
  return windowIndex.get(`${dx},${dy},${dz}`) ?? -1;
}

/** FOLD_IMAGE[t][k]: the window index of transform t applied to window cell k. */
const FOLD_IMAGE: readonly Uint8Array[] = Array.from({ length: FOLD_TRANSFORMS }, (_, t) => Uint8Array.from(CASE_WINDOW, (o) => caseWindowIndex(...applyFold(t, o))));

/** FOLD_COMPOSE[t * 8 + u]: the transform that applies u, then t. */
const FOLD_COMPOSE = (() => {
  // A transform is known by where it takes +x and +z.
  const key = (f: (o: [number, number, number]) => [number, number, number]): string => `${f([1, 0, 0]).join(',')}|${f([0, 0, 1]).join(',')}`;
  const byImage = new Map<string, number>();
  for (let v = 0; v < FOLD_TRANSFORMS; v++) byImage.set(key((o) => applyFold(v, o)), v);
  const out = new Uint8Array(FOLD_TRANSFORMS * FOLD_TRANSFORMS);
  for (let t = 0; t < FOLD_TRANSFORMS; t++) for (let u = 0; u < FOLD_TRANSFORMS; u++) out[t * FOLD_TRANSFORMS + u] = byImage.get(key((o) => applyFold(t, applyFold(u, o))))!;
  return out;
})();

/** The transform that applies u, then t. */
export function composeFolds(t: number, u: number): number {
  return FOLD_COMPOSE[t * FOLD_TRANSFORMS + u]!;
}

/** A window turned and mirrored by t: cell k of `win` lands at cell t(k). */
export function foldWindow(win: Uint8Array, t: number, out = new Uint8Array(CASE_WINDOW_CELLS)): Uint8Array {
  const img = FOLD_IMAGE[t]!;
  for (let k = 0; k < CASE_WINDOW_CELLS; k++) out[img[k]!] = win[k]!;
  return out;
}

/** Inferred architectural features: cases of the stored roles, never roles themselves. */
export type InferredFeature = 'beam' | 'banister' | 'soffit' | 'moulding' | 'running-board' | 'foundation-skirt';

/**
 * The coarse shapes a case declares for its consumers (collision,
 * navigation, light; case-forms.ts gives each one's box), never read from a
 * piece mesh.
 */
export const CASE_SHAPES = Object.freeze(['none', 'box', 'slab', 'panel', 'bar', 'post'] as const);
export type CaseShape = (typeof CASE_SHAPES)[number];

/** What a case does with the base surface of its cell: draw it, leave it to a piece, or draw its declared shape instead. */
export const CASE_BASES = Object.freeze(['keep', 'suppress', 'reshape'] as const);
export type CaseBase = (typeof CASE_BASES)[number];

/**
 * A case's base and shape that cannot go together, or null: a kept base
 * draws the whole cell, so its shape is the box (or none, for an opening);
 * a reshaped base draws the shape, so it is neither; a suppressed base
 * leaves the cell to a piece, so its shape is not the whole box.
 */
export function caseFormProblem(c: { readonly base: string; readonly shape: string }): string | null {
  if (!(CASE_BASES as readonly string[]).includes(c.base)) return `base "${c.base}" (${CASE_BASES.join(', ')})`;
  if (!(CASE_SHAPES as readonly string[]).includes(c.shape)) return `shape "${c.shape}" (${CASE_SHAPES.join(', ')})`;
  if (c.base === 'keep' && c.shape !== 'box' && c.shape !== 'none') return 'a kept base needs the box or no shape';
  if (c.base === 'reshape' && (c.shape === 'box' || c.shape === 'none')) return 'a reshaped base needs a partial shape';
  if (c.base === 'suppress' && c.shape === 'box') return 'a suppressed base with the whole box: keep it';
  return null;
}

/** One case of a catalogue. */
export interface CaseDef {
  /** Id syntax (lower case, digits, - and _): what a kit names the case by. */
  readonly id: string;
  /** The centre roles the case can be (a rule naming it applies to these or fewer). */
  readonly roles: readonly number[];
  /** The inferred feature it draws, if any. */
  readonly feature?: InferredFeature;
  /** Whether a complete kit must provide pieces for it (an optional case without them draws its role's fallback). */
  readonly required: boolean;
  /** The axis a run of the case follows in its own orientation (its sections join along it), or null. */
  readonly run: 'x' | 'y' | null;
  /** What the base surface does in the cell. */
  readonly base: CaseBase;
  /** The coarse shape collision, navigation and light read (in the case's own orientation). */
  readonly shape: CaseShape;
  /** One line: what the case is. */
  readonly note: string;
  /**
   * Another case of the catalogue (of the same base and shape) whose piece a
   * kit without one of this case's draws instead: a later stage of the same
   * thing, so a kit with one debris piece still dresses every stage.
   */
  readonly standIn?: string;
}

/** A rule cell: an offset in the window and the symbols it accepts. */
export type CaseRuleCell = readonly [dx: number, dy: number, dz: number, accepts: number];

/** A rule: the case a pattern names, for some centre roles, at a priority. */
export interface CaseRule {
  readonly case: string;
  /** The centre roles it applies to (absent: every role of its case). */
  readonly roles?: readonly number[];
  /** Higher is tried first. */
  readonly priority: number;
  /** The pattern in the case's own orientation; unlisted cells are wildcards. */
  readonly cells: readonly CaseRuleCell[];
}

/** A case catalogue: cases, rules and one fallback case per detail role. */
export interface CaseCatalogueDef {
  readonly id: string;
  readonly version: number;
  /** True while the owner has not approved the catalogue as a role spec. */
  readonly draft: boolean;
  readonly cases: readonly CaseDef[];
  readonly rules: readonly CaseRule[];
  /** Role → its fallback case id, or null for no case (the base surface alone), for every role of {@link CASE_ROLES}. */
  readonly fallback: Readonly<Record<number, string | null>>;
}

/** A cell's case result packed in a u16: case index << 3 | transform. */
export const NO_CASE = 0xffff;
const CASE_INDEX_SHIFT = 3;
/** Cases a catalogue may hold (the packed index's range, NO_CASE excluded). */
export const CASE_INDEX_LIMIT = (NO_CASE >> CASE_INDEX_SHIFT) - 1;

/** The case index of a packed result. */
export function caseIndexOf(packed: number): number {
  return packed >> CASE_INDEX_SHIFT;
}

/** The transform of a packed result: the case's orientation placed by it fits the world. */
export function caseFoldOf(packed: number): number {
  return packed & (FOLD_TRANSFORMS - 1);
}

/** What one window resolves to. */
export interface CaseMatch {
  /** The case, or −1 (and a null id) for a cell no rule matches whose role has no fallback. */
  readonly caseIndex: number;
  readonly caseId: string | null;
  /** The transform taking the case's own orientation to the world's: the matched rule's pattern placed by it fits. */
  readonly fold: number;
  /** The transform taking the key (the folded window) to the world's window. */
  readonly keyFold: number;
  /** The rule that matched (index in the catalogue's rules), or −1 for the role's fallback. */
  readonly rule: number;
  /** The case key: the folded window's packed symbols (hex) after the centre role. */
  readonly key: string;
  /** The folded window (the case's own orientation). */
  readonly folded: Uint8Array;
}

interface CompiledRule {
  readonly index: number;
  readonly caseIndex: number;
  /** Per distinct transform u: [u, then window index and mask pairs]. */
  readonly variants: readonly Int32Array[];
}

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const CACHE_SLOTS = 16384;
const CACHE_STRIDE = 1 + KEY_WORDS;

/** A checked, compiled catalogue: matching and the per-thread window cache. */
export class CaseCatalogue {
  readonly id: string;
  readonly version: number;
  readonly draft: boolean;
  readonly cases: readonly CaseDef[];
  readonly rules: readonly CaseRule[];
  /** Whether its rules read the same-material bit ({@link catalogueReadsMaterial}); without, windows never carry it. */
  readonly readsMaterial: boolean;
  private readonly caseIndex = new Map<string, number>();
  private readonly byRole: CompiledRule[][] = [];
  /** Per role without a fallback: the face-cell masks (6 a tuple, {@link FACE_CELLS} order) some rule variant needs; null otherwise. */
  private readonly faceTuples: (Int32Array | null)[] = Array.from({ length: ROLE_MASK + 1 }, () => null);
  private readonly fallbackIndex = new Int32Array(ROLE_MASK + 1).fill(-1);
  private readonly cacheKeys = new Uint32Array(CACHE_SLOTS * CACHE_STRIDE);
  private readonly cacheResults = new Uint16Array(CACHE_SLOTS);
  private readonly words = new Uint32Array(KEY_WORDS);
  private readonly win = new Uint8Array(CASE_WINDOW_CELLS);
  private readonly folded = new Uint8Array(CASE_WINDOW_CELLS);
  private readonly candidate = new Uint32Array(KEY_WORDS);
  private readonly best = new Uint32Array(KEY_WORDS);

  /** Checks a definition and compiles it; throws a RangeError naming the first problem. */
  constructor(def: CaseCatalogueDef) {
    this.id = def.id;
    this.version = def.version;
    this.draft = def.draft;
    this.cases = def.cases;
    this.rules = def.rules;
    this.readsMaterial = catalogueReadsMaterial(def);
    const fail = (msg: string): never => {
      throw new RangeError(`case catalogue ${def.id}: ${msg}`);
    };
    if (!ID_RE.test(def.id) || !Number.isInteger(def.version) || def.version < 0) fail('id or version');
    if (def.cases.length > CASE_INDEX_LIMIT) fail(`${def.cases.length} cases (at most ${CASE_INDEX_LIMIT})`);
    for (const c of def.cases) {
      if (!ID_RE.test(c.id)) fail(`case id "${c.id}" is not id syntax`);
      if (this.caseIndex.has(c.id)) fail(`case ${c.id} listed twice`);
      if (c.roles.length === 0 || c.roles.some((r) => !CASE_ROLES.includes(r))) fail(`case ${c.id}: roles must be detail roles`);
      const form = caseFormProblem(c);
      if (form !== null) fail(`case ${c.id}: ${form}`);
      this.caseIndex.set(c.id, this.caseIndex.size);
    }
    for (const c of def.cases) {
      if (c.standIn === undefined) continue;
      const k = this.caseIndex.get(c.standIn);
      if (k === undefined || k === this.caseIndex.get(c.id)) fail(`case ${c.id}: stand-in ${c.standIn} is not another case`);
      const o = def.cases[k!]!;
      if (o.base !== c.base || o.shape !== c.shape) fail(`case ${c.id}: stand-in ${c.standIn} fills another shape`);
    }
    for (const role of CASE_ROLES) {
      const id = def.fallback[role];
      if (id === undefined) fail(`no fallback case for role ${role} (every detail role names one, or null for none)`);
      if (id === null) continue;
      const k = this.caseIndex.get(id!);
      if (k === undefined) fail(`fallback ${id} is not a case`);
      if (!def.cases[k!]!.roles.includes(role)) fail(`fallback ${id} does not list role ${role}`);
      this.fallbackIndex[role] = k!;
    }
    for (const role of CASE_ROLES) this.byRole[role] = [];
    const order = def.rules.map((r, i) => ({ r, i })).sort((a, b) => b.r.priority - a.r.priority || a.i - b.i);
    for (const { r, i } of order) {
      const k = this.caseIndex.get(r.case);
      if (k === undefined) fail(`rule ${i} names unknown case ${r.case}`);
      if (!Number.isFinite(r.priority)) fail(`rule ${i}: priority`);
      const caseRoles = def.cases[k!]!.roles;
      const roles = r.roles ?? caseRoles;
      if (roles.length === 0 || roles.some((x) => !caseRoles.includes(x))) fail(`rule ${i}: roles outside case ${r.case}'s`);
      const seen = new Set<number>();
      const cells = r.cells.map(([dx, dy, dz, mask]) => {
        const at = caseWindowIndex(dx, dy, dz);
        if (at < 0) fail(`rule ${i}: cell (${dx}, ${dy}, ${dz}) is outside the case window`);
        if (seen.has(at)) fail(`rule ${i}: cell (${dx}, ${dy}, ${dz}) listed twice`);
        if (!Number.isInteger(mask) || mask <= 0 || (mask & ~CELL.any) !== 0) fail(`rule ${i}: cell (${dx}, ${dy}, ${dz}) accepts no symbol or unknown ones`);
        seen.add(at);
        return [at, mask] as const;
      });
      const variants: Int32Array[] = [];
      const distinct = new Set<string>();
      for (let u = 0; u < FOLD_TRANSFORMS; u++) {
        const img = FOLD_IMAGE[u]!;
        const v = new Int32Array(1 + 2 * cells.length);
        v[0] = u;
        cells.map(([at, mask]) => [img[at]!, mask] as const).sort((a, b) => a[0] - b[0]).forEach(([at, mask], j) => {
          v[1 + 2 * j] = at;
          v[2 + 2 * j] = mask;
        });
        const sig = Array.from(v.subarray(1)).join(',');
        if (distinct.has(sig)) continue;
        distinct.add(sig);
        variants.push(v);
      }
      for (const role of roles) this.byRole[role]!.push({ index: i, caseIndex: k!, variants });
    }
    // A role with no fallback: a cell none of whose rules' face cells it meets has no case, without its window.
    for (const role of CASE_ROLES) {
      if (this.fallbackIndex[role]! >= 0) continue;
      const tuples = new Set<string>();
      for (const r of this.byRole[role]!) {
        for (const v of r.variants) {
          const t = FACE_CELLS.map(() => CELL.any);
          for (let j = 1; j < v.length; j += 2) {
            const f = FACE_CELLS.indexOf(v[j]!);
            if (f >= 0) t[f] = v[j + 1]!;
          }
          tuples.add(t.join(','));
        }
      }
      this.faceTuples[role] = Int32Array.from([...tuples].flatMap((t) => t.split(',').map(Number)));
    }
  }

  /** The index of a case id, or −1. */
  indexOf(id: string): number {
    return this.caseIndex.get(id) ?? -1;
  }

  /** The fallback case index of a detail role, or −1 when it has none (its unmatched cells get no case). */
  fallbackOf(role: number): number {
    return this.fallbackIndex[role]!;
  }

  /**
   * Folds a window (symbols in {@link CASE_WINDOW} order) and matches it:
   * the slow, allocation-making path tests and tools read; extraction
   * gives the same case and transform through its cache.
   */
  matchWindow(role: number, win: Uint8Array): CaseMatch {
    if (CARRIES[role] !== 1) throw new RangeError(`role ${role} carries no case`);
    const packed = this.resolve(role, this.readsMaterial ? win : win.map(withoutSame));
    const fold = packed === NO_CASE ? this.lastKeyFold : caseFoldOf(packed);
    const caseIndex = packed === NO_CASE ? -1 : caseIndexOf(packed);
    const folded = this.folded.slice();
    const key = `${role}:${Array.from(this.best, (w) => w.toString(16).padStart(8, '0')).join('')}`;
    return { caseIndex, caseId: caseIndex < 0 ? null : this.cases[caseIndex]!.id, fold, keyFold: this.lastKeyFold, rule: this.lastRule, key, folded };
  }

  private lastRule = -1;
  private lastKeyFold = 0;

  /** Folds `win` into this.folded/this.best and returns the packed case. */
  private resolve(role: number, win: Uint8Array): number {
    // The fold with the smallest packed symbols (the lowest transform among equals) is the key.
    let bestT = 0;
    for (let t = 0; t < FOLD_TRANSFORMS; t++) {
      const img = FOLD_IMAGE[t]!;
      const c = this.candidate;
      c.fill(0);
      for (let k = 0; k < CASE_WINDOW_CELLS; k++) c[k >> 3] = (c[k >> 3]! | (win[img[k]!]! << ((k & 7) * 4))) >>> 0;
      let less = t === 0;
      for (let w = 0; w < KEY_WORDS && !less; w++) {
        if (c[w]! !== this.best[w]!) {
          less = c[w]! < this.best[w]!;
          break;
        }
      }
      if (less) {
        this.best.set(c);
        bestT = t;
      }
    }
    this.lastKeyFold = bestT;
    const img = FOLD_IMAGE[bestT]!;
    const folded = this.folded;
    for (let k = 0; k < CASE_WINDOW_CELLS; k++) folded[k] = win[img[k]!]!;
    // Rule u matching the key means folded[u(o)] fits cell o, so world[t(u(o))] does: the piece goes by t after u.
    for (const r of this.byRole[role]!) {
      for (const v of r.variants) {
        let ok = true;
        for (let j = 1; j < v.length; j += 2) {
          if (((v[j + 1]! >> folded[v[j]!]!) & 1) === 0) {
            ok = false;
            break;
          }
        }
        if (ok) {
          this.lastRule = r.index;
          return (r.caseIndex << CASE_INDEX_SHIFT) | composeFolds(bestT, v[0]!);
        }
      }
    }
    this.lastRule = -1;
    const fb = this.fallbackIndex[role]!;
    return fb < 0 ? NO_CASE : (fb << CASE_INDEX_SHIFT) | bestT;
  }

  /**
   * Resolves the case of every cell of the box [lo, hi) (padded
   * coordinates, the same bounds on all three axes) of a neighbourhood into
   * `out` (neighbourhood indexing): a packed case ({@link caseIndexOf},
   * {@link caseFoldOf}) for a detail-bearing cell, {@link NO_CASE} for any
   * other (and for a cell no rule matches whose role has no fallback). Reads cells within {@link CASE_REACH} of the box, so the box must
   * sit that far inside the neighbourhood. Returns the cells given a case.
   */
  extract(n: Neighbourhood, lo: number, hi: number, out: Uint16Array): number {
    const s = n.side;
    if (lo < CASE_REACH || hi + CASE_REACH > s || out.length !== n.values.length) throw new RangeError(`case extraction: box ${lo}…${hi} in a side of ${s} (reach ${CASE_REACH})`);
    const vals = new Int32Array(n.values.buffer, n.values.byteOffset, n.values.length);
    let any = false;
    for (let x = lo; x < hi; x++) for (let z = lo; z < hi; z++) {
      const row = (x * s + z) * s;
      for (let y = lo; y < hi; y++) {
        const i = row + y;
        if (CARRIES[(vals[i]! >> ROLE_SHIFT) & ROLE_MASK] === 1) any = true;
        out[i] = NO_CASE;
      }
    }
    if (!any) return 0;
    const sym = symbolsOf(n, lo - CASE_REACH, hi + CASE_REACH);
    const deltas = windowDeltas(s);
    const words = this.words;
    const win = this.win;
    const keys = this.cacheKeys;
    let count = 0;
    for (let x = lo; x < hi; x++) for (let z = lo; z < hi; z++) {
      const row = (x * s + z) * s;
      for (let y = lo; y < hi; y++) {
        const i = row + y;
        const own = sym[i]!;
        // Detail-bearing: built to the surface, or an opening.
        if (own < CASE_SYMBOL.built && own !== CASE_SYMBOL.opening) continue;
        const role = (vals[i]! >> ROLE_SHIFT) & ROLE_MASK;
        if (CARRIES[role] !== 1) continue;
        // -1 matches no material: the same-material bit stays off where no rule reads it.
        const mat = this.readsMaterial ? vals[i]! & MATERIAL_ID_MAX : -1;
        const faces = this.faceTuples[role]!;
        if (faces !== null) {
          for (let f = 0; f < 6; f++) {
            const j = i + deltas[FACE_CELLS[f]!]!;
            let sy = sym[j]!;
            if (sy >= CASE_SYMBOL.built && (vals[j]! & MATERIAL_ID_MAX) === mat) sy++;
            faceSym[f] = sy;
          }
          let may = false;
          for (let t = 0; t < faces.length && !may; t += 6) {
            may = true;
            for (let f = 0; f < 6 && may; f++) may = ((faces[t + f]! >> faceSym[f]!) & 1) === 1;
          }
          if (!may) {
            out[i] = NO_CASE;
            continue;
          }
        }
        words.fill(0);
        let h = role + 1;
        for (let k = 0; k < CASE_WINDOW_CELLS; k++) {
          const j = i + deltas[k]!;
          let sy = sym[j]!;
          if (sy >= CASE_SYMBOL.built && (vals[j]! & MATERIAL_ID_MAX) === mat) sy++;
          win[k] = sy;
          words[k >> 3] = (words[k >> 3]! | (sy << ((k & 7) * 4))) >>> 0;
        }
        for (let w = 0; w < KEY_WORDS; w++) h = Math.imul(h ^ words[w]!, 0x9e3779b1) ^ (h >>> 15);
        const slot = (h >>> 0) & (CACHE_SLOTS - 1);
        const at = slot * CACHE_STRIDE;
        let hit = keys[at] === role + 1;
        for (let w = 0; w < KEY_WORDS && hit; w++) hit = keys[at + 1 + w] === words[w];
        if (hit) {
          out[i] = this.cacheResults[slot]!;
        } else {
          const packed = this.resolve(role, win);
          keys[at] = role + 1;
          keys.set(words, at + 1);
          this.cacheResults[slot] = packed;
          out[i] = packed;
        }
        if (out[i] !== NO_CASE) count++;
      }
    }
    return count;
  }
}

/** The window indices of the centre's 6 face cells: up first (most rules name it), then down, ±x, ±z. */
const FACE_CELLS: readonly number[] = [caseWindowIndex(0, 1, 0), caseWindowIndex(0, -1, 0), caseWindowIndex(1, 0, 0), caseWindowIndex(-1, 0, 0), caseWindowIndex(0, 0, 1), caseWindowIndex(0, 0, -1)];
const faceSym = new Uint8Array(6);

/** Per role: 1 when cells of it carry a case. */
const CARRIES = (() => {
  const t = new Uint8Array(ROLE_MASK + 1);
  for (const r of CASE_ROLES) t[r] = 1;
  return t;
})();

/** Per role: its first built symbol, or the open/opening/ground symbol. */
const ROLE_SYMBOL = (() => {
  const t = new Uint8Array(ROLE_MASK + 1);
  for (let r = 0; r <= ROLE_MASK; r++) {
    const b = BUILT_ROLES.indexOf(r);
    t[r] = b >= 0 ? CASE_SYMBOL.built + 2 * b : r === VOXEL_ROLE.opening ? CASE_SYMBOL.opening : r === VOXEL_ROLE.terrain ? CASE_SYMBOL.ground : CASE_SYMBOL.open;
  }
  return t;
})();

/** The symbol of a value and its density, before the same-material bit. */
export function caseSymbol(value: number, density: number): number {
  const role = (value >>> ROLE_SHIFT) & ROLE_MASK;
  if (role === VOXEL_ROLE.opening) return CASE_SYMBOL.opening;
  if (OPEN_ROLE[role] === 1 || density < SURFACE_ISO) return CASE_SYMBOL.open;
  return ROLE_SYMBOL[role]!;
}

/** Per thread, by neighbourhood size: every cell's symbol before the same-material bit. */
const symbolScratch = new Map<number, Uint8Array>();

function symbolsOf(n: Neighbourhood, lo: number, hi: number): Uint8Array {
  const len = n.values.length;
  let sym = symbolScratch.get(len);
  if (sym === undefined) {
    sym = new Uint8Array(len);
    symbolScratch.set(len, sym);
  }
  const s = n.side;
  const vals = new Int32Array(n.values.buffer, n.values.byteOffset, len);
  const shapes = n.shapes;
  for (let x = lo; x < hi; x++) for (let z = lo; z < hi; z++) {
    const row = (x * s + z) * s;
    for (let y = lo; y < hi; y++) {
      const i = row + y;
      const role = (vals[i]! >> ROLE_SHIFT) & ROLE_MASK;
      sym[i] = role === VOXEL_ROLE.opening ? CASE_SYMBOL.opening : OPEN_ROLE[role] === 1 || shapes[i]! < SURFACE_ISO ? CASE_SYMBOL.open : ROLE_SYMBOL[role]!;
    }
  }
  return sym;
}

const deltaCache = new Map<number, Int32Array>();

/** Neighbourhood index offsets of the window's cells for a side. */
function windowDeltas(side: number): Int32Array {
  let d = deltaCache.get(side);
  if (d === undefined) {
    d = Int32Array.from(CASE_WINDOW, ([dx, dy, dz]) => (dx * side + dz) * side + dy);
    deltaCache.set(side, d);
  }
  return d;
}

/** The window of padded cell `i` of a neighbourhood, as symbols with the same-material bit (for tests and tools). */
export function caseWindowAt(n: Neighbourhood, i: number, out = new Uint8Array(CASE_WINDOW_CELLS)): Uint8Array {
  const deltas = windowDeltas(n.side);
  const mat = n.values[i]! & MATERIAL_ID_MAX;
  for (let k = 0; k < CASE_WINDOW_CELLS; k++) {
    const j = i + deltas[k]!;
    let sy = caseSymbol(n.values[j]!, n.shapes[j]!);
    if (sy >= CASE_SYMBOL.built && (n.values[j]! & MATERIAL_ID_MAX) === mat) sy++;
    out[k] = sy;
  }
  return out;
}
