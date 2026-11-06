/**
 * The case pass on windows: folding, rule priority and wildcards, the
 * mandatory fallback (on a window test catalogue: the edge catalogue's
 * beam and banister rules with directional rules and a fallback for every
 * role, so most windows resolve through a rule), and the edge catalogue's
 * window part.
 */
import { mulberry32 } from '@thirdlight/shared';
import { describe, expect, it } from 'vitest';
import { EDGE_CASE_IDS } from './edge-cases';
import { EDGE_CASE_CATALOGUE } from './kit-case-catalogue';
import {
  applyFold,
  catalogueReadsMaterial,
  CASE_ROLES,
  CASE_SYMBOL,
  CASE_WINDOW,
  CASE_WINDOW_CELLS,
  CaseCatalogue,
  caseWindowIndex,
  CELL,
  composeFolds,
  FOLD_TRANSFORMS,
  foldWindow,
  type CaseCatalogueDef,
  type CaseDef,
  type CaseRule,
  type CaseRuleCell,
} from './kit-cases';
import { VOXEL_ROLE } from './record';

const R = VOXEL_ROLE;
const SYMBOLS = 15;

/** A symbol without the same-material bit (a built role in "another material"). */
const plain = (sy: number): number => (sy > CASE_SYMBOL.built ? sy - ((sy - CASE_SYMBOL.built) & 1) : sy);

/** A window of one symbol, with cells set. */
function windowOf(fill: number, cells: ReadonlyArray<readonly [number, number, number, number]> = []): Uint8Array {
  const w = new Uint8Array(CASE_WINDOW_CELLS).fill(fill);
  for (const [x, y, z, s] of cells) w[caseWindowIndex(x, y, z)] = s;
  return w;
}

const WALL_SAME = CASE_SYMBOL.built + 1;
const FLOOR_SAME = CASE_SYMBOL.built + 3;

const { open: O, opening: OP, solid: S } = CELL;
const rule = (c: string, priority: number, cells: readonly CaseRuleCell[]): CaseRule => ({ case: c, priority, cells });
const testCase = (id: string, roles: readonly number[]): CaseDef => ({ id, roles, base: 'keep', shape: 'box', note: '' });

/**
 * A window test catalogue: the edge catalogue with rules that read one side
 * (so a turn or mirror matters), gravity (open below against open above)
 * and openings, and a fallback for every role, so the machinery's paths are
 * all exercised on random windows. Test data, never a world's catalogue.
 */
const WINDOW_TEST_CATALOGUE: CaseCatalogueDef = Object.freeze({
  id: 'window-test',
  version: 1,
  draft: true,
  cases: [...EDGE_CASE_CATALOGUE.cases, testCase('plain', CASE_ROLES), testCase('front', CASE_ROLES), testCase('top-front', CASE_ROLES), testCase('under', [R.floor, R.roof]), testCase('jamb', [R.wall]), testCase('corner', [R.wall, R.floor])],
  rules: [
    ...EDGE_CASE_CATALOGUE.rules,
    rule('jamb', 65, [[1, 0, 0, OP], [0, 0, 1, O]]),
    rule('under', 60, [[0, -1, 0, O], [0, 0, 1, O], [0, -1, 1, O]]),
    rule('corner', 54, [[0, 0, 1, O], [1, 0, 0, O], [1, 0, 1, O], [-1, 0, 0, S]]),
    rule('top-front', 50, [[0, 1, 0, O], [0, 0, 1, O]]),
    rule('front', 1, [[0, 0, 1, O]]),
  ],
  fallback: Object.fromEntries(CASE_ROLES.map((r) => [r, 'plain'])),
});

/** A random member of a mask. */
function pick(rnd: () => number, mask: number): number {
  const opts: number[] = [];
  for (let s = 0; s < SYMBOLS; s++) if ((mask >> s) & 1) opts.push(s);
  return opts[Math.floor(rnd() * opts.length)]!;
}

