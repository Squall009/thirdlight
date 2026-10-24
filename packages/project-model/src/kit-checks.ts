/**
 * The checks of a kit against the trim sheet spec
 * (docs/manual/guides/trim-sheet-spec.md, its checklist): one module for the
 * kit editor (through the backend's kit check), the backend's kit Problems
 * and the Basic Kit's own tests, so a piece or a sheet passes or fails the
 * same way everywhere.
 *
 * - A **piece** (a model, or one named piece of it, in a kit slot): origin at
 *   the bottom centre, sized in whole cells, top-level nodes at the file
 *   origin, `<piece>_LOD0..2` and `<piece>_COL`, UV0 inside the sheet's rows
 *   on what wears the trim sheet, no `COLOR_0` there.
 * - A **sheet** (a trim material's row table, and its albedo's pixels when
 *   they were read): size and density, gutters, the standard slots at the
 *   spec's bounds, rows on the 16 px grid, the safe mip level, the gutters
 *   repeating their rows, seams at the u wrap (and v wrap of fields), a real
 *   height in A.
 *
 * Pure: bytes and values in, check rows out; no I/O.
 */
import { BLOCK_LAYER_DEFAULT } from './block-layers';
import { kitSlotPlacement } from './kits';
export { kitCheckTally } from './kits';
import { isModelHelperNode, MODEL_LOD_RE, modelNodeMatrix, modelPieceName, readModelGeometry, type ModelGeometryPrimitive } from './model-collision';
import { glbChunks, sanitizeRigNodeName } from './model-rig';
import { TRIM_PIECE_PLACE_TOLERANCE, TRIM_SHEET_DEFAULTS, TRIM_STARTER_ROWS, trimPaddingProblems, trimRowMetres, trimRowV, trimSheetProblems, trimSheetSafeMipLevel, type TrimRow, type TrimSheet } from './trim-sheet';

/** ok: meets the spec; warn: draws, but not as the spec asks; err: draws wrong; info: not checked, and why. */
export type KitCheckState = 'ok' | 'warn' | 'err' | 'info';

/** A fix the editor can apply with one command. */
export type KitCheckFix = { kind: 'map-material'; source: string; material: string };

export interface KitCheck {
  /** Stable per check (`origin`, `lods`, `row:floor`, …). */
  id: string;
  state: KitCheckState;
  title: string;
  detail: string;
  /** The sheet row the check is about. */
  row?: string;
  fix?: KitCheckFix;
}

/** The spec's numbers (the 2048² sheet; a 4096² one doubles every pixel number). */
export const TRIM_SPEC = Object.freeze({
  size: TRIM_SHEET_DEFAULTS.size[0],
  texelDensity: TRIM_SHEET_DEFAULTS.texelDensity,
  gutter: TRIM_SHEET_DEFAULTS.padding,
  align: 16,
  safeMipLevel: 4,
  /** A seam at a wrap this many times the pattern's own steps shows on long walls. */
  seamRatio: 1.15,
  /** The spread a real height in A has at least (0–255). */
  heightRange: 20,
  /** How far an origin may sit from the bottom centre, a size from whole cells (metres). */
  placeTolerance: TRIM_PIECE_PLACE_TOLERANCE,
  /** Triangles a piece check reads at most (larger files are checked by their bounds only). */
  uvTriangles: 400_000,
});

const SPEC_SCALES = [1, 2] as const;

/* ------------------------------------------------------------- pieces --- */

/** What a piece's checks read from its file (kept per file version: independent of the kit). */
export interface PieceFacts {
  /** The piece read (`''`: the file as a whole). */
  piece: string;
  /** Every piece the file holds (top-level base names). */
  pieces: string[];
  found: boolean;
  /** Render levels present (`_LOD<n>` numbers; empty: none named). */
  lods: number[];
  /** Triangles per level (one entry when it has no levels). */
  triangles: number[];
  collider: boolean;
  colliderTriangles: number;
  /** LOD0's box in the file's space (null: no geometry read). */
  bounds: { min: [number, number, number]; max: [number, number, number] } | null;
  /** Top-level nodes of the piece that are moved, turned or scaled. */
  moved: { node: string; offset: [number, number, number]; turned: boolean; scaled: boolean }[];
  /** Per source material its render triangles' v ranges ([vmin, vmax] pairs, every level) and whether it has COLOR_0. */
  surfaces: { material: string | null; v: number[]; uvMissing: boolean; colour: boolean }[];
  /** Why the file could not be read (null: it was). */
  unreadable: string | null;
  /** The file has more triangles than the UV check reads (`TRIM_SPEC.uvTriangles`): its UVs were not checked. */
  uvSkipped: boolean;
}

