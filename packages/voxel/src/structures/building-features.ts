/**
 * Openings and stairs laid on a building's plan, each checked where it
 * stands, so a definition whose door is inside the building or whose stair
 * leaves the plan is refused with the cell that is wrong.
 *
 * An opening is the wall cells along its edge, one row of the wall, from
 * `sill` rows over its storey's floor for `height` rows. Its edge must be on
 * the building's outline there (an edge two polygons share is inside the
 * building and has no wall).
 *
 * A stair climbs from storey `from` to the next: storey height − 1 steps,
 * each a row up and a cell on toward `facing`, then the landing: the next
 * storey's floor, which is left open over every step (the headroom: a
 * walker on any step has the whole storey over it).
 */
import { STAIR_WIDTH_CELLS, StructureDefinitionError, type StructureDefinition } from './definition';
import { signedArea2, type PlanGrid } from './building-plan';

function push(map: Map<number, number[]>, col: number, ...v: number[]): void {
  let l = map.get(col);
  if (l === undefined) map.set(col, (l = []));
  l.push(...v);
}

/** Every opening's rows by column; refuses one off its wall, past its edge or storey, or over another. */
export function openingRows(def: StructureDefinition, g: PlanGrid): Map<number, number[]> {
  const out = new Map<number, number[]>();
  const owner = new Map<number, string[]>();
  const h = def.storeyHeight;
  const ids = new Map(def.footprint.map((p, k) => [p.id, k]));
  def.openings.forEach((o, k) => {
    const path = `/openings/${k}`;
    const what = `opening "${o.id}"`;
    const pk = ids.get(o.polygon);
    if (pk === undefined) throw new StructureDefinitionError(`${path}/polygon`, `${what} is on polygon "${o.polygon}", which the footprint does not have`);
    const pts = def.footprint[pk]!.points;
    if (o.edge >= pts.length) throw new StructureDefinitionError(`${path}/edge`, `${what}: polygon "${o.polygon}" has edges 0 to ${pts.length - 1}`);
    if (o.storey >= def.storeys) throw new StructureDefinitionError(`${path}/storey`, `${what} is on storey ${o.storey}; the building has storeys 0 to ${def.storeys - 1}`);
    if (o.sill + o.height > h - 1) throw new StructureDefinitionError(`${path}/height`, `${what}: sill ${o.sill} + height ${o.height} is more than the ${h - 1} rows between a storey's floor and the next`);
    const a = pts[o.edge]!;
    const b = pts[(o.edge + 1) % pts.length]!;
    const alongX = a[1] === b[1];
    const len = Math.abs(alongX ? b[0] - a[0] : b[1] - a[1]);
    if (o.at + o.width > len) throw new StructureDefinitionError(`${path}/width`, `${what} reaches past its edge's end (at ${o.at} + width ${o.width} is more than the edge's ${len} cells)`);
    const step = alongX ? Math.sign(b[0] - a[0]) : Math.sign(b[1] - a[1]);
    // The inside lies on the edge's left when the polygon's points run anticlockwise over (x, z).
    const left = signedArea2(pts) > 0 ? 1 : -1;
    const inward = alongX ? left * step : -left * step;
    const y0 = o.storey * h + 1 + o.sill;
    for (let j = o.at; j < o.at + o.width; j++) {
      const along = step > 0 ? (alongX ? a[0] : a[1]) + j : (alongX ? a[0] : a[1]) - 1 - j;
      const across = alongX ? a[1] : a[0];
      const inCell = inward > 0 ? across : across - 1;
      const outCell = inward > 0 ? across - 1 : across;
      const [x, z, ox, oz] = alongX ? [along, inCell, along, outCell] : [inCell, along, outCell, along];
      const col = (x - g.x0) * g.d + (z - g.z0);
      const ocol = (ox - g.x0) * g.d + (oz - g.z0);
      if (g.wall[col] !== 1 || g.inside[ocol] === 1) throw new StructureDefinitionError(path, `${what} lies inside the building at cell (${x}, ${z}): edge ${o.edge} of polygon "${o.polygon}" is joined to another polygon there; put it on an outside wall`);
      const rows = out.get(col);
      for (let r = 0; rows !== undefined && r < rows.length; r += 2) {
        if (rows[r]! <= y0 + o.height - 1 && y0 <= rows[r + 1]!) throw new StructureDefinitionError(path, `${what} overlaps opening "${owner.get(col)![r / 2]}" at cell (${x}, ${z})`);
      }
      push(out, col, y0, y0 + o.height - 1);
      let names = owner.get(col);
      if (names === undefined) owner.set(col, (names = []));
      names.push(o.id);
    }
  });
  return out;
}

/** Every stair's step rows and the floor rows it leaves open, by column; refuses a stair off the plan, past the top storey or over another. */
export function stairRows(def: StructureDefinition, g: PlanGrid): { steps: Map<number, number[]>; holes: Map<number, number[]> } {
  const steps = new Map<number, number[]>();
  const holes = new Map<number, number[]>();
  const landings: { col: number; y: number; id: string; x: number; z: number }[] = [];
  const owner = new Map<string, string>();
  const h = def.storeyHeight;
  const ids = new Map(def.footprint.map((p, k) => [p.id, k]));
  def.stairs.forEach((s, k) => {
    const path = `/stairs/${k}`;
    const what = `stair "${s.id}"`;
    const pk = ids.get(s.polygon);
    if (pk === undefined) throw new StructureDefinitionError(`${path}/polygon`, `${what} is in polygon "${s.polygon}", which the footprint does not have`);
    if (s.from >= def.storeys - 1) throw new StructureDefinitionError(`${path}/from`, `${what} climbs from storey ${s.from}, but a stair needs a storey above it (the building's top storey is ${def.storeys - 1})`);
    const alongX = s.facing === '+x' || s.facing === '-x';
    const dir = s.facing[0] === '+' ? 1 : -1;
    const mask = g.polygons[pk]!;
    // h − 1 steps, then the landing on the next floor.
    for (let j = 0; j < h; j++) for (let c = 0; c < STAIR_WIDTH_CELLS; c++) {
      const x = s.at[0] + (alongX ? dir * j : c);
      const z = s.at[1] + (alongX ? c : dir * j);
      const ix = x - g.x0;
      const iz = z - g.z0;
      const col = ix * g.d + iz;
      const on = ix >= 0 && iz >= 0 && ix < g.w && iz < g.d;
      const part = j < h - 1 ? `step ${j + 1}` : 'its landing';
      if (!on || mask[col] !== 1) throw new StructureDefinitionError(path, `${what}: ${part} at cell (${x}, ${z}) is outside polygon "${s.polygon}"`);
      if (g.wall[col] === 1) throw new StructureDefinitionError(path, `${what}: ${part} at cell (${x}, ${z}) is in a wall; a stair stands inside the rooms`);
      if (j === h - 1) {
        landings.push({ col, y: (s.from + 1) * h, id: s.id, x, z });
        continue;
      }
      const y = s.from * h + 1 + j;
      const key = `${col}:${y}`;
      const other = owner.get(key);
      if (other !== undefined) throw new StructureDefinitionError(path, `${what} overlaps stair "${other}" at cell (${x}, ${y}, ${z})`);
      owner.set(key, s.id);
      push(steps, col, y);
      push(holes, col, (s.from + 1) * h);
    }
  });
  for (const l of landings) {
    if (holes.get(l.col)?.includes(l.y)) throw new StructureDefinitionError('/stairs', `stair "${l.id}": its landing at cell (${l.x}, ${l.z}) lies over another stair, where the floor is open`);
  }
  return { steps, holes };
}
