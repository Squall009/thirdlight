/**
 * How the voxel surface maps a tiling texture onto construction: from the
 * build grid in metres, so a band of a texture sits at the same height on
 * every wall and floor and runs on across chunk faces.
 *
 * A face's U runs along it (to the right seen from outside), V up it: on a
 * wall V is the world height, on a floor U and V are x and −z (a ceiling
 * x and z), on a slope (a roof plane) U runs level along the slope's ridge
 * and V up the slope, so a band on a roof sheet is parallel to its eave.
 * Positions are the chunk's grid phase plus the local position: the phase
 * is taken modulo a whole number of every tile, so a floating-origin shift
 * or a chunk boundary never moves a texture. V on a slope goes along a
 * diagonal of the grid, √2 long a cell at 45° and √5 long two cells at 1:2;
 * each slope uses its own phase, taken modulo the phase length times √2 or
 * √5, so it stays continuous where the plain phase wraps (a slope's V would
 * jump there).
 *
 * The math is written once over a small scalar interface: the program
 * builds it from shader nodes, the tests run it on numbers.
 */

/** The scalar operations the projection needs (numbers or shader nodes). */
export interface ProjectionOps<F, B> {
  num(v: number): F;
  add(a: F, b: F): F;
  sub(a: F, b: F): F;
  mul(a: F, b: F): F;
  div(a: F, b: F): F;
  abs(a: F): F;
  max(a: F, b: F): F;
  sqrt(a: F): F;
  less(a: F, b: F): B;
  /** `c ? a : b`. */
  pick(c: B, a: F, b: F): F;
}

export type Vec<F> = readonly [F, F, F];

/** Below this horizontal share of the normal a face is a floor or ceiling (U along x). */
const LEVEL_SHARE = 1e-3;
/** Above this a normal component makes the face axis-aligned (V from the plain phase). */
const AXIS_SHARE = 0.99;
/** A slope whose normal's vertical part exceeds its horizontal part this many times is 1:2 (2 ×; 45°: 1 ×). */
const SHALLOW_RATIO = 1.5;

/**
 * The directions U and V run in on a construction surface of unit normal
 * `n` (unit vectors, world axes; with `n` a right-handed frame): U along
 * the level line (up × n; x on a floor or ceiling), V up the face (n × U).
 * A normal map's tangent and bitangent on the grid projection. `h`: the
 * normal's horizontal length.
 */
export function gridFrame<F, B>(o: ProjectionOps<F, B>, n: Vec<F>): { u: Vec<F>; v: Vec<F>; h: F } {
  const [nx, ny, nz] = n;
  const h = o.sqrt(o.add(o.mul(nx, nx), o.mul(nz, nz)));
  const level = o.less(h, o.num(LEVEL_SHARE));
  const hh = o.max(h, o.num(LEVEL_SHARE));
  const rx = o.pick(level, o.num(1), o.div(nz, hh));
  const rz = o.pick(level, o.num(0), o.div(o.sub(o.num(0), nx), hh));
  const sx = o.mul(ny, rz);
  const sy = o.sub(o.mul(nz, rx), o.mul(nx, rz));
  const sz = o.sub(o.num(0), o.mul(ny, rx));
  return { u: [rx, o.num(0), rz], v: [sx, sy, sz], h };
}

/**
 * The (U, V) in metres of a construction surface point: `p` its grid
 * position in metres (plain phase + local), `ps` and `ps5` the same with
 * the 45° and the 1:2 slope phase, `n` its unit normal.
 */
export function gridUv<F, B>(o: ProjectionOps<F, B>, p: Vec<F>, ps: Vec<F>, ps5: Vec<F>, n: Vec<F>): [F, F] {
  const [nx, ny, nz] = n;
  const { u: [rx, , rz], v: [sx, sy, sz], h } = gridFrame(o, n);
  const axis = o.less(o.num(AXIS_SHARE), o.max(o.abs(nx), o.max(o.abs(ny), o.abs(nz))));
  const shallow = o.less(o.mul(o.num(SHALLOW_RATIO), h), o.abs(ny));
  const u = o.add(o.mul(p[0], rx), o.mul(p[2], rz));
  const vx = o.pick(axis, p[0], o.pick(shallow, ps5[0], ps[0]));
  const vy = o.pick(axis, p[1], o.pick(shallow, ps5[1], ps[1]));
  const vz = o.pick(axis, p[2], o.pick(shallow, ps5[2], ps[2]));
  const v = o.add(o.add(o.mul(vx, sx), o.mul(vy, sy)), o.mul(vz, sz));
  return [u, v];
}