/** Read a model file's facts for one piece (`piece` absent: the whole file). Never throws. */
export function pieceFacts(bytes: Uint8Array, piece?: string): PieceFacts {
  const empty: PieceFacts = { piece: piece ?? '', pieces: [], found: false, lods: [], triangles: [], collider: false, colliderTriangles: 0, bounds: null, moved: [], surfaces: [], unreadable: null, uvSkipped: false };
  const chunks = glbChunks(bytes);
  if (typeof chunks === 'string') return { ...empty, unreadable: chunks };
  const json = chunks.json;
  const nodes = Array.isArray(json['nodes']) ? (json['nodes'] as Record<string, unknown>[]) : [];
  const scenes = Array.isArray(json['scenes']) ? (json['scenes'] as Record<string, unknown>[]) : [];
  const scene = scenes[typeof json['scene'] === 'number' ? json['scene'] : 0];
  const top = (Array.isArray(scene?.['nodes']) ? (scene['nodes'] as unknown[]) : []).flatMap((i) => (typeof i === 'number' && nodes[i] !== undefined ? [nodes[i]!] : []));
  // Node names as three.js gives them (the editor names a piece by those, as the geometry reader does).
  const nameOf = (n: Record<string, unknown>): string => (typeof n['name'] === 'string' ? sanitizeRigNodeName(n['name']) : '');
  const pieces = [...new Set(top.map((n) => modelPieceName(nameOf(n))))];
  const renderPieces = pieces.filter((p) => top.some((n) => modelPieceName(nameOf(n)) === p && !isModelHelperNode(nameOf(n))));
  const want = piece ?? '';
  const mine = (name: string): boolean => want === '' || modelPieceName(name) === want;
  const found = want === '' ? top.length > 0 : renderPieces.includes(want);
  const facts: PieceFacts = { ...empty, pieces: renderPieces, found };
  if (!found) return facts;
  for (const n of top) {
    const name = nameOf(n);
    if (!mine(name)) continue;
    // The node's matrix as the geometry reader applies it: its columns' lengths are the scale, what is left the turn.
    const m = modelNodeMatrix(n);
    const offset: [number, number, number] = [m[12]!, m[13]!, m[14]!];
    const lengths = [0, 1, 2].map((c) => Math.hypot(m[c * 4]!, m[c * 4 + 1]!, m[c * 4 + 2]!));
    const scaled = lengths.some((l) => Math.abs(l - 1) > 1e-6);
    const turned = [0, 1, 2].some((c) => [0, 1, 2].some((r) => Math.abs(m[c * 4 + r]! / (lengths[c]! || 1) - (c === r ? 1 : 0)) > 1e-6));
    if (turned || scaled || offset.some((x) => Math.abs(x) > 1e-6)) facts.moved.push({ node: name, offset, turned, scaled });
    const lod = MODEL_LOD_RE.exec(name);
    if (lod !== null) facts.lods.push(Number(lod[2]));
  }
  facts.lods = [...new Set(facts.lods)].sort((a, b) => a - b);
  const read = readModelGeometry(bytes, { surface: true });
  if (!read.ok) return { ...facts, unreadable: read.message };
  const prims = read.geometry.primitives.filter((p) => want === '' || p.piece === want);
  const levels = new Map<number, number>();
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const surfaces = new Map<string | null, PieceFacts['surfaces'][number]>();
  let triangles = 0;
  for (const p of prims) {
    // An occluder stand-in is never drawn: not part of the piece's levels, bounds or surfaces.
    if (p.occluder) continue;
    if (p.collision) {
      if (p.pieceCollision) {
        facts.collider = true;
        facts.colliderTriangles += p.triangles.length;
      }
      continue;
    }
    const level = p.lod ?? 0;
    levels.set(level, (levels.get(level) ?? 0) + p.triangles.length);
    if (level === (facts.lods[0] ?? 0)) for (const q of p.positions) for (let k = 0; k < 3; k++) {
      if (q[k]! < min[k]!) min[k] = q[k]!;
      if (q[k]! > max[k]!) max[k] = q[k]!;
    }
    triangles += p.triangles.length;
    let s = surfaces.get(p.material ?? null);
    if (s === undefined) {
      s = { material: p.material ?? null, v: [], uvMissing: false, colour: false };
      surfaces.set(p.material ?? null, s);
    }
    if (p.colour === true) s.colour = true;
    if (triangles <= TRIM_SPEC.uvTriangles) addVRanges(s, p);
    else facts.uvSkipped = true;
  }
  facts.triangles = [...levels.entries()].sort((a, b) => a[0] - b[0]).map(([, n]) => n);
  facts.bounds = Number.isFinite(min[0]) ? { min, max } : null;
  facts.surfaces = [...surfaces.values()];
  return facts;
}

