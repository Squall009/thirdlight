/**
 * Trim sheets: one 2D texture set (albedo, normal, ORM) whose rows are
 * strips that tile along u, and the row table that says where each row is.
 *
 * Generated architecture draws every row as its own strip of geometry: u
 * runs along the strip in metres (times the row's texel density), v stays
 * inside the row's pixel bounds. A sheet is one texture of each kind, so it
 * costs a fraction of a texture array's memory, gives the strips the vertex
 * density that painted grime and wetness need, and lets rows differ in
 * height (a thin moulding beside a tall wall panel).
 *
 * Rows name semantic slots (`floor`, `lower_wall`, `baseboard`, …): a row
 * layout is the set of slots a generator asks for, and any sheet that has
 * those slots swaps in for another (`trimLayoutMissing`).
 *
 * Bleeding. A strip must show only its row, also where filtering reads
 * around the sample: bilinear reads a texel either side, mips average 2^L
 * pixels, and a floor seen at a grazing angle reaches deep into the chain.
 * Three rules keep each row's reads inside the row's own pixels:
 * - every row has `padding` pixels above and below that repeat its edge (or,
 *   for a row that tiles in v, continue its wrap) — the Texture Designer's
 *   gutter;
 * - the strip's v is inset by half a texel at the row's edges, so level 0
 *   reads only the row (`trimRowV`);
 * - the material caps the sampling footprint at the deepest mip level whose
 *   reads stay inside the padded row (`trimSheetSafeMipLevel`): past it a
 *   level-L texel would straddle the neighbour. Distant trims then alias a
 *   little rather than bleed; more padding (or rows aligned to 2^L) raises
 *   the cap.
 * The level bound assumes box-filtered mips (each level the mean of 2 × 2
 * texels, as the browsers' mip generation and the Texture Designer's
 * wrap-filtered mips are); a wider mip filter needs a pixel or two more
 * padding.
 *
 * Vertex colours (COLOR_0) on trim meshes are data: R occlusion (0 open,
 * 1 fully occluded), G grime weight, B wetness; A is unused. A mesh without
 * them reads (0, 0, 0, 1): clean, dry, unoccluded. The material blends them
 * with no texture read of their own.
 *
 * Pure data rules, no I/O: the editor, the backend's padding check, the
 * renderer and the generator share them (`@thirdlight/project-model/trim-sheet`).
 */
import { ID_RE } from './validate';

/** A row's place on the sheet: pixel rows `top` (inclusive) to `bottom` (exclusive), counted from the image's top. */
export interface TrimRow {
  /** The semantic slot the row fills (an id: `floor`, `lower_wall`, …); unique on the sheet. */
  slot: string;
  top: number;
  bottom: number;
  /** Pixels per metre along u for this row (absent: the sheet's). */
  texelDensity?: number;
  /** The row tiles in v too (its padding continues its wrap, and strips may stack it up a wall). */
  tileV?: boolean;
}

/** A trim sheet's row table (a trim material's `trim`). */
export interface TrimSheet {
  /** The sheet's size in pixels [width, height] (level 0 of its textures). */
  size: [number, number];
  /** Pixels per metre along u (each row may set its own). */
  texelDensity: number;
  /** Pixels above and below every row that repeat its edge (or continue its wrap). */
  padding: number;
  rows: TrimRow[];
}

/** The largest sheet side (pixels): the textures' own limit on the GPUs the engine targets. */
export const TRIM_SHEET_SIZE_MAX = 16384;
/** Texel density bounds (pixels per metre). */
export const TRIM_DENSITY_MIN = 1;
export const TRIM_DENSITY_MAX = 65536;
/** The most padding a row may declare (pixels). */
export const TRIM_PADDING_MAX = 256;
/** A new sheet's values: 1024², 256 px/m (a 4 m wide strip), 8 px of padding (the Texture Designer's gutter). */
export const TRIM_SHEET_DEFAULTS = { size: [1024, 1024] as [number, number], texelDensity: 256, padding: 8 } as const;
/**
 * The engine's neutral starter layout: the slots a generated room or
 * building asks for. A game's sheets may add slots of their own; a sheet
 * conforms to a layout when it has all of the layout's slots.
 */
