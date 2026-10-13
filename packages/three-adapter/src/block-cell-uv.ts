/**
 * Cell-unit texture coordinates for materials made while block layers'
 * generated UVs counted cells.
 *
 * A stand-in chunk's UVs are metres from the layer origin (box mapping). They
 * used to be cells, and a height-blended layers material from that time
 * repeats its textures by a `tiling` per cell (`readsCellUv`). On a layer
 * whose cells are not 1 m such a material would repeat more or less often
 * than it did, so its chunk meshes take the same UVs divided back into cells:
 * u by the cell width (cells are square from above), v by the width under a
 * top (or bottom) projection and by the cell height under a wall's. Which
 * projection a triangle used is read from its UVs: a wall's v is −y exactly
 * (heights are neither wrapped nor scaled), a top's follows z. Not from the
 * vertex normal: a smoothed slope's normals lean either side of 45° while
 * its triangles keep one projection, and dividing by the wrong size
 * stretched them by the cell's width-to-height ratio.
 *
 * A material that draws trim strips (a trim sheet, or a layered surface with
 * a trim layer) reads the UVs as places on its sheet; its chunk meshes take
 * strip UVs made from the metres (`trimStripUvs`), so a block wall wears the
 * sheet's rows as a generated wall does: on a sheet drawing rows at their
 * real height, a field row repeats up the wall at its own height (the mesher
 * cuts the walls where it repeats: `trimWallRowSteps`).
 *
 * The metre UVs stay with the mesh: a material change in place (the project
 * switching to per-layer tilings, a trim layer added or dropped) puts them
 * back.
 */
import { trimRowDensity, trimRowMetres, trimRowOf, trimRowV, type TrimSheet } from '@thirdlight/runtime';
import type * as THREE from 'three';

import { CELL_UV_KEY, TRIM_STRIPS_KEY } from './material-graph';

/** `mesh.userData[METRE_UV_KEY]`: a stand-in chunk mesh's own (metre) UVs and its layer's cell size. */
const METRE_UV_KEY = '__tlMetreUv';

interface KeptUv {
  readonly metres: Float32Array;
  readonly cellSize: readonly [number, number, number];
  cells: Float32Array | null;
  /** Whether a material that reads cells gets them (stand-ins: their materials may predate metres). */
  readonly cellsAllowed: boolean;
  /** Strip UVs, made for the row table `stripsOf` (a material swap to another table makes them again). */
  strips: Float32Array | null;
  stripsOf: TrimSheet | null;
}

/**
 * The rows a block layer's faces wear under a trim material, as a generated
 * wall wears them: the layer's first storey of cells the lower wall, the
 * storeys above the upper wall, tops and undersides the floor. A sheet
 * without one of them falls back down this list, then to its first row.
 */
const STRIP_ROWS = { lower: ['lower_wall', 'upper_wall'], upper: ['upper_wall', 'lower_wall'], top: ['floor', 'upper_wall', 'lower_wall'] } as const;
const rowFor = (sheet: TrimSheet, slots: readonly string[]): TrimSheet['rows'][number] | null => {
  for (const slot of slots) {
    const r = trimRowOf(sheet, slot);
    if (r !== null) return r;
  }
  return sheet.rows[0] ?? null;
};

/**
 * The heights a block wall under `sheet` is cut at so its rows repeat at
 * their real height: [the first storey's row, the higher storeys' row] in
 * metres, 0 where that row is not a field (a trim is drawn once per face);
 * null when the sheet fits rows to faces (no cuts) or neither row repeats.
 */
export function trimWallRowSteps(sheet: TrimSheet): readonly [number, number] | null {
  if (sheet.realHeight !== true) return null;
  const step = (slots: readonly string[]): number => {
    const r = rowFor(sheet, slots);
    return r !== null && r.tileV === true ? trimRowMetres(sheet, r) : 0;
  };
  const steps: [number, number] = [step(STRIP_ROWS.lower), step(STRIP_ROWS.upper)];
  return steps[0] > 0 || steps[1] > 0 ? steps : null;
}