function addVRanges(s: PieceFacts['surfaces'][number], p: ModelGeometryPrimitive): void {
  const uv = p.uv;
  if (uv === null || uv === undefined) {
    if (p.triangles.length > 0) s.uvMissing = true;
    return;
  }
  for (const t of p.triangles) {
    const a = uv[t[0] * 2 + 1]!, b = uv[t[1] * 2 + 1]!, c = uv[t[2] * 2 + 1]!;
    s.v.push(Math.min(a, b, c), Math.max(a, b, c));
  }
}

export interface PieceCheckContext {
  slot: string;
  /** The kit's trim sheet: its material id and row table (absent: the kit has none). */
  sheet?: { materialId: string; trim: TrimSheet };
  /** The asset's material map (source material name → material id). */
  materials?: Readonly<Record<string, string>>;
  /** The block cell's width and height (metres; absent: the default cell). */
  cell?: number;
}

const m2 = (x: number): string => x.toFixed(2);
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** Where the bottom centre sits from the origin, in words ("0.40 m right (+X)"). */
function offsetWords(dx: number, dy: number, dz: number, tol: number): string {
  const out: string[] = [];
  if (Math.abs(dx) > tol) out.push(`${m2(Math.abs(dx))} m ${dx > 0 ? 'right (+X)' : 'left (−X)'}`);
  if (Math.abs(dz) > tol) out.push(`${m2(Math.abs(dz))} m ${dz > 0 ? 'forward (+Z)' : 'back (−Z)'}`);
  if (Math.abs(dy) > tol) out.push(`${m2(Math.abs(dy))} m ${dy > 0 ? 'up' : 'down'}`);
  return out.join(', ');
}

