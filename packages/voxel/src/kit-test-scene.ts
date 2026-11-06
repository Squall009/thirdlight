/**
 * The kit test scene: every case of a rule set's catalogue built from
 * voxels, laid out in a labelled box, so a kit's pieces can be looked at
 * case by case in a real world through the real derive.
 *
 * **Two parts.** The window cases (a case window decides them; the edge
 * catalogue has none) get one exhibit a (case, role) pair in a grid (a row
 * a role, a column a case). The cases the passes give (edges and corners, roof edges,
 * debris) come from a **fixed sampler** in a column past the grid's last row: a stepped
 * block (a block with a top and a bottom corner notch cut out: every outer and
 * inner edge and corner), a gable roof, a hip roof, an L-plan hip roof (its
 * valley) and a wall with two damaged cells. Each of those cases is
 * labelled at the first cell (x, then z, then y) the real passes give it,
 * read from a neighbourhood holding only that structure.
 *
 * **Exhibits come from the catalogue, not by hand.** For each (case, role)
 * the generator looks for a case window the matcher resolves to that case:
 * first a few readable arrangements (a face of the role with the front open,
 * a top surface, or nothing around), each with the cells of one of the
 * case's rules laid over it; failing those, seeded random windows with the
 * rule's cells, cut down cell by cell to the fewest built cells that still
 * give the case. A window's symbols are realised as voxels one for one
 * (open → air, opening → the opening role, ground → terrain, a built
 * role → that role, full cells), so the derive reads the window the matcher
 * was given: a catalogue that grows or changes gets its scene with it.
 *
 * **Isolation.** Exhibits stand {@link KIT_TEST_SCENE_PITCH} cells apart
 * inside a box the scene first empties, so no exhibit's centre reads
 * another exhibit or the world around the box. Each label's case is what
 * the real case pass gives the centre; the generator checks the case before
 * it hands the scene out, so a label never names a case its cell does not
 * get.
 *
 * Pure: the scene is a list of ordinary edit commands (one box emptied, then
 * one `set` a distinct voxel), applied as one change by the voxel world's
 * test-scene command. Engine-owned test content: no game data, no
 * procedural world generation.
 */
import { mulberry32 } from '@thirdlight/shared';
import { createNeighbourhood, jobRadius, type AssemblyRuleSet } from './assembly';
import type { SetEdit, VoxelEditCommand, FillEdit } from './edit-command';
import { CASE_REACH, CASE_SYMBOL, CASE_WINDOW, CASE_WINDOW_CELLS, CaseCatalogue, caseIndexOf, NO_CASE, type CaseCatalogueDef, type CaseRule } from './kit-cases';
import { evaluateCases } from './kit-rules';
import { WORLD_GRID_ID } from './region-file';
import { damagedIntegrity, MATERIAL_ID_MAX, SHAPE_FULL, shapeDensity, valueDensity, valueMaterial, valueOf, valueRole, valueShape, valueWetness, VOXEL_ROLE } from './record';
import { isDebrisCell } from './case-forms';
import { createEdgeMasks, EDGE_CASE_IDS, edgeCaseOf, PIECE_SLOTS } from './edge-cases';
import { DEBRIS_LIGHT_MIN } from './kit-case-catalogue';
import { classifyRoofs, roofEdgesOf } from './roof-mesher';

/**
 * Cells between exhibit centres along x and z, and the height of the box.
 * A centre's case reads two cells round it; a cell more keeps every exhibit
 * clear of the next one's window: a 7-cell slot with the centre in its
 * middle holds all of it.
 */
export const KIT_TEST_SCENE_PITCH = 2 * (CASE_REACH + 1) + 1;

/** The roles by name, as labels print them. */
const ROLE_NAMES: Readonly<Record<number, string>> = Object.freeze(Object.fromEntries(Object.entries(VOXEL_ROLE).map(([k, v]) => [v, k])));