describe('folding', () => {
  it('has eight distinct transforms that keep up up, compose as a group, and map the window onto itself', () => {
    const images = new Set<string>();
    for (let t = 0; t < FOLD_TRANSFORMS; t++) {
      images.add(`${applyFold(t, [1, 0, 0])}|${applyFold(t, [0, 0, 1])}`);
      for (const o of CASE_WINDOW) {
        const p = applyFold(t, o);
        expect(p[1]).toBe(o[1]);
        expect(caseWindowIndex(...p)).toBeGreaterThanOrEqual(0);
      }
      for (let u = 0; u < FOLD_TRANSFORMS; u++) for (const o of CASE_WINDOW) expect(applyFold(composeFolds(t, u), o)).toEqual(applyFold(t, applyFold(u, o)));
    }
    expect(images.size).toBe(8);
    // A quarter turn takes +x to +z; the mirror takes +x to −x and keeps z.
    expect(applyFold(1, [1, 0, 0])).toEqual([0, 0, 1]);
    expect(applyFold(4, [1, 0, 1])).toEqual([-1, 0, 1]);
  });

  it('gives a turned or mirrored window the same case and key, and a transform that maps the case onto it', () => {
    const cat = new CaseCatalogue(WINDOW_TEST_CATALOGUE);
    const rnd = mulberry32(5);
    let asymmetric = 0;
    for (let trial = 0; trial < 3000; trial++) {
      const role = CASE_ROLES[Math.floor(rnd() * CASE_ROLES.length)]!;
      // Sparse built windows reach more cases than uniform noise does.
      const density = rnd();
      // The catalogue's rules read no material, so its windows carry no same-material bit (matching takes it off).
      const raw = Uint8Array.from({ length: CASE_WINDOW_CELLS }, () => (rnd() < density ? Math.floor(rnd() * SYMBOLS) : CASE_SYMBOL.open));
      const win = raw.map(plain);
      const a = cat.matchWindow(role, raw);
      const A = Math.floor(rnd() * FOLD_TRANSFORMS);
      const turned = foldWindow(win, A);
      const b = cat.matchWindow(role, turned);
      expect(b.caseId).toBe(a.caseId);
      expect(b.key).toBe(a.key);
      expect(b.rule).toBe(a.rule);
      // The key placed by its transform is the world's window; the matched pattern placed by the case's transform fits it.
      expect(foldWindow(b.folded, b.keyFold)).toEqual(turned);
      expect(foldWindow(a.folded, a.keyFold)).toEqual(win);
      if (b.rule >= 0) {
        for (const [x, y, z, mask] of cat.rules[b.rule]!.cells) expect((mask >> turned[caseWindowIndex(...applyFold(b.fold, [x, y, z]))]!) & 1).toBe(1);
      } else {
        expect(b.fold).toBe(b.keyFold);
      }
      // Without a symmetry the transform is unique: the world's turn after the original's.
      let symmetric = false;
      for (let t = 1; t < FOLD_TRANSFORMS && !symmetric; t++) symmetric = foldWindow(win, t).every((s, k) => s === win[k]);
      if (!symmetric) {
        asymmetric++;
        expect(b.fold).toBe(composeFolds(A, a.fold));
      }
    }
    expect(asymmetric).toBeGreaterThan(2000);
  });

  it('decides no case or transform by materials unless a rule reads the same-material bit', () => {
    const cat = new CaseCatalogue(WINDOW_TEST_CATALOGUE);
    expect(cat.readsMaterial).toBe(false);
    expect(catalogueReadsMaterial(WINDOW_TEST_CATALOGUE)).toBe(false);
    const rnd = mulberry32(9);
    for (let trial = 0; trial < 2000; trial++) {
      const role = CASE_ROLES[Math.floor(rnd() * CASE_ROLES.length)]!;
      const win = Uint8Array.from({ length: CASE_WINDOW_CELLS }, () => (rnd() < 0.5 ? Math.floor(rnd() * SYMBOLS) : CASE_SYMBOL.open));
      // The same roles with each built neighbour's material drawn again: the case and its transform stay.
      const repainted = win.map((sy) => (sy >= CASE_SYMBOL.built ? plain(sy) + (rnd() < 0.5 ? 1 : 0) : sy));
      const a = cat.matchWindow(role, win);
      const b = cat.matchWindow(role, repainted);
      expect([b.caseId, b.fold, b.key]).toEqual([a.caseId, a.fold, a.key]);
    }
    // A rule that tells the centre's material from another makes the catalogue read materials.
    expect(catalogueReadsMaterial({ rules: [{ case: 'a', priority: 1, cells: [[0, -1, 0, CELL.floor & CELL.same]] }] })).toBe(true);
    expect(catalogueReadsMaterial({ rules: [{ case: 'a', priority: 1, cells: [[0, -1, 0, CELL.floor | CELL.ground]] }] })).toBe(false);
  });

  it('never flips a case upside down: a window and its vertical flip may differ', () => {
    const cat = new CaseCatalogue(WINDOW_TEST_CATALOGUE);
    // A floor slab edge open below and in front is the underside case; the same edge flipped (open above) is the top's.
    const under = windowOf(CASE_SYMBOL.open, [[0, 0, -1, FLOOR_SAME], [1, 0, 0, FLOOR_SAME], [-1, 0, 0, FLOOR_SAME], [0, 1, 0, WALL_SAME]]);
    const flipped = windowOf(CASE_SYMBOL.open, [[0, 0, -1, FLOOR_SAME], [1, 0, 0, FLOOR_SAME], [-1, 0, 0, FLOOR_SAME], [0, -1, 0, WALL_SAME]]);
    expect(cat.matchWindow(R.floor, under).caseId).toBe('under');
    expect(cat.matchWindow(R.floor, flipped).caseId).toBe('top-front');
  });
});

