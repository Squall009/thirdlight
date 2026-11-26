/**
 * The gas part: a derive unit's gas faces against open space, merged into quads,
 * each with its gas's material and how dense the gas is behind it; and the
 * unit's gas as runs up its columns. What the page draws as plain fog near
 * the eye; derived like every other part, never stored.
 *
 * Every other derived output reads a gas cell as the air it stands in, so a
 * cell changing only between air and gas, or a gas's density or material,
 * makes this part stale and nothing else (record.ts `changeFeeds`).
 *
 * **Faces.** A gas cell (density 1 … 15; density 0 holds nothing and counts
 * as air) shows its whole face toward a neighbour that is **open** (air, an
 * opening, ground filled below the surface, a liquid) and none toward
 * anything else: ground, a built cell, or gas of any material or density.
 * So the quads are a bank's hull where it meets air; where it lies on the
 * ground, against a wall or against another fog it has none. A liquid is
 * read as the air it stands in, as every output but the liquid's own reads
 * it: a change only between air and liquid then leaves this part as it is
 * (the feeds rule), and the face of fog lying on water looks down at the
 * water, where nothing sees it. Positions are
 * whole cells ({@link GAS_STEPS_PER_CELL}). A neighbour across the unit's
 * face is read from the neighbourhood's pad, so no face is made against gas
 * across a border and two units' faces meet without a gap or a doubled face.
 *
 * **Density behind a face.** A quad's spare byte holds two densities (0 …
 * 15): its own cell's in the low four bits, and in the high four the
 * density of the cell behind it (the cell on the other side of its own from
 * the face; 0: not gas). A hull has no faces inside the bank, so this is
 * what a draw knows of a density that rises behind the surface (a fill's
 * soft top): the first cell at its own density, everything deeper at the
 * second.
 *
 * **Merging.** Faces of one direction in one cell layer merge into
 * rectangles of one material and one pair of densities (the media's shared
 * merge, derived-medium.ts). A quad never crosses the unit's border.
 *
 * **Runs.** Each column's gas as runs of touching cells of one material
 * ({@link GAS_RUN_BYTES} a run, little-endian: x, z, the first row and the
 * row past the last as u8, cells from the unit's corner; material u16; the
 * sum of the cells' densities u16). A hull against air does not say whether
 * a point is in the gas (a bank lying in a hollow has no face against the
 * ground, mist under a roof none at all): the runs do, for a draw that
 * needs to know the eye stands in fog.
 *
 * A unit with no gas cell has no part (null) and costs one look at its
 * cells; a unit whose gas shows no face (closed in) keeps its runs.
 */
import type { Neighbourhood } from './assembly';
import { closesMedium, joinMediumQuads, MEDIUM_FACE, mediumQuad, MediumQuadWriter, mergeLayerRects, type MediumQuads } from './derived-medium';
import { MATERIAL_ID_MAX, ROLE_MASK, ROLE_SHIFT, SHAPE_FULL, SHAPE_SHIFT } from './record';
import { isGasRole } from './role-traits';

/** Steps a cell along each axis in the gas part's positions: its faces are whole cell faces. */
export const GAS_STEPS_PER_CELL = 1;

/** Cells round a unit the gas part reads (its faces look at the six neighbours, the density behind a face one cell back): the apron of a gas-only derive. */
export const GAS_REACH_CELLS = 1;

/** Bytes of one run. */
export const GAS_RUN_BYTES = 8;

/** A gas cell's full density: its material's full density per metre is drawn at this level. */
export const GAS_DENSITY_FULL = SHAPE_FULL;

/** A unit's (or a joined chunk's) gas: its hull quads and its runs. */
export interface GasPart extends MediumQuads {
  readonly runCount: number;
  /** {@link GAS_RUN_BYTES} a run, columns in x then z order, a column's runs upward. */
  readonly runs: Uint8Array;
}

/** A neighbour as the gas part sees it: open, or something that closes the face; a gas is its density (1 … 15). */
const AIR = 0;
const CLOSED = -1;

/** Density (1 … 15) of a gas value, {@link AIR} or {@link CLOSED} for anything else (a liquid: open, as air). */
function kindOf(v: number, density: number): number {
  if ((v & MATERIAL_ID_MAX) === 0) return AIR;
  const role = (v >>> ROLE_SHIFT) & ROLE_MASK;
  if (isGasRole(role)) return (v >>> SHAPE_SHIFT) & SHAPE_FULL;
  return closesMedium(role, density) ? CLOSED : AIR;
}