/** The name of a voxel role (its key in VOXEL_ROLE). */
export function voxelRoleName(role: number): string {
  return ROLE_NAMES[role] ?? `role ${role}`;
}

/** One exhibit: a case of a role and the window cells it is built from (offsets from the centre, the symbol each holds; open cells left out). */
export interface KitTestExhibit {
  readonly caseId: string;
  readonly role: number;
  readonly cells: readonly (readonly [dx: number, dy: number, dz: number, symbol: number])[];
}

/** A labelled cell of the scene. */
export interface KitTestLabel {
  /** The exhibit's centre, world cells. */
  readonly cell: readonly [number, number, number];
  readonly role: number;
  readonly roleName: string;
  readonly caseId: string;
}

export interface KitTestScene {
  /** The box the scene empties and builds in (inclusive, world cells). */
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
  /** The grid row by row (roles in order), column by column (cases in catalogue order), then the sampler's cases. */
  readonly labels: readonly KitTestLabel[];
  /** The edits that write it, in order: the box emptied, then one `set` a distinct voxel. */
  readonly commands: readonly VoxelEditCommand[];
  /** (case, role) pairs neither a window nor the sampler reached (none for the world's catalogue). */
  readonly unreached: readonly { readonly caseId: string; readonly role: number }[];
}

export interface KitTestSceneOptions {
  /** The box's lowest corner, world cells. */
  readonly origin: readonly [number, number, number];
  /** The material every built cell takes (a kit's bound material draws its pieces). */
  readonly material: number;
  /** The material of built cells a rule wants in "another material" (only a catalogue that reads materials has them; default: the next id). */
  readonly otherMaterial?: number;
}

/**
 * Cells between the sampler's structures along z (each stands in cells 2 … 11 of its slot and from 2 up, air round
 * it: two cells clear of whatever is round the box, the roof mesher's reach).
 */
export const KIT_TEST_SAMPLER_PITCH = 14;

/** A sampler structure: its cells in its slot (x, y, z from the slot's corner) and their voxel values. */
type SamplerCells = [number, number, number, number][];

/** A roof over a footprint, 45° all round (hip) or along z only (gable): each cell's height its distance to the footprint's edge. */
function samplerRoof(inside: (x: number, z: number) => boolean, hip: boolean, value: number): SamplerCells {
  const out: SamplerCells = [];
  for (let x = 0; x < KIT_TEST_SAMPLER_PITCH; x++) for (let z = 0; z < KIT_TEST_SAMPLER_PITCH; z++) {
    if (!inside(x, z)) continue;
    let d = Infinity;
    for (let ox = -1; ox <= KIT_TEST_SAMPLER_PITCH; ox++) for (let oz = -1; oz <= KIT_TEST_SAMPLER_PITCH; oz++) {
      if (inside(ox, oz) || (!hip && ox !== x)) continue;
      d = Math.min(d, Math.max(Math.abs(ox - x), Math.abs(oz - z)) - 1);
    }
    out.push([x, 2 + d, z, value]);
  }
  return out;
}

/** The sampler's structures in slot order (see the file comment). */
function samplerStructures(material: number): SamplerCells[] {
  const wall = valueOf({ material, role: VOXEL_ROLE.wall, shape: SHAPE_FULL, wetness: 0 });
  const roof = valueOf({ material, role: VOXEL_ROLE.roof, shape: SHAPE_FULL, wetness: 0 });
  const steps: SamplerCells = [];
  // Notches at the two ends, apart, so each keeps its inner corner (seven of eight cells round it solid).
  for (let x = 2; x < 8; x++) for (let y = 2; y < 6; y++) for (let z = 2; z < 6; z++) {
    const top = x >= 6 && y >= 4 && z >= 4;
    const bottom = x < 4 && y < 4 && z < 4;
    if (!top && !bottom) steps.push([x, y, z, wall]);
  }
  const damaged: SamplerCells = [];
  for (let x = 2; x < 9; x++) for (let y = 2; y < 6; y++) {
    const shape = x === 4 && y === 3 ? DEBRIS_LIGHT_MIN + 4 : x === 6 && y === 4 ? DEBRIS_LIGHT_MIN - 3 : SHAPE_FULL;
    damaged.push([x, y, 6, valueOf({ material, role: VOXEL_ROLE.wall, shape, wetness: 0 })]);
  }
  const box = (x0: number, x1: number, z0: number, z1: number) => (x: number, z: number): boolean => x >= x0 && x <= x1 && z >= z0 && z <= z1;
  const gable = box(2, 8, 2, 6);
  const hip = box(2, 7, 2, 9);
  const a = box(2, 11, 2, 6);
  const b = box(7, 11, 2, 11);
  return [steps, samplerRoof(gable, false, roof), samplerRoof(hip, true, roof), samplerRoof((x, z) => a(x, z) || b(x, z), true, roof), damaged];
}

