/**
 * The kit test scene: every case of a rule set's catalogue built from
 * voxels, one exhibit a (case, role) pair, laid out in a labelled grid (a
 * row a role, a column a case), so a kit's pieces can be looked at case by
 * case in a real world through the real derive.
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
 * inside a box the scene first empties, so no exhibit's centre, nor the
 * run section beside it, reads another exhibit or the world around the box.
 * Each label's case and run section are what the real case and run passes
 * give the centre; the generator checks the case before it hands the scene
 * out, so a label never names a case its cell does not get.
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
import { evaluateCases, evaluateRuns } from './kit-rules';
import { NO_SECTION, runSectionOf } from './kit-runs';
import { RUN_SECTION_IDS } from './piece-table';
import { WORLD_GRID_ID } from './region-file';
import { MATERIAL_ID_MAX, SHAPE_FULL, shapeDensity, valueMaterial, valueOf, valueRole, valueShape, valueWetness, VOXEL_ROLE } from './record';

/**
 * Cells between exhibit centres along x and z, and the height of the box.
 * A centre's run section reads its neighbours' cases (one cell) and theirs
 * read two more, so nothing farther than three cells from a centre decides
 * its label: a 7-cell slot with the centre in its middle holds all of it.
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
  /** The run section the run pass gives the centre (a {@link RUN_SECTION_IDS} id), or null when the case has none there. */
  readonly section: string | null;
}

export interface KitTestScene {
  /** The box the scene empties and builds in (inclusive, world cells). */
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
  /** Row by row (roles in catalogue order), column by column (cases in catalogue order). */
  readonly labels: readonly KitTestLabel[];
  /** The edits that write it, in order: the box emptied, then one `set` a distinct voxel. */
  readonly commands: readonly VoxelEditCommand[];
  /** (case, role) pairs no window was found for (none for a catalogue every case of which is reachable). */
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
 * The case and run section the real case and run passes give an exhibit's
 * centre, with nothing but air around it (what the scene's emptied box
 * gives it): read from a neighbourhood holding only the exhibit.
 */
function centreResult(rules: AssemblyRuleSet, cat: CaseCatalogueDef, values: readonly [number, number, number, number][]): { caseId: string | null; section: string | null } {
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
  const count = evaluateCases(n, rules, 0, cases);
  const sections = new Uint16Array(n.values.length);
  evaluateRuns(n, rules, cases, sections, count);
  const c = cases[at(0, 0, 0)]!;
  const sec = sections[at(0, 0, 0)]!;
  return { caseId: c === NO_CASE ? null : (cat.cases[caseIndexOf(c)]?.id ?? null), section: sec === NO_SECTION ? null : (RUN_SECTION_IDS[runSectionOf(sec)] ?? null) };
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
  const { exhibits, unreached } = kitTestExhibits(def);
  const roles = [...new Set(def.cases.flatMap((c) => c.roles))].sort((a, b) => a - b);
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
    const got = centreResult(rules, def, values);
    if (got.caseId !== e.caseId) throw new Error(`kit test scene: the ${voxelRoleName(e.role)} exhibit of ${e.caseId} derives as ${got.caseId ?? 'no case'}`);
    labels.push({ cell: centre, role: e.role, roleName: voxelRoleName(e.role), caseId: e.caseId, section: got.section });
    for (const [dx, dy, dz, v] of values) {
      let list = byValue.get(v);
      if (list === undefined) byValue.set(v, (list = []));
      list.push(centre[0] + dx, centre[1] + dy, centre[2] + dz);
    }
  }
  const min: [number, number, number] = [ox, oy, oz];
  const max: [number, number, number] = [ox + Math.max(1, cols) * p - 1, oy + p - 1, oz + Math.max(1, roles.length) * p - 1];
  const clear: FillEdit = { v: 2, grid: WORLD_GRID_ID, kind: 'fill', min, max, mode: 'dig' };
  const sets: SetEdit[] = [...byValue.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([v, cells]) => ({ v: 2, grid: WORLD_GRID_ID, kind: 'set', cells, voxel: { material: valueMaterial(v), role: valueRole(v), shape: valueShape(v), wetness: valueWetness(v) } }));
  return { min, max, labels, commands: [clear, ...sets], unreached };
}