/** The checks of one piece in a slot, in the spec checklist's order. */
export function kitPieceChecks(f: PieceFacts, ctx: PieceCheckContext): KitCheck[] {
  const name = f.piece !== '' ? f.piece : 'the model';
  if (f.unreadable !== null && !f.found) return [{ id: 'file', state: 'err', title: 'The file could not be read', detail: f.unreadable }];
  if (!f.found) return [{ id: 'file', state: 'err', title: `The file has no piece “${f.piece}”`, detail: f.pieces.length > 0 ? `Its pieces: ${f.pieces.join(', ')}. Pick one of them.` : 'It has no pieces (top-level nodes).' }];
  const out: KitCheck[] = [];
  const tol = TRIM_SPEC.placeTolerance;
  const cell = ctx.cell ?? BLOCK_LAYER_DEFAULT.cellSize[0];
  const b = f.bounds;
  if (b === null) out.push({ id: 'origin', state: 'info', title: 'Origin not checked', detail: f.unreadable ?? 'No render geometry was read.' });
  else {
    const dx = (b.min[0] + b.max[0]) / 2;
    const dz = (b.min[2] + b.max[2]) / 2;
    const dy = b.min[1];
    const off = offsetWords(dx, dy, dz, tol);
    out.push(off === '' ? { id: 'origin', state: 'ok', title: 'Origin at the bottom centre', detail: 'It stands on its cell where the engine places it.' } : { id: 'origin', state: 'err', title: 'Origin is not at the bottom centre', detail: `Its bottom centre is ${off} of the file's origin, so it draws that far off its cell. Move the geometry (or the origin) in the modelling tool and export again.` });
  }
  if (f.moved.length === 0) out.push({ id: 'transform', state: 'ok', title: 'Node transform at the file origin', detail: 'Its top-level nodes have no offset, turn or scale.' });
  else {
    const m = f.moved[0]!;
    const what = [m.offset.some((x) => Math.abs(x) > 1e-6) ? `moved ${m.offset.map(m2).join(', ')} m` : '', m.turned ? 'turned' : '', m.scaled ? 'scaled' : ''].filter((x) => x !== '').join(', ');
    out.push({ id: 'transform', state: 'err', title: 'Node transform is not applied', detail: `${m.node} is ${what}${f.moved.length > 1 ? ` (and ${plural(f.moved.length - 1, 'more node')})` : ''}: the engine keeps a node's own transform, so the piece draws offset. Apply the transforms before export.` });
  }
  if (b !== null) {
    const w = b.max[0] - b.min[0], h = b.max[1] - b.min[1], d = b.max[2] - b.min[2];
    const whole = (x: number): boolean => x >= cell - tol && Math.abs(x / cell - Math.round(x / cell)) * cell <= tol;
    const placement = kitSlotPlacement(ctx.slot);
    const upright = placement.kind !== 'free';
    const bad: string[] = [];
    if (!whole(w)) bad.push(`its width ${m2(w)} m is not a whole number of ${m2(cell)} m cells`);
    if (upright && !whole(h)) bad.push(`its height ${m2(h)} m is not a whole number of cells`);
    if (upright && d > cell + tol) bad.push(`it is ${m2(d)} m deep, more than a cell`);
    const size = `${m2(w)} × ${m2(h)} m (${m2(d)} m deep)`;
    out.push(bad.length === 0 ? { id: 'size', state: 'ok', title: 'Size fits the cell', detail: `${size}: ${Math.round(w / cell)} × ${upright ? Math.round(h / cell) : '—'} cells of ${m2(cell)} m.` } : { id: 'size', state: 'warn', title: 'Size does not fit the cells', detail: `${size}: ${bad.join('; ')}. Pieces snap to the grid by whole cells.` });
  }
  const base = f.piece !== '' ? f.piece : (f.pieces[0] ?? '<piece>');
  out.push(f.collider ? { id: 'collision', state: 'ok', title: '_COL collision present', detail: `${base}_COL: ${plural(f.colliderTriangles, 'triangle')}.` } : { id: 'collision', state: 'warn', title: '_COL collision missing', detail: `Nothing named ${base}_COL: players walk through it. Add a few boxes or convex parts named so.` });
  const levels = f.lods.length;
  const tris = f.triangles.map((n, i) => (levels > 0 ? `LOD${f.lods[i] ?? i} ${n}` : `${n}`)).join(' · ');
  if (levels >= 3) out.push({ id: 'lods', state: 'ok', title: `LOD 0–${f.lods[levels - 1]} present`, detail: `Triangles: ${tris}.` });
  else if (levels === 0) out.push({ id: 'lods', state: 'warn', title: 'No levels of detail', detail: `${name} has ${tris} triangles and no ${base}_LOD0..2 nodes: it is drawn in full at any distance.` });
  else out.push({ id: 'lods', state: 'warn', title: `LOD ${levels} missing`, detail: `It has ${levels === 1 ? 'only LOD0' : `LOD 0–${f.lods[levels - 1]}`} (${tris} triangles). Pieces are seen far away on streets; add levels down to LOD 2 (about ½ and ¼ of LOD0).` });
  out.push(...uvChecks(f, ctx));
  return out;
}