export const TRIM_STARTER_LAYOUT: readonly string[] = ['floor', 'lower_wall', 'upper_wall', 'baseboard', 'crown', 'frame', 'column', 'bevel', 'emissive'];
/** COLOR_0 channels on trim meshes (see the module comment). */
export const TRIM_COLOUR_OCCLUSION = 0;
export const TRIM_COLOUR_GRIME = 1;
export const TRIM_COLOUR_WETNESS = 2;

/** A problem with a row table: where (a JSON pointer below the table) and what. */
export interface TrimSheetError {
  path: string;
  message: string;
  /** An unknown field: the fields allowed there. */
  allowed?: readonly string[];
}

const SHEET_FIELDS = ['size', 'texelDensity', 'padding', 'rows'] as const;
const ROW_FIELDS = ['slot', 'top', 'bottom', 'texelDensity', 'tileV'] as const;

const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const isNum = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The table's shape problems (empty: valid): sizes and bounds in range,
 * slots unique, rows inside the sheet and not overlapping. Padding that is
 * too thin is a warning (`trimSheetProblems`), not an error: an
 * off-the-shelf sheet still draws.
 */
export function trimSheetErrors(v: unknown): TrimSheetError[] {
  const out: TrimSheetError[] = [];
  if (!isObject(v)) return [{ path: '', message: 'a trim sheet is an object {size, texelDensity, padding, rows}' }];
  for (const k of Object.keys(v)) if (!(SHEET_FIELDS as readonly string[]).includes(k)) out.push({ path: `/${k}`, message: `unknown trim sheet field "${k}"`, allowed: SHEET_FIELDS });
  const size = v['size'];
  const sized = Array.isArray(size) && size.length === 2 && isInt(size[0], 1, TRIM_SHEET_SIZE_MAX) && isInt(size[1], 1, TRIM_SHEET_SIZE_MAX);
  if (!sized) out.push({ path: '/size', message: `size is [width, height] in pixels, 1-${TRIM_SHEET_SIZE_MAX} each` });
  if (!isNum(v['texelDensity'], TRIM_DENSITY_MIN, TRIM_DENSITY_MAX)) out.push({ path: '/texelDensity', message: `texelDensity is pixels per metre, ${TRIM_DENSITY_MIN}-${TRIM_DENSITY_MAX}` });
  if (!isInt(v['padding'], 0, TRIM_PADDING_MAX)) out.push({ path: '/padding', message: `padding is whole pixels, 0-${TRIM_PADDING_MAX}` });
  const rows = v['rows'];
  if (!Array.isArray(rows) || rows.length === 0) {
    out.push({ path: '/rows', message: 'rows lists at least one row {slot, top, bottom}' });
    return out;
  }
  const height = sized ? (size as number[])[1]! : TRIM_SHEET_SIZE_MAX;
  const slots = new Set<string>();
  const spans: [number, number, number][] = [];
  rows.forEach((r, i) => {
    const p = `/rows/${i}`;
    if (!isObject(r)) {
      out.push({ path: p, message: 'a row is an object {slot, top, bottom, texelDensity?, tileV?}' });
      return;
    }
    for (const k of Object.keys(r)) if (!(ROW_FIELDS as readonly string[]).includes(k)) out.push({ path: `${p}/${k}`, message: `unknown row field "${k}"`, allowed: ROW_FIELDS });
    const slot = r['slot'];
    if (typeof slot !== 'string' || !ID_RE.test(slot)) out.push({ path: `${p}/slot`, message: 'a slot uses the id syntax [a-z0-9][a-z0-9_-]{0,63}' });
    else if (slots.has(slot)) out.push({ path: `${p}/slot`, message: `slot "${slot}" is used by two rows` });
    else slots.add(slot);
    const top = r['top'];
    const bottom = r['bottom'];
    if (!isInt(top, 0, height - 1)) out.push({ path: `${p}/top`, message: `top is a pixel row inside the sheet (0-${height - 1})` });
    if (!isInt(bottom, 1, height)) out.push({ path: `${p}/bottom`, message: `bottom is a pixel row inside the sheet (1-${height}), exclusive` });
    else if (isInt(top, 0, height - 1)) {
      if (bottom <= top) out.push({ path: `${p}/bottom`, message: 'bottom is below top (a row is at least one pixel tall)' });
      else spans.push([top, bottom, i]);
    }
    if (r['texelDensity'] !== undefined && !isNum(r['texelDensity'], TRIM_DENSITY_MIN, TRIM_DENSITY_MAX)) out.push({ path: `${p}/texelDensity`, message: `texelDensity is pixels per metre, ${TRIM_DENSITY_MIN}-${TRIM_DENSITY_MAX}` });
    if (r['tileV'] !== undefined && typeof r['tileV'] !== 'boolean') out.push({ path: `${p}/tileV`, message: 'tileV is true or false' });
  });
  spans.sort((a, b) => a[0] - b[0]);
  for (let k = 1; k < spans.length; k++) {
    const [top, , i] = spans[k]!;
    const [, prevBottom, j] = spans[k - 1]!;
    if (top < prevBottom) out.push({ path: `/rows/${i}/top`, message: `row ${i} overlaps row ${j}` });
  }
  return out;
}

