/**
 * Structure grids in the world grid's walk graph: a section's navigation with
 * the structures stamped over its chunk (structure-stamp.ts, held by
 * prop-channel.ts as a chunk's structure classes).
 *
 * A stamped stopping cell (a wall, a floor, a stair step, the foundation: any
 * construction cell the share rule fills) blocks a walker as a world cell of a
 * box form does, so the world's walker goes round a turned building, never
 * through it, and the ground under its foundation is no longer standable. A
 * structure is walked in its own grid's graph, stitched to the world's at its
 * doorsteps and foundation edges (walk-graph-links.ts), so by default a stamp
 * supports nothing: inside the footprint the world graph holds no place to
 * stand. With `supports`, a stamped stopping cell also carries a walker, as the
 * world's own would (the stamp walked as world cells: a turned floor and its
 * stairs resampled at the world's cells, which loses stair tops and lets a path
 * graze a wall; kept for the measurement that showed it). A stamped opening or
 * open cell is the world's own. Nothing is stored: the result is made when the
 * walk graph makes the chunk again, from the classes the channel holds then.
 */
import { NAV_CLEARANCE_CELLS, NAV_CLEARANCE_CONTINUES, OCCUPANCY, type NavOut } from './derived-data';
import { STAMP_CLASS } from './structure-stamp';
import type { SectionNav } from './walk-graph-cells';

/** The structure classes the walk graph reads (prop-channel.ts `rooms`: a chunk's {@link STAMP_CLASS} a cell, or null). */
export interface WalkStamps {
  rooms(cx: number, cy: number, cz: number): Uint8Array | null;
}

/** How the walk graph reads stamps: the classes, and whether a stamped stop carries a walker (the module comment). */
export interface WalkStampsUse {
  readonly stamps: WalkStamps;
  readonly supports?: boolean;
}

function baseBlocks(nav: NavOut | null, i: number): boolean {
  if (nav === null || nav.blocking === OCCUPANCY.empty) return false;
  if (nav.blocking === OCCUPANCY.solid) return true;
  return ((nav.blocks![i >>> 5]! >>> (i & 31)) & 1) === 1;
}

/**
 * A section's navigation with the structure classes of its chunk stamped over it: `classes` the chunk's (local index
 * `((x << csh) | z) << csh | y`), the section's cells at (`ox`, `oy`, `oz`) in it, edge `se`; `below` the classes of
 * the chunk under it (read only for the section's lowest layer when `oy` is 0: a floor stamped there supports the cell
 * over it, with `supports`). `base` itself (the same object) where no stamped stopping cell falls in the section (or,
 * with `supports`, under its lowest layer); an unknown section stays unknown.
 */
export function stampedNav(base: SectionNav, classes: Uint8Array | null, below: Uint8Array | null, ox: number, oy: number, oz: number, csh: number, se: number, supports = false): SectionNav {
  if (base === undefined) return undefined;
  if (!supports) below = null;
  if (classes === null && (oy > 0 || below === null)) return base;
  const cm = (1 << csh) - 1;
  // A stamped stop under section-local (x, y, z): y −1 is the layer under the section (in this chunk or the one below).
  const stopAt = (x: number, y: number, z: number): boolean => {
    const cy = oy + y;
    const src = cy >= 0 ? classes : below;
    if (src === null) return false;
    return src[((((ox + x) << csh) | (oz + z)) << csh) | (cy & cm)] === STAMP_CLASS.stop;
  };
  let any = false;
  for (let x = 0; x < se && !any; x++) for (let z = 0; z < se && !any; z++) for (let y = supports ? -1 : 0; y < se; y++) if (stopAt(x, y, z)) {
    any = true;
    break;
  }
  if (!any) return base;
  const cells = se * se * se;
  const blocks = new Uint32Array(cells >>> 5);
  let blocking = 0;
  for (let x = 0; x < se; x++) for (let z = 0; z < se; z++) for (let y = 0; y < se; y++) {
    const i = (x * se + z) * se + y;
    if (baseBlocks(base, i) || stopAt(x, y, z)) {
      blocks[i >>> 5]! |= 1 << (i & 31);
      blocking++;
    }
  }
  const blocked = (i: number): boolean => ((blocks[i >>> 5]! >>> (i & 31)) & 1) === 1;
  const was = new Uint8Array(cells);
  if (base !== null) for (const i of base.standable) was[i] = 1;
  const standable: number[] = [];
  const clearance: number[] = [];
  for (let x = 0; x < se; x++) for (let z = 0; z < se; z++) for (let y = 0; y < se; y++) {
    const i = (x * se + z) * se + y;
    if (blocked(i)) continue;
    if (was[i] !== 1 && !(supports && stopAt(x, y - 1, z))) continue;
    let free = 0;
    while (free < NAV_CLEARANCE_CELLS && y + free < se && !blocked(i + free)) free++;
    standable.push(i);
    clearance.push(free < NAV_CLEARANCE_CELLS && y + free === se ? free | NAV_CLEARANCE_CONTINUES : free);
  }
  const all = blocking === cells;
  return { blocking: blocking === 0 ? OCCUPANCY.empty : all ? OCCUPANCY.solid : OCCUPANCY.mixed, blocks: blocking === 0 || all ? null : blocks, standable: Uint16Array.from(standable), clearance: Uint8Array.from(clearance) };
}
