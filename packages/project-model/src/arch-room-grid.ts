/**
 * Rooms on a block layer (`architecture.layer`): what the layer's grid
 * reads of the rooms drawn on it.
 *
 * - Wall edges: a room's wall (a sweep marked `wall`) standing on a cell
 *   line blocks passage across the cell edges it covers, in the rows its
 *   profile spans, as an edge piece would (`ctx.grid` walks, the
 *   `edgeBlocked` query); where a door or window is cut it lets passage
 *   through (a door piece the editor puts there, a real edge piece, decides
 *   then: open or closed). Walls off the cell lines (arcs, diagonals) are
 *   left to the colliders.
 * - Regions: each room storey is a region of the layer (the columns whose
 *   middles lie inside it, the rows between its floor and its walls' top),
 *   named by the room (its outline's id; `-s<storey>` above the ground).
 * - Wall paint: the layer's wall paint the generator reads at the faces.
 *
 * Positions convert by the offset between the two objects (layer-local =
 * object-local + offset), both placed by position only.
 *
 * Pure.
 */
import { hashText64 } from './arch-math';
import { openingSpan } from './arch-opening';
import { samplePath } from './arch-path';
import { pointInPolygon } from './arch-mesh';
import type { ArchitectureRoomPlan } from './arch-style';
import { profileBounds, resolveProfile } from './arch-sweep';
import type { ArchitectureComponent, ArchitecturePaint } from './architecture';
import { cellKeyOf } from './block-grid';
import type { BlockRegion } from './block-layers';

/** How close to a cell line (in cells) a wall's path must run to stand on it. */
const ON_LINE = 1e-3;

/**
 * The cell edges a component's walls stand on (layer cells): key
 * `cellKeyOf(x, y, z) * 2 + axis` (axis 0: the cell's −x side, 1: its −z
 * side, as `block-edges.ts`), true where the wall blocks, false where an
 * opening lets passage through. `c` is the expanded component.
 */
export function architectureWallEdges(c: Pick<ArchitectureComponent, 'elements' | 'profiles'>, offset: readonly number[], cellSize: readonly number[]): Map<number, boolean> {
  const out = new Map<number, boolean>();
  const [cs0, cs1, cs2] = [cellSize[0]!, cellSize[1]!, cellSize[2]!];
  const [ox, oy, oz] = [offset[0] ?? 0, offset[1] ?? 0, offset[2] ?? 0];
  for (const e of c.elements) {
    if (e.kind !== 'sweep' || e.wall !== true) continue;
    const def = c.profiles?.[e.profile];
    if (def === undefined) continue;
    const pts = resolveProfile(def, false).pts;
    const [, , y0, y1] = profileBounds(pts);
    const s = samplePath(e.path);
    const holes = (e.openings ?? []).map((o) => openingSpan(o, s, pts)).filter((h) => h.b > h.a && h.top > h.bottom);
    const segs = s.closed ? s.n : s.n - 1;
    for (let j = 0; j < segs; j++) {
      const a = j;
      const b = (j + 1) % s.n;
      const px = s.pos[a * 3]! + ox;
      const py = s.pos[a * 3 + 1]! + oy;
      const pz = s.pos[a * 3 + 2]! + oz;
      const qx = s.pos[b * 3]! + ox;
      const qz = s.pos[b * 3 + 2]! + oz;
      if (Math.abs(s.pos[b * 3 + 1]! - s.pos[a * 3 + 1]!) > 1e-6) continue;
      let axis: 0 | 1;
      let line: number;
      let lo: number;
      let hi: number;
      let start: number;
      if (Math.abs(px - qx) < 1e-6 && Math.abs(px / cs0 - Math.round(px / cs0)) < ON_LINE) {
        axis = 0;
        line = Math.round(px / cs0);
        [lo, hi, start] = [Math.min(pz, qz), Math.max(pz, qz), pz];
      } else if (Math.abs(pz - qz) < 1e-6 && Math.abs(pz / cs2 - Math.round(pz / cs2)) < ON_LINE) {
        axis = 1;
        line = Math.round(pz / cs2);
        [lo, hi, start] = [Math.min(px, qx), Math.max(px, qx), px];
      } else continue;
      const along = axis === 0 ? cs2 : cs0;
      const r0 = Math.ceil((py + y0) / cs1 - 0.5 - 1e-9);
      const r1 = Math.floor((py + y1) / cs1 - 0.5 + 1e-9);
      for (let k = Math.ceil(lo / along - 0.5 - 1e-9); (k + 0.5) * along < hi - 1e-9; k++) {
        const mid = (k + 0.5) * along;
        const d = s.dist[j]! + Math.abs(mid - start);
        for (let r = r0; r <= r1; r++) {
          const h = (r + 0.5) * cs1 - py;
          const open = holes.some((o) => d > o.a && d < o.b && h > o.bottom && h < o.top);
          const key = (axis === 0 ? cellKeyOf(line, r, k) : cellKeyOf(k, r, line)) * 2 + axis;
          out.set(key, (out.get(key) ?? false) || !open);
        }
      }
    }
  }
  return out;
}