function uvChecks(f: PieceFacts, ctx: PieceCheckContext): KitCheck[] {
  if (ctx.sheet === undefined) return [{ id: 'uvs', state: 'info', title: 'UVs not checked', detail: 'The kit has no trim sheet yet.' }];
  const sheet = ctx.sheet;
  const mapping = ctx.materials ?? {};
  const onSheet = f.surfaces.filter((s) => s.material !== null && mapping[s.material] === sheet.materialId);
  const out: KitCheck[] = [];
  if (onSheet.length === 0) {
    const names = f.surfaces.flatMap((s) => (s.material !== null ? [s.material] : []));
    const guess = names.find((n) => /trim/i.test(n)) ?? (names.length === 1 ? names[0] : undefined);
    out.push({
      id: 'uvs',
      state: 'info',
      title: 'Not on the trim sheet',
      detail: names.length === 0 ? 'Its parts have no named materials, so none can wear the kit\'s trim sheet.' : `None of its materials (${names.join(', ')}) is mapped to the kit's trim sheet, so it draws with its own.${guess !== undefined ? ` Map “${guess}” to the sheet to restyle it with the kit.` : ''}`,
      ...(guess !== undefined ? { fix: { kind: 'map-material' as const, source: guess, material: sheet.materialId } } : {}),
    });
    return out;
  }
  const rows = sheet.trim.rows.map((r) => ({ slot: r.slot, v: trimRowV(sheet.trim, r) }));
  const eps = 1e-5;
  let total = 0;
  let outside = 0;
  let worst: [number, number] | null = null;
  const used = new Set<string>();
  const missing = onSheet.filter((s) => s.uvMissing).map((s) => s.material!);
  for (const s of onSheet) {
    for (let i = 0; i < s.v.length; i += 2) {
      const lo = s.v[i]!, hi = s.v[i + 1]!;
      total += 1;
      const row = rows.find((r) => lo >= r.v[0] - eps && hi <= r.v[1] + eps);
      if (row === undefined) {
        outside += 1;
        if (worst === null || hi - lo > worst[1] - worst[0]) worst = [lo, hi];
      } else used.add(row.slot);
    }
  }
  if (f.uvSkipped) out.push({ id: 'uvs', state: 'info', title: 'UVs not checked', detail: `It has ${plural(f.triangles.reduce((a, b) => a + b, 0), 'triangle')}, more than the ${TRIM_SPEC.uvTriangles.toLocaleString('en')} the check reads: check that its faces stay inside one row each in the modelling tool.` });
  else if (missing.length > 0) out.push({ id: 'uvs', state: 'err', title: 'No UVs on the trim sheet', detail: `${missing.join(', ')} wears the trim sheet without texture coordinates (UV0): it draws one pixel of it.` });
  else if (outside > 0) out.push({ id: 'uvs', state: 'err', title: 'UVs outside the sheet\'s rows', detail: `${outside} of ${plural(total, 'triangle')} on the sheet span two rows or reach a gutter${worst !== null ? ` (v ${worst[0].toFixed(3)}–${worst[1].toFixed(3)})` : ''}. Keep every face's v inside one row's inset bounds (the spec's table).` });
  else out.push({ id: 'uvs', state: 'ok', title: 'UVs inside the sheet\'s rows', detail: `${onSheet.map((s) => s.material).join(', ')} on ${[...used].join(', ') || 'no row'}${f.surfaces.length > onSheet.length ? `; ${f.surfaces.filter((s) => !onSheet.includes(s)).map((s) => s.material ?? 'unnamed').join(', ')} on ${f.surfaces.length - onSheet.length === 1 ? 'its own material' : 'their own materials'}` : ''}.` });
  const coloured = onSheet.filter((s) => s.colour).map((s) => s.material!);
  out.push(coloured.length === 0 ? { id: 'colour', state: 'ok', title: 'No vertex colours on the sheet', detail: 'It reads clean, dry and unoccluded.' } : { id: 'colour', state: 'warn', title: 'Vertex colours on the trim sheet', detail: `${coloured.join(', ')} carries COLOR_0, which the file check takes as trim data and moves out of COLOR_0 (R occlusion, B wetness: white = fully occluded and wet). Leave it out unless it means that.` });
  return out;
}

/* -------------------------------------------------------------- sheets --- */

/** A sheet's albedo pixels (8-bit RGBA, rows top first), with how far lossy compression may move a gutter. */
export interface SheetImage {
  rgba: Uint8Array;
  width: number;
  height: number;
  tolerance: number;
  /** The pixels are an ETC1S KTX2's: gutters that differ are not judged (its blocks move them as much as a fault would). */
  lossy?: boolean;
}

/** One row of the checker's table: where it is and the worst state of its checks. */
export interface SheetRowView {
  slot: string;
  kind: 'tile_uv' | 'tile_u';
  metres: number;
  top: number;
  bottom: number;
  standard: boolean;
  state: KitCheckState;
}

export interface SheetCheckReport {
  checks: KitCheck[];
  rows: SheetRowView[];
  /** The spec's scale this sheet is checked at (1: 2048², 2: 4096²). */
  scale: number;
}

const WORST: Record<KitCheckState, number> = { ok: 0, info: 0, warn: 1, err: 2 };

