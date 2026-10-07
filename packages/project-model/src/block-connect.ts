/**
 * Auto-connect — a block type (cell or edge piece) whose look follows its
 * neighbours: paint "wall" and each cell shows the straight run, corner,
 * T-join, cross or end piece (and a wall's base or cap) its neighbours call
 * for, turned to fit.
 *
 * The rules live on the block type (`connect`): which other block types count
 * as connected (the type itself always does) and, per piece, the variant it
 * shows and an extra turn for looks authored another way round. Nothing is
 * stored per cell: the look is resolved from the cell and its neighbours
 * wherever a look is needed (the mesher on the page and in workers, the
 * collider, live blocks, `ctx.grid` reads). That keeps a pure function of the
 * layer, so the page and the workers mesh the same bytes, replays and saves
 * need nothing new, a rule change shows at once without rewriting cells, and
 * a neighbour's change re-resolves only the cells around it (their chunks
 * re-mesh as they do for hidden faces).
 *
 * Cells: the four horizontal neighbours give the piece. At rotation 0 the
 * pieces connect (directions in the block's own frame, +Z the way ramps
 * rise): `end` +Z; `straight` −Z and +Z; `corner` +X and +Z; `t` −X, +X and
 * +Z; `cross` all four; `single` none. The rotation is the one that turns
 * the piece onto the neighbours; where several do (a straight run, a single
 * post) the cell's own rotation is kept when it is one of them.
 *
 * Edge pieces: each end of the edge (a grid point) is open (nothing
 * connected meets there), a line (the edge continues straight on) or a turn
 * (only edges across it meet there). At rotation 0 the pieces are: `end`
 * joined at its +X end and open at −X; `straight` both ends joined; `corner`
 * a turn at its +X end (the look fills the corner; absent, the straight
 * piece is used); `single` both open. An edge piece turns end for end only,
 * so an end or corner piece faces the way its joined end decides.
 *
 * Vertically, a cell or edge with a connected one above and none below is a
 * `base`, with one below and none above a `cap`; these win over the
 * horizontal piece and keep its turn (a plinth row, a coping row).
 *
 * A piece the type does not name leaves the cell its ordinary look (its
 * variant, or one picked by weight, and its own rotation). A cell or edge
 * that names a variant is pinned: its look is never resolved.
 */
import { BLOCK_LIMITS, type BlockCell, type BlockType } from './block-layers';
import type { BlockEdge } from './block-edges';
import type { ModelErrorV2 } from './errors';
import { ID_RE } from './validate';

/** The pieces a connected type can name. */
export const BLOCK_CONNECT_PIECES = ['single', 'end', 'straight', 'corner', 't', 'cross', 'base', 'cap'] as const;
export type BlockConnectPiece = (typeof BLOCK_CONNECT_PIECES)[number];
/** The pieces an edge piece can name (T-joins and crosses happen at grid points, between several edges). */
export const BLOCK_EDGE_CONNECT_PIECES: readonly BlockConnectPiece[] = ['single', 'end', 'straight', 'corner', 'base', 'cap'];

/** One piece's look: a variant of the type, turned a further `rot` degrees (an edge piece: 0 or 180). */
export interface BlockConnectLook {
  variant: number;
  rot?: number;
}

/** A block type's connection rules. */
export interface BlockConnect {
  /** Other block types of the same placement that count as connected (the type itself always does). */
  with?: string[];
  /** The look per piece; a piece not named keeps the ordinary look. */
  pieces: Partial<Record<BlockConnectPiece, BlockConnectLook>>;
}

/** The most other block types one type connects with. */
export const BLOCK_CONNECT_WITH_MAX = 32;