/**
 * The pass cases a sampler structure gives, each at the first cell that
 * owns it (slot cells): the edge pass of `rules`, the roof mesher's edges,
 * debris and debris faces, read from a neighbourhood holding only the
 * structure, as the derive reads a world.
 */
function samplerCases(rules: AssemblyRuleSet, cells: SamplerCells): Map<string, [number, number, number, number]> {
  const edge = KIT_TEST_SAMPLER_PITCH;
  const pad = Math.max(jobRadius(rules), 2);
  const n = createNeighbourhood(edge, pad);
  const s = n.side;
  const at = (x: number, y: number, z: number): number => ((pad + x) * s + (pad + z)) * s + (pad + y);
  for (const [x, y, z, v] of cells) {
    n.values[at(x, y, z)] = v;
    n.shapes[at(x, y, z)] = valueDensity(v);
  }
  const masks = createEdgeMasks(n);
  rules.resolveEdges?.(n, pad, pad + edge, 0, masks);
  const roofs = new Uint32Array(n.values.length);
  classifyRoofs(n, roofs);
  const found = new Map<string, [number, number, number, number]>();
  const take = (id: string, x: number, y: number, z: number, i: number): void => {
    if (!found.has(id)) found.set(id, [x, y, z, valueRole(n.values[i]!)]);
  };
  const faces = [1, -1, s, -s, s * s, -s * s];
  for (let x = 0; x < edge; x++) for (let z = 0; z < edge; z++) for (let y = 0; y < edge; y++) {
    const i = at(x, y, z);
    if (n.values[i] === 0) continue;
    if (isDebrisCell(n, i)) {
      take(damagedIntegrity(n.values[i]!) >= DEBRIS_LIGHT_MIN ? 'debris' : 'debris-heavy', x, y, z, i);
      continue;
    }
    for (let k = 0; k < PIECE_SLOTS; k++) if (((masks.pieces[i]! >>> k) & 1) !== 0) take(EDGE_CASE_IDS[edgeCaseOf(k, ((masks.inner[i]! >>> k) & 1) !== 0)]!, x, y, z, i);
    for (const e of roofEdgesOf(roofs[i]!)) take(e.caseId, x, y, z, i);
    if (faces.some((f) => n.values[i + f] !== 0 && isDebrisCell(n, i + f))) take('debris-face', x, y, z, i);
  }
  return found;
}

const BUILT_FIRST = CASE_SYMBOL.built;
/** The built roles in symbol order (kit-cases.ts: role b is symbol 3 + 2b, + 1 in the centre's material). */
const BUILT_ROLES: readonly number[] = [VOXEL_ROLE.wall, VOXEL_ROLE.floor, VOXEL_ROLE.roof, VOXEL_ROLE.foundation, VOXEL_ROLE.stair, VOXEL_ROLE.pillar];
const SYMBOLS = BUILT_FIRST + 2 * BUILT_ROLES.length;

/** A role's symbol in the centre's material (openings: the opening symbol). */
function ownSymbol(role: number): number {
  const b = BUILT_ROLES.indexOf(role);
  return b >= 0 ? BUILT_FIRST + 2 * b + 1 : CASE_SYMBOL.opening;
}