/**
 * A construction tile's texture coordinate of (U, V) metres, for a tile of
 * `tileMetres`: the material's texture and its crack map both read it, so
 * the two lie on the grid with one phase.
 */
export function tileUv<F, B>(o: ProjectionOps<F, B>, uv: readonly [F, F], tileMetres: F): [F, F] {
  return [o.div(uv[0], tileMetres), o.div(uv[1], tileMetres)];
}

/** `v` modulo `m`, in [0, m). */
function wrapTo(v: number, m: number): number {
  return v - Math.floor(v / m) * m;
}

/**
 * An object's phases from its corner (level-0 cells): the plain phase
 * (cells, each axis modulo `phaseCells`) and the 45° and 1:2 slope phases
 * (metres, each axis modulo `phaseCells` cells times √2 and times √5).
 */
export function gridPhases(cell: readonly number[], cellMetres: number, phaseCells: number, phase: { set(x: number, y: number, z: number): unknown }, slope: { set(x: number, y: number, z: number): unknown }, slope5: { set(x: number, y: number, z: number): unknown }): void {
  const m = phaseCells * cellMetres * Math.SQRT2;
  const m5 = phaseCells * cellMetres * Math.sqrt(5);
  phase.set(wrapTo(cell[0]!, phaseCells), wrapTo(cell[1]!, phaseCells), wrapTo(cell[2]!, phaseCells));
  slope.set(wrapTo(cell[0]! * cellMetres, m), wrapTo(cell[1]! * cellMetres, m), wrapTo(cell[2]! * cellMetres, m));
  slope5.set(wrapTo(cell[0]! * cellMetres, m5), wrapTo(cell[1]! * cellMetres, m5), wrapTo(cell[2]! * cellMetres, m5));
}

/** Texels along the band test texture's side (one tile). */
export const BAND_TEXELS = 256;

/** A 3 × 5 digit font, rows top first, three bits a row (left bit first). */
const DIGITS = ['111101101101111', '010110010010111', '111001111100111', '111001111001111'];

/**
 * The band test texture over one tile of `tileMetres` (RGBA, alpha the
 * line's cover, nothing elsewhere): a thin dark line every 0.5 m, a thick
 * red one at 0 m and a thick blue one at half the tile, a short tick every
 * 1 m along U on each line, and the line's metre (0 … 3) written above it
 * near U 0. Row r is V = r / {@link BAND_TEXELS} of the tile (row 0 at the
 * tile's foot), so pictures show the same bands at the same heights on
 * every wall and floor.
 */
export function bandTexels(tileMetres: number): Uint8Array {
  const n = BAND_TEXELS;
  const perM = n / tileMetres;
  const data = new Uint8Array(n * n * 4);
  const put = (x: number, y: number, r: number, g: number, b: number): void => {
    const o = (((y + n) % n) * n + ((x + n) % n)) * 4;
    data[o] = r;
    data[o + 1] = g;
    data[o + 2] = b;
    data[o + 3] = 255;
  };
  const half = Math.round(perM / 2);
  const thick = Math.max(2, Math.round(n / 64));
  for (let line = 0; line * half < n; line++) {
    const y0 = line * half;
    const metre = line / 2;
    const red = y0 === 0;
    const blue = y0 === n / 2;
    const w = red || blue ? thick : 1;
    for (let dy = -w; dy <= w; dy++) for (let x = 0; x < n; x++) put(x, y0 + dy, red ? 230 : 25, 25, blue ? 230 : 25);
    // Ticks every metre along U, a short way up from the line.
    for (let t = 0; t * perM < n; t++) for (let dy = 0; dy < Math.round(perM / 8); dy++) for (let dx = -1; dx <= 1; dx++) put(Math.round(t * perM) + dx, y0 + w + dy, 25, 25, 25);
    if (Number.isInteger(metre) && metre < DIGITS.length) {
      const glyph = DIGITS[metre]!;
      const px = Math.max(2, Math.round(perM / 20));
      const left = Math.round(perM / 8);
      const foot = y0 + w + Math.round(perM / 16);
      for (let gy = 0; gy < 5; gy++) for (let gx = 0; gx < 3; gx++) {
        if (glyph[gy * 3 + gx] !== '1') continue;
        for (let a = 0; a < px; a++) for (let b = 0; b < px; b++) put(left + gx * px + a, foot + (4 - gy) * px + b, 15, 15, 15);
      }
    }
  }
  return data;
}