/** The trim sheet spec's checklist run on a row table (and its albedo when read). */
export function trimSpecChecks(sheet: TrimSheet, image?: SheetImage | null): SheetCheckReport {
  const checks: KitCheck[] = [];
  const [w, h] = sheet.size;
  const scale = SPEC_SCALES.find((k) => w === TRIM_SPEC.size * k) ?? 1;
  const size = TRIM_SPEC.size * scale;
  const density = TRIM_SPEC.texelDensity * scale;
  const gutter = TRIM_SPEC.gutter * scale;
  const align = TRIM_SPEC.align * scale;
  const pow2 = (n: number): boolean => n > 0 && (n & (n - 1)) === 0;
  const sizeOk = w === size && h === size && sheet.texelDensity === density;
  checks.push(
    sizeOk
      ? { id: 'size', state: 'ok', title: `Sheet is ${size}² at ${density} px/m`, detail: `Power-of-two sides; a strip is ${size / density} m across before it repeats.` }
      : { id: 'size', state: pow2(w) && pow2(h) ? 'warn' : 'err', title: `Sheet is ${w === h ? `${w}²` : `${w} × ${h}`} at ${sheet.texelDensity} px/m`, detail: `The spec asks for 2048² at 512 px/m (a 4 m repeat across)${pow2(w) && pow2(h) ? '' : '; sides that are not powers of two do not halve evenly into mips'}.` },
  );
  checks.push(sheet.padding === gutter ? { id: 'gutters', state: 'ok', title: `Gutters are ${gutter} px`, detail: 'Above and below every row.' } : { id: 'gutters', state: 'warn', title: `Gutters are ${sheet.padding} px`, detail: `The spec asks for ${gutter} px so mips do not bleed.` });
  const rowState = new Map<string, KitCheckState>();
  const flag = (c: KitCheck): void => {
    checks.push(c);
    if (c.row !== undefined) rowState.set(c.row, WORST[c.state] > WORST[rowState.get(c.row) ?? 'ok'] ? c.state : (rowState.get(c.row) ?? 'ok'));
  };
  const standardSlots = new Set(TRIM_STARTER_ROWS.map((r) => r.slot));
  const bands = TRIM_STARTER_ROWS.map((r) => ({ slot: r.slot, top: r.top * scale - gutter, bottom: r.bottom * scale + gutter }));
  const missing: string[] = [];
  for (const spec of TRIM_STARTER_ROWS) {
    const r = sheet.rows.find((x) => x.slot === spec.slot);
    if (r === undefined) {
      missing.push(spec.slot);
      continue;
    }
    const top = spec.top * scale, bottom = spec.bottom * scale;
    if (r.top === top && r.bottom === bottom && (r.tileV === true) === (spec.tileV === true)) continue;
    const grid = (r.top - gutter) % align === 0 && (r.bottom - r.top) % align === 0;
    if (!grid) flag({ id: `row:${r.slot}`, state: 'err', row: r.slot, title: `${r.slot} starts at ${r.top} px`, detail: `Rows start on the ${align} px grid (${gutter} px into a band): move it to ${top} px.` });
    else if ((r.tileV === true) !== (spec.tileV === true)) flag({ id: `row:${r.slot}`, state: 'warn', row: r.slot, title: `${r.slot} is a ${r.tileV === true ? 'field (tile_uv)' : 'trim (tile_u)'}`, detail: `The spec makes it a ${spec.tileV === true ? 'field that tiles both ways' : 'trim that tiles along u only'}.` });
    else flag({ id: `row:${r.slot}`, state: 'warn', row: r.slot, title: `${r.slot} is at ${r.top}–${r.bottom} px`, detail: `The spec puts it at ${top}–${bottom} px; a sheet with it elsewhere does not swap in for other kits' sheets.` });
  }
  if (missing.length > 0) checks.push({ id: 'slots', state: 'warn', title: `${plural(missing.length, 'standard slot')} missing`, detail: `${missing.join(', ')}: parts and block faces that read ${missing.length === 1 ? 'it' : 'them'} fall back to another row or are not drawn.` });
  for (const r of sheet.rows) {
    if (standardSlots.has(r.slot)) continue;
    if ((r.top - gutter) % align !== 0 || (r.bottom - r.top) % align !== 0) flag({ id: `row:${r.slot}`, state: 'err', row: r.slot, title: `${r.slot} starts at ${r.top} px`, detail: `Rows start on the ${align} px grid and are a multiple of ${align} px tall: move it to ${Math.ceil((r.top - gutter) / align) * align + gutter} px.` });
    const hit = bands.find((b) => r.top - gutter < b.bottom && r.bottom + gutter > b.top && sheet.rows.some((x) => x.slot === b.slot));
    if (hit !== undefined) flag({ id: `free:${r.slot}`, state: 'warn', row: r.slot, title: `${r.slot} takes the standard “${hit.slot}” row's pixels`, detail: 'Extra rows go in free pixels, so the sheet keeps every standard slot at its bounds.' });
  }
  const safe = trimSheetSafeMipLevel(sheet);
  checks.push(safe >= TRIM_SPEC.safeMipLevel ? { id: 'mips', state: 'ok', title: `Rows read cleanly to mip level ${safe}`, detail: 'Distant trims do not bleed into the next row.' } : { id: 'mips', state: 'warn', title: `Rows bleed from mip level ${safe + 1}`, detail: `The spec's layout reads cleanly to level ${TRIM_SPEC.safeMipLevel}; wider gutters or aligned bands raise it.` });
  for (const p of trimSheetProblems(sheet)) flag({ id: `table:${p.slot ?? 'sheet'}`, state: 'warn', ...(p.slot !== null ? { row: p.slot } : {}), title: p.slot !== null ? `${p.slot}: the row table` : 'The row table', detail: p.message });
  if (image === undefined || image === null) checks.push({ id: 'pixels', state: 'info', title: 'The image was not read', detail: 'Gutters, seams and height in A are checked from the sheet\'s albedo: run Check all.' });
  else imageChecks(sheet, image, flag);
  const rows: SheetRowView[] = [...sheet.rows].sort((a, b) => a.top - b.top).map((r) => ({ slot: r.slot, kind: r.tileV === true ? 'tile_uv' : 'tile_u', metres: trimRowMetres(sheet, r), top: r.top, bottom: r.bottom, standard: standardSlots.has(r.slot), state: rowState.get(r.slot) ?? 'ok' }));
  return { checks, rows, scale };
}