/** The table in canonical form: rows by top, optional fields only when set. */
export function canonicalTrimSheet(s: TrimSheet): TrimSheet {
  return {
    size: [s.size[0], s.size[1]],
    texelDensity: s.texelDensity,
    padding: s.padding,
    rows: [...s.rows]
      .sort((a, b) => a.top - b.top)
      .map((r) => ({ slot: r.slot, top: r.top, bottom: r.bottom, ...(r.texelDensity !== undefined ? { texelDensity: r.texelDensity } : {}), ...(r.tileV === true ? { tileV: true } : {}) })),
  };
}

/**
 * Equal rows, one per slot, down the sheet: each band is height / count
 * pixels rounded down to the alignment below, the row its middle with
 * `padding` pixels left above and below (the default layout; rows may then
 * be moved to unequal heights).
 */
export function equalTrimRows(height: number, slots: readonly string[], padding: number): TrimRow[] {
  const n = Math.max(1, slots.length);
  // Bands start on multiples of the power of two nearest twice the padding (at most), so mip texels that deep
  // never straddle two bands (the Texture Designer aligns its bands the same way); the rest of the height is left over.
  const align = padding > 0 ? 2 ** Math.floor(Math.log2(2 * padding)) : 1;
  const band = Math.max(1, Math.floor(height / n / align) * align) || Math.floor(height / n);
  const pad = Math.max(0, Math.min(padding, Math.floor((band - 1) / 2)));
  return slots.map((slot, i) => ({ slot, top: i * band + pad, bottom: (i + 1) * band - pad }));
}

/** A new sheet in the starter layout (equal rows). */
export function defaultTrimSheet(slots: readonly string[] = TRIM_STARTER_LAYOUT): TrimSheet {
  const { size, texelDensity, padding } = TRIM_SHEET_DEFAULTS;
  return { size: [size[0], size[1]], texelDensity, padding, rows: equalTrimRows(size[1], slots, padding) };
}

/** The row filling `slot`, or null. */
export function trimRowOf(sheet: TrimSheet, slot: string): TrimRow | null {
  return sheet.rows.find((r) => r.slot === slot) ?? null;
}

/** The layout's slots the sheet lacks (empty: the sheet conforms and swaps in for any other that does). */
export function trimLayoutMissing(sheet: TrimSheet, slots: readonly string[]): string[] {
  const have = new Set(sheet.rows.map((r) => r.slot));
  return slots.filter((s) => !have.has(s));
}

/** A row's pixels per metre along u. */
export function trimRowDensity(sheet: TrimSheet, row: TrimRow): number {
  return row.texelDensity ?? sheet.texelDensity;
}

/** A row's height in metres at its density: how tall a strip is with square texels. */
export function trimRowMetres(sheet: TrimSheet, row: TrimRow): number {
  return (row.bottom - row.top) / trimRowDensity(sheet, row);
}

/**
 * The v range a strip of `row` spans, [at its top edge, at its bottom edge]:
 * the row's pixel bounds inset by half a texel, so bilinear filtering at
 * level 0 reads only the row's pixels. v counts from the image's top (glTF's
 * convention, the engine's textures are not flipped).
 */