/** Whether any of a neighbourhood's own cells (not its pad) holds gas. */
function holdsGas(n: Neighbourhood): boolean {
  const { edge: e, pad: p, side: s, values } = n;
  for (let x = 0; x < e; x++) for (let z = 0; z < e; z++) {
    const row = ((x + p) * s + (z + p)) * s + p;
    for (let y = 0; y < e; y++) {
      const v = values[row + y]!;
      if ((v & MATERIAL_ID_MAX) !== 0 && isGasRole((v >>> ROLE_SHIFT) & ROLE_MASK) && ((v >>> SHAPE_SHIFT) & SHAPE_FULL) !== 0) return true;
    }
  }
  return false;
}

/** The six faces: its {@link MEDIUM_FACE}, the step to the neighbour it looks at, and the layer's two axes (0 x, 1 y, 2 z) after its own. */
const FACES: ReadonlyArray<readonly [face: number, axis: number, sign: number, u: number, v: number]> = [
  [MEDIUM_FACE.px, 0, 1, 2, 1],
  [MEDIUM_FACE.nx, 0, -1, 2, 1],
  [MEDIUM_FACE.py, 1, 1, 0, 2],
  [MEDIUM_FACE.ny, 1, -1, 0, 2],
  [MEDIUM_FACE.pz, 2, 1, 0, 1],
  [MEDIUM_FACE.nz, 2, -1, 0, 1],
];

/**
 * The gas part of a neighbourhood's own cells (its pad at least
 * {@link GAS_REACH_CELLS} deep), or null when they hold no gas.
 */
export function gasOfNeighbourhood(n: Neighbourhood): GasPart | null {
  if (n.pad < GAS_REACH_CELLS) throw new RangeError(`gas part: a pad of ${n.pad} does not reach the ${GAS_REACH_CELLS}-cell neighbours`);
  if (!holdsGas(n)) return null;
  const { edge: e, pad: p, side: s, values, shapes } = n;
  // Every cell of the unit and one round it: its kind (density, air or closed); the unit's cells' materials.
  const ks = e + 2;
  const kinds = new Int8Array(ks * ks * ks);
  const mats = new Uint16Array(ks * ks * ks);
  for (let x = -1; x <= e; x++) for (let z = -1; z <= e; z++) {
    const src = ((x + p) * s + (z + p)) * s + (p - 1);
    const dst = ((x + 1) * ks + (z + 1)) * ks;
    for (let y = -1; y <= e; y++) {
      const v = values[src + y + 1]!;
      const k = kindOf(v, shapes[src + y + 1]!);
      kinds[dst + y + 1] = k;
      if (k > 0) mats[dst + y + 1] = v & MATERIAL_ID_MAX;
    }
  }
  // Steps between neighbours in `kinds`, by axis (x, y, z).
  const step = [ks * ks, 1, ks];
  const cell = (c: readonly number[]): number => ((c[0]! + 1) * ks + (c[2]! + 1)) * ks + c[1]! + 1;
  const out = new MediumQuadWriter();
  const key = new Int32Array(e * e);
  const used = new Uint8Array(e * e);
  const c = [0, 0, 0];
  const lo = [0, 0, 0];
  const hi = [0, 0, 0];
  for (const [face, axis, sign, u, v] of FACES) {
    const toward = sign * step[axis]!;
    for (let a = 0; a < e; a++) {
      let any = false;
      c[axis] = a;
      for (let i = 0; i < e; i++) for (let j = 0; j < e; j++) {
        c[u] = i;
        c[v] = j;
        const at = cell(c);
        const d = kinds[at]!;
        let k = -1;
        if (d > 0 && kinds[at + toward] === AIR) {
          const behind = kinds[at - toward]!;
          k = ((d | ((behind > 0 ? behind : 0) << 4)) << 12) | mats[at]!;
        }
        key[i * e + j] = k;
        any ||= k >= 0;
      }
      if (!any) continue;
      const plane = sign > 0 ? a + 1 : a;
      mergeLayerRects(e, e, key, used, (i0, j0, i1, j1, k) => {
        lo[axis] = hi[axis] = plane;
        lo[u] = i0;
        hi[u] = i1;
        lo[v] = j0;
        hi[v] = j1;
        out.add(face, k & 0xfff, lo[0]!, lo[1]!, lo[2]!, hi[0]!, hi[1]!, hi[2]!, k >>> 12);
      });
    }
  }

  // The runs: each column's touching gas cells of one material.
  let runs = new Uint8Array(GAS_RUN_BYTES * 64);
  let runCount = 0;
  const run = (x: number, z: number, y0: number, y1: number, material: number, sum: number): void => {
    const at = runCount * GAS_RUN_BYTES;
    if (at + GAS_RUN_BYTES > runs.length) {
      const grown = new Uint8Array(runs.length * 2);
      grown.set(runs);
      runs = grown;
    }
    runs.set([x, z, y0, y1, material & 0xff, material >>> 8, sum & 0xff, sum >>> 8], at);
    runCount++;
  };
  for (let x = 0; x < e; x++) for (let z = 0; z < e; z++) {
    const base = ((x + 1) * ks + (z + 1)) * ks + 1;
    let y0 = -1;
    let material = 0;
    let sum = 0;
    for (let y = 0; y <= e; y++) {
      const d = y < e ? kinds[base + y]! : 0;
      const m = d > 0 ? mats[base + y]! : 0;
      if (y0 >= 0 && m !== material) {
        run(x, z, y0, y, material, sum);
        y0 = -1;
      }
      if (d > 0) {
        if (y0 < 0) {
          y0 = y;
          material = m;
          sum = 0;
        }
        sum += d;
      }
    }
  }
  return { count: out.count, quads: out.quads(), runCount, runs: runs.slice(0, runCount * GAS_RUN_BYTES) };
}