/** Symbols a rule cell is filled with, most readable first: the centre's own role, air, ground, the built roles, the opening. */
function preference(role: number): number[] {
  const order = [ownSymbol(role), CASE_SYMBOL.open, CASE_SYMBOL.ground, ...BUILT_ROLES.map((_, b) => BUILT_FIRST + 2 * b + 1), CASE_SYMBOL.opening, ...BUILT_ROLES.map((_, b) => BUILT_FIRST + 2 * b)];
  return [...new Set(order)];
}

function firstOf(mask: number, order: readonly number[]): number {
  for (const s of order) if ((mask >> s) & 1) return s;
  return CASE_SYMBOL.open;
}

/** The readable starting arrangements around a centre of `role`: a face with the front open, a top surface, nothing. */
function fillers(role: number): Uint8Array[] {
  const own = ownSymbol(role);
  const front = Uint8Array.from(CASE_WINDOW, ([, , dz]) => (dz > 0 ? CASE_SYMBOL.open : own));
  const top = Uint8Array.from(CASE_WINDOW, ([, dy]) => (dy > 0 ? CASE_SYMBOL.open : own));
  return [front, top, new Uint8Array(CASE_WINDOW_CELLS)];
}

const windowIndex = new Map(CASE_WINDOW.map((o, k) => [o.join(','), k]));

/**
 * A window the catalogue resolves to case `caseIndex` for a centre of
 * `role`, or null when none was found. Deterministic: the same catalogue
 * gives the same window.
 */
function windowFor(cat: CaseCatalogue, caseIndex: number, role: number): Uint8Array | null {
  const id = cat.cases[caseIndex]!.id;
  const rules: (CaseRule | null)[] = cat.rules.filter((r) => r.case === id && (r.roles === undefined || r.roles.includes(role)));
  // A fallback case has no rule: the arrangement alone must match none.
  if (rules.length === 0) rules.push(null);
  const order = preference(role);
  const hits = (w: Uint8Array): boolean => cat.matchWindow(role, w).caseIndex === caseIndex;
  const lay = (w: Uint8Array, r: CaseRule | null, pick: (mask: number) => number): Uint8Array => {
    for (const [dx, dy, dz, mask] of r?.cells ?? []) w[windowIndex.get(`${dx},${dy},${dz}`)!] = pick(mask);
    return w;
  };
  for (const filler of fillers(role)) {
    for (const r of rules) {
      const w = lay(filler.slice(), r, (m) => firstOf(m, order));
      if (hits(w)) return w;
    }
  }
  const rnd = mulberry32(0x6b17 + caseIndex * 31 + role);
  for (let n = 0; n < 20_000; n++) {
    const r = rules[n % rules.length]!;
    const filler = rnd() < 0.5 ? CASE_SYMBOL.open : Math.floor(rnd() * SYMBOLS);
    const w = Uint8Array.from({ length: CASE_WINDOW_CELLS }, () => (rnd() < 0.3 ? Math.floor(rnd() * SYMBOLS) : filler));
    lay(w, r, (mask) => {
      const opts: number[] = [];
      for (let s = 0; s < SYMBOLS; s++) if ((mask >> s) & 1) opts.push(s);
      return opts[Math.floor(rnd() * opts.length)] ?? CASE_SYMBOL.open;
    });
    if (!hits(w)) continue;
    // The fewest built cells that still give the case: each cell opened where the case holds.
    for (let k = 0; k < CASE_WINDOW_CELLS; k++) {
      if (w[k] === CASE_SYMBOL.open) continue;
      const was = w[k]!;
      w[k] = CASE_SYMBOL.open;
      if (!hits(w)) w[k] = was;
    }
    return w;
  }
  return null;
}

/**
 * The exhibits of a catalogue: one a (case, role) pair, in catalogue case
 * order and each case's role order, plus the pairs no window was found for
 * (every pair of a case no window rule names: the pass cases).
 */