export function trimRowV(sheet: TrimSheet, row: TrimRow): [number, number] {
  const h = sheet.size[1];
  const top = row.top + 0.5;
  const bottom = Math.max(top, row.bottom - 0.5);
  return [top / h, bottom / h];
}

/** u at `metres` along a strip of `row` (the sampler repeats u: a strip runs on past the sheet's width). */
export function trimU(sheet: TrimSheet, row: TrimRow, metres: number): number {
  return (metres * trimRowDensity(sheet, row)) / sheet.size[0];
}

/** v at `t` across a strip of `row` (0 its top edge, 1 its bottom edge; inset, see `trimRowV`). */
export function trimV(sheet: TrimSheet, row: TrimRow, t: number): number {
  const [v0, v1] = trimRowV(sheet, row);
  return v0 + (v1 - v0) * Math.max(0, Math.min(1, t));
}

/**
 * A strip's texture coordinates into `out` (xy pairs from `offset`): vertex
 * i is `along[i]` metres along the strip and `across[i]` (0 top edge, 1
 * bottom edge) across it. Flat arrays, no allocation per vertex: the
 * generator writes whole chunks with it.
 */
export function writeTrimStripUvs(sheet: TrimSheet, row: TrimRow, along: ArrayLike<number>, across: ArrayLike<number>, out: Float32Array, offset = 0): void {
  const su = trimRowDensity(sheet, row) / sheet.size[0];
  const [v0, v1] = trimRowV(sheet, row);
  const n = Math.min(along.length, across.length);
  for (let i = 0; i < n; i++) {
    const t = across[i]!;
    out[offset + i * 2] = along[i]! * su;
    out[offset + i * 2 + 1] = v0 + (v1 - v0) * (t < 0 ? 0 : t > 1 ? 1 : t);
  }
}

/** A vertex's COLOR_0 for trim meshes into `out` at vertex `i` (RGBA floats; each weight clamped to 0–1). */
export function writeTrimVertexColour(out: Float32Array, i: number, occlusion: number, grime: number, wetness: number): void {
  const c = (x: number): number => (x > 0 ? (x < 1 ? x : 1) : 0);
  out[i * 4 + TRIM_COLOUR_OCCLUSION] = c(occlusion);
  out[i * 4 + TRIM_COLOUR_GRIME] = c(grime);
  out[i * 4 + TRIM_COLOUR_WETNESS] = c(wetness);
  out[i * 4 + 3] = 1;
}

/** The mip levels a sheet's textures have (a full chain down to 1 × 1). */
export function trimSheetMipLevels(sheet: TrimSheet): number {
  return Math.floor(Math.log2(Math.max(sheet.size[0], sheet.size[1]))) + 1;
}

/** Whether every pixel bilinear filtering reads at level `level` for v-pixel `y` lies in [lo, hi). */
function readsInside(height: number, level: number, y: number, lo: number, hi: number): boolean {
  const texels = Math.max(1, Math.floor(height / 2 ** level));
  const s = height / texels;
  const yl = y / s - 0.5;
  const i0 = Math.floor(yl);
  const f = yl - i0;
  const used = f < 1e-9 ? [i0] : f > 1 - 1e-9 ? [i0 + 1] : [i0, i0 + 1];
  return used.every((i) => i >= 0 && i < texels && i * s >= lo - 1e-9 && (i + 1) * s <= hi + 1e-9);
}

/**
 * The deepest mip level at which a strip of `row` reads only the row and its
 * padding (bilinear, at both inset edges; trilinear blends two levels at
 * most this deep): every level up to it is safe. The padded band ends at the
 * sheet's edges (the wrap there reads the other side's row) and where a
 * neighbour's padding begins.
 */
export function trimSafeMipLevel(sheet: TrimSheet, row: TrimRow): number {
  const h = sheet.size[1];
  // The padded band, less any pixels a neighbour's padding claims too (whose they hold is not known).
  let lo = Math.max(0, row.top - sheet.padding);
  let hi = Math.min(h, row.bottom + sheet.padding);
  for (const o of sheet.rows) {
    if (o === row) continue;
    if (o.top >= row.bottom) hi = Math.max(row.bottom, Math.min(hi, o.top - sheet.padding));
    else if (o.bottom <= row.top) lo = Math.min(row.top, Math.max(lo, o.bottom + sheet.padding));
  }
  const [v0, v1] = trimRowV(sheet, row);
  const levels = trimSheetMipLevels(sheet);
  let safe = 0;
  for (let l = 1; l < levels; l++) {
    if (!readsInside(h, l, v0 * h, lo, hi) || !readsInside(h, l, v1 * h, lo, hi)) break;
    safe = l;
  }
  return safe;
}