/**
 * Metre UVs divided back into cells: u by the cell width; v by the height
 * where all three corners of a triangle have v = −y (a wall's projection),
 * else by the width. A top's triangle passes that test only where its v
 * (z less the chunk's whole periods, or its negative) equals −y at all three
 * corners: a 45° slope lying exactly on that plane, which then counts as a
 * wall. `index` null: the triangles are the vertices in threes.
 */
export function cellUnitUvs(metres: Float32Array, positions: ArrayLike<number>, index: ArrayLike<number> | null, cellSize: readonly [number, number, number]): Float32Array {
  const out = new Float32Array(metres.length);
  const [w, h] = [cellSize[0], cellSize[1]];
  const count = metres.length / 2;
  // Unreferenced vertices keep the top's divisor.
  for (let i = 0; i < count; i++) {
    out[i * 2] = metres[i * 2]! / w;
    out[i * 2 + 1] = metres[i * 2 + 1]! / w;
  }
  const corners = index === null ? count - (count % 3) : index.length;
  const wallV = (v: number): boolean => metres[v * 2 + 1] === -positions[v * 3 + 1]!;
  for (let i = 0; i + 2 < corners; i += 3) {
    const a = index === null ? i : index[i]!;
    const b = index === null ? i + 1 : index[i + 1]!;
    const c = index === null ? i + 2 : index[i + 2]!;
    if (!(wallV(a) && wallV(b) && wallV(c))) continue;
    // A vertex never joins triangles of two projections (the mesher splits it), so this only rewrites wall vertices.
    out[a * 2 + 1] = metres[a * 2 + 1]! / h;
    out[b * 2 + 1] = metres[b * 2 + 1]! / h;
    out[c * 2 + 1] = metres[c * 2 + 1]! / h;
  }
  return out;
}

/**
 * Metre UVs turned into trim strips: a trim material reads the mesh's UVs as
 * places on its sheet, and a metre UV there shows the whole sheet, every row
 * stacked, once a metre. A wall triangle (v = −y, as `cellUnitUvs` tells
 * them) takes u along the wall in metres at its row's texel density (the
 * sampler repeats u: the strip runs on along the wall, as a generated wall's
 * does) and v across its row, from the bottom to the top of the cells it
 * spans (a cell's face shows the row once, stretched to the cell's height
 * where the row is shorter: the mesher makes one quad a cell face, and a row
 * cannot repeat inside one quad without cutting it). Tops and undersides
 * take the floor row across each cell along v. Which cells a triangle spans
 * comes from its corners snapped to the cell grid, so the two triangles of a
 * face agree; the mesher keeps one vertex per cell face, so no vertex is
 * asked for two rows (welded smooth tops excepted: one of their cells wins).
 *
 * A sheet drawing rows at their real height maps a field row by height
 * instead: v follows the place's height above the layer's row 0 (along v on
 * a top) modulo the row's metres, so the row repeats at its own height and
 * runs on unbroken across cells. A triangle inside one repeat (the mesher cut
 * the wall there: `trimWallRowSteps`) takes it exactly; one spanning several
 * (a mesh made before the cut) keeps the mapping above. A trim row (no tiling
 * in v) keeps it too: once per face.
 */