/** A small catalogue for one role with given rules (every other role gets a fallback). */
function tiny(rules: CaseCatalogueDef['rules'], extraCases: string[] = []): CaseCatalogue {
  const fallback: Record<number, string> = {};
  for (const role of CASE_ROLES) fallback[role] = 'plain';
  return new CaseCatalogue({
    id: 'tiny',
    version: 1,
    draft: true,
    cases: [{ id: 'plain', roles: CASE_ROLES, base: 'keep', shape: 'box', note: '' }, ...['a', 'b', ...extraCases].map((id) => ({ id, roles: [R.wall], base: 'keep' as const, shape: 'box' as const, note: '' }))],
    rules,
    fallback,
  });
}

describe('rules', () => {
  const openFront: CaseRuleCell = [0, 0, 1, CELL.open];
  const wallAbove: CaseRuleCell = [0, 1, 0, CELL.wall];

  it('tries rules by priority, equal priorities in table order, the first match winning', () => {
    const win = windowOf(WALL_SAME, [[0, 0, 1, CASE_SYMBOL.open]]);
    expect(tiny([{ case: 'a', priority: 1, cells: [openFront] }, { case: 'b', priority: 2, cells: [openFront, wallAbove] }]).matchWindow(R.wall, win).caseId).toBe('b');
    expect(tiny([{ case: 'a', priority: 3, cells: [openFront] }, { case: 'b', priority: 2, cells: [openFront, wallAbove] }]).matchWindow(R.wall, win).caseId).toBe('a');
    expect(tiny([{ case: 'b', priority: 2, cells: [openFront] }, { case: 'a', priority: 2, cells: [openFront] }]).matchWindow(R.wall, win).caseId).toBe('b');
    // A rule that does not match is passed over for a lower one that does.
    expect(tiny([{ case: 'b', priority: 9, cells: [[0, -1, 0, CELL.ground]] }, { case: 'a', priority: 1, cells: [openFront] }]).matchWindow(R.wall, win).caseId).toBe('a');
  });

  it('treats unlisted cells as wildcards and listed cells as symbol sets (roles, classes, same material)', () => {
    const cat = tiny([{ case: 'a', priority: 2, cells: [openFront, [0, -1, 0, CELL.floor & CELL.same]] }, { case: 'b', priority: 1, cells: [openFront, [0, -1, 0, CELL.floor | CELL.ground]] }]);
    const rnd = mulberry32(3);
    for (let k = 0; k < 200; k++) {
      // Everything but the two listed cells is noise.
      const win = Uint8Array.from({ length: CASE_WINDOW_CELLS }, () => Math.floor(rnd() * SYMBOLS));
      win[caseWindowIndex(0, 0, 1)] = CASE_SYMBOL.opening;
      // Fold the listed cells away from any other open side, so only the pattern decides.
      for (const [x, y, z] of [[1, 0, 0], [-1, 0, 0], [0, 0, -1]] as const) win[caseWindowIndex(x, y, z)] = WALL_SAME;
      win[caseWindowIndex(0, -1, 0)] = FLOOR_SAME;
      expect(cat.matchWindow(R.wall, win).caseId).toBe('a');
      win[caseWindowIndex(0, -1, 0)] = FLOOR_SAME - 1;
      expect(cat.matchWindow(R.wall, win).caseId).toBe('b');
      win[caseWindowIndex(0, -1, 0)] = CASE_SYMBOL.ground;
      expect(cat.matchWindow(R.wall, win).caseId).toBe('b');
      win[caseWindowIndex(0, -1, 0)] = WALL_SAME;
      expect(cat.matchWindow(R.wall, win).caseId).toBe('plain');
    }
  });

  it('applies a rule only to its roles, and falls back per role when nothing matches', () => {
    const cat = tiny([{ case: 'a', priority: 1, cells: [openFront] }]);
    const win = windowOf(WALL_SAME, [[0, 0, 1, CASE_SYMBOL.open]]);
    expect(cat.matchWindow(R.wall, win).caseId).toBe('a');
    expect(cat.matchWindow(R.floor, win)).toMatchObject({ caseId: 'plain', rule: -1 });
    expect(() => cat.matchWindow(R.terrain, win)).toThrow(/carries no case/);
  });

  it('refuses a catalogue without a fallback for every detail role, and other broken definitions', () => {
    const good = WINDOW_TEST_CATALOGUE;
    expect(() => new CaseCatalogue(good)).not.toThrow();
    for (const role of CASE_ROLES) {
      const fallback = { ...good.fallback } as Record<number, string>;
      delete fallback[role];
      expect(() => new CaseCatalogue({ ...good, fallback }), `role ${role}`).toThrow(/no fallback case for role/);
      // Named as none: the role's unmatched cells carry no case.
      const none = new CaseCatalogue({ ...good, fallback: { ...good.fallback, [role]: null } });
      expect(none.fallbackOf(role)).toBe(-1);
    }
    const bad = (patch: Partial<CaseCatalogueDef>, msg: RegExp): void => {
      expect(() => new CaseCatalogue({ ...good, ...patch })).toThrow(msg);
    };
    bad({ fallback: { ...good.fallback, [R.wall]: 'under' } }, /does not list role/);
    bad({ fallback: { ...good.fallback, [R.wall]: 'nope' } }, /is not a case/);
    bad({ cases: [...good.cases, good.cases[0]!] }, /listed twice/);
    bad({ cases: [...good.cases, { id: 'Bad Id', roles: [R.wall], base: 'keep', shape: 'box', note: '' }] }, /id syntax/);
    bad({ cases: [...good.cases, { id: 'ground', roles: [R.terrain], base: 'keep', shape: 'box', note: '' }] }, /detail roles/);
    // A case's base and declared shape must go together (a kept base is the whole cell, a suppressed one a partial shape).
    const formOf = (base: string, shape: string): CaseCatalogueDef['cases'][number] => ({ id: 'odd', roles: [R.wall], base, shape, note: '' }) as unknown as CaseCatalogueDef['cases'][number];
    bad({ cases: [...good.cases, formOf('keep', 'bar')] }, /kept base needs the box/);
    bad({ cases: [...good.cases, formOf('reshape', 'slab')] }, /base "reshape"/);
    bad({ cases: [...good.cases, formOf('suppress', 'box')] }, /suppressed base with the whole box/);
    bad({ cases: [...good.cases, formOf('hide', 'box')] }, /base "hide"/);
    bad({ cases: [...good.cases, formOf('keep', 'sphere')] }, /shape "sphere"/);
    bad({ rules: [...good.rules, { case: 'nope', priority: 1, cells: [] }] }, /unknown case/);
    bad({ rules: [...good.rules, { case: 'jamb', priority: 1, cells: [[3, 0, 0, CELL.air]] }] }, /outside the case window/);
    bad({ rules: [...good.rules, { case: 'jamb', priority: 1, cells: [[1, 1, 1, CELL.air], [1, 1, 1, CELL.air]] }] }, /listed twice/);
    bad({ rules: [...good.rules, { case: 'jamb', priority: 1, cells: [[1, 1, 1, 0]] }] }, /accepts no symbol/);
    bad({ rules: [...good.rules, { case: 'jamb', priority: 1, roles: [R.roof], cells: [] }] }, /roles outside/);
  });
});

describe('the edge catalogue (window part)', () => {
  const cat = new CaseCatalogue(EDGE_CASE_CATALOGUE);

  it('is a 17-case draft with no window rules and no fallback for any role: no cell gets a window case', () => {
    expect([cat.id, cat.version, cat.draft]).toEqual(['edges-draft', 3, true]);
    expect(cat.cases).toHaveLength(17);
    expect(cat.cases.map((c) => c.id).slice(0, EDGE_CASE_IDS.length)).toEqual([...EDGE_CASE_IDS]);
    expect(cat.cases.map((c) => c.id).filter((id) => /beam|banister/.test(id))).toEqual([]);
    expect(cat.rules).toEqual([]);
    for (const role of CASE_ROLES) expect(cat.fallbackOf(role)).toBe(-1);
    expect(cat.readsMaterial).toBe(false);
    // A wall face, open in front and solid all round otherwise: no case (no piece on a flat face).
    const face = windowOf(WALL_SAME, [[0, 0, 1, CASE_SYMBOL.open]]);
    expect(cat.matchWindow(R.wall, face)).toMatchObject({ caseIndex: -1, caseId: null, rule: -1 });
  });
});