/** The deepest mip level safe for every row (`trimSafeMipLevel`): the material's sampling cap. */
export function trimSheetSafeMipLevel(sheet: TrimSheet): number {
  let safe = trimSheetMipLevels(sheet) - 1;
  for (const r of sheet.rows) safe = Math.min(safe, trimSafeMipLevel(sheet, r));
  return safe;
}

/**
 * The longest a pixel's texture footprint may be (in level-0 texels) before
 * the sampler would read past the safe mip level: the material shortens the
 * screen-space derivatives it samples with to this.
 */
export function trimMaxFootprint(sheet: TrimSheet): number {
  return 2 ** trimSheetSafeMipLevel(sheet);
}

/** A warning about a sheet (it draws, but may bleed or blur). */
export interface TrimSheetProblem {
  /** The row's slot, or null for the sheet. */
  slot: string | null;
  message: string;
}

/**
 * What to fix in a valid table: padding of 0 (rows bleed into each other
 * once mips are read), padded rows that overlap a neighbour's padding or run
 * off the sheet (the padding there is not the row's), a sheet whose sides
 * are not powers of two (mips no longer halve evenly: the bounds above are
 * approximate), and the safe mip level when it is shallow.
 */
export function trimSheetProblems(sheet: TrimSheet): TrimSheetProblem[] {
  const out: TrimSheetProblem[] = [];
  const [w, h] = sheet.size;
  const pow2 = (n: number): boolean => (n & (n - 1)) === 0;
  if (!pow2(w) || !pow2(h)) out.push({ slot: null, message: `the sheet is ${w} × ${h}: sides that are powers of two keep every mip level aligned with the rows` });
  if (sheet.padding === 0) out.push({ slot: null, message: 'no padding: filtering reads the next row as soon as the sheet is drawn smaller than its size (8 px is usual)' });
  const rows = [...sheet.rows].sort((a, b) => a.top - b.top);
  rows.forEach((r, i) => {
    const next = rows[i + 1];
    if (r.top - sheet.padding < 0) out.push({ slot: r.slot, message: `its padding above runs off the sheet (top ${r.top} < padding ${sheet.padding})` });
    if (r.bottom + sheet.padding > h) out.push({ slot: r.slot, message: `its padding below runs off the sheet (bottom ${r.bottom} + padding ${sheet.padding} > ${h})` });
    if (next !== undefined && r.bottom + sheet.padding > next.top - sheet.padding) out.push({ slot: r.slot, message: `${next.top - r.bottom} px to "${next.slot}" below: two paddings need ${2 * sheet.padding}` });
  });
  const safe = trimSheetSafeMipLevel(sheet);
  const levels = trimSheetMipLevels(sheet);
  if (safe < levels - 1 && safe < 3) {
    const worst = rows.filter((r) => trimSafeMipLevel(sheet, r) === safe).map((r) => r.slot);
    out.push({ slot: null, message: `mip levels past ${safe} would bleed (${worst.join(', ')}): sampling stops there, so trims alias when drawn at under 1/${2 ** safe} of their size; more padding raises it` });
  }
  return out;
}

/** The padding pixels that differ from what the row repeats there (a sheet's image checked against its table). */
export interface TrimPaddingProblem {
  slot: string;
  side: 'above' | 'below';
  /** The worst pixel row (sheet pixels) and its largest channel difference (0–255). */
  y: number;
  difference: number;
}

/**
 * Check a sheet image (8-bit RGBA, rows top first) against its table: each
 * row's padding should repeat its edge row (a row that tiles in v: continue
 * its wrap — padding row k above holds the row's k-th row from the bottom).
 * Differences up to `tolerance` (a channel, 0–255) pass: lossy compression
 * moves pixels a little. Padding off the sheet is not read (the problems
 * list says so).
 */