/** A resolved look: the variant shown, its rotation, and the piece (null: not resolved, the ordinary look). */
export interface ConnectedLook {
  variant: number;
  rot: number;
  piece: BlockConnectPiece | null;
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
function err(errors: ModelErrorV2[], code: string, path: string, message: string, found?: unknown): void {
  errors.push({ code, path, message, ...(found !== undefined ? { found } : {}) } as ModelErrorV2);
}

// ---- rules ------------------------------------------------------------------------

/** The shape of a type's `connect` (references and variant ranges are checked with the content). */
export function validateBlockConnect(v: unknown, p: string, errors: ModelErrorV2[], edge: boolean): void {
  if (v === undefined) return;
  if (!isPlainObject(v)) return err(errors, 'field_type', p, 'connect is an object {with?, pieces}', v);
  for (const k of Object.keys(v)) if (k !== 'with' && k !== 'pieces') err(errors, 'field_unexpected', `${p}/${k}`, `unknown connect field "${k}"`, k);
  const w = v['with'];
  if (w !== undefined && (!Array.isArray(w) || w.length > BLOCK_CONNECT_WITH_MAX || !w.every((x) => typeof x === 'string' && ID_RE.test(x)) || new Set(w).size !== w.length)) {
    err(errors, 'field_value', `${p}/with`, `with is a list of up to ${BLOCK_CONNECT_WITH_MAX} distinct block type ids`, w);
  }
  const pieces = v['pieces'];
  if (!isPlainObject(pieces)) return err(errors, 'field_type', `${p}/pieces`, 'pieces is an object (piece → {variant, rot?})', pieces);
  const allowed = edge ? BLOCK_EDGE_CONNECT_PIECES : BLOCK_CONNECT_PIECES;
  for (const [k, look] of Object.entries(pieces)) {
    const pp = `${p}/pieces/${k}`;
    if (!allowed.includes(k as BlockConnectPiece)) {
      err(errors, 'field_unexpected', pp, edge ? `an edge piece's pieces are ${allowed.join(', ')} (T-joins and crosses are where several edges meet)` : `a piece is one of ${allowed.join(', ')}`, k);
      continue;
    }
    if (!isPlainObject(look)) {
      err(errors, 'field_type', pp, 'a piece is {variant, rot?}', look);
      continue;
    }
    for (const kk of Object.keys(look)) if (kk !== 'variant' && kk !== 'rot') err(errors, 'field_unexpected', `${pp}/${kk}`, `unknown piece field "${kk}"`, kk);
    if (!isInt(look['variant']) || look['variant'] < 0 || look['variant'] >= BLOCK_LIMITS.variants) err(errors, 'field_value', `${pp}/variant`, `variant is an index 0-${BLOCK_LIMITS.variants - 1}`, look['variant']);
    const r = look['rot'];
    if (r !== undefined && !(edge ? [0, 180] : [0, 90, 180, 270]).includes(r as number)) err(errors, 'field_value', `${pp}/rot`, edge ? 'an edge piece turns 0 or 180' : 'rot is 0, 90, 180 or 270', r);
  }
}

/** The canonical form (with sorted, pieces in the fixed order, rot 0 dropped; null: nothing left). */
export function canonicalBlockConnect(c: BlockConnect | undefined): BlockConnect | null {
  if (c === undefined) return null;
  const pieces: Partial<Record<BlockConnectPiece, BlockConnectLook>> = {};
  for (const k of BLOCK_CONNECT_PIECES) {
    const look = c.pieces[k];
    if (look !== undefined) pieces[k] = { variant: look.variant, ...(look.rot !== undefined && look.rot % 360 !== 0 ? { rot: look.rot } : {}) };
  }
  const w = c.with !== undefined && c.with.length > 0 ? [...c.with].sort() : null;
  return { ...(w !== null ? { with: w } : {}), pieces };
}

/** The content's rules: `with` names block types of the same placement, and each piece a variant the type has. */
export function composeBlockConnect(t: BlockType, path: string, types: ReadonlyMap<string, BlockType>, errors: ModelErrorV2[]): void {
  const c = t.connect;
  if (c === undefined) return;
  const edge = t.placement === 'edge';
  for (const [i, id] of (c.with ?? []).entries()) {
    const o = types.get(id);
    if (o === undefined) err(errors, 'reference_missing', `${path}/connect/with/${i}`, 'connect.with names block types of content.blockTypes', id);
    else if ((o.placement === 'edge') !== edge) err(errors, 'field_value', `${path}/connect/with/${i}`, edge ? `"${id}" fills cells; an edge piece connects with edge pieces` : `"${id}" is an edge piece; a cell block connects with cell blocks`, id);
  }
  for (const [k, look] of Object.entries(c.pieces)) {
    if (look !== undefined && look.variant >= t.variants.length) err(errors, 'field_value', `${path}/connect/pieces/${k}/variant`, `block "${t.blockId}" has ${t.variants.length} variant(s)`, look.variant);
  }
  const f = t.footprint;
  if (f !== undefined && (f[0] !== 1 || f[1] !== 1 || f[2] !== 1)) err(errors, 'field_value', `${path}/connect`, 'a connected block fills one cell (no larger footprint)', f);
}

// ---- resolution ------------------------------------------------------------------------

/** What resolution reads of a layer. */
export interface ConnectGrid {
  get(x: number, y: number, z: number): BlockCell | null;
  edgeAt(x: number, y: number, z: number, axis: number): BlockEdge | null;
}

const partnersCache = new WeakMap<BlockType, ReadonlySet<string>>();
/** The block ids a type connects with (itself and `with`). */
function partners(t: BlockType): ReadonlySet<string> {
  let s = partnersCache.get(t);
  if (s === undefined) partnersCache.set(t, (s = new Set([t.blockId, ...(t.connect?.with ?? [])])));
  return s;
}

/** Whether a cell or edge type resolves its look from its neighbours. */
export function blockTypeConnects(t: Pick<BlockType, 'connect'> | undefined): boolean {
  return t?.connect !== undefined;
}

// Cell sides as mask bits: −x 1, +x 2, −z 4, +z 8.
const SIDES: readonly [number, number][] = [[-1, 0], [1, 0], [0, -1], [0, 1]];
const CELL_PIECE_MASKS: Readonly<Record<'single' | 'end' | 'straight' | 'corner' | 't' | 'cross', number>> = { single: 0, end: 8, straight: 4 | 8, corner: 2 | 8, t: 1 | 2 | 8, cross: 15 };

/** A side mask turned as a block rotation turns its frame (`rotateXZ`: x' = x cos + z sin, z' = −x sin + z cos). */
function turnMask(mask: number, rot: number): number {
  let out = 0;
  for (let b = 0; b < 4; b++) {
    if ((mask & (1 << b)) === 0) continue;
    const [dx, dz] = SIDES[b]!;
    const c = Math.round(Math.cos((rot * Math.PI) / 180));
    const s = Math.round(Math.sin((rot * Math.PI) / 180));
    const wx = dx * c + dz * s;
    const wz = -dx * s + dz * c;
    out |= 1 << SIDES.findIndex(([x, z]) => x === wx && z === wz);
  }
  return out;
}

/** World side mask → its piece and the rotations that turn the piece onto it. */
const CELL_TABLE: readonly { piece: BlockConnectPiece; rots: number[] }[] = (() => {
  const table: { piece: BlockConnectPiece; rots: number[] }[] = [];
  for (const [piece, mask] of Object.entries(CELL_PIECE_MASKS) as [BlockConnectPiece, number][]) {
    for (const rot of [0, 90, 180, 270]) {
      const m = turnMask(mask, rot);
      (table[m] ??= { piece, rots: [] }).rots.push(rot);
    }
  }
  return table;
})();

/** The rotation to show: the cell's own when it is one that fits, else the first that does. */
const pickRot = (rots: readonly number[], own: number): number => (rots.includes(own) ? own : rots[0]!);

function finish(look: BlockConnectLook, base: number, piece: BlockConnectPiece): ConnectedLook {
  return { variant: look.variant, rot: (base + (look.rot ?? 0)) % 360, piece };
}

/**
 * The look a cell shows: for a connected type (and a cell without a variant
 * of its own) the piece its neighbours call for; otherwise its ordinary look
 * (`ordinary` is its variant or the weighted pick).
 */
export function resolveCellLook(g: Pick<ConnectGrid, 'get'>, t: BlockType, cell: BlockCell, x: number, y: number, z: number, ordinary: number): ConnectedLook {
  const own = cell.rot ?? 0;
  const c = t.connect;
  if (c === undefined || cell.variant !== undefined) return { variant: ordinary, rot: own, piece: null };
  const with_ = partners(t);
  const linked = (nx: number, ny: number, nz: number): boolean => {
    const b = g.get(nx, ny, nz)?.block;
    return b !== undefined && with_.has(b);
  };
  let mask = 0;
  for (let b = 0; b < 4; b++) if (linked(x + SIDES[b]![0], y, z + SIDES[b]![1])) mask |= 1 << b;
  const h = CELL_TABLE[mask]!;
  const hRot = pickRot(h.rots, own);
  const v = verticalPiece(c, linked(x, y + 1, z), linked(x, y - 1, z));
  if (v !== null) return finish(c.pieces[v]!, hRot, v);
  const look = c.pieces[h.piece];
  return look !== undefined ? finish(look, hRot, h.piece) : { variant: ordinary, rot: own, piece: null };
}

function verticalPiece(c: BlockConnect, up: boolean, down: boolean): 'base' | 'cap' | null {
  if (up && !down && c.pieces.base !== undefined) return 'base';
  if (down && !up && c.pieces.cap !== undefined) return 'cap';
  return null;
}

/** The grid points an edge runs between (x, z): its start (the lower coordinate) and its end. */
export function edgeEnds(x: number, z: number, axis: number): [[number, number], [number, number]] {
  return axis === 0 ? [[x, z], [x, z + 1]] : [[x, z], [x + 1, z]];
}

/** Whether the start point (lower coordinate) is the edge piece's +X end at rotation 0 (its frame: +X along the edge, `edgeFrame`). */
const startIsPlusX = (axis: number): boolean => axis === 0;

type EndKind = 'open' | 'line' | 'turn';

/**
 * The look an edge piece shows: for a connected type (and an edge without a
 * variant of its own) the piece its ends and the edges above and below call
 * for; otherwise its ordinary look.
 */
export function resolveEdgeLook(g: ConnectGrid, t: BlockType, edge: BlockEdge, x: number, y: number, z: number, axis: number, ordinary: number): ConnectedLook {
  const own = edge.rot ?? 0;
  const c = t.connect;
  if (c === undefined || edge.variant !== undefined) return { variant: ordinary, rot: own, piece: null };
  const with_ = partners(t);
  const linked = (ex: number, ey: number, ez: number, ea: number): boolean => {
    const b = g.edgeAt(ex, ey, ez, ea)?.block;
    return b !== undefined && with_.has(b);
  };
  const kind = (px: number, pz: number, start: boolean): EndKind => {
    // The edge going on straight from this point, then the two across it.
    const on = axis === 0 ? (start ? linked(px, y, pz - 1, 0) : linked(px, y, pz, 0)) : start ? linked(px - 1, y, pz, 1) : linked(px, y, pz, 1);
    if (on) return 'line';
    const across = axis === 0 ? linked(px - 1, y, pz, 1) || linked(px, y, pz, 1) : linked(px, y, pz - 1, 0) || linked(px, y, pz, 0);
    return across ? 'turn' : 'open';
  };
  const [s, e] = edgeEnds(x, z, axis);
  const ks = kind(s[0], s[1], true);
  const ke = kind(e[0], e[1], false);
  // The ends at rotation 0: +X and −X.
  const [plus0, minus0] = startIsPlusX(axis) ? [ks, ke] : [ke, ks];
  const fits = (want: (plus: EndKind, minus: EndKind) => boolean): number[] => [0, 180].filter((r) => (r === 0 ? want(plus0, minus0) : want(minus0, plus0)));
  let piece: BlockConnectPiece;
  let rots: number[];
  if (ks === 'open' && ke === 'open') [piece, rots] = ['single', [0, 180]];
  else if (ks === 'open' || ke === 'open') [piece, rots] = ['end', fits((p) => p !== 'open')];
  else if ((ks === 'turn' || ke === 'turn') && c.pieces.corner !== undefined) [piece, rots] = ['corner', fits((p) => p === 'turn')];
  else [piece, rots] = ['straight', [0, 180]];
  const hRot = pickRot(rots, own);
  const v = verticalPiece(c, linked(x, y + 1, z, axis), linked(x, y - 1, z, axis));
  if (v !== null) return finish(c.pieces[v]!, hRot, v);
  const look = c.pieces[piece];
  return look !== undefined ? finish(look, hRot, piece) : { variant: ordinary, rot: own, piece: null };
}

// ---- what a write re-resolves ------------------------------------------------------------

/** The cells whose look a write at (x, y, z) can change: its four sides, above and below. */
export function cellConnectNeighbours(x: number, y: number, z: number): [number, number, number][] {
  return [[x - 1, y, z], [x + 1, y, z], [x, y, z - 1], [x, y, z + 1], [x, y - 1, z], [x, y + 1, z]];
}

/** The edges whose look a write at an edge can change: those meeting it at either end, above and below. */
export function edgeConnectNeighbours(x: number, y: number, z: number, axis: number): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  for (const [px, pz] of edgeEnds(x, z, axis)) {
    for (const n of [[px, y, pz - 1, 0], [px, y, pz, 0], [px - 1, y, pz, 1], [px, y, pz, 1]] as [number, number, number, number][]) {
      if (n[0] === x && n[2] === z && n[3] === axis) continue;
      out.push(n);
    }
  }
  out.push([x, y - 1, z, axis], [x, y + 1, z, axis]);
  return out;
}