function imageChecks(sheet: TrimSheet, img: SheetImage, flag: (c: KitCheck) => void): void {
  if (img.width !== sheet.size[0] || img.height !== sheet.size[1]) {
    flag({ id: 'pixels', state: 'err', title: `The image is ${img.width} × ${img.height}`, detail: `The row table says ${sheet.size[0]} × ${sheet.size[1]}: every row lands in the wrong place.` });
    return;
  }
  let padding = trimPaddingProblems(img.rgba, img.width, img.height, sheet, img.tolerance);
  if (img.lossy === true && padding.length > 0) {
    const worst = Math.max(...padding.map((p) => p.difference));
    flag({ id: 'gutter', state: 'info', title: 'Gutters not judged from this image', detail: `The albedo is an ETC1S KTX2: its gutters differ from their rows by up to ${worst} (of 255), but its blocks move the pixels where a row meets its gutter as much as a real fault would. Check the sheet's PNG export, or use a UASTC KTX2.` });
    padding = [];
  } else if (padding.length === 0) flag({ id: 'gutter', state: 'ok', title: 'Gutters repeat their rows', detail: 'Fields continue their wrap, trims repeat their edge.' });
  for (const p of padding) flag({ id: `gutter:${p.slot}:${p.side}`, state: 'warn', row: p.slot, title: `${p.slot}: gutter ${p.side} does not repeat the row`, detail: `Pixel row ${p.y} differs by ${p.difference} (of 255): mips mix the neighbour in. ${sheet.rows.find((r) => r.slot === p.slot)?.tileV === true ? 'Continue the wrap' : 'Repeat the edge row'} into the gutter.` });
  let flat: string[] = [];
  let seams = 0;
  for (const r of sheet.rows) {
    const u = seamRatio(img, r, 'u');
    if (u > TRIM_SPEC.seamRatio) {
      seams += 1;
      flag({ id: `seam-u:${r.slot}`, state: 'warn', row: r.slot, title: `${r.slot}: tiling seam ${u.toFixed(2)}× at the u wrap`, detail: `Above ${TRIM_SPEC.seamRatio} the seam shows on long walls: the left edge should continue the right.` });
    }
    if (r.tileV === true) {
      const v = seamRatio(img, r, 'v');
      if (v > TRIM_SPEC.seamRatio) {
        seams += 1;
        flag({ id: `seam-v:${r.slot}`, state: 'warn', row: r.slot, title: `${r.slot}: tiling seam ${v.toFixed(2)}× at the v wrap`, detail: 'A field stacks up a wall: its top pixel row should continue from its bottom one.' });
      }
    }
    if (!realHeight(img, r)) flat = [...flat, r.slot];
  }
  if (seams === 0) flag({ id: 'seams', state: 'ok', title: 'Rows tile without a seam', detail: 'Along u, and fields in v too.' });
  if (flat.length === 0) flag({ id: 'height', state: 'ok', title: 'Height in the albedo alpha', detail: 'Blends between layers stay sharp.' });
  else flag({ id: 'height', state: 'warn', title: flat.length === sheet.rows.length ? 'No height in the albedo alpha' : `No height in A on ${flat.join(', ')}`, detail: 'A is opaque or one value: layered blends (moss in the joints) fade evenly instead. Pack the height into A.' });
}