export function trimPaddingProblems(rgba: Uint8Array, width: number, height: number, sheet: TrimSheet, tolerance = 8): TrimPaddingProblem[] {
  const out: TrimPaddingProblem[] = [];
  if (width !== sheet.size[0] || height !== sheet.size[1]) return out;
  const rowDiff = (a: number, b: number): number => {
    let worst = 0;
    const oa = a * width * 4;
    const ob = b * width * 4;
    for (let x = 0; x < width * 4; x++) {
      if ((x & 3) === 3) continue;
      const d = Math.abs(rgba[oa + x]! - rgba[ob + x]!);
      if (d > worst) worst = d;
    }
    return worst;
  };
  for (const r of sheet.rows) {
    const rowsTall = r.bottom - r.top;
    for (const side of ['above', 'below'] as const) {
      let worst = 0;
      let at = -1;
      for (let k = 1; k <= sheet.padding; k++) {
        const y = side === 'above' ? r.top - k : r.bottom - 1 + k;
        if (y < 0 || y >= height) break;
        // The pixel row the padding should repeat: the edge, or (tiling in v) the wrap's continuation.
        const src = r.tileV === true ? (side === 'above' ? r.bottom - 1 - ((k - 1) % rowsTall) : r.top + ((k - 1) % rowsTall)) : side === 'above' ? r.top : r.bottom - 1;
        const d = rowDiff(y, src);
        if (d > worst) {
          worst = d;
          at = y;
        }
      }
      if (worst > tolerance) out.push({ slot: r.slot, side, y: at, difference: worst });
    }
  }
  return out;
}

/** A Texture Designer trim export's layout (`layout.json`, format trim/1) read as a row table. */
export type TrimLayoutImport = { ok: true; sheet: TrimSheet; skipped: string[] } | { ok: false; message: string };

/**
 * A row table from the Texture Designer's `layout.json` (format `trim/1`):
 * the sheet's size, texel density and gutter (the padding), and one row per
 * strip layer (`tile_u` / `tile_uv`, by its pixel bounds; `tile_uv` tiles in
 * v). Decal layers are cells, not strips: they are listed in `skipped`.
 */
export function trimSheetFromLayout(json: unknown): TrimLayoutImport {
  if (!isObject(json) || json['format'] !== 'trim/1') return { ok: false, message: 'not a trim sheet layout (layout.json, format "trim/1")' };
  const size = json['size'];
  const density = json['texel_density_px_per_m'];
  const gutter = json['gutter_px'];
  const layers = json['layers'];
  if (!Array.isArray(size) || size.length !== 2 || !isInt(size[0], 1, TRIM_SHEET_SIZE_MAX) || !isInt(size[1], 1, TRIM_SHEET_SIZE_MAX)) return { ok: false, message: 'layout.json: size is not [width, height]' };
  if (!isNum(density, TRIM_DENSITY_MIN, TRIM_DENSITY_MAX)) return { ok: false, message: 'layout.json: texel_density_px_per_m is missing' };
  if (!Array.isArray(layers)) return { ok: false, message: 'layout.json: layers is missing' };
  const rows: TrimRow[] = [];
  const skipped: string[] = [];
  for (const l of layers) {
    if (!isObject(l) || typeof l['name'] !== 'string') continue;
    const px = l['px'];
    if (l['kind'] === 'decals' || !Array.isArray(px) || px.length !== 2 || typeof px[0] !== 'number' || typeof px[1] !== 'number') {
      skipped.push(l['name']);
      continue;
    }
    rows.push({ slot: l['name'], top: px[0], bottom: px[1], ...(l['kind'] === 'tile_uv' ? { tileV: true } : {}) });
  }
  const sheet: TrimSheet = { size: [size[0], size[1]], texelDensity: density, padding: isInt(gutter, 0, TRIM_PADDING_MAX) ? gutter : 0, rows };
  const errors = trimSheetErrors(sheet);
  if (errors.length > 0) return { ok: false, message: `layout.json: ${errors[0]!.path} ${errors[0]!.message}` };
  return { ok: true, sheet: canonicalTrimSheet(sheet), skipped };
}