export function kitTestExhibits(def: CaseCatalogueDef): { exhibits: KitTestExhibit[]; unreached: { caseId: string; role: number }[] } {
  const cat = new CaseCatalogue(def);
  const exhibits: KitTestExhibit[] = [];
  const unreached: { caseId: string; role: number }[] = [];
  // A case no rule names (an edge, roof-edge or debris case, from its own pass) and no role falls back to has no window.
  const windowed = new Set([...def.rules.map((r) => r.case), ...Object.values(def.fallback).filter((f): f is string => f !== null)]);
  cat.cases.forEach((c, k) => {
    for (const role of new Set(c.roles)) {
      const w = windowed.has(c.id) ? windowFor(cat, k, role) : null;
      if (w === null) {
        unreached.push({ caseId: c.id, role });
        continue;
      }
      const cells: [number, number, number, number][] = [];
      CASE_WINDOW.forEach(([dx, dy, dz], i) => {
        if (w[i] !== CASE_SYMBOL.open) cells.push([dx, dy, dz, w[i]!]);
      });
      exhibits.push({ caseId: c.id, role, cells });
    }
  });
  return { exhibits, unreached };
}

/** The voxel value a window symbol is realised as. */
function symbolValue(symbol: number, centreRole: number, material: number, other: number): number {
  if (symbol === CASE_SYMBOL.open) return 0;
  if (symbol === -1) return valueOf({ material, role: centreRole, shape: SHAPE_FULL, wetness: 0 });
  if (symbol === CASE_SYMBOL.opening) return valueOf({ material, role: VOXEL_ROLE.opening, shape: SHAPE_FULL, wetness: 0 });
  if (symbol === CASE_SYMBOL.ground) return valueOf({ material, role: VOXEL_ROLE.terrain, shape: SHAPE_FULL, wetness: 0 });
  const b = (symbol - BUILT_FIRST) >> 1;
  const same = ((symbol - BUILT_FIRST) & 1) === 1;
  return valueOf({ material: same ? material : other, role: BUILT_ROLES[b]!, shape: SHAPE_FULL, wetness: 0 });
}

/** An exhibit's cells as voxel values by offset from its centre (the centre included). */
function exhibitValues(e: KitTestExhibit, material: number, other: number): [number, number, number, number][] {
  return [[0, 0, 0, symbolValue(-1, e.role, material, other)], ...e.cells.map(([dx, dy, dz, s]) => [dx, dy, dz, symbolValue(s, e.role, material, other)] as [number, number, number, number])];
}

/**
 * The case the real case pass gives an exhibit's centre, with nothing but
 * air around it (what the scene's emptied box gives it): read from a
 * neighbourhood holding only the exhibit.
 */
function centreCase(rules: AssemblyRuleSet, cat: CaseCatalogueDef, values: readonly [number, number, number, number][]): string | null {
  const edge = KIT_TEST_SCENE_PITCH;
  const pad = jobRadius(rules);
  const n = createNeighbourhood(edge, pad);
  const s = n.side;
  const mid = pad + (edge >> 1);
  const at = (dx: number, dy: number, dz: number): number => ((mid + dx) * s + (mid + dz)) * s + (mid + dy);
  for (const [dx, dy, dz, v] of values) {
    n.values[at(dx, dy, dz)] = v;
    n.shapes[at(dx, dy, dz)] = v === 0 ? 0 : shapeDensity(SHAPE_FULL);
  }
  const cases = new Uint16Array(n.values.length);
  evaluateCases(n, rules, 0, cases);
  const c = cases[at(0, 0, 0)]!;
  return c === NO_CASE ? null : (cat.cases[caseIndexOf(c)]?.id ?? null);
}

/**
 * The kit test scene of a rule set with a case pass (its catalogue): the
 * labels, the box and the edits that write it at `origin`. Refuses a rule
 * set without a catalogue, and a material outside the voxel's 12 bits.
 */