/** Bytes a gas part holds. */
export function gasBytes(g: GasPart | null | undefined): number {
  return g == null ? 0 : g.quads.byteLength + g.runs.byteLength;
}

/** One quad's fields (tests, the renderer's unpack): `density` its own cell's, `behind` the cell's behind it (0 … 15). */
export function gasQuad(g: GasPart, k: number): { face: number; material: number; density: number; behind: number; min: [number, number, number]; max: [number, number, number] } {
  const { face, material, extra, min, max } = mediumQuad(g, k);
  return { face, material, density: extra & 15, behind: extra >>> 4, min, max };
}

/** One run's fields: rows [y0, y1) of column (x, z), its material and the sum of its cells' densities. */
export interface GasRun {
  x: number;
  z: number;
  y0: number;
  y1: number;
  material: number;
  sum: number;
}

/** Run `k` of a part. */
export function gasRun(g: GasPart, k: number): GasRun {
  const r = g.runs;
  const at = k * GAS_RUN_BYTES;
  return { x: r[at]!, z: r[at + 1]!, y0: r[at + 2]!, y1: r[at + 3]!, material: r[at + 4]! | (r[at + 5]! << 8), sum: r[at + 6]! | (r[at + 7]! << 8) };
}

/** The run holding cell (x, y, z) of a part (cells from its corner), or null: no gas there. */
export function gasRunAt(g: GasPart | null | undefined, x: number, y: number, z: number): GasRun | null {
  if (g == null) return null;
  const r = g.runs;
  for (let at = 0, end = g.runCount * GAS_RUN_BYTES; at < end; at += GAS_RUN_BYTES) {
    if (r[at] === x && r[at + 1] === z && r[at + 2]! <= y && y < r[at + 3]!) return gasRun(g, at / GAS_RUN_BYTES);
  }
  return null;
}

/**
 * The gas parts of a chunk's sections (by section id; null: none) as one
 * part of the chunk, positions moved from each section's corner to the
 * chunk's (`origin(id)`, cells); null when no section holds gas. A run that
 * crosses a section's top is two runs (as one that crosses a chunk's).
 */
export function joinGas(parts: ReadonlyArray<GasPart | null | undefined>, origin: (id: number) => readonly [number, number, number]): GasPart | null {
  let runCount = 0;
  for (const g of parts) runCount += g?.runCount ?? 0;
  if (runCount === 0) return null;
  const quads = joinMediumQuads(parts, origin, GAS_STEPS_PER_CELL);
  const runs = new Uint8Array(runCount * GAS_RUN_BYTES);
  let at = 0;
  parts.forEach((g, id) => {
    if (g == null || g.runCount === 0) return;
    const [ox, oy, oz] = origin(id);
    runs.set(g.runs.subarray(0, g.runCount * GAS_RUN_BYTES), at);
    for (let k = 0; k < g.runCount; k++, at += GAS_RUN_BYTES) {
      runs[at] = runs[at]! + ox;
      runs[at + 1] = runs[at + 1]! + oz;
      runs[at + 2] = runs[at + 2]! + oy;
      runs[at + 3] = runs[at + 3]! + oy;
    }
  });
  return { count: quads?.count ?? 0, quads: quads?.quads ?? new Uint8Array(0), runCount, runs };
}