/** The rooms' storeys as regions of the layer (layer cells; a room too small to hold a column's middle has none). */
export function architectureRoomRegions(rooms: readonly ArchitectureRoomPlan[], offset: readonly number[], cellSize: readonly number[]): BlockRegion[] {
  const out: BlockRegion[] = [];
  const [cs0, cs1, cs2] = [cellSize[0]!, cellSize[1]!, cellSize[2]!];
  const [ox, oy, oz] = [offset[0] ?? 0, offset[1] ?? 0, offset[2] ?? 0];
  for (const room of rooms) {
    const poly: number[] = [];
    let x0 = Infinity;
    let x1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;
    for (const [x, z] of room.points) {
      poly.push(x + ox, z + oz);
      x0 = Math.min(x0, x + ox);
      x1 = Math.max(x1, x + ox);
      z0 = Math.min(z0, z + oz);
      z1 = Math.max(z1, z + oz);
    }
    const r0 = Math.ceil((room.floor + oy) / cs1 - 0.5 - 1e-9);
    const r1 = Math.floor((room.top + oy) / cs1 - 0.5 + 1e-9) + 1;
    if (r1 <= r0) continue;
    const boxes: number[][] = [];
    for (let z = Math.floor(z0 / cs2); z * cs2 < z1; z++) {
      let run = -Infinity;
      const flush = (x: number): void => {
        if (run !== -Infinity) boxes.push([run, r0, z, x, r1, z + 1]);
        run = -Infinity;
      };
      let x = Math.floor(x0 / cs0);
      for (; x * cs0 < x1; x++) {
        if (pointInPolygon((x + 0.5) * cs0, (z + 0.5) * cs2, poly)) {
          if (run === -Infinity) run = x;
        } else flush(x);
      }
      flush(x);
    }
    if (boxes.length > 0) out.push({ regionId: room.id, boxes });
  }
  return out;
}

/**
 * The wall paint a component drawn on a layer reads (null: the layer has no
 * wall paint, or none is painted): its cell size, the offset from the
 * object's frame into the layer's, and its chunks' wall paint.
 */
export function architecturePaintOf(layer: { readonly cellSize: readonly number[]; readonly wallPaint?: boolean }, chunks: Iterable<{ readonly cx: number; readonly cz: number; readonly wallPaint?: string }>, layerOrigin: readonly number[], objectOrigin: readonly number[]): ArchitecturePaint | null {
  if (layer.wallPaint !== true) return null;
  const out: Record<string, string> = {};
  const hashes: Record<string, string> = {};
  let any = false;
  for (const ch of chunks) {
    if (ch.wallPaint === undefined || ch.wallPaint === '') continue;
    const k = `${ch.cx},${ch.cz}`;
    out[k] = ch.wallPaint;
    hashes[k] = hashText64(ch.wallPaint);
    any = true;
  }
  if (!any) return null;
  return { cellSize: [...layer.cellSize], offset: [0, 1, 2].map((i) => (objectOrigin[i] ?? 0) - (layerOrigin[i] ?? 0)), chunks: out, hashes };
}
