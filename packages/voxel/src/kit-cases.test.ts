/**
 * The case pass on windows: folding, rule priority and wildcards, the
 * mandatory fallback, and the draft catalogue's coverage (every case
 * reachable, every window some case of its role).
 */
import { mulberry32 } from '@thirdlight/shared';
import { describe, expect, it } from 'vitest';
import { DRAFT_CASE_CATALOGUE } from './kit-case-catalogue';
import {
  applyFold,
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
  type CaseRuleCell,
} from './kit-cases';
import { VOXEL_ROLE } from './record';

const R = VOXEL_ROLE;
const SYMBOLS = 15;

/** A window of one symbol, with cells set. */
function windowOf(fill: number, cells: ReadonlyArray<readonly [number, number, number, number]> = []): Uint8Array {
  const w = new Uint8Array(CASE_WINDOW_CELLS).fill(fill);
  for (const [x, y, z, s] of cells) w[caseWindowIndex(x, y, z)] = s;
  return w;
}

const WALL_SAME = CASE_SYMBOL.built + 1;
const FLOOR_SAME = CASE_SYMBOL.built + 3;

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
    const cat = new CaseCatalogue(DRAFT_CASE_CATALOGUE);
    const rnd = mulberry32(5);
    let asymmetric = 0;
    for (let trial = 0; trial < 3000; trial++) {
      const role = CASE_ROLES[Math.floor(rnd() * CASE_ROLES.length)]!;
      // Sparse built windows reach more cases than uniform noise does.
      const density = rnd();
      const win = Uint8Array.from({ length: CASE_WINDOW_CELLS }, () => (rnd() < density ? Math.floor(rnd() * SYMBOLS) : CASE_SYMBOL.open));
      const a = cat.matchWindow(role, win);
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

  it('never flips a case upside down: a window and its vertical flip may differ', () => {
    const cat = new CaseCatalogue(DRAFT_CASE_CATALOGUE);
    // A floor slab edge open below and in front is a soffit; the same edge flipped (open above) is a floor edge.
    const soffit = windowOf(CASE_SYMBOL.open, [[0, 0, -1, FLOOR_SAME], [1, 0, 0, FLOOR_SAME], [-1, 0, 0, FLOOR_SAME], [0, 1, 0, WALL_SAME]]);
    const flipped = windowOf(CASE_SYMBOL.open, [[0, 0, -1, FLOOR_SAME], [1, 0, 0, FLOOR_SAME], [-1, 0, 0, FLOOR_SAME], [0, -1, 0, WALL_SAME]]);
    expect(cat.matchWindow(R.floor, soffit).caseId).toBe('soffit');
    expect(cat.matchWindow(R.floor, flipped).caseId).toBe('floor-edge');
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
    cases: [{ id: 'plain', roles: CASE_ROLES, run: null, required: true, note: '' }, ...['a', 'b', ...extraCases].map((id) => ({ id, roles: [R.wall], run: 'x' as const, required: false, note: '' }))],
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
    const good = DRAFT_CASE_CATALOGUE;
    expect(() => new CaseCatalogue(good)).not.toThrow();
    for (const role of CASE_ROLES) {
      const fallback = { ...good.fallback } as Record<number, string>;
      delete fallback[role];
      expect(() => new CaseCatalogue({ ...good, fallback }), `role ${role}`).toThrow(/no fallback case for role/);
    }
    const bad = (patch: Partial<CaseCatalogueDef>, msg: RegExp): void => {
      expect(() => new CaseCatalogue({ ...good, ...patch })).toThrow(msg);
    };
    bad({ fallback: { ...good.fallback, [R.wall]: 'floor-plain' } }, /does not list role/);
    bad({ fallback: { ...good.fallback, [R.wall]: 'nope' } }, /is not a case/);
    bad({ cases: [...good.cases, good.cases[0]!] }, /listed twice/);
    bad({ cases: [...good.cases, { id: 'Bad Id', roles: [R.wall], run: null, required: false, note: '' }] }, /id syntax/);
    bad({ cases: [...good.cases, { id: 'ground', roles: [R.terrain], run: null, required: false, note: '' }] }, /detail roles/);
    bad({ rules: [...good.rules, { case: 'nope', priority: 1, cells: [] }] }, /unknown case/);
    bad({ rules: [...good.rules, { case: 'beam', priority: 1, cells: [[3, 0, 0, CELL.air]] }] }, /outside the case window/);
    bad({ rules: [...good.rules, { case: 'beam', priority: 1, cells: [[1, 1, 1, CELL.air], [1, 1, 1, CELL.air]] }] }, /listed twice/);
    bad({ rules: [...good.rules, { case: 'beam', priority: 1, cells: [[1, 1, 1, 0]] }] }, /accepts no symbol/);
    bad({ rules: [...good.rules, { case: 'beam', priority: 1, roles: [R.roof], cells: [] }] }, /roles outside/);
  });
});

describe('the draft catalogue', () => {
  const cat = new CaseCatalogue(DRAFT_CASE_CATALOGUE);

  it('says it is a draft, names a fallback for every detail role, and covers the built roles and the inferred features', () => {
    expect(cat.draft).toBe(true);
    for (const role of CASE_ROLES) expect(cat.fallbackOf(role)).toBeGreaterThanOrEqual(0);
    const features = new Set(cat.cases.map((c) => c.feature).filter((f) => f !== undefined));
    expect([...features].sort()).toEqual(['banister', 'beam', 'foundation-skirt', 'moulding', 'running-board', 'soffit']);
  });

  it('reaches every case: each has a window that resolves to it', () => {
    const rnd = mulberry32(11);
    const reached = new Map<string, number>();
    for (const [k, c] of cat.cases.entries()) {
      const rules = cat.rules.filter((r) => r.case === c.id);
      for (const role of c.roles) {
        // A fallback: a window no rule of the role matches; try sparse windows of the role's own symbol.
        const tries = rules.length === 0 ? [{ case: c.id, priority: 0, cells: [] as CaseRuleCell[] }] : rules;
        let hit = false;
        for (let n = 0; n < 4000 && !hit; n++) {
          const r = tries[n % tries.length]!;
          if (r.roles !== undefined && !r.roles.includes(role)) continue;
          const filler = rnd() < 0.5 ? CASE_SYMBOL.open : Math.floor(rnd() * SYMBOLS);
          const win = Uint8Array.from({ length: CASE_WINDOW_CELLS }, () => (rnd() < 0.3 ? Math.floor(rnd() * SYMBOLS) : filler));
          for (const [x, y, z, mask] of r.cells) win[caseWindowIndex(x, y, z)] = pick(rnd, mask);
          hit = cat.matchWindow(role, win).caseIndex === k;
        }
        if (hit) reached.set(c.id, (reached.get(c.id) ?? 0) + 1);
      }
    }
    expect(cat.cases.filter((c) => !reached.has(c.id)).map((c) => c.id)).toEqual([]);
  });

  it('gives every window of every detail role a case of that role', () => {
    const rnd = mulberry32(17);
    const seen = new Set<string>();
    for (let n = 0; n < 20000; n++) {
      const role = CASE_ROLES[n % CASE_ROLES.length]!;
      const density = rnd();
      const win = Uint8Array.from({ length: CASE_WINDOW_CELLS }, () => (rnd() < density ? Math.floor(rnd() * SYMBOLS) : CASE_SYMBOL.open));
      const m = cat.matchWindow(role, win);
      expect(cat.cases[m.caseIndex]!.roles).toContain(role);
      seen.add(m.caseId);
    }
    expect(seen.size).toBeGreaterThan(cat.cases.length / 2);
  });
});