export function kitTestScene(rules: AssemblyRuleSet, opts: KitTestSceneOptions): KitTestScene {
  const def = rules.catalogue;
  if (def === undefined) throw new RangeError(`rule set ${rules.id} has no case catalogue: no kit test scene`);
  const { material } = opts;
  const other = opts.otherMaterial ?? (material < MATERIAL_ID_MAX ? material + 1 : material - 1);
  for (const m of [material, other]) if (!Number.isInteger(m) || m < 1 || m > MATERIAL_ID_MAX) throw new RangeError(`material ${m} is not a voxel material id (1-${MATERIAL_ID_MAX})`);
  const { exhibits, unreached: noWindow } = kitTestExhibits(def);
  const roles = [...new Set(exhibits.map((e) => e.role))].sort((a, b) => a - b);
  const columns = new Map<number, number>();
  const p = KIT_TEST_SCENE_PITCH;
  const half = p >> 1;
  const [ox, oy, oz] = opts.origin;
  const labels: KitTestLabel[] = [];
  const byValue = new Map<number, number[]>();
  let cols = 0;
  for (const e of exhibits) {
    const row = roles.indexOf(e.role);
    const col = columns.get(e.role) ?? 0;
    columns.set(e.role, col + 1);
    cols = Math.max(cols, col + 1);
    const centre: [number, number, number] = [ox + col * p + half, oy + half, oz + row * p + half];
    const values = exhibitValues(e, material, other);
    const got = centreCase(rules, def, values);
    if (got !== e.caseId) throw new Error(`kit test scene: the ${voxelRoleName(e.role)} exhibit of ${e.caseId} derives as ${got ?? 'no case'}`);
    labels.push({ cell: centre, role: e.role, roleName: voxelRoleName(e.role), caseId: e.caseId });
    for (const [dx, dy, dz, v] of values) {
      let list = byValue.get(v);
      if (list === undefined) byValue.set(v, (list = []));
      list.push(centre[0] + dx, centre[1] + dy, centre[2] + dz);
    }
  }
  // The sampler's column past the grid's last row (narrow: the scene's box stays as wide as the grid): the pass
  // cases, each labelled once, at the first cell that owns it.
  const z0 = oz + roles.length * p;
  const reached = new Set<string>();
  const structures = samplerStructures(material);
  structures.forEach((cells, slot) => {
    const sx = ox;
    const sz = z0 + slot * KIT_TEST_SAMPLER_PITCH;
    for (const [id, [x, y, z, role]] of samplerCases(rules, cells)) {
      if (reached.has(id) || !def.cases.some((c) => c.id === id)) continue;
      reached.add(id);
      labels.push({ cell: [sx + x, oy + y, sz + z], role, roleName: voxelRoleName(role), caseId: id });
    }
    for (const [x, y, z, v] of cells) {
      let list = byValue.get(v);
      if (list === undefined) byValue.set(v, (list = []));
      list.push(sx + x, oy + y, sz + z);
    }
  });
  const unreached = noWindow.filter((u) => !reached.has(u.caseId));
  const min: [number, number, number] = [ox, oy, oz];
  const max: [number, number, number] = [ox + Math.max(cols * p, KIT_TEST_SAMPLER_PITCH) - 1, oy + Math.max(p, KIT_TEST_SAMPLER_PITCH >> 1) - 1, z0 + structures.length * KIT_TEST_SAMPLER_PITCH - 1];
  const clear: FillEdit = { v: 2, grid: WORLD_GRID_ID, kind: 'fill', min, max, mode: 'dig' };
  const sets: SetEdit[] = [...byValue.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([v, cells]) => ({ v: 2, grid: WORLD_GRID_ID, kind: 'set', cells, voxel: { material: valueMaterial(v), role: valueRole(v), shape: valueShape(v), wetness: valueWetness(v) } }));
  return { min, max, labels, commands: [clear, ...sets], unreached };
}