/** A channel step between two pixels (RGB, the largest). */
function step(d: Uint8Array, a: number, b: number): number {
  return Math.max(Math.abs(d[a]! - d[b]!), Math.abs(d[a + 1]! - d[b + 1]!), Math.abs(d[a + 2]! - d[b + 2]!));
}

/**
 * How much the step across a row's wrap stands out: the mean step across
 * it over the larger of the steps across the row's middle and its quarters
 * (the same place of a pattern whose repeat divides the strip) and the 95th
 * percentile of every other step. A pattern seam that falls on the edge
 * (a panel joint) recurs in the middle too, so only a break in the wrap
 * stands out.
 */
function seamRatio(img: SheetImage, r: TrimRow, axis: 'u' | 'v'): number {
  const { rgba, width } = img;
  const along = axis === 'u' ? width : r.bottom - r.top;
  const across = axis === 'u' ? r.bottom - r.top : width;
  if (along < 8 || across < 1) return 0;
  const px = (i: number, j: number): number => (axis === 'u' ? ((r.top + j) * width + i) * 4 : ((r.top + i) * width + j) * 4);
  const stride = Math.max(1, Math.floor(across / 64));
  const meanStep = (i: number): number => {
    let sum = 0;
    let n = 0;
    for (let j = 0; j < across; j += stride) {
      sum += step(rgba, px(i, j), px((i + 1) % along, j));
      n += 1;
    }
    return sum / n;
  };
  const wrap = meanStep(along - 1);
  const steps: number[] = [];
  const every = Math.max(1, Math.floor(along / 256));
  for (let i = 0; i < along - 1; i += every) steps.push(meanStep(i));
  steps.sort((a, b) => a - b);
  const p95 = steps[Math.floor(steps.length * 0.95)] ?? 0;
  const same = Math.max(meanStep(Math.floor(along / 2) - 1), meanStep(Math.floor(along / 4) - 1), meanStep(Math.floor((3 * along) / 4) - 1));
  const ref = Math.max(p95, same, 1);
  return wrap / ref;
}

/** A real height in a row's A: not opaque, not one value. */
function realHeight(img: SheetImage, r: TrimRow): boolean {
  let lo = 255;
  let hi = 0;
  for (let y = r.top; y < r.bottom; y += 4) for (let x = 0; x < img.width; x += 16) {
    const a = img.rgba[(y * img.width + x) * 4 + 3]!;
    if (a < lo) lo = a;
    if (a > hi) hi = a;
  }
  return hi - lo > TRIM_SPEC.heightRange && lo < 255;
}

/** One piece of a kit slot as the kit check reports it (the backend's `GET …/kits/:kitId/check`). */
export interface KitPieceReport {
  slot: string;
  index: number;
  assetId: string;
  piece?: string;
  weight?: number;
  /** The model is in the project. */
  present: boolean;
  /** The pieces its file holds (to pick another). */
  pieces: string[];
  triangles: number[];
  lods: number[];
  collider: boolean;
  /** LOD0's size across, up and deep in metres (absent: no geometry read): what an opening sized to the piece takes. */
  size?: [number, number, number];
  /** The model's material map (its file's material names → project materials; absent: none). */
  materials?: Record<string, string>;
  checks: KitCheck[];
}

export interface KitSheetReport {
  materialId: string;
  name: string;
  /** The albedo texture whose pixels are checked (null: the material has none). */
  albedo: string | null;
  trim: TrimSheet;
  report: SheetCheckReport;
  /** The pixels were read and checked (false: not asked, or could not be read: `imageError`). */
  imageRead: boolean;
  imageError?: string;
}

export interface KitCheckReport {
  ok: true;
  kitId: string;
  sheet: KitSheetReport | null;
  pieces: KitPieceReport[];
}