export function trimStripUvs(metres: Float32Array, positions: ArrayLike<number>, index: ArrayLike<number> | null, cellSize: readonly [number, number, number], sheet: TrimSheet): Float32Array {
  const out = new Float32Array(metres);
  const [w, h] = [cellSize[0], cellSize[1]];
  const count = metres.length / 2;
  const corners = index === null ? count - (count % 3) : index.length;
  const wallV = (v: number): boolean => metres[v * 2 + 1] === -positions[v * 3 + 1]!;
  const lower = rowFor(sheet, STRIP_ROWS.lower);
  const upper = rowFor(sheet, STRIP_ROWS.upper);
  const top = rowFor(sheet, STRIP_ROWS.top);
  if (lower === null || upper === null || top === null) return out;
  const eps = 1e-4;
  const tri = [0, 0, 0];
  for (let i = 0; i + 2 < corners; i += 3) {
    tri[0] = index === null ? i : index[i]!;
    tri[1] = index === null ? i + 1 : index[i + 1]!;
    tri[2] = index === null ? i + 2 : index[i + 2]!;
    const wall = wallV(tri[0]!) && wallV(tri[1]!) && wallV(tri[2]!);
    // Across the row: height up a wall, metres along v on a top (its v is ±z, less whole periods).
    const across = (v: number): number => (wall ? positions[v * 3 + 1]! : metres[v * 2 + 1]!);
    const size = wall ? h : w;
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of tri) {
      lo = Math.min(lo, across(v));
      hi = Math.max(hi, across(v));
    }
    const c0 = Math.floor(lo / size + eps);
    const c1 = Math.max(c0 + 1, Math.ceil(hi / size - eps));
    const row = !wall ? top : c0 <= 0 ? lower : upper;
    const [v0, v1] = trimRowV(sheet, row);
    const su = trimRowDensity(sheet, row) / sheet.size[0];
    if (sheet.realHeight === true && row.tileV === true) {
      const m = trimRowMetres(sheet, row);
      const k = Math.floor(lo / m + eps);
      if (Math.ceil(hi / m - eps) - k <= 1) {
        for (const v of tri) {
          const f = (across(v) - k * m) / m;
          const t = wall ? 1 - f : f;
          out[v * 2] = metres[v * 2]! * su;
          out[v * 2 + 1] = v0 + (v1 - v0) * (t < 0 ? 0 : t > 1 ? 1 : t);
        }
        continue;
      }
    }
    const span = (c1 - c0) * size;
    for (const v of tri) {
      // 0 at the cells' top edge, 1 at their bottom (a row's v runs down the image); a top's v grows along +v.
      const f = (across(v) - c0 * size) / span;
      const t = wall ? 1 - f : f;
      out[v * 2] = metres[v * 2]! * su;
      out[v * 2 + 1] = v0 + (v1 - v0) * (t < 0 ? 0 : t > 1 ? 1 : t);
    }
  }
  return out;
}

/** Keep a stand-in chunk mesh's metre UVs (cells and trim strips are made from them as its material asks). */
export function keepMetreUv(mesh: THREE.Mesh, cellSize: readonly [number, number, number], cellsAllowed = true): void {
  const uv = mesh.geometry.getAttribute('uv') as THREE.BufferAttribute | undefined;
  if (uv === undefined) return;
  const kept: KeptUv = { metres: uv.array as Float32Array, cellSize: [cellSize[0], cellSize[1], cellSize[2]], cells: null, cellsAllowed, strips: null, stripsOf: null };
  mesh.userData[METRE_UV_KEY] = kept;
}

/** Give a kept chunk mesh the UVs its material reads: cells for a material that counts them, else metres. */
export function syncCellUv(mesh: THREE.Mesh): void {
  const kept = mesh.userData[METRE_UV_KEY] as KeptUv | undefined;
  if (kept === undefined) return;
  const uv = mesh.geometry.getAttribute('uv') as THREE.BufferAttribute | undefined;
  if (uv === undefined) return;
  const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const sheet = (list.find((m) => m.userData[TRIM_STRIPS_KEY] !== undefined)?.userData[TRIM_STRIPS_KEY] as TrimSheet | undefined) ?? null;
  const cells = sheet === null && kept.cellsAllowed && list.some((m) => m.userData[CELL_UV_KEY] === true) && !(kept.cellSize[0] === 1 && kept.cellSize[1] === 1);
  const positions = (): ArrayLike<number> => mesh.geometry.getAttribute('position').array;
  const index = (): ArrayLike<number> | null => mesh.geometry.getIndex()?.array ?? null;
  if (sheet !== null && kept.stripsOf !== sheet) {
    kept.strips = trimStripUvs(kept.metres, positions(), index(), kept.cellSize, sheet);
    kept.stripsOf = sheet;
  }
  if (cells && kept.cells === null) kept.cells = cellUnitUvs(kept.metres, positions(), index(), kept.cellSize);
  const want = sheet !== null ? kept.strips! : cells ? kept.cells! : kept.metres;
  if (uv.array === want) return;
  (uv as { array: Float32Array }).array = want;
  uv.needsUpdate = true;
}
